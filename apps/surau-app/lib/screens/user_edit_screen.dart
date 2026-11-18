// One person's page (plan PP, task A6; mockup 02): the name with the ID under
// it and who added them, "Tukar nama"; a locked PIN with "Buka kunci"; the
// phone number (Tukar nombor, WhatsApp to that number only); the person's
// phones, tablets and computers (Ubah opens the device sheet, an unused one
// has a direct Padam) and "Daftar peranti baharu"; the roles; and under
// Lain-lain "Set semula PIN", "Nyahaktifkan" and "Padam pengguna" (never on
// your own page). A deactivated person shows "Aktifkan semula" instead of the
// devices and the PIN reset.
//
// The box has the last word on every write; its refusals are said in the
// app's words. A rename is queued offline like the roles; a delete is
// live-only and never queued. Day counts and the lock come from the box's own
// clock (the activity); without it (an older box, the cloud) the page shows
// as before and the lock is taken from the list.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/app_lang.dart';
import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart' show BoxError;
import '../box/wire.dart';
import '../content/kinds.dart' show dateWords;
import '../features/common/error_text.dart';
import '../features/common/ltr.dart';
import '../features/common/roles.dart';
import '../features/common/time_words.dart';
import '../features/finance/share.dart' show openWhatsApp;
import '../features/people/people_activity.dart';
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/phone.dart';
import '../features/people/ref.dart';
import '../features/sync/live_only_dialog.dart';
import '../l10n/generated/s.dart';
import 'device_sheet.dart';
import 'devices_screen.dart' show devicesPath, parseDevices;
import 'users_screen.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/users/:id`.
class UserEditScreen extends ConsumerWidget {
  const UserEditScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          BoxReadView(
            path: usersPath,
            builder: (context, body) {
              final users = parseUsers(body);
              final user = users.where((u) => u.id == userId).firstOrNull;
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
              return _UserPage(user: user, others: [for (final u in users) if (u.id != userId) u]);
            },
          ),
        ],
      ),
    );
  }
}

