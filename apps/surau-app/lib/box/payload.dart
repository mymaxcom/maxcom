import 'dart:convert';

import 'package:flutter/foundation.dart' show kDebugMode;

/// Enrolment payload shown as a QR by the box (`surau1:` + base64url JSON).
/// Port of `parseEnrolPayload` in packages/device-client/src/index.ts.
class EnrolPayload {
  const EnrolPayload({
    required this.mode,
    required this.box,
    required this.boxId,
    required this.caSha256,
    required this.code,
    required this.user,
    required this.exp,
    this.pinSet,
    this.appLock,
    this.cloud,
  });

  /// 'ip' or 'domain'.
  final String mode;

  /// Origin only, for example `https://<box-ip>:8443`.
  final String box;
  final String boxId;

  /// Lower-case hex sha256 of the root CA, or null.
  final String? caSha256;
  final String code;
  final String user;

  /// Expiry, epoch milliseconds.
  final int exp;

  /// Whether the box already holds a PIN for this person: true, false, or
  /// null for a payload from an older box (the app then asks).
  final bool? pinSet;

  /// Whether the box's app lock is on: false means the app opens with the
  /// device key alone (no PIN step); null for a payload from an older box
  /// (the app then behaves as if the lock is on).
  final bool? appLock;

  /// Origin of the cloud copy (Plan 6), when the box has one linked; null
  /// for a box without cloud sync or a payload from an older box.
  final String? cloud;

  static const String _prefix = 'surau1:';
  static const String _bad = 'Kod QR pendaftaran tidak sah';

  static final RegExp _boxId = RegExp(r'^[0-9a-f]{16}$');
  static final RegExp _code = RegExp(
    r'^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$',
  );
  static final RegExp _sha = RegExp(r'^[0-9a-fA-F]{64}$');
  static final RegExp _b64url = RegExp(r'^[A-Za-z0-9_-]*$');

  /// Only the phone itself, as `network_security_config.xml` allows.
  static bool _isLoopback(String host) => host == '127.0.0.1';

  /// [requireCa]: the app pins the box's root CA itself (Android), so a
  /// payload without `caSha256` is refused like any other bad QR; an
  /// unpinned client would trust the system roots instead of the surau's
  /// own CA. [allowLoopback]: plain `http://127.0.0.1` for a box on the
  /// same machine, for debug builds only (the default is [kDebugMode]).
  static EnrolPayload parse(
    String s, {
    bool requireCa = false,
    bool allowLoopback = kDebugMode,
  }) {
    if (!s.startsWith(_prefix) || s.length > 4096) {
      throw const FormatException(_bad);
    }
    final Object? raw;
    try {
      final text = s.substring(_prefix.length);
      if (!_b64url.hasMatch(text) || text.length % 4 == 1) {
        throw const FormatException(_bad);
      }
      final padded = text + '=' * ((4 - text.length % 4) % 4);
      raw = jsonDecode(utf8.decode(base64Url.decode(padded)));
    } on FormatException {
      throw const FormatException(_bad);
    } on ArgumentError {
      throw const FormatException(_bad);
    }
    if (raw is! Map<String, dynamic>) throw const FormatException(_bad);
    final p = raw;
    final mode = p['mode'];
    if (p['v'] != 1 || (mode != 'ip' && mode != 'domain')) {
      throw const FormatException(_bad);
    }
    final box = p['box'];
    final boxId = p['boxId'];
    final code = p['code'];
    final user = p['user'];
    final exp = p['exp'];
    final ca = p['caSha256'];
    if (box is! String || boxId is! String || !_boxId.hasMatch(boxId)) {
      throw const FormatException(_bad);
    }
    if (code is! String || !_code.hasMatch(code)) {
      throw const FormatException(_bad);
    }
    if (user is! String || user.length > 80) throw const FormatException(_bad);
    if (exp is! num || !exp.isFinite) throw const FormatException(_bad);
    if (ca != null && !(ca is String && _sha.hasMatch(ca))) {
      throw const FormatException(_bad);
    }
    if (requireCa && ca == null) throw const FormatException(_bad);
    final pinSet = p['pinSet'];
    if (pinSet != null && pinSet is! bool) throw const FormatException(_bad);
    final appLock = p['appLock'];
    if (appLock != null && appLock is! bool) throw const FormatException(_bad);
    final origin = _originOf(box, allowLoopback);
    final cloudRaw = p['cloud'];
    if (cloudRaw != null && cloudRaw is! String) {
      throw const FormatException(_bad);
    }
    final cloudOrigin = cloudRaw == null
        ? null
        : _originOf(cloudRaw as String, allowLoopback);
    return EnrolPayload(
      mode: mode as String,
      box: origin,
      boxId: boxId,
      caSha256: ca == null ? null : (ca as String).toLowerCase(),
      code: code,
      user: user,
      exp: exp.toInt(),
      pinSet: pinSet as bool?,
      appLock: appLock as bool?,
      cloud: cloudOrigin,
    );
  }

  static String _originOf(String text, bool allowLoopback) {
    final Uri url;
    try {
      url = Uri.parse(text);
    } on FormatException {
      throw const FormatException(_bad);
    }
    final okScheme =
        url.scheme == 'https' ||
        (allowLoopback && url.scheme == 'http' && _isLoopback(url.host));
    if (!okScheme || url.host.isEmpty) throw const FormatException(_bad);
    if (url.userInfo.isNotEmpty || url.hasQuery || url.hasFragment) {
      throw const FormatException(_bad);
    }
    if (url.path != '' && url.path != '/') throw const FormatException(_bad);
    // Like `new URL(...).origin`: the scheme's default port is dropped.
    final defaultPort = url.scheme == 'https' ? 443 : 80;
    return url.hasPort && url.port != defaultPort
        ? '${url.scheme}://${url.host}:${url.port}'
        : '${url.scheme}://${url.host}';
  }
}
