// The app's own notice when the preview page cannot be loaded.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/content/preview_guard.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/main.dart' show defaultLocale;

Widget _app(Widget child) => MaterialApp(
  theme: SurauTheme.light(),
  locale: defaultLocale,
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(body: SizedBox(width: 400, height: 225, child: child)),
);

const _line = 'Pratonton tidak dapat dipaparkan. Semak sambungan rangkaian, kemudian cuba lagi.';

void main() {
  testWidgets('a load error swaps the host for the notice; retry builds the host again', (tester) async {
    VoidCallback? fail;
    final attempts = <int>[];
    await tester.pumpWidget(
      _app(
        PreviewGuard(
          resetKey: 'a',
          builder: (context, onLoadError, attempt) {
            fail = onLoadError;
            attempts.add(attempt);
            return const Text('host', key: ValueKey('host'));
          },
        ),
      ),
    );
    expect(find.byKey(const ValueKey('host')), findsOneWidget);
    expect(find.text(_line), findsNothing);

    fail!();
    await tester.pump();
    expect(find.byKey(const ValueKey('host')), findsNothing);
    expect(find.text(_line), findsOneWidget);
    expect(find.text('Cuba lagi'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('preview-load-retry')));
    await tester.pump();
    expect(find.byKey(const ValueKey('host')), findsOneWidget);
    expect(find.text(_line), findsNothing);
    expect(attempts.last, greaterThan(attempts.first), reason: 'the host is rebuilt with a new attempt');
  });

  testWidgets('a new address (reset key) clears the failure and loads again', (tester) async {
    VoidCallback? fail;
    Widget guard(Object key) => _app(
      PreviewGuard(
        resetKey: key,
        builder: (context, onLoadError, attempt) {
          fail = onLoadError;
          return const Text('host', key: ValueKey('host'));
        },
      ),
    );
    await tester.pumpWidget(guard('old'));
    fail!();
    await tester.pump();
    expect(find.text(_line), findsOneWidget);

    await tester.pumpWidget(guard('new'));
    expect(find.byKey(const ValueKey('host')), findsOneWidget);
    expect(find.text(_line), findsNothing);
  });

  testWidgets('the notice fits the TV frame at a small size', (tester) async {
    await tester.pumpWidget(_app(PreviewFailedNotice(onRetry: () {})));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('preview-load-failed')), findsOneWidget);
  });
}
