// Web: a hidden file input; read as UTF-8 text.

import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'csv_file_pick.dart';

const bool supported = true;

Future<CsvFileResult?> pick(int maxBytes) {
  final done = Completer<CsvFileResult?>();
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = '.csv,text/csv,text/plain';
  input.onchange = ((web.Event _) {
    final file = input.files?.item(0);
    if (file == null) {
      done.complete(null);
      return;
    }
    if (file.size > maxBytes) {
      done.complete(const CsvFileResult.tooBig());
      return;
    }
    file.text().toDart.then(
      (text) => done.complete(CsvFileResult.text(text.toDart)),
      onError: (Object _) => done.complete(const CsvFileResult.unreadable()),
    );
  }).toJS;
  input.oncancel = ((web.Event _) {
    if (!done.isCompleted) done.complete(null);
  }).toJS;
  input.click();
  return done.future;
}
