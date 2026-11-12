// Peranti: every live enrolled phone, iPad and browser grouped under its
// person, and the paired TV screens in their own group, each with its
// kind in words and `Batalkan`. A cancelled device or screen is never
// listed (operator rule 2026-11-06): rows the box or the local store still
// carry as revoked are filtered out here, and after `Batalkan` the row
// leaves the list at once, before the next answer. `Padankan skrin TV`
// leads to the pairing page.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/wire.dart';
import '../features/setup/setup_providers.dart';
import '../features/sync/live_only_dialog.dart';
import '../features/sync/sync_actions.dart';
import '../l10n/generated/s.dart';
import '../sync/sync_engine.dart' show SyncState;
import '../sync/sync_providers.dart' show syncViewProvider;
import 'users_screen.dart' show parseUsers, usersPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String devicesPath = '/api/devices';

List<DeviceDto> parseDevices(Map<String, dynamic> body) => [
  for (final d in (body['devices'] as List? ?? const []))
    DeviceDto.fromJson(d as Map<String, dynamic>),
];

/// Ids cancelled from this screen: hidden at once, whatever the next
/// answer from the box or store says.
class CancelledDeviceIds extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  void add(String id) => state = {...state, id};
}

final cancelledDeviceIdsProvider =
    NotifierProvider<CancelledDeviceIds, Set<String>>(CancelledDeviceIds.new);

class DevicesScreen extends ConsumerWidget {
  const DevicesScreen({super.key});

