// "Pautkan MAXCOM Kiosk Box": the link flow of Peranti > Skrin TV dan MAXCOM Kiosk Box. One screen that follows the controller
// (link_controller.dart): it draws the entry (the checks and two choices), the PIN sheet, the camera and the
// confirmation of a scanned box, the wait for the other admin, the matching code, the questions, the progress, the
// result and the stops. The screens of the questions and of the code are in their own files.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show DoneLine, ErrorLine;
import '../common/ltr.dart';
import '../enrol/enrol_screen.dart' show defaultScanner;
import '../labels.dart' show appLangOf;
import 'link_code_view.dart';
import 'link_kept_notice.dart';
import 'link_controller.dart';
import 'link_models.dart';
import 'link_pin_sheet.dart';
import 'link_questions.dart';
import 'link_text.dart';
import 'link_widgets.dart';
import '../setup/recovery_code_view.dart';

/// The refusals a screen words beside its buttons; the PIN's own are worded in the sheet, the others by the screen.
const Set<String> _quietCodes = {'wrong_pin', 'locked', 'pin_required', 'stale_revision', 'unreachable'};

class LinkFlowScreen extends ConsumerStatefulWidget {
  const LinkFlowScreen({super.key});

  @override
  ConsumerState<LinkFlowScreen> createState() => _LinkFlowScreenState();
}

class _LinkFlowScreenState extends ConsumerState<LinkFlowScreen> {
  late final LinkController _ctl;

  @override
  void initState() {
    super.initState();
    _ctl = ref.read(linkControllerProvider.notifier)..startPolling();
  }

  @override
  void dispose() {
    _ctl.stopPolling();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final state = ref.watch(linkControllerProvider);
    final phase = linkPhaseOf(state);
    final err = state.error;
    return ShellPage(
      title: s.linkTitle,
      backTo: AppRoutes.screens,
      body: SurauTheme.page(
        children: [
          if (state.unreachable) ...[
            ErrorLine(s.errorBoxUnreachable),
            const SizedBox(height: 12),
          ],
          if (state.unreadable) ...[
            ErrorLine(s.linkCodeUnknown),
            const SizedBox(height: 12),
          ],
          if (err != null && !_quietCodes.contains(err) && phase != LinkPhase.questions && phase != LinkPhase.scanning) ...[
            if (err == 'kept_data') KeptDataNotice(until: state.errorUntil) else ErrorLine(linkErrorText(s, err, state.errorUntil, appLangOf(context))),
            const SizedBox(height: 12),
          ],
          switch (phase) {
            LinkPhase.loading => const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: LinearProgressIndicator(minHeight: 2),
            ),
            LinkPhase.follower => _FollowerView(master: state.status?.master),
            LinkPhase.entry => _EntryView(state: state),
            LinkPhase.scanning => _ScanView(state: state),
            LinkPhase.waiting => _WaitingView(session: state.status!.session!),
            LinkPhase.calling => _CallingView(session: state.status!.session!),
            LinkPhase.code => _CodeHost(state: state),
            LinkPhase.questions => _QuestionsHost(state: state),
            LinkPhase.progress => LinkProgressView(
              progress: state.status?.progress,
              session: state.status?.session,
            ),
            LinkPhase.done => _DoneView(state: state),
            LinkPhase.stop => _StopView(stop: state.stop!),
          },
        ],
      ),
    );
  }
}

// ---- follower ----

class _FollowerView extends StatelessWidget {
  const _FollowerView({required this.master});

  final String? master;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('link-follower'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.link_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(
          master == null ? s.linkFollowerTitleNoName : s.linkFollowerTitle(master!),
          key: const ValueKey('link-follower-title'),
          textAlign: TextAlign.center,
          style: text.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(s.linkCheckFollower, textAlign: TextAlign.center, style: text.bodyLarge),
      ],
    );
  }
}

// ---- entry ----

