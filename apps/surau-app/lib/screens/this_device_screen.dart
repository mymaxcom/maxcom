// Peranti ini: what the box knows about the phone or iPad in hand and
// whose it is, the box address and certificate behind `Butiran teknikal`,
// then the person's own switches: a new PIN (the same PIN serves all
// their devices), fingerprint unlock on Android, `Log keluar` (locks the
// app, the enrolment stays) and `Keluar dari surau`, the one way out (the box
// is told, then the key and the enrolment go). There is no "forget this
// device": it left the box counting a phone that could never come back.
// The owner may rename this device ("Tukar nama peranti ini", live-only);
// the page shows the person's own ID, the device's ID and the person's own
// phone number (from `/api/auth/me`, which carries it for the caller only).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_address.dart';
import '../box/box_client.dart';
import '../features/common/error_text.dart';
import '../features/common/help_card.dart';
import '../features/common/ltr.dart';
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/phone.dart';
import '../features/people/ref.dart';
import '../features/common/roles.dart';
import '../features/enrol/pin_policy.dart';
import '../features/setup/leave_flow.dart';
import '../features/setup/network_check_sheet.dart';
import '../features/unlock/offline_vault.dart';
import '../features/unlock/session_keeper.dart';
import '../features/unlock/unlock_flow.dart';
import '../box/locator.dart' show CloudWaking;
import '../sync/sync_providers.dart' show baseLocatorProvider, sessionTokensProvider;
import '../sync/transport.dart' show boxAt, unlockAtLocated;
import '../ops/device_lock_card.dart';
import '../ops/ops_build.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String mePath = '/api/auth/me';

class ThisDeviceScreen extends ConsumerStatefulWidget {
  const ThisDeviceScreen({super.key});

  @override
  ConsumerState<ThisDeviceScreen> createState() => _ThisDeviceScreenState();
}

