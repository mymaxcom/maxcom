// Users: the list with roles as chips and each person's state, adding a
// person with several roles, editing roles (the last admin refusal), the
// PIN reset that can revoke a lost phone in the same step, deactivation,
// and the enrolment QR for a new device. Goldens: users, enrol_qr.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/ui_flags.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/people/people_words.dart';
import 'package:surau_app/features/setup/setup_providers.dart';
import 'package:surau_app/screens/widgets/box_read.dart';
import 'package:surau_app/ops/fleet/fleet_models.dart';
import 'package:surau_app/ops/fleet/fleet_providers.dart';
import 'package:surau_app/features/common/help_card.dart';
import 'package:surau_app/screens/enrol_qr_screen.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> openUsers(WidgetTester tester, [String path = '/users']) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  tallView(tester);
  h.router.go(path);
  await settle(tester);
  return h;
}

void main() {
  testWidgets('the list on an older box: names, roles as chips, locked first, inactive folded, no PIN', (
    tester,
  ) async {
    final h = await openUsers(tester);
    tallView(tester);
    await settle(tester);
    expect(h.location, '/users');
    expect(find.text('Pengguna & peranti'), findsWidgets);
    for (final name in ['Ustaz Ali', 'Aminah binti Yusof', 'Encik Hafiz', 'Kak Ros']) {
      expect(find.text(name), findsWidgets, reason: name);
    }
    // Pak Mat is inactive: inside the folded Dinyahaktifkan.
    expect(find.text('Pak Mat'), findsNothing);
    expect(find.text('Dinyahaktifkan (1)'), findsOneWidget);
    expect(find.text('Pentadbir'), findsOneWidget);
    expect(find.text('Bendahari'), findsOneWidget);
    expect(find.text('Media'), findsOneWidget);
    expect(find.text('AJK'), findsNWidgets(2), reason: 'Aminah, Kak Ros');
    expect(find.text('PIN dikunci'), findsOneWidget);
    expect(find.text('PIN belum ditetapkan'), findsOneWidget);
    expect(find.text('Tambah pengguna'), findsOneWidget);
    expect(find.textContaining('Kotak'), findsNothing);
  });

  // A7: the old one-page form is now the three-step flow; its own tests are in user_add_flow_test.dart.
  testWidgets('Tambah pengguna opens the three-step flow', (tester) async {
    final h = await openUsers(tester);
    await tester.tap(find.text('Tambah pengguna').first);
    await settle(tester);
    expect(h.location, '/users/new');
    expect(find.text('Langkah 1 daripada 3'), findsOneWidget);
  });

  testWidgets('roles: several at once, saved as the array; 409 shows the box message', (
    tester,
  ) async {
    final h = await openUsers(tester);
    await tester.tap(find.text('Aminah binti Yusof'));
    await settle(tester);
    expect(h.location, '/users/u2');
    expect(find.text('Seorang boleh memegang lebih daripada satu peranan.'), findsOneWidget);
    await tester.tap(find.text('Pentadbir'));
    await settle(tester);
    await tester.tap(find.text('Simpan peranan'));
    await settle(tester);
    final put = h.box.byPath('/api/users/u2/roles')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {
      'roles': ['admin', 'treasurer', 'ajk'],
    });
    expect(find.text('Peranan disimpan'), findsOneWidget);

    // Taking the last admin's role away is refused by the box.
    h.handlers['PUT /api/users/u2/roles'] = (r) async => jsonResponse(409, {
      'errors': ['Mesti ada sekurang-kurangnya seorang pentadbir aktif'],
    });
    await tester.tap(find.text('Pentadbir'));
    await settle(tester);
    await tester.tap(find.text('Simpan peranan'));
    await settle(tester);
    expect(find.text('Mesti ada sekurang-kurangnya seorang pentadbir aktif'), findsOneWidget);

    // No role at all is refused before anything is sent.
    h.box.seen.clear();
    await tester.tap(find.text('Bendahari'));
    await tester.tap(find.text('AJK'));
    await settle(tester);
    await tester.tap(find.text('Simpan peranan'));
    await settle(tester);
    expect(find.text('Pilih sekurang-kurangnya satu peranan.'), findsOneWidget);
    expect(h.box.byPath('/api/users/u2/roles'), isNull);
  });

  testWidgets('a person\'s page: roles to tick, the three actions', (tester) async {
    final h = await openUsers(tester, '/users/u3');
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('PIN dikunci'), findsOneWidget);
    expect(find.byType(Checkbox), findsNWidgets(5), reason: 'Pentadbir, Siaran Langsung, Bendahari, Media, AJK');
    expect(find.text('Siaran Langsung'), findsOneWidget);
    expect(find.text('Daftar peranti baharu'), findsOneWidget);
    expect(find.text('Set semula PIN'), findsOneWidget);
    expect(find.text('Nyahaktifkan'), findsOneWidget);
    expect(h.location, '/users/u3'); // goldens: user_edit_test.dart
  });

  testWidgets('Set semula PIN: asks about a lost phone and revokes the ticked devices', (
    tester,
  ) async {
    final h = await openUsers(tester, '/users/u2');
    await reveal(tester, find.text('Set semula PIN'));
    await tester.ensureVisible(find.text('Set semula PIN'));
    await tester.tap(find.text('Set semula PIN'));
    await settle(tester);
    expect(find.text('Set semula PIN Aminah binti Yusof?'), findsOneWidget);
    expect(find.text('Adakah telefon ini hilang?'), findsOneWidget);
    final dialog = find.byType(AlertDialog);
    expect(find.descendant(of: dialog, matching: find.text('iPad Aminah')), findsOneWidget);
    expect(find.text('Telefon lama'), findsNothing, reason: 'already revoked');
    await tester.tap(find.descendant(of: dialog, matching: find.text('iPad Aminah')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Set semula PIN'));
    await settle(tester);
    final put = h.box.byPath('/api/users/u2/pin')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {
      'revokeDeviceIds': ['dev-2'],
    });
    expect(
      find.text('PIN Aminah binti Yusof diset semula. 1 peranti dibatalkan.'),
      findsOneWidget,
    );
  });

  testWidgets('Nyahaktifkan: confirm, then the box may refuse the last admin', (
    tester,
  ) async {
    final h = await openUsers(tester, '/users/u1');
    h.handlers['POST /api/users/u1/deactivate'] = (r) async => jsonResponse(409, {
      'errors': ['Mesti ada sekurang-kurangnya seorang pentadbir aktif'],
    });
    await tester.ensureVisible(find.text('Nyahaktifkan'));
    await settle(tester);
    await tester.tap(find.text('Nyahaktifkan'));
    await settle(tester);
    expect(find.text('Nyahaktifkan Ustaz Ali?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Nyahaktifkan'));
    await settle(tester);
    expect(h.box.byPath('/api/users/u1/deactivate')?.method, 'POST');
    expect(find.text('Mesti ada sekurang-kurangnya seorang pentadbir aktif'), findsOneWidget);

    // Someone else goes through.
    h.router.go('/users/u4');
    await settle(tester);
    expect(find.text('Nyahaktifkan'), findsNothing, reason: 'already inactive');
    h.router.go('/users/u5');
    await settle(tester);
    await tester.ensureVisible(find.text('Nyahaktifkan'));
    await settle(tester);
    await tester.tap(find.text('Nyahaktifkan'));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Nyahaktifkan'));
    await settle(tester);
    expect(h.location, '/users');
    expect(find.text('Kak Ros dinyahaktifkan.'), findsOneWidget);
  });

  testWidgets('Daftar peranti on the cloud (Ops): a surau person gets the box-only message and no code', (tester) async {
    final h = await pumpShell(
      tester,
      roles: const ['admin'],
      overrides: [
        isCloudGatewayProvider.overrideWithValue(true),
        // the ops build reads /api/auth/me on the cloud; a marked ops phone that has no surau chosen keeps the tenant screen
        opsContextProvider.overrideWith((ref) async => const OpsContext(ops: true, scopeAll: false)),
      ],
    );
    h.router.go('/users/u2/enrol');
    await settle(tester);
    expect(find.byKey(const ValueKey('enrol-box-only')), findsOneWidget);
    expect(
      find.text('Kod peranti mesti dibuat oleh MAXCOM di surau. Gunakan telefon Pentadbir Surau di Wi-Fi surau.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('enrol-device-name')), findsNothing);
    expect(find.text('Jana kod QR'), findsNothing);
    expect(h.box.byPath('/api/enrol/begin'), isNull);
  });

  testWidgets('Daftar peranti: name, then the QR with the code, the countdown and the fingerprint', (
    tester,
  ) async {
    final h = await openUsers(tester, '/users/u2');
    await reveal(tester, find.text('Daftar peranti baharu'));
    await tester.tap(find.text('Daftar peranti baharu'));
    await settle(tester);
    expect(h.location, '/users/u2/enrol');
    expect(find.text('Peranti untuk Aminah binti Yusof'), findsOneWidget);

    await tester.tap(find.text('Jana kod QR'));
    await settle(tester);
    expect(find.text('Masukkan nama peranti'), findsOneWidget);
    expect(h.box.byPath('/api/enrol/begin'), isNull);

    await tester.enterText(find.byKey(const ValueKey('enrol-device-name')), 'Telefon Aminah');
    await tester.tap(find.text('Jana kod QR'));
    await settle(tester);
    expect(jsonDecode(h.box.byPath('/api/enrol/begin')!.body), {
      'userId': 'u2',
      'deviceName': 'Telefon Aminah',
      'ttlMinutes': 10,
    });
    final qr = tester.widget<InvitationQr>(find.byType(InvitationQr));
    expect(qr.data, enrolBeginFixture()['payload']);
    expect(find.byType(QrImageView), findsOneWidget);
    expect(find.text('ABCD-EFGH-2345'), findsOneWidget);
    expect(find.textContaining('Tamat dalam \u206609:5'), findsOneWidget);
    // The fingerprint (and the word "sijil") stays behind Butiran teknikal.
    expect(find.byType(TechnicalDetails), findsOneWidget);
    expect(find.text('abcd ef01 2345 6789\nabcd ef01 2345 6789'), findsNothing);
    expect(find.textContaining('sijil'), findsNothing);
    await expectGoldens(tester, h.app, 'enrol_qr');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.text('Butiran teknikal'));
    await settle(tester);
    expect(find.text('Cap jari sijil'), findsOneWidget);
    expect(find.text('abcd ef01 2345 6789\nabcd ef01 2345 6789'), findsOneWidget);
    expect(find.textContaining('bandingkan cap jari sijil ini'), findsOneWidget);

    // Salin kod puts the text the manual field accepts on the clipboard (never the 12 characters alone).
    final copied = <String?>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add((call.arguments as Map)['text'] as String?);
          }
          return null;
        });
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.text('Salin kod'));
    await settle(tester);
    expect(copied, [enrolBeginFixture()['payload']]);
    expect(find.text('Kod disalin'), findsOneWidget);
  });

  testWidgets('a person without the permission is kept out', (tester) async {
    final h = await pumpShell(tester, roles: const ['media']);
    h.router.go('/users/u2/enrol');
    await settle(tester);
    expect(h.location, '/');
    expect(find.text('Tiada kebenaran untuk tindakan ini'), findsOneWidget);
  });

  testWidgets('the box away: the last list stays, writes are refused', (tester) async {
    final h = await openUsers(tester);
    // The person's page also lists their devices: read once while the box answered, as the app would have.
    await h.container.read(boxJsonProvider('/api/devices').future);
    h.boxAway = true;
    await h.container.read(healthProvider.notifier).refresh();
    await settle(tester);
    expect(find.text('Aminah binti Yusof'), findsOneWidget);
    await tester.tap(find.text('Aminah binti Yusof'));
    await settle(tester);
    await tester.tap(find.text('Pentadbir'));
    await settle(tester);
    await tester.tap(find.text('Simpan peranan'));
    await settle(tester);
    expect(find.text('MAXCOM tidak dapat dihubungi. Cuba lagi di surau.'), findsOneWidget);
    expect(h.box.byPath('/api/users/u2/roles'), isNull);
  });

  group('Pengguna list (PP A5)', () {
    testWidgets('[G-S7] the box flag noAdminPhone shows the no-Pentadbir-phone line, and only then', (tester) async {
      await openPeople(tester, activityBody: () => {...peopleActivity(), 'noAdminPhone': true});
      expect(find.byKey(const ValueKey('users-no-admin-phone')), findsOneWidget);
      expect(find.text('Tiada Pentadbir mempunyai telefon yang aktif. Daftarkan telefon Pentadbir.'), findsOneWidget);
    });

    testWidgets('[G-S7] without the flag there is no such line', (tester) async {
      await openPeople(tester);
      expect(find.byKey(const ValueKey('users-no-admin-phone')), findsNothing);
    });

    testWidgets('[PP-A5] Perlu tindakan first: locked, no device, shared number; no row for a missing number; goldens', (tester) async {
      final h = await openPeople(tester);
      tallView(tester);
      await settle(tester);
      final needs = find.byKey(const ValueKey('users-needs'));
      expect(find.descendant(of: needs, matching: find.text('Perlu tindakan')), findsOneWidget);
      // Encik Rahman: locked (the old `phone` need is ignored), the action of the first need.
      expect(find.descendant(of: needs, matching: find.text('Encik Rahman')), findsOneWidget);
      // A server `phone` need (an older box) is ignored: the number is optional.
      expect(find.text('PIN dikunci'), findsOneWidget);
      expect(find.byKey(const ValueKey('users-unlock-u3')), findsOneWidget);
      expect(find.byKey(const ValueKey('users-phone-u3')), findsNothing);
      // Kak Siti: added 4 days ago (server clock), no phone yet.
      expect(find.text('Ditambah 4 hari lalu, belum daftar telefon'), findsOneWidget);
      expect(find.byKey(const ValueKey('users-qr-u6')), findsOneWidget);
      // Ustaz Ahmad U-0001: no phone number.
      expect(find.byKey(const ValueKey('users-phone-u1')), findsOneWidget);
      expect(find.text('Nombor telefon sama dengan pengguna lain'), findsOneWidget);
      expect(find.text('Nombor telefon diperlukan'), findsNothing);
      // The 90-day suggestion opens the person.
      expect(find.text('${isolate('Ustaz Ahmad')} tidak menggunakan aplikasi lebih 90 hari. Nyahaktifkan?'), findsOneWidget);

      // The active list: device counts and the server's day words.
      expect(find.text('Semua pengguna aktif (6)'), findsOneWidget);
      expect(find.text('2 peranti, aktif hari ini'), findsOneWidget);
      expect(find.text('1 peranti, aktif semalam'), findsOneWidget);
      expect(find.text('1 peranti, aktif 97 hari lalu'), findsOneWidget);
      expect(find.text('Belum ada peranti'), findsOneWidget);
      await expectGoldens(tester, h.app, 'users');
    });

    testWidgets('[CL-2] a deactivated person shows the date and the days left before the automatic delete, by the server clock', (tester) async {
      await openPeople(tester);
      tallView(tester);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('users-deactivated-fold')));
      await settle(tester);
      final row = find.byKey(const ValueKey('users-off-u4'));
      expect(find.descendant(of: row, matching: find.text('Dinyahaktifkan 19 Okt 2026\nDipadam automatik dalam 335 hari')), findsOneWidget);
    });

    testWidgets('[CL-2] without the activity answer only the date shows (no days left from the phone clock)', (tester) async {
      await openPeople(tester, activity: false);
      tallView(tester);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('users-deactivated-fold')));
      await settle(tester);
      final row = find.byKey(const ValueKey('users-off-u4'));
      expect(find.descendant(of: row, matching: find.text('Dinyahaktifkan 19 Okt 2026')), findsOneWidget);
      expect(find.descendant(of: row, matching: find.textContaining('Dipadam automatik')), findsNothing);
    });

    testWidgets('[PP-A5] a deleted user never renders and no phone digits are on the list', (tester) async {
      await openPeople(tester);
      tallView(tester);
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('users-deactivated-fold')));
      await settle(tester);
      expect(find.text('Haji Osman'), findsOneWidget, reason: 'the fold is open');
      expect(findRef('U-0007'), findsNothing, reason: 'deleted');
      expect(find.text('Puan Zainab'), findsNothing, reason: 'deleted');
      final shown = [
        for (final w in tester.widgetList<RichText>(find.byType(RichText))) w.text.toPlainText(),
        for (final w in tester.widgetList<SelectableText>(find.byType(SelectableText))) w.data ?? '',
      ].join('\n');
      for (final digits in ['0000002', '000 0002', '0000005', '+60', '012-']) {
        expect(shown.contains(digits), isFalse, reason: digits);
      }
    });

    testWidgets('[PP-A5] two "Ustaz Ahmad" differ by ID; u5 finds one; the ID sits under the name', (tester) async {
      await openPeople(tester);
      tallView(tester);
      await settle(tester);
      final active = find.byKey(const ValueKey('users-active'));
      expect(find.descendant(of: active, matching: find.text('Ustaz Ahmad')), findsNWidgets(2));
      expect(find.descendant(of: active, matching: findRef('U-0001')), findsOneWidget);
      expect(find.descendant(of: active, matching: findRef('U-0005')), findsOneWidget);
      // Kak Siti came through the cloud; a record without its ID yet says so.
      expect(find.descendant(of: active, matching: findRef('U-C0001')), findsOneWidget);
      expect(find.descendant(of: active, matching: find.text('ID belum ada')), findsOneWidget);
      final name = tester.getRect(find.descendant(of: active, matching: find.text('Puan Aminah')));
      final id = tester.getRect(find.descendant(of: active, matching: findRef('U-0002')));
      expect(id.top, greaterThanOrEqualTo(name.bottom - 1), reason: 'the ID is on the line under the name');

      await tester.enterText(find.byKey(const ValueKey('users-search')), 'u5');
      await settle(tester);
      expect(find.descendant(of: active, matching: find.text('Ustaz Ahmad')), findsOneWidget);
      expect(findRef('U-0001'), findsNothing);
      expect(find.text('Semua pengguna aktif (1)'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('users-search')), 'U-0005');
      await settle(tester);
      expect(find.descendant(of: active, matching: findRef('U-0005')), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('users-search')), 'ahmad');
      await settle(tester);
      expect(find.descendant(of: active, matching: find.text('Ustaz Ahmad')), findsNWidgets(2));
      expect(find.descendant(of: active, matching: find.text('Puan Aminah')), findsNothing);
    });

    testWidgets('[PP-A5] search reaches the Dinyahaktifkan fold and opens it on a hit', (tester) async {
      await openPeople(tester);
      tallView(tester);
      await settle(tester);
      expect(find.text('Haji Osman'), findsNothing, reason: 'folded by default');
      expect(find.text('Dinyahaktifkan (1)'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('users-search')), 'osman');
      await settle(tester);
      expect(find.text('Haji Osman'), findsOneWidget);
      expect(find.text('Aktifkan semula'), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('users-active')), matching: find.text('Ustaz Ahmad')), findsNothing);
      await tester.enterText(find.byKey(const ValueKey('users-search')), 'u4');
      await settle(tester);
      expect(find.text('Haji Osman'), findsOneWidget);
    });

    testWidgets('[PP-A5] Aktifkan semula calls the box and the person moves up; Padam sends the id and the ID', (tester) async {
      final h = await openPeople(tester);
      tallView(tester);
      await settle(tester);
      h.handlers['POST /api/users/u4/activate'] = (r) async {
        final i = h.users.indexWhere((u) => u['id'] == 'u4');
        h.users[i] = {...h.users[i], 'active': true};
        return jsonResponse(200, {'ok': true});
      };
      await tester.tap(find.byKey(const ValueKey('users-deactivated-fold')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('users-activate-u4')));
      await settle(tester);
      expect(h.box.byPath('/api/users/u4/activate')?.method, 'POST');
      expect(find.text('Haji Osman diaktifkan semula. Daftar telefon dengan kod QR baharu.'), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('users-active')), matching: find.text('Haji Osman')), findsOneWidget);
      expect(find.byKey(const ValueKey('users-deactivated-fold')), findsNothing);

      // Padam on a deactivated person: confirm names the person and the ID; Batal sends nothing.
      final i = h.users.indexWhere((u) => u['id'] == 'u4');
      h.users[i] = {...h.users[i], 'active': false};
      await h.container.read(boxJsonProvider('/api/users').notifier).refresh();
      await settle(tester);
      h.handlers['POST /api/users/u4/delete'] = (r) async => jsonResponse(200, {'ok': true});
      // The fold keeps the state it was left in (open).
      await tester.tap(find.byKey(const ValueKey('users-delete-u4')));
      await settle(tester);
      expect(find.text('Padam Haji Osman?'), findsOneWidget);
      expect(find.textContaining('(U-0004)'), findsOneWidget);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(h.box.byPath('/api/users/u4/delete'), isNull);
      await tester.tap(find.byKey(const ValueKey('users-delete-u4')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
      await settle(tester);
      expect(h.box.bodyOf('/api/users/u4/delete'), {'ref': 'U-0004'});
      expect(find.text('Haji Osman dipadam.'), findsOneWidget);
    });

    testWidgets('[PP-A5] Buka kunci unlocks; Kod QR opens the enrol page; Tukar nombor opens the phone sheet', (tester) async {
      final h = await openPeople(tester);
      tallView(tester);
      await settle(tester);
      h.handlers['POST /api/users/u3/unlock'] = (r) async => jsonResponse(200, {'ok': true});
      await tester.tap(find.byKey(const ValueKey('users-unlock-u3')));
      await settle(tester);
      expect(h.box.byPath('/api/users/u3/unlock')?.method, 'POST');
      expect(find.text('PIN Encik Rahman dibuka. PIN tidak berubah.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('users-phone-u1')));
      await settle(tester);
      expect(find.byKey(const ValueKey('user-phone-field')), findsOneWidget);
      await tester.tap(find.text('Batal'));
      await settle(tester);

      await tester.tap(find.byKey(const ValueKey('users-qr-u6')));
      await settle(tester);
      expect(h.location, '/users/u6/enrol');
    });

    testWidgets('[PP-A5] an older box: the rows of today in the new sections, no day counts, locked from the list', (tester) async {
      final h = await openPeople(tester, activity: false);
      tallView(tester);
      await settle(tester);
      expect(find.text('Semua pengguna aktif (6)'), findsOneWidget);
      expect(find.textContaining('hari lalu'), findsNothing);
      expect(find.textContaining('aktif hari ini'), findsNothing);
      expect(find.textContaining(RegExp(r'\d peranti|Belum ada peranti')), findsNothing, reason: 'no device counts without the activity');
      // The list says Encik Rahman is locked: he still shows under Perlu tindakan.
      final needs = find.byKey(const ValueKey('users-needs'));
      expect(find.descendant(of: needs, matching: find.text('Encik Rahman')), findsOneWidget);
      expect(find.byKey(const ValueKey('users-unlock-u3')), findsOneWidget);
      expect(find.byKey(const ValueKey('users-phone-u1')), findsNothing);
      expect(find.byKey(const ValueKey('users-qr-u6')), findsNothing);
      // Buka kunci on an older box says the box needs an update.
      await tester.tap(find.byKey(const ValueKey('users-unlock-u3')));
      await settle(tester);
      expect(find.text('Kemas kini MAX Kiosk Server untuk fungsi ini'), findsOneWidget);
      expect(h.location, '/users');
    });

    testWidgets('[PP-A5] the Media hint is dismissible and stays dismissed after a rebuild', (tester) async {
      final store = MemoryUiFlagsStore();
      final h = await openPeople(tester, overrides: [uiFlagsStoreProvider.overrideWithValue(store)]);
      tallView(tester);
      await settle(tester);
      expect(find.byKey(const ValueKey('users-media-live-hint')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('users-media-hint-close')));
      await settle(tester);
      expect(find.byKey(const ValueKey('users-media-live-hint')), findsNothing);
      expect(store.values['users.mediaLiveHint.dismissed'], isTrue);
      h.router.go('/');
      await settle(tester);
      h.container.invalidate(uiFlagProvider('users.mediaLiveHint.dismissed'));
      h.router.go('/users');
      await settle(tester);
      expect(find.byKey(const ValueKey('users-media-live-hint')), findsNothing);
      // The sentence still lives in the roles fold.
      await tester.tap(find.byKey(const ValueKey('users-roles-fold')));
      await settle(tester);
      expect(find.text('Peranan Media tidak lagi boleh membuat siaran langsung. Beri peranan Siaran Langsung kepada pengguna yang perlu.'), findsOneWidget);
    });

    testWidgets('[PP-A5] the no-recovery warning shows with the Kod pemulihan fold closed', (tester) async {
      await openPeople(tester, overrides: [recoveryCodeSetProvider.overrideWith((ref) async => false)]);
      tallView(tester);
      await settle(tester);
      expect(find.byKey(const ValueKey('users-no-recovery-warning')), findsOneWidget);
      expect(find.byKey(const ValueKey('users-rotate-recovery')), findsNothing, reason: 'inside the fold');
      await tester.tap(find.byKey(const ValueKey('users-recovery-fold')));
      await settle(tester);
      expect(find.byKey(const ValueKey('users-rotate-recovery')), findsOneWidget);
    });

    for (final lang in [AppLang.ms, AppLang.ar]) {
      testWidgets('[PP-A5] 320 dp, ${lang.code}: a 40-character name in a row with a button is not cut by the ID', (tester) async {
        const long = 'Ustaz Ahmad bin Abdullah Hafiz Al-Rahman'; // 40 characters
        expect(long.length, 40);
        await openPeople(
          tester,
          overrides: [appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang))],
          rename: {'u3': long},
        );
        tester.view.physicalSize = const Size(320, 1600) * goldenPixelRatio;
        await settle(tester);
        expect(tester.takeException(), isNull);
        final needs = find.byKey(const ValueKey('users-needs'));
        final name = find.descendant(of: needs, matching: find.text(long));
        expect(name, findsOneWidget);
        expect(tester.renderObject<RenderParagraph>(name).didExceedMaxLines, isFalse);
        final ref = tester.getRect(find.descendant(of: needs, matching: findRef('U-0003')));
        expect(ref.top, greaterThanOrEqualTo(tester.getRect(name).bottom - 1));
        expect(find.byKey(const ValueKey('users-unlock-u3')), findsOneWidget);
        final button = tester.getRect(find.byKey(const ValueKey('users-unlock-u3')));
        expect(button.left, greaterThanOrEqualTo(0));
        expect(button.right, lessThanOrEqualTo(320));
        // The ID reads left to right inside Arabic too.
        final id = tester.widget<SelectableText>(find.descendant(of: needs, matching: findRef('U-0003')));
        expect(id.textDirection, TextDirection.ltr);
      });
    }

    testWidgets('[PP-A5] Arabic golden', (tester) async {
      final h = await openPeople(
        tester,
        overrides: [
          appLangStoreProvider.overrideWithValue(MemoryAppLangStore(AppLang.ar)),
          livePublisherProvider.overrideWithValue(FakePublisher()),
        ],
      );
      await expectGoldens(tester, h.app, 'users_ar', sizes: const [GoldenSize.phone]);
    });
  });
}

