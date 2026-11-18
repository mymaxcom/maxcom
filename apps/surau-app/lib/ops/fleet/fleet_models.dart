// Plan 14 Task 14: what the fleet routes answer (apps/box-server/src/surau/routes.ts), as the MAXCOM Ops app
// reads it. Ops build only. Parsing is lenient about extra fields; a missing field never throws.

/// The server's `status` words for a surau (registry.ts).
const String surauStatusWaiting = 'Menunggu MAXCOM';
const String surauStatusSuspended = 'Digantung';

/// A box that has not synced for this long is shown as "Luar talian".
const Duration offlineAfter = Duration(hours: 24);

/// Bar colours: yellow from 80 percent of the limit, red from 95.
const double storageWarnAt = 0.80;
const double storageDangerAt = 0.95;

String? _s(Object? v) => v is String && v.isNotEmpty ? v : null;
int _n(Object? v) => v is num ? v.toInt() : 0;

class FleetBox {
  const FleetBox({
    required this.boxId,
    required this.name,
    required this.role,
    required this.lastSeenAt,
    required this.revoked,
  });

  factory FleetBox.fromJson(Map<String, dynamic> j) => FleetBox(
    boxId: _s(j['boxId']) ?? '',
    name: _s(j['name']) ?? '',
    role: _s(j['role']) ?? 'primary',
    lastSeenAt: DateTime.tryParse(_s(j['lastSeenAt']) ?? ''),
    revoked: j['revoked'] == true,
  );

  final String boxId;
  final String name;
  final String role;
  final DateTime? lastSeenAt;
  final bool revoked;
}

/// What a surau card says: ordered as the list is sorted.
enum SurauState { waiting, offline, suspended, ok }

class FleetSurau {
  const FleetSurau({
    required this.id,
    required this.name,
    required this.kind,
    required this.location,
    required this.zone,
    required this.status,
    required this.linkedAt,
    required this.suspendedAt,
    required this.suspendedReason,
    required this.storageLimitBytes,
    required this.storageUsedBytes,
    required this.boxes,
    this.empty = false,
  });

  factory FleetSurau.fromJson(Map<String, dynamic> j) => FleetSurau(
    id: _s(j['id']) ?? '',
    name: _s(j['name']) ?? '',
    kind: _s(j['kind']) ?? 'surau',
    location: _s(j['location']) ?? '',
    zone: _s(j['zone']) ?? '',
    status: _s(j['status']) ?? '',
    linkedAt: _s(j['linkedAt']),
    suspendedAt: _s(j['suspendedAt']),
    suspendedReason: _s(j['suspendedReason']),
    storageLimitBytes: _n(j['storageLimitBytes']),
    storageUsedBytes: _n(j['storageUsedBytes']),
    empty: j['empty'] == true,
    boxes: [
      for (final b in (j['boxes'] as List? ?? const []))
        if (b is Map<String, dynamic>) FleetBox.fromJson(b),
    ],
  );

  final String id;
  final String name;
  final String kind;
  final String location;
  final String zone;
  final String status;
  final String? linkedAt;
  final String? suspendedAt;
  final String? suspendedReason;
  final int storageLimitBytes;
  final int storageUsedBytes;
  final List<FleetBox> boxes;

  /// The server says nothing was ever put in this surau (it may be deleted). False when the field is absent.
  final bool empty;

  List<FleetBox> get liveBoxes => [
    for (final b in boxes)
      if (!b.revoked) b,
  ];

  bool get hasLiveBox => liveBoxes.isNotEmpty;

  /// Suspended first; then waiting (the server says so, or no box ever linked); then a linked surau whose primary box
  /// has not synced for [offlineAfter] (or has no live box); else ok.
  SurauState stateAt(DateTime now) {
    if (suspendedAt != null || status == surauStatusSuspended) return SurauState.suspended;
    if (status == surauStatusWaiting || linkedAt == null) return SurauState.waiting;
    final live = liveBoxes;
    if (live.isEmpty) return SurauState.offline;
    final primary = live.firstWhere((b) => b.role == 'primary', orElse: () => live.first);
    final seen = primary.lastSeenAt;
    if (seen == null || now.difference(seen) > offlineAfter) return SurauState.offline;
    return SurauState.ok;
  }

