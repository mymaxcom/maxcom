// What the running platform offers for enrolment: a camera for the QR
// scanner, and the browser's user agent (to tell the box `ios-web` from
// `web`). Android answers from the stub; the web file reads `navigator`.

export 'browser_probe_io.dart'
    if (dart.library.js_interop) 'browser_probe_web.dart';
