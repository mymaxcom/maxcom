// The finance data layer on a MemoryLocalStore with the in-memory sync
// server: writes are signed, shown at once as pending with a temporary
// number, queued, and reconciled by the box's answer and feed.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/finance/finance_models.dart';
import 'package:surau_app/finance/finance_repository.dart';
import 'package:surau_app/finance/photo_prep.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/canonical.dart';
import 'package:surau_app/sync/live_only.dart';
import 'package:surau_app/sync/outbox.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import '../sync/sync_fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

// A minimal JPEG start: SOI + APP0 marker bytes, enough for the magic check.
Uint8List jpegBytes([int n = 64]) => Uint8List.fromList([
  0xFF,
  0xD8,
  0xFF,
  0xE0,
  for (var i = 0; i < n; i++) i % 251,
]);

void main() {
  late MemoryLocalStore store;
  late FakeSyncServer server;
  late SyncEngine engine;
  late FinanceRepository repo;
  var clock = DateTime.utc(2026, 11, 10, 3, 0, 0); // KL 11:00 on 2026-11-10
  DateTime now() => clock = clock.add(const Duration(seconds: 1));

  Map<String, dynamic> cash({int sen = 135680, String? fund}) => {
    'entryDate': '2026-11-10',
    'fundId': fund ?? 'f1',
    'perihalId': 'in-j',
    'amountSen': sen,
    'method': 'tunai',
    'counters': [
      {'userId': 'u1'},
      {'name': 'Tuan Haji Ali'},
    ],
  };

  setUp(() async {
    clock = DateTime.utc(2026, 11, 10, 3, 0, 0);
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    server = FakeSyncServer();
    engine = SyncEngine(
      store: store,
      key: FakeDeviceKey(present: true),
      box: syncBox(),
      transport: FakeTransport(server),
      now: now,
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    repo = FinanceRepository(store: store, engine: engine, now: now);
    await store.setMeta('seq', '0');
    await store.setMeta('seq@box', '0');
    await store.putDoc(Collections.financeFunds, 'f1', {
      'id': 'f1',
      'name': 'Tabung Jumaat',
      'sortOrder': 1,
      'public': true,
    });
    await store.putDoc(Collections.financeFunds, 'f2', {
      'id': 'f2',
      'name': 'Tabung Am',
      'sortOrder': 2,
    });
    await store.putDoc(Collections.financePerihal, 'in-j', {
      'id': 'in-j',
      'direction': 'in',
      'label': 'Kutipan solat Jumaat',
    });
  });

  tearDown(() {
    repo.dispose();
    engine.dispose();
  });

  group('appendCollection', () {
    test('queues one finance.append and shows a pending row with a temporary number', () async {
      final e = await repo.appendCollection(cash());
      final ops = await engine.outbox.pending();
      expect(ops, hasLength(1));
      expect(ops.single.kind, 'finance.append');
      expect(ops.single.entity, 'finance:entry');
      expect(ops.single.entityId, e.id);
      expect(ulidPattern.hasMatch(e.id), isTrue);

      expect(e.pending, isTrue);
      expect(e.kind, 'in');
      expect(e.amountSen, 135680);
      expect(e.refNo, isNull);
      expect(e.refLabel, startsWith('K-'));
      expect(e.refLabel, endsWith('(sementara)'));
      expect(e.createdBy, 'u1');
      expect(e.deviceId, 'dev-1');
      expect(e.counters!.map((c) => c.userId ?? c.name), [
        'u1',
        'Tuan Haji Ali',
      ]);
      expect(await repo.isPending(e.id), isTrue);
      expect(await repo.pendingFinanceCount(), 1);
      expect(e.refLabel, 'K-${e.id.substring(e.id.length - 4)} (sementara)');
    });

    test(
      'signs only what the box takes: no refNo, createdBy or times',
      () async {
        await repo.appendCollection({
          ...cash(),
          'refNo': 'K-9999',
          'createdBy': 'someone-else',
          'receivedAt': '2020-01-01T00:00:00.000Z',
          'id': 'forced',
          'kind': 'out',
        });
        final p = (await engine.outbox.pending()).single.payload as Map;
        expect(p.keys.toSet(), {
          'kind',
          'entryDate',
          'fundId',
          'perihalId',
          'amountSen',
          'method',
          'counters',
        });
        expect(p['kind'], 'in');
      },
    );

    test('refuses an amount that is not whole sen', () async {
      expect(
        () => repo.appendCollection({...cash(), 'amountSen': 12.5}),
        throwsArgumentError,
      );
      expect(
        () => repo.appendCollection({...cash(), 'amountSen': -1}),
        throwsArgumentError,
      );
      expect(await engine.outbox.count, 0);
    });

    test('a pending row becomes final when the box accepts the op', () async {
      final e = await repo.appendCollection(cash());
      await engine.sync();
      expect(await engine.outbox.count, 0);
      expect(await repo.isPending(e.id), isFalse);
      final back = (await repo.entry(e.id))!.entry;
      expect(back.amountSen, 135680);
      expect(back.pending, isFalse);
    });

    test(
      'a pulled feed entry with refNo replaces the temporary number',
      () async {
        final e = await repo.appendCollection(cash());
        await engine.sync();
        expect(
          (await repo.entry(e.id))!.entry.refLabel,
          endsWith('(sementara)'),
        );
        server.seq = 3;
        server.entries = [
          {
            'seq': 3,
            'entity': 'finance:entry',
            'entityId': e.id,
            'rev': '2026-11-10T03:05:00.000Z|dev-9',
            'editedAt': '2026-11-10T03:05:00.000Z',
            'opId': null,
            'after': {...e.toJson(), 'refNo': 'K-0135'},
          },
        ];
        await engine.sync();
        final got = (await repo.entry(e.id))!.entry;
        expect(got.refNo, 'K-0135');
        expect(got.refLabel, 'K-0135');
      },
    );

    test(
      'a refused append disappears from the screens and shows as a conflict',
      () async {
        server.verdict = (op) => {
          'opId': op['opId'],
          'status': 'refused',
          'rev': null,
          'reason': 'invalid',
          'winner': null,
        };
        final e = await repo.appendCollection(cash());
        await engine.sync();
        expect(await repo.entry(e.id), isNull);
        expect(await engine.outbox.count, 0);
        expect((await engine.conflicts()).single['reason'], 'invalid');
      },
    );
  });

  group('photos', () {
    test(
      'a photo travels as an upload- blob and the entry carries its id',
      () async {
        final jpeg = jpegBytes();
        final e = await repo.appendCollection(cash(), photo: jpeg);
        final id = sha256HexOf(jpeg);
        expect(e.photoId, id);

        final ops = await engine.outbox.pending();
        expect(
          ops.map((o) => o.kind),
          containsAll(['finance.photo.put', 'finance.append']),
        );
        final photo = ops.firstWhere((o) => o.kind == 'finance.photo.put');
        expect(photo.entity, 'finance:photo');
        expect(photo.entityId, id);
        final p = photo.payload as Map;
        expect(p['entryId'], e.id);
        expect(base64.decode(p['bytesBase64'] as String), jpeg);

        // The stored op document holds no bytes; they are in the blob.
        final doc = await store.getDoc(Collections.outbox, photo.opId);
        expect((doc!['op'] as Map)['payload'], isNot(contains('bytesBase64')));
        expect(await store.getBlob(Outbox.blobId(photo.opId)), jpeg);
        // And readable offline.
        expect(await store.getBlob(SyncEngine.financePhotoBlob(id)), jpeg);
        expect(
          (await store.getDoc(Collections.financePhotos, id))!['entryId'],
          e.id,
        );
      },
    );

    test('attachPhoto returns the sha256 id; a non-JPEG or oversize file is refused', () async {
      final jpeg = jpegBytes();
      expect(await repo.attachPhoto('01HENTRY', jpeg), sha256HexOf(jpeg));
      expect(
        () => repo.attachPhoto('01HENTRY', Uint8List.fromList([1, 2, 3, 4, 5])),
        throwsA(isA<FinancePhotoError>()),
      );
      expect(
        () => repo.attachPhoto('01HENTRY', jpegBytes(2 * 1024 * 1024)),
        throwsA(isA<FinancePhotoError>()),
      );
    });

    test('the photo op is accepted and its bytes leave the queue', () async {
      await repo.appendCollection(cash(), photo: jpegBytes());
      await engine.sync();
      expect(await engine.outbox.count, 0);
      expect(await store.getBlob(Outbox.blobId('x')), isNull);
      final pushed = server.opBatches.expand((b) => b['ops'] as List).toList();
      // The photo op is pushed alone, in its own batch.
      expect(
        server.opBatches.any(
          (b) =>
              (b['ops'] as List).length == 1 &&
              ((b['ops'] as List).single as Map)['kind'] == 'finance.photo.put',
        ),
        isTrue,
      );
      expect(pushed, hasLength(2));
    });
  });

  group('corrections and payments', () {
    test('a correction of a correction points at the original', () async {
      await store.putDoc(Collections.financeEntries, 'orig', {
        'id': 'orig',
        'kind': 'in',
        'entryDate': '2026-11-03',
        'fundId': 'f2',
        'amountSen': 5000,
        'editedAt': '2026-11-03T01:00:00.000Z',
      });
      await store.putDoc(Collections.financeEntries, 'adj1', {
        'id': 'adj1',
        'kind': 'adjust',
        'entryDate': '2026-11-04',
        'fundId': 'f2',
        'correctsId': 'orig',
        'correctionKind': 'amount',
        'amountSen': 4000,
        'reason': 'Salah taip jumlah: 40',
        'editedAt': '2026-11-04T01:00:00.000Z',
      });
      final c = await repo.appendCorrection({
        'entryDate': '2026-11-10',
        'correctsId': 'adj1',
        'correctionKind': 'void',
        'reason': 'Dimasukkan dua kali',
      });
      expect(c.kind, 'adjust');
      expect(c.correctsId, 'orig');
      expect(c.fundId, 'f2');
      final p = (await engine.outbox.pending()).single.payload as Map;
      expect(p['correctsId'], 'orig');
      expect(p['fundId'], 'f2');
      expect(p['amountSen'], 0);
    });

    test(
      'a penceramah payment copies the penceramah from the kuliah',
      () async {
        await store.putDoc(Collections.content('kuliah'), 'k1', {
          'id': 'k1',
          'date': '2026-11-10',
          'label': 'Maghrib',
          'penceramahId': 'pen1',
          'status': 'aktif',
        });
        await store.putDoc(Collections.content('penceramah'), 'pen1', {
          'id': 'pen1',
          'name': 'Ustaz Ali',
        });
        final e = await repo.appendPayment({
          'entryDate': '2026-11-10',
          'fundId': 'f1',
          'perihalId': 'perihal-penceramah',
          'amountSen': 20000,
          'method': 'tunai',
          'kuliahId': 'k1',
        });
        expect(e.kind, 'out');
        expect(e.kuliahId, 'k1');
        expect(e.penceramahId, 'pen1');
        expect(e.penceramahName, 'Ustaz Ali');
      },
    );
  });

  group('lookups and months', () {
    test(
      'putFund and putPerihal queue finance.lookup.put and show the change',
      () async {
        final f = await repo.putFund(
          Fund(
            id: repo.newId(),
            name: 'Tabung Anak Yatim',
            public: true,
            sortOrder: 3,
          ),
        );
        expect(f.name, 'Tabung Anak Yatim');
        expect(
          (await repo.funds()).map((x) => x.name),
          contains('Tabung Anak Yatim'),
        );
        final p = await repo.putPerihal(
          Perihal(
            id: repo.newId(),
            direction: 'out',
            label: 'Utiliti',
            sortOrder: 1,
          ),
        );
        expect((await repo.perihal('out')).map((x) => x.id), [p.id]);
        final ops = await engine.outbox.pending();
        expect(ops.map((o) => o.entity), ['finance:fund', 'finance:perihal']);
        expect(ops.every((o) => o.kind == 'finance.lookup.put'), isTrue);
        expect((ops.first.payload as Map).keys.toSet(), {
          'name',
          'public',
          'targetSen',
          'jumaat',
          'sortOrder',
          'archivedAt',
        });
      },
    );

    test('an archived fund leaves funds() unless asked for', () async {
      await repo.putFund(
        Fund(
          id: 'f2',
          name: 'Tabung Am',
          sortOrder: 2,
          archivedAt: '2026-11-10T00:00:00.000Z',
        ),
      );
      expect((await repo.funds()).map((f) => f.id), ['f1']);
      expect((await repo.funds(includeArchived: true)).map((f) => f.id), [
        'f1',
        'f2',
      ]);
    });

    test('setMonth queues finance.month.put keyed by the month', () async {
      final m = await repo.setMonth('2026-10', 'closed');
      expect(m.closed, isTrue);
      final op = (await engine.outbox.pending()).single;
      expect(op.kind, 'finance.month.put');
      expect(op.entityId, '2026-10');
      expect(op.payload, {'status': 'closed'});
      expect((await repo.months()).single.ym, '2026-10');
      expect(() => repo.setMonth('2026-13', 'closed'), throwsArgumentError);
      expect(() => repo.setMonth('2026-10', 'done'), throwsArgumentError);
    });
  });

  group('reads', () {
    Future<void> seedLedger() async {
      for (final e in [
        {
          'id': 'a1',
          'kind': 'opening',
          'entryDate': '2026-11-01',
          'fundId': 'f1',
          'amountSen': 100000,
          'editedAt': '2026-11-01T01:00:00.000Z',
        },
        {
          'id': 'a2',
          'kind': 'in',
          'entryDate': '2026-11-05',
          'fundId': 'f1',
          'perihalId': 'in-j',
          'amountSen': 30000,
          'editedAt': '2026-11-05T01:00:00.000Z',
        },
        {
          'id': 'a3',
          'kind': 'out',
          'entryDate': '2026-11-06',
          'fundId': 'f1',
          'amountSen': 5000,
          'editedAt': '2026-11-06T01:00:00.000Z',
        },
        {
          'id': 'a4',
          'kind': 'in',
          'entryDate': '2026-10-30',
          'fundId': 'f2',
          'amountSen': 7000,
          'editedAt': '2026-10-30T01:00:00.000Z',
        },
      ]) {
        await store.putDoc(Collections.financeEntries, e['id'] as String, e);
      }
    }

    test('summary: balances, this month and the counts', () async {
      await seedLedger();
      final s = await repo.summary();
      expect(s.ym, '2026-11');
      expect(s.funds.map((f) => (f.fund.id, f.balanceSen)), [
        ('f1', 125000),
        ('f2', 7000),
      ]);
      expect(s.totalSen, 132000);
      expect(s.monthInSen, 30000);
      expect(s.monthOutSen, 5000);
      expect(s.entryCount, 4);
      expect(s.pendingCount, 0);
    });

    test('the month follows the Kuala Lumpur date, not UTC', () async {
      await seedLedger();
      clock = DateTime.utc(2026, 10, 31, 17, 30); // KL 01:30 on 1 Nov
      final s = await repo.summary();
      expect(s.ym, '2026-11');
      expect(repo.todayKl, '2026-11-01');
    });

    test('entries filter by month and fund, newest first', () async {
      await seedLedger();
      expect((await repo.entries(ym: '2026-11')).map((e) => e.id), [
        'a3',
        'a2',
        'a1',
      ]);
      expect((await repo.entries(fundId: 'f2')).map((e) => e.id), ['a4']);
    });

    test('watchSummary emits now and again after a write', () async {
      await seedLedger();
      final seen = <int>[];
      final sub = repo.watchSummary().listen((s) => seen.add(s.entryCount));
      await pumpEventQueue();
      expect(seen, [4]);
      await repo.appendCollection(cash());
      await pumpEventQueue();
      expect(seen.last, 5);
      await sub.cancel();
    });

    test('report: an open month is computed locally, a closed one is the frozen copy', () async {
      await seedLedger();
      final open = await repo.report('2026-11');
      expect(open.status, 'open');
      expect(open.totals.inSen, 30000);
      expect(open.totals.outSen, 5000);
      expect(open.totals.closingSen, 132000);
      final frozen = open.toJson()
        ..['status'] = 'closed'
        ..['generatedAt'] = 'then';
      await store.putDoc(Collections.financeMonths, '2026-11', {
        'ym': '2026-11',
        'status': 'closed',
        'report': frozen,
      });
      final closed = await repo.report('2026-11');
      expect(closed.generatedAt, 'then');
      expect(closed.status, 'closed');
    });

    test(
      'unseen corrections count adjust rows newer than the seen stamp',
      () async {
        await seedLedger();
        for (final (id, at) in [
          ('c1', '2026-11-07T01:00:00.000Z'),
          ('c2', '2026-11-09T01:00:00.000Z'),
        ]) {
          await store.putDoc(Collections.financeEntries, id, {
            'id': id,
            'kind': 'adjust',
            'entryDate': '2026-11-09',
            'fundId': 'f1',
            'correctsId': 'a2',
            'correctionKind': 'amount',
            'amountSen': 1,
            'reason': 'Kiraan semula: 1',
            'editedAt': at,
            'receivedAt': at,
          });
        }
        expect(await repo.unseenCorrectionsCount(), 2);
        await store.setMeta(
          metaFinanceCorrectionsSeenAt,
          '2026-11-08T00:00:00.000Z',
        );
        expect(await repo.unseenCorrectionsCount(), 1);
        await repo.markCorrectionsSeen();
        expect(await repo.unseenCorrectionsCount(), 0);
        expect((await store.meta())[metaFinanceCorrectionsSeenAt], isNotNull);
      },
    );

    test('kuliahCandidates: today and earlier, paid flag, batal flagged, tomorrow left out', () async {
      Future<void> kuliah(String id, String date, {String status = 'aktif'}) =>
          store.putDoc(Collections.content('kuliah'), id, {
            'id': id,
            'date': date,
            'time': '20:00',
            'label': 'Kuliah $id',
            'topic': id == 'k-today' ? 'Tafsir Surah Yasin' : '',
            'penceramahId': 'pen1',
            'status': status,
          });
      await store.putDoc(Collections.content('penceramah'), 'pen1', {
        'id': 'pen1',
        'name': 'Ustaz Ali',
      });
      await kuliah('k-old', '2026-11-03');
      await kuliah('k-today', '2026-11-10');
      await kuliah('k-batal', '2026-11-08', status: 'batal');
      await kuliah('k-tomorrow', '2026-11-11');
      await store.putDoc(Collections.financeEntries, 'pay1', {
        'id': 'pay1',
        'kind': 'out',
        'entryDate': '2026-11-04',
        'fundId': 'f1',
        'amountSen': 20000,
        'kuliahId': 'k-old',
        'penceramahId': 'pen1',
        'editedAt': '2026-11-04T01:00:00.000Z',
      });
      final c = await repo.kuliahCandidates();
      expect(c.map((k) => k.kuliahId), ['k-today', 'k-batal', 'k-old']);
      expect(c.firstWhere((k) => k.kuliahId == 'k-old').paid, isTrue);
      expect(c.firstWhere((k) => k.kuliahId == 'k-today').paid, isFalse);
      expect(c.firstWhere((k) => k.kuliahId == 'k-today').tonight, isTrue);
      expect(
        c.firstWhere((k) => k.kuliahId == 'k-today').title,
        'Tafsir Surah Yasin',
      );
      expect(c.firstWhere((k) => k.kuliahId == 'k-batal').cancelled, isTrue);
      expect(c.first.penceramahName, 'Ustaz Ali');
    });

    test('a voided payment leaves the kuliah unpaid', () async {
      await store.putDoc(Collections.content('kuliah'), 'k1', {
        'id': 'k1',
        'date': '2026-11-03',
        'label': 'x',
        'penceramahId': 'pen1',
        'status': 'aktif',
      });
      await store.putDoc(Collections.financeEntries, 'pay1', {
        'id': 'pay1',
        'kind': 'out',
        'entryDate': '2026-11-04',
        'fundId': 'f1',
        'amountSen': 20000,
        'kuliahId': 'k1',
        'editedAt': '2026-11-04T01:00:00.000Z',
      });
      await store.putDoc(Collections.financeEntries, 'v1', {
        'id': 'v1',
        'kind': 'adjust',
        'entryDate': '2026-11-05',
        'fundId': 'f1',
        'correctsId': 'pay1',
        'correctionKind': 'void',
        'reason': 'Dibayar dua kali',
        'editedAt': '2026-11-05T01:00:00.000Z',
      });
      expect((await repo.kuliahCandidates()).single.paid, isFalse);
    });

    test('suggestedFee is the last non-voided payment, corrected', () async {
      await store.putDoc(Collections.financeEntries, 'p1', {
        'id': 'p1',
        'kind': 'out',
        'entryDate': '2026-10-02',
        'fundId': 'f1',
        'amountSen': 15000,
        'penceramahId': 'pen1',
        'editedAt': '2026-10-02T01:00:00.000Z',
      });
      await store.putDoc(Collections.financeEntries, 'p2', {
        'id': 'p2',
        'kind': 'out',
        'entryDate': '2026-10-09',
        'fundId': 'f1',
        'amountSen': 20000,
        'penceramahId': 'pen1',
        'editedAt': '2026-10-09T01:00:00.000Z',
      });
      await store.putDoc(Collections.financeEntries, 'c1', {
        'id': 'c1',
        'kind': 'adjust',
        'entryDate': '2026-10-10',
        'fundId': 'f1',
        'correctsId': 'p2',
        'correctionKind': 'amount',
        'amountSen': 25000,
        'reason': 'Kiraan semula: 250',
        'editedAt': '2026-10-10T01:00:00.000Z',
      });
      expect(await repo.suggestedFee('pen1'), 25000);
      expect(await repo.suggestedFee('nobody'), isNull);
    });

    test('pendingFinanceCount counts finance ops only', () async {
      await repo.appendCollection(cash());
      await engine.enqueue(
        kind: 'content.put',
        entity: 'content:pengumuman',
        entityId: 'p1',
        payload: {'title': 'x'},
      );
      expect(await engine.outbox.count, 2);
      expect(await repo.pendingFinanceCount(), 1);
    });
  });

  group('sync wiring', () {
    test('the snapshot finance block lands in the five collections', () async {
      await store.setMeta('seq@box', null);
      server.snapshot['finance'] = {
        'funds': [
          {'id': 'f9', 'name': 'Tabung Baru', 'sortOrder': 1},
        ],
        'perihal': [
          {'id': 'p9', 'direction': 'out', 'label': 'Utiliti'},
        ],
        'entries': [
          {
            'id': 'e9',
            'kind': 'in',
            'entryDate': '2026-11-02',
            'fundId': 'f9',
            'amountSen': 100,
            'refNo': 'K-0001',
          },
        ],
        'months': [
          {'ym': '2026-10', 'status': 'closed', 'report': null},
        ],
        'photos': [
          {
            'id': 'a' * 64,
            'entryId': 'e9',
            'mime': 'image/jpeg',
            'bytes': 10,
            'present': true,
          },
        ],
      };
      await engine.sync();
      expect(server.snapshotCalls, 1);
      expect((await store.list(Collections.financeFunds)).single['id'], 'f9');
      expect((await store.list(Collections.financePerihal)).single['id'], 'p9');
      expect(
        (await store.list(Collections.financeEntries)).single['refNo'],
        'K-0001',
      );
      expect(
        (await store.getDoc(Collections.financeMonths, '2026-10'))!['status'],
        'closed',
      );
      expect(
        (await store.list(Collections.financePhotos)).single['entryId'],
        'e9',
      );
    });

    test(
      'a snapshot without a finance block empties the copies (no finance:read)',
      () async {
        await store.putDoc(Collections.financeEntries, 'old', {
          'id': 'old',
          'kind': 'in',
        });
        await store.setMeta('seq@box', null);
        await engine.sync();
        expect(await store.list(Collections.financeEntries), isEmpty);
        expect(await store.list(Collections.financeFunds), isEmpty);
      },
    );

    test(
      'feed entries of every finance entity land in their collection',
      () async {
        server.seq = 5;
        server.entries = [
          for (final (i, x) in [
            (
              'finance:entry',
              'e1',
              {
                'id': 'e1',
                'kind': 'in',
                'entryDate': '2026-11-02',
                'fundId': 'f1',
                'amountSen': 1,
              },
            ),
            ('finance:fund', 'f7', {'name': 'Tabung Tujuh', 'sortOrder': 7}),
            ('finance:perihal', 'p7', {'direction': 'in', 'label': 'Derma'}),
            (
              'finance:month',
              '2026-11',
              {'ym': '2026-11', 'status': 'open', 'report': null},
            ),
            (
              'finance:photo',
              'b' * 64,
              {'entryId': 'e1', 'mime': 'image/jpeg', 'bytes': 9},
            ),
          ].indexed)
            {
              'seq': i + 1,
              'entity': x.$1,
              'entityId': x.$2,
              'rev': '2026-11-10T03:05:00.00${i}Z|dev-9',
              'editedAt': '2026-11-10T03:05:00.000Z',
              'opId': null,
              'after': x.$3,
            },
        ];
        await engine.sync();
        expect(
          (await store.getDoc(Collections.financeEntries, 'e1'))!['amountSen'],
          1,
        );
        expect(
          (await store.getDoc(Collections.financeFunds, 'f7'))!['id'],
          'f7',
        );
        expect(
          (await store.getDoc(Collections.financePerihal, 'p7'))!['label'],
          'Derma',
        );
        expect(
          (await store.getDoc(Collections.financeMonths, '2026-11'))!['status'],
          'open',
        );
        expect(
          (await store.getDoc(Collections.financePhotos, 'b' * 64))!['id'],
          'b' * 64,
        );
      },
    );
  });

  group('live-only and the gateway', () {
    test('the PDF, the stored photo, the share record and the audit need a connection', () {
      expect(isLiveOnly('GET', '/api/finance/report/2026-10.pdf'), isTrue);
      expect(isLiveOnly('GET', '/api/finance/photos/${'a' * 64}'), isTrue);
      expect(isLiveOnly('POST', '/api/finance/report/2026-10/shared'), isTrue);
      expect(isLiveOnly('GET', '/api/finance/audit'), isTrue);
    });

    test('writes and the JSON report are not live-only', () {
      expect(isLiveOnly('PUT', '/api/finance/entries/x'), isFalse);
      expect(isLiveOnly('PUT', '/api/finance/funds/x'), isFalse);
      expect(isLiveOnly('PUT', '/api/finance/months/2026-10'), isFalse);
      expect(isLiveOnly('POST', '/api/finance/photos'), isFalse);
      expect(isLiveOnly('GET', '/api/finance/report/2026-10'), isFalse);
      expect(isLiveOnly('GET', '/api/finance/summary'), isFalse);
    });

    late BoxGateway gw;
    late int networkCalls;
    setUp(() {
      networkCalls = 0;
      final box = FakeBox((r) async {
        networkCalls++;
        throw http.ClientException('away');
      });
      gw = BoxGateway(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        token: 'tok-1',
        cache: ReadCache(),
        reach: _Reach(),
        now: now,
        onSessionExpired: () {},
        store: store,
        engine: engine,
      );
    });

    test('PUT /api/finance/entries/:id queues finance.append and answers with the pending row', () async {
      final out = await gw.put('/api/finance/entries/01HNEWENTRY', {
        ...cash(),
        'kind': 'in',
        'refNo': 'K-1',
      });
      expect(networkCalls, 0);
      expect((out['entry'] as Map)['id'], '01HNEWENTRY');
      expect((out['entry'] as Map)['pending'], isTrue);
      final op = (await engine.outbox.pending()).single;
      expect(op.kind, 'finance.append');
      expect(op.entity, 'finance:entry');
      expect(op.entityId, '01HNEWENTRY');
      expect(op.payload as Map, isNot(contains('refNo')));
    });

    test('funds, perihal and months map to their ops', () async {
      await gw.put('/api/finance/funds/f5', {
        'name': 'Tabung Lima',
        'public': false,
        'targetSen': null,
        'jumaat': false,
        'sortOrder': 5,
        'archivedAt': null,
      });
      await gw.put('/api/finance/perihal/p5', {
        'direction': 'out',
        'label': 'Air',
        'sortOrder': 1,
        'archivedAt': null,
      });
      await gw.put('/api/finance/months/2026-10', {'status': 'closed'});
      final ops = await engine.outbox.pending();
      expect(
        [for (final o in ops) '${o.kind} ${o.entity} ${o.entityId}'],
        [
          'finance.lookup.put finance:fund f5',
          'finance.lookup.put finance:perihal p5',
          'finance.month.put finance:month 2026-10',
        ],
      );
    });

    test(
      'POST /api/finance/photos queues finance.photo.put with its bytes',
      () async {
        final jpeg = jpegBytes();
        final out = await gw.postRaw(
          '/api/finance/photos',
          jpeg,
          'image/jpeg',
          headers: {'X-Entry-Id': '01HENTRY'},
        );
        expect(out['id'], sha256HexOf(jpeg));
        expect(networkCalls, 0);
        final op = (await engine.outbox.pending()).single;
        expect(op.kind, 'finance.photo.put');
        expect((op.payload as Map)['entryId'], '01HENTRY');
        // The bytes are served from the device, with no request.
        expect(
          await gw.getBytes('/api/finance/photos/${sha256HexOf(jpeg)}'),
          jpeg,
        );
        expect(networkCalls, 0);
      },
    );

    test('a photo that is not on the device is live-only', () async {
      await expectLater(
        gw.getBytes('/api/finance/photos/${'c' * 64}'),
        throwsA(isA<LiveOnly>()),
      );
    });

    test(
      'reads come from the local ledger, in the box shapes, with no request',
      () async {
        await store.putDoc(Collections.financeEntries, 'a1', {
          'id': 'a1',
          'kind': 'in',
          'entryDate': '2026-11-05',
          'fundId': 'f1',
          'amountSen': 30000,
          'editedAt': '2026-11-05T01:00:00.000Z',
        });
        await store.putDoc(Collections.financeEntries, 'c1', {
          'id': 'c1',
          'kind': 'adjust',
          'entryDate': '2026-11-06',
          'fundId': 'f1',
          'correctsId': 'a1',
          'correctionKind': 'amount',
          'amountSen': 25000,
          'reason': 'Kiraan semula: 250',
          'editedAt': '2026-11-06T01:00:00.000Z',
          'receivedAt': '2026-11-06T01:00:00.000Z',
        });
        final s = (await gw.get('/api/finance/summary')).value;
        expect((s['funds'] as List).first, containsPair('balanceSen', 25000));
        expect((s['month'] as Map)['ym'], '2026-11');
        expect((s['counts'] as Map)['corrections'], 1);
        final list = (await gw.get('/api/finance/entries?ym=2026-11')).value;
        expect((list['entries'] as List).map((e) => (e as Map)['id']), [
          'a1',
          'c1',
        ]);
        final one = (await gw.get('/api/finance/entries/a1')).value;
        expect((one['effective'] as Map)['effAmountSen'], 25000);
        expect((one['corrections'] as List), hasLength(1));
        expect(
          ((await gw.get('/api/finance/funds')).value['funds'] as List),
          hasLength(2),
        );
        final rep = (await gw.get('/api/finance/report/2026-11')).value;
        expect(rep['ym'], '2026-11');
        expect((rep['totals'] as Map)['closingSen'], 25000);
        expect(networkCalls, 0);
      },
    );
  });
}
