import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'device_key.dart';

final ECDomainParameters _p256 = ECDomainParameters('prime256v1');

/// Software ECDSA P-256 key. FOR TESTS ONLY (and as the verifier): a production device key lives
/// in the Android Keystore or WebCrypto and is never held in Dart memory.
class SoftwareDeviceKey implements DeviceKey {
  SoftwareDeviceKey._(this._d, this._jwk);

  /// Loads a private JWK (`kty, crv, x, y, d`).
  factory SoftwareDeviceKey.fromJwk(Map<String, dynamic> privateJwk) {
    final d = privateJwk['d'];
    if (privateJwk['kty'] != 'EC' ||
        privateJwk['crv'] != 'P-256' ||
        d is! String) {
      throw const FormatException('JWK peribadi tidak sah');
    }
    final dBytes = unB64url(d);
    if (dBytes.length != 32) throw const FormatException('JWK peribadi tidak sah');
    final dInt = _toBigInt(dBytes);
    final pub = _p256.G * dInt;
    final jwk = _jwkOf(pub!);
    final claimed = {'x': privateJwk['x'], 'y': privateJwk['y']};
    if (claimed['x'] != jwk['x'] || claimed['y'] != jwk['y']) {
      throw const FormatException('JWK peribadi tidak sepadan');
    }
    return SoftwareDeviceKey._(dInt, jwk);
  }

  /// A fresh random key (tests).
  factory SoftwareDeviceKey.random() {
    final gen = ECKeyGenerator()
      ..init(ParametersWithRandom(
          ECKeyGeneratorParameters(_p256), _secureRandom()));
    final pair = gen.generateKeyPair();
    final priv = pair.privateKey;
    final pub = pair.publicKey;
    return SoftwareDeviceKey._(priv.d!, _jwkOf(pub.Q!));
  }

  BigInt? _d;
  Map<String, String>? _jwk;

  @override
  Future<bool> exists() async => _d != null;

  @override
  Future<Map<String, String>> generate() async {
    final k = SoftwareDeviceKey.random();
    _d = k._d;
    _jwk = k._jwk;
    return Map<String, String>.of(_jwk!);
  }

  @override
  Future<Map<String, String>> publicJwk() async {
    final j = _jwk;
    if (j == null) throw StateError('Kunci peranti tiada');
    return Map<String, String>.of(j);
  }

  @override
  Future<Uint8List> sign(Uint8List message) async {
    final d = _d;
    if (d == null) throw StateError('Kunci peranti tiada');
    // RFC 6979 deterministic nonce: no RNG needed and no nonce reuse across messages.
    final signer = ECDSASigner(SHA256Digest(), HMac(SHA256Digest(), 64))
      ..init(true, PrivateKeyParameter<ECPrivateKey>(ECPrivateKey(d, _p256)));
    final sig = signer.generateSignature(message) as ECSignature;
    final out = Uint8List(64)
      ..setRange(0, 32, fixed32(sig.r))
      ..setRange(32, 64, fixed32(sig.s));
    return out;
  }

  @override
  Future<void> clear() async {
    _d = null;
    _jwk = null;
  }
}

SecureRandom _secureRandom() {
  final rnd = Random.secure();
  final seed = Uint8List.fromList(List.generate(32, (_) => rnd.nextInt(256)));
  return FortunaRandom()..seed(KeyParameter(seed));
}

BigInt _toBigInt(Uint8List b) {
  var v = BigInt.zero;
  for (final x in b) {
    v = (v << 8) | BigInt.from(x);
  }
  return v;
}

Map<String, String> _jwkOf(ECPoint q) {
  final x = q.x!.toBigInteger()!;
  final y = q.y!.toBigInteger()!;
  return {
    'kty': 'EC',
    'crv': 'P-256',
    'x': b64url(fixed32(x)),
    'y': b64url(fixed32(y)),
  };
}

/// Verifies an ECDSA P-256 / SHA-256 signature in the 64-byte P1363 form. Mirrors the box's
/// `verifyP256` (apps/box-server/src/auth/crypto.ts): only a clean public JWK (`kty, crv, x, y`
/// and nothing else), a point on the curve, `0 < r, s < n`; any failure returns false.
bool verifyP256(
  Map<String, String> publicJwk,
  Uint8List message,
  Uint8List sigP1363,
) {
  try {
    if (publicJwk['kty'] != 'EC' || publicJwk['crv'] != 'P-256') return false;
    const allowed = {'kty', 'crv', 'x', 'y'};
    if (publicJwk.keys.any((k) => !allowed.contains(k))) return false;
    final xs = publicJwk['x'];
    final ys = publicJwk['y'];
    if (xs == null || ys == null) return false;
    final xb = unB64url(xs);
    final yb = unB64url(ys);
    if (xb.length != 32 || yb.length != 32) return false;
    if (sigP1363.length != 64) return false;
    final curve = _p256.curve;
    final q = curve.createPoint(_toBigInt(xb), _toBigInt(yb));
    // createPoint does not validate; check the curve equation and the subgroup.
    if (!_onCurve(_toBigInt(xb), _toBigInt(yb))) return false;
    final r = _toBigInt(Uint8List.sublistView(sigP1363, 0, 32));
    final s = _toBigInt(Uint8List.sublistView(sigP1363, 32, 64));
    final n = _p256.n;
    if (r <= BigInt.zero || r >= n || s <= BigInt.zero || s >= n) return false;
    final verifier = ECDSASigner(SHA256Digest())
      ..init(false, PublicKeyParameter<ECPublicKey>(ECPublicKey(q, _p256)));
    return verifier.verifySignature(message, ECSignature(r, s));
  } catch (_) {
    return false;
  }
}

bool _onCurve(BigInt x, BigInt y) {
  // NIST P-256 field prime.
  final p = BigInt.parse(
      'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
      radix: 16);
  if (x >= p || y >= p) return false;
  final a = _p256.curve.a!.toBigInteger()!;
  final b = _p256.curve.b!.toBigInteger()!;
  final lhs = (y * y) % p;
  final rhs = (x * x * x + a * x + b) % p;
  return lhs == rhs;
}
