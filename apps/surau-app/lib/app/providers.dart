// App-wide state: the enrolled box, the session (from the unlock feature),
// the surau's name, box reachability, the read cache, the gateway that
// every screen talks through, health and settings with their cached
// fallbacks, and the one-shot notice the shell shows as a snackbar.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../box/box_address.dart' show currentIpOrigin;
import '../box/box_client.dart';
import '../box/box_name.dart';
import '../box/cloud_origin.dart';
import '../features/common/surau_info.dart';
import '../features/enrol/enrol_flow.dart';
import '../features/settings_repository.dart' show loadSettings;
import '../features/shell/box_gateway.dart';
import '../features/shell/permissions.dart';
import '../features/shell/read_cache.dart';
import '../features/unlock/session.dart';
import '../features/unlock/session_keeper.dart';
import '../ops/fleet/fleet_providers.dart';
import '../ops/ops_build.dart';
import '../sync/sync_providers.dart';
import '../sync/transport.dart' show boxAt;
import 'deps.dart';

export '../features/unlock/session.dart' show sessionProvider;

/// Overridden in `main` and in every test with the platform's pieces.
final appDepsProvider = Provider<AppDeps>(
  (ref) => throw StateError('appDepsProvider must be overridden'),
);

// ---- enrolment ----

class EnrolledBoxNotifier extends Notifier<EnrolledBox?> {
  @override
  EnrolledBox? build() => ref.watch(appDepsProvider).initialBox;

  /// After `EnrolFlow.run`, which already saved the box to the store. A
  /// new enrolment starts with an empty read cache.
  void adopt(EnrolledBox box) {
    final cache = ref.read(readCacheProvider)..clear();
    cache.useBox(box.boxId);
    state = box;
  }

  /// A new enrolment succeeded while the old one still stood (the phone left a follower for the main box): the new
  /// enrolment is already saved by the enrol, so only the OLD box's local copy and cached answers go, then the new box
  /// is taken. Nothing of the old enrolment is dropped before this is called.
  Future<void> replaceWith(EnrolledBox box) async {
    final cache = ref.read(readCacheProvider)..clear();
    await wipeLocalStore(ref);
    cache.useBox(box.boxId);
    state = box;
  }

  /// The box said its app lock is [value] (unlock challenge): keep it, in
  /// memory and in the store, so the next launch starts on the right view.
  /// Nothing changes when it is already so.
  Future<void> setAppLock(bool value) async {
    final box = state;
    if (box == null || box.appLock == value) return;
    final next = box.withAppLock(value);
    await ref.read(appDepsProvider).boxStore.save(next);
    if (ref.mounted) state = next;
  }

  // The three learns below are read-modify-write on the enrolled box. They
  // run one after another, each re-reading the current state when it starts,
  // so two that overlap cannot drop each other's field.
  Future<void> _learnQueue = Future<void>.value();

