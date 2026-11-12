// A platform with neither Android nor a browser (not shipped): nothing is
// saved or sent. Arguments were already checked by share.dart.

import 'dart:typed_data';

import 'share.dart';

const String implementation = 'stub';

Future<SaveResult> save(Uint8List bytes, String filename, String mime) async =>
    const SaveResult(saved: false);

Future<ShareResult> share(
  Uint8List bytes,
  String filename,
  String mime,
) async => const ShareResult('other', completed: false);
