// The live stream notice text (Task L1): the three binding sentences, the
// kitab word, the night slots, the dropped clauses, the one link.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/live/live_notice.dart';

const _id = 'AAAAAAAAAAA';
const _link = 'https://www.youtube.com/live/AAAAAAAAAAA';

// 2026-11-18 17:00, a Wednesday afternoon.
final _now = DateTime(2026, 11, 18, 17, 0);

LiveNoticeInput _full({
  String? slot = 'maghrib',
  DateTime? start,
  String? label = 'Kuliah Maghrib',
  String? speaker = 'Ustaz Ahmad',
  String? kitab = 'Kitab Contoh',
  String? topic = 'Tajuk Contoh',
}) => LiveNoticeInput(
  videoId: _id,
  slot: slot,
  label: label,
  start: start ?? DateTime(2026, 11, 18, 19, 30),
  speaker: speaker,
  kitab: kitab,
  topic: topic,
  surau: 'Surau Perintis Contoh',
);

String _text(LiveNoticeInput i, AppLang l, [DateTime? now]) => liveNoticeText(i, l, now ?? _now)!;

List<String> _lines(String t) => t.split('\n');

void _clean(String t, {String? reason}) {
  expect(t.contains('  '), isFalse, reason: 'double space in: $t');
  expect(t.contains('youtu.be'), isFalse, reason: reason);
  final links = _lines(t).where((l) => l.startsWith('https://')).toList();
  expect(links, [_link], reason: 'exactly one link line in: $t');
  expect(t.split('https://').length, 2, reason: 'one link only in: $t');
}

