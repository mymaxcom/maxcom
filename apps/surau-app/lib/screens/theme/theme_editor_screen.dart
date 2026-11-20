// Ubah suai: one theme, every catalog screen. The values are edited in memory
// and posted to the kiosk preview (nothing reaches the TV) until Simpan, which
// re-reads the settings (a cached answer is never saved from) and saves this
// theme's own entry only. Set semula (this screen or all) and Guna untuk semua
// skrin ask first.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../content/asset_picker.dart' show pickImageProvider, prepareImageProvider;
import '../../features/registry.g.dart' show themeTitles;
import '../../features/settings_repository.dart';
import '../../features/shell/read_cache.dart' show Read;
import '../../features/shell/permissions.dart';
import '../../features/theme/theme_providers.dart';
import '../../features/theme/theme_style.dart';
import '../../l10n/generated/s.dart';
import '../preview_screen.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'theme_controls.dart';
import 'theme_preview_frame.dart';
import 'theme_screen_list.dart';

/// Width from which the editor lays out for an iPad: preview and screens on
/// the left, controls on the right.
const double themeEditorWideWidth = 840;

class ThemeEditorScreen extends ConsumerStatefulWidget {
  const ThemeEditorScreen({super.key, required this.theme});

  final String theme;

  @override
  ConsumerState<ThemeEditorScreen> createState() => _ThemeEditorScreenState();
}

