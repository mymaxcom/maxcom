// Peranti (plan PP, task A3): every live phone, tablet and computer, grouped
// under its owner (name and ID), each with its ID under the name, its kind in
// words and, from the box, when it was last used. TV screens and the MAXCOM
// row are on the Skrin TV tab (pairing_screen.dart).
//
// The box flags a device unused for 60 days ("Tidak aktif"): such a row has a
// direct "Padam", the last 30 days before the box deletes it on its own are
// counted, and a card offers "Padam semua" (the box re-checks every id and
// says what it skipped). Any row opens the device sheet (rename, delete). The
// enrolment codes not yet used are listed with "Tamatkan kod". A deleted
// device is never listed (operator rule 2026-11-06).
//
// The flags and day counts are the box's, by the box's clock; through the
// cloud, or from an older box, the list shows as before without them.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/wire.dart';
import '../features/common/ltr.dart';
import '../features/people/people_activity.dart';
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/ref.dart';
import '../features/shell/connection_icons.dart' show LinkGlyph, LinkKind, LinkState;
import '../features/sync/live_only_dialog.dart';
import '../features/sync/sync_actions.dart';
import '../l10n/generated/s.dart';
import '../sync/sync_engine.dart' show SyncState;
import '../sync/sync_providers.dart' show syncViewProvider;
import 'device_sheet.dart';
import 'users_screen.dart' show parseUsers, usersPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

export 'device_sheet.dart' show CancelledDeviceIds, cancelledDeviceIdsProvider;

const String devicesPath = '/api/devices';

List<DeviceDto> parseDevices(Map<String, dynamic> body) => [
  for (final d in (body['devices'] as List? ?? const [])) DeviceDto.fromJson(d as Map<String, dynamic>),
];

/// Whether [device] answers the search [query]: its name, its owner's name,
/// or its own or its owner's ID typed loosely (`d7`, `D-0007`, `u1`).
bool deviceMatches(String query, DeviceDto device, String deviceName, UserDto? owner) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  if (deviceName.toLowerCase().contains(q)) return true;
  if (owner != null && owner.name.toLowerCase().contains(q)) return true;
  final typed = parseRef(q);
  if (typed == null) return false;
  bool same(String? ref, String kind) {
    final mine = ref == null ? null : parseRef(ref);
    if (mine == null) return false;
    return (typed.kind == null || typed.kind == kind) && mine.src == typed.src && mine.no == typed.no;
  }

  return same(device.ref, 'device') || same(owner?.ref, 'user');
}

/// The comma between two parts of one line, in the language of [s].
String listComma(S s) => s.localeName == 'ar' ? '، ' : ', ';

class DevicesScreen extends ConsumerStatefulWidget {
  const DevicesScreen({super.key});