void main() {
  group('[W22-2] the notice names the surau and bolds the penceramah and the title', () {
    test('[W22-2] BM: the four lines, character for character', () {
      expect(
        _text(_full(), AppLang.ms),
        "Assalamu'alaikum warahmatullah.\n"
        'Ikuti *Kuliah Maghrib* di *Surau Perintis Contoh* bersama *Ustaz Ahmad*.\n'
        'Tajuk: *Tajuk Contoh*\n'
        '$_link',
      );
    });

    test('[W22-2] EN: the four lines, character for character', () {
      expect(
        _text(_full(), AppLang.en),
        "Assalamu'alaikum warahmatullah.\n"
        'Join *Maghrib Talk* at *Surau Perintis Contoh* with *Ustaz Ahmad*.\n'
        'Title: *Tajuk Contoh*\n'
        '$_link',
      );
    });

    test('[W22-2] AR: the four lines, Latin names stay as typed inside the bold marks', () {
      expect(
        _text(_full(), AppLang.ar),
        'السلام عليكم ورحمة الله.\n'
        'تابعوا *درس المغرب* في *Surau Perintis Contoh* مع *Ustaz Ahmad*.\n'
        'الموضوع: *Tajuk Contoh*\n'
        '$_link',
      );
    });

    test('[W22-2] the title is the topic, then the kitab when there is no topic', () {
      expect(_text(_full(topic: null), AppLang.ms), contains('Tajuk: *Kitab Contoh*'));
      expect(_text(_full(kitab: null), AppLang.ms), contains('Tajuk: *Tajuk Contoh*'));
      expect(_text(_full(), AppLang.ms), isNot(contains('Kitab Contoh')));
    });

    test('[W22-2] a slot outside the five uses the label, then the plain word', () {
      final dhuha = _full(slot: 'lain', label: 'Kuliah Dhuha');
      expect(_text(dhuha, AppLang.ms), contains('Ikuti *Kuliah Dhuha* di'));
      expect(_text(dhuha, AppLang.en), contains('Join *Kuliah Dhuha* at'));
      expect(_text(dhuha, AppLang.ar), contains('تابعوا *Kuliah Dhuha* في'));
      final none = _full(slot: 'lain', label: null);
      expect(_text(none, AppLang.ms), contains('Ikuti *Kuliah* di'));
      expect(_text(none, AppLang.en), contains('Join *Talk* at'));
      expect(_text(none, AppLang.ar), contains('تابعوا *الدرس* في'));
    });

    test('[W22-2] every standard slot has its own name in the three languages', () {
      final names = {
        'subuh': ('Kuliah Subuh', 'Subuh Talk', 'درس الفجر'),
        'zohor': ('Kuliah Zohor', 'Zohor Talk', 'درس الظهر'),
        'asar': ('Kuliah Asar', 'Asar Talk', 'درس العصر'),
        'maghrib': ('Kuliah Maghrib', 'Maghrib Talk', 'درس المغرب'),
        'isyak': ('Kuliah Isyak', 'Isyak Talk', 'درس العشاء'),
      };
      names.forEach((slot, n) {
        final i = _full(slot: slot);
        expect(_text(i, AppLang.ms), contains('*${n.$1}*'));
        expect(_text(i, AppLang.en), contains('*${n.$2}*'));
        expect(_text(i, AppLang.ar), contains('*${n.$3}*'));
      });
    });
  });

  group('[W22-2] a missing piece is left out cleanly', () {
    test('[W22-2] no speaker, no surau, no title: no empty bold, no double space, link last', () {
      for (final lang in AppLang.values) {
        final noSpeaker = _text(_full(speaker: null), lang);
        _clean(noSpeaker);
        expect(noSpeaker, isNot(contains('Ustaz')));
        expect(noSpeaker, isNot(contains('**')));
        expect(_lines(noSpeaker).length, 4);

        final noTitle = _text(_full(kitab: null, topic: null), lang);
        _clean(noTitle);
        expect(noTitle, isNot(contains('Tajuk Contoh')));
        expect(_lines(noTitle).length, 3);

        final noSurau = _text(
          LiveNoticeInput(videoId: _id, slot: 'maghrib', speaker: 'Ustaz Ahmad', topic: 'Tajuk Contoh'),
          lang,
        );
        _clean(noSurau);
        expect(noSurau, isNot(contains('**')));
        expect(noSurau, isNot(contains('Surau')));

        final bare = _text(_full(speaker: null, kitab: null, topic: null), lang);
        _clean(bare);
        expect(bare, isNot(contains('**')));
        expect(_lines(bare).length, 3);
        expect(_lines(bare).last, _link);
      }
      expect(
        _text(_full(speaker: null, kitab: null, topic: null), AppLang.ms),
        "Assalamu'alaikum warahmatullah.\nIkuti *Kuliah Maghrib* di *Surau Perintis Contoh*.\n$_link",
      );
      expect(
        _text(LiveNoticeInput(videoId: _id, slot: 'maghrib', speaker: 'Ustaz Ahmad'), AppLang.en),
        "Assalamu'alaikum warahmatullah.\nJoin *Maghrib Talk* with *Ustaz Ahmad*.\n$_link",
      );
    });

    test('[W22-2] blank fields count as missing', () {
      final t = _text(_full(speaker: '   ', topic: ' *** ', kitab: ''), AppLang.ms);
      expect(t, isNot(contains('**')));
      expect(t, isNot(contains('Tajuk:')));
      expect(t, isNot(contains('bersama')));
    });

    test('[W22-2] no kuliah chosen gives the surau sentence, and without a surau the plain one', () {
      const none = LiveNoticeInput(videoId: _id, surau: 'Surau Perintis Contoh');
      expect(
        _text(none, AppLang.ms),
        "Assalamu'alaikum warahmatullah.\nIkuti siaran langsung di *Surau Perintis Contoh*.\n$_link",
      );
      expect(_text(none, AppLang.en), contains('Join the live stream at *Surau Perintis Contoh*.'));
      expect(_text(none, AppLang.ar), contains('تابعوا البث المباشر في *Surau Perintis Contoh*.'));
      const noName = LiveNoticeInput(videoId: _id);
      expect(_text(noName, AppLang.ms), "Assalamu'alaikum warahmatullah.\nIkuti siaran langsung.\n$_link");
      expect(_text(noName, AppLang.en), contains('Join the live stream.\n'));
      for (final lang in AppLang.values) {
        _clean(_text(none, lang));
        _clean(_text(noName, lang));
      }
    });
  });

  group('[W22-2] asterisks in a name cannot break the bold', () {
    test('[W22-2] an asterisk typed in any field is removed', () {
      final i = _full(
        speaker: 'Ustaz *Ahmad*',
        topic: 'Tajuk *Contoh',
        label: 'Kuliah* Maghrib',
        slot: 'lain',
      );
      final t = _text(i, AppLang.ms);
      expect(t, contains('bersama *Ustaz Ahmad*.'));
      expect(t, contains('Tajuk: *Tajuk Contoh*'));
      expect(t, contains('Ikuti *Kuliah Maghrib* di'));
      // exactly the bold marks the builder put: 3 on line 2 pairs and 1 on the title
      final stars = RegExp(r'\*').allMatches(t).length;
      expect(stars, 8);
    });

    test('[W22-2] the surau name with an asterisk is cleaned too', () {
      const i = LiveNoticeInput(videoId: _id, surau: '**Surau Contoh*');
      expect(_text(i, AppLang.en), contains('at *Surau Contoh*.'));
    });
  });

  group('[PP-L1] only the public watch link', () {
    test('[PP-L1] every variant has exactly one link line of the form youtube.com/live/<11 chars>', () {
      final variants = <String>[];
      for (final lang in AppLang.values) {
        for (final slot in ['subuh', 'zohor', 'asar', 'maghrib', 'isyak', 'lain']) {
          for (final start in [DateTime(2026, 11, 18, 6, 0), DateTime(2026, 11, 19, 14, 0), DateTime(2026, 12, 1, 20, 0)]) {
            for (final kitab in ['Kitab Contoh', 'Contoh Fiqh', null]) {
              variants.add(_text(_full(slot: slot, start: start, kitab: kitab), lang));
            }
          }
        }
        variants.add(_text(const LiveNoticeInput(videoId: _id), lang));
      }
      expect(variants.length, greaterThan(100));
      final form = RegExp(r'^https://www\.youtube\.com/live/[A-Za-z0-9_-]{11}$');
      for (final t in variants) {
        final links = _lines(t).where((l) => l.contains('://')).toList();
        expect(links.length, 1, reason: t);
        expect(form.hasMatch(links.single), isTrue, reason: t);
        final low = t.toLowerCase();
        for (final bad in ['youtu.be', 'rtmp', 'key', '192.', '.local', 'mymaxcom', 'studio']) {
          expect(low.contains(bad), isFalse, reason: '$bad in $t');
        }
      }
    });

    test('[PP-L1] a video id that is not 11 safe characters gives null', () {
      for (final bad in [
        'AAAAAAAAAA',
        'AAAAAAAAAAAA',
        'AAAAA/AAAAA',
        'rtmp://a.rtmp.youtube.com/live2/AAAA',
        'http://192.0.2.10/live/AAAAAAAAAAA',
        'AAAAA AAAAA',
        '',
      ]) {
        expect(liveNoticeText(LiveNoticeInput(videoId: bad), AppLang.ms, _now), isNull, reason: bad);
        expect(isLiveVideoId(bad), isFalse, reason: bad);
      }
      expect(isLiveVideoId('Ab_-0123456'), isTrue);
    });

    test('[PP-L1] only a public YouTube watch address gives a video id (no button otherwise)', () {
      expect(liveNoticeVideoId('https://www.youtube.com/watch?v=AAAAAAAAAAA'), _id);
      expect(liveNoticeVideoId('https://youtube.com/watch?v=AAAAAAAAAAA'), _id);
      expect(liveNoticeVideoId('https://youtu.be/AAAAAAAAAAA'), _id);
      expect(liveNoticeVideoId('https://www.youtube.com/live/AAAAAAAAAAA'), _id);
      for (final bad in [
        null,
        '',
        'https://evil.example/watch?v=AAAAAAAAAAA',
        'https://www.youtube.com.evil.example/watch?v=AAAAAAAAAAA',
        'http://www.youtube.com/watch?v=AAAAAAAAAAA',
        'https://www.youtube.com/watch?v=short',
        'https://studio.youtube.com/watch?v=AAAAAAAAAAA',
        'rtmp://a.rtmp.youtube.com/live2/AAAAAAAAAAA',
        'http://192.0.2.10/live/AAAAAAAAAAA',
        'https://user@www.youtube.com/watch?v=AAAAAAAAAAA',
        'https://www.youtube.com:8443/watch?v=AAAAAAAAAAA',
        'https://youtu.be/AAAAAAAAAAA/extra',
      ]) {
        expect(liveNoticeVideoId(bad), isNull, reason: '$bad');
      }
    });

    test('[PP-L1] a field typed by a person cannot add a second link or a new line', () {
      final i = _full(speaker: 'Ustaz Ahmad\nhttps://evil.example/x', topic: 'Tajuk\r\nhttp://192.0.2.10/live');
      for (final lang in AppLang.values) {
        final t = _text(i, lang);
        _clean(t);
        expect(t.contains('evil'), isFalse);
        expect(t.contains('192.'), isFalse);
        expect(_lines(t).length, 4);
      }
      final rlo = String.fromCharCode(0x202E);
      final marks = _full(speaker: 'Ustaz$rlo Ahmad${String.fromCharCode(0x2066)}');
      expect(_text(marks, AppLang.ms), isNot(contains(rlo)));
    });

    test('[AS1] WhatsApp _ ~ and backtick marks go, and scheme-less links are dropped', () {
      final i = _full(
        speaker: 'Ustaz _Ahmad_ ~Ali~ `Zain`',
        topic: 'Tajuk www.evil.example bit.ly/x sebenar',
        kitab: 'Kitab Contoh',
      );
      for (final lang in AppLang.values) {
        final t = _text(i, lang);
        _clean(t);
        expect(t.contains('evil'), isFalse, reason: t);
        expect(t.contains('bit.ly'), isFalse, reason: t);
        // the three marks are gone from the typed fields; the only marks left are the notice's own bold stars
        expect(t.contains('_'), isFalse, reason: t);
        expect(t.contains('~'), isFalse, reason: t);
        expect(t.contains('`'), isFalse, reason: t);
      }
      expect(_text(i, AppLang.ms), contains('*Ustaz Ahmad Ali Zain*'));
      expect(_text(i, AppLang.ms), contains('Tajuk: *Tajuk sebenar*'));
      // a plain word with a dot, or a name, is kept
      expect(_text(_full(topic: 'Bab 1.2 tentang niat'), AppLang.ms), contains('Tajuk: *Bab 1.2 tentang niat*'));
    });

    test('[PP-L1b] the link is put back on its own line when it was removed', () {
      expect(ensureLiveLink('Teks sahaja', _id), 'Teks sahaja\n$_link');
      expect(ensureLiveLink('Teks sahaja\n\n', _id), 'Teks sahaja\n$_link');
      expect(ensureLiveLink('', _id), _link);
      expect(ensureLiveLink('Ada $_link di sini', _id), 'Ada $_link di sini');
    });
  });
}
