// The browser's list of microphones (`mediaDevices.enumerateDevices` and its
// `devicechange` event); everywhere else there is none.
export 'mic_devices_stub.dart'
    if (dart.library.js_interop) 'mic_devices_web.dart';
