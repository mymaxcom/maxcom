// One feature: its switch (or `Sentiasa hidup` when locked), the form the
// registry shapes (settings_form.dart), `Simpan` that sends only the
// changed keys once the patch passes the core-equal validator (the whole
// page on the first save of a feature with no stored row, B4), and `Set
// semula kepada lalai` in the page menu, behind a confirm (it keeps the
// feature's switch and a camera's identity, G2). The box's answer is the form:
// after a save the values on screen are what it stored. An AJK sees the
// same page with every control read-only and no buttons.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/app_lang.dart';
import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../features/labels.dart';
import '../features/live/relay_capability.dart';
import '../features/labels_cam.dart' show cameraUseOff, cameraUseOn, cameraUseTitle;
import '../features/registry.g.dart';
import '../features/settings_form.dart';
import '../features/settings_widgets/camera_source_card.dart';
import '../features/settings_repository.dart';
import '../features/shell/box_gateway.dart';
import '../features/shell/connection_icons.dart' show LinkGlyph, LinkKind, LinkState;
import '../features/shell/permissions.dart';
import '../features/sync/sync_settings_screen.dart';
import '../features/validate.dart';
import '../ops/device_lock_card.dart';
import '../ops/lanjutan_card.dart';
import '../ops/ops_build.dart';
import '../l10n/generated/s.dart';
import 'hadis/hadis_settings_body.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/settings/:feature`.
class SettingsFeatureScreen extends ConsumerWidget {
  const SettingsFeatureScreen({super.key, required this.featureKey, this.scrollToLanjutan = false, this.backTo});

  final String featureKey;

  /// Opened from another page (Siaran langsung): Back goes there.
  final String? backTo;

