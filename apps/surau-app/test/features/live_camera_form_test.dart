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
import 'package:surau_app/features/settings_widgets/camera_source_card.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart' show DiscoveredCamera;

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
  final List<Map<String, dynamic>> puts = [];
  int deletes = 0;
  final List<Map<String, dynamic>> tests = [];

  /// The next test answer; null plays the default success.
  Map<String, Object?>? testAnswer;
  int testStatus = 200;

  /// When set, the test waits for it.
  Completer<void>? testGate;

  Map<String, Object?> masked() => {
    'configured': url.isNotEmpty,
    'url': url.isEmpty || password == null || password!.isEmpty ? url : url.replaceFirst('rtsp://', 'rtsp://${username ?? ''}:$_dots@'),
    'username': username,
    'hasPassword': password != null && password!.isNotEmpty,
    'lastTest': lastTest,
  };
}

Map<String, Object?> _okTest({bool audio = true}) => {
  'code': 'ok',
  'ok': true,
  'at': '2026-11-17T10:05:00.000Z',
  'hasAudio': audio,
  'codecs': audio ? ['H264', 'MPEG-4 Audio'] : ['H264'],
  'transport': 'tcp',
  'message': 'Berjaya. Kotak menerima gambar dari kamera.',
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
}) async {
  final cam = _Cam(configured: configured);
  final h = await pumpShell(tester, roles: roles);
  h.settings['liveCamera'] = {'enabled': enabled, 'name': name, 'transport': transport};
  h.container.invalidate(settingsProvider);
  await settle(tester);
  h.handlers['GET /api/live/camera'] = (r) async => jsonResponse(200, cam.masked());
  h.handlers['PUT /api/live/camera'] = (r) async {
    final b = jsonDecode(r.body) as Map<String, dynamic>;
    cam.puts.add(b);
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
      expect(find.text('Guna kamera luaran'), findsOneWidget);
      expect(find.text('Dipaparkan sebagai pilihan sebelum siaran'), findsOneWidget);
      expect((tester.widget<TextField>(k('camera-name')).controller!.text), 'Kamera Mimbar');
      // The address as the box answered it: password as dots, not the password.
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, 'rtsp://siaran:$_dots@10.168.1.50:554/stream1');
      expect(tester.widget<TextField>(k('camera-username')).controller!.text, 'siaran');
      expect(k('camera-password-dots'), findsOneWidget);
      expect(k('camera-password'), findsNothing);
      expect(find.text('Tukar kata laluan'), findsOneWidget);
      expect(find.text('Disimpan bersulit di kotak MAXCOM dan sandaran awan. Tidak dipaparkan semula.'), findsOneWidget);
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
      expect(find.text('Telefon atau kotak yang menarik video mesti berada pada Wi-Fi surau yang sama dengan kamera. Internet tidak diperlukan untuk siaran ke skrin surau.'), findsOneWidget);
      expect(find.textContaining('kotak'), findsWidgets, reason: 'the camera texts of the mockups say "kotak MAXCOM"');
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

    testWidgets('Pengangkutan sits inside Lanjutan: Automatik, TCP, UDP; the choice is saved with the settings', (tester) async {
      final (h, _) = await openForm(tester);
      await reveal(tester, k('camera-lanjutan'));
      await tester.tap(k('camera-lanjutan'));
      await settle(tester);
      expect(find.text('Automatik'), findsOneWidget);
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

  group('mockup 08: the first time', () {
    testWidgets('empty fields with hints, the audio line says it is not known yet, the password box is open', (tester) async {
      final (h, _) = await openForm(tester, configured: false, name: '');
      expect(tester.widget<TextField>(k('camera-url')).controller!.text, '');
      expect(find.text('Contoh: Kamera Mimbar'), findsOneWidget);
      expect(find.text('rtsp://10.168.1.50:554/stream1'), findsOneWidget);
      expect(find.text('Kosongkan jika ada dalam alamat'), findsNWidgets(2));
      expect(k('camera-password'), findsOneWidget);
      expect(find.text('Disimpan bersulit di kotak MAXCOM dan sandaran awan.'), findsOneWidget);
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
      expect(find.text('Hidupkan untuk menyiarkan kuliah dari kamera IP yang dipasang di surau.'), findsOneWidget);
    });

    testWidgets('a camera never set up has nothing to delete', (tester) async {
      await openForm(tester, enabled: false, configured: false);
      expect(k('camera-delete'), findsNothing);
      expect(find.text('Hidupkan untuk menyiarkan kuliah dari kamera IP yang dipasang di surau.'), findsOneWidget);
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
      expect(find.text('Kotak MAXCOM sedang menyambung ke kamera'), findsOneWidget);
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
      expect(find.text('Berjaya. Kotak menerima gambar dari kamera.'), findsOneWidget);
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
      ('12', 'unreachable', 'Gagal: kamera tidak dapat dihubungi', 'Kotak tidak mendapat jawapan dari 10.168.1.50.', 'camera_test_unreachable'),
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

  group('who sees it', () {
    for (final role in ['ajk', 'media', 'treasurer']) {
      testWidgets('$role does not: the page is not found, nothing is asked of the camera route', (tester) async {
        final (h, cam) = await openForm(tester, roles: [role]);
        expect(k('camera-card'), findsNothing);
        expect(k('camera-url'), findsNothing);
        expect(find.text('Tiada kebenaran untuk tindakan ini'), findsNothing);
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