/// A refusal of the box about a person, in the app's words: the delete and
/// PIN-reset refusals by their code, anything else as [errorText] says it.
String personRefusal(S s, Object e) {
  if (e is BoxError) {
    switch (e.code) {
      case 'own_account':
        return s.userDeleteSelf;
      case 'last_admin':
        return s.userDeleteLastAdmin;
      case 'last_admin_device':
        return s.devicesLastAdmin;
    }
  }
  return writeErrorText(s, e);
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
    // The Pentadbir MAXCOM role is never granted or taken here (the cloud CLI only, Plan 14 decisions 19 and 20):
    // it is never a tick, and a person who holds it shows it as read-only text.
    final roleList = [for (final r in roleOrder) if (r != 'superadmin') r];
    String hint(String role) => switch (role) {
      'admin' => s.roleAdminHint,
      'treasurer' => s.roleTreasurerHint,
      'live' => s.roleLiveHint,
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
              if (selected.contains('superadmin')) ...[
                ListTile(
                  key: const ValueKey('user-role-superadmin-readonly'),
                  title: Text(roleLabel(s, 'superadmin')),
                  contentPadding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                ),
                const Divider(),
              ],
              for (var i = 0; i < roleList.length; i++) ...[
                if (i > 0) const Divider(),
                CheckboxListTile(
                  value: selected.contains(roleList[i]),
                  onChanged: (v) => onChanged(roleList[i], v ?? false),
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(roleLabel(s, roleList[i])),
                  subtitle: Text(hint(roleList[i])),
                  contentPadding: const EdgeInsetsDirectional.fromSTEB(12, 6, 16, 6),
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

// ---- one person ----

class _UserPage extends ConsumerStatefulWidget {
  const _UserPage({required this.user, required this.others});

  final UserDto user;

  /// Everyone else on the list (for the same-name warning).
  final List<UserDto> others;

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

  void _refresh() {
    ref.invalidate(boxJsonProvider(usersPath));
    ref.invalidate(peopleActivityProvider);
  }

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
        _actionError = personRefusal(s, e);
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
      _refresh();
      toast(context, s.userDeactivated(u.name));
      context.go(AppRoutes.users);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _actionError = personRefusal(s, e);
      });
    }
  }

  /// One call of the people api; a live-only refusal shows its dialog, any
  /// other refusal is put on the page. True when it went through.
  Future<bool> _call(Future<void> Function(PeopleApi api) run) async {
    final s = S.of(context);
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await run(ref.read(peopleApiProvider));
      if (mounted) setState(() => _busy = false);
      return true;
    } catch (e) {
      if (!mounted) return false;
      setState(() => _busy = false);
      if (await showLiveOnlyIf(context, e)) return false;
      if (!mounted) return false;
      setState(() => _actionError = personRefusal(s, e));
      return false;
    }
  }

  Future<void> _unlock() async {
    final s = S.of(context);
    final u = widget.user;
    if (!await _call((api) => api.unlockUser(u.id)) || !mounted) return;
    _refresh();
    toast(context, s.usersUnlocked(u.name));
  }

  Future<void> _activate() async {
    final s = S.of(context);
    final u = widget.user;
    if (!await _call((api) => api.activateUser(u.id)) || !mounted) return;
    _refresh();
    toast(context, s.usersActivated(u.name));
  }

  Future<void> _delete() async {
    final s = S.of(context);
    final u = widget.user;
    final ok = await confirmDialog(
      context,
      title: s.userDeleteTitle(u.name),
      body: s.userDeleteBody(u.name, u.ref ?? s.idPending),
      confirm: s.devicesRevoke,
      destructive: true,
    );
    if (!ok || !mounted) return;
    // The ID the person saw goes with the id: the box refuses a mismatch.
    if (!await _call((api) => api.deleteUser(u.id, u.ref ?? u.id)) || !mounted) return;
    _refresh();
    toast(context, s.userDeleted(u.name));
    context.go(AppRoutes.users);
  }

  Future<void> _rename() async {
    final saved = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: BoxConstraints(maxWidth: 560, maxHeight: MediaQuery.sizeOf(context).height * 0.9),
      builder: (context) => _RenameSheet(user: widget.user, others: widget.others),
    );
    if (saved == null || !mounted) return;
    _refresh();
    toast(context, S.of(context).userRenamed(saved));
  }

  Future<void> _whatsApp(String phone) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.waTo(widget.user.name),
      body: s.waOpensTo(ltr(formatPhone(phone))),
      confirm: s.shareContinue,
    );
    if (!ok || !mounted) return;
    var opened = false;
    try {
      opened = await openWhatsApp(whatsAppUri(phone, ''), open: ref.read(appDepsProvider).openUrl);
    } on Object {
      opened = false;
    }
    if (!opened && mounted) toast(context, s.waUnavailablePage);
  }

  Future<void> _phone() async {
    if (await showUserPhoneSheet(context, ref, widget.user) && mounted) _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final u = widget.user;
    final deps = ref.watch(appDepsProvider);
    final lang = ref.watch(appLangProvider);
    final activity = ref.watch(peopleActivityProvider).value;
    final a = activity?.userOf(u.id);
    final self = ref.watch(sessionProvider)?.user.id == u.id;

    // The lock: the box's own answer when there is one, else the list's.
    DateTime? lockedUntil;
    if (activity != null) {
      lockedUntil = a != null && a.locked ? a.pinLockedUntil : null;
    } else if (isLocked(u, deps.now())) {
      lockedUntil = DateTime.tryParse(u.pinLockedUntil!);
    }
    final locked = u.active && (activity != null ? (a?.locked ?? false) : lockedUntil != null);

    String? addedBy;
    final created = a?.createdAt ?? u.createdAt;
    if (created != null && a?.createdByName != null) {
      final local = deps.toLocal(created);
      final iso = '${local.year.toString().padLeft(4, '0')}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')}';
      final byRef = a!.createdByRef;
      addedBy = s.userAddedBy(dateWords(iso, lang, weekday: false), byRef == null ? isolate(a.createdByName!) : '${isolate(a.createdByName!)} ${ltr(byRef)}');
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        KeyedSubtree(
          key: const ValueKey('user-header'),
          child: _Header(
            user: u,
            addedBy: addedBy,
            locked: locked,
            onRename: _busy ? null : _rename,
          ),
        ),
        if (locked) ...[
          const SizedBox(height: 16),
          _LockedCard(
            text: s.usersLockedUntil(
              lockedUntil == null
                  ? ''
                  : ltr(whenWords(deps.toLocal(lockedUntil), today: deps.toLocal(activity?.now ?? deps.now()), lang: lang)),
            ),
            onUnlock: _busy ? null : _unlock,
          ),
        ],
        if (!u.active) ...[
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const ValueKey('user-activate'),
            onPressed: _busy ? null : _activate,
            icon: const Icon(Icons.person_add_alt_rounded),
            label: Text(s.usersActivate),
          ),
        ],
        const SizedBox(height: 24),
        SectionLabel(s.phoneLabel),
        _PhoneCard(
          phone: u.phone,
          onEdit: _busy ? null : _phone,
          onWhatsApp: u.phone == null || _busy ? null : () => _whatsApp(u.phone!),
        ),
        if (u.active) ...[
          const SizedBox(height: 24),
          _Devices(user: u, activity: activity, busy: _busy),
          const SizedBox(height: 24),
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
        ] else ...[
          const SizedBox(height: 24),
          SectionLabel(s.userRolesTitle),
          Wrap(spacing: 6, runSpacing: 6, children: roleChips(u.roles, dim: true)),
        ],
        const SizedBox(height: 28),
        SectionLabel(s.a6Other),
        RowsCard(
          children: [
            if (u.active) ...[
              ListTile(
                leading: const Icon(Icons.pin_outlined),
                title: Text(s.userResetPin),
                subtitle: Text(s.userResetPinHint(u.name)),
                onTap: _busy ? null : _resetPin,
              ),
              ListTile(
                key: const ValueKey('user-deactivate'),
                leading: const Icon(Icons.person_off_outlined, color: SurauColors.text),
                title: Text(s.userDeactivate),
                subtitle: Text(s.userDeactivateHint(u.name)),
                onTap: _busy ? null : _deactivate,
              ),
            ],
            if (!self)
              ListTile(
                key: const ValueKey('user-delete'),
                leading: const Icon(Icons.delete_outline_rounded, color: SurauColors.danger),
                title: Text(s.userDelete, style: const TextStyle(color: SurauColors.danger)),
                subtitle: Text(s.userDeleteHint),
                onTap: _busy ? null : _delete,
              ),
          ],
        ),
        if (_actionError != null) ...[
          const SizedBox(height: 12),
          ErrorLine(_actionError!),
        ],
      ],
    );
  }
}

