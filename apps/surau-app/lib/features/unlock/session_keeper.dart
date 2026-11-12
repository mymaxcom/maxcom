// Keeps the person signed in without a trip to the unlock screen:
//
// * Offline session (no box, no cloud): every 15 s, backing off to 2 min,
//   and at once on app resume, when the box answers a health poll, or when
//   the sync engine finds a base but holds no token, it unlocks silently
//   (the device key; in PIN mode the PIN kept in memory for this run) at the
//   box, else the cloud. On success the real session replaces the offline
//   one, the sync engine starts, pushes the outbox and pulls.
// * Cloud session: the same loop probes the box alone; when it answers, the
//   app unlocks there silently and switches.
// * A 401 on a live session: one silent unlock before giving up.
//
// A server that refuses the person (revoked, PIN changed, lock turned on)
// ends it: the unlock screen opens with the server's own words. Runs only
// while the app is in front (the shell pauses and resumes it).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../../box/locator.dart';
import '../../store/local_store.dart';
import '../../sync/sync_providers.dart';
import '../../sync/transport.dart';
import 'offline_vault.dart';
import 'unlock_flow.dart';

enum _Mode { idle, offline, cloud }

/// A silent unlock is impossible: the app lock is on and no PIN was typed
/// in this run. The person unlocks on the screen as before.
class NeedsPin implements Exception {
  const NeedsPin();
}

class SessionKeeper {
  SessionKeeper({
    required this.attempt,
    required this.onConnected,
    required this.onRefused,
    required this.onUnavailable,
    Timer Function(Duration, void Function())? schedule,
    this.steps = const [
      Duration(seconds: 15),
      Duration(seconds: 30),
      Duration(minutes: 1),
      Duration(minutes: 2),
    ],
    this.wakeCap = const Duration(seconds: 90),
  }) : _schedule = schedule ?? ((d, f) => Timer(d, f));

  /// One silent unlock: at the box only ([boxOnly]), else wherever the
  /// locator finds a base.
  final Future<SessionDto> Function({required bool boxOnly}) attempt;
  final void Function(SessionDto session) onConnected;

  /// The server refused the person; [message] is its wording (null when
  /// nothing was asked: the PIN is needed and none is known).
  final void Function(String? message) onRefused;

  /// A live session ended (401) and no base answers.
  final Future<void> Function() onUnavailable;

  /// Waits between tries; the last repeats.
  final List<Duration> steps;

  /// Longest wait for a waking cloud's `Retry-After`.
  final Duration wakeCap;
  final Timer Function(Duration, void Function()) _schedule;

  _Mode _mode = _Mode.idle;
  SessionDto? _session;
  Timer? _timer;
  bool _busy = false;
  bool _paused = false;
  bool _dead = false;
  bool _recovering = false;
  int _failures = 0;

  /// For tests and the banner: a retry is waiting.
  bool get waiting => _timer?.isActive ?? false;
  bool get busy => _busy;

  /// The session changed: start, switch or stop the loop.
  void follow(SessionDto? session) {
    _session = session;
    final next = session == null
        ? _Mode.idle
        : session.offline
        ? _Mode.offline
        : session.via == SessionDto.viaCloud
        ? _Mode.cloud
        : _Mode.idle;
    if (next == _mode) return;
    _mode = next;
    _failures = 0;
    _timer?.cancel();
    _timer = null;
    if (next != _Mode.idle) _later(steps.first);
  }

  /// An unlock the unlock screen started before it let the person in
  /// offline: its session is used when it arrives.
  void adopt(Future<SessionDto> inFlight) {
    if (_busy || _dead) {
      inFlight.then((_) {}, onError: (Object _) {});
      return;
    }
    unawaited(_run(() => inFlight));
  }

  /// Try now (app resumed, the box answered, the banner's retry).
  void kick() {
    if (_dead || _paused || _mode == _Mode.idle || _busy) return;
    _timer?.cancel();
    _timer = null;
    unawaited(_run());
  }

  /// The app went to the background: no tries until [resume].
  void pause() {
    _paused = true;
    _timer?.cancel();
    _timer = null;
  }

  /// Back in front: try now when the app had been away.
  void resume() {
    if (!_paused) return;
    _paused = false;
    kick();
  }

  /// A request was refused with 401. Offline that only means a base
  /// answered (try now); on a live session one silent unlock is tried
  /// before the person is sent anywhere.
  Future<void> expired() async {
    final s = _session;
    if (s == null || _dead) return;
    if (s.offline) {
      kick();
      return;
    }
    if (_recovering) return;
    _recovering = true;
    try {
      final next = await attempt(boxOnly: false);
      if (!_dead && _session != null) onConnected(next);
    } on NeedsPin {
      if (!_dead && _session != null) onRefused(null);
    } on UnlockFailure catch (e) {
      if (_dead || _session == null) return;
      if (_transient(e)) {
        await onUnavailable();
      } else {
        onRefused(e.message);
      }
    } on Object {
      if (!_dead && _session != null) await onUnavailable();
    } finally {
      _recovering = false;
    }
  }

  void dispose() {
    _dead = true;
    _timer?.cancel();
  }

  static bool _transient(UnlockFailure e) =>
      e is UnlockNotVerified || e is UnlockBiometricFailed;

  void _later(Duration d) {
    if (_dead || _paused || _mode == _Mode.idle) return;
    _timer?.cancel();
    _timer = _schedule(d, () {
      _timer = null;
      unawaited(_run());
    });
  }

