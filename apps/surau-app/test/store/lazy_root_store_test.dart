// Gate fix Q3: concurrent first calls on the lazy Android store share ONE
// instance (one folder lookup), and a failed creation is retried.

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/device_key_android.dart' show keystoreChannelName;
import 'package:surau_app/store/local_store_android.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const ch = MethodChannel(keystoreChannelName);
  late Directory tmp;
  var dirCalls = 0;
  var failFirst = false;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('lazy_root');
    dirCalls = 0;
    failFirst = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(ch, (call) async {
          if (call.method == 'localDir') {
            dirCalls++;
            await Future<void>.delayed(const Duration(milliseconds: 20));
            if (failFirst && dirCalls == 1) {
              throw PlatformException(code: 'keystore_failed');
            }
            return tmp.path;
          }
          return null;
        });
  });

  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(ch, null);
    await tmp.delete(recursive: true);
  });

  test('concurrent first calls build one inner store', () async {
    final s = androidLocalStore();
    await Future.wait([
      s.setMeta('a', '1').catchError((_) {}),
      s.meta().catchError((_) => <String, String>{}),
      s.meta().catchError((_) => <String, String>{}),
    ]);
    expect(dirCalls, 1);
  });

  test('a failed creation is retried on the next call', () async {
    failFirst = true;
    final s = androidLocalStore();
    await expectLater(s.meta(), throwsA(anything));
    await s.meta().catchError((_) => <String, String>{});
    expect(dirCalls, 2);
  });
}
