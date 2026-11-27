// The zikir list in Kandungan links to "Tetapan paparan zikir" (the
// Zikir selepas solat settings): only on that kind, only with the right to
// open the settings form.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/screens/content_list_screen.dart';

import '../features/shell/harness.dart';

Finder get link => find.byKey(const ValueKey('content-zikir-settings'));

void main() {
  testWidgets('the zikir list shows the link and it opens the zikir settings', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.router.go('/content/zikir');
    await settle(tester);
    expect(link, findsOneWidget);
    expect(find.text('Tetapan paparan zikir'), findsOneWidget);
    expect(find.text('Bila zikir bermula, tempoh setiap zikir, jam dan rupa skrin'), findsOneWidget);
    await tester.ensureVisible(link);
    await tester.tap(link);
    await settle(tester);
    expect(h.location, '/settings/zikirSelepasSolat');
  });

  testWidgets('another kind\'s list has no such link', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    h.router.go('/content/kuliah');
    await settle(tester);
    expect(find.text('Tambah kuliah'), findsOneWidget);
    expect(link, findsNothing);
  });

  testWidgets('without the right to open the settings the link is not shown', (tester) async {
    Future<void> pumpWith(Set<String> roles) => tester.pumpWidget(
      ProviderScope(
        overrides: [rolesProvider.overrideWithValue(roles)],
        child: const MaterialApp(
          localizationsDelegates: S.localizationsDelegates,
          supportedLocales: S.supportedLocales,
          locale: Locale('ms'),
          home: Scaffold(body: ZikirSettingsLink()),
        ),
      ),
    );
    await pumpWith({'admin'});
    expect(link, findsOneWidget);
    await pumpWith(<String>{});
    expect(link, findsNothing);
    await pumpWith({'nosuchrole'});
    expect(link, findsNothing);
  });
}
