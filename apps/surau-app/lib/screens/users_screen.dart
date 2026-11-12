// Pengguna: every AJK member the box knows, their roles as chips and the
// one state worth noticing (locked out, no PIN yet, inactive), with
// `Tambah pengguna` on top. Tapping a person opens their page
// (user_edit_screen.dart). Read through the gateway, so the last list
// stays on screen when the box is away.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../box/setup_client.dart';
import '../features/setup/recovery_code_view.dart';
import '../features/setup/setup_providers.dart';
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String usersPath = '/api/users';

List<UserDto> parseUsers(Map<String, dynamic> body) => [
  for (final u in (body['users'] as List? ?? const []))
    UserDto.fromJson(u as Map<String, dynamic>),
];

/// True while the box refuses this person's PIN (`pinLockedUntil` ahead).
bool isLocked(UserDto u, DateTime now) {
  final until = u.pinLockedUntil;
  if (until == null) return false;
  final t = DateTime.tryParse(until);
  return t != null && t.isAfter(now);
}

class UsersScreen extends ConsumerWidget {
  const UsersScreen({super.key});

  /// "Kod pemulihan baharu": the old code dies, the new one is shown once (screenshots blocked on Android).
  Future<void> _rotate(BuildContext context, WidgetRef ref) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.rotateRecoveryTitle,
      body: s.rotateRecoveryBody,
      confirm: s.rotateRecoveryConfirm,
    );
    if (!ok || !context.mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    final String code;
    try {
      code = await SetupClient(gateway.client).rotateRecoveryCode(gateway);
    } on Object catch (e) {
      if (!context.mounted) return;
      toast(context, e is TooManyAttempts || (e is BoxError && e.status == 429) ? s.errorTooMany : writeErrorText(s, e));
      return;
    }
    if (!context.mounted) return;
    ref.invalidate(recoveryCodeSetProvider);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (context) => Scaffold(
          appBar: AppBar(title: Text(s.rotateRecoveryTitle)),
          body: SurauTheme.page(
            children: [RecoveryCodeView(code: code, onContinue: () => Navigator.of(context).pop())],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final now = ref.watch(appDepsProvider).now();
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.users),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () => context.go(AppRoutes.userNew),
            icon: const Icon(Icons.person_add_alt_1_rounded),
            label: Text(s.usersAdd),
          ),
          if (canSee(ref.watch(rolesProvider), 'users:manage')) ...[
            // A box upgraded from before recovery codes has none: nobody could get back in if every phone were lost.
            if (ref.watch(recoveryCodeSetProvider).value == false) ...[
              const SizedBox(height: 12),
              Container(
                key: const ValueKey('users-no-recovery-warning'),
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: SurauColors.goldSoft,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded, color: SurauColors.ink),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        S.of(context).usersNoRecoveryWarning,
                        style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.ink),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const ValueKey('users-rotate-recovery'),
              onPressed: () => _rotate(context, ref),
              icon: const Icon(Icons.key_rounded),
              label: Text(s.rotateRecoveryTitle),
            ),
          ],
          const SizedBox(height: 16),
          BoxReadView(
            path: usersPath,
            builder: (context, body) {
              final users = parseUsers(body);
              if (users.isEmpty) {
                return _Empty(s.usersEmpty);
              }
              final ordered = [
                for (final u in users)
                  if (u.active) u,
                for (final u in users)
                  if (!u.active) u,
              ];
              return RowsCard(
                children: [
                  for (final u in ordered) _UserRow(user: u, locked: isLocked(u, now)),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _UserRow extends StatelessWidget {
  const _UserRow({required this.user, required this.locked});

  final UserDto user;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final u = user;
    return InkWell(
      onTap: () => context.go(AppRoutes.userFor(u.id)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 12, 14),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    u.name,
                    style: text.titleSmall!.copyWith(
                      color: u.active ? SurauColors.text : SurauColors.muted,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      ...roleChips(u.roles, dim: !u.active),
                      if (!u.active)
                        StateChip(
                          label: s.usersInactive,
                          background: SurauColors.paperDeep,
                          foreground: SurauColors.muted,
                        )
                      else if (locked)
                        StateChip(
                          label: s.usersLocked,
                          background: SurauColors.goldSoft,
                          foreground: SurauColors.ink,
                        )
                      else if (u.pinRequired)
                        StateChip(
                          label: s.usersPinPending,
                          background: SurauColors.goldSoft,
                          foreground: SurauColors.ink,
                        ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: SurauColors.muted),
      ),
    );
  }
}
