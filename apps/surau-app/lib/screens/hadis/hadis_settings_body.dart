// `Tetapan > Hadis`: where hadis come from, the order, the turnover, what is
// shown on the TV and which grades may be. The switch, `Simpan` and `Set
// semula` stay the feature screen's; this is only the body, handing every
// change back through [HadisSettingsBody.onChanged]. `Hari ini di TV` and the
// preview follow the form as it is, before it is saved.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../hadis/hadis_api.dart';
import '../../hadis/hadis_list_controller.dart';
import '../../hadis/hadis_rules.dart';
import '../../hadis/hadis_tv_rules.dart';
import '../../l10n/generated/s.dart';
import '../widgets/pieces.dart';
import 'hadis_list_screen.dart' show hadisTwoColumnsFrom;
import 'widgets/hadis_tags.dart';
import 'widgets/hadis_tv_preview.dart';

class HadisSettingsBody extends ConsumerStatefulWidget {
  const HadisSettingsBody({
    super.key,
    required this.values,
    required this.errors,
    required this.readOnly,
    required this.onChanged,
  });

  /// The `hadis` feature's values (the form's, unsaved).
  final Map<String, dynamic> values;
  final Map<String, String> errors;
  final bool readOnly;
  final void Function(String key, Object? value) onChanged;

  @override
  ConsumerState<HadisSettingsBody> createState() => _HadisSettingsBodyState();
}

