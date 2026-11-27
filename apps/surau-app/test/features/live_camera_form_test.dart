// The Kamera luaran form (plan 4.2, 4.3; mockups 07 to 16) on the real
// feature page over the fake box: every state of the mockups, the save of the
// sealed record with the settings, the password that never comes back, the
// result message for each failure reason, who may see it, and the goldens.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/unlock/session_keeper.dart';
import 'package:surau_app/features/settings_widgets/camera_source_card.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart' show DiscoveredCamera;
import 'package:surau_app/sync/camera_relay_seal.dart';

import 'fakes.dart';
import 'shell/harness.dart';
import '../golden_sizes.dart';

const String _dots = '••••••';

Finder k(String key) => find.byKey(ValueKey(key));
Finder get save => find.widgetWithText(FilledButton, 'Simpan');

/// What the fake box keeps of the camera, as the real route does: the answer is masked, the password stays here.
class _Cam {
  _Cam({bool configured = true}) {
    if (configured) {
      url = 'rtsp://10.168.1.50:554/stream1';
      username = 'siaran';
      password = 'kamera2026';
      lastTest = {
        'code': 'ok',
        'ok': true,
        'at': '2026-11-17T10:00:00.000Z',
        'hasAudio': true,
        'codecs': ['H264', 'MPEG-4 Audio'],
        'transport': 'tcp',
      };
    }
  }

  String url = '';
  String? username;
  String? password;
  Map<String, Object?>? lastTest;

  /// The box restored the camera from the cloud backup and waits for its password (the box drops it on a save).
  bool passwordNeeded = false;
  final List<Map<String, dynamic>> puts = [];
  int deletes = 0;
  final List<Map<String, dynamic>> tests = [];

  /// The next test answer; null plays the default success.
  Map<String, Object?>? testAnswer;
  int testStatus = 200;

  /// When set, the test waits for it.
  Completer<void>? testGate;

  /// Lane X: the control opt-in the box keeps with the camera, and what the app PUT to change it.
  Map<String, Object?> control = {
    'enabled': false,
    'protocol': 'http',
    'profile': {'preset': 1, 'focus': 'continuous', 'tracking': 'off', 'exposureEv': 0.0},
    'applyOnLive': false,
  };
  final List<Map<String, dynamic>> controlPuts = [];

  Map<String, Object?> masked() => {
    'control': control,
    'configured': url.isNotEmpty,
    'url': url.isEmpty || password == null || password!.isEmpty ? url : url.replaceFirst('rtsp://', 'rtsp://${username ?? ''}:$_dots@'),
    'username': username,
    'hasPassword': password != null && password!.isNotEmpty,
    'lastTest': lastTest,
    if (passwordNeeded && (password == null || password!.isEmpty)) 'passwordNeeded': true,
  };
}

Map<String, Object?> _okTest({bool audio = true}) => {
  'code': 'ok',
  'ok': true,
  'at': '2026-11-17T10:05:00.000Z',
  'hasAudio': audio,
  'codecs': audio ? ['H264', 'MPEG-4 Audio'] : ['H264'],
  'transport': 'tcp',
  'message': 'Berjaya. MAXCOM menerima gambar dari kamera.',
};

Map<String, Object?> _failTest(String code, String message) => {
  'code': code,
  'ok': false,
  'at': '2026-11-17T10:05:00.000Z',
  'hasAudio': null,
  'codecs': <String>[],
  'transport': null,
  'message': message,
};

Future<(ShellHarness, _Cam)> openForm(
  WidgetTester tester, {
  List<String> roles = const ['admin'],
  bool enabled = true,
  bool configured = true,
  String name = 'Kamera Mimbar',
  String transport = 'auto',
  Map<String, Object?>? control,
}) async {
  final cam = _Cam(configured: configured);
  if (control != null) cam.control = control;
  final h = await pumpShell(tester, roles: roles);
  h.settings['liveCamera'] = {'enabled': enabled, 'name': name, 'transport': transport};
  h.container.invalidate(settingsProvider);
  await settle(tester);
  h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, cam.masked());
  h.handlers['PUT /api/live/camera'] = (r) async {
    final b = jsonDecode(r.body) as Map<String, dynamic>;
    cam.puts.add(b);
    cam.passwordNeeded = false;
    final u = b['url'] as String;
    if (!RegExp(r'^rtsp://(?:[^@/]*@)?10\.168\.').hasMatch(u)) {
      return jsonResponse(400, {'errors': ['Alamat kamera tidak sah.'], 'code': 'bad_address'});
    }
    final stored = cam.url;
    final masked = u.contains('@') && u.contains(_dots);
    final changedAddress = u != cam.masked()['url'];
    final inUrl = RegExp(r'^rtsp://([^:@/]+):([^@/]+)@(.*)$').firstMatch(u);
    if (!masked && inUrl != null) {
      // a login inside the address is split off and sealed, as the box does
      cam.url = 'rtsp://${inUrl.group(3)}';
      cam.username = inUrl.group(1);
      cam.password = inUrl.group(2);
    } else if (!masked) {
      cam.url = u;
      if (b['username'] is String && (b['username'] as String).isNotEmpty) cam.username = b['username'] as String;
      if (b['username'] == '') cam.username = null;
    }
    if (b['password'] is String) cam.password = b['password'] as String;
    if (changedAddress && stored != cam.url) cam.lastTest = null;
    return jsonResponse(200, cam.masked());
  };
  h.handlers['PUT /api/live/camera/control'] = (r) async {
    final b = jsonDecode(r.body) as Map<String, dynamic>;
    cam.controlPuts.add(b);
    if (cam.url.isEmpty) return jsonResponse(404, {'errors': ['Alamat kamera belum disimpan.'], 'code': 'not_configured'});
    cam.control = {...cam.control, for (final e in b.entries) if (e.key != 'protocol') e.key: e.value};
    return jsonResponse(200, cam.masked());
  };
  h.handlers['DELETE /api/live/camera'] = (r) async {
    cam.deletes++;
    cam
      ..url = ''
      ..username = null
      ..password = null
      ..lastTest = null;
    return jsonResponse(200, cam.masked());
  };
  h.handlers['POST /api/live/camera/test'] = (r) async {
    cam.tests.add(jsonDecode(r.body) as Map<String, dynamic>);
    final gate = cam.testGate;
    if (gate != null) await gate.future;
    final a = cam.testAnswer ?? _okTest();
    if (cam.testStatus != 200) return jsonResponse(cam.testStatus, a);
    cam.lastTest = a['code'] == 'ok' || ['unreachable', 'login', 'path', 'codec'].contains(a['code']) ? a : cam.lastTest;
    return jsonResponse(200, a);
  };
  h.router.go('/settings/liveCamera');
  await settle(tester);
  return (h, cam);
}

/// Every Text on screen, for a failure message and for "never on screen" checks.
String screenText(WidgetTester tester) => [
  for (final t in tester.widgetList<Text>(find.byType(Text))) t.data ?? t.textSpan?.toPlainText() ?? '',
  for (final t in tester.widgetList<EditableText>(find.byType(EditableText))) t.controller.text,
].join(' | ');

Future<void> _type(WidgetTester tester, String key, String text) async {
  await reveal(tester, k(key));
  await tester.enterText(k(key), text);
  await tester.pump();
}

