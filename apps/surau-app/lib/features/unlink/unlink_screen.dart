// "Putuskan pautan" at the main box: the intro on a follower's row, the sheet of each side this phone answers for,
// "Menunggu pentadbir yang satu lagi", the progress, the join of the follower by the phone that answered for it (the
// 2C move flow's `connect`), the result, and the data kept after an unlink with "Tukar pilihan" and "Buang data
// lama" until the date the box names. The controller (unlink_controller.dart) polls the box every two seconds.

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxUnreachable;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show DoneLine, ErrorLine, PinField, SectionLabel, platformLabel, toast;
import '../common/contact_links.dart' show UrlOpener, launchOutside;
import '../common/ltr.dart';
import '../enrol/enrol_flow.dart' show EnrolledBox;
import '../enrol/pin_policy.dart';
import '../labels.dart' show appLangOf;
import '../link/link_text.dart' show linkCodeText;
import '../link/link_widgets.dart';
import '../link/move_flow.dart';
import 'unlink_confirm_sheet.dart';
import 'unlink_controller.dart';
import 'unlink_models.dart';
import 'unlink_sheet.dart';
import 'unlink_text.dart';

/// The route: the page around [UnlinkFlowBody]. [deviceId] and [name] come from the follower's row; without them the
/// page shows the data kept after an unlink only.
class UnlinkFlowScreen extends ConsumerStatefulWidget {
  const UnlinkFlowScreen({super.key, this.deviceId, this.name});

  final String? deviceId;
  final String? name;

  @override
  ConsumerState<UnlinkFlowScreen> createState() => _UnlinkFlowScreenState();
}

class _UnlinkFlowScreenState extends ConsumerState<UnlinkFlowScreen> {
  late final UnlinkController _ctl;

  @override
  void initState() {
    super.initState();
    _ctl = ref.read(unlinkControllerProvider.notifier)..startPolling();
  }

  @override
  void dispose() {
    _ctl.stopPolling();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ShellPage(
      title: s.unlinkTitle,
      backTo: AppRoutes.screens,
      body: SurauTheme.page(children: [UnlinkFlowBody(deviceId: widget.deviceId, name: widget.name)]),
    );
  }
}

/// What the page shows for the state of the box; no page of its own, so the tests draw it alone.
class UnlinkFlowBody extends ConsumerWidget {
  const UnlinkFlowBody({super.key, this.deviceId, this.name});

  final String? deviceId;
  final String? name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final state = ref.watch(unlinkControllerProvider);
    final ctl = ref.read(unlinkControllerProvider.notifier);
    final phase = unlinkPhaseOf(state, canStart: deviceId != null);
    final err = state.error;
    final session = state.status?.session;
    final deps = ref.watch(appDepsProvider);
    // The sheets show their own refusal under the choices; the others are said on top.
    final sheetOwnsError = phase == UnlinkPhase.answers;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.unreachable) ...[ErrorLine(s.errorBoxUnreachable), const SizedBox(height: 12)],
        if (state.unreadable) ...[ErrorLine(s.linkCodeUnknown), const SizedBox(height: 12)],
        if (err != null && !sheetOwnsError && err != 'unreachable') ...[ErrorLine(unlinkCodeText(s, err)), const SizedBox(height: 12)],
        switch (phase) {
          UnlinkPhase.loading => const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2)),
          UnlinkPhase.start => UnlinkStartView(
            name: name ?? '',
            onStart: () => _start(context, ref),
          ),
          UnlinkPhase.idle => UnlinkIdleView(kept: state.status!.kept),
          UnlinkPhase.answers => _SheetHost(session: session!, state: state),
          UnlinkPhase.waiting => UnlinkWaitingView(
            session: session!,
            onEdit: session.mine.isEmpty ? null : () => ctl.edit(session.mine.firstWhere((x) => session.sideView(x).agreed, orElse: () => session.mine.first)),
            onCancel: () => ctl.cancel(),
            busy: state.busy,
          ),
          UnlinkPhase.progress => UnlinkProgressView(
            progress: session!.progress,
            videosNotFit: session.follower.numbers.videosNotFit,
          ),
          UnlinkPhase.join => UnlinkJoinView(
            join: session!.join!,
            masterName: session.masterName,
            onStay: () => context.go(AppRoutes.screens),
            deviceName: platformLabel(s, deps.platform),
            run: ref.read(unlinkJoinProvider),
            isWeb: ref.watch(unlinkIsWebProvider),
            openUrl: deps.openUrl,
            userName: ref.watch(enrolledBoxProvider)?.userName ?? '',
            onContinue: (box) {
              ref.read(enrolledBoxProvider.notifier).adopt(box);
              context.go(AppRoutes.unlock);
            },
          ),
          UnlinkPhase.joinWait => UnlinkJoinWaitView(name: session!.followerName),
          UnlinkPhase.result => UnlinkResultView(
            outcome: state.status!.last?.outcome ?? 'done',
            followerName: state.status!.last?.followerName ?? session?.followerName ?? '',
            kept: state.status!.kept,
            videosNotFit: session?.follower.numbers.videosNotFit ?? const <UnlinkVideo>[],
            onList: () {
              ctl.dismissResult();
              context.go(AppRoutes.screens);
            },
            onClose: ctl.dismissResult,
          ),
        },
        if (phase == UnlinkPhase.start && state.status!.kept.isNotEmpty) ...[
          const SizedBox(height: 20),
          UnlinkKeptRows(kept: state.status!.kept),
        ],
      ],
    );
  }

  Future<void> _start(BuildContext context, WidgetRef ref) async {
    final id = deviceId;
    if (id == null) return;
    final s = S.of(context);
    final ctl = ref.read(unlinkControllerProvider.notifier);
    if (!ctl.pinRequired) {
      await ctl.start(id, null);
      return;
    }
    await showUnlinkConfirmSheet(
      context,
      title: s.linkPinTitle,
      body: s.unlinkStartPinBody,
      action: s.unlinkStartButton,
      needsPin: true,
      submit: (pin) => _viaSheet(ctl, () => ctl.start(id, pin)),
    );
  }
}

