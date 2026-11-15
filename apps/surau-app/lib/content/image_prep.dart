// A photo is made small and upright on the device before it is uploaded
// (builder's call 9): decode JPEG, PNG or WebP, bake the EXIF orientation,
// shrink the longest side to 1920 px, encode JPEG at quality 85. A PNG
// keeps its format only when it is actually transparent (a logo). The box
// still validates what arrives. Heavy work runs in a background isolate on
// Android; the web has no isolates, so there it runs inline while the
// editor shows a progress indicator.

import 'dart:typed_data' show BytesBuilder;

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

/// The fast path (no re-encode) is only for files this small: a large file
/// of few pixels (a q100 JPEG) is re-encoded so it stays well under the
/// upload caps.
const int fastPathMaxBytes = 1500000;

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
  // Fast path: the gallery picker already shrinks the photo on Android
  // (max 1920 px, JPEG q85). An upright JPEG that small needs no decode and
  // re-encode: only its header is read and its metadata segments dropped.
  final head = input.length <= fastPathMaxBytes ? readJpegHead(input) : null;
  if (head != null &&
      head.upright &&
      head.width > 0 &&
      head.height > 0 &&
      (head.width > head.height ? head.width : head.height) <= maxSide) {
    // Metadata (EXIF with GPS, XMP, IPTC, comments) never leaves the device:
    // dropped by copying segments, still no pixel work.
    final clean = stripJpegMetadata(input);
    if (clean != null) {
      return PreparedImage(
        bytes: clean,
        mime: 'image/jpeg',
        width: head.width,
        height: head.height,
      );
    }
  }

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

/// What the header of a JPEG says, read without decoding the picture.
class JpegHead {
  const JpegHead({
    required this.width,
    required this.height,
    required this.orientation,
  });

  final int width;
  final int height;

  /// The EXIF orientation (1..8); null when the file has none.
  final int? orientation;

  /// No turn is needed to show it upright (EXIF orientation 1 or absent).
  bool get upright => orientation == null || orientation == 1;
}

