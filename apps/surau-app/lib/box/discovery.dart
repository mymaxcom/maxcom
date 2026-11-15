// Finding MAXCOM boxes on the Wi-Fi (DNS-SD `_maxcom._tcp`).
//
// Everything here is a HINT. Anyone on the network can advertise a service
// or answer a `.local` name, so a [DiscoveredBox] only says where to try; the
// locator opens a TLS connection pinned to the enrolled CA and compares the
// box id before it believes it (lib/box/locator.dart).

import 'box_name.dart';
import 'discovery_stub.dart'
    if (dart.library.io) 'discovery_io.dart'
    as impl;

class DiscoveredBox {
  const DiscoveredBox({
    required this.name,
    required this.ip,
    required this.port,
    this.id,
    this.ca,
  });

  /// `box1-surau.local`, from the instance `MAXCOM box1`.
  final String name;

  /// IPv4 the service resolved to.
  final String ip;
  final int port;

  /// TXT `id` (the box id) and `ca` (first 16 hex of the root's sha256).
  final String? id;
  final String? ca;
}

abstract class BoxDiscovery {
  /// Boxes seen within [timeout]; never throws (a failure is an empty list).
  Future<List<DiscoveredBox>> discover({
    Duration timeout = const Duration(milliseconds: 1500),
  });
}

/// Finds nothing (web, tests, non-Android).
class NoDiscovery implements BoxDiscovery {
  const NoDiscovery();

  @override
  Future<List<DiscoveredBox>> discover({
    Duration timeout = const Duration(milliseconds: 1500),
  }) async => const [];
}

/// The platform's discovery: NsdManager on Android, none elsewhere.
BoxDiscovery platformDiscovery() => impl.platformDiscovery();

final RegExp _instance = RegExp(r'^MAXCOM box([1-9][0-9]?)$');
final RegExp _hex16 = RegExp(r'^[0-9a-f]{16}$');

/// Reads the channel's list. Drops entries that are not a plausible MAXCOM
/// box (instance name, IPv4, port); at most 8 are kept.
List<DiscoveredBox> parseDiscovered(Object? raw) {
  if (raw is! List) return const [];
  final out = <DiscoveredBox>[];
  for (final e in raw) {
    if (e is! Map) continue;
    final instance = e['instance'];
    final ip = e['ip'];
    final port = e['port'];
    if (instance is! String || ip is! String || port is! int) continue;
    final m = _instance.firstMatch(instance);
    if (m == null || !isIpv4(ip) || port < 1 || port > 65535) continue;
    final id = e['id'];
    final ca = e['ca'];
    out.add(
      DiscoveredBox(
        name: 'box${m.group(1)}-surau.local',
        ip: ip,
        port: port,
        id: id is String && _hex16.hasMatch(id) ? id : null,
        ca: ca is String && _hex16.hasMatch(ca) ? ca : null,
      ),
    );
    if (out.length >= 8) break;
  }
  return out;
}