/// The round mark, the name, the ID under it, who added the person, the
/// state chips and "Tukar nama".
class _Header extends StatelessWidget {
  const _Header({required this.user, required this.addedBy, required this.locked, required this.onRename});

  final UserDto user;
  final String? addedBy;
  final bool locked;
  final VoidCallback? onRename;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final u = user;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(
              child: Container(
                width: 56,
                height: 56,
                alignment: AlignmentDirectional.center,
                decoration: BoxDecoration(
                  color: u.active ? SurauColors.tealSoft : SurauColors.paperDeep,
                  shape: BoxShape.circle,
                ),
                child: Text(
                  initialsOf(u.name),
                  style: text.titleMedium!.copyWith(color: u.active ? SurauColors.teal : SurauColors.muted),
                ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(u.name, style: text.headlineSmall),
                  RefText(u.ref),
                  if (addedBy != null) ...[
                    const SizedBox(height: 4),
                    Text(addedBy!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton.icon(
              key: const ValueKey('user-rename'),
              onPressed: onRename,
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(SurauTheme.minTapSize, 44),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                textStyle: text.labelMedium,
              ),
              icon: const Icon(Icons.edit_outlined, size: 18),
              label: Text(s.userRename),
            ),
            if (!u.active)
              StateChip(label: s.usersInactive, background: SurauColors.paperDeep, foreground: SurauColors.muted)
            else ...[
              if (locked) StateChip(label: s.usersLocked, background: SurauColors.goldSoft, foreground: SurauColors.ink),
              if (u.pinRequired)
                StateChip(label: s.usersPinPending, background: SurauColors.goldSoft, foreground: SurauColors.ink),
            ],
          ],
        ),
      ],
    );
  }
}