class _ThisDeviceScreenState extends ConsumerState<ThisDeviceScreen> {
  bool _biometricOffered = false;
  bool _biometricOn = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _readBiometric();
  }

  Future<void> _readBiometric() async {
    final deps = ref.read(appDepsProvider);
    final offered = deps.platform == 'android' && await deps.biometric.available();
    final on = offered && await deps.biometric.hasSealedPin();
    if (!mounted) return;
    setState(() {
      _biometricOffered = offered;
      _biometricOn = on;
    });
  }

  Future<void> _changePin() async {
    final s = S.of(context);
    final changed = await showModalBottomSheet<bool>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      constraints: const BoxConstraints(maxWidth: 520),
      builder: (context) => const _ChangePinSheet(),
    );
    if (changed == true && mounted) toast(context, s.pinChanged);
  }

  /// "Tukar nama peranti ini": the name of the phone this session runs on
  /// (`PUT /api/auth/device/name`). Old Log perubahan lines keep the old
  /// name. A box without the route says `peopleNeedsUpdate`.
  Future<void> _renameDevice(String current) async {
    final s = S.of(context);
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => _RenameDeviceDialog(current: current),
    );
    if (saved != true || !mounted) return;
    ref.invalidate(boxJsonProvider(mePath));
    toast(context, s.deviceRenamed);
  }

  Future<void> _toggleBiometric(bool on) async {
    final s = S.of(context);
    final deps = ref.read(appDepsProvider);
    if (!on) {
      await deps.biometric.clear();
      if (!mounted) return;
      setState(() => _biometricOn = false);
      toast(context, s.thisDeviceBiometricOff);
      return;
    }
    final pin = await showDialog<String>(
      context: context,
      builder: (context) => _AskPinDialog(verify: _pinProblem),
    );
    if (pin == null || !mounted) return;
    final sealed = await deps.biometric.seal(pin);
    if (!mounted) return;
    if (!sealed) {
      setState(() => _biometricOn = false);
      return;
    }
    setState(() => _biometricOn = true);
    toast(context, s.thisDeviceBiometricOn);
  }

  /// A8: the PIN is checked before it is sealed for the fingerprint, with
  /// the box (or the offline vault when the box is away). Null when it is
  /// right, else the sentence to show. A wrong PIN is never sealed: the next
  /// fingerprint unlock would fail and cost a server attempt.
  Future<String?> _pinProblem(String pin) async {
    final s = S.of(context);
    final box = ref.read(enrolledBoxProvider);
    final deps = ref.read(appDepsProvider);
    if (box == null) return s.errorBoxUnreachable;
    try {
      final locator = ref.read(baseLocatorProvider);
      if (locator != null) {
        await unlockAtLocated(
          locator: locator,
          box: box,
          clientFor: (base) => deps.enrolledClient(boxAt(box, base)),
          key: deps.key,
          biometric: deps.biometric,
          tokens: ref.read(sessionTokensProvider),
          pin: pin,
        );
      } else {
        final client = await ref.read(enrolledClientProvider.future);
        if (client == null) throw const BoxUnreachable();
        await UnlockFlow(
          client: client,
          key: deps.key,
          box: box,
          biometric: deps.biometric,
        ).run(pin: pin);
      }
      return null;
    } on UnlockWrongPin {
      return s.errcWrongPin;
    } on UnlockTooMany catch (e) {
      final secs = e.retryAfterSec ?? 60;
      return s.ra5UnlockTooMany(secs <= 0 ? 1 : (secs + 59) ~/ 60);
    } on UnlockLocked {
      return s.unlockLockedTitle;
    } on UnlockFailure {
      return s.errorRequestFailed;
    } on BoxUnreachable {
      return _offlinePinProblem(pin);
    } on CloudWaking {
      return _offlinePinProblem(pin);
    } on BoxError {
      return _offlinePinProblem(pin);
    }
  }

  Future<OfflineVault?> _vault() async {
    try {
      return await ref.read(offlineVaultProvider.future);
    } on Object {
      return null;
    }
  }

  Future<String?> _offlinePinProblem(String pin) async {
    final s = S.of(context);
    final vault = await _vault();
    final check = await vault?.checkPin(pin);
    return switch (check) {
      PinOk() => null,
      PinWrong(:final left) => s.offlinePinWrong(left),
      PinLocked() => s.unlockLockedTitle,
      PinClosed() => s.ra5OfflineClosed,
      _ => s.ra5SealCheckFailed,
    };
  }

  Future<void> _logout() async {
    setState(() => _busy = true);
    final gateway = ref.read(gatewayProvider);
    try {
      await gateway?.post('/api/auth/logout', const {});
    } catch (_) {
      // The box may be away or the session already gone: the app locks
      // either way and the enrolment stays.
    }
    if (!mounted) return;
    ref.read(sessionProvider.notifier).clear();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final box = ref.watch(enrolledBoxProvider);
    final lockOn = ref.watch(appLockProvider);
    final session = ref.watch(sessionProvider);
    final surau = ref.watch(surauInfoProvider)?.name ?? s.productName;
    final roles = rolesSentence(s, ref.watch(rolesProvider).toList());
    final me = ref.watch(boxJsonProvider(mePath)).value?.value;
    final device = me?['device'] is Map ? me!['device'] as Map : null;
    final deviceName = (device?['name'] as String?) ?? '';
    final platform = (device?['platform'] as String?) ?? ref.watch(appDepsProvider).platform;
    final userName = session?.user.name ?? box?.userName ?? '';
    final meUser = me?['user'] is Map ? me!['user'] as Map : null;
    final deviceRef = device?['ref'] is String ? device!['ref'] as String : null;
    final userRef = meUser?['ref'] is String ? meUser!['ref'] as String : null;
    final ownPhone = meUser?['phone'] is String && isE164(meUser!['phone'] as String)
        ? meUser['phone'] as String
        : null;

    return ShellPage(
      title: s.navThisDevice,
      body: SurauTheme.page(
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
              child: Row(
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: const BoxDecoration(
                      color: SurauColors.tealSoft,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(platformIcon(platform), size: 30, color: SurauColors.teal),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          deviceName.isEmpty ? s.navThisDevice : deviceName,
                          key: const ValueKey('this-device-name'),
                          style: text.titleLarge,
                        ),
                        if (deviceRef != null) RefText(deviceRef, key: const ValueKey('this-device-ref')),
                        const SizedBox(height: 2),
                        Text(
                          platformLabel(s, platform),
                          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                        ),
                        if (device != null) ...[
                          const SizedBox(height: 6),
                          TextButton.icon(
                            key: const ValueKey('this-device-rename'),
                            onPressed: _busy ? null : () => _renameDevice(deviceName),
                            style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              minimumSize: const Size(0, 40),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            icon: const Icon(Icons.edit_outlined, size: 18),
                            label: Text(s.thisDeviceRename),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          RowsCard(
            children: [
              _FactRow(
                icon: Icons.person_outline_rounded,
                label: s.thisDeviceUser,
                value: userName,
                idRef: userRef,
                detail: roles.isEmpty ? null : roles,
              ),
              if (ownPhone != null)
                _FactRow(
                  key: const ValueKey('this-device-phone'),
                  icon: Icons.phone_outlined,
                  label: s.phoneLabel,
                  value: ltr(formatPhone(ownPhone)),
                  detail: s.phonePrivate,
                ),
              _FactRow(
                icon: Icons.mosque_outlined,
                label: s.productName,
                value: surau,
              ),
            ],
          ),
          if (box != null) ...[
            const SizedBox(height: 12),
            TechnicalDetails(
              boxAddress: boxAddressText(box.box, name: box.name),
              fingerprint: box.caFingerprint,
            ),
          ],
          const SizedBox(height: 24),
          RowsCard(
            children: [
              if (kOpsBuild && ref.watch(isSuperadminProvider)) const DeviceLockAlwaysRow(),
              if (lockOn) ...[
                ListTile(
                  leading: const Icon(Icons.pin_outlined),
                  title: Text(s.thisDeviceChangePin),
                  subtitle: Text(s.thisDeviceChangePinHint),
                  trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                  onTap: _busy ? null : _changePin,
                ),
                if (_biometricOffered)
                  SwitchListTile(
                    secondary: const Icon(Icons.fingerprint_rounded),
                    title: Text(s.biometricUse),
                    subtitle: Text(s.thisDeviceBiometricHint),
                    value: _biometricOn,
                    onChanged: _busy ? null : _toggleBiometric,
                  ),
              ] else
                // The sealed biometric PIN is kept, so turning the lock on
                // again brings the fingerprint button back.
                ListTile(
                  key: const ValueKey('this-device-no-lock'),
                  leading: const Icon(Icons.lock_open_rounded),
                  title: Text(s.appLockOffLine),
                  subtitle: Text(s.appLockOffHint),
                ),
              ListTile(
                leading: const Icon(Icons.lock_outline_rounded),
                title: Text(s.actionLogout),
                subtitle: Text(s.thisDeviceLogoutHint),
                onTap: _busy ? null : _logout,
              ),
              ListTile(
                key: const ValueKey('this-device-scan'),
                leading: const Icon(Icons.qr_code_scanner_rounded),
                title: Text(s.scanEntry),
                subtitle: Text(s.scanEntryHint),
                trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                onTap: _busy ? null : () => context.go(AppRoutes.scan),
              ),
              ListTile(
                key: const ValueKey('this-device-netcheck'),
                leading: const Icon(Icons.network_check_rounded),
                title: Text(s.netCheckEntry),
                trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                onTap: _busy ? null : () => showNetworkCheck(context),
              ),
              ListTile(
                key: const ValueKey('this-device-leave'),
                leading: const Icon(Icons.logout_rounded, color: SurauColors.danger),
                title: Text(
                  s.leaveTitle,
                  style: const TextStyle(color: SurauColors.danger),
                ),
                subtitle: Text(s.ra5LeaveHint),
                onTap: _busy ? null : () => startLeave(context, ref, onBusy: (b) => mounted ? setState(() => _busy = b) : null),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.detail,
    this.idRef,
  });

  final IconData icon;
  final String label;
  final String value;
  final String? detail;

  /// The ID under the value (a person's `U-0001`).
  final String? idRef;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 24, color: SurauColors.teal),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: text.bodySmall),
                const SizedBox(height: 2),
                Text(value, style: text.titleSmall),
                if (idRef != null) RefText(idRef, key: const ValueKey('this-device-user-ref')),
                if (detail != null)
                  Text(detail!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The device name, prefilled; saved through `renameOwnDevice`. Pops true
/// when saved; a refusal stays in the dialog in the person's words.
class _RenameDeviceDialog extends ConsumerStatefulWidget {
  const _RenameDeviceDialog({required this.current});

  final String current;

  @override
  ConsumerState<_RenameDeviceDialog> createState() => _RenameDeviceDialogState();
}

class _RenameDeviceDialogState extends ConsumerState<_RenameDeviceDialog> {
  late final _name = TextEditingController(text: widget.current);
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final s = S.of(context);
    final problem = nameProblem(s, _name.text);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    if (cleanedName(_name.text) == cleanedName(widget.current)) {
      Navigator.of(context).pop(false);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(peopleApiProvider).renameOwnDevice(_name.text);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = errorText(s, e);
      });
      return;
    }
    if (mounted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      title: Text(s.thisDeviceRename),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const ValueKey('this-device-name-field'),
              controller: _name,
              autofocus: true,
              maxLength: 80,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                labelText: s.deviceNameLabel,
                hintText: s.deviceNameHint,
                errorText: _error,
                errorMaxLines: 3,
                counterText: '',
              ),
              onSubmitted: (_) => _save(),
            ),
            const SizedBox(height: 10),
            Text(
              s.deviceRenameHistory,
              style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
            ),
          ],
        ),
      ),
      actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          key: const ValueKey('this-device-name-save'),
          onPressed: _busy ? null : _save,
          child: Text(s.userRenameSave),
        ),
      ],
    );
  }
}

