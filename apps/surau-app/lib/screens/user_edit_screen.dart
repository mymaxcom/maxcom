// One person: adding them (name and the roles they hold, several at once)
// or looking after them (roles, a new device's QR, a PIN reset that can
// revoke a lost phone in the same step, deactivation). The box has the
// last word on every write and its refusals are shown in its own words
// (`Mesti ada sekurang-kurangnya seorang pentadbir aktif`).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/wire.dart';
import '../features/common/roles.dart';
import '../l10n/generated/s.dart';
import 'devices_screen.dart' show devicesPath, parseDevices;
import 'users_screen.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/users/new` when [userId] is null, else `/users/:id`.
class UserEditScreen extends ConsumerWidget {
  const UserEditScreen({super.key, this.userId});

  final String? userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final id = userId;
    if (id == null) {
      return ShellPage(
        title: s.usersAdd,
        body: SurauTheme.page(children: const [_NewUserForm()]),
      );
    }
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          BoxReadView(
            path: usersPath,
            builder: (context, body) {
              final user = parseUsers(body).where((u) => u.id == id).firstOrNull;
              if (user == null) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 28),
                  child: Text(
                    s.userNotFound,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                );
              }
              return _UserPage(user: user);
            },
          ),
        ],
      ),
    );
  }
}

// ---- roles ----

/// The four roles as big checkboxes with one line each on what the role
/// lets a person do; [error] shows under them.
class _RoleBoxes extends ConsumerWidget {
  const _RoleBoxes({required this.selected, required this.onChanged, this.error});

  final Set<String> selected;
  final void Function(String role, bool on) onChanged;
  final String? error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    // The Pentadbir MAXCOM role is handed out on the cloud only, by someone who may manage it; a box refuses it.
    final canGrant = ref.watch(canGrantSuperadminProvider);
    final roleList = [
      for (final r in roleOrder)
        if (r != 'superadmin' || canGrant || selected.contains('superadmin')) r,
    ];
    String hint(String role) => switch (role) {
      'superadmin' => s.roleSuperadminHint,
      'admin' => s.roleAdminHint,
      'treasurer' => s.roleTreasurerHint,
      'media' => s.roleMediaHint,
      _ => s.roleAjkHint,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.userRolesTitle, style: text.titleSmall),
        const SizedBox(height: 2),
        Text(s.userRolesHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 10),
        Card(
          child: Column(
            children: [
              for (var i = 0; i < roleList.length; i++) ...[
                if (i > 0) const Divider(),
                CheckboxListTile(
                  value: selected.contains(roleList[i]),
                  onChanged: roleList[i] == 'superadmin' && !canGrant
                      ? null
                      : (v) => onChanged(roleList[i], v ?? false),
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(roleLabel(s, roleList[i])),
                  subtitle: Text(hint(roleList[i])),
                  contentPadding: const EdgeInsets.fromLTRB(12, 6, 16, 6),
                ),
              ],
            ],
          ),
        ),
        if (error != null) ...[const SizedBox(height: 12), ErrorLine(error!)],
      ],
    );
  }
}

// ---- new ----

class _NewUserForm extends ConsumerStatefulWidget {
  const _NewUserForm();

  @override
  ConsumerState<_NewUserForm> createState() => _NewUserFormState();
}

