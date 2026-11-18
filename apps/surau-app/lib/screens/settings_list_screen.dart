// Konfigurasi (named Tetapan until operator round 1): every feature of the
// box in its registry group, one folding card per group (a header row with
// its count and a chevron), with the search box on top that filters as you
// type and unfolds the groups it matches. Each row says what the feature is
// for. A feature that has nothing to set is a switch right on its row; the
// rest show their state (a green "Hidup" pill when on) and open a page. The
// Lanjutan group (MAXCOM system values) is last and is simply absent for
// anyone without `system:read`. Every group is folded when the app starts;
// a group opened (or the group of a search result opened) stays open while
// the app runs, so coming back from a feature finds it as it was.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/app_lang.dart';
import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../features/labels.dart';
import '../features/labels_ms.dart';
import '../features/registry.g.dart';
import '../features/settings_repository.dart';
import '../features/settings_search.dart';
import '../features/shell/permissions.dart';
import '../ops/lanjutan_card.dart';
import '../ops/lanjutan_group.dart';
import '../ops/ops_build.dart';
import '../ops/system_labels_ms.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// The groups opened in this run of the app; empty (all folded) at start.
class SettingsOpenGroups extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  void toggle(String group) {
    final next = {...state};
    if (!next.remove(group)) next.add(group);
    state = next;
  }

  void open(String group) {
    if (!state.contains(group)) state = {...state, group};
  }
}

final settingsOpenGroupsProvider = NotifierProvider<SettingsOpenGroups, Set<String>>(SettingsOpenGroups.new);

class SettingsListScreen extends ConsumerStatefulWidget {
  const SettingsListScreen({super.key});

  @override
  ConsumerState<SettingsListScreen> createState() => _SettingsListScreenState();
}

class _SettingsListScreenState extends ConsumerState<SettingsListScreen> {
  final _search = TextEditingController();
  String _q = '';

  void _toggle(String group) => ref.read(settingsOpenGroupsProvider.notifier).toggle(group);

