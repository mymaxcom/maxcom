import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app_lang.dart';
import 'app/deps.dart';
import 'app/providers.dart';
import 'app/router.dart';
import 'app/theme.dart';
import 'box/join_address.dart';
import 'features/common/trilingual_strings.dart';
import 'features/common/trilingual_text.dart';
import 'l10n/generated/s.dart';
import 'ops/ops_build.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Plan 14 section 3.4 B belt: the compiled build switch and the installed
  // package name must agree (public id vs `.ops`), else the app does not run.
  if (!await buildIdentityOk()) {
    runApp(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: ColoredBox(
          color: Color(0xFF06302B),
          child: Center(
            child: TrilingualText(
              ms: TrilingualStrings.badBuildMs,
              en: TrilingualStrings.badBuildEn,
              ar: TrilingualStrings.badBuildAr,
              style: TextStyle(color: Color(0xFFFFFFFF), fontSize: 18),
            ),
          ),
        ),
      ),
    );
    return;
  }
  // The first frame while the app's own storage and certificates load.
  runApp(
    const Directionality(
      textDirection: TextDirection.ltr,
      child: ColoredBox(
        color: SurauColors.glass,
        child: Center(
          child: TrilingualWait(
            ms: TrilingualStrings.loadingMs,
            en: TrilingualStrings.loadingEn,
            ar: TrilingualStrings.loadingAr,
          ),
        ),
      ),
    ),
  );
  // A join ticket in the web address is taken into memory and scrubbed from the address on whatever route follows.
  captureAndScrubJoinAddress();
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
      locale: ref.watch(appLangProvider).locale,
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      routerConfig: ref.watch(routerProvider),
    );
  }
}
