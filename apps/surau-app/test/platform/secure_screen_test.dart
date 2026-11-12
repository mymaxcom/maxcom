import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/platform/secure_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final calls = <String>[];
  const channel = MethodChannel(SecureScreen.channelName);

  setUp(() {
    calls.clear();
    SecureScreen.debugReset();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    SecureScreen.debugReset();
  });

  test('enable and disable call secure/enable and secure/disable on the channel', () async {
    await SecureScreen.enable();
    await SecureScreen.disable();
    expect(calls, ['secure/enable', 'secure/disable']);
  });

  test('on the web both are no-ops', () async {
    SecureScreen.debugOverride(isWeb: true);
    await SecureScreen.enable();
    await SecureScreen.disable();
    expect(calls, isEmpty);
  });

  test('a platform without the channel does not throw', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    await SecureScreen.enable();
    await SecureScreen.disable();
  });

  test('a platform error is swallowed (blocking is best effort)', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(code: 'boom');
    });
    await SecureScreen.enable();
  });
}
