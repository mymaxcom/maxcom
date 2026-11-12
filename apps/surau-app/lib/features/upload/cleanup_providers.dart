// Riverpod wiring for the recording clean-up (Plan 6 Task 13): the platform
// remover, the YouTube check through the gateway (the cloud when cloud sync
// is on, the box otherwise), the audit note through the sync outbox, and the
// run triggers (app start, a change in the upload jobs, every 20 s; the
// clean-up itself asks YouTube at most once an hour per session).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../store/local_store.dart';
import '../../sync/sync_providers.dart';
import '../../upload/recording_cleanup.dart';
import '../../upload/recording_remover.dart';
import '../../upload/session_files.dart';
import '../../upload/upload_providers.dart';
import '../live/live_controller.dart';
import '../live/publisher.dart';

/// `recordingCleanup` and `liveYoutube.privacy` out of the settings map the
/// screens read (feature key to its settings), defaults when not loaded.
CleanupSettings cleanupSettingsFrom(Map<String, dynamic>? settings) {
  Map<String, dynamic>? doc(String k) {
    final v = settings?[k];
    return v is Map<String, dynamic> ? v : null;
  }

  return CleanupSettings.fromDocs(doc('recordingCleanup'), doc('liveYoutube'));
}

/// The clean-up settings for the screens.
final cleanupSettingsProvider = Provider<CleanupSettings>(
  (ref) => cleanupSettingsFrom(ref.watch(settingsProvider).value?.value),
);

/// The exact file names each Android live wrote; null until the store is open.
final sessionFilesProvider = Provider<SessionFiles?>((ref) {
  final store = ref.watch(localStoreProvider).value;
  return store == null ? null : SessionFiles(store);
});

final recordingRemoverProvider = Provider<RecordingRemover?>(
  (ref) => recordingRemoverFor(
    ref.watch(appDepsProvider).platform,
    ref.watch(recordingsStoreProvider),
    sessionFiles: ref.watch(sessionFilesProvider),
  ),
);

/// A live or a recording is on: the clean-up deletes nothing meanwhile. It
/// does not build the publisher just to ask (that would wake the camera).
bool liveOrRecordingNow(Ref ref) {
  if (!ref.exists(livePublisherProvider)) return false;
  final s = ref.read(livePublisherProvider).current;
  return s.recording.on ||
      s.phase == PublisherPhase.starting ||
      s.phase == PublisherPhase.live ||
      s.phase == PublisherPhase.stopping;
}

String _safeId(String raw) {
  final s = raw.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '-');
  return s.isEmpty ? 'session' : (s.length > 100 ? s.substring(0, 100) : s);
}

/// The clean-up; null until the store, the queue and a remover exist.
final recordingCleanupProvider = Provider<RecordingCleanup?>((ref) {
  final deps = ref.watch(appDepsProvider);
  final store = ref.watch(localStoreProvider).value;
  final queue = ref.watch(uploadQueueProvider);
  final remover = ref.watch(recordingRemoverProvider);
  if (store == null || queue == null || remover == null) return null;

  final cleanup = RecordingCleanup(
    store: store,
    now: deps.now,
    verify: (ids) async {
      final gateway = ref.read(gatewayProvider);
      if (gateway == null) throw StateError('no_gateway');
      final out = await gateway.post('/api/youtube/verify', {'videoIds': ids});
      final list = out['results'];
      if (list is! List) throw StateError('bad_answer');
      return [
        for (final e in list)
          if (e is Map<String, dynamic>) VideoCheck.fromJson(e),
      ];
    },
    remover: remover,
    settings: () async => CleanupSettings.fromDocs(
      await store.getDoc(Collections.settings, 'recordingCleanup'),
      await store.getDoc(Collections.settings, 'liveYoutube'),
    ),
    jobs: queue.jobs,
    recordingNow: () async => liveOrRecordingNow(ref),
    audit: (sessionId, videoIds, bytes) async {
      final engine = ref.read(syncEngineProvider);
      if (engine == null) throw StateError('no_engine');
      await engine.enqueue(
        kind: 'audit.put',
        entity: 'audit',
        entityId: _safeId(sessionId),
        payload: {
          'event': 'recording/deleted',
          'sessionId': _safeId(sessionId),
          'videoIds': videoIds,
          'bytes': bytes,
        },
      );
    },
  );

  var running = false;
  Future<void> run() async {
    if (running) return;
    running = true;
    try {
      await cleanup.run();
    } on Object {
      // a failed pass is tried again on the next tick
    } finally {
      running = false;
    }
  }

  unawaited(queue.load().then((_) => run(), onError: (_) {}));
  final sub = queue.changes.listen((_) => unawaited(run()));
  final timer = Timer.periodic(
    const Duration(seconds: 20),
    (_) => unawaited(run()),
  );
  ref.onDispose(() {
    timer.cancel();
    unawaited(sub.cancel());
    unawaited(cleanup.dispose());
  });
  return cleanup;
});

/// Every session the clean-up watches, as it changes.
final cleanupRecordsProvider = StreamProvider<Map<String, CleanupRecord>>((
  ref,
) async* {
  final c = ref.watch(recordingCleanupProvider);
  if (c == null) {
    yield const {};
    return;
  }
  yield await c.records();
  await for (final _ in c.changes) {
    yield await c.records();
  }
});
