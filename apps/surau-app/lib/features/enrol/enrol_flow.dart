// Enrolment: parse the admin's QR payload, establish trust in the box's
// root CA (Android), make a device key, redeem the code at
// `POST /api/enrol/complete`, and only then keep the key and remember the
// box. Mirrors `enrol()` in packages/device-client/src/index.ts.

import '../../box/box_address.dart';
import '../../box/box_client.dart';
import '../../box/box_name.dart';
import '../../box/device_key.dart';
import '../../box/payload.dart';
import '../../l10n/generated/s.dart';
import '../../l10n/s_lookup.dart';
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
    this.name,
    this.lastIp,
    this.caSha256Next,
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
    name: j['name'] is String && isBoxName(j['name'] as String)
        ? j['name'] as String
        : null,
    lastIp: j['lastIp'] is String && isIpv4(j['lastIp'] as String)
        ? j['lastIp'] as String
        : null,
    caSha256Next: j['caSha256Next'] is String ? j['caSha256Next'] as String : null,
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

  /// The box's local name (`box1-surau.local`) once it is known and has been
  /// proven by a handshake to the pinned CA; null for a box enrolled by IP
  /// that never reported one. Only a hint for finding the box: the pinned CA
  /// and [boxId] still decide who answers.
  final String? name;

  /// The last LAN IPv4 at which this box was reached and verified.
  final String? lastIp;

  /// Sha256 of the next root, staged for a re-key (plan C4); unused yet.
  final String? caSha256Next;

  EnrolledBox _with({
    bool? appLock,
    Uri? cloud,
    bool setCloud = false,
    String? name,
    String? lastIp,
  }) => EnrolledBox(
    box: box,
    boxId: boxId,
    deviceId: deviceId,
    userId: userId,
    userName: userName,
    roles: roles,
    caSha256: caSha256,
    appLock: appLock ?? this.appLock,
    cloud: setCloud ? cloud : this.cloud,
    name: name ?? this.name,
    lastIp: lastIp ?? this.lastIp,
    caSha256Next: caSha256Next,
  );

  EnrolledBox withAppLock(bool value) => _with(appLock: value);

  /// The same enrolment with the cloud origin [value] (learnt from the
  /// box's `GET /api/health` after enrolment).
  EnrolledBox withCloud(Uri? value) => _with(cloud: value, setCloud: true);

  /// The same enrolment with the proven local name [value].
  EnrolledBox withName(String value) => _with(name: value);

  /// The same enrolment with the last verified LAN address [value].
  EnrolledBox withLastIp(String value) => _with(lastIp: value);

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
    'name': ?name,
    'lastIp': ?lastIp,
    'caSha256Next': ?caSha256Next,
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

  /// Native only: from now on the box's local [name] opens [ip] (the table
  /// the pinned clients share). The certificate is still checked for the
  /// name against the pinned CA, so a wrong [ip] can only fail.
  void routeName(String name, String ip);

  /// Forgets the address given to [name] by [routeName].
  void unrouteName(String name);

  /// The address [name] opens now, or null (so a failed attempt can put it back).
  String? routeOf(String name);
}

class BrowserEnrolTrust implements EnrolTrust {
  const BrowserEnrolTrust();

  @override
  bool get pinsCa => false;

  @override
  Future<void> establish(Uri box, String? caSha256) async {}

  @override
  Future<void> commit(String? caSha256) async {}

  @override
  void routeName(String name, String ip) {}

  @override
  void unrouteName(String name) {}

  @override
  String? routeOf(String name) => null;
}

/// Why the box's certificate could not be trusted (the app words each one).
enum TrustKind {
  rootMissing,
  rootInvalid,
  rootMismatch,
  cloudFailed,
  badQr,
  rootFetch,
  noHttps,
}

class TrustError implements Exception {
  const TrustError(this.message, [this.kind]);

