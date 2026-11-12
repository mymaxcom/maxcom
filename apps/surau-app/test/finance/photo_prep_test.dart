import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/finance/ledger.dart';
import 'package:surau_app/finance/photo_prep.dart';

Uint8List jpegOf(int w, int h, {bool noise = false, int? orientation}) {
  final im = img.Image(width: w, height: h);
  final r = Random(7);
  for (final p in im) {
    if (noise) {
      p
        ..r = r.nextInt(256)
        ..g = r.nextInt(256)
        ..b = r.nextInt(256);
    } else {
      p
        ..r = p.x * 255 ~/ w
        ..g = p.y * 255 ~/ h
        ..b = 90;
    }
  }
  if (orientation != null) im.exif.imageIfd.orientation = orientation;
  return Uint8List.fromList(img.encodeJpg(im, quality: 95));
}

void main() {
  test('a 4000 px photo comes out as a JPEG of at most 1280 px under 2 MB', () {
    final out = prepareFinancePhoto(jpegOf(4000, 3000));
    expect(out.length, lessThanOrEqualTo(maxPhotoBytes));
    expect(out[0], 0xFF);
    expect(out[1], 0xD8);
    final back = img.decodeJpg(out)!;
    expect(back.width, 1280);
    expect(back.height, 960);
  });

  test('a tall photo is limited on its longest side', () {
    final back = img.decodeJpg(prepareFinancePhoto(jpegOf(1500, 3000)))!;
    expect(back.height, 1280);
    expect(back.width, 640);
  });

  test('a small photo is not enlarged', () {
    final back = img.decodeJpg(prepareFinancePhoto(jpegOf(400, 300)))!;
    expect([back.width, back.height], [400, 300]);
  });

  test(
    'the EXIF orientation is applied (a sideways phone photo stands up)',
    () {
      // Orientation 6: the camera was turned; the stored 300x200 shows as 200x300.
      final back = img.decodeJpg(
        prepareFinancePhoto(jpegOf(300, 200, orientation: 6)),
      )!;
      expect([back.width, back.height], [200, 300]);
    },
  );

  test('a PNG is accepted and comes out as a JPEG', () {
    final png = Uint8List.fromList(
      img.encodePng(img.Image(width: 50, height: 40)),
    );
    final out = prepareFinancePhoto(png);
    expect([out[0], out[1], out[2]], [0xFF, 0xD8, 0xFF]);
  });

  test(
    'bytes that are not an image are refused with a message for the person',
    () {
      expect(
        () => prepareFinancePhoto(Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8])),
        throwsA(
          isA<FinancePhotoError>().having(
            (e) => e.message,
            'message',
            FinancePhotoError.notAnImage,
          ),
        ),
      );
    },
  );

  test('a photo that is still over 2 MB after shrinking is refused', () {
    // Pure noise at the size cap does not compress below 2 MB at quality 80.
    expect(
      () => prepareFinancePhoto(jpegOf(1280, 1280, noise: true)),
      throwsA(
        isA<FinancePhotoError>().having(
          (e) => e.message,
          'message',
          FinancePhotoError.tooBig,
        ),
      ),
    );
  });

  test('the user texts carry no dash or arrow', () {
    for (final t in [FinancePhotoError.notAnImage, FinancePhotoError.tooBig]) {
      expect(t, isNot(matches(RegExp('[–—→≈]'))));
    }
  });
}
