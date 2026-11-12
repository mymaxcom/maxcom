// The pure parts of the kiosk preview handshake, kept free of any platform
// import so they can be unit-tested: the preview URL and the postMessage that
// hands the page its session token.

import 'dart:convert';

/// Same shape the box accepts in `Authorization: Bearer` and the kiosk page
/// accepts in the message (apps/box-server/src/auth/authz.ts).
final RegExp _tokenRe = RegExp(r'^[A-Za-z0-9_-]{1,200}$');

bool isPreviewToken(String token) => _tokenRe.hasMatch(token);

const String previewMessageType = 'surau-preview';

String _two(int n) => n.toString().padLeft(2, '0');

/// [t] as an ISO time in the surau's zone ([utcOffsetMinutes], Kuala Lumpur
/// +08:00 by default), whatever zone the phone is in.
String _klIso(DateTime t, int utcOffsetMinutes) {
  final k = t.toUtc().add(Duration(minutes: utcOffsetMinutes));
  final a = utcOffsetMinutes.abs();
  final sign = utcOffsetMinutes < 0 ? '-' : '+';
  return '${k.year.toString().padLeft(4, '0')}-${_two(k.month)}-${_two(k.day)}'
      'T${_two(k.hour)}:${_two(k.minute)}:${_two(k.second)}$sign${_two(a ~/ 60)}:${_two(a % 60)}';
}

/// `<box>/?preview=1`, plus `now=<ISO in the surau's offset>&proof=1` to pin the kiosk clock.
/// Only the box's scheme, host and port are kept (no path, query, fragment or
/// credentials). Throws [ArgumentError] unless [box] is an absolute http(s) URL.
Uri previewUri(Uri box, {DateTime? now, int utcOffsetMinutes = 480}) {
  if ((box.scheme != 'https' && box.scheme != 'http') || box.host.isEmpty) {
    throw ArgumentError.value(box, 'box', 'must be an absolute http(s) URL');
  }
  return Uri(
    scheme: box.scheme,
    host: box.host,
    port: box.hasPort ? box.port : null,
    path: '/',
    queryParameters: {'preview': '1', if (now != null) 'now': _klIso(now, utcOffsetMinutes), if (now != null) 'proof': '1'},
  );
}

/// The message the kiosk page listens for.
Map<String, Object?> previewMessage(String token) => {'type': previewMessageType, 'token': token};

/// The origin of [box] as a browser writes `location.origin`: scheme, host
/// (IPv6 in brackets) and the port unless it is the scheme's default.
String previewOrigin(Uri box) {
  final host = box.host.contains(':') ? '[${box.host}]' : box.host;
  final defaultPort = box.scheme == 'https' ? 443 : 80;
  final port = box.hasPort && box.port != defaultPort ? ':${box.port}' : '';
  return '${box.scheme}://$host$port';
}

/// The page must still be the box's when the script runs, not only when
/// Dart last looked: a page that navigated in between would otherwise be
/// handed the message as its own origin.
String _onlyOnOrigin(String origin, String post) => 'if (location.origin === ${jsonEncode(origin)}) { $post }';

/// JavaScript for a WebView: posts [previewMessage] to the page's own origin,
/// and only when `location.origin` is [origin] (the box's). The message is
/// built with [jsonEncode], never by joining strings, and the target origin
/// is the page's `location.origin`, never a wildcard.
String previewMessageJs(String token, {required String origin}) =>
    _onlyOnOrigin(origin, 'window.postMessage(${jsonEncode(previewMessage(token))}, location.origin);');

// ---- "show this poster" (the poster editor's Pratonton di TV) ----

/// The second message type the kiosk preview accepts, after the token: one
/// poster to show on its own. It carries only a box asset id and a title.
const String previewPosterMessageType = 'surau-preview-poster';

/// Box asset ids are lower-case sha256 hex (`/assets/:id`), nothing else.
final RegExp _assetIdRe = RegExp(r'^[0-9a-f]{64}$');

/// Same cap as the poster `title` field (lib/content/kinds.dart, core).
const int previewPosterTitleMax = 80;

bool isAssetId(String id) => _assetIdRe.hasMatch(id);

/// A poster the preview may be asked to show: the id is checked, the title
/// trimmed, stripped of control characters and cut at
/// [previewPosterTitleMax]. The constructor refuses a bad id outright.
class PreviewPoster {
  PreviewPoster({required this.assetId, required String title}) : title = cleanTitle(title) {
    if (!isAssetId(assetId)) {
      throw ArgumentError.value(assetId, 'assetId', 'must be a box asset id');
    }
  }

  /// Null unless [assetId] is a box asset id (the editor has a draft or a
  /// saved picture); [title] may be anything, it is cleaned.
  static PreviewPoster? tryFrom(Object? assetId, Object? title) {
    if (assetId is! String || !isAssetId(assetId)) return null;
    return PreviewPoster(assetId: assetId, title: title is String ? title : '');
  }

  static String cleanTitle(String t) {
    final clean = t.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ').trim();
    return clean.length > previewPosterTitleMax ? clean.substring(0, previewPosterTitleMax) : clean;
  }

  final String assetId;
  final String title;

  @override
  bool operator ==(Object other) => other is PreviewPoster && other.assetId == assetId && other.title == title;

  @override
  int get hashCode => Object.hash(assetId, title);
}

/// The message the kiosk preview reads as "show this poster".
Map<String, Object?> previewPosterMessage(PreviewPoster p) => {
  'type': previewPosterMessageType,
  'assetId': p.assetId,
  'title': p.title,
};

/// JavaScript for a WebView: posts [previewPosterMessage] exactly as
/// [previewMessageJs] posts the token (JSON-encoded, own origin only, and
/// only while the page is on [origin]).
String previewPosterMessageJs(PreviewPoster p, {required String origin}) =>
    _onlyOnOrigin(origin, 'window.postMessage(${jsonEncode(previewPosterMessage(p))}, location.origin);');
