import 'dart:io' show Platform;

import 'package:flutter/services.dart';

import 'discovery.dart';

BoxDiscovery platformDiscovery() =>
    Platform.isAndroid ? _AndroidDiscovery() : const NoDiscovery();

class _AndroidDiscovery implements BoxDiscovery {
  static const MethodChannel _channel = MethodChannel('my.maxcom.app/discovery');

  @override
  Future<List<DiscoveredBox>> discover({
    Duration timeout = const Duration(milliseconds: 1500),
  }) async {
    try {
      final raw = await _channel
          .invokeMethod<Object?>('discover', {'timeoutMs': timeout.inMilliseconds})
          .timeout(timeout + const Duration(seconds: 2));
      return parseDiscovered(raw);
    } on Object {
      return const [];
    }
  }
}
