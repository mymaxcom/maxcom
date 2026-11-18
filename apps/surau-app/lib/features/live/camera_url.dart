// The camera address rules (core `cameraUrlError`, boxes' `cameraAddressReason`):
// the phone says why an address is refused before it is sent, with the same
// reason words the box answers with (`not_rtsp`, `not_ipv4`, `not_private`,
// `is_box`, `bad_port`, `bad_login_chars`, `bad_path`, `too_long`).
// test/fixtures/vectors/camera-url-vectors.json is read by this twin and by the
// box's own test, so the two cannot drift apart.

import '../../l10n/generated/s.dart';

/// The longest address the box accepts.
const int cameraUrlMax = 400;

const String _scheme = 'rtsp://';
const String _passwordMask = '••••••';

final RegExp _forbidden = RegExp('[\\u0000-\\u0020\\u007f"\'`<>\\\\]');
final RegExp _userinfoChars = RegExp(r'^[A-Za-z0-9._~!$&*+,;=:%-]*$');
final RegExp _pathChars = RegExp(r'^[A-Za-z0-9._~!$&*+,;=:@%/?-]*$');
final RegExp _percentOk = RegExp(r'^(?:[^%]|%[0-9A-Fa-f]{2})*$');
final RegExp _octet = RegExp(r'^(?:0|[1-9][0-9]{0,2})$');

List<int>? _ipv4(String host) {
  final parts = host.split('.');
  if (parts.length != 4) return null;
  final out = <int>[];
  for (final p in parts) {
    if (!_octet.hasMatch(p)) return null;
    final n = int.parse(p);
    if (n > 255) return null;
    out.add(n);
  }
  return out;
}

bool _privateRange(List<int> o) =>
    o[0] == 10 ||
    (o[0] == 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] == 192 && o[1] == 168);

/// Why [url] is refused, or null when it is acceptable. [boxIps] are the box's
/// own addresses (the phone does not know them, so it passes none and the box
/// answers `is_box`).
String? cameraAddressReason(String url, {List<String> boxIps = const []}) {
  if (url.isEmpty) return 'not_rtsp';
  if (url.length > cameraUrlMax) return 'too_long';
  if (_forbidden.hasMatch(url)) return 'bad_path';
  if (!url.startsWith(_scheme)) return 'not_rtsp';
  final rest = url.substring(_scheme.length);
  final cut = rest.indexOf(RegExp(r'[/?#]'));
  final authority = cut == -1 ? rest : rest.substring(0, cut);
  final tail = cut == -1 ? '' : rest.substring(cut);

  if (tail.contains('#')) return 'bad_path';
  final at = authority.split('@');
  if (at.length > 2) return 'bad_login_chars';
  final hostPort = at.last;
  if (at.length == 2) {
    final info = at.first;
    final masked = info.endsWith(':$_passwordMask');
    final plain = masked ? info.substring(0, info.length - _passwordMask.length) : info;
    if (!_userinfoChars.hasMatch(plain) || !_percentOk.hasMatch(plain)) return 'bad_login_chars';
  }

  final colon = hostPort.indexOf(':');
  final host = colon == -1 ? hostPort : hostPort.substring(0, colon);
  if (host.isEmpty) return 'not_ipv4';
  if (colon != -1) {
    final port = hostPort.substring(colon + 1);
    if (!RegExp(r'^[0-9]{1,5}$').hasMatch(port)) return 'bad_port';
    final n = int.parse(port);
    if (n < 1 || n > 65535) return 'bad_port';
  }

  final octets = _ipv4(host);
  if (octets == null) return 'not_ipv4';
  if (!_privateRange(octets)) return 'not_private';
  if (boxIps.contains(host)) return 'is_box';

  if (!_pathChars.hasMatch(tail) || !_percentOk.hasMatch(tail)) return 'bad_path';
  return null;
}

/// The person's words for a reason; null for a word this app does not know.
String? cameraReasonText(S s, String? reason) => switch (reason) {
  'not_rtsp' => s.ra4CamNotRtsp,
  'not_ipv4' => s.ra4CamNotIpv4,
  'not_private' => s.ra4CamNotPrivate,
  'is_box' => s.ra4CamIsBox,
  'bad_port' => s.ra4CamBadPort,
  'bad_login_chars' => s.ra4CamBadLogin,
  'bad_path' => s.ra4CamBadPath,
  'too_long' => s.ra4CamTooLong,
  _ => null,
};
