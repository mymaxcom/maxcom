// The phone's side of the box screen routes (Plan 14): ask the box who it
// is, finish a first setup or a recovery, prove a probe, leave the surau,
// rotate the recovery code, list recent enrolment codes. Thin calls on the
// existing [BoxClient] (pinned to the box's CA when the payload had one) and
// [BoxGateway]; the box's reason codes become typed errors the screens
// explain in their own words.

import '../features/shell/box_gateway.dart';
import 'box_client.dart';
import 'box_qr.dart';

/// What `GET /api/box/info` says. Public, no secrets.
class BoxInfo {
  const BoxInfo({
    required this.boxId,
    required this.keyFp,
    required this.name,
    required this.state,
    required this.reason,
    required this.linked,
    required this.https,
    required this.caSha256,
  });

  factory BoxInfo.fromJson(Map<String, dynamic> j) {
    String s(String k) => j[k] is String ? j[k] as String : '';
    return BoxInfo(
      boxId: s('boxId'),
      keyFp: s('keyFp'),
      name: s('name'),
      state: s('state'),
      reason: s('reason'),
      linked: j['linked'] == true,
      https: j['https'] == true,
      caSha256: j['caSha256'] is String ? j['caSha256'] as String : null,
    );
  }

  final String boxId;
  final String keyFp;
  final String name;

  /// 'setup', 'active', 'recovery' or 'locked'.
  final String state;
  final String reason;
  final bool linked;
  final bool https;
  final String? caSha256;

  String get fingerprintGroups => fingerprintGroupsOf(keyFp);
  String get boxIdGroups => fingerprintGroupsOf(boxId);
}

/// What the phone scanned is not the box it is talking to (a different `boxId` or key fingerprint).
class BoxQrMismatch implements Exception {
  const BoxQrMismatch();

  @override
  String toString() => 'BoxQrMismatch';
}

/// Throws [BoxQrMismatch] unless the scanned payload and the box's HTTPS answer agree on `boxId` and `keyFp`.
void checkBoxMatches(BoxQrPayload p, BoxInfo i) {
  if (p.boxId != i.boxId || p.keyFp != i.keyFp) throw const BoxQrMismatch();
}

/// Reasons the screens explain; each is built from a box answer.
sealed class SetupFailure implements Exception {
  const SetupFailure();
}

/// 409 `already_set_up`: someone else finished the setup first.
class SetupAlreadyDone extends SetupFailure {
  const SetupAlreadyDone();
}

/// 401 `bad_code`: the QR (or the recovery code) was wrong, expired or used. A recovery nonce is spent: scan again.
class SetupCodeInvalid extends SetupFailure {
  const SetupCodeInvalid();
}

/// 409 `not_in_recovery`: an active Pentadbir exists now.
class RecoveryNotNeeded extends SetupFailure {
  const RecoveryNotNeeded();
}

/// 409 `box_locked`: the box is suspended; recovery cannot run until it is released.
class BoxLocked extends SetupFailure {
  const BoxLocked();
}

/// 429.
class TooManyAttempts extends SetupFailure {
  const TooManyAttempts(this.retryAfterSec);

  final int? retryAfterSec;
}

/// 409 `last_admin_device`: this phone is the surau's last Pentadbir device.
class LastAdminDevice extends SetupFailure {
  const LastAdminDevice();
}

class SetupRequest {
  const SetupRequest({
    required this.nonce,
    required this.surauName,
    required this.boxName,
    required this.adminName,
    required this.deviceName,
    required this.publicJwk,
    required this.platform,
    required this.pin,
  });

  final String nonce;
  final String surauName;
  final String boxName;
  final String adminName;
  final String deviceName;
  final Map<String, String> publicJwk;
  final String platform;
  final String pin;

  Map<String, Object> toJson() => {
    'nonce': nonce,
    'surauName': surauName,
    'boxName': boxName,
    'adminName': adminName,
    'deviceName': deviceName,
    'publicJwk': publicJwk,
    'platform': platform,
    'pin': pin,
  };
}

class RecoveryRequest {
  const RecoveryRequest({
    required this.nonce,
    required this.recoveryCode,
    required this.adminName,
    required this.deviceName,
    required this.publicJwk,
    required this.platform,
    required this.pin,
  });

  final String nonce;
  final String recoveryCode;
  final String adminName;
  final String deviceName;
  final Map<String, String> publicJwk;
  final String platform;
  final String pin;

  Map<String, Object> toJson() => {
    'nonce': nonce,
    'recoveryCode': recoveryCode,
    'adminName': adminName,
    'deviceName': deviceName,
    'publicJwk': publicJwk,
    'platform': platform,
    'pin': pin,
  };
}

/// The 201 answer of setup and recovery. [recoveryCode] is shown once.
class SetupResult {
  const SetupResult({
    required this.deviceId,
    required this.userId,
    required this.roles,
    required this.recoveryCode,
    required this.appLock,
    this.surauId,
    this.boxName,
    this.surauName,
  });