class _EntryView extends ConsumerWidget {
  const _EntryView({required this.state});

  final LinkState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final st = state.status!;
    final block = linkBlockOf(st);
    final ctl = ref.read(linkControllerProvider.notifier);
    final ownName = state.ownName ?? st.session?.own.name ?? '';

    Future<void> show() async {
      if (!ctl.pinRequired) {
        await ctl.showCode(null);
        return;
      }
      await showLinkPinSheet(
        context,
        body: s.linkPinBodyShow(ownName),
        action: s.linkShowCode,
        submit: (pin) async {
          final code = await ctl.showCode(pin);
          return code;
        },
        codeText: (s, code) => linkErrorText(s, code, ref.read(linkControllerProvider).errorUntil, appLangOf(context)),
      );
    }

    Widget choice({
      required Key key,
      required IconData icon,
      required String title,
      required String sub,
      required VoidCallback? onTap,
    }) {
      return Opacity(
        opacity: onTap == null ? 0.55 : 1,
        child: Card(
          margin: const EdgeInsets.only(bottom: 12),
          child: InkWell(
            key: key,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 12, 14),
              child: Row(
                children: [
                  Icon(icon, size: 30, color: SurauColors.teal),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: text.titleSmall),
                        const SizedBox(height: 2),
                        Text(sub, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                ],
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      key: const ValueKey('link-entry'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.linkEntryIntro, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 16),
        if (block != null) ...[
          LinkNote(
            key: ValueKey('link-block-${block.name}'),
            tone: LinkTone.gold,
            icon: block == LinkBlock.notLan ? Icons.wifi_off_rounded : Icons.info_outline_rounded,
            text: switch (block) {
              LinkBlock.notLan => s.linkCheckLan,
              LinkBlock.live => s.linkCheckLive,
              LinkBlock.follower => s.linkCheckFollower,
            },
          ),
          const SizedBox(height: 16),
        ],
        choice(
          key: const ValueKey('link-choice-show'),
          icon: Icons.qr_code_2_rounded,
          title: s.linkChoiceShow,
          sub: s.linkChoiceShowSub,
          onTap: block == null && !state.busy ? show : null,
        ),
        choice(
          key: const ValueKey('link-choice-scan'),
          icon: Icons.qr_code_scanner_rounded,
          title: s.linkChoiceScan,
          sub: s.linkChoiceScanSub,
          onTap: block == null && !state.busy ? ctl.beginScan : null,
        ),
      ],
    );
  }
}

// ---- scan ----

class _ScanView extends ConsumerStatefulWidget {
  const _ScanView({required this.state});

  final LinkState state;

  @override
  ConsumerState<_ScanView> createState() => _ScanViewState();
}

class _ScanViewState extends ConsumerState<_ScanView> {
  final _paste = TextEditingController();

  @override
  void dispose() {
    _paste.dispose();
    super.dispose();
  }