  @override
  ConsumerState<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends ConsumerState<DevicesScreen> {
  final _search = TextEditingController();
  String _query = '';

  /// What the last "Padam semua" did: deleted count and the skipped devices
  /// with the reason in words.
  ({int removed, List<(DeviceDto, String)> skipped})? _removeResult;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// `Daftar peranti baharu`: who the device is for, then that person's QR
  /// page (the code is made by the box, never by this app). With no
  /// connection at all the live-only dialog says so at once.
  Future<void> _enrolNew() async {
    final s = S.of(context);
    final actions = ref.read(syncActionsProvider);
    final state = ref.read(syncViewProvider).value?.state;
    if (actions != null && state == SyncState.offline) {
      await showLiveOnlyDialog(context, action: s.devicesEnrolNew);
      return;
    }
    final body = ref.read(boxJsonProvider(usersPath)).value?.value;
    final people = body == null ? const <UserDto>[] : parseUsers(body).where((u) => u.active).toList();
    final id = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      constraints: BoxConstraints(maxWidth: 520, maxHeight: MediaQuery.sizeOf(context).height * 0.8),
      builder: (context) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(0, 4, 0, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(s.devicesEnrolPick, style: Theme.of(context).textTheme.titleMedium),
            ),
            for (final u in people)
              ListTile(
                key: ValueKey('enrol-for-${u.id}'),
                leading: const Icon(Icons.person_outline_rounded),
                title: Text(u.name),
                subtitle: RefText(u.ref),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => Navigator.of(context).pop(u.id),
              ),
          ],
        ),
      ),
    );
    if (id != null && mounted) context.go(AppRoutes.userEnrolFor(id));
  }

  /// "Padam semua": the flagged devices, after one confirm; the box re-checks
  /// each id and skips what it must.
  Future<void> _removeAll(List<DeviceDto> flagged) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.devicesRemoveAllConfirm(flagged.length),
      body: s.devicesUnusedHint,
      confirm: s.devicesRevoke,
      destructive: true,
    );
    if (!ok || !mounted) return;
    try {
      final out = await ref.read(peopleApiProvider).revokeInactive([for (final d in flagged) d.id]);
      if (!mounted) return;
      ref.read(cancelledDeviceIdsProvider.notifier).addAll(out.revoked);
      ref.invalidate(boxJsonProvider(devicesPath));
      ref.invalidate(peopleActivityProvider);
      final byId = {for (final d in flagged) d.id: d};
      setState(() {
        _removeResult = (
          removed: out.revoked.length,
          skipped: [
            for (final k in out.skipped)
              if (byId[k.id] != null) (byId[k.id]!, _skipWords(s, k.reason)),
          ],
        );
      });
    } catch (e) {
      if (!mounted) return;
      if (e is PeopleNeedsUpdate) {
        toast(context, s.peopleNeedsUpdate);
        return;
      }
      if (await showLiveOnlyIf(context, e)) return;
      if (!mounted) return;
      toast(context, writeErrorText(s, e));
    }
  }

  static String _skipWords(S s, String reason) => switch (reason) {
    'own_device' => s.devicesSkipOwn,
    'in_use' => s.devicesSkipInUse,
    'last_admin_device' => s.devicesSkipLastAdmin,
    'is_tv' => s.devicesSkipTv,
    _ => s.devicesSkipGone,
  };

  Future<void> _endCode(OpenCodeDto code) async {
    final s = S.of(context);
    try {
      await ref.read(peopleApiProvider).cancelCode(id: code.id, userId: code.userId);
      if (!mounted) return;
      ref.invalidate(openCodesProvider);
      toast(context, s.devicesCodeEnded);
    } catch (e) {
      if (!mounted) return;
      if (e is PeopleNeedsUpdate) {
        toast(context, s.peopleNeedsUpdate);
        return;
      }
      if (await showLiveOnlyIf(context, e)) return;
      if (!mounted) return;
      toast(context, writeErrorText(s, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final usersBody = ref.watch(boxJsonProvider(usersPath)).value;
    final cancelled = ref.watch(cancelledDeviceIdsProvider);
    final renamed = ref.watch(renamedDeviceNamesProvider);
    final people = <String, UserDto>{
      if (usersBody != null)
        for (final u in parseUsers(usersBody.value)) u.id: u,
    };

    // Away from the surau no enrolment code can be made (the cloud answers
    // `box_only`), and the box's activity flags are not shown.
    final away = ref.watch(syncViewProvider).value?.via == 'cloud';
    final activity = away ? null : ref.watch(peopleActivityProvider).value;
    final codes = activity == null ? null : ref.watch(openCodesProvider).value;
    final result = _removeResult;

    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.devices),
          const SizedBox(height: 16),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: FilledButton.icon(
              key: const ValueKey('devices-enrol-new'),
              onPressed: away ? null : _enrolNew,
              icon: const Icon(Icons.qr_code_2_rounded),
              label: Text(s.devicesEnrolNew),
            ),
          ),
          if (away) ...[
            const SizedBox(height: 12),
            Row(
              key: const ValueKey('devices-away-banner'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const LinkGlyph(kind: LinkKind.cloud, state: LinkState.connected, size: 20, onDark: false),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.devicesEnrolViaCloud, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                      const SizedBox(height: 4),
                      Text(s.peopleFlagsBoxOnly, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                    ],
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 14),
          TextField(
            key: const ValueKey('devices-search'),
            controller: _search,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: s.searchNameOrId,
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: s.actionCancel,
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () => setState(() {
                        _search.clear();
                        _query = '';
                      }),
                    ),
            ),
            onChanged: (v) => setState(() => _query = v),
          ),
          const SizedBox(height: 16),
          BoxReadView(
            path: devicesPath,
            builder: (context, body) {
              final devices = [
                for (final d in parseDevices(body))
                  if (!d.revoked && !cancelled.contains(d.id) && d.platform != 'kiosk') d,
              ];
              final flagged = [
                for (final d in devices)
                  if (activity?.deviceOf(d.id)?.inactive == true) d,
              ];
              final shown = [
                for (final d in devices)
                  if (deviceMatches(_query, d, renamed[d.id] ?? d.name, people[d.userId])) d,
              ];
              // People in the order the box lists them, then anyone whose
              // name is not known.
              final byUser = <String, List<DeviceDto>>{};
              for (final d in shown) {
                byUser.putIfAbsent(d.userId, () => []).add(d);
              }
              final userIds = [
                for (final id in people.keys)
                  if (byUser.containsKey(id)) id,
                for (final id in byUser.keys)
                  if (!people.containsKey(id)) id,
              ];
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (result != null) ...[_RemoveResult(result: result, renamed: renamed), const SizedBox(height: 20)],
                  if (flagged.isNotEmpty && _query.isEmpty) ...[
                    _UnusedCard(count: flagged.length, onRemoveAll: () => _removeAll(flagged)),
                    const SizedBox(height: 20),
                  ],
                  if (devices.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 28),
                      child: Text(
                        s.devicesEmpty,
                        textAlign: TextAlign.center,
                        style: text.bodyLarge!.copyWith(color: SurauColors.muted),
                      ),
                    ),
                  for (final id in userIds) ...[
                    _GroupHeading(
                      key: ValueKey('devices-group-$id'),
                      name: people[id]?.name ?? id,
                      ownerRef: people[id]?.ref,
                    ),
                    RowsCard(
                      children: [
                        for (final d in byUser[id]!)
                          DeviceRow(
                            device: d,
                            activity: activity?.deviceOf(d.id),
                            ownerName: people[id]?.name ?? id,
                            ownerRef: people[id]?.ref,
                          ),
                      ],
                    ),
                    const SizedBox(height: 20),
                  ],
                ],
              );
            },
          ),
          if (codes != null && codes.isNotEmpty && activity != null) ...[
            _OpenCodes(codes: codes, now: activity.now, onEnd: _endCode),
            const SizedBox(height: 20),
          ],
          Text(s.devicesRemovedNote, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 6),
          Text(s.autoCleanNote, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        ],
      ),
    );
  }
}

