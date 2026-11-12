// Tetapan: every feature of the box in its registry group, one expandable
// card per group, with a search box that filters as you type and opens the
// groups it matches. Each row says what the feature is for. A feature that
// has nothing to set is a switch right on its row; the rest show their state
// and open a page. The Lanjutan group (MAXCOM system values) is last and is
// simply absent for anyone without `system:read`. Which groups are open is
// remembered on this device.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../features/labels_ms.dart';
import '../features/registry.g.dart';
import '../features/settings_repository.dart';
import '../features/settings_search.dart';
import '../features/settings_widgets/lanjutan_card.dart';
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String settingsOpenGroupsKey = 'settings.openGroups';

const Set<String> _defaultOpen = {'solat'};

class SettingsListScreen extends ConsumerStatefulWidget {
  const SettingsListScreen({super.key});

  @override
  ConsumerState<SettingsListScreen> createState() => _SettingsListScreenState();
}

class _SettingsListScreenState extends ConsumerState<SettingsListScreen> {
  final _search = TextEditingController();
  String _q = '';
  Set<String> _open = _defaultOpen;

  @override
  void initState() {
    super.initState();
    _loadOpen();
  }

  Future<void> _loadOpen() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(settingsOpenGroupsKey);
      if (raw == null || !mounted) return;
      final list = jsonDecode(raw);
      if (list is List) setState(() => _open = list.whereType<String>().toSet());
    } catch (_) {
      // A remembered layout is a convenience; the default is fine.
    }
  }

  Future<void> _toggle(String group) async {
    final next = {..._open};
    if (!next.remove(group)) next.add(group);
    setState(() => _open = next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(settingsOpenGroupsKey, jsonEncode(next.toList()));
    } catch (_) {
      // Not remembered this time.
    }
  }

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

    final solat = groupLabelsMs['solat']!;
    final kandungan = groupLabelsMs['kandungan']!;
    final extras = [
      if (canWrite)
        SearchExtra('order', s.settingsOrderRow, kandungan, keywords: const ['giliran', 'urutan', 'susunan']),
      if (canSee(roles, 'prayer:import'))
        SearchExtra('prayer-data', s.statusPrayerData, solat, keywords: const ['import', 'csv']),
      if (canSee(roles, 'settings:read')) SearchExtra('islamic', s.settingsIslamicRow, solat),
    ];
    final searching = _q.trim().isNotEmpty;
    final hits = {
      for (final h in SettingsSearchIndex(extras: extras).search(_q, roles: roles)) h.feature: h,
    };
    bool shown(String key) => !searching || hits.containsKey(key);
    String? why(String key) => hits[key]?.why;

    // ---- rows of the ordinary groups ----
    List<Widget> rowsOf(String g) {
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
            onTap: () => context.go(AppRoutes.settingsOrder),
          ),
        );
      }
      for (final f in features) {
        if (f.group != g || !shown(f.key)) continue;
        // Zon JAKIM is for Malaysia only (operator 2026-11-07).
        if (f.key == 'zone' && outsideMalaysia) continue;
        rows.add(
          _FeatureRow(
            key: ValueKey('settings-row-${f.key}'),
            feature: f,
            on: isOn(f),
            why: why(f.key),
            query: _q,
            canWrite: canWrite,
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
              onTap: () => context.go(AppRoutes.prayerData),
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
              onTap: () => context.go(AppRoutes.islamic),
            ),
          );
        }
      }
      return rows;
    }

    final groups = <Widget>[];
    var total = 0;
    for (final g in groupOrder) {
      if (g == 'lanjutan') continue;
      final rows = rowsOf(g);
      if (rows.isEmpty) continue;
      total += rows.length;
      final mine = features.where((f) => f.group == g).toList();
      groups.add(
        _Group(
          group: g,
          title: groupLabelsMs[g] ?? g,
          query: _q,
          subtitle: searching
              ? s.settingsGroupMatches(rows.length)
              : s.settingsGroupCount(mine.length, mine.where(isOn).length),
          open: searching || _open.contains(g),
          onToggle: () => _toggle(g),
          children: rows,
        ),
      );
    }

    // ---- Lanjutan ----
    if (canSee(roles, 'system:read')) {
      final rows = <Widget>[
        for (final f in features)
          if (f.group == 'lanjutan' && shown(f.key))
            _NavRow(
              key: ValueKey('settings-row-${f.key}'),
              label: f.labelMs,
              hint: featureDescTable[f.key]?['ms'] as String? ?? '',
              why: why(f.key),
              query: _q,
              onTap: () => context.go(AppRoutes.settingsFor(f.key)),
            ),
        for (final r in lanjutanRows)
          if (shown('lj:${r['feature']}'))
            _NavRow(
              key: ValueKey('settings-row-lj-${r['feature']}'),
              label: r['labelMs'] as String,
              hint: lanjutanRowHintMs[r['feature']] ?? '',
              why: why('lj:${r['feature']}'),
              query: _q,
              onTap: () => context.go('${AppRoutes.settingsFor(r['feature'] as String)}?lj=1'),
            ),
      ];
      if (rows.isNotEmpty) {
        total += rows.length;
        groups.add(
          _Group(
            group: 'lanjutan',
            title: groupLabelsMs['lanjutan']!,
            query: _q,
            subtitle: searching ? s.settingsGroupMatches(rows.length) : s.settingsLanjutanSubtitle,
            open: searching || _open.contains('lanjutan'),
            onToggle: () => _toggle('lanjutan'),
            lanjutan: true,
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
    this.lanjutan = false,
  });

  final String group;
  final String title;
  final String subtitle;
  final String query;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;
  final bool lanjutan;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final edge = lanjutan ? lanjutanEdge : SurauColors.line;
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
            InkWell(
              key: ValueKey('settings-group-$group'),
              onTap: onToggle,
              child: Container(
                constraints: const BoxConstraints(minHeight: 64),
                decoration: lanjutan
                    ? const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Color(0xFFFFFDF6), SurauColors.card],
                        ),
                      )
                    : null,
                padding: const EdgeInsets.fromLTRB(18, 12, 14, 12),
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
                              if (lanjutan) const PentadbirMaxcomBadge(),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(subtitle, style: text.bodySmall),
                        ],
                      ),
                    ),
                    AnimatedRotation(
                      turns: open ? 0.5 : 0,
                      duration: const Duration(milliseconds: 150),
                      child: const Icon(Icons.expand_more_rounded, color: SurauColors.muted),
                    ),
                  ],
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
          padding: const EdgeInsets.fromLTRB(18, 12, 12, 12),
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
  });

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
      if (mounted) toast(context, e is SettingsSaveError ? e.message : writeErrorText(s, e));
    } finally {
      if (mounted) setState(() => _pending = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final f = widget.feature;
    final on = _pending ?? widget.on;
    final desc = featureDescTable[f.key]?['ms'] as String? ?? '';
    final noFields = f.defaults.isEmpty;
    final body = _RowText(title: f.labelMs, desc: desc, why: widget.why, query: widget.query, dim: !on);

    if (noFields && f.locked) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(18, 12, 12, 12),
        child: Row(
          children: [
            Expanded(child: body),
            const SizedBox(width: 10),
            StateChip(label: s.featureLocked, background: SurauColors.goldSoft, foreground: SurauColors.ink),
          ],
        ),
      );
    }
    if (noFields && f.key != 'appLock') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(18, 8, 12, 8),
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
      onTap: () => context.go(AppRoutes.settingsFor(f.key)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 12, 12, 12),
        child: Row(
          children: [
            Expanded(child: body),
            const SizedBox(width: 10),
            if (f.locked)
              StateChip(label: s.featureLocked, background: SurauColors.goldSoft, foreground: SurauColors.ink)
            else if (on)
              StateChip(label: s.featureOn, background: SurauColors.tealSoft, foreground: SurauColors.teal)
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
