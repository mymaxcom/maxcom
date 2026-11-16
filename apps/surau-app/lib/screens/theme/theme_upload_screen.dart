// Muat naik tema: pick a .maxtheme, the box checks it (nothing is installed), the
// person sees the result (valid, warnings, or refused with the reason), Pasang
// installs it, and Guna sekarang is a separate choice. Rights: settings:write.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../features/registry.g.dart' show themeTitles;
import '../../features/settings_repository.dart';
import '../../features/shell/permissions.dart';
import '../../features/theme/theme_api.dart';
import '../../features/theme/theme_providers.dart';
import '../../l10n/generated/s.dart';
import '../widgets/box_read.dart';
import '../widgets/pieces.dart';
import 'theme_preview_frame.dart';
import 'theme_screen_list.dart';

enum _Step { pick, checking, result, installed }

String _size(int bytes) => bytes >= 1024 * 1024 ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB' : '${(bytes / 1024).ceil()} KB';

class ThemeUploadScreen extends ConsumerStatefulWidget {
  const ThemeUploadScreen({super.key});

  @override
  ConsumerState<ThemeUploadScreen> createState() => _ThemeUploadScreenState();
}

class _ThemeUploadScreenState extends ConsumerState<ThemeUploadScreen> {
  _Step _step = _Step.pick;
  String? _fileName;
  Uint8List? _bytes;
  String? _problem;
  PackReport? _report;
  String? _stagedId;
  String _previewScreen = 'kuliah';
  bool _busy = false;
  String? _error;
  ({String name, int version, String title})? _installed;

  bool get _ms => Localizations.localeOf(context).languageCode == 'ms';

  Future<void> _pick() async {
    final s = S.of(context);
    final picked = await ref.read(themeFilePickerProvider)();
    if (!mounted || picked == null) return;
    setState(() {
      _problem = picked.tooBig
          ? s.themeUploadTooBig
          : picked.wrongType
          ? s.themeUploadWrongType
          : picked.unreadable
          ? s.themeUploadUnreadable
          : null;
      _fileName = picked.name;
      _bytes = picked.bytes;
      _error = null;
    });
  }

  Future<void> _check() async {
    final api = ref.read(themeApiProvider);
    final bytes = _bytes;
    if (api == null || bytes == null) return;
    setState(() {
      _step = _Step.checking;
      _error = null;
    });
    try {
      final r = await api.check(bytes);
      if (!mounted) return;
      setState(() {
        _report = r.report;
        _stagedId = r.stagedId;
        _previewScreen = r.report.screens.contains('kuliah') || r.report.screens.isEmpty ? 'kuliah' : r.report.screens.first;
        _step = _Step.result;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _Step.pick;
        _error = _problemText(e);
      });
    }
  }

  String _problemText(Object e) {
    final s = S.of(context);
    // A refusal the box explains in its own words (too big, wrong type) comes through as BoxError.message.
    if (e is BoxError && e.status == 413) return s.themeUploadTooBig;
    return writeErrorText(s, e);
  }

