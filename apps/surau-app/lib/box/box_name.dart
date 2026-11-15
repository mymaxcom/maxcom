// The box's local name: one label, `box1-surau.local` ... `box99-surau.local`.
// A name (from the QR, health, mDNS) is only a hint for finding the box; what
// proves it is the TLS handshake to the pinned CA plus the matching boxId.

final RegExp _boxName = RegExp(r'^box([1-9][0-9]?)-surau\.local$');
final RegExp _ipv4 = RegExp(
  r'^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  r'(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$',
);

/// True for exactly `box1-surau.local` to `box99-surau.local`.
bool isBoxName(String s) => _boxName.hasMatch(s);

/// True for a dotted-quad IPv4 literal.
bool isIpv4(String s) => _ipv4.hasMatch(s);

/// `https://<name>:<port>` (the default https port is dropped).
Uri boxNameOrigin(String name, int port) =>
    Uri(scheme: 'https', host: name, port: port == 443 ? null : port);