  Future<void> _serialized(Future<void> Function() task) {
    final run = _learnQueue.then((_) => task());
    _learnQueue = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  /// The box named its cloud in `GET /api/health`: keep it when it is an
  /// https origin on the MAXCOM domain ([acceptedCloudOrigin]) and differs
  /// from the one kept. Anything else is ignored.
  Future<void> learnCloud(String? raw) => _serialized(() async {
    final box = state;
    if (box == null) return;
    final origin = acceptedCloudOrigin(box, raw);
    if (origin == null || origin == box.cloud) return;
    final next = box.withCloud(origin);
    await ref.read(appDepsProvider).boxStore.save(next);
    if (ref.mounted && state?.boxId == next.boxId) state = next;
  });

  /// A direct answer was verified (pinned CA, matching boxId) at [ip]: keep
  /// it as the last known address.
  Future<void> learnLastIp(String? ip) => _serialized(() async {
    final box = state;
    if (box == null || ip == null || !isIpv4(ip) || box.lastIp == ip) return;
    final next = box.withLastIp(ip);
    await ref.read(appDepsProvider).boxStore.save(next);
    if (ref.mounted && state?.boxId == next.boxId) state = next;
  });

  /// A handshake by [name] to the pinned CA, with the enrolled boxId,
  /// worked: the enrolment now carries the name. The IP origin stays as the
  /// fallback.
  Future<void> learnName(String name) => _serialized(() async {
    final box = state;
    if (box == null || !isBoxName(name) || box.name == name) return;
    final next = box.withName(name);
    await ref.read(appDepsProvider).boxStore.save(next);
    if (ref.mounted && state?.boxId == next.boxId) state = next;
  });

  /// "Bukan anda? Daftar semula": forget the box and the key's owner, and
  /// every answer cached from it.
  Future<void> forget() async {
    final cache = ref.read(readCacheProvider)..clear();
    cache.useBox('');
    await wipeLocalStore(ref);
    await ref.read(appDepsProvider).boxStore.clear();
    // the surau's name and helper belong to the box that was left
    await ref.read(appDepsProvider).surauInfoStore.clear();
    state = null;
  }
}

final enrolledBoxProvider = NotifierProvider<EnrolledBoxNotifier, EnrolledBox?>(
  EnrolledBoxNotifier.new,
);

/// Whether the app lock (PIN, fingerprint) is on: the box's settings when
/// known (fresh or cached), else what the box last said at enrolment or
/// unlock; on when nothing is known.
final appLockProvider = Provider<bool>((ref) {
  // The Pentadbir MAXCOM's device always asks for a PIN or fingerprint.
  if (ref.watch(isSuperadminProvider)) return true;
  final settings = ref.watch(settingsProvider).value?.value;
  final lock = settings?['appLock'];
  if (lock is Map && lock['enabled'] is bool) return lock['enabled'] as bool;
  return ref.watch(enrolledBoxProvider)?.appLock ?? true;
});

/// Roles for navigation and gating: the session's (fresh from the box),
/// else what enrolment recorded.
final rolesProvider = Provider<Set<String>>((ref) {
  final session = ref.watch(sessionProvider);
  if (session != null) return session.user.roles.toSet();
  return ref.watch(enrolledBoxProvider)?.roles.toSet() ?? const {};
});

/// The signed-in person holds the Pentadbir MAXCOM role.
final isSuperadminProvider = Provider<bool>(
  (ref) => ref.watch(rolesProvider).contains('superadmin'),
);

/// Whether the lock applies to this person: the surau's lock, or the Pentadbir MAXCOM rule.
final effectiveLockProvider = Provider<bool>(
  (ref) => ref.watch(appLockProvider),
);

/// True when the app talks to the MAXCOM cloud rather than the surau's box:
/// the current session was issued by the cloud.
final isCloudGatewayProvider = Provider<bool>(
  (ref) => ref.watch(sessionProvider)?.via == SessionDto.viaCloud,
);

// ---- the surau ----

class SurauInfoNotifier extends Notifier<SurauInfo?> {
  // What the header last showed, so a rebuild (a new route to the box, a
  // move onto a cloud session) does not blank it while the refresh runs.
  SurauInfo? _last;
  // The enrolment (box id) [_last] belongs to: another box, or none, drops it.
  String? _lastBoxId;

  @override
  SurauInfo? build() {
    final deps = ref.watch(appDepsProvider);
    // While the client is being rebuilt for a changed enrolment, the value
    // kept is the old box's client: do not ask it for the new box.
    final clientAsync = ref.watch(enrolledClientProvider);
    final client = clientAsync.isLoading ? null : clientAsync.value;
    final box = ref.watch(enrolledBoxProvider);
    if (box?.boxId != _lastBoxId) {
      _last = null;
      _lastBoxId = box?.boxId;
    }
    // A cloud session means the box did not answer the unlock: ask again.
    ref.watch(sessionProvider.select((s) => s?.via == SessionDto.viaCloud));
    if (client != null) _refresh(deps, client, box);
    // The kept copy from launch is the initial box's surau only.
    return _last ?? (box != null && box.boxId == deps.initialBox?.boxId ? deps.initialSurau : null);
  }

  /// Ignored when the enrolment changed since [boxId] started a refresh: the
  /// answer belongs to the old surau.
  void _set(SurauInfo info, String? boxId) {
    if (!ref.mounted || boxId != _lastBoxId) return;
    _last = info;
    state = info;
  }

  Future<void> _refresh(AppDeps deps, BoxClient client, EnrolledBox? box) async {
    final boxId = box?.boxId;
    final loader = SurauInfoLoader(
      client: client,
      store: deps.surauInfoStore,
      // The box away: the MAXCOM cloud answers the same public route for
      // this enrolment (the box id tells it which surau).
      fallback: box == null
          ? null
          : () => deps.enrolledClient(boxAt(box, cloudOriginOf(box))),
    );
    final cached = await loader.cached();
    if (cached != null) _set(cached, boxId);
    final fresh = await loader.refresh();
    if (fresh != null) _set(fresh, boxId);
  }
}

/// "Kemudian" on the move screen: the person left the move for now. The unlock then shows "Sambung ke Box utama" instead
/// of sending the phone straight back to the move screen. Cleared when the move is opened again or the phone is enrolled
/// anew.
class MoveDeferredNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void set(bool value) => state = value;
}

final moveDeferredProvider = NotifierProvider<MoveDeferredNotifier, bool>(MoveDeferredNotifier.new);

