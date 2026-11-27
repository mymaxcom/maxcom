// The phone move (phase 2C): a phone enrolled at a box that became a follower asks that box where the surau is
// managed now, then joins the main box with the one-time ticket it got and a NEW PIN.
//
//   1. `POST /api/follow/move/challenge {deviceId}` at the box the phone knows, answered with a nonce;
//   2. `POST /api/follow/move {deviceId, nonce, signature}`, the signature made with the device key over
//      `maxcom-link-move\n<that box's id>\n<deviceId>\n<nonce>` (the same key and encoding as the unlock), answered
//      with the pointer: the main box's name, id, key fingerprint, root CA hash and addresses, and the ticket;
//   3. the phone reaches the main box on one of the addresses, trusting only the root CA hash of the pointer, and
//      checks that the box that answers is the one named (id and key fingerprint);
//   4. the ticket is an ordinary enrolment code at the main box: the phone makes a new device key, enrols with a new
//      PIN and only then replaces the stored box.
//
// What is NOT checked: the pointer's `sig` (the follower's identity signature). The phone does not hold the old box's
// identity public key (enrolment never gave it one), so it relies on the pinned TLS to the old box, which is how every
// call to that box is trusted already; the pointer is also checked to come from the box id this phone enrolled at.
// The master is proven independently in step 3.

import 'dart:convert';
import 'dart:typed_data';

import '../../box/box_name.dart' show isIpv4;
import '../../box/box_client.dart';
import '../../box/device_key.dart';
import '../../box/setup_client.dart' show SetupClient;
import '../enrol/enrol_flow.dart';
import '../enrol/pin_policy.dart';

/// `utf8("maxcom-link-move\n" + boxId + "\n" + deviceId + "\n" + nonce)`: the message the follower checks
/// (`moveMessage` in apps/box-server/src/follow/moves.ts). [boxId] is the FOLLOWER's id, the box the phone knows.
Uint8List moveMessage(String boxId, String deviceId, String nonce) =>
    Uint8List.fromList(utf8.encode('maxcom-link-move\n$boxId\n$deviceId\n$nonce'));

/// True for the answer of a follower to a session or admin route: 409 `follower`.
bool isFollowerRefusal(Object e) => e is BoxError && e.status == 409 && e.code == 'follower';

/// The pointer a follower gives a phone that proved its device key (`POST /api/follow/move`).
class MovePointer {
  const MovePointer({
    required this.linkId,
    required this.fromBoxId,
    required this.masterName,
    required this.masterBoxId,
    required this.masterKeyFp,
    required this.masterCaSha256,
    required this.addresses,
    required this.ticket,
    required this.expiresAt,
    required this.sig,
  });

  /// Strict read of the answer body. [FormatException] when anything is missing or of the wrong shape.
  factory MovePointer.fromJson(Map<String, dynamic> body) {
    final p = body['pointer'];
    if (p is! Map || p['v'] != 1) throw const FormatException('pointer');
    final m = p['master'];
    if (m is! Map) throw const FormatException('master');
    String str(Object? v) => v is String && v.isNotEmpty && v.length <= 200 ? v : throw const FormatException('string');
    final addresses = m['addresses'];
    if (addresses is! List || addresses.isEmpty || addresses.length > 8) throw const FormatException('addresses');
    final ticket = str(p['ticket']);
    if (!_ticket.hasMatch(ticket)) throw const FormatException('ticket');
    final boxId = str(m['boxId']);
    final ca = str(m['caSha256']).toLowerCase();
    if (!_boxId.hasMatch(boxId) || !_sha.hasMatch(ca)) throw const FormatException('master');
    return MovePointer(
      linkId: str(p['linkId']),
      fromBoxId: str(p['fromBoxId']),
      masterName: str(m['name']),
      masterBoxId: boxId,
      masterKeyFp: str(m['keyFp']),
      masterCaSha256: ca,
      addresses: [for (final a in addresses) originOf(str(a)) ?? (throw const FormatException('address'))],
      ticket: ticket,
      expiresAt: DateTime.parse(str(p['expiresAt'])),
      sig: str(body['sig']),
    );
  }

  static final RegExp _ticket = RegExp(r'^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$');
  static final RegExp _boxId = RegExp(r'^[0-9a-f]{16}$');
  static final RegExp _sha = RegExp(r'^[0-9a-f]{64}$');

  final String linkId;

  /// The box id of the follower that answered: must be the box this phone enrolled at.
  final String fromBoxId;
  final String masterName;
  final String masterBoxId;
  final String masterKeyFp;
  final String masterCaSha256;

  /// HTTPS origins of the main box, in the order the follower listed them.
  final List<String> addresses;

  /// The one-time enrolment code at the main box. Never shown.
  final String ticket;
  final DateTime expiresAt;

  /// The follower's identity signature over the pointer; kept, not verified here (see the top of this file).
  final String sig;

  @override
  String toString() => 'MovePointer($masterName)';
}

