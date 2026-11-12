// A real file pick for an MP3. Only the web build has one (an
// `<input type=file>`); elsewhere [supported] is false.

import 'dart:typed_data';

import 'audio_file_pick_stub.dart'
    if (dart.library.js_interop) 'audio_file_pick_web.dart'
    as platform;

/// Largest MP3 accepted before sending (the box caps uploads at this size).
const int audioMaxBytes = 20 * 1024 * 1024;

bool get supported => platform.supported;

/// The bytes, or null when the person backs out. Throws on a file that is
/// too big or cannot be read.
Future<Uint8List?> pickAudioFile() => platform.pick(audioMaxBytes);
