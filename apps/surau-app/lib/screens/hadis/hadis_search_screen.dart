// `Cari hadis`: browse HadeethEnc's category tree (BM names), search the Malay
// titles and texts of the box's catalog, open a hadis. On an iPad the detail
// sits on the right; on a phone it is its own page. Every read is a question
// to the box: the phone never talks to HadeethEnc.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../features/shell/permissions.dart';
import '../../hadis/hadis_api.dart';
import '../../hadis/hadis_list_controller.dart';
import '../../hadis/hadis_rules.dart';
import '../../hadis/hadis_search_controller.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'hadis_detail_screen.dart' show HadisDetailPanel;
import 'hadis_list_screen.dart' show hadisTwoColumnsFrom;
import 'widgets/hadis_tags.dart';

enum HadisCariTab { categories, results }

class HadisCariTabNotifier extends Notifier<HadisCariTab> {
  @override
  HadisCariTab build() => HadisCariTab.categories;

  void set(HadisCariTab tab) => state = tab;
}

/// Which half of `Cari hadis` is showing; a category chip in the detail can
/// bring back the categories.
final hadisCariTabProvider = NotifierProvider<HadisCariTabNotifier, HadisCariTab>(
  HadisCariTabNotifier.new,
);

const List<String> _suggestions = ['amalan', 'solat', 'doa', 'syurga', 'zakat', 'bidaah'];

class HadisSearchScreen extends ConsumerStatefulWidget {
  const HadisSearchScreen({super.key});

  @override
  ConsumerState<HadisSearchScreen> createState() => _HadisSearchScreenState();
}

class _HadisSearchScreenState extends ConsumerState<HadisSearchScreen> {
  final TextEditingController _query = TextEditingController();

