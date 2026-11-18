// [L8] The Dart twin of core's camera address rules gives the same reason as
// the box for every shared vector (apps/box-server/test/cameraUrlVectors.test.ts
// reads the same file).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/camera_url.dart';

void main() {
  final vectors = (jsonDecode(
    File('test/fixtures/vectors/camera-url-vectors.json').readAsStringSync(),
  ) as List).cast<Map<String, dynamic>>();

  for (final v in vectors) {
    test('[L8] ${v['name']}', () {
      var url = v['url'] as String;
      final repeat = v['repeat'];
      if (repeat is Map) url += (repeat['char'] as String) * (repeat['times'] as int);
      final ips = [for (final i in (v['boxIps'] as List? ?? const [])) i as String];
      expect(cameraAddressReason(url, boxIps: ips), v['reason']);
    });
  }

  test('[L8] the field limit is 400', () {
    expect(cameraUrlMax, 400);
  });
}
