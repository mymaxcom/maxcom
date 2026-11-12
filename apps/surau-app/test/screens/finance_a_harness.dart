// Shared set-up of the Task 8a screen tests (home, kutipan, bayaran,
// pembetulan): the whole app over a fake box, with a finance repository on a
// MemoryLocalStore and the in-memory sync server standing in for the local
// copy. Date: 2026-11-04 22:30 in Kuala Lumpur (a Wednesday).

import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/features/finance/finance_widgets.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart'
    show livePublisherProvider;
import 'package:surau_app/finance/finance_repository.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/outbox.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import '../sync/sync_fakes.dart';

/// A small valid JPEG for the photo picker.
Uint8List testJpeg([int w = 400, int h = 300]) {
  final im = img.Image(width: w, height: h);
  final r = Random(3);
  for (final p in im) {
    p
      ..r = r.nextInt(256)
      ..g = p.y * 255 ~/ h
      ..b = 90;
  }
  return Uint8List.fromList(img.encodeJpg(im, quality: 90));
}

class FinA {
  FinA._();

  late MemoryLocalStore store;
  late FakeSyncServer server;
  late SyncEngine engine;
  late FinanceRepository repo;
  DateTime clock = DateTime.utc(2026, 11, 4, 14, 30);

  static Future<FinA> create() async {
    final f = FinA._();
    f.store = MemoryLocalStore();
    await f.store.open('0123456789abcdef');
    f.server = FakeSyncServer();
    f.engine = SyncEngine(
      store: f.store,
      key: FakeDeviceKey(present: true),
      box: syncBox(),
      transport: FakeTransport(f.server),
      now: () => f.clock = f.clock.add(const Duration(seconds: 1)),
      autoSync: false,
      schedule: (d, fn) => Timer(const Duration(days: 1), () {}),
    );
    f.repo = FinanceRepository(
      store: f.store,
      engine: f.engine,
      now: () => f.clock,
    );
    await f.store.setMeta('seq', '0');
    await f.store.setMeta('seq@box', '0');
    await f.seed();
    return f;
  }

  void dispose() {
    repo.dispose();
    engine.dispose();
  }

  Future<void> entry(Map<String, dynamic> e) {
    final doc = <String, dynamic>{
      'createdBy': 'u2',
      'editedAt': '2026-11-02T03:00:00.000Z',
      'amountSen': 0,
      ...e,
    };
    return store.putDoc(Collections.financeEntries, doc['id'] as String, doc);
  }

  /// Three tabung, their perihal, four people, five lectures and the
  /// opening balances plus two entries.
  Future<void> seed() async {
    final funds = [
      ('f1', 'Tabung Jumaat', 1, true),
      ('f2', 'Tabung Am', 2, true),
      ('f3', 'Tabung Khairat Kematian', 3, false),
    ];
    for (final (id, name, order, public) in funds) {
      await store.putDoc(Collections.financeFunds, id, {
        'id': id,
        'name': name,
        'sortOrder': order,
        'public': public,
      });
    }
    final perihal = [
      ('in-j', 'in', 'Kutipan solat Jumaat', null),
      ('in-p', 'in', 'Peti derma pintu utama', null),
      ('out-pc', 'out', 'Penceramah', 'penceramah'),
      ('out-u', 'out', 'Utiliti', null),
      ('out-k', 'out', 'Kebersihan', null),
    ];
    for (final (id, dir, label, system) in perihal) {
      await store.putDoc(Collections.financePerihal, id, {
        'id': id,
        'direction': dir,
        'label': label,
        'system': system,
      });
    }
    for (final (id, name) in [
      ('u1', 'Ustaz Ali'),
      ('u2', 'Aminah binti Yusof'),
      ('u3', 'Encik Hafiz'),
      ('u4', 'Encik Kamal bin Hassan'),
    ]) {
      await store.putDoc(Collections.users, id, {
        'id': id,
        'name': name,
        'active': true,
        'roles': ['ajk'],
      });
    }
    await store.putDoc(Collections.devices, 'd1', {
      'id': 'd1',
      'name': 'Telefon Aminah (Android)',
    });
    for (final (id, name) in [
      ('p1', 'Ustaz Abu Bakar Ahmad'),
      ('p2', 'Ustaz Mohd Hafiz bin Rahman'),
      ('p3', 'Ustaz Haji Ahmad Fauzi bin Ismail'),
    ]) {
      await store.putDoc(Collections.content('penceramah'), id, {
        'id': id,
        'name': name,
      });
    }
    final kuliah = [
      ('k1', '2026-11-03', 'Tafsir Surah Al-Kahfi (siri 4)', 'p1', null),
      ('k2', '2026-11-02', 'Fiqh Solat: sujud sahwi', 'p2', null),
      ('k3', '2026-11-04', 'Sifat 20: Wujud, Qidam dan Baqa', 'p3', null),
      ('k4', '2026-11-10', 'Tafsir Surah Al-Kahfi (siri 5)', 'p1', null),
      ('k5', '2026-10-30', 'Sifat 20: sifat nafsiyah', 'p3', 'batal'),
    ];
    for (final (id, date, topic, pid, status) in kuliah) {
      await store.putDoc(Collections.content('kuliah'), id, {
        'id': id,
        'date': date,
        'time': '19:30',
        'topic': topic,
        'penceramahId': pid,
        'status': status ?? 'aktif',
      });
    }
    await entry({
      'id': 'o1',
      'kind': 'opening',
      'entryDate': '2026-10-01',
      'fundId': 'f1',
      'amountSen': 100000,
      'refNo': 'A-0001',
      'createdBy': 'u2',
      'editedAt': '2026-10-01T01:00:00.000Z',
    });
    await entry({
      'id': 'o2',
      'kind': 'opening',
      'entryDate': '2026-10-01',
      'fundId': 'f2',
      'amountSen': 50000,
      'refNo': 'A-0002',
      'editedAt': '2026-10-01T01:00:01.000Z',
    });
    await entry({
      'id': 'e1',
      'kind': 'in',
      'entryDate': '2026-11-02',
      'fundId': 'f1',
      'perihalId': 'in-j',
      'amountSen': 128430,
      'method': 'tunai',
      'counters': [
        {'userId': 'u3'},
        {'userId': 'u4'},
      ],
      'photoId': 'a' * 64,
      'deviceId': 'd1',
      'refNo': 'K-0118',
      'editedAt': '2026-11-02T08:41:00.000Z',
    });
    await entry({
      'id': 'e2',
      'kind': 'out',
      'entryDate': '2026-11-03',
      'fundId': 'f1',
      'perihalId': 'out-pc',
      'amountSen': 15000,
      'method': 'tunai',
      'kuliahId': 'k1',
      'penceramahId': 'p1',
      'penceramahName': 'Ustaz Abu Bakar Ahmad',
      'refNo': 'B-0071',
      'editedAt': '2026-11-03T12:31:00.000Z',
    });
    // The last fee paid to p3: the suggestion for tonight's lecture.
    await entry({
      'id': 'e3',
      'kind': 'out',
      'entryDate': '2026-10-31',
      'fundId': 'f1',
      'perihalId': 'out-pc',
      'amountSen': 15000,
      'method': 'tunai',
      'kuliahId': 'k0',
      'penceramahId': 'p3',
      'penceramahName': 'Ustaz Haji Ahmad Fauzi bin Ismail',
      'refNo': 'B-0070',
      'editedAt': '2026-10-31T12:31:00.000Z',
    });
  }

