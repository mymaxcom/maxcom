// The zikir editor: the optional English translation ("Terjemahan bahasa
// Inggeris") sits under the Malay one; a filled one is sent as `textEn`, an
// empty one is not sent (the TV then shows the Malay translation).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../features/shell/harness.dart';

Finder field(String key) => find.byKey(ValueKey('field-$key'));

Finder get save => find.byKey(const ValueKey('content-save'));

Future<ShellHarness> openNew(WidgetTester tester) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  h.router.go('/content/zikir/new');
  await settle(tester);
  return h;
}

void main() {
  testWidgets('a new zikir with its English translation sends textEn', (tester) async {
    final h = await openNew(tester);
    expect(field('textEn'), findsOneWidget);
    await reveal(tester, field('textEn'));
    // an optional field: its label says so
    expect(find.textContaining('Terjemahan bahasa Inggeris'), findsOneWidget);
    await tester.enterText(field('textAr'), 'سُبْحَانَ اللهِ');
    await tester.enterText(field('textMs'), 'Maha Suci Allah');
    await tester.enterText(field('textEn'), 'Glory be to Allah');
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final body = jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT').body) as Map<String, dynamic>;
    expect(body['textMs'], 'Maha Suci Allah');
    expect(body['textEn'], 'Glory be to Allah');
  });

  testWidgets('the English translation may stay empty: it is not sent', (tester) async {
    final h = await openNew(tester);
    await tester.enterText(field('textAr'), 'اَلْحَمْدُ لِلّٰهِ');
    await tester.enterText(field('textMs'), 'Segala puji bagi Allah');
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final body = jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT').body) as Map<String, dynamic>;
    expect(body['textMs'], 'Segala puji bagi Allah');
    expect(body.containsKey('textEn'), isFalse);
  });
}
