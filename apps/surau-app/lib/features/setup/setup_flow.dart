// First setup and recovery from the box screen's QR (Plan 14). The phone scans
// the signed QR on the TV, checks it (signature, expiry, fingerprint against what
// the box says over HTTPS), makes a device key, and finishes the setup or the
// recovery at the box. The key is kept after the box answered 201. A definite refusal (a
// 4xx answer) clears it so a retry starts clean; a lost reply (timeout, dropped
// connection, 5xx) keeps it and the same request, because the box may have
// committed: [SetupNotConfirmed] and a retry with the same key. Mirrors
// `EnrolFlow` (lib/features/enrol/enrol_flow.dart).

import '../../box/box_client.dart';
import '../../box/box_qr.dart';
import '../../box/device_key.dart';
import '../../box/setup_client.dart';
import '../common/surau_info.dart';
import '../enrol/enrol_flow.dart';

/// The QR on the TV is the wrong kind for this page (a setup page was given a recovery QR).
class WrongBoxQr implements Exception {
  const WrongBoxQr(this.kind);

  final ScannedKind kind;
}

/// The QR was valid but its time is up on this phone's clock.
class BoxQrExpired implements Exception {
  const BoxQrExpired(this.expiredAt);

  final DateTime expiredAt;
}

/// The box did not answer, or answered with a server error, after the request left the phone: it may or may not
/// have committed. The key and the request are kept; running the same step again sends the same request (the box
/// resumes it when it did commit). Never a definite refusal.
class SetupNotConfirmed implements Exception {
  const SetupNotConfirmed(this.cause);

  final Object cause;

  @override
  String toString() => 'SetupNotConfirmed($cause)';
}

/// What the phone learned from a checked QR, before anything is written.
class BoxInspection {
  const BoxInspection({required this.payload, required this.info});

  final BoxQrPayload payload;
  final BoxInfo info;
}

class SetupOutcome {
  const SetupOutcome({required this.box, required this.recoveryCode, required this.surauName});

  /// Remembered in the store already; the screen adopts it when the person is done with the recovery code.
  final EnrolledBox box;

  /// Shown once, then gone.
  final String recoveryCode;
  final String surauName;
}

