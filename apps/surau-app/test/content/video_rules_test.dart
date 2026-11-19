// The phone's rules for a Video item: limits equal to core's, the YouTube link reader, the clip clock, the MP4
// reader (against a synthetic file built here) and the checks between fields.

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/kinds.dart';
import 'package:surau_app/content/video_rules.dart';
import 'package:surau_app/l10n/s_lookup.dart';

import '../support/mp4.dart';

RangeReader readerOf(Uint8List b) => (start, length) async => b.sublist(start, (start + length).clamp(0, b.length));

void main() {
  test('the limits are the ones in core (one constant each)', () {
    final core = File('../../packages/core/src/content/video.ts').readAsStringSync();
    int pick(String key) {
      final m = RegExp('$key: ([0-9 *]+),').firstMatch(core)!;
      return m.group(1)!.split('*').map((x) => int.parse(x.trim())).fold<int>(1, (a, b) => a * b);
    }
    expect(kVideoMaxHeight, pick('maxHeight'));
    expect(kVideoMaxSeconds, pick('maxSeconds'));
    expect(kVideoMaxFileBytes, pick('maxFileBytes'));
    expect(kVideoTotalBytes, pick('totalBytes'));
    expect(kVideoMinFreeBytes, pick('minFreeBytes'));
  });

  group('parseYoutubeId', () {
    const id = 'dQw4w9WgXcQ';
    for (final input in [
      id,
      'https://www.youtube.com/watch?v=$id',
      'https://youtu.be/$id?t=5',
      'https://m.youtube.com/watch?v=$id&list=PL1',
      'https://www.youtube.com/shorts/$id',
      'https://www.youtube-nocookie.com/embed/$id',
      'youtube.com/live/$id?feature=share',
      '  https://youtu.be/$id  ',
    ]) {
      test('reads $input', () => expect(parseYoutubeId(input), id));
    }
    for (final input in ['', 'hello', 'https://example.com/watch?v=$id', 'https://www.youtube.com/playlist?list=PL1', 'javascript:alert(1)', 'https://youtu.be/short']) {
      test('refuses "$input"', () => expect(parseYoutubeId(input), isNull));
    }
    test('names a live link', () {
      expect(isYoutubeLiveLink('https://www.youtube.com/live/dQw4w9WgXcQ'), isTrue);
      expect(isYoutubeLiveLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), isFalse);
    });
  });

  test('the clip clock reads and writes minutes and seconds', () {
    expect(parseClock('12:30'), 750);
    expect(parseClock('1:05:00'), 3900);
    expect(parseClock('90'), 90);
    expect(parseClock('1:75'), isNull);
    expect(parseClock('abc'), isNull);
    expect(parseClock(''), isNull);
    expect(clockOf(750), '12:30');
    expect(clockOf(3900), '1:05:00');
    expect(clockOf(5), '0:05');
  });

  test('sizes read in MB and GB', () {
    expect(sizeText(300 * 1024 * 1024), '300 MB');
    expect(sizeText(1024 * 1024 * 1024), '1.0 GB');
    expect(sizeText(2048), '2 KB');
  });

  group('readMp4Facts', () {
    test('reads codec, size and length, with the movie box first or last', () async {
      for (final last in [false, true]) {
        final b = mp4(seconds: 42.5, moovLast: last);
        final f = (await readMp4Facts(readerOf(b), b.length))!;
        expect([f.codec, f.width, f.height, f.durationSec], ['avc1', 1280, 720, 42.5]);
        expect(f.isH264, isTrue);
      }
    });
    test('is null for anything that is not an MP4', () async {
      final junk = Uint8List.fromList('this is not a video at all'.codeUnits);
      expect(await readMp4Facts(readerOf(junk), junk.length), isNull);
      expect(await readMp4Facts(readerOf(Uint8List(0)), 0), isNull);
    });
    test('judges the files', () async {
      Future<VideoProblem?> problem(Uint8List b) async => videoProblemOf(await readMp4Facts(readerOf(b), b.length), b.length);
      expect(await problem(mp4()), isNull);
      expect(await problem(mp4(width: 720, height: 1280)), isNull);
      expect(await problem(mp4(codec: 'hvc1')), VideoProblem.notH264);
      expect(await problem(mp4(width: 1920, height: 1080)), VideoProblem.tooBig);
      expect(await problem(mp4(seconds: 700)), VideoProblem.tooLong);
      expect(videoProblemOf(const Mp4Facts(codec: 'avc1', width: 1280, height: 720, durationSec: 30), kVideoMaxFileBytes + 1), VideoProblem.tooBig);
    });
  });

  group('video item rules', () {
    final s = sBm;
    const asset = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    final base = {'title': 'Salam', 'days': ['umum'], 'order': 1};
    bool ok(Map<String, Object?> m) => validateContent('video', {...base, ...m}, s: s).ok;

    test('accepts an upload, a YouTube video and a recording clip', () {
      expect(ok({'source': 'upload', 'assetId': asset.substring(0, 64), 'durationSec': 90}), isTrue);
      expect(ok({'source': 'youtube', 'youtubeId': 'dQw4w9WgXcQ', 'sound': true}), isTrue);
      expect(ok({'source': 'rakaman', 'youtubeId': 'dQw4w9WgXcQ', 'startSec': 10, 'endSec': 70}), isTrue);
    });
    test('refuses what core refuses', () {
      expect(ok({'source': 'upload'}), isFalse);
      expect(ok({'source': 'upload', 'assetId': 'xyz'}), isFalse);
      expect(ok({'source': 'upload', 'assetId': asset.substring(0, 64), 'youtubeId': 'dQw4w9WgXcQ'}), isFalse);
      expect(ok({'source': 'youtube', 'youtubeId': 'short'}), isFalse);
      expect(ok({'source': 'youtube'}), isFalse);
      expect(ok({'source': 'youtube', 'youtubeId': 'dQw4w9WgXcQ', 'startSec': 5}), isFalse);
      expect(ok({'source': 'rakaman', 'youtubeId': 'dQw4w9WgXcQ', 'startSec': 70, 'endSec': 10}), isFalse);
      expect(ok({'source': 'rakaman', 'youtubeId': 'dQw4w9WgXcQ', 'startSec': 0, 'endSec': 601}), isFalse);
      expect(ok({'source': 'upload', 'assetId': asset.substring(0, 64), 'durationSec': 601}), isFalse);
      expect(ok({'source': 'tv'}), isFalse);
      expect(ok({'source': 'youtube', 'youtubeId': 'dQw4w9WgXcQ', 'extra': 1}), isFalse);
    });
  });
}
