// What the "Skrin TV dan MAXCOM Kiosk Box" list shows: the main box, the follower boxes (`GET /api/boxes`) and the browser
// screens (the paired devices of platform `kiosk` that are not a box). One provider reads both lists and builds the
// rows; the editor of one TV finds its name here too.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart' show BoxError, BoxUnreachable;
import '../../box/wire.dart' show DeviceDto;
import '../../screens/devices_screen.dart' show devicesPath, parseDevices;
import '../../screens/widgets/box_read.dart' show boxJsonProvider;
import '../link/link_api.dart';
import '../link/link_backup.dart';
import '../link/link_controller.dart' show linkApiProvider;
import '../people/people_activity.dart';
import 'tv_profile.dart';

/// A box seen as connected when it was heard from this recently.
const Duration boxConnectedWithin = Duration(minutes: 2);

enum ScreenKind { main, follower, browser }

/// One row of the list.
class ScreenRowData {
  const ScreenRowData({
    required this.kind,
    required this.id,
    required this.name,
    this.version,
    this.lastSeenAt,
    this.linkedAt,
    this.removedAt,
    this.notSeenSince,
    this.backup,
    this.kept,
    this.freeBytes,
  });

  final ScreenKind kind;

  /// The TV id of its profile: `self` for the main box's own TV, the device id for every other screen.
  final String id;
  final String name;
  final String? version;
  final DateTime? lastSeenAt;
  final DateTime? linkedAt;
  final DateTime? removedAt;

  /// A follower the main box has not seen for more than 3 days: since when (the box says so). It is only shown;
  /// the row is never removed by itself.
  final DateTime? notSeenSince;

  /// The main box's own row: the backup of its data before it was linked, the data it keeps after an unlink, and the
  /// free room on its volume (`self` of `GET /api/boxes`).
  final LinkBackup? backup;
  final LinkKept? kept;
  final int? freeBytes;

  bool get removed => removedAt != null;

  bool get stale => !removed && notSeenSince != null;

  /// Heard from within [boxConnectedWithin] of [now] (the clock the times were taken on). The main box is the one
  /// this phone is talking to: it is connected whenever the list could be read.
  bool connectedAt(DateTime now) =>
      kind == ScreenKind.main || (!removed && lastSeenAt != null && now.difference(lastSeenAt!) < boxConnectedWithin);
}

/// The answer of the box to the list, and why there may be less than the whole list.
class ScreensData {
  const ScreensData({
    required this.rows,
    this.lanOnly = false,
    this.olderBox = false,
    this.followerOf,
    this.isFollower = false,
    this.serverNow,
  });

  final List<ScreenRowData> rows;

  /// The box refused the list: this phone is not on the surau Wi-Fi.
  final bool lanOnly;

  /// The box has no `/api/boxes` (a release before the link): only browser screens are listed.
  final bool olderBox;

  /// This phone's box follows another box.
  final bool isFollower;
  final String? followerOf;

  /// The box's clock when the activity answered, for the browser screens' state.
  final DateTime? serverNow;

  /// Follower boxes that are linked now (removed ones do not count).
  int get followers => rows.where((r) => r.kind == ScreenKind.follower && !r.removed).length;

  List<ScreenRowData> get boxes => [for (final r in rows) if (r.kind != ScreenKind.browser) r];
  List<ScreenRowData> get browsers => [for (final r in rows) if (r.kind == ScreenKind.browser) r];

  ScreenRowData? byId(String id) {
    for (final r in rows) {
      if (r.id == id) return r;
    }
    return null;
  }
}

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

/// The rows of `GET /api/boxes` and the browser screens among [devices].
ScreensData buildScreensData(
  Map<String, dynamic>? boxes,
  List<DeviceDto> devices, {
  Map<String, DateTime?> deviceSeen = const {},
  DateTime? serverNow,
}) {
  final rows = <ScreenRowData>[];
  final boxIds = <String>{};
  if (boxes != null) {
    final self = boxes['self'];
    if (self is Map) {
      rows.add(
        ScreenRowData(
          kind: ScreenKind.main,
          id: selfTvId,
          name: self['name'] is String ? self['name'] as String : '',
          version: self['version'] is String ? self['version'] as String : null,
          backup: LinkBackup.fromJson(self['backup']),
          kept: LinkKept.fromJson(self['kept']),
          freeBytes: self['freeBytes'] is num ? (self['freeBytes'] as num).toInt() : null,
        ),
      );
    }
    for (final b in (boxes['boxes'] as List? ?? const [])) {
      if (b is! Map || b['id'] is! String) continue;
      boxIds.add(b['id'] as String);
      rows.add(
        ScreenRowData(
          kind: ScreenKind.follower,
          id: b['id'] as String,
          name: b['name'] is String ? b['name'] as String : '',
          version: b['version'] is String ? b['version'] as String : null,
          lastSeenAt: _date(b['lastSeenAt']),
          linkedAt: _date(b['linkedAt']),
          removedAt: _date(b['removedAt']),
          notSeenSince: _date(b['notSeenSince']),
        ),
      );
    }
  }
  for (final d in devices) {
    if (d.platform != 'kiosk' || d.revoked || boxIds.contains(d.id)) continue;
    rows.add(ScreenRowData(kind: ScreenKind.browser, id: d.id, name: d.name, lastSeenAt: deviceSeen[d.id], linkedAt: d.enrolledAt));
  }
  return ScreensData(rows: rows, serverNow: serverNow);
}

/// The list, read fresh. A refusal of the boxes route becomes a flag, never an exception, so the browser screens
/// still show.
final screensDataProvider = FutureProvider.autoDispose<ScreensData>((ref) async {
  final api = ref.watch(linkApiProvider);
  final gateway = ref.watch(gatewayProvider);
  if (api == null || gateway == null) return const ScreensData(rows: []);
  Map<String, dynamic>? boxes;
  var lanOnly = false;
  var older = false;
  var follower = false;
  String? master;
  try {
    boxes = await api.boxes();
  } on LinkRefusal catch (e) {
    if (e.code == 'lan_only') {
      lanOnly = true;
    } else if (e.code == 'follower') {
      follower = true;
      master = e.masterName;
    } else if (e.status == 404) {
      older = true;
    } else {
      rethrow;
    }
  }
  List<DeviceDto> devices = const [];
  try {
    final read = await ref.watch(boxJsonProvider(devicesPath).future);
    if (read != null) devices = parseDevices(read.value);
  } on BoxError {
    // the browser screens are left out
  } on BoxUnreachable {
    // the browser screens are left out
  }
  final activity = await ref.watch(peopleActivityProvider.future);
  final seen = <String, DateTime?>{
    if (activity != null)
      for (final d in activity.devices) d.id: d.lastSeenAt,
  };
  final data = buildScreensData(boxes, devices, deviceSeen: seen, serverNow: activity?.now);
  return ScreensData(
    rows: data.rows,
    lanOnly: lanOnly,
    olderBox: older,
    isFollower: follower,
    followerOf: master,
    serverNow: data.serverNow,
  );
});
