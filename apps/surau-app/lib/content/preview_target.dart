// Where the Android preview WebView should load the kiosk page from NOW.
//
// The enrolled origin (`EnrolledBox.box`) is the address the box had at
// enrolment. When the box moves to another network address the app's own
// clients keep working, because they open the box's local name through the
// route table (BoxRoutes: name -> the IPv4 a verified, pinned answer came
// from). A WebView cannot resolve `.local` names and cannot use that table, so
// it is given the proven IPv4 itself, with the scheme and port of the stored
// origin. Trust is unchanged: the WebView proceeds past its certificate error
// only for a leaf byte-identical to the one the pinned connection received
// (judgeSslError), and that leaf is fetched through the name and the same
// route. The web build keeps the box's own origin (an iframe on it).

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../box/box_name.dart';
import '../box/routes.dart';
import '../box/trust.dart' show isPublicCloudOrigin;
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../sync/transport.dart' show boxAt;

/// The origin to load and the box to fetch the pinned leaf for.
class PreviewTarget {
  const PreviewTarget({required this.origin, required this.leafBox, required this.routed});

  /// The origin the preview loads (the stored one, or the stored one with
  /// the proven IPv4 for its host).
  final Uri origin;

  /// The box whose pinned leaf is compared with what the WebView is shown:
  /// the enrolled box, or, when [routed], the same box at its local name
  /// (the pinned connection reaches the proven address through the route
  /// table and checks the certificate for the name).
  final EnrolledBox leafBox;

  /// True when [origin] was built from the route table.
  final bool routed;
}

/// Chooses the preview origin for [box]. Pure: [routes] is read once.
///
/// A name plus a route for it gives the stored origin with its host replaced
/// by that IPv4 (scheme and port kept). No name, no route, a non-https or
/// cloud origin, the web build or no route table give the stored origin.
PreviewTarget previewTargetFor(EnrolledBox box, BoxRoutes? routes, {bool isWeb = kIsWeb}) {
  final stored = PreviewTarget(origin: box.box, leafBox: box, routed: false);
  if (isWeb || routes == null) return stored;
  final name = box.name;
  if (name == null || !isBoxName(name)) return stored;
  if (box.box.scheme != 'https' || isPublicCloudOrigin(box.box)) return stored;
  final ip = routes.addressOf(name);
  if (ip == null || !isIpv4(ip)) return stored;
  final nameOrigin = boxNameOrigin(name, box.box.port);
  return PreviewTarget(
    origin: box.box.replace(host: ip),
    leafBox: boxAt(box, nameOrigin),
    routed: true,
  );
}

/// The preview target of the enrolled box; recomputed when the route table
/// changes (BoxRoutes.epoch), so a moved box reloads the preview.
final previewTargetProvider = Provider<PreviewTarget?>((ref) {
  final box = ref.watch(enrolledBoxProvider);
  if (box == null) return null;
  final deps = ref.watch(appDepsProvider);
  ref.watch(boxRoutesEpochProvider);
  return previewTargetFor(box, deps.routes);
});
