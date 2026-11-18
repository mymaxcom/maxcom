// [F12] Amounts, phone numbers, times and IDs keep their own left-to-right
// order inside an Arabic row: the leading minus stays first.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/common/ltr.dart';

void main() {
  group('[F12] ltr', () {
    test('[F12] ltr wraps the text in U+2066 and U+2069 and keeps every character', () {
      final out = ltr('-RM 18.00');
      expect(out.codeUnitAt(0), 0x2066);
      expect(out.codeUnitAt(out.length - 1), 0x2069);
      expect(out.substring(1, out.length - 1), '-RM 18.00');
      expect(out.replaceAll('\u2066', '').replaceAll('\u2069', ''), '-RM 18.00');
    });

    test('[F12] an empty text stays empty and wrapping is not doubled', () {
      expect(ltr(''), '');
      expect(ltr(ltr('+60 12-000 0001')), ltr('+60 12-000 0001'));
    });
  });

  group('[F12] LtrText', () {
    Widget host(Widget child, TextDirection d) => MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Directionality(
        textDirection: d,
        child: Scaffold(body: Center(child: SizedBox(width: 300, child: child))),
      ),
    );

    testWidgets('[F12] LtrText shows the isolated text and semantics read the plain text', (t) async {
      await t.pumpWidget(host(const LtrText('-RM 18.00'), TextDirection.rtl));
      final text = t.widget<Text>(find.byType(Text));
      expect(text.data, ltr('-RM 18.00'));
      expect(text.semanticsLabel, '-RM 18.00');
    });

    testWidgets('[F12] in an Arabic row the minus is drawn left of the figures (golden ltr_amount_ar)', (t) async {
      await t.binding.setSurfaceSize(const Size(360, 120));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(
        RepaintBoundary(
          key: const ValueKey('shot'),
          child: host(
            const Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Row(
                  children: [
                    Expanded(child: Text('دفع المتطوع', style: TextStyle(fontFamily: 'NotoNaskhArabic', fontSize: 18))),
                    LtrText('-RM 18.00', style: TextStyle(fontFamily: 'PlusJakartaSans', fontSize: 18)),
                  ],
                ),
                Row(
                  children: [
                    Expanded(child: Text('الهاتف', style: TextStyle(fontFamily: 'NotoNaskhArabic', fontSize: 18))),
                    LtrText('+60 12-000 0001', style: TextStyle(fontFamily: 'PlusJakartaSans', fontSize: 18)),
                  ],
                ),
              ],
            ),
            TextDirection.rtl,
          ),
        ),
      );
      await t.pumpAndSettle();
      // The isolated amount starts with the minus: its first glyph box is the
      // leftmost one of the run.
      final box = t.getRect(find.byType(LtrText).first);
      expect(box.left, lessThan(60), reason: 'in a right-to-left row the amount sits at the left edge');
      await expectLater(find.byKey(const ValueKey('shot')), matchesGoldenFile('ltr_amount_ar.png'));
    });
  });
}
