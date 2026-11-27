// Riverpod wiring for Plan 6 sync: the local store of the enrolled box, the
// per-base session tokens, the signed-outbox engine, the cloud wake and the
// foreground hook. Everything is inert (null engine, no store) when the app
// has no local-store builder, which is how the older widget tests run.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../box/box_address.dart' show currentIpOrigin;
import '../box/cloud_origin.dart';
import '../box/locator.dart';
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../features/unlock/session_keeper.dart';
import '../ops/fleet/fleet_providers.dart' show opsLocalDataClosedProvider;
import '../ops/ops_build.dart';
import '../store/local_store.dart';
import 'cloud_wake.dart';
import 'sync_engine.dart';
import 'transport.dart';

const String _metaLastWake = 'lastWake';

/// The local copy of the enrolled box's data; null when not enrolled or when
/// this app has no store builder.
final localStoreProvider = FutureProvider<LocalStore?>((ref) async {
  final build = ref.watch(appDepsProvider).localStoreBuilder;
  // Only the box's id: the enrolled record also changes when the box's address, name or cloud is learned, and
  // a store reopened for that rebuilt the upload queue under a running job (U8) and the sync engine with it.
  final boxId = ref.watch(enrolledBoxProvider.select((b) => b?.boxId));
  if (build == null || boxId == null) return null;
  final store = build();
  await store.open(boxId);
  return store;
});

final sessionTokensProvider = Provider<SessionTokens>((ref) => SessionTokens());

/// Set when the server refused this device as revoked (the store is wiped
/// and the session cleared). The unlock screen shows
/// `Peranti ini telah dibatalkan`, then clears it.
class RevokedNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void set() => state = true;

  void clear() => state = false;
}

final revokedProvider = NotifierProvider<RevokedNotifier, bool>(
  RevokedNotifier.new,
);

/// The direct (LAN) locator for [box]: a box with a proven local name is
/// found by name, last IP and discovery (each candidate checked against the
/// pinned CA and the enrolled boxId); a box without one by its enrolled
/// address only, which then learns the name once the box reports it.
BoxLocator directLocatorFor(Ref ref, EnrolledBox box) {
  final deps = ref.read(appDepsProvider);
  final boxes = ref.read(enrolledBoxProvider.notifier);
  final legacy = DirectBoxLocator(
    clientFor: deps.enrolledClient,
    // Every box answer may name the cloud it is linked to.
    onHealth: (h) => unawaited(boxes.learnCloud(h.cloud)),
  );
  final probe = deps.probeClient;
  final routes = deps.routes;
  if (probe == null || routes == null) {
    return TimeoutLocator(legacy, const Duration(seconds: 2));
  }
  return TimeoutLocator(
    NameAwareLocator(
      legacy: legacy,
      probeClient: (origin, ip) => probe(boxAt(box, origin), ip),
      discovery: deps.discovery,
      routes: routes,
      onReached: (ip) => unawaited(boxes.learnLastIp(ip)),
      onNameLearned: (n) => unawaited(boxes.learnName(n)),
    ),
    // Discovery takes about a second and a half: a named box gets longer.
    Duration(seconds: box.name != null ? 4 : 2),
  );
}

BoxLocator _locatorFor(Ref ref, EnrolledBox box) {
  final deps = ref.read(appDepsProvider);
  final wake = ref.read(cloudWakeProvider);
  return CompositeLocator(
    [
      // The box first, with a short budget, then the cloud (12 s, so the
      // Worker's own down-detection can answer).
      directLocatorFor(ref, box),
      CloudLocator(
        clientFor: (cloud) => deps.enrolledClient(boxAt(box, cloud)),
      ),
    ],
    // The box is away: wake the cloud (signed, debounced) before asking it.
    onFailed: (i) {
      if (i == 0) wake?.wakeSoon(cloudOriginOf(box));
    },
  );
}

/// The box first, then the cloud: what the unlock screen locates with.
final baseLocatorProvider = Provider<BoxLocator?>((ref) {
  final box = ref.watch(enrolledBoxProvider);
  return box == null ? null : _locatorFor(ref, box);
});

/// The last wake sent in this run, shared by every [CloudWake] the provider
/// builds (it is rebuilt when the store opens), so the debounce holds
/// before the store is there.
class _WakeMemory {
  int? lastMs;
}

final _wakeMemoryProvider = Provider<_WakeMemory>((ref) => _WakeMemory());

/// Wakes the cloud (signed, debounced to once per 10 min per device); null
/// when not enrolled. The cloud is [cloudOriginOf] the enrolled box.
final cloudWakeProvider = Provider<CloudWake?>((ref) {
  final deps = ref.watch(appDepsProvider);
  final box = ref.watch(enrolledBoxProvider);
  if (box == null) return null;
  final store = ref.watch(localStoreProvider).value;
  final memory = ref.watch(_wakeMemoryProvider);
  return CloudWake(
    clientFor: (cloud) => deps.enrolledClient(boxAt(box, cloud)),
    key: deps.key,
    boxId: box.boxId,
    deviceId: box.deviceId,
    now: deps.now,
    loadLast: () async {
      final kept = store == null
          ? null
          : int.tryParse((await store.meta())[_metaLastWake] ?? '');
      final mem = memory.lastMs;
      if (kept == null) return mem;
      return mem == null || kept > mem ? kept : mem;
    },
    saveLast: (ms) async {
      memory.lastMs = ms;
      await store?.setMeta(_metaLastWake, '$ms');
    },
  );
});

