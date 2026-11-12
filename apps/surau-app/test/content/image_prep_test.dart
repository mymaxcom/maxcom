// Images are made small and upright before they leave the device: a 12 MP
// photo with EXIF orientation 6 comes out 1440 x 1920, JPEG, under 1 MB;
// a PNG with transparency stays PNG; a picture that is already small is
// not enlarged; rubbish is refused with a BM message.

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/box/wire.dart' show ImageBox;
import 'package:surau_app/content/image_prep.dart';

Uint8List _photo(int w, int h, {int? orientation}) {
  final im = img.Image(width: w, height: h);
  // A gradient with a bright corner so the orientation is visible.
  for (var y = 0; y < h; y += 1) {
    for (var x = 0; x < w; x += 1) {
      im.setPixelRgb(x, y, (x * 255) ~/ w, (y * 255) ~/ h, 90);
    }
  }
  if (orientation != null) {
    im.exif.imageIfd.orientation = orientation;
  }
  return Uint8List.fromList(img.encodeJpg(im, quality: 90));
}

void main() {
  test('a 4000x3000 JPEG with EXIF orientation 6 becomes 1440x1920 JPEG under 1 MB', () async {
    final input = _photo(4000, 3000, orientation: 6);
    final out = await prepareImage(input);
    expect(out.mime, 'image/jpeg');
    expect(out.width, 1440);
    expect(out.height, 1920);
    expect(out.bytes.length, lessThan(1024 * 1024));
    final back = img.decodeJpg(out.bytes)!;
    expect(back.width, 1440);
    expect(back.height, 1920);
    expect(back.exif.imageIfd.orientation ?? 1, 1, reason: 'orientation baked');
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('a 2x2 PNG with alpha stays PNG', () async {
    final im = img.Image(width: 2, height: 2, numChannels: 4);
    im.setPixelRgba(0, 0, 255, 0, 0, 0);
    im.setPixelRgba(1, 1, 0, 0, 255, 255);
    final out = await prepareImage(Uint8List.fromList(img.encodePng(im)));
    expect(out.mime, 'image/png');
    expect(out.width, 2);
    expect(out.height, 2);
    final back = img.decodePng(out.bytes)!;
    expect(back.getPixel(0, 0).a, 0);
    expect(back.getPixel(1, 1).a, 255);
  });

  test('an opaque PNG becomes JPEG; a small photo is not enlarged', () async {
    final im = img.Image(width: 300, height: 200);
    final png = await prepareImage(Uint8List.fromList(img.encodePng(im)));
    expect(png.mime, 'image/jpeg');
    expect(png.width, 300);
    expect(png.height, 200);
    final small = await prepareImage(_photo(640, 480));
    expect(small.width, 640);
    expect(small.height, 480);
  });

  test('a landscape 3000x4000 with orientation 8 is 1920 wide', () async {
    final out = await prepareImage(_photo(3000, 4000, orientation: 8));
    expect(out.width, 1920);
    expect(out.height, 1440);
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('not an image: refused in BM', () async {
    await expectLater(
      prepareImage(Uint8List.fromList([1, 2, 3, 4, 5])),
      throwsA(
        isA<ImagePrepError>().having(
          (e) => e.message,
          'message',
          'Fail ini bukan gambar yang boleh dibaca. Pilih fail JPEG, PNG atau WebP.',
        ),
      ),
    );
  });

  group('bakeAdjustmentSync (a background cropped on the device)', () {
    // Left half red, right half blue, 200 x 100.
    Uint8List halves() {
      final im = img.Image(width: 200, height: 100);
      for (var y = 0; y < 100; y++) {
        for (var x = 0; x < 200; x++) {
          im.setPixelRgb(x, y, x < 100 ? 230 : 20, 20, x < 100 ? 20 : 230);
        }
      }
      return Uint8List.fromList(img.encodePng(im));
    }

    test('a crop keeps only that box', () {
      final out = bakeAdjustmentSync(
        halves(),
        crop: const ImageBox(x: 0.5, y: 0, w: 0.5, h: 1),
      );
      expect(out.mime, 'image/jpeg');
      expect((out.width, out.height), (100, 100));
      final back = img.decodeJpg(out.bytes)!;
      final p = back.getPixel(50, 50);
      expect(p.b, greaterThan(180), reason: 'the blue half');
      expect(p.r, lessThan(80));
    });

    test('a quarter turn clockwise puts the left half on top', () {
      final out = bakeAdjustmentSync(halves(), rotate: 90);
      expect((out.width, out.height), (100, 200));
      final back = img.decodeJpg(out.bytes)!;
      expect(back.getPixel(50, 20).r, greaterThan(180), reason: 'red on top');
      expect(back.getPixel(50, 180).b, greaterThan(180), reason: 'blue below');
    });

    test('the crop is read after the turn', () {
      final out = bakeAdjustmentSync(
        halves(),
        rotate: 90,
        crop: const ImageBox(x: 0, y: 0, w: 1, h: 0.5),
      );
      expect((out.width, out.height), (100, 100));
      expect(img.decodeJpg(out.bytes)!.getPixel(50, 50).r, greaterThan(180));
    });

    test('rubbish is refused with the BM message', () {
      expect(
        () => bakeAdjustmentSync(Uint8List.fromList([1, 2, 3])),
        throwsA(isA<ImagePrepError>()),
      );
    });
  });
}
