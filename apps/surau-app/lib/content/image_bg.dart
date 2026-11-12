// What the box does to a picture, done again on the device so a thumbnail
// and the adjust screen show the adjusted look before anything is saved:
// `analyzeImage` (apps/box-server/src/imageAdjust.ts: the plain background
// from the four corners, the tight content box) and `removeBackground`
// (the plain colour made transparent with a soft edge). The same numbers
// as the box, so the preview is what the TV will get. Also the width and
// height of a PNG or JPEG read from its header, without decoding it.

import 'dart:math' as math;
import 'dart:ui' show Size;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import 'image_ref.dart';

/// Largest distance (any channel) at which a pixel is still the background.
const int bgTolerance = 24;
const int _removeLow = 16;
const int _removeHigh = 80;
const double _plainConfidence = 0.9;
const int _nearWhite = 235;

/// The rounded light plate behind a `card` logo (the box's PLATE_COLOUR).
const int plateR = 248;
const int plateG = 246;
const int plateB = 240;

img.Image _rgba8(img.Image im) =>
    im.format == img.Format.uint8 && im.numChannels == 4 ? im : im.convert(format: img.Format.uint8, numChannels: 4);

int _dist(img.Pixel p, List<double> c) => math.max(
  (p.r - c[0]).abs(),
  math.max((p.g - c[1]).abs(), (p.b - c[2]).abs()),
).round();

String _hex2(double n) => n.round().toRadixString(16).padLeft(2, '0');