  /// A failure the app words itself: BM as [message], any language through [text].
  TrustError.of(TrustKind this.kind) : message = _textOf(sBm, kind);

  /// BM text; screens show [text].
  final String message;
  final TrustKind? kind;

  /// What to show, in the language of [s].
  String text(S s) => kind == null ? message : _textOf(s, kind!);

  static String _textOf(S s, TrustKind k) => switch (k) {
    TrustKind.rootMissing => s.trustRootMissing,
    TrustKind.rootInvalid => s.trustRootInvalid,
    TrustKind.rootMismatch => s.trustRootMismatch,
    TrustKind.cloudFailed => s.trustCloudFailed,
    TrustKind.badQr => s.trustBadQr,
    TrustKind.rootFetch => s.trustRootFetch,
    TrustKind.noHttps => s.trustNoHttps,
  };

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
    this.pageOrigin,
    this.replacing = false,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// True when the phone enrols at another box while it is still enrolled at the old one (a follower it leaves for
  /// the main box). The old record and key are then replaced only once the new enrolment has succeeded; the caller
  /// clears the old box's local copy after that.
  final bool replacing;

  /// Builds the client for the box named in the payload (Task 4 gives a
  /// client pinned to the enrolled CA).
  final BoxClient Function(Uri box) clientFor;
  final DeviceKey key;
  final EnrolTrust trust;
  final EnrolledBoxStore store;
  final String platform;

  /// The origin the web app itself runs at (`Uri.base`), null off the web.
  /// A web page can only call its own origin, so when it is one of the
  /// addresses the QR lists for the box, enrolment goes there.
  final Uri? pageOrigin;

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
    // A web page can only enrol at its own origin: a payload (a link in a message, say) whose box is not this page's
    // origin is refused, the same sentence as a text that is no invitation.
    final page = pageOrigin;
    if (page != null && page.hasAuthority && page.host.isNotEmpty) {
      final target = enrolOrigin(payload, page: page);
      if (target.host.toLowerCase() != page.host.toLowerCase() || target.port != (page.hasPort ? page.port : target.port)) {
        throw const FormatException('bukan kotak halaman ini'); // lang-ok: diagnostic exception text, not shown; screens map the error type to S
      }
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
    if (!replacing && await store.load() != null && await key.exists()) {
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
    final box = enrolOrigin(payload, page: pageOrigin);

    // Native, the payload names the box by its local name: Android cannot
    // resolve it, so find the address from the payload's IPs and prove it.
    String? provenIp;
    String? previousRoute;
    TrustError? loopTrustError;
    if (pageOrigin == null && trust.pinsCa) {
      final r = await _establishByName(box, payload);
      provenIp = r.ip;
      previousRoute = r.previous;
      loopTrustError = r.error;
    }
    if (provenIp == null) {
      try {
        await trust.establish(box, payload.caSha256);
      } on Object {
        // The loop's own trust failure says more than the fallback's.
        if (loopTrustError != null) throw loopTrustError;
        rethrow;
      }
    }

    // The route the proven IP set is kept only once the enrolment is saved;
    // any failure before that puts the table back as it was.
    var saved = false;
    final EnrolledBox enrolled;
    final bool pinRequired;
    var pendingKey = false;
    try {
      // Replacing an enrolment: the new key waits in a pending slot and the old key stays usable until the new
      // enrolment is saved. A failure at any point discards only the pending key.
      final Map<String, String> jwk;
      if (replacing) {
        jwk = await key.generatePending();
        pendingKey = true;
      } else {
        jwk = await key.generate();
      }
      Future<void> dropKey() => pendingKey ? key.discardPending() : key.clear();
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
        await dropKey();
        if (e.status == 400 && e.message.startsWith('PIN sudah ditetapkan')) { // lang-ok: box wire text, matched exactly
          throw const EnrolPinExists();
        }
        rethrow;
      } catch (_) {
        await dropKey();
        rethrow;
      }

      pinRequired = result.pinRequired;
      enrolled = EnrolledBox(
        box: box,
        boxId: payload.boxId,
        deviceId: result.deviceId,
        userId: result.userId,
        userName: payload.user,
        roles: result.roles,
        caSha256: payload.caSha256,
        appLock: result.appLock ?? payload.appLock ?? true,
        cloud: payload.cloud == null ? null : Uri.parse(payload.cloud!),
        // The QR's name is a hint, kept so the locator may try it; it is only
        // trusted after a handshake to the pinned CA with a matching boxId.
        name: provenIp != null ? box.host : payload.name,
        lastIp: provenIp ??
            (isIpv4(box.host)
                ? box.host
                : (payload.ips.isEmpty ? null : payload.ips.first)),
      );
      try {
        await trust.commit(payload.caSha256);
        await store.save(enrolled);
      } catch (_) {
        if (pendingKey) await key.discardPending();
        rethrow;
      }
      saved = true;
      if (pendingKey) await key.commitPending();
    } catch (_) {
      // The key generation itself failed or the self-check threw: nothing pending may stay behind.
      if (pendingKey && !saved) await key.discardPending();
      rethrow;
    } finally {
      if (!saved && provenIp != null) _restoreRoute(box.host, previousRoute);
    }
    final surau = EnrolPayloadExtras.parse(payloadText).surauWithHelp;
    // a payload without surau info must not leave the previous surau's copy standing
    if (surau != null) {
      await surauInfoStore?.save(surau);
    } else {
      await surauInfoStore?.clear();
    }
    return EnrolOutcome(
      box: enrolled,
      pinPending: pinRequired && enrolled.appLock,
      surau: surau,
    );
  }

