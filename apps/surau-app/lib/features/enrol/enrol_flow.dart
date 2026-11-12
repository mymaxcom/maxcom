// Enrolment: parse the admin's QR payload, establish trust in the box's
// root CA (Android), make a device key, redeem the code at
// `POST /api/enrol/complete`, and only then keep the key and remember the
// box. Mirrors `enrol()` in packages/device-client/src/index.ts.

import '../../box/box_client.dart';
import '../../box/device_key.dart';
import '../../box/payload.dart';
import '../common/payload_extras.dart';
import '../common/surau_info.dart';
import 'pin_policy.dart';

/// What the app remembers about the box it is enrolled with. No secrets:
/// the private key stays in its store, the session token is not persisted.
class EnrolledBox {
  const EnrolledBox({
    required this.box,
    required this.boxId,
    required this.deviceId,
    required this.userId,
    required this.userName,
    required this.roles,
    required this.caSha256,
    this.appLock = true,
    this.cloud,
  });

  factory EnrolledBox.fromJson(Map<String, dynamic> j) => EnrolledBox(
    box: Uri.parse(j['box'] as String),
    boxId: j['boxId'] as String,
    deviceId: j['deviceId'] as String,
    userId: j['userId'] as String,
    userName: j['userName'] as String,
    roles: (j['roles'] as List? ?? const [])
        .map((e) => e.toString())
        .toList(growable: false),
    caSha256: j['caSha256'] as String?,
    appLock: j['appLock'] is bool ? j['appLock'] as bool : true,
    cloud: j['cloud'] is String ? Uri.tryParse(j['cloud'] as String) : null,
  );

  /// Origin of the box, for example `https://<box-ip>:8443`.
  final Uri box;
  final String boxId;
  final String deviceId;
  final String userId;
  final String userName;
  final List<String> roles;

  /// Lower-case hex sha256 of the box's root CA; null on a loopback test box.
  final String? caSha256;

  /// Whether the box asks for a PIN when this device unlocks. Last seen on
  /// the box (enrolment, then every unlock challenge); true when unknown,
  /// so an older record or box keeps the PIN pad.
  final bool appLock;

  /// Origin of the cloud copy (Plan 6); null when the box has none linked.
  final Uri? cloud;

  EnrolledBox withAppLock(bool value) => EnrolledBox(
    box: box,
    boxId: boxId,
    deviceId: deviceId,
    userId: userId,
    userName: userName,
    roles: roles,
    caSha256: caSha256,
    appLock: value,
    cloud: cloud,
  );

  /// The same enrolment with the cloud origin [value] (learnt from the
  /// box's `GET /api/health` after enrolment).
  EnrolledBox withCloud(Uri? value) => EnrolledBox(
    box: box,
    boxId: boxId,
    deviceId: deviceId,
    userId: userId,
    userName: userName,
    roles: roles,
    caSha256: caSha256,
    appLock: appLock,
    cloud: value,
  );

  Map<String, dynamic> toJson() => {
    'box': box.toString(),
    'boxId': boxId,
    'deviceId': deviceId,
    'userId': userId,
    'userName': userName,
    'roles': roles,
    'caSha256': caSha256,
    'appLock': appLock,
    'cloud': ?cloud?.toString(),
  };

  /// The first 8 groups of 4 hex characters, the part an admin compares
  /// against the bootstrap printout.
  String? get caFingerprint => fingerprintOf(caSha256);

  static String? fingerprintOf(String? sha256) {
    if (sha256 == null || sha256.length < 32) return null;
    final groups = <String>[];
    for (var i = 0; i < 32; i += 4) {
      groups.add(sha256.substring(i, i + 4));
    }
    return groups.join(' ');
  }
}

/// Where the enrolled box is kept between launches. Task 4's session store
/// (shared_preferences) implements this; tests use [MemoryEnrolledBoxStore].
abstract class EnrolledBoxStore {
  Future<EnrolledBox?> load();
  Future<void> save(EnrolledBox box);
  Future<void> clear();
}

class MemoryEnrolledBoxStore implements EnrolledBoxStore {
  EnrolledBox? _box;

  @override
  Future<EnrolledBox?> load() async => _box;

  @override
  Future<void> save(EnrolledBox box) async => _box = box;

  @override
  Future<void> clear() async => _box = null;
}

/// Trust on first use. On Android, Task 4's trust store fetches
/// `/api/pki/root.cer` once and accepts it only when its sha256 equals
/// [caSha256]; on the web the browser already trusts the installed root, so
/// [BrowserEnrolTrust] does nothing.
abstract class EnrolTrust {
  /// True where the app pins the surau's root CA itself (Android): an
  /// enrolment payload must then carry the CA's sha256.
  bool get pinsCa;

  /// Throws [TrustError] when the box's CA cannot be trusted. Nothing is stored yet: the CA is held in memory for
  /// the pinned client only.
  Future<void> establish(Uri box, String? caSha256);

  /// Keeps the CA just established on the phone. Called only after the join succeeded (a 201 or a completed
  /// enrolment), never before.
  Future<void> commit(String? caSha256);
}

class BrowserEnrolTrust implements EnrolTrust {
  const BrowserEnrolTrust();

  @override
  bool get pinsCa => false;

  @override
  Future<void> establish(Uri box, String? caSha256) async {}

  @override
  Future<void> commit(String? caSha256) async {}
}

class TrustError implements Exception {
  const TrustError(this.message);

  final String message;

  @override
  String toString() => 'TrustError($message)';
}

