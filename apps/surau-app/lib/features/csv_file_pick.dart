// A real file pick for the prayer-data CSV. Only the web build has one (an
// `<input type=file>`); elsewhere [csvFilePickSupported] is false and the
// paste box stays the only way. The text is read as UTF-8 and capped.

import 'csv_file_pick_stub.dart'
    if (dart.library.js_interop) 'csv_file_pick_web.dart'
    as platform;

/// Largest CSV accepted (a year for one zone is about 40 KB).
const int csvMaxBytes = 1024 * 1024;

/// What the pick gave back: the text, or why there is none.
class CsvFileResult {
  const CsvFileResult.text(String this.text)
    : tooBig = false,
      unreadable = false;
  const CsvFileResult.tooBig() : text = null, tooBig = true, unreadable = false;
  const CsvFileResult.unreadable()
    : text = null,
      tooBig = false,
      unreadable = true;

  final String? text;
  final bool tooBig;
  final bool unreadable;
}

/// Null when the person backs out.
typedef CsvFilePicker = Future<CsvFileResult?> Function();

bool get csvFilePickSupported => platform.supported;

Future<CsvFileResult?> pickCsvFile() => platform.pick(csvMaxBytes);
