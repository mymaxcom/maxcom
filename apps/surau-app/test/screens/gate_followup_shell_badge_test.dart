// Gate follow-up item 2: the running-jobs count is drawn on the upload
// entry of the shell's navigation (side rail and bottom bar), and nowhere
// when no job runs.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/upload/upload_widgets.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<void> _shell(
  WidgetTester tester,
  int count,
  GoldenSize size, {
  List<String> roles = const ['media'],
}) async {
  await pumpShell(
    tester,
    roles: roles,
    features: const {'youtubeCatchUp': true},
    size: size,
    overrides: [catchUpActiveCountProvider.overrideWith((ref) => count)],
  );
  await settle(tester);
}

Finder get _navBadge => find.byKey(const ValueKey('nav-badge'));

void main() {
  for (final size in [
    GoldenSize.phone,
    GoldenSize.ipadMiniPortrait,
    GoldenSize.ipadMiniLandscape,
  ]) {
    testWidgets('${size.name}: the upload entry shows the running count', (
      tester,
    ) async {
      await _shell(tester, 3, size);
      expect(_navBadge, findsOneWidget);
      expect(find.descendant(of: _navBadge, matching: find.text('3')),
          findsOneWidget);
      // the badge sits on the upload entry (on the phone that entry is
      // behind "Lagi" for this role, so the Lagi button carries it)
      final upload = find.ancestor(
        of: find.text('Muat naik YouTube'),
        matching: find.byType(InkWell),
      );
      if (upload.evaluate().isNotEmpty) {
        expect(
          find.descendant(of: upload.first, matching: _navBadge),
          findsOneWidget,
        );
      } else {
        expect(size, GoldenSize.phone);
      }
    });

    testWidgets('${size.name}: no running job, no badge', (tester) async {
      await _shell(tester, 0, size);
      expect(_navBadge, findsNothing);
    });
  }

  testWidgets('phone: an upload entry behind "Lagi" badges the Lagi button '
      'and its row in the sheet', (tester) async {
    await _shell(tester, 2, GoldenSize.phone, roles: const ['admin']);
    expect(find.text('Muat naik YouTube'), findsNothing);
    expect(_navBadge, findsOneWidget);
    await tester.tap(find.text('Lagi'));
    await settle(tester);
    expect(find.byKey(const ValueKey('sheet-badge')), findsOneWidget);
  });
}