  Future<void> _confirm() async {
    final s = S.of(context);
    final ctl = ref.read(linkControllerProvider.notifier);
    final q = widget.state.scanned!;
    if (!ctl.pinRequired) {
      await ctl.confirmScan(null);
      return;
    }
    await showLinkPinSheet(
      context,
      body: s.linkPinBodyScan(q.name),
      action: s.actionContinue,
      submit: ctl.confirmScan,
      codeText: (s, code) => linkErrorText(s, code, ref.read(linkControllerProvider).errorUntil, appLangOf(context)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final state = widget.state;
    final ctl = ref.read(linkControllerProvider.notifier);
    final q = state.scanned;
    if (q != null) {
      final err = state.error;
      return Column(
        key: const ValueKey('link-confirm'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s.linkConfirmTitle(q.name), key: const ValueKey('link-confirm-title'), style: text.titleLarge),
          const SizedBox(height: 12),
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(s.linkFingerprint, style: text.bodySmall),
                  const SizedBox(height: 4),
                  LtrText(q.fingerprintGroups, key: const ValueKey('link-confirm-fp'), style: text.titleMedium),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(s.linkConfirmBody, style: text.bodyMedium),
          if (err != null && !_quietCodes.contains(err)) ...[
            const SizedBox(height: 12),
            if (err == 'kept_data') KeptDataNotice(until: state.errorUntil) else ErrorLine(linkErrorText(s, err, state.errorUntil, appLangOf(context))),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('link-confirm-rescan'),
                  onPressed: state.busy ? null : ctl.rescan,
                  child: Text(s.linkRescan),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('link-confirm-go'),
                  onPressed: state.busy ? null : _confirm,
                  child: Text(s.actionContinue),
                ),
              ),
            ],
          ),
        ],
      );
    }
    final deps = ref.watch(appDepsProvider);
    final err = state.error;
    return Column(
      key: const ValueKey('link-scan'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.linkScanHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 16),
        if (deps.cameraAvailable)
          SizedBox(
            height: 320,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              child: (deps.scannerBuilder ?? defaultScanner)(context, ctl.onScanned, () {}),
            ),
          )
        else ...[
          TextField(
            key: const ValueKey('link-scan-paste'),
            controller: _paste,
            decoration: InputDecoration(labelText: s.linkScanPasteLabel),
            onSubmitted: ctl.onScanned,
          ),
          const SizedBox(height: 12),
          FilledButton(
            key: const ValueKey('link-scan-paste-go'),
            onPressed: () => ctl.onScanned(_paste.text),
            child: Text(s.actionContinue),
          ),
        ],
        if (err == 'bad_qr') ...[
          const SizedBox(height: 12),
          ErrorLine(s.linkCodeBadQr),
        ],
        const SizedBox(height: 16),
        OutlinedButton(
          key: const ValueKey('link-scan-cancel'),
          onPressed: ctl.endScan,
          child: Text(s.actionCancel),
        ),
      ],
    );
  }
}

// ---- waiting for the scan (this box shows the QR) ----

class _WaitingView extends ConsumerWidget {
  const _WaitingView({required this.session});

  final LinkSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ctl = ref.read(linkControllerProvider.notifier);
    final busy = ref.watch(linkControllerProvider.select((x) => x.busy));
    final now = ref.watch(appDepsProvider).now;
    return Column(
      key: const ValueKey('link-waiting'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.qr_code_2_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(s.linkWaitTitle(session.own.name), textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 8),
        Text(s.linkWaitBody, textAlign: TextAlign.center, style: text.bodyLarge),
        const SizedBox(height: 20),
        _Countdown(expiresAt: session.expiresAt, now: now, total: const Duration(minutes: 5), builder: s.linkWaitExpires),
        const SizedBox(height: 20),
        for (final line in [s.linkWaitFact1, s.linkWaitFact2, s.linkWaitFact3])
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.check_rounded, size: 20, color: SurauColors.success),
                const SizedBox(width: 10),
                Expanded(child: Text(line, style: text.bodyMedium)),
              ],
            ),
          ),
        const SizedBox(height: 20),
        OutlinedButton(
          key: const ValueKey('link-wait-close'),
          onPressed: busy ? null : ctl.cancel,
          child: Text(s.linkWaitClose),
        ),
      ],
    );
  }
}

/// "Kod tamat dalam 4:52" with a bar, ticking once a second.
class _Countdown extends StatefulWidget {
  const _Countdown({required this.expiresAt, required this.now, required this.total, required this.builder});

  final DateTime expiresAt;
  final DateTime Function() now;
  final Duration total;
  final String Function(String time) builder;

  @override
  State<_Countdown> createState() => _CountdownState();
}

class _CountdownState extends State<_Countdown> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final left = widget.expiresAt.difference(widget.now());
    final frac = (left.inMilliseconds / widget.total.inMilliseconds).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          widget.builder(linkCountdown(left)),
          key: const ValueKey('link-countdown'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(value: frac, minHeight: 8),
        ),
      ],
    );
  }
}

