// Tambah pengguna in three steps (`/users/new`, Task A7 of the Peranti and
// Pengguna plan): the person, the hand-over of the code (QR, WhatsApp to that
// one number, Kongsi, Salin kod, with the sharing rules), and the device that
// came in. Goldens: user_add_step1, user_add_step2 (+ ar), user_add_step3.
// Phone numbers here are the plan's test range only (+60 12-000 0000 to 0099).

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/finance/share.dart' show ShareResult;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart' show livePublisherProvider;
import 'package:surau_app/screens/enrol_qr_screen.dart';
import 'package:surau_app/screens/user_add_flow.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

const _ipv4 = r'\b\d{1,3}(\.\d{1,3}){3}\b';

/// The reduced text the box makes for a message (Task S5): the numbered local
/// name, no `ips`, `roles`, `invitedBy`, `help` or `cloud`.
String sharePayloadFixture() {
  final m = <String, Object?>{
    'v': 1,
    'mode': 'domain',
    'box': 'https://maxcom-0001.local:8443',
    'name': 'maxcom-0001',
    'boxId': '0123456789abcdef',
    'caSha256': 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    'code': 'KQ7M-2RTD-W5XA',
    'user': 'Encik Rahman',
    'pinSet': false,
    'appLock': false,
    'exp': DateTime.utc(2026, 11, 4, 15).millisecondsSinceEpoch,
    'surau': {'name': 'Surau Perintis Contoh', 'kind': 'surau'},
  };
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

class _Fake {
  _Fake(this.h, {this.share = true});

  final ShellHarness h;
  bool share;
  int creates = 0;
  int begins = 0;
  int recentCalls = 0;
  Map<String, Object?>? createBody;
  Map<String, Object?>? beginBody;
  http.Response Function()? createAnswer;
  http.Response Function()? beginAnswer;
  List<Map<String, Object?>> recent = [];
  final List<String> revoked = [];
  final List<Map<String, Object?>> cancels = [];

  Map<String, Object?> createdUser(String name, List<String> roles) => {
    'id': 'u9',
    'name': name,
    'roles': roles,
    'active': true,
    'pinRequired': true,
    'pinLockedUntil': null,
    'ref': 'U-0006',
    'phone': '+60120000002',
  };

  void install() {
    h.handlers['POST /api/users'] = (r) async {
      creates++;
      createBody = jsonDecode(r.body) as Map<String, Object?>;
      final custom = createAnswer;
      if (custom != null) return custom();
      return jsonResponse(
        200,
        createdUser(createBody!['name'] as String, [for (final x in createBody!['roles'] as List) x as String]),
      );
    };
    h.handlers['POST /api/enrol/begin'] = (r) async {
      begins++;
      beginBody = jsonDecode(r.body) as Map<String, Object?>;
      final custom = beginAnswer;
      if (custom != null) return custom();
      return jsonResponse(200, {
        'id': 41,
        'code': 'KQ7M-2RTD-W5XA',
        'expiresAt': '2026-11-04T15:00:00.000Z',
        'payload': fixturePayload(user: 'Encik Rahman', code: 'KQ7M-2RTD-W5XA', roles: const ['ajk']),
        if (share) 'sharePayload': sharePayloadFixture(),
      });
    };
    h.handlers['GET /api/enrol/recent'] = (r) async {
      recentCalls++;
      return jsonResponse(200, {'codes': recent});
    };
    h.handlers['POST /api/enrol/cancel'] = (r) async {
      cancels.add(jsonDecode(r.body) as Map<String, Object?>);
      return jsonResponse(200, {'ok': true, 'cancelled': true});
    };
    h.handlers['POST /api/devices/dev-9/revoke'] = (r) async {
      revoked.add('dev-9');
      return jsonResponse(200, {'ok': true});
    };
  }

  void deviceCameIn({int reuse = 0, String? cancelledAt}) => recent = [
    {
      'id': 41,
      'userId': 'u9',
      'userRef': 'U-0006',
      'userName': 'Encik Rahman',
      'deviceName': 'Telefon Encik Rahman',
      'expiresAt': '2026-11-04T15:00:00.000Z',
      'usedAt': '2026-11-04T14:31:00.000Z',
      'cancelledAt': cancelledAt,
      'reuseAttempts': reuse,
      'device': cancelledAt != null
          ? null
          : {
              'id': 'dev-9',
              'name': 'Telefon Encik Rahman',
              'platform': 'android',
              'enrolledAt': '2026-11-04T14:31:00.000Z',
              'ref': 'D-0006',
            },
    },
  ];
}

class _ShareSpy {
  final List<String> texts = [];
  final List<Uri> wa = [];
  final List<String> waTexts = [];
  bool waOpens = true;

  UserAddShare get share => UserAddShare(
    shareText: (t) async {
      texts.add(t);
      return const ShareResult('whatsapp');
    },
    openWhatsApp: (u) async {
      wa.add(u);
      return waOpens;
    },
    openWhatsAppText: (t) async {
      waTexts.add(t);
      return waOpens;
    },
  );
}

Future<(ShellHarness, _Fake, _ShareSpy)> openAdd(
  WidgetTester tester, {
  bool lockOn = false,
  bool share = true,
  bool cloud = false,
  AppLang? lang,
  GoldenSize size = GoldenSize.phone,
}) async {
  final spy = _ShareSpy();
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    features: {'appLock': lockOn},
    size: size,
    overrides: [
      userAddShareProvider.overrideWithValue(spy.share),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      if (cloud) isCloudGatewayProvider.overrideWithValue(true),
      if (lang != null) appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
    ],
  );
  final fake = _Fake(h, share: share)..install();
  h.router.go('/users/new');
  await settle(tester);
  return (h, fake, spy);
}