/// An action a confirm sheet runs: a refusal is worded in the sheet, so the page behind does not say it again.
Future<String?> _viaSheet(UnlinkController ctl, Future<String?> Function() call) async {
  final code = await call();
  if (code != null) ctl.clearError();
  return code;
}

// ---- the sheet of one side ----

class _SheetHost extends ConsumerWidget {
  const _SheetHost({required this.session, required this.state});

  final UnlinkView session;
  final UnlinkState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ctl = ref.read(unlinkControllerProvider.notifier);
    final deps = ref.watch(appDepsProvider);
    final side = unlinkSideToAnswer(session, state.editing)!;
    final v = session.sideView(side);
    final both = session.mine.length > 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (both) ...[
          SegmentedButton<UnlinkSide>(
            key: const ValueKey('unlink-side-switch'),
            segments: [
              ButtonSegment(value: UnlinkSide.follower, label: Text(S.of(context).unlinkSideFollower)),
              ButtonSegment(value: UnlinkSide.master, label: Text(S.of(context).unlinkSideMaster)),
            ],
            selected: {side},
            onSelectionChanged: (x) => ctl.edit(x.first),
          ),
          const SizedBox(height: 16),
        ],
        UnlinkSheetView(
          session: session,
          side: side,
          lang: appLangOf(context),
          toLocal: deps.toLocal,
          tick: v.financeTick,
          busy: state.busy,
          staleNotice: state.staleNotice,
          error: state.error,
          onChoose: (c) => ctl.choose(side, c),
          onRemovePeople: ctl.setRemovePeople,
          onTick: ctl.setFinanceTick,
          onAgree: () => _agree(context, ref, side, v),
          onCancel: () => ctl.cancel(),
        ),
      ],
    );
  }

  Future<void> _agree(BuildContext context, WidgetRef ref, UnlinkSide side, UnlinkSideView v) async {
    final s = S.of(context);
    final ctl = ref.read(unlinkControllerProvider.notifier);
    if (!v.needsTyped && !ctl.pinRequired) {
      await ctl.agree(side);
      return;
    }
    await showUnlinkConfirmSheet(
      context,
      title: v.needsTyped ? s.unlinkConfirmTitle : s.linkPinTitle,
      body: v.needsTyped ? s.unlinkConfirmBody : s.unlinkAgreePinBody,
      action: s.unlinkAgree,
      needsPin: ctl.pinRequired,
      word: v.needsTyped ? s.unlinkWord : null,
      destructive: v.needsTyped,
      submit: (pin) => _viaSheet(ctl, () => ctl.agree(side, confirm: v.needsTyped, pin: pin)),
    );
  }
}

// ---- start ----

class UnlinkStartView extends StatelessWidget {
  const UnlinkStartView({super.key, required this.name, required this.onStart});

