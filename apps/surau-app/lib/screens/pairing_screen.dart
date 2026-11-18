// Skrin TV (plan PP, task A4): "MAXCOM di surau", the box itself (its name
// and box id, always there, never deleted, no device ID); the paired TV
// screens ("Skrin tambahan") with their ID, when the box last saw them and a
// green "Hidup" pill when seen in the last 10 minutes, "Tidak aktif" and a
// direct "Padam" when the box flags them, a tap for the same sheet as
// Peranti; then "Padankan skrin baharu": who is waiting (the address that
// asked and how long ago, never the code itself, so the admin can tell the
// surau's TV from a stranger before typing the six digits the TV shows) and
// the approval form, as before. The answer names the screen and repeats the
// requester's address and the code's age.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/wire.dart';
import '../features/people/people_activity.dart';
import '../features/prayer/prayer_names.dart' show shortDate;
import '../features/setup/setup_providers.dart';
import '../l10n/generated/s.dart';
import '../sync/sync_providers.dart' show syncViewProvider;
import 'device_sheet.dart';
import 'devices_screen.dart' show DeviceRow, devicesPath, parseDevices;
import 'users_screen.dart' show parseUsers, usersPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String pendingPath = '/api/kiosk/pair/pending';

/// A screen seen this recently is "Hidup".
const Duration tvOnWithin = Duration(minutes: 10);

/// "baru tadi", "3 minit lalu", "2 jam lalu", "41 hari lalu", by the box's
/// clock.
String seenAgoWords(S s, Duration ago) {
  if (ago.inMinutes < 1) return s.tvSeenNow;
  if (ago.inHours < 1) return s.tvSeenMinutes(ago.inMinutes);
  if (ago.inDays < 1) return s.tvSeenHours(ago.inHours);
  return s.tvSeenDays(ago.inDays);
}

class PairingScreen extends ConsumerWidget {
  const PairingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    // Away from the surau network (the app is talking to the cloud) a display cannot be paired: the pending list
    // and the approval need the box on the surau Wi-Fi.
    final away = ref.watch(syncViewProvider).value?.via == 'cloud';
    final boxInfo = ref.watch(boxInfoProvider).value;
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.pairing),
          const SizedBox(height: 20),
          if (boxInfo != null) ...[
            RowsCard(
              children: [
                Padding(
                  key: const ValueKey('tv-box-row'),
                  padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 16, 14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsetsDirectional.only(top: 2),
                        child: Icon(Icons.dns_outlined, size: 26, color: SurauColors.teal),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(s.tvBoxTitle, style: text.titleSmall!.copyWith(color: SurauColors.text)),
                            const SizedBox(height: 2),
                            Text(boxInfo.name, style: text.bodyMedium!.copyWith(color: SurauColors.text)),
                            Directionality(
                              key: const ValueKey('tv-box-id'),
                              textDirection: TextDirection.ltr,
                              child: Text(
                                s.devicesBoxRow(boxInfo.boxIdGroups),
                                style: text.bodySmall!.copyWith(color: SurauColors.muted),
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(s.devicesBoxRowHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      StateChip.on(label: s.tvOn),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
          ],
          const _Screens(),
          SectionLabel(s.tvPairNew),
          Text(s.pairingIntro, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 16),
          if (away)
            Card(
              key: const ValueKey('pairing-needs-lan'),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.devicesNeedLan, style: text.titleSmall),
                    const SizedBox(height: 4),
                    Text(s.devicesNeedLanBody, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
            )
          else ...[
            const _PendingList(),
            const SizedBox(height: 24),
            const _ApproveForm(),
          ],
        ],
      ),
    );
  }
}

/// "Skrin tambahan (n)": every live paired TV screen. Nothing when there is
/// none.
class _Screens extends ConsumerWidget {
  const _Screens();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final cancelled = ref.watch(cancelledDeviceIdsProvider);
    final away = ref.watch(syncViewProvider).value?.via == 'cloud';
    final activity = away ? null : ref.watch(peopleActivityProvider).value;
    final usersBody = ref.watch(boxJsonProvider(usersPath)).value;
    final people = <String, UserDto>{
      if (usersBody != null)
        for (final u in parseUsers(usersBody.value)) u.id: u,
    };
    return BoxReadView(
      path: devicesPath,
      builder: (context, body) {
        final screens = [
          for (final d in parseDevices(body))
            if (d.platform == 'kiosk' && !d.revoked && !cancelled.contains(d.id)) d,
        ];
        if (screens.isEmpty) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SectionLabel(s.tvExtraScreens(screens.length)),
            RowsCard(children: [for (final d in screens) _screenRow(s, d, activity, people[d.userId])]),
            const SizedBox(height: 24),
          ],
        );
      },
    );
  }

  Widget _screenRow(S s, DeviceDto d, PeopleActivityDto? activity, UserDto? owner) {
    final a = activity?.deviceOf(d.id);
    final enrolled = d.enrolledAt;
    final paired = enrolled == null ? null : shortDate(s, enrolled.toIso8601String());
    final seen = a?.lastSeenAt;
    String? line;
    var on = false;
    if (activity != null && a != null && a.inactive) {
      line = s.tvNotSeenDays(a.idleDays);
    } else if (activity != null && seen != null) {
      final ago = activity.now.difference(seen);
      on = ago <= tvOnWithin;
      final words = seenAgoWords(s, ago.isNegative ? Duration.zero : ago);
      line = paired == null ? words : s.tvPairedSeen(paired, words);
    } else if (paired != null) {
      line = s.tvPaired(paired);
    }
    return DeviceRow(
      device: d,
      ownerName: owner?.name ?? d.userId,
      ownerRef: owner?.ref,
      activity: a,
      line: line ?? platformLabel(s, d.platform),
      trailing: on ? StateChip.on(label: s.tvOn) : null,
    );
  }
}

