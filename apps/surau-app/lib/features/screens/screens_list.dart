// "Skrin TV dan MAXCOM Kiosk Box" (Peranti): the main box, each follower box and each browser screen of the surau, with the
// state of each (from when the box was last heard from), "Tetapan TV ini" for the choices of one TV, "Tanggalkan" for
// a follower box and "Pautkan kotak lain" for the link flow. The list is read fresh and again every 20 seconds while
// it is open. A removed box stays in the list, greyed.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxUnreachable;
import '../../content/kinds.dart' show dateWords;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show ErrorLine, PeopleTab, PeopleTabs, RowsCard, SectionLabel, StateChip, confirmDialog, toast;
import '../common/ltr.dart';
import '../common/time_words.dart' show whenWords;
import '../labels.dart' show appLangOf;
import '../link/link_api.dart' show LinkRefusal;
import '../link/link_backup_view.dart';
import '../link/link_controller.dart' show linkApiProvider;
import '../link/link_text.dart' show linkCodeText;
import '../link/link_widgets.dart';
import '../unlink/unlink_screen.dart' show UnlinkKeptLine;
import 'screens_data.dart';
import 'tv_profile.dart';

/// The slot of a row for what concerns the link: the backup lines on the main box's row. Other rows draw nothing and
/// take no room.
class ScreenRowLinkSlot extends StatelessWidget {
  const ScreenRowLinkSlot({super.key, required this.row, this.followers = 0});

  final ScreenRowData row;
  final int followers;

  @override
  Widget build(BuildContext context) => row.kind == ScreenKind.main && (row.backup != null || row.kept != null)
      ? BackupLines(backup: row.backup, kept: row.kept, followers: followers)
      : const SizedBox.shrink();
}

class ScreensListScreen extends ConsumerStatefulWidget {
  const ScreensListScreen({super.key});

  @override
  ConsumerState<ScreensListScreen> createState() => _ScreensListScreenState();
}