/// Current PIN, new PIN twice; `PUT /api/auth/pin` straight on the client
/// (not through the gateway: the box answers a wrong current PIN with
/// 401, which must not read as an expired session). Pops true when done.
class _ChangePinSheet extends ConsumerStatefulWidget {
  const _ChangePinSheet();

  @override
  ConsumerState<_ChangePinSheet> createState() => _ChangePinSheetState();
}

class _ChangePinSheetState extends ConsumerState<_ChangePinSheet> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _again = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _again.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final s = S.of(context);
    if (_next.text != _again.text) {
      setState(() => _error = s.pinMismatch);
      return;
    }
    if (!isValidPin(_next.text)) {
      setState(() => _error = s.pinTooWeak);
      return;
    }
    if (_current.text.length != pinLength) {
      setState(() => _error = s.pinHint);
      return;
    }
    final client = ref.read(enrolledClientProvider).value;
    final session = ref.read(sessionProvider);
    if (client == null || session == null) return;
    if (ref.read(connectivityProvider).down) {
      setState(() => _error = s.offlineWriteRefused);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await client.putJson(
        '/api/auth/pin',
        {'currentPin': _current.text, 'newPin': _next.text},
        token: session.token,
      );
      // A2: the app now holds the NEW PIN: the next silent unlock sends it
      // (the old one would be refused and count against the account), and
      // the offline vault accepts it and no longer the old one.
      ref.read(pinMemoryProvider).replace(_next.text);
      final vault = await _vault();
      try {
        await vault?.savePin(_next.text);
      } on Object {
        // the online PIN changed; the offline copy catches up at the next unlock
      }
      final biometric = ref.read(appDepsProvider).biometric;
      if (await biometric.hasSealedPin()) {
        // A failed re-seal must not leave the old PIN sealed.
        if (!await biometric.seal(_next.text)) await biometric.clear();
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on BoxError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.status == 429 ? s.errorTooMany : e.message;
      });
    } on BoxUnreachable {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = s.errorBoxUnreachable;
      });
    }
  }

  Future<OfflineVault?> _vault() async {
    try {
      return await ref.read(offlineVaultProvider.future);
    } on Object {
      return null;
    }
  }

  void _clearError(String _) {
    if (_error != null) setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 24 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s.thisDeviceChangePin, style: text.titleLarge),
          const SizedBox(height: 4),
          Text(s.enrolPinCreateHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 20),
          PinField(
            key: const ValueKey('pin-current'),
            controller: _current,
            label: s.pinCurrentLabel,
            autofocus: true,
            onChanged: _clearError,
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: PinField(
                  key: const ValueKey('pin-new'),
                  controller: _next,
                  label: s.enrolPinNewHint,
                  onChanged: _clearError,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: PinField(
                  key: const ValueKey('pin-again'),
                  controller: _again,
                  label: s.enrolPinAgainLabel,
                  onChanged: _clearError,
                ),
              ),
            ],
          ),
          if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: Text(s.thisDeviceChangePin),
          ),
          const SizedBox(height: 4),
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(false),
            child: Text(s.actionCancel),
          ),
        ],
      ),
    );
  }
}

