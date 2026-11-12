// Riverpod wiring for the catch-up upload (Plan 6 Task 10): the queue on the
// local store's `uploads` collection, the platform runner, the cloud access
// a run needs, and the `youtubeCatchUp` settings. Inert (null) when the app
// has no store or no runner builder, which is how the older widget tests run.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../box/trust.dart' show CaDerSource, usesPublicTls;
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../store/local_store.dart';
import '../sync/sync_providers.dart';
import '../sync/transport.dart' show boxAt;
import 'session_files.dart';
import 'upload_queue.dart';
import 'upload_runner_android.dart' show AndroidUploadRunner;

/// `youtubeCatchUp` from the local copy of the settings; the registry's
/// defaults when nothing is stored yet.
class CatchUpSettings {
  const CatchUpSettings({
    this.enabled = false,
    this.wifiOnly = true,
    this.joinSegments = true,
    this.replaceGappyLive = 'ask',
  });

  factory CatchUpSettings.fromDoc(Map<String, dynamic>? d) {
    if (d == null) return const CatchUpSettings();
    final replace = d['replaceGappyLive'];
    return CatchUpSettings(
      enabled: d['enabled'] == true,
      wifiOnly: d['wifiOnly'] != false,
      joinSegments: d['joinSegments'] != false,
      replaceGappyLive: replace is String ? replace : 'ask',
    );
  }

  final bool enabled;
  final bool wifiOnly;
  final bool joinSegments;

  /// `ask`, `always` or `never`.
  final String replaceGappyLive;
}

Future<CatchUpSettings> readCatchUpSettings(LocalStore store) async =>
    CatchUpSettings.fromDoc(
      await store.getDoc(Collections.settings, 'youtubeCatchUp'),
    );

/// The CA the native uploader pins for its calls to [cloudBox] (the box with
/// its base swapped to the cloud). Null when the cloud uses public TLS
/// (normal HTTPS) or no CA is kept.
Future<Uint8List?> uploadCaDer(EnrolledBox cloudBox, Object? store) async {
  final sha = cloudBox.caSha256;
  if (usesPublicTls(cloudBox) || store is! CaDerSource || sha == null) {
    return null;
  }
  return store.loadCaDer(sha);
}

final uploadRunnerProvider = Provider<UploadRunner?>((ref) {
  final build = ref.watch(appDepsProvider).uploadRunnerBuilder;
  if (build == null) return null;
  final runner = build();
  ref.onDispose(() => unawaited(runner.dispose()));
  return runner;
});

/// Cloud access for a run: the cloud base, this device's session there and
/// the pinned root CA. Null when the box has no cloud or the device holds no
/// session on it (then a job waits, `lastError: no_cloud`).
final uploadAuthProvider = Provider<Future<UploadAuth?> Function()>((ref) {
  return () async {
    final deps = ref.read(appDepsProvider);
    final box = ref.read(enrolledBoxProvider);
    final cloud = box?.cloud;
    if (box == null || cloud == null) return null;
    final session = ref.read(sessionProvider);
    final token = cloud.authority == box.box.authority
        ? session?.token
        : ref.read(sessionTokensProvider).get(cloud);
    if (token == null) return null;
    final cloudBox = boxAt(box, cloud);
    final client = await deps.enrolledClient(cloudBox);
    final ca = await uploadCaDer(cloudBox, deps.boxStore);
    return UploadAuth(
      api: HttpUploadApi(client: client, token: token),
      base: cloud,
      token: token,
      caDer: ca,
    );
  };
});

/// The queue; null until the local store is open or when uploads are off.
final uploadQueueProvider = Provider<UploadQueue?>((ref) {
  final deps = ref.watch(appDepsProvider);
  final store = ref.watch(localStoreProvider).value;
  final runner = ref.watch(uploadRunnerProvider);
  if (store == null || runner == null) return null;
  // Android: a live is found by the exact names its engine reported.
  if (runner is AndroidUploadRunner) runner.sessionFiles = SessionFiles(store);

  CatchUpSettings cached = const CatchUpSettings();
  Future<void> refreshSettings() async {
    try {
      cached = await readCatchUpSettings(store);
    } on Object {
      // keep the last known values
    }
  }

  final queue = UploadQueue(
    store: store,
    runner: runner,
    now: deps.now,
    auth: ref.read(uploadAuthProvider),
    wifiOnly: () => cached.wifiOnly,
    joinSegments: () => cached.joinSegments,
  );

  var kicking = false;
  Future<void> kick() async {
    if (kicking) return;
    kicking = true;
    try {
      await refreshSettings();
      await queue.kick();
    } on Object {
      // a failed look at the network is tried again on the next tick
    } finally {
      kicking = false;
    }
  }

  unawaited(queue.load().then((_) => kick(), onError: (_) {}));
  final sub = queue.changes.listen((_) => unawaited(kick()));
  final timer = Timer.periodic(
    const Duration(seconds: 20),
    (_) => unawaited(kick()),
  );
  ref.onDispose(() {
    timer.cancel();
    unawaited(sub.cancel());
    unawaited(queue.dispose());
  });
  return queue;
});

/// The jobs for the UI, newest change first.
final uploadJobsProvider = StreamProvider<List<UploadJob>>((ref) async* {
  final queue = ref.watch(uploadQueueProvider);
  if (queue == null) {
    yield const [];
    return;
  }
  yield await queue.jobs();
  yield* queue.changes;
});
