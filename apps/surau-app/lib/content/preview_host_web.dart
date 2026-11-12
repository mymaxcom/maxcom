// Web (iPad, PC): the kiosk page in an iframe on the box's own origin.

import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import 'preview_message.dart';
import 'preview_tls.dart';

class PlatformPreview extends StatefulWidget {
  const PlatformPreview({super.key, required this.url, required this.token, this.poster, this.onSslError, this.pinnedLeaf});

  final Uri url;
  final String token;
  final PreviewPoster? poster;

  /// Not used on the web: the browser handles certificate trust itself.
  final SslRefused? onSslError;

  /// Not used on the web.
  final LeafFetcher? pinnedLeaf;

  @override
  State<PlatformPreview> createState() => _PlatformPreviewState();
}

int _counter = 0;

class _PlatformPreviewState extends State<PlatformPreview> {
  late final String _viewType = 'surau-preview-${_counter++}';
  late final web.HTMLIFrameElement _frame;

  @override
  void initState() {
    super.initState();
    _frame = web.HTMLIFrameElement()
      ..src = widget.url.toString()
      ..style.border = '0'
      ..style.width = '100%'
      ..style.height = '100%';
    _frame.addEventListener('load', ((web.Event _) => _postToken()).toJS);
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int _) => _frame);
  }

  /// Only ever to this page's own origin, and only when the preview really is
  /// on it (the kiosk page rejects any other sender). Never a wildcard.
  void _postToken() {
    final origin = web.window.location.origin;
    if (widget.url.origin != origin || !isPreviewToken(widget.token)) return;
    _frame.contentWindow?.postMessage(previewMessage(widget.token).jsify(), origin.toJS);
    _postPoster();
  }

  /// The poster, after the token, to the same origin only.
  void _postPoster() {
    final p = widget.poster;
    final origin = web.window.location.origin;
    if (p == null || widget.url.origin != origin) return;
    _frame.contentWindow?.postMessage(previewPosterMessage(p).jsify(), origin.toJS);
  }

  @override
  void didUpdateWidget(PlatformPreview old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _frame.src = widget.url.toString(); // the load event posts the token again
    } else if (old.token != widget.token) {
      _postToken();
    } else if (old.poster != widget.poster) {
      _postPoster();
    }
  }

  @override
  Widget build(BuildContext context) => HtmlElementView(viewType: _viewType);
}
