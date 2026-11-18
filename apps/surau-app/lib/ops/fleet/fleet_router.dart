// Plan 14 Task 14: the ops routes inside the app shell. Reached from the router only through `if (kOpsBuild)`, so
// the public build registers none of them.

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'fleet_detail_screen.dart';
import 'fleet_providers.dart' show opsContextProvider;
import 'fleet_routes.dart';
import '../enrol/ops_enrol_screen.dart' show OpsUnmarkedNotice;
import 'fleet_screen.dart';
import 'pending_screen.dart';
import 'fleet_widgets.dart' show LocalOnlyNotice;
import 'surau_switcher.dart';

List<RouteBase> opsFleetRoutes() => [
  GoRoute(
    path: OpsRoutes.armada,
    builder: (context, state) => const FleetScreen(),
    routes: [
      GoRoute(
        path: ':id',
        builder: (context, state) => FleetDetailScreen(surauId: state.pathParameters['id']!),
      ),
    ],
  ),
  GoRoute(path: OpsRoutes.pending, builder: (context, state) => const PendingScreen()),
  GoRoute(path: OpsRoutes.localOnly, builder: (context, state) => const LocalOnlyNotice()),
  GoRoute(path: OpsRoutes.switcher, builder: (context, state) => const SurauSwitcherScreen()),
];

/// The notice for a phone that is no longer an ops device. Outside the shell, so no ops menu or banner is around it.
List<RouteBase> opsUnmarkedRoutes(void Function(BuildContext context) openThisDevice) => [
  GoRoute(
    path: OpsRoutes.unmarked,
    builder: (context, state) => Consumer(
      builder: (context, ref, _) => OpsUnmarkedNotice(
        onThisDevice: () => openThisDevice(context),
        // Ask the cloud again; when the phone is marked once more the guard leads away from the notice.
        onRetry: () => ref.invalidate(opsContextProvider),
      ),
    ),
  ),
];
