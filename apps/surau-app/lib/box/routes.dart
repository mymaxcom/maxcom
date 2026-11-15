// Where a box's local name currently points, as proven by the app.
//
// A name (`box1-surau.local`) is looked up by the app's own discovery because
// Android's resolver does not answer `.local`. The table only chooses the
// ADDRESS the socket opens; the TLS handshake still verifies the certificate
// against the pinned CA for the NAME in the URL, so a wrong or hostile
// address can only fail, never impersonate the box.

import 'package:flutter/foundation.dart' show ValueNotifier;

import 'box_name.dart';

class BoxRoutes {
  final Map<String, String> _ips = {};

  /// Counts the changes; the app rebuilds its clients when it moves.
  final ValueNotifier<int> epoch = ValueNotifier<int>(0);

  /// The IPv4 to open for [host], or null to use the system resolver.
  String? addressOf(String host) => _ips[host.toLowerCase()];

  /// Points [name] at [ip]. Anything but a box name and an IPv4 literal is
  /// ignored. Returns true when the table changed.
  bool set(String name, String ip) {
    if (!isBoxName(name) || !isIpv4(ip)) return false;
    if (_ips[name] == ip) return false;
    _ips[name] = ip;
    epoch.value++;
    return true;
  }

  /// Forgets [name] (its address no longer verified).
  void remove(String name) {
    if (_ips.remove(name) != null) epoch.value++;
  }
}