  /// `Daftar peranti baharu`: who the device is for, then that person's QR
  /// page (the code is made by the server, never by this app). With no
  /// connection at all the live-only dialog says so at once.
  Future<void> _enrolNew(BuildContext context, WidgetRef ref) async {
    final s = S.of(context);
    final actions = ref.read(syncActionsProvider);
    final state = ref.read(syncViewProvider).value?.state;
    if (actions != null && state == SyncState.offline) {
      await showLiveOnlyDialog(context, action: s.devicesEnrolNew);
      return;
    }
    final body = ref.read(boxJsonProvider(usersPath)).value?.value;
    final people = body == null
        ? const <UserDto>[]
        : parseUsers(body).where((u) => u.active).toList();
    final id = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxWidth: 520,
        maxHeight: MediaQuery.sizeOf(context).height * 0.8,
      ),
      builder: (context) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(0, 4, 0, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(
                s.devicesEnrolPick,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            for (final u in people)
              ListTile(
                key: ValueKey('enrol-for-${u.id}'),
                leading: const Icon(Icons.person_outline_rounded),
                title: Text(u.name),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => Navigator.of(context).pop(u.id),
              ),
          ],
        ),
      ),
    );
    if (id != null && context.mounted) context.go(AppRoutes.userEnrolFor(id));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final users = ref.watch(boxJsonProvider(usersPath)).value;
    final cancelled = ref.watch(cancelledDeviceIdsProvider);
    final names = <String, String>{
      if (users != null)
        for (final u in parseUsers(users.value)) u.id: u.name,
    };

    // Away from the surau the enrolment code is made by the cloud (operator
    // answer Q7: an admin may enrol a device from home).
    final sync = ref.watch(syncViewProvider).value;
    final viaCloud =
        ref.watch(syncActionsProvider) != null &&
        sync?.via == 'cloud' &&
        sync?.state != SyncState.offline;
    // Plan 14: away from the surau network the changes wait for the next sync, and the box itself heads the list.
    final away = sync?.via == 'cloud';
    final boxInfo = ref.watch(boxInfoProvider).value;

    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.devices),
          const SizedBox(height: 16),
          Wrap(
            spacing: 12,
            runSpacing: 10,
            children: [
              FilledButton.icon(
                key: const ValueKey('devices-enrol-new'),
                onPressed: () => _enrolNew(context, ref),
                icon: const Icon(Icons.qr_code_2_rounded),
                label: Text(s.devicesEnrolNew),
              ),
              OutlinedButton.icon(
                onPressed: () => context.go(AppRoutes.pairing),
                icon: const Icon(Icons.tv_outlined),
                label: Text(s.devicesPair),
              ),
            ],
          ),
          if (viaCloud) ...[
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.cloud_done_outlined,
                  size: 20,
                  color: SurauColors.teal,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    s.devicesEnrolViaCloud,
                    style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                  ),
                ),
              ],
            ),
          ],
          if (away) ...[
            const SizedBox(height: 12),
            Text(
              s.devicesAwayBanner,
              key: const ValueKey('devices-away-banner'),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ],
          const SizedBox(height: 16),
          if (boxInfo != null) ...[
            RowsCard(
              children: [
                ListTile(
                  key: const ValueKey('devices-box-row'),
                  leading: const Icon(Icons.dns_outlined, color: SurauColors.teal),
                  title: Text(boxInfo.name),
                  subtitle: Text('${s.devicesBoxRow(boxInfo.boxIdGroups)}\n${s.devicesBoxRowHint}'),
                  isThreeLine: true,
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],
          BoxReadView(
            path: devicesPath,
            builder: (context, body) {
              final devices = [
                for (final d in parseDevices(body))
                  if (!d.revoked && !cancelled.contains(d.id)) d,
              ];
              if (devices.isEmpty) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 28),
                  child: Text(
                    s.devicesEmpty,
                    textAlign: TextAlign.center,
                    style: text.bodyLarge!.copyWith(color: SurauColors.muted),
                  ),
                );
              }
              // People in the order the box lists them, then anyone whose
              // name is not known, then the TV screens.
              final byUser = <String, List<DeviceDto>>{};
              final screens = <DeviceDto>[];
              for (final d in devices) {
                if (d.platform == 'kiosk') {
                  screens.add(d);
                } else {
                  byUser.putIfAbsent(d.userId, () => []).add(d);
                }
              }
              final userIds = [
                for (final id in names.keys)
                  if (byUser.containsKey(id)) id,
                for (final id in byUser.keys)
                  if (!names.containsKey(id)) id,
              ];
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final id in userIds) ...[
                    SectionLabel(names[id] ?? id),
                    RowsCard(
                      children: [
                        for (final d in byUser[id]!) _DeviceRow(device: d),
                      ],
                    ),
                    const SizedBox(height: 20),
                  ],
                  if (screens.isNotEmpty) ...[
                    SectionLabel(s.devicesKioskGroup),
                    RowsCard(
                      children: [
                        for (final d in screens) _DeviceRow(device: d),
                      ],
                    ),
                  ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _DeviceRow extends ConsumerWidget {
  const _DeviceRow({required this.device});

  final DeviceDto device;

  Future<void> _revoke(BuildContext context, WidgetRef ref) async {
    final s = S.of(context);
    final d = device;
    final ok = await confirmDialog(
      context,
      title: s.devicesRevokeTitle(d.name),
      body: s.devicesRevokeBody,
      confirm: s.devicesRevoke,
      destructive: true,
    );
    if (!ok || !context.mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    try {
      await gateway.post('$devicesPath/${d.id}/revoke', const {});
      if (!context.mounted) return;
      ref.read(cancelledDeviceIdsProvider.notifier).add(d.id);
      ref.invalidate(boxJsonProvider(devicesPath));
      toast(context, s.devicesRevokedToast(d.name));
    } catch (e) {
      if (!context.mounted) return;
      if (await showLiveOnlyIf(context, e)) return;
      if (!context.mounted) return;
      toast(context, writeErrorText(s, e));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final d = device;
    return Padding(
      key: ValueKey('device-${d.id}'),
      padding: const EdgeInsets.fromLTRB(20, 12, 8, 12),
      child: Row(
        children: [
          Icon(platformIcon(d.platform), size: 26, color: SurauColors.teal),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(d.name, style: text.titleSmall!.copyWith(color: SurauColors.text)),
                const SizedBox(height: 2),
                Text(
                  platformLabel(s, d.platform),
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          TextButton(
            onPressed: () => _revoke(context, ref),
            style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
            child: Text(s.devicesRevoke),
          ),
        ],
      ),
    );
  }
}
