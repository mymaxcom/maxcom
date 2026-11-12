// Roles in plain BM and moments as a Malaysian says them.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/common/roles.dart';
import 'package:surau_app/features/common/time_words.dart';
import 'package:surau_app/l10n/generated/s.dart';

Future<S> msStrings(WidgetTester tester) async {
  late S s;
  await tester.pumpWidget(
    MaterialApp(
      locale: const Locale('ms'),
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      home: Builder(
        builder: (context) {
          s = S.of(context);
          return const SizedBox();
        },
      ),
    ),
  );
  return s;
}

void main() {
  testWidgets('the Pentadbir MAXCOM comes first and reads as its own role', (tester) async {
    final s = await msStrings(tester);
    expect(roleOrder.first, 'superadmin');
    expect(roleLabel(s, 'superadmin'), 'Pentadbir MAXCOM');
    expect(rolesSentence(s, ['admin', 'superadmin']), 'Pentadbir MAXCOM dan Pentadbir');
  });

  testWidgets('one to four roles read calmly, in the box order', (
    tester,
  ) async {
    final s = await msStrings(tester);
    expect(rolesSentence(s, []), '');
    expect(rolesSentence(s, ['admin']), 'Pentadbir');
    expect(rolesSentence(s, ['media', 'admin']), 'Pentadbir dan Media');
    expect(
      rolesSentence(s, ['admin', 'treasurer', 'media']),
      'Pentadbir, Bendahari dan Media',
    );
    expect(
      rolesSentence(s, ['ajk', 'media', 'treasurer', 'admin']),
      'Pentadbir, Bendahari, Media dan AJK',
    );
    expect(
      rolesSentence(s, ['admin', 'admin', 'khatib']),
      'Pentadbir dan khatib',
    );
  });

  test('time of day in BM', () {
    expect(timeOfDayWords(DateTime(2026, 11, 4, 22, 45)), '10:45 malam');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 8, 0)), '8:00 pagi');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 0, 5)), '12:05 pagi');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 12, 30)), '12:30 tengah hari');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 13, 0)), '1:00 petang');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 18, 59)), '6:59 petang');
    expect(timeOfDayWords(DateTime(2026, 11, 4, 19, 0)), '7:00 malam');
  });

  test('whenWords adds esok or a short date when not today', () {
    final today = DateTime(2026, 11, 4, 20, 0);
    expect(
      whenWords(DateTime(2026, 11, 4, 22, 45), today: today),
      '10:45 malam',
    );
    expect(
      whenWords(DateTime(2026, 11, 5, 0, 10), today: today),
      '12:10 pagi esok',
    );
    expect(
      whenWords(DateTime(2026, 11, 12, 9, 0), today: today),
      '9:00 pagi, 12 Nov',
    );
    expect(
      whenWords(DateTime(2027, 3, 1, 9, 0), today: today),
      '9:00 pagi, 1 Mac',
    );
  });
}
