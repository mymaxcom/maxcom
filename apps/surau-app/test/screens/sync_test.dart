// Plan 6 Task 9: the sync status chip in every state, its sheet with
// `Selaraskan sekarang`, the conflicts screen (a superseded edit with the
// winner's name, refusals in BM, `Guna versi saya semula` re-enqueues),
// the live-only dialog, the cloud sync settings page (https only, link
// status, sync now), the revoked device on the unlock screen and enrolment
// from home on the devices screen.
//
// Goldens: sync_chip_synced, sync_chip_pending, sync_chip_offline,
// sync_chip_waking, sync_chip_cloud, sync_sheet, conflicts,
// conflicts_empty, live_only_dialog, sync_settings_linked,
// sync_settings_unlinked, unlock_revoked_sync, devices_cloud.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart'
    show livePublisherProvider;
import 'package:surau_app/features/sync/live_only_dialog.dart';
import 'package:surau_app/features/sync/sync_actions.dart';
import 'package:surau_app/features/sync/sync_settings_screen.dart';
import 'package:surau_app/features/sync/sync_status_chip.dart';
import 'package:surau_app/sync/live_only.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

/// The engine as the screens see it: a view the test sets, and a record of
/// what was asked.
class FakeSyncActions implements SyncActions {
  FakeSyncActions(this.view, {List<Map<String, dynamic>>? conflicts})
    : list = conflicts ?? [];

  SyncView view;
  final List<Map<String, dynamic>> list;
  final StreamController<SyncView> _views = StreamController.broadcast();
  int syncCalls = 0;
  final List<Map<String, dynamic>> reapplied = [];
  final List<String> discarded = [];

  void set(SyncView v) {
    view = v;
    _views.add(v);
  }

  Stream<SyncView> views() async* {
    yield view;
    yield* _views.stream;
  }

  @override
  Future<SyncView> syncNow() async {
    syncCalls++;
    return view;
  }

  @override
  Future<List<Map<String, dynamic>>> conflicts() async => List.of(list);

  @override
  Future<void> discard(String opId) async {
    discarded.add(opId);
    list.removeWhere((c) => c['opId'] == opId);
    set(view.copyWith(conflicts: list.length));
  }

  @override
  Future<void> reapply(Map<String, dynamic> conflict) async {
    reapplied.add(conflict);
    list.removeWhere((c) => c['opId'] == conflict['opId']);
    set(view.copyWith(conflicts: list.length, pendingOut: view.pendingOut + 1));
  }
}

/// 22:25 Malaysian time on the harness's day (fixedNow is 22:30).
final DateTime _lastSync = DateTime.utc(2026, 11, 4, 14, 25);

SyncView _synced({String via = 'box', int conflicts = 0}) =>
    SyncView(lastSync: _lastSync, via: via, conflicts: conflicts);

/// A superseded announcement, a refused settings change and a picture too
/// large: one of each kind of card.
List<Map<String, dynamic>> conflictsFixture() => [
  {
    'opId': '01JC0000000000000000000003',
    'kind': 'content.put',
    'entity': 'content:pengumuman',
    'entityId': 'a1',
    'reason': 'superseded',
    'mine': {
      'title': 'Gotong-royong surau',
      'body': 'Ahad ini selepas Subuh. Bawa cangkul sendiri.',
      'priority': 2,
    },
    'winner': {
      'actor': 'user:u2',
      'userName': 'Aminah binti Yusof',
      'editedAt': '2026-11-04T14:12:00.000Z',
    },
    'editedAt': '2026-11-04T14:05:00.000Z',
    'at': '2026-11-04T14:20:00.000Z',
  },
  {
    'opId': '01JC0000000000000000000002',
    'kind': 'settings.put',
    'entity': 'settings',
    'entityId': 'jumaat',
    'reason': 'forbidden',
    'mine': {'khutbahMinutes': 25},
    'winner': null,
    'editedAt': '2026-11-04T13:40:00.000Z',
    'at': '2026-11-04T14:20:00.000Z',
  },
  {
    'opId': '01JC0000000000000000000001',
    'kind': 'asset.put',
    'entity': 'asset',
    'entityId': 'f' * 64,
    'reason': 'too_large',
    'mine': {'mime': 'image/jpeg'},
    'winner': null,
    'editedAt': '2026-11-03T09:00:00.000Z',
    'at': '2026-11-04T14:20:00.000Z',
  },
];