/// The phone is leaving its follower enrolment for the main box with a join code: the enrol page is open while the old
/// enrolment still stands (the guard lets it through), and the old enrolment is forgotten only after the new one
/// succeeded. Cleared by "Kembali" on that page and by the success.
class JoiningInsteadNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void set(bool value) => state = value;
}

final joiningInsteadProvider = NotifierProvider<JoiningInsteadNotifier, bool>(JoiningInsteadNotifier.new);

final surauInfoProvider = NotifierProvider<SurauInfoNotifier, SurauInfo?>(
  SurauInfoNotifier.new,
);

// ---- reachability and cache ----

class ConnectivityNotifier extends Notifier<BoxReach> implements ReachSink {
  @override
  BoxReach build() => BoxReach.unknown;

  @override
  BoxReach get reach => state;

  @override
  void markUp(DateTime at) => state = state.up(at);

  @override
  void markDown(DateTime at) => state = state.failed(at);
}

/// Whether the box answered lately; the offline banner watches this.
final connectivityProvider = NotifierProvider<ConnectivityNotifier, BoxReach>(
  ConnectivityNotifier.new,
);

/// Lives for the whole run: a 401 or sign-out never empties it, but
/// forgetting the box does, and another box id gets its own cache. Loads
/// what the last run cached for this box, then keeps the store current.
final readCacheProvider = Provider<ReadCache>((ref) {
  final store = ref.watch(appDepsProvider).cacheStore;
  final boxId = ref.watch(appDepsProvider).initialBox?.boxId ?? '';
  final cache = ReadCache(store: store, boxId: boxId);
  cache.restore();
  return cache;
});

/// The pinned client for the enrolled box; its error is a [TrustError]
/// when the enrolled CA is gone (enrol again).
final enrolledClientProvider = FutureProvider<BoxClient?>((ref) async {
  final box = ref.watch(enrolledBoxProvider);
  if (box == null) return null;
  final deps = ref.watch(appDepsProvider);
  // A proven name whose address was found by discovery: talk to the name
  // (verified against the pinned CA by name), so a changed IP does not
  // matter. Otherwise the enrolled address, as before.
  final routes = deps.routes;
  if (routes != null) {
    ref.watch(boxRoutesEpochProvider);
    final name = box.name;
    if (name != null && routes.addressOf(name) != null) {
      return deps.enrolledClient(boxAt(box, boxNameOrigin(name, box.box.port)));
    }
  }
  // No proven route: the enrolled address, or the IP the locator last
  // proved for the box when that moved (never a name Android cannot open).
  final direct = currentIpOrigin(box);
  return deps.enrolledClient(direct == box.box ? box : boxAt(box, direct));
});

/// Moves when a box's name is pointed at a new address ([BoxRoutes]).
class BoxRoutesEpoch extends Notifier<int> {
  @override
  int build() {
    final routes = ref.watch(appDepsProvider).routes;
    if (routes == null) return 0;
    void listener() => state = routes.epoch.value;
    routes.epoch.addListener(listener);
    ref.onDispose(() => routes.epoch.removeListener(listener));
    return routes.epoch.value;
  }
}

final boxRoutesEpochProvider = NotifierProvider<BoxRoutesEpoch, int>(
  BoxRoutesEpoch.new,
);

/// A client for a cloud origin that issued the session: public TLS on the
/// MAXCOM domain, else pinned to the surau's CA.
final cloudClientProvider = FutureProvider.family<BoxClient?, Uri>((
  ref,
  base,
) async {
  final box = ref.watch(enrolledBoxProvider);
  if (box == null) return null;
  return ref.watch(appDepsProvider).enrolledClient(boxAt(box, base));
});

/// Null until enrolled and unlocked (or in the offline session, whose
/// token is empty: reads come from the local copy, writes wait in the
/// outbox). Talks to the base that issued the token: the cloud's client for
/// a cloud session, else the enrolled box's.
final gatewayProvider = Provider<BoxGateway?>((ref) {
  final deps = ref.watch(appDepsProvider);
  final cloudBase = ref.watch(
    sessionProvider.select(
      (s) => s?.via == SessionDto.viaCloud ? s?.base : null,
    ),
  );
  final client = cloudBase == null
      ? ref.watch(enrolledClientProvider).value
      : ref.watch(cloudClientProvider(cloudBase)).value;
  final session = ref.watch(sessionProvider);
  if (client == null || session == null) return null;
  // Ops build: a Pentadbir MAXCOM on the cloud works in one surau at a time (the acting-surau header).
  final acting = kOpsBuild && cloudBase != null ? ref.watch(actingSurauIdProvider) : null;
  return BoxGateway(
    client: client,
    actingSurau: acting,
    token: session.token,
    cache: ref.watch(readCacheProvider),
    reach: ref.watch(connectivityProvider.notifier),
    now: deps.now,
    // A silent unlock first (the box may be back, or the cloud's token is
    // spent); the unlock screen only when that is refused.
    onSessionExpired: () =>
        unawaited(ref.read(sessionKeeperProvider).expired()),
    store: ref.watch(localStoreProvider).value,
    engine: ref.watch(syncEngineProvider),
  );
});

