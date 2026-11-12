import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

/// `getUserMedia` exists only in a secure context (HTTPS, or loopback),
/// which is also what the box needs for WebCrypto. Without it the enrol
/// screen goes straight to the paste field.
bool cameraLikelyAvailable() {
  try {
    if (!web.window.isSecureContext) return false;
    final nav = web.window.navigator as JSObject;
    if (!nav.has('mediaDevices')) return false;
    final devices = nav['mediaDevices'];
    return devices.isDefinedAndNotNull &&
        (devices as JSObject).has('getUserMedia');
  } catch (_) {
    return false;
  }
}

String currentUserAgent() {
  try {
    return web.window.navigator.userAgent;
  } catch (_) {
    return '';
  }
}