class _PendingList extends StatelessWidget {
  const _PendingList();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return BoxReadView(
      path: pendingPath,
      builder: (context, body) {
        final rows = (body['pairings'] as List? ?? const []).cast<Map<String, dynamic>>();
        if (rows.isEmpty) {
          return Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
              child: Text(s.tvNoneWaiting, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SectionLabel(s.pairingPendingTitle),
            RowsCard(
              children: [
                for (final r in rows)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
                    child: Row(
                      children: [
                        const Icon(Icons.tv_outlined, color: SurauColors.teal, size: 26),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                s.pairingPendingRow(
                                  (r['requesterIp'] as String?) ?? s.pairingUnknownIp,
                                  ageWords(s, (r['codeAgeSeconds'] as num? ?? 0).toInt()),
                                ),
                                style: text.titleSmall,
                              ),
                              const SizedBox(height: 2),
                              Text(s.pairingStrangerHint, style: text.bodySmall),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ],
        );
      },
    );
  }
}

class _ApproveForm extends ConsumerStatefulWidget {
  const _ApproveForm();

  @override
  ConsumerState<_ApproveForm> createState() => _ApproveFormState();
}

class _ApproveFormState extends ConsumerState<_ApproveForm> {
  final _code = TextEditingController();
  final _name = TextEditingController();
  String? _codeError;
  String? _error;
  bool _busy = false;
  (String name, String ip, int age)? _done;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _approve() async {
    final s = S.of(context);
    final code = _code.text.trim();
    if (code.length != 6) {
      setState(() => _codeError = s.pairingCodeRequired);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    final name = _name.text.trim();
    setState(() {
      _busy = true;
      _codeError = null;
      _error = null;
      _done = null;
    });
    try {
      final out = await gateway.post('/api/kiosk/pair/approve', {
        'code': code,
        if (name.isNotEmpty) 'deviceName': name,
      });
      if (!mounted) return;
      setState(() {
        _busy = false;
        _done = (
          out['name'] as String? ?? name,
          out['requesterIp'] as String? ?? s.pairingUnknownIp,
          (out['codeAgeSeconds'] as num? ?? 0).toInt(),
        );
        _code.clear();
        _name.clear();
      });
      ref.invalidate(boxJsonProvider(pendingPath));
      ref.invalidate(boxJsonProvider(devicesPath));
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
    final done = _done;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (done != null) ...[
          DoneLine(s.pairingDone(done.$1), detail: s.pairingDoneDetail(done.$2, ageWords(s, done.$3))),
          if (ref.watch(boxInfoProvider).value != null) ...[
            const SizedBox(height: 8),
            Text(
              s.devicesPairedMirrors(done.$1, ref.watch(boxInfoProvider).value!.name),
              key: const ValueKey('pairing-mirrors'),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ],
          const SizedBox(height: 20),
        ],
        TextField(
          key: const ValueKey('pair-code'),
          controller: _code,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          autocorrect: false,
          enableSuggestions: false,
          textAlign: TextAlign.center,
          style: text.headlineMedium!.copyWith(letterSpacing: 8, fontFeatures: const [FontFeature.tabularFigures()]),
          decoration: InputDecoration(
            labelText: s.pairingCodeLabel,
            floatingLabelAlignment: FloatingLabelAlignment.center,
            errorText: _codeError,
            errorMaxLines: 2,
          ),
          onChanged: (_) {
            if (_codeError != null) setState(() => _codeError = null);
          },
        ),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey('pair-name'),
          controller: _name,
          textCapitalization: TextCapitalization.sentences,
          textInputAction: TextInputAction.done,
          maxLength: 80,
          decoration: InputDecoration(labelText: s.pairingNameLabel, hintText: s.pairingNameHint, counterText: ''),
          onSubmitted: (_) => _approve(),
        ),
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        const SizedBox(height: 20),
        FilledButton.icon(
          onPressed: _busy ? null : _approve,
          icon: const Icon(Icons.check_rounded),
          label: Text(s.pairingApprove),
        ),
      ],
    );
  }
}
