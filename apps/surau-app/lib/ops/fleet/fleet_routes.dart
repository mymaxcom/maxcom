// Plan 14 Task 14: the paths of the MAXCOM Ops screens and the rule for who may open them. Ops build only; the router
// and the menu reach this through `if (kOpsBuild)`, so the public app has no such path (a deep link finds nothing).

import '../../app/router.dart' show AppRoutes;
import 'fleet_providers.dart';

abstract final class OpsRoutes {
  static const String armada = '/ops/suraus';
  static const String surauDetail = '/ops/suraus/:id';
  static const String pending = '/ops/pending';
  static const String switcher = '/ops/switch';
  /// The notice of a phone whose ops mark was withdrawn (`/api/auth/me` `ops: false`); outside the app shell.
  static const String unmarked = '/ops/unmarked';
  /// The notice shown instead of a page that works from the phone's own copy of one surau's data.
  static const String localOnly = '/ops/local';

  static String detailFor(String id) => '/ops/suraus/$id';
}

/// Whether [path] is an ops screen at all.
bool isOpsPath(String path) => path == '/ops' || path.startsWith('/ops/');

/// May someone holding [roles] open [path]: the lists and the switcher for Pentadbir MAXCOM and Sokongan MAXCOM
/// (`fleet:read`). The server decides again on every call.
bool opsRouteAllowed(String path, Set<String> roles) {
  if (!isOpsPath(path)) return false;
  return fleetCanRead(roles);
}

/// Pages that work from the phone's own local copy and sync engine (Kewangan, the upload queue, the sync pages). A
/// MAXCOM session acts through the cloud for another surau's data, which that copy cannot do, so these are closed.
bool isLocalDataPath(String path) {
  bool under(String root) => path == root || path.startsWith('$root/');
  return under(AppRoutes.finance) ||
      under(AppRoutes.upload) ||
      under(AppRoutes.syncConflicts) ||
      path == AppRoutes.syncSettings;
}

/// True for the session that has no surau of its own on the phone: an ops cloud session of a role that may act for
/// others. The local copy and sync engine stay idle for it and the local data pages are not offered.
bool opsLocalDataClosed({required bool cloud, required Set<String> roles}) => cloud && fleetCanRead(roles);