  /// Puts the route of [name] back to [previous] (removes it when null).
  void _restoreRoute(String name, String? previous) {
    if (previous == null) {
      trust.unrouteName(name);
    } else {
      trust.routeName(name, previous);
    }
  }

  /// When [box] (the origin the payload enrols at) is a box name, tries each
  /// IPv4 the payload lists, in order: fetch and check the root CA there
  /// (the bytes are checked against the QR's hash, so the origin does not
  /// matter), point the name at that IP, and ask the name for `/api/box/info`
  /// through the pinned client; the boxId must be the payload's. The first IP
  /// that passes wins and its route stays ([previous] is what the name had
  /// before, for the caller to restore on a later failure); a failed one puts
  /// the table back as it was. A root that does not match the QR's hash is
  /// the same for every IP and is rethrown at once. Other failures move on
  /// to the next IP; the last trust error is returned in [error] for the
  /// caller's fallback to prefer. [ip] is null when [box] is no name, the
  /// payload lists no IPv4 or none passed (the caller then enrols at [box]
  /// as it is).
  Future<({String? ip, String? previous, TrustError? error})> _establishByName(
    Uri box,
    EnrolPayload payload,
  ) async {
    final name = box.host;
    if (!isBoxName(name)) return (ip: null, previous: null, error: null);
    final previous = trust.routeOf(name);
    TrustError? trustError;
    final seen = <String>{};
    for (final ip in payload.ips) {
      if (!isIpv4(ip) || !seen.add(ip)) continue;
      try {
        await trust.establish(box.replace(host: ip), payload.caSha256);
        trust.routeName(name, ip);
        final info = await clientFor(box).getJson('/api/box/info');
        if (info['boxId'] != payload.boxId) {
          throw const BoxUnreachable('bukan kotak ini'); // lang-ok: diagnostic exception text, not shown
        }
        return (ip: ip, previous: previous, error: null);
      } on Object catch (e) {
        _restoreRoute(name, previous);
        if (e is TrustError) {
          if (e.kind == TrustKind.rootMismatch) rethrow;
          trustError ??= e;
        }
      }
    }
    return (ip: null, previous: null, error: trustError);
  }
}