/// "PIN dikunci sehingga ..." with "Buka kunci".
class _LockedCard extends StatelessWidget {
  const _LockedCard({required this.text, required this.onUnlock});

  final String text;
  final VoidCallback? onUnlock;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Container(
      key: const ValueKey('user-locked-card'),
      padding: const EdgeInsetsDirectional.fromSTEB(14, 12, 12, 12),
      decoration: BoxDecoration(
        color: SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.lock_clock_outlined, color: SurauColors.ink),
              const SizedBox(width: 12),
              Expanded(
                child: Text(text, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.ink)),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: FilledButton(
              key: const ValueKey('user-unlock'),
              onPressed: onUnlock,
              style: FilledButton.styleFrom(minimumSize: const Size(SurauTheme.minTapSize, 44)),
              child: Text(s.usersUnlock),
            ),
          ),
        ],
      ),
    );
  }
}

/// The phone number (left to right), who may see it, WhatsApp and "Tukar
/// nombor"; "Nombor telefon diperlukan" with "Isi nombor" when there is none.
class _PhoneCard extends StatelessWidget {
  const _PhoneCard({required this.phone, required this.onEdit, required this.onWhatsApp});

  final String? phone;
  final VoidCallback? onEdit;
  final VoidCallback? onWhatsApp;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final number = phone;
    if (number == null) {
      return RowsCard(
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
            child: Row(
              children: [
                const Icon(Icons.phone_disabled_outlined, color: SurauColors.muted),
                const SizedBox(width: 12),
                Expanded(child: Text(s.phoneNeeded, style: text.bodyLarge)),
                const SizedBox(width: 8),
                OutlinedButton(
                  key: const ValueKey('user-phone-edit'),
                  onPressed: onEdit,
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(SurauTheme.minTapSize, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    textStyle: text.labelMedium,
                  ),
                  child: Text(s.phoneFill),
                ),
              ],
            ),
          ),
        ],
      );
    }
    return RowsCard(
      children: [
        Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(top: 2),
                child: Icon(Icons.phone_outlined, color: SurauColors.teal),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    LtrText(formatPhone(number), style: text.titleMedium),
                    const SizedBox(height: 2),
                    Text(s.phonePrivate, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                key: const ValueKey('user-whatsapp'),
                onPressed: onWhatsApp,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(SurauTheme.minTapSize, 44),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  textStyle: text.labelMedium,
                ),
                icon: const Icon(Icons.chat_outlined, size: 18),
                label: const Text('WhatsApp'),
              ),
            ],
          ),
        ),
        ListTile(
          key: const ValueKey('user-phone-edit'),
          leading: const Icon(Icons.edit_outlined),
          title: Text(s.phoneEdit),
          trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          onTap: onEdit,
        ),
      ],
    );
  }
}

/// "Peranti {name} (n)": the person's live phones, tablets and computers (no
/// TV screen, nothing deleted), each with its ID, kind and last use; a tap or
/// "Ubah" opens the device sheet, an unused one has "Tidak aktif" and a direct
/// "Padam"; then "Daftar peranti baharu".
class _Devices extends ConsumerWidget {
  const _Devices({required this.user, required this.activity, required this.busy});

