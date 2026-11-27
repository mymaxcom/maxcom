// C5 of the 2026.11.15 Siaran langsung revamp (B13): the dashboard banner
// "Siaran sedang berlangsung" follows the box's status (it goes within one
// poll after the live ends, also when one read throws), and a sync that
// failed against the box does not turn the cloud icon red.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_notice_box.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/connection_icons.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/features/sync/sync_status_chip.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../../sync/sync_fakes.dart';
import '../fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

const _notice = {
  'active': true,
  'videoId': 'abcdefghijk',
  'watchUrl': 'https://youtube.com/live/abcdefghijk',
  'text': 'Kuliah Maghrib sedang berlangsung',
};

void main() {
  group('[B13] the dashboard banner follows the box', () {
    late bool sessionOn;
    late bool statusThrows;
    late int statusReads;
    late ProviderContainer c;

    setUp(() {
      sessionOn = true;
      statusThrows = false;
      statusReads = 0;
      final box = FakeBox((r) async {
        if (r.url.path == '/api/live/notice') return jsonResponse(200, _notice);
        if (r.url.path == '/api/live/status') {
          statusReads++;
          if (statusThrows) throw http.ClientException('one read fails');
          return jsonResponse(200, {
            'session': sessionOn ? {'id': 's1', 'startedBy': 'Tablet Surau'} : null,
          });
        }
        return jsonResponse(404, {'errors': ['tiada']});
      });
      c = ProviderContainer(
        overrides: [
          gatewayProvider.overrideWithValue(
            BoxGateway(
              client: box.client(Uri.parse('https://box.test:8443')),
              token: 't',
              cache: ReadCache(),
              reach: _Reach(),
              now: () => DateTime.utc(2026, 11, 23, 12),
              onSessionExpired: () {},
            ),
          ),
          rolesProvider.overrideWithValue(const {'live'}),
          liveBoxProvider.overrideWith(() => LiveBoxNotifier()),
          liveNoticePollIntervalProvider.overrideWithValue(const Duration(milliseconds: 20)),
        ],
      );
      c.listen(liveBoxNoticeProvider, (_, _) {});
    });

    tearDown(() => c.dispose());

    Future<BoxLiveNotice?> shown() async {
      // let the slow poll's timer fire and the provider read again
      await Future<void>.delayed(const Duration(milliseconds: 60));
      return c.read(liveBoxNoticeProvider.future);
    }

    test('while the live runs the banner stays (success path)', () async {
      expect(await c.read(liveBoxNoticeProvider.future), isNotNull);
      expect(await shown(), isNotNull);
      expect(statusReads, greaterThan(1), reason: 'a slow poll stays alive while the notice is shown');
    });

    test('the banner goes within one poll after the session ends, with no other trigger', () async {
      expect(await c.read(liveBoxNoticeProvider.future), isNotNull);
      sessionOn = false;
      expect(await shown(), isNull);
    });

    test('one status read throws: the banner is kept for that read, then goes at the next poll', () async {
      expect(await c.read(liveBoxNoticeProvider.future), isNotNull);
      sessionOn = false;
      statusThrows = true;
      expect(await shown(), isNotNull, reason: 'a failed read is not "the live is over"');
      statusThrows = false;
      expect(await shown(), isNull, reason: 'the poll retried instead of keeping the banner for good');
    });

    test('with no live the poll stops', () async {
      sessionOn = false;
      expect(await c.read(liveBoxNoticeProvider.future), isNull);
      final before = statusReads;
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(statusReads, before);
    });
  });

  group('[B13] a sync failure against the box does not turn the cloud icon red', () {
    final last = DateTime.utc(2026, 11, 23, 11);

    test('failed with the box: the cloud icon stays as it was, the failure is the box icon\'s', () {
      const v = SyncView(state: SyncState.offline, lastError: 'unreachable', failedVia: 'box');
      final withSync = SyncView(state: SyncState.offline, lastError: 'http_500', failedVia: 'box', lastSync: last);
      expect(boxSyncFailed(v), isTrue);
      expect(cloudStateOf(v), LinkState.connecting, reason: 'never synced: not red');
      expect(cloudStateOf(withSync), LinkState.connected);
      expect(cloudStateOf(withSync), isNot(LinkState.error));
    });

    test('the sync sheet words a failure with the box as its own, never as "MAXCOM dan awan"', () {
      final s = SMs();
      const box = SyncView(state: SyncState.offline, lastError: 'unreachable', failedVia: 'box');
      expect(syncSheetErrorWords(s, box), 'Tidak dapat menyelaras dengan MAXCOM');
      expect(syncSheetErrorWords(s, const SyncView(state: SyncState.offline, lastError: 'http_500', failedVia: 'box')), s.syncBoxFailed);
      // no base answered, or the cloud exchange failed: the words of before
      expect(syncSheetErrorWords(s, const SyncView(state: SyncState.offline, lastError: 'unreachable')), s.syncErrUnreachable);
      expect(syncSheetErrorWords(s, const SyncView(state: SyncState.offline, lastError: 'http_500', failedVia: 'cloud')), s.syncErrFailed);
      // a cause with words of its own keeps them, whichever base it was
      expect(syncSheetErrorWords(s, const SyncView(lastError: 'needs_unlock', failedVia: 'box')), s.syncErrNeedsUnlock);
      expect(syncSheetErrorWords(s, const SyncView(lastError: 'forbidden', failedVia: 'box')), syncErrorWords(s, 'forbidden'));
      expect(syncSheetErrorWords(s, const SyncView()), isNull);
      expect(syncSheetErrorWords(SEn(), box), 'Cannot sync with MAXCOM');
    });

    test('no base answered at all, or the cloud exchange failed: the cloud icon is red as before', () {
      expect(cloudStateOf(SyncView(state: SyncState.offline, lastError: 'unreachable', lastSync: last)), LinkState.disconnected);
      expect(
        cloudStateOf(SyncView(state: SyncState.offline, lastError: 'unreachable', failedVia: 'cloud', lastSync: last)),
        LinkState.disconnected,
      );
      expect(
        cloudStateOf(SyncView(state: SyncState.offline, lastError: 'http_500', failedVia: 'cloud', lastSync: last)),
        LinkState.error,
      );
      expect(boxSyncFailed(SyncView(lastSync: last)), isFalse);
    });

    test('the engine names the base a failed exchange was with, and clears it on the next good run', () async {
      final store = MemoryLocalStore();
      await store.open('0123456789abcdef');
      final server = FakeSyncServer();
      final engine = SyncEngine(
        store: store,
        key: FakeDeviceKey(present: true),
        box: syncBox(),
        transport: FakeTransport(server), // via: box
        now: () => DateTime.utc(2026, 11, 23, 12),
        autoSync: false,
        schedule: (d, f) => Timer(const Duration(days: 1), () {}),
      );
      addTearDown(engine.dispose);
      server.away = true; // the box was found, then the exchange with it failed
      final failed = await engine.sync();
      expect(failed.lastError, 'unreachable');
      expect(failed.failedVia, 'box');
      expect(cloudStateOf(failed), isNot(LinkState.disconnected));
      server.away = false;
      final ok = await engine.sync();
      expect(ok.lastError, isNull);
      expect(ok.failedVia, isNull);
      expect(cloudStateOf(ok), LinkState.connected);
    });

    test('[G3] the ops body carries clockOffsetMs to the box when it is known, and never to the cloud', () async {
      Future<Map<String, dynamic>> pushVia(String via, int? offset) async {
        final store = MemoryLocalStore();
        await store.open('0123456789abcdef');
        final server = FakeSyncServer();
        final engine = SyncEngine(
          store: store,
          key: FakeDeviceKey(present: true),
          box: syncBox(),
          transport: FakeTransport(server, via: via),
          now: () => DateTime.utc(2026, 11, 23, 12),
          autoSync: false,
          schedule: (d, f) => Timer(const Duration(days: 1), () {}),
          clockOffsetMs: () => offset,
        );
        addTearDown(engine.dispose);
        await engine.enqueue(kind: 'settings.put', entity: 'settings', entityId: 'clock', payload: {'showSeconds': true});
        await engine.sync();
        return server.opBatches.single;
      }

      expect((await pushVia('box', 300000))['clockOffsetMs'], 300000);
      expect((await pushVia('box', null)).containsKey('clockOffsetMs'), isFalse, reason: 'unknown: the body is today\'s');
      expect((await pushVia('cloud', 300000)).containsKey('clockOffsetMs'), isFalse, reason: 'measured against the box only');
    });
  });
}