/// Failures the enrol screen explains in its own words. Box and network
/// errors ([BoxError], [BoxUnreachable], [TrustError]) pass through as is.
sealed class EnrolFailure implements Exception {
  const EnrolFailure();
}

/// The payload's `exp` is in the past.
class EnrolExpired extends EnrolFailure {
  const EnrolExpired();
}

/// `Cipta PIN baharu` with a PIN the box would refuse.
class EnrolPinTooWeak extends EnrolFailure {
  const EnrolPinTooWeak();
}

/// 400 from the box: the user already has a PIN, so the enrolment should
/// be retried with `Saya sudah ada PIN`. The code is still unused.
class EnrolPinExists extends EnrolFailure {
  const EnrolPinExists();
}

/// This device already holds a working enrolment (a box record and a key).
/// Enrolling again would replace the key before the box answers, and a
/// refusal would then wipe it, so [EnrolFlow.run] refuses. The way to enrol
/// again is the explicit forget ("Daftar semula"), which removes the record.
class EnrolAlreadyEnrolled extends EnrolFailure {
  const EnrolAlreadyEnrolled();
}

class EnrolOutcome {
  const EnrolOutcome({required this.box, required this.pinPending, this.surau});

  final EnrolledBox box;

  /// The user has no PIN yet (an admin reset): the next unlock will ask for
  /// a new one (the box answers 409 `pinRequired` to a verified device).
  final bool pinPending;

  /// The surau named in the payload (with its help contact), or null for a
  /// payload from an older box.
  final SurauInfo? surau;
}

/// `platform` sent to the box: `android`, `ios-web` for Safari on an iPad
/// or iPhone, else `web`.
String detectEnrolPlatform({required bool isWeb, required String userAgent}) {
  if (!isWeb) return 'android';
  final ua = userAgent.toLowerCase();
  if (ua.contains('ipad') || ua.contains('iphone')) return 'ios-web';
  return 'web';
}

class EnrolFlow {
  EnrolFlow({
    required this.clientFor,
    required this.key,
    required this.trust,
    required this.store,
    required this.platform,
    this.surauInfoStore,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Builds the client for the box named in the payload (Task 4 gives a
  /// client pinned to the enrolled CA).
  final BoxClient Function(Uri box) clientFor;
  final DeviceKey key;
  final EnrolTrust trust;
  final EnrolledBoxStore store;
  final String platform;

  /// Seeded with the surau and help contact from the payload on success,
  /// so the unlock screen knows the surau before it ever reaches the box.
  final SurauInfoStore? surauInfoStore;
  final DateTime Function() _now;

  /// Parses [payloadText] without side effects, for the review step.
  /// Throws [FormatException] (box wording) or [EnrolExpired].
  EnrolPayload inspect(String payloadText) {
    final payload = EnrolPayload.parse(
      payloadText.trim(),
      requireCa: trust.pinsCa,
    );
    if (payload.exp <= _now().millisecondsSinceEpoch) {
      throw const EnrolExpired();
    }
    return payload;
  }

  /// parse -> trust -> generate -> enrolComplete -> keep key, remember box.
  /// The key is kept only after the box accepted it; on any failure after
  /// `generate()` the key is cleared so a retry starts clean.
  Future<EnrolOutcome> run(
    String payloadText, {
    required String deviceName,
    bool? hasPinAlready,
    String? newPin,
  }) async {
    // Never touch the key of a working enrolment: no generate() and no
    // clear() unless the person has forgotten the box first.
    if (await store.load() != null && await key.exists()) {
      throw const EnrolAlreadyEnrolled();
    }
    final payload = inspect(payloadText);
    // A box with the app lock off never asks for a PIN: the device key is
    // the only factor, so no PIN is chosen or sent (the box would ignore it).
    final lockOff = payload.appLock == false;
    final hasPin = hasPinAlready ?? (lockOff ? true : null);
    if (hasPin == null) {
      throw ArgumentError.notNull('hasPinAlready');
    }
    final pin = hasPin ? null : newPin;
    if (!hasPin && (pin == null || !isValidPin(pin))) {
      throw const EnrolPinTooWeak();
    }
    final box = Uri.parse(payload.box);

    await trust.establish(box, payload.caSha256);

    final jwk = await key.generate();
    final publicJwk = {
      'kty': jwk['kty']!,
      'crv': jwk['crv']!,
      'x': jwk['x']!,
      'y': jwk['y']!,
    };

    final EnrolResult result;
    try {
      result = await clientFor(box).enrolComplete(
        code: payload.code,
        publicJwk: publicJwk,
        deviceName: deviceName.trim(),
        platform: platform,
        pin: pin,
      );
    } on BoxError catch (e) {
      await key.clear();
      if (e.status == 400 && e.message.startsWith('PIN sudah ditetapkan')) {
        throw const EnrolPinExists();
      }
      rethrow;
    } catch (_) {
      await key.clear();
      rethrow;
    }

    final enrolled = EnrolledBox(
      box: box,
      boxId: payload.boxId,
      deviceId: result.deviceId,
      userId: result.userId,
      userName: payload.user,
      roles: result.roles,
      caSha256: payload.caSha256,
      appLock: result.appLock ?? payload.appLock ?? true,
      cloud: payload.cloud == null ? null : Uri.parse(payload.cloud!),
    );
    await trust.commit(payload.caSha256);
    await store.save(enrolled);
    final surau = EnrolPayloadExtras.parse(payloadText).surauWithHelp;
    if (surau != null) await surauInfoStore?.save(surau);
    return EnrolOutcome(
      box: enrolled,
      pinPending: result.pinRequired && enrolled.appLock,
      surau: surau,
    );
  }
}
