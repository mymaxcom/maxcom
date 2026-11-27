import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/labels_cam.dart' show externalMixFailedMessage;
import 'package:surau_app/features/live/web_external_live.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';

LiveAudioMix mix({int camera = 100, bool mic = false, int micVol = 100}) =>
    LiveAudioMix(
      camera: AudioSourceMix(enabled: true, volume: camera),
      deviceMic: AudioSourceMix(enabled: mic, volume: micVol),
      boxInput: const AudioSourceMix(enabled: false, volume: 100),
    );

void main() {
  group('the box status of 4.7', () {
    test('rows, volumes, health and alignment are read', () {
      final rows = parseExternalAudio({
        'audio': {
          'sources': [
            {'id': 'camera', 'enabled': true, 'volume': 40, 'state': 'ok'},
            {
              'id': 'deviceMic',
              'enabled': true,
              'volume': 100,
              'state': 'silent',
              'align': {'state': 'locked', 'delayMs': 612, 'residualMs': 8},
            },
          ],
        },
      });
      expect(rows, hasLength(2));
      expect(rows[0].id, 'camera');
      expect(rows[0].volume, 40);
      expect(rows[0].isAdded, isFalse);
      expect(rows[0].alignState, isNull);
      expect(rows[1].isAdded, isTrue);
      expect(rows[1].state, 'silent');
      expect(rows[1].alignState, 'locked');
      expect(rows[1].delayMs, 612);
      expect(rows[1].residualMs, 8);
    });

    test('the level of each source is read (dBFS) and drawn as a 0 to 1 fill; an older box has none', () {
      final rows = parseExternalAudio({
        'audio': {
          'sources': [
            {'id': 'camera', 'enabled': true, 'volume': 40, 'state': 'ok', 'level': -30},
            {'id': 'deviceMic', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': -90.0},
            {'id': 'boxInput', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': 'loud'},
            {'id': 'x', 'enabled': true, 'volume': 100, 'state': 'ok', 'level': 5},
          ],
        },
      });
      expect(rows[0].levelDb, -30);
      expect(rows[0].levelFill, closeTo(0.5, 0.001));
      expect(rows[1].levelFill, 0);
      expect(rows[2].levelDb, isNull);
      expect(rows[2].levelFill, isNull);
      expect(rows[3].levelDb, 0); // never above full scale
      expect(rows[3].levelFill, 1);
    });

    test('an older box, or a malformed answer, gives no rows and no throw', () {
      expect(parseExternalAudio(<String, dynamic>{}), isEmpty);
      expect(parseExternalAudio(null), isEmpty);
      expect(parseExternalAudio({'audio': 'x'}), isEmpty);
      expect(
        parseExternalAudio({
          'audio': {
            'sources': [
              'x',
              {'enabled': true},
              {'id': 'camera', 'volume': 250},
            ],
          },
        }).single.volume,
        100,
      );
      expect(parseExternalWarnings({'warnings': ['a', 3, 'b']}), ['a', 'b']);
      expect(parseExternalWarnings(null), isEmpty);
    });
  });

  group('wording (BM, plan 4.7 and mockups 23, 24, 33, 35)', () {
    test('alignment chips: M1 words and M4 before the live', () {
      String chip(String? s, {bool started = true, bool lost = false}) =>
          externalAlignChip(alignState: s, started: started, micLost: lost);
      expect(chip('searching'), 'Sedang diselaraskan');
      expect(chip(null), 'Sedang diselaraskan');
      expect(chip('locked'), 'Selaras');
      expect(chip('holding'), 'Selaras');
      expect(chip('failed'), 'Belum selaras');
      expect(chip('manual'), 'Imbangan masa audio');
      expect(
        chip('locked', started: false),
        'Diselaraskan bila siaran bermula',
      );
      expect(chip('locked', lost: true), 'Diselaraskan semula bila kembali');
    });

    test('the delay note names the camera and says 1 to 2 seconds', () {
      final n = boxPullNote('Kamera Mimbar');
      expect(n, contains('Kamera Mimbar'));
      expect(n, contains('1 hingga 2 saat lewat'));
    });

    test('no em dash, en dash or arrow anywhere in the strings', () {
      final all = [
        boxPullNote('X'),
        externalControllerOnlyNote(),
        externalScreenLockNote(),
        externalRecordingFallback(),
        externalMicLostMessage(cameraAudible: true),
        externalMicLostMessage(cameraAudible: false),
        externalMicLostHint(),
        externalMicRefusedMessage(),
        externalAlignFailedMessage(cameraAudible: true),
        externalAlignFailedMessage(cameraAudible: false),
        externalUseMicOnlyAction(),
        externalCameraNoAudioWithMic(),
        externalCameraNoAudioAlone(),
        externalAllMutedMessage(),
        externalPreviewRetryMessage(),
      ];
      for (final s in all) {
        expect(s, isNot(matches(RegExp('[—–→≈]'))), reason: s);
      }
    });
  });

  group('the one notice, by priority', () {
    ({String message, String? hint, bool micOnlyAction})? notice({
      LiveAudioMix? m,
      ExternalMic mic = ExternalMic.ok,
      List<ExternalAudioSource> sources = const [],
      List<String> warnings = const [],
      bool cameraHasAudio = true,
      ExternalRecording recording = ExternalRecording.off,
      bool recordingAsked = true,
    }) {
      final mx = m ?? mix(mic: true);
      return externalNoticeFor(
        mix: mx,
        mic: mic,
        sources: sources,
        warnings: warnings,
        cameraHasAudio: cameraHasAudio,
        micInMix: mx.deviceMic.enabled,
        recording: recording,
        recordingAsked: recordingAsked,
      );
    }

    test('nothing to say on a healthy live', () {
      expect(notice(), isNull);
    });

    test('microphone lost beats everything, in both forms', () {
      final a = notice(mic: ExternalMic.lost, warnings: ['audio_all_muted'])!;
      expect(
        a.message,
        'Mikrofon iPad terputus. Siaran diteruskan dengan audio kamera.',
      );
      expect(a.hint, externalMicLostHint());
      final b = notice(m: mix(camera: 0, mic: true), mic: ExternalMic.lost)!;
      expect(
        b.message,
        'Mikrofon iPad terputus. Siaran diteruskan tanpa bunyi.',
      );
    });

    test('a lost mic that is not in the mix is not announced', () {
      expect(notice(m: mix(), mic: ExternalMic.lost), isNull);
    });

    test('audio_mix_failed warns that the box combiner failed, ahead of the other warnings', () {
      final a = notice(warnings: ['audio_mix_failed', 'audio_all_muted'])!;
      expect(a.message, externalMixFailedMessage(AppLang.ms));
      expect(
        externalMixFailedMessage(AppLang.ms),
        'Pencampur audio MAXCOM gagal. Siaran mungkin tiada gambar atau bunyi; cuba hentikan dan mulakan semula.',
      );
      expect(a.micOnlyAction, isFalse);
    });

    test('alignment failed: action only while the camera is audible', () {
      const failed = ExternalAudioSource(
        id: 'deviceMic',
        enabled: true,
        volume: 100,
        state: 'ok',
        alignState: 'failed',
      );
      final a = notice(sources: [failed])!;
      expect(a.micOnlyAction, isTrue);
      expect(a.message, startsWith('Penyelarasan automatik belum berjaya, jadi'));
      final b = notice(m: mix(camera: 0, mic: true), sources: [failed])!;
      expect(b.micOnlyAction, isFalse);
      expect(b.message, endsWith('tidak selari dengan gambar.'));
    });

    test('camera without audio, with and without a microphone', () {
      expect(
        notice(cameraHasAudio: false)!.message,
        externalCameraNoAudioWithMic(),
      );
      expect(
        notice(m: mix(), cameraHasAudio: false)!.message,
        externalCameraNoAudioAlone(),
      );
    });

    test('every volume at 0 is a warning', () {
      final m = LiveAudioMix(
        camera: const AudioSourceMix(enabled: true, volume: 0),
        deviceMic: const AudioSourceMix(enabled: true, volume: 0),
        boxInput: const AudioSourceMix(enabled: false, volume: 100),
      );
      expect(notice(m: m)!.message, externalAllMutedMessage());
    });

    test('recording unavailable is shown only when recording was asked', () {
      expect(
        notice(recording: ExternalRecording.unavailable)!.message,
        externalRecordingFallback(),
      );
      expect(
        notice(
          recording: ExternalRecording.unavailable,
          recordingAsked: false,
        ),
        isNull,
      );
    });
  });

  test('the fallback offset: 0 to 2000 ms, steps of 50', () {
    expect(clampExternalOffset(-10), 0);
    expect(clampExternalOffset(24), 0);
    expect(clampExternalOffset(26), 50);
    expect(clampExternalOffset(1234), 1250);
    expect(clampExternalOffset(99999), 2000);
  });
}
