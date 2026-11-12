import 'dart:convert';
import 'dart:typed_data';

import 'device_key_android.dart'
    if (dart.library.js_interop) 'device_key_web.dart' as platform;
import 'device_key_software.dart';

/// The device's ECDSA P-256 signing key. The private half never leaves its store (Android
/// Keystore, browser WebCrypto with `extractable: false`); only signatures and the public JWK
/// do. Tests use [SoftwareDeviceKey].
abstract class DeviceKey {
  /// True when a usable key is present in the store.
  Future<bool> exists();

  /// Replaces any existing key with a fresh one and returns its public JWK, exactly
  /// `{kty: 'EC', crv: 'P-256', x, y}` (base64url, 32 bytes each, no padding).
  Future<Map<String, String>> generate();

  /// The public JWK of the stored key. Throws [StateError] when there is no key.
  Future<Map<String, String>> publicJwk();

  /// ECDSA P-256 / SHA-256 over [message]; always the 64-byte IEEE P1363 form `r||s`.
  Future<Uint8List> sign(Uint8List message);

  /// Deletes the key. Idempotent.
  Future<void> clear();
}

/// The device key for this platform: Android Keystore, or WebCrypto in the browser.
DeviceKey platformDeviceKey() => platform.createPlatformDeviceKey();

/// Signs a probe with the freshly generated key and checks it against the public JWK. If the
/// store returned a public key that does not match its private key (or a malformed signature)
/// the key is cleared and a [StateError] is thrown, so enrolment never sends a bad key.
Future<void> deviceKeySelfCheck(DeviceKey key, Map<String, String> jwk) async {
  try {
    final probe = Uint8List.fromList(utf8.encode('surau-self-check'));
    final sig = await key.sign(probe);
    if (sig.length != 64 || !verifyP256(jwk, probe, sig)) {
      throw StateError('self-check');
    }
  } catch (_) {
    await key.clear();
    throw StateError('Kunci peranti tidak sah. Cuba lagi');
  }
}

/// `utf8("surau-unlock\n" + boxId + "\n" + deviceId + "\n" + nonce)`, the signed unlock message
/// (apps/box-server/src/auth/sessions.ts, packages/device-client/src/index.ts).
Uint8List unlockMessage(String boxId, String deviceId, String nonce) =>
    Uint8List.fromList(utf8.encode('surau-unlock\n$boxId\n$deviceId\n$nonce'));

final RegExp _b64urlChars = RegExp(r'^[A-Za-z0-9_-]*$');

/// base64url without padding.
String b64url(Uint8List bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// Strict base64url decode: unpadded, URL-safe alphabet only.
Uint8List unB64url(String s) {
  if (!_b64urlChars.hasMatch(s) || s.length % 4 == 1) {
    throw const FormatException('base64url tidak sah');
  }
  final padded = s + '=' * ((4 - s.length % 4) % 4);
  return Uint8List.fromList(base64Url.decode(padded));
}

/// 32-byte big-endian, left-padded with zeros (JWK x/y and P1363 halves are fixed width).
Uint8List fixed32(BigInt v) {
  if (v.isNegative || v.bitLength > 256) {
    throw const FormatException('nilai di luar julat');
  }
  final out = Uint8List(32);
  var x = v;
  for (var i = 31; i >= 0; i--) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x = x >> 8;
  }
  return out;
}

/// Builds the JWK `{kty, crv, x, y}` from an uncompressed SEC1 point `04 || X || Y`.
Map<String, String> jwkFromUncompressedPoint(Uint8List point) {
  if (point.length != 65 || point[0] != 0x04) {
    throw const FormatException('titik kunci awam tidak sah');
  }
  return {
    'kty': 'EC',
    'crv': 'P-256',
    'x': b64url(Uint8List.sublistView(point, 1, 33)),
    'y': b64url(Uint8List.sublistView(point, 33, 65)),
  };
}

/// Converts an ASN.1 DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`, what Java's
/// `SHA256withECDSA` returns) to the fixed 64-byte IEEE P1363 `r||s` form. Strict: any defect
/// throws [FormatException]. The `0x00` sign padding on a high-bit value is removed, a value
/// shorter than 32 bytes is left-padded, so the output is always exactly 64 bytes.
Uint8List derToP1363(Uint8List der) {
  const bad = FormatException('tandatangan DER tidak sah');
  var p = 0;

  int readByte() {
    if (p >= der.length) throw bad;
    return der[p++];
  }

  int readLen() {
    final b = readByte();
    if (b < 0x80) return b;
    throw bad; // P-256 DER is at most 72 bytes: long-form lengths never occur
  }

  if (readByte() != 0x30) throw bad;
  final seqLen = readLen();
  if (p + seqLen != der.length) throw bad;

  Uint8List readInt() {
    if (readByte() != 0x02) throw bad;
    final len = readLen();
    if (len == 0 || p + len > der.length) throw bad;
    var start = p;
    final end = p + len;
    p = end;
    if (der[start] & 0x80 != 0) throw bad; // negative
    // Strip sign padding / leading zeros, but keep at least one byte.
    while (start < end - 1 && der[start] == 0) {
      start++;
    }
    final v = Uint8List.sublistView(der, start, end);
    if (v.length > 32) throw bad;
    if (v.every((b) => b == 0)) throw bad; // r, s must be non-zero
    return v;
  }

  final r = readInt();
  final s = readInt();
  if (p != der.length) throw bad;

  final out = Uint8List(64);
  out.setRange(32 - r.length, 32, r);
  out.setRange(64 - s.length, 64, s);
  return out;
}
