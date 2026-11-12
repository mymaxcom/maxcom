// Which MAXCOM cloud this phone falls back to when the box is away: the one
// named at enrolment, else the one the box reported later (`cloud` in
// `GET /api/health`, kept with [EnrolledBox.withCloud]), else the default.

import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import 'trust.dart' show usesPublicTls;

/// The cloud a phone tries when its enrolment names none.
final Uri defaultCloudOrigin = Uri.parse('https://api.mymaxcom.my');

/// The cloud origin for [b]: its own, else [defaultCloudOrigin].
Uri cloudOriginOf(EnrolledBox b) => b.cloud ?? defaultCloudOrigin;

/// True when [b] names no cloud of its own, so the cloud tried is only the
/// default (the box may never have been linked to it).
bool usesDefaultCloud(EnrolledBox b) => b.cloud == null;

/// The cloud origin in a box's health answer, when it may be kept: an https
/// origin (no path, query, fragment or user info) that passes the public-TLS
/// rule of [usesPublicTls] (host `mymaxcom.my` or a subdomain). Anything else
/// is null and ignored.
Uri? acceptedCloudOrigin(EnrolledBox b, Object? raw) {
  if (raw is! String || raw.isEmpty || raw.length > 200) return null;
  final Uri u;
  try {
    u = Uri.parse(raw.trim());
  } on FormatException {
    return null;
  }
  if (u.scheme != 'https' || u.host.isEmpty) return null;
  if (u.hasQuery || u.hasFragment || u.userInfo.isNotEmpty) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  final origin = Uri(
    scheme: 'https',
    host: u.host.toLowerCase(),
    port: u.hasPort && u.port != 443 ? u.port : null,
  );
  final probe = EnrolledBox(
    box: origin,
    boxId: b.boxId,
    deviceId: b.deviceId,
    userId: b.userId,
    userName: b.userName,
    roles: b.roles,
    caSha256: b.caSha256,
    appLock: b.appLock,
    cloud: origin,
  );
  return usesPublicTls(probe) ? origin : null;
}