  /// The hadis asked for in the right half, also when its read failed.
  String? _selected;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (!mounted) return;
      final search = ref.read(hadisSearchProvider.notifier);
      unawaited(search.loadStatus());
      unawaited(search.loadCategories());
      if (!ref.read(hadisListProvider).loaded) {
        unawaited(ref.read(hadisListProvider.notifier).load());
      }
    });
  }

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  HadisSearchController get _search => ref.read(hadisSearchProvider.notifier);

  void _setTab(HadisCariTab tab) => ref.read(hadisCariTabProvider.notifier).set(tab);

  void _typed(String q) {
    _search.search(q);
    if (q.trim().isNotEmpty) _setTab(HadisCariTab.results);
  }

  void _go() {
    _setTab(HadisCariTab.results);
    unawaited(_search.searchNow(_query.text));
  }

  void _suggest(String word) {
    _query.text = word;
    _go();
  }

  Future<void> _retry() async {
    final s = S.of(context);
    await _search.loadStatus();
    if (!mounted) return;
    if (!ref.read(hadisSearchProvider).status.online) {
      toast(context, s.hadisStillOffline);
    } else {
      unawaited(_search.loadCategories());
    }
  }

  Future<void> _download() async {
    final s = S.of(context);
    try {
      await _search.refresh();
    } catch (e) {
      if (mounted) toast(context, writeErrorText(s, e));
    }
  }

  void _openHadis(String id, bool wide) {
    if (wide) {
      setState(() => _selected = id);
      unawaited(_search.openDetail(id));
    } else {
      context.go(AppRoutes.hadisDetailFor(id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final state = ref.watch(hadisSearchProvider);
    final online = !state.statusLoaded || state.status.online;

    return ShellPage(
      title: s.hadisFind,
      body: LayoutBuilder(
        builder: (context, c) {
          final wide = c.maxWidth >= hadisTwoColumnsFrom;
          final list = _listPane(s, state, online, wide);
          if (!online || !wide) {
            return ContentColumn(
              child: ListView(padding: SurauTheme.pagePadding, children: list),
            );
          }
          final detail = state.detail;
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 9,
                child: ListView(padding: SurauTheme.pagePadding, children: list),
              ),
              Expanded(
                flex: 11,
                child: detail == null && !state.detailLoading && _selected == null
                    ? Padding(
                        padding: const EdgeInsets.all(40),
                        child: Center(
                          child: Text(
                            s.hadisPickToRead,
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: SurauColors.muted),
                          ),
                        ),
                      )
                    : HadisDetailPanel(
                        key: ValueKey('panel-${_selected ?? detail?.id}'),
                        heId: _selected ?? detail?.id ?? '',
                        embedded: true,
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  List<Widget> _listPane(S s, HadisSearchState state, bool online, bool wide) {
    final tab = ref.watch(hadisCariTabProvider);
    final top = <Widget>[
      HadisNetBar(online: online),
      const SizedBox(height: 12),
      _SearchBox(
        controller: _query,
        enabled: online,
        onChanged: _typed,
        onSubmit: _go,
      ),
      const SizedBox(height: 12),
      HadisSegments<HadisCariTab>(
        value: tab,
        onChanged: online ? _setTab : null,
        segments: [
          HadisSegment(HadisCariTab.categories, s.hadisTabCategories, key: const ValueKey('hadis-tab-categories')),
          HadisSegment(HadisCariTab.results, s.hadisTabResults, key: const ValueKey('hadis-tab-results')),
        ],
      ),
      const SizedBox(height: 12),
    ];
    if (!online) return [...top, _offlineCard(s)];
    if (state.statusLoaded && state.status.catalogEmpty) {
      return [...top, _catalogEmptyCard(s, state)];
    }
    return [
      ...top,
      ...tab == HadisCariTab.results
          ? _resultsPanel(s, state, wide)
          : _categoryPanel(s, state, wide),
    ];
  }

  Widget _offlineCard(S s) {
    final text = Theme.of(context).textTheme;
    final saved = ref.watch(hadisListProvider.select((x) => x.saved));
    return Card(
      key: const ValueKey('hadis-offline-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 26, 18, 26),
            child: Column(
              children: [
                const Icon(Icons.cloud_off_rounded, size: 40, color: SurauColors.outline),
                const SizedBox(height: 6),
                Text(
                  s.hadisOfflineTitle,
                  textAlign: TextAlign.center,
                  style: text.titleMedium!.copyWith(fontSize: 17, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 4),
                Text(
                  s.hadisOfflineBody,
                  textAlign: TextAlign.center,
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted, fontSize: 14.5),
                ),
                const SizedBox(height: 14),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: s.hadisOfflineSaved(saved),
                        style: const TextStyle(fontWeight: FontWeight.w700, color: SurauColors.text),
                      ),
                      TextSpan(text: ' ${s.hadisOfflineSavedTail}'),
                    ],
                  ),
                  textAlign: TextAlign.center,
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted, fontSize: 14.5),
                ),
              ],
            ),
          ),
          const Divider(),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  key: const ValueKey('hadis-manage-saved'),
                  style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44), padding: const EdgeInsets.symmetric(horizontal: 16)),
                  onPressed: () => context.go(AppRoutes.contentFor('hadis')),
                  child: Text(s.hadisManageSaved),
                ),
                TextButton.icon(
                  key: const ValueKey('hadis-offline-retry'),
                  onPressed: () => unawaited(_retry()),
                  icon: const Icon(Icons.refresh_rounded),
                  label: Text(s.actionRetry),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _catalogEmptyCard(S s, HadisSearchState state) {
    final text = Theme.of(context).textTheme;
    final canFetch = canSee(ref.watch(rolesProvider), 'islamic:fetch');
    final job = state.job;
    final running = job != null && job.running;
    return Card(
      key: const ValueKey('hadis-catalog-empty'),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.cloud_download_rounded, size: 40, color: SurauColors.outline),
            const SizedBox(height: 8),
            Text(
              s.hadisCatalogEmptyTitle,
              textAlign: TextAlign.center,
              style: text.titleMedium!.copyWith(fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              canFetch ? s.hadisCatalogEmptyBody : s.hadisCatalogEmptyAsk,
              textAlign: TextAlign.center,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
            if (running) ...[
              const SizedBox(height: 14),
              LinearProgressIndicator(value: job.total > 0 ? job.done / job.total : null, minHeight: 4),
              const SizedBox(height: 6),
              Text(
                job.total > 0 ? s.hadisDownloading(job.done, job.total) : s.hadisDownloadStarting,
                textAlign: TextAlign.center,
                style: text.bodySmall,
              ),
            ],
            if (job != null && job.failed) ...[
              const SizedBox(height: 12),
              ErrorLine(s.hadisDownloadFailed),
            ],
            if (canFetch && !running) ...[
              const SizedBox(height: 14),
              FilledButton.icon(
                key: const ValueKey('hadis-download'),
                onPressed: () => unawaited(_download()),
                icon: const Icon(Icons.download_rounded),
                label: Text(s.hadisDownloadNow),
              ),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _categoryPanel(S s, HadisSearchState state, bool wide) {
    final text = Theme.of(context).textTheme;
    final current = state.categoryId;
    final cat = current == null ? null : _search.categoryOf(current);
    final path = current == null ? const <HeCategory>[] : _search.pathOf(current);
    final children = _search.childrenOf(current);
    final saved = ref.watch(hadisSavedIdsProvider);
    final listLoaded = ref.watch(hadisListProvider.select((x) => x.loaded));

    final out = <Widget>[
      Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 2,
        runSpacing: 2,
        children: [
          _Crumb(
            label: s.hadisAllCategories,
            onTap: current == null ? null : _search.closeCategory,
          ),
          for (var i = 0; i < path.length; i++) ...[
            const Icon(Icons.chevron_right_rounded, size: 16, color: SurauColors.muted),
            _Crumb(
              label: path[i].titleMs,
              onTap: i == path.length - 1 ? null : () => unawaited(_search.openCategory(path[i].id)),
            ),
          ],
        ],
      ),
      const SizedBox(height: 8),
    ];
    if (cat != null) {
      out.addAll([
        HadisNote(
          key: const ValueKey('hadis-cat-header'),
          tone: HadisNoteTone.teal,
          icon: Icons.folder_rounded,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(cat.titleMs, style: const TextStyle(fontWeight: FontWeight.w700)),
              Text(s.hadisCatOriginalName(cat.titleEn), style: const TextStyle(fontSize: 13)),
            ],
          ),
        ),
        const SizedBox(height: 12),
      ]);
    }
    if (state.categoriesError != null && state.categories.isEmpty) {
      out.add(ErrorLine(_readError(s, state.categoriesError)));
    } else if (!state.categoriesLoaded) {
      out.add(const LinearProgressIndicator(minHeight: 2));
    }
    if (children.isNotEmpty) {
      out.add(
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < children.length; i++) ...[
                if (i > 0) const Divider(),
                _CategoryRow(
                  category: children[i],
                  subcategories: _search.childrenOf(children[i].id).length,
                  onTap: () => unawaited(_search.openCategory(children[i].id)),
                ),
              ],
            ],
          ),
        ),
      );
    }
    if (current != null) {
      out.add(
        HadisSection(
          s.hadisInCategory,
          trailing: Text(
            s.hadisCount(cat?.count ?? state.categoryTotal),
            style: text.bodySmall!.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      );
      if (state.categoryError != null) {
        out.add(ErrorLine(_readError(s, state.categoryError)));
      } else if (state.categoryLoading && state.categoryItems.isEmpty) {
        out.add(const LinearProgressIndicator(minHeight: 2));
      } else {
        out.add(
          Card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (state.categoryItems.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 26),
                    child: Text(
                      s.hadisNoItems,
                      textAlign: TextAlign.center,
                      style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                    ),
                  ),
                for (var i = 0; i < state.categoryItems.length; i++) ...[
                  if (i > 0) const Divider(),
                  _HadisResultRow(
                    item: state.categoryItems[i],
                    query: '',
                    selected: wide && state.detail?.id == state.categoryItems[i].id,
                    saved: listLoaded ? saved.contains(state.categoryItems[i].id) : state.categoryItems[i].saved,
                    onTap: () => _openHadis(state.categoryItems[i].id, wide),
                  ),
                ],
                if (state.categoryHasMore) ...[
                  const Divider(),
                  TextButton.icon(
                    key: const ValueKey('hadis-load-more'),
                    onPressed: state.categoryLoading ? null : () => unawaited(_search.loadMoreCategory()),
                    icon: const Icon(Icons.expand_more_rounded),
                    label: Text(s.hadisLoadMore),
                  ),
                ],
              ],
            ),
          ),
        );
      }
    }
    out.addAll([const SizedBox(height: 12), _creditLine(s)]);
    return out;
  }

  List<Widget> _resultsPanel(S s, HadisSearchState state, bool wide) {
    final text = Theme.of(context).textTheme;
    final saved = ref.watch(hadisSavedIdsProvider);
    final listLoaded = ref.watch(hadisListProvider.select((x) => x.loaded));
    final q = state.query;
    final asked = q.length >= minSearchChars;
    return [
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final w in _suggestions)
            ActionChip(
              key: ValueKey('hadis-suggest-$w'),
              label: Text(
                w,
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: q.toLowerCase() == w ? Colors.white : SurauColors.teal,
                ),
              ),
              backgroundColor: q.toLowerCase() == w ? SurauColors.teal : SurauColors.tealSoft,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              onPressed: () => _suggest(w),
            ),
        ],
      ),
      HadisSection(
        asked && !state.searching ? s.hadisResultsCount(state.results.length, q) : s.hadisTypeKeyword,
        trailing: Text(
          s.hadisResultsScope,
          style: text.bodySmall!.copyWith(fontWeight: FontWeight.w600),
        ),
      ),
      if (state.searchError != null)
        ErrorLine(_readError(s, state.searchError))
      else if (state.searching)
        const LinearProgressIndicator(minHeight: 2)
      else
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (state.results.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 26),
                  child: Column(
                    children: [
                      const Icon(Icons.search_rounded, size: 36, color: SurauColors.outline),
                      const SizedBox(height: 6),
                      Text(
                        asked ? s.hadisNoResults : s.hadisSearchExample,
                        textAlign: TextAlign.center,
                        style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                      ),
                    ],
                  ),
                ),
              for (var i = 0; i < state.results.length; i++) ...[
                if (i > 0) const Divider(),
                _HadisResultRow(
                  item: state.results[i],
                  query: q,
                  selected: wide && state.detail?.id == state.results[i].id,
                  saved: listLoaded ? saved.contains(state.results[i].id) : state.results[i].saved,
                  onTap: () => _openHadis(state.results[i].id, wide),
                ),
              ],
            ],
          ),
        ),
      const SizedBox(height: 12),
      _creditLine(s),
    ];
  }

  String _readError(S s, Object? error) => error is BoxUnreachable
      ? s.errorBoxUnreachable
      : writeErrorText(s, error ?? Exception());

  Widget _creditLine(S s) {
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: SurauColors.paper,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: SurauColors.line),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline_rounded, size: 16, color: SurauColors.muted),
          const SizedBox(width: 8),
          Expanded(child: Text(s.hadisCredit, style: text.bodySmall!.copyWith(fontSize: 12))),
        ],
      ),
    );
  }
}

