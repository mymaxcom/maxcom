// Penyelarasan awan (Plan 6 Task 9): the feature switch and how often the
// cloud is checked (only the Pentadbir MAXCOM may change either: `system:write`),
// the cloud address (read-only, set by the link), whether MAXCOM at the surau is linked to the
// cloud with its last send, last receive and last error
// (`GET /api/sync/status`), and `Selaraskan sekarang` (`POST /api/sync/run`,
// live only). Linking itself is a step on MAXCOM by the system
// administrator, so the page says so instead of offering it.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import '../labels_ms.dart';
import '../settings_repository.dart';
import '../settings_widgets/chips_field.dart';
import '../settings_widgets/field_meta.dart';
import '../shell/permissions.dart';
import 'live_only_dialog.dart';
import 'sync_status_chip.dart' show stampWords;

const String syncStatusPath = '/api/sync/status';
const String syncRunPath = '/api/sync/run';
const String cloudSyncKey = 'cloudSync';

/// `GET /api/sync/status` as the box answers it.
class SyncStatus {
  const SyncStatus({
    required this.linked,
    this.cloudUrl,
    this.lastPush,
    this.lastPull,
    this.pendingOut = 0,
    this.lastError,
  });

  factory SyncStatus.fromJson(Map<String, dynamic> j) => SyncStatus(
    linked: j['linked'] == true,
    cloudUrl: j['cloudUrl'] as String?,
    lastPush: _time(j['lastPush']),
    lastPull: _time(j['lastPull']),
    pendingOut: (j['pendingOut'] as num?)?.toInt() ?? 0,
    lastError: j['lastError'] as String?,
  );

  static DateTime? _time(Object? v) =>
      v is String ? DateTime.tryParse(v) : null;

  final bool linked;
  final String? cloudUrl;
  final DateTime? lastPush;
  final DateTime? lastPull;
  final int pendingOut;
  final String? lastError;
}

class SyncSettingsScreen extends ConsumerWidget {
  const SyncSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final roles = ref.watch(rolesProvider);
    final canWrite = canSee(roles, 'settings:write');
    final canSystem = canSee(roles, 'system:write');
    final settings = ref.watch(settingsProvider).value?.value;
    final raw = settings?[cloudSyncKey];
    final feature = raw is Map
        ? raw.cast<String, dynamic>()
        : const <String, dynamic>{};

    return ShellPage(
      title: s.syncSettingsTitle,
      body: SurauTheme.page(
        children: [
          Text(
            s.syncSettingsHelp,
            style: text.bodyLarge!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 18),
          if (settings == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: LinearProgressIndicator(minHeight: 2),
            )
          else
            _CloudForm(
              key: ValueKey(
                'cloud-form-${feature['enabled']}-${feature['dirtyCheckSeconds']}',
              ),
              enabled: feature['enabled'] != false,
              cloudUrl: (feature['cloudUrl'] as String?) ?? '',
              dirtyCheckSeconds: (feature['dirtyCheckSeconds'] as num?)?.toInt() ?? 120,
              readOnly: !canSystem,
            ),
          const SizedBox(height: 22),
          SectionLabel(s.syncSettingsStatus),
          const _StatusCard(),
          const SizedBox(height: 12),
          Row(
            children: [
              const Icon(
                Icons.info_outline_rounded,
                size: 20,
                color: SurauColors.muted,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  s.syncSettingsLinkNote,
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
              ),
            ],
          ),
          if (canWrite) ...[const SizedBox(height: 20), const _SyncNowButton()],
        ],
      ),
    );
  }
}

class _CloudForm extends ConsumerStatefulWidget {
  const _CloudForm({
    super.key,
    required this.enabled,
    required this.cloudUrl,
    required this.dirtyCheckSeconds,
    required this.readOnly,
  });

  final bool enabled;
  final String cloudUrl;
  final int dirtyCheckSeconds;
  final bool readOnly;

  @override
  ConsumerState<_CloudForm> createState() => _CloudFormState();
}

class _CloudFormState extends ConsumerState<_CloudForm> {
  late bool _enabled = widget.enabled;
  late final TextEditingController _url = TextEditingController(
    text: widget.cloudUrl,
  );
  late int _dirtyCheck = widget.dirtyCheckSeconds;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  bool get _dirty =>
      _enabled != widget.enabled || _dirtyCheck != widget.dirtyCheckSeconds;

