// The kiosk preview: the real kiosk page (`/?preview=1`) shown inside the
// app. Android uses a WebView, the web build an iframe on the same origin.
// The session token goes in by postMessage after the page has loaded; it is
// never part of the URL.

import 'package:flutter/widgets.dart';

import 'preview_host_io.dart' if (dart.library.js_interop) 'preview_host_web.dart' as platform;
import 'preview_message.dart';
import 'preview_tls.dart';

export 'preview_message.dart';

class PreviewHost extends StatelessWidget {
  const PreviewHost(this.box, this.token, {super.key, this.now, this.utcOffsetMinutes = 480, this.onSslError, this.poster, this.theme, this.pinnedLeaf, this.onLoadError});

  /// The origin to load, e.g. `https://<box-ip>:8443`: on Android the
  /// address the app has proven for the box now (see preview_target.dart).
  final Uri box;

  /// A valid session token. A new value is posted to the page again.
  final String token;

  /// Pins the kiosk clock (shown as `?now=`); null follows the real time.
  final DateTime? now;

  /// The surau's offset from UTC in minutes; `?now=` is written in it.
  final int utcOffsetMinutes;

  /// The page address, with the pinned clock when [now] is set.
  @visibleForTesting
  Uri get url => previewUri(box, now: now, utcOffsetMinutes: utcOffsetMinutes);

  /// Android only: the WebView refused the box certificate and it did not
  /// match the pinned one either. Gets the short expected and presented
  /// sha256.
  final SslRefused? onSslError;

  /// Android only: the box's current leaf certificate over the pinned
  /// connection, to compare with what the WebView is shown.
  final LeafFetcher? pinnedLeaf;

  /// Android only: the page itself could not be loaded (timeout, host
  /// unreachable); the caller shows its own notice instead of the browser's.
  final VoidCallback? onLoadError;

  /// One poster the page should show on its own (the poster editor's
  /// preview), posted right after the token; null for the normal rotation.
  final PreviewPoster? poster;

  /// The theme, the screen and the unsaved values the page should wear
  /// (Ubah suai and the gallery), posted after the token and again whenever
  /// it changes; null for the page as the box has it.
  final PreviewThemeRequest? theme;

  @override
  Widget build(BuildContext context) => platform.PlatformPreview(
        url: url,
        token: token,
        poster: poster,
        theme: theme,
        onSslError: onSslError,
        pinnedLeaf: pinnedLeaf,
        onLoadError: onLoadError,
      );
}