class _SearchBox extends StatelessWidget {
  const _SearchBox({
    required this.controller,
    required this.enabled,
    required this.onChanged,
    required this.onSubmit,
  });

  final TextEditingController controller;
  final bool enabled;
  final void Function(String) onChanged;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Opacity(
      opacity: enabled ? 1 : 0.5,
      child: Container(
        padding: const EdgeInsets.only(left: 14, right: 8),
        constraints: const BoxConstraints(minHeight: 56),
        decoration: BoxDecoration(
          color: enabled ? SurauColors.card : SurauColors.paper,
          borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          border: Border.all(color: SurauColors.line),
        ),
        child: Row(
          children: [
            const Icon(Icons.search_rounded, color: SurauColors.muted),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                key: const ValueKey('hadis-search'),
                controller: controller,
                enabled: enabled,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: s.hadisSearchHint,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  disabledBorder: InputBorder.none,
                  filled: false,
                  isDense: true,
                  contentPadding: EdgeInsets.zero,
                ),
                onChanged: onChanged,
                onSubmitted: (_) => onSubmit(),
              ),
            ),
            FilledButton(
              key: const ValueKey('hadis-search-go'),
              onPressed: enabled ? onSubmit : null,
              style: FilledButton.styleFrom(
                backgroundColor: SurauColors.teal,
                foregroundColor: Colors.white,
                minimumSize: const Size(0, 40),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: Theme.of(context).textTheme.labelMedium!.copyWith(fontWeight: FontWeight.w700),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
              child: Text(s.hadisSearchGo),
            ),
          ],
        ),
      ),
    );
  }
}

