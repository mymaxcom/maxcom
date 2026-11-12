@TestOn('browser')
library;

// pickFile on the web: a fake input whose files are set with a
// DataTransfer, so the pick reads real bytes through the browser.

import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/prayer/file_pick_web.dart' as web_pick;
import 'package:web/web.dart' as web;

web.HTMLInputElement _inputWith(String name, List<int> bytes) {
  final input = web.HTMLInputElement();
  final dt = web.DataTransfer();
  dt.items.add(web.File([Uint8List.fromList(bytes).toJS].toJS, name));
  input.files = dt.files;
  return input;
}

void main() {
  test('reads the bytes of the chosen file', () async {
    final input = _inputWith('waktu.csv', [1, 2, 3, 4]);
    web_pick.inputFactory = () => input;
    final f = web_pick.pick(['csv'], 1024);
    input.dispatchEvent(web.Event('change'));
    final got = await f;
    expect(got!.name, 'waktu.csv');
    expect(got.bytes, [1, 2, 3, 4]);
    expect(input.accept, contains('.csv'));
  });

  test('a file over the cap is tooBig and unread', () async {
    final input = _inputWith('big.xlsx', List.filled(100, 7));
    web_pick.inputFactory = () => input;
    final f = web_pick.pick(['xlsx'], 10);
    input.dispatchEvent(web.Event('change'));
    final got = await f;
    expect(got!.tooBig, isTrue);
    expect(got.bytes, isEmpty);
  });

  test('cancel gives null', () async {
    final input = web.HTMLInputElement();
    web_pick.inputFactory = () => input;
    final f = web_pick.pick(['csv'], 10);
    input.dispatchEvent(web.Event('cancel'));
    expect(await f, isNull);
  });
}
