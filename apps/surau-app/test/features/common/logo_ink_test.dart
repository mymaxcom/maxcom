// The light-card decision for a logo (lib/features/common/logo_ink.dart):
// dark ink on transparency gets a card; light or coloured ink, opaque
// logos and non-pictures never do.

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/features/common/logo_ink.dart';

Uint8List _png(img.Image im) => Uint8List.fromList(img.encodePng(im));

/// 100 x 40 fully transparent canvas.
img.Image _clear() => img.Image(width: 100, height: 40, numChannels: 4);

img.Image _wordmark(img.Color ink, {img.Color? accent}) {
  final im = _clear();
  img.fillRect(im, x1: 10, y1: 10, x2: 90, y2: 30, color: ink);
  if (accent != null) img.fillRect(im, x1: 80, y1: 12, x2: 90, y2: 18, color: accent);
  return im;
}

void main() {
  test('black ink on transparency needs a light card', () {
    expect(logoWantsLightCard(_png(_wordmark(img.ColorRgba8(0, 0, 0, 255)))), isTrue);
    expect(logoWantsLightCard(_png(_wordmark(img.ColorRgba8(20, 40, 90, 255)))), isTrue, reason: 'dark navy');
  });

  test('white and gold ink on transparency need none', () {
    expect(logoWantsLightCard(_png(_wordmark(img.ColorRgba8(255, 255, 255, 255)))), isFalse);
    expect(logoWantsLightCard(_png(_wordmark(img.ColorRgba8(240, 201, 122, 255)))), isFalse);
  });

  test('an opaque black-on-white logo carries its own background', () {
    final im = img.Image(width: 100, height: 40, numChannels: 4);
    img.fill(im, color: img.ColorRgba8(255, 255, 255, 255));
    img.fillRect(im, x1: 10, y1: 10, x2: 90, y2: 30, color: img.ColorRgba8(0, 0, 0, 255));
    expect(logoWantsLightCard(_png(im)), isFalse);
    // An RGB PNG (no alpha channel at all) is opaque too.
    final rgb = img.Image(width: 20, height: 20);
    img.fill(rgb, color: img.ColorRgb8(0, 0, 0));
    expect(logoWantsLightCard(_png(rgb)), isFalse);
  });

  test('a black wordmark with a small gold accent is still dark', () {
    final im = _wordmark(img.ColorRgba8(0, 0, 0, 255), accent: img.ColorRgba8(240, 201, 122, 255));
    expect(logoWantsLightCard(_png(im)), isTrue);
  });

  test('black letters with coloured parts (about half the ink) still need a card', () {
    final im = _clear();
    img.fillRect(im, x1: 10, y1: 10, x2: 50, y2: 30, color: img.ColorRgba8(0, 0, 0, 255));
    img.fillRect(im, x1: 50, y1: 10, x2: 70, y2: 30, color: img.ColorRgba8(60, 170, 60, 255));
    img.fillRect(im, x1: 70, y1: 10, x2: 90, y2: 30, color: img.ColorRgba8(240, 75, 20, 255));
    expect(logoWantsLightCard(_png(im)), isTrue);
  });

  test('a white wordmark with a small black accent is still light', () {
    final im = _wordmark(img.ColorRgba8(255, 255, 255, 255), accent: img.ColorRgba8(0, 0, 0, 255));
    expect(logoWantsLightCard(_png(im)), isFalse);
  });

  test('a gold wordmark with a dark shadow under 40 % of the ink needs none', () {
    final im = _clear();
    img.fillRect(im, x1: 10, y1: 10, x2: 70, y2: 30, color: img.ColorRgba8(240, 201, 122, 255));
    img.fillRect(im, x1: 70, y1: 10, x2: 90, y2: 30, color: img.ColorRgba8(0, 0, 0, 255));
    expect(logoWantsLightCard(_png(im)), isFalse);
  });

  test('a fully transparent picture and garbage bytes need none', () {
    expect(logoWantsLightCard(_png(_clear())), isFalse);
    expect(logoWantsLightCard(Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8])), isFalse);
    expect(logoWantsLightCard(Uint8List(0)), isFalse);
  });

  test('raw RGBA: malformed sizes are refused, a large picture is sampled', () {
    expect(rgbaWantsLightCard(Uint8List(3), 2, 2), isFalse);
    expect(rgbaWantsLightCard(Uint8List(16), 0, 4), isFalse);
    final big = Uint8List(2000 * 1500 * 4); // transparent black
    for (var y = 500; y < 1000; y++) {
      for (var x = 200; x < 1800; x++) {
        big[(y * 2000 + x) * 4 + 3] = 255; // black opaque ink
      }
    }
    expect(rgbaWantsLightCard(big, 2000, 1500), isTrue);
  });

  test('the verdict is cached per bytes instance', () {
    final bytes = _png(_wordmark(img.ColorRgba8(0, 0, 0, 255)));
    expect(logoWantsLightCardCached(bytes), isTrue);
    expect(logoWantsLightCardCached(bytes), isTrue);
  });
}
