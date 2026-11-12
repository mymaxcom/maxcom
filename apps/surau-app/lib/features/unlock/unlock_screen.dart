// The daily front door, on the kiosk's deep teal glass: the surau's name,
// "Assalamualaikum, <name>", six dots and a pad. The sixth digit submits;
// there is no button to find. Every box answer is explained in one line
// under the dots. When a person is stuck (locked out, box away, device
// revoked) the surau's helper appears right there with a call button, and
// "Lupa PIN?" opens the same help at any time. The box address and the
// certificate live behind "Butiran teknikal" in that sheet.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../box/locator.dart' show CloudWaking;
import '../../l10n/generated/s.dart';
import '../../sync/sync_providers.dart' show revokedProvider;
import '../common/contact_links.dart';
import '../common/help_card.dart';
import '../common/identity.dart';
import '../common/roles.dart';
import '../common/surau_info.dart';
import '../common/surau_logo.dart';
import '../common/time_words.dart';
import '../enrol/enrol_flow.dart';
import '../enrol/pin_policy.dart';
import 'offline_vault.dart';
import 'pin_pad.dart';
import 'session.dart';
import 'session_keeper.dart' show unlockNoticeProvider;
import 'unlock_flow.dart';

/// The way into the app without the box or the cloud, for a phone that has
/// unlocked online before: [profile] is the person kept then, [checkPin]
/// checks a PIN against the local verifier, and [enter] opens the app in
/// the offline session (with the online unlock still under way, if any,
/// for the reconnector to finish).
class OfflineDoor {
  const OfflineDoor({
    required this.profile,
    required this.checkPin,
    required this.enter,
    this.grace = const Duration(seconds: 3),
  });

  final Future<OfflineProfile?> Function() profile;
  final Future<PinCheck> Function(String pin) checkPin;
  final void Function(
    OfflineProfile profile, {
    String? pin,
    Future<SessionDto>? inFlight,
  })
  enter;

  /// How long the box and the cloud get before the app opens offline.
  final Duration grace;
}

enum _Step { pin, newPin, confirmNewPin }

enum _Tone { quiet, error }

/// Why the pad cannot help right now; each shows the help card.
enum _Stuck { none, locked, unreachable, enrolAgain }

class UnlockScreen extends ConsumerStatefulWidget {
  const UnlockScreen({
    super.key,
    required this.flow,
    required this.box,
    required this.onUnlocked,
    required this.onEnrolAgain,
    this.surauInfo,
    this.offline,
    this.sealPinAfterUnlock = false,
    this.openUrl = launchOutside,
    this.now = DateTime.now,
    this.toLocal = _toLocal,
  });

  final UnlockFlow flow;
  final EnrolledBox box;
  final void Function(SessionDto session) onUnlocked;
  final VoidCallback onEnrolAgain;

  /// The surau's name and helper: the cached copy shows at once, then the
  /// box is asked for a fresh one (public route, no token). Null shows the
  /// product name and a help card without a contact.
  final SurauInfoLoader? surauInfo;

  /// Null: the app needs the box or the cloud to open (never unlocked
  /// online on this phone, or no local store).
  final OfflineDoor? offline;

  /// Set by Settings > Peranti ini when the user turned biometrics on: the
  /// next accepted PIN is sealed for the fingerprint key.
  final bool sealPinAfterUnlock;

  final UrlOpener openUrl;

  /// Clock and zone, injectable so goldens are stable.
  final DateTime Function() now;
  final DateTime Function(DateTime) toLocal;

  static DateTime _toLocal(DateTime t) => t.toLocal();

