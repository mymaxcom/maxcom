// Web: a hidden file input; the bytes are read only when the file fits.

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'file_pick.dart';

const bool supported = true;

/// Tests replace this to hand the pick an input they can fill.
web.HTMLInputElement Function() inputFactory = web.HTMLInputElement.new;

Future<PickedFile?> pick(List<String> extensions, int maxBytes) {
  final done = Completer<PickedFile?>();
  final input = inputFactory()
    ..type = 'file'
    ..accept = [
      for (final e in extensions) '.${e.toLowerCase()}',
      ...mimeTypesFor(extensions),
    ].join(',');
  input.onchange = ((web.Event _) {
    final file = input.files?.item(0);
    if (file == null) {
      done.complete(null);
      return;
    }
    if (file.size > maxBytes) {
      done.complete(PickedFile.tooBig(file.name));
      return;
    }
    file.arrayBuffer().toDart.then(
      (buf) => done.complete(PickedFile(file.name, Uint8List.view(buf.toDart))),
      onError: (Object e) => done.completeError(e),
    );
  }).toJS;
  input.oncancel = ((web.Event _) {
    if (!done.isCompleted) done.complete(null);
  }).toJS;
  input.click();
  return done.future;
}
