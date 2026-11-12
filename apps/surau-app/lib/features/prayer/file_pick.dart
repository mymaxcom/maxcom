// A real file pick for the prayer data: a CSV or an Excel sheet.
// Web uses an `<input type=file>`, Android the system
// document picker through the `FilePickChannel`; elsewhere
// [filePickSupported] is false and the CSV paste box stays the only way.
// The file is read into memory only up to `maxBytes`; a bigger one comes
// back as [PickedFile.tooBig] with no bytes.

import 'dart:typed_data';

import 'file_pick_stub.dart'
    if (dart.library.js_interop) 'file_pick_web.dart'
    if (dart.library.io) 'file_pick_android.dart'
    as platform;

/// Largest file accepted by default (a year of days is far below this).
const int pickMaxBytes = 2 * 1024 * 1024;

/// What the pick gave back. [tooBig] means the file was over the cap and
/// [bytes] is empty.
class PickedFile {
  PickedFile(this.name, this.bytes) : tooBig = false;
  PickedFile.tooBig(this.name) : bytes = Uint8List(0), tooBig = true;

  final String name;
  final Uint8List bytes;
  final bool tooBig;
}

bool get filePickSupported => platform.supported;

/// [extensions] are lower-case without the dot (`csv`, `xlsx`, `zip`).
/// Null when the person backs out or the platform has no pick.
Future<PickedFile?> pickFile({
  required List<String> extensions,
  required int maxBytes,
}) => platform.pick(extensions, maxBytes);

/// The MIME types a document picker should offer for [extensions].
List<String> mimeTypesFor(List<String> extensions) {
  const known = {
    'csv': ['text/csv', 'text/comma-separated-values'],
    'xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    'zip': ['application/zip'],
  };
  final out = <String>[];
  for (final e in extensions) {
    for (final m in known[e.toLowerCase()] ?? const <String>[]) {
      if (!out.contains(m)) out.add(m);
    }
  }
  return out;
}
