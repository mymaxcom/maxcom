import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/sync/camera_relay_seal.dart';

// Made by `apps/box-server` (cameraRelayCrypto.ts): the box's key pair and a value sealed to it.
const _box = {
  'kty': 'EC',
  'crv': 'P-256',
  'x': '_3cj-DakG4KtizzNP0ZmsiA6N2jVMtLgLYY9iZNxEUg',
  'y': 'RsoTz1uetxQljH94us22AGtsGHfpQERE_jECHeqtlN0',
  'd': 'Mgiv-LvGFamfSh93EKF5BuhllvQSDIO-GKY9TTdPZ98',
};
const _boxId = 'aaaa000000000001';
const _plain =
    '{"seq":7,"boxId":"aaaa000000000001","url":"rtsp://10.168.1.20:554/main","username":"viewer","password":"p@ss w0rd"}';
const _fromBox =
    'e1.BLJ3rGA1elNhBlg2_xGfgY4VzUN_SYBw14SSZz0tyFvd9I_XDhVu6UtjZQpJSKdE53PPPO4gtdgy0YGSdwYuqQ0.iYq35cS-7_Cq9hCF.Jw2adMgyDNmHZu4aWho6zoc-2pTTumKuNZswws59lz_ePjtxXddC5vf4jiElQzT2X62cbhQ-k34O9beXTsVm9n3kl67baCkXMkSTtXRsQZjL7Uhi-nQNhlOxFXY428iL_xApIWrrGzgTrlAfYyKIbD239bI.wX-vvZDKKExTDPrUEfFaSA';

void main() {
  test('opens a value the box side sealed (same ECDH, HKDF and AES-GCM)', () {
    expect(
      openCameraRelay(boxPrivateJwk: _box, sealed: _fromBox, aad: cameraRelayAad(_boxId, 7)),
      _plain,
    );
  });

  test('a value it seals opens with the box key, only under its own box and number', () {
    final sealed = sealCameraRelay(boxPublicJwk: _box, plaintext: _plain, aad: cameraRelayAad(_boxId, 7));
    expect(sealed.startsWith('e1.'), isTrue);
    expect(sealed.split('.').length, 5);
    expect(sealed.contains('viewer'), isFalse);
    expect(openCameraRelay(boxPrivateJwk: _box, sealed: sealed, aad: cameraRelayAad(_boxId, 7)), _plain);
    expect(() => openCameraRelay(boxPrivateJwk: _box, sealed: sealed, aad: cameraRelayAad(_boxId, 8)), throwsA(anything));
    expect(() => openCameraRelay(boxPrivateJwk: _box, sealed: sealed, aad: cameraRelayAad('bbbb000000000002', 7)), throwsA(anything));
  });

  test('two seals of the same text differ', () {
    final a = sealCameraRelay(boxPublicJwk: _box, plaintext: _plain, aad: 'x');
    final b = sealCameraRelay(boxPublicJwk: _box, plaintext: _plain, aad: 'x');
    expect(a, isNot(b));
  });

  test('a key that is not a P-256 public key is refused', () {
    expect(() => sealCameraRelay(boxPublicJwk: const {'kty': 'RSA'}, plaintext: 'x', aad: 'x'), throwsFormatException);
  });
}