/// The engine; null until enrolled, unlocked and the store is open.
final syncEngineProvider = Provider<SyncEngine?>((ref) {
  final deps = ref.watch(appDepsProvider);
  final box = ref.watch(enrolledBoxProvider);
  final store = ref.watch(localStoreProvider).value;
  final session = ref.watch(sessionProvider);
  if (box == null || store == null || session == null) return null;
  // Ops build: a MAXCOM cloud session has no surau of its own on this phone (the cloud answers `surau_required` to
  // its sync), so the engine stays idle instead of retrying a refused call.
  if (kOpsBuild && ref.watch(opsLocalDataClosedProvider)) return null;
  final tokens = ref.read(sessionTokensProvider);
  final locator = _locatorFor(ref, box);
  final wake = ref.read(cloudWakeProvider);

  final engine = SyncEngine(
    store: store,
    key: deps.key,
    box: box,
    now: deps.now,
    transport: LocatorTransport(
      locator: locator,
      box: () => box,
      clientFor: (base) => deps.enrolledClient(boxAt(box, base)),
      // The session's token belongs to the base that issued it; another
      // base needs its own (kept under its host). The offline session has
      // none anywhere: a base that answers then asks for a silent unlock.
      tokenFor: (base) {
        if (session.offline) return null;
        final issued = session.base ?? currentIpOrigin(box);
        return base.authority == issued.authority
            ? session.token
            : tokens.get(base);
      },
    ),
    onChanged: () {
      if (ref.mounted) ref.read(dataVersionProvider.notifier).bump();
    },
    onRevoked: () {
      if (!ref.mounted) return;
      ref.read(revokedProvider.notifier).set();
      ref.read(sessionProvider.notifier).clear();
    },
    onSessionExpired: () {
      if (ref.mounted) unawaited(ref.read(sessionKeeperProvider).expired());
    },
    onNeedsUnlock: () {
      if (ref.mounted) ref.read(sessionKeeperProvider).kick();
    },
    onWakeNeeded: () => wake?.wakeSoon(cloudOriginOf(box)),
    clockOffsetMs: () => ref.mounted ? ref.read(boxClockOffsetProvider) : null,
    // A copy made before the ID, phone and delete fields is rebuilt once.
    snapshotFormat: kSnapshotFormat,
  );
  ref.onDispose(engine.dispose);
  unawaited(
    engine.load().then((_) => engine.sync()).then((_) {}, onError: (_) {}),
  );
  return engine;
});

/// The engine's view for the UI (status chip, counts).
final syncViewProvider = StreamProvider<SyncView>((ref) async* {
  final engine = ref.watch(syncEngineProvider);
  if (engine == null) {
    yield SyncView.empty;
    return;
  }
  yield engine.view;
  yield* engine.views;
});

/// The asset ids of pictures still waiting in the outbox (queued locally,
/// not yet on the box). Read again whenever the engine's view changes (the
/// same signal as the `N menunggu` count); reads only the queue's ids, never
/// the picture bytes. Empty without an engine.
final queuedAssetIdsProvider = FutureProvider<Set<String>>((ref) async {
  final engine = ref.watch(syncEngineProvider);
  ref.watch(syncViewProvider);
  if (engine == null) return const <String>{};
  final targets = await engine.outbox.targets();
  const prefix = 'asset|';
  return {
    for (final t in targets)
      if (t.startsWith(prefix)) t.substring(prefix.length),
  };
});

/// The asset ids of pictures whose bytes were lost before they could be
/// sent: a `blob_missing` conflict the person has not dismissed, or a queued
/// upload whose bytes are gone (it becomes that conflict at the next sync).
/// Read-only; no picture bytes are loaded. Retrying is not possible (the
/// bytes are gone), so the UI asks for the picture to be chosen again.
final lostAssetIdsProvider = FutureProvider<Set<String>>((ref) async {
  final engine = ref.watch(syncEngineProvider);
  ref.watch(syncViewProvider);
  if (engine == null) return const <String>{};
  final ids = <String>{};
  for (final c in await engine.conflicts()) {
    if (c['entity'] == 'asset' && c['reason'] == 'blob_missing') {
      final id = c['entityId'];
      if (id is String) ids.add(id);
    }
  }
  for (final op in await engine.outbox.missingBlobOps()) {
    if (op.entity == 'asset') ids.add(op.entityId);
  }
  return ids;
});

/// What the shell calls when the app opens or comes back to the front: wake
/// the cloud when the box is not on this network or edits wait (debounced,
/// never blocking), and sync.
class SyncCoordinator {
  SyncCoordinator(this._ref);

  final Ref _ref;

  void onForeground() {
    final engine = _ref.read(syncEngineProvider);
    final box = _ref.read(enrolledBoxProvider);
    final wake = _ref.read(cloudWakeProvider);
    if (engine == null || box == null) return;
    if (wake != null) {
      final deps = _ref.read(appDepsProvider);
      ForegroundWaker(
        wake: wake,
        boxReachable: () async {
          try {
            // the IP last proved for the box, not the enrolment-time one
            final direct = currentIpOrigin(box);
            await DirectBoxLocator(clientFor: deps.enrolledClient)
                .locate(direct == box.box ? box : boxAt(box, direct));
            return true;
          } on Object {
            return false;
          }
        },
        outboxCount: () => engine.outbox.count,
        cloud: () => cloudOriginOf(box),
      ).onForeground();
    }
    unawaited(engine.sync());
  }
}

final syncCoordinatorProvider = Provider<SyncCoordinator>(
  (ref) => SyncCoordinator(ref),
);

/// Used by `EnrolledBoxNotifier.forget`: empties the local copy and its key.
Future<void> wipeLocalStore(Ref ref) async {
  try {
    final store = await ref.read(localStoreProvider.future);
    await store?.wipe();
  } on Object {
    // forgetting the box must not fail on a store that is already gone
  }
}
