// Unlock: challenge -> sign "surau-unlock\n<boxId>\n<deviceId>\n<nonce>"
// with the device key -> POST /api/auth/unlock with the PIN (or, after an
// admin reset, a new PIN). The box's answers are mapped to one failure
// type each so the screen can explain them; anything else passes through.

import '../../box/box_client.dart';
import '../../box/device_key.dart';
import '../enrol/enrol_flow.dart';
import '../enrol/pin_policy.dart';
import 'biometric_pin.dart';

sealed class UnlockFailure implements Exception {
  const UnlockFailure(this.message);

  /// The box's wording when it answered, else the app's.
  final String message;

  @override
  String toString() => '$runtimeType($message)';
}

/// 401 `wrong_pin`.
class UnlockWrongPin extends UnlockFailure {
  const UnlockWrongPin(super.message);
}

/// 423 with `Retry-After`.
class UnlockLocked extends UnlockFailure {
  const UnlockLocked(super.message, {this.retryAfterSec});

  final int? retryAfterSec;
}

/// 409 `pinRequired`: an admin reset the PIN; call `run(newPin: ...)`.
/// The box says this only after the device signature verified.
class UnlockPinRequired extends UnlockFailure {
  const UnlockPinRequired(super.message);
}

/// 401 `pin_missing`: the admin turned the app lock on and this person has a
/// PIN but sent none. Not a wrong guess (the box did not count it); the
/// screen shows the pad.
class UnlockPinMissing extends UnlockFailure {
  const UnlockPinMissing(super.message);
}

/// 400 while setting a new PIN: a PIN exists after all; use `run(pin: ...)`.
class UnlockPinExists extends UnlockFailure {
  const UnlockPinExists(super.message);
}

/// A new PIN the box would refuse (checked locally, nothing sent).
class UnlockPinTooWeak extends UnlockFailure {
  const UnlockPinTooWeak() : super('PIN terlalu mudah');
}

/// 401 `device_revoked` or `user_inactive`: the box will not accept this
/// device any more, so it has to be enrolled again. Nothing else is.
class UnlockRevoked extends UnlockFailure {
  const UnlockRevoked(super.message);
}

/// 401 `bad_signature`: the box could not check the device's signature.
/// Not a revoked device; the person can try again.
class UnlockNotVerified extends UnlockFailure {
  const UnlockNotVerified(super.message);
}

/// The device key store is empty (Safari evicted IndexedDB, fresh install).
class UnlockNoKey extends UnlockFailure {
  const UnlockNoKey() : super('Kunci peranti tiada');
}

/// Why the biometric prompt gave no PIN.
enum BiometricFailure {
  /// The person closed the prompt or chose the PIN: say nothing.
  cancelled,

  /// Too many wrong fingers; the sensor is locked for a while.
  lockedOut,

  /// The fingerprint was not recognised, or nothing could be unsealed.
  notRecognised,
}

/// The biometric prompt gave no PIN; the pad is the fallback.
class UnlockBiometricFailed extends UnlockFailure {
  const UnlockBiometricFailed([this.reason = BiometricFailure.notRecognised])
    : super('Cap jari tidak dikenali');

  final BiometricFailure reason;
}

class UnlockFlow {
  UnlockFlow({
    required this.client,
    required this.key,
    required this.box,
    required this.biometric,
    this.onAppLock,
    this.onPinAccepted,
  });

  /// Told after every successful unlock: the PIN the box checked and
  /// accepted, or null when no PIN was checked (lock off, device key only).
  /// The app keeps it in memory for this run (silent reconnects) and stores
  /// a local verifier of it for offline unlocks. Never fails the unlock.
  final void Function(String? pin)? onPinAccepted;

  /// Told the box's app lock whenever the box states it (every challenge,
  /// and a `pin_missing` or `pin_required` refusal), so the app can keep
  /// it for the next launch. Failures of the callback never fail the unlock.
  final Future<void> Function(bool appLock)? onAppLock;

  final BoxClient client;
  final DeviceKey key;
  final EnrolledBox box;
  final BiometricPin biometric;

  // The box's reason codes (apps/box-server/src/auth/sessions.ts, users.ts).
  static const String _wrongPin = 'wrong_pin';
  static const String _badNonce = 'bad_nonce';
  static const String _badSignature = 'bad_signature';
  static const String _deviceRevoked = 'device_revoked';
  static const String _userInactive = 'user_inactive';
  static const String _pinMissing = 'pin_missing';

  /// Strong biometrics present and a PIN sealed on this device.
  Future<bool> canUseBiometric() async =>
      await biometric.available() && await biometric.hasSealedPin();

  Future<void> _report(bool appLock) async {
    try {
      await onAppLock?.call(appLock);
    } on Object {
      // Remembering the lock is a convenience, never a reason to fail.
    }
  }

