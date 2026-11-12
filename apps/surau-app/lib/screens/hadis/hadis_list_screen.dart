// `Kandungan > Hadis`: every hadis saved on MAXCOM in one list, with a source
// badge, grade, attribution and `Panjang untuk TV`, a switch that shows or
// hides it on the TV, a bin that removes it (behind a confirm) and a `Susun`
// mode with arrows. Without `content:write` it is read-only: no switch, no
// bin, no `Cari hadis`.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../content/editors/content_form.dart' show contentPath;
import '../../features/shell/permissions.dart';
import '../../hadis/hadis_api.dart';
import '../../hadis/hadis_list_controller.dart';
import '../../hadis/hadis_rules.dart';
import '../../hadis/hadis_search_controller.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'widgets/hadis_tags.dart';

/// Content width from which a hadis screen uses two columns.
const double hadisTwoColumnsFrom = 800;

class HadisListScreen extends ConsumerStatefulWidget {
  const HadisListScreen({super.key});

  @override
  ConsumerState<HadisListScreen> createState() => _HadisListScreenState();
}

class _HadisListScreenState extends ConsumerState<HadisListScreen> {
  late final HadisSearchController _search = ref.read(hadisSearchProvider.notifier);

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (!mounted) return;
      unawaited(ref.read(hadisListProvider.notifier).load());
      _search.watchStatus();
    });
  }

  @override
  void dispose() {
    _search.stopWatchingStatus();
    super.dispose();
  }

  HadisListController get _list => ref.read(hadisListProvider.notifier);

  Future<void> _run(Future<void> Function() action) async {
    final s = S.of(context);
    try {
      await action();
    } on ReorderNeedsConnection {
      if (mounted) toast(context, s.hadisReorderNeedsConnection);
    } on HadisGradeBlocked {
      if (mounted) toast(context, s.hadisAddGradeBlocked);
    } catch (e) {
      if (mounted) toast(context, writeErrorText(s, e));
    }
  }

  Future<void> _remove(HadisItem item) async {
    final s = S.of(context);
    final ok = await confirmRemoveHadis(
      context,
      title: item.title ?? item.textMs,
      own: !item.isProvider,
    );
    if (!ok || !mounted) return;
    await _run(() async {
      await _list.remove(item.id);
      if (mounted) toast(context, s.hadisRemoved);
    });
  }

  void _open(HadisItem item, bool canWrite) {
    if (item.isProvider) {
      if (canWrite) context.go(AppRoutes.hadisDetailFor(item.providerId!));
      return;
    }
    // The editor reads the box's list: make it the current one, so what it
    // carries through (`shown`, `order`) is not an older copy.
    ref.invalidate(boxJsonProvider(contentPath('hadis')));
    context.go(AppRoutes.contentItemFor('hadis', item.id));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final canWrite = canSee(ref.watch(rolesProvider), 'content:write');
    final state = ref.watch(hadisListProvider);
    final online = ref.watch(
      hadisSearchProvider.select((x) => !x.statusLoaded || x.status.online),
    );
    // A save in the own-list editor, or a change from another device: the
    // shared list read refreshes, so this list does too.
    ref.listen(boxJsonProvider(contentPath('hadis')), (prev, next) {
      if (prev != null && prev.hasValue && next.hasValue && !next.isLoading) {
        unawaited(_list.load());
      }
    });

    final Widget body;
    if (!state.loaded && state.error != null) {
      final error = state.error;
      body = SurauTheme.page(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 28),
            child: Column(
              children: [
                const Icon(Icons.cloud_off_rounded, size: 36, color: SurauColors.outline),
                const SizedBox(height: 12),
                Text(
                  writeErrorText(s, error!),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => unawaited(_list.load()),
                  icon: const Icon(Icons.refresh_rounded),
                  label: Text(s.actionRetry),
                ),
              ],
            ),
          ),
        ],
      );
    } else if (!state.loaded) {
      body = const Padding(
        padding: EdgeInsets.fromLTRB(20, 24, 20, 0),
        child: Align(
          alignment: Alignment.topCenter,
          child: LinearProgressIndicator(minHeight: 2),
        ),
      );
    } else {
      body = LayoutBuilder(
        builder: (context, c) {
          final left = _leftColumn(s, state, online, canWrite);
          final twoColumns = c.maxWidth >= hadisTwoColumnsFrom;
          final right = _rightColumn(s, state, canWrite, twoColumns);
          if (twoColumns) {
            return ListView(
              padding: SurauTheme.pagePadding,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(flex: 9, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left)),
                    const SizedBox(width: 20),
                    Expanded(flex: 11, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right)),
                  ],
                ),
              ],
            );
          }
          return ContentColumn(
            child: ListView(padding: SurauTheme.pagePadding, children: [...left, ...right]),
          );
        },
      );
    }

    return ShellPage(
      title: s.hadisTitle,
      actions: [
        if (canWrite && state.loaded)
          _SortAction(
            key: const ValueKey('hadis-sort'),
            on: state.sortMode,
            onTap: () => _list.setSortMode(!state.sortMode),
          ),
      ],
      body: body,
    );
  }

  List<Widget> _leftColumn(S s, HadisListState state, bool online, bool canWrite) {
    final text = Theme.of(context).textTheme;
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 16),
        child: Text(s.hadisListIntro, style: text.bodyLarge!.copyWith(fontSize: 16, color: SurauColors.muted)),
      ),
      HadisNetBar(online: online),
      const SizedBox(height: 12),
      IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Stat(value: state.saved, label: s.hadisStatSaved),
            const SizedBox(width: 10),
            _Stat(value: state.shown, label: s.hadisStatShown),
            const SizedBox(width: 10),
            _Stat(value: state.fromProvider, label: s.hadisStatProvider),
          ],
        ),
      ),
      if (state.nearLimit) ...[
        const SizedBox(height: 12),
        HadisNote(
          key: const ValueKey('hadis-near-full'),
          tone: HadisNoteTone.gold,
          icon: Icons.warning_rounded,
          child: Text(s.hadisNearFull(state.saved, maxSaved)),
        ),
      ],
      if (canWrite) ...[
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                key: const ValueKey('hadis-cari'),
                onPressed: online ? () => context.go(AppRoutes.hadisCari) : null,
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                icon: const Icon(Icons.search_rounded),
                label: Text(s.hadisFind, maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                key: const ValueKey('hadis-tambah'),
                onPressed: () => context.go(AppRoutes.contentNewFor('hadis')),
                style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                icon: const Icon(Icons.add_rounded),
                label: Text(s.hadisAddOwn, maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ),
          ],
        ),
        if (!online)
          Padding(
            padding: const EdgeInsets.fromLTRB(2, 6, 2, 0),
            child: Text(s.hadisFindNeedsInternet, style: text.bodySmall),
          ),
      ],
    ];
  }

  List<Widget> _rightColumn(S s, HadisListState state, bool canWrite, bool twoColumns) {
    final text = Theme.of(context).textTheme;
    final index = {for (var i = 0; i < state.items.length; i++) state.items[i].id: i};
    final visible = state.visible;
    return [
      HadisSection(
        s.hadisOrderTitle,
        top: twoColumns ? 4 : 20,
        trailing: canWrite
            ? Text(
                state.sortMode ? s.hadisOrderHintSort : s.hadisOrderHintSwitch,
                textAlign: TextAlign.right,
                style: text.bodySmall!.copyWith(fontWeight: FontWeight.w600),
              )
            : null,
      ),
      HadisSegments<HadisFilter>(
        value: state.filter,
        onChanged: state.sortMode ? null : _list.setFilter,
        segments: [
          HadisSegment(HadisFilter.all, s.hadisFilterAll, key: const ValueKey('hadis-filter-all')),
          HadisSegment(HadisFilter.own, s.hadisFilterOwn, key: const ValueKey('hadis-filter-own')),
          HadisSegment(HadisFilter.hadeethenc, s.hadisFilterProvider, key: const ValueKey('hadis-filter-he')),
        ],
      ),
      const SizedBox(height: 10),
      if (visible.isEmpty)
        Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 26),
            child: Text(
              state.items.isEmpty ? s.hadisNoneSaved : s.hadisNoneFiltered,
              textAlign: TextAlign.center,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        )
      else
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < visible.length; i++) ...[
                if (i > 0) const Divider(),
                _HadisRow(
                  key: ValueKey('hadis-row-${visible[i].id}'),
                  item: visible[i],
                  number: index[visible[i].id]! + 1,
                  isFirst: index[visible[i].id] == 0,
                  isLast: index[visible[i].id] == state.items.length - 1,
                  sortMode: state.sortMode,
                  canWrite: canWrite,
                  tags: hadisRowTags(s, visible[i], _list.tagsFor(visible[i])),
                  onOpen: () => _open(visible[i], canWrite),
                  onToggle: () => _run(() => _list.toggleShown(visible[i].id)),
                  onMove: (dir) => _run(() => _list.move(visible[i].id, dir)),
                  onRemove: () => _remove(visible[i]),
                ),
              ],
            ],
          ),
        ),
      Padding(
        padding: const EdgeInsets.fromLTRB(2, 8, 2, 0),
        child: Text(s.hadisListHelp, style: text.bodySmall),
      ),
    ];
  }
}