  final String name;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('unlink-start'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.link_off_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(s.unlinkSheetTitle(name), textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 10),
        Text(s.unlinkStartBody, textAlign: TextAlign.center, style: text.bodyLarge),
        const SizedBox(height: 14),
        LinkNote(tone: LinkTone.grey, icon: Icons.phone_android_rounded, text: s.unlinkStartPhoneNote(name)),
        const SizedBox(height: 10),
        LinkNote(tone: LinkTone.gold, icon: Icons.timer_outlined, text: s.unlinkStartTimeNote),
        const SizedBox(height: 20),
        FilledButton(key: const ValueKey('unlink-start-go'), onPressed: onStart, child: Text(s.unlinkStartButton)),
      ],
    );
  }
}

/// One line on the screens list while data is kept after an unlink: "Data lama disimpan hingga 27 Nov 2026". It opens
/// the page of the kept rows. Nothing is drawn when nothing is kept or the person may not manage devices.
class UnlinkKeptLine extends ConsumerWidget {
  const UnlinkKeptLine({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final kept = ref.watch(unlinkKeptProvider).value;
    if (kept == null || kept.isEmpty) return const SizedBox.shrink();
    final s = S.of(context);
    final deps = ref.watch(appDepsProvider);
    final until = kept.map((k) => k.keptUntil).reduce((a, b) => a.isBefore(b) ? a : b);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        key: const ValueKey('tvs-kept-line'),
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        onTap: () => context.go(AppRoutes.screensUnlink),
        child: LinkNote(
          tone: LinkTone.teal,
          icon: Icons.history_rounded,
          text: s.unlinkKeptListLine(ltr(unlinkDate(deps.toLocal(until), appLangOf(context)))),
        ),
      ),
    );
  }
}

class UnlinkIdleView extends StatelessWidget {
  const UnlinkIdleView({super.key, required this.kept});

  final List<UnlinkKept> kept;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    if (kept.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(s.unlinkKeptNone, key: const ValueKey('unlink-idle-none'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
      );
    }
    return UnlinkKeptRows(kept: kept);
  }
}

// ---- waiting and progress ----

/// "Menunggu pentadbir yang satu lagi", with "Ubah jawapan" while this phone has a side to change and "Batal".
class UnlinkWaitingView extends StatelessWidget {
  const UnlinkWaitingView({super.key, required this.session, required this.onEdit, required this.onCancel, required this.busy});

  final UnlinkView session;
  final VoidCallback? onEdit;
  final VoidCallback onCancel;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('unlink-waiting'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.hourglass_top_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 16),
        Text(s.unlinkWaitingTitle, key: const ValueKey('unlink-waiting-title'), textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 8),
        Text(
          session.mine.isEmpty ? s.unlinkWaitingOther : s.unlinkWaitingBody,
          textAlign: TextAlign.center,
          style: text.bodyLarge,
        ),
        const SizedBox(height: 20),
        if (onEdit != null)
          OutlinedButton(key: const ValueKey('unlink-edit'), onPressed: busy ? null : onEdit, child: Text(s.unlinkChangeAnswer)),
        if (onEdit != null) const SizedBox(height: 8),
        TextButton(key: const ValueKey('unlink-cancel'), onPressed: busy ? null : onCancel, child: Text(s.actionCancel)),
      ],
    );
  }
}

/// "Langkah 2 daripada 3: menyimpan data sekarang, 62%", with a bar.
class UnlinkProgressView extends StatelessWidget {
  const UnlinkProgressView({super.key, required this.progress, this.videosNotFit = const <UnlinkVideo>[]});

  final UnlinkProgress? progress;

  /// The videos the follower's copy leaves out; known once the copy started.
  final List<UnlinkVideo> videosNotFit;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final p = progress;
    final line = p == null
        ? s.unlinkProgressStarting
        : p.percent == null
        ? s.linkProgressStep(p.stepNo, p.steps, unlinkStepName(s, p.step))
        : s.linkProgressStepPercent(p.stepNo, p.steps, unlinkStepName(s, p.step), p.percent!);
    final value = p == null ? 0.0 : (p.percent != null ? p.percent! / 100 : (p.stepNo - 1) / p.steps).clamp(0.0, 1.0);
    return Column(
      key: const ValueKey('unlink-progress'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.sync_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(s.unlinkProgressTitle, textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 16),
        Text(line, key: const ValueKey('unlink-progress-step'), textAlign: TextAlign.center, style: text.titleMedium),
        const SizedBox(height: 12),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(key: const ValueKey('unlink-progress-bar'), value: value, minHeight: 10),
        ),
        if (videosNotFit.isNotEmpty) ...[const SizedBox(height: 14), UnlinkVideosNotFit(videos: videosNotFit)],
        const SizedBox(height: 20),
        LinkNote(tone: LinkTone.gold, icon: Icons.power_settings_new_rounded, text: s.unlinkProgressNote),
      ],
    );
  }
}