  void _clear() {
    _search.clear();
    setState(() => _q = '');
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final roles = ref.watch(rolesProvider);
    final canWrite = canSee(roles, 'settings:write');
    final location = settings['location'];
    final outsideMalaysia = location is Map && location['country'] is String && location['country'] != 'MY';
    bool isOn(FeatureDef f) {
      final box = settings[f.key];
      final enabled = box is Map ? box['enabled'] : null;
      return f.locked || (enabled is bool ? enabled : f.defaultEnabled);
    }

    final lang = ref.watch(appLangProvider);
    final solat = groupLabel('solat', lang);
    final kandungan = groupLabel('kandungan', lang);
    final extras = [
      if (canWrite)
        SearchExtra('order', s.settingsOrderRow, kandungan, keywords: const ['giliran', 'urutan', 'susunan']),
      if (canSee(roles, 'prayer:import'))
        SearchExtra('prayer-data', s.statusPrayerData, solat, keywords: const ['import', 'csv']),
      if (canSee(roles, 'settings:read')) SearchExtra('islamic', s.settingsIslamicRow, solat),
    ];
    final searching = _q.trim().isNotEmpty;
    final openGroups = ref.watch(settingsOpenGroupsProvider);
    final hits = {
      for (final h in SettingsSearchIndex(extras: extras).search(_q, roles: roles, lang: lang)) h.feature: h,
    };
    bool shown(String key) => !searching || hits.containsKey(key);
    String? why(String key) => hits[key]?.why;

    // ---- rows of the ordinary groups ----
    List<Widget> rowsOf(String g) {
      // A row opened (from a search or not) leaves its group unfolded for the
      // way back.
      void keep() => ref.read(settingsOpenGroupsProvider.notifier).open(g);
      final rows = <Widget>[];
      if (g == 'kandungan' && canWrite && shown('order')) {
        rows.add(
          _NavRow(
            key: const ValueKey('settings-order'),
            icon: Icons.drag_handle_rounded,
            label: s.settingsOrderRow,
            hint: s.settingsOrderRowHint(orderedFeatures.length),
            why: why('order'),
            query: _q,
            tinted: true,
            onTap: () {
              keep();
              context.go(AppRoutes.settingsOrder);
            },
          ),
        );
      }
      for (final f in features) {
        if (f.group != g || !shown(f.key) || hiddenFeatures.contains(f.key)) continue;
        // Zon JAKIM is for Malaysia only (operator 2026-11-07).
        if (f.key == 'zone' && outsideMalaysia) continue;
        // The camera form is Siaran Langsung's: only holders of live:settings see it in the list.
        if (f.key == 'liveCamera' && !canSee(roles, 'live:settings')) continue;
        rows.add(
          _FeatureRow(
            key: ValueKey('settings-row-${f.key}'),
            feature: f,
            on: isOn(f),
            why: why(f.key),
            query: _q,
            canWrite: canWriteSettingsFeature(roles, f.key),
            onOpen: keep,
          ),
        );
      }
      if (g == 'solat') {
        if (canSee(roles, 'prayer:import') && shown('prayer-data')) {
          final daysAhead = ref.watch(healthProvider).value?.value.daysAhead;
          rows.add(
            _NavRow(
              key: const ValueKey('settings-prayer-data'),
              icon: Icons.calendar_month_outlined,
              label: s.statusPrayerData,
              hint: daysAhead == null ? s.settingsPrayerDataHint : s.daysLeft(daysAhead),
              why: why('prayer-data'),
              query: _q,
              onTap: () {
                keep();
                context.go(AppRoutes.prayerData);
              },
            ),
          );
        }
        if (canSee(roles, 'settings:read') && shown('islamic')) {
          rows.add(
            _NavRow(
              key: const ValueKey('settings-islamic'),
              icon: Icons.menu_book_outlined,
              label: s.settingsIslamicRow,
              hint: s.settingsIslamicHint,
              why: why('islamic'),
              query: _q,
              onTap: () {
                keep();
                context.go(AppRoutes.islamic);
              },
            ),
          );
        }
      }
      return rows;
    }

    final groups = <Widget>[];
    var total = 0;
    for (final g in groupOrder) {
      final rows = rowsOf(g);
      if (rows.isEmpty) continue;
      total += rows.length;
      final mine = features.where((f) => f.group == g && !hiddenFeatures.contains(f.key)).toList();
      groups.add(
        _Group(
          group: g,
          title: groupLabel(g, lang),
          query: _q,
          subtitle: searching
              ? s.settingsGroupMatches(rows.length)
              : s.settingsGroupCount(mine.length, mine.where(isOn).length),
          open: searching || openGroups.contains(g),
          count: searching ? rows.length : mine.length,
          onToggle: () => _toggle(g),
          children: rows,
        ),
      );
    }

    // ---- Lanjutan ----
    // The Lanjutan group exists only in the ops build (Plan 14 Task 25).
    if (kOpsBuild && canSee(roles, 'system:read')) {
      final rows = <Widget>[
        for (final r in lanjutanRowSpecs())
          if (shown(r.hitKey))
            _NavRow(
              key: ValueKey('settings-row-${r.rowKey}'),
              label: r.label,
              hint: r.hint,
              why: why(r.hitKey),
              query: _q,
              onTap: () {
                ref.read(settingsOpenGroupsProvider.notifier).open('lanjutan');
                context.go(
                  r.deepLink ? '${AppRoutes.settingsFor(r.feature)}?lj=1' : AppRoutes.settingsFor(r.feature),
                );
              },
            ),
      ];
      if (rows.isNotEmpty) {
        total += rows.length;
        groups.add(
          _Group(
            group: 'lanjutan',
            title: lanjutanGroupTitleMs,
            query: _q,
            subtitle: searching ? s.settingsGroupMatches(rows.length) : s.settingsLanjutanSubtitle,
            open: searching || openGroups.contains('lanjutan'),
            count: rows.length,
            onToggle: () => _toggle('lanjutan'),
            edgeColor: lanjutanEdge,
            badge: const PentadbirMaxcomBadge(),
            children: rows,
          ),
        );
      }
    }

    return ShellPage(
      title: s.settingsTitle,
      body: SurauTheme.page(
        children: [
          TextField(
            key: const ValueKey('settings-search'),
            controller: _search,
            onChanged: (t) => setState(() => _q = t),
            style: text.bodyLarge,
            decoration: InputDecoration(
              hintText: s.settingsSearchHint,
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: searching
                  ? IconButton(
                      key: const ValueKey('settings-search-clear'),
                      tooltip: s.settingsClearSearch,
                      icon: const Icon(Icons.close_rounded),
                      onPressed: _clear,
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 12),
          if (searching && total == 0)
            _NoResults(query: _q.trim(), onClear: _clear)
          else ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
              child: Text(
                searching
                    ? s.settingsSearchFound(total)
                    : canWrite
                    ? s.settingsListHint
                    : s.settingsReadOnlyHint,
                style: (searching ? text.bodySmall! : text.bodyMedium!).copyWith(color: SurauColors.muted),
              ),
            ),
            ...groups,
          ],
        ],
      ),
    );
  }
}

