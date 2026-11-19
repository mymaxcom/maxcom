// Bahasa skrin TV: Automatik, Bahasa Melayu, English and العربية. A box from
// before Arabic (its health does not list `tvLangAr`) would answer 400, so the
// Arabic choice is left out for it and a short note says why. While the box is
// not known (offline, loading) nothing is hidden.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../l10n/generated/s.dart';
import '../settings_form.dart' show ChoiceField;

/// The `tvLangAr` mark of a box that accepts `language.lang = 'ar'`.
const String tvLangArFeature = 'tvLangAr';

/// The choices of the TV language that the box accepts: [all] minus `ar` for a box without [tvLangArFeature]
/// (a value already `ar` stays, so a saved choice never vanishes from view).
List<String> tvLangChoices(List<String> all, {required bool boxHasArabic, String? current}) =>
    boxHasArabic || current == 'ar' ? all : [for (final c in all) if (c != 'ar') c];

class TvLangChoice extends ConsumerWidget {
  const TvLangChoice({
    super.key,
    required this.path,
    required this.name,
    required this.label,
    required this.value,
    required this.choices,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String name;
  final String label;
  final String value;
  final List<String> choices;
  final void Function(String value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasArabic = ref.watch(boxSupportsProvider(tvLangArFeature));
    final shown = tvLangChoices(choices, boxHasArabic: hasArabic, current: value);
    return ChoiceField(
      path: path,
      name: name,
      label: label,
      value: value,
      choices: shown,
      error: error,
      readOnly: readOnly,
      onChanged: onChanged,
      help: shown.length == choices.length ? null : S.of(context).tvLangArNeedsUpdate,
    );
  }
}