class _Crumb extends StatelessWidget {
  const _Crumb({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      fontSize: 13.5,
      fontWeight: FontWeight.w700,
      color: onTap == null ? SurauColors.text : SurauColors.teal,
    );
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
        child: Text(label, style: style),
      ),
    );
  }
}

class _CategoryRow extends StatelessWidget {
  const _CategoryRow({
    required this.category,
    required this.subcategories,
    required this.onTap,
  });

  final HeCategory category;
  final int subcategories;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return InkWell(
      key: ValueKey('hadis-cat-${category.id}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: SurauColors.tealSoft,
                borderRadius: BorderRadius.circular(11),
              ),
              child: const Icon(Icons.folder_rounded, size: 20, color: SurauColors.teal),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(category.titleMs, style: text.titleSmall!.copyWith(fontSize: 15.5, height: 1.35)),
                  if (subcategories > 0)
                    Text(s.hadisSubcategories(subcategories), style: text.bodySmall!.copyWith(fontSize: 12.5)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: SurauColors.paper,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                s.hadisCount(category.count),
                style: text.bodySmall!.copyWith(fontSize: 12.5, fontWeight: FontWeight.w700),
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          ],
        ),
      ),
    );
  }
}

/// A hadis in a category or the search results; a grade the TV may not show
/// is greyed, with no way to open or add it.
class _HadisResultRow extends StatelessWidget {
  const _HadisResultRow({
    required this.item,
    required this.query,
    required this.selected,
    required this.saved,
    required this.onTap,
  });