/// The owner's name, then the owner's ID, above their devices.
class _GroupHeading extends StatelessWidget {
  const _GroupHeading({super.key, required this.name, this.ownerRef});

  final String name;
  final String? ownerRef;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.titleSmall!.copyWith(color: SurauColors.muted);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(4, 0, 4, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Flexible(
            child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
          ),
          const SizedBox(width: 8),
          RefText(ownerRef),
        ],
      ),
    );
  }
}

/// "{n} peranti tidak digunakan lebih 60 hari", why nothing is lost, and
/// "Padam semua".
class _UnusedCard extends StatelessWidget {
  const _UnusedCard({required this.count, required this.onRemoveAll});

  final int count;
  final VoidCallback onRemoveAll;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      key: const ValueKey('devices-unused-card'),
      color: SurauColors.goldSoft,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(18, 16, 18, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.devicesUnusedCard(count), style: text.titleSmall!.copyWith(color: SurauColors.ink)),
            const SizedBox(height: 4),
            Text(s.devicesUnusedHint, style: text.bodyMedium!.copyWith(color: SurauColors.ink)),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const ValueKey('devices-remove-all'),
              onPressed: onRemoveAll,
              icon: const Icon(Icons.cleaning_services_outlined),
              label: Text(s.devicesRemoveAll),
              style: OutlinedButton.styleFrom(
                foregroundColor: SurauColors.danger,
                backgroundColor: SurauColors.card,
                side: const BorderSide(color: SurauColors.danger),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What "Padam semua" did: "{n} dipadam, {m} dilangkau" and one line per
/// skipped device with the reason.
class _RemoveResult extends StatelessWidget {
  const _RemoveResult({required this.result, required this.renamed});

  final ({int removed, List<(DeviceDto, String)> skipped}) result;
  final Map<String, String> renamed;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      key: const ValueKey('devices-removed-result'),
      color: SurauColors.successSoft,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(18, 14, 18, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.devicesRemovedSome(result.removed, result.skipped.length),
              style: text.titleSmall!.copyWith(color: SurauColors.success),
            ),
            for (final (d, why) in result.skipped) ...[
              const SizedBox(height: 4),
              Text(
                '${isolate(renamed[d.id] ?? d.name)} ${ltr(d.ref ?? s.idPending)}: $why',
                style: text.bodyMedium!.copyWith(color: SurauColors.text),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// "Kod belum digunakan (n)": who, which device, minutes left by the box's
/// clock, and "Tamatkan kod".
class _OpenCodes extends StatelessWidget {
  const _OpenCodes({required this.codes, required this.now, required this.onEnd});

  final List<OpenCodeDto> codes;
  final DateTime now;
  final void Function(OpenCodeDto) onEnd;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('devices-open-codes'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(s.devicesOpenCodes(codes.length)),
        RowsCard(
          children: [
            for (final c in codes)
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 8, 12),
                child: Row(
                  children: [
                    const Icon(Icons.qr_code_2_rounded, size: 26, color: SurauColors.teal),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            c.userName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: text.titleSmall!.copyWith(color: SurauColors.text),
                          ),
                          RefText(c.userRef),
                          const SizedBox(height: 2),
                          Text(
                            s.devicesCodeExpiresIn(isolate(c.deviceName), _minutesLeft(c.expiresAt)),
                            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      key: ValueKey('code-end-${c.id}'),
                      onPressed: () => onEnd(c),
                      style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                      child: Text(s.devicesEndCode),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ],
    );
  }

  int _minutesLeft(DateTime expiresAt) {
    final secs = expiresAt.difference(now).inSeconds;
    return secs <= 0 ? 0 : (secs + 59) ~/ 60;
  }
}

/// One phone, tablet, computer or TV screen: name, ID under it, kind and
/// last use; the "Tidak aktif" chip, the automatic delete count and a direct
/// "Padam" when the box flags it; a tap opens the device sheet. Skrin TV
/// passes [line] (its own words) and [trailing] (the "Hidup" pill).
class DeviceRow extends ConsumerWidget {
  const DeviceRow({
    super.key,
    required this.device,
    required this.ownerName,
    this.ownerRef,
    this.activity,
    this.line,
    this.trailing,
  });

  final DeviceDto device;
  final String ownerName;
  final String? ownerRef;
  final DeviceActivityDto? activity;
  final String? line;
  final Widget? trailing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final d = device;
    final a = activity;
    final name = deviceNameOf(ref, d);
    final inactive = a?.inactive == true;
    final platform = platformLabel(s, d.platform);
    final words =
        line ??
        (a == null
            ? platform
            : '$platform${listComma(s)}${inactive ? unusedWords(s, a.idleDays) : lastActiveWords(s, a.idleDays)}');
    final soon = autoCleanDaysLeft(a);
    return InkWell(
      key: ValueKey('device-${d.id}'),
      onTap: () => showDeviceSheet(context, ref, device: d, ownerName: ownerName, ownerRef: ownerRef, activity: a),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 8, 12),
        child: Row(
          children: [
            Icon(platformIcon(d.platform), size: 26, color: SurauColors.teal),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: text.titleSmall!.copyWith(color: SurauColors.text),
                  ),
                  RefText(d.ref),
                  const SizedBox(height: 2),
                  Text(words, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  if (inactive) ...[const SizedBox(height: 6), InactiveChip(key: ValueKey('device-badge-${d.id}'))],
                  if (soon != null) ...[const SizedBox(height: 4), AutoCleanSoon(days: soon)],
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (trailing != null) ...[trailing!, const SizedBox(width: 8)],
            if (inactive)
              TextButton(
                key: ValueKey('device-remove-${d.id}'),
                onPressed: () => removeDevice(context, ref, d, name: name),
                style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                child: Text(s.devicesRevoke),
              )
            else
              const Padding(
                padding: EdgeInsetsDirectional.only(end: 8),
                child: Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
              ),
          ],
        ),
      ),
    );
  }
}
