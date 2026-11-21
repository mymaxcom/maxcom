// Butiran pengguna (plan PP, task A6): one page per person. The ID under the
// name, who added them, Tukar nama, Buka kunci, the phone number (Tukar
// nombor, WhatsApp), their devices (Ubah, Padam), roles, and under Lain-lain
// Set semula PIN, Nyahaktifkan and Padam pengguna. Goldens: user_edit,
// user_edit_ar.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/common/ltr.dart';
import 'package:surau_app/features/people/people_api.dart';
import 'package:surau_app/features/people/people_words.dart';
import 'package:surau_app/screens/widgets/box_read.dart';
import 'package:surau_app/sync/live_only.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'users_test.dart' show findRef, openPeople, peopleActivity, tallView;

/// The activity with Encik Rahman's two devices: one in use, one unused 74 days.
Map<String, Object?> activityWithDevices() => {
  ...peopleActivity(),
  'devices': [
    {'id': 'dev-6', 'ref': 'D-0006', 'userId': 'u3', 'kind': 'device', 'enrolledAt': '2026-02-01T08:00:00.000Z', 'lastSeenAt': '2026-11-15T08:00:00.000Z', 'idleDays': 3, 'inactive': false},
    {'id': 'dev-4', 'ref': 'D-0004', 'userId': 'u3', 'kind': 'device', 'enrolledAt': '2026-02-01T08:00:00.000Z', 'lastSeenAt': '2026-09-05T08:00:00.000Z', 'idleDays': 74, 'inactive': true},
  ],
};

List<Map<String, Object?>> rahmanDevices() => [
  {'id': 'dev-6', 'userId': 'u3', 'name': 'Telefon Encik Rahman', 'platform': 'android', 'revoked': false, 'ref': 'D-0006'},
  {'id': 'dev-4', 'userId': 'u3', 'name': 'Komputer pejabat', 'platform': 'web', 'revoked': false, 'ref': 'D-0004'},
  {'id': 'dev-7', 'userId': 'u3', 'name': 'Telefon lama Rahman', 'platform': 'android', 'revoked': true, 'ref': 'D-0007'},
  {'id': 'dev-8', 'userId': 'u3', 'name': 'Skrin dewan', 'platform': 'kiosk', 'revoked': false, 'ref': 'D-0008'},
  {'id': 'dev-1', 'userId': 'u1', 'name': 'Telefon Ustaz Ahmad', 'platform': 'android', 'revoked': false, 'ref': 'D-0001'},
];

Future<ShellHarness> openPerson(
  WidgetTester tester,
  String id, {
  bool activity = true,
  Map<String, Map<String, Object?>> patch = const {},
  List<Override> overrides = const [],
  Map<String, Object?> Function()? activityBody,
}) async {
  final h = await openPeople(
    tester,
    path: '/users/$id',
    activity: activity,
    patch: patch,
    overrides: overrides,
    activityBody: activityBody ?? activityWithDevices,
  );
  h.devices = rahmanDevices();
  tallView(tester);
  await h.container.read(boxJsonProvider('/api/devices').notifier).refresh();
  await settle(tester);
  return h;
}

/// Records what the page asks and plays the offline-first gateway: a rename
/// is queued (no error), a delete is live-only.
class FakePeopleApi extends PeopleApi {
  FakePeopleApi() : super(() => null);

  final List<(String, String)> renamed = [];
  final List<(String, String)> deleted = [];

  @override
  Future<void> renameUser(String id, String name) async => renamed.add((id, name));

  @override
  Future<void> deleteUser(String id, String ref) async => throw LiveOnly('/api/users/$id/delete');
}