  final HeSummary item;
  final String query;
  final bool selected;
  final bool saved;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final blocked = !item.allowed;
    final tags = <Widget>[
      if (item.grade != null)
        HadisTagChip(
          label: gradeLabel(item.grade!),
          background: blocked ? SurauColors.dangerSoft : SurauColors.tealSoft,
          foreground: blocked ? SurauColors.danger : SurauColors.teal,
        ),
      if (blocked)
        HadisTagChip(
          label: item.grade == null ? s.hadisGradeUnknown : s.hadisGradeBlocked,
          background: SurauColors.paperDeep,
          foreground: SurauColors.muted,
        ),
      if (item.attributionShort != null || item.attributionAr.isNotEmpty)
        HadisTagChip.attribution(item.attributionShort ?? item.attributionAr),
      if (item.isLong)
        HadisTagChip(
          label: s.hadisTagLong,
          background: SurauColors.goldSoft,
          foreground: HadisColors.updateInk,
        ),
      if (saved)
        HadisTagChip(
          label: s.hadisAlreadyKiosk,
          icon: Icons.check_rounded,
          background: SurauColors.tealSoft,
          foreground: SurauColors.teal,
        ),
    ];
    final titleStyle = text.titleSmall!.copyWith(fontSize: 15.5, height: 1.35);
    final row = Container(
      decoration: selected
          ? const BoxDecoration(
              color: Color(0xFFF1F8F6),
              border: Border(left: BorderSide(color: SurauColors.teal, width: 4)),
            )
          : null,
      padding: EdgeInsets.fromLTRB(selected ? 10 : 14, 13, 14, 13),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: HadisColors.heSoft,
              borderRadius: BorderRadius.circular(11),
            ),
            child: const Icon(Icons.bookmark_rounded, size: 20, color: HadisColors.heBlue),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  _highlighted(item.title, query),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: titleStyle,
                ),
                const SizedBox(height: 6),
                Wrap(spacing: 6, runSpacing: 6, children: tags),
              ],
            ),
          ),
          if (!blocked) const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
        ],
      ),
    );
    if (blocked) {
      return Opacity(
        key: ValueKey('hadis-result-blocked-${item.id}'),
        opacity: 0.55,
        child: row,
      );
    }
    return InkWell(key: ValueKey('hadis-result-${item.id}'), onTap: onTap, child: row);
  }

  TextSpan _highlighted(String title, String q) {
    final needle = q.trim().toLowerCase();
    if (needle.isEmpty) return TextSpan(text: title);
    final hay = title.toLowerCase();
    if (hay.length != title.length) return TextSpan(text: title);
    final spans = <InlineSpan>[];
    var i = 0;
    while (true) {
      final j = hay.indexOf(needle, i);
      if (j < 0) {
        spans.add(TextSpan(text: title.substring(i)));
        break;
      }
      if (j > i) spans.add(TextSpan(text: title.substring(i, j)));
      spans.add(
        TextSpan(
          text: title.substring(j, j + needle.length),
          style: const TextStyle(backgroundColor: SurauColors.goldSoft),
        ),
      );
      i = j + needle.length;
    }
    return TextSpan(children: spans);
  }
}