// ---- data ----

/// Bumped when `GET /api/health` reports a new `version`; data providers
/// watch it to refetch.
class DataVersionNotifier extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state++;
}

final dataVersionProvider = NotifierProvider<DataVersionNotifier, int>(
  DataVersionNotifier.new,
);

/// The box clock minus this device's clock in milliseconds, learned from the
/// box's health answer; null until one carried the box's time.
class BoxClockOffset extends Notifier<int?> {
  @override
  int? build() {
    ref.watch(enrolledBoxProvider.select((b) => b?.boxId));
    return null;
  }

  void learn(int ms) => state = ms;
}

final boxClockOffsetProvider = NotifierProvider<BoxClockOffset, int?>(BoxClockOffset.new);

class HealthNotifier extends AsyncNotifier<Read<HealthDto>?> {
  int? _lastVersion;

  @override
  Future<Read<HealthDto>?> build() async {
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return null;
    return _fetch(gateway);
  }

  /// The poller and the banner's `Cuba lagi`. Errors land in [state] like
  /// those of [build]; the previous value stays readable.
  Future<void> refresh() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    state = await AsyncValue.guard(() => _fetch(gateway));
  }

  Future<Read<HealthDto>?> _fetch(BoxGateway gateway) async {
    final read = (await gateway.get('/api/health')).map(HealthDto.fromJson);
    if (!read.stale) {
      // A fresh answer from the box (not the cloud): keep its cloud, and
      // leave the offline session at once.
      final session = ref.read(sessionProvider);
      if (session?.via != SessionDto.viaCloud) {
        unawaited(
          ref.read(enrolledBoxProvider.notifier).learnCloud(read.value.cloud),
        );
      }
      if (session?.offline == true) ref.read(sessionKeeperProvider).kick();
      // The box's own clock, when its health answer carries it: the offset the
      // settings ops are sent with (G3). Only against the box itself.
      final boxNow = read.value.now;
      if (boxNow != null && session?.via != SessionDto.viaCloud) {
        ref.read(boxClockOffsetProvider.notifier).learn(boxNow.difference(ref.read(appDepsProvider).now()).inMilliseconds);
      }
      final v = read.value.version;
      if (_lastVersion != null && _lastVersion != v) {
        ref.read(dataVersionProvider.notifier).bump();
        // Something changed on the box (another admin, another device): the
        // settings are read fresh by the bump above, and a sync pull brings
        // the lists and the local copy along (G1). Never awaited: the health
        // answer does not wait for a pull.
        final engine = ref.read(syncEngineProvider);
        if (engine != null) unawaited(engine.sync().then<void>((_) {}, onError: (Object _) {}));
      }
      _lastVersion = v;
    }
    return read;
  }
}

final healthProvider = AsyncNotifierProvider<HealthNotifier, Read<HealthDto>?>(
  HealthNotifier.new,
);

/// Whether the box can do [feature] (`video`, `posterStretch`). While the box's health is not known (offline, loading)
/// the answer is yes, so nothing is hidden by a missing answer; an older box that answered says no.
final boxSupportsProvider = Provider.family<bool, String>((ref, feature) {
  final h = ref.watch(healthProvider).value?.value;
  return h == null ? true : h.supports(feature);
});

class SettingsNotifier extends AsyncNotifier<Read<Map<String, dynamic>>?> {
  @override
  Future<Read<Map<String, dynamic>>?> build() async {
    ref.watch(dataVersionProvider);
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return null;
    return loadSettings(gateway, enrolledAppLock: ref.read(enrolledBoxProvider)?.appLock);
  }
}

final settingsProvider =
    AsyncNotifierProvider<SettingsNotifier, Read<Map<String, dynamic>>?>(
      SettingsNotifier.new,
    );

/// Feature switches for the menu: the box's settings when known (fresh or
/// cached), else the registry defaults.
final featureFlagsProvider = Provider<FeatureFlags>((ref) {
  final settings = ref.watch(settingsProvider).value;
  if (settings == null) return FeatureFlags.defaults;
  return FeatureFlags.fromSettings(settings.value);
});

// ---- notices ----

enum Notice { forbidden }

/// A one-shot message the shell shows as a snackbar, set by the guard.
class NoticeNotifier extends Notifier<Notice?> {
  @override
  Notice? build() => null;

  void show(Notice notice) => state = notice;

  void clear() => state = null;
}

final noticeProvider = NotifierProvider<NoticeNotifier, Notice?>(
  NoticeNotifier.new,
);
