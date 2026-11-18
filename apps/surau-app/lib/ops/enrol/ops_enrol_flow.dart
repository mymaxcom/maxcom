// Plan 14 Task 26: enrolling this phone as a MAXCOM device. Ops build only
// (reached through `if (kOpsBuild)`). A cloud-only twin of `EnrolFlow.run`:
// no QR payload, no box CA, no LAN origin; the "box" is the cloud.

import '../../box/box_client.dart';
import '../../box/cloud_origin.dart';
import '../../box/device_key.dart';
import '../../features/enrol/enrol_flow.dart';

/// The one-time code from `ops-enrol` is 12 characters, dashes and spaces
/// ignored (the server normalises the same way).
String normaliseOpsCode(String raw) =>
    raw.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

bool isOpsCodeReady(String raw) => normaliseOpsCode(raw).length == 12;

/// `K7QM2XP9H4TW` as `K7QM-2XP9-H4TW` (what the field shows).
String groupOpsCode(String raw) {
  final n = normaliseOpsCode(raw);
  final b = StringBuffer();
  for (var i = 0; i < n.length && i < 12; i++) {
    if (i > 0 && i % 4 == 0) b.write('-');
    b.write(n[i]);
  }
  return b.toString();
}

/// The typed code is not 12 characters; nothing was sent.
class OpsCodeInvalid implements Exception {
  const OpsCodeInvalid();
}

/// The cloud accepted the code but the phone could not keep the enrolment: the code is used up, so MAXCOM must issue
/// a new one. The key made for it is cleared.
class OpsEnrolSaveFailed implements Exception {
  const OpsEnrolSaveFailed();
}

class OpsEnrolFlow {
  OpsEnrolFlow({
    required this.clientFor,
    required this.key,
    required this.store,
    required this.platform,
    Uri? cloud,
  }) : cloud = cloud ?? defaultCloudOrigin;

  final BoxClient Function(Uri origin) clientFor;
  final DeviceKey key;
  final EnrolledBoxStore store;
  final String platform;

  /// Public TLS cloud origin; no CA is pinned or stored.
  final Uri cloud;

  /// code check -> the cloud's own id (`GET /api/box/info`) -> key ->
  /// `POST /api/enrol/complete` with `client: 'ops'` -> remember the cloud as
  /// the device's "box". The key is kept only after the cloud accepted it.
  Future<EnrolOutcome> run(String code, {required String deviceName}) async {
    if (await store.load() != null && await key.exists()) {
      throw const EnrolAlreadyEnrolled();
    }
    if (!isOpsCodeReady(code)) throw const OpsCodeInvalid();
    final client = clientFor(cloud);
    final info = await client.getJson('/api/box/info');
    final id = info['boxId'];
    if (id is! String || id.isEmpty) throw const BoxError(502, 'Permintaan gagal');

    final jwk = await key.generate();
    final EnrolResult result;
    try {
      result = await client.enrolComplete(
        code: normaliseOpsCode(code),
        publicJwk: {
          'kty': jwk['kty']!,
          'crv': jwk['crv']!,
          'x': jwk['x']!,
          'y': jwk['y']!,
        },
        deviceName: deviceName.trim(),
        platform: platform,
        client: 'ops',
      );
    } catch (_) {
      await key.clear();
      rethrow;
    }
    final enrolled = EnrolledBox(
      box: cloud,
      boxId: id,
      deviceId: result.deviceId,
      userId: result.userId,
      userName: '',
      roles: result.roles,
      caSha256: null,
      appLock: result.appLock ?? true,
      cloud: cloud,
    );
    try {
      await store.save(enrolled);
    } catch (_) {
      // The code is consumed and nothing was kept: no key may stay for an enrolment that is not remembered.
      await key.clear();
      throw const OpsEnrolSaveFailed();
    }
    return EnrolOutcome(box: enrolled, pinPending: result.pinRequired && enrolled.appLock);
  }
}