  final UserDto user;
  final PeopleActivityDto? activity;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final gone = ref.watch(cancelledDeviceIdsProvider);
    final read = ref.watch(boxJsonProvider(devicesPath)).value;
    final devices = read == null
        ? const <DeviceDto>[]
        : [
            for (final d in parseDevices(read.value))
              if (d.userId == user.id && !d.revoked && d.platform != 'kiosk' && !gone.contains(d.id)) d,
          ];
    String usage(DeviceDto d, DeviceActivityDto? a) {
      final kind = platformLabel(s, d.platform);
      if (a == null) return kind;
      final comma = Localizations.localeOf(context).languageCode == 'ar' ? '، ' : ', ';
      return '$kind$comma${a.inactive ? unusedWords(s, a.idleDays) : lastActiveWords(s, a.idleDays)}';
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(s.userDevicesOf(isolate(user.name), devices.length)),
        RowsCard(
          children: [
            for (final d in devices)
              Builder(
                builder: (context) {
                  final a = activity?.deviceOf(d.id);
                  final name = deviceNameOf(ref, d);
                  void open() => showDeviceSheet(
                    context,
                    ref,
                    device: d,
                    ownerName: user.name,
                    ownerRef: user.ref,
                    activity: a,
                  );
                  return InkWell(
                    key: ValueKey('user-device-${d.id}'),
                    onTap: busy ? null : open,
                    child: Padding(
                      padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Icon(platformIcon(d.platform), color: SurauColors.teal),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(name, style: text.titleSmall, maxLines: 3, overflow: TextOverflow.ellipsis),
                                RefText(d.ref),
                                const SizedBox(height: 2),
                                Text(usage(d, a), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                                if (a != null && a.inactive) ...[
                                  const SizedBox(height: 6),
                                  StateChip(
                                    label: s.peopleInactiveBadge,
                                    background: SurauColors.goldSoft,
                                    foreground: SurauColors.ink,
                                  ),
                                ],
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          if (a != null && a.inactive)
                            OutlinedButton(
                              key: ValueKey('user-device-remove-${d.id}'),
                              onPressed: busy ? null : () => removeDevice(context, ref, d, name: name),
                              style: OutlinedButton.styleFrom(
                                foregroundColor: SurauColors.danger,
                                side: const BorderSide(color: SurauColors.danger, width: 1.5),
                                minimumSize: const Size(SurauTheme.minTapSize, 44),
                                padding: const EdgeInsets.symmetric(horizontal: 14),
                                textStyle: text.labelMedium,
                              ),
                              child: Text(s.devicesRevoke),
                            )
                          else
                            TextButton(
                              key: ValueKey('user-device-edit-${d.id}'),
                              onPressed: busy ? null : open,
                              child: Text(s.deviceEdit),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ListTile(
              leading: const Icon(Icons.qr_code_2_rounded),
              title: Text(s.devicesEnrolNew),
              subtitle: Text(s.userEnrolDeviceHint(user.name)),
              trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
              onTap: busy ? null : () => context.go(AppRoutes.userEnrolFor(user.id)),
            ),
          ],
        ),
      ],
    );
  }
}

/// "Tukar nama": the name prefilled, the rule checked before anything is
/// sent, a name another person already has asked about first. Pops the
/// saved name.
class _RenameSheet extends ConsumerStatefulWidget {
  const _RenameSheet({required this.user, required this.others});

  final UserDto user;
  final List<UserDto> others;

  @override
  ConsumerState<_RenameSheet> createState() => _RenameSheetState();
}

class _RenameSheetState extends ConsumerState<_RenameSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.user.name);
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
    final clean = cleanedName(_name.text);
    if (clean == widget.user.name) {
      Navigator.of(context).pop();
      return;
    }
    final taken = widget.others.any((o) => o.active && cleanedName(o.name).toLowerCase() == clean.toLowerCase());
    if (taken) {
      final go = await confirmDialog(
        context,
        title: s.userRenameTitle,
        body: s.userNameTaken(clean),
        confirm: s.userRenameSave,
      );
      if (!go || !mounted) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(peopleApiProvider).renameUser(widget.user.id, clean);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      if (await showLiveOnlyIf(context, e)) return;
      if (!mounted) return;
      setState(() => _error = writeErrorText(s, e));
      return;
    }
    if (!mounted) return;
    Navigator.of(context).pop(clean);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.userRenameTitle, style: text.titleLarge),
            const SizedBox(height: 2),
            RefText(widget.user.ref),
            const SizedBox(height: 8),
            Text(s.userRenameBody, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('user-rename-field'),
              controller: _name,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _busy ? null : _save(),
              decoration: InputDecoration(
                labelText: s.userNameLabel,
                helperText: _error == null ? s.addNameHint : null,
                helperMaxLines: 2,
                errorText: _error,
                errorMaxLines: 3,
              ),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: SurauColors.paperDeep,
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.history_rounded, size: 20, color: SurauColors.muted),
                  const SizedBox(width: 10),
                  Expanded(child: Text(s.userRenameHistory, style: text.bodyMedium)),
                ],
              ),
            ),
            const SizedBox(height: 20),
            FilledButton(
              key: const ValueKey('user-rename-save'),
              onPressed: _busy ? null : _save,
              child: Text(s.userRenameSave),
            ),
            const SizedBox(height: 4),
            TextButton(
              onPressed: _busy ? null : () => Navigator.of(context).pop(),
              child: Text(s.actionCancel),
            ),
          ],
        ),
      ),
    );
  }
}