// ---- calling ----

class _CallingView extends StatelessWidget {
  const _CallingView({required this.session});

  final LinkSession session;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      key: const ValueKey('link-calling'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Center(child: SizedBox(width: 36, height: 36, child: CircularProgressIndicator(strokeWidth: 3))),
        const SizedBox(height: 16),
        Text(s.linkCalling, textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 6),
        Text(s.linkCallingBody, textAlign: TextAlign.center, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
      ],
    );
  }
}

// ---- code ----

class _CodeHost extends ConsumerWidget {
  const _CodeHost({required this.state});

  final LinkState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = state.status!.session!;
    final ctl = ref.read(linkControllerProvider.notifier);
    final now = ref.watch(appDepsProvider).now;
    return _Ticking(
      builder: () => LinkCodeView(
        session: session,
        busy: state.busy,
        onApprove: ctl.approve,
        onCancel: ctl.cancel,
        remaining: session.expiresAt.difference(now()),
      ),
    );
  }
}

/// Rebuilds [builder] once a second (the countdown of the code).
class _Ticking extends StatefulWidget {
  const _Ticking({required this.builder});

  final Widget Function() builder;

  @override
  State<_Ticking> createState() => _TickingState();
}

class _TickingState extends State<_Ticking> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder();
}

// ---- questions ----

class _QuestionsHost extends ConsumerWidget {
  const _QuestionsHost({required this.state});

  final LinkState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final st = state.status!;
    final session = st.session!;
    final ctl = ref.read(linkControllerProvider.notifier);
    final deps = ref.watch(appDepsProvider);
    final err = state.error;

    Future<void> agree() async {
      final needPin = await ctl.agree();
      if (!needPin || !context.mounted) return;
      await showLinkPinSheet(
        context,
        body: s.linkPinBodyAgree,
        action: s.linkApprove,
        submit: ctl.agreeWithPin,
      );
    }

    return LinkQuestionsView(
      session: session,
      caseX: st.checks.caseX,
      nowLocal: deps.toLocal(deps.now()),
      lang: appLangOf(context),
      busy: state.busy,
      staleNotice: state.staleNotice,
      error: err != null && !_quietCodes.contains(err) ? err : null,
      onKeep: ctl.chooseKeep,
      onMaster: ctl.chooseMaster,
      onTick: ctl.setFinanceTick,
      onAgree: agree,
      onRole: ctl.chooseRole,
      onSame: ctl.setSame,
      onPhones: ctl.choosePhones,
    );
  }
}

// ---- progress ----

/// "Langkah 2 daripada 4: memindahkan data, 62%", with a bar. Both boxes show the same steps.
class LinkProgressView extends StatelessWidget {
  const LinkProgressView({super.key, required this.progress, required this.session});

  final LinkProgress? progress;
  final LinkSession? session;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final p = progress;
    final line = p == null
        ? s.linkProgressStarting
        : p.percent == null
        ? s.linkProgressStep(p.stepNo, p.steps, linkStepName(s, p.step))
        : s.linkProgressStepPercent(p.stepNo, p.steps, linkStepName(s, p.step), p.percent!);
    final value = p == null ? 0.0 : (p.percent != null ? p.percent! / 100 : (p.stepNo - 1) / p.steps).clamp(0.0, 1.0);
    return Column(
      key: const ValueKey('link-progress'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.sync_rounded, size: 44, color: SurauColors.teal),
        const SizedBox(height: 12),
        Text(s.linkProgressTitle, textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 16),
        Text(line, key: const ValueKey('link-progress-step'), textAlign: TextAlign.center, style: text.titleMedium),
        const SizedBox(height: 12),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(key: const ValueKey('link-progress-bar'), value: value, minHeight: 10),
        ),
        const SizedBox(height: 20),
        LinkNote(tone: LinkTone.gold, icon: Icons.power_settings_new_rounded, text: s.linkProgressNote),
      ],
    );
  }
}

