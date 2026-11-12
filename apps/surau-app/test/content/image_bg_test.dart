// The device-side copy of the box's picture analysis and background
// removal gives the same answer as the box for the operator's wordmark
// (apps/box-server/test/fixtures/maxcom-logo.png, analysed by the box's
// own code: plain #ffffff at 0.995, trim 0.038/0.0556/0.93/0.9444,
// suggested remove), leaves a photo alone, and reads a PNG or JPEG size
// from its header.

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' show Size;

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/content/image_bg.dart';

Uint8List maxcom() => File('test/fixtures/maxcom-logo.png').readAsBytesSync();

void main() {
  test('the wordmark on white: plain, near white, suggested remove, trimmed as the box trims', () {
    final a = ImageAnalysis.fromJson(analyzeBytes(maxcom())!.cast<String, dynamic>());
    expect(a.width, 500);
    expect(a.height, 126);
    expect(a.plainBackground, isTrue);
    expect(a.backgroundColour, '#ffffff');
    expect(a.backgroundConfidence, closeTo(0.995, 1e-3));
    expect(a.transparent, isFalse);
    expect(a.suggested, 'remove');
    expect(a.trim.x, closeTo(0.038, 1e-3));
    expect(a.trim.y, closeTo(0.0556, 1e-3));
    expect(a.trim.w, closeTo(0.93, 1e-3));
    expect(a.trim.h, closeTo(0.9444, 1e-3));
  });

  test('a busy photo is not plain and is never trimmed; a transparent PNG says so', () {
    final photo = img.Image(width: 64, height: 48);
    for (var y = 0; y < 48; y++) {
      for (var x = 0; x < 64; x++) {
        photo.setPixelRgb(x, y, (x * 4) % 256, (y * 5) % 256, (x + y) % 256);
      }
    }
    final a = ImageAnalysis.fromJson(analyzeBytes(Uint8List.fromList(img.encodeJpg(photo)))!.cast<String, dynamic>());
    expect(a.plainBackground, isFalse);
    expect(a.backgroundColour, isNull);
    expect(a.suggested, 'keep');
    expect(a.trim.w, 1);
    expect(a.trim.h, 1);
    expect(removeBackgroundPng(Uint8List.fromList(img.encodeJpg(photo))), isNull, reason: 'nothing to remove');

    final clear = img.Image(width: 40, height: 40, numChannels: 4);
    img.fillCircle(clear, x: 20, y: 20, radius: 10, color: clear.getColor(10, 20, 30, 255));
    final t = ImageAnalysis.fromJson(analyzeBytes(Uint8List.fromList(img.encodePng(clear)))!.cast<String, dynamic>());
    expect(t.transparent, isTrue);
    expect(t.plainBackground, isFalse);
    expect(t.trim.x, inInclusiveRange(0.2, 0.3), reason: 'the disc, not the empty margin');
    expect(t.trim.w, inInclusiveRange(0.45, 0.55));
    expect(analyzeBytes(Uint8List.fromList([1, 2, 3])), isNull);
  });

  test('removing the background: corners go transparent, the mark stays opaque, the size is kept', () {
    final out = removeBackgroundPng(maxcom())!;
    final im = img.decodePng(out)!;
    expect(im.width, 500);
    expect(im.height, 126);
    expect(im.getPixel(0, 0).a, 0);
    expect(im.getPixel(499, 125).a, 0);
    var opaque = 0;
    for (final p in im) {
      if (p.a == 255) opaque++;
    }
    expect(opaque, greaterThan(2000), reason: 'the letters remain');
    expect(opaque, lessThan(500 * 126 ~/ 2), reason: 'the white is gone');
    final small = img.decodePng(removeBackgroundPng(maxcom(), maxSide: 100)!)!;
    expect(small.width, 100);
  });

  test('pictureSize reads PNG and JPEG headers', () {
    expect(pictureSize(maxcom()), const Size(500, 126));
    final jpg = Uint8List.fromList(img.encodeJpg(img.Image(width: 123, height: 45)));
    expect(pictureSize(jpg), const Size(123, 45));
    expect(pictureSize(Uint8List.fromList([0, 1, 2])), isNull);
  });
}
