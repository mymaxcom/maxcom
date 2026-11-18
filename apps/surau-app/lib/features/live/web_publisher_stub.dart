// Off the web there is no browser publisher. The class exists so shared
// code (`publisherFor`) compiles on every platform; it never goes live.

import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../l10n/generated/s.dart';
import '../shell/live_camera_gateway.dart' show LiveAudioMix;
import 'publisher.dart';
import 'web_external_live.dart';

export 'web_external_live.dart';

class WebPublisher implements LivePublisher {
  WebPublisher({
    Future<String?> Function()? tokenProvider,
    Uri? box,
    int segmentMinutes = 15,
    int maxBitrateKbps = 2500,
    Future<void> Function(LiveAudioMix mix)? audioChanger,
    Future<void> Function(LiveAudioMix mix, {String? video, int? avOffsetMs})?
    audioSender,
    Future<void> Function(String id, int ms)? offsetSaver,
    S Function()? lang,
  });

  final _controller = StreamController<PublisherState>.broadcast();

  @override
  Stream<PublisherState> get states => _controller.stream;

  @override
  PublisherState get current =>
      const PublisherState(phase: PublisherPhase.error);

  @override
  Future<void> prepare(PublisherConfig c) async {}

  @override
  Future<void> start(PublisherTargets t) async =>
      throw UnsupportedError('Penerbit pelayar hanya ada di web');

  @override
  Future<void> startYoutube(String url) async =>
      throw UnsupportedError('Penerbit pelayar hanya ada di web');

  @override
  Future<void> stop() async {}

  @override
  Future<List<String>> sessionRecordings() async => const [];

  @override
  String? get recordingSessionId => null;

  @override
  Future<void> switchCamera() async {}

  @override
  void setMuted(bool muted) {}

  @override
  Widget preview(BuildContext context) => const SizedBox.shrink();

  // External camera (task C4): the browser publisher only exists on the web.

  Stream<ExternalLiveState> get external => const Stream.empty();
  ExternalLiveState get externalState => ExternalLiveState.idle;
  LiveAudioMix get externalMix => throw UnsupportedError(_off);

  Future<void> prepareExternal(
    PublisherConfig c, {
    LiveAudioMix? mix,
    bool cameraHasAudio = true,
    int fallbackOffsetMs = 0,
  }) async {}

  void applyBoxStatus(Map<String, dynamic> status) {}
  Future<void> setExternalMix(LiveAudioMix mix) async =>
      throw UnsupportedError(_off);
  Future<void> useMicOnly() async => throw UnsupportedError(_off);
  void setPreviewSound(bool on) {}
  void setFallbackOffset(int ms) {}
  Future<void> saveFallbackOffset() async => throw UnsupportedError(_off);
  Future<bool> switchToIpadCamera() async => false;
  Future<bool> switchToExternalCamera() async => false;

  static const String _off = 'Penerbit pelayar hanya ada di web';

  Future<void> dispose() => _controller.close();
}
