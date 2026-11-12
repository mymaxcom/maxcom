// The Dart content validator says yes and no exactly where core's
// `validateContent` does: every case in `test/fixtures/content-cases.json`
// (answers computed by core itself), the drift hash of core's content
// sources, the 14 kind specs the editors are built from, and `newId()`.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/digests/sha256.dart';
import 'package:surau_app/content/kinds.dart';

String _read(String relative) {
  final file = File(relative);
  if (!file.existsSync()) {
    throw StateError('$relative not found; run from apps/surau-app');
  }
  return file.readAsStringSync();
}

/// Same recipe as the generator: schema.ts then types.ts, CRLF as LF.
String contentHashNow() {
  final d = SHA256Digest();
  for (final f in ['content/schema.ts', 'content/types.ts']) {
    final text = _read('../../packages/core/src/$f').replaceAll('\r\n', '\n');
    final bytes = Uint8List.fromList(utf8.encode(text));
    d.update(bytes, 0, bytes.length);
  }
  final out = Uint8List(32);
  d.doFinal(out, 0);
  return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

void main() {
  final fixture = jsonDecode(_read('test/fixtures/content-cases.json')) as Map;
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  test('core content sources unchanged since the fixture was generated', () {
    expect(
      fixture['contentSourceHash'],
      contentHashNow(),
      reason: 'core changed: run  node scripts/gen-app-fixtures.mjs --content  and re-check kinds.dart',
    );
    expect(contentSourceHash, fixture['contentSourceHash']);
  });

  test('the fixture covers every kind, valid and invalid', () {
    expect(cases.length, greaterThan(500));
    expect(
      (fixture['kinds'] as List).cast<String>(),
      contentKinds.map((k) => k.key).toList(),
    );
    for (final k in contentKinds) {
      final mine = cases.where((c) => c['kind'] == k.key).toList();
      expect(mine.any((c) => c['note'] == 'full' && c['ok'] == true), isTrue, reason: k.key);
      expect(mine.any((c) => c['ok'] == false), isTrue, reason: k.key);
    }
  });

  test('every generated case gets the same ok as core', () {
    final wrong = <String>[];
    for (final c in cases) {
      final r = validateContent(c['kind'] as String, c['item']);
      if (r.ok != c['ok']) {
        wrong.add(
          '${c['kind']} / ${c['note']}: dart ${r.ok} core ${c['ok']} '
          '${jsonEncode(c['item'])} ${r.errors}',
        );
      }
    }
    expect(wrong, isEmpty, reason: wrong.take(10).join('\n'));
  });

  group('specs', () {
    test('14 kinds, each with a BM label, an icon and fields', () {
      expect(contentKinds.length, 14);
      expect(contentKinds.map((k) => k.key).toSet().length, 14);
      for (final k in contentKinds) {
        expect(k.labelMs, isNotEmpty, reason: k.key);
        expect(k.labelMsPlural, isNotEmpty, reason: k.key);
        expect(k.fields, isNotEmpty, reason: k.key);
        expect(k.fields.map((f) => f.key).toSet().length, k.fields.length, reason: k.key);
        for (final f in k.fields) {
          expect(f.labelMs, isNotEmpty, reason: '${k.key}.${f.key}');
        }
      }
      expect(contentKindByKey('kuliah')!.labelMsPlural, 'Kuliah');
      expect(contentKindByKey('zzz'), isNull);
    });

    test('the field types the plan names', () {
      final kuliah = contentKindByKey('kuliah')!;
      expect(kuliah.field('date').type, FieldType.date);
      expect(kuliah.field('time').type, FieldType.time);
      expect(kuliah.field('slot').type, FieldType.enumOf);
      expect(kuliah.field('slot').choices, ['subuh', 'zohor', 'asar', 'maghrib', 'isyak', 'lain']);
      expect(kuliah.field('penceramahId').type, FieldType.ref);
      expect(kuliah.field('penceramahId').refKind, 'penceramah');
      expect(kuliah.field('kitabId').required, isFalse);
      expect(kuliah.field('status').type, FieldType.status);
      final poster = contentKindByKey('poster')!;
      expect(poster.field('assetId').type, FieldType.asset);
      expect(poster.field('days').type, FieldType.days);
      expect(poster.field('days').allowDaily, isFalse);
      expect(poster.field('order').type, FieldType.int);
      final tilawah = contentKindByKey('tilawahSlot')!;
      expect(tilawah.field('days').allowDaily, isTrue);
      expect(tilawah.field('minutesBefore').min, 1);
      expect(tilawah.field('minutesBefore').max, 120);
      expect(tilawah.field('surah').max, 114);
      expect(tilawah.field('enabled').type, FieldType.bool);
      final pengumuman = contentKindByKey('pengumuman')!;
      expect(pengumuman.field('priority').type, FieldType.priority);
      expect(pengumuman.field('body').type, FieldType.multiline);
      expect(pengumuman.field('body').maxLength, 2000);
      expect(contentKindByKey('ticker')!.field('text').maxLength, 300);
      expect(contentKindByKey('programKhas')!.field('at').type, FieldType.dateTime);
      expect(contentKindByKey('worldTime')!.field('tz').type, FieldType.timezone);
      expect(contentKindByKey('tugasan')!.field('petugasId').refKind, 'petugas');
    });

    test('every enum choice and the roles have a BM label', () {
      for (final k in contentKinds) {
        for (final f in k.fields) {
          for (final c in f.choices) {
            expect(f.choiceLabelMs(c), isNot(c), reason: '${k.key}.${f.key}=$c');
          }
        }
      }
    });
  });

  group('messages', () {
    test('from after to: the BM sentence the editor shows', () {
      final r = validateContent('pengumuman', {
        'title': 'A',
        'body': 'B',
        'from': '2026-11-08',
        'to': '2026-11-01',
        'priority': 1,
      });
      expect(r.ok, isFalse);
      expect(r.errors.map((e) => e.message), contains('Tarikh mula mesti sebelum tarikh tamat'));
      expect(r.errors.first.path, 'from');
    });

    test('a required field left empty says so, with the field path', () {
      final r = validateContent('penceramah', {'name': '  '});
      expect(r.errors.single.path, 'name');
      expect(r.errors.single.message, 'Wajib diisi');
    });

    test('an optional field may be absent but not null', () {
      expect(validateContent('penceramah', {'name': 'A'}).ok, isTrue);
      expect(validateContent('penceramah', {'name': 'A', 'title': null}).ok, isFalse);
      expect(validateContent('penceramah', {'name': 'A', 'title': ''}).ok, isTrue);
    });

    test('a whole number sent as 2.0 is accepted, 2.5 is not', () {
      final base = {'title': 'A', 'body': 'B', 'from': '2026-11-01', 'to': '2026-11-02'};
      expect(validateContent('pengumuman', {...base, 'priority': 2.0}).ok, isTrue);
      expect(validateContent('pengumuman', {...base, 'priority': 2.5}).ok, isFalse);
    });
  });

  test('cleanItem drops empty optional text so the box never sees null', () {
    final spec = contentKindByKey('kuliah')!;
    final out = cleanItem(spec, {
      'date': '2026-11-05',
      'slot': 'maghrib',
      'time': '19:15',
      'label': ' Kuliah Maghrib ',
      'penceramahId': 'p1',
      'kitabId': '',
      'topic': '  ',
      'status': 'aktif',
      'seriesId': null,
    });
    expect(out, {
      'date': '2026-11-05',
      'slot': 'maghrib',
      'time': '19:15',
      'label': 'Kuliah Maghrib',
      'penceramahId': 'p1',
      'status': 'aktif',
    });
  });

  test('newId is a lower-case UUID v4, different every time', () {
    final re = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
    final ids = {for (var i = 0; i < 50; i++) newId()};
    expect(ids.length, 50);
    for (final id in ids) {
      expect(re.hasMatch(id), isTrue, reason: id);
    }
  });
}
