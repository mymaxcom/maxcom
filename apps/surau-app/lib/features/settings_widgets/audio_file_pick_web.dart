// Web: a hidden file input limited to MP3.

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

const bool supported = true;

Future<Uint8List?> pick(int maxBytes) {
  final done = Completer<Uint8List?>();
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = '.mp3,audio/mpeg';
  input.onchange = ((web.Event _) {
    final file = input.files?.item(0);
    if (file == null) {
      done.complete(null);
      return;
    }
    if (file.size > maxBytes) {
      done.completeError(StateError('too big'));
      return;
    }
    file.arrayBuffer().toDart.then(
      (buffer) => done.complete(buffer.toDart.asUint8List()),
      onError: (Object e) => done.completeError(e),
    );
  }).toJS;
  input.oncancel = ((web.Event _) {
    if (!done.isCompleted) done.complete(null);
  }).toJS;
  input.click();
  return done.future;
}