class _ScreensListScreenState extends ConsumerState<ScreensListScreen> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted) ref.invalidate(screensDataProvider);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _remove(ScreenRowData row, String shown) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.tvsRemoveTitle(shown),
      body: row.stale ? s.tvsRemoveStaleBody : s.tvsRemoveBody,
      confirm: s.tvsRemove,
      destructive: true,
    );
    if (!ok || !mounted) return;
    final api = ref.read(linkApiProvider);
    if (api == null) return;
    try {
      await api.removeBox(row.id);
      if (!mounted) return;
      ref.invalidate(screensDataProvider);
      toast(context, S.of(context).tvsRemovedToast(shown));
    } on LinkRefusal catch (e) {
      if (mounted) toast(context, linkCodeText(S.of(context), e.code));
    } on BoxUnreachable {
      if (mounted) toast(context, S.of(context).errorBoxUnreachable);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final data = ref.watch(screensDataProvider);
    final settings = ref.watch(settingsProvider).value?.value;
    final deps = ref.watch(appDepsProvider);
    final lang = appLangOf(context);
    final d = data.value;

    String shownName(ScreenRowData r) => tvProfileOf(settings, r.id).name ?? r.name;

    Widget row(ScreenRowData r) {
      final name = shownName(r);
      final now = r.kind == ScreenKind.browser ? (d?.serverNow ?? deps.now()) : deps.now();
      final connected = r.connectedAt(now);
      final seen = r.lastSeenAt;
      final linked = r.linkedAt;
      final removed = r.removedAt;
      final stale = r.stale;
      final chip = r.removed
          ? StateChip(label: s.tvsRemoved, background: SurauColors.paperDeep, foreground: SurauColors.muted)
          : stale
          ? StateChip(
              label: s.tvsNotSeenSince(dateWords(_isoDate(deps.toLocal(r.notSeenSince!)), lang, weekday: false)),
              background: SurauColors.paperDeep,
              foreground: SurauColors.muted,
            )
          : connected
          ? StateChip.on(label: s.tvsConnected)
          : seen != null
          ? StateChip(
              label: s.tvsAwaySince(ltr(whenWords(deps.toLocal(seen), today: deps.toLocal(deps.now()), lang: lang))),
              background: SurauColors.dangerSoft,
              foreground: SurauColors.dangerInk,
            )
          : r.kind == ScreenKind.follower
          ? StateChip(label: s.tvsNeverSeen, background: SurauColors.paperDeep, foreground: SurauColors.muted)
          : null;
      final role = switch (r.kind) {
        ScreenKind.main => s.tvsMainBox,
        ScreenKind.follower => s.tvsFollowerBox,
        ScreenKind.browser => s.tvsBrowserScreen,
      };
      final lines = <String>[
        r.version == null ? role : s.tvsRoleLine(role, ltr(r.version!)),
        if (removed != null)
          s.tvsRemovedOn(dateWords(_isoDate(deps.toLocal(removed)), lang, weekday: false))
        else if (linked != null && r.kind != ScreenKind.main)
          s.tvsLinkedOn(dateWords(_isoDate(deps.toLocal(linked)), lang, weekday: false)),
      ];
      final body = Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.only(top: 2),
              child: Icon(
                r.kind == ScreenKind.browser ? Icons.language_rounded : Icons.dns_outlined,
                size: 26,
                color: r.removed || stale ? SurauColors.outline : SurauColors.teal,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: text.titleSmall!.copyWith(color: r.removed || stale ? SurauColors.muted : SurauColors.text)),
                  for (final l in lines) Text(l, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  if (chip != null) ...[const SizedBox(height: 6), Align(alignment: AlignmentDirectional.centerStart, child: chip)],
                  ScreenRowLinkSlot(row: r, followers: d?.followers ?? 0),
                ],
              ),
            ),
          ],
        ),
      );
      final actions = r.removed
          ? const SizedBox.shrink()
          : Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(8, 0, 8, 6),
              child: Wrap(
                children: [
                  TextButton.icon(
                    key: ValueKey('tv-edit-${r.id}'),
                    onPressed: () => context.go(AppRoutes.screensTvFor(r.id)),
                    icon: const Icon(Icons.tune_rounded, size: 20),
                    label: Text(s.tvsOpenSettings),
                  ),
                  if (r.kind == ScreenKind.follower)
                    TextButton.icon(
                      key: ValueKey('tv-unlink-${r.id}'),
                      onPressed: () => context.go(
                        Uri(path: AppRoutes.screensUnlink, queryParameters: {'device': r.id, 'name': name}).toString(),
                      ),
                      icon: const Icon(Icons.link_off_rounded, size: 20),
                      label: Text(s.unlinkTitle),
                    ),
                  if (r.kind == ScreenKind.follower)
                    TextButton.icon(
                      key: ValueKey('tv-remove-${r.id}'),
                      onPressed: () => _remove(r, name),
                      style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                      icon: const Icon(Icons.link_off_rounded, size: 20),
                      label: Text(s.tvsRemove),
                    ),
                ],
              ),
            );
      return Container(
        key: ValueKey('tv-row-${r.id}'),
        color: r.removed || stale ? SurauColors.paper : null,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [body, actions]),
      );
    }

    final children = <Widget>[const PeopleTabs(current: PeopleTab.screens), const SizedBox(height: 20)];
    if (data.hasError && d == null) {
      children.add(ErrorLine(data.error is BoxUnreachable ? s.errorBoxUnreachable : s.loadFailed));
      children.add(const SizedBox(height: 12));
      children.add(
        OutlinedButton.icon(
          onPressed: () => ref.invalidate(screensDataProvider),
          icon: const Icon(Icons.refresh_rounded),
          label: Text(s.actionRetry),
        ),
      );
    } else if (d == null) {
      children.add(const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2)));
    } else {
      final live = [for (final r in d.rows) if (!r.removed) r];
      final connected = live.where((r) => r.connectedAt(r.kind == ScreenKind.browser ? (d.serverNow ?? deps.now()) : deps.now())).length;
      children.addAll([
        Text(s.tvsIntro, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 12),
        if (live.isNotEmpty)
          Text(s.tvsCount(connected, live.length), key: const ValueKey('tvs-count'), style: text.titleSmall),
        const SizedBox(height: 12),
        if (d.lanOnly) ...[
          LinkNote(key: const ValueKey('tvs-lan-only'), tone: LinkTone.gold, icon: Icons.wifi_off_rounded, text: s.linkCheckLan),
          const SizedBox(height: 12),
        ],
        if (!d.isFollower) const UnlinkKeptLine(),
        if (d.isFollower) ...[
          LinkNote(
            key: const ValueKey('tvs-follower'),
            tone: LinkTone.teal,
            icon: Icons.link_rounded,
            text: d.followerOf == null ? s.linkFollowerTitleNoName : s.linkFollowerTitle(d.followerOf!),
          ),
          const SizedBox(height: 12),
        ],
        if (d.olderBox) ...[
          LinkNote(key: const ValueKey('tvs-older'), tone: LinkTone.grey, icon: Icons.info_outline_rounded, text: s.tvsOlderBox),
          const SizedBox(height: 12),
        ],
        FilledButton.icon(
          key: const ValueKey('tvs-link'),
          onPressed: d.isFollower ? null : () => context.go(AppRoutes.screensLink),
          icon: const Icon(Icons.link_rounded),
          label: Text(s.tvsLinkOther),
        ),
        const SizedBox(height: 20),
        if (d.boxes.isNotEmpty) ...[
          SectionLabel(s.tvsSectionBoxes),
          RowsCard(children: [for (final r in d.boxes) row(r)]),
          const SizedBox(height: 16),
        ],
        if (d.browsers.isNotEmpty) ...[
          SectionLabel(s.tvsSectionBrowsers),
          RowsCard(children: [for (final r in d.browsers) row(r)]),
          const SizedBox(height: 16),
        ],
        if (d.rows.isEmpty && !d.isFollower) Text(s.tvsEmpty, style: text.bodyMedium),
      ]);
    }
    return ShellPage(
      title: s.tvsTitle,
      body: SurauTheme.page(children: children),
    );
  }
}

String _isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