// ---- join ----

/// The follower side's phone joins the follower: a new PIN, the ticket of the pointer, the 2C move flow's `connect`.
class UnlinkJoinView extends StatefulWidget {
  const UnlinkJoinView({
    super.key,
    required this.join,
    required this.masterName,
    required this.deviceName,
    required this.run,
    required this.onContinue,
    required this.onStay,
    this.isWeb = kIsWeb,
    this.openUrl = launchOutside,
    this.userName = '',
  });

  final UnlinkJoin join;

  /// A browser cannot call the follower (another origin, another certificate): it opens the follower's own web app
  /// instead, where the person enrols with the join ticket. Native apps join directly.
  final bool isWeb;

  /// Opens the follower's web app (web only).
  final UrlOpener openUrl;

  /// The name of this person, shown on the enrol page of the follower.
  final String userName;

  /// The main box's name, for the sentence that says what staying costs this phone.
  final String masterName;

  /// "Kekal di sini": the phone does not join the follower and goes back to the main box's screens.
  final VoidCallback onStay;
  final String deviceName;
  final UnlinkJoinRunner run;

  /// "Teruskan": the new enrolment is saved; the app takes it as its box.
  final void Function(EnrolledBox box) onContinue;

  @override
  State<UnlinkJoinView> createState() => _UnlinkJoinViewState();
}

class _UnlinkJoinViewState extends State<UnlinkJoinView> {
  final _pin = TextEditingController();
  final _again = TextEditingController();
  bool _working = false;
  EnrolledBox? _done;
  String? _error;

  @override
  void dispose() {
    _pin.dispose();
    _again.dispose();
    super.dispose();
  }

  /// Web: opens the follower's own web app on its enrol page with the join ticket in the address fragment.
  Future<void> _openFollower() async {
    final s = S.of(context);
    final j = widget.join;
    final ok = await widget.openUrl(
      followerEnrolUrl(j.pointer, user: j.user ?? widget.userName, origin: j.box, expMs: j.expMs),
    );
    if (!mounted) return;
    setState(() => _error = ok ? null : s.unlinkJoinWebFailed);
  }

  Future<void> _connect() async {
    final s = S.of(context);
    if (!isValidPin(_pin.text)) {
      setState(() => _error = s.pinTooWeak);
      return;
    }
    if (_pin.text != _again.text) {
      setState(() => _error = s.pinMismatch);
      return;
    }
    setState(() {
      _error = null;
      _working = true;
    });
    String? error;
    EnrolledBox? box;
    try {
      box = await widget.run(widget.join.pointer, _pin.text, widget.deviceName);
    } on MoveFailure catch (e) {
      error = _failureText(s, e);
    } on BoxUnreachable {
      error = s.unlinkJoinUnreachable(widget.join.name);
    } on Object {
      error = s.errorBoxUnreachable;
    }
    if (!mounted) return;
    setState(() {
      _working = false;
      _done = box;
      _error = error;
    });
  }

