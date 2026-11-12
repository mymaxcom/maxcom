import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/deps.dart';
import 'app/providers.dart';
import 'app/router.dart';
import 'app/theme.dart';
import 'l10n/generated/s.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final deps = await AppDeps.forPlatform();
  runApp(
    ProviderScope(
      overrides: [appDepsProvider.overrideWithValue(deps)],
      child: const SurauApp(),
    ),
  );
}

/// BM is the app's language; English comes later via the `language`
/// feature.
const Locale defaultLocale = Locale('ms');

/// The whole app under a [ProviderScope] that overrides [appDepsProvider]
/// (the real platform in [main], fakes in tests).
class SurauApp extends ConsumerWidget {
  const SurauApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      onGenerateTitle: (context) => S.of(context).appTitle,
      debugShowCheckedModeBanner: false,
      theme: SurauTheme.light(),
      locale: defaultLocale,
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      routerConfig: ref.watch(routerProvider),
    );
  }
}