/// The box's `analyzeImage` on decoded pixels, as the JSON of
/// `GET /api/assets/<id>/analyze` (`ImageAnalysis.fromJson` reads it).
Map<String, Object?> analyzeDecoded(img.Image source) {
  final im = _rgba8(source);
  final w = im.width;
  final h = im.height;

  ({List<double> c, double a}) corner(bool right, bool bottom) {
    var r = 0.0;
    var g = 0.0;
    var b = 0.0;
    var a = 0.0;
    var n = 0;
    for (var dy = 0; dy < 3; dy++) {
      for (var dx = 0; dx < 3; dx++) {
        final x = right ? w - 1 - dx : dx;
        final y = bottom ? h - 1 - dy : dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        final p = im.getPixel(x, y);
        r += p.r;
        g += p.g;
        b += p.b;
        a += p.a;
        n++;
      }
    }
    final d = math.max(1, n);
    return (c: [r / d, g / d, b / d], a: a / d);
  }

  final corners = [corner(false, false), corner(true, false), corner(false, true), corner(true, true)];
  final transparent = corners.where((c) => c.a < 16).length >= 3;
  final opaque = corners.where((c) => c.a >= 16).toList();
  final bg = [0.0, 0.0, 0.0];
  for (final c in opaque) {
    for (var k = 0; k < 3; k++) {
      bg[k] += c.c[k] / math.max(1, opaque.length);
    }
  }

  bool onRing(int x, int y) {
    final p = im.getPixel(x, y);
    return transparent ? p.a < 16 : p.a >= 16 && _dist(p, bg) <= bgTolerance;
  }

  var ringTotal = 0;
  var ringHit = 0;
  for (var x = 0; x < w; x++) {
    ringTotal += 2;
    ringHit += (onRing(x, 0) ? 1 : 0) + (onRing(x, h - 1) ? 1 : 0);
  }
  for (var y = 1; y < h - 1; y++) {
    ringTotal += 2;
    ringHit += (onRing(0, y) ? 1 : 0) + (onRing(w - 1, y) ? 1 : 0);
  }
  final confidence = ringTotal > 0 ? ringHit / ringTotal : 0.0;
  final cornersAgree =
      transparent ||
      opaque.length == 4 &&
          opaque.every(
            (c) => math.max((c.c[0] - bg[0]).abs(), math.max((c.c[1] - bg[1]).abs(), (c.c[2] - bg[2]).abs())) <= bgTolerance,
          );
  final plain = !transparent && cornersAgree && confidence >= _plainConfidence;

  var trim = fullBox;
  var contentFound = false;
  if (plain || transparent) {
    var minX = w;
    var minY = h;
    var maxX = -1;
    var maxY = -1;
    for (final p in im) {
      final content = transparent ? p.a >= 16 : p.a >= 16 && _dist(p, bg) > bgTolerance;
      if (!content) continue;
      contentFound = true;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (maxX >= 0) {
      trim = _clampRect(minX / w, minY / h, (maxX - minX + 1) / w, (maxY - minY + 1) / h);
    }
  }
  final nearWhite = plain && math.min(bg[0], math.min(bg[1], bg[2])) >= _nearWhite;

  return {
    'width': w,
    'height': h,
    'trim': trim.toJson(),
    'background': {
      'plain': plain,
      'colour': plain ? '#${_hex2(bg[0])}${_hex2(bg[1])}${_hex2(bg[2])}' : null,
      'confidence': (confidence * 1000).round() / 1000,
      'transparent': transparent,
      'suggested': nearWhite && contentFound ? 'remove' : 'keep',
    },
  };
}

ImageBox _clampRect(double x, double y, double w, double h) {
  final ww = math.min(1.0, math.max(minCropSpan, w));
  final hh = math.min(1.0, math.max(minCropSpan, h));
  return ImageBox(x: math.min(math.max(0, x), 1 - ww), y: math.min(math.max(0, y), 1 - hh), w: ww, h: hh);
}

/// [analyzeDecoded] on encoded bytes; null when they are not a picture.
Map<String, Object?>? analyzeBytes(Uint8List bytes) {
  final im = _decode(bytes);
  return im == null ? null : analyzeDecoded(im);
}

img.Image? _decode(Uint8List bytes) {
  try {
    final d = img.decodeImage(bytes);
    if (d == null || d.width == 0 || d.height == 0) return null;
    return d.numFrames > 1 ? d.frames.first : d;
  } on Object {
    return null;
  }
}

/// The picture with its plain background made transparent, as the box's
/// `removeBackground` (soft edge between 16 and 80 of distance, the edge
/// colour un-blended from the background), encoded as PNG. The picture is
/// first shrunk to [maxSide] on its longest side (a preview, not the
/// stored derivative). Null when the bytes are not a picture or the
/// background is not plain (then there is nothing to remove and the
/// caller shows the picture as it is).
Uint8List? removeBackgroundPng(Uint8List bytes, {int maxSide = 1024}) {
  var im = _decode(bytes);
  if (im == null) return null;
  final longest = math.max(im.width, im.height);
  if (longest > maxSide) {
    im = im.width >= im.height
        ? img.copyResize(im, width: maxSide, interpolation: img.Interpolation.average)
        : img.copyResize(im, height: maxSide, interpolation: img.Interpolation.average);
  }
  im = _rgba8(im);
  final a = analyzeDecoded(im);
  final background = a['background']! as Map<String, Object?>;
  final colour = background['colour'];
  if (background['plain'] != true || colour is! String) return null;
  final bg = [
    int.parse(colour.substring(1, 3), radix: 16).toDouble(),
    int.parse(colour.substring(3, 5), radix: 16).toDouble(),
    int.parse(colour.substring(5, 7), radix: 16).toDouble(),
  ];
  for (final p in im) {
    final d = _dist(p, bg);
    final t = d <= _removeLow ? 0.0 : d >= _removeHigh ? 1.0 : (d - _removeLow) / (_removeHigh - _removeLow);
    if (t >= 1) continue;
    final alpha = t * (p.a / 255);
    if (alpha <= 0) {
      p.setRgba(0, 0, 0, 0);
      continue;
    }
    p.setRgba(
      ((p.r - bg[0] * (1 - t)) / t).round().clamp(0, 255),
      ((p.g - bg[1] * (1 - t)) / t).round().clamp(0, 255),
      ((p.b - bg[2] * (1 - t)) / t).round().clamp(0, 255),
      (alpha * 255).round(),
    );
  }
  return Uint8List.fromList(img.encodePng(im));
}

/// [removeBackgroundPng] off the UI thread on Android (inline on the web,
/// which has no isolates).
Future<Uint8List?> removeBackgroundAsync(Uint8List bytes) {
  if (kIsWeb) return Future.sync(() => removeBackgroundPng(bytes));
  return compute(_removeJob, bytes);
}

Uint8List? _removeJob(Uint8List bytes) => removeBackgroundPng(bytes);

/// The width and height of a PNG or JPEG from its header, or null for
/// anything else (then the caller decodes).
Size? pictureSize(Uint8List b) {
  if (b.length >= 24 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) {
    final d = ByteData.sublistView(b);
    final w = d.getUint32(16);
    final h = d.getUint32(20);
    return w > 0 && h > 0 ? Size(w.toDouble(), h.toDouble()) : null;
  }
  if (b.length >= 4 && b[0] == 0xFF && b[1] == 0xD8) {
    var i = 2;
    while (i + 9 < b.length) {
      if (b[i] != 0xFF) {
        i++;
        continue;
      }
      final marker = b[i + 1];
      if (marker == 0xFF) {
        i++;
        continue;
      }
      if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        i += 2;
        continue;
      }
      final len = (b[i + 2] << 8) | b[i + 3];
      final sof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
      if (sof) {
        final h = (b[i + 5] << 8) | b[i + 6];
        final w = (b[i + 7] << 8) | b[i + 8];
        return w > 0 && h > 0 ? Size(w.toDouble(), h.toDouble()) : null;
      }
      if (marker == 0xDA) break;
      i += 2 + len;
    }
  }
  return null;
}
