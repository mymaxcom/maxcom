// Plan 14 Task 14: the menu rows of the MAXCOM Ops app (Senarai surau, Kotak menunggu), ahead of the surau pages.
// Reached from the menu only through `if (kOpsBuild)`.

import 'package:flutter/material.dart';

import '../../features/shell/menu.dart';
import 'fleet_providers.dart';
import 'fleet_routes.dart';
import 'fleet_texts.dart';

List<MenuItem> opsFleetMenu(Set<String> roles) => [
  if (fleetCanRead(roles)) ...[
    MenuItem(
      entry: MenuEntry.fleet,
      route: OpsRoutes.armada,
      icon: Icons.apartment_outlined,
      selectedIcon: Icons.apartment_rounded,
      labelOf: (s) => FleetT.ofS(s).armadaTitle,
    ),
    MenuItem(
      entry: MenuEntry.fleet,
      route: OpsRoutes.pending,
      icon: Icons.hourglass_empty_rounded,
      selectedIcon: Icons.hourglass_top_rounded,
      labelOf: (s) => FleetT.ofS(s).pendingMenu,
    ),
  ],
];