  /// `?lj=1`: opened from the Lanjutan group, so go straight to its card.
  final bool scrollToLanjutan;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Cloud sync has its own page: link status and `Selaraskan sekarang`.
    if (kOpsBuild && featureKey == cloudSyncKey) return const SyncSettingsScreen();
    final s = S.of(context);
    final f = featureByKey(featureKey);
    // The MAXCOM system pages (group `lanjutan`) exist only in the ops build.
    if (f == null || (!kOpsBuild && f.group == 'lanjutan')) {
      return ShellPage(
        backTo: backTo,
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
    final roles = ref.watch(rolesProvider);
    // The camera form (address, login, test) belongs to Siaran Langsung (`live:settings`), not to Tetapan in general.
    if (f.key == liveCameraFeatureKey && !canSee(roles, 'live:settings')) {
      return ShellPage(
        backTo: backTo,
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
    final canWrite = canWriteSettingsFeature(roles, f.key);
    final read = ref.watch(settingsProvider);
    final value = read.value;
    final Widget body;
    // The form's own state, for the page menu (the reset lives there, away from Simpan: G2).
    final formKey = _formKeys.putIfAbsent(f.key, GlobalKey<_FeatureFormState>.new);
    if (value != null) {
      final box = value.value[f.key];
      body = KeyedSubtree(
        key: ValueKey('feature-${f.key}'),
        child: _FeatureForm(
        key: formKey,
        feature: f,
        stale: value.stale,
        original: _merge(
          f,
          box is Map ? box.cast<String, dynamic>() : const {},
        ),
        readOnly: !canWrite,
        scrollToLanjutan: scrollToLanjutan,
        unsupported: unsupportedByBox(f.key, box is Map ? box.cast<String, dynamic>() : const {}),
        ),
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
            if (error is BoxUnreachable)
              const LinkGlyph(kind: LinkKind.box, state: LinkState.disconnected, size: 36, onDark: false)
            else
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
      backTo: backTo,
      title: featureLabel(f, ref.watch(appLangProvider)),
      actions: [
        if (value != null && canWrite)
          PopupMenuButton<String>(
            key: const ValueKey('feature-menu'),
            tooltip: s.settingsReset,
            icon: const Icon(Icons.more_vert_rounded),
            onSelected: (_) => formKey.currentState?.resetFromMenu(),
            itemBuilder: (context) => [
              PopupMenuItem<String>(
                key: const ValueKey('feature-reset'),
                value: 'reset',
                child: Row(
                  children: [
                    const Icon(Icons.restart_alt_rounded, size: 20, color: SurauColors.muted),
                    const SizedBox(width: 12),
                    Flexible(child: Text(s.settingsReset)),
                  ],
                ),
              ),
            ],
          ),
      ],
      // Hadis has two columns on an iPad and a `Simpan` that stays in view;
      // its body scrolls by itself.
      body: value != null && f.key == hadisFeatureKey
          ? body
          : SurauTheme.page(children: [body]),
    );
  }
}

/// One key per feature form, kept for the run: the page menu reaches the
/// form's state through it, and the form keeps its unsaved edits across the
/// page's rebuilds.
final Map<String, GlobalKey<_FeatureFormState>> _formKeys = {};

/// Settings added after the first box release, by feature: a box that does not send one does not know it,
/// so the form neither draws it nor sends it (an older box answers 400 to an unknown field).
const Map<String, Set<String>> _newerSettings = {
  'videos': {'volume'},
};

/// The newer settings of [feature] that the box's own answer [box] lacks.
Set<String> unsupportedByBox(String feature, Map<String, dynamic> box) =>
    {for (final k in _newerSettings[feature] ?? const <String>{}) if (!box.containsKey(k)) k};

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

/// Every feature's values (with `enabled`), for fields another setting switches off.
Map<String, Map<String, dynamic>> _othersOf(WidgetRef ref) {
  final all = ref.watch(settingsProvider).value?.value;
  return {
    for (final f in features)
      f.key: _merge(f, all?[f.key] is Map ? (all![f.key] as Map).cast<String, dynamic>() : const {}),
  };
}

class _FeatureForm extends ConsumerStatefulWidget {
  const _FeatureForm({
    super.key,
    required this.feature,
    required this.original,
    required this.readOnly,
    this.scrollToLanjutan = false,
    this.unsupported = const {},
    this.stale = false,
  });

  /// The values come from this device's copy because MAXCOM did not answer:
  /// the page says they may be out of date (G1).
  final bool stale;

  /// Settings this box did not send (an older box): not drawn, not reset.
  final Set<String> unsupported;

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

  /// The box's values for this feature changed while the page was open, by
  /// another device (never by this page's own save): "Tetapan ini baru diubah
  /// pada peranti lain", with "Muat semula" (G4).
  bool _changedNow = false;

  /// This page's own save or reset is under way: the change of values that
  /// follows it is not another device's.
  bool _ownWrite = false;

  final GlobalKey _lanjutanKey = GlobalKey();

  /// The sealed camera record behind the Kamera luaran form; saved with the same `Simpan`.
  CameraSourceController? _camera;

  @override
  void initState() {
    super.initState();
    if (widget.feature.key == liveCameraFeatureKey) {
      _camera = CameraSourceController(() => ref.read(gatewayProvider), viaCloud: () => ref.read(isCloudGatewayProvider))
        ..addListener(() {
          if (mounted) setState(() {});
        })
        ..load();
    }
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
    if (_ownWrite) {
      _ownWrite = false;
    } else {
      _changedNow = true;
    }
  }

  /// "Muat semula": the values MAXCOM holds now, this page's unsaved edits dropped.
  void _reload() {
    setState(() {
      _edited = copyJson(widget.original) as Map<String, dynamic>;
      _changedElsewhere = false;
      _changedNow = false;
      _error = null;
    });
    ref.invalidate(settingsProvider);
  }

  /// The page menu's "Set semula kepada lalai".
  void resetFromMenu() {
    if (_busy || widget.readOnly) return;
    unawaited(_reset());
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

  @override
  void dispose() {
    _camera?.dispose();
    super.dispose();
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
    _ownWrite = true;
    try {
      await action(repo);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _changedNow = false;
      });
    } on SettingsSaveError catch (e) {
      _ownWrite = false;
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.text(s);
      });
    } on SessionExpired {
      _ownWrite = false;
      if (mounted) setState(() => _busy = false);
    } catch (e) {
      _ownWrite = false;
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
    final camera = _camera;
    if (patch.isEmpty && !(camera?.dirty ?? false)) return;
    await _run((repo) async {
      // The address and login first: a refused address stops the save and shows under its field.
      if (camera != null && !await camera.save()) return;
      if (patch.isNotEmpty) {
        // The first save of a feature with no stored row sends the whole page
        // (the switch and every value), not only the cell that was touched: a
        // row holding one cell read as "switched off" everywhere else (B4).
        final first = await repo.rowMissing(widget.feature.key);
        if (!mounted) return;
        await repo.save(
          widget.feature.key,
          first
              ? fullRowPatch(
                  widget.feature.key,
                  _edited,
                  changed: patch,
                  includeSystem: canSee(ref.read(rolesProvider), 'system:write'),
                  without: widget.unsupported,
                )
              : patch,
        );
      }
      if (mounted) {
        toast(
          context,
          widget.feature.key == hadisFeatureKey
              ? s.hadisSettingsSaved
              : (repo.lastSaveQueued ? s.ra6SettingsSavedQueued : s.settingsSaved),
        );
      }
    });
  }

  Future<void> _reset() async {
    final s = S.of(context);
    final f = widget.feature;
    final ok = await confirmDialog(
      context,
      title: s.settingsResetTitle(featureLabel(f, ref.read(appLangProvider))),
      // the camera keeps its switch, name, address and login (G2)
      body: f.key == liveCameraFeatureKey ? s.cameraResetBody : s.settingsResetBody,
      confirm: s.settingsReset,
    );
    if (!ok || !mounted) return;
    await _run((repo) async {
      await repo.resetToDefaults(f.key, includeSystem: canSee(ref.read(rolesProvider), 'system:write'), without: widget.unsupported);
      if (mounted) toast(context, s.settingsResetDone);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final f = widget.feature;
    // The app lock lives on the box alone: with the box away its state is the
    // last one heard, so the page says it needs the connection and changes
    // nothing (K1).
    final lockAway = f.key == 'appLock' &&
        (ref.watch(settingsProvider).value?.value['appLock'] is Map &&
            (ref.watch(settingsProvider).value!.value['appLock'] as Map)['_live'] == false);
    // A feature that needs another (Siaran YouTube needs the live on the TV)
    // cannot be switched on while that one is off: say which (registry
    // `featureRequires`).
    final needs = featureRequires[f.key]?['requires'];
    final needsDef = needs == null ? null : featureByKey(needs);
    final needsOff = needsDef != null && _othersOf(ref)[needs]?['enabled'] != true;
    final readOnly = widget.readOnly || _busy || lockAway;
    final patch = _patch;
    final result = validateFeatureSettings(f.key, patch, current: widget.original, s: s);
    final fieldError = _boxFieldError;
    final errors = {
      for (final e in result.errors) e.path: e.message,
      if (fieldError != null) fieldError.$1: fieldError.$2,
    };
    final enabled = _edited['enabled'] == true;
    final values = {..._edited}..remove('enabled');
    final camera = _camera;
    final canSave = (patch.isNotEmpty || (camera?.dirty ?? false)) &&
        result.ok &&
        (camera?.valid ?? true) &&
        !readOnly;

    final saveButton = FilledButton.icon(
      key: const ValueKey('feature-save'),
      onPressed: canSave ? _save : null,
      icon: const Icon(Icons.check_rounded),
      label: Text(s.settingsSave),
    );
    final lang = ref.watch(appLangProvider);
    Widget hint(Key key, String label, {String? action, VoidCallback? onAction}) => Padding(
      key: key,
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
      child: Row(
        children: [
          const Icon(Icons.info_outline, size: 20, color: SurauColors.muted),
          const SizedBox(width: 10),
          Expanded(child: Text(label, style: text.bodyMedium)),
          if (action != null)
            TextButton(key: const ValueKey('settings-reload'), onPressed: onAction, child: Text(action)),
        ],
      ),
    );
    final above = <Widget>[
        if (widget.stale) hint(const ValueKey('settings-maybe-stale'), s.settingsMaybeStale),
        if (_changedNow)
          hint(
            const ValueKey('settings-changed-now'),
            s.settingsChangedElsewhereNow,
            action: s.settingsReload,
            onAction: _busy ? null : _reload,
          ),
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
                  title: Text(featureLabel(f, lang)),
                  subtitle: Text(kOpsBuild && f.group == 'lanjutan' ? s.featureLocked : s.settingsLockedHint),
                  trailing: kOpsBuild && f.group == 'lanjutan'
                      ? const PentadbirMaxcomBadge()
                      : StateChip.on(label: s.featureLocked),
                  contentPadding: const EdgeInsetsDirectional.fromSTEB(20, 8, 16, 8),
                )
              : SwitchListTile(
                  key: const ValueKey('feature-switch'),
                  value: enabled,
                  onChanged: readOnly || (needsOff && !enabled) ? null : (v) => _switch(v),
                  title: Text(camera != null ? cameraUseTitle(lang) : featureLabel(f, lang)),
                  subtitle: Text(camera != null ? (enabled ? cameraUseOn(lang) : cameraUseOff(lang)) : (enabled ? s.featureOn : s.featureOff)),
                  contentPadding: const EdgeInsetsDirectional.fromSTEB(20, 8, 12, 8),
                ),
        ),
        if (needsOff && !enabled)
          Padding(
            key: const ValueKey('feature-requires'),
            padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
            child: Text(s.ra6FeatureNeeds(featureLabel(needsDef, lang)), style: text.bodyMedium!.copyWith(color: SurauColors.danger)),
          ),
        if (lockAway)
          Padding(
            key: const ValueKey('applock-needs-box'),
            padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
            child: Text(s.ra6AppLockNeedsBox, style: text.bodyMedium!.copyWith(color: SurauColors.danger)),
          ),
        if (featureHelp(f.key, lang) != null)
          Padding(
            key: ValueKey('feature-help-${f.key}'),
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
            child: Text(
              featureHelp(f.key, lang)!,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        if (kOpsBuild && f.key == 'appLock' && ref.watch(isSuperadminProvider)) const DeviceLockCard(),
        if (!f.locked && !enabled && f.key != 'appLock' && camera == null)
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
        else if (camera != null)
          CameraSourceCard(
            controller: camera,
            enabled: enabled,
            name: values['name'] is String ? values['name'] as String : '',
            transport: values['transport'] is String ? values['transport'] as String : 'auto',
            brightness: values['brightness'] is String ? values['brightness'] as String : 'auto',
            readOnly: readOnly,
            nameError: errors['name'],
            onChanged: _set,
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
            lanjutanVisible: kOpsBuild && canSee(ref.watch(rolesProvider), 'system:read'),
            lanjutanKey: _lanjutanKey,
            others: _othersOf(ref),
            relayReencode: f.key == 'liveYoutube' ? ref.watch(relayReencodeProvider).value : null,
            unsupported: widget.unsupported,
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
              children: above,
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
        // Room under Simpan (where the reset used to be), so a toast never sits on it.
        if (!widget.readOnly) ...[saveButton, const SizedBox(height: 56)],
      ],
    );
  }
}

/// The feature whose body is [CameraSourceCard].
const String liveCameraFeatureKey = 'liveCamera';

/// The feature whose body is [HadisSettingsBody].
const String hadisFeatureKey = 'hadis';
