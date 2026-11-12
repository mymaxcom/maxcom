// Theme golden: a sample settings page (app bar "Tetapan", one switch,
// one primary button) at phone, iPad mini portrait and landscape.
//
// Regenerate with `flutter test --update-goldens`, then open the PNGs in
// test/goldens/ and look at them.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../golden_sizes.dart';

Widget _sampleApp() {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: SurauTheme.light(),
    locale: const Locale('ms'),
    localizationsDelegates: S.localizationsDelegates,
    supportedLocales: S.supportedLocales,
    home: const _SamplePage(),
  );
}

class _SamplePage extends StatelessWidget {
  const _SamplePage();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.settingsTitle)),
      body: SurauTheme.page(
        children: [
          Card(
            child: Column(
              children: [
                SwitchListTile(
                  value: true,
                  onChanged: (_) {},
                  title: const Text('Paparkan kuliah di skrin'),
                  subtitle: const Text(
                    'Kuliah minggu ini dipaparkan di bawah jam.',
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: () {},
            child: Text(s.actionSave),
          ),
        ],
      ),
    );
  }
}

void main() {
  testWidgets('theme sample page at phone and iPad mini sizes',
      (tester) async {
    await expectGoldens(tester, _sampleApp(), 'theme_sample');
  });

  testWidgets('theme uses Plus Jakarta Sans and 48 px tap targets',
      (tester) async {
    final theme = SurauTheme.light();
    expect(theme.textTheme.bodyLarge?.fontFamily, 'PlusJakartaSans');
    expect(theme.useMaterial3, isTrue);
    final buttonMin =
        theme.filledButtonTheme.style?.minimumSize?.resolve(const {});
    expect(buttonMin, isNotNull);
    expect(buttonMin!.height, greaterThanOrEqualTo(SurauTheme.minTapSize));
    expect(theme.materialTapTargetSize, MaterialTapTargetSize.padded);
  });
}
