// The browser download of the joined recording: an `<a download>` in the browser, nothing elsewhere.

export 'recordings_store_stub.dart'
    if (dart.library.js_interop) 'recordings_store_web.dart'
    show saveBytesToDevice;