Future<void> fillStep1(
  WidgetTester tester, {
  String name = 'Encik Rahman',
  String phone = '012-000 0002',
  List<String> tap = const [],
}) async {
  await tester.enterText(find.byKey(const ValueKey('add-name')), name);
  await tester.enterText(find.byKey(const ValueKey('add-phone')), phone);
  for (final role in tap) {
    await reveal(tester, find.byKey(ValueKey('add-role-$role')));
    await tester.tap(find.byKey(ValueKey('add-role-$role')));
  }
  await settle(tester);
}

Future<void> save(WidgetTester tester) async {
  await reveal(tester, find.byKey(const ValueKey('add-save')));
  await tester.tap(find.byKey(const ValueKey('add-save')));
  await settle(tester);
}

Future<void> tapKey(WidgetTester tester, String key) async {
  await reveal(tester, find.byKey(ValueKey(key)));
  await tester.tap(find.byKey(ValueKey(key)));
  await settle(tester);
}

/// The text of a shared message after its last line (the `surau1:` text).
String lastLine(String text) => text.split('\n').last;

void main() {
  testWidgets('[PP-A7b] happy path: AJK ticked, phone sent as E.164, code for 30 minutes, then the device that came in', (
    tester,
  ) async {
    final (h, fake, _) = await openAdd(tester, lockOn: true);
    expect(find.text('Langkah 1 daripada 3'), findsOneWidget);
    final ajk = tester.widget<CheckboxListTile>(find.byKey(const ValueKey('add-role-ajk')));
    expect(ajk.value, isTrue, reason: 'AJK is ticked by default');
    await fillStep1(tester);
    expect(find.textContaining('Telefon Encik Rahman'), findsWidgets);
    expect(find.textContaining('kod sah 30 minit'), findsOneWidget);
    await expectGoldens(tester, h.app, 'user_add_step1');
    await tapKey(tester, 'add-role-media');

    await save(tester);
    expect(fake.creates, 1);
    expect(fake.createBody, {
      'name': 'Encik Rahman',
      'roles': ['media', 'ajk'],
      'phone': '+60120000002',
    });
    expect(fake.beginBody, {'userId': 'u9', 'deviceName': 'Telefon Encik Rahman', 'ttlMinutes': 30});
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);
    expect(find.text('Encik Rahman imbas kod ini dengan aplikasi MAXCOM'), findsOneWidget);
    expect(find.text('KQ7M-2RTD-W5XA'), findsOneWidget);
    expect(find.text('WhatsApp kepada Encik Rahman'), findsOneWidget);
    await expectGoldens(tester, h.app, 'user_add_step2');

    // The box reports the device that used the code: step 3.
    fake.deviceCameIn();
    await tester.pump(const Duration(seconds: 3));
    await settle(tester);
    expect(find.text('Langkah 3 daripada 3'), findsOneWidget);
    expect(find.text('Encik Rahman sudah masuk'), findsOneWidget);
    expect(find.text('U-0006'), findsOneWidget);
    expect(find.text('D-0006'), findsOneWidget);
    expect(find.text('Dia boleh guna aplikasi sebagai Media dan AJK mulai sekarang.'), findsOneWidget);
    expect(find.textContaining('Android, didaftarkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-reuse')), findsNothing);
    expect(find.byKey(const ValueKey('add-bottom-bar')), findsNothing);
    await expectGoldens(tester, h.app, 'user_add_step3');

    await tapKey(tester, 'add-back');
    expect(h.location, '/users');
  });

  testWidgets('[PP-A7b] in step 2 the waiting line is in the bottom bar beside "Tamatkan kod ini" and the QR is 176 px', (
    tester,
  ) async {
    final (_, fake, _) = await openAdd(tester, lockOn: true);
    await fillStep1(tester);
    await save(tester);
    final bar = find.byKey(const ValueKey('add-bottom-bar'));
    expect(find.descendant(of: bar, matching: find.text('Menunggu \u2068Encik Rahman\u2069 mendaftar')), findsOneWidget);
    expect(find.descendant(of: bar, matching: find.text('Tamatkan kod ini')), findsOneWidget);
    // Not inside the scrolling body.
    expect(find.descendant(of: find.byType(ListView), matching: find.byKey(const ValueKey('add-waiting'))), findsNothing);
    final waiting = tester.getRect(find.byKey(const ValueKey('add-waiting')));
    final end = tester.getRect(find.byKey(const ValueKey('add-end-code')));
    expect((waiting.center.dy - end.center.dy).abs(), lessThan(12), reason: 'side by side');
    expect(tester.widget<InvitationQr>(find.byType(InvitationQr)).size, 176);
    expect(tester.getSize(find.byType(InvitationQr)), const Size(176, 176));

    // Tamatkan kod ini ends the code and offers a new one.
    await tester.tap(find.byKey(const ValueKey('add-end-code')));
    await settle(tester);
    expect(fake.cancels, [
      {'id': 41, 'userId': 'u9'},
    ]);
    expect(find.byKey(const ValueKey('add-ended')), findsOneWidget);
    expect(find.byKey(const ValueKey('add-bottom-bar')), findsNothing);
    final before = fake.recentCalls;
    await tester.pump(const Duration(seconds: 12));
    expect(fake.recentCalls, before, reason: 'no polling after the code was ended');
    await tapKey(tester, 'add-new-code');
    expect(fake.begins, 2);
    expect(find.byKey(const ValueKey('add-bottom-bar')), findsOneWidget);
  });

  testWidgets('[PP-A7b] an invalid number is refused, no role blocks: nothing is sent', (tester) async {
    final (_, fake, _) = await openAdd(tester);
    await tester.enterText(find.byKey(const ValueKey('add-name')), 'Encik Rahman');
    await tester.enterText(find.byKey(const ValueKey('add-phone')), '12345');
    await save(tester);
    expect(find.textContaining('Nombor telefon tidak sah'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('add-phone')), '012-000 0002');
    await tapKey(tester, 'add-role-ajk'); // untick the only role
    await save(tester);
    expect(find.text('Pilih sekurang-kurangnya satu peranan.'), findsOneWidget);
    expect(fake.creates, 0);
    expect(fake.begins, 0);
  });

  testWidgets('[PP-A7b] the phone number is optional: an empty field sends no phone and the person is saved', (tester) async {
    final (_, fake, spy) = await openAdd(tester, lockOn: true);
    expect(find.text('Nombor telefon untuk WhatsApp (pilihan)'), findsOneWidget);
    expect(find.text('Digunakan untuk menghantar notis dan pautan melalui WhatsApp. Boleh dikosongkan.'), findsOneWidget);
    fake.createAnswer = () => jsonResponse(200, {
      'id': 'u9',
      'name': 'Encik Rahman',
      'roles': ['ajk'],
      'active': true,
      'pinRequired': true,
      'ref': 'U-0006',
      'phone': null,
    });
    await fillStep1(tester, phone: '');
    await save(tester);
    expect(fake.creates, 1);
    expect(fake.createBody, {'name': 'Encik Rahman', 'roles': ['ajk']});
    expect(fake.createBody!.containsKey('phone'), isFalse);
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);

    // No number: WhatsApp's own picker with the text, no recipient and no "opens to" line.
    await tapKey(tester, 'add-wa');
    expect(find.byKey(const ValueKey('add-wa-opens-to')), findsNothing);
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(spy.wa, isEmpty);
    expect(spy.waTexts, hasLength(1));
    expect(lastLine(spy.waTexts.single), sharePayloadFixture());
    expect(spy.waTexts.single, contains('Encik Rahman'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('[PP-A7b] a taken number shows the other ID and nothing more is called', (tester) async {
    final (_, fake, _) = await openAdd(tester);
    fake.createAnswer = () => jsonResponse(409, {
      'errors': ['Nombor telefon ini sudah digunakan oleh pengguna lain'],
      'code': 'phone_taken',
      'detail': {'ref': 'U-0002'},
    });
    await fillStep1(tester);
    await save(tester);
    expect(find.text('Nombor ini sudah digunakan oleh pengguna lain (U-0002).'), findsOneWidget);
    expect(fake.begins, 0);
  });

  testWidgets('[PP-A7b] a failed create calls nothing else; a double tap creates one person', (tester) async {
    final (_, fake, _) = await openAdd(tester);
    fake.createAnswer = () => jsonResponse(500, {
      'errors': ['internal error'],
    });
    await fillStep1(tester);
    await save(tester);
    expect(fake.creates, 1);
    expect(fake.begins, 0);
    expect(find.byKey(const ValueKey('add-save')), findsOneWidget, reason: 'still on step 1');

    fake.createAnswer = null;
    await reveal(tester, find.byKey(const ValueKey('add-save')));
    await tester.tap(find.byKey(const ValueKey('add-save')));
    await tester.tap(find.byKey(const ValueKey('add-save')), warnIfMissed: false);
    await settle(tester);
    expect(fake.creates, 2, reason: 'one more create for two taps');
    expect(fake.begins, 1);
  });

  testWidgets('[PP-A7b] box_only after the create: the person is saved and the flow ends on the list with addSavedNoQr', (
    tester,
  ) async {
    final (h, fake, _) = await openAdd(tester);
    fake.beginAnswer = () => jsonResponse(409, {
      'errors': ['Kod hanya di MAXCOM surau'],
      'code': 'box_only',
    });
    await fillStep1(tester);
    await save(tester);
    expect(fake.creates, 1);
    expect(h.location, '/users');
    expect(find.text('Encik Rahman disimpan. Buat kod QR apabila anda di Wi-Fi surau.'), findsOneWidget);
  });

  testWidgets('[PP-A7b] through the cloud no code is asked for', (tester) async {
    final (h, fake, _) = await openAdd(tester, cloud: true);
    await fillStep1(tester);
    await save(tester);
    expect(fake.creates, 1);
    expect(fake.begins, 0);
    expect(h.location, '/users');
    expect(find.text('Encik Rahman disimpan. Buat kod QR apabila anda di Wi-Fi surau.'), findsOneWidget);
  });

  testWidgets('[PP-A7b] TTL 30 here and 10 on Daftar peranti; the device name and validity can be changed', (tester) async {
    final (h, fake, _) = await openAdd(tester);
    await fillStep1(tester);
    await tapKey(tester, 'add-change-device');
    await tester.enterText(find.byKey(const ValueKey('add-device-name')), 'iPad meja bendahari');
    await tapKey(tester, 'add-ttl-60');
    await save(tester);
    expect(fake.beginBody, {'userId': 'u9', 'deviceName': 'iPad meja bendahari', 'ttlMinutes': 60});

    // The plain Daftar peranti page still opens at 10.
    h.router.go('/users/u2/enrol');
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('enrol-device-name')), 'Telefon Puan Aminah');
    await tester.tap(find.text('Jana kod QR'));
    await settle(tester);
    expect((fake.beginBody!)['ttlMinutes'], 10);
  });

  testWidgets('[PP-A7b] polling stops when the page is left', (tester) async {
    final (h, fake, _) = await openAdd(tester);
    await fillStep1(tester);
    await save(tester);
    await tester.pump(const Duration(seconds: 3));
    await settle(tester);
    expect(fake.recentCalls, greaterThan(0));
    h.router.go('/users');
    await settle(tester);
    final calls = fake.recentCalls;
    await tester.pump(const Duration(seconds: 30));
    expect(fake.recentCalls, calls);
  });

  testWidgets('[PP-A7] no share before the confirm; WhatsApp names the number and opens exactly wa.me/<digits>', (
    tester,
  ) async {
    final (_, _, spy) = await openAdd(tester, lockOn: true);
    await fillStep1(tester);
    await save(tester);

    await tapKey(tester, 'add-wa');
    expect(spy.wa, isEmpty, reason: 'nothing opens before the confirm');
    expect(find.text('Hantar kepada Encik Rahman sahaja'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-wa-opens-to')), findsOneWidget);
    expect(find.text('WhatsApp dibuka terus ke \u2066+60 12-000 0002\u2069'), findsOneWidget);
    // Batal: still nothing.
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(spy.wa, isEmpty);

    await tapKey(tester, 'add-wa');
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(spy.wa, hasLength(1));
    final uri = spy.wa.single;
    expect('${uri.scheme}://${uri.host}${uri.path}', 'https://wa.me/60120000002');
    expect(uri.queryParametersAll.keys, ['text']);
    final text = uri.queryParameters['text']!;
    expect(text, contains('Encik Rahman'));
    expect(lastLine(text), sharePayloadFixture());
    expect(RegExp(_ipv4).hasMatch(text), isFalse);
    expect(spy.texts, isEmpty);

    // Kongsi: the same confirm, then the share sheet with the reduced text.
    await tapKey(tester, 'add-share');
    expect(spy.texts, isEmpty);
    expect(find.byKey(const ValueKey('add-wa-opens-to')), findsNothing);
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(spy.texts, hasLength(1));
    expect(lastLine(spy.texts.single), sharePayloadFixture());
    expect(spy.texts.single, contains('Encik Rahman'));
    expect(RegExp(_ipv4).hasMatch(spy.texts.single), isFalse);
  });

  testWidgets('[PP-A7] WhatsApp that cannot open says so and leaves Kongsi', (tester) async {
    final (_, _, spy) = await openAdd(tester, lockOn: true);
    spy.waOpens = false;
    await fillStep1(tester);
    await save(tester);
    await tapKey(tester, 'add-wa');
    await tester.tap(find.text('Teruskan'));
    await settle(tester);
    expect(find.text('WhatsApp tidak dapat dibuka. Guna Kongsi.'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-share')), findsOneWidget);
  });

  testWidgets('[G-Q6] a create with no answer in time: the person is found by phone and the code step goes on', (
    tester,
  ) async {
    final (h, fake, _) = await openAdd(tester, lockOn: true);
    h.users.add({...fake.createdUser('Encik Rahman', const ['ajk']), 'phone': '+60120000002'});
    fake.createAnswer = () => throw TimeoutException('no answer');
    await fillStep1(tester);
    await save(tester);
    expect(fake.creates, 1);
    expect(fake.begins, 1, reason: 'the code step goes on for the found person');
    expect(find.byKey(const ValueKey('add-new-code')), findsNothing);
    expect(find.byKey(const ValueKey('add-copy')), findsOneWidget);
  });

  testWidgets('[G-Q6] a create with no answer and no such person stays on step 1 with the check text', (
    tester,
  ) async {
    final (_, fake, _) = await openAdd(tester, lockOn: true);
    fake.createAnswer = () => throw TimeoutException('no answer');
    await fillStep1(tester);
    await save(tester);
    expect(fake.begins, 0);
    expect(find.byKey(const ValueKey('add-save')), findsOneWidget);
  });

  testWidgets('[G-S6] Salin kod never copies the full payload: nothing without sharePayload or for a Pentadbir with the lock off', (
    tester,
  ) async {
    for (final c in [(lockOn: true, share: false, admin: false), (lockOn: false, share: true, admin: true)]) {
      final (_, _, _) = await openAdd(tester, lockOn: c.lockOn, share: c.share);
      await fillStep1(tester, tap: c.admin ? const ['admin'] : const []);
      await save(tester);
      final copied = <String?>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String?);
          return null;
        },
      );
      expect(find.byKey(const ValueKey('add-copy')), findsNothing);
      expect(copied, isEmpty);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('[PP-A7] both share buttons hidden without sharePayload', (tester) async {
    final (_, _, _) = await openAdd(tester, lockOn: true, share: false);
    await fillStep1(tester);
    await save(tester);
    expect(find.byKey(const ValueKey('add-wa')), findsNothing);
    expect(find.byKey(const ValueKey('add-share')), findsNothing);
    expect(find.text('Kongsi tidak tersedia pada MAXCOM ini. Tunjukkan kod QR.'), findsOneWidget);
  });

  testWidgets('[PP-A7] a Pentadbir target: hidden with the lock off, shown with it on', (tester) async {
    final (_, _, _) = await openAdd(tester);
    await fillStep1(tester, tap: const ['admin']);
    await save(tester);
    expect(find.byKey(const ValueKey('add-wa')), findsNothing);
    expect(find.byKey(const ValueKey('add-share')), findsNothing);
    expect(
      find.text('Kod untuk Pentadbir mesti diimbas di depan anda semasa kunci aplikasi dimatikan.'),
      findsOneWidget,
    );
    expect(
      find.text('Kunci aplikasi dimatikan. Hidupkan di Konfigurasi untuk keselamatan lebih.'),
      findsOneWidget,
    );
  });

  testWidgets('[PP-A7] a Pentadbir target with the lock on can be shared', (tester) async {
    final (_, _, _) = await openAdd(tester, lockOn: true);
    await fillStep1(tester, tap: const ['admin']);
    await save(tester);
    expect(find.byKey(const ValueKey('add-wa')), findsOneWidget);
    expect(find.byKey(const ValueKey('add-share')), findsOneWidget);
    expect(find.byKey(const ValueKey('add-lock-off')), findsNothing);
  });

  testWidgets('[PP-A7] the text "Salin kod" copies is accepted by EnrolFlow.inspect', (tester) async {
    final (_, _, _) = await openAdd(tester, lockOn: true);
    await fillStep1(tester);
    await save(tester);
    final copied = <String?>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String?);
        return null;
      },
    );
    await tapKey(tester, 'add-copy');
    expect(copied, [sharePayloadFixture()]);
    final flow = EnrolFlow(
      clientFor: FakeBox((_) async => jsonResponse(404, {})).client,
      key: FakeDeviceKey(),
      trust: FakeTrust(),
      store: MemoryEnrolledBoxStore(),
      platform: 'android',
      now: fixedNow,
    );
    final p = flow.inspect(copied.single!);
    expect(p.code, 'KQ7M-2RTD-W5XA');
    expect(p.user, 'Encik Rahman');
  });

  testWidgets('[PP-A7] a wrong device that used the code is removed from step 3; reuse attempts are shown', (
    tester,
  ) async {
    final (_, fake, _) = await openAdd(tester, lockOn: true);
    await fillStep1(tester);
    await save(tester);
    fake.deviceCameIn(reuse: 2);
    await tester.pump(const Duration(seconds: 3));
    await settle(tester);
    expect(find.text('Kod ini cuba digunakan lagi 2 kali selepas itu.'), findsOneWidget);
    await tapKey(tester, 'add-not-theirs');
    expect(fake.revoked, isEmpty, reason: 'confirm first');
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    expect(fake.revoked, ['dev-9']);
    expect(find.byKey(const ValueKey('add-ended')), findsOneWidget);
    expect(find.byKey(const ValueKey('add-new-code')), findsOneWidget);
  });

  testWidgets('[PP-A7b] a cancelled code never shows step 3', (tester) async {
    final (_, fake, _) = await openAdd(tester, lockOn: true);
    await fillStep1(tester);
    await save(tester);
    fake.deviceCameIn(cancelledAt: '2026-11-04T14:31:00.000Z');
    await tester.pump(const Duration(seconds: 3));
    await settle(tester);
    expect(find.text('Langkah 2 daripada 3'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-done')), findsNothing);
  });

  testWidgets('[PP-A7b] Arabic: the step label mirrors, the code and countdown stay left to right', (tester) async {
    final (h, _, _) = await openAdd(tester, lockOn: true, lang: AppLang.ar);
    await fillStep1(tester, name: 'Encik Rahman');
    await save(tester);
    expect(Directionality.of(tester.element(find.byKey(const ValueKey('add-step')))), TextDirection.rtl);
    final code = tester.widget<Text>(find.byKey(const ValueKey('enrol-qr-code')));
    expect(code.textDirection, TextDirection.ltr);
    expect(find.textContaining('\u206630:00'), findsWidgets, reason: 'the countdown is isolated left to right');
    await expectGoldens(tester, h.app, 'user_add_step2_ar', sizes: const [GoldenSize.phone]);
  });

  for (final (name, lang, label, hint) in [
    ('bm', AppLang.ms, 'Nombor telefon untuk WhatsApp (pilihan)', 'Digunakan untuk menghantar notis dan pautan melalui WhatsApp. Boleh dikosongkan.'),
    ('en', AppLang.en, 'Phone number for WhatsApp (optional)', 'Used to send notices and links through WhatsApp. You can leave it empty.'),
    ('ar', AppLang.ar, 'رقم الهاتف للواتساب (اختياري)', 'يُستخدم لإرسال الإشعارات والروابط عبر واتساب. يمكن تركه فارغًا.'),
  ]) {
    testWidgets('[W25-3] the phone field says it is for WhatsApp and optional, $name', (tester) async {
      final (h, _, _) = await openAdd(tester, lockOn: true, lang: lang);
      expect(find.text(label), findsOneWidget);
      expect(find.text(hint), findsOneWidget);
      await tester.ensureVisible(find.byKey(const ValueKey('add-phone')));
      await settle(tester);
      await expectGoldens(tester, h.app, 'user_add_phone_whatsapp_$name', sizes: const [GoldenSize.phone]);
    });
  }
}
