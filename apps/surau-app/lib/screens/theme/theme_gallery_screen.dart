// Templat paparan: the active theme on top with a live preview and Ubah suai,
// below it a grid of every theme (a colour band, the name, a badge). Tapping a
// card opens a sheet with a live preview of that theme and Guna tema ini.
// Rights: settings:write (Pentadbir Surau); others see it read only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../features/settings_repository.dart';
import '../../features/shell/permissions.dart';
import '../../box/box_client.dart' show BoxError;
import '../../box/wire.dart' show ThemeHealth;
import '../../features/theme/theme_api.dart';
import '../../features/theme/theme_providers.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'theme_download_sheet.dart';
import 'theme_preview_frame.dart';

/// The colours of a theme's card band (the theme's own palette).
const Map<String, List<Color>> themeBandColours = {
  'default': [Color(0xFF06302B), Color(0xFFF0C97A)],
  'colourful': [Color(0xFF5A2A98), Color(0xFFFF5A8C), Color(0xFFFF9A3C), Color(0xFF1D9A85)],
  'creative': [Color(0xFF0D1823), Color(0xFF2FD1B0), Color(0xFFF9B544)],
  'oldschool': [Color(0xFFF1E6CF), Color(0xFF7A1F2B), Color(0xFF1F4D3A)],
  'minimal': [Color(0xFFF3F3F0), Color(0xFF0F6E63)],
  'arabic': [Color(0xFF0A1630), Color(0xFFD9B25F), Color(0xFF0A1630)],
};
const List<Color> _uploadedBand = [Color(0xFFD9DEDC), Color(0xFFB9C2BF)];

class ThemeGalleryScreen extends ConsumerWidget {
  const ThemeGalleryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final canWrite = canSee(ref.watch(rolesProvider), 'settings:write');
    final support = ref.watch(themeSupportProvider).value;
    final canCustomise = canWrite && supportsThemeEditing(support);
    final full = ref.watch(themeSupportFullProvider).value;
    // Arabic Art is offered only when every box of the surau lists it (a box without it would refuse the name).
    final arabicOffered = full != null && themeOfferable(full, contract: 1, builtIn: 'arabic');
    final cards = [for (final c in themeCards(settings)) if (c.name != 'arabic' || c.active || arabicOffered) c];
    final health = ref.watch(healthProvider).value?.value.themeHealth;
    final active = cards.firstWhere((c) => c.active, orElse: () => cards.first);
    final width = MediaQuery.sizeOf(context).width;
    final columns = width >= 700 ? 3 : 2;

    return ShellPage(
      title: s.themeGalleryTitle,
      body: SurauTheme.page(
        children: [
          if (!supportsThemeEditing(support)) ...[
            Container(
              key: const ValueKey('theme-needs-update'),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: SurauColors.goldSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              ),
              child: Row(
                children: [
                  const Icon(Icons.info_outline_rounded, color: SurauColors.ink),
                  const SizedBox(width: 10),
                  Expanded(child: Text(s.themeNeedsUpdate, style: text.bodyMedium!.copyWith(color: SurauColors.ink))),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],
          Text(s.themeInUse, style: text.titleMedium),
          const SizedBox(height: 8),
          Card(
            key: const ValueKey('theme-active-card'),
            clipBehavior: Clip.antiAlias,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 520),
                      child: ThemePreviewFrame(
                        theme: active.name,
                        screen: 'biasa',
                        entry: storedEntryOf(settings, active.name),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(active.title, style: text.titleLarge),
                            if (active.changedScreenCount > 0)
                              Text(
                                s.themeChangedScreens(active.changedScreenCount),
                                style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                              ),
                          ],
                        ),
                      ),
                      _Badge(s.themeActive, tone: _BadgeTone.active),
                    ],
                  ),
                  if (canCustomise) ...[
                    const SizedBox(height: 12),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: FilledButton.icon(
                        key: const ValueKey('theme-customise'),
                        onPressed: () => context.go(AppRoutes.themeEditorFor(active.name)),
                        icon: const Icon(Icons.tune_rounded),
                        label: Text(s.themeCustomise),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(s.themeAll(cards.length), style: text.titleMedium),
          const SizedBox(height: 4),
          Text(s.themeGalleryHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          if (canWrite) ...[
            const SizedBox(height: 12),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton.icon(
                key: const ValueKey('theme-upload-open'),
                onPressed: () => context.go(AppRoutes.settingsThemeUpload),
                icon: const Icon(Icons.upload_file_rounded),
                label: Text(s.themeUploadTitle),
              ),
            ),
          ],
          const SizedBox(height: 12),
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: columns,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 1.25,
            children: [
              for (final c in cards)
                _ThemeCard(
                  data: c,
                  invalid: _isInvalid(health, c),
                  onTap: () => _openSheet(context, c, canWrite),
                ),
            ],
          ),
        ],
      ),
    );
  }

  static bool _isInvalid(ThemeHealth? h, ThemeCardData c) => h != null && !h.ok && h.theme == c.name && c.active && !c.builtIn;

  Future<void> _openSheet(BuildContext context, ThemeCardData c, bool canWrite) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _ThemeSheet(card: c, canWrite: canWrite),
    );
  }
}

