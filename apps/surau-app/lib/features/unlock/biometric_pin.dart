// Biometrics do not gate the device key (builder's call 3). Instead the
// PIN is sealed with an AES-GCM Keystore key that only a strong biometric
// can use (`surau-pin-seal`, `setUserAuthenticationRequired(true)`,
// `AUTH_BIOMETRIC_STRONG`); the Kotlin side shows the prompt and returns
// the PIN, which then goes to the box exactly as a typed PIN would. The
// PIN is never stored in clear and never leaves the device unsealed except
// in the unlock request body.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// The person closed the biometric prompt or chose the PIN instead.
class BiometricCancelled implements Exception {
  const BiometricCancelled();

  @override
  String toString() => 'BiometricCancelled()';
}

/// The sensor is locked for a while after too many wrong fingers.
class BiometricLockedOut implements Exception {
  const BiometricLockedOut();

  @override
  String toString() => 'BiometricLockedOut()';
}

abstract class BiometricPin {
  /// True when the device offers strong biometrics and has at least one
  /// enrolled.
  Future<bool> available();

  /// True when a sealed PIN exists on this device.
  Future<bool> hasSealedPin();

  /// Seals [pin]; call only after the box accepted it. True when sealed;
  /// false when the prompt was cancelled or failed (nothing is left behind).
  Future<bool> seal(String pin);

  /// Shows the biometric prompt and returns the PIN, or null when it
  /// failed or no sealed PIN exists. Throws [BiometricCancelled] when the
  /// person closed the prompt and [BiometricLockedOut] when the sensor is
  /// locked.
  Future<String?> open();

  /// Forgets the sealed PIN. Idempotent.
  Future<void> clear();
}

/// Web and any platform without the Keystore channel: no biometrics.
class NoBiometricPin implements BiometricPin {
  const NoBiometricPin();

  @override
  Future<bool> available() async => false;

  @override
  Future<bool> hasSealedPin() async => false;

  @override
  Future<bool> seal(String pin) async => false;

  @override
  Future<String?> open() async => null;

  @override
  Future<void> clear() async {}
}

/// Android: the Keystore channel (`my.maxcom/keystore`, methods
/// `available`, `sealPin`, `openPin`, `hasSealedPin`, `clearSealedPin`)
/// answers whether strong biometrics are enrolled and does the sealing.
class AndroidBiometricPin implements BiometricPin {
  AndroidBiometricPin({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('my.maxcom/keystore');

  final MethodChannel _channel;

  @override
  Future<bool> available() async {
    try {
      return await _channel.invokeMethod<bool>('available') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<bool> hasSealedPin() async {
    try {
      return await _channel.invokeMethod<bool>('hasSealedPin') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<bool> seal(String pin) async {
    try {
      await _channel.invokeMethod<void>('sealPin', {'pin': pin});
      return true;
    } on PlatformException {
      await clear();
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<String?> open() async {
    try {
      return await _channel.invokeMethod<String>('openPin');
    } on PlatformException catch (e) {
      switch (e.code) {
        case 'cancelled':
          throw const BiometricCancelled();
        case 'lockout':
          throw const BiometricLockedOut();
      }
      // a real mismatch, key invalidated by a new fingerprint, no PIN
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  @override
  Future<void> clear() async {
    try {
      await _channel.invokeMethod<void>('clearSealedPin');
    } on PlatformException {
      // nothing to clear
    } on MissingPluginException {
      // channel absent (tests, web)
    }
  }
}

/// The sealed-PIN store for this platform.
BiometricPin platformBiometricPin() {
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    return AndroidBiometricPin();
  }
  return const NoBiometricPin();
}