/// The enrolment text (`surau1:` + base64url JSON) of the join ticket in [p], for the web app of the FOLLOWER: a browser
/// cannot call a box on another origin, so the person opens that box's own web app and enrols there with this text.
/// The ticket is an ordinary enrolment code of that box. [user] is the name the enrol page shows ("Sertai ... sebagai").
String joinEnrolText(MovePointer p, {required String user, String? origin, int? expMs}) {
  origin ??= p.addresses.first;
  final json = jsonEncode({
    'v': 1,
    'mode': isIpv4(Uri.parse(origin).host) ? 'ip' : 'domain',
    'box': origin,
    'boxId': p.masterBoxId,
    'caSha256': p.masterCaSha256,
    'code': p.ticket,
    'user': user.length > 80 ? user.substring(0, 80) : user,
    'exp': expMs ?? p.expiresAt.millisecondsSinceEpoch,
    // The person chooses a NEW PIN at the follower, as in the direct join.
    'pinSet': false,
  });
  return 'surau1:${base64Url.encode(utf8.encode(json)).replaceAll('=', '')}';
}

/// The address that opens the enrol page of the follower's web app with the join ticket: `<origin>/app/#/enrol?join=...`.
/// The ticket rides in the URL fragment, which a browser never sends to any server; the enrol page reads it once and
/// removes it from the address bar.
Uri followerEnrolUrl(MovePointer p, {required String user, String? origin, int? expMs}) {
  final base = Uri.parse(origin ?? p.addresses.first);
  return Uri(
    scheme: base.scheme,
    host: base.host,
    port: base.hasPort ? base.port : null,
    path: '/app/',
    fragment: '/enrol?join=${Uri.encodeQueryComponent(joinEnrolText(p, user: user, origin: origin, expMs: expMs))}',
  );
}

/// An `https` origin (`https://10.168.50.10:8443`) from [text]: no credentials, path, query or fragment; null if not.
String? originOf(String text) {
  final Uri u;
  try {
    u = Uri.parse(text);
  } on FormatException {
    return null;
  }
  if (u.scheme != 'https' || u.host.isEmpty) return null;
  if (u.userInfo.isNotEmpty || u.hasQuery || u.hasFragment) return null;
  if (u.path != '' && u.path != '/') return null;
  return u.hasPort && u.port != 443 ? 'https://${u.host}:${u.port}' : 'https://${u.host}';
}

/// Why a move did not happen; the screen words each one.
sealed class MoveFailure implements Exception {
  const MoveFailure();
}

/// The phone is not on the surau network (or the box did not answer): open the app on the surau Wi-Fi once.
class MoveAway extends MoveFailure {
  const MoveAway();
}

/// No ticket for this phone (an admin's phone, an unknown phone, an expired or used ticket): ask the admin of the
/// main box for a join code.
class MoveNeedCode extends MoveFailure {
  const MoveNeedCode();
}

class MoveTooMany extends MoveFailure {
  const MoveTooMany();
}

/// The box that answered at the main box's addresses is not the one the pointer names. Nothing was changed.
class MoveWrongBox extends MoveFailure {
  const MoveWrongBox();
}

/// The answer of the old box could not be read or is not from the box this phone enrolled at.
class MoveBadPointer extends MoveFailure {
  const MoveBadPointer();
}

/// The box this phone knows is not a follower (any more): there is nothing to move.
class MoveNotFollower extends MoveFailure {
  const MoveNotFollower();
}

/// A new PIN the box would refuse (checked here, nothing sent).
class MovePinTooWeak extends MoveFailure {
  const MovePinTooWeak();
}

