// [PP-A1] The Dart twins of the core ref and phone modules. They read the same
// JSON vector files the server's tests read (apps/box-server/test/fixtures):
// a rule that changes on one side fails the other.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/people/phone.dart';
import 'package:surau_app/features/people/ref.dart';
import 'package:surau_app/l10n/generated/s.dart';

Map<String, dynamic> _vectors(String name) => jsonDecode(
  File('../box-server/test/fixtures/$name').readAsStringSync(),
) as Map<String, dynamic>;

void main() {
  final refs = _vectors('ref-vectors.json');
  final phones = _vectors('phone-vectors.json');

  group('[PP-A1] ref vectors', () {
    for (final v in (refs['format'] as List).cast<Map<String, dynamic>>()) {
      test('[PP-A1] format ${v['short']}', () {
        final kind = v['kind'] as String;
        final src = v['src'] as String;
        final no = v['no'] as int;
        expect(formatRef(kind, src, no), v['short']);
        expect(formatGlobalRef('surau-contoh', kind, src, no), v['global']);
      });
    }

    test('[PP-A1] a number below 1 or a bad kind or series is refused', () {
      expect(() => formatRef('user', 'b', 0), throwsRangeError);
      expect(() => formatRef('user', 'b', -3), throwsRangeError);
      expect(() => formatRef('tv', 'b', 1), throwsArgumentError);
      expect(() => formatRef('user', 'x', 1), throwsArgumentError);
    });

    for (final v in (refs['parse'] as List).cast<Map<String, dynamic>>()) {
      test('[PP-A1] parse "${v['text']}"', () {
        final p = parseRef(v['text'] as String);
        if (v['null'] == true) {
          expect(p, isNull);
          return;
        }
        expect(p, isNotNull);
        expect(p!.surauId, v['surauId']);
        expect(p.kind, v['kind']);
        expect(p.src, v['src']);
        expect(p.no, v['no']);
      });
    }
  });

  group('[PP-A1] ref of a record', () {
    test('[PP-A1] the stored ref wins; else no and noSrc; else null (never invented)', () {
      expect(refOf(ref: 'U-0007', kind: 'user', no: 3, noSrc: 'b'), 'U-0007');
      expect(refOf(kind: 'user', no: 12, noSrc: 'c'), 'U-C0012');
      expect(refOf(kind: 'device', no: 9, noSrc: 'b'), 'D-0009');
      expect(refOf(kind: 'user'), isNull);
      expect(refOf(kind: 'user', no: 4), isNull);
      expect(refOf(ref: '', kind: 'user'), isNull);
      expect(refOf(kind: 'user', no: 0, noSrc: 'b'), isNull);
    });
  });

  group('[PP-A1] phone vectors', () {
    for (final v in (phones['normalise'] as List).cast<Map<String, dynamic>>()) {
      test('[PP-A1] normalise "${v['raw']}"', () {
        expect(normalisePhone(v['raw'] as String), v['e164']);
      });
    }

    for (final v in (phones['format'] as List).cast<Map<String, dynamic>>()) {
      test('[PP-A1] format ${v['e164']}', () {
        expect(formatPhone(v['e164'] as String), v['text']);
      });
    }

    test('[PP-A1] a formatted number reads back to the same E.164', () {
      for (final v in (phones['format'] as List).cast<Map<String, dynamic>>()) {
        expect(normalisePhone(v['text'] as String), v['e164']);
      }
    });
  });

  group('[PP-A1] whatsAppUri', () {
    test('[PP-A1] wa.me, digits only, text percent-encoded (a space is %20)', () {
      final u = whatsAppUri('+60120000003', 'Ikuti kuliah\nhttps://www.youtube.com/live/abcdefghijk');
      expect(u.scheme, 'https');
      expect(u.host, 'wa.me');
      expect(u.path, '/60120000003');
      expect(u.queryParameters['text'], 'Ikuti kuliah\nhttps://www.youtube.com/live/abcdefghijk');
      expect(u.toString(), startsWith('https://wa.me/60120000003?text=Ikuti%20kuliah%0A'));
      expect(u.toString(), isNot(contains('+')));
    });

    test('[PP-A1] a value that is not E.164 is refused', () {
      for (final bad in ['60120000003', '+0120000003', '012-000 0003', '+6012', '', '+60 12-000 0003']) {
        expect(() => whatsAppUri(bad, 'x'), throwsArgumentError, reason: bad);
      }
    });
  });

  group('[PP-A1] RefText', () {
    Future<void> pump(WidgetTester t, Widget child, {Locale locale = const Locale('ar')}) =>
        t.pumpWidget(
          MaterialApp(
            locale: locale,
            localizationsDelegates: S.localizationsDelegates,
            supportedLocales: S.supportedLocales,
            home: Scaffold(body: child),
          ),
        );

    testWidgets('[CL-1] is left-to-right inside an Arabic row, selectable, app font with tabular figures, spoken label', (t) async {
      await pump(t, const Row(children: [RefText('U-0001')]));
      final sel = t.widget<SelectableText>(find.byType(SelectableText));
      expect(sel.textDirection, TextDirection.ltr);
      expect(sel.data, contains('U-0001'));
      expect(find.bySemanticsLabel('ID U 0 0 0 1'), findsOneWidget);
      final style = sel.style!;
      expect(style.fontFamily, isNot('monospace'));
      expect(style.fontFeatures, contains(const FontFeature.tabularFigures()));
    });

    testWidgets('[PP-A1] a record with no ID shows "ID belum ada" in the app language', (t) async {
      await pump(t, const RefText(null), locale: const Locale('ms'));
      expect(find.text('ID belum ada'), findsOneWidget);
      expect(find.byType(SelectableText), findsNothing);
    });

    testWidgets('[PP-A1] the cloud series is spoken letter by letter too', (t) async {
      await pump(t, const RefText('D-C0012'), locale: const Locale('en'));
      expect(find.bySemanticsLabel('ID D C 0 0 1 2'), findsOneWidget);
    });
  });
}
