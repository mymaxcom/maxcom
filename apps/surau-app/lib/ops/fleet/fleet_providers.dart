// Plan 14 Task 14: the state of the MAXCOM Ops fleet screens. Ops build only (reached through `if (kOpsBuild)`).
// The acting surau lives in memory for one run: a Pentadbir MAXCOM who reopens the app starts with none chosen, so
// nothing is ever done in the wrong surau by habit.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/wire.dart' show SessionDto;
import 'fleet_models.dart';
import 'fleet_routes.dart' show opsLocalDataClosed;

class ActingSurauNotifier extends Notifier<ActingSurau?> {
  @override
  ActingSurau? build() {
    // Locking, signing out or a 401 ends the work in that surau.
    ref.listen(sessionProvider, (previous, session) {
      if (session != null) return;
      // Cached tenant answers of a cloud session do not outlive it (sign-out, lock, a 401). A box session keeps its
      // cache across a 401 (offline reading), as in the public build.
      if (previous?.via == SessionDto.viaCloud) ref.read(readCacheProvider).clear();
      if (state != null) state = null;
    });
    return null;
  }

  /// Work in [surau] from the next request on. Everything cached for the previous surau is dropped, so a screen can
  /// never show the other surau's last answer.
  void choose(ActingSurau surau) {
    if (state?.id == surau.id) return;
    ref.read(readCacheProvider).clear();
    state = surau;
  }

  void clear() {
    if (state == null) return;
    ref.read(readCacheProvider).clear();
    state = null;
  }
}

final actingSurauProvider = NotifierProvider<ActingSurauNotifier, ActingSurau?>(ActingSurauNotifier.new);

/// The id the gateway sends in the header; the gateway rebuilds when it changes.
final actingSurauIdProvider = Provider<String?>((ref) => ref.watch(actingSurauProvider.select((a) => a?.id)));

/// Whether the local data pages are closed and the sync engine idle: a MAXCOM cloud session (acting for any surau,
/// or none yet). Watches only the session and roles, never the gateway, so the engine can depend on it.
final opsLocalDataClosedProvider = Provider<bool>(
  (ref) => opsLocalDataClosed(cloud: ref.watch(isCloudGatewayProvider), roles: ref.watch(rolesProvider)),
);

/// `GET /api/auth/me` on the cloud: whether this session is an ops session that may act for any surau. Null on a
/// box session or before sign-in; an error when the cloud does not answer. Refetched for each new session token only (not when
/// the acting surau changes, so the switcher does not blink).
final opsContextProvider = FutureProvider<OpsContext?>(
  (ref) async {
    if (!ref.watch(isCloudGatewayProvider)) return null;
    ref.watch(sessionProvider.select((s) => s?.token));
    // Rebuilds when the gateway first exists, not when only the acting surau changes it.
    ref.watch(gatewayProvider.select((g) => g?.token));
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return null;
    // A failed read is an error, not "no": the roles decide meanwhile (see [switcherVisibleProvider]) and the person's
    // next try (the switcher button, pull to refresh) asks again. No automatic retry loop against the cloud.
    return OpsContext.fromJson(await gateway.getFresh('/api/auth/me'));
  },
  retry: (_, _) => null,
);

/// Asks `/api/auth/me` again when the last try failed; nothing changes otherwise.
void retryOpsContext(WidgetRef ref) {
  if (ref.read(opsContextProvider).hasError) ref.invalidate(opsContextProvider);
}

/// The switcher is shown for an ops session of the cloud that sees every surau; never on a box, never for a surau user.
final switcherVisibleProvider = Provider<bool>((ref) {
  if (!ref.watch(isCloudGatewayProvider)) return false;
  final ctx = ref.watch(opsContextProvider);
  final known = ctx.value;
  if (known != null) return known.mayAct;
  // Unknown (the check failed): the roles of the session decide, so one failed call does not hide the switcher.
  return ctx.hasError && fleetCanRead(ref.watch(rolesProvider));
});

/// A Pentadbir MAXCOM or Sokongan MAXCOM on the cloud who has chosen no surau: tenant screens ask for one first. The
/// answer of `/api/auth/me` decides when it is known; the effective roles (the server gives an ops role only to an ops
/// device) decide until then.
final needsSurauProvider = Provider<bool>((ref) {
  if (!ref.watch(isCloudGatewayProvider)) return false;
  if (ref.watch(actingSurauProvider) != null) return false;
  final ctx = ref.watch(opsContextProvider).value;
  if (ctx != null) return ctx.mayAct;
  final roles = ref.watch(rolesProvider);
  return roles.contains('superadmin') || roles.contains('support');
});

/// True when the cloud has answered `GET /api/auth/me` with `ops: false` for this cloud session: the Pentadbir MAXCOM
/// withdrew the ops mark of this phone. The router then shows the notice and no ops screen. An unanswered check is
/// not this (nothing is withdrawn on a network failure).
final opsRevokedProvider = Provider<bool>((ref) {
  if (!ref.watch(isCloudGatewayProvider)) return false;
  final ctx = ref.watch(opsContextProvider).value;
  return ctx != null && !ctx.ops;
});

/// `GET /api/suraus`: every surau with its boxes and storage, from the cloud.
final fleetSurausProvider = FutureProvider.autoDispose<List<FleetSurau>>(
  (ref) async {
    ref.watch(dataVersionProvider);
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return const [];
    return parseSuraus(await gateway.getFresh('/api/suraus'));
  },
  // A failed read waits for the person's `Cuba lagi`, not an automatic retry loop against the cloud.
  retry: (_, _) => null,
);

/// `GET /api/fleet/pending`: the boxes the Worker knows that the cloud has not linked. Both lists are read again each
/// time a screen opens (they are dropped when no screen shows them); a failure reaches the screen with the server's own
/// BM message.
final pendingBoxesProvider = FutureProvider.autoDispose<List<PendingBox>>(
  (ref) async {
    ref.watch(dataVersionProvider);
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return const [];
    return parsePending(await gateway.getFresh('/api/fleet/pending'));
  },
  retry: (_, _) => null,
);

/// One surau by id out of the list (null when unknown).
FleetSurau? surauById(List<FleetSurau> all, String id) {
  for (final s in all) {
    if (s.id == id) return s;
  }
  return null;
}

/// Fleet writes (T15) and the pages need to know who may do what: Pentadbir MAXCOM changes things, Sokongan MAXCOM
/// only reads.
bool fleetCanRead(Set<String> roles) => roles.contains('superadmin') || roles.contains('support');
bool fleetCanManage(Set<String> roles) => roles.contains('superadmin');
