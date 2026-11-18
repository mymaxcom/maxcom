// One phone, tablet, computer or TV screen in a bottom sheet (plan PP, task
// A3; reused by Skrin TV and Butiran pengguna): its name, ID, owner, kind and
// last use; "Simpan nama" to rename it (the change log keeps the old name);
// "Padam peranti ini" to delete it (today's revoke: the device can no longer
// open the app, its owner enrols again by QR).
//
// A device deleted from here leaves every list at once ([cancelledDeviceIds]),
// and a new name shows at once ([renamedDeviceNames]), before the next answer
// of the box or the store. The box's refusal of the last Pentadbir phone
// (409 `last_admin_device`) is said in words and the device stays.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/theme.dart';
import '../box/box_client.dart' show BoxError;
import '../box/wire.dart';
import '../features/common/ltr.dart';
import '../features/people/people_activity.dart';
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/ref.dart';
import '../features/sync/live_only_dialog.dart';
import '../l10n/generated/s.dart';
import '../features/prayer/prayer_names.dart' show shortDate;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String _devicesPath = '/api/devices';

/// Ids deleted in this session: hidden at once, whatever the next answer
/// from the box or the store says.
class CancelledDeviceIds extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  void add(String id) => state = {...state, id};

  void addAll(Iterable<String> ids) => state = {...state, ...ids};
}

final cancelledDeviceIdsProvider = NotifierProvider<CancelledDeviceIds, Set<String>>(CancelledDeviceIds.new);

/// Names saved in this session, by device id: shown at once.
class RenamedDeviceNames extends Notifier<Map<String, String>> {
  @override
  Map<String, String> build() => const {};

  void set(String id, String name) => state = {...state, id: name};
}

final renamedDeviceNamesProvider = NotifierProvider<RenamedDeviceNames, Map<String, String>>(RenamedDeviceNames.new);

/// [device]'s name, with a name saved in this session winning.
String deviceNameOf(WidgetRef ref, DeviceDto device) => ref.watch(renamedDeviceNamesProvider)[device.id] ?? device.name;

/// Days left before the box deletes an unused device or TV screen on its own
/// (`AUTO_DELETE_DEVICE_DAYS`, 180), shown only in the last 30 days; null
/// otherwise.
int? autoCleanDaysLeft(DeviceActivityDto? a) {
  if (a == null || !a.inactive) return null;
  final left = 180 - a.idleDays;
  return left > 0 && left <= 30 ? left : null;
}

/// Asks, then deletes [device] (`POST /api/devices/<id>/revoke`). True when
/// it is gone. Says why when it is not: the last Pentadbir phone, no
/// connection, or the box's refusal in words.
Future<bool> removeDevice(BuildContext context, WidgetRef ref, DeviceDto device, {String? name}) async {
  final s = S.of(context);
  final shown = name ?? device.name;
  final ok = await confirmDialog(
    context,
    title: s.devicesRevokeTitle(shown),
    body: s.devicesRevokeBody,
    confirm: s.devicesRevoke,
    destructive: true,
  );
  if (!ok || !context.mounted) return false;
  try {
    await ref.read(peopleApiProvider).revokeDevice(device.id);
  } catch (e) {
    if (!context.mounted) return false;
    if (e is BoxError && e.code == 'last_admin_device') {
      toast(context, s.devicesLastAdmin);
      return false;
    }
    if (await showLiveOnlyIf(context, e)) return false;
    if (!context.mounted) return false;
    toast(context, writeErrorText(s, e));
    return false;
  }
  ref.read(cancelledDeviceIdsProvider.notifier).add(device.id);
  ref.invalidate(boxJsonProvider(_devicesPath));
  ref.invalidate(peopleActivityProvider);
  if (context.mounted) toast(context, s.devicesRevokedToast(shown));
  return true;
}

/// The sheet of [device]. [ownerName] (and [ownerRef], the owner's ID) name
/// who it belongs to; [activity] is the box's day count, null when the box
/// gave none (an older box, or through the cloud).
Future<void> showDeviceSheet(
  BuildContext context,
  WidgetRef ref, {
  required DeviceDto device,
  required String ownerName,
  String? ownerRef,
  DeviceActivityDto? activity,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    constraints: BoxConstraints(maxWidth: 560, maxHeight: MediaQuery.sizeOf(context).height * 0.9),
    builder: (context) => _DeviceSheet(device: device, ownerName: ownerName, ownerRef: ownerRef, activity: activity),
  );
}

class _DeviceSheet extends ConsumerStatefulWidget {
  const _DeviceSheet({required this.device, required this.ownerName, this.ownerRef, this.activity});

  final DeviceDto device;
  final String ownerName;
  final String? ownerRef;
  final DeviceActivityDto? activity;

  @override
  ConsumerState<_DeviceSheet> createState() => _DeviceSheetState();
}

