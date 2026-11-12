// pickFile on the platforms the VM can run: the Android channel contract
// (mocked), the MIME list, and the stub where there is no pick. The web
// input is proved in test/web/file_pick_web_test.dart (browser).
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/prayer/file_pick.dart';
import 'package:surau_app/features/prayer/file_pick_android.dart' as android;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    android.debugAndroid = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(android.channel, null);
  });

  void mock(Future<Object?> Function(MethodCall c) h) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(android.channel, h);

  test('mime types follow the extensions, no duplicates', () {
    expect(mimeTypesFor(['csv']), ['text/csv', 'text/comma-separated-values']);
    expect(mimeTypesFor(['csv', 'xlsx', 'zip', 'CSV']), [
      'text/csv',
      'text/comma-separated-values',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
    ]);
    expect(mimeTypesFor(['exe']), isEmpty);
  });

  test('Android sends the types and the cap, and returns the bytes', () async {
    android.debugAndroid = true;
    MethodCall? seen;
    mock((c) async {
      seen = c;
      return {
        'name': 'waktu.csv',
        'bytes': Uint8List.fromList([1, 2, 3]),
      };
    });
    final f = await pickFile(extensions: ['csv', 'xlsx'], maxBytes: 4096);
    expect(seen!.method, 'pick');
    expect((seen!.arguments as Map)['maxBytes'], 4096);
    expect((seen!.arguments as Map)['mimeTypes'], contains('text/csv'));
    expect(f, isNotNull);
    expect(f!.name, 'waktu.csv');
    expect(f.bytes, [1, 2, 3]);
    expect(f.tooBig, isFalse);
  });

  test('Android: over the cap is tooBig with no bytes', () async {
    android.debugAndroid = true;
    mock((c) async => {'name': 'big.xlsx', 'tooBig': true});
    final f = await pickFile(extensions: ['xlsx'], maxBytes: 10);
    expect(f!.tooBig, isTrue);
    expect(f.name, 'big.xlsx');
    expect(f.bytes, isEmpty);
  });

  test('Android: backing out gives null; a native error gives null', () async {
    android.debugAndroid = true;
    mock((c) async => null);
    expect(await pickFile(extensions: ['csv'], maxBytes: 10), isNull);
    mock((c) async => throw PlatformException(code: 'unreadable'));
    expect(await pickFile(extensions: ['csv'], maxBytes: 10), isNull);
  });

  test('off Android there is no pick and the channel is not called', () async {
    android.debugAndroid = false;
    var called = false;
    mock((c) async {
      called = true;
      return null;
    });
    expect(await pickFile(extensions: ['csv'], maxBytes: 10), isNull);
    expect(called, isFalse);
    expect(filePickSupported, isFalse);
  });

  test('on Android the pick is supported', () {
    android.debugAndroid = true;
    expect(filePickSupported, isTrue);
  });
}
