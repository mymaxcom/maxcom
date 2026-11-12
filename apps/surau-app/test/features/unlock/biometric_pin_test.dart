import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/unlock/biometric_pin.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('my.maxcom/keystore');
  final calls = <MethodCall>[];

  void mock(Future<Object?> Function(MethodCall) h) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (c) {
      calls.add(c);
      return h(c);
    });
  }

  setUp(calls.clear);
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
  );

  test('available asks the channel', () async {
    mock((c) async => true);
    expect(await AndroidBiometricPin().available(), isTrue);
    expect(calls.single.method, 'available');
  });

  test('available is false when the channel is absent or errors', () async {
    expect(await AndroidBiometricPin().available(), isFalse);
    mock((c) async => throw PlatformException(code: 'x'));
    expect(await AndroidBiometricPin().available(), isFalse);
  });

  test('seal and open use the agreed method names and shapes', () async {
    mock((c) async => c.method == 'openPin' ? '123456' : null);
    final b = AndroidBiometricPin();
    await b.seal('123456');
    expect(await b.open(), '123456');
    await b.clear();
    expect(calls.map((c) => c.method), ['sealPin', 'openPin', 'clearSealedPin']);
    expect(calls.first.arguments, {'pin': '123456'});
  });

  test('seal returns false and clears when the prompt is cancelled', () async {
    mock((c) async => c.method == 'sealPin' ? throw PlatformException(code: 'cancelled') : null);
    expect(await AndroidBiometricPin().seal('123456'), isFalse);
    expect(calls.map((c) => c.method), ['sealPin', 'clearSealedPin']);
  });

  test('open tells cancel and lockout apart; other failures are null', () async {
    mock((c) async => throw PlatformException(code: 'cancelled'));
    await expectLater(AndroidBiometricPin().open(), throwsA(isA<BiometricCancelled>()));
    mock((c) async => throw PlatformException(code: 'lockout'));
    await expectLater(AndroidBiometricPin().open(), throwsA(isA<BiometricLockedOut>()));
    mock((c) async => throw PlatformException(code: 'auth_error'));
    expect(await AndroidBiometricPin().open(), isNull);
  });

  test('hasSealedPin reads the channel', () async {
    mock((c) async => true);
    expect(await AndroidBiometricPin().hasSealedPin(), isTrue);
  });
}