  factory SetupResult.fromJson(Map<String, dynamic> j) => SetupResult(
    deviceId: j['deviceId'] as String,
    userId: j['userId'] as String,
    roles: (j['roles'] as List? ?? const []).map((e) => e.toString()).toList(growable: false),
    recoveryCode: j['recoveryCode'] as String,
    appLock: j['appLock'] is bool ? j['appLock'] as bool : true,
    surauId: j['surauId'] as String?,
    boxName: j['boxName'] as String?,
    surauName: j['surauName'] as String?,
  );

  final String deviceId;
  final String userId;
  final List<String> roles;
  final String recoveryCode;
  final bool appLock;
  final String? surauId;
  final String? boxName;
  final String? surauName;
}

/// One enrolment code the Pentadbir issued in the last 24 hours (never the code itself).
class EnrolCodeStatus {
  const EnrolCodeStatus({
    required this.userId,
    required this.userName,
    required this.deviceName,
    required this.expiresAt,
    required this.usedAt,
    required this.reuseAttempts,
  });

  factory EnrolCodeStatus.fromJson(Map<String, dynamic> j) => EnrolCodeStatus(
    userId: j['userId'] as String? ?? '',
    userName: j['userName'] as String? ?? '',
    deviceName: j['deviceName'] as String? ?? '',
    expiresAt: DateTime.tryParse(j['expiresAt'] as String? ?? ''),
    usedAt: DateTime.tryParse(j['usedAt'] as String? ?? ''),
    reuseAttempts: j['reuseAttempts'] is int ? j['reuseAttempts'] as int : 0,
  );

  final String userId;
  final String userName;
  final String deviceName;
  final DateTime? expiresAt;
  final DateTime? usedAt;
  final int reuseAttempts;
}

class SetupClient {
  const SetupClient(this.client);

  final BoxClient client;

  /// `GET /api/box/info`: public, so safe to read before anything is trusted.
  Future<BoxInfo> boxInfo() async => BoxInfo.fromJson(await client.getJson('/api/box/info'));

  Future<SetupResult> setupComplete(SetupRequest r) async {
    try {
      return SetupResult.fromJson(await client.postJson('/api/setup/complete', r.toJson()));
    } on BoxError catch (e) {
      throw _setupFailure(e) ?? e;
    }
  }

  Future<SetupResult> recoveryComplete(RecoveryRequest r) async {
    try {
      return SetupResult.fromJson(await client.postJson('/api/recovery/complete', r.toJson()));
    } on BoxError catch (e) {
      throw _setupFailure(e) ?? e;
    }
  }

  /// The phone proves it can reach the box (the TV's network check reads it).
  Future<void> probe(String nonce) async {
    await client.postJson('/api/setup/probe', {'nonce': nonce});
  }

  /// Revokes this phone's own device. 409 `last_admin_device` is [LastAdminDevice].
  Future<void> leave(BoxGateway gateway) async {
    try {
      await gateway.post('/api/auth/leave', <String, Object>{});
    } on BoxError catch (e) {
      throw _setupFailure(e) ?? e;
    }
  }

  /// Whether the box has a recovery code at all (`GET /api/recovery/status`, Pentadbir only). Null when the box does
  /// not say. A box upgraded from before codes existed has none.
  Future<bool?> recoveryCodeSet(BoxGateway gateway) async {
    final out = await gateway.getFresh('/api/recovery/status');
    final v = out['recoveryCodeSet'];
    return v is bool ? v : null;
  }

  /// A new recovery code, shown once; the old one dies.
  Future<String> rotateRecoveryCode(BoxGateway gateway) async {
    try {
      final out = await gateway.post('/api/recovery/code', <String, Object>{});
      final c = out['recoveryCode'];
      if (c is! String) throw const BoxError(500, 'Jawapan tidak sah');
      return c;
    } on BoxError catch (e) {
      throw _setupFailure(e) ?? e;
    }
  }

  Future<List<EnrolCodeStatus>> enrolRecent(BoxGateway gateway) async {
    final out = await gateway.getFresh('/api/enrol/recent');
    final list = out['codes'];
    if (list is! List) return const [];
    return list.whereType<Map<String, dynamic>>().map(EnrolCodeStatus.fromJson).toList(growable: false);
  }

  static SetupFailure? _setupFailure(BoxError e) {
    if (e.status == 429) return TooManyAttempts(e.retryAfterSec);
    switch ((e.status, e.code)) {
      case (409, 'already_set_up'):
        return const SetupAlreadyDone();
      case (401, 'bad_code'):
        return const SetupCodeInvalid();
      case (409, 'not_in_recovery'):
        return const RecoveryNotNeeded();
      case (409, 'box_locked'):
        return const BoxLocked();
      case (409, 'last_admin_device'):
        return const LastAdminDevice();
    }
    return null;
  }
}