  void _backoff() {
    _failures++;
    final i = _failures < steps.length ? _failures : steps.length - 1;
    _later(steps[i]);
  }

  Future<void> _run([Future<SessionDto> Function()? source]) async {
    if (_busy || _dead) return;
    final mode = _mode;
    if (source == null && mode == _Mode.idle) return;
    _busy = true;
    try {
      final s = await (source ?? () => attempt(boxOnly: mode == _Mode.cloud))();
      if (_dead || _mode == _Mode.idle) return;
      _failures = 0;
      onConnected(s);
    } on NeedsPin {
      // Nothing to try with: stay as is until the person unlocks.
    } on UnlockFailure catch (e) {
      if (_dead || _mode == _Mode.idle) return;
      if (_transient(e)) {
        _backoff();
      } else {
        onRefused(e.message);
      }
    } on CloudWaking catch (w) {
      final secs = w.retryAfterSec ?? 15;
      final wait = Duration(seconds: secs < 1 ? 1 : secs);
      _later(wait > wakeCap ? wakeCap : wait);
    } on Object {
      _backoff();
    } finally {
      _busy = false;
    }
  }
}

// ---- wiring ----

/// The PIN the person typed in this run, for silent unlocks. Memory only;
/// forgotten whenever the session ends.
class PinMemory {
  String? value;

  void clear() => value = null;
}

final pinMemoryProvider = Provider<PinMemory>((ref) => PinMemory());

/// A refusal to show on the unlock screen (the server's words), set when a
/// silent unlock was refused; the screen shows it once and clears it.
class UnlockNoticeNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  void show(String message) => state = message;

  void clear() => state = null;
}

final unlockNoticeProvider = NotifierProvider<UnlockNoticeNotifier, String?>(
  UnlockNoticeNotifier.new,
);

/// The offline profile and PIN verifier of the enrolled box; null where the
/// app has no local store (older tests, a platform without one).
final offlineVaultProvider = FutureProvider<OfflineVault?>((ref) async {
  final LocalStore? store = await ref.watch(localStoreProvider.future);
  if (store == null) return null;
  return OfflineVault(store: store, now: ref.watch(appDepsProvider).now);
});

/// Loads the vault without keeping a dependency (callbacks, the keeper).
Future<OfflineVault?> readOfflineVault(Ref ref) async {
  try {
    return await ref.read(offlineVaultProvider.future);
  } on Object {
    return null;
  }
}

final sessionKeeperProvider = Provider<SessionKeeper>((ref) {
  final deps = ref.watch(appDepsProvider);

  Future<SessionDto> attempt({required bool boxOnly}) async {
    final box = ref.read(enrolledBoxProvider);
    if (box == null) throw const BoxUnreachable('tidak berdaftar');
    final BoxLocator? locator = boxOnly
        ? TimeoutLocator(
            DirectBoxLocator(
              clientFor: deps.enrolledClient,
              onHealth: (h) => unawaited(
                ref.read(enrolledBoxProvider.notifier).learnCloud(h.cloud),
              ),
            ),
            const Duration(seconds: 2),
          )
        : ref.read(baseLocatorProvider);
    if (locator == null) throw const BoxUnreachable('tiada pangkalan');
    final pin = ref.read(pinMemoryProvider).value;
    if (pin == null && ref.read(effectiveLockProvider)) throw const NeedsPin();
    final out = await unlockAtLocated(
      locator: locator,
      box: box,
      clientFor: (base) => deps.enrolledClient(boxAt(box, base)),
      key: deps.key,
      biometric: deps.biometric,
      tokens: ref.read(sessionTokensProvider),
      pin: pin,
      noPin: pin == null,
      onAppLock: (on) => ref.read(enrolledBoxProvider.notifier).setAppLock(on),
    );
    return out.session;
  }

  final keeper = SessionKeeper(
    attempt: attempt,
    onConnected: (s) {
      if (ref.mounted) ref.read(sessionProvider.notifier).set(s);
    },
    onRefused: (message) {
      if (!ref.mounted) return;
      if (message != null) {
        ref.read(unlockNoticeProvider.notifier).show(message);
      }
      ref.read(sessionProvider.notifier).clear();
    },
    onUnavailable: () async {
      final profile = await (await readOfflineVault(ref))?.profile();
      if (!ref.mounted) return;
      final sessions = ref.read(sessionProvider.notifier);
      if (profile == null) {
        sessions.clear();
      } else {
        sessions.set(SessionDto.offline(profile.user));
      }
    },
  );
  ref.onDispose(keeper.dispose);

  Future<void> remember(SessionDto s) async {
    final vault = await readOfflineVault(ref);
    if (vault == null || !ref.mounted) return;
    try {
      await vault.saveProfile(
        OfflineProfile(
          userId: s.user.id,
          name: s.user.name,
          roles: s.user.roles,
          at: deps.now(),
          surauName: ref.read(surauInfoProvider)?.name,
        ),
      );
      final pin = ref.read(pinMemoryProvider).value;
      if (pin != null) await vault.savePin(pin);
    } on Object {
      // the offline profile is a convenience; the online session stands
    }
  }

  ref.listen<SessionDto?>(sessionProvider, (previous, next) {
    keeper.follow(next);
    if (next == null) {
      ref.read(pinMemoryProvider).clear();
    } else if (!next.offline) {
      unawaited(remember(next));
    }
  }, fireImmediately: true);
  return keeper;
});
