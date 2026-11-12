import 'package:flutter/services.dart';

import 'device_key.dart';

/// Channel implemented by `KeystoreChannel.kt`.
const String keystoreChannelName = 'my.maxcom/keystore';

/// Device key held in the Android Keystore (StrongBox when the phone offers it). The private
/// key is non-exportable: Kotlin only returns the public point and DER signatures.
class AndroidDeviceKey implements DeviceKey {
  AndroidDeviceKey({MethodChannel? channel})
      : _ch = channel ?? const MethodChannel(keystoreChannelName);

  final MethodChannel _ch;

  Future<Uint8List> _bytes(String method, [Object? args]) async {
    final r = await _ch.invokeMethod<Uint8List>(method, args);
    if (r == null) throw StateError('Kunci peranti tidak tersedia');
    return r;
  }

  @override
  Future<bool> exists() async {
    try {
      return await _ch.invokeMethod<bool>('exists') ?? false;
    } on PlatformException {
      return false;
    }
  }

  @override
  Future<Map<String, String>> generate() async {
    final point = await _guard(() => _bytes('generate'));
    final jwk = jwkFromUncompressedPoint(point);
    await deviceKeySelfCheck(this, jwk);
    return jwk;
  }

  @override
  Future<Map<String, String>> publicJwk() async =>
      jwkFromUncompressedPoint(await _guard(() => _bytes('publicKey')));

  @override
  Future<Uint8List> sign(Uint8List message) async {
    final der = await _guard(() => _bytes('sign', message));
    return derToP1363(der);
  }

  @override
  Future<void> clear() async {
    try {
      await _ch.invokeMethod<void>('clear');
    } on PlatformException {
      // Nothing to delete or the store is unavailable; either way no key is usable.
    }
  }

  /// Native errors carry a short code only; surface a BM message without platform details.
  Future<T> _guard<T>(Future<T> Function() f) async {
    try {
      return await f();
    } on PlatformException catch (e) {
      if (e.code == 'no_key') {
        throw StateError('Kunci peranti tiada. Daftar semula peranti ini');
      }
      throw StateError('Kunci peranti tidak dapat digunakan');
    }
  }
}

DeviceKey createPlatformDeviceKey() => AndroidDeviceKey();
