// Which way the joined recording travels between the browser and the box: in a browser as Blobs through `fetch`
// (no copy in Dart memory); elsewhere `openRecordingTransfer` gives null and the bytes version of
// `recording_join.dart` is used.

export 'recording_transfer_stub.dart'
    if (dart.library.js_interop) 'recording_transfer_web.dart'
    show openRecordingTransfer;