  String _failureText(S s, MoveFailure e) => switch (e) {
    // Said plainly: the follower did not answer. Never the "open the app on the surau Wi-Fi" line of the phone move.
    MoveAway() => s.unlinkJoinUnreachable(widget.join.name),
    MoveNeedCode() => s.moveNeedCodeNoName,
    MoveTooMany() => s.moveTooMany,
    MoveWrongBox() => s.moveWrongBox,
    MovePinTooWeak() => s.pinTooWeak,
    MoveBadPointer() || MoveNotFollower() => s.moveBadPointer,
  };

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final name = widget.join.name;
    final done = _done;
    if (done != null) {
      return Column(
        key: const ValueKey('unlink-join-done'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DoneLine(s.moveDone(name)),
          const SizedBox(height: 16),
          FilledButton(key: const ValueKey('unlink-join-continue'), onPressed: () => widget.onContinue(done), child: Text(s.moveDoneButton)),
        ],
      );
    }
    if (_working) {
      return Column(
        key: const ValueKey('unlink-join-working'),
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          Text(s.moveWorking(name), textAlign: TextAlign.center, style: text.titleMedium),
        ],
      );
    }
    if (widget.isWeb) {
      return Column(
        key: const ValueKey('unlink-join-web'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(Icons.open_in_new_rounded, size: 44, color: SurauColors.teal),
          const SizedBox(height: 12),
          Text(s.unlinkJoinTitle(name), key: const ValueKey('unlink-join-title'), textAlign: TextAlign.center, style: text.titleLarge),
          const SizedBox(height: 10),
          Text(s.unlinkJoinWebBody(name), textAlign: TextAlign.center, style: text.bodyLarge),
          const SizedBox(height: 20),
          FilledButton(key: const ValueKey('unlink-join-open'), onPressed: _openFollower, child: Text(s.unlinkJoinWebOpen(name))),
          const SizedBox(height: 8),
          Text(s.unlinkJoinWebTrust, key: const ValueKey('unlink-join-trust'), textAlign: TextAlign.center, style: text.bodySmall),
          if (_error != null) ...[const SizedBox(height: 10), ErrorLine(_error!)],
          const SizedBox(height: 16),
          LinkNote(
            key: const ValueKey('unlink-join-stay-note'),
            tone: LinkTone.gold,
            icon: Icons.logout_rounded,
            text: s.unlinkJoinStayNote(widget.masterName, name),
          ),
          const SizedBox(height: 8),
          TextButton(key: const ValueKey('unlink-join-stay'), onPressed: widget.onStay, child: Text(s.unlinkJoinStay)),
        ],
      );
    }
    return Column(
      key: const ValueKey('unlink-join'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.lock_outline_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(s.unlinkJoinTitle(name), key: const ValueKey('unlink-join-title'), textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 10),
        Text(s.unlinkJoinBody(name), textAlign: TextAlign.center, style: text.bodyLarge),
        const SizedBox(height: 20),
        PinField(
          key: const ValueKey('unlink-join-pin'),
          controller: _pin,
          label: s.enrolPinNewHint,
          autofocus: true,
          onChanged: (_) => setState(() => _error = null),
        ),
        const SizedBox(height: 12),
        PinField(
          key: const ValueKey('unlink-join-pin-again'),
          controller: _again,
          label: s.enrolPinAgainLabel,
          onChanged: (_) => setState(() => _error = null),
        ),
        const SizedBox(height: 6),
        Text(s.enrolPinCreateHint, style: text.bodySmall),
        if (_error != null) ...[const SizedBox(height: 10), ErrorLine(_error!)],
        const SizedBox(height: 16),
        FilledButton(key: const ValueKey('unlink-join-submit'), onPressed: _connect, child: Text(s.moveConnect)),
        const SizedBox(height: 16),
        LinkNote(
          key: const ValueKey('unlink-join-stay-note'),
          tone: LinkTone.gold,
          icon: Icons.logout_rounded,
          text: s.unlinkJoinStayNote(widget.masterName, name),
        ),
        const SizedBox(height: 8),
        TextButton(key: const ValueKey('unlink-join-stay'), onPressed: widget.onStay, child: Text(s.unlinkJoinStay)),
      ],
    );
  }
}

/// This phone does not join the follower: another phone does; the unlink is not done until it has.
class UnlinkJoinWaitView extends StatelessWidget {
  const UnlinkJoinWaitView({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('unlink-join-wait'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.hourglass_top_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 16),
        Text(s.unlinkJoinWaitTitle(name), textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 8),
        Text(s.unlinkJoinWaitBody, textAlign: TextAlign.center, style: text.bodyLarge),
      ],
    );
  }
}

// ---- result and kept data ----

class UnlinkResultView extends StatelessWidget {
  const UnlinkResultView({
    super.key,
    required this.outcome,
    required this.followerName,
    required this.kept,
    required this.onList,
    required this.onClose,
    this.videosNotFit = const <UnlinkVideo>[],
  });

  /// `done`, `cancelled`, `failed` or `expired`.
  final String outcome;
  final String followerName;
  final List<UnlinkKept> kept;