class _SortAction extends StatelessWidget {
  const _SortAction({super.key, required this.on, required this.onTap});

  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final fg = on ? SurauColors.ink : SurauColors.gold;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Center(
        child: Material(
          color: on ? SurauColors.gold : SurauColors.gold.withValues(alpha: 0.12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: SurauColors.goldHairline),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(on ? Icons.check_rounded : Icons.sort_rounded, size: 18, color: fg),
                  const SizedBox(width: 6),
                  Text(
                    on ? s.hadisSortDone : s.hadisSort,
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: fg),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label});

  final int value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: SurauColors.card,
          borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          border: Border.all(color: SurauColors.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$value',
              style: const TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w800,
                color: SurauColors.teal,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
            Text(
              label,
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: SurauColors.muted),
            ),
          ],
        ),
      ),
    );
  }
}

class _HadisRow extends StatelessWidget {
  const _HadisRow({
    super.key,
    required this.item,
    required this.number,
    required this.isFirst,
    required this.isLast,
    required this.sortMode,
    required this.canWrite,
    required this.tags,
    required this.onOpen,
    required this.onToggle,
    required this.onMove,
    required this.onRemove,
  });

  final HadisItem item;
  final int number;
  final bool isFirst;
  final bool isLast;
  final bool sortMode;
  final bool canWrite;
  final List<Widget> tags;
  final VoidCallback onOpen;
  final VoidCallback onToggle;
  final void Function(int dir) onMove;
  final VoidCallback onRemove;

