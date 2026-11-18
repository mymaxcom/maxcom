// What the phone keeps so the app opens without the box or the cloud: the
// last person who unlocked online (id, name, roles, surau name, when) and,
// with the app lock on, a verifier of their PIN. Both live in the sealed
// local store of the enrolled box (Keystore-sealed files on Android), never
// in shared_preferences, and never a token.
//
// The PIN verifier is PBKDF2-HMAC-SHA256 over the PIN with a 16-byte random
// salt and at least 210 000 iterations. Five wrong PINs in a row lock the
// offline unlock for 15 minutes, the next round 30 minutes, then the offline
// door is closed (the third round closes it) until an
// online unlock saves the PIN again, as it is after a server 423. The count,
// the rounds and the lock are stored, so a restart does not reset them.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show compute;
import 'package:pointycastle/digests/sha256.dart';
import 'package:pointycastle/key_derivators/api.dart' show Pbkdf2Parameters;
import 'package:pointycastle/key_derivators/pbkdf2.dart';
import 'package:pointycastle/macs/hmac.dart';

import '../../box/wire.dart';
import '../../store/local_store.dart';

/// The person the offline session is for.
class OfflineProfile {
  const OfflineProfile({
    required this.userId,
    required this.name,
    required this.roles,
    required this.at,
    this.surauName,
  });

  /// Null when a field the app relies on is missing or of the wrong type.
  static OfflineProfile? fromJson(Map<String, dynamic> j) {
    final id = j['userId'];
    final name = j['name'];
    final roles = j['roles'];
    final at = DateTime.tryParse(j['at'] is String ? j['at'] as String : '');
    if (id is! String || id.isEmpty || name is! String || at == null) {
      return null;
    }
    return OfflineProfile(
      userId: id,
      name: name,
      roles: roles is List
          ? roles.map((e) => e.toString()).toList(growable: false)
          : const [],
      at: at,
      surauName: j['surauName'] is String ? j['surauName'] as String : null,
    );
  }

  final String userId;
  final String name;

  /// The roles of the last online session. They only drive the UI: every
  /// queued operation is checked again by the server when it is pushed.
  final List<String> roles;

  /// When the person last unlocked online.
  final DateTime at;
  final String? surauName;

  SessionUser get user => SessionUser(id: userId, name: name, roles: roles);

  Map<String, dynamic> toJson() => {
    'userId': userId,
    'name': name,
    'roles': roles,
    'at': at.toUtc().toIso8601String(),
    'surauName': ?surauName,
  };
}

/// The answer of [OfflineVault.checkPin].
sealed class PinCheck {
  const PinCheck();
}

class PinOk extends PinCheck {
  const PinOk();
}

/// Wrong; [left] more tries before the lock.
class PinWrong extends PinCheck {
  const PinWrong(this.left);

  final int left;
}

/// Too many wrong PINs: no offline unlock before [until].
class PinLocked extends PinCheck {
  const PinLocked(this.until);

  final DateTime until;
}

/// Offline unlock is closed (three lock rounds, a server 423 for this person,
/// or a revoked device): only an online unlock opens the app again.
class PinClosed extends PinCheck {
  const PinClosed();
}

/// No verifier on this phone (never unlocked online with a PIN).
class PinUnknown extends PinCheck {
  const PinUnknown();
}

/// The least PBKDF2 work the app stores or accepts.
const int minPinIterations = 210000;

/// Derives the PIN key; injectable so widget tests need no isolate.
typedef PinDeriver =
    Future<Uint8List> Function(String pin, Uint8List salt, int iterations);

/// PBKDF2-HMAC-SHA256, 32 bytes.
Uint8List pbkdf2Sha256(String pin, Uint8List salt, int iterations) {
  final d = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
    ..init(Pbkdf2Parameters(salt, iterations, 32));
  return d.process(Uint8List.fromList(utf8.encode(pin)));
}

/// [pbkdf2Sha256] off the UI thread (inline on the web).
Future<Uint8List> derivePinInBackground(
  String pin,
  Uint8List salt,
  int iterations,
) => compute(_derive, (pin, salt, iterations));

Uint8List _derive((String, Uint8List, int) a) => pbkdf2Sha256(a.$1, a.$2, a.$3);

class OfflineVault {
  OfflineVault({
    required this.store,
    DateTime Function()? now,
    this.derive = derivePinInBackground,
    this.iterations = minPinIterations,
    this.minIterations = minPinIterations,
    Random? random,
  }) : now = now ?? DateTime.now,
       _random = random ?? Random.secure();

  final LocalStore store;
  final DateTime Function() now;
  final PinDeriver derive;

  /// Work for a new verifier, and the least accepted when checking one.
  final int iterations;
  final int minIterations;
  final Random _random;

  static const String collection = 'offline';
  static const String _profile = 'profile';
  static const String _pin = 'pin';

  static const String _revoked = 'revoked';