/// A tall phone so a long page is built whole (the list is lazy).
void tallView(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 2600) * goldenPixelRatio;
  tester.view.devicePixelRatio = goldenPixelRatio;
}

/// The ID as [RefText] draws it.
Finder findRef(String ref) => find.byWidgetPredicate((w) => w is SelectableText && w.data == ref);

/// The server's clock in these fixtures (the phone's is 2026-11-04).
const String _serverNow = '2026-11-18T09:00:00.000Z';

/// `GET /api/users` for the relook: two "Ustaz Ahmad", a locked person with no
/// number, one added through the cloud, one without an ID yet, a deactivated
/// person and a deleted one (never shown).
List<Map<String, Object?>> peopleUsers() => [
  {'id': 'u1', 'name': 'Ustaz Ahmad', 'roles': ['admin', 'treasurer'], 'active': true, 'pinRequired': false, 'ref': 'U-0001'},
  {'id': 'u2', 'name': 'Puan Aminah', 'roles': ['treasurer', 'ajk'], 'active': true, 'pinRequired': false, 'ref': 'U-0002', 'phone': '+60120000002'},
  {'id': 'u3', 'name': 'Encik Rahman', 'roles': ['media', 'live'], 'active': true, 'pinRequired': false, 'ref': 'U-0003', 'pinLockedUntil': '2026-11-04T15:00:00.000Z'},
  {'id': 'u4', 'name': 'Haji Osman', 'roles': ['ajk'], 'active': false, 'pinRequired': false, 'ref': 'U-0004', 'deactivatedAt': '2026-10-19T08:00:00.000Z'},
  {'id': 'u5', 'name': 'Ustaz Ahmad', 'roles': ['media'], 'active': true, 'pinRequired': false, 'ref': 'U-0005', 'phone': '+60120000005'},
  {'id': 'u6', 'name': 'Kak Siti', 'roles': ['ajk'], 'active': true, 'pinRequired': true, 'ref': 'U-C0001'},
  {'id': 'u7', 'name': 'Puan Zainab', 'roles': ['ajk'], 'active': false, 'pinRequired': false, 'ref': 'U-0007', 'deleted': true},
  {'id': 'u8', 'name': 'Encik Yusof', 'roles': ['ajk'], 'active': true, 'pinRequired': false},
];