  Widget _arrow(IconData icon, String tip, Key key, VoidCallback? onTap) => SizedBox(
    width: 44,
    height: 36,
    child: IconButton(
      key: key,
      tooltip: tip,
      onPressed: onTap,
      padding: EdgeInsets.zero,
      style: IconButton.styleFrom(
        minimumSize: const Size(44, 36),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        backgroundColor: onTap == null ? SurauColors.card : SurauColors.paper,
        foregroundColor: SurauColors.teal,
        disabledForegroundColor: SurauColors.line,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: const BorderSide(color: SurauColors.line),
        ),
      ),
      icon: Icon(icon, size: 20),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final off = !item.onTv;
    final title = item.title ?? item.textMs;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: text.titleSmall!.copyWith(
            fontSize: 15.5,
            height: 1.38,
            color: off ? SurauColors.muted : SurauColors.text,
          ),
        ),
        const SizedBox(height: 7),
        Wrap(spacing: 6, runSpacing: 6, children: tags),
      ],
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 14, 8, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: off ? SurauColors.paperDeep : SurauColors.tealSoft,
              shape: BoxShape.circle,
            ),
            child: Text(
              '$number',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: off ? SurauColors.muted : SurauColors.glass,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: InkWell(
              onTap: onOpen,
              borderRadius: BorderRadius.circular(8),
              child: body,
            ),
          ),
          if (canWrite) ...[
            const SizedBox(width: 4),
            if (sortMode)
              Column(
                children: [
                  _arrow(Icons.keyboard_arrow_up_rounded, s.hadisMoveUp, ValueKey('hadis-up-${item.id}'), isFirst ? null : () => onMove(-1)),
                  const SizedBox(height: 2),
                  _arrow(Icons.keyboard_arrow_down_rounded, s.hadisMoveDown, ValueKey('hadis-down-${item.id}'), isLast ? null : () => onMove(1)),
                ],
              )
            else
              Tooltip(
                message: s.hadisShowOnTv,
                child: Switch(
                  key: ValueKey('hadis-switch-${item.id}'),
                  value: item.onTv,
                  onChanged: (_) => onToggle(),
                ),
              ),
            IconButton(
              key: ValueKey('hadis-bin-${item.id}'),
              tooltip: s.hadisRemoveTip,
              onPressed: onRemove,
              style: IconButton.styleFrom(
                foregroundColor: SurauColors.danger,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                  side: const BorderSide(color: SurauColors.line),
                ),
                minimumSize: const Size(40, 40),
                fixedSize: const Size(40, 40),
                padding: EdgeInsets.zero,
              ),
              icon: const Icon(Icons.delete_rounded, size: 20),
            ),
          ],
        ],
      ),
    );
  }
}
