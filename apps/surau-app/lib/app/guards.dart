// Where a person may be, decided before every navigation (go_router's
// redirect): not enrolled -> enrol; enrolled but locked -> unlock (never the
// enrol form); unlocked
// -> anywhere their roles and the box's feature switches allow, else home
// with a notice. Pure, so the rules are tested without widgets.

import '../features/shell/menu.dart';
import '../ops/fleet/fleet_routes.dart';
import '../features/shell/permissions.dart';
import '../ops/ops_build.dart';
import 'router.dart';

class GuardInput {
  const GuardInput({
    required this.location,
    required this.enrolled,
    required this.unlocked,
    required this.roles,
    required this.features,
    this.needsSurau = false,
    this.opsRevoked = false,
    this.localDataClosed = false,
  });

  final String location;
  final bool enrolled;
  final bool unlocked;
  final Set<String> roles;
  final FeatureFlags features;

  /// Ops build: a Pentadbir MAXCOM on the cloud who has chosen no surau yet. The surau screens are not opened for
  /// them; they land on the list of suraus instead.
  final bool needsSurau;

  /// Ops build: the cloud answered `ops: false` for this phone. No ops screen opens; the notice does.
  final bool opsRevoked;

  /// Ops build: a MAXCOM session acting through the cloud; the pages that use the phone's own local copy are closed.
  final bool localDataClosed;
}

class GuardResult {
  const GuardResult({this.redirect, this.forbidden = false});

  /// Let the navigation through.
  static const GuardResult allow = GuardResult();

  /// Where to go instead, or null to stay.
  final String? redirect;

  /// The person asked for a page their roles do not allow.
  final bool forbidden;
}

GuardResult guard(GuardInput input) {
  final path = _path(input.location);
  final atDoor = path == AppRoutes.enrol || path == AppRoutes.unlock;
  // The first-setup and recovery pages are doors of a phone that belongs to no
  // surau yet (reached by scanning the box screen's QR from the enrol page).
  final joinDoor =
      path == AppRoutes.enrol || path == AppRoutes.setup || path == AppRoutes.recovery;

  if (!input.enrolled) {
    return joinDoor
        ? GuardResult.allow
        : const GuardResult(redirect: AppRoutes.enrol);
  }
  // An enrolled app never shows the enrol form: the way back to it is
  // "Daftar semula", which forgets the box first (so `enrolled` is false).
  if (joinDoor) {
    return GuardResult(
      redirect: input.unlocked ? AppRoutes.dashboard : AppRoutes.unlock,
    );
  }
  if (!input.unlocked) {
    if (atDoor) return GuardResult.allow;
    // A session that ends keeps the page: the unlock door remembers it.
    return GuardResult(redirect: _unlockFor(input.location, path));
  }
  if (atDoor) {
    return GuardResult(
      redirect: returnPathOf(input.location) ?? AppRoutes.dashboard,
    );
  }
  if (kOpsBuild && input.opsRevoked) {
    return path == OpsRoutes.unmarked || path == AppRoutes.thisDevice
        ? GuardResult.allow
        : const GuardResult(redirect: OpsRoutes.unmarked);
  }
  // The notice is only for a withdrawn mark; once the cloud says the phone is marked again, leave it.
  if (kOpsBuild && path == OpsRoutes.unmarked) return const GuardResult(redirect: AppRoutes.dashboard);
  if (kOpsBuild && input.needsSurau && !isOpsPath(path) && path != AppRoutes.thisDevice && path != AppRoutes.scan) {
    return const GuardResult(redirect: OpsRoutes.armada);
  }
  if (kOpsBuild && input.localDataClosed && isLocalDataPath(path)) {
    return const GuardResult(redirect: OpsRoutes.localOnly);
  }
  if (routeAllowed(path, input.roles, input.features)) return GuardResult.allow;
  return const GuardResult(redirect: AppRoutes.dashboard, forbidden: true);
}

String _unlockFor(String location, String path) {
  if (path == AppRoutes.dashboard) return AppRoutes.unlock;
  return '${AppRoutes.unlock}?from=${Uri.encodeQueryComponent(location)}';
}

/// The page an unlock returns to: the `from` of an unlock address when it is
/// a plain in-app path (never another site, never a door), else null.
String? returnPathOf(String location) {
  final Uri uri;
  try {
    uri = Uri.parse(location);
  } on FormatException {
    return null;
  }
  final from = uri.queryParameters['from'];
  if (from == null || !from.startsWith('/') || from.startsWith('//')) {
    return null;
  }
  if (from.contains(r'\') || from.contains('://')) return null;
  final target = _path(from);
  if (target == AppRoutes.enrol ||
      target == AppRoutes.unlock ||
      target == AppRoutes.setup ||
      target == AppRoutes.recovery) {
    return null;
  }
  return from;
}

String _path(String location) {
  final q = location.indexOf('?');
  return q >= 0 ? location.substring(0, q) : location;
}
