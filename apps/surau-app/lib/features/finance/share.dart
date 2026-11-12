// Save a file to the phone or hand it to another app (Plan 7 Task 9): the
// finance PDF today, and Plan 13's template download (CSV, XLSX) later, so
// this is a general bytes helper, not PDF-only.
//
//  - [saveBytes]: Android 10 and later writes it to Downloads through
//    MediaStore; Android 8 and 9 (and any failure) fall back to the share
//    sheet; the web downloads it through a Blob and an anchor.
//  - [shareBytes]: Android writes it to the app cache and sends it with
//    ACTION_SEND through a FileProvider URI (files older than an hour are
//    deleted on the next call); the web uses navigator.share with a File
//    when the browser can, else downloads it.
//
// The rules for a file name and a type are checked here and again in
// ShareChannel.kt (the same rules); a name or content is never logged. The
// platform halves are picked by conditional import, the same pattern as
// csv_file_pick.dart.

import 'dart:typed_data';

import 'share_stub.dart'
    if (dart.library.js_interop) 'share_web.dart'
    if (dart.library.io) 'share_android.dart'
    as platform;

/// The only types the helper writes or sends.
const Set<String> shareMimes = {
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/// Longest file name accepted.
const int shareMaxNameLength = 100;

/// Most bytes accepted (a month's PDF is a few hundred KB).
const int shareMaxBytes = 20 * 1024 * 1024;

/// A name or type the helper refuses. [message] is for the developer; the
/// screens show their own words.
class ShareArgsError implements Exception {
  const ShareArgsError(this.message);

  final String message;

  @override
  String toString() => 'ShareArgsError($message)';
}

/// The platform could not save or send the file (no message detail: it
/// would carry the name).
class ShareFailed implements Exception {
  const ShareFailed();

  @override
  String toString() => 'ShareFailed';
}

/// Whether [name] is a plain file name: 1 to 100 characters, no `/`, `\`
/// or `..`, no control character. Mirrors `ShareArgs.nameOk` in
/// ShareChannel.kt.
bool shareNameOk(String name) {
  if (name.isEmpty || name.length > shareMaxNameLength) return false;
  if (name.contains('/') || name.contains(r'\') || name.contains('..')) {
    return false;
  }
  for (final u in name.codeUnits) {
    if (u < 0x20 || u == 0x7f) return false;
  }
  return true;
}

/// Throws [ShareArgsError] unless the name, the type and the size are
/// acceptable. Run before anything reaches the platform.
void checkShareArgs(String filename, String mime, Uint8List bytes) {
  if (!shareNameOk(filename)) throw const ShareArgsError('filename');
  if (!shareMimes.contains(mime)) throw const ShareArgsError('mime');
  if (bytes.isEmpty || bytes.length > shareMaxBytes) {
    throw const ShareArgsError('size');
  }
}

/// What [saveBytes] did.
class SaveResult {
  const SaveResult({required this.saved, this.sharedInstead = false});

  /// The file is in the phone's Downloads (or was downloaded by the browser).
  final bool saved;

  /// The phone cannot save it directly (Android 8 or 9, or the write
  /// failed): the share sheet was opened instead.
  final bool sharedInstead;
}

/// What [shareBytes] did. [via] is `whatsapp`, `email` or `other`: from the
/// app the person chose when the system reports it, else `other`.
class ShareResult {
  const ShareResult(this.via, {this.completed = true});

  final String via;

  /// False when the person backed out or the system did not say which app
  /// was chosen: nothing then proves the file was sent.
  final bool completed;

  static const Set<String> vias = {'whatsapp', 'email', 'other'};
}

/// Which half was picked: `android`, `web` or `stub`.
String get shareImplementation => platform.implementation;

Future<SaveResult> saveBytes(
  Uint8List bytes,
  String filename, {
  required String mime,
}) async {
  checkShareArgs(filename, mime, bytes);
  return platform.save(bytes, filename, mime);
}

Future<ShareResult> shareBytes(
  Uint8List bytes,
  String filename, {
  required String mime,
}) async {
  checkShareArgs(filename, mime, bytes);
  return platform.share(bytes, filename, mime);
}

/// The finance PDF: opens the share sheet (which also offers Drive and
/// Files to keep a copy). A thin call on [shareBytes].
Future<ShareResult> saveAndShare(
  Uint8List bytes,
  String filename, {
  String mime = 'application/pdf',
}) => shareBytes(bytes, filename, mime: mime);