  Future<void> _save() async {
    final s = S.of(context);
    setState(() => _error = null);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null) return;
    final patch = <String, dynamic>{
      if (_enabled != widget.enabled) 'enabled': _enabled,
      if (_dirtyCheck != widget.dirtyCheckSeconds) 'dirtyCheckSeconds': _dirtyCheck,
    };
    setState(() => _busy = true);
    try {
      await repo.save(cloudSyncKey, patch);
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, s.settingsSaved);
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
        _error = writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ro = widget.readOnly;
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwitchListTile(
              key: const ValueKey('cloud-enabled'),
              contentPadding: EdgeInsets.zero,
              title: Text(s.syncSettingsEnabled, style: text.titleMedium),
              value: _enabled,
              onChanged: ro || _busy
                  ? null
                  : (v) => setState(() => _enabled = v),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('cloud-url'),
              controller: _url,
              readOnly: true,
              enabled: !_busy,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: s.syncSettingsUrl,
                helperText: s.syncSettingsUrlFixed,
                helperMaxLines: 2,
                prefixIcon: const Icon(Icons.cloud_outlined),
              ),
            ),
            const SizedBox(height: 4),
            ChipsField(
              path: 'dirtyCheckSeconds',
              name: 'dirtyCheckSeconds',
              label: settingLabelMs('dirtyCheckSeconds'),
              value: _dirtyCheck,
              meta: fieldMeta(cloudSyncKey, 'dirtyCheckSeconds')!,
              help: settingHelpMs['dirtyCheckSeconds'],
              readOnly: ro || _busy,
              padding: const EdgeInsets.symmetric(vertical: 10),
              onChanged: (v) => setState(() => _dirtyCheck = v as int),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              ErrorLine(_error!),
            ],
            if (!ro) ...[
              const SizedBox(height: 16),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: _busy || !_dirty ? null : _save,
                  child: Text(s.actionSave),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends ConsumerWidget {
  const _StatusCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final read = ref.watch(boxJsonProvider(syncStatusPath));
    final body = read.value?.value;
    if (body == null) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: read.isLoading
              ? const LinearProgressIndicator(minHeight: 2)
              : Text(s.syncSettingsStatusUnavailable, style: text.bodyLarge),
        ),
      );
    }
    final st = SyncStatus.fromJson(body);
    final today = deps.toLocal(deps.now());
    String when(DateTime? t) => t == null
        ? s.syncSettingsNone
        : stampWords(deps.toLocal(t), today: today);

    Widget row(String label, Widget value) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 13, 20, 13),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: Text(
              label,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 6,
            child: Align(alignment: Alignment.centerRight, child: value),
          ),
        ],
      ),
    );
    Text plain(String v, {Color? color}) => Text(
      v,
      textAlign: TextAlign.end,
      style: text.bodyLarge!.copyWith(
        fontWeight: FontWeight.w600,
        color: color,
      ),
    );

    return RowsCard(
      children: [
        row(
          s.syncSettingsLinked,
          StateChip(
            label: st.linked ? s.syncYes : s.syncNo,
            background: st.linked
                ? SurauColors.tealSoft
                : SurauColors.paperDeep,
            foreground: st.linked ? SurauColors.teal : SurauColors.muted,
          ),
        ),
        if (st.cloudUrl != null && st.cloudUrl!.isNotEmpty)
          row(s.syncSettingsUrl, plain(st.cloudUrl!)),
        row(s.syncSettingsLastPush, plain(when(st.lastPush))),
        row(s.syncSettingsLastPull, plain(when(st.lastPull))),
        row(s.syncWaitingLabel, plain('${st.pendingOut}')),
        row(
          s.syncErrorLabel,
          plain(
            st.lastError ?? s.syncSettingsNone,
            color: st.lastError == null ? null : SurauColors.danger,
          ),
        ),
      ],
    );
  }
}

class _SyncNowButton extends ConsumerStatefulWidget {
  const _SyncNowButton();

  @override
  ConsumerState<_SyncNowButton> createState() => _SyncNowButtonState();
}

class _SyncNowButtonState extends ConsumerState<_SyncNowButton> {
  bool _busy = false;

  Future<void> _run() async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() => _busy = true);
    try {
      await gateway.post(syncRunPath, const {});
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(syncStatusPath));
      toast(context, s.syncSettingsRunDone);
    } catch (e) {
      if (!mounted) return;
      if (!await showLiveOnlyIf(context, e) && mounted) {
        toast(context, writeErrorText(s, e));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return FilledButton.icon(
      key: const ValueKey('sync-run'),
      onPressed: _busy ? null : _run,
      icon: _busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2.2,
                color: Colors.white,
              ),
            )
          : const Icon(Icons.sync_rounded),
      label: Text(s.syncNow),
    );
  }
}
