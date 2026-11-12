// App-wide state: the enrolled box, the session (from the unlock feature),
// the surau's name, box reachability, the read cache, the gateway that
// every screen talks through, health and settings with their cached
// fallbacks, and the one-shot notice the shell shows as a snackbar.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../box/box_client.dart';
import '../box/cloud_origin.dart';
import '../features/common/surau_info.dart';
import '../features/enrol/enrol_flow.dart';
import '../features/shell/box_gateway.dart';
import '../features/shell/permissions.dart';
import '../features/shell/read_cache.dart';
import '../features/unlock/session.dart';
import '../features/unlock/session_keeper.dart';
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

  /// The box named its cloud in `GET /api/health`: keep it when it is an
  /// https origin on the MAXCOM domain ([acceptedCloudOrigin]) and differs
  /// from the one kept. Anything else is ignored.
  Future<void> learnCloud(String? raw) async {
    final box = state;
    if (box == null) return;
    final origin = acceptedCloudOrigin(box, raw);
    if (origin == null || origin == box.cloud) return;
    final next = box.withCloud(origin);
    await ref.read(appDepsProvider).boxStore.save(next);
    if (ref.mounted && state?.boxId == next.boxId) state = next;
  }

  /// "Bukan anda? Daftar semula": forget the box and the key's owner, and
  /// every answer cached from it.
  Future<void> forget() async {
    final cache = ref.read(readCacheProvider)..clear();
    cache.useBox('');
    await wipeLocalStore(ref);
    await ref.read(appDepsProvider).boxStore.clear();
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
final isSuperadminProvider = Provider<bool>((ref) => ref.watch(rolesProvider).contains('superadmin'));

/// Whether the lock applies to this person: the surau's lock, or the Pentadbir MAXCOM rule.
final effectiveLockProvider = Provider<bool>((ref) => ref.watch(appLockProvider));

/// True when the app talks to the MAXCOM cloud rather than the surau's box:
/// the current session was issued by the cloud.
final isCloudGatewayProvider = Provider<bool>(
  (ref) => ref.watch(sessionProvider)?.via == SessionDto.viaCloud,
);

/// May this person give or take the Pentadbir MAXCOM role: on the cloud, with `superadmin:manage`.
final canGrantSuperadminProvider = Provider<bool>(
  (ref) => ref.watch(isCloudGatewayProvider) && canSee(ref.watch(rolesProvider), 'superadmin:manage'),
);

// ---- the surau ----

class SurauInfoNotifier extends Notifier<SurauInfo?> {
  @override
  SurauInfo? build() {
    final deps = ref.watch(appDepsProvider);
    final client = ref.watch(enrolledClientProvider).value;
    if (client != null) _refresh(deps, client);
    return deps.initialSurau;
  }

  Future<void> _refresh(AppDeps deps, BoxClient client) async {
    final loader = SurauInfoLoader(client: client, store: deps.surauInfoStore);
    final cached = await loader.cached();
    if (cached != null && ref.mounted) state = cached;
    final fresh = await loader.refresh();
    if (fresh != null && ref.mounted) state = fresh;
  }
}

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
  return ref.watch(appDepsProvider).enrolledClient(box);
});

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
  return BoxGateway(
    client: client,
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
      final v = read.value.version;
      if (_lastVersion != null && _lastVersion != v) {
        ref.read(dataVersionProvider.notifier).bump();
      }
      _lastVersion = v;
    }
    return read;
  }
}

final healthProvider = AsyncNotifierProvider<HealthNotifier, Read<HealthDto>?>(
  HealthNotifier.new,
);

class SettingsNotifier extends AsyncNotifier<Read<Map<String, dynamic>>?> {
  @override
  Future<Read<Map<String, dynamic>>?> build() async {
    ref.watch(dataVersionProvider);
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return null;
    return gateway.get('/api/settings');
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
