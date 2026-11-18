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
  group('[PP-L1b] the binding sentences', () {
    test('[PP-L1b] BM: the three lines, character for character, with the kitab word once', () {
      final t = _text(_full(), AppLang.ms);
      expect(
        t,
        "Assalamu'alaikum warahmatullah.\n"
        'Ikuti Kuliah Maghrib malam ini disampaikan oleh Ustaz Ahmad membicarakan Kitab Contoh '
        'secara langsung dalam talian menerusi pautan berikut:\n'
        '$_link',
      );
    });

    test('[PP-L1b] BM: a title that does not begin with Kitab gets the word', () {
      final t = _text(_full(kitab: 'Contoh Fiqh'), AppLang.ms);
      expect(t, contains('membicarakan kitab Contoh Fiqh secara langsung'));
      expect(_text(_full(kitab: '  kitab Tauhid '), AppLang.ms), contains('membicarakan kitab Tauhid secara'));
      expect(_text(_full(kitab: 'Kitabun Contoh'), AppLang.ms), contains('membicarakan kitab Kitabun Contoh'));
    });

    test('[PP-L1b] EN: the sentence, and the book word once', () {
      expect(
        _text(_full(), AppLang.en),
        "Assalamu'alaikum warahmatullah.\n"
        'Join the Maghrib talk tonight, delivered by Ustaz Ahmad, on Kitab Contoh, '
        'live online at the link below:\n'
        '$_link',
      );
      expect(_text(_full(kitab: 'Contoh Fiqh'), AppLang.en), contains('on the book Contoh Fiqh, live online'));
      expect(_text(_full(kitab: 'Book of Contoh'), AppLang.en), contains(', on Book of Contoh, live'));
    });

    test('[PP-L1b] AR: the sentence, and the book word once', () {
      expect(
        _text(_full(), AppLang.ar),
        'السلام عليكم ورحمة الله.\n'
        'تابعوا درس المغرب الليلة يلقيه Ustaz Ahmad في شرح Kitab Contoh في بث مباشر عبر الرابط التالي:\n'
        '$_link',
      );
      expect(_text(_full(kitab: 'Contoh Fiqh'), AppLang.ar), contains('في شرح كتاب Contoh Fiqh في بث'));
      expect(_text(_full(kitab: 'كتاب التوحيد'), AppLang.ar), contains('في شرح كتاب التوحيد في بث'));
    });
  });

  group('[PP-L1b] Maghrib and Isyak are always tonight', () {
    test('[PP-L1b] a Maghrib kuliah at 18:45 and an Isyak kuliah say malam ini, tonight, الليلة', () {
      for (final (slot, h, m) in [('maghrib', 18, 45), ('isyak', 20, 30), ('isyak', 9, 0)]) {
        final i = _full(slot: slot, start: DateTime(2026, 11, 18, h, m));
        expect(_text(i, AppLang.ms), contains(' malam ini '), reason: '$slot $h:$m');
        expect(_text(i, AppLang.en), contains(' tonight, '), reason: '$slot $h:$m');
        expect(_text(i, AppLang.ar), contains(' الليلة '), reason: '$slot $h:$m');
      }
    });

    test('[PP-L1b] time words at 05:50, 12:30, 16:00 and 19:30 follow the start', () {
      final cases = <(String, int, int, String, String, String)>[
        ('subuh', 5, 50, 'pagi ini', 'this morning', 'هذا الصباح'),
        ('zohor', 12, 30, 'tengah hari ini', 'this afternoon', 'بعد ظهر اليوم'),
        ('asar', 16, 0, 'petang ini', 'this afternoon', 'بعد ظهر اليوم'),
        ('lain', 19, 30, 'malam ini', 'tonight', 'الليلة'),
      ];
      for (final (slot, h, m, ms, en, ar) in cases) {
        final i = _full(slot: slot, label: 'Kuliah Contoh', start: DateTime(2026, 11, 18, h, m));
        expect(_text(i, AppLang.ms), contains(' $ms '), reason: '$h:$m');
        expect(_text(i, AppLang.en), contains(' $en, '), reason: '$h:$m');
        expect(_text(i, AppLang.ar), contains(' $ar '), reason: '$h:$m');
      }
    });

    test('[PP-L1b] tomorrow is esok, tomorrow, غدا; three days ahead has no time words', () {
      final tomorrow = _full(slot: 'zohor', start: DateTime(2026, 11, 19, 13, 0));
      expect(_text(tomorrow, AppLang.ms), contains('Ikuti Kuliah Zohor esok disampaikan'));
      expect(_text(tomorrow, AppLang.en), contains('Join the Zohor talk tomorrow, delivered'));
      expect(_text(tomorrow, AppLang.ar), contains('تابعوا درس الظهر غدا يلقيه'));
      final later = _full(slot: 'zohor', start: DateTime(2026, 11, 21, 13, 0));
      expect(_text(later, AppLang.ms), contains('Ikuti Kuliah Zohor disampaikan'));
      expect(_text(later, AppLang.en), contains('Join the Zohor talk, delivered'));
      expect(_text(later, AppLang.ar), contains('تابعوا درس الظهر يلقيه'));
      // a Maghrib kuliah three days ahead is not "tonight"
      final maghribLater = _full(slot: 'maghrib', start: DateTime(2026, 11, 21, 18, 45));
      expect(_text(maghribLater, AppLang.ms), isNot(contains('malam ini')));
    });

    test('[PP-L1b] a slot outside the five uses the label, then the plain word', () {
      final dhuha = _full(slot: 'lain', label: 'Kuliah Dhuha');
      expect(_text(dhuha, AppLang.ms), contains('Ikuti Kuliah Dhuha malam ini'));
      expect(_text(dhuha, AppLang.en), contains('Join Kuliah Dhuha tonight'));
      expect(_text(dhuha, AppLang.ar), contains('تابعوا Kuliah Dhuha الليلة'));
      final none = _full(slot: 'lain', label: null);
      expect(_text(none, AppLang.ms), contains('Ikuti kuliah malam ini'));
      expect(_text(none, AppLang.en), contains('Join the talk tonight'));
      expect(_text(none, AppLang.ar), contains('تابعوا الدرس الليلة'));
    });
  });

  group('[PP-L1b] a missing piece still reads as one correct sentence', () {
    test('[PP-L1b] no speaker, no kitab and a topic, no kitab and no topic, in every language', () {
      for (final lang in AppLang.values) {
        final noSpeaker = _text(_full(speaker: null), lang);
        _clean(noSpeaker);
        expect(noSpeaker, isNot(contains('disampaikan')));
        expect(noSpeaker, isNot(contains('delivered')));
        expect(noSpeaker, isNot(contains('يلقيه')));
        expect(_lines(noSpeaker)[1], isNot(contains('Ustaz')));

        final topicOnly = _text(_full(kitab: null), lang);
        _clean(topicOnly);
        expect(topicOnly, contains('Tajuk Contoh'));
        expect(topicOnly, isNot(contains('Kitab Contoh')));

        final neither = _text(_full(kitab: null, topic: null), lang);
        _clean(neither);
        expect(neither, isNot(contains('Tajuk')));
        expect(neither, isNot(contains('Kitab')));

        final bare = _text(_full(speaker: null, kitab: null, topic: null), lang);
        _clean(bare);
        expect(_lines(bare).length, 3);
      }
      final ms = _text(_full(kitab: null), AppLang.ms);
      expect(ms, contains('membicarakan tajuk Tajuk Contoh secara langsung'));
      expect(_text(_full(kitab: null), AppLang.en), contains(', on the topic Tajuk Contoh, live online'));
      expect(_text(_full(kitab: null), AppLang.ar), contains('في موضوع Tajuk Contoh في بث'));
      expect(
        _text(_full(speaker: null, kitab: null, topic: null), AppLang.ms),
        contains('Ikuti Kuliah Maghrib malam ini secara langsung dalam talian'),
      );
      expect(
        _text(_full(speaker: null, kitab: null, topic: null), AppLang.en),
        contains('Join the Maghrib talk tonight, live online at the link below:'),
      );
    });

    test('[PP-L1b] no kuliah chosen gives the surau sentence', () {
      const none = LiveNoticeInput(videoId: _id, surau: 'Surau Perintis Contoh');
      expect(
        _text(none, AppLang.ms),
        "Assalamu'alaikum warahmatullah.\n"
        'Ikuti siaran langsung dari Surau Perintis Contoh dalam talian menerusi pautan berikut:\n$_link',
      );
      expect(_text(none, AppLang.en), contains('Join the live stream from Surau Perintis Contoh at the link below:'));
      expect(_text(none, AppLang.ar), contains('تابعوا البث المباشر من Surau Perintis Contoh عبر الرابط التالي:'));
      for (final lang in AppLang.values) {
        _clean(_text(none, lang));
      }
      const noName = LiveNoticeInput(videoId: _id);
      expect(_text(noName, AppLang.ms), contains('Ikuti siaran langsung dalam talian menerusi'));
      expect(_text(noName, AppLang.en), contains('Join the live stream at the link below:'));
      for (final lang in AppLang.values) {
        _clean(_text(noName, lang));
      }
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
        expect(_lines(t).length, 3);
      }
      final rlo = String.fromCharCode(0x202E);
      final marks = _full(speaker: 'Ustaz$rlo Ahmad${String.fromCharCode(0x2066)}');
      expect(_text(marks, AppLang.ms), isNot(contains(rlo)));
    });

    test('[PP-L1b] the link is put back on its own line when it was removed', () {
      expect(ensureLiveLink('Teks sahaja', _id), 'Teks sahaja\n$_link');
      expect(ensureLiveLink('Teks sahaja\n\n', _id), 'Teks sahaja\n$_link');
      expect(ensureLiveLink('', _id), _link);
      expect(ensureLiveLink('Ada $_link di sini', _id), 'Ada $_link di sini');
    });
  });
}