  /// Wrong PINs in a row before the lock.
  static const int maxTries = 5;

  /// Lock rounds before the offline door closes.
  static const int maxRounds = 3;

  /// How long the lock of round [round] (1, 2, 3 ...) lasts: 15 minutes,
  /// doubling, never more than 24 hours (the server's own rule).
  static Duration lockForRound(int round) {
    final r = round < 1 ? 1 : round;
    if (r > 7) return const Duration(hours: 24);
    final d = Duration(minutes: 15 * (1 << (r - 1)));
    return d > const Duration(hours: 24) ? const Duration(hours: 24) : d;
  }

  /// A revoked device wiped this copy (see [wipeForRevocation]).
  Future<bool> isRevoked() async =>
      (await store.getDoc(collection, _revoked)) != null;

  /// A server answered 423 for this person: close the offline door until
  /// the next online unlock saves the PIN again.
  Future<void> closeOffline() async {
    final doc = await store.getDoc(collection, _pin);
    if (doc == null) return;
    await store.putDoc(collection, _pin, {...doc, 'closed': true});
  }

  Future<void> saveProfile(OfflineProfile p) =>
      store.putDoc(collection, _profile, p.toJson());

  Future<OfflineProfile?> profile() async {
    final j = await store.getDoc(collection, _profile);
    return j == null ? null : OfflineProfile.fromJson(j);
  }

  /// Replaces the verifier with one for [pin] (new salt); clears the count.
  Future<void> savePin(String pin) async {
    final salt = Uint8List.fromList(
      List<int>.generate(16, (_) => _random.nextInt(256)),
    );
    final hash = await derive(pin, salt, iterations);
    await store.putDoc(collection, _pin, {
      'v': 1,
      'alg': 'pbkdf2-sha256',
      'it': iterations,
      'salt': base64.encode(salt),
      'hash': base64.encode(hash),
      'fails': 0,
      'rounds': 0,
    });
  }

  Future<bool> hasPin() async => (await _verifier()) != null;

  /// Checks [pin] against the stored verifier, counting wrong tries.
  Future<PinCheck> checkPin(String pin) async {
    if (await isRevoked()) return const PinClosed();
    final doc = await store.getDoc(collection, _pin);
    final v = _parse(doc);
    if (doc == null || v == null) return const PinUnknown();
    if (doc['closed'] == true) return const PinClosed();
    final t = now();
    final locked = DateTime.tryParse(doc['lockedUntil'] as String? ?? '');
    if (locked != null && t.isBefore(locked)) return PinLocked(locked);
    final got = await derive(pin, v.salt, v.it);
    if (_same(got, v.hash)) {
      await store.putDoc(collection, _pin, {
        ...doc,
        'fails': 0,
        'rounds': 0,
      }..remove('lockedUntil'));
      return const PinOk();
    }
    final fails = ((doc['fails'] as num?)?.toInt() ?? 0) + 1;
    if (fails >= maxTries) {
      final rounds = ((doc['rounds'] as num?)?.toInt() ?? 0) + 1;
      if (rounds >= maxRounds) {
        await store.putDoc(collection, _pin, {
          ...doc,
          'fails': 0,
          'rounds': rounds,
          'closed': true,
        }..remove('lockedUntil'));
        return const PinClosed();
      }
      final until = t.add(lockForRound(rounds));
      await store.putDoc(collection, _pin, {
        ...doc,
        'fails': 0,
        'rounds': rounds,
        'lockedUntil': until.toUtc().toIso8601String(),
      });
      return PinLocked(until);
    }
    await store.putDoc(collection, _pin, {
      ...doc,
      'fails': fails,
    }..remove('lockedUntil'));
    return PinWrong(maxTries - fails);
  }

  Future<({Uint8List salt, Uint8List hash, int it})?> _verifier() async =>
      _parse(await store.getDoc(collection, _pin));

  ({Uint8List salt, Uint8List hash, int it})? _parse(Map<String, dynamic>? d) {
    if (d == null || d['alg'] != 'pbkdf2-sha256') return null;
    final it = (d['it'] as num?)?.toInt() ?? 0;
    if (it < minIterations) return null;
    try {
      final salt = base64.decode(d['salt'] as String);
      final hash = base64.decode(d['hash'] as String);
      if (salt.length < 16 || hash.length != 32) return null;
      return (salt: salt, hash: hash, it: it);
    } on Object {
      return null;
    }
  }

  static bool _same(Uint8List a, Uint8List b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff == 0;
  }
}

/// A revoked device (the server said `device_revoked`): the local copy and
/// the offline vault are wiped and a flag stays, so the offline door never
/// opens again on this copy. Being merely unreachable never calls this.
Future<void> wipeForRevocation(LocalStore store) async {
  await store.wipe();
  await store.putDoc(OfflineVault.collection, OfflineVault._revoked, {
    'at': DateTime.now().toUtc().toIso8601String(),
  });
}
