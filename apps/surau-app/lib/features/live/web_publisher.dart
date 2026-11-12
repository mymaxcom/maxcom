// The browser publisher of the Live tab (Plan 5 Task 9): iPad Safari, and
// Chrome on a PC. The real one is `web_publisher_web.dart` (getUserMedia,
// WHIP over an RTCPeerConnection, MediaRecorder segments, Screen Wake
// Lock); everywhere else the stub reports that the browser publisher is
// not available.

export 'web_publisher_stub.dart'
    if (dart.library.js_interop) 'web_publisher_web.dart';
