// pickThemeFile on what the VM can run: the Android channel contract (mocked) with the .maxtheme rules, and no
// pick elsewhere. The web input is the same code path as the prayer-data pick (test/web/file_pick_web_test.dart).

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/prayer/file_pick.dart';
import 'package:surau_app/features/prayer/file_pick_android.dart' as android;
import 'package:surau_app/features/theme/theme_api.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    android.debugAndroid = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(android.channel, null);
  });

  void mock(Future<Object?> Function(MethodCall c) h) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(android.channel, h);

  test('a theme file name is offered to the picker and required on the native side', () async {
    android.debugAndroid = true;
    MethodCall? seen;
    mock((c) async {
      seen = c;
      return {'name': 'hijau-siti.maxtheme', 'bytes': Uint8List.fromList([1, 2, 3])};
    });
    final r = await pickThemeFile();
    final a = seen!.arguments as Map;
    expect(a['maxBytes'], packMaxBytes);
    expect(a['suffix'], '.maxtheme');
    expect(a['mimeTypes'], containsAll(['application/octet-stream', 'application/zip']));
    expect(r!.name, 'hijau-siti.maxtheme');
    expect(r.bytes, [1, 2, 3]);
    expect(r.tooBig || r.wrongType || r.unreadable, isFalse);
  });

  test('the type is checked again here: a name without .maxtheme is wrong, whatever the platform said', () async {
    android.debugAndroid = true;
    mock((c) async => {'name': 'a.zip', 'bytes': Uint8List.fromList([1])});
    expect((await pickThemeFile())!.wrongType, isTrue);
    mock((c) async => {'name': 'HIJAU.MAXTHEME', 'bytes': Uint8List.fromList([1])});
    expect((await pickThemeFile())!.name, 'HIJAU.MAXTHEME');
    mock((c) async => {'name': 'a.maxtheme.exe', 'bytes': Uint8List.fromList([1])});
    expect((await pickThemeFile())!.wrongType, isTrue);
  });

  test('the platform can say wrong type or too big without sending bytes', () async {
    android.debugAndroid = true;
    mock((c) async => {'name': 'notes.txt', 'wrongType': true});
    expect((await pickThemeFile())!.wrongType, isTrue);
    mock((c) async => {'name': 'big.maxtheme', 'tooBig': true});
    expect((await pickThemeFile())!.tooBig, isTrue);
  });

  test('a file over 15 MB is too big even if the platform let it through; an empty file is unreadable', () async {
    android.debugAndroid = true;
    mock((c) async => {'name': 'big.maxtheme', 'bytes': Uint8List(packMaxBytes + 1)});
    expect((await pickThemeFile())!.tooBig, isTrue);
    mock((c) async => {'name': 'empty.maxtheme', 'bytes': Uint8List(0)});
    expect((await pickThemeFile())!.unreadable, isTrue);
  });

  test('backing out gives null; a native error gives null; off Android there is no pick', () async {
    android.debugAndroid = true;
    mock((c) async => null);
    expect(await pickThemeFile(), isNull);
    mock((c) async => throw PlatformException(code: 'unreadable'));
    expect(await pickThemeFile(), isNull);
    android.debugAndroid = false;
    var called = false;
    mock((c) async {
      called = true;
      return null;
    });
    expect(await pickThemeFile(), isNull);
    expect(called, isFalse);
    expect(themeFilePickSupported, isFalse);
  });

  test('mimeTypesFor knows maxtheme', () {
    expect(mimeTypesFor(['maxtheme']), contains('application/vnd.maxcom.theme+zip'));
  });
}