class _NewUserFormState extends ConsumerState<_NewUserForm> {
  final _name = TextEditingController();
  final _roles = <String>{};
  String? _nameError;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final s = S.of(context);
    final name = _name.text.trim();
    setState(() {
      _nameError = name.isEmpty ? s.userNameRequired : null;
      _error = _roles.isEmpty ? s.userRoleRequired : null;
    });
    if (_nameError != null || _error != null) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() => _busy = true);
    try {
      await gateway.post(usersPath, {'name': name, 'roles': orderedRoles(_roles)});
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(usersPath));
      toast(context, s.userCreated(name));
      context.go(AppRoutes.users);
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('user-name'),
          controller: _name,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.done,
          maxLength: 60,
          decoration: InputDecoration(
            labelText: s.userNameLabel,
            hintText: s.userNameHint,
            errorText: _nameError,
            counterText: '',
          ),
          onChanged: (_) {
            if (_nameError != null) setState(() => _nameError = null);
          },
        ),
        const SizedBox(height: 24),
        _RoleBoxes(
          selected: _roles,
          error: _error,
          onChanged: (role, on) => setState(() {
            if (on) {
              _roles.add(role);
            } else {
              _roles.remove(role);
            }
            if (_roles.isNotEmpty) _error = null;
          }),
        ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: _busy ? null : _submit,
          icon: const Icon(Icons.person_add_alt_1_rounded),
          label: Text(s.usersAdd),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _busy ? null : () => context.go(AppRoutes.users),
          child: Text(s.actionCancel),
        ),
      ],
    );
  }
}

// ---- existing ----

class _UserPage extends ConsumerStatefulWidget {
  const _UserPage({required this.user});

  final UserDto user;

  @override
  ConsumerState<_UserPage> createState() => _UserPageState();
}

class _UserPageState extends ConsumerState<_UserPage> {
  late Set<String> _roles = widget.user.roles.toSet();
  String? _rolesError;
  String? _actionError;
  bool _busy = false;

  @override
  void didUpdateWidget(covariant _UserPage old) {
    super.didUpdateWidget(old);
    if (old.user.roles.join(',') != widget.user.roles.join(',')) {
      _roles = widget.user.roles.toSet();
    }
  }

  bool get _rolesChanged =>
      orderedRoles(_roles).join(',') != orderedRoles(widget.user.roles).join(',');

