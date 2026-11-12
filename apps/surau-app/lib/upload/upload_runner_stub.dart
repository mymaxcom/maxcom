// The runner for anything that is neither the browser nor Android (the VM
// tests, an unknown platform): it can list nothing and send nothing, so a
// queue built on it never starts a job.

import 'dart:async';

import 'upload_queue.dart';

class StubUploadRunner implements UploadRunner {
  final StreamController<UploadEvent> _events = StreamController.broadcast();

  @override
  bool get survivesRestart => false;

  @override
  Stream<UploadEvent> get events => _events.stream;

  @override
  Future<UploadNetwork> network() async => UploadNetwork.none;

  @override
  Future<List<UploadSegment>> segmentsFor(
    String sessionId,
    String? kuliahId,
  ) async => const [];

  @override
  Future<void> start(UploadJob job, UploadAuth auth) async =>
      throw UnsupportedError('upload');

  @override
  Future<void> cancel(String jobId) async {}

  @override
  Future<void> forget(String jobId) async {}

  @override
  Future<void> dispose() async => _events.close();
}

UploadRunner createWebRunner() => StubUploadRunner();

UploadRunner createAndroidRunner() => StubUploadRunner();
