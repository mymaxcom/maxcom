// QR reader setup. Android: nothing to do. Web: see zxing_web_impl.dart.

export 'zxing_stub.dart' if (dart.library.js_interop) 'zxing_web_impl.dart';
