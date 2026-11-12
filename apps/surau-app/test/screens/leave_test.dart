// Plan 14 in the shell: leave the surau, the box row and the away banner on the device list, the pairing page away
// from the surau network, the recovery code rotation, and the scan and network-check entries on "Peranti ini".

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/features/sync/sync_actions.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../support/box_qr_fixture.dart';

/// Opens the shell on the dashboard, lets [before] set the box's answers, then goes to [path].
Future<ShellHarness> open(
  WidgetTester tester,
  String path, {
  List<String> roles = const ['admin'],
  List<Override> overrides = const [],
  void Function(ShellHarness h)? before,
}) async {
  final h = await pumpShell(tester, roles: roles, overrides: overrides);
  before?.call(h);
  h.router.go(path);
  await settle(tester);
  return h;
}

http.Response boxInfo() => jsonResponse(200, {
  'boxId': '0123456789abcdef',
  'keyFp': '4f2a9c1e77b0d3a1',
  'name': 'MAXCOM Dewan Utama',
  'state': 'active',
  'reason': 'none',
  'linked': false,
  'https': true,
  'caSha256': null,
});

List<Override> viaCloud() => [
  syncViewProvider.overrideWith((ref) => Stream.value(SyncView(lastSync: DateTime.utc(2026, 11, 4, 14, 0), via: 'cloud'))),
];

Future<void> tapText(WidgetTester t, String text) async {
  final f = find.text(text);
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await settle(t);
}

Future<void> tapKey(WidgetTester t, String key) async {
  final f = find.byKey(ValueKey(key));
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await settle(t);
}

