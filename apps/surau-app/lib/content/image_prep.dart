// A photo is made small and upright on the device before it is uploaded
// (builder's call 9): decode JPEG, PNG or WebP, bake the EXIF orientation,
// shrink the longest side to 1920 px, encode JPEG at quality 85. A PNG
// keeps its format only when it is actually transparent (a logo). The box
// still validates what arrives. Heavy work runs in a background isolate on
// Android; the web has no isolates, so there it runs inline while the
// editor shows a progress indicator.

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import '../box/wire.dart' show ImageBox;

class PreparedImage {
  const PreparedImage({
    required this.bytes,
    required this.mime,
    required this.width,
    required this.height,
  });

  final Uint8List bytes;

  /// `image/jpeg` or `image/png`: the `Content-Type` of the upload.
  final String mime;
  final int width;
  final int height;
}

/// The file could not be read as an image. [message] is for the person.
class ImagePrepError implements Exception {
  const ImagePrepError(this.message);

  final String message;

  static const String notAnImage =
      'Fail ini bukan gambar yang boleh dibaca. Pilih fail JPEG, PNG atau WebP.';

  @override
  String toString() => 'ImagePrepError($message)';
}

/// The default longest side and JPEG quality (plan: 1920 px, q85).
const int defaultMaxSide = 1920;
const int defaultJpegQuality = 85;

class _Job {
  const _Job(this.input, this.maxSide, this.quality);

  final Uint8List input;
  final int maxSide;
  final int quality;
}

/// [prepareImageSync] in a background isolate on Android, inline on web.
Future<PreparedImage> prepareImage(
  Uint8List input, {
  int maxSide = defaultMaxSide,
  int quality = defaultJpegQuality,
}) {
  final job = _Job(input, maxSide, quality);
  if (kIsWeb) return Future.sync(() => _run(job));
  return compute(_run, job);
}

PreparedImage _run(_Job job) =>
    prepareImageSync(job.input, maxSide: job.maxSide, quality: job.quality);

/// The whole job on the calling thread: decode, bake orientation, resize,
/// encode. Throws [ImagePrepError] when the bytes are not an image.
PreparedImage prepareImageSync(
  Uint8List input, {
  int maxSide = defaultMaxSide,
  int quality = defaultJpegQuality,
}) {
  img.Image? decoded;
  try {
    decoded = img.decodeImage(input);
  } on Object {
    decoded = null;
  }
  if (decoded == null || decoded.width == 0 || decoded.height == 0) {
    throw const ImagePrepError(ImagePrepError.notAnImage);
  }

  // Multi-frame files (animated WebP or PNG): the first frame is the picture.
  var im = decoded.numFrames > 1 ? decoded.frames.first : decoded;
  im = img.bakeOrientation(im);

  final longest = im.width > im.height ? im.width : im.height;
  if (longest > maxSide) {
    im = im.width >= im.height
        ? img.copyResize(
            im,
            width: maxSide,
            interpolation: img.Interpolation.average,
          )
        : img.copyResize(
            im,
            height: maxSide,
            interpolation: img.Interpolation.average,
          );
  }

  if (_hasTransparency(im)) {
    return PreparedImage(
      bytes: Uint8List.fromList(img.encodePng(im)),
      mime: 'image/png',
      width: im.width,
      height: im.height,
    );
  }
  // JPEG has no alpha channel; drop one that is fully opaque.
  if (im.numChannels == 4) im = im.convert(numChannels: 3);
  return PreparedImage(
    bytes: Uint8List.fromList(img.encodeJpg(im, quality: quality)),
    mime: 'image/jpeg',
    width: im.width,
    height: im.height,
  );
}

bool _hasTransparency(img.Image im) {
  if (!im.hasAlpha) return false;
  final opaque = im.maxChannelValue;
  for (final p in im) {
    if (p.a < opaque) return true;
  }
  return false;
}

class _BakeJob {
  const _BakeJob(this.input, this.rotate, this.crop, this.quality);

  final Uint8List input;
  final int rotate;
  final ImageBox? crop;
  final int quality;
}

/// [bakeAdjustmentSync] in a background isolate on Android, inline on web.
Future<PreparedImage> bakeAdjustment(
  Uint8List input, {
  int rotate = 0,
  ImageBox? crop,
  int quality = defaultJpegQuality,
}) {
  final job = _BakeJob(input, rotate, crop, quality);
  if (kIsWeb) return Future.sync(() => _bake(job));
  return compute(_bake, job);
}

PreparedImage _bake(_BakeJob job) => bakeAdjustmentSync(
  job.input,
  rotate: job.rotate,
  crop: job.crop,
  quality: job.quality,
);

/// The picture turned [rotate] degrees clockwise (0, 90, 180, 270), then
/// cut to [crop] (0..1 of the turned picture), encoded as JPEG. Used where
/// a setting can hold only a plain asset id (the TV's backgrounds): the
/// adjustment is burnt into a new picture instead of stored beside it.
PreparedImage bakeAdjustmentSync(
  Uint8List input, {
  int rotate = 0,
  ImageBox? crop,
  int quality = defaultJpegQuality,
}) {
  img.Image? decoded;
  try {
    decoded = img.decodeImage(input);
  } on Object {
    decoded = null;
  }
  if (decoded == null || decoded.width == 0 || decoded.height == 0) {
    throw const ImagePrepError(ImagePrepError.notAnImage);
  }
  var im = decoded.numFrames > 1 ? decoded.frames.first : decoded;
  im = img.bakeOrientation(im);
  if (rotate % 360 != 0) im = img.copyRotate(im, angle: rotate % 360);
  if (crop != null) {
    final x = (crop.x * im.width).round().clamp(0, im.width - 1);
    final y = (crop.y * im.height).round().clamp(0, im.height - 1);
    final w = (crop.w * im.width).round().clamp(1, im.width - x);
    final h = (crop.h * im.height).round().clamp(1, im.height - y);
    im = img.copyCrop(im, x: x, y: y, width: w, height: h);
  }
  if (im.numChannels == 4) im = im.convert(numChannels: 3);
  return PreparedImage(
    bytes: Uint8List.fromList(img.encodeJpg(im, quality: quality)),
    mime: 'image/jpeg',
    width: im.width,
    height: im.height,
  );
}
