// The phone move as a person sees it: "Surau anda kini diurus dari MAXCOM Kiosk Box utama <name>. Sambung sekarang?",
// then a NEW PIN, then done. The refusals are worded in one calm line each: away from the surau Wi-Fi, no ticket (ask
// the admin of the main box for a join code), too many tries, a box that is not the one named. See move_flow.dart for
// the calls.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxUnreachable;
import '../../box/box_qr.dart' show ScannedKind, kindOf;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show ErrorLine, PinField;
import '../enrol/enrol_flow.dart' show EnrolledBox;
import '../enrol/pin_policy.dart';
import 'move_flow.dart';

enum MovePhase { checking, ask, pin, working, done, failed }

class MoveScreen extends StatefulWidget {
  const MoveScreen({
    super.key,
    required this.flow,
    required this.deviceName,
    required this.onAdopt,
    required this.onLater,
    required this.onJoinScan,
    required this.onJoinCode,
  });

  final MoveFlow flow;

  /// The name this phone gives itself at the main box.
  final String deviceName;

  /// The move is done and the new enrolment is saved: the app takes it as its box (and goes to the door).
  final void Function(EnrolledBox box) onAdopt;

  /// "Kemudian": leave the move alone for now.
  final VoidCallback onLater;

  /// "Imbas kod sertai": the phone leaves its old box and opens the ordinary enrolment scan (for the main box).
  final VoidCallback onJoinScan;

  /// A pasted join code (the full `surau1:` text): the phone leaves its old box and enrols with it.
  final void Function(String code) onJoinCode;

  @override
  State<MoveScreen> createState() => _MoveScreenState();
}

class _MoveScreenState extends State<MoveScreen> {
  MovePhase _phase = MovePhase.checking;
  MovePointer? _pointer;
  MoveFailure? _failure;
  String? _masterName;
  EnrolledBox? _adopted;
  String? _pinError;
  bool _pasting = false;
  String? _pasteError;
  final _paste = TextEditingController();
  final _pin = TextEditingController();
  final _again = TextEditingController();

  @override
  void initState() {
    super.initState();
    _check();
  }

  @override
  void dispose() {
    _pin.dispose();
    _again.dispose();
    _paste.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    setState(() {
      _phase = MovePhase.checking;
      _failure = null;
    });
    // The name only improves the "ask for a join code" sentence; it never holds the move up.
    final nameFuture = widget.flow.masterName();
    try {
      final p = await widget.flow.pointer();
      if (!mounted) return;
      setState(() {
        _pointer = p;
        _masterName = p.masterName;
        _phase = MovePhase.ask;
      });
    } on MoveFailure catch (e) {
      final name = await nameFuture;
      if (!mounted) return;
      setState(() {
        _failure = e;
        _masterName = name;
        _phase = MovePhase.failed;
      });
    } on BoxUnreachable {
      _fail(const MoveAway());
    } on Object {
      _fail(null);
    }
  }

  void _fail(MoveFailure? f) {
    if (!mounted) return;
    setState(() {
      _failure = f;
      _phase = MovePhase.failed;
    });
  }