// ---- result ----

class _DoneView extends ConsumerWidget {
  const _DoneView({required this.state});

  final LinkState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ctl = ref.read(linkControllerProvider.notifier);
    final code = state.recoveryCode;
    if (code != null) {
      // Case X or N-X: this box has a new recovery code. The box gave it once; it is shown, never kept.
      return RecoveryCodeView(key: const ValueKey('link-recovery'), code: code, title: s.linkRecoveryTitle, onContinue: ctl.ackRecoveryCode);
    }
    final last = state.status!.last!;
    if (!last.linked) {
      return Column(
        key: const ValueKey('link-failed'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Icon(Icons.link_off_rounded, size: 44, color: SurauColors.danger),
          const SizedBox(height: 12),
          Text(s.linkFailedTitle, textAlign: TextAlign.center, style: text.titleLarge),
          const SizedBox(height: 12),
          ErrorLine(linkOutcomeText(s, last.outcome)),
          const SizedBox(height: 20),
          FilledButton(key: const ValueKey('link-done-close'), onPressed: ctl.dismissResult, child: Text(s.linkDoneClose)),
        ],
      );
    }
    final recent = state.recent;
    final a = recent != null && recent.answers != null ? recent : null;
    String? masterLine;
    if (a != null) {
      final master = a.face(a.answers!.master);
      final other = a.face(a.answers!.master.other);
      if (master != null && other != null) masterLine = s.linkDoneMaster(master.name, other.name);
    }
    return Column(
      key: const ValueKey('link-done'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DoneLine(s.linkDoneTitle, detail: masterLine ?? s.linkDoneBody),
        const SizedBox(height: 16),
        LinkNote(tone: LinkTone.gold, icon: Icons.shield_outlined, text: s.linkDoneBackup),
        const SizedBox(height: 10),
        LinkNote(tone: LinkTone.grey, icon: Icons.groups_outlined, text: s.linkDoneNext),
        const SizedBox(height: 20),
        FilledButton(
          key: const ValueKey('link-done-list'),
          onPressed: () {
            ctl.dismissResult();
            context.go(AppRoutes.screens);
          },
          child: Text(s.linkDoneList),
        ),
        const SizedBox(height: 8),
        TextButton(key: const ValueKey('link-done-close'), onPressed: ctl.dismissResult, child: Text(s.linkDoneClose)),
      ],
    );
  }
}

// ---- stop ----

class _StopView extends ConsumerWidget {
  const _StopView({required this.stop});

  final LinkStop stop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ctl = ref.read(linkControllerProvider.notifier);
    // Which box is behind: this phone's own (the scanning one), the shown one (named in the QR), or not said.
    final (name, release) = switch (stop.behind) {
      LinkSide.scan => (stop.ownName, stop.ownRelease),
      LinkSide.show => (stop.peerName, null),
      null => (null, null),
    };
    final sentence = name == null
        ? s.linkStopOlderUnnamed
        : release != null && stop.code == 'version'
        ? s.linkStopVersion(name, release)
        : s.linkStopOlder(name);
    return Column(
      key: const ValueKey('link-stop'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.system_update_alt_rounded, size: 44, color: SurauColors.gold),
        const SizedBox(height: 12),
        Text(s.linkStopTitle, textAlign: TextAlign.center, style: text.titleLarge),
        const SizedBox(height: 12),
        Text(sentence, key: const ValueKey('link-stop-text'), textAlign: TextAlign.center, style: text.bodyLarge),
        const SizedBox(height: 12),
        LinkNote(tone: LinkTone.grey, icon: Icons.info_outline_rounded, text: s.linkStopNothingChanged),
        const SizedBox(height: 20),
        FilledButton(key: const ValueKey('link-stop-close'), onPressed: ctl.dismissStop, child: Text(s.actionClose)),
      ],
    );
  }
}