/// [source] with the first match of [query] marked; plain [Text] when there
/// is nothing to mark.
Widget _marked(String source, String query, TextStyle style) {
  final q = query.trim().toLowerCase();
  final at = q.isEmpty ? -1 : source.toLowerCase().indexOf(q);
  if (at < 0) return Text(source, style: style);
  return Text.rich(
    TextSpan(
      style: style,
      children: [
        TextSpan(text: source.substring(0, at)),
        TextSpan(
          text: source.substring(at, at + q.length),
          style: const TextStyle(backgroundColor: SurauColors.goldSoft),
        ),
        TextSpan(text: source.substring(at + q.length)),
      ],
    ),
  );
}

class _Group extends StatelessWidget {
  const _Group({
    required this.group,
    required this.title,
    required this.subtitle,
    required this.query,
    required this.open,
    required this.onToggle,
    required this.children,
    required this.count,
    this.edgeColor,
    this.badge,
  });

  /// The features of the group (its matches while searching), on the pill.
  final int count;

  final String group;
  final String title;
  final String subtitle;
  final String query;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;
  /// A group with its own edge colour and badge (the ops build's Lanjutan group); null for the rest.
  final Color? edgeColor;
  final Widget? badge;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final edge = edgeColor ?? SurauColors.line;
    final radius = BorderRadius.circular(SurauTheme.radiusCard);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: SurauColors.card,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: edge)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              button: true,
              expanded: open,
              child: InkWell(
                key: ValueKey('settings-group-$group'),
                onTap: onToggle,
                child: Container(
                  constraints: const BoxConstraints(minHeight: 64),
                  decoration: edgeColor != null
                      ? const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [Color(0xFFFFFDF6), SurauColors.card],
                          ),
                        )
                      : null,
                  padding: const EdgeInsetsDirectional.fromSTEB(18, 12, 14, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: 10,
                              runSpacing: 4,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                _marked(title, query, text.titleMedium!.copyWith(fontWeight: FontWeight.w700)),
                                ?badge,
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(subtitle, style: text.bodySmall),
                          ],
                        ),
                      ),
                      Container(
                        key: ValueKey('settings-group-count-$group'),
                        constraints: const BoxConstraints(minWidth: 28),
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: SurauColors.paperDeep,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Text(
                          '$count',
                          style: text.labelMedium!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700),
                        ),
                      ),
                      const SizedBox(width: 8),
                      AnimatedRotation(
                        turns: open ? 0.5 : 0,
                        duration: const Duration(milliseconds: 150),
                        child: const Icon(Icons.expand_more_rounded, color: SurauColors.teal),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (open)
              for (final row in children) ...[Divider(color: edge), row],
          ],
        ),
      ),
    );
  }
}

class _RowText extends StatelessWidget {
  const _RowText({required this.title, required this.desc, required this.why, required this.query, this.dim = false});

  final String title;
  final String desc;
  final String? why;
  final String query;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _marked(
          title,
          query,
          text.bodyLarge!.copyWith(fontWeight: FontWeight.w600, color: dim ? SurauColors.muted : SurauColors.text),
        ),
        if (desc.isNotEmpty) ...[
          const SizedBox(height: 2),
          Text(desc, style: text.bodySmall),
        ],
        if (why != null) ...[
          const SizedBox(height: 4),
          Text(why!, style: text.labelSmall!.copyWith(color: SurauColors.teal, fontWeight: FontWeight.w600)),
        ],
      ],
    );
  }
}

