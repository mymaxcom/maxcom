// The camera and audio-mix calls of the box gateway (plan 4.2, 4.3): paths,
// verbs, bodies, the masked answers, and the box's refusals reaching the caller.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import 'fakes.dart';

class _Reach implements ReachSink {
  BoxReach state = BoxReach.unknown;
  @override
  BoxReach get reach => state;
  @override
  void markUp(DateTime at) => state = state.up(at);
  @override
  void markDown(DateTime at) => state = state.failed(at);
}

const _masked = {
  'configured': true,
  'url': 'rtsp://siaran:••••••@10.168.1.50:554/stream1',
  'username': 'siaran',
  'hasPassword': true,
  'lastTest': {
    'code': 'ok',
    'ok': true,
    'at': '2026-11-17T10:00:00.000Z',
    'hasAudio': true,
    'codecs': ['H264', 'MPEG-4 Audio'],
    'transport': 'tcp',
  },
};

({FakeBox box, BoxGateway gateway}) _rig(Future<dynamic> Function(String method, String path, Map<String, dynamic>? body) answer) {
  final box = FakeBox((r) async {
    final body = r.body.isEmpty ? null : jsonDecode(r.body) as Map<String, dynamic>;
    final out = await answer(r.method, r.url.path, body);
    if (out is Map) return jsonResponse(200, out);
    return out as http.Response;
  });
  final gateway = BoxGateway(
    client: box.client(Uri.parse('https://127.0.0.1:8443')),
    token: 'tok-1',
    cache: ReadCache(),
    reach: _Reach(),
    now: () => DateTime.utc(2026, 11, 17, 10),
    onSessionExpired: () {},
  );
  return (box: box, gateway: gateway);
}