void main() {
  group('leave the surau', () {
    testWidgets('2xx: the box cancelled this phone, a final message, then the key and enrolment are gone', (tester) async {
      final h = await open(tester, '/this-device');
      h.handlers['POST /api/auth/leave'] = (r) async => jsonResponse(200, {'ok': true});
      await tapKey(tester, 'this-device-leave');
      expect(find.text('Keluar dari surau'), findsWidgets);
      expect(find.textContaining('Telefon ini akan dikeluarkan daripada Surau D\'Waqaf'), findsOneWidget);
      await tapKey(tester, 'leave-confirm');
      expect(h.box.byPath('/api/auth/leave')?.method, 'POST');
      expect(find.text('Anda sudah keluar'), findsOneWidget);
      expect(find.textContaining('tidak lagi menyertai Surau D\'Waqaf'), findsOneWidget);
      expect((h.deps.key as FakeDeviceKey).clearCalls, 1, reason: 'wiped before the message, so a killed app leaves nothing behind');
      expect(await h.deps.boxStore.load(), isNull);
      await tapKey(tester, 'left-join-other');
      expect((h.deps.key as FakeDeviceKey).clearCalls, 1);
      expect(h.location, '/enrol');
      expect(await h.deps.boxStore.load(), isNull);
    });

    testWidgets('Batal changes nothing and sends nothing', (tester) async {
      final h = await open(tester, '/this-device');
      await tapKey(tester, 'this-device-leave');
      await tester.tap(find.widgetWithText(TextButton, 'Batal'));
      await settle(tester);
      expect(h.box.byPath('/api/auth/leave'), isNull);
      expect(h.location, '/this-device');
      expect((h.deps.key as FakeDeviceKey).clearCalls, 0);
    });

    testWidgets('409 last_admin_device: the explanation, the enrolment stays, and a way to enrol another Pentadbir device', (tester) async {
      final h = await open(tester, '/this-device');
      h.handlers['POST /api/auth/leave'] = (r) async => jsonResponse(409, {
        'errors': ['Daftar peranti Pentadbir lain dahulu'],
        'code': 'last_admin_device',
      });
      await tapKey(tester, 'this-device-leave');
      await tapKey(tester, 'leave-confirm');
      expect(find.text('Telefon ini satu-satunya peranti Pentadbir'), findsOneWidget);
      expect(find.text('Anda sudah keluar'), findsNothing);
      expect((h.deps.key as FakeDeviceKey).clearCalls, 0);
      expect(await h.deps.boxStore.load(), isNotNull);
      await tapKey(tester, 'leave-enrol-other');
      expect(h.location, '/users');
    });

    testWidgets('the box away: it says the device stays active, and offers to forget this phone only', (tester) async {
      final h = await open(tester, '/this-device');
      h.boxAway = true;
      await tapKey(tester, 'this-device-leave');
      await tapKey(tester, 'leave-confirm');
      expect(find.textContaining('kekal aktif di MAXCOM'), findsOneWidget);
      expect((h.deps.key as FakeDeviceKey).clearCalls, 0);
      await tapKey(tester, 'leave-forget-only');
      expect((h.deps.key as FakeDeviceKey).clearCalls, 1);
      expect(h.location, '/enrol');
    });

    testWidgets('unsynced changes are counted in the confirm, with "Selaraskan sekarang"', (tester) async {
      final fake = _FakeSync(const SyncView(pendingOut: 3));
      final h = await open(
        tester,
        '/this-device',
        overrides: [syncActionsProvider.overrideWithValue(fake), syncViewProvider.overrideWith((ref) => Stream.value(fake.view))],
      );
      await tapKey(tester, 'this-device-leave');
      expect(find.text('3 perubahan belum diselaraskan'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('leave-sync-first')));
      await settle(tester);
      expect(fake.syncCalls, 1);
      expect(h.box.byPath('/api/auth/leave'), isNull);
    });
  });

  group('this device: the entries', () {
    testWidgets('"Imbas kod QR" opens the scan page; the network check reports the box and the cloud', (tester) async {
      final h = await open(tester, '/this-device');
      h.handlers['GET /api/box/info'] = (r) async => boxInfo();
      await tapKey(tester, 'this-device-netcheck');
      expect(find.text('MAXCOM dapat dihubungi'), findsOneWidget);
      expect(find.text('Tidak dipautkan ke awan'), findsOneWidget);
      await tester.tapAt(const Offset(10, 10));
      await settle(tester);
      await tapKey(tester, 'this-device-scan');
      expect(h.location, '/scan');
    });

    testWidgets('a box that does not answer is shown as not reachable', (tester) async {
      final h = await open(tester, '/this-device');
      h.boxAway = true;
      await tapKey(tester, 'this-device-netcheck');
      expect(find.text('MAXCOM tidak dapat dihubungi'), findsOneWidget);
    });

    testWidgets('on the scan page a probe QR gives the success line; a setup QR gives the leave-first card', (tester) async {
      final h = await open(tester, '/scan');
      h.handlers['GET /api/box/info'] = (r) async => boxInfoResponse('probe', state: 'active');
      h.handlers['POST /api/setup/probe'] = (r) async => jsonResponse(200, {'ok': true});
      expect(find.byKey(const ValueKey('scan-only-tv')), findsOneWidget);
      expect(find.text('Imbas hanya QR pada skrin TV MAXCOM. Jangan imbas QR daripada kertas, gambar atau mesej.'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('scan-paste')), boxQrText('probe'));
      await tapText(tester, 'Teruskan');
      // the host is shown and the phone asks first; nothing has been sent yet
      expect(find.text('Hantar ujian sambungan?'), findsOneWidget);
      expect(find.textContaining(Uri.parse(boxQrPayloadJson('probe')['box'] as String).authority), findsOneWidget);
      expect(h.box.byPath('/api/setup/probe'), isNull);
      await tapText(tester, 'Ya, hantar ujian');
      expect(find.text('Sambungan ke MAXCOM berjaya'), findsOneWidget);
      expect(h.box.bodyOf('/api/setup/probe')['nonce'], boxQrPayloadJson('probe')['nonce']);

      await tester.enterText(find.byKey(const ValueKey('scan-paste')), boxQrText('setup'));
      await tapText(tester, 'Teruskan');
      expect(find.text('Telefon ini sudah menyertai surau lain'), findsOneWidget);
      expect(find.text('Keluar dari Surau D\'Waqaf'), findsOneWidget);
    });
  });

  group('the device list and pairing', () {
    testWidgets('the box itself heads the list, with its id and no Batalkan', (tester) async {
      await open(tester, '/devices', before: (h) => h.handlers['GET /api/box/info'] = (r) async => boxInfo());
      final row = find.byKey(const ValueKey('devices-box-row'));
      expect(row, findsOneWidget);
      expect(find.text('MAXCOM Dewan Utama'), findsOneWidget);
      expect(find.textContaining('0123 4567 89AB CDEF'), findsOneWidget);
      expect(find.descendant(of: row, matching: find.text('Batalkan')), findsNothing);
      // the first card on the page
      expect(tester.getTopLeft(row).dy, lessThan(tester.getTopLeft(find.text('Ustaz Ali')).dy));
    });

    testWidgets('away from the surau: the banner on the list, and the pairing page needs the surau network', (tester) async {
      final h = await open(tester, '/devices', overrides: viaCloud());
      expect(find.byKey(const ValueKey('devices-away-banner')), findsOneWidget);
      h.router.go('/pairing');
      await settle(tester);
      expect(find.byKey(const ValueKey('pairing-needs-lan')), findsOneWidget);
      expect(find.text('Perlukan rangkaian surau'), findsOneWidget);
      expect(find.byKey(const ValueKey('pair-code')), findsNothing);
      expect(find.text('Menunggu kelulusan'), findsNothing);
    });

    testWidgets('at the surau the approve form is there and the answer says the screen mirrors the box', (tester) async {
      await open(tester, '/pairing', before: (h) {
        h.handlers['GET /api/box/info'] = (r) async => boxInfo();
        h.handlers['POST /api/kiosk/pair/approve'] = (r) async => jsonResponse(200, {'name': 'Skrin dewan', 'requesterIp': '10.168.0.50', 'codeAgeSeconds': 20});
      });
      expect(find.byKey(const ValueKey('pairing-needs-lan')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('pair-code')), '123456');
      await tester.enterText(find.byKey(const ValueKey('pair-name')), 'Skrin dewan');
      await tapText(tester, 'Luluskan');
      expect(find.textContaining('Ia kini mencerminkan MAXCOM Dewan Utama'), findsOneWidget);
    });
  });

  group('the invitation page', () {
    testWidgets('shows the box key fingerprint, and what became of the code: used at, and tried again', (tester) async {
      await open(
        tester,
        '/users/u2/enrol',
        before: (h) {
          h.handlers['GET /api/box/info'] = (r) async => boxInfo();
          h.handlers['GET /api/enrol/recent'] = (r) async => jsonResponse(200, {
            'codes': [
              {
                'userId': 'u2',
                'userName': 'Aminah binti Yusof',
                'deviceName': 'Telefon Aminah',
                'expiresAt': '2026-11-04T14:40:00.000Z',
                'usedAt': '2026-11-04T14:35:00.000Z',
                'reuseAttempts': 2,
              },
              {'userId': 'u3', 'userName': 'Encik Hafiz', 'deviceName': 'x', 'expiresAt': '2026-11-04T14:40:00.000Z', 'usedAt': '2026-11-04T14:36:00.000Z', 'reuseAttempts': 5},
            ],
          });
        },
      );
      await tester.enterText(find.byKey(const ValueKey('enrol-device-name')), 'Telefon Aminah');
      await tapText(tester, 'Jana kod QR');
      expect(find.text('Cap jari MAXCOM: 4F2A 9C1E 77B0 D3A1'), findsOneWidget);
      expect(find.byKey(const ValueKey('enrol-recent')), findsOneWidget);
      expect(find.textContaining('Digunakan '), findsOneWidget);
      expect(find.text('Cuba digunakan 2 kali'), findsOneWidget);
      expect(find.textContaining('5 kali'), findsNothing, reason: 'the code of another person');
    });
  });

  group('a box with no recovery code', () {
    testWidgets('a Pentadbir sees the warning on Pengguna, and Kod pemulihan baharu leads to the rotation', (tester) async {
      final h = await open(tester, '/users', before: (h) {
        h.handlers['GET /api/recovery/status'] = (r) async => jsonResponse(200, {'recoveryCodeSet': false});
      });
      expect(find.byKey(const ValueKey('users-no-recovery-warning')), findsOneWidget);
      expect(find.textContaining('belum ada kod pemulihan'), findsOneWidget);
      h.handlers['POST /api/recovery/code'] = (r) async => jsonResponse(200, {'recoveryCode': 'WXYZ-2345-6789-ABCD'});
      h.handlers['GET /api/recovery/status'] = (r) async => jsonResponse(200, {'recoveryCodeSet': true});
      await tapKey(tester, 'users-rotate-recovery');
      await tapText(tester, 'Jana kod baharu');
      expect(find.text('WXYZ-2345-6789-ABCD'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('recovery-code-written')));
      await tester.pumpAndSettle();
      await tapKey(tester, 'recovery-code-continue');
      expect(find.byKey(const ValueKey('users-no-recovery-warning')), findsNothing, reason: 'the warning goes once a code exists');
    });

    testWidgets('no warning when the box has a code', (tester) async {
      await open(tester, '/users', before: (h) {
        h.handlers['GET /api/recovery/status'] = (r) async => jsonResponse(200, {'recoveryCodeSet': true});
      });
      expect(find.byKey(const ValueKey('users-no-recovery-warning')), findsNothing);
    });

    testWidgets('a box that does not answer the status shows no warning', (tester) async {
      await open(tester, '/users', before: (h) {
        h.handlers['GET /api/recovery/status'] = (r) async => jsonResponse(404, {'errors': ['x']});
      });
      expect(find.byKey(const ValueKey('users-no-recovery-warning')), findsNothing);
    });
  });

  group('recovery code rotation', () {
    testWidgets('a Pentadbir confirms, then sees the new code once', (tester) async {
      final h = await open(tester, '/users');
      h.handlers['POST /api/recovery/code'] = (r) async => jsonResponse(200, {'recoveryCode': 'WXYZ-2345-6789-ABCD'});
      await tapKey(tester, 'users-rotate-recovery');
      expect(find.text('Kod lama tamat serta-merta. Kod baharu ditunjukkan sekali sahaja.'), findsOneWidget);
      await tapText(tester, 'Jana kod baharu');
      expect(h.box.byPath('/api/recovery/code')?.method, 'POST');
      expect(find.text('WXYZ-2345-6789-ABCD'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('recovery-code-written')));
      await tester.pumpAndSettle();
      await tapKey(tester, 'recovery-code-continue');
      expect(find.text('WXYZ-2345-6789-ABCD'), findsNothing);
    });

    testWidgets('429 says too many tries', (tester) async {
      final h = await open(tester, '/users');
      h.handlers['POST /api/recovery/code'] = (r) async => jsonResponse(429, {'errors': ['x']});
      await tapKey(tester, 'users-rotate-recovery');
      await tapText(tester, 'Jana kod baharu');
      expect(find.text('Terlalu banyak percubaan. Tunggu sebentar dan cuba lagi.'), findsOneWidget);
    });
  });
}

class _FakeSync implements SyncActions {
  _FakeSync(this.view);

  final SyncView view;
  int syncCalls = 0;

  @override
  Future<SyncView> syncNow() async {
    syncCalls++;
    return view;
  }

  @override
  Future<List<Map<String, dynamic>>> conflicts() async => const [];

  @override
  Future<void> discard(String opId) async {}

  @override
  Future<void> reapply(Map<String, dynamic> conflict) async {}
}