// ---- phone number ----

/// "Tukar nombor" (or "Isi nombor" when [user] has none): the number typed,
/// normalised to E.164 before it is sent; a number the app cannot read or the
/// box refuses (`phone_taken`, with the other person's ID only) is said in
/// the sheet and nothing else happens. True when a number was saved.
Future<bool> showUserPhoneSheet(BuildContext context, WidgetRef ref, UserDto user) async {
  final saved = await showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    constraints: BoxConstraints(maxWidth: 560, maxHeight: MediaQuery.sizeOf(context).height * 0.9),
    builder: (context) => _PhoneSheet(user: user),
  );
  return saved ?? false;
}

class _PhoneSheet extends ConsumerStatefulWidget {
  const _PhoneSheet({required this.user});

  final UserDto user;

  @override
  ConsumerState<_PhoneSheet> createState() => _PhoneSheetState();
}

class _PhoneSheetState extends ConsumerState<_PhoneSheet> {
  late final TextEditingController _phone = TextEditingController(
    text: widget.user.phone == null ? '' : formatPhone(widget.user.phone!),
  );
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final s = S.of(context);
    final raw = _phone.text.trim();
    if (raw.isEmpty) {
      setState(() => _error = s.phoneRequired);
      return;
    }
    if (normalisePhone(raw) == null) {
      setState(() => _error = s.phoneInvalid);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(peopleApiProvider).setPhone(widget.user.id, raw);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      if (await showLiveOnlyIf(context, e)) return;
      if (!mounted) return;
      setState(() => _error = e is BadPhone ? s.phoneInvalid : writeErrorText(s, e));
      return;
    }
    if (!mounted) return;
    ref.invalidate(boxJsonProvider(usersPath));
    final messenger = ScaffoldMessenger.of(context);
    Navigator.of(context).pop(true);
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(s.phoneSaved)));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.user.phone == null ? s.phoneFill : s.phoneEdit, style: text.titleLarge),
            const SizedBox(height: 2),
            Text(widget.user.name, style: text.titleSmall),
            RefText(widget.user.ref),
            const SizedBox(height: 12),
            Text(s.phonePrivate, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('user-phone-field'),
              controller: _phone,
              autofocus: true,
              keyboardType: TextInputType.phone,
              textDirection: TextDirection.ltr,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _busy ? null : _save(),
              decoration: InputDecoration(
                labelText: s.phoneLabel,
                hintText: s.phoneHint,
                helperText: _error == null ? s.phoneHint : null,
                errorText: _error,
                errorMaxLines: 3,
              ),
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
            ),
            const SizedBox(height: 20),
            FilledButton(
              key: const ValueKey('user-phone-save'),
              onPressed: _busy ? null : _save,
              child: Text(s.phoneSave),
            ),
            const SizedBox(height: 4),
            TextButton(
              onPressed: _busy ? null : () => Navigator.of(context).pop(false),
              child: Text(s.actionCancel),
            ),
          ],
        ),
      ),
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
