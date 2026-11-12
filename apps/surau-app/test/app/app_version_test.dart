// The MAX Admin Client version: the compile-time default equals pubspec.yaml,
// and the Lagi sheet shows it as `MAX Admin Client <versi>`.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_version.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

void main() {
  test('the default version equals the pubspec.yaml version', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final m = RegExp(
      r'^version:\s*([^\s+]+)\+(\d+)',
      multiLine: true,
    ).firstMatch(pubspec)!;
    expect(m.group(1), appVersion);
    expect(appVersionLine, 'MAX Admin Client ${m.group(1)}');
    expect(appVersion, matches(RegExp(r'^20\d\d\.(0[1-9]|1[0-2])\.\d{1,2}$')));
    // build number = (YY*10000 + MM*100 + N) * 10
    final p = appVersion.split('.').map(int.parse).toList();
    expect(
      int.parse(m.group(2)!),
      ((p[0] - 2000) * 10000 + p[1] * 100 + p[2]) * 10,
    );
  });

  testWidgets('the Lagi sheet ends with the app version', (tester) async {
    await pumpShell(tester, roles: const ['admin'], size: GoldenSize.phone);
    await settle(tester);
    await tester.tap(find.text('Lagi'));
    await settle(tester);
    expect(find.byKey(const ValueKey('app-version')), findsOneWidget);
    expect(find.text('MAX Admin Client $appVersion'), findsOneWidget);
  });
}