/// A row that opens a page rather than a feature: optional icon, name, one
/// line of what it is for (or the live figure), chevron. 48 dp at least.
class _NavRow extends StatelessWidget {
  const _NavRow({
    super.key,
    required this.label,
    required this.hint,
    required this.onTap,
    required this.why,
    required this.query,
    this.icon,
    this.tinted = false,
  });

  final IconData? icon;
  final String label;
  final String hint;
  final VoidCallback onTap;
  final String? why;
  final String query;

  /// The card-order row, set apart from the features below it.
  final bool tinted;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: tinted ? const Color(0xFFF9FBFA) : SurauColors.card,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(18, 12, 12, 12),
          child: Row(
            children: [
              if (icon != null) ...[
                Icon(icon, size: 24, color: SurauColors.teal),
                const SizedBox(width: 14),
              ],
              Expanded(child: _RowText(title: label, desc: hint, why: why, query: query)),
              const SizedBox(width: 10),
              const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
            ],
          ),
        ),
      ),
    );
  }
}

class _FeatureRow extends ConsumerStatefulWidget {
  const _FeatureRow({
    super.key,
    required this.feature,
    required this.on,
    required this.why,
    required this.query,
    required this.canWrite,
    this.onOpen,
  });

  /// Called before the row opens its page.
  final VoidCallback? onOpen;

  final FeatureDef feature;
  final bool on;
  final String? why;
  final String query;
  final bool canWrite;

  @override
  ConsumerState<_FeatureRow> createState() => _FeatureRowState();
}

class _FeatureRowState extends ConsumerState<_FeatureRow> {
  /// The value being saved, shown until the box's answer arrives.
  bool? _pending;

  Future<void> _save(bool on) async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null) return;
    setState(() => _pending = on);
    try {
      await repo.save(widget.feature.key, {'enabled': on});
      if (mounted) toast(context, s.settingsSavedShort);
    } catch (e) {
      if (mounted) toast(context, e is SettingsSaveError ? e.text(s) : writeErrorText(s, e));
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final f = widget.feature;
    final on = _pending ?? widget.on;
    final lang = ref.watch(appLangProvider);
    final desc = featureDesc(f.key, lang);
    final noFields = f.defaults.isEmpty;
    final body = _RowText(title: featureLabel(f, lang), desc: desc, why: widget.why, query: widget.query, dim: !on);

    if (noFields && f.locked) {
      return Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(18, 12, 12, 12),
        child: Row(
          children: [
            Expanded(child: body),
            const SizedBox(width: 10),
            StateChip.on(label: s.featureLocked),
          ],
        ),
      );
    }
    if (noFields && f.key != 'appLock') {
      return Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(18, 8, 12, 8),
        child: Row(
          children: [
            Expanded(child: body),
            const SizedBox(width: 10),
            Switch(
              key: ValueKey('settings-switch-${f.key}'),
              value: on,
              onChanged: widget.canWrite && _pending == null ? _save : null,
            ),
          ],
        ),
      );
    }
    return InkWell(
      onTap: () {
        widget.onOpen?.call();
        context.go(AppRoutes.settingsFor(f.key));
      },
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(18, 12, 12, 12),
        child: Row(
          children: [
            Expanded(child: body),
            const SizedBox(width: 10),
            if (f.locked)
              StateChip.on(label: s.featureLocked)
            else if (on)
              StateChip.on(label: s.featureOn)
            else
              StateChip(label: s.featureOff, background: SurauColors.paperDeep, foreground: SurauColors.muted),
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          ],
        ),
      ),
    );
  }
}

class _NoResults extends StatelessWidget {
  const _NoResults({required this.query, required this.onClear});

  final String query;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      key: const ValueKey('settings-no-results'),
      padding: const EdgeInsets.fromLTRB(20, 48, 20, 48),
      child: Column(
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: const BoxDecoration(color: SurauColors.paperDeep, shape: BoxShape.circle),
            child: const Icon(Icons.search_rounded, size: 34, color: SurauColors.teal),
          ),
          const SizedBox(height: 14),
          Text(s.settingsNoResults, style: text.titleLarge!.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text(
            s.settingsNoResultsBody(query),
            textAlign: TextAlign.center,
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 16),
          OutlinedButton(
            key: const ValueKey('settings-search-reset'),
            onPressed: onClear,
            child: Text(s.settingsClearSearch),
          ),
        ],
      ),
    );
  }
}
