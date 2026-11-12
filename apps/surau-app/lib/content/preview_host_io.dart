// Android: the kiosk page in a WebView (needs `webview_flutter: ^4.14.1`).
//
// The WebView trusts the system roots only. The surau's own CA is not
// installed on the phone, so the box's certificate raises `onSslAuthError`.
// It is accepted ONLY by `judgeSslError` (preview_tls.dart): same https
// origin as the preview and a certificate byte-identical to the leaf the
// app's pinned Dart connection received from the box just before.

import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'preview_message.dart';
import 'preview_tls.dart';

class PlatformPreview extends StatefulWidget {
  const PlatformPreview({
    super.key,
    required this.url,
    required this.token,
    this.poster,
    this.onSslError,
    this.pinnedLeaf,
  });

  final Uri url;
  final String token;
  final PreviewPoster? poster;

  /// Called when the certificate was refused.
  final SslRefused? onSslError;

  /// The box's current leaf certificate over the pinned connection.
  final LeafFetcher? pinnedLeaf;

  @override
  State<PlatformPreview> createState() => _PlatformPreviewState();
}

class _PlatformPreviewState extends State<PlatformPreview> {
  late final WebViewController _controller;

  /// The leaf the pinned connection received before this load.
  Uint8List? _expectedLeaf;

  bool _sameOrigin(String url) {
    final u = Uri.tryParse(url);
    return u != null && u.scheme == widget.url.scheme && u.host == widget.url.host && u.port == widget.url.port;
  }

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          // The preview never leaves the box.
          onNavigationRequest: (r) => _sameOrigin(r.url) ? NavigationDecision.navigate : NavigationDecision.prevent,
          onPageFinished: (_) => _postToken(),
          onSslAuthError: _onSslAuthError,
        ),
      );
    _load();
  }

  /// Get the box's leaf over the pinned connection first, then load. A
  /// failed fetch still loads: the certificate error then cancels.
  Future<void> _load() async {
    final url = widget.url;
    try {
      _expectedLeaf = await widget.pinnedLeaf?.call();
    } on Object {
      _expectedLeaf = null;
    }
    if (!mounted || url != widget.url) return;
    await _controller.loadRequest(url);
  }

  /// The URL the error is about: `AndroidSslAuthError.url` of the
  /// installed webview_flutter_android (not a direct dependency of the app,
  /// hence read dynamically). Anything unreadable is the empty string, which
  /// is never the preview origin, so the error is cancelled.
  static String _failingUrl(SslAuthError error) {
    try {
      final u = (error.platform as dynamic).url;
      return u is String ? u : '';
    } on Object {
      return '';
    }
  }

  Future<void> _onSslAuthError(SslAuthError error) async {
    final failing = _failingUrl(error);
    final verdict = await judgeSslError(
      previewUrl: widget.url,
      failingUrl: failing,
      presented: error.certificate?.data,
      expected: _expectedLeaf,
      refresh: widget.pinnedLeaf,
    );
    _expectedLeaf = verdict.expected;
    if (verdict.proceed) {
      await error.proceed();
      return;
    }
    await error.cancel(); // never proceed past a certificate we do not pin
    if (mounted) {
      widget.onSslError?.call(shortSha(verdict.expectedSha), shortSha(verdict.presentedSha));
    }
  }

  /// `window.postMessage(msg, location.origin)` runs inside the page, where the
  /// kiosk accepts it because `window.parent === window` there. The target
  /// origin is the page's own, so first make sure the page is still the box's.
  Future<void> _postToken() async {
    final current = await _controller.currentUrl();
    if (!mounted || current == null || !_sameOrigin(current)) return;
    if (!isPreviewToken(widget.token)) return;
    await _controller.runJavaScript(previewMessageJs(widget.token, origin: previewOrigin(widget.url)));
    await _postPoster();
  }

  /// The poster, after the token, under the same origin check.
  Future<void> _postPoster() async {
    final p = widget.poster;
    if (p == null) return;
    final current = await _controller.currentUrl();
    if (!mounted || current == null || !_sameOrigin(current)) return;
    await _controller.runJavaScript(previewPosterMessageJs(p, origin: previewOrigin(widget.url)));
  }

  @override
  void didUpdateWidget(PlatformPreview old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _load(); // onPageFinished posts the token again
    } else if (old.token != widget.token) {
      _postToken();
    } else if (old.poster != widget.poster) {
      _postPoster();
    }
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}