class _ThemeEditorScreenState extends ConsumerState<ThemeEditorScreen> {
  ThemeStyleEntry? _entry;
  ThemeStyleEntry _baseline = const ThemeStyleEntry();
  String _screen = 'biasa';
  bool _busy = false;
  bool _picking = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Fresh values on open: whatever another admin saved a moment ago.
    Future(() async {
      try {
        final read = await ref.refresh(settingsProvider.future);
        if (!mounted || _entry != null) return;
        final e = storedEntryOf(read?.value ?? const {}, widget.theme);
        setState(() {
          _entry = e;
          _baseline = e;
        });
      } catch (_) {
        // The page shows its own empty state below.
      }
    });
  }

  bool get _dirty => _entry != null && jsonLike(_entry!) != jsonLike(_baseline);

  static String jsonLike(ThemeStyleEntry e) => e.toJson().toString();

  String _title() {
    final own = themeTitles[widget.theme];
    if (own != null) return own;
    final settings = ref.read(settingsProvider).value?.value ?? const <String, dynamic>{};
    for (final c in themeCards(settings)) {
      if (c.name == widget.theme) return c.title;
    }
    return widget.theme;
  }

  void _change(String key, Object? value) {
    final e = _entry;
    if (e == null) return;
    setState(() {
      _entry = setValue(e, _screen, key, value);
      _error = null;
    });
  }

  Future<void> _pickPicture() async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _picking = true;
      _error = null;
    });
    try {
      final bytes = await ref.read(pickImageProvider)();
      if (bytes == null || !mounted) {
        if (mounted) setState(() => _picking = false);
        return;
      }
      final prepared = await ref.read(prepareImageProvider)(bytes);
      final meta = await gateway.uploadAsset(prepared.bytes, prepared.mime);
      if (!mounted) return;
      setState(() => _picking = false);
      _change('bgImage', meta.id);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _picking = false;
        _error = writeErrorText(s, e);
      });
    }
  }

  Future<bool> _confirm(String question, String yes) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(question),
        actions: [
          TextButton(key: const ValueKey('confirm-no'), onPressed: () => Navigator.pop(context, false), child: Text(s.actionCancel)),
          FilledButton(key: const ValueKey('confirm-yes'), onPressed: () => Navigator.pop(context, true), child: Text(yes)),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _applyAll() async {
    final s = S.of(context);
    final e = _entry;
    if (e == null) return;
    // Screens other than this one with values of their own lose them (all-screens takes this screen's values): say so.
    final others = e.skrin.entries.where((x) => x.key != _screen && x.value.isNotEmpty).length;
    final question = others == 0 ? s.themeApplyAllConfirm(_title()) : s.themeApplyAllReplaces(_title(), others);
    if (!await _confirm(question, s.themeApplyAll)) return;
    setState(() => _entry = applyToAll(e, _screen));
  }

  Future<void> _resetScreen() async {
    final s = S.of(context);
    final e = _entry;
    if (e == null) return;
    if (!await _confirm(s.themeResetScreenConfirm(themeScreenName(s, _screen)), s.themeReset)) return;
    setState(() => _entry = resetScreen(e, _screen));
  }

  Future<void> _resetAll() async {
    final s = S.of(context);
    if (!await _confirm(s.themeResetConfirm(_title()), s.themeResetAll)) return;
    setState(() => _entry = const ThemeStyleEntry());
  }

  Future<void> _save() async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    final e = _entry;
    if (repo == null || e == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Never save from a cached read: the box must answer now, or nothing is sent.
      Read<Map<String, dynamic>>? fresh;
      try {
        fresh = await ref.refresh(settingsProvider.future);
      } catch (_) {
        fresh = null;
      }
      if (fresh == null || fresh.stale) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = s.themeFreshFailed;
        });
        return;
      }
      await repo.save('themeStyle', stylesPatch(widget.theme, e));
      if (!mounted) return;
      setState(() {
        _busy = false;
        _baseline = e;
      });
      toast(context, s.themeSaved);
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = err is SettingsSaveError ? err.text(s) : writeErrorText(s, err);
      });
    }
  }

  Future<void> _leave(BuildContext context) async {
    final s = S.of(context);
    final nav = Navigator.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.themeDiscardTitle),
        actions: [
          TextButton(key: const ValueKey('discard-keep'), onPressed: () => Navigator.pop(context, false), child: Text(s.themeKeepEditing)),
          FilledButton(key: const ValueKey('discard-yes'), onPressed: () => Navigator.pop(context, true), child: Text(s.themeDiscard)),
        ],
      ),
    );
    if (ok == true && context.mounted) {
      setState(() => _baseline = _entry!);
      nav.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final canWrite = canSee(ref.watch(rolesProvider), 'settings:write');
    final bundle = ref.watch(boxJsonProvider(bundlePath)).value?.value;
    final info = ref.watch(boxJsonProvider(surauInfoPath)).value?.value;
    final offset = utcOffsetOf(info);
    final entry = _entry;
    final now = bundle == null ? null : previewNowForScreen(_screen, bundle, utcOffsetMinutes: offset);
    final title = _title();

    if (entry == null) {
      return ShellPage(
        title: s.themeEditTitle(title),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    final changed = changedScreens(entry);
    final preview = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Icon(Icons.visibility_outlined, size: 18, color: SurauColors.muted),
            const SizedBox(width: 6),
            Text(s.themeLivePreview, style: text.labelLarge!.copyWith(color: SurauColors.muted)),
          ],
        ),
        const SizedBox(height: 6),
        ThemePreviewFrame(theme: widget.theme, screen: _screen, entry: entry, now: now, utcOffsetMinutes: offset),
        const SizedBox(height: 6),
        Text(s.themeEditScreen(themeScreenName(s, _screen)), key: const ValueKey('theme-screen-sub'), style: text.titleSmall),
      ],
    );

    final controls = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ThemeControls(
          entry: entry,
          theme: widget.theme,
          screen: _screen,
          onChange: _change,
          onPickPicture: _pickPicture,
          base: packBaseOf(settings, widget.theme),
          arabLooksOn: arabLooksOn(settings, widget.theme),
          readOnly: !canWrite,
          busyPicture: _picking,
        ),
        if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 12)],
        if (canWrite) ...[
          OutlinedButton.icon(
            key: const ValueKey('theme-apply-all'),
            onPressed: _busy ? null : _applyAll,
            icon: const Icon(Icons.layers_outlined),
            label: Text(s.themeApplyAll),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            key: const ValueKey('theme-reset'),
            onPressed: _busy ? null : _resetScreen,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(s.themeResetScreen),
          ),
          TextButton.icon(
            key: const ValueKey('theme-reset-all'),
            onPressed: _busy ? null : _resetAll,
            icon: const Icon(Icons.restart_alt_rounded),
            label: Text(s.themeResetAll),
          ),
        ],
      ],
    );

    final saveButton = FilledButton.icon(
      key: const ValueKey('theme-save'),
      onPressed: canWrite && _dirty && !_busy ? _save : null,
      icon: const Icon(Icons.check_rounded),
      label: Text(s.settingsSave),
    );

    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _leave(context);
      },
      child: LayoutBuilder(
        builder: (context, box) {
          final wide = MediaQuery.sizeOf(context).width >= themeEditorWideWidth;
          if (wide) {
            return ShellPage(
              title: s.themeEditTitle(title),
              actions: [if (canWrite) Padding(padding: const EdgeInsetsDirectional.only(end: 8), child: saveButton)],
              body: Row(
                key: const ValueKey('theme-editor-wide'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 420,
                    child: ListView(
                      padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 12, 24),
                      children: [
                        preview,
                        const SizedBox(height: 8),
                        ThemeScreenList(selected: _screen, changed: changed, onSelect: (id) => setState(() => _screen = id)),
                      ],
                    ),
                  ),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsetsDirectional.fromSTEB(12, 16, 24, 24),
                      children: [controls, const SizedBox(height: 12), if (canWrite) saveButton],
                    ),
                  ),
                ],
              ),
            );
          }
          // The preview and the screen chips take at most half of the body
          // and scroll inside it, so the controls below always keep room to
          // be used, whatever the phone, the keyboard or the preview's state.
          return ShellPage(
            title: s.themeEditTitle(title),
            body: LayoutBuilder(
              builder: (context, body) => Column(
                key: const ValueKey('theme-editor-narrow'),
                children: [
                  ConstrainedBox(
                    constraints: BoxConstraints(maxHeight: body.hasBoundedHeight ? body.maxHeight * 0.5 : double.infinity),
                    child: SingleChildScrollView(
                      key: const ValueKey('theme-editor-top'),
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 380), child: preview)),
                          const SizedBox(height: 8),
                          ThemeScreenChips(selected: _screen, changed: changed, onSelect: (id) => setState(() => _screen = id)),
                        ],
                      ),
                    ),
                  ),
                  const Divider(height: 16),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                      children: [controls, const SizedBox(height: 12), if (canWrite) saveButton],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