void main() {
  test('liveCamera reads the masked record: dots, hasPassword, the last test', () async {
    final rig = _rig((m, p, b) async => _masked);
    final r = await rig.gateway.liveCamera();
    expect(rig.box.seen.single.method, 'GET');
    expect(rig.box.seen.single.url.path, '/api/live/camera');
    expect(rig.box.seen.single.headers['authorization'], 'Bearer tok-1');
    expect(r.configured, isTrue);
    expect(r.url, contains('••••••'));
    expect(r.username, 'siaran');
    expect(r.hasPassword, isTrue);
    expect(r.lastTest!.ok, isTrue);
    expect(r.lastTest!.hasAudio, isTrue);
    expect(r.lastTest!.codecs, ['H264', 'MPEG-4 Audio']);
    expect(r.lastTest!.transport, 'tcp');
  });

  test('liveCamera on a box with no camera answers the empty record', () async {
    final rig = _rig((m, p, b) async => {'configured': false, 'url': '', 'username': null, 'hasPassword': false, 'lastTest': null});
    final r = await rig.gateway.liveCamera();
    expect(r.configured, isFalse);
    expect(r.url, '');
    expect(r.lastTest, isNull);
  });

  test('saveLiveCamera PUTs the address, the login and the password only when given', () async {
    final rig = _rig((m, p, b) async => _masked);
    await rig.gateway.saveLiveCamera(url: 'rtsp://10.168.1.50:554/stream1', username: 'siaran', password: 'rahsia-1');
    var r = rig.box.seen.last;
    expect(r.method, 'PUT');
    expect(r.url.path, '/api/live/camera');
    expect(jsonDecode(r.body), {'url': 'rtsp://10.168.1.50:554/stream1', 'username': 'siaran', 'password': 'rahsia-1'});

    // No password typed: it is not in the request, so the box keeps the stored one.
    final out = await rig.gateway.saveLiveCamera(url: 'rtsp://siaran:••••••@10.168.1.50:554/stream1');
    r = rig.box.seen.last;
    expect((jsonDecode(r.body) as Map).containsKey('password'), isFalse);
    expect((jsonDecode(r.body) as Map).containsKey('username'), isFalse);
    expect(out.hasPassword, isTrue);
  });

  test('a refused address reaches the caller as the box error with its code and words', () async {
    final rig = _rig((m, p, b) async => jsonResponse(400, {'errors': ['Alamat kamera tidak sah'], 'code': 'bad_address'}));
    await expectLater(
      rig.gateway.saveLiveCamera(url: 'http://x'),
      throwsA(isA<BoxError>().having((e) => e.code, 'code', 'bad_address').having((e) => e.message, 'message', 'Alamat kamera tidak sah')),
    );
  });

  test('the record carries the control opt-in; an older box without it reads as off', () async {
    var rig = _rig((m, p, b) async => {..._masked, 'control': {'enabled': true, 'protocol': 'visca'}});
    var r = await rig.gateway.liveCamera();
    expect(r.control.enabled, isTrue);
    expect(r.control.protocol, 'visca');
    expect(r.control.hasBrightness, isFalse);
    rig = _rig((m, p, b) async => _masked);
    r = await rig.gateway.liveCamera();
    expect(r.control.enabled, isFalse);
    expect(r.control.hasBrightness, isTrue);
  });

  test('setLiveCameraControl PUTs the opt-in and answers the masked record', () async {
    final rig = _rig((m, p, b) async => {..._masked, 'control': {'enabled': true, 'protocol': 'osc'}});
    final r = await rig.gateway.setLiveCameraControl(enabled: true);
    final seen = rig.box.seen.single;
    expect(seen.method, 'PUT');
    expect(seen.url.path, '/api/live/camera/control');
    expect(jsonDecode(seen.body), {'enabled': true});
    expect(r.control.enabled, isTrue);
  });

  test('controlLiveCamera POSTs one fixed action each and reads sent and confirmed', () async {
    final rig = _rig((m, p, b) async => {'sent': true, 'confirmed': b!['action'] == 'preset'});
    final g = rig.gateway;
    expect((await g.controlLiveCamera(exposure: -2.3)).confirmed, isFalse);
    expect((await g.controlLiveCamera(preset: 2)).confirmed, isTrue);
    await g.controlLiveCamera(resetPosition: true);
    await g.controlLiveCamera(aiTracking: false);
    expect(rig.box.seen.map((r) => r.url.path).toSet(), {'/api/live/camera/control'});
    expect(rig.box.seen.map((r) => r.method).toSet(), {'POST'});
    expect(rig.box.seen.map((r) => jsonDecode(r.body)).toList(), [
      {'action': 'exposure', 'ev': -2.3},
      {'action': 'preset', 'preset': 2},
      {'action': 'resetPosition'},
      {'action': 'aiTracking', 'on': false},
    ]);
  });

  test('the record carries the profile and the on-live switch, with defaults for a box that says nothing of them', () async {
    var rig = _rig(
      (m, p, b) async => {
        ..._masked,
        'control': {
          'enabled': true,
          'protocol': 'http',
          'profile': {'preset': 3, 'focus': 'manual', 'tracking': 'human', 'exposureEv': -1.5},
          'applyOnLive': true,
        },
      },
    );
    var r = await rig.gateway.liveCamera();
    expect(r.control.protocol, 'http');
    expect(r.control.profile.toJson(), {'preset': 3, 'focus': 'manual', 'tracking': 'human', 'exposureEv': -1.5});
    expect(r.control.applyOnLive, isTrue);
    rig = _rig((m, p, b) async => {..._masked, 'control': {'enabled': true, 'protocol': 'osc'}});
    r = await rig.gateway.liveCamera();
    expect(r.control.profile.toJson(), {'preset': 1, 'focus': 'continuous', 'tracking': 'off', 'exposureEv': 0.0});
    expect(r.control.applyOnLive, isFalse);
  });

  test('setLiveCameraControl sends only the fields given: the profile alone, the on-live switch alone', () async {
    final rig = _rig((m, p, b) async => {..._masked, 'control': {'enabled': true, 'protocol': 'http'}});
    await rig.gateway.setLiveCameraControl(profile: const LiveCameraProfile(preset: 2, focus: 'single', exposureEv: 0.5));
    await rig.gateway.setLiveCameraControl(applyOnLive: true);
    expect(rig.box.seen.map((r) => jsonDecode(r.body)).toList(), [
      {
        'profile': {'preset': 2, 'focus': 'single', 'tracking': 'off', 'exposureEv': 0.5},
      },
      {'applyOnLive': true},
    ]);
  });

  test('controlLiveCamera(applyProfile) POSTs the one fixed action and reads the steps', () async {
    final rig = _rig(
      (m, p, b) async => {
        'sent': true,
        'confirmed': false,
        'steps': [
          {'step': 'preset', 'sent': true, 'confirmed': true},
          {'step': 'exposure', 'sent': true, 'confirmed': false},
        ],
      },
    );
    final out = await rig.gateway.controlLiveCamera(applyProfile: true);
    expect(jsonDecode(rig.box.seen.single.body), {'action': 'applyProfile'});
    expect(out.steps.map((s) => '${s.step}:${s.confirmed}').toList(), ['preset:true', 'exposure:false']);
  });

  test('a camera control refusal (opt-in off) reaches the caller with its code', () async {
    final rig = _rig((m, p, b) async => jsonResponse(404, {'errors': ['x'], 'code': 'control_off'}));
    await expectLater(rig.gateway.controlLiveCamera(resetPosition: true), throwsA(isA<BoxError>().having((e) => e.code, 'code', 'control_off')));
  });

  test('clearLiveCamera sends DELETE /api/live/camera', () async {
    final rig = _rig((m, p, b) async => {'configured': false, 'url': '', 'username': null, 'hasPassword': false, 'lastTest': null});
    await rig.gateway.clearLiveCamera();
    expect(rig.box.seen.single.method, 'DELETE');
    expect(rig.box.seen.single.url.path, '/api/live/camera');
  });

  test('testLiveCamera POSTs the transport and reads the code, audio and codecs', () async {
    final rig = _rig(
      (m, p, b) async => {
        'code': 'ok',
        'ok': true,
        'at': '2026-11-17T10:00:00.000Z',
        'hasAudio': false,
        'codecs': ['H265'],
        'transport': 'udp',
        'message': 'Berjaya. MAXCOM menerima gambar dari kamera.',
      },
    );
    final t = await rig.gateway.testLiveCamera(transport: 'udp');
    final r = rig.box.seen.single;
    expect(r.method, 'POST');
    expect(r.url.path, '/api/live/camera/test');
    expect(jsonDecode(r.body), {'transport': 'udp'});
    expect(t.code, 'ok');
    expect(t.hasAudio, isFalse);
    expect(t.codecs, ['H265']);
    expect(t.transport, 'udp');
    expect(t.message, startsWith('Berjaya'));

    await rig.gateway.testLiveCamera();
    expect(jsonDecode(rig.box.seen.last.body), <String, dynamic>{});
  });

  test('a test refused while a live runs, or too often, is a box error with its code', () async {
    final busy = _rig((m, p, b) async => jsonResponse(409, {'errors': ['Siaran sedang berjalan.'], 'code': 'live_busy'}));
    await expectLater(busy.gateway.testLiveCamera(), throwsA(isA<BoxError>().having((e) => e.code, 'code', 'live_busy')));
    final many = _rig((m, p, b) async => jsonResponse(429, {'errors': ['Terlalu banyak percubaan.'], 'code': 'too_many'}, headers: {'retry-after': '30'}));
    await expectLater(many.gateway.testLiveCamera(), throwsA(isA<BoxError>().having((e) => e.status, 'status', 429)));
  });

  test('liveCameraSource reads the full address (live:control), uncached', () async {
    final rig = _rig((m, p, b) async => {'url': 'rtsp://siaran:rahsia-1@10.168.1.50:554/stream1'});
    final url = await rig.gateway.liveCameraSource();
    expect(url, 'rtsp://siaran:rahsia-1@10.168.1.50:554/stream1');
    expect(rig.box.seen.single.method, 'GET');
    expect(rig.box.seen.single.url.path, '/api/live/camera/source');
    // never served from the read cache a second time
    await rig.gateway.liveCameraSource();
    expect(rig.box.seen, hasLength(2));
  });

  test('changeLiveAudio adds video and avOffsetMs to the body only when given', () async {
    final rig = _rig((m, p, b) async => {'ok': true});
    const mix = LiveAudioMix(
      camera: AudioSourceMix(enabled: true, volume: 40),
      deviceMic: AudioSourceMix(enabled: true, volume: 100),
      boxInput: AudioSourceMix(enabled: false, volume: 100),
    );
    await rig.gateway.changeLiveAudio(mix, video: 'phone', avOffsetMs: 350);
    final body = jsonDecode(rig.box.seen.single.body) as Map<String, dynamic>;
    expect(body['video'], 'phone');
    expect(body['avOffsetMs'], 350);
    expect(body['audio'], isA<Map<String, dynamic>>());
    await rig.gateway.changeLiveAudio(mix);
    final plain = jsonDecode(rig.box.seen.last.body) as Map<String, dynamic>;
    expect(plain.keys, ['audio']);
  });

  test('changeLiveAudio POSTs the mix to /api/live/audio', () async {
    final rig = _rig((m, p, b) async => {'ok': true});
    await rig.gateway.changeLiveAudio(
      const LiveAudioMix(
        camera: AudioSourceMix(enabled: true, volume: 40),
        deviceMic: AudioSourceMix(enabled: true, volume: 100),
        boxInput: AudioSourceMix(enabled: false, volume: 100),
      ),
    );
    final r = rig.box.seen.single;
    expect(r.method, 'POST');
    expect(r.url.path, '/api/live/audio');
    expect(jsonDecode(r.body), {
      'audio': {
        'camera': {'enabled': true, 'volume': 40},
        'deviceMic': {'enabled': true, 'volume': 100},
        'boxInput': {'enabled': false, 'volume': 100},
      },
    });
  });

  test('discoverLiveCameras posts to discover and reads name + address; fillDiscoveredCamera posts ip and login', () async {
    final rig = _rig((m, p, b) async {
      if (p == '/api/live/camera/discover') {
        return {
          'cameras': [
            {'name': 'Kamera Dewan', 'ip': '10.168.1.20'},
            {'ip': '10.168.1.21'},
            {'name': 'x'},
          ],
        };
      }
      return {'url': 'rtsp://viewer:lihat123@10.168.1.20:554/main', 'masked': 'rtsp://viewer:******@10.168.1.20:554/main'};
    });
    final found = await rig.gateway.discoverLiveCameras();
    expect(found.map((c) => '${c.name}|${c.ip}'), ['Kamera Dewan|10.168.1.20', '|10.168.1.21']);
    final url = await rig.gateway.fillDiscoveredCamera(ip: '10.168.1.20', username: 'viewer', password: 'lihat123');
    expect(url, 'rtsp://viewer:lihat123@10.168.1.20:554/main');
    final fill = rig.box.seen.where((r) => r.url.path == '/api/live/camera/discover/fill').single;
    expect(fill.method, 'POST');
    expect(jsonDecode(fill.body), {'ip': '10.168.1.20', 'username': 'viewer', 'password': 'lihat123'});
  });

  test('a refused fill reaches the caller as a BoxError with the box code and words', () async {
    final rig = _rig((m, p, b) async => jsonResponse(422, {'errors': ['Alamat tidak dapat diisi secara automatik.'], 'code': 'login'}));
    await expectLater(
      rig.gateway.fillDiscoveredCamera(ip: '10.168.1.20'),
      throwsA(isA<BoxError>().having((e) => e.code, 'code', 'login').having((e) => e.status, 'status', 422)),
    );
  });

  test('a box that does not answer is BoxUnreachable', () async {
    final box = FakeBox((r) async => throw Exception('down'));
    final gateway = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: ReadCache(),
      reach: _Reach(),
      now: () => DateTime.utc(2026, 11, 17, 10),
      onSessionExpired: () {},
    );
    await expectLater(gateway.liveCamera(), throwsA(isA<BoxUnreachable>()));
  });
}
