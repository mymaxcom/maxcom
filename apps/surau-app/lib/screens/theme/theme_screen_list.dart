// The screens of the Ubah suai editor: chips on a phone, a grouped list on an
// iPad. A gold dot marks a screen with values of its own.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../features/registry.g.dart' show screenGroups;
import '../../l10n/generated/s.dart';
import '../preview_screen.dart' show themeEditorScreens;

/// The name of a catalog screen as the surau reads it.
String themeScreenName(S s, String id) => switch (id) {
  'biasa' => s.themeScreenBiasa,
  'azan' => s.themeScreenAzan,
  'masuk-waktu' => s.themeScreenMasukWaktu,
  'iqamah' => s.themeScreenIqamah,
  'solat' => s.themeScreenSolat,
  'jumaat' => s.themeScreenJumaat,
  'live' => s.themeScreenLive,
  'poster' => s.themeScreenPoster,
  'kuliah' => s.themeScreenKuliah,
  'program' => s.themeScreenProgram,
  'hadis' => s.themeScreenHadis,
  'zikir' => s.themeScreenZikir,
  'pengumuman' => s.themeScreenPengumuman,
  'takwim' => s.themeScreenTakwim,
  'tabung' => s.themeScreenTabung,
  'ayat' => s.themeScreenAyat,
  'arab-ayat' => s.themeScreenArabAyat,
  'arab-zikir' => s.themeScreenArabZikir,
  'arab-hadis' => s.themeScreenArabHadis,
  _ => id,
};

class _Dot extends StatelessWidget {
  const _Dot();

  @override
  Widget build(BuildContext context) => Container(
    width: 8,
    height: 8,
    decoration: const BoxDecoration(color: SurauColors.gold, shape: BoxShape.circle),
  );
}

/// Phone: one wrapped row of chips.
class ThemeScreenChips extends StatelessWidget {
  const ThemeScreenChips({super.key, required this.selected, required this.changed, required this.onSelect});

  final String selected;
  final Set<String> changed;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: [
        for (final id in themeEditorScreens)
          ChoiceChip(
            key: ValueKey('theme-screen-$id'),
            selected: selected == id,
            onSelected: (_) => onSelect(id),
            avatar: changed.contains(id) ? const _Dot() : null,
            label: Text(themeScreenName(s, id)),
          ),
      ],
    );
  }
}

/// iPad: the screens in two groups, Waktu solat and Kandungan.
class ThemeScreenList extends StatelessWidget {
  const ThemeScreenList({super.key, required this.selected, required this.changed, required this.onSelect});

  final String selected;
  final Set<String> changed;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    Widget group(String title, String g) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 12, 8, 4),
          child: Text(title, style: text.labelLarge!.copyWith(color: SurauColors.muted)),
        ),
        for (final id in themeEditorScreens.where((e) => screenGroups[e] == g))
          ListTile(
            key: ValueKey('theme-screen-$id'),
            dense: true,
            visualDensity: VisualDensity.compact,
            minVerticalPadding: 0,
            selected: selected == id,
            selectedTileColor: SurauColors.tealSoft,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
            title: Text(themeScreenName(s, id)),
            trailing: changed.contains(id) ? const _Dot() : null,
            onTap: () => onSelect(id),
          ),
      ],
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [group(s.themeGroupPrayer, 'prayer'), group(s.themeGroupContent, 'content'), group(s.themeGroupArab, 'arabic')],
    );
  }
}
