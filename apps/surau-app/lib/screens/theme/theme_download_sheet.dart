// Muat turun tema: one .maxtheme file to edit outside MAXCOM or to share with another surau. A built-in theme
// downloads as a starting pack under a name the person chooses; an uploaded theme keeps its own name. "Sertakan
// ubah suai saya" (on) bakes the surau's menu values into the file so it looks as the TV does now.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../features/finance/share.dart';
import '../../features/registry.g.dart' show builtInThemeIds;
import '../../features/theme/theme_api.dart';
import '../../features/theme/theme_providers.dart';
import '../../features/theme/theme_style.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';

final RegExp _themeName = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$');

/// Names a download may not take: the built-in themes (and the Arabic Art theme that comes later).
bool themeNameUsable(String name) => _themeName.hasMatch(name) && !builtInThemeIds.contains(name) && name != 'arabic';

/// `<theme id>-<surau name>` as a theme name: lowercase, spaces to hyphens, other characters dropped, at most 32.
String proposedThemeName(String themeId, String surauName) {
  final tail = surauName
      .toLowerCase()
      .replaceAll(RegExp(r'\s+'), '-')
      .replaceAll(RegExp(r'[^a-z0-9-]'), '')
      .replaceAll(RegExp(r'-{2,}'), '-');
  var out = tail.isEmpty ? themeId : '$themeId-$tail';
  if (out.length > 32) out = out.substring(0, 32);
  return out.replaceAll(RegExp(r'^-+|-+$'), '');
}

/// How many screens and how many background pictures the surau changed for [entry].
({int screens, int pictures}) changeCounts(ThemeStyleEntry entry) {
  var pictures = 0;
  if (entry.semua['bgImage'] != null) pictures++;
  for (final s in entry.skrin.values) {
    if (s['bgImage'] != null) pictures++;
  }
  return (screens: changedScreens(entry).length, pictures: pictures);
}

class ThemeDownloadSheet extends ConsumerStatefulWidget {
  const ThemeDownloadSheet({super.key, required this.card});

  final ThemeCardData card;

  @override
  ConsumerState<ThemeDownloadSheet> createState() => _ThemeDownloadSheetState();
}

class _ThemeDownloadSheetState extends ConsumerState<ThemeDownloadSheet> {
  late final TextEditingController _name;
  bool _bake = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final settings = ref.read(settingsProvider).value?.value ?? const <String, dynamic>{};
    final info = settings['surauInfo'];
    final surau = info is Map && info['name'] is String ? info['name'] as String : '';
    _name = TextEditingController(text: widget.card.builtIn ? proposedThemeName(widget.card.name, surau) : widget.card.name);
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  bool get _nameOk => !widget.card.builtIn || themeNameUsable(_name.text);

  Future<Uint8List?> _fetch() async {
    final api = ref.read(themeApiProvider);
    if (api == null) return null;
    final s = S.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bytes = await api.download(widget.card.name, bake: _bake, as: widget.card.builtIn ? _name.text : null);
      return bytes;
    } catch (e) {
      if (mounted) setState(() => _error = writeErrorText(s, e));
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _download({required bool share}) async {
    final s = S.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final bytes = await _fetch();
    if (bytes == null || !mounted) return;
    final file = '${_name.text}.maxtheme';
    try {
      if (share) {
        await shareBytes(bytes, file, mime: packMime);
      } else {
        final r = await saveBytes(bytes, file, mime: packMime);
        if (!r.saved && !r.sharedInstead) {
          if (mounted) setState(() => _error = s.themeDownloadFailed);
          return;
        }
        messenger
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text(s.themeDownloaded)));
        nav.pop();
      }
    } on Object {
      if (mounted) setState(() => _error = s.themeDownloadFailed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final counts = changeCounts(storedEntryOf(settings, widget.card.name));
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.themeDownloadTitle, style: text.titleLarge),
            const SizedBox(height: 4),
            Text(s.themeDownloadLine, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('theme-download-name'),
              controller: _name,
              readOnly: !widget.card.builtIn,
              maxLength: 32,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: s.themeFileName,
                suffixText: '.maxtheme',
                errorText: _nameOk ? null : s.themeNameBad,
                counterText: '',
              ),
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              key: const ValueKey('theme-download-bake'),
              contentPadding: EdgeInsets.zero,
              value: _bake,
              onChanged: _busy ? null : (v) => setState(() => _bake = v),
              title: Text(s.themeBake),
              subtitle: Text(s.themeBakeNote(counts.screens, counts.pictures)),
            ),
            if (_error != null) ...[const SizedBox(height: 8), ErrorLine(_error!)],
            const SizedBox(height: 12),
            Row(
              children: [
                TextButton(
                  key: const ValueKey('theme-download-cancel'),
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: Text(s.themeUploadCancel),
                ),
                const Spacer(),
                if (shareImplementation == 'android') ...[
                  OutlinedButton(
                    key: const ValueKey('theme-download-share'),
                    onPressed: _busy || !_nameOk ? null : () => _download(share: true),
                    child: Text(s.themeShare),
                  ),
                  const SizedBox(width: 8),
                ],
                FilledButton.icon(
                  key: const ValueKey('theme-download-go'),
                  onPressed: _busy || !_nameOk ? null : () => _download(share: false),
                  icon: const Icon(Icons.download_rounded),
                  label: Text(s.themeDownloadButton),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