/// Asks the PIN to seal for fingerprint unlock; pops it, or null.
class _AskPinDialog extends StatefulWidget {
  const _AskPinDialog({required this.verify});

  /// Null when the PIN is right, else the sentence to show.
  final Future<String?> Function(String pin) verify;

  @override
  State<_AskPinDialog> createState() => _AskPinDialogState();
}

class _AskPinDialogState extends State<_AskPinDialog> {
  final _pin = TextEditingController();
  String? _error;
  bool _checking = false;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _ok() async {
    if (_checking) return;
    if (_pin.text.length != pinLength) {
      setState(() => _error = S.of(context).pinHint);
      return;
    }
    setState(() => _checking = true);
    final problem = await widget.verify(_pin.text);
    if (!mounted) return;
    if (problem != null) {
      setState(() {
        _checking = false;
        _error = problem;
      });
      return;
    }
    Navigator.of(context).pop(_pin.text);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      title: Text(s.thisDeviceBiometricOnTitle),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.thisDeviceBiometricOnBody),
            const SizedBox(height: 16),
            PinField(
              key: const ValueKey('pin-seal'),
              controller: _pin,
              label: s.pinLabel,
              autofocus: true,
              errorText: _error,
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
          ],
        ),
      ),
      actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.actionCancel),
        ),
        FilledButton(onPressed: _checking ? null : _ok, child: Text(s.actionContinue)),
      ],
    );
  }
}
