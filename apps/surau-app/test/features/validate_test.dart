// The Dart validator says yes and no exactly where core does: every case in
// `test/fixtures/settings-cases.json` (answers computed by core's own
// validateFeatureSettings), plus the enum and int rules read from core's source.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/validate.dart';

String _read(String relative) {
  final file = File(relative);
  if (!file.existsSync()) {
    throw StateError('$relative not found; run from apps/surau-app');
  }
  return file.readAsStringSync();
}

void main() {
  final fixture = jsonDecode(_read('test/fixtures/settings-cases.json')) as Map;
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  test('the fixture covers every feature, valid and invalid', () {
    expect(cases.length, greaterThan(1000));
    expect(
      cases.map((c) => c['key']).toSet(),
      features.map((f) => f.key).toSet(),
    );
    expect(cases.where((c) => c['ok'] == true).length, greaterThan(100));
    expect(cases.where((c) => c['ok'] == false).length, greaterThan(100));
    for (final f in features) {
      final mine = cases.where((c) => c['key'] == f.key).toList();
      expect(
        mine.any((c) => c['note'] == 'defaults' && c['ok'] == true),
        isTrue,
        reason: f.key,
      );
    }
  });

  test('every generated case gets the same ok as core', () {
    final wrong = <String>[];
    for (final c in cases) {
      final r = validateFeatureSettings(c['key'] as String, c['patch']);
      if (r.ok != c['ok']) {
        wrong.add(
          '${c['key']} / ${c['note']}: dart ${r.ok} core ${c['ok']} '
          '${jsonEncode(c['patch'])} ${r.errors}',
        );
      }
    }
    expect(wrong, isEmpty, reason: wrong.take(8).join('\n'));
  });

  test('every cross-field case gets the same ok as core', () {
    final cross = (fixture['crossCases'] as List).cast<Map<String, dynamic>>();
    expect(cross.where((c) => c['ok'] == true), isNotEmpty);
    expect(cross.where((c) => c['ok'] == false), isNotEmpty);
    final wrong = <String>[];
    for (final c in cross) {
      final r = validateFeatureSettings(
        c['key'] as String,
        c['patch'],
        current: (c['current'] as Map).cast<String, dynamic>(),
      );
      if (r.ok != c['ok']) wrong.add('${c['note']}: dart ${r.ok} core ${c['ok']} ${r.errors}');
    }
    expect(wrong, isEmpty, reason: wrong.join('\n'));
  });

  test('without current the cross-field rules stay silent, as in core', () {
    expect(validateFeatureSettings('ayatCard', {'ayatFrom': 10, 'ayatTo': 20}).ok, isTrue);
  });

  test('enum lists equal the ones in core settings.ts', () {
    final ts = _read('../../packages/core/src/features/settings.ts');
    final found = RegExp(
      r"case '(\w+)': return \{ t: 'enum', vals: \[([^\]]*)\] \}",
    ).allMatches(ts).toList();
    expect(found.length, greaterThanOrEqualTo(9));
    for (final m in found) {
      final vals = RegExp(r"'([^']+)'")
          .allMatches(m.group(2)!)
          .map((q) => q.group(1)!)
          .toList();
      final rule = ruleFor(m.group(1)!);
      expect(rule, isNotNull, reason: m.group(1));
      expect(rule!.type, SettingRuleType.enumOf);
      expect(rule.vals, vals, reason: m.group(1));
    }
  });

  test('int rules equal the ones in core settings.ts', () {
    final ts = _read('../../packages/core/src/features/settings.ts');
    final found = RegExp(
      r"case '(\w+)': return \{ t: 'int', min: (-?\d+), max: (\d+) \}",
    ).allMatches(ts).toList();
    expect(found.length, greaterThanOrEqualTo(10));
    for (final m in found) {
      final rule = ruleFor(m.group(1)!);
      expect(rule?.type, SettingRuleType.int, reason: m.group(1));
      expect(rule!.min, int.parse(m.group(2)!), reason: m.group(1));
      expect(rule.max, int.parse(m.group(3)!), reason: m.group(1));
    }
  });

  group('messages', () {
    test('out of range: BM text with the range and core key path', () {
      final r = validateFeatureSettings('iqamahCountdown', {
        'minutes': {
          'jumaat': {'subuh': -3},
        },
      });
      expect(r.ok, isFalse);
      expect(r.errors.single.path, 'minutes.jumaat.subuh');
      expect(r.errors.single.message, 'Mesti nombor bulat 0 hingga 120');
      expect(r.firstMessage, contains('0 hingga 120'));
      expect(r.errors.single.toString(), startsWith('minutes.jumaat.subuh: '));
    });

    test('locked feature cannot be switched off', () {
      expect(validateFeatureSettings('clock', {'enabled': false}).ok, isFalse);
      expect(validateFeatureSettings('clock', {'enabled': true}).ok, isTrue);
      expect(validateFeatureSettings('finance', {'enabled': false}).ok, isTrue);
    });

    test('unknown feature, unknown key and non-object patch', () {
      expect(validateFeatureSettings('nope', {}).ok, isFalse);
      expect(validateFeatureSettings('clock', {'zz': 1}).ok, isFalse);
      expect(validateFeatureSettings('clock', [1]).ok, isFalse);
      expect(validateFeatureSettings('clock', null).ok, isFalse);
    });

    test('text limits, enum, zone and backgrounds', () {
      expect(
        validateFeatureSettings('solatScreen', {'message': 'a' * 101}).ok,
        isFalse,
      );
      expect(
        validateFeatureSettings('solatScreen', {'message': 'a' * 100}).ok,
        isTrue,
      );
      expect(validateFeatureSettings('zone', {'zone': 'sgr01'}).ok, isFalse);
      expect(validateFeatureSettings('zone', {'zone': 'SGR02'}).ok, isTrue);
      expect(
        validateFeatureSettings('backgrounds', {
          'images': ['../x'],
        }).ok,
        isFalse,
      );
      expect(
        validateFeatureSettings('backgrounds', {
          'images': ['default-1', '/uploads/a.jpg'],
        }).ok,
        isTrue,
      );
      expect(
        validateFeatureSettings('surauInfo', {'name': '   '}).firstMessage,
        'Wajib diisi',
      );
    });

    test('internet sources: name is plain text 1..60, url is public https', () {
      String? url(String v) => validateFeatureSettings('dataSources', {
        'esolat': {'url': v},
      }).firstMessage;
      String? name(String v) => validateFeatureSettings('dataSources', {
        'quranText': {'name': v},
      }).firstMessage;
      expect(url('https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat'), isNull);
      expect(url('https://quranenc.com/api/v1'), isNull);
      expect(url('http://quranenc.com/api/v1'), 'Mesti bermula dengan https://');
      expect(url('zzz-wrong'), 'Mesti bermula dengan https://');
      expect(url(''), 'Mesti bermula dengan https://');
      expect(url('https://user:pw@quranenc.com/'), contains('kata laluan'));
      expect(url('https://quranenc.com/api#x'), contains('#'));
      expect(url('https://quranenc.com/a b'), contains('ruang'));
      expect(url('https://${'a' * 300}.com'), contains('300'));
      for (final host in [
        'localhost',
        'box.local',
        'box',
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.9',
        '192.' '168.1.14',
        '169.254.1.1',
        '100.64.0.1',
        '0.0.0.0',
        '[::1]',
        '[fc00::1]',
        '[fe80::1]',
        '[::ffff:192.' '168.1.1]',
      ]) {
        expect(url('https://$host/x'), contains('awam'), reason: host);
      }
      expect(url('https://[2606:4700::1111]/x'), isNull);
      expect(url('https://8.8.8.8/x'), isNull);
      expect(validateFeatureSettings('dataSources', {
        'esolat': {'url': 'https://quranenc.com/'},
      }).ok, isTrue);
      expect(validateFeatureSettings('dataSources', {
        'esolat': {'url': 'http://x.com/'},
      }).errors.single.path, 'esolat.url');
      expect(name('e-Solat JAKIM'), isNull);
      expect(name(''), 'Wajib diisi');
      expect(name('   '), 'Wajib diisi');
      expect(name('a' * 61), contains('60'));
      expect(name('<b>x</b>'), 'Mesti teks biasa');
      expect(validateFeatureSettings('dataSources', {'enabled': false}).ok, isFalse);
      expect(validateFeatureSettings('dataSources', {
        'esolat': {'zz': 'x'},
      }).ok, isFalse);
      // The `surauInfo.name` rule (1..80) is untouched by the source rule.
      expect(validateFeatureSettings('surauInfo', {'name': 'a' * 70}).ok, isTrue);
    });

    test('the rules of Plan 12: colour, audio id, relay source, system values, cross messages', () {
      bool ok(String k, Map<String, Object?> p) => validateFeatureSettings(k, p).ok;
      expect(ok('autoTone', {'override': '#12ab'}), isFalse);
      expect(ok('autoTone', {'override': '#12AB34'}), isTrue);
      expect(ok('autoTone', {'override': null}), isTrue);
      expect(ok('firstAzanSubuh', {'audioFile': 'x'}), isFalse);
      expect(ok('firstAzanSubuh', {'audioFile': 'a' * 64}), isTrue);
      expect(ok('liveYoutube', {'relayFrom': 'tablet'}), isFalse);
      expect(ok('liveYoutube', {'relayFrom': 'phone'}), isTrue);
      expect(ok('liveYoutube', {'titleTemplate': 'a' * 101}), isFalse);
      expect(ok('liveYoutube', {'titleTemplate': 'a' * 100}), isTrue);
      expect(ok('system', {'syncHistoryDays': 90}), isFalse);
      expect(ok('system', {'syncHistoryDays': 365}), isTrue);
      expect(ok('system', {'noVideoSeconds': 4}), isFalse);
      expect(ok('system', {'cloudWakeSeconds': 60}), isTrue);
      expect(ok('system', {'suspendedAt': 'x'}), isFalse);
      expect(ok('system', {'suspendedAt': null}), isTrue);
      expect(ok('system', {'suspendedAt': '2026-11-09T10:00:00.000Z'}), isTrue);
      final r = validateFeatureSettings('ayatCard', {'surah': 1, 'ayatTo': 8}, current: {'ayatFrom': 1});
      expect(r.errors.single.path, 'ayatTo');
      expect(r.errors.single.message, 'Al-Fatihah ada 7 ayat');
      expect(
        validateFeatureSettings('ayatCard', {'ayatFrom': 10, 'ayatTo': 20}, current: {'surah': 2}).firstMessage,
        'Paling banyak 5 ayat sekali paparan',
      );
      // an old stored range that breaks the rule is reported only when the patch touches a verse field
      const oldRange = {'surah': 2, 'ayatFrom': 10, 'ayatTo': 20};
      expect(validateFeatureSettings('ayatCard', {'showTranslation': false}, current: oldRange).ok, isTrue);
      expect(validateFeatureSettings('ayatCard', {'ayatFrom': 11}, current: oldRange).ok, isFalse);
    });

    test('a whole number sent as 50.0 is accepted, 50.5 is not', () {
      expect(validateFeatureSettings('beeps', {'volume': 50.0}).ok, isTrue);
      expect(validateFeatureSettings('beeps', {'volume': 50.5}).ok, isFalse);
    });
  });
}
