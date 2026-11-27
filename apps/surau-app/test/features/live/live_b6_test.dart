// 2026.11.15 build 6 in the app: one sound only (the pure mix rules), the new status fields of the box and the three
// warning codes the live screen turns into notices.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';

AudioSourceMix _m(bool on, [int v = 100]) => AudioSourceMix(enabled: on, volume: v);

LiveAudioMix _mix({bool cam = false, int camVol = 100, bool mic = false, int micVol = 100, bool box = false, int boxVol = 100}) =>
    LiveAudioMix(camera: _m(cam, camVol), deviceMic: _m(mic, micVol), boxInput: _m(box, boxVol));

List<String> _on(LiveAudioMix m) => [for (final id in [idCamera, idDeviceMic, idBoxInput]) if (mixOf(m, id).enabled) id];

void main() {
  group('one sound only', () {
    test('soloMix keeps the box microphone over the camera when both are on', () {
      final s = soloMix(_mix(cam: true, box: true));
      expect(_on(s), [idBoxInput]);
    });

    test('soloMix honours prefer', () {
      final s = soloMix(_mix(cam: true, box: true), prefer: idCamera);
      expect(_on(s), [idCamera]);
    });

    test('a zero volume source loses to an audible one', () {
      final s = soloMix(_mix(cam: true, camVol: 80, box: true, boxVol: 0));
      expect(_on(s), [idCamera]);
    });

    test('none on stays none and volumes are left alone', () {
      final s = soloMix(_mix(camVol: 40, micVol: 60));
      expect(_on(s), isEmpty);
      expect(s.camera.volume, 40);
      expect(s.deviceMic.volume, 60);
    });

    test('turnOn: that source at its last volume (100 when it was 0), every other one off', () {
      final a = turnOn(_mix(cam: true, camVol: 70, box: false, boxVol: 55), idBoxInput);
      expect(_on(a), [idBoxInput]);
      expect(a.boxInput.volume, 55);
      expect(a.camera.volume, 70);
      final b = turnOn(_mix(cam: true, box: false, boxVol: 0), idBoxInput);
      expect(b.boxInput.volume, 100);
    });

    test('soundOn is the enabled source above 0', () {
      expect(soundOn(_mix(cam: true, camVol: 0)), isNull);
      expect(soundOn(_mix(mic: true)), idDeviceMic);
    });
  });

  group('the status of build 6', () {
    Map<String, dynamic> status(Map<String, Object?> relay, [List<String> warnings = const []]) => {
      'session': {'id': 's1'},
      'relay': relay,
      'warnings': warnings,
      'ingest': {'ready': true},
      'youtube': {'signedIn': true},
    };

    test('the relay fields are parsed', () {
      final d = LiveStatusDto.fromJson(status({'state': 'running', 'restarts': 3, 'behindSeconds': 7.6, 'quality': 'low'}));
      expect(d.relayRestarts, 3);
      expect(d.relayBehindSeconds, 8);
      expect(d.relayQuality, 'low');
    });

    test('a box of build 5 sends none of them', () {
      final d = LiveStatusDto.fromJson(status({'state': 'running'}));
      expect(d.relayRestarts, 0);
      expect(d.relayBehindSeconds, isNull);
      expect(d.relayQuality, isNull);
    });

    test('an unknown quality word is dropped', () {
      expect(LiveStatusDto.fromJson(status({'state': 'running', 'quality': 'ultra'})).relayQuality, isNull);
    });

    test('the three warning codes drive the three getters', () {
      const none = LiveBoxStatus();
      expect(none.boxMicDrops || none.uploadBehind || none.qualityLowered, isFalse);
      final all = none.copyWith(warnings: {boxMicDropsWarning, uploadBehindWarning, qualityLoweredWarning});
      expect(all.boxMicDrops, isTrue);
      expect(all.uploadBehind, isTrue);
      expect(all.qualityLowered, isTrue);
      expect(boxMicDropsWarning, 'box_mic_drops');
      expect(uploadBehindWarning, 'upload_behind');
      expect(qualityLoweredWarning, 'quality_lowered');
    });
  });
}
