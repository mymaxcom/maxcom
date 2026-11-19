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

import '../common/contact_links.dart' show UrlOpener, launchOutside;
import 'share_stub.dart'
    if (dart.library.js_interop) 'share_web.dart'
    if (dart.library.io) 'share_android.dart'
    as platform;

/// The only types the helper writes or sends.
const Set<String> shareMimes = {
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // A theme file (.maxtheme), the Muat turun tema download.
  'application/vnd.maxcom.theme+zip',
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
  const ShareResult(this.via, {this.completed = true, this.unavailable = false});

  final String via;

  /// True when the platform has no way to share a text (the stub, or a
  /// browser without `navigator.share`): the caller copies it instead.
  final bool unavailable;

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

/// Most characters of a text [shareText] sends.
const int shareTextMaxLength = 4096;

/// Opens the phone's share sheet with a short [text] (and an optional
/// [subject]). Refused with [ShareArgsError] when the text is empty or
/// longer than [shareTextMaxLength]. The text is never logged. A platform
/// that cannot share a text answers [ShareResult.unavailable] true and the
/// caller copies it to the clipboard.
Future<ShareResult> shareText(String text, {String? subject}) async {
  if (text.isEmpty || text.length > shareTextMaxLength) {
    throw const ShareArgsError('text');
  }
  if (subject != null && subject.length > 200) {
    throw const ShareArgsError('subject');
  }
  return platform.shareText(text, subject);
}

/// Most bytes of the notice picture (a 1200 x 630 JPEG is about 150 KB).
const int shareNoticeMaxBytes = 4 * 1024 * 1024;

/// Whether WhatsApp or WhatsApp Business is installed (Android only; the web
/// and any other platform answer false: it cannot be detected there).
Future<bool> whatsAppInstalled() => platform.whatsAppInstalled();

/// The live notice: [text] and, when given, a JPEG [picture] (1 byte to
/// [shareNoticeMaxBytes]). With [toWhatsApp] the share intent is aimed at the
/// installed WhatsApp (its own chooser of chats and groups), else the system
/// share sheet. The web shares through navigator.share with the file when the
/// browser can, else the text alone. Nothing is logged.
Future<ShareResult> shareNotice(String text, {Uint8List? picture, bool toWhatsApp = false}) async {
  if (text.isEmpty || text.length > shareTextMaxLength) {
    throw const ShareArgsError('text');
  }
  if (picture != null && (picture.isEmpty || picture.length > shareNoticeMaxBytes)) {
    throw const ShareArgsError('size');
  }
  return platform.shareNotice(text, picture, toWhatsApp);
}

/// Deletes the temporary picture of an earlier [shareNotice] (Android).
Future<void> cleanNotice() => platform.cleanNotice();

/// Whether [u] is `https://wa.me/<8 to 15 digits>` with at most one
/// `text=` query parameter: the only address [openWhatsApp] opens.
bool isWaMeUri(Uri u) {
  if (u.scheme != 'https' || u.host != 'wa.me') return false;
  if (u.hasPort || u.userInfo.isNotEmpty || u.fragment.isNotEmpty) return false;
  if (!RegExp(r'^/[0-9]{8,15}$').hasMatch(u.path)) return false;
  final q = u.queryParametersAll;
  if (q.isEmpty) return true;
  return q.length == 1 && q.containsKey('text') && q['text']!.length == 1;
}

/// Opens a WhatsApp chat in the WhatsApp app (or the browser when it is not
/// installed) through url_launcher. Anything but a [isWaMeUri] address is
/// refused with [ShareArgsError]. False when nothing could open it. [open]
/// is for tests.
Future<bool> openWhatsApp(Uri waUri, {UrlOpener? open}) async {
  if (!isWaMeUri(waUri)) throw const ShareArgsError('uri');
  return (open ?? launchOutside)(waUri);
}

/// `https://wa.me/?text=<text>`: WhatsApp's own picker for a message with no
/// preset recipient (the web fallback when the browser has no share sheet).
Uri whatsAppShareUri(String text) =>
    Uri.parse('https://wa.me/?text=${Uri.encodeComponent(text)}');

/// Opens [whatsAppShareUri]. False when nothing could open it.
Future<bool> openWhatsAppShare(String text, {UrlOpener? open}) {
  if (text.isEmpty || text.length > shareTextMaxLength) {
    throw const ShareArgsError('text');
  }
  return (open ?? launchOutside)(whatsAppShareUri(text));
}

/// The finance PDF: opens the share sheet (which also offers Drive and
/// Files to keep a copy). A thin call on [shareBytes].
Future<ShareResult> saveAndShare(
  Uint8List bytes,
  String filename, {
  String mime = 'application/pdf',
}) => shareBytes(bytes, filename, mime: mime);