class _ThemeCard extends StatelessWidget {
  const _ThemeCard({required this.data, required this.onTap, this.invalid = false});

  final ThemeCardData data;
  final bool invalid;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final colours = themeBandColours[data.name] ?? _uploadedBand;
    return Card(
      key: ValueKey('theme-card-${data.name}'),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        side: BorderSide(color: data.active ? SurauColors.teal : SurauColors.line, width: data.active ? 2 : 1),
      ),
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final (i, c) in colours.indexed)
                        Expanded(flex: i == 0 ? 3 : 1, child: ColoredBox(color: c)),
                    ],
                  ),
                  if (data.active)
                    const PositionedDirectional(
                      top: 6,
                      end: 6,
                      child: CircleAvatar(
                        radius: 12,
                        backgroundColor: SurauColors.teal,
                        child: Icon(Icons.check_rounded, size: 16, color: Colors.white),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(data.title, style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      _Badge(data.builtIn ? s.themeBuiltIn : s.themeUploadedBadge(data.version ?? 0), tone: _BadgeTone.plain),
                      if (data.name == 'arabic') _Badge(s.themeNewBadge, key: const ValueKey('theme-new-badge'), tone: _BadgeTone.plain),
                      if (invalid) _Badge(s.themeInvalidBadge, key: const ValueKey('theme-invalid-badge'), tone: _BadgeTone.warn),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

enum _BadgeTone { plain, active, warn }

class _Badge extends StatelessWidget {
  const _Badge(this.label, {super.key, required this.tone});

  final String label;
  final _BadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final active = tone == _BadgeTone.active;
    final warn = tone == _BadgeTone.warn;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: warn ? SurauColors.dangerSoft : (active ? SurauColors.tealSoft : SurauColors.paperDeep),
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelMedium!.copyWith(color: warn ? SurauColors.dangerInk : (active ? SurauColors.teal : SurauColors.muted)),
      ),
    );
  }
}

class _ThemeSheet extends ConsumerStatefulWidget {
  const _ThemeSheet({required this.card, required this.canWrite});

  final ThemeCardData card;
  final bool canWrite;

  @override
  ConsumerState<_ThemeSheet> createState() => _ThemeSheetState();
}

class _ThemeSheetState extends ConsumerState<_ThemeSheet> {
  bool _busy = false;
  String? _error;

