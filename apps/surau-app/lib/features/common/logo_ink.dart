// Whether a logo needs a light card behind it on the app's dark headers.
//
// A surau uploads a black wordmark on white and picks "Buang latar putih":
// the box then serves a transparent PNG with dark ink, which is barely
// readable on dark green glass. The rule (mirrored by the kiosk's
// `logoInk.ts`):
//
// * Ink is every pixel with alpha >= 128.
// * An opaque logo (fewer than 5 % of pixels with alpha < 128) carries its
//   own background and never gets a card.
// * Otherwise the ink's luma decides (Rec. 709 weights on the sRGB values,
//   0 black to 1 white, each pixel weighted by its alpha): when at least
//   [darkShare] (40 %) of the ink is dark (luma at or below [darkInkLuma])
//   the logo needs a card. A share, not the mean, so a black wordmark with
//   a gold accent, or one with a green dome and an orange letter (about half
//   the ink coloured), still counts as dark: its black letters would vanish
//   on the header. A white or gold wordmark with a small dark shadow does
//   not (the dark part is under 40 %).
//
// 0.35 (about sRGB 89 of 255) for "dark": below it the ink is within roughly
// 3 : 1 contrast of the header's deep green, so it reads poorly; mid-tones,
// golds, oranges and whites sit above it and hold their own.
//
// At most about 64 000 pixels are looked at (a stride over x and y), so a
// large logo stays cheap. Anything that is not a picture needs no card.

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// The luma (0 to 1) at or below which ink counts as dark.
const double darkInkLuma = 0.35;

/// The share of the ink that must be dark for the logo to get a card.
const double darkShare = 0.4;

/// The share of pixels that must be see-through for the logo to count as
/// "on transparency".
const double transparentShare = 0.05;

const int _maxSamples = 64000;

/// The decision on RGBA bytes (4 per pixel, row by row) of [width] x
/// [height]; false for anything malformed.
bool rgbaWantsLightCard(Uint8List rgba, int width, int height) {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return false;
  final stride = math.max(1, math.sqrt(width * height / _maxSamples).ceil());
  final hist = List<double>.filled(256, 0);
  var sampled = 0;
  var clear = 0;
  var total = 0.0;
  for (var y = 0; y < height; y += stride) {
    for (var x = 0; x < width; x += stride) {
      final i = (y * width + x) * 4;
      final a = rgba[i + 3];
      sampled++;
      if (a < 128) {
        clear++;
        continue;
      }
      final luma = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]).round().clamp(0, 255);
      hist[luma] += a;
      total += a;
    }
  }
  if (sampled == 0 || total == 0) return false;
  if (clear / sampled < transparentShare) return false;
  var dark = 0.0;
  for (var l = 0; l < 256; l++) {
    if (l / 255 > darkInkLuma) break;
    dark += hist[l];
  }
  return dark / total >= darkShare;
}

/// [rgbaWantsLightCard] on an encoded PNG or JPEG; false when it cannot be
/// decoded.
bool logoWantsLightCard(Uint8List bytes) {
  try {
    final d = img.decodeImage(bytes);
    if (d == null || d.width == 0 || d.height == 0) return false;
    final first = d.numFrames > 1 ? d.frames.first : d;
    final im = first.format == img.Format.uint8 && first.numChannels == 4
        ? first
        : first.convert(format: img.Format.uint8, numChannels: 4);
    final data = im.getBytes(order: img.ChannelOrder.rgba);
    return rgbaWantsLightCard(data, im.width, im.height);
  } on Object {
    return false;
  }
}

final Expando<bool> _verdicts = Expando<bool>('logoWantsLightCard');

/// [logoWantsLightCard], decoded once per bytes instance (the logo provider
/// hands the same list to every rebuild).
bool logoWantsLightCardCached(Uint8List bytes) {
  final known = _verdicts[bytes];
  if (known != null) return known;
  final verdict = logoWantsLightCard(bytes);
  _verdicts[bytes] = verdict;
  return verdict;
}
