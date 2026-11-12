// One feature: its switch (or `Sentiasa hidup` when locked), the form the
// registry shapes (settings_form.dart), `Simpan` that sends only the
// changed keys once the patch passes the core-equal validator, and `Set
// semula kepada lalai` behind a confirm. The box's answer is the form:
// after a save the values on screen are what it stored. An AJK sees the
// same page with every control read-only and no buttons.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../features/labels_ms.dart' show featureHelpMs;
import '../features/registry.g.dart';
import '../features/settings_form.dart';
import '../features/settings_repository.dart';
import '../features/shell/box_gateway.dart';
import '../features/settings_widgets/lanjutan_card.dart';
import '../features/shell/permissions.dart';
import '../features/sync/sync_settings_screen.dart';
import '../features/validate.dart';
import '../l10n/generated/s.dart';
import 'hadis/hadis_settings_body.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/settings/:feature`.
class SettingsFeatureScreen extends ConsumerWidget {
  const SettingsFeatureScreen({super.key, required this.featureKey, this.scrollToLanjutan = false});

  final String featureKey;

  /// `?lj=1`: opened from the Lanjutan group, so go straight to its card.
  final bool scrollToLanjutan;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Cloud sync has its own page: link status and `Selaraskan sekarang`.
    if (featureKey == cloudSyncKey) return const SyncSettingsScreen();
    final s = S.of(context);
    final f = featureByKey(featureKey);
    if (f == null) {
      return ShellPage(
        title: s.settingsTitle,
        body: SurauTheme.page(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(
                s.settingsNotFound,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ),
          ],
        ),
      );
    }
    final canWrite = canSee(ref.watch(rolesProvider), 'settings:write');
    final read = ref.watch(settingsProvider);
    final value = read.value;
    final Widget body;
    if (value != null) {
      final box = value.value[f.key];
      body = _FeatureForm(
        key: ValueKey('feature-${f.key}'),
        feature: f,
        original: _merge(
          f,
          box is Map ? box.cast<String, dynamic>() : const {},
        ),
        readOnly: !canWrite,
        scrollToLanjutan: scrollToLanjutan,
      );
    } else if (read.isLoading) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 24),
        child: LinearProgressIndicator(minHeight: 2),
      );
    } else {
      final error = read.error;
      body = Padding(
        padding: const EdgeInsets.symmetric(vertical: 28),
        child: Column(
          children: [
            const Icon(
              Icons.cloud_off_rounded,
              size: 36,
              color: SurauColors.outline,
            ),
            const SizedBox(height: 12),
            Text(
              error is BoxUnreachable ? s.errorBoxUnreachable : s.loadFailed,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => ref.invalidate(settingsProvider),
              icon: const Icon(Icons.refresh_rounded),
              label: Text(s.actionRetry),
            ),
          ],
        ),
      );
    }
    return ShellPage(
      title: f.labelMs,
      // Hadis has two columns on an iPad and a `Simpan` that stays in view;
      // its body scrolls by itself.
      body: value != null && f.key == hadisFeatureKey
          ? body
          : SurauTheme.page(children: [body]),
    );
  }
}

/// The box's values over the registry defaults (deep), with `enabled`, so
/// the form never shows a hole and a diff against it is only what changed.
Map<String, dynamic> _merge(FeatureDef f, Map<String, dynamic> box) {
  Object? merge(Object? d, Object? b) {
    if (d is Map) {
      final out = <String, dynamic>{};
      for (final e in d.entries) {
        out[e.key as String] = b is Map && b.containsKey(e.key)
            ? merge(e.value, b[e.key])
            : copyJson(e.value);
      }
      return out;
    }
    return b == null && d != null ? copyJson(d) : copyJson(b);
  }

  final enabled = box['enabled'];
  return {
    'enabled': enabled is bool ? enabled : f.defaultEnabled,
    ...(merge(f.defaults, box) as Map<String, dynamic>),
  };
}

class _FeatureForm extends ConsumerStatefulWidget {
  const _FeatureForm({
    super.key,
    required this.feature,
    required this.original,
    required this.readOnly,
    this.scrollToLanjutan = false,
  });

  final FeatureDef feature;
  final Map<String, dynamic> original;
  final bool readOnly;
  final bool scrollToLanjutan;

  @override
  ConsumerState<_FeatureForm> createState() => _FeatureFormState();
}

class _FeatureFormState extends ConsumerState<_FeatureForm> {
  late Map<String, dynamic> _edited =
      copyJson(widget.original) as Map<String, dynamic>;
  String? _error;
  bool _busy = false;

  /// The box's values changed under unsaved edits: the edits are kept and
  /// this says so, because saving them replaces what the other device set.
  bool _changedElsewhere = false;

