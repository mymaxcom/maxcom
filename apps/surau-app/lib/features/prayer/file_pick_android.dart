// Android: the system document picker through `FilePickChannel`
// (android/.../FilePickChannel.kt). The native side reads the chosen Uri
// into memory up to `maxBytes` and answers `{name, bytes}`, or
// `{name, tooBig: true}` beyond it, or null when the person backs out.
// On any other dart:io platform there is no pick.

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart';

import 'file_pick.dart';

const MethodChannel channel = MethodChannel('my.maxcom/filepick');

/// Tests set this to run the Android path on the host machine.
@visibleForTesting
bool? debugAndroid;

bool get _android => debugAndroid ?? Platform.isAndroid;

bool get supported => _android;

Future<PickedFile?> pick(List<String> extensions, int maxBytes) async {
  if (!_android) return null;
  final Map<Object?, Object?>? r;
  try {
    r = await channel.invokeMapMethod<Object?, Object?>('pick', {
      'mimeTypes': mimeTypesFor(extensions),
      'maxBytes': maxBytes,
    });
  } on PlatformException {
    return null;
  }
  if (r == null) return null;
  final name = r['name'] is String ? r['name'] as String : 'file';
  if (r['tooBig'] == true) return PickedFile.tooBig(name);
  final bytes = r['bytes'];
  if (bytes is! Uint8List) return null;
  return PickedFile(name, bytes);
}