  Future<void> _connect() async {
    final p = _pointer;
    if (p == null) return;
    final s = S.of(context);
    final pin = _pin.text;
    if (!isValidPin(pin)) {
      setState(() => _pinError = s.pinTooWeak);
      return;
    }
    if (pin != _again.text) {
      setState(() => _pinError = s.pinMismatch);
      return;
    }
    setState(() {
      _pinError = null;
      _phase = MovePhase.working;
    });
    try {
      final out = await widget.flow.connect(p, newPin: pin, deviceName: widget.deviceName);
      if (!mounted) return;
      setState(() {
        _adopted = out.box;
        _phase = MovePhase.done;
      });
    } on MovePinTooWeak {
      if (mounted) {
        setState(() {
          _pinError = s.pinTooWeak;
          _phase = MovePhase.pin;
        });
      }
    } on MoveFailure catch (e) {
      _fail(e);
    } on BoxUnreachable {
      _fail(const MoveAway());
    } on Object {
      _fail(null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final master = _masterName ?? '';
    final Widget body = switch (_phase) {
      MovePhase.checking => _Waiting(key: const ValueKey('move-checking'), text: s.moveChecking),
      MovePhase.working => _Waiting(key: const ValueKey('move-working'), text: s.moveWorking(master)),
      MovePhase.ask => _Panel(
        key: const ValueKey('move-ask'),
        icon: Icons.link_rounded,
        title: s.moveAskTitle(master),
        body: s.moveAskBody,
        children: [
          FilledButton(
            key: const ValueKey('move-connect'),
            onPressed: () => setState(() => _phase = MovePhase.pin),
            child: Text(s.moveConnect),
          ),
          const SizedBox(height: 8),
          TextButton(key: const ValueKey('move-later'), onPressed: widget.onLater, child: Text(s.moveLater)),
        ],
      ),
      MovePhase.pin => _Panel(
        key: const ValueKey('move-pin-panel'),
        icon: Icons.lock_outline_rounded,
        title: s.pinNewTitle,
        body: s.movePinBody(master),
        children: [
          PinField(controller: _pin, label: s.enrolPinNewHint, autofocus: true, onChanged: (_) => _clearPinError()),
          const SizedBox(height: 12),
          PinField(controller: _again, label: s.enrolPinAgainLabel, onChanged: (_) => _clearPinError()),
          const SizedBox(height: 6),
          Text(s.enrolPinCreateHint, style: text.bodySmall),
          if (_pinError != null) ...[const SizedBox(height: 10), ErrorLine(_pinError!)],
          const SizedBox(height: 16),
          FilledButton(
            key: const ValueKey('move-submit'),
            onPressed: _connect,
            child: Text(s.moveConnect),
          ),
        ],
      ),
      MovePhase.done => _Panel(
        key: const ValueKey('move-done'),
        icon: Icons.check_circle_outline_rounded,
        title: s.moveDone(master),
        children: [
          FilledButton(
            key: const ValueKey('move-continue'),
            onPressed: () => widget.onAdopt(_adopted!),
            child: Text(s.moveDoneButton),
          ),
        ],
      ),
      MovePhase.failed => _failedPanel(s),
    };
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: body),
          ),
        ),
      ),
    );
  }

  void _clearPinError() => setState(() => _pinError = null);

  /// Only an enrolment code (`surau1:`) is taken here; the enrol page then checks it and asks for the PIN as for any
  /// enrolment.
  void _submitPaste(S s) {
    final text = _paste.text.trim();
    if (kindOf(text) != ScannedKind.enrol) {
      setState(() => _pasteError = s.scanUnknown);
      return;
    }
    widget.onJoinCode(text);
  }

  Widget _failedPanel(S s) {
    final f = _failure;
    final retry = FilledButton(key: const ValueKey('move-retry'), onPressed: _check, child: Text(s.moveRetry));
    final later = TextButton(key: const ValueKey('move-later'), onPressed: widget.onLater, child: Text(s.moveLater));
    return switch (f) {
      MoveNeedCode() => _Panel(
        key: const ValueKey('move-needcode'),
        icon: Icons.vpn_key_outlined,
        title: s.moveNeedCodeTitle,
        body: _masterName == null || _masterName!.isEmpty ? s.moveNeedCodeNoName : s.moveNeedCode(_masterName!),
        children: [
          Text(s.moveJoinHint, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const ValueKey('move-join-scan'),
            onPressed: widget.onJoinScan,
            icon: const Icon(Icons.qr_code_scanner_rounded),
            label: Text(s.moveJoinScan),
          ),
          const SizedBox(height: 8),
          if (_pasting) ...[
            TextField(
              key: const ValueKey('move-join-field'),
              controller: _paste,
              minLines: 1,
              maxLines: 3,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(labelText: s.moveJoinCodeLabel),
              onChanged: (_) => setState(() => _pasteError = null),
              onSubmitted: (_) => _submitPaste(s),
            ),
            if (_pasteError != null) ...[const SizedBox(height: 8), ErrorLine(_pasteError!)],
            const SizedBox(height: 8),
            FilledButton(
              key: const ValueKey('move-join-submit'),
              onPressed: () => _submitPaste(s),
              child: Text(s.actionContinue),
            ),
          ] else
            OutlinedButton(
              key: const ValueKey('move-join-paste'),
              onPressed: () => setState(() => _pasting = true),
              child: Text(s.moveJoinPaste),
            ),
          const SizedBox(height: 8),
          later,
        ],
      ),
      MoveAway() => _Panel(
        key: const ValueKey('move-away'),
        icon: Icons.wifi_off_rounded,
        title: s.moveAway,
        children: [retry, const SizedBox(height: 8), later],
      ),
      MoveTooMany() => _Panel(
        key: const ValueKey('move-toomany'),
        icon: Icons.hourglass_empty_rounded,
        title: s.moveTooMany,
        children: [retry, const SizedBox(height: 8), later],
      ),
      MoveWrongBox() => _Panel(
        key: const ValueKey('move-wrongbox'),
        icon: Icons.report_gmailerrorred_rounded,
        title: s.moveWrongBox,
        children: [later],
      ),
      MoveBadPointer() || MoveNotFollower() || MovePinTooWeak() => _Panel(
        key: const ValueKey('move-badpointer'),
        icon: Icons.report_gmailerrorred_rounded,
        title: s.moveBadPointer,
        children: [retry, const SizedBox(height: 8), later],
      ),
      null => _Panel(
        key: const ValueKey('move-error'),
        icon: Icons.report_gmailerrorred_rounded,
        title: s.errorBoxUnreachable,
        children: [retry, const SizedBox(height: 8), later],
      ),
    };
  }
}

class _Waiting extends StatelessWidget {
  const _Waiting({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      const CircularProgressIndicator(),
      const SizedBox(height: 16),
      Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
    ],
  );
}

class _Panel extends StatelessWidget {
  const _Panel({super.key, required this.icon, required this.title, this.body, required this.children});

  final IconData icon;
  final String title;
  final String? body;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(icon, size: 44, color: SurauColors.teal),
        const SizedBox(height: 14),
        Text(title, key: const ValueKey('move-title'), textAlign: TextAlign.center, style: text.titleLarge),
        if (body != null) ...[
          const SizedBox(height: 10),
          Text(body!, key: const ValueKey('move-body'), textAlign: TextAlign.center, style: text.bodyLarge),
        ],
        const SizedBox(height: 22),
        ...children,
      ],
    );
  }
}
