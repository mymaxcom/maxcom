// The Pentadbir MAXCOM in the ops build: the badge, the forced lock and the
// lock row of this device. Plan 14 Task 25 moved these into lib/ops/; the
// tests run under --dart-define=MAXCOM_OPS=true and are skipped in the public
// build (public_build_test.dart covers that side). Granting the role has no
// screen: the cloud CLI only.

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../../golden_sizes.dart';
import 'harness.dart';

Future<ShellHarness> open(
  WidgetTester tester,
  List<String> roles, {
  String path = '/',
  GoldenSize size = GoldenSize.phone,
  List<Override> overrides = const [],
}) async {
  final h = await pumpShell(tester, roles: roles, size: size, overrides: overrides);
  if (path != '/') {
    h.router.go(path);
    await settle(tester);
  }
  return h;
}

void main() {
  testWidgets('the shield shows for a Pentadbir MAXCOM and for nobody else', (tester) async {
    await open(tester, const ['admin', 'superadmin'], path: '/settings');
    expect(find.byKey(const ValueKey('superadmin-badge')), findsOneWidget);
    await open(tester, const ['admin'], path: '/settings');
    expect(find.byKey(const ValueKey('superadmin-badge')), findsNothing);
  }, skip: !kOpsBuild);

  testWidgets('the rail carries the full badge on the iPad', (tester) async {
    await open(tester, const ['superadmin'], size: GoldenSize.ipadMiniLandscape);
    expect(find.text('Pentadbir MAXCOM'), findsWidgets);
    await open(tester, const ['admin'], size: GoldenSize.ipadMiniLandscape);
    expect(find.byKey(const ValueKey('superadmin-badge')), findsNothing);
  }, skip: !kOpsBuild);

  testWidgets('the shield in the app bar reads on the dark glass (gold, not teal)', (tester) async {
    await open(tester, const ['admin', 'superadmin'], path: '/settings');
    final icon = tester.widget<Icon>(
      find.descendant(of: find.byKey(const ValueKey('superadmin-badge')), matching: find.byType(Icon)),
    );
    expect(icon.color, SurauColors.gold);
    expect(icon.color, isNot(SurauColors.teal));
  }, skip: !kOpsBuild);

  testWidgets('the narrow rail (iPad portrait) shows the role name whole, not cut to "Pent..."', (tester) async {
    await open(tester, const ['superadmin'], size: GoldenSize.ipadMiniPortrait);
    final badge = find.byKey(const ValueKey('superadmin-badge'));
    expect(badge, findsOneWidget);
    final text = find.descendant(of: badge, matching: find.byType(Text));
    expect(text, findsWidgets);
    for (final e in text.evaluate()) {
      final w = e.widget as Text;
      final para = tester.renderObject<RenderParagraph>(find.byWidget(w));
      // every word of the name fits the line it is on: the paragraph is as wide as its widest word needs
      for (final word in 'Pentadbir MAXCOM'.split(' ')) {
        final tp = TextPainter(
          text: TextSpan(text: word, style: DefaultTextStyle.of(e).style.merge(w.style)),
          textDirection: TextDirection.ltr,
        )..layout();
        expect(para.size.width, greaterThanOrEqualTo(tp.width - 0.5), reason: 'the word "$word" is cut');
      }
      expect(para.didExceedMaxLines, isFalse);
    }
    expect(find.descendant(of: badge, matching: find.text('Pentadbir MAXCOM')), findsOneWidget);
  }, skip: !kOpsBuild);

  testWidgets('the lock is on for a Pentadbir MAXCOM whatever the surau says, off for an admin', (tester) async {
    final h = await open(tester, const ['superadmin']);
    expect(h.container.read(isSuperadminProvider), isTrue);
    expect(h.container.read(appLockProvider), isTrue);
    expect(h.container.read(effectiveLockProvider), isTrue);
  }, skip: !kOpsBuild);

  testWidgets('this device: the always-on lock row for a Pentadbir MAXCOM only', (tester) async {
    await open(tester, const ['superadmin'], path: '/this-device');
    expect(find.byKey(const ValueKey('this-device-lock-always')), findsOneWidget);
    await open(tester, const ['admin'], path: '/this-device');
    expect(find.byKey(const ValueKey('this-device-lock-always')), findsNothing);
  }, skip: !kOpsBuild);
}
