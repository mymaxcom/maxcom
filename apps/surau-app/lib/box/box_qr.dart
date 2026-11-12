// The box's signed QR codes (`maxcom1:` + base64url JSON): setup, recovery
// and network probe. The Dart twin of packages/core/src/setup/boxQr.ts; the
// shared vectors in packages/core/test/fixtures/box-qr-vectors.json pin both
// sides byte for byte (test/box/box_qr_test.dart reads them in place).
//
// A payload is trusted only after ALL of these hold: only the listed keys and
// sizes, `keyFp == sha256(pub)`, and the signature over the canonical message
// verifies with `pub`. The phone then still compares `boxId` and `keyFp` with
// what the box answers over HTTPS (setup_client.dart `checkBoxMatches`).

import 'dart:convert';
import 'dart:typed_data';

import '../sync/canonical.dart';
import 'device_key.dart';
import 'device_key_software.dart' show verifyP256;

/// What a scanned QR is.
enum ScannedKind { enrol, setup, recovery, probe, unknown }

/// The scanned text is not a valid, correctly signed box QR.
class BoxQrInvalid implements Exception {
  const BoxQrInvalid([this.message = 'Kod QR tidak sah']);

  final String message;

  @override
  String toString() => 'BoxQrInvalid($message)';
}

const String boxQrPrefix = 'maxcom1:';
const String _enrolPrefix = 'surau1:';

/// Tells the kind of QR from its text without verifying anything: `surau1:`
/// is an enrolment, `maxcom1:` is read by its `type`. Junk is [unknown].
ScannedKind kindOf(String text) {
  final t = text.trim();
  if (t.startsWith(_enrolPrefix)) return ScannedKind.enrol;
  if (!t.startsWith(boxQrPrefix) || t.length > _maxText) return ScannedKind.unknown;
  try {
    final m = _decode(t.substring(boxQrPrefix.length));
    switch (m['type']) {
      case 'setup':
        return ScannedKind.setup;
      case 'recovery':
        return ScannedKind.recovery;
      case 'probe':
        return ScannedKind.probe;
    }
  } on BoxQrInvalid {
    // fall through
  }
  return ScannedKind.unknown;
}

const int _maxText = 4096;
const Set<String> _keys = {
  'v', 'type', 'boxId', 'keyFp', 'name', 'box', 'caSha256', 'linked', 'cloud', 'nonce', 'iat', 'exp', 'pub', 'sig',
};
final RegExp _hex16 = RegExp(r'^[0-9a-f]{16}$');
final RegExp _hex64 = RegExp(r'^[0-9a-f]{64}$');
final RegExp _nonce = RegExp(r'^[A-Za-z0-9_-]{43}$');
final RegExp _sig = RegExp(r'^[A-Za-z0-9_-]{86}$');
final RegExp _coord = RegExp(r'^[A-Za-z0-9_-]{43}$');
final RegExp _b64urlChars = RegExp(r'^[A-Za-z0-9_-]*$');

Map<String, dynamic> _decode(String text) {
  try {
    if (!_b64urlChars.hasMatch(text) || text.length % 4 == 1) throw const BoxQrInvalid();
    final padded = text + '=' * ((4 - text.length % 4) % 4);
    final raw = jsonDecode(utf8.decode(base64Url.decode(padded)));
    if (raw is! Map<String, dynamic>) throw const BoxQrInvalid();
    return raw;
  } on FormatException {
    throw const BoxQrInvalid();
  } on ArgumentError {
    throw const BoxQrInvalid();
  }
}

/// True for `https://host[:port]` with nothing else, written exactly as its own origin would be.
bool _isHttpsOrigin(Object? s, {required bool allowEmpty}) {
  if (s == '') return allowEmpty;
  if (s is! String || s.length > 200) return false;
  final Uri u;
  try {
    u = Uri.parse(s);
  } on FormatException {
    return false;
  }
  if (u.scheme != 'https' || u.host.isEmpty) return false;
  if (u.userInfo.isNotEmpty || u.hasQuery || u.hasFragment || u.path.isNotEmpty) return false;
  final host = u.host.contains(':') ? '[${u.host}]' : u.host;
  final origin = u.hasPort && u.port != 443 ? 'https://$host:${u.port}' : 'https://$host';
  return origin == s;
}

/// First 16 hex of sha256 of the canonical `{crv,kty,x,y}`.
String keyFingerprint(Map<String, dynamic> pub) => sha256HexOf(
  utf8.encode(canonicalJson({'crv': pub['crv'], 'kty': pub['kty'], 'x': pub['x'], 'y': pub['y']})),
).substring(0, 16);

/// `'4F2A 9C1E 77B0 D3A1'` from 16 hex.
String fingerprintGroupsOf(String fp) {
  final up = fp.toUpperCase();
  final groups = <String>[];
  for (var i = 0; i < up.length; i += 4) {
    groups.add(up.substring(i, i + 4 > up.length ? up.length : i + 4));
  }
  return groups.join(' ');
}

