// Users: the list with roles as chips and each person's state, adding a
// person with several roles, editing roles (the last admin refusal), the
// PIN reset that can revoke a lost phone in the same step, deactivation,
// and the enrolment QR for a new device. Goldens: users, enrol_qr.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/common/help_card.dart';
import 'package:surau_app/screens/enrol_qr_screen.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> openUsers(WidgetTester tester, [String path = '/users']) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  h.router.go(path);
  await settle(tester);
  return h;
}

void main() {
  testWidgets('the list: names, roles as chips, locked, inactive, no PIN', (
    tester,
  ) async {
    final h = await openUsers(tester);
    expect(h.location, '/users');
    expect(find.text('Pengguna & peranti'), findsWidgets);
    for (final name in ['Ustaz Ali', 'Aminah binti Yusof', 'Encik Hafiz', 'Pak Mat', 'Kak Ros']) {
      expect(find.text(name), findsOneWidget, reason: name);
    }
    expect(find.text('Pentadbir'), findsOneWidget);
    expect(find.text('Bendahari'), findsOneWidget);
    expect(find.text('Media'), findsOneWidget);
    expect(find.text('AJK'), findsNWidgets(3), reason: 'Aminah, Pak Mat, Kak Ros');
    expect(find.text('PIN dikunci'), findsOneWidget);
    expect(find.text('Tidak aktif'), findsOneWidget);
    expect(find.text('PIN belum ditetapkan'), findsOneWidget);
    expect(find.text('Tambah pengguna'), findsOneWidget);
    expect(find.textContaining('Kotak'), findsNothing);
    await expectGoldens(tester, h.app, 'users');
  });

  testWidgets('Tambah pengguna: Aminah as Bendahari posts {name, roles}', (
    tester,
  ) async {
    final h = await openUsers(tester);
    await tester.tap(find.text('Tambah pengguna'));
    await settle(tester);
    expect(h.location, '/users/new');
    await tester.enterText(find.byKey(const ValueKey('user-name')), 'Aminah');

    // At least one role.
    await tester.tap(find.widgetWithText(FilledButton, 'Tambah pengguna'));
    await settle(tester);
    expect(find.text('Pilih sekurang-kurangnya satu peranan.'), findsOneWidget);
    expect(h.box.byPath('/api/users')?.method, isNot('POST'));

    await tester.tap(find.text('Bendahari'));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Tambah pengguna'));
    await settle(tester);
    final post = h.box.seen.firstWhere(
      (r) => r.method == 'POST' && r.url.path == '/api/users',
    );
    expect(jsonDecode(post.body), {
      'name': 'Aminah',
      'roles': ['treasurer'],
    });
    expect(h.location, '/users');
    expect(find.text('Aminah ditambah. Seterusnya, daftar peranti mereka.'), findsOneWidget);
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
    expect(find.byType(Checkbox), findsNWidgets(4));
    expect(find.text('Daftar peranti'), findsOneWidget);
    expect(find.text('Set semula PIN'), findsOneWidget);
    expect(find.text('Nyahaktifkan'), findsOneWidget);
    await expectGoldens(tester, h.app, 'user_edit');
  });

  testWidgets('Set semula PIN: asks about a lost phone and revokes the ticked devices', (
    tester,
  ) async {
    final h = await openUsers(tester, '/users/u2');
    await tester.tap(find.text('Set semula PIN'));
    await settle(tester);
    expect(find.text('Set semula PIN Aminah binti Yusof?'), findsOneWidget);
    expect(find.text('Adakah telefon ini hilang?'), findsOneWidget);
    expect(find.text('iPad Aminah'), findsOneWidget);
    expect(find.text('Telefon lama'), findsNothing, reason: 'already revoked');
    await tester.tap(find.text('iPad Aminah'));
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

  testWidgets('Daftar peranti: name, then the QR with the code, the countdown and the fingerprint', (
    tester,
  ) async {
    final h = await openUsers(tester, '/users/u2');
    await tester.tap(find.text('Daftar peranti'));
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
    expect(find.textContaining('Tamat dalam 09:5'), findsOneWidget);
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

    // Salin kod puts the code on the clipboard.
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
    expect(copied, ['ABCD-EFGH-2345']);
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
}
