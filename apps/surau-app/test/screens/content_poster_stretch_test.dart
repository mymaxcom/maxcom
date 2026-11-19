// Poster: `Regangkan gambar` (stretch). A new poster starts with it on, a saved
// poster without the field shows it on, a poster saved with false shows it
// off, and Simpan always sends the flag.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> open(WidgetTester tester, String path) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  h.router.go(path);
  await settle(tester);
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  return h;
}

Finder get stretch => find.byKey(const ValueKey('field-stretch'));
Finder get save => find.byKey(const ValueKey('content-save'));

bool isOn(WidgetTester tester) => tester.widget<SwitchListTile>(stretch).value;

void main() {
  testWidgets('a new poster: Regangkan gambar is on, with its one-line help', (tester) async {
    await open(tester, '/content/poster/new');
    await reveal(tester, stretch);
    expect(find.text('Regangkan gambar'), findsOneWidget);
    expect(find.text('Ya: gambar memenuhi ruang, bentuk mungkin berubah. Tidak: gambar penuh, bentuk asal.'), findsOneWidget);
    expect(isOn(tester), isTrue);
  });

  testWidgets('a saved poster without the field shows on; turning it off saves stretch false', (tester) async {
    final h = await open(tester, '/content/poster/o1');
    await reveal(tester, stretch);
    expect(isOn(tester), isTrue, reason: 'absent means Yes');
    await tester.tap(stretch);
    await settle(tester);
    expect(isOn(tester), isFalse);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect((jsonDecode(put.body) as Map)['stretch'], false);
  });

  testWidgets('saving a saved poster left untouched sends no stretch (absent is Yes)', (tester) async {
    final h = await open(tester, '/content/poster/o1');
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect((jsonDecode(put.body) as Map).containsKey('stretch'), isFalse);
  });

  testWidgets('a poster saved with stretch false shows off, and keeps sending false', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.content['poster']![1]['stretch'] = false;
    h.router.go('/content/poster/o2');
    await settle(tester);
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await reveal(tester, stretch);
    expect(isOn(tester), isFalse);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect((jsonDecode(put.body) as Map)['stretch'], false);
  });

  testWidgets('an older box (no features) does not get the switch, and a save sends no stretch', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], health: {...healthyJson}..remove('features'));
    h.router.go('/content/poster/o1');
    await settle(tester);
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    expect(stretch, findsNothing);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect((jsonDecode(put.body) as Map).containsKey('stretch'), isFalse);
  });
}
