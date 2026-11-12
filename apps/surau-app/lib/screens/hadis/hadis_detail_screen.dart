// `Butiran hadis`: everything HadeethEnc says about one hadis, a preview of
// the TV card and `Tambah ke kiosk` (or `Sudah di kiosk` and `Buang`). The
// panel is also the right half of `Cari hadis` on an iPad. When HadeethEnc has
// since changed the text of a saved hadis, `Semak` shows the new text and the
// TV keeps the old one until `Guna teks baharu`.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../features/validate.dart' show featureByKey;
import '../../hadis/hadis_api.dart';
import '../../hadis/hadis_list_controller.dart';
import '../../hadis/hadis_providers.dart';
import '../../hadis/hadis_rules.dart';
import '../../hadis/hadis_search_controller.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'hadis_search_screen.dart' show hadisCariTabProvider, HadisCariTab;
import 'widgets/hadis_tags.dart';
import 'widgets/hadis_tv_preview.dart';

/// `/content/hadis/cari/:heId` on a phone, or opened from the list.
class HadisDetailScreen extends ConsumerStatefulWidget {
  const HadisDetailScreen({super.key, required this.heId});

  final String heId;

  @override
  ConsumerState<HadisDetailScreen> createState() => _HadisDetailScreenState();
}

class _HadisDetailScreenState extends ConsumerState<HadisDetailScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (!mounted) return;
      ref.read(hadisSearchProvider.notifier).openDetail(widget.heId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ShellPage(
      title: s.hadisDetailTitle,
      body: ContentColumn(child: HadisDetailPanel(heId: widget.heId)),
    );
  }
}

/// The body of `Butiran hadis`; reads the hadis the search controller holds.
class HadisDetailPanel extends ConsumerStatefulWidget {
  const HadisDetailPanel({super.key, required this.heId, this.embedded = false});

  final String heId;

  /// Inside `Cari hadis` on an iPad: a category chip stays on the same page.
  final bool embedded;

  @override
  ConsumerState<HadisDetailPanel> createState() => _HadisDetailPanelState();
}