  Future<void> _saveRoles() async {
    final s = S.of(context);
    if (_roles.isEmpty) {
      setState(() => _rolesError = s.userRoleRequired);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _rolesError = null;
    });
    try {
      await gateway.put('$usersPath/${widget.user.id}/roles', {
        'roles': orderedRoles(_roles),
      });
      if (!mounted) return;
      setState(() => _busy = false);
      ref.invalidate(boxJsonProvider(usersPath));
      toast(context, s.userRolesSaved);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _rolesError = writeErrorText(s, e);
      });
    }
  }

  Future<void> _resetPin() async {
    final s = S.of(context);
    final u = widget.user;
    // The person's live phones and iPads (never the TV screens), fetched
    // now so the dialog can list them; none when the box is away.
    var devices = const <DeviceDto>[];
    try {
      final read = await ref.read(boxJsonProvider(devicesPath).future);
      if (read != null) {
        devices = parseDevices(read.value)
            .where((d) => d.userId == u.id && !d.revoked && d.platform != 'kiosk')
            .toList();
      }
    } catch (_) {
      // offline with nothing cached: the reset still goes ahead
    }
    if (!mounted) return;
    final revoke = <String>{};
    final ok = await confirmDialog(
      context,
      title: s.userResetPinTitle(u.name),
      body: s.userResetPinHint(u.name),
      confirm: s.userResetPin,
      extra: StatefulBuilder(
        builder: (context, setLocal) => _LostPhoneAsk(
          userName: u.name,
          devices: devices,
          ticked: revoke,
          onTick: (id, on) => setLocal(() {
            if (on) {
              revoke.add(id);
            } else {
              revoke.remove(id);
            }
          }),
        ),
      ),
    );
    if (!ok || !mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      final out = await gateway.put('$usersPath/${u.id}/pin', {
        'revokeDeviceIds': revoke.toList(),
      });
      if (!mounted) return;
      final revoked = (out['revoked'] as List? ?? const []).length;
      setState(() => _busy = false);
      ref.invalidate(boxJsonProvider(usersPath));
      ref.invalidate(boxJsonProvider(devicesPath));
      toast(
        context,
        revoked == 0
            ? s.userResetPinDone(u.name)
            : s.userResetPinDoneRevoked(u.name, revoked),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _actionError = writeErrorText(s, e);
      });
    }
  }

  Future<void> _deactivate() async {
    final s = S.of(context);
    final u = widget.user;
    final ok = await confirmDialog(
      context,
      title: s.userDeactivateTitle(u.name),
      body: s.userDeactivateHint(u.name),
      confirm: s.userDeactivate,
      destructive: true,
    );
    if (!ok || !mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await gateway.post('$usersPath/${u.id}/deactivate', const {});
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(usersPath));
      toast(context, s.userDeactivated(u.name));
      context.go(AppRoutes.users);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _actionError = writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final u = widget.user;
    final now = ref.watch(appDepsProvider).now();
    final locked = isLocked(u, now);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(u.name, style: text.headlineSmall),
        if (!u.active || locked || u.pinRequired) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              if (!u.active)
                StateChip(
                  label: s.usersInactive,
                  background: SurauColors.paperDeep,
                  foreground: SurauColors.muted,
                )
              else ...[
                if (locked)
                  StateChip(
                    label: s.usersLocked,
                    background: SurauColors.goldSoft,
                    foreground: SurauColors.ink,
                  ),
                if (u.pinRequired)
                  StateChip(
                    label: s.usersPinPending,
                    background: SurauColors.goldSoft,
                    foreground: SurauColors.ink,
                  ),
              ],
            ],
          ),
        ],
        const SizedBox(height: 20),
        if (!u.active)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: roleChips(u.roles, dim: true),
          )
        else ...[
          _RoleBoxes(
            selected: _roles,
            error: _rolesError,
            onChanged: (role, on) => setState(() {
              if (on) {
                _roles.add(role);
              } else {
                _roles.remove(role);
              }
              if (_roles.isNotEmpty) _rolesError = null;
            }),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy || !_rolesChanged ? null : _saveRoles,
            child: Text(s.userRolesSave),
          ),
          const SizedBox(height: 28),
          RowsCard(
            children: [
              ListTile(
                leading: const Icon(Icons.qr_code_2_rounded),
                title: Text(s.userEnrolDevice),
                subtitle: Text(s.userEnrolDeviceHint(u.name)),
                trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                onTap: _busy ? null : () => context.go(AppRoutes.userEnrolFor(u.id)),
              ),
              ListTile(
                leading: const Icon(Icons.pin_outlined),
                title: Text(s.userResetPin),
                subtitle: Text(s.userResetPinHint(u.name)),
                onTap: _busy ? null : _resetPin,
              ),
              ListTile(
                leading: const Icon(Icons.person_off_outlined, color: SurauColors.danger),
                title: Text(s.userDeactivate, style: const TextStyle(color: SurauColors.danger)),
                subtitle: Text(s.userDeactivateHint(u.name)),
                onTap: _busy ? null : _deactivate,
              ),
            ],
          ),
          if (_actionError != null) ...[
            const SizedBox(height: 12),
            ErrorLine(_actionError!),
          ],
        ],
      ],
    );
  }
}

/// Inside the reset dialog: "Adakah telefon ini hilang?" with the person's
/// devices to tick, so a lost phone is revoked in the same action.
class _LostPhoneAsk extends StatelessWidget {
  const _LostPhoneAsk({
    required this.userName,
    required this.devices,
    required this.ticked,
    required this.onTick,
  });

  final String userName;
  final List<DeviceDto> devices;
  final Set<String> ticked;
  final void Function(String id, bool on) onTick;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.userResetPinLost, style: text.titleSmall),
        const SizedBox(height: 2),
        Text(
          devices.isEmpty ? s.userResetPinNoDevices(userName) : s.userResetPinLostHint,
          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
        ),
        for (final d in devices)
          CheckboxListTile(
            value: ticked.contains(d.id),
            onChanged: (v) => onTick(d.id, v ?? false),
            controlAffinity: ListTileControlAffinity.leading,
            contentPadding: EdgeInsets.zero,
            title: Text(d.name),
            subtitle: Text(platformLabel(s, d.platform)),
            secondary: Icon(platformIcon(d.platform)),
          ),
      ],
    );
  }
}