  final GlobalKey _lanjutanKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    if (widget.scrollToLanjutan) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final target = _lanjutanKey.currentContext;
        if (target != null && target.mounted) {
          Scrollable.ensureVisible(target, duration: const Duration(milliseconds: 250), alignment: 0.05);
        }
      });
    }
  }

  @override
  void didUpdateWidget(covariant _FeatureForm old) {
    super.didUpdateWidget(old);
    if (diffPatch(old.original, widget.original).isEmpty &&
        diffPatch(widget.original, old.original).isEmpty) {
      return;
    }
    // What this person changed on top of the values they started from.
    final mine = diffPatch(old.original, _edited);
    final next = copyJson(widget.original) as Map<String, dynamic>;
    _applyPatch(next, mine);
    _edited = next;
    _error = null;
    // Their own save landing leaves nothing to warn about.
    _changedElsewhere = diffPatch(widget.original, _edited).isNotEmpty;
  }

  /// Lays [patch] (a [diffPatch] result) over [target].
  static void _applyPatch(
    Map<String, dynamic> target,
    Map<String, dynamic> patch,
  ) {
    for (final e in patch.entries) {
      final t = target[e.key];
      final v = e.value;
      if (t is Map<String, dynamic> &&
          v is Map<String, dynamic> &&
          !wholeValueKeys.contains(e.key)) {
        _applyPatch(t, v);
      } else {
        target[e.key] = copyJson(v);
      }
    }
  }

  Map<String, dynamic> get _patch => diffPatch(widget.original, _edited);

  void _set(String key, Object? value) => setState(() {
    _edited[key] = value;
    _error = null;
  });

  /// The box's 400 as `<path> <reason>` (core: `esolat.url must start
  /// with https://`): when the path names a setting of this feature the
  /// reason goes under that field; anything else stays a page line.
  (String path, String message)? get _boxFieldError {
    final e = _error;
    if (e == null) return null;
    final m = RegExp(
      r'^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*) (.+)$',
    ).firstMatch(e);
    if (m == null) return null;
    Object? node = widget.feature.defaults;
    for (final part in m.group(1)!.split('.')) {
      if (node is! Map || !node.containsKey(part)) return null;
      node = node[part];
    }
    return (m.group(1)!, m.group(2)!);
  }

  Future<void> _run(
    Future<void> Function(SettingsRepository repo) action,
  ) async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action(repo);
      if (!mounted) return;
      setState(() => _busy = false);
    } on SettingsSaveError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    } on SessionExpired {
      if (mounted) setState(() => _busy = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is OfflineWriteRefused
            ? OfflineWriteRefused.message
            : writeErrorText(s, e);
      });
    }
  }

  /// The feature switch. Turning the app lock on asks first: every user
  /// will be asked for a PIN at their next open.
  Future<void> _switch(bool on) async {
    if (on && widget.feature.key == 'appLock') {
      final s = S.of(context);
      final ok = await confirmDialog(
        context,
        title: s.appLockOnTitle,
        body: s.appLockOnBody,
        confirm: s.appLockOnConfirm,
      );
      if (!ok || !mounted) return;
    }
    _set('enabled', on);
  }

  Future<void> _save() async {
    final s = S.of(context);
    final patch = _patch;
    if (patch.isEmpty) return;
    await _run((repo) async {
      await repo.save(widget.feature.key, patch);
      if (mounted) {
        toast(
          context,
          widget.feature.key == hadisFeatureKey ? s.hadisSettingsSaved : s.settingsSaved,
        );
      }
    });
  }

  Future<void> _reset() async {
    final s = S.of(context);
    final f = widget.feature;
    final ok = await confirmDialog(
      context,
      title: s.settingsResetTitle(f.labelMs),
      body: s.settingsResetBody,
      confirm: s.settingsReset,
    );
    if (!ok || !mounted) return;
    await _run((repo) async {
      await repo.resetToDefaults(f.key);
      if (mounted) toast(context, s.settingsResetDone);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final f = widget.feature;
    final readOnly = widget.readOnly || _busy;
    final patch = _patch;
    final result = validateFeatureSettings(f.key, patch, current: widget.original);
    final fieldError = _boxFieldError;
    final errors = {
      for (final e in result.errors) e.path: e.message,
      if (fieldError != null) fieldError.$1: fieldError.$2,
    };
    final enabled = _edited['enabled'] == true;
    final values = {..._edited}..remove('enabled');
    final canSave = patch.isNotEmpty && result.ok && !readOnly;

    final saveButton = FilledButton.icon(
      key: const ValueKey('feature-save'),
      onPressed: canSave ? _save : null,
      icon: const Icon(Icons.check_rounded),
      label: Text(s.settingsSave),
    );
    final resetButton = TextButton.icon(
      onPressed: _busy ? null : _reset,
      icon: const Icon(Icons.restart_alt_rounded),
      label: Text(s.settingsReset),
    );

    final above = <Widget>[
        if (_changedElsewhere && patch.isNotEmpty)
          Padding(
            key: const ValueKey('settings-changed-elsewhere'),
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.info_outline,
                  size: 20,
                  color: SurauColors.muted,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    s.settingsChangedElsewhere,
                    style: text.bodyMedium,
                  ),
                ),
              ],
            ),
          ),
        if (widget.readOnly)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(
              s.settingsReadOnlyHint,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        Card(
          child: f.locked
              ? ListTile(
                  title: Text(f.labelMs),
                  subtitle: Text(systemFeatures.contains(f.key) ? s.featureLocked : s.settingsLockedHint),
                  trailing: systemFeatures.contains(f.key)
                      ? const PentadbirMaxcomBadge()
                      : StateChip(
                          label: s.featureLocked,
                          background: SurauColors.goldSoft,
                          foreground: SurauColors.ink,
                        ),
                  contentPadding: const EdgeInsets.fromLTRB(20, 8, 16, 8),
                )
              : SwitchListTile(
                  key: const ValueKey('feature-switch'),
                  value: enabled,
                  onChanged: readOnly ? null : (v) => _switch(v),
                  title: Text(f.labelMs),
                  subtitle: Text(enabled ? s.featureOn : s.featureOff),
                  contentPadding: const EdgeInsets.fromLTRB(20, 8, 12, 8),
                ),
        ),
        if (featureHelpMs[f.key] != null)
          Padding(
            key: ValueKey('feature-help-${f.key}'),
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
            child: Text(
              featureHelpMs[f.key]!,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        if (f.key == 'appLock' && ref.watch(isSuperadminProvider)) _DeviceLockCard(s: s, text: text),
        if (!f.locked && !enabled && f.key != 'appLock')
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
            child: Text(s.settingsFeatureOffHint, style: text.bodySmall),
          ),
        if (errors['enabled'] != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
            child: Text(
              errors['enabled']!,
              style: text.bodySmall!.copyWith(color: SurauColors.danger),
            ),
          ),
        const SizedBox(height: 22),
        if (f.defaults.isEmpty && f.key == 'appLock')
          const SizedBox.shrink()
        else if (f.defaults.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 22),
            child: Text(
              s.settingsNoSettings,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          )
        else if (f.key == hadisFeatureKey)
          HadisSettingsBody(
            values: values,
            errors: errors,
            readOnly: readOnly,
            onChanged: _set,
          )
        else
          SettingsForm(
            feature: f,
            values: values,
            errors: errors,
            readOnly: readOnly,
            onChanged: _set,
            lanjutanVisible: canSee(ref.watch(rolesProvider), 'system:read'),
            lanjutanKey: _lanjutanKey,
          ),
        if (_error != null && fieldError == null) ...[
          ErrorLine(_error!),
          const SizedBox(height: 16),
        ],
    ];

    if (f.key == hadisFeatureKey) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              padding: SurauTheme.pagePadding,
              children: [
                ...above,
                if (!widget.readOnly) ...[const SizedBox(height: 8), resetButton],
              ],
            ),
          ),
          if (!widget.readOnly)
            Container(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
              decoration: const BoxDecoration(
                color: SurauColors.paper,
                border: Border(top: BorderSide(color: SurauColors.line)),
              ),
              child: saveButton,
            ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...above,
        if (!widget.readOnly) ...[
          saveButton,
          const SizedBox(height: 8),
          resetButton,
        ],
      ],
    );
  }
}

/// The Pentadbir MAXCOM's own lock on the `Kunci aplikasi` page: always on,
/// whatever the surau's switch says.
class _DeviceLockCard extends StatelessWidget {
  const _DeviceLockCard({required this.s, required this.text});

  final S s;
  final TextTheme text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const ValueKey('superadmin-device-lock'),
      padding: const EdgeInsets.only(top: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
            child: Row(
              children: [
                Text(s.settingsDeviceLockSection, style: text.titleSmall!.copyWith(color: SurauColors.muted)),
                const SizedBox(width: 10),
                const PentadbirMaxcomBadge(),
              ],
            ),
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.lock_rounded, size: 26, color: SurauColors.teal),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          s.settingsDeviceLockTitle,
                          style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      StateChip(
                        label: s.featureLocked,
                        background: SurauColors.goldSoft,
                        foreground: SurauColors.ink,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                    decoration: BoxDecoration(
                      color: SurauColors.goldSoft,
                      borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                    ),
                    child: Text(s.settingsDeviceLockBody, style: text.bodyMedium!.copyWith(color: SurauColors.ink)),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The feature whose body is [HadisSettingsBody].
const String hadisFeatureKey = 'hadis';