class _HadisDetailPanelState extends ConsumerState<HadisDetailPanel> {
  bool _showArabic = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      if (!mounted) return;
      final search = ref.read(hadisSearchProvider.notifier);
      if (!ref.read(hadisSearchProvider).categoriesLoaded) unawaited(search.loadCategories());
      if (!ref.read(hadisSearchProvider).statusLoaded) unawaited(search.loadStatus());
      if (!ref.read(hadisListProvider).loaded) {
        unawaited(ref.read(hadisListProvider.notifier).load());
      }
    });
  }

  HadisSearchController get _search => ref.read(hadisSearchProvider.notifier);

  Map<String, dynamic> _tvSettings() {
    final box = ref.watch(settingsProvider).value?.value['hadis'];
    return {
      ...(featureByKey('hadis')?.defaults ?? const {}),
      if (box is Map) ...box.cast<String, dynamic>(),
      if (!_showArabic) 'showArabic': false,
    };
  }

  Future<void> _add(HeDetail d) async {
    final s = S.of(context);
    setState(() => _busy = true);
    final r = await _search.add(d.id);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      toast(context, s.hadisAdded);
      return;
    }
    toast(context, switch (r.failure) {
      AddFailure.gradeBlocked => s.hadisAddGradeBlocked,
      AddFailure.tooLong => s.hadisAddTooLong,
      AddFailure.limitReached => s.hadisAddLimit(maxSaved),
      AddFailure.sourceUnavailable => s.hadisAddUnavailable,
      AddFailure.forbidden => s.errorForbidden,
      _ => r.message ?? s.errorUnknown,
    });
  }

  Future<void> _remove(HeDetail d, HadisItem? item) async {
    final s = S.of(context);
    final id = item?.id ?? d.savedItemId ?? providerItemId(d.id);
    final ok = await confirmRemoveHadis(context, title: d.title, own: false);
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(hadisListProvider.notifier).remove(id);
      if (mounted) toast(context, s.hadisRemoved);
    } catch (e) {
      if (mounted) toast(context, writeErrorText(s, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// `Semak`: the new text, then keep the old one or use the new one.
  Future<void> _review(HeDetail d, String itemId) async {
    final s = S.of(context);
    final repo = ref.read(hadisRepositoryProvider);
    if (repo == null) return;
    String? preview;
    try {
      for (final u in await repo.updates()) {
        if (u.itemId == itemId) preview = u.previewMs;
      }
    } on SessionExpired {
      return;
    } on Object {
      // the dialog still opens; the box refuses again at accept when it is down
    }
    if (!mounted) return;
    final use = await showDialog<bool>(
      context: context,
      builder: (context) {
        final text = Theme.of(context).textTheme;
        final body = preview;
        return AlertDialog(
          title: Text(s.hadisUpdateTitle),
          content: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 500),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(s.hadisUpdateBody(d.id)),
                  const SizedBox(height: 8),
                  Text(s.hadisUpdateBody2),
                  if (body != null) ...[
                    const SizedBox(height: 14),
                    Text(s.hadisUpdateNewText, style: text.titleSmall),
                    const SizedBox(height: 6),
                    Container(
                      key: const ValueKey('hadis-update-preview'),
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: SurauColors.paper,
                        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                        border: Border.all(color: SurauColors.line),
                      ),
                      child: Text(body, style: text.bodyMedium),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(s.hadisUpdateKeep),
            ),
            FilledButton(
              key: const ValueKey('hadis-update-use'),
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(s.hadisUpdateUse),
            ),
          ],
        );
      },
    );
    if (use != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final blocked = await ref.read(hadisListProvider.notifier).acceptUpdate(itemId);
      if (!mounted) return;
      toast(context, blocked ? s.hadisUpdateGradeBlocked : s.hadisUpdateDone);
      await _search.openDetail(d.id);
    } catch (e) {
      if (mounted) toast(context, writeErrorText(s, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openCategory(String id) {
    ref.read(hadisCariTabProvider.notifier).set(HadisCariTab.categories);
    unawaited(_search.openCategory(id));
    if (!widget.embedded) context.go(AppRoutes.hadisCari);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final state = ref.watch(hadisSearchProvider);
    final d = state.detail;
    if (state.detailLoading ||
        (state.detailError == null && (d == null || d.id != widget.heId))) {
      return const Padding(
        padding: EdgeInsets.fromLTRB(20, 24, 20, 0),
        child: Align(
          alignment: Alignment.topCenter,
          child: LinearProgressIndicator(minHeight: 2),
        ),
      );
    }
    if (d == null || d.id != widget.heId) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
        child: Column(
          children: [
            const Icon(Icons.cloud_off_rounded, size: 36, color: SurauColors.outline),
            const SizedBox(height: 12),
            Text(
              state.detailError is BoxUnreachable ? s.errorBoxUnreachable : s.loadFailed,
              textAlign: TextAlign.center,
              style: text.bodyLarge,
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => unawaited(_search.openDetail(widget.heId)),
              icon: const Icon(Icons.refresh_rounded),
              label: Text(s.actionRetry),
            ),
          ],
        ),
      );
    }

    final list = ref.watch(hadisListProvider);
    final savedIds = ref.watch(hadisSavedIdsProvider);
    final saved = list.loaded ? savedIds.contains(d.id) : d.saved;
    final itemId = d.savedItemId ?? providerItemId(d.id);
    final item = list.items.where((x) => x.providerId == d.id).firstOrNull;
    final updated = saved && list.updates.contains(item?.id ?? itemId);
    final isLong = d.length == 'long';
    final short = d.attributionShort ?? d.attributionAr;

    final lengthTag = switch (d.length) {
      'long' => s.hadisTagLong,
      'medium' => s.hadisTagMedium,
      _ => s.hadisTagShort,
    };

    final children = <Widget>[
      // Dark header: id, title, grade, attribution, length.
      Container(
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
        decoration: BoxDecoration(
          color: SurauColors.glass,
          borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
          border: Border.all(color: SurauColors.goldHairline),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.hadisDetailKicker(d.id),
              style: const TextStyle(
                color: SurauColors.gold,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.5,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              d.title,
              style: const TextStyle(color: Colors.white, fontSize: 19, height: 1.35, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (d.grade != null)
                  HadisTagChip(label: gradeLabel(d.grade!), background: SurauColors.gold, foreground: SurauColors.ink),
                HadisTagChip(
                  label: short,
                  background: Colors.white.withValues(alpha: 0.08),
                  foreground: const Color(0xFFE6EFED),
                  border: SurauColors.goldHairline,
                ),
                HadisTagChip(
                  label: lengthTag,
                  background: isLong ? SurauColors.gold.withValues(alpha: 0.18) : Colors.white.withValues(alpha: 0.08),
                  foreground: isLong ? SurauColors.gold : const Color(0xFFE6EFED),
                  border: isLong ? null : SurauColors.goldHairline,
                ),
              ],
            ),
          ],
        ),
      ),
      HadisSection(s.hadisTranslation),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(d.textMs, style: text.bodyLarge!.copyWith(fontSize: 16, height: 1.62)),
        ),
      ),
      HadisSection(
        s.hadisArabicText,
        trailing: Align(
          alignment: Alignment.centerRight,
          child: Switch(
            key: const ValueKey('hadis-show-arabic'),
            value: _showArabic,
            onChanged: (v) => setState(() => _showArabic = v),
          ),
        ),
      ),
      if (_showArabic)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Text(
              d.textAr,
              textDirection: TextDirection.rtl,
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontFamily: 'NotoNaskhArabic',
                // `{` and `}` around a verse are not in the Arabic font
                fontFamilyFallback: [SurauTheme.fontFamily],
                fontSize: 21,
                height: 2.05,
                color: SurauColors.text,
              ),
            ),
          ),
        )
      else
        Padding(
          padding: const EdgeInsets.fromLTRB(2, 0, 2, 0),
          child: Text(s.hadisArabicHidden, style: text.bodySmall),
        ),
      HadisSection(s.hadisDetails),
      Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Field(
              label: s.hadisGrade,
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: d.grade == null ? d.gradeAr : gradeLabel(d.grade!)),
                    if (d.grade != null)
                      TextSpan(
                        text: '   ${d.gradeAr}',
                        style: const TextStyle(
                          fontFamily: 'NotoNaskhArabic',
                          fontWeight: FontWeight.w400,
                          color: SurauColors.muted,
                        ),
                      ),
                  ],
                ),
                style: text.titleSmall,
              ),
            ),
            const Divider(),
            _Field(
              label: s.hadisAttribution,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(text: short),
                        if (d.attributionLong != null)
                          TextSpan(
                            text: ' (${d.attributionLong})',
                            style: const TextStyle(fontWeight: FontWeight.w500, color: SurauColors.muted),
                          ),
                      ],
                    ),
                    style: text.titleSmall,
                  ),
                  Text(
                    d.attributionAr,
                    textDirection: TextDirection.rtl,
                    style: const TextStyle(
                      fontFamily: 'NotoNaskhArabic',
                      fontSize: 15,
                      color: SurauColors.muted,
                    ),
                  ),
                ],
              ),
            ),
            const Divider(),
            _Field(
              label: s.hadisCategories,
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final c in d.categories)
                    if (_search.categoryOf(c) case final cat?)
                      ActionChip(
                        key: ValueKey('hadis-cat-chip-${cat.id}'),
                        label: Text(cat.titleMs, style: const TextStyle(fontSize: 12.5, color: SurauColors.muted)),
                        backgroundColor: SurauColors.paperDeep,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        onPressed: () => _openCategory(cat.id),
                      ),
                ],
              ),
            ),
            Container(
              color: SurauColors.paper,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              child: Row(
                children: [
                  const Icon(Icons.bookmark_rounded, size: 16, color: SurauColors.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(s.hadisSourceLine(d.id), style: text.bodySmall!.copyWith(fontSize: 12)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      HadisSection(s.hadisPreviewOnTv),
      HadisTvPreview(
        key: const ValueKey('hadis-detail-preview'),
        data: HadisPreviewData.fromDetail(d),
        settings: _tvSettings(),
      ),
      if (isLong) ...[
        const SizedBox(height: 12),
        HadisNote(
          key: const ValueKey('hadis-long-note'),
          tone: HadisNoteTone.gold,
          icon: Icons.warning_rounded,
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '${s.hadisTagLong} ',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                TextSpan(text: s.hadisLongNote(d.textMs.length)),
              ],
            ),
          ),
        ),
      ],
      if (updated) ...[
        const SizedBox(height: 12),
        HadisNote(
          key: const ValueKey('hadis-update-note'),
          tone: HadisNoteTone.gold,
          icon: Icons.refresh_rounded,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.hadisUpdateNote),
              TextButton(
                key: const ValueKey('hadis-review-update'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(48, 36)),
                onPressed: _busy ? null : () => unawaited(_review(d, item?.id ?? itemId)),
                child: Text(s.hadisUpdateReview),
              ),
            ],
          ),
        ),
      ],
    ];

    final canAdd = state.canAdd && d.allowed;
    final Widget action = saved
        ? Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  key: const ValueKey('hadis-saved'),
                  onPressed: () => context.go(AppRoutes.contentFor('hadis')),
                  icon: const Icon(Icons.check_rounded),
                  label: Text(s.hadisAlreadyKiosk, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ),
              const SizedBox(width: 10),
              TextButton.icon(
                key: const ValueKey('hadis-detail-remove'),
                style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                onPressed: _busy ? null : () => unawaited(_remove(d, item)),
                icon: const Icon(Icons.delete_rounded, size: 20),
                label: Text(s.hadisRemoveConfirm),
              ),
            ],
          )
        : FilledButton.icon(
            key: const ValueKey('hadis-add'),
            onPressed: canAdd && !_busy ? () => unawaited(_add(d)) : null,
            icon: const Icon(Icons.tv_rounded),
            label: Text(s.hadisAddKiosk),
          );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ListView(
            padding: widget.embedded
                ? const EdgeInsets.fromLTRB(0, 16, 20, 16)
                : const EdgeInsets.fromLTRB(20, 16, 20, 16),
            children: children,
          ),
        ),
        Container(
          padding: EdgeInsets.fromLTRB(widget.embedded ? 0 : 20, 12, 20, 16),
          decoration: const BoxDecoration(
            color: SurauColors.paper,
            border: Border(top: BorderSide(color: SurauColors.line)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              action,
              if (!saved && !state.canAdd) ...[
                const SizedBox(height: 6),
                Text(s.hadisAddNeedsInternet, style: text.bodySmall, textAlign: TextAlign.center),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: text.bodySmall!.copyWith(fontSize: 13.5)),
          const SizedBox(height: 4),
          child,
        ],
      ),
    );
  }
}