  /// A correction row of e1 already in the ledger.
  Future<void> seedCorrection() => entry({
    'id': 'c1',
    'kind': 'adjust',
    'entryDate': '2026-11-03',
    'fundId': 'f1',
    'amountSen': 126630,
    'correctsId': 'e1',
    'correctionKind': 'amount',
    'reason': 'Kiraan semula oleh 2 AJK: syiling RM18.00 dikira dua kali.',
    'refNo': 'P-0008',
    'editedAt': '2026-11-03T09:00:00.000Z',
    'receivedAt': '2026-11-03T09:00:01.000Z',
  });

  Future<List<OutboxOp>> ops() => engine.outbox.pending();
}

/// The app unlocked as [roles] with finance on, at [route].
Future<ShellHarness> pumpFinance(
  WidgetTester tester,
  FinA f, {
  List<String> roles = const ['treasurer'],
  String route = '/finance',
  GoldenSize size = GoldenSize.phone,
  FinanceSettings settings = const FinanceSettings(),
  Uint8List? picked,
}) async {
  final List<Override> overrides = [
    financeRepositoryProvider.overrideWithValue(f.repo),
    financeSettingsProvider.overrideWithValue(settings),
    livePublisherProvider.overrideWithValue(FakePublisher()),
  ];
  final h = await pumpShell(
    tester,
    roles: roles,
    features: const {'finance': true},
    size: size,
    overrides: overrides,
  );
  h.pickedImage = picked;
  h.router.go(route);
  await settle(tester);
  return h;
}

/// Scrolls to [finder] and taps it.
Future<void> tapAt(WidgetTester tester, Finder finder) async {
  await _bring(tester, finder);
  await tester.tap(finder.first);
  await settle(tester);
}

/// A lazy list builds a row only near the viewport: scroll until it exists.
Future<void> _bring(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty) await reveal(tester, finder);
  await tester.ensureVisible(finder.first);
  await tester.pump();
}

/// Scrolls to the field, replaces its text.
Future<void> typeAt(WidgetTester tester, Finder finder, String text) async {
  await _bring(tester, finder);
  await tester.enterText(finder.first, text);
  await tester.pump();
}

Future<bool> buttonEnabled(WidgetTester tester, Finder finder) async {
  await _bring(tester, finder);
  final w = tester.widget(finder.first);
  if (w is FilledButton) return w.onPressed != null;
  if (w is OutlinedButton) return w.onPressed != null;
  if (w is TextButton) return w.onPressed != null;
  throw StateError('not a button: ${w.runtimeType}');
}
