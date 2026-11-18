// Shared by the Plan 14 ops-fleet tests: a cloud session over the shell harness and a small fleet of invented suraus.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/unlock/session_keeper.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

final Uri cloudOrigin = Uri.parse('https://api.mymaxcom.my');

String iso(Duration ago) => fixedNow().subtract(ago).toIso8601String();

Map<String, Object?> box(String id, {String name = 'Kotak', Duration? seen, bool revoked = false}) => {
  'boxId': id,
  'name': name,
  'role': 'primary',
  'lastSeenAt': seen == null ? null : iso(seen),
  'revoked': revoked,
};

Map<String, Object?> surau(
  String id,
  String name, {
  String status = 'Aktif',
  String? linkedAt = '2026-11-01T00:00:00.000Z',
  String? suspendedAt,
  String? reason,
  int used = 420 * 1024 * 1024,
  int limit = 2 * 1024 * 1024 * 1024,
  List<Map<String, Object?>> boxes = const [],
}) => {
  'id': id,
  'name': name,
  'kind': 'surau',
  'location': '',
  'zone': '',
  'createdAt': '2026-11-01T00:00:00.000Z',
  'createdBy': 'cli',
  'linkedAt': linkedAt,
  'suspendedAt': suspendedAt,
  'suspendedReason': reason,
  'status': status,
  'storageLimitBytes': limit,
  'storageUsedBytes': used,
  'boxes': boxes,
};

/// Five suraus: ok twice, offline, suspended and waiting.
List<Map<String, Object?>> fleetFixture() => [
  surau('al-hidayah', 'Surau Al-Hidayah Contoh', boxes: [box('a41f07c29be30000', seen: const Duration(minutes: 3))]),
  surau(
    'dwaqaf',
    "Surau D'Waqaf",
    used: 1750 * 1024 * 1024,
    boxes: [box('3c88e1d02a5f0000', seen: const Duration(days: 2))],
  ),
  surau(
    'masjid-contoh',
    'Masjid Contoh',
    status: 'Digantung',
    suspendedAt: '2026-11-03T08:00:00.000Z',
    reason: 'Storan penuh berulang kali',
    used: 2000 * 1024 * 1024,
    boxes: [box('51d308e9f6b00000', seen: const Duration(minutes: 14))],
  ),
  surau('taman-contoh', 'Surau Taman Contoh', status: 'Menunggu MAXCOM', linkedAt: null, used: 0),
  surau('bukit-contoh', 'Surau Bukit Contoh', boxes: [box('9f02b7aa1c4e0000', seen: const Duration(hours: 1))]),
];

Map<String, Object?> meOps({String? surauId, String? surauName, String scope = 'all', bool ops = true}) => {
  'user': {'id': 'u1', 'name': 'Pentadbir MAXCOM'},
  'device': {'id': 'dev-1', 'name': 'Telefon MAXCOM', 'platform': 'android'},
  'roles': ['superadmin'],
  'ops': ops,
  'scope': scope,
  'surau': surauId == null ? null : {'id': surauId, 'name': surauName},
  'suspended': false,
  'expiresAt': '2026-11-05T00:00:00.000Z',
};

/// The shell over the fake box, signed in with a session the CLOUD issued (the ops app's only kind), and the fleet
/// answers installed. The fake box logs every request, headers included.
Future<ShellHarness> openCloud(
  WidgetTester tester, {
  List<String> roles = const ['superadmin'],
  Map<String, Object?>? me,
  List<Map<String, Object?>>? suraus,
  GoldenSize size = GoldenSize.phone,
  bool viaCloud = true,
  void Function(ShellHarness h)? beforeSession,
}) async {
  final h = await pumpShell(
    tester,
    roles: roles,
    size: size,
    overrides: [
      // A cloud session starts the keeper's 15 s retry timer; here nothing needs it (and a pending timer fails a test).
      sessionKeeperProvider.overrideWith(
        (ref) => SessionKeeper(
          attempt: ({required bool boxOnly}) async => throw const BoxUnreachable('test'),
          onConnected: (_) {},
          onRefused: (_) {},
          onUnavailable: () async {},
          schedule: (d, f) => Timer(d, f)..cancel(),
        ),
      ),
      livePublisherProvider.overrideWithValue(FakePublisher()),
    ],
  );
  h.me = me ?? meOps();
  h.handlers['GET /api/suraus'] = (r) async => jsonResponse(200, {'suraus': suraus ?? fleetFixture()});
  beforeSession?.call(h);
  if (viaCloud) {
    h.container.read(sessionProvider.notifier).set(h.session().issuedBy(cloudOrigin, SessionDto.viaCloud));
  }
  await settle(tester);
  return h;
}

/// Requests the fake box saw for [path], in order.
List<http.Request> seenAt(ShellHarness h, String path) => [
  for (final r in h.box.seen)
    if (r.url.path == path) r,
];

Map<String, dynamic> bodyOfRequest(http.Request r) => jsonDecode(r.body) as Map<String, dynamic>;
