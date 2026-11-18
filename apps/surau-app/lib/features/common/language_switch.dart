// `BM | EN | ع`: the language of this phone's app, on the dashboard header
// and the top bars of the first-time screens (enrol, setup, recovery).
// Compact (32 dp high) and segmented, gold for the language in use. It
// changes this phone only: nothing is sent to the box or the cloud.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_lang.dart';
import '../../app/theme.dart';

class LanguageSwitch extends ConsumerWidget {
  const LanguageSwitch({super.key});

  static const double height = 32;

  static const _labels = {AppLang.ms: 'BM', AppLang.en: 'EN', AppLang.ar: 'ع'};

  /// Each language named in itself, for screen readers.
  static const _names = {
    AppLang.ms: 'Bahasa Melayu',
    AppLang.en: 'English',
    AppLang.ar: 'العربية',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(appLangProvider);
    return Container(
      height: height,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: SurauColors.gold.withValues(alpha: 0.45)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        // Always BM, EN, then Arabic, in reading order of the page.
        children: [
          for (final lang in AppLang.values)
            _Option(
              key: ValueKey('lang-${lang.code}'),
              label: _labels[lang]!,
              name: _names[lang]!,
              arabic: lang == AppLang.ar,
              selected: lang == current,
              onTap: lang == current ? null : () => ref.read(appLangProvider.notifier).set(lang),
            ),
        ],
      ),
    );
  }
}

class _Option extends StatelessWidget {
  const _Option({
    super.key,
    required this.label,
    required this.name,
    required this.arabic,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final String name;
  final bool arabic;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: name,
      excludeSemantics: true,
      child: Material(
        color: selected ? SurauColors.gold : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            constraints: const BoxConstraints(minWidth: 36),
            padding: const EdgeInsets.symmetric(horizontal: 6),
            alignment: Alignment.center,
            child: Text(
              label,
              textDirection: arabic ? TextDirection.rtl : TextDirection.ltr,
              style: TextStyle(
                fontFamily: arabic ? 'NotoNaskhArabic' : SurauTheme.fontFamily,
                fontSize: arabic ? 17 : 13.5,
                height: 1,
                fontWeight: FontWeight.w700,
                color: selected ? SurauColors.ink : const Color(0xFFD9E5E2),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
