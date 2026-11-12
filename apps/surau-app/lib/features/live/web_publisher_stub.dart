// Off the web there is no browser publisher. The class exists so shared
// code (`publisherFor`) compiles on every platform; it never goes live.

import 'dart:async';

import 'package:flutter/widgets.dart';

import 'publisher.dart';

class WebPublisher implements LivePublisher {
  WebPublisher({
    Future<String?> Function()? tokenProvider,
    Uri? box,
    int segmentMinutes = 15,
    int maxBitrateKbps = 2500,
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
  Future<void> switchCamera() async {}

  @override
  void setMuted(bool muted) {}

  @override
  Widget preview(BuildContext context) => const SizedBox.shrink();

  Future<void> dispose() => _controller.close();
}
