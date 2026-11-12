import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:web/web.dart' as web;

import 'zxing_urls.dart';

/// mobile_scanner skips its own loading when a script with this id exists.
const _scriptId = 'mobile-scanner-zxing-wasm';

Future<void>? _ready;

/// Loads the bundled zxing-wasm reader from the box's own origin and points
/// its `.wasm` fetch there too. Never throws: if it fails the scanner
/// reports its own error and the enrol screen falls back to the paste field.
Future<void> prepareZxing() => _ready ??= _prepare();

Future<void> _prepare() async {
  try {
    final base = Uri.parse(web.document.baseURI);
    final scriptUrl = zxingUrl(base, zxingScriptPath);
    final wasmUrl = zxingUrl(base, zxingWasmPath);

    // Supported hook: mobile_scanner loads this URL instead of the CDN one.
    MobileScannerPlatform.instance.setBarcodeLibraryScriptUrl(scriptUrl);

    if (web.document.querySelector('script#$_scriptId') == null) {
      final done = Completer<void>();
      final script = web.HTMLScriptElement()
        ..id = _scriptId
        ..async = true
        ..src = scriptUrl;
      script.onload = ((JSAny _) {
        if (!done.isCompleted) done.complete();
      }).toJS;
      script.onerror = ((JSAny _) {
        script.remove(); // so a retry (or mobile_scanner) can try again
        if (!done.isCompleted) done.completeError(StateError('zxing'));
      }).toJS;
      web.document.head!.appendChild(script);
      await done.future;
    }

    final zx = web.window.getProperty<JSObject?>('ZXingWASM'.toJS);
    if (zx != null) {
      final overrides = JSObject()
        ..['locateFile'] = ((JSString name, JSString prefix) {
          return name.toDart.endsWith('.wasm') ? wasmUrl.toJS : (prefix.toDart + name.toDart).toJS;
        }).toJS;
      zx.callMethod('setZXingModuleOverrides'.toJS, overrides);
    }
  } catch (_) {
    _ready = null; // allow a retry on the next scanner start
  }
}
