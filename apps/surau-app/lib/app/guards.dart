// Where a person may be, decided before every navigation (go_router's
// redirect): not enrolled -> enrol; enrolled but locked -> unlock (never the
// enrol form); unlocked
// -> anywhere their roles and the box's feature switches allow, else home
// with a notice. Pure, so the rules are tested without widgets.

import '../features/shell/menu.dart';
import '../features/shell/permissions.dart';
import 'router.dart';

class GuardInput {
  const GuardInput({
    required this.location,
    required this.enrolled,
    required this.unlocked,
    required this.roles,
    required this.features,
  });

  final String location;
  final bool enrolled;
  final bool unlocked;
  final Set<String> roles;
  final FeatureFlags features;
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
    return atDoor
        ? GuardResult.allow
        : const GuardResult(redirect: AppRoutes.unlock);
  }
  if (atDoor) return const GuardResult(redirect: AppRoutes.dashboard);
  if (routeAllowed(path, input.roles, input.features)) return GuardResult.allow;
  return const GuardResult(redirect: AppRoutes.dashboard, forbidden: true);
}

String _path(String location) {
  final q = location.indexOf('?');
  return q >= 0 ? location.substring(0, q) : location;
}