/// The size and EXIF orientation of a JPEG from its marker segments only
/// (no decode), or null when [b] is not a complete-looking baseline or
/// progressive JPEG with a grey or colour (1 or 3 component) frame and a
/// scan. Anything else (CMYK, truncated, not a JPEG) takes the full path.
JpegHead? readJpegHead(Uint8List b) {
  try {
    if (b.length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
    final d = ByteData.sublistView(b);
    var i = 2;
    int? w;
    int? h;
    int? orientation;
    var components = 0;
    var sawScan = false;
    while (i + 4 <= b.length) {
      if (b[i] != 0xFF) return null;
      final m = b[i + 1];
      if (m == 0xFF) {
        i++; // fill byte
        continue;
      }
      i += 2;
      if (m == 0x01 || (m >= 0xD0 && m <= 0xD8)) continue; // no length
      if (m == 0xD9) break;
      final len = d.getUint16(i);
      if (len < 2 || i + len > b.length) return null;
      final seg = i + 2;
      // Only baseline (C0) and progressive (C2) Huffman frames, 8 bits per
      // sample: arithmetic, lossless, 12-bit and the rest take the full path.
      final isSof = m >= 0xC0 &&
          m <= 0xCF &&
          m != 0xC4 &&
          m != 0xC8 &&
          m != 0xCC;
      if (isSof) {
        if (m != 0xC0 && m != 0xC2) return null;
        if (len < 8 || b[seg] != 8) return null;
        h = d.getUint16(seg + 1);
        w = d.getUint16(seg + 3);
        components = b[seg + 5];
      } else if (m == 0xE1 && orientation == null) {
        orientation = _exifOrientation(d, seg, i + len);
      } else if (m == 0xDA) {
        sawScan = true;
        break;
      }
      i += len;
    }
    if (!sawScan || w == null || h == null) return null;
    if (components != 1 && components != 3) return null;
    return JpegHead(width: w, height: h, orientation: orientation);
  } on RangeError {
    return null;
  }
}

/// [b] without its metadata: every APPn segment except a JFIF APP0, and
/// every comment, is dropped; the segments before the scan are copied, the
/// scan and the rest verbatim. The ICC colour profile (APP2 `ICC_PROFILE`)
/// is kept. Returns [b] itself when there was nothing to drop. Null (use the
/// full path) when the structure is unexpected, an Adobe APP14
/// colour-transform segment is present (dropping it could change the
/// colours), or the file does not end exactly at the end of its scans
/// (bytes after the EOI, a second picture, or an APPn/COM segment after the
/// first scan could carry metadata the copy would keep).
Uint8List? stripJpegMetadata(Uint8List b) {
  try {
    if (b.length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
    final d = ByteData.sublistView(b);
    final out = BytesBuilder(copy: false)..add(Uint8List.sublistView(b, 0, 2));
    var i = 2;
    var dropped = false;
    while (i + 4 <= b.length) {
      if (b[i] != 0xFF) return null;
      final m = b[i + 1];
      if (m == 0xFF) return null; // fill bytes: not worth trusting
      if (m == 0x01 || (m >= 0xD0 && m <= 0xD8) || m == 0xD9) return null;
      final len = d.getUint16(i + 2);
      if (len < 2 || i + 2 + len > b.length) return null;
      final end = i + 2 + len;
      if (m == 0xDA) {
        if (!_endsCleanlyAfterScan(b, end)) return null;
        out.add(Uint8List.sublistView(b, i)); // the scan and the rest
        return dropped ? out.toBytes() : b;
      }
      var keep = true;
      if (m == 0xE0) {
        keep = len >= 7 &&
            b[i + 4] == 0x4A &&
            b[i + 5] == 0x46 &&
            b[i + 6] == 0x49 &&
            b[i + 7] == 0x46 &&
            b[i + 8] == 0;
      } else if (m == 0xEE) {
        if (len >= 7 && b[i + 4] == 0x41 && b[i + 5] == 0x64) return null;
        keep = false;
      } else if (m == 0xE2) {
        keep = _isIccProfile(b, i, len);
      } else if ((m >= 0xE1 && m <= 0xEF) || m == 0xFE) {
        keep = false;
      }
      if (keep) {
        out.add(Uint8List.sublistView(b, i, end));
      } else {
        dropped = true;
      }
      i = end;
    }
    return null;
  } on RangeError {
    return null;
  }
}

/// An APP2 segment at [i] (marker offset) of length [len] that holds a piece
/// of the ICC colour profile.
bool _isIccProfile(Uint8List b, int i, int len) {
  const tag = [0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45, 0];
  if (len < 2 + tag.length) return false;
  for (var k = 0; k < tag.length; k++) {
    if (b[i + 4 + k] != tag[k]) return false;
  }
  return true;
}

/// True when, from [scanStart] (just after the first SOS header) to the end,
/// the data holds only entropy-coded scan data, the markers between scans,
/// and one EOI that is the very last two bytes: no second SOI, no APPn or
/// COM segment, nothing after the EOI. (A stuffed 0xFF in scan data is
/// followed by 0x00, a restart marker or another scan marker, so a marker
/// that matters never hides in it.)
bool _endsCleanlyAfterScan(Uint8List b, int scanStart) {
  final n = b.length;
  if (n < scanStart + 2 || b[n - 2] != 0xFF || b[n - 1] != 0xD9) return false;
  var i = scanStart;
  while (i < n - 1) {
    if (b[i] != 0xFF) {
      i++;
      continue;
    }
    final m = b[i + 1];
    if (m == 0xFF) {
      i++;
      continue;
    }
    if (m == 0xD9) return i == n - 2;
    if (m == 0xD8 || (m >= 0xE0 && m <= 0xEF) || m == 0xFE) return false;
    i += 2;
  }
  return false;
}

int? _exifOrientation(ByteData d, int start, int end) {
  // "Exif  " then a TIFF header.
  if (end - start < 14 ||
      d.getUint32(start) != 0x45786966 ||
      d.getUint16(start + 4) != 0) {
    return null;
  }
  final tiff = start + 6;
  final Endian e;
  if (d.getUint16(tiff) == 0x4949) {
    e = Endian.little;
  } else if (d.getUint16(tiff) == 0x4D4D) {
    e = Endian.big;
  } else {
    return null;
  }
  final ifd = tiff + d.getUint32(tiff + 4, e);
  if (ifd + 2 > end) return null;
  final n = d.getUint16(ifd, e);
  for (var k = 0; k < n; k++) {
    final at = ifd + 2 + k * 12;
    if (at + 12 > end) return null;
    if (d.getUint16(at, e) == 0x0112) {
      final v = d.getUint16(at + 8, e);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
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