  Future<void> _install() async {
    final api = ref.read(themeApiProvider);
    final id = _stagedId;
    if (api == null || id == null) return;
    final s = S.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await api.install(id);
      ref.invalidate(settingsProvider);
      ref.invalidate(themeSupportFullProvider);
      if (!mounted) return;
      setState(() {
        _installed = r;
        _step = _Step.installed;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (e is BoxError && e.status == 410) {
          _step = _Step.pick;
          _report = null;
          _stagedId = null;
          _error = s.themeUploadExpired;
        } else if (e is BoxError && (e.status == 409 || e.status == 429)) {
          // 409: a newer version arrived. 429: ten installs an hour on one box. The box's own sentence says which.
          _error = e.message;
        } else {
          _error = _problemText(e);
        }
      });
    }
  }

  Future<void> _useNow() async {
    final repo = ref.read(settingsRepositoryProvider);
    final inst = _installed;
    if (repo == null || inst == null) return;
    final s = S.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await repo.save('kioskTemplate', {'templateId': inst.name});
      ref.invalidate(settingsProvider);
      if (!mounted) return;
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(s.themeChosen)));
      router.go(AppRoutes.settingsThemes);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is SettingsSaveError ? e.message : writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final canWrite = canSee(ref.watch(rolesProvider), 'settings:write');
    final stepNo = switch (_step) {
      _Step.pick || _Step.checking => 1,
      _Step.result => 2,
      _Step.installed => 3,
    };
    return ShellPage(
      title: s.themeUploadTitle,
      body: SurauTheme.page(
        children: [
          if (!canWrite)
            ErrorLine(s.errorForbidden)
          else ...[
            Text(s.themeUploadStep(stepNo), style: text.labelMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 8),
            switch (_step) {
              _Step.pick || _Step.checking => _pickStep(s, text),
              _Step.result => _resultStep(s, text),
              _Step.installed => _installedStep(s, text),
            },
          ],
        ],
      ),
    );
  }

  Widget _pickStep(S s, TextTheme text) {
    final checking = _step == _Step.checking;
    final ready = _bytes != null && _problem == null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.themeUploadPickTitle, style: text.titleLarge),
        const SizedBox(height: 4),
        Text(s.themeUploadPickHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 12),
        if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 12)],
        if (_problem != null) ...[ErrorLine(_problem!), const SizedBox(height: 12)],
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            key: const ValueKey('theme-upload-pick'),
            onPressed: checking ? null : _pick,
            icon: const Icon(Icons.folder_open_rounded),
            label: Text(s.themeUploadPickButton),
          ),
        ),
        if (ready) ...[
          const SizedBox(height: 12),
          Card(
            child: ListTile(
              key: const ValueKey('theme-upload-file'),
              leading: const Icon(Icons.inventory_2_outlined),
              title: Text(_fileName ?? ''),
              subtitle: Text(_size(_bytes!.length)),
            ),
          ),
          const SizedBox(height: 8),
          Text(s.themeUploadChecksNote, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        ],
        const SizedBox(height: 16),
        Row(
          children: [
            TextButton(
              key: const ValueKey('theme-upload-cancel'),
              onPressed: checking ? null : () => context.go(AppRoutes.settingsThemes),
              child: Text(s.themeUploadCancel),
            ),
            const Spacer(),
            FilledButton(
              key: const ValueKey('theme-upload-check'),
              onPressed: ready && !checking ? _check : null,
              child: checking
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                        const SizedBox(width: 8),
                        Text(s.themeUploadChecking),
                      ],
                    )
                  : Text(s.themeUploadCheck),
            ),
          ],
        ),
      ],
    );
  }

  Widget _issueList(List<ThemeIssue> issues) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final i in issues)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Container(
            key: ValueKey('theme-issue-${i.code}'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: SurauColors.paperDeep, borderRadius: BorderRadius.circular(SurauTheme.radiusControl)),
            child: Text(i.text(_ms)),
          ),
        ),
    ],
  );

  Widget _resultStep(S s, TextTheme text) {
    final r = _report!;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    if (!r.ok) {
      final first = r.errors.isEmpty ? null : r.errors.first;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(first?.text(_ms) ?? s.themeUploadUnreadable, key: const ValueKey('theme-upload-refused'), style: text.titleLarge),
          const SizedBox(height: 12),
          _issueList(r.errors),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              key: const ValueKey('theme-upload-close'),
              onPressed: () => context.go(AppRoutes.settingsThemes),
              child: Text(s.themeUploadClose),
            ),
          ),
        ],
      );
    }
    final warn = r.warnings;
    final screens = <String>{'biasa', 'kuliah', ...r.screens}.toList();
    final baseTitle = themeTitles[r.base] ?? r.base ?? '';
    final ownScreens = r.screens.isEmpty ? '-' : r.screens.map((id) => themeScreenName(s, id)).join(', ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(warn.isEmpty ? s.themeUploadValid : s.themeUploadWarnTitle(warn.length), key: const ValueKey('theme-upload-valid'), style: text.titleLarge),
        const SizedBox(height: 4),
        if (warn.isEmpty) Text(s.themeUploadNoProblems, style: text.bodyMedium!.copyWith(color: SurauColors.muted)) else _issueList(warn),
        const SizedBox(height: 12),
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ThemePreviewFrame(
              theme: r.name ?? '',
              screen: _previewScreen,
              entry: storedEntryOf(settings, r.name ?? ''),
              staged: _stagedId,
              pack: r.previewPack,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final id in screens)
              ChoiceChip(
                label: Text(themeScreenName(s, id)),
                selected: _previewScreen == id,
                onSelected: (_) => setState(() => _previewScreen = id),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text(s.themeUploadPreview(themeScreenName(s, _previewScreen)), style: text.labelMedium!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 12),
        RowsCard(
          children: [
            _row(s.themeUploadName, r.title ?? r.name ?? ''),
            _row(
              s.themeUploadVersion,
              r.isUpdate && r.installedVersion != null ? s.themeUploadVersionUpdate(r.version ?? 0, r.installedVersion!) : s.themeUploadVersionNew(r.version ?? 0),
            ),
            _row(s.themeUploadBase, baseTitle),
            _row(s.themeUploadContract, '${r.contract ?? ''}'),
            _row(s.themeUploadContent, s.themeUploadContentValue(r.fileCount, _size(r.bytes))),
            _row(s.themeUploadOwnScreens, ownScreens),
          ],
        ),
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        const SizedBox(height: 16),
        Row(
          children: [
            TextButton(
              key: const ValueKey('theme-upload-cancel'),
              onPressed: _busy ? null : () => context.go(AppRoutes.settingsThemes),
              child: Text(s.themeUploadCancel),
            ),
            const Spacer(),
            FilledButton(
              key: const ValueKey('theme-upload-install'),
              onPressed: _busy ? null : _install,
              child: Text(warn.isEmpty ? s.themeUploadInstall : s.themeUploadInstallAnyway),
            ),
          ],
        ),
      ],
    );
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 130, child: Text(label, style: const TextStyle(color: SurauColors.muted))),
        Expanded(child: Text(value)),
      ],
    ),
  );

  Widget _installedStep(S s, TextTheme text) {
    final inst = _installed!;
    final settings = ref.watch(settingsProvider).value?.value ?? const <String, dynamic>{};
    final cards = themeCards(settings);
    final current = cards.firstWhere((c) => c.active, orElse: () => cards.first).title;
    final support = ref.watch(themeSupportFullProvider).value;
    final offerable = support != null && themeOfferable(support, contract: _report?.contract ?? 1, builtIn: _report?.base);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.themeUploadInstalled(inst.title), key: const ValueKey('theme-upload-installed'), style: text.titleLarge),
        const SizedBox(height: 4),
        Text(s.themeUploadInstalledNote(current), style: text.bodyMedium),
        const SizedBox(height: 4),
        Text(s.themeUploadSavedNote, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        if (!offerable) ...[
          const SizedBox(height: 8),
          Text(support != null && !support.complete ? s.themeCannotConfirm : s.themeNotReadyNote, key: const ValueKey('theme-upload-not-ready')),
        ],
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        const SizedBox(height: 16),
        Row(
          children: [
            TextButton(
              key: const ValueKey('theme-upload-back'),
              onPressed: () => context.go(AppRoutes.settingsThemes),
              child: Text(s.themeUploadBack),
            ),
            const Spacer(),
            FilledButton(
              key: const ValueKey('theme-upload-use'),
              onPressed: _busy || !offerable ? null : _useNow,
              child: Text(s.themeUploadUseNow),
            ),
          ],
        ),
      ],
    );
  }
}
