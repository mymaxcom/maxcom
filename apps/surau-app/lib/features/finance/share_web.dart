// Web half: a Blob and an anchor download; navigator.share with a File when
// the browser says it can. Names and content are never logged.

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'share.dart';

const String implementation = 'web';

web.Blob _blob(Uint8List bytes, String mime) =>
    web.Blob(<JSAny>[bytes.toJS].toJS, web.BlobPropertyBag(type: mime));

Future<SaveResult> save(Uint8List bytes, String filename, String mime) async {
  final url = web.URL.createObjectURL(_blob(bytes, mime));
  final a = web.HTMLAnchorElement()
    ..href = url
    ..download = filename
    ..style.display = 'none';
  web.document.body?.append(a);
  a.click();
  a.remove();
  // The browser has started the download; free the object URL later.
  Timer(const Duration(seconds: 30), () => web.URL.revokeObjectURL(url));
  return const SaveResult(saved: true);
}

Future<ShareResult> share(Uint8List bytes, String filename, String mime) async {
  final file = web.File(
    <JSAny>[bytes.toJS].toJS,
    filename,
    web.FilePropertyBag(type: mime),
  );
  final data = web.ShareData(files: <web.File>[file].toJS);
  final nav = web.window.navigator;
  bool can;
  try {
    can = nav.canShare(data);
  } on Object {
    can = false;
  }
  if (!can) {
    await save(bytes, filename, mime);
    return const ShareResult('other', completed: false);
  }
  try {
    await nav.share(data).toDart;
    // The browser never says which app took it.
    return const ShareResult('other');
  } on Object {
    // The person closed the sheet (AbortError) or the browser refused.
    return const ShareResult('other', completed: false);
  }
}