class _DeviceSheetState extends ConsumerState<_DeviceSheet> {
  late final TextEditingController _name;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: ref.read(renamedDeviceNamesProvider)[widget.device.id] ?? widget.device.name);
  }

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
    final current = ref.read(renamedDeviceNamesProvider)[widget.device.id] ?? widget.device.name;
    if (clean == current) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(peopleApiProvider).renameDevice(widget.device.id, clean);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      if (e is PeopleNeedsUpdate) {
        setState(() => _error = s.peopleNeedsUpdate);
        return;
      }
      if (await showLiveOnlyIf(context, e)) return;
      if (!mounted) return;
      setState(() => _error = writeErrorText(s, e));
      return;
    }
    if (!mounted) return;
    ref.read(renamedDeviceNamesProvider.notifier).set(widget.device.id, clean);
    ref.invalidate(boxJsonProvider(_devicesPath));
    final messenger = ScaffoldMessenger.of(context);
    Navigator.of(context).pop();
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(s.deviceRenamed)));
  }

  Future<void> _remove() async {
    final navigator = Navigator.of(context);
    final shown = ref.read(renamedDeviceNamesProvider)[widget.device.id] ?? widget.device.name;
    final gone = await removeDevice(context, ref, widget.device, name: shown);
    if (gone && mounted) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final d = widget.device;
    final a = widget.activity;
    final shownName = deviceNameOf(ref, d);
    final platform = platformLabel(s, d.platform);
    final enrolled = d.enrolledAt;
    final owner = widget.ownerRef == null
        ? isolate(widget.ownerName)
        : '${isolate(widget.ownerName)} ${ltr(widget.ownerRef!)}';
    final soon = autoCleanDaysLeft(a);
    return SingleChildScrollView(
      key: const ValueKey('device-sheet'),
      padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsetsDirectional.only(top: 2),
                child: Icon(platformIcon(d.platform), size: 28, color: SurauColors.teal),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      shownName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleLarge!.copyWith(color: SurauColors.text),
                    ),
                    const SizedBox(height: 2),
                    RefText(d.ref),
                    const SizedBox(height: 6),
                    Text(
                      enrolled == null
                          ? '$owner. $platform'
                          : s.deviceOwnedBy(owner, platform, shortDate(s, enrolled.toIso8601String())),
                      style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                    ),
                    if (a != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        a.inactive ? unusedWords(s, a.idleDays) : lastActiveWords(s, a.idleDays),
                        style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                      ),
                    ],
                    if (soon != null) ...[const SizedBox(height: 4), AutoCleanSoon(days: soon)],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          TextField(
            key: const ValueKey('device-sheet-name'),
            controller: _name,
            textCapitalization: TextCapitalization.sentences,
            textInputAction: TextInputAction.done,
            decoration: InputDecoration(
              labelText: s.deviceNameLabel,
              helperText: s.deviceNameHint,
              helperMaxLines: 2,
              errorText: _error,
              errorMaxLines: 3,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
            onSubmitted: (_) => _busy ? null : _save(),
          ),
          const SizedBox(height: 16),
          FilledButton(
            key: const ValueKey('device-sheet-save'),
            onPressed: _busy ? null : _save,
            child: Text(s.userRenameSave),
          ),
          const SizedBox(height: 8),
          Text(s.deviceRenameHistory, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 20),
          const Divider(height: 1),
          const SizedBox(height: 20),
          OutlinedButton.icon(
            key: const ValueKey('device-sheet-remove'),
            onPressed: _busy ? null : _remove,
            icon: const Icon(Icons.delete_outline_rounded),
            label: Text(s.deviceRemoveThis),
            style: OutlinedButton.styleFrom(
              foregroundColor: SurauColors.danger,
              side: const BorderSide(color: SurauColors.danger),
            ),
          ),
          const SizedBox(height: 8),
          Text(s.deviceRemoveHint, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        ],
      ),
    );
  }
}

/// "Dipadam automatik dalam {n} hari", with a clock, in the gold of a
/// warning.
class AutoCleanSoon extends StatelessWidget {
  const AutoCleanSoon({super.key, required this.days});

  final int days;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final style = Theme.of(context).textTheme.labelMedium!.copyWith(color: const Color(0xFF6B4100));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.schedule_rounded, size: 15, color: style.color),
        const SizedBox(width: 5),
        Flexible(child: Text(s.autoCleanSoon(days), style: style)),
      ],
    );
  }
}

/// "Tidak aktif" as a quiet chip.
class InactiveChip extends StatelessWidget {
  const InactiveChip({super.key});

  @override
  Widget build(BuildContext context) => StateChip(
    label: S.of(context).peopleInactiveBadge,
    background: SurauColors.paperDeep,
    foreground: SurauColors.muted,
  );
}
