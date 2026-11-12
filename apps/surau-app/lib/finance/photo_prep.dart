// A finance photo (the counting sheet, a receipt) is made small and upright
// on the device before it is queued: decode, apply the EXIF orientation,
// shrink the longest side to 1280 px, encode JPEG at quality 80, and refuse
// when it is still over 2 MB. The box takes JPEG only and checks again.

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import 'ledger.dart' show maxPhotoBytes, maxPhotoSide;

const int financePhotoQuality = 80;

/// The picture cannot be queued. [message] is for the person.
class FinancePhotoError implements Exception {
  const FinancePhotoError(this.message);

  final String message;

  static const String notAnImage =
      'Fail ini bukan gambar yang boleh dibaca. Pilih gambar JPEG atau PNG.';
  static const String tooBig =
      'Gambar masih terlalu besar. Ambil gambar semula dari jarak yang lebih dekat.';

  @override
  String toString() => 'FinancePhotoError($message)';
}

/// The whole job on the calling thread. Throws [FinancePhotoError] when the
/// bytes are not an image or the JPEG is still over 2 MB.
Uint8List prepareFinancePhoto(Uint8List input) {
  img.Image? decoded;
  try {
    decoded = img.decodeImage(input);
  } on Object {
    decoded = null;
  }
  if (decoded == null || decoded.width == 0 || decoded.height == 0) {
    throw const FinancePhotoError(FinancePhotoError.notAnImage);
  }
  var im = decoded.numFrames > 1 ? decoded.frames.first : decoded;
  im = img.bakeOrientation(im);

  final longest = im.width > im.height ? im.width : im.height;
  if (longest > maxPhotoSide) {
    im = im.width >= im.height
        ? img.copyResize(
            im,
            width: maxPhotoSide,
            interpolation: img.Interpolation.average,
          )
        : img.copyResize(
            im,
            height: maxPhotoSide,
            interpolation: img.Interpolation.average,
          );
  }
  // JPEG has no alpha channel.
  if (im.numChannels == 4) im = im.convert(numChannels: 3);
  final out = Uint8List.fromList(
    img.encodeJpg(im, quality: financePhotoQuality),
  );
  if (out.length > maxPhotoBytes) {
    throw const FinancePhotoError(FinancePhotoError.tooBig);
  }
  return out;
}

/// [prepareFinancePhoto] in a background isolate on Android, inline on the
/// web (which has no isolates).
Future<Uint8List> prepareFinancePhotoAsync(Uint8List input) {
  if (kIsWeb) return Future.sync(() => prepareFinancePhoto(input));
  return compute(prepareFinancePhoto, input);
}
