// Android half: MethodChannel `my.maxcom/share` (ShareChannel.kt). Names and
// content are never logged; a failure is [ShareFailed] with no detail.

import 'package:flutter/services.dart';

import 'share.dart';

const String implementation = 'android';

const MethodChannel _channel = MethodChannel('my.maxcom/share');

Map<String, Object> _args(Uint8List bytes, String filename, String mime) => {
  'bytes': bytes,
  'filename': filename,
  'mime': mime,
};

/// Android 10 and later: Downloads through MediaStore. Android 8 and 9, or a
/// failed write: the share sheet.
Future<SaveResult> save(Uint8List bytes, String filename, String mime) async {
  try {
    final r = await _channel.invokeMapMethod<String, Object?>(
      'save',
      _args(bytes, filename, mime),
    );
    if (r?['saved'] == true) return const SaveResult(saved: true);
  } on PlatformException {
    // fall back to the share sheet below
  }
  await share(bytes, filename, mime);
  return const SaveResult(saved: false, sharedInstead: true);
}

Future<ShareResult> share(Uint8List bytes, String filename, String mime) async {
  try {
    final r = await _channel.invokeMapMethod<String, Object?>(
      'share',
      _args(bytes, filename, mime),
    );
    final via = r?['via'];
    return ShareResult(
      via is String && ShareResult.vias.contains(via) ? via : 'other',
      completed: r?['completed'] == true,
    );
  } on PlatformException {
    throw const ShareFailed();
  } on MissingPluginException {
    throw const ShareFailed();
  }
}