  Future<void> _use() async {
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null) return;
    final s = S.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await repo.save('kioskTemplate', {'templateId': widget.card.name});
      if (!mounted) return;
      nav.pop();
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.themeChosen)));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is SettingsSaveError ? e.text(s) : writeErrorText(s, e);
      });
    }
  }

  Future<void> _download() async {
    final nav = Navigator.of(context);
    final card = widget.card;
    nav.pop();
    await showModalBottomSheet<void>(
      context: nav.context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => ThemeDownloadSheet(card: card),
    );
  }

  Future<void> _delete() async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        content: Text(s.themeDeleteConfirm(widget.card.title)),
        actions: [
          TextButton(key: const ValueKey('theme-delete-no'), onPressed: () => Navigator.of(ctx).pop(false), child: Text(s.themeUploadCancel)),
          FilledButton(key: const ValueKey('theme-delete-yes'), onPressed: () => Navigator.of(ctx).pop(true), child: Text(s.themeDelete)),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final api = ref.read(themeApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.remove(widget.card.name);
      ref.invalidate(settingsProvider);
      ref.invalidate(themeSupportFullProvider);
      if (!mounted) return;
      nav.pop();
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.themeDeleted)));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // The box's own sentence for "in use" and "built in" is the answer.
        _error = e is BoxError && (e.status == 409 || e.status == 400) ? e.message : writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final health = ref.watch(healthProvider).value?.value.themeHealth;
    final support = ref.watch(themeSupportFullProvider).value;
    final c = widget.card;
    final active = activeThemeOf(settings) == c.name;
    final invalid = health != null && !health.ok && health.theme == c.name && !c.builtIn;
    // An uploaded theme is offered only when every MAXCOM of the surau can wear it (and the list is complete).
    final offerable = c.builtIn || (support != null && themeOfferable(support, contract: c.contract ?? 1, builtIn: c.base));
    final cannotConfirm = !c.builtIn && support != null && !support.complete;
    final cannotRead = !c.builtIn && support == null;
    final badge = active ? s.themeActive : (c.builtIn ? s.themeBuiltIn : s.themeUploadedBadge(c.version ?? 0));
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(c.title, style: text.titleLarge)),
              _Badge(badge, tone: active ? _BadgeTone.active : _BadgeTone.plain),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              if (invalid) _Badge(s.themeInvalidBadge, key: const ValueKey('theme-sheet-invalid'), tone: _BadgeTone.warn),
              if (!offerable) _Badge(s.themeNotReady, key: const ValueKey('theme-sheet-not-ready'), tone: _BadgeTone.warn),
            ],
          ),
          const SizedBox(height: 12),
          ThemePreviewFrame(theme: c.name, screen: 'biasa', entry: storedEntryOf(settings, c.name)),
          const SizedBox(height: 16),
          if (invalid) ...[
            Text(s.themeInvalidNote, key: const ValueKey('theme-invalid-note'), style: text.bodyMedium),
            const SizedBox(height: 12),
          ],
          if (!offerable) ...[
            Text(cannotConfirm || cannotRead ? s.themeCannotConfirm : s.themeNotReadyNote, key: const ValueKey('theme-not-ready-note'), style: text.bodyMedium),
            const SizedBox(height: 12),
          ],
          if (_error != null) ...[
            ErrorLine(_error!),
            const SizedBox(height: 12),
          ],
          if (widget.canWrite) ...[
            if (offerable)
              FilledButton.icon(
                key: const ValueKey('theme-use'),
                onPressed: _busy || active ? null : _use,
                icon: const Icon(Icons.check_rounded),
                label: Text(s.themeUse),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const ValueKey('theme-download'),
              onPressed: _busy ? null : _download,
              icon: const Icon(Icons.download_rounded),
              label: Text(s.themeDownloadTitle),
            ),
            const SizedBox(height: 8),
            if (c.builtIn)
              Text(s.themeDeleteBuiltIn, key: const ValueKey('theme-delete-builtin'), style: text.bodyMedium!.copyWith(color: SurauColors.muted))
            else ...[
              OutlinedButton.icon(
                key: const ValueKey('theme-delete'),
                onPressed: _busy || active ? null : _delete,
                icon: const Icon(Icons.delete_outline_rounded),
                label: Text(s.themeDelete),
              ),
              if (active) ...[
                const SizedBox(height: 4),
                Text(s.themeDeleteInUse, key: const ValueKey('theme-delete-inuse'), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
              ],
            ],
          ],
        ],
      ),
    );
  }
}