  /// Exactly one of [pin], [newPin] or [noPin]. [noPin] posts only the
  /// device proof (the box has its app lock off). With [sealPin], a PIN the
  /// box accepted is sealed for biometrics afterwards, unless the box said
  /// its lock is off (it ignored the PIN, so nothing was checked). A
  /// challenge the box calls spent or expired (`bad_nonce`) is replaced by
  /// a new one, once, without the person noticing.
  Future<SessionDto> run({
    String? pin,
    String? newPin,
    bool noPin = false,
    bool sealPin = false,
  }) async {
    if ((pin != null ? 1 : 0) + (newPin != null ? 1 : 0) + (noPin ? 1 : 0) !=
        1) {
      throw ArgumentError('exactly one of pin, newPin or noPin');
    }
    if (newPin != null && !isValidPin(newPin)) throw const UnlockPinTooWeak();
    if (!await key.exists()) throw const UnlockNoKey();

    Map<String, dynamic>? out;
    bool? lockNow;
    for (var attempt = 0; out == null; attempt++) {
      final Challenge challenge;
      try {
        challenge = await client.challenge(box.deviceId);
      } on BoxError catch (e) {
        throw _map(e, settingNew: false);
      }
      lockNow = challenge.appLock ?? lockNow;
      if (challenge.appLock != null) await _report(challenge.appLock!);

      final signature = b64url(
        await key.sign(unlockMessage(box.boxId, box.deviceId, challenge.nonce)),
      );

      try {
        out = await client.postJson('/api/auth/unlock', {
          'deviceId': box.deviceId,
          'nonce': challenge.nonce,
          'signature': signature,
          'pin': ?pin,
          'newPin': ?newPin,
        });
      } on BoxError catch (e) {
        if (attempt == 0 && _codeOf(e) == _badNonce) continue;
        final failure = _map(e, settingNew: newPin != null);
        // The box only asks for a PIN, or answers 409, while its lock is on.
        if (failure is UnlockPinMissing || failure is UnlockPinRequired) {
          await _report(true);
        }
        throw failure;
      }
    }
    final session = SessionDto.fromJson(out).issuedBy(client.box, 'box');

    if (sealPin && !noPin && lockNow != false) {
      final accepted = pin ?? newPin!;
      await biometric.seal(accepted);
    }
    try {
      onPinAccepted?.call(noPin || lockNow == false ? null : (pin ?? newPin));
    } on Object {
      // remembering is a convenience, never a reason to fail
    }
    return session;
  }

  /// Opens the sealed PIN with the biometric prompt and unlocks with it.
  /// A PIN the box no longer accepts is unsealed so the button disappears.
  Future<SessionDto> runWithBiometric() async {
    final String? pin;
    try {
      pin = await biometric.open();
    } on BiometricCancelled {
      throw const UnlockBiometricFailed(BiometricFailure.cancelled);
    } on BiometricLockedOut {
      throw const UnlockBiometricFailed(BiometricFailure.lockedOut);
    }
    if (pin == null) throw const UnlockBiometricFailed();
    try {
      return await run(pin: pin);
    } on UnlockWrongPin {
      await biometric.clear();
      rethrow;
    } on UnlockPinRequired {
      await biometric.clear();
      rethrow;
    }
  }

  /// The box's reason code. A box that sends no `code` is read by its
  /// fixed answers (the exact strings it uses for these refusals), never
  /// by pattern.
  static String? _codeOf(BoxError e) {
    final c = e.code;
    if (c != null) return c;
    if (e.status != 401) return null;
    switch (e.message) {
      case 'PIN salah':
        return _wrongPin;
      case 'Cabaran (nonce) tidak sah, telah digunakan atau tamat':
        return _badNonce;
      case 'Tandatangan peranti tidak sah':
        return _badSignature;
      case 'Peranti telah dibatalkan':
        return _deviceRevoked;
    }
    return null;
  }

  Object _map(BoxError e, {required bool settingNew}) {
    final code = _codeOf(e);
    switch (e.status) {
      case 423:
        return UnlockLocked(e.message, retryAfterSec: e.retryAfterSec);
      case 409:
        // The box answers 409 on unlock only for `pin_required`, and only
        // after the device signature verified.
        return UnlockPinRequired(e.message);
      case 400 when settingNew:
        if (code == 'pin_exists' ||
            e.message.startsWith('PIN sudah ditetapkan')) {
          return UnlockPinExists(e.message);
        }
        return UnlockPinTooWeak();
      case 401:
        switch (code) {
          case _wrongPin:
            return UnlockWrongPin(e.message);
          case _pinMissing:
            return UnlockPinMissing(e.message);
          case _deviceRevoked:
          case _userInactive:
            return UnlockRevoked(e.message);
          case _badSignature:
            return UnlockNotVerified(e.message);
          case _badNonce:
            // Twice in a row: not the person's doing; try again.
            return UnlockNotVerified(e.message);
        }
    }
    return e;
  }
}