  /// The share of the limit in use, 0 when no limit is known.
  double get storageRatio => storageLimitBytes <= 0 ? 0 : storageUsedBytes / storageLimitBytes;
}

List<FleetSurau> parseSuraus(Map<String, dynamic> body) => [
  for (final s in (body['suraus'] as List? ?? const []))
    if (s is Map<String, dynamic>) FleetSurau.fromJson(s),
];

/// Waiting and offline first, then suspended, then ok; by name inside each group.
List<FleetSurau> sortFleet(List<FleetSurau> all, DateTime now) {
  int rank(FleetSurau s) => switch (s.stateAt(now)) {
    SurauState.waiting => 0,
    SurauState.offline => 0,
    SurauState.suspended => 1,
    SurauState.ok => 2,
  };
  final out = [...all];
  out.sort((a, b) {
    final r = rank(a).compareTo(rank(b));
    if (r != 0) return r;
    return a.name.toLowerCase().compareTo(b.name.toLowerCase());
  });
  return out;
}

String? _held(Map<String, dynamic> j) {
  final h = _s(j['held']);
  if (h == 'daily_cap' || h == 'other') return h;
  return j['heldByCap'] == true ? 'daily_cap' : null;
}

/// One box waiting to be linked (`GET /api/fleet/pending`).
class PendingBox {
  const PendingBox({
    required this.boxId,
    required this.name,
    required this.at,
    required this.boxName,
    required this.platform,
    required this.version,
    required this.heldByCap,
    this.held,
  });

  factory PendingBox.fromJson(Map<String, dynamic> j) => PendingBox(
    boxId: _s(j['boxId']) ?? '',
    name: _s(j['name']) ?? '',
    at: DateTime.tryParse(_s(j['at']) ?? ''),
    boxName: _s(j['boxName']),
    platform: _s(j['platform']),
    version: _s(j['version']),
    heldByCap: j['heldByCap'] == true,
    held: _held(j),
  );

  final String boxId;
  final String name;
  final DateTime? at;
  final String? boxName;
  final String? platform;
  final String? version;
  final bool heldByCap;

  /// Why the box waits: `daily_cap`, `other`, or null when the server did not say it is held. An older server sends
  /// only `heldByCap`, which reads as `daily_cap`.
  final String? held;

  /// The id in groups of four, `9f02-b7aa-1c4e-0d11`, for reading aloud and comparing.
  String get idGroups => groupId(boxId);
}

List<PendingBox> parsePending(Map<String, dynamic> body) => [
  for (final p in (body['pending'] as List? ?? const []))
    if (p is Map<String, dynamic>) PendingBox.fromJson(p),
];

String groupId(String id) {
  final b = StringBuffer();
  for (var i = 0; i < id.length; i++) {
    if (i > 0 && i % 4 == 0) b.write('-');
    b.write(id[i]);
  }
  return b.toString();
}

/// `GET /api/auth/me` as far as the ops app needs it.
class OpsContext {
  const OpsContext({required this.ops, required this.scopeAll, this.surauId, this.surauName});

  factory OpsContext.fromJson(Map<String, dynamic> j) {
    final surau = j['surau'];
    return OpsContext(
      ops: j['ops'] == true,
      scopeAll: j['scope'] == 'all',
      surauId: surau is Map ? _s(surau['id']) : null,
      surauName: surau is Map ? _s(surau['name']) : null,
    );
  }

  final bool ops;
  final bool scopeAll;
  final String? surauId;
  final String? surauName;

  /// The surau switcher exists only for this person.
  bool get mayAct => ops && scopeAll;
}

/// The surau the ops person works in now, chosen in this run only (never remembered).
class ActingSurau {
  const ActingSurau({required this.id, required this.name, this.suspended = false});

  final String id;
  final String name;
  final bool suspended;
}

/// A size in the largest whole unit: `420 MB`, `1.71 GB`.
String bytesLabel(int bytes) {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) {
    final v = bytes / gb;
    return '${v >= 10 || v == v.roundToDouble() ? v.round() : v.toStringAsFixed(2)} GB';
  }
  if (bytes >= mb) return '${(bytes / mb).round()} MB';
  if (bytes >= 1024) return '${(bytes / 1024).round()} KB';
  return '$bytes B';
}
