// The Android preview WebView does not trust the surau's own root CA (the
// app no longer asks the person to install it). Instead, when the WebView
// reports a certificate error, the app lets the page load only if the
// certificate the WebView was shown is byte-identical to the leaf
// certificate the app's own PINNED connection (enrolled root CA) received
// from the same box origin moments before. This file is the pure decision.

import 'dart:typed_data';

import '../box/trust.dart' show sha256Hex;

/// The WebView's certificate was refused: first 16 hex of the sha256 of the
/// expected (pinned) leaf and of the presented one, `-` when unknown.
typedef SslRefused = void Function(String expected, String presented);

/// Fetches the box's current leaf certificate (DER) over the pinned
/// connection; null when it cannot be had.
typedef LeafFetcher = Future<Uint8List?> Function();

/// True only when [url] is https and has the exact scheme, host and port
/// of [expected], which must itself be https.
bool sameHttpsOrigin(Uri expected, String url) {
  final u = Uri.tryParse(url);
  return u != null &&
      expected.scheme == 'https' &&
      u.scheme == 'https' &&
      u.host.isNotEmpty &&
      u.host == expected.host &&
      u.port == expected.port;
}

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

/// First 16 hex characters of a sha256, or `-`.
String shortSha(String? hex) =>
    hex == null || hex.isEmpty ? '-' : hex.substring(0, hex.length < 16 ? hex.length : 16);

class SslVerdict {
  const SslVerdict({required this.proceed, this.expected, this.expectedSha, this.presentedSha});

  /// True only when the WebView may continue past the certificate error.
  final bool proceed;

  /// The leaf to remember for the next error (after a refresh).
  final Uint8List? expected;

  /// sha256 hex of the expected leaf and of the presented one, for the
  /// technical detail line.
  final String? expectedSha;
  final String? presentedSha;
}

/// Decides one `onSslAuthError`. Proceeds only when ALL hold: the failing
/// URL is the preview's exact https origin, a certificate was presented,
/// and it equals the leaf the pinned connection got. If [expected] is
/// unknown or differs, [refresh] is called at most once (a renewed leaf)
/// and the comparison repeated; otherwise the answer is cancel.
Future<SslVerdict> judgeSslError({
  required Uri previewUrl,
  required String failingUrl,
  required Uint8List? presented,
  required Uint8List? expected,
  required LeafFetcher? refresh,
}) async {
  final presentedSha = presented == null || presented.isEmpty ? null : sha256Hex(presented);
  if (!sameHttpsOrigin(previewUrl, failingUrl) || presented == null || presented.isEmpty) {
    return SslVerdict(
      proceed: false,
      expected: expected,
      expectedSha: expected == null ? null : sha256Hex(expected),
      presentedSha: presentedSha,
    );
  }
  if (expected != null && _same(expected, presented)) {
    return SslVerdict(proceed: true, expected: expected, expectedSha: presentedSha, presentedSha: presentedSha);
  }
  Uint8List? fresh;
  if (refresh != null) {
    try {
      fresh = await refresh();
    } on Object {
      fresh = null;
    }
  }
  final now = fresh ?? expected;
  final match = fresh != null && fresh.isNotEmpty && _same(fresh, presented);
  return SslVerdict(
    proceed: match,
    expected: now,
    expectedSha: now == null ? null : sha256Hex(now),
    presentedSha: presentedSha,
  );
}