  /// The videos the follower's copy left out, when the session is still there to say.
  final List<UnlinkVideo> videosNotFit;
  final VoidCallback onList;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    if (outcome != 'done') {
      return Column(
        key: const ValueKey('unlink-failed'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(Icons.link_rounded, size: 44, color: SurauColors.danger),
          const SizedBox(height: 12),
          Text(s.unlinkFailedTitle, textAlign: TextAlign.center, style: text.titleLarge),
          const SizedBox(height: 12),
          ErrorLine(linkCodeText(s, outcome)),
          const SizedBox(height: 20),
          FilledButton(key: const ValueKey('unlink-done-close'), onPressed: onClose, child: Text(s.linkDoneClose)),
        ],
      );
    }
    return Column(
      key: const ValueKey('unlink-done'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DoneLine(s.unlinkDoneTitle, detail: followerName.isEmpty ? null : s.unlinkDoneBody(followerName)),
        if (videosNotFit.isNotEmpty) ...[const SizedBox(height: 14), UnlinkVideosNotFit(videos: videosNotFit)],
        if (kept.isNotEmpty) ...[const SizedBox(height: 20), UnlinkKeptRows(kept: kept)],
        const SizedBox(height: 20),
        FilledButton(key: const ValueKey('unlink-done-list'), onPressed: onList, child: Text(s.linkDoneList)),
        const SizedBox(height: 8),
        TextButton(key: const ValueKey('unlink-done-close'), onPressed: onClose, child: Text(s.linkDoneClose)),
      ],
    );
  }
}

/// The data kept after an unlink: what was chosen, "Pilihan ini boleh ditukar hingga the date", "Tukar pilihan" and
/// "Buang data lama".
class UnlinkKeptRows extends ConsumerWidget {
  const UnlinkKeptRows({super.key, required this.kept});

  final List<UnlinkKept> kept;

  /// The title of a row; a name the box did not give is left out, never printed as an empty gap.
  static String _keptTitle(S s, UnlinkKept k) {
    if (k.side == UnlinkSide.master) {
      if (k.followerName.isEmpty) return k.masterName.isEmpty ? s.productName : k.masterName;
      return s.unlinkKeptMasterNamed(k.masterName.isEmpty ? s.productName : k.masterName, k.followerName);
    }
    return k.followerName.isEmpty ? s.productName : s.unlinkKeptFollowerRow(k.followerName);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final lang = appLangOf(context);
    final needsPin = ref.watch(appLockProvider);
    final ctl = ref.read(unlinkControllerProvider.notifier);
    final muted = text.bodyMedium!.copyWith(color: SurauColors.muted);
    return Column(
      key: const ValueKey('unlink-kept'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(s.unlinkKeptSection),
        for (final k in kept)
          Container(
            key: ValueKey('unlink-kept-${k.side.name}-${k.followerName}'),
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
            decoration: BoxDecoration(
              color: SurauColors.card,
              border: Border.all(color: SurauColors.line),
              borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_keptTitle(s, k), style: text.titleSmall),
                Text(k.chosen == UnlinkChoice.back ? s.unlinkKeptChosenBack : s.unlinkKeptChosenCarry, style: muted),
                Text(
                  s.backupKeptLine(ltr(unlinkDate(deps.toLocal(k.keptUntil), lang))),
                  key: ValueKey('unlink-kept-line-${k.side.name}'),
                  style: muted,
                ),
                Wrap(
                  children: [
                    if (k.switchable)
                    TextButton(
                      key: ValueKey('unlink-switch-${k.side.name}'),
                      onPressed: () => showUnlinkConfirmSheet(
                        context,
                        title: s.unlinkSwitchTitle,
                        body: k.otherChoice == UnlinkChoice.back
                            ? s.unlinkSwitchBodyToBack(ltr(unlinkDate(deps.toLocal(k.keptUntil), lang)))
                            : s.unlinkSwitchBodyToCarry(ltr(unlinkDate(deps.toLocal(k.keptUntil), lang))),
                        action: s.unlinkSwitch,
                        needsPin: needsPin,
                        word: s.unlinkWord,
                        destructive: true,
                        submit: (pin) async {
                          final code = await _viaSheet(ctl, () => ctl.switchChoice(k.side, pin));
                          if (code == null && context.mounted) toast(context, s.unlinkSwitchedToast);
                          return code;
                        },
                      ),
                      child: Text(s.unlinkSwitch),
                    ),
                    TextButton(
                      key: ValueKey('unlink-drop-${k.side.name}'),
                      onPressed: () => showUnlinkConfirmSheet(
                        context,
                        title: s.backupKeptDropTitle,
                        body: s.unlinkDropBody,
                        action: s.backupKeptDrop,
                        needsPin: needsPin,
                        word: s.backupWordDrop,
                        destructive: true,
                        submit: (pin) async {
                          final code = await _viaSheet(ctl, () => ctl.dropKept(k.side, pin));
                          if (code == null && context.mounted) toast(context, s.backupKeptDroppedToast);
                          return code;
                        },
                      ),
                      style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
                      child: Text(s.backupKeptDrop),
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}
