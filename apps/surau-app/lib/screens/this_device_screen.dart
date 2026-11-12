// Peranti ini: what the box knows about the phone or iPad in hand and
// whose it is, the box address and certificate behind `Butiran teknikal`,
// then the person's own switches: a new PIN (the same PIN serves all
// their devices), fingerprint unlock on Android, `Log keluar` (locks the
// app, the enrolment stays) and `Lupakan peranti ini` (key and enrolment
// gone; a new QR code is needed to come back).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../features/common/help_card.dart';
import '../features/common/roles.dart';
import '../features/enrol/pin_policy.dart';
import '../features/setup/leave_flow.dart';
import '../features/setup/network_check_sheet.dart';
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
      builder: (context) => const _AskPinDialog(),
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

  Future<void> _forget() async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.thisDeviceForgetTitle,
      body: s.thisDeviceForgetHint,
      confirm: s.thisDeviceForgetConfirm,
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    final deps = ref.read(appDepsProvider);
    final gateway = ref.read(gatewayProvider);
    try {
      await gateway?.post('/api/auth/logout', const {});
    } catch (_) {
      // as above
    }
    await deps.biometric.clear();
    await deps.key.clear();
    if (!mounted) return;
    ref.read(sessionProvider.notifier).clear();
    await ref.read(enrolledBoxProvider.notifier).forget();
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
                          style: text.titleLarge,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          platformLabel(s, platform),
                          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                        ),
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
                detail: roles.isEmpty ? null : roles,
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
              boxAddress: box.box.toString(),
              fingerprint: box.caFingerprint,
            ),
          ],
          const SizedBox(height: 24),
          RowsCard(
            children: [
              if (ref.watch(isSuperadminProvider))
                ListTile(
                  key: const ValueKey('this-device-lock-always'),
                  leading: const Icon(Icons.shield_outlined),
                  title: Text(s.deviceLockAlwaysOn),
                  subtitle: Text(s.featureLocked),
                ),
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
                onTap: _busy ? null : () => startLeave(context, ref, onBusy: (b) => mounted ? setState(() => _busy = b) : null),
              ),
              ListTile(
                leading: const Icon(Icons.phonelink_erase_rounded, color: SurauColors.danger),
                title: Text(
                  s.thisDeviceForget,
                  style: const TextStyle(color: SurauColors.danger),
                ),
                subtitle: Text(s.thisDeviceForgetHint),
                onTap: _busy ? null : _forget,
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
    required this.icon,
    required this.label,
    required this.value,
    this.detail,
  });

  final IconData icon;
  final String label;
  final String value;
  final String? detail;

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
  const _AskPinDialog();

  @override
  State<_AskPinDialog> createState() => _AskPinDialogState();
}

class _AskPinDialogState extends State<_AskPinDialog> {
  final _pin = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  void _ok() {
    if (_pin.text.length != pinLength) {
      setState(() => _error = S.of(context).pinHint);
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
        FilledButton(onPressed: _ok, child: Text(s.actionContinue)),
      ],
    );
  }
}