/// `GET /api/people/activity` from the box, matching [peopleUsers].
Map<String, Object?> peopleActivity() => {
  'now': _serverNow,
  'authority': 'box',
  'limits': {'deviceDays': 60, 'tvDays': 30, 'noDeviceDays': 3, 'userDays': 90, 'deactivatedDays': 365},
  'devices': <Object?>[],
  'users': [
    {'id': 'u1', 'ref': 'U-0001', 'createdAt': '2026-01-02T08:00:00.000Z', 'deviceCount': 2, 'lastActiveAt': '2026-11-18T08:00:00.000Z', 'locked': false, 'needs': ['phone_duplicate'], 'suggestDeactivate': false},
    {'id': 'u2', 'ref': 'U-0002', 'createdAt': '2026-01-03T08:00:00.000Z', 'deviceCount': 1, 'lastActiveAt': '2026-11-17T08:00:00.000Z', 'locked': false, 'needs': <String>[], 'suggestDeactivate': false},
    {'id': 'u3', 'ref': 'U-0003', 'createdAt': '2026-01-04T08:00:00.000Z', 'createdByName': 'Ustaz Ahmad', 'createdByRef': 'U-0001', 'deviceCount': 2, 'lastActiveAt': '2026-11-15T08:00:00.000Z', 'locked': true, 'pinLockedUntil': '2026-11-18T09:27:00.000Z', 'needs': ['locked', 'phone'], 'suggestDeactivate': false},
    {'id': 'u5', 'ref': 'U-0005', 'createdAt': '2026-01-05T08:00:00.000Z', 'deviceCount': 1, 'lastActiveAt': '2026-08-13T08:00:00.000Z', 'locked': false, 'needs': <String>[], 'suggestDeactivate': true},
    {'id': 'u6', 'ref': 'U-C0001', 'createdAt': '2026-11-14T08:00:00.000Z', 'deviceCount': 0, 'locked': false, 'needs': ['no_device'], 'suggestDeactivate': false},
    {'id': 'u8', 'createdAt': '2026-11-17T08:00:00.000Z', 'deviceCount': 1, 'lastActiveAt': '2026-11-18T07:00:00.000Z', 'locked': false, 'needs': <String>[], 'suggestDeactivate': false},
  ],
};

/// The people screens with [peopleUsers], and the activity unless [activity]
/// is false (an older box: the route answers 404).
Future<ShellHarness> openPeople(
  WidgetTester tester, {
  bool activity = true,
  List<Override> overrides = const [],
  Map<String, String> rename = const {},
  Map<String, Map<String, Object?>> patch = const {},
  Map<String, Object?> Function()? activityBody,
  String path = '/users',
}) async {
  final h = await pumpShell(tester, roles: const ['admin'], overrides: overrides);
  h.users = [
    for (final u in peopleUsers()) {...u, if (rename.containsKey(u['id'])) 'name': rename[u['id']], ...?patch[u['id']]},
  ];
  if (activity) h.handlers['GET /api/people/activity'] = (r) async => jsonResponse(200, (activityBody ?? peopleActivity)());
  h.router.go(path);
  await settle(tester);
  return h;
}
