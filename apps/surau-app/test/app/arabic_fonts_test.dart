// The bundled Arabic fonts (assets/fonts/ARABIC-FONTS.md): a Quran line in
// the Quran style (QPC Hafs, Amiri Quran behind it) and a surah name in
// the UI fallback (Noto Naskh Arabic) shape correctly with no download,
// as on the box's web build under `font-src 'self'`. Golden: arabic_fonts
// (phone). Open the PNG: joined letters, harakat in place, no tofu.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../golden_sizes.dart';

const bismillah = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
const alFatihah = 'الفاتحة';

Widget _page() => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Builder(
    builder: (context) {
      final text = Theme.of(context).textTheme;
      return Scaffold(
        appBar: AppBar(title: const Text('Al-Quran')),
        body: SurauTheme.page(
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('Surah Al-Fatihah', style: text.titleMedium),
                        ),
                        Text(alFatihah, style: text.titleLarge),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      bismillah,
                      textDirection: TextDirection.rtl,
                      textAlign: TextAlign.center,
                      style: SurauTheme.quranTextStyle,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Dengan nama Allah Yang Maha Pemurah lagi Maha Mengasihani.',
                      textAlign: TextAlign.center,
                      style: text.bodyLarge,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    },
  ),
);

void main() {
  testWidgets('Quran style and Arabic fallback use the bundled families', (
    tester,
  ) async {
    expect(SurauTheme.quranTextStyle.fontFamily, 'QpcHafs');
    expect(SurauTheme.quranTextStyle.fontFamilyFallback, contains('AmiriQuran'));
    expect(SurauTheme.quranTextStyle.height, greaterThanOrEqualTo(1.8));
    final theme = SurauTheme.light();
    expect(theme.textTheme.bodyLarge?.fontFamilyFallback, contains('NotoNaskhArabic'));
    expect(theme.textTheme.titleLarge?.fontFamilyFallback, contains('NotoNaskhArabic'));
    expect(theme.textTheme.bodyLarge?.fontFamily, 'PlusJakartaSans', reason: 'Latin first');

    final page = _page();
    await pumpAtSize(tester, page, GoldenSize.phone);
    expect(find.text(bismillah), findsOneWidget);
    expect(find.text(alFatihah), findsOneWidget);
    expect(tester.takeException(), isNull);
    await expectGoldens(tester, page, 'arabic_fonts', sizes: const [GoldenSize.phone]);
  });
}
