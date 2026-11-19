// A platform with neither Android nor a browser (not shipped): nothing is
// saved or sent. Arguments were already checked by share.dart.

import 'dart:typed_data';

import 'share.dart';

const String implementation = 'stub';

Future<SaveResult> save(Uint8List bytes, String filename, String mime) async =>
    const SaveResult(saved: false);

Future<ShareResult> shareText(String text, [String? subject]) async =>
    const ShareResult('other', completed: false, unavailable: true);

Future<ShareResult> share(
  Uint8List bytes,
  String filename,
  String mime,
) async => const ShareResult('other', completed: false);

Future<bool> whatsAppInstalled() async => false;

Future<ShareResult> shareNotice(String text, Uint8List? picture, bool toWhatsApp) =>
    shareText(text);

Future<void> cleanNotice() async {}
