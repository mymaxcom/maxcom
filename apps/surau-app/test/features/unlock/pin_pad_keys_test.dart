// A physical keyboard types into the PIN pad like the keys do: main-row
// and numpad digits, Backspace.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/unlock/pin_pad.dart';

void main() {
  Future<(List<String>, List<int>)> pump(WidgetTester tester) async {
    final digits = <String>[];
    final backs = <int>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: PinPad(
              onDigit: digits.add,
              onBackspace: () => backs.add(1),
              backspaceLabel: 'Padam',
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    return (digits, backs);
  }

  testWidgets('main row digits, numpad digits and Backspace act like taps', (
    tester,
  ) async {
    final (digits, backs) = await pump(tester);
    for (final k in [
      LogicalKeyboardKey.digit1,
      LogicalKeyboardKey.digit0,
      LogicalKeyboardKey.numpad7,
      LogicalKeyboardKey.numpad9,
    ]) {
      await tester.sendKeyEvent(k);
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    expect(digits, ['1', '0', '7', '9']);
    expect(backs, [1]);
  });

  testWidgets('other keys and ctrl combos do nothing; tapping still works', (
    tester,
  ) async {
    final (digits, backs) = await pump(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.digit5);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    expect(digits, isEmpty);
    expect(backs, isEmpty);
    await tester.tap(find.text('5'));
    expect(digits, ['5']);
  });
}