void main() {
  testWidgets('[PP-A6b] the page: ID under the name, added by, locked card, phone, devices, roles, Lain-lain; goldens', (tester) async {
    final h = await openPerson(tester, 'u3', patch: {'u3': {'phone': '+60120000001'}});
    expect(find.text('Encik Rahman'), findsWidgets);
    expect(findRef('U-0003'), findsOneWidget);
    expect(find.text('Ditambah 4 Jan 2026 oleh ${isolate('Ustaz Ahmad')} ${ltr('U-0001')}'), findsOneWidget, reason: '[CL-2] the adder name and ID');
    expect(find.byKey(const ValueKey('user-locked-card')), findsOneWidget);
    expect(find.byKey(const ValueKey('user-unlock')), findsOneWidget);
    expect(find.text(ltr('+60 12-000 0001')), findsOneWidget);
    expect(find.text('Hanya Pentadbir dan orang itu sendiri boleh melihat nombor ini.'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-whatsapp')), findsOneWidget);
    expect(find.text('Tukar nombor'), findsOneWidget);
    // Live phones and computers only: not the revoked one, not the TV screen.
    expect(find.text('Peranti ${isolate('Encik Rahman')} (2)'), findsOneWidget);
    expect(find.text('Telefon Encik Rahman'), findsOneWidget);
    expect(find.text('Komputer pejabat'), findsOneWidget);
    expect(find.text('Telefon lama Rahman'), findsNothing);
    expect(find.text('Skrin dewan'), findsNothing);
    expect(find.text('Android, aktif 3 hari lalu'), findsOneWidget);
    expect(find.text('Pelayar web, tidak digunakan 74 hari'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-device-remove-dev-4')), findsOneWidget, reason: 'inactive: a direct Padam');
    expect(find.byKey(const ValueKey('user-device-remove-dev-6')), findsNothing);
    expect(find.text('Daftar peranti baharu'), findsOneWidget);
    expect(find.text('Simpan peranan'), findsOneWidget);
    expect(find.text('Set semula PIN'), findsOneWidget);
    expect(find.text('Nyahaktifkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-delete')), findsOneWidget);
    await expectGoldens(tester, h.app, 'user_edit');
  });

  testWidgets('[PP-A6b] Arabic golden', (tester) async {
    final h = await openPerson(
      tester,
      'u3',
      patch: {'u3': {'phone': '+60120000001'}},
      overrides: [
        appLangStoreProvider.overrideWithValue(MemoryAppLangStore(AppLang.ar)),
        livePublisherProvider.overrideWithValue(FakePublisher()),
      ],
    );
    await expectGoldens(tester, h.app, 'user_edit_ar', sizes: const [GoldenSize.phone]);
  });

  testWidgets('[PP-A6b] Tukar nama: cleaned and saved, the header changes; a bad name sends nothing; a taken name asks first', (tester) async {
    final h = await openPerson(tester, 'u2');
    h.handlers['PUT /api/users/u2/name'] = (r) async {
      final name = (jsonDecode(r.body) as Map<String, dynamic>)['name'];
      final i = h.users.indexWhere((u) => u['id'] == 'u2');
      h.users[i] = {...h.users[i], 'name': name};
      return jsonResponse(200, h.users[i]);
    };
    await tester.tap(find.byKey(const ValueKey('user-rename')));
    await settle(tester);
    expect(find.text('Rekod lama tidak berubah. Log perubahan dan kewangan terus menunjukkan nama yang dipakai pada masa itu.'), findsOneWidget);

    // Too long: refused before anything is sent.
    await tester.enterText(find.byKey(const ValueKey('user-rename-field')), 'A' * 81);
    await tester.tap(find.byKey(const ValueKey('user-rename-save')));
    await settle(tester);
    expect(find.text('Nama mesti 1 hingga 80 aksara'), findsOneWidget);
    expect(h.box.byPath('/api/users/u2/name'), isNull);

    // The name of another active person: asked first; Batal sends nothing.
    await tester.enterText(find.byKey(const ValueKey('user-rename-field')), ' ustaz  ahmad ');
    await tester.tap(find.byKey(const ValueKey('user-rename-save')));
    await settle(tester);
    expect(find.text('Sudah ada pengguna bernama ustaz ahmad. Simpan juga?'), findsOneWidget);
    await tester.tap(find.text('Batal').last);
    await settle(tester);
    expect(h.box.byPath('/api/users/u2/name'), isNull);

    await tester.enterText(find.byKey(const ValueKey('user-rename-field')), '  Puan   Aminah binti Ali ');
    await tester.tap(find.byKey(const ValueKey('user-rename-save')));
    await settle(tester);
    expect(h.box.bodyOf('/api/users/u2/name'), {'name': 'Puan Aminah binti Ali'});
    expect(find.text('Nama ditukar kepada Puan Aminah binti Ali.'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-rename-field')), findsNothing);
    expect(find.descendant(of: find.byKey(const ValueKey('user-header')), matching: find.text('Puan Aminah binti Ali')), findsOneWidget);
  });

  testWidgets('[PP-A6b] offline-first: the rename is handed to the queue, not refused', (tester) async {
    final api = FakePeopleApi();
    await openPerson(tester, 'u2', overrides: [peopleApiProvider.overrideWithValue(api)]);
    await tester.tap(find.byKey(const ValueKey('user-rename')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('user-rename-field')), 'Puan Aminah Contoh');
    await tester.tap(find.byKey(const ValueKey('user-rename-save')));
    await settle(tester);
    expect(api.renamed, [('u2', 'Puan Aminah Contoh')]);
    expect(find.text('Perlukan sambungan'), findsNothing);
    expect(find.text('Nama ditukar kepada Puan Aminah Contoh.'), findsOneWidget);
  });

  testWidgets('[PP-A6b] Buka kunci: the lock card goes away', (tester) async {
    var locked = true;
    final h = await openPerson(
      tester,
      'u3',
      activityBody: () {
        final a = activityWithDevices();
        if (locked) return a;
        return {
          ...a,
          'users': [
            for (final u in (a['users']! as List).cast<Map<String, Object?>>())
              u['id'] == 'u3' ? {...u, 'locked': false, 'pinLockedUntil': null, 'needs': ['phone']} : u,
          ],
        };
      },
    );
    h.handlers['POST /api/users/u3/unlock'] = (r) async {
      locked = false;
      final i = h.users.indexWhere((u) => u['id'] == 'u3');
      h.users[i] = {...h.users[i], 'pinLockedUntil': null};
      return jsonResponse(200, {'ok': true});
    };
    expect(find.byKey(const ValueKey('user-locked-card')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('user-unlock')));
    await settle(tester);
    expect(h.box.byPath('/api/users/u3/unlock')?.method, 'POST');
    expect(find.text('PIN Encik Rahman dibuka. PIN tidak berubah.'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-locked-card')), findsNothing);
  });

  testWidgets('[PP-A6b] an older box: rename and unlock say the box needs an update; the page still shows', (tester) async {
    final h = await openPerson(tester, 'u3', activity: false);
    // The list's own pinLockedUntil still shows the lock.
    expect(find.byKey(const ValueKey('user-locked-card')), findsOneWidget);
    expect(find.text('Simpan peranan'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('user-unlock')));
    await settle(tester);
    expect(find.text('Kemas kini MAX Kiosk Server untuk fungsi ini'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('user-rename')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('user-rename-field')), 'Encik Rahman Yusof');
    await tester.tap(find.byKey(const ValueKey('user-rename-save')));
    await settle(tester);
    expect(find.text('Kemas kini MAX Kiosk Server untuk fungsi ini'), findsWidgets);
    expect(h.location, '/users/u3');
  });

  testWidgets('[PP-A6b] Set semula PIN naming the last Pentadbir phone shows the box refusal in words', (tester) async {
    final h = await openPerson(tester, 'u3');
    h.handlers['PUT /api/users/u3/pin'] = (r) async => jsonResponse(409, {
      'code': 'last_admin_device',
      'errors': ['last admin device'],
    });
    await tester.tap(find.text('Set semula PIN'));
    await settle(tester);
    await tester.tap(find.text('Telefon Encik Rahman').last);
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Set semula PIN'));
    await settle(tester);
    expect(find.text('Daftar peranti Pentadbir lain dahulu'), findsOneWidget);
  });

  testWidgets('[PP-A6b] a device row opens the device sheet', (tester) async {
    await openPerson(tester, 'u3');
    await tester.tap(find.byKey(const ValueKey('user-device-dev-6')));
    await settle(tester);
    expect(find.text('Simpan nama'), findsOneWidget);
    expect(find.text('Padam peranti ini'), findsOneWidget);
  });

  testWidgets('[PP-A6b] Tukar nombor: an empty field clears the number with {"phone": ""}', (tester) async {
    final h = await openPerson(tester, 'u2');
    h.handlers['PUT /api/users/u2/phone'] = (r) async => jsonResponse(200, {'ok': true});
    await tester.tap(find.byKey(const ValueKey('user-phone-edit')));
    await settle(tester);
    expect(find.text('Nombor telefon untuk WhatsApp (pilihan)'), findsOneWidget);
    expect(find.text('Digunakan untuk menghantar notis dan pautan melalui WhatsApp. Boleh dikosongkan.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('user-phone-field')), '');
    await tester.tap(find.byKey(const ValueKey('user-phone-save')));
    await settle(tester);
    final sent = h.box.seen.lastWhere((r) => r.url.path == '/api/users/u2/phone');
    expect(jsonDecode(sent.body), {'phone': ''});
    expect(find.text('Nombor telefon dibuang.'), findsOneWidget);
  });

  testWidgets('[PP-A6b] Tukar nombor: 012-000 0001 is sent as +60120000001; a bad number sends nothing; a taken one names the other ID', (tester) async {
    final h = await openPerson(tester, 'u2');
    await tester.tap(find.byKey(const ValueKey('user-phone-edit')));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('user-phone-field')), '12345');
    await tester.tap(find.byKey(const ValueKey('user-phone-save')));
    await settle(tester);
    expect(find.text('Nombor telefon tidak sah. Untuk nombor luar negara, mulakan dengan + dan kod negara.'), findsOneWidget);
    expect(h.box.byPath('/api/users/u2/phone'), isNull);

    h.handlers['PUT /api/users/u2/phone'] = (r) async => jsonResponse(409, {
      'code': 'phone_taken',
      'detail': {'ref': 'U-0005'},
      'errors': ['phone taken'],
    });
    await tester.enterText(find.byKey(const ValueKey('user-phone-field')), '012-000 0005');
    await tester.tap(find.byKey(const ValueKey('user-phone-save')));
    await settle(tester);
    expect(find.text('Nombor ini sudah digunakan oleh pengguna lain (U-0005).'), findsOneWidget);

    h.handlers['PUT /api/users/u2/phone'] = (r) async => jsonResponse(200, {'ok': true});
    await tester.enterText(find.byKey(const ValueKey('user-phone-field')), '012-000 0001');
    await tester.tap(find.byKey(const ValueKey('user-phone-save')));
    await settle(tester);
    final sent = h.box.seen.lastWhere((r) => r.url.path == '/api/users/u2/phone');
    expect(jsonDecode(sent.body), {'phone': '+60120000001'});
    expect(find.text('Nombor telefon disimpan.'), findsOneWidget);
  });

  testWidgets('[PP-A6b] no number: Tiada nombor telefon with Isi nombor; WhatsApp names the number before it opens', (tester) async {
    final h = await openPerson(tester, 'u1');
    expect(tester.takeException(), isNull);
    expect(find.text('Tiada nombor telefon'), findsOneWidget);
    expect(find.text('Isi nombor'), findsOneWidget);
    expect(find.byKey(const ValueKey('user-whatsapp')), findsNothing);

    h.router.go('/users/u2');
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('user-whatsapp')));
    await settle(tester);
    expect(find.text('WhatsApp dibuka terus ke ${ltr('+60 12-000 0002')}'), findsOneWidget);
    expect(h.opener.opened, isEmpty, reason: 'nothing opens before Teruskan');
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(h.opener.opened.single.toString(), startsWith('https://wa.me/60120000002'));
  });

  testWidgets('[CL-3] WhatsApp that cannot open says so without naming a Kongsi button this page does not have', (tester) async {
    final h = await openPerson(tester, 'u2');
    h.opener.result = false;
    await tester.tap(find.byKey(const ValueKey('user-whatsapp')));
    await settle(tester);
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(find.text('WhatsApp tidak tersedia pada telefon ini.'), findsOneWidget);
    expect(find.textContaining('Kongsi'), findsNothing);
  });

  testWidgets('[PP-A6] Padam pengguna: Batal sends nothing; the confirm sends the id AND the ID; the hint is under the button', (tester) async {
    final h = await openPerson(tester, 'u2');
    h.handlers['POST /api/users/u2/delete'] = (r) async => jsonResponse(200, {'ok': true});
    final button = tester.getRect(find.byKey(const ValueKey('user-delete')));
    final hint = tester.getRect(find.text('Orang ini hilang dari senarai dan tidak lagi boleh masuk. Sejarah kekal. Boleh dipulihkan dari Log perubahan.'));
    expect(hint.top, greaterThanOrEqualTo(button.top));
    await tester.tap(find.byKey(const ValueKey('user-delete')));
    await settle(tester);
    expect(find.text('Padam Puan Aminah?'), findsOneWidget);
    expect(find.textContaining('Puan Aminah (U-0002) tidak lagi boleh masuk'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(h.box.byPath('/api/users/u2/delete'), isNull);
    await tester.tap(find.byKey(const ValueKey('user-delete')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    final post = h.box.byPath('/api/users/u2/delete')!;
    expect(post.method, 'POST');
    expect(jsonDecode(post.body), {'ref': 'U-0002'});
    expect(h.location, '/users');
    expect(find.text('Puan Aminah dipadam.'), findsOneWidget);
  });

  testWidgets('[PP-A6] Padam pengguna refused: own account, last Pentadbir, last Pentadbir phone; the person stays', (tester) async {
    final h = await openPerson(tester, 'u2');
    for (final (code, words) in [
      ('own_account', 'Anda tidak boleh memadam akaun sendiri'),
      ('last_admin', 'Mesti ada sekurang-kurangnya seorang Pentadbir aktif'),
      ('last_admin_device', 'Daftar peranti Pentadbir lain dahulu'),
    ]) {
      h.handlers['POST /api/users/u2/delete'] = (r) async => jsonResponse(409, {'code': code, 'errors': [code]});
      await tester.tap(find.byKey(const ValueKey('user-delete')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
      await settle(tester);
      expect(find.text(words), findsOneWidget, reason: code);
      expect(h.location, '/users/u2');
    }
  });

  testWidgets('[PP-A6] Padam pengguna offline: the live-only dialog, never queued', (tester) async {
    final api = FakePeopleApi();
    final h = await openPerson(tester, 'u2', overrides: [peopleApiProvider.overrideWithValue(api)]);
    await tester.tap(find.byKey(const ValueKey('user-delete')));
    await settle(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    expect(find.text('Perlukan sambungan'), findsOneWidget);
    expect(h.location, '/users/u2');
  });

  testWidgets('[PP-A6] no Padam pengguna on your own page', (tester) async {
    await openPerson(tester, 'u1');
    expect(find.byKey(const ValueKey('user-delete')), findsNothing);
    expect(find.text('Nyahaktifkan'), findsOneWidget);
  });

  testWidgets('[PP-A6b] a deactivated person: Aktifkan semula instead of devices and PIN; a hidden account is not found', (tester) async {
    final h = await openPerson(tester, 'u4');
    h.handlers['POST /api/users/u4/activate'] = (r) async => jsonResponse(200, {'ok': true});
    expect(find.byKey(const ValueKey('user-activate')), findsOneWidget);
    expect(find.text('Set semula PIN'), findsNothing);
    expect(find.text('Daftar peranti baharu'), findsNothing);
    expect(find.byKey(const ValueKey('user-delete')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('user-activate')));
    await settle(tester);
    expect(h.box.byPath('/api/users/u4/activate')?.method, 'POST');
    expect(find.text('Haji Osman diaktifkan semula. Daftar telefon dengan kod QR baharu.'), findsOneWidget);

    // A deleted person, or an account the box hides (404 for a `*` id), is not on the list: not found.
    h.router.go('/users/u7');
    await settle(tester);
    expect(find.text('Pengguna tidak dijumpai.'), findsOneWidget);
  });

  testWidgets('[PP-A6b] a Bendahari cannot reach the page', (tester) async {
    final h = await pumpShell(tester, roles: const ['treasurer']);
    h.router.go('/users/u2');
    await settle(tester);
    expect(h.location, '/');
  });
}
