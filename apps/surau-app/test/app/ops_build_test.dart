// Plan 14 Task 24: the build switch. `flutter test` runs both ways:
// default (public) and with --dart-define=MAXCOM_OPS=true (ops).

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/ops/ops_build.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const expectOps = bool.fromEnvironment('MAXCOM_OPS');

  test('kOpsBuild follows the MAXCOM_OPS dart-define (false by default)', () {
    expect(kOpsBuild, expectOps);
  });

  test('the package name must agree with the build variant', () {
    expect(opsIdentityMatches(ops: false, packageName: 'my.maxcom.app'), isTrue);
    expect(opsIdentityMatches(ops: true, packageName: 'my.maxcom.app.ops'), isTrue);
    expect(opsIdentityMatches(ops: false, packageName: 'my.maxcom.app.ops'), isFalse);
    expect(opsIdentityMatches(ops: true, packageName: 'my.maxcom.app'), isFalse);
    expect(opsIdentityMatches(ops: true, packageName: ''), isFalse);
    expect(opsIdentityMatches(ops: false, packageName: 'my.maxcom.app.opsx'), isFalse);
  });

  test('buildIdentityOk reads the package name from the platform', () async {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    const ch = MethodChannel('my.maxcom/build');
    final own = kOpsBuild ? 'my.maxcom.app.ops' : 'my.maxcom.app';
    final other = kOpsBuild ? 'my.maxcom.app' : 'my.maxcom.app.ops';
    messenger.setMockMethodCallHandler(ch, (c) async => own);
    expect(await buildIdentityOk(), isTrue);
    messenger.setMockMethodCallHandler(ch, (c) async => other);
    expect(await buildIdentityOk(), isFalse);
    messenger.setMockMethodCallHandler(ch, (c) async => throw PlatformException(code: 'x'));
    expect(await buildIdentityOk(), isFalse);
    messenger.setMockMethodCallHandler(ch, null);
  });

  test('with no channel (a desktop test run) the check passes', () async {
    expect(await buildIdentityOk(), isTrue);
  });

  test('the web build is public: an ops flag on web is a mismatch', () async {
    expect(await buildIdentityOk(isWeb: true), !kOpsBuild);
  });
}