class MoveFlow {
  MoveFlow({
    required this.box,
    required this.oldClient,
    required this.key,
    required this.trust,
    required this.clientFor,
    required this.store,
    required this.platform,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final DateTime Function() _now;

  /// How far this phone's clock may run ahead of the box before a ticket that is still valid reads as ended. The box
  /// is the judge of the ticket; this only avoids a useless call.
  static const Duration clockSkew = Duration(minutes: 2);

  bool _ended(MovePointer p) => !p.expiresAt.add(clockSkew).isAfter(_now().toUtc());

  /// The box this phone is enrolled at (now a follower).
  final EnrolledBox box;

  /// A client of that box, pinned to the CA kept at enrolment.
  final BoxClient oldClient;
  final DeviceKey key;
  final EnrolTrust trust;

  /// A client for the main box, pinned to the CA [trust] just established (the enrolment's `clientFor`).
  final BoxClient Function(Uri box) clientFor;
  final EnrolledBoxStore store;
  final String platform;

  /// The main box's name as the follower's own TV answer says it (`GET /api/kiosk/link`, open to any phone), or
  /// null. Best effort: it only improves the sentence "Minta kod sertai daripada Pentadbir (name)".
  Future<String?> masterName() async {
    try {
      final j = await oldClient.getJson('/api/kiosk/link');
      final m = j['master'];
      final name = m is Map ? m['name'] : null;
      return name is String && name.isNotEmpty && name.length <= 80 ? name : null;
    } on Object {
      return null;
    }
  }

  /// Steps 1 and 2: proves the device key to the old box and returns its pointer. Throws a [MoveFailure].
  Future<MovePointer> pointer() async {
    if (!await key.exists()) throw const MoveNeedCode();
    final String nonce;
    try {
      final c = await oldClient.postJson('/api/follow/move/challenge', {'deviceId': box.deviceId});
      final n = c['nonce'];
      if (n is! String || n.isEmpty || n.length > 100) throw const MoveBadPointer();
      nonce = n;
    } on BoxError catch (e) {
      throw _mapOld(e);
    } on BoxUnreachable {
      throw const MoveAway();
    }
    final signature = b64url(await key.sign(moveMessage(box.boxId, box.deviceId, nonce)));
    final Map<String, dynamic> body;
    try {
      body = await oldClient.postJson('/api/follow/move', {
        'deviceId': box.deviceId,
        'nonce': nonce,
        'signature': signature,
      });
    } on BoxError catch (e) {
      throw _mapOld(e);
    } on BoxUnreachable {
      throw const MoveAway();
    }
    final MovePointer p;
    try {
      p = MovePointer.fromJson(body);
    } on FormatException {
      throw const MoveBadPointer();
    }
    if (p.fromBoxId != box.boxId) throw const MoveBadPointer();
    if (_ended(p)) throw const MoveNeedCode();
    return p;
  }

  MoveFailure _mapOld(BoxError e) {
    if (e.status == 403 || e.code == 'lan_only') return const MoveAway();
    if (e.status == 429) return const MoveTooMany();
    if (e.status == 401 && e.code == 'bad_signature') return const MoveNeedCode();
    if (e.status == 404 && e.code == 'no_ticket') return const MoveNeedCode();
    if (e.status == 404 || e.code == 'not_found') return const MoveNotFollower();
    if (e.status == 400) return const MoveBadPointer();
    return const MoveAway();
  }

  /// Steps 3 and 4. The device key is replaced only after the main box has been reached and has proven who it is.
  /// Returns the new enrolment, already saved. A failure after the new key was made removes it again (the old key is
  /// gone by then; the person asks the admin for a join code).
  Future<EnrolOutcome> connect(MovePointer p, {required String newPin, required String deviceName}) async {
    if (!isValidPin(newPin)) throw const MovePinTooWeak();
    // A ticket that ended while the person typed the PIN is not tried: nothing is changed, a join code is the way.
    if (_ended(p)) throw const MoveNeedCode();
    final (origin, client) = await _reachMaster(p);

    final jwk = await key.generate();
    final publicJwk = {'kty': jwk['kty']!, 'crv': jwk['crv']!, 'x': jwk['x']!, 'y': jwk['y']!};
    final EnrolResult result;
    try {
      result = await client.enrolComplete(
        code: p.ticket,
        publicJwk: publicJwk,
        deviceName: deviceName.trim(),
        platform: platform,
        pin: newPin,
      );
    } on BoxError catch (e) {
      await key.clear();
      // A refused, used or expired ticket reads the same as no ticket: a join code is the way.
      throw e.status == 429 ? const MoveTooMany() : (e.status >= 400 && e.status < 500 ? const MoveNeedCode() : e);
    } on Object {
      await key.clear();
      rethrow;
    }

    final enrolled = EnrolledBox(
      box: Uri.parse(origin),
      boxId: p.masterBoxId,
      deviceId: result.deviceId,
      userId: result.userId,
      userName: box.userName,
      roles: result.roles,
      caSha256: p.masterCaSha256,
      appLock: result.appLock ?? true,
      lastIp: isIpv4(Uri.parse(origin).host) ? Uri.parse(origin).host : null,
    );
    await trust.commit(p.masterCaSha256);
    await store.save(enrolled);
    return EnrolOutcome(box: enrolled, pinPending: result.pinRequired && enrolled.appLock);
  }

  /// The first address of the pointer where a box answers with the id and key fingerprint the pointer names, over a
  /// connection trusting only the pointer's root CA hash.
  Future<(String, BoxClient)> _reachMaster(MovePointer p) async {
    var wrong = false;
    for (final origin in p.addresses) {
      final uri = Uri.parse(origin);
      try {
        await trust.establish(uri, p.masterCaSha256);
        final client = clientFor(uri);
        final info = await SetupClient(client).boxInfo();
        if (info.boxId == p.masterBoxId && info.keyFp == p.masterKeyFp) return (origin, client);
        wrong = true;
      } on TrustError catch (e) {
        if (e.kind == TrustKind.rootMismatch || e.kind == TrustKind.rootInvalid) wrong = true;
      } on BoxUnreachable {
        // try the next address
      } on BoxError {
        // not a box that knows this route: try the next address
      }
    }
    throw wrong ? const MoveWrongBox() : const MoveAway();
  }
}