  @override
  ConsumerState<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends ConsumerState<UnlockScreen> {
  _Step _step = _Step.pin;
  String _typed = '';
  String? _firstNewPin;
  bool _busy = false;
  bool _biometricReady = false;
  int _shake = 0;

  /// Wrong PINs in a row; from the second the help contact is shown, so a
  /// person who does not know the PIN is not left with a bare error.
  int _wrong = 0;
  SurauInfo? _info;

  /// The surau logo (public route, through the loader's pinned client);
  /// fetched once per logo path, absent until then or without one.
  Uint8List? _logo;
  String? _logoPath;

  /// The box's own wording or null; shown under the dots.
  String? _status;
  String? _subline;
  _Tone _tone = _Tone.quiet;
  _Stuck _stuck = _Stuck.none;

  /// Lockout end; the pad is dim until then (checked on every tap).
  DateTime? _lockedUntil;

  /// The box's app lock was off when this screen opened: no pad, the device
  /// key alone opens MAXCOM. [_startedOff] stays for the whole visit (it
  /// words the hint if an admin has turned the lock on meanwhile); [_auto]
  /// ends when the box wants a PIN after all.
  late final bool _startedOff = widget.box.appLock == false && !widget.box.roles.contains('superadmin');
  bool _auto = false;
  bool _autoBusy = false;
  String? _autoError;

  /// The cloud answered `waking`: progress, never an error.
  bool _waking = false;

  /// The next automatic try (every 10 s while nothing answers, or after the
  /// cloud's `Retry-After`).
  Timer? _retryTimer;

  /// Bumped by every attempt; an answer for an older one is dropped.
  int _gen = 0;

  /// The app has been opened in the offline session from here.
  bool _left = false;

  static const Duration _retryEvery = Duration(seconds: 10);
  static const Duration _wakeCap = Duration(seconds: 90);

  static Duration _wakeDelay(CloudWaking w) {
    final secs = w.retryAfterSec ?? 10;
    final d = Duration(seconds: secs < 1 ? 1 : secs);
    return d > _wakeCap ? _wakeCap : d;
  }

  void _retryIn(Duration d, VoidCallback again) {
    _retryTimer?.cancel();
    _retryTimer = Timer(d, () {
      _retryTimer = null;
      if (mounted && !_left) again();
    });
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    super.dispose();
  }

  /// Opens the app offline when this phone has a kept profile. False when
  /// it has none (the screen carries on as before).
  Future<bool> _goOffline({Future<SessionDto>? inFlight, String? pin}) async {
    final door = widget.offline;
    if (door == null || _left) return false;
    final OfflineProfile? profile;
    try {
      profile = await door.profile();
    } on Object {
      return false;
    }
    if (profile == null || !mounted || _left) return false;
    _left = true;
    _retryTimer?.cancel();
    door.enter(profile, pin: pin, inFlight: inFlight);
    return true;
  }

  /// PIN mode, nothing answered: the PIN against the local verifier. True
  /// when that decided (in, wrong, locked); false without a verifier.
  Future<bool> _offlinePin(
    String pin,
    int gen, {
    Future<SessionDto>? inFlight,
  }) async {
    final door = widget.offline;
    if (door == null || _left) return false;
    final OfflineProfile? profile;
    final PinCheck check;
    try {
      profile = await door.profile();
      if (profile == null) return false;
      check = await door.checkPin(pin);
    } on Object {
      return false;
    }
    if (!mounted || _left) return true;
    if (gen != _gen) return true;
    final s = S.of(context);
    switch (check) {
      case PinOk():
        _left = true;
        _retryTimer?.cancel();
        door.enter(profile, pin: pin, inFlight: inFlight);
      case PinWrong(:final left):
        _gen++;
        setState(() {
          _busy = false;
          _typed = '';
          _shake++;
          _wrong++;
          _stuck = _Stuck.none;
          _say(s.offlinePinWrong(left), tone: _Tone.error);
        });
      case PinLocked(:final until):
        _gen++;
        setState(() {
          _busy = false;
          _typed = '';
          _lockedUntil = until;
          _stuck = _Stuck.locked;
          _say(
            s.unlockLockedTitle,
            subline: s.unlockLockedUntil(timeOfDayWords(widget.toLocal(until))),
            tone: _Tone.error,
          );
        });
      case PinUnknown():
        return false;
    }
    return true;
  }

  @override
  void initState() {
    super.initState();
    // Revoked by the server during a sync (Plan 6): the store is already
    // wiped; say so and offer only the way back (enrol again).
    final revoked = ref.read(revokedProvider);
    _auto = _startedOff && !revoked;
    if (revoked) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final s = S.of(context);
        setState(() {
          _stuck = _Stuck.enrolAgain;
          _say(
            s.syncDeviceRevoked,
            subline: s.syncDeviceRevokedHint,
            tone: _Tone.error,
          );
        });
      });
    }
    // A silent reconnect was refused by the server (PIN changed, lock
    // turned on, account closed): its words, once, and the pad.
    final notice = ref.read(unlockNoticeProvider);
    if (notice != null && !revoked) {
      _auto = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.read(unlockNoticeProvider.notifier).clear();
        setState(() => _say(notice, tone: _Tone.error));
      });
    }
    if (_auto) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _autoUnlock();
      });
    }
    widget.flow.canUseBiometric().then((ok) {
      if (mounted && ok) setState(() => _biometricReady = true);
    });
    final loader = widget.surauInfo;
    if (loader != null) {
      loader.cached().then(_takeInfo);
      loader.refresh().then(_takeInfo);
    }
  }

  void _takeInfo(SurauInfo? info) {
    if (!mounted || info == null) return;
    setState(() => _info = info);
    final path = info.logo;
    final loader = widget.surauInfo;
    if (path == null || path == _logoPath || loader == null) return;
    _logoPath = path;
    fetchSurauLogo(loader.servedBy, path).then((bytes) {
      if (!mounted || bytes == null || _logoPath != path) return;
      setState(() => _logo = bytes);
    });
  }

  String _surauName(S s) => _info?.name ?? s.productName;

  bool get _locked {
    final until = _lockedUntil;
    if (until == null) return false;
    if (widget.now().isBefore(until)) return true;
    _lockedUntil = null;
    if (_stuck == _Stuck.locked) {
      _stuck = _Stuck.none;
      _say(null);
    }
    return false;
  }

  void _say(String? text, {String? subline, _Tone tone = _Tone.quiet}) {
    _status = text;
    _subline = subline;
    _tone = tone;
  }

  void _onDigit(String d) {
    if (_busy || _locked || _typed.length >= pinLength) return;
    // The person types again: their new PIN replaces the automatic retry.
    _retryTimer?.cancel();
    _retryTimer = null;
    setState(() {
      _typed += d;
      if (_stuck == _Stuck.unreachable) _stuck = _Stuck.none;
      if (_waking) {
        _waking = false;
        _say(null);
      }
      if (_tone == _Tone.error) _say(null);
    });
    if (_typed.length == pinLength) _submit();
  }

  void _onBackspace() {
    if (_busy || _locked || _typed.isEmpty) return;
    setState(() => _typed = _typed.substring(0, _typed.length - 1));
  }

  Future<void> _submit() async {
    final s = S.of(context);
    final entered = _typed;
    switch (_step) {
      case _Step.pin:
        await _unlock(
          () =>
              widget.flow.run(pin: entered, sealPin: widget.sealPinAfterUnlock),
          offlinePin: entered,
        );
      case _Step.newPin:
        if (!isValidPin(entered)) {
          setState(() {
            _typed = '';
            _shake++;
            _say(s.pinTooWeak, tone: _Tone.error);
          });
          return;
        }
        setState(() {
          _firstNewPin = entered;
          _typed = '';
          _step = _Step.confirmNewPin;
          _say(null);
        });
      case _Step.confirmNewPin:
        if (entered != _firstNewPin) {
          setState(() {
            _typed = '';
            _firstNewPin = null;
            _step = _Step.newPin;
            _shake++;
            _say(s.pinMismatch, tone: _Tone.error);
          });
          return;
        }
        await _unlock(
          () => widget.flow.run(
            newPin: entered,
            sealPin: widget.sealPinAfterUnlock,
          ),
        );
    }
  }

  /// Lock off: prove the device (signed challenge) and open, no PIN. With
  /// an [OfflineDoor] and a kept profile, the app opens offline when
  /// neither the box nor the cloud has answered within its grace; without
  /// one, the screen tries again by itself (every 10 s, or after the
  /// cloud's `Retry-After` while it wakes).
  Future<void> _autoUnlock() async {
    if (_left) return;
    final s = S.of(context);
    _retryTimer?.cancel();
    _retryTimer = null;
    final gen = ++_gen;
    setState(() {
      _autoBusy = true;
      _autoError = null;
    });
    final attempt = widget.flow.run(noPin: true);
    final door = widget.offline;
    final grace = door == null
        ? null
        : Timer(door.grace, () {
            if (gen == _gen && mounted) _goOffline(inFlight: attempt);
          });
    bool stale() => !mounted || gen != _gen || _left;
    try {
      final session = await attempt;
      grace?.cancel();
      if (stale()) return;
      ref.read(sessionProvider.notifier).set(session);
      setState(() {
        _autoBusy = false;
        _waking = false;
      });
      widget.onUnlocked(session);
    } on UnlockFailure catch (e) {
      grace?.cancel();
      if (stale()) return;
      setState(() {
        _waking = false;
        _autoBusy = false;
        switch (e) {
          case UnlockPinMissing() ||
              UnlockPinRequired() ||
              UnlockRevoked() ||
              UnlockNoKey():
            // The box wants a PIN now, or will not take this device: the
            // ordinary views say so.
            _auto = false;
            _explain(e, s);
          case UnlockNotVerified():
            _autoError = s.unlockNotVerified;
          default:
            _autoError = e.message;
        }
      });
    } on CloudWaking catch (w) {
      grace?.cancel();
      if (stale() || await _goOffline() || stale()) return;
      setState(() {
        _autoBusy = false;
        _waking = true;
        _autoError = null;
      });
      _retryIn(_wakeDelay(w), _autoUnlock);
    } on BoxUnreachable {
      grace?.cancel();
      if (stale() || await _goOffline() || stale()) return;
      setState(() {
        _autoBusy = false;
        _waking = false;
        _autoError = s.unlockAutoUnreachable;
      });
      _retryIn(_retryEvery, _autoUnlock);
    } on BoxError catch (e) {
      grace?.cancel();
      if (stale() || await _goOffline() || stale()) return;
      setState(() {
        _autoBusy = false;
        _waking = false;
        _autoError = e.message;
      });
      _retryIn(_retryEvery, _autoUnlock);
    }
  }

  Future<void> _useBiometric() async {
    await _unlock(widget.flow.runWithBiometric, biometric: true);
  }

  /// One unlock with the pad (or the fingerprint). With an [OfflineDoor],
  /// when neither base has answered within its grace (or both said no) the
  /// PIN is checked against the local verifier and the app opens offline.
  /// Without a verifier the screen keeps today's views, but retries the
  /// same PIN by itself (every 10 s, or after the cloud's `Retry-After`)
  /// until the person types again or taps `Cuba lagi`.
  Future<void> _unlock(
    Future<SessionDto> Function() attempt, {
    bool biometric = false,
    String? offlinePin,
  }) async {
    if (_left) return;
    final s = S.of(context);
    _retryTimer?.cancel();
    _retryTimer = null;
    final gen = ++_gen;
    setState(() {
      _busy = true;
      _stuck = _Stuck.none;
      _waking = false;
      _say(biometric ? s.biometricChecking : s.unlockChecking);
    });
    final run = attempt();
    final door = widget.offline;
    final grace = door == null || offlinePin == null
        ? null
        : Timer(door.grace, () {
            if (gen == _gen && mounted && !_left) {
              _offlinePin(offlinePin, gen, inFlight: run);
            }
          });
    bool stale() => !mounted || gen != _gen || _left;
    void again() =>
        _unlock(attempt, biometric: biometric, offlinePin: offlinePin);
    Future<bool> offline() async =>
        offlinePin != null && await _offlinePin(offlinePin, gen);
    try {
      final session = await run;
      grace?.cancel();
      if (stale()) return;
      ref.read(sessionProvider.notifier).set(session);
      setState(() {
        _busy = false;
        _wrong = 0;
        _typed = '';
        _say(null);
      });
      widget.onUnlocked(session);
    } on UnlockFailure catch (e) {
      grace?.cancel();
      if (stale()) return;
      setState(() {
        _busy = false;
        _typed = '';
        _explain(e, s);
      });
    } on CloudWaking catch (w) {
      grace?.cancel();
      if (stale() || await offline() || stale()) return;
      setState(() {
        _busy = false;
        _typed = '';
        _waking = true;
        _say(s.unlockCloudWaking);
      });
      _retryIn(_wakeDelay(w), again);
    } on BoxUnreachable {
      grace?.cancel();
      if (stale() || await offline() || stale()) return;
      setState(() {
        _busy = false;
        _typed = '';
        _stuck = _Stuck.unreachable;
        _say(
          s.errorUnreachableNamed(_surauName(s)),
          subline: s.errorUnreachableHint,
          tone: _Tone.error,
        );
      });
      _retryIn(_retryEvery, again);
    } on BoxError catch (e) {
      grace?.cancel();
      if (stale() || await offline() || stale()) return;
      setState(() {
        _busy = false;
        _typed = '';
        _stuck = _Stuck.unreachable;
        _say(e.message, tone: _Tone.error);
      });
      _retryIn(_retryEvery, again);
    }
  }

  void _explain(UnlockFailure e, S s) {
    switch (e) {
      case UnlockWrongPin():
        _shake++;
        _wrong++;
        _say(e.message, tone: _Tone.error);
      case UnlockLocked():
        final secs = e.retryAfterSec ?? 15 * 60;
        final until = widget.now().add(Duration(seconds: secs));
        _lockedUntil = until;
        _stuck = _Stuck.locked;
        _say(
          s.unlockLockedTitle,
          subline: s.unlockLockedUntil(timeOfDayWords(widget.toLocal(until))),
          tone: _Tone.error,
        );
      case UnlockPinMissing():
        _step = _Step.pin;
        _typed = '';
        _say(s.unlockPinMissing);
      case UnlockPinRequired():
        _step = _Step.newPin;
        _firstNewPin = null;
        _biometricReady = false;
        _say(null);
      case UnlockPinExists():
        _step = _Step.pin;
        _firstNewPin = null;
        _say(e.message, tone: _Tone.error);
      case UnlockPinTooWeak():
        _step = _Step.newPin;
        _firstNewPin = null;
        _shake++;
        _say(s.pinTooWeak, tone: _Tone.error);
      case UnlockRevoked():
        _stuck = _Stuck.enrolAgain;
        _say(e.message, subline: s.unlockRevokedHint, tone: _Tone.error);
      case UnlockNoKey():
        _stuck = _Stuck.enrolAgain;
        _say(
          s.errorDeviceKeyMissing,
          subline: s.unlockNoKeyHint,
          tone: _Tone.error,
        );
      case UnlockNotVerified():
        _say(s.unlockNotVerified, tone: _Tone.error);
      case UnlockBiometricFailed(:final reason):
        switch (reason) {
          case BiometricFailure.cancelled:
            // The person chose the PIN pad: nothing to say.
            _say(null);
          case BiometricFailure.lockedOut:
            _say(s.biometricLocked, tone: _Tone.error);
          case BiometricFailure.notRecognised:
            _say(s.biometricFailed, tone: _Tone.error);
        }
    }
  }

  void _retry() {
    _retryTimer?.cancel();
    _retryTimer = null;
    setState(() {
      _stuck = _Stuck.none;
      _say(null);
    });
  }

  Future<void> _showForgotPin() async {
    final s = S.of(context);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _ForgotPinSheet(
        box: widget.box,
        contact: _info?.help,
        openUrl: widget.openUrl,
        onClose: () => Navigator.of(context).pop(),
        closeLabel: s.actionClose,
      ),
    );
  }

  Future<void> _confirmNotYou() async {
    final s = S.of(context);
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.unlockNotYouTitle),
        content: Text(s.unlockNotYouBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.actionEnrolAgain),
          ),
        ],
      ),
    );
    if (yes == true && mounted) widget.onEnrolAgain();
  }

  /// The lock is off: who and where, a spinner and `Membuka kunci`; if the
  /// box cannot be reached, the reason and `Cuba lagi`.
  Widget _buildAuto(BuildContext context, S s) {
    final text = Theme.of(context).textTheme;
    final soft = Colors.white.withValues(alpha: 0.72);
    final error = _autoError;
    return Scaffold(
      backgroundColor: SurauColors.glass,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  SurauIdentity(
                    surauName: _surauName(s),
                    logo: _logo == null
                        ? null
                        : LogoImage(
                            bytes: _logo,
                            height: 72,
                            maxWidth: 300,
                            radius: 16,
                          ),
                    showName: _info?.showName ?? true,
                    greeting: s.greeting(widget.box.userName),
                    roles: rolesSentence(s, widget.box.roles),
                  ),
                  const SizedBox(height: 36),
                  if (error == null) ...[
                    const SizedBox(
                      width: 32,
                      height: 32,
                      child: CircularProgressIndicator(
                        key: ValueKey('unlock-auto-spinner'),
                        color: SurauColors.gold,
                        strokeWidth: 3,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      _waking ? s.unlockCloudWaking : s.unlockAuto,
                      textAlign: TextAlign.center,
                      style: text.bodyLarge!.copyWith(color: soft),
                    ),
                  ] else ...[
                    Text(
                      error,
                      textAlign: TextAlign.center,
                      style: text.bodyLarge!.copyWith(
                        color: _StatusLine._errorInk,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    // Not a dead end: the screen tries again by itself.
                    if (_retryTimer != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        s.unlockAutoRetrying,
                        textAlign: TextAlign.center,
                        style: text.bodyLarge!.copyWith(color: soft),
                      ),
                    ],
                    const SizedBox(height: 14),
                    _GlassButton(
                      label: s.actionRetry,
                      onPressed: _autoBusy ? () {} : _autoUnlock,
                    ),
                    const SizedBox(height: 16),
                    HelpCard(
                      contact: _info?.help,
                      onGlass: true,
                      openUrl: widget.openUrl,
                    ),
                  ],
                  const SizedBox(height: 20),
                  _GlassLink(label: s.unlockNotYou, onPressed: _confirmNotYou),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    if (_auto) return _buildAuto(context, s);
    final text = Theme.of(context).textTheme;
    final soft = Colors.white.withValues(alpha: 0.72);
    final locked = _locked;
    final stuck = _stuck;
    final showPad = stuck != _Stuck.enrolAgain;
    final padLive = showPad && !locked && !_busy;

    final String greeting;
    final String hint;
    switch (_step) {
      case _Step.pin:
        greeting = s.greeting(widget.box.userName);
        hint = s.unlockHint;
      case _Step.newPin:
        greeting = s.pinNewTitle;
        hint = _startedOff ? s.unlockPinRequiredByAdmin : s.pinNewHint;
      case _Step.confirmNewPin:
        greeting = s.pinConfirmTitle;
        hint = _startedOff ? s.unlockPinRequiredByAdmin : s.pinNewHint;
    }

    return Scaffold(
      backgroundColor: SurauColors.glass,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final roomy = constraints.maxHeight >= 860;
            return SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: 24,
                vertical: roomy ? 40 : 20,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: constraints.maxHeight - (roomy ? 80 : 40),
                  maxWidth: constraints.maxWidth,
                ),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 400),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        SurauIdentity(
                          surauName: _surauName(s),
                          logo: _logo == null
                              ? null
                              : LogoImage(
                                  bytes: _logo,
                                  height: 72,
                                  maxWidth: 300,
                                  radius: 16,
                                ),
                          showName: _info?.showName ?? true,
                          greeting: greeting,
                          roles: _step == _Step.pin
                              ? rolesSentence(s, widget.box.roles)
                              : null,
                        ),
                        SizedBox(height: roomy ? 28 : 20),
                        // No "enter your PIN" while the pad cannot take one.
                        if (stuck == _Stuck.none ||
                            stuck == _Stuck.unreachable) ...[
                          Text(
                            hint,
                            textAlign: TextAlign.center,
                            style: text.bodyLarge!.copyWith(color: soft),
                          ),
                          const SizedBox(height: 18),
                        ],
                        if (showPad) ...[
                          PinDots(filled: _typed.length, shake: _shake),
                          const SizedBox(height: 18),
                        ],
                        _StatusLine(
                          text: _status,
                          tone: _tone,
                          subline: _subline,
                        ),
                        if (stuck != _Stuck.none) ...[
                          const SizedBox(height: 10),
                          if (stuck == _Stuck.enrolAgain)
                            _GlassButton(
                              label: s.actionEnrolAgain,
                              onPressed: widget.onEnrolAgain,
                            ),
                          if (stuck == _Stuck.unreachable)
                            _GlassButton(
                              label: s.actionRetry,
                              onPressed: _retry,
                            ),
                          const SizedBox(height: 16),
                          HelpCard(
                            contact: _info?.help,
                            onGlass: true,
                            openUrl: widget.openUrl,
                          ),
                        ] else if (_wrong >= 2) ...[
                          const SizedBox(height: 16),
                          HelpCard(
                            contact: _info?.help,
                            onGlass: true,
                            openUrl: widget.openUrl,
                          ),
                        ],
                        if (showPad) ...[
                          SizedBox(
                            height: stuck == _Stuck.none
                                ? (roomy ? 20 : 12)
                                : 22,
                          ),
                          PinPad(
                            enabled: padLive,
                            onDigit: _onDigit,
                            onBackspace: _onBackspace,
                            backspaceLabel: s.pinDeleteDigit,
                            leading: _biometricReady && _step == _Step.pin
                                ? PinKey(
                                    accent: true,
                                    enabled: padLive,
                                    semanticsLabel: s.biometricUse,
                                    onTap: padLive ? _useBiometric : null,
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        const Icon(
                                          Icons.fingerprint,
                                          size: 30,
                                          color: SurauColors.gold,
                                        ),
                                        const SizedBox(height: 3),
                                        Text(
                                          s.biometricUse,
                                          textAlign: TextAlign.center,
                                          style: text.labelSmall!.copyWith(
                                            color: SurauColors.gold,
                                            fontSize: 11,
                                            height: 1.1,
                                          ),
                                        ),
                                      ],
                                    ),
                                  )
                                : null,
                          ),
                        ],
                        if (_step == _Step.pin) ...[
                          const SizedBox(height: 4),
                          _GlassLink(
                            label: s.unlockForgotPin,
                            onPressed: _showForgotPin,
                          ),
                          _GlassLink(
                            label: s.unlockNotYou,
                            onPressed: _confirmNotYou,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Two lines of fixed height under the dots so the pad never jumps when a
/// message appears: the box's answer, and (rarely) what to do next.
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.text, required this.tone, this.subline});

  final String? text;
  final _Tone tone;
  final String? subline;

  static const Color _errorInk = Color(0xFFFFC1B6);

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    final colour = tone == _Tone.error
        ? _errorInk
        : Colors.white.withValues(alpha: 0.72);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 160),
        child: Column(
          key: ValueKey('$text|$subline'),
          mainAxisSize: MainAxisSize.min,
          children: [
            if (text != null)
              Text(
                text!,
                textAlign: TextAlign.center,
                style: style.bodyLarge!.copyWith(
                  color: colour,
                  fontWeight: FontWeight.w600,
                ),
              ),
            if (subline != null) ...[
              const SizedBox(height: 4),
              Text(
                subline!,
                textAlign: TextAlign.center,
                style: style.bodyLarge!.copyWith(
                  color: Colors.white.withValues(alpha: 0.80),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// An outlined button that reads on the glass.
class _GlassButton extends StatelessWidget {
  const _GlassButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: SurauColors.gold,
        side: const BorderSide(color: SurauColors.goldHairline, width: 1.5),
        minimumSize: const Size(220, 52),
      ),
      child: Text(label),
    );
  }
}

/// A quiet text link under the pad, tall enough for a thumb.
class _GlassLink extends StatelessWidget {
  const _GlassLink({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: SurauColors.gold,
        minimumSize: const Size(220, 48),
        textStyle: Theme.of(context).textTheme.labelLarge!
            .copyWith(fontSize: 16),
      ),
      child: Text(label, textAlign: TextAlign.center),
    );
  }
}

/// "Lupa PIN?": what an admin can do, the help card, and the technical
/// details for anyone who needs them.
class _ForgotPinSheet extends StatelessWidget {
  const _ForgotPinSheet({
    required this.box,
    required this.contact,
    required this.openUrl,
    required this.onClose,
    required this.closeLabel,
  });

  final EnrolledBox box;
  final HelpContact? contact;
  final UrlOpener openUrl;
  final VoidCallback onClose;
  final String closeLabel;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    // Sized to its content (heightFactor), never the whole screen.
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(s.unlockForgotPin, style: text.headlineSmall),
                const SizedBox(height: 8),
                Text(s.unlockForgotPinBody, style: text.bodyLarge),
                const SizedBox(height: 18),
                HelpCard(contact: contact, openUrl: openUrl),
                const SizedBox(height: 12),
                TechnicalDetails(
                  boxAddress: box.box.toString(),
                  fingerprint: box.caFingerprint,
                ),
                const SizedBox(height: 18),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: onClose,
                    child: Text(closeLabel),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