class SetupFlow {
  SetupFlow({
    required this.clientFor,
    required this.key,
    required this.trust,
    required this.store,
    required this.platform,
    this.surauInfoStore,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Client for the box named in the QR (pinned to the CA just checked).
  final BoxClient Function(Uri box) clientFor;
  final DeviceKey key;
  final EnrolTrust trust;
  final EnrolledBoxStore store;
  final String platform;
  final SurauInfoStore? surauInfoStore;
  final DateTime Function() _now;

  /// The nonce of a request that may have reached the box; its key is still on the phone and is reused.
  String? _pendingNonce;

  /// Parse, verify the signature, check the expiry, trust the box's CA, ask the box who it is and compare. Writes
  /// nothing. Throws [BoxQrInvalid], [WrongBoxQr], [BoxQrExpired], [TrustError], [BoxUnreachable], [BoxQrMismatch],
  /// [SetupAlreadyDone] (setup on a box that is set up) or [RecoveryNotNeeded] (recovery on a box with a Pentadbir).
  Future<BoxInspection> inspect(String text, {required ScannedKind expect}) async {
    final kind = kindOf(text);
    if (kind != expect) {
      throw kind == ScannedKind.unknown ? const BoxQrInvalid() : WrongBoxQr(kind);
    }
    final payload = BoxQrPayload.parse(text, requireCa: trust.pinsCa);
    if (payload.isExpired(_now())) throw BoxQrExpired(payload.expiresAt);
    if (payload.box.isEmpty) {
      // a box with no certificate: never fall back to plain HTTP
      throw const TrustError('MAXCOM ini belum ada sijil HTTPS');
    }
    final box = Uri.parse(payload.box);
    await trust.establish(box, payload.caSha256);
    final info = await SetupClient(clientFor(box)).boxInfo();
    checkBoxMatches(payload, info);
    if (expect == ScannedKind.setup && info.state != 'setup') throw const SetupAlreadyDone();
    if (expect == ScannedKind.recovery && info.state != 'recovery') throw const RecoveryNotNeeded();
    return BoxInspection(payload: payload, info: info);
  }

  /// A probe QR: proves to the box that this phone can reach it (the TV's network check shows it). Writes nothing
  /// on the phone.
  Future<void> probe(String text) async {
    final i = await inspect(text, expect: ScannedKind.probe);
    await SetupClient(clientFor(Uri.parse(i.payload.box))).probe(i.payload.nonce);
  }

  /// A first setup: the first phone names the surau and becomes its first Pentadbir.
  Future<SetupOutcome> run(
    BoxInspection inspection, {
    required String surauName,
    required String adminName,
    required String deviceName,
    required String boxName,
    required String pin,
  }) {
    final p = inspection.payload;
    return _finish(p, adminName: adminName, surau: surauName.trim(), (client, publicJwk) => client.setupComplete(
      SetupRequest(
        nonce: p.nonce,
        surauName: surauName.trim(),
        boxName: boxName.trim(),
        adminName: adminName.trim(),
        deviceName: deviceName.trim(),
        publicJwk: publicJwk,
        platform: platform,
        pin: pin,
      ),
    ));
  }

  /// A recovery: a NEW Pentadbir, by the recovery code on paper. The answer carries the NEW recovery code.
  Future<SetupOutcome> recover(
    BoxInspection inspection, {
    required String recoveryCode,
    required String adminName,
    required String deviceName,
    required String pin,
  }) {
    final p = inspection.payload;
    return _finish(p, adminName: adminName, surau: inspection.info.name, (client, publicJwk) => client.recoveryComplete(
      RecoveryRequest(
        nonce: p.nonce,
        recoveryCode: recoveryCode,
        adminName: adminName.trim(),
        deviceName: deviceName.trim(),
        publicJwk: publicJwk,
        platform: platform,
        pin: pin,
      ),
    ));
  }

  Future<SetupOutcome> _finish(
    BoxQrPayload p,
    Future<SetupResult> Function(SetupClient client, Map<String, String> publicJwk) send, {
    required String adminName,
    required String surau,
  }) async {
    // Never touch the key of a working enrolment: this phone must leave its surau first.
    if (await store.load() != null && await key.exists()) throw const EnrolAlreadyEnrolled();
    final box = Uri.parse(p.box);
    // The same QR after a lost reply: the same key, so the box can recognise the request it already committed.
    final resume = _pendingNonce == p.nonce && await key.exists();
    final jwk = resume ? await key.publicJwk() : await key.generate();
    final publicJwk = {'kty': jwk['kty']!, 'crv': jwk['crv']!, 'x': jwk['x']!, 'y': jwk['y']!};
    final SetupResult result;
    try {
      result = await send(SetupClient(clientFor(box)), publicJwk);
    } on Object catch (e) {
      if (_isDefiniteRefusal(e)) {
        _pendingNonce = null;
        await key.clear();
        rethrow;
      }
      _pendingNonce = p.nonce;
      throw SetupNotConfirmed(e);
    }
    _pendingNonce = null;
    final enrolled = EnrolledBox(
      box: box,
      boxId: p.boxId,
      deviceId: result.deviceId,
      userId: result.userId,
      userName: adminName.trim(),
      roles: result.roles,
      caSha256: p.caSha256,
      appLock: result.appLock,
      cloud: p.cloud == null ? null : Uri.parse(p.cloud!),
    );
    await trust.commit(p.caSha256);
    await store.save(enrolled);
    final name = result.surauName ?? surau;
    if (name.isNotEmpty) await surauInfoStore?.save(SurauInfo(name: name));
    return SetupOutcome(box: enrolled, recoveryCode: result.recoveryCode, surauName: name);
  }
}

/// A refusal the box meant: one of its typed reasons or any 4xx answer. A timeout, a dropped connection, a 5xx or
/// an answer that cannot be read is not: the box may have committed.
bool _isDefiniteRefusal(Object e) => e is SetupFailure || (e is BoxError && e.status >= 400 && e.status < 500);