class _HadisSettingsBodyState extends ConsumerState<HadisSettingsBody> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (!mounted) return;
      if (!ref.read(hadisListProvider).loaded) {
        unawaited(ref.read(hadisListProvider.notifier).load());
      }
    });
  }

  Map<String, dynamic> get v => widget.values;

  void Function(T)? _change<T>(void Function(T) f) => widget.readOnly ? null : f;

  Widget _radio(S s, String value, String title, String desc, {Widget? badge}) {
    final selected = v['source'] == value;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: selected ? const Color(0xFFF8FCFB) : SurauColors.card,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(
            color: selected ? SurauColors.teal : SurauColors.line,
            width: selected ? 2 : 1,
          ),
        ),
        child: InkWell(
          key: ValueKey('hadis-src-$value'),
          borderRadius: BorderRadius.circular(16),
          onTap: widget.readOnly ? null : () => widget.onChanged('source', value),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  selected ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded,
                  size: 22,
                  color: selected ? SurauColors.teal : SurauColors.outline,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(title, style: text.titleSmall!.copyWith(fontWeight: FontWeight.w700)),
                          ?badge,
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(desc, style: text.bodySmall!.copyWith(fontSize: 14)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _switchRow(String key, String title, String help, {bool last = false}) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 12, 10),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    Text(help, style: text.bodySmall!.copyWith(fontSize: 13.5)),
                  ],
                ),
              ),
              Switch(
                key: ValueKey('hadis-field-$key'),
                value: v[key] != false,
                onChanged: _change<bool>((x) => widget.onChanged(key, x)),
              ),
            ],
          ),
        ),
        if (!last) const Divider(),
      ],
    );
  }

  Widget _labelled(String label, Widget child, {String? help, String? value}) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(label, style: text.titleSmall)),
              if (value != null)
                Text(
                  value,
                  style: text.titleSmall!.copyWith(fontSize: 15, fontWeight: FontWeight.w700, color: SurauColors.teal),
                ),
            ],
          ),
          const SizedBox(height: 10),
          child,
          if (help != null) ...[
            const SizedBox(height: 6),
            Text(help, style: text.bodySmall),
          ],
        ],
      ),
    );
  }

  Widget _stepperRow(String title, String help, Widget stepper) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: text.titleSmall),
                Text(help, style: text.bodySmall!.copyWith(fontSize: 13.5)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          stepper,
        ],
      ),
    );
  }

  int _int(String key, int fallback) => v[key] is num ? (v[key] as num).toInt() : fallback;

  List<Widget> _leftColumn(S s, List<HadisItem> items, List<HadisItem> pool) {
    final text = Theme.of(context).textTheme;
    final own = items.where((i) => !i.isProvider).toList();
    final he = items.where((i) => i.isProvider).toList();
    final source = v['source'] as String? ?? 'both';
    final both = source == 'both';
    final mix = v['mix'] as String? ?? 'list';
    final changeDay = (v['changeEvery'] as String? ?? 'day') == 'day';
    final perDay = _int('perDay', 3);
    final duration = _int('durationSeconds', 20);
    final visible = pool.take(10).toList();
    final mixHelp = switch (both ? mix : (mix == 'alternate' ? 'list' : mix)) {
      'alternate' => s.hadisMixAlternateHelp,
      'random' => s.hadisMixRandomHelp,
      _ => s.hadisMixListHelp,
    };
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 16),
        child: Text(s.hadisSettingsIntro, style: text.bodyLarge!.copyWith(fontSize: 16, color: SurauColors.muted)),
      ),
      HadisSection(s.hadisSourceTitle, top: 4),
      _radio(s, 'own', s.hadisFilterOwn, s.hadisSourceOwnDesc(own.length, own.where((i) => i.shown).length)),
      _radio(
        s,
        'hadeethenc',
        s.hadisFilterProvider,
        s.hadisSourceProviderDesc(he.length, he.where((i) => i.onTv).length),
        badge: HadisTagChip.provider(s),
      ),
      _radio(s, 'both', s.hadisSourceBoth, s.hadisSourceBothDesc),
      const SizedBox(height: 2),
      Card(
        child: _labelled(
          s.hadisMixTitle,
          HadisSegments<String>(
            value: mix,
            onChanged: _change<String>((x) => widget.onChanged('mix', x)),
            segments: [
              HadisSegment('list', s.hadisMixList, key: const ValueKey('hadis-mix-list')),
              HadisSegment('alternate', s.hadisMixAlternate, enabled: both, key: const ValueKey('hadis-mix-alternate')),
              HadisSegment('random', s.hadisMixRandom, key: const ValueKey('hadis-mix-random')),
            ],
          ),
          help: mixHelp,
        ),
      ),
      HadisSection(s.hadisTurnTitle),
      Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _labelled(
              s.hadisChangeTitle,
              HadisSegments<String>(
                value: changeDay ? 'day' : 'card',
                onChanged: _change<String>((x) => widget.onChanged('changeEvery', x)),
                segments: [
                  HadisSegment('day', s.hadisChangeDay, key: const ValueKey('hadis-change-day')),
                  HadisSegment('card', s.hadisChangeCard, key: const ValueKey('hadis-change-card')),
                ],
              ),
              help: changeDay ? s.hadisChangeDayHelp : s.hadisChangeCardHelp,
            ),
            const Divider(),
            _stepperRow(
              s.hadisPerDay,
              changeDay ? s.hadisPerDayHelp : s.hadisPerDayNotUsed,
              HadisStepper(
                key: const ValueKey('hadis-per-day'),
                keyPrefix: 'hadis-per',
                value: perDay,
                label: '$perDay',
                min: 1,
                max: 10,
                dim: !changeDay,
                onChanged: changeDay ? _change<int>((x) => widget.onChanged('perDay', x)) : null,
              ),
            ),
            const Divider(),
            _stepperRow(
              s.hadisDuration,
              s.hadisDurationHelp,
              HadisStepper(
                keyPrefix: 'hadis-dur',
                value: duration,
                label: s.hadisSeconds(duration),
                min: 5,
                max: 120,
                step: 5,
                onChanged: _change<int>((x) => widget.onChanged('durationSeconds', x)),
              ),
            ),
          ],
        ),
      ),
      HadisSection(s.hadisTodayTitle),
      Card(
        key: const ValueKey('hadis-today'),
        child: pool.isEmpty
            ? Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 26),
                child: Text(
                  s.hadisTodayEmpty,
                  textAlign: TextAlign.center,
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < visible.length; i++) ...[
                    if (i > 0) const Divider(),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 64,
                            child: Text(
                              s.hadisTodayItem(i + 1),
                              style: text.labelMedium!.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: SurauColors.teal),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              visible[i].title ?? visible[i].textMs,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: text.bodyMedium!.copyWith(fontSize: 14),
                            ),
                          ),
                          const SizedBox(width: 10),
                          visible[i].isProvider ? HadisTagChip.provider(s) : HadisTagChip.own(s),
                        ],
                      ),
                    ),
                  ],
                  if (pool.length > visible.length) ...[
                    const Divider(),
                    Padding(
                      padding: const EdgeInsets.all(10),
                      child: Text(
                        s.hadisTodayMore(pool.length - visible.length),
                        textAlign: TextAlign.center,
                        style: text.bodySmall,
                      ),
                    ),
                  ],
                ],
              ),
      ),
    ];
  }

  List<Widget> _rightColumn(S s, List<HadisItem> items, List<HadisItem> pool, bool twoColumns) {
    final text = Theme.of(context).textTheme;
    final font = v['fontSize'] as String? ?? 'auto';
    final allowed = v['allowedGrades'] is Map ? v['allowedGrades'] as Map<dynamic, dynamic> : const <dynamic, dynamic>{};
    final fontLabel = switch (font) {
      's' => s.hadisFontSmall,
      'm' => s.hadisFontMedium,
      'l' => s.hadisFontLarge,
      _ => s.hadisFontAutoLong,
    };
    final previewItem = pool.isNotEmpty ? pool.first : (items.isNotEmpty ? items.first : null);
    final preview = previewItem != null
        ? HadisPreviewData.fromItem(previewItem)
        : HadisPreviewData(textMs: s.hadisPreviewSample, attribution: s.hadisPreviewSampleSource);
    return [
      HadisSection(s.hadisDisplayTitle, top: twoColumns ? 4 : 20),
      Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _switchRow('showArabic', s.hadisFieldArabic, s.hadisFieldArabicHelp),
            _switchRow('showMalay', s.hadisFieldMalay, s.hadisFieldMalayHelp),
            _switchRow('showAttribution', s.hadisFieldAttribution, s.hadisFieldAttributionHelp),
            _switchRow('showGrade', s.hadisFieldGrade, s.hadisFieldGradeHelp),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 10, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(s.hadisFieldCredit, style: text.titleSmall),
                        Text(s.hadisFieldCreditHelp, style: text.bodySmall!.copyWith(fontSize: 13.5)),
                      ],
                    ),
                  ),
                  HadisTagChip.attribution(s.hadisRequired),
                  const Switch(key: ValueKey('hadis-field-credit'), value: true, onChanged: null),
                ],
              ),
            ),
            const Divider(),
            _labelled(
              s.hadisFontTitle,
              HadisSegments<String>(
                value: font,
                onChanged: _change<String>((x) => widget.onChanged('fontSize', x)),
                segments: [
                  HadisSegment('auto', s.hadisFontAuto, key: const ValueKey('hadis-font-auto')),
                  HadisSegment('s', s.hadisFontSmall, key: const ValueKey('hadis-font-s')),
                  HadisSegment('m', s.hadisFontMedium, key: const ValueKey('hadis-font-m')),
                  HadisSegment('l', s.hadisFontLarge, key: const ValueKey('hadis-font-l')),
                ],
              ),
              value: fontLabel,
              help: s.hadisFontHelp,
            ),
          ],
        ),
      ),
      HadisSection(s.hadisPreviewTitle),
      HadisTvPreview(key: const ValueKey('hadis-settings-preview'), data: preview, settings: v),
      Padding(
        padding: const EdgeInsets.fromLTRB(2, 6, 2, 0),
        child: Text(s.hadisPreviewHelp, style: text.bodySmall),
      ),
      HadisSection(s.hadisGradesTitle),
      Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < hadisGrades.length; i++) ...[
              if (i > 0) const Divider(),
              _gradeRow(s, hadisGrades[i], allowed),
            ],
            Container(
              color: SurauColors.paper,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              child: Row(
                children: [
                  const Icon(Icons.info_outline_rounded, size: 16, color: SurauColors.muted),
                  const SizedBox(width: 8),
                  Expanded(child: Text(s.hadisGradesNote, style: text.bodySmall!.copyWith(fontSize: 12))),
                ],
              ),
            ),
          ],
        ),
      ),
    ];
  }

  Widget _gradeRow(S s, HadisGradeRow g, Map<dynamic, dynamic> allowed) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 8, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(g.ms, style: text.titleSmall!.copyWith(fontSize: 15.5)),
                Text(g.note, style: text.bodySmall!.copyWith(fontSize: 12.5)),
              ],
            ),
          ),
          Text(
            g.ar,
            textDirection: TextDirection.rtl,
            style: const TextStyle(
              fontFamily: 'NotoNaskhArabic',
              fontSize: 18,
              color: SurauColors.muted,
            ),
          ),
          const SizedBox(width: 12),
          Tooltip(
            message: g.allowed ? g.ms : s.hadisLocked,
            child: Switch(
              key: ValueKey('hadis-grade-${g.key}'),
              value: g.allowed && allowed[g.key] == true,
              onChanged: g.allowed
                  ? _change<bool>((x) {
                      final next = {
                        for (final e in allowed.entries) e.key as String: e.value,
                        g.key: x,
                      };
                      widget.onChanged('allowedGrades', next);
                    })
                  : null,
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final items = ref.watch(hadisListProvider.select((x) => x.items));
    final deps = ref.watch(appDepsProvider);
    final pool = hadisPool(items, v, klDateOf(deps.now()));
    final errors = widget.errors.values.toList();
    return LayoutBuilder(
      builder: (context, c) {
        final twoColumns = c.maxWidth >= hadisTwoColumnsFrom;
        final left = _leftColumn(s, items, pool);
        final right = _rightColumn(s, items, pool, twoColumns);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (twoColumns)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left)),
                  const SizedBox(width: 20),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right)),
                ],
              )
            else ...[
              ...left,
              ...right,
            ],
            if (errors.isNotEmpty) ...[
              const SizedBox(height: 16),
              ErrorLine(errors.first),
            ],
          ],
        );
      },
    );
  }
}
