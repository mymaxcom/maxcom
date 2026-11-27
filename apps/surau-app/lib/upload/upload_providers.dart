// Riverpod wiring for the catch-up upload (Plan 6 Task 10): the queue on the
// local store's `uploads` collection, the platform runner, the cloud access
// a run needs, and the `youtubeCatchUp` settings. Inert (null) when the app
// has no store or no runner builder, which is how the older widget tests run.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../box/box_address.dart' show currentIpOrigin;
import '../box/box_name.dart' show isBoxName;
import '../box/trust.dart' show CaDerSource, usesPublicTls;
import '../box/wire.dart' show SessionDto;
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../features/settings_defaults.dart';
import '../store/local_store.dart';
import '../sync/sync_providers.dart';
import '../sync/transport.dart' show SessionTokens;
import 'session_files.dart';
import 'upload_queue.dart';
import 'upload_runner_android.dart' show AndroidUploadRunner;

/// `youtubeCatchUp` from the local copy of the settings; the registry's
/// defaults when nothing is stored yet.
class CatchUpSettings {
  const CatchUpSettings({
    this.enabled = true,
    this.wifiOnly = true,
    this.joinSegments = true,
    this.replaceGappyLive = 'ask',
  });

  factory CatchUpSettings.fromDoc(Map<String, dynamic>? d) {
    // One defaults helper for every reader (B2): a missing row, or a row
    // without the key, reads the registry's value (the feature is ON by default).
    const f = 'youtubeCatchUp';
    final replace = featureValue(f, d, 'replaceGappyLive');
    return CatchUpSettings(
      enabled: featureOnIn(d, f),
      wifiOnly: featureValue(f, d, 'wifiOnly') != false,
      joinSegments: featureValue(f, d, 'joinSegments') != false,
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

/// The CA the native uploader pins for its calls to [cloudBox] (the enrolled
/// box, or the box with its base swapped to the cloud). Null when it uses public TLS
/// (normal HTTPS) or no CA is kept.
Future<Uint8List?> uploadCaDer(EnrolledBox cloudBox, Object? store) async {
  final sha = cloudBox.caSha256;
  if (usesPublicTls(cloudBox) || store is! CaDerSource || sha == null) {
    return null;
  }
  return store.loadCaDer(sha);
}

/// The session token the device holds on the box itself, whichever address
/// the session was issued at: tokens are kept under the base that issued
/// them ([SessionTokens]), which is the address now in use, the name or the
/// enrolment-time origin.
String? boxSessionToken(SessionTokens tokens, EnrolledBox box) {
  final bases = <Uri>[
    currentIpOrigin(box),
    box.box,
    if (box.name != null && isBoxName(box.name!))
      box.box.replace(host: box.name!),
  ];
  for (final b in bases) {
    final t = tokens.get(b);
    if (t != null && t.isNotEmpty) return t;
  }
  return null;
}

final uploadRunnerProvider = Provider<UploadRunner?>((ref) {
  final build = ref.watch(appDepsProvider).uploadRunnerBuilder;
  if (build == null) return null;
  final runner = build();
  ref.onDispose(() => unawaited(runner.dispose()));
  return runner;
});

/// Access for a run (release 2026.11.13): the MAXCOM at the surau holds the
/// YouTube grant, so `begin`, `done` and `quota` go to the enrolled box, with
/// this device's session there and the surau's root CA. The bytes go straight
/// to Google from anywhere once a session is open. Null while the device holds
/// no session on the box (then a job waits, `lastError: no_box`); a `done`
/// that cannot reach the box is kept with its video id and sent again later.
final uploadAuthProvider = Provider<Future<UploadAuth?> Function()>((ref) {
  return () async {
    final deps = ref.read(appDepsProvider);
    final box = ref.read(enrolledBoxProvider);
    if (box == null) return null;
    final session = ref.read(sessionProvider);
    // the cloud never holds the grant now: a cloud session's token is not used here
    // The native uploader opens `base` with the system resolver, so it must
    // be an IP (or domain) origin that is current now, never a `.local` name.
    // Web (the trust does not pin the CA): the page origin is the only address,
    // and the browser resolves a name and holds the trust, so neither the
    // `.local` guard nor the stored-CA guard applies.
    final pins = deps.trust.pinsCa;
    final base = currentIpOrigin(box, isWeb: !pins);
    if (pins && isBoxName(base.host)) return null;
    final token = session != null && session.via != SessionDto.viaCloud
        ? session.token
        : boxSessionToken(ref.read(sessionTokensProvider), box);
    if (token == null || token.isEmpty) return null;
    // name first when the box's name is proven, else the current IP
    final client = await ref.read(enrolledClientProvider.future) ??
        await deps.enrolledClient(box);
    final ca = await uploadCaDer(box, deps.boxStore);
    // A private box without its stored root would be opened with system
    // trust by the native uploader: never. Only the public cloud may.
    if (pins && ca == null && !usesPublicTls(box)) return null;
    return UploadAuth(
      api: HttpUploadApi(client: client, token: token),
      base: base,
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
    // The Android worker only sends bytes to Google: the app asks the box for the address and confirms (B1, U7).
    appBegins: runner is AndroidUploadRunner,
  );

  var kicking = false;
  Future<void> kick({bool retryFailed = true}) async {
    if (kicking) return;
    kicking = true;
    try {
      await refreshSettings();
      await queue.kick(retryFailed: retryFailed);
    } on Object {
      // a failed look at the network is tried again on the next tick
    } finally {
      kicking = false;
    }
  }

  unawaited(queue.load().then((_) => kick(), onError: (_) {}));
  // a change of the list itself never re-asks a box that just failed to answer: the timer does
  final sub = queue.changes.listen((_) => unawaited(kick(retryFailed: false)));
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