class BoxQrPayload {
  const BoxQrPayload._({
    required this.type,
    required this.boxId,
    required this.keyFp,
    required this.name,
    required this.box,
    required this.caSha256,
    required this.linked,
    required this.cloud,
    required this.nonce,
    required this.iat,
    required this.exp,
    required this.pub,
    required this.sig,
    required Map<String, dynamic> raw,
    // ignore: prefer_initializing_formals
  }) : _raw = raw;

  /// 'setup', 'recovery' or 'probe'.
  final String type;
  final String boxId;
  final String keyFp;
  final String name;

  /// `https://host:port`, or '' when the box has no HTTPS.
  final String box;
  final String? caSha256;
  final bool linked;
  final String? cloud;
  final String nonce;

  /// Unix seconds.
  final int iat;
  final int exp;
  final Map<String, String> pub;
  final String sig;
  final Map<String, dynamic> _raw;

  /// Strict parse of a `maxcom1:` text. Throws [BoxQrInvalid] for a bad shape, a `keyFp` that is not
  /// `sha256(pub)`, a signature that does not verify, or (with [requireCa], Android) a payload with no HTTPS
  /// address or no CA fingerprint: the app pins the box's own CA and never falls back to system roots.
  static BoxQrPayload parse(String text, {required bool requireCa}) {
    final t = text.trim();
    if (!t.startsWith(boxQrPrefix) || t.length > _maxText) throw const BoxQrInvalid();
    final r = _decode(t.substring(boxQrPrefix.length));
    for (final k in r.keys) {
      if (!_keys.contains(k)) throw const BoxQrInvalid();
    }
    final type = r['type'];
    final pubRaw = r['pub'];
    final iat = r['iat'];
    final exp = r['exp'];
    final ca = r['caSha256'];
    final cloud = r['cloud'];
    if (r['v'] != 1 ||
        (type != 'setup' && type != 'recovery' && type != 'probe') ||
        r['boxId'] is! String || !_hex16.hasMatch(r['boxId'] as String) ||
        r['keyFp'] is! String || !_hex16.hasMatch(r['keyFp'] as String) ||
        r['name'] is! String || (r['name'] as String).isEmpty || (r['name'] as String).length > 60 ||
        !_isHttpsOrigin(r['box'], allowEmpty: true) ||
        !(ca == null || (ca is String && _hex64.hasMatch(ca))) ||
        r['linked'] is! bool ||
        (r.containsKey('cloud') && !_isHttpsOrigin(cloud, allowEmpty: false)) ||
        r['nonce'] is! String || !_nonce.hasMatch(r['nonce'] as String) ||
        iat is! int || exp is! int || iat <= 0 || exp <= iat ||
        r['sig'] is! String || !_sig.hasMatch(r['sig'] as String) ||
        pubRaw is! Map<String, dynamic> ||
        pubRaw.length != 4 ||
        pubRaw['kty'] != 'EC' || pubRaw['crv'] != 'P-256' ||
        pubRaw['x'] is! String || !_coord.hasMatch(pubRaw['x'] as String) ||
        pubRaw['y'] is! String || !_coord.hasMatch(pubRaw['y'] as String)) {
      throw const BoxQrInvalid();
    }
    if (r['keyFp'] != keyFingerprint(pubRaw)) throw const BoxQrInvalid();
    if (requireCa && (r['box'] == '' || ca == null)) throw const BoxQrInvalid();
    final payload = BoxQrPayload._(
      type: type as String,
      boxId: r['boxId'] as String,
      keyFp: r['keyFp'] as String,
      name: r['name'] as String,
      box: r['box'] as String,
      caSha256: ca as String?,
      linked: r['linked'] as bool,
      cloud: cloud as String?,
      nonce: r['nonce'] as String,
      iat: iat,
      exp: exp,
      pub: {'kty': 'EC', 'crv': 'P-256', 'x': pubRaw['x'] as String, 'y': pubRaw['y'] as String},
      sig: r['sig'] as String,
      raw: r,
    );
    if (!payload.verifySignature()) throw const BoxQrInvalid();
    return payload;
  }

  /// `utf8("maxcom-qr\n<boxId>\n<type>\n<sha256 hex of canonicalJson(payload without sig)>")`.
  Uint8List get message {
    final rest = Map<String, dynamic>.of(_raw)..remove('sig');
    return Uint8List.fromList(
      utf8.encode('maxcom-qr\n$boxId\n$type\n${sha256HexOf(utf8.encode(canonicalJson(rest)))}'),
    );
  }

  /// ECDSA P-256 / SHA-256 (r||s) over [message] with the payload's own `pub`.
  bool verifySignature() {
    try {
      return verifyP256(pub, message, unB64url(sig));
    } on Object {
      return false;
    }
  }

  /// `exp` is in the past on this phone's clock.
  bool isExpired(DateTime now) => exp * 1000 <= now.millisecondsSinceEpoch;

  DateTime get expiresAt => DateTime.fromMillisecondsSinceEpoch(exp * 1000);

  String get fingerprintGroups => fingerprintGroupsOf(keyFp);

  String get boxIdGroups => fingerprintGroupsOf(boxId);
}
