// The seal of a camera address sent to the box through the cloud ("Kamera luaran" set from anywhere).
//
// The twin of `apps/box-server/src/sync/cameraRelayCrypto.ts`: ECIES on the box's own P-256 key. A fresh
// ephemeral key per message, ECDH, HKDF-SHA256 into an AES-256-GCM key. The cloud keeps the sealed text and
// cannot open it. The associated text binds the value to one box and one number.
//
// Wire form `e1.<ephemeral point, 65 bytes>.<iv, 12>.<ciphertext>.<tag, 16>`, each part base64url.
// [open] is here for the tests (a fixed vector from the box keeps the two sides honest); the phone only seals.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import '../box/device_key.dart' show b64url, fixed32, unB64url;

final ECDomainParameters _p256 = ECDomainParameters('prime256v1');

const String _info = 'maxcom-camera-relay-v1';

/// The text the seal is bound to: this box, this number.
String cameraRelayAad(String boxId, int seq) => '$_info|$boxId|$seq';

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

ECPublicKey _publicOf(String x, String y) {
  final xb = unB64url(x);
  final yb = unB64url(y);
  if (xb.length != 32 || yb.length != 32) {
    throw const FormatException('kunci kotak tidak sah'); // lang-ok: diagnostic exception text, not shown
  }
  final q = _p256.curve.createPoint(_toBigInt(xb), _toBigInt(yb));
  return ECPublicKey(q, _p256);
}

Uint8List _derive(BigInt shared, String aad) {
  final kdf = HKDFKeyDerivator(SHA256Digest())
    ..init(
      HkdfParameters(
        fixed32(shared),
        32,
        Uint8List(0),
        Uint8List.fromList(utf8.encode('$_info\n$aad')),
      ),
    );
  final out = Uint8List(32);
  kdf.deriveKey(null, 0, out, 0);
  return out;
}

Uint8List _gcm(bool encrypt, Uint8List key, Uint8List iv, String aad, Uint8List input) {
  final c = GCMBlockCipher(AESEngine())
    ..init(
      encrypt,
      AEADParameters(KeyParameter(key), 128, iv, Uint8List.fromList(utf8.encode(aad))),
    );
  return c.process(input);
}

/// Seals [plaintext] (JSON text) to the box's public key [boxPublicJwk] (`x`, `y` of a P-256 JWK).
/// [random] is for tests only.
String sealCameraRelay({
  required Map<String, dynamic> boxPublicJwk,
  required String plaintext,
  required String aad,
  SecureRandom? random,
}) {
  final x = boxPublicJwk['x'];
  final y = boxPublicJwk['y'];
  if (boxPublicJwk['kty'] != 'EC' || boxPublicJwk['crv'] != 'P-256' || x is! String || y is! String) {
    throw const FormatException('kunci kotak tidak sah'); // lang-ok: diagnostic exception text, not shown
  }
  final rng = random ?? _secureRandom();
  final gen = ECKeyGenerator()..init(ParametersWithRandom(ECKeyGeneratorParameters(_p256), rng));
  final eph = gen.generateKeyPair();
  final ephPriv = eph.privateKey;
  final ephPub = eph.publicKey;
  final agreement = ECDHBasicAgreement()..init(ephPriv);
  final shared = agreement.calculateAgreement(_publicOf(x, y));
  final iv = Uint8List.fromList(List.generate(12, (_) => rng.nextUint8()));
  final both = _gcm(true, _derive(shared, aad), iv, aad, Uint8List.fromList(utf8.encode(plaintext)));
  final ct = Uint8List.sublistView(both, 0, both.length - 16);
  final tag = Uint8List.sublistView(both, both.length - 16);
  return ['e1', b64url(Uint8List.fromList(ephPub.Q!.getEncoded(false))), b64url(iv), b64url(Uint8List.fromList(ct)), b64url(Uint8List.fromList(tag))].join('.');
}

/// Opens a sealed value with the box's private JWK. Tests only: the phone never holds the box's key.
String openCameraRelay({
  required Map<String, dynamic> boxPrivateJwk,
  required String sealed,
  required String aad,
}) {
  final parts = sealed.split('.');
  if (parts.length != 5 || parts[0] != 'e1') throw const FormatException('format'); // lang-ok: diagnostic exception text, not shown
  final d = boxPrivateJwk['d'];
  if (d is! String) throw const FormatException('format'); // lang-ok: diagnostic exception text, not shown
  final point = unB64url(parts[1]);
  final q = _p256.curve.decodePoint(point);
  final shared = (ECDHBasicAgreement()..init(ECPrivateKey(_toBigInt(unB64url(d)), _p256))).calculateAgreement(ECPublicKey(q, _p256));
  final ct = unB64url(parts[3]);
  final tag = unB64url(parts[4]);
  final joined = Uint8List(ct.length + tag.length)
    ..setRange(0, ct.length, ct)
    ..setRange(ct.length, ct.length + tag.length, tag);
  return utf8.decode(_gcm(false, _derive(shared, aad), unB64url(parts[2]), aad, joined));
}
