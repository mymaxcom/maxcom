// Plan 14 section 3.4 B: one source, two builds. `kOpsBuild` is true only in
// the private MAXCOM Ops build (`build-app.ps1 -Apk -Ops` passes
// --dart-define=MAXCOM_OPS=true; the Gradle side reads the same define, so the
// Android identity and this switch cannot drift). All ops-only code lives under
// lib/ops/ and is reached only through `if (kOpsBuild)`, so the release
// compiler drops it from the public binary. The web build is always public.

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

const bool kOpsBuild = bool.fromEnvironment('MAXCOM_OPS');

const String _publicId = 'my.maxcom.app';
const String _opsId = 'my.maxcom.app.ops';

/// True when the Android package name belongs to the build variant.
bool opsIdentityMatches({required bool ops, required String packageName}) =>
    packageName == (ops ? _opsId : _publicId);

/// Start-up belt: the compiled switch and the installed package name must
/// agree, else the app refuses to run. A platform with no channel (a desktop
/// test run) cannot be checked and passes; the web build passes only as public.
Future<bool> buildIdentityOk({bool? isWeb}) async {
  if (isWeb ?? kIsWeb) return !kOpsBuild;
  try {
    final name = await const MethodChannel('my.maxcom/build').invokeMethod<String>('packageName');
    return opsIdentityMatches(ops: kOpsBuild, packageName: name ?? '');
  } on MissingPluginException {
    return true;
  } on PlatformException {
    return false;
  }
}