/// Goldens for a state that animates (a spinner): sized and pumped without waiting for it to settle.
Future<void> goldensUnsettled(WidgetTester tester, Widget app, String name) async {
  for (final size in GoldenSize.values) {
    tester.view.physicalSize = size.size * goldenPixelRatio;
    tester.view.devicePixelRatio = goldenPixelRatio;
    await tester.pumpWidget(app);
    await tester.pump(const Duration(milliseconds: 100));
    await expectLater(find.byWidget(app), matchesGoldenFile('${name}_${size.name}.png'), reason: 'golden $name at ${size.name}');
  }
}

void main() {
  group('mockup 07: a camera that is set up', () {
    testWidgets('shows name, address, login, dots for the password, audio from the last test, Lanjutan folded', (tester) async {
      final (h, _) = await openForm(tester);
      expect(find.text('Kamera luaran'), findsWidgets);
      expect(find.text('Tawarkan kamera luaran'), findsOneWidget);
      expect(find.text('Dipaparkan sebagai pilihan sebelum siaran'), findsOneWidget);
      expect((tester.widget<TextField>(k('camera-name')).controller!.text), 'Kamera Mimbar');
      // The address as the box answered it: password as dots, not the password.
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://siaran:$_dots@10.168.1.50:554/stream1');
      expect(tester.widget<TextField>(k('camera-username')).controller!.text, 'siaran');
      expect(k('camera-password-dots'), findsOneWidget);
      expect(k('camera-password'), findsNothing);
      expect(find.text('Tukar kata laluan'), findsOneWidget);
      expect(find.text('Disimpan bersulit di MAXCOM sahaja, tidak di awan. Tidak dipaparkan semula.'), findsOneWidget);
      expect(find.text('Ada, AAC'), findsOneWidget);
      expect(find.text('Audio kamera digunakan bersama gambarnya. Sumber lain boleh ditambah dan dicampur sebelum setiap siaran.'), findsOneWidget);
      expect(find.text('Uji sambungan'), findsOneWidget);
      expect(find.text('Pengangkutan: Automatik'), findsOneWidget);
      expect(find.text('Automatik cuba TCP dahulu, kemudian UDP jika gambar tidak sampai. Pilih TCP atau UDP hanya jika Automatik tidak berjaya.'), findsNothing, reason: 'folded');
      // RTSP is the only kind; SRT, NDI and RTMP are shown greyed and can be neither chosen nor stored.
      expect(find.text('RTSP'), findsOneWidget);
      for (final x in ['SRT', 'NDI', 'RTMP']) {
        expect(find.text(x), findsOneWidget);
      }
      expect(find.text('Akan datang'), findsNWidgets(3));
      expect(find.text('Telefon atau MAXCOM yang menarik video mesti berada pada Wi-Fi surau yang sama dengan kamera. Internet tidak diperlukan untuk siaran ke skrin surau.'), findsOneWidget);
      expect(find.textContaining('MAXCOM'), findsWidgets, reason: 'the camera texts of the mockups say "MAXCOM"');
      // nothing to save yet
      expect(tester.widget<FilledButton>(save).enabled, isFalse);
      await expectGoldens(tester, h.app, 'camera_form');
    });

    testWidgets('Cari kamera di rangkaian is drawn (discovery has landed)', (tester) async {
      await openForm(tester);
      expect(cameraDiscoveryReady, isTrue);
      expect(cameraDiscoveryFill, isTrue);
      await reveal(tester, k('camera-discover'));
      expect(find.text('Cari kamera di rangkaian'), findsOneWidget);
    });

    testWidgets('B7: Kecerahan gambar is on the page, Automatik by default, and the choice is saved with the settings', (tester) async {
      final (h, _) = await openForm(tester);
      await reveal(tester, k('camera-brightness-card'));
      expect(find.text('Kecerahan gambar'), findsOneWidget);
      await tester.tap(find.descendant(of: k('camera-brightness-card'), matching: find.text('Automatik')));
      await settle(tester);
      await tester.tap(find.text('Cerah').last);
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final put = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera').single;
      expect(jsonDecode(put.body), {'brightness': 'bright'});
    });

    testWidgets('Pengangkutan sits inside Lanjutan: Automatik, TCP, UDP; the choice is saved with the settings', (tester) async {
      final (h, _) = await openForm(tester);
      await reveal(tester, k('camera-lanjutan'));
      await tester.tap(k('camera-lanjutan'));
      await settle(tester);
      // the transport choice and, below the card, the picture brightness choice (also Automatik by default)
      expect(find.text('Automatik'), findsNWidgets(2));
      expect(find.text('TCP'), findsOneWidget);
      expect(find.text('UDP'), findsOneWidget);
      expect(find.textContaining('Automatik cuba TCP dahulu'), findsOneWidget);
      await tester.tap(find.text('TCP'));
      await settle(tester);
      expect(find.text('Pengangkutan: TCP'), findsOneWidget);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final put = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera').single;
      expect(jsonDecode(put.body), {'transport': 'tcp'});
    });
  });

  group('restored from the cloud backup (the cloud never holds the password)', () {
    Future<(ShellHarness, _Cam)> openRestored(WidgetTester tester) async {
      final cam = _Cam();
      cam
        ..password = null
        ..passwordNeeded = true;
      final h = await pumpShell(tester, roles: const ['admin']);
      h.settings['liveCamera'] = {'enabled': true, 'name': 'Kamera Mimbar', 'transport': 'auto'};
      h.container.invalidate(settingsProvider);
      await settle(tester);
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, cam.masked());
      h.handlers['PUT /api/live/camera'] = (r) async {
        final b = jsonDecode(r.body) as Map<String, dynamic>;
        cam.puts.add(b);
        cam.passwordNeeded = false;
        if (b['password'] is String) cam.password = b['password'] as String;
        return jsonResponse(200, cam.masked());
      };
      h.router.go('/settings/liveCamera');
      await settle(tester);
      return (h, cam);
    }

    testWidgets('says the password must be typed again, with the password field open and focused; typing it and Simpan ends the state', (tester) async {
      final (_, cam) = await openRestored(tester);
      // address and user name came back; no dots, the password box is open and has the focus
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://10.168.1.50:554/stream1');
      expect(tester.widget<TextField>(k('camera-username')).controller!.text, 'siaran');
      expect(k('camera-password-dots'), findsNothing);
      expect(k('camera-password-needed'), findsOneWidget);
      expect(find.text('Kata laluan kamera perlu ditaip semula'), findsOneWidget);
      expect(find.text('Alamat dan nama pengguna dipulihkan dari sandaran awan. Kata laluan tidak pernah disimpan di awan.'), findsOneWidget);
      final field = tester.widget<TextField>(k('camera-password'));
      expect(field.focusNode!.hasFocus, isTrue);

      await _type(tester, 'camera-password', 'kamera2026');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single, {'url': 'rtsp://10.168.1.50:554/stream1', 'username': 'siaran', 'password': 'kamera2026'});
      expect(k('camera-password-needed'), findsNothing);
      expect(k('camera-password-dots'), findsOneWidget);
      expect(screenText(tester), isNot(contains('kamera2026')));
    });
  });

  group('mockup 08: the first time', () {
    testWidgets('empty fields with hints, the audio line says it is not known yet, the password box is open', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, '');
      expect(find.text('Contoh: Kamera Mimbar'), findsOneWidget);
      expect(find.text('rtsp://10.168.1.50:554/stream1'), findsOneWidget);
      expect(find.text('Kosongkan jika ada dalam alamat'), findsNWidgets(2));
      expect(k('camera-password'), findsOneWidget);
      expect(find.text('Disimpan bersulit di MAXCOM sahaja, tidak di awan.'), findsOneWidget);
      expect(find.text('Belum diketahui. Dikesan semasa Uji sambungan.'), findsOneWidget);
      await reveal(tester, k('camera-lanjutan'));
      await tester.tap(k('camera-lanjutan'));
      await settle(tester);
      await expectGoldens(tester, h.app, 'camera_form_new');
    });

    testWidgets('the password box hides what is typed and the eye shows it', (tester) async {
      await openForm(tester, configured: false);
      await _type(tester, 'camera-password', 'rahsia-1');
      expect(tester.widget<EditableText>(find.descendant(of: k('camera-password'), matching: find.byType(EditableText))).obscureText, isTrue);
      await reveal(tester, k('camera-password-toggle'));
      await tester.tap(k('camera-password-toggle'));
      await settle(tester);
      expect(tester.widget<EditableText>(find.descendant(of: k('camera-password'), matching: find.byType(EditableText))).obscureText, isFalse);
    });

    testWidgets('saving the first address sends it with the login and the settings go with it', (tester) async {
      final (h, cam) = await openForm(tester, configured: false, name: '');
      await _type(tester, 'camera-name', 'Kamera Dewan');
      await _type(tester, 'camera-url', 'rtsp://10.168.1.60:554/live');
      await _type(tester, 'camera-username', 'siaran');
      await _type(tester, 'camera-password', 'rahsia-1');
      await reveal(tester, save);
      expect(tester.widget<FilledButton>(save).enabled, isTrue);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single, {'url': 'rtsp://10.168.1.60:554/live', 'username': 'siaran', 'password': 'rahsia-1'});
      final put = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera').single;
      expect(jsonDecode(put.body), {'name': 'Kamera Dewan'});
      // After the save the form holds dots and no password text anywhere on screen.
      expect(k('camera-password-dots'), findsOneWidget);
      expect(k('camera-password'), findsNothing);
      expect(screenText(tester), isNot(contains('rahsia-1')));
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://siaran:$_dots@10.168.1.60:554/live');
      expect(tester.widget<FilledButton>(save).enabled, isFalse);
    });
  });

  group('mockup 16: change the password', () {
    testWidgets('Tukar kata laluan opens the box, Batal tukar closes it and clears what was typed', (tester) async {
      final (h, cam) = await openForm(tester);
      await reveal(tester, k('camera-password-change'));
      await tester.tap(k('camera-password-change'));
      await settle(tester);
      expect(k('camera-password'), findsOneWidget);
      expect(find.text('Kata laluan lama diganti bila anda tekan Simpan.'), findsOneWidget);
      await tester.enterText(k('camera-password'), 'baharu-2');
      await tester.pump();
      expect(tester.widget<FilledButton>(save).enabled, isTrue, reason: 'a typed password is a change');
      await expectGoldens(tester, h.app, 'camera_password_change');
      await tester.tap(k('camera-password-cancel'));
      await settle(tester);
      expect(k('camera-password'), findsNothing);
      expect(k('camera-password-dots'), findsOneWidget);
      expect(screenText(tester), isNot(contains('baharu-2')));
      expect(tester.widget<FilledButton>(save).enabled, isFalse);
      expect(cam.puts, isEmpty);
    });

    testWidgets('the new password is sent once, the address with dots keeps nothing else, and it is gone from the screen', (tester) async {
      final (_, cam) = await openForm(tester);
      await reveal(tester, k('camera-password-change'));
      await tester.tap(k('camera-password-change'));
      await settle(tester);
      await tester.enterText(k('camera-password'), 'baharu-2');
      await tester.pump();
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single['password'], 'baharu-2');
      expect(cam.puts.single['url'], 'rtsp://siaran:$_dots@10.168.1.50:554/stream1');
      expect(cam.password, 'baharu-2');
      expect(screenText(tester), isNot(contains('baharu-2')));
      expect(k('camera-password-dots'), findsOneWidget);
    });

    testWidgets('an edit that leaves the password alone does not send it', (tester) async {
      final (_, cam) = await openForm(tester);
      await _type(tester, 'camera-username', 'tetamu');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single.containsKey('password'), isFalse);
      expect(cam.puts.single['username'], 'tetamu');
    });
  });

  group('mockup 09: switched off', () {
    testWidgets('the record is kept and said so; Padam tetapan kamera removes it after a confirm', (tester) async {
      final (h, cam) = await openForm(tester, enabled: false);
      expect(find.text('Tidak dipaparkan sebagai pilihan siaran'), findsOneWidget);
      expect(find.text('Tetapan Kamera Mimbar masih disimpan. Ia tidak muncul sebagai pilihan semasa siaran sehingga dihidupkan semula.'), findsOneWidget);
      expect(k('camera-url'), findsNothing);
      expect(find.text('Padam tetapan kamera'), findsOneWidget);
      await expectGoldens(tester, h.app, 'camera_form_off');

      await tester.tap(k('camera-delete'));
      await settle(tester);
      expect(find.text('Padam tetapan kamera?'), findsOneWidget);
      expect(cam.deletes, 0);
      await tester.tap(find.text('Padam'));
      await settle(tester);
      expect(cam.deletes, 1);
      expect(find.text('Padam tetapan kamera'), findsNothing, reason: 'no record left to delete');
      expect(find.text('Hidupkan untuk menyiarkan kuliah dari kamera IP atau CCTV di surau. Masukkan alamat RTSP, atau guna Cari kamera di rangkaian (ONVIF).'), findsOneWidget);
    });

    testWidgets('a camera never set up has nothing to delete', (tester) async {
      await openForm(tester, enabled: false, configured: false);
      expect(k('camera-delete'), findsNothing);
      expect(find.text('Hidupkan untuk menyiarkan kuliah dari kamera IP atau CCTV di surau. Masukkan alamat RTSP, atau guna Cari kamera di rangkaian (ONVIF).'), findsOneWidget);
    });

    testWidgets('switching on shows the form and saves enabled with the settings', (tester) async {
      final (h, _) = await openForm(tester, enabled: false);
      await tester.tap(find.descendant(of: k('feature-switch'), matching: find.byType(Switch)));
      await settle(tester);
      expect(k('camera-url'), findsOneWidget);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final put = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera').single;
      expect(jsonDecode(put.body), {'enabled': true});
    });
  });

  group('[G2] Set semula kepada lalai on the camera page', () {
    testWidgets('leaves the camera ON with its name, address and login; only the advanced choices go back', (tester) async {
      final (h, cam) = await openForm(tester, transport: 'udp');
      expect(find.text('Set semula kepada lalai'), findsNothing, reason: 'in the page menu, not 8 px under Simpan');
      await tester.tap(k('feature-menu'));
      await settle(tester);
      await tester.tap(k('feature-reset'));
      await settle(tester);
      expect(find.text('Pilihan lanjutan akan dikembalikan kepada lalai. Kamera kekal dihidupkan.'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Set semula kepada lalai'));
      await settle(tester);
      final put = h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera').single;
      final body = jsonDecode(put.body) as Map<String, dynamic>;
      expect(body.containsKey('enabled'), isFalse, reason: 'audit id 1915: the reset switched the camera off');
      expect(body.containsKey('name'), isFalse, reason: 'audit id 1915: the reset renamed it "Kamera luaran"');
      expect(body['transport'], 'auto');
      expect(cam.puts, isEmpty, reason: 'the sealed record (address, login) is not touched');
      expect(cam.deletes, 0);
    });
  });

  group('mockups 10 to 15: Uji sambungan', () {
    testWidgets('10 running: the button is disabled and says who is connecting to what', (tester) async {
      final (h, cam) = await openForm(tester);
      cam.testGate = Completer<void>();
      addTearDown(() {
        if (!cam.testGate!.isCompleted) cam.testGate!.complete();
      });
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(k('camera-test-running'), findsOneWidget);
      expect(find.text('MAXCOM sedang menyambung ke kamera'), findsOneWidget);
      expect(find.text('Menghubungi 10.168.1.50. Ini mengambil masa hingga 15 saat.'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(k('camera-test')).onPressed, isNull);
      await goldensUnsettled(tester, h.app, 'camera_test_running');
      cam.testGate!.complete();
      await settle(tester);
      expect(k('camera-test-ok'), findsOneWidget);
    });

    testWidgets('11 success: the box words, chips for video, audio and transport, and the audio line follows', (tester) async {
      final (h, cam) = await openForm(tester, configured: false);
      cam.testAnswer = _okTest();
      await _type(tester, 'camera-url', 'rtsp://10.168.1.50:554/stream1');
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      // The address that was typed is saved first: the box tests the saved record.
      expect(cam.puts.single['url'], 'rtsp://10.168.1.50:554/stream1');
      expect(cam.tests.single, {'transport': 'auto'});
      expect(find.text('Berjaya. MAXCOM menerima gambar dari kamera.'), findsOneWidget);
      for (final chip in ['H.264', 'Audio AAC', 'Pengangkutan TCP']) {
        expect(find.text(chip), findsOneWidget, reason: chip);
      }
      expect(find.text('Ada, AAC'), findsOneWidget);
      await expectGoldens(tester, h.app, 'camera_test_ok');
    });

    testWidgets('a camera with no audio line says so, in the result and under Audio pada kamera', (tester) async {
      final (_, cam) = await openForm(tester);
      cam.testAnswer = _okTest(audio: false);
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(find.text('Tiada audio'), findsOneWidget, reason: 'the chip');
      expect(find.text('Kamera ini tiada audio'), findsOneWidget, reason: 'the line under Audio pada kamera');
      expect(find.text('Ada, AAC'), findsNothing);
    });

    for (final c in <(String, String, String, String, String)>[
      ('12', 'unreachable', 'Gagal: kamera tidak dapat dihubungi', 'MAXCOM tidak mendapat jawapan dari 10.168.1.50.', 'camera_test_unreachable'),
      ('13', 'login', 'Gagal: nama pengguna atau kata laluan salah', 'Kamera menolak log masuk.', 'camera_test_login'),
      ('14', 'codec', 'Gagal: codec tidak disokong, guna H.264', 'Tukar pengekodan strim utama kepada H.264', 'camera_test_codec'),
      ('15', 'path', 'Gagal: alamat strim tidak dijumpai', 'Kamera menjawab tetapi tiada strim di alamat ini.', 'camera_test_path'),
    ]) {
      testWidgets('${c.$1} failure ${c.$2}: its own heading and its own advice', (tester) async {
        final (h, cam) = await openForm(tester);
        cam.testAnswer = _failTest(c.$2, c.$3);
        await reveal(tester, k('camera-test'));
        await tester.tap(k('camera-test'));
        await settle(tester);
        expect(k('camera-test-${c.$2}'), findsOneWidget);
        expect(find.text(c.$3), findsOneWidget);
        expect(find.textContaining(c.$4), findsOneWidget);
        // the others are not shown
        expect(find.byKey(const ValueKey('camera-test-ok')), findsNothing);
        await expectGoldens(tester, h.app, c.$5);
      });
    }

    testWidgets('a test with the transport chosen in Lanjutan sends it', (tester) async {
      final (_, cam) = await openForm(tester, transport: 'udp');
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(cam.tests.single, {'transport': 'udp'});
    });

    testWidgets('refused while a live runs, or too often: the box words, no result box of a camera failure', (tester) async {
      final (h, cam) = await openForm(tester);
      cam.testStatus = 409;
      cam.testAnswer = {'errors': ['Siaran sedang berjalan. Uji sambungan selepas siaran tamat.'], 'code': 'live_busy'};
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(find.text('Siaran langsung sedang berjalan. Cuba selepas siaran tamat.'), findsOneWidget);
      expect(find.text('Gagal: kamera tidak dapat dihubungi'), findsNothing);
      cam.testStatus = 429;
      cam.testAnswer = {'errors': ['Terlalu banyak percubaan. Cuba sebentar lagi.'], 'code': 'too_many'};
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(find.text('Terlalu banyak percubaan. Tunggu sebentar dan cuba lagi.'), findsOneWidget);
      expect(h.box.seen.where((r) => r.url.path == '/api/live/camera/test'), hasLength(2));
    });

    testWidgets('[L8] a test refused for its address shows the reason from the top level of the answer', (tester) async {
      final (_, cam) = await openForm(tester);
      cam.testAnswer = {
        'code': 'bad_address',
        'ok': false,
        'at': '2026-11-18T10:00:00Z',
        'reason': 'not_private',
        'message': 'Alamat kamera tidak sah.',
      };
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(find.textContaining('rangkaian persendirian'), findsOneWidget);
      expect(find.text('Alamat kamera tidak sah.'), findsNothing);
    });

    testWidgets('testing with no address asks for one and sends nothing', (tester) async {
      final (_, cam) = await openForm(tester, configured: false);
      await reveal(tester, k('camera-test'));
      await tester.tap(k('camera-test'));
      await settle(tester);
      expect(find.text('Masukkan alamat kamera dahulu.'), findsOneWidget);
      expect(cam.tests, isEmpty);
      expect(cam.puts, isEmpty);
    });
  });

  group('a refused address', () {
    testWidgets('the box words land under the address and nothing else is saved', (tester) async {
      final (h, cam) = await openForm(tester, configured: false, name: '');
      await _type(tester, 'camera-name', 'Kamera Dewan');
      await _type(tester, 'camera-url', 'rtsp://10.9.9.9:554/x');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts, hasLength(1));
      expect(find.text('Alamat kamera tidak sah'), findsOneWidget);
      expect(h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/settings/liveCamera'), isEmpty, reason: 'the settings wait for a good address');
    });

    for (final e in const {
      'is_box': 'Alamat ini ialah MAXCOM sendiri. Masukkan alamat kamera.',
      'bad_port': 'Port mesti nombor dari 1 hingga 65535.',
    }.entries) {
      testWidgets('[L8] the box reason ${e.key} lands under the address in its own words', (tester) async {
        final (h, cam) = await openForm(tester, configured: false, name: '');
        h.handlers['PUT /api/live/camera'] = (r) async =>
            jsonResponse(400, {'errors': ['Alamat kamera tidak sah.'], 'code': 'bad_address', 'detail': {'reason': e.key}});
        await _type(tester, 'camera-name', 'Kamera Dewan');
        await _type(tester, 'camera-url', 'rtsp://10.168.1.50:554/x');
        await reveal(tester, save);
        await tester.tap(save);
        await settle(tester);
        expect(find.text(e.value), findsOneWidget);
        expect(find.text('Alamat kamera tidak sah.'), findsNothing, reason: 'not the box sentence');
      });
    }

    testWidgets('[L8] an address the app can judge is answered while typing, with the reason', (tester) async {
      final (_, cam) = await openForm(tester, configured: false);
      await _type(tester, 'camera-url', 'rtsp://camera.local/live');
      expect(find.text('Guna alamat IPv4 kamera di rangkaian surau (contoh 10.168.1.20), bukan nama.'), findsOneWidget);
      await _type(tester, 'camera-url', 'rtsp://8.8.8.8/live');
      expect(find.textContaining('rangkaian persendirian'), findsOneWidget);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.50:99999/live');
      expect(find.textContaining('65535'), findsOneWidget);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.50:554/live');
      expect(find.textContaining('65535'), findsNothing);
      expect(cam.puts, isEmpty);
    });

    testWidgets('[L8] the address field holds 400 characters at most', (tester) async {
      await openForm(tester, configured: false);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.50/${'a' * 500}');
      final field = tester.widget<TextField>(find.byKey(const ValueKey('camera-url')));
      expect(field.controller!.text.length, 400);
    });

    testWidgets('an address that is not rtsp:// is refused before it leaves the phone', (tester) async {
      final (_, cam) = await openForm(tester, configured: false);
      await _type(tester, 'camera-url', 'http://10.168.1.50/live');
      await reveal(tester, save);
      expect(tester.widget<FilledButton>(save).enabled, isFalse);
      expect(cam.puts, isEmpty);
    });
  });

  group('Lane X: Benarkan kawalan kamera', () {
    testWidgets('a saved camera shows the switch, off, with its note; switching it on tells the box and keeps the form', (tester) async {
      final (h, cam) = await openForm(tester);
      await reveal(tester, k('camera-control-switch'));
      expect(find.text('Benarkan kawalan kamera'), findsOneWidget);
      expect(find.text('Hanya untuk kamera yang menyokong kawalan melalui rangkaian.'), findsOneWidget);
      expect(tester.widget<SwitchListTile>(k('camera-control-switch')).value, isFalse);
      await expectGoldens(tester, h.app, 'camera_form_control');
      await tester.tap(k('camera-control-switch'));
      await settle(tester);
      expect(cam.controlPuts, [
        {'enabled': true},
      ]);
      expect(tester.widget<SwitchListTile>(k('camera-control-switch')).value, isTrue);
      // the address typed before is still there
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://siaran:$_dots@10.168.1.50:554/stream1');
      expect(k('camera-control-error'), findsNothing);
      // and off again
      await tester.tap(k('camera-control-switch'));
      await settle(tester);
      expect(cam.controlPuts.last, {'enabled': false});
      expect(tester.widget<SwitchListTile>(k('camera-control-switch')).value, isFalse);
    });

    testWidgets('the profile fields appear under the switch only while it is on, with the defaults; each change is saved at once', (tester) async {
      final (_, cam) = await openForm(tester);
      expect(k('camera-profile'), findsNothing);
      await reveal(tester, k('camera-control-switch'));
      await tester.tap(k('camera-control-switch'));
      await settle(tester);
      await reveal(tester, k('camera-profile'));
      for (final t in ['Kedudukan', 'Fokus', 'Jejak automatik', 'Kecerahan', 'Berterusan', 'Sekali', 'Manual', 'Tutup', 'Orang', 'Terapkan semasa siaran bermula']) {
        expect(find.text(t), findsOneWidget, reason: t);
      }
      expect(tester.widget<Text>(k('camera-profile-ev')).data, '0.0');
      expect(tester.widget<SwitchListTile>(k('camera-profile-on-live')).value, isFalse);
      await tester.tap(find.descendant(of: k('camera-profile-focus'), matching: find.text('Sekali')));
      await settle(tester);
      expect(cam.controlPuts.last, {
        'profile': {'preset': 1, 'focus': 'single', 'tracking': 'off', 'exposureEv': 0.0},
      });
      await tester.tap(find.descendant(of: k('camera-profile-tracking'), matching: find.text('Orang')));
      await settle(tester);
      await tester.tap(find.descendant(of: k('camera-profile-preset'), matching: find.text('3')));
      await settle(tester);
      await reveal(tester, k('camera-profile-brighter'));
      await tester.tap(k('camera-profile-brighter'));
      await settle(tester);
      expect(cam.controlPuts.last, {
        'profile': {'preset': 3, 'focus': 'single', 'tracking': 'human', 'exposureEv': 0.5},
      });
      expect(tester.widget<Text>(k('camera-profile-ev')).data, '+0.5');
      await reveal(tester, k('camera-profile-on-live'));
      await tester.tap(k('camera-profile-on-live'));
      await settle(tester);
      expect(cam.controlPuts.last, {'applyOnLive': true});
      expect(tester.widget<SwitchListTile>(k('camera-profile-on-live')).value, isTrue);
    });

    testWidgets('golden: the profile fields under the switch', (tester) async {
      final (h, _) = await openForm(tester, control: {'enabled': true, 'protocol': 'http', 'profile': {'preset': 2, 'focus': 'single', 'tracking': 'off', 'exposureEv': -1.5}, 'applyOnLive': true});
      await reveal(tester, k('camera-profile'));
      await expectGoldens(tester, h.app, 'camera_form_profile');
    });

    testWidgets('brightness stops at +3.0', (tester) async {
      final (_, cam) = await openForm(tester, control: {'enabled': true, 'protocol': 'http', 'profile': {'preset': 1, 'focus': 'continuous', 'tracking': 'off', 'exposureEv': 3.0}, 'applyOnLive': false});
      expect(cam.control['enabled'], isTrue);
      await reveal(tester, k('camera-profile-brighter'));
      expect(tester.widget<IconButton>(k('camera-profile-brighter')).onPressed, isNull);
      expect(tester.widget<IconButton>(k('camera-profile-darker')).onPressed, isNotNull);
    });

    testWidgets('no camera saved: no switch (there is nothing to control)', (tester) async {
      await openForm(tester, configured: false);
      expect(k('camera-control-switch'), findsNothing);
    });

    testWidgets('a box that refuses is told in the app words and the switch stays as it was', (tester) async {
      final (h, cam) = await openForm(tester);
      h.handlers['PUT /api/live/camera/control'] = (r) async => jsonResponse(404, {'errors': ['x'], 'code': 'not_configured'});
      await reveal(tester, k('camera-control-switch'));
      await tester.tap(k('camera-control-switch'));
      await settle(tester);
      expect(k('camera-control-error'), findsOneWidget);
      expect(tester.widget<SwitchListTile>(k('camera-control-switch')).value, isFalse);
      expect(cam.controlPuts, isEmpty);
    });
  });

  group('who sees it', () {
    for (final role in ['ajk', 'media', 'treasurer']) {
      testWidgets('$role does not: the route is refused, nothing is asked of the camera route', (tester) async {
        final (h, cam) = await openForm(tester, roles: [role]);
        // /settings/liveCamera goes to /live/settings/liveCamera, which is for live:settings only
        expect(h.location, '/');
        expect(k('camera-card'), findsNothing);
        expect(k('camera-url'), findsNothing);
        expect(h.box.seen.where((r) => r.url.path.startsWith('/api/live/camera')), isEmpty);
        expect(cam.puts, isEmpty);
      });
    }

    for (final role in ['live', 'admin', 'superadmin']) {
      testWidgets('$role does: live:settings opens the form', (tester) async {
        await openForm(tester, roles: [role]);
        expect(k('camera-card'), findsOneWidget);
        expect(find.text('Uji sambungan'), findsOneWidget);
      });
    }

    testWidgets('the Siaran Langsung role saves the camera with its own permission, without settings:write', (tester) async {
      final (_, cam) = await openForm(tester, roles: const ['live']);
      await _type(tester, 'camera-username', 'tetamu');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single['username'], 'tetamu');
    });

    testWidgets('the list of settings hides Kamera luaran from anyone without live:settings', (tester) async {
      final h = await pumpShell(tester, roles: const ['media']);
      h.router.go('/settings');
      await settle(tester);
      final head = find.byKey(const ValueKey('settings-group-live'));
      if (head.evaluate().isNotEmpty) {
        await tester.ensureVisible(head);
        await tester.tap(head);
        await settle(tester);
      }
      expect(find.byKey(const ValueKey('settings-row-liveCamera')), findsNothing);
    });
  });

  group('the box does not answer', () {
    testWidgets('the form says so with a retry, and loads when it comes back', (tester) async {
      final (h, cam) = await openForm(tester);
      h.router.go('/settings');
      await settle(tester);
      h.handlers['GET /api/live/camera'] = (r) async => throw http.ClientException('away');
      h.router.go('/settings/liveCamera');
      await settle(tester);
      expect(k('camera-load-error'), findsOneWidget);
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, cam.masked());
      await tester.tap(k('camera-load-retry'));
      await settle(tester);
      expect(k('camera-url'), findsOneWidget);
    });
  });

  group('the camera routes live only on the box', () {
    const atSurau =
        'Tetapan kamera hanya boleh dibuat di surau. Sambung telefon ke Wi-Fi surau, kemudian buka halaman ini semula. Di sini anda boleh masukkan alamat RTSP kamera atau guna Cari kamera di rangkaian (ONVIF).';

    testWidgets('a 404 from the camera route shows the at-the-surau card with Cuba lagi, never the raw path', (tester) async {
      final (h, cam) = await openForm(tester);
      h.router.go('/settings');
      await settle(tester);
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(404, {'errors': ['not found: GET /api/live/camera']});
      h.router.go('/settings/liveCamera');
      await settle(tester);
      expect(k('camera-load-error'), findsOneWidget);
      expect(find.text(atSurau), findsOneWidget);
      expect(screenText(tester), isNot(contains('not found')));
      expect(screenText(tester), isNot(contains('/api/live/camera')));
      expect(k('camera-url'), findsNothing);
      expect(k('camera-load-retry'), findsOneWidget);
      // the phone reaches the box again: Cuba lagi brings the form
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, cam.masked());
      await tester.tap(k('camera-load-retry'));
      await settle(tester);
      expect(k('camera-url'), findsOneWidget);
    });

    testWidgets('on the surau Wi-Fi the form with the RTSP address shows', (tester) async {
      await openForm(tester);
      expect(k('camera-url'), findsOneWidget);
      expect(find.text(atSurau), findsNothing);
    });
  });

  group('the camera set from anywhere (sealed, sent through the cloud)', () {
    const boxJwk = {
      'kty': 'EC',
      'crv': 'P-256',
      'x': '_3cj-DakG4KtizzNP0ZmsiA6N2jVMtLgLYY9iZNxEUg',
      'y': 'RsoTz1uetxQljH94us22AGtsGHfpQERE_jECHeqtlN0',
      'd': 'Mgiv-LvGFamfSh93EKF5BuhllvQSDIO-GKY9TTdPZ98',
    };
    const boxId = 'aaaa000000000001';
    const pending = 'Dihantar ke MAXCOM. Akan digunakan selepas MAXCOM menerima (biasanya dalam 2 minit).';

    Map<String, Object?> view({
      bool configured = false,
      String url = '',
      String? username,
      bool hasPassword = false,
      bool pending = false,
      String? failure,
      int seq = 1,
      bool relay = true,
    }) => {
      'configured': configured,
      'url': url,
      'username': username,
      'hasPassword': hasPassword,
      'lastTest': null,
      'pending': pending,
      'failure': failure,
      'relay': relay ? {'boxId': boxId, 'key': {for (final e in boxJwk.entries) if (e.key != 'd') e.key: e.value}, 'seq': seq} : null,
    };

    Future<ShellHarness> openCloud(WidgetTester tester) async {
      final h = await pumpShell(
        tester,
        roles: const ['admin'],
        overrides: [
          sessionKeeperProvider.overrideWith(
            (ref) => SessionKeeper(
              attempt: ({required bool boxOnly}) async => throw const BoxUnreachable('test'),
              onConnected: (_) {},
              onRefused: (_) {},
              onUnavailable: () async {},
              schedule: (d, f) => Timer(d, f)..cancel(),
            ),
          ),
        ],
      );
      h.settings['liveCamera'] = {'enabled': true, 'name': 'Kamera Mimbar', 'transport': 'auto'};
      h.container.read(sessionProvider.notifier).set(h.session().issuedBy(Uri.parse('https://api.mymaxcom.my'), SessionDto.viaCloud));
      h.container.invalidate(settingsProvider);
      await settle(tester);
      return h;
    }

    Future<void> go(WidgetTester tester, ShellHarness h) async {
      h.router.go('/settings/liveCamera');
      await settle(tester);
    }

    testWidgets('the RTSP block shows over the cloud; ONVIF and the test say they are at the surau only; no raw error', (tester) async {
      final h = await openCloud(tester);
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, view());
      await go(tester, h);
      expect(k('camera-url'), findsOneWidget);
      expect(k('camera-username'), findsOneWidget);
      expect(k('camera-password'), findsOneWidget);
      expect(k('camera-discover'), findsNothing);
      expect(k('camera-test'), findsNothing);
      await reveal(tester, k('camera-discover-surau-only'));
      expect(find.text('Cari kamera (ONVIF) hanya di Wi-Fi surau.'), findsOneWidget);
      expect(find.text('Uji kamera hanya di Wi-Fi surau.'), findsOneWidget);
      expect(k('camera-load-error'), findsNothing);
      expect(screenText(tester), isNot(contains('not found')));
      expect(screenText(tester), isNot(contains('/api/live/camera')));
    });

    testWidgets('Simpan seals the address and password to the box key: the cloud gets no address, no login; the note says it was sent', (tester) async {
      final h = await openCloud(tester);
      final puts = <Map<String, dynamic>>[];
      var pend = false;
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(
        200,
        view(
          configured: pend,
          url: pend ? 'rtsp://10.168.1.20:554/main' : '',
          username: pend ? 'viewer' : null,
          hasPassword: pend,
          pending: pend,
          seq: pend ? 2 : 1,
        ),
      );
      h.handlers['PUT /api/live/camera'] = (r) async {
        puts.add(jsonDecode(r.body) as Map<String, dynamic>);
        pend = true;
        return jsonResponse(200, view(pending: true, seq: 2));
      };
      await go(tester, h);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.20:554/main');
      await _type(tester, 'camera-username', 'viewer');
      await _type(tester, 'camera-password', 'jauh123Rahsia');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);

      expect(puts, hasLength(1));
      expect(puts.single.keys.toSet(), {'boxId', 'seq', 'sealed'});
      expect(puts.single['boxId'], boxId);
      expect(puts.single['seq'], 1);
      final raw = jsonEncode(puts.single);
      for (final secret in ['jauh123Rahsia', 'viewer', '10.168.1.20', 'rtsp://']) {
        expect(raw, isNot(contains(secret)));
      }
      // only the box key opens it, and it holds what was typed
      final plain =
          jsonDecode(openCameraRelay(boxPrivateJwk: boxJwk, sealed: puts.single['sealed'] as String, aad: cameraRelayAad(boxId, 1)))
              as Map<String, dynamic>;
      expect(plain, {'seq': 1, 'boxId': boxId, 'url': 'rtsp://10.168.1.20:554/main', 'username': 'viewer', 'password': 'jauh123Rahsia'});

      await reveal(tester, k('camera-pending'));
      expect(find.text(pending), findsOneWidget);
      expect(screenText(tester), isNot(contains('jauh123Rahsia')));
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://10.168.1.20:554/main');
      expect(tester.widget<TextField>(k('camera-username')).controller!.text, 'viewer');
      expect(k('camera-password-dots'), findsOneWidget);
      expect(k('camera-password'), findsNothing);
    });

    testWidgets('the note clears by itself once the box has applied the change', (tester) async {
      final h = await openCloud(tester);
      var applied = false;
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(
        200,
        view(configured: true, url: 'rtsp://10.168.1.20:554/main', pending: !applied, seq: 2),
      );
      await go(tester, h);
      await reveal(tester, k('camera-pending'));
      expect(find.text(pending), findsOneWidget);
      applied = true;
      await tester.pump(const Duration(seconds: 16));
      await tester.pump();
      expect(k('camera-pending'), findsNothing);
      expect(k('camera-cloud-refused'), findsNothing);
    });

    testWidgets('a change the box refused says why, in words, from a fixed code', (tester) async {
      final h = await openCloud(tester);
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, view(failure: 'bad_address', seq: 2));
      await go(tester, h);
      await reveal(tester, k('camera-cloud-refused'));
      expect(find.textContaining('MAXCOM tidak menerima alamat itu'), findsOneWidget);
      expect(k('camera-pending'), findsNothing);
    });

    testWidgets('a number taken by another change: the phone reads again and seals again, once', (tester) async {
      final h = await openCloud(tester);
      var gets = 0;
      final puts = <Map<String, dynamic>>[];
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, view(seq: ++gets == 1 ? 1 : 2));
      h.handlers['PUT /api/live/camera'] = (r) async {
        puts.add(jsonDecode(r.body) as Map<String, dynamic>);
        if (puts.length == 1) return jsonResponse(409, {'errors': ['Tetapan kamera telah berubah. Cuba lagi.'], 'code': 'stale'});
        return jsonResponse(200, view(pending: true, seq: 3));
      };
      await go(tester, h);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.20:554/main');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(puts.map((p) => p['seq']), [1, 2]);
      await reveal(tester, k('camera-pending'));
    });

    testWidgets('no box linked to the cloud: the words say so and nothing is sent', (tester) async {
      final h = await openCloud(tester);
      var puts = 0;
      h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, view(relay: false));
      h.handlers['PUT /api/live/camera'] = (r) async {
        puts++;
        return jsonResponse(200, view());
      };
      await go(tester, h);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.20:554/main');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(puts, 0);
      expect(find.text('MAXCOM belum disambung ke awan, jadi kamera hanya boleh ditetapkan di Wi-Fi surau.'), findsOneWidget);
    });

    testWidgets('on the surau Wi-Fi the ONVIF search and the test are there and the note is not', (tester) async {
      await openForm(tester);
      expect(k('camera-discover'), findsOneWidget);
      expect(k('camera-test'), findsOneWidget);
      expect(k('camera-discover-surau-only'), findsNothing);
      expect(k('camera-pending'), findsNothing);
    });
  });

  group('O1: Cari kamera di rangkaian', () {
    void box(ShellHarness h, {List<Map<String, String>> cameras = const [], int fillStatus = 200, Map<String, Object?>? fillAnswer, int discoverStatus = 200}) {
      h.handlers['POST /api/live/camera/discover'] = (r) async => discoverStatus == 200
          ? jsonResponse(200, {'cameras': cameras})
          : jsonResponse(discoverStatus, {'errors': ['Terlalu banyak percubaan. Cuba sebentar lagi.'], 'code': 'too_many'});
      h.handlers['POST /api/live/camera/discover/fill'] = (r) async => jsonResponse(
        fillStatus,
        fillAnswer ?? {'url': 'rtsp://viewer:lihat123@10.168.1.20:554/main', 'masked': 'rtsp://viewer:$_dots@10.168.1.20:554/main'},
      );
    }

    Future<void> open(WidgetTester tester) async {
      await reveal(tester, k('camera-discover'));
      await tester.tap(k('camera-discover'));
      await settle(tester);
    }

    const two = [
      {'name': 'Kamera Dewan', 'ip': '10.168.1.20'},
      {'name': 'Pintu Utama', 'ip': '10.168.1.21'},
    ];

    testWidgets('the list shows name and address of each camera the box found', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      box(h, cameras: two);
      await open(tester);
      expect(k('camera-discover-sheet'), findsOneWidget);
      expect(find.text('Kamera di rangkaian surau'), findsOneWidget);
      expect(find.text('Kamera Dewan'), findsOneWidget);
      expect(find.text('10.168.1.20'), findsOneWidget);
      expect(find.text('Pintu Utama'), findsOneWidget);
      expect(find.text('10.168.1.21'), findsOneWidget);
      expect(h.box.seen.where((r) => r.method == 'POST' && r.url.path == '/api/live/camera/discover'), hasLength(1));
      await expectLater(find.byWidget(h.app), matchesGoldenFile('camera_discover_list_phone.png'));
    });

    testWidgets('nothing found: "Tiada kamera ditemui" with the advice, and Cari lagi asks again', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      box(h);
      await open(tester);
      expect(k('camera-discover-empty'), findsOneWidget);
      expect(find.text('Tiada kamera ditemui'), findsOneWidget);
      expect(find.textContaining('Pastikan kamera hidup dan ONVIF dihidupkan, atau tampal alamat RTSP.'), findsOneWidget);
      box(h, cameras: two);
      await tester.tap(k('camera-discover-again'));
      await settle(tester);
      expect(find.text('Kamera Dewan'), findsOneWidget);
    });

    testWidgets('the box refusing the search (too many) shows its own words', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      box(h, discoverStatus: 429);
      await open(tester);
      expect(find.text('Terlalu banyak percubaan. Cuba sebentar lagi.'), findsOneWidget);
    });

    testWidgets('tap a camera, enter the login: the address fills in, the login boxes stay empty, Simpan saves it and the password is dots', (tester) async {
      final (h, cam) = await openForm(tester, configured: false, name: '');
      box(h, cameras: two);
      await open(tester);
      await tester.tap(k('camera-discover-item-10.168.1.20'));
      await settle(tester);
      expect(k('camera-login-sheet'), findsOneWidget);
      expect(find.text('Log masuk kamera'), findsOneWidget);
      await tester.enterText(k('camera-login-user'), 'viewer');
      await tester.enterText(k('camera-login-pass'), 'lihat123');
      await tester.pump();
      await expectLater(find.byWidget(h.app), matchesGoldenFile('camera_discover_login_phone.png'));
      await tester.tap(k('camera-login-fill'));
      await settle(tester);
      final post = h.box.seen.where((r) => r.method == 'POST' && r.url.path == '/api/live/camera/discover/fill').single;
      expect(jsonDecode(post.body), {'ip': '10.168.1.20', 'username': 'viewer', 'password': 'lihat123'});
      expect(k('camera-login-sheet'), findsNothing);
      // the field shows the masked address; the full one is only in memory for Simpan
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://viewer:$_dots@10.168.1.20:554/main');
      expect(screenText(tester), isNot(contains('lihat123')));
      expect(tester.widget<TextField>(k('camera-username')).controller!.text, '');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single['url'], 'rtsp://viewer:lihat123@10.168.1.20:554/main');
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://viewer:$_dots@10.168.1.20:554/main');
      expect(screenText(tester), isNot(contains('lihat123')));
    });

    testWidgets('after a fill, an edit of the address wins over the held full address', (tester) async {
      final (h, cam) = await openForm(tester, configured: false, name: '');
      box(h, cameras: two);
      await open(tester);
      await tester.tap(k('camera-discover-item-10.168.1.20'));
      await settle(tester);
      await tester.enterText(k('camera-login-user'), 'viewer');
      await tester.enterText(k('camera-login-pass'), 'lihat123');
      await tester.tap(k('camera-login-fill'));
      await settle(tester);
      await _type(tester, 'camera-url', 'rtsp://10.168.1.99:554/lain');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts.single['url'], 'rtsp://10.168.1.99:554/lain');
      expect(screenText(tester), isNot(contains('lihat123')));
    });

    test('maskCameraUrl hides the password, keeps the rest, and leaves a path @ alone', () {
      expect(maskCameraUrl('rtsp://viewer:lihat123@10.168.1.20:554/main'), 'rtsp://viewer:$_dots@10.168.1.20:554/main');
      expect(maskCameraUrl('rtsp://10.168.1.20:554/main'), 'rtsp://10.168.1.20:554/main');
      expect(maskCameraUrl('rtsp://10.168.1.20/a@b:c'), 'rtsp://10.168.1.20/a@b:c');
      expect(maskCameraUrl('not an address'), 'not an address');
      expect(maskCameraUrl('rtsp://10.168.1.20:554/s?user=a&Password=rahsia&x=1'), 'rtsp://10.168.1.20:554/s?user=a&Password=$_dots&x=1');
      expect(maskCameraUrl('rtsp://u:p@10.168.1.20/s?PWD=abc&pass=d&passwd=e&pass='), 'rtsp://u:$_dots@10.168.1.20/s?PWD=$_dots&pass=$_dots&passwd=$_dots&pass=');
      expect(maskCameraUrl('rtsp://10.168.1.20/s?channel=1&stream=0'), 'rtsp://10.168.1.20/s?channel=1&stream=0');
    });

    testWidgets('a refused login: the box words stay in the sheet, the password box is emptied, the form is untouched', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      box(h, cameras: two, fillStatus: 422, fillAnswer: {'errors': ['Alamat tidak dapat diisi secara automatik. Semak nama pengguna dan kata laluan, pastikan ONVIF dihidupkan pada kamera, atau tampal alamat RTSP.'], 'code': 'login'});
      await open(tester);
      await tester.tap(k('camera-discover-item-10.168.1.21'));
      await settle(tester);
      await tester.enterText(k('camera-login-user'), 'viewer');
      await tester.enterText(k('camera-login-pass'), 'salah');
      await tester.tap(k('camera-login-fill'));
      await settle(tester);
      expect(k('camera-login-error'), findsOneWidget);
      expect(find.textContaining('Alamat tidak dapat diisi secara automatik'), findsOneWidget);
      expect(tester.widget<TextField>(k('camera-login-pass')).controller!.text, '');
      expect(k('camera-login-sheet'), findsOneWidget);
      await tester.tap(k('camera-login-back'));
      await settle(tester);
      expect(k('camera-discover-sheet'), findsOneWidget);
      await tester.tap(k('camera-discover-close'));
      await settle(tester);
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, '');
    });

    testWidgets('username_missing: the sheet shows the fixed BM sentence whatever the box text', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      box(h, cameras: two, fillStatus: 422, fillAnswer: {'errors': ['x'], 'code': 'username_missing'});
      await open(tester);
      await tester.tap(k('camera-discover-item-10.168.1.21'));
      await settle(tester);
      await tester.enterText(k('camera-login-pass'), 'rahsia');
      await tester.tap(k('camera-login-fill'));
      await settle(tester);
      expect(k('camera-login-error'), findsOneWidget);
      expect(find.text('Masukkan nama pengguna bersama kata laluan.'), findsOneWidget);
    });

    testWidgets('list-only mode (the switch off): choosing a camera only puts its address in the form', (tester) async {
      final ctl = CameraSourceController(() => null)..loading = false;
      addTearDown(ctl.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: CameraSourceCard(controller: ctl, enabled: true, name: 'x', transport: 'auto', onChanged: (_, _) {}, discoveryFill: false),
            ),
          ),
        ),
      );
      await tester.tap(k('camera-discover'));
      await tester.pump();
      // the controller has no box here: it keeps what is set
      ctl.found = const [DiscoveredCamera(name: 'Kamera Dewan', ip: '10.168.1.20')];
      ctl.notifyListeners();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(k('camera-discover-item-10.168.1.20'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(ctl.url.text, 'rtsp://10.168.1.20:554/');
      expect(k('camera-login-sheet'), findsNothing);
    });
  });

  group('a new address asks for the password again', () {
    const again = 'Masukkan kata laluan semula untuk alamat baharu';

    testWidgets('a changed host opens the password box without dots and Simpan sends nothing until it is filled', (tester) async {
      final (h, cam) = await openForm(tester);
      expect(k('camera-password-dots'), findsOneWidget);
      await _type(tester, 'camera-url', 'rtsp://siaran:$_dots@10.168.1.60:554/stream1');
      expect(k('camera-password-dots'), findsNothing);
      expect(k('camera-password'), findsOneWidget);
      expect(tester.widget<TextField>(k('camera-password')).controller!.text, isEmpty);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts, isEmpty, reason: 'nothing leaves the form without the password');
      expect(find.text(again), findsOneWidget);
      expect(h.box.seen.where((r) => r.method == 'PUT' && r.url.path == '/api/live/camera'), isEmpty);
    });

    testWidgets('a changed port or path asks too; the same address does not', (tester) async {
      await openForm(tester);
      await _type(tester, 'camera-url', 'rtsp://siaran:$_dots@10.168.1.50:8554/stream1');
      expect(k('camera-password'), findsOneWidget, reason: 'port');
      await _type(tester, 'camera-url', 'rtsp://siaran:$_dots@10.168.1.50:554/stream2');
      expect(k('camera-password'), findsOneWidget, reason: 'path');
      await _type(tester, 'camera-url', 'rtsp://siaran:$_dots@10.168.1.50:554/stream1');
      expect(k('camera-password-dots'), findsOneWidget, reason: 'back to the saved address');
    });

    testWidgets('a changed login name alone keeps the dots', (tester) async {
      await openForm(tester);
      await _type(tester, 'camera-username', 'lain');
      expect(k('camera-password-dots'), findsOneWidget);
    });

    testWidgets('with the password typed, the save carries the address without dots and the password', (tester) async {
      final (_, cam) = await openForm(tester);
      await _type(tester, 'camera-url', 'rtsp://siaran:$_dots@10.168.1.60:554/stream1');
      await _type(tester, 'camera-password', 'baharu2026');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(cam.puts, hasLength(1));
      expect(cam.puts.single['url'], 'rtsp://siaran@10.168.1.60:554/stream1');
      expect(cam.puts.single['password'], 'baharu2026');
      expect(cam.puts.single['url'], isNot(contains(_dots)));
    });

    testWidgets('the box refusing with password_again shows the same sentence under the password', (tester) async {
      final (h, _) = await openForm(tester);
      h.handlers['PUT /api/live/camera'] = (r) async =>
          jsonResponse(400, {'errors': ['Masukkan kata laluan semula.'], 'code': 'password_again'});
      // an edit the form does not see as a move: the same host, then the box still refuses
      await _type(tester, 'camera-username', 'lain');
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      expect(find.text(again), findsOneWidget);
      expect(k('camera-password'), findsOneWidget, reason: 'the box for the password is open after the refusal');
    });
  });
}
