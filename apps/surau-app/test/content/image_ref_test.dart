// ImageRef: the plain id or the adjusted object, stored plain again when
// nothing is adjusted; the slot of every image field; the crop geometry
// (frame to crop box, cover and contain limits, zoom about a point, the
// free frame) as pure maths.

import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/image_ref.dart';

const id = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';

void main() {
  group('ImageRef', () {
    test('a plain id parses and is stored plain; an untouched object is stored plain too', () {
      final plain = ImageRef.parse(id)!;
      expect(plain.asset, id);
      expect(plain.hasAdjustment, isFalse);
      expect(plain.toJson(), id);
      expect(ImageRef.parse({'asset': id})!.toJson(), id);
      expect(ImageRef.parse({'asset': id, 'crop': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'bg': 'keep', 'rotate': 0})!.toJson(), id);
      expect(ImageRef.assetIdOf({'asset': id, 'bg': 'remove'}), id);
    });

    test('an adjusted object keeps only the parts that matter, rounded to four decimals', () {
      final ref = ImageRef.parse({
        'asset': id,
        'crop': {'x': 0.038, 'y': 0.0555555, 'w': 0.93, 'h': 0.9444444},
        'bg': 'remove',
        'rotate': 90,
        'square': {'x': 0.2, 'y': 0, 'w': 0.5, 'h': 0.5},
      })!;
      expect(ref.hasAdjustment, isTrue);
      expect(ref.rotate, 90);
      expect(ref.toJson(), {
        'asset': id,
        'crop': {'x': 0.038, 'y': 0.0556, 'w': 0.93, 'h': 0.9444},
        'bg': 'remove',
        'rotate': 90,
        'square': {'x': 0.2, 'y': 0, 'w': 0.5, 'h': 0.5},
      });
      expect(ref.copyWith(bg: null, rotate: 0, crop: null, square: null).toJson(), id);
    });

    test('junk is dropped or refused', () {
      expect(ImageRef.parse('abc'), isNull);
      expect(ImageRef.parse(42), isNull);
      expect(ImageRef.parse({'asset': 'nope'}), isNull);
      final odd = ImageRef.parse({'asset': id, 'crop': {'x': 0.5, 'y': 0, 'w': 0.9, 'h': 1}, 'bg': 'blur', 'rotate': 45})!;
      expect(odd.crop, isNull, reason: 'outside the picture');
      expect(odd.bg, isNull);
      expect(odd.rotate, 0);
      expect(odd.toJson(), id);
    });

    test('every image field has its slot', () {
      expect(slotForField('penceramah', 'photoAssetId'), ImageSlot.penceramah);
      expect(slotForField('petugas', 'photoAssetId'), ImageSlot.petugas);
      expect(slotForField('kitab', 'coverAssetId'), ImageSlot.kitab);
      expect(slotForField('poster', 'assetId'), ImageSlot.poster);
      expect(slotForField('programKhas', 'assetId'), ImageSlot.programKhas);
      expect(slotForField('takwim', 'assetId'), ImageSlot.takwim);
      expect(ImageSlot.logo.free, isTrue);
      expect(ImageSlot.penceramah.circle, isTrue);
      expect(ImageSlot.poster.contain, isTrue);
      expect(ImageSlot.kitab.aspect, closeTo(2 / 3, 1e-9));
    });

    test('a box rotated a quarter turn, and the square centred on a crop', () {
      // A 500 x 126 picture: the top-left quarter lands top-right.
      final r = rotateBoxCw(const ImageBox(x: 0, y: 0, w: 0.5, h: 0.5));
      expect(r.x, closeTo(0.5, 1e-9));
      expect(r.y, 0);
      expect(r.w, 0.5);
      expect(r.h, 0.5);
      final q = centredSquare(const ImageBox(x: 0.038, y: 0.0556, w: 0.93, h: 0.9444), 500, 126);
      expect(q.w * 500, closeTo(q.h * 126, 0.1), reason: 'square in pixels');
      expect(q.h, closeTo(0.9444, 1e-3));
      expect(q.x + q.w / 2, closeTo(0.038 + 0.93 / 2, 1e-3), reason: 'centred on the crop');
    });
  });

  group('CropGeometry', () {
    const image = Size(500, 126);

    test('a covering frame: the picture fills it and the crop is the frame read back', () {
      final frame = frameFor(const Rect.fromLTWH(0, 0, 300, 300), 1);
      final g = CropGeometry.fit(image: image, frame: frame);
      expect(g.scale, closeTo(300 / 126, 1e-9), reason: 'cover: the height fills');
      expect(g.shown.height, closeTo(300, 1e-6));
      final c = g.crop;
      expect(c.h, 1);
      expect(c.w, closeTo(126 / 500, 1e-3));
      expect(c.x, closeTo((1 - 126 / 500) / 2, 1e-3), reason: 'centred');
      // Panning cannot leave the frame uncovered.
      final far = g.pan(const Offset(1000, 1000));
      expect(far.offset.dx, closeTo(0, 1e-6));
      expect(far.offset.dy, closeTo(0, 1e-6));
      expect(far.crop.x, 0);
      // Zooming out stops at cover.
      expect(g.zoomAt(0.1, frame.center).scale, closeTo(g.coverScale, 1e-9));
    });

    test('a containing frame lets the whole picture sit inside with bars: the crop is then full', () {
      final frame = frameFor(const Rect.fromLTWH(0, 0, 320, 180), 16 / 9);
      final g = CropGeometry.fit(image: image, frame: frame, contain: true);
      expect(g.scale, closeTo(320 / 500, 1e-9));
      expect(g.shown.width, closeTo(320, 1e-6));
      expect(g.shown.center.dy, closeTo(90, 1e-6), reason: 'centred on the short axis');
      expect(g.crop.toJson(), fullBox.toJson());
      // Zoomed in, the frame reads a part of the picture.
      final z = g.zoomAt(2, frame.center);
      expect(z.crop.w, closeTo(0.5, 1e-3));
      expect(z.crop.x, closeTo(0.25, 1e-3));
    });

    test('zoom about a point keeps that picture point still', () {
      final frame = frameFor(const Rect.fromLTWH(0, 0, 300, 300), 1);
      final g = CropGeometry.fit(image: image, frame: frame).zoomAt(2, frame.center);
      final focal = Offset(frame.left + 40, frame.top + 50);
      final before = (focal - g.offset) / g.scale;
      final z = g.zoomAt(1.5, focal);
      final after = (focal - z.offset) / z.scale;
      expect(after.dx, closeTo(before.dx, 1e-6));
      expect(after.dy, closeTo(before.dy, 1e-6));
      expect(z.scale, closeTo(g.scale * 1.5, 1e-9));
    });

    test('an existing crop is fitted back exactly', () {
      final frame = frameFor(const Rect.fromLTWH(0, 0, 300, 300), 1);
      const crop = ImageBox(x: 0.4, y: 0, w: 0.252, h: 1);
      final g = CropGeometry.fit(image: image, frame: frame, crop: crop);
      expect(g.crop.x, closeTo(0.4, 1e-3));
      expect(g.crop.w, closeTo(0.252, 1e-3));
    });

    test('the free frame starts on the trim box and stays over the picture', () {
      const area = Rect.fromLTWH(20, 20, 400, 300);
      const trim = ImageBox(x: 0.038, y: 0.0556, w: 0.93, h: 0.9444);
      final g = freeGeometry(image: image, area: area, crop: trim);
      expect(g.shown.width, closeTo(400, 1e-6), reason: 'the whole picture fits the area');
      expect(g.crop.x, closeTo(trim.x, 1e-3));
      expect(g.crop.w, closeTo(trim.w, 1e-3));
      expect(g.crop.h, closeTo(trim.h, 1e-3));
      // Dragging an edge past the picture stops at its edge.
      final wide = g.withFrame(Rect.fromLTRB(-100, g.frame.top, g.frame.right, g.frame.bottom), bounds: area);
      expect(wide.frame.left, closeTo(g.shown.left, 1e-6));
      expect(wide.crop.x, 0);
      // The frame never collapses.
      final tiny = g.withFrame(Rect.fromLTRB(g.frame.left, g.frame.top, g.frame.left + 2, g.frame.top + 2), bounds: area);
      expect(tiny.frame.width, greaterThanOrEqualTo(24));
      expect(tiny.frame.height, greaterThanOrEqualTo(24));
    });

    test('tidyBox keeps a crop inside the picture with a floor on its size', () {
      final b = tidyBox(const ImageBox(x: 0.99, y: -0.2, w: 0.5, h: 0.001));
      expect(b.x + b.w, lessThanOrEqualTo(1));
      expect(b.y, 0);
      expect(b.h, minCropSpan);
    });
  });
}