List<Override> _overrides(FakeSyncActions fake) => [
  livePublisherProvider.overrideWithValue(FakePublisher()),
  syncActionsProvider.overrideWithValue(fake),
  syncViewProvider.overrideWith((ref) => fake.views()),
];

Future<ShellHarness> _open(
  WidgetTester tester,
  FakeSyncActions fake,
  String path, {
  List<String> roles = const ['admin'],
  GoldenSize size = GoldenSize.phone,
}) async {
  final h = await pumpShell(
    tester,
    roles: roles,
    size: size,
    overrides: _overrides(fake),
  );
  h.router.go(path);
  await settle(tester);
  return h;
}

Finder _chip(SyncChipKind kind) =>
    find.byKey(ValueKey('sync-chip-${kind.name}'));

void main() {
  group('the chip', () {
    testWidgets('synced through MAXCOM: `Diselaraskan`', (tester) async {
      final fake = FakeSyncActions(_synced());
      final h = await _open(tester, fake, '/settings');
      expect(_chip(SyncChipKind.synced), findsOneWidget);
      expect(find.text('Diselaraskan'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_chip_synced');
    });

    testWidgets('3 edits waiting', (tester) async {
      final fake = FakeSyncActions(_synced().copyWith(pendingOut: 3));
      final h = await _open(tester, fake, '/settings');
      expect(
        find.text('3 menunggu'),
        findsOneWidget,
        reason: 'short on a phone',
      );
      expect(find.bySemanticsLabel('3 perubahan menunggu'), findsOneWidget);
      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniPortrait);
      expect(find.text('3 perubahan menunggu'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_chip_pending');
    });

    testWidgets('offline: short on a phone, the whole sentence on an iPad', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced().copyWith(
          pendingOut: 3,
          state: SyncState.offline,
          lastError: 'unreachable',
        ),
      );
      final h = await _open(tester, fake, '/settings');
      expect(_chip(SyncChipKind.offline), findsOneWidget);
      expect(find.text('Luar talian'), findsOneWidget);
      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      expect(
        find.text('Luar talian, akan diselaraskan kemudian'),
        findsOneWidget,
      );
      await expectGoldens(tester, h.app, 'sync_chip_offline');
    });

    testWidgets('the cloud is waking: `Menyambung ke awan...`', (tester) async {
      final fake = FakeSyncActions(_synced().copyWith(state: SyncState.waking));
      final h = await _open(tester, fake, '/settings');
      expect(find.text('Menyambung...'), findsOneWidget);
      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      expect(find.text('Menyambung ke awan...'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_chip_waking');
    });

    testWidgets('synced through the cloud, with two conflicts', (tester) async {
      final fake = FakeSyncActions(_synced(via: 'cloud', conflicts: 2));
      final h = await _open(tester, fake, '/settings');
      expect(find.text('Melalui awan'), findsOneWidget);
      expect(find.byKey(const ValueKey('sync-chip-conflicts')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('Konflik: 2')), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_chip_cloud');
    });

    testWidgets('the chip follows the engine as it changes', (tester) async {
      final fake = FakeSyncActions(_synced());
      await _open(tester, fake, '/settings');
      fake.set(_synced().copyWith(pendingOut: 1));
      await settle(tester);
      expect(find.text('1 menunggu'), findsOneWidget);
    });

    testWidgets('no engine, no chip', (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      h.router.go('/settings');
      await settle(tester);
      expect(find.byType(SyncStatusChip), findsOneWidget);
      for (final k in SyncChipKind.values) {
        expect(_chip(k), findsNothing);
      }
      expect(find.text('Diselaraskan'), findsNothing);
      expect(find.byKey(const ValueKey('sync-dashboard')), findsNothing);
    });

    test('chipKindOf: the most urgent state wins', () {
      expect(chipKindOf(_synced()), SyncChipKind.synced);
      expect(chipKindOf(_synced(via: 'cloud')), SyncChipKind.viaCloud);
      expect(
        chipKindOf(_synced().copyWith(pendingOut: 2)),
        SyncChipKind.pending,
      );
      expect(
        chipKindOf(_synced().copyWith(pendingOut: 2, state: SyncState.offline)),
        SyncChipKind.offline,
      );
      expect(
        chipKindOf(_synced().copyWith(state: SyncState.waking)),
        SyncChipKind.waking,
      );
      expect(
        chipKindOf(const SyncView(state: SyncState.syncing)),
        SyncChipKind.running,
      );
    });
  });

  group('the sheet', () {
    testWidgets('a tap opens it; `Selaraskan sekarang` syncs; conflicts open', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced().copyWith(pendingOut: 2, conflicts: 1),
        conflicts: [conflictsFixture().first],
      );
      final h = await _open(tester, fake, '/settings');
      await tester.tap(_chip(SyncChipKind.pending));
      await settle(tester);
      expect(find.text('Penyelarasan'), findsOneWidget);
      expect(find.text('Melalui MAXCOM di surau'), findsOneWidget);
      expect(find.text('22:25'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_sheet');

      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.tap(find.text('Selaraskan sekarang'));
      await settle(tester);
      expect(fake.syncCalls, 1);

      await tester.tap(find.text('Lihat konflik (1)'));
      await settle(tester);
      expect(find.text('Pengumuman: Gotong-royong surau'), findsOneWidget);
    });

    testWidgets('sync now while offline says it needs a connection', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced().copyWith(state: SyncState.offline, lastError: 'unreachable'),
      );
      await _open(tester, fake, '/settings');
      await tester.tap(_chip(SyncChipKind.offline));
      await settle(tester);
      expect(
        find.text('MAXCOM dan awan tidak dapat dihubungi'),
        findsOneWidget,
      );
      await tester.tap(find.text('Selaraskan sekarang'));
      await settle(tester);
      expect(find.text('Perlukan sambungan'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-only-action')), findsOneWidget);
    });
  });

  group('conflicts', () {
    testWidgets('each card: what, when, who won or why refused', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced(conflicts: 3),
        conflicts: conflictsFixture(),
      );
      final h = await _open(tester, fake, '/sync/conflicts');
      expect(h.location, '/sync/conflicts');
      expect(find.text('Pengumuman: Gotong-royong surau'), findsOneWidget);
      expect(find.text('Perubahan anda pada 22:05'), findsOneWidget);
      expect(
        find.text('Menang: Aminah binti Yusof pada 22:12'),
        findsOneWidget,
      );
      expect(find.textContaining('Bawa cangkul sendiri'), findsOneWidget);
      expect(find.text('Ditolak: tiada kebenaran'), findsOneWidget);
      expect(find.text('Ditolak: fail terlalu besar'), findsOneWidget);
      expect(
        find.text('Guna versi saya semula'),
        findsOneWidget,
        reason: 'only the superseded edit can be sent again',
      );
      await expectGoldens(tester, h.app, 'conflicts');
    });

    testWidgets('`Guna versi saya semula` re-enqueues; `Buang` forgets', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced(conflicts: 3),
        conflicts: conflictsFixture(),
      );
      await _open(tester, fake, '/sync/conflicts');
      await tester.tap(find.text('Guna versi saya semula'));
      await settle(tester);
      expect(fake.reapplied.single['opId'], '01JC0000000000000000000003');
      expect(find.text('Versi anda dihantar semula'), findsOneWidget);
      expect(find.text('Pengumuman: Gotong-royong surau'), findsNothing);

      await tester.tap(find.text('Buang').first);
      await settle(tester);
      expect(fake.discarded, ['01JC0000000000000000000002']);
    });

    testWidgets('none: `Tiada konflik`', (tester) async {
      final fake = FakeSyncActions(_synced());
      final h = await _open(tester, fake, '/sync/conflicts');
      expect(find.text('Tiada konflik'), findsOneWidget);
      await expectGoldens(tester, h.app, 'conflicts_empty');
    });
  });

  group('live-only', () {
    testWidgets('`Daftar peranti baharu` offline opens the dialog naming it', (
      tester,
    ) async {
      final fake = FakeSyncActions(
        _synced().copyWith(state: SyncState.offline, lastError: 'unreachable'),
      );
      final h = await _open(tester, fake, '/devices');
      await tester.tap(find.byKey(const ValueKey('devices-enrol-new')));
      await settle(tester);
      expect(find.text('Perlukan sambungan'), findsOneWidget);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('live-only-action')))
            .data,
        'Daftar peranti baharu',
      );
      expect(
        find.textContaining(
          'Tindakan ini perlu sambungan ke MAXCOM di surau atau awan',
        ),
        findsOneWidget,
      );
      expect(h.box.byPath('/api/enrol/begin'), isNull, reason: 'nothing sent');
      await expectGoldens(tester, h.app, 'live_only_dialog');
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.tap(find.text('Faham'));
      await settle(tester);
      expect(find.text('Perlukan sambungan'), findsNothing);
    });

    testWidgets('a LiveOnly error names its action from the list', (
      tester,
    ) async {
      late BuildContext ctx;
      final fake = FakeSyncActions(_synced());
      await _open(tester, fake, '/settings');
      ctx = tester.element(find.byType(SyncStatusChip).first);
      unawaited(
        showLiveOnlyIf(ctx, const LiveOnly('/api/devices/dev-2/revoke')),
      );
      await settle(tester);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('live-only-action')))
            .data,
        'Batalkan peranti',
      );
      expect(LiveOnly.message, 'Perlukan sambungan ke MAXCOM atau awan');
      expect(liveOnlyLabelFor('/api/sync/run'), 'Selaraskan sekarang');
    });
  });

  group('enrol from home', () {
    testWidgets(
      'through the cloud: the note, then the person, then the QR page',
      (tester) async {
        final fake = FakeSyncActions(_synced(via: 'cloud'));
        final h = await _open(tester, fake, '/devices');
        expect(
          find.text(
            'Anda disambungkan melalui awan. Kod QR dibuat oleh awan dan boleh diimbas dari rumah.',
          ),
          findsOneWidget,
        );
        await expectGoldens(tester, h.app, 'devices_cloud');
        await pumpAtSize(tester, h.app, GoldenSize.phone);
        await tester.tap(find.byKey(const ValueKey('devices-enrol-new')));
        await settle(tester);
        expect(find.text('Peranti ini untuk siapa?'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('enrol-for-u4')),
          findsNothing,
          reason: 'inactive',
        );
        await tester.tap(find.byKey(const ValueKey('enrol-for-u2')));
        await settle(tester);
        expect(h.location, '/users/u2/enrol');
      },
    );
  });

  group('cloud sync settings', () {
    Map<String, Object?> linked() => {
      'linked': true,
      'cloudUrl': 'https://api.maxcom.my',
      'lastPush': '2026-11-04T14:21:00.000Z',
      'lastPull': '2026-11-04T14:28:00.000Z',
      'pendingOut': 0,
      'lastError': null,
    };

    Future<ShellHarness> openSettings(
      WidgetTester tester, {
      required Map<String, Object?> status,
      String cloudUrl = '',
      List<String> roles = const ['admin'],
    }) async {
      final fake = FakeSyncActions(_synced());
      final h = ShellHarness(roles: roles, overrides: _overrides(fake));
      h.settings['cloudSync'] = {
        'enabled': true,
        'cloudUrl': cloudUrl,
        'dirtyCheckSeconds': 120,
      };
      h.handlers['GET $syncStatusPath'] = (r) async =>
          jsonResponse(200, status);
      h.handlers['POST $syncRunPath'] = (r) async => jsonResponse(200, status);
      h.unlock();
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      h.router.go('/settings/sync');
      await settle(tester);
      return h;
    }

    testWidgets('linked: the status rows read `Ya` and the times', (
      tester,
    ) async {
      final h = await openSettings(
        tester,
        status: linked(),
        cloudUrl: 'https://api.maxcom.my',
      );
      expect(find.text('Penyelarasan awan'), findsWidgets);
      expect(find.text('Dipautkan ke awan'), findsOneWidget);
      expect(find.text('Ya'), findsOneWidget);
      expect(find.text('22:21'), findsOneWidget);
      expect(find.text('22:28'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_settings_linked');
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await reveal(
        tester,
        find.text('Pautan dibuat oleh pentadbir sistem di MAXCOM.'),
      );
      expect(
        find.text('Pautan dibuat oleh pentadbir sistem di MAXCOM.'),
        findsOneWidget,
      );
    });

    testWidgets('unlinked, with the last error', (tester) async {
      final h = await openSettings(
        tester,
        status: {
          'linked': false,
          'cloudUrl': null,
          'lastPush': null,
          'lastPull': null,
          'pendingOut': 4,
          'lastError': 'Awan tidak dapat dihubungi',
        },
      );
      expect(find.text('Tidak'), findsOneWidget);
      expect(find.text('Awan tidak dapat dihubungi'), findsOneWidget);
      await expectGoldens(tester, h.app, 'sync_settings_unlinked');
    });

    testWidgets('the address is read-only; only the Pentadbir MAXCOM may switch or change the interval', (
      tester,
    ) async {
      final admin = await openSettings(tester, status: linked(), cloudUrl: 'https://api.mymaxcom.my');
      Switch sw() => tester.widget<Switch>(
        find.descendant(of: find.byKey(const ValueKey('cloud-enabled')), matching: find.byType(Switch)),
      );
      final url = find.byKey(const ValueKey('cloud-url'));
      expect(sw().onChanged, isNull, reason: 'a surau admin cannot switch it off');
      expect(tester.widget<TextField>(url).readOnly, isTrue);
      expect(find.text('Ditetapkan semasa MAXCOM dipautkan ke awan'), findsOneWidget);
      expect(find.text('Simpan perubahan'), findsNothing);
      expect(tester.widget<ChoiceChip>(find.byKey(const ValueKey('setting-dirtyCheckSeconds-300'))).onSelected, isNull);
      await reveal(tester, find.byKey(const ValueKey('sync-run')));
      expect(find.byKey(const ValueKey('sync-run')), findsOneWidget, reason: 'sync now stays settings:write');
      expect(admin.box.byPath('/api/settings/cloudSync'), isNull);

      final sup = await openSettings(tester, status: linked(), cloudUrl: 'https://api.mymaxcom.my', roles: const ['superadmin']);
      expect(sw().onChanged, isNotNull);
      expect(tester.widget<TextField>(url).readOnly, isTrue, reason: 'still set by the link');
      await tester.tap(find.byKey(const ValueKey('setting-dirtyCheckSeconds-300')));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('cloud-enabled')), matching: find.byType(Switch)));
      await settle(tester);
      await reveal(tester, find.text('Simpan perubahan'));
      await tester.tap(find.text('Simpan perubahan'));
      await settle(tester);
      expect(jsonDecode(sup.box.byPath('/api/settings/cloudSync')!.body), {'enabled': false, 'dirtyCheckSeconds': 300});
    });

    testWidgets('`Selaraskan sekarang` asks MAXCOM to sync', (tester) async {
      final h = await openSettings(tester, status: linked());
      await reveal(tester, find.byKey(const ValueKey('sync-run')));
      await tester.tap(find.byKey(const ValueKey('sync-run')));
      await settle(tester);
      expect(h.box.byPath(syncRunPath)?.method, 'POST');
      expect(find.text('Penyelarasan selesai'), findsOneWidget);
    });

    testWidgets('/settings/cloudSync opens the same page', (tester) async {
      final h = await openSettings(tester, status: linked(), roles: const ['superadmin']);
      h.router.go('/settings/cloudSync');
      await settle(tester);
      expect(find.byType(SyncSettingsScreen), findsOneWidget);
    });

  });

  group('revoked', () {
    testWidgets('the unlock screen says so and offers only enrol again', (
      tester,
    ) async {
      final h = ShellHarness(roles: const ['admin']);
      h.container.read(revokedProvider.notifier).set();
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await settle(tester);
      expect(h.location, '/unlock');
      expect(find.text('Peranti ini telah dibatalkan'), findsOneWidget);
      expect(find.text('Daftar semula'), findsOneWidget);
      await expectGoldens(tester, h.app, 'unlock_revoked_sync');

      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await tester.tap(find.text('Daftar semula'));
      await settle(tester);
      expect(h.location, '/enrol');
      expect(h.container.read(revokedProvider), isFalse);
    });
  });
}
