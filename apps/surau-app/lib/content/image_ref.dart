// A picture field's value and the shape it is shown in, as core's
// image.ts: the plain asset id ("as uploaded") or an adjusted image
// `{asset, crop?, bg?, rotate?, square?}` that the box renders from the
// untouched original. The crop and square boxes are 0..1 of the picture
// after `rotate`. This file also holds the crop-screen geometry (where the
// picture sits under the frame and what crop box that means), kept pure
// so it is testable without a widget.

import 'dart:math' as math;
import 'dart:ui';

import '../box/wire.dart' show ImageBox;

export '../box/wire.dart' show ImageBox;

/// The shape each kind of picture is shown in (core's IMAGE_SLOTS).
/// [aspect] is width / height of the frame, null for a free frame.
enum ImageSlot {
  /// Wide logo in its natural shape for the kiosk header and app headers.
  logo(aspect: null),

  /// Square logo for app icons and the favicon.
  logoSquare(aspect: 1),
  poster(aspect: 16 / 9, contain: true),
  programKhas(aspect: 16 / 9, contain: true),
  takwim(aspect: 16 / 9, contain: true),
  penceramah(aspect: 1, circle: true),
  petugas(aspect: 1, circle: true),
  kitab(aspect: 2 / 3),

  /// A kiosk background: the whole TV screen, the crop covers the frame.
  background(aspect: 16 / 9);

  const ImageSlot({required this.aspect, this.contain = false, this.circle = false});

  final double? aspect;

  /// The whole crop is fitted inside the frame (side bars allowed) rather
  /// than covering it.
  final bool contain;
  final bool circle;

  bool get free => aspect == null;
}

/// The slot of a content kind's image field (core's CONTENT_IMAGE_FIELDS).
ImageSlot slotForField(String kind, String field) => switch ((kind, field)) {
  ('penceramah', 'photoAssetId') => ImageSlot.penceramah,
  ('kitab', 'coverAssetId') => ImageSlot.kitab,
  ('poster', 'assetId') => ImageSlot.poster,
  ('programKhas', 'assetId') => ImageSlot.programKhas,
  ('takwim', 'assetId') => ImageSlot.takwim,
  ('petugas', 'photoAssetId') => ImageSlot.petugas,
  _ => ImageSlot.poster,
};

final RegExp _assetIdRe = RegExp(r'^[0-9a-f]{64}$');

/// Core's MIN_CROP_SPAN: a crop side never under 1 % of the picture.
const double minCropSpan = 0.01;

const ImageBox fullBox = ImageBox(x: 0, y: 0, w: 1, h: 1);

bool boxEquals(ImageBox? a, ImageBox? b, {double eps = 1e-6}) {
  if (a == null || b == null) return a == b;
  return (a.x - b.x).abs() < eps && (a.y - b.y).abs() < eps && (a.w - b.w).abs() < eps && (a.h - b.h).abs() < eps;
}

/// True when [b] is the whole picture (nothing cut off).
bool isFullBox(ImageBox? b) => b == null || boxEquals(b, fullBox, eps: 1e-4);

/// Rounds to four decimals and keeps the box inside 0..1 with a side of at
/// least [minCropSpan] (core refuses anything else).
ImageBox tidyBox(ImageBox b) {
  double r(double v) => (v * 10000).round() / 10000;
  final w = r(b.w.clamp(minCropSpan, 1));
  final h = r(b.h.clamp(minCropSpan, 1));
  final x = r(b.x.clamp(0, 1 - w));
  final y = r(b.y.clamp(0, 1 - h));
  return ImageBox(x: x, y: y, w: w, h: h);
}

/// [b] (0..1 of a picture) after that picture is rotated a quarter turn
/// clockwise, as the box rotates: a point (x, y) lands at (1 - y, x).
ImageBox rotateBoxCw(ImageBox b) => ImageBox(x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w);

/// The largest square centred on [b], inside the picture of [w] x [h] px.
ImageBox centredSquare(ImageBox b, int w, int h) {
  final side = math.min(b.w * w, b.h * h);
  final cx = (b.x + b.w / 2) * w;
  final cy = (b.y + b.h / 2) * h;
  return tidyBox(ImageBox(x: (cx - side / 2) / w, y: (cy - side / 2) / h, w: side / w, h: side / h));
}

/// An image field's value: the original asset and, when adjusted, how it
/// is shown. [toJson] gives the plain id back when nothing is adjusted, so
/// an untouched picture is stored exactly as before.
class ImageRef {
  const ImageRef(this.asset, {this.crop, this.bg, this.rotate = 0, this.square});

  /// The plain id, or an object with a sha256 `asset`; anything else is
  /// null. Unknown or malformed parts are dropped (the validator says no
  /// before a save; this is for drawing).
  static ImageRef? parse(Object? v) {
    if (v is String) return _assetIdRe.hasMatch(v) ? ImageRef(v) : null;
    if (v is! Map) return null;
    final asset = v['asset'];
    if (asset is! String || !_assetIdRe.hasMatch(asset)) return null;
    final rotate = v['rotate'];
    final bg = v['bg'];
    return ImageRef(
      asset,
      crop: _box(v['crop']),
      square: _box(v['square']),
      bg: bg is String && const ['keep', 'remove', 'card'].contains(bg) ? bg : null,
      rotate: rotate is num && const [0, 90, 180, 270].contains(rotate.toInt()) ? rotate.toInt() : 0,
    );
  }

  static ImageBox? _box(Object? v) {
    if (v is! Map) return null;
    final x = v['x'];
    final y = v['y'];
    final w = v['w'];
    final h = v['h'];
    if (x is! num || y is! num || w is! num || h is! num) return null;
    final b = ImageBox(x: x.toDouble(), y: y.toDouble(), w: w.toDouble(), h: h.toDouble());
    if (b.w < minCropSpan || b.h < minCropSpan || b.x < 0 || b.y < 0 || b.x + b.w > 1 + 1e-9 || b.y + b.h > 1 + 1e-9) {
      return null;
    }
    return b;
  }

  /// The original asset id of any value shape, or null.
  static String? assetIdOf(Object? v) => parse(v)?.asset;

  final String asset;
  final ImageBox? crop;

  /// `keep`, `remove`, `card` or null (as uploaded).
  final String? bg;

  /// 0, 90, 180 or 270.
  final int rotate;

  /// Logo only: the area used for the square icon.
  final ImageBox? square;

  /// The square area that says something: the box takes the crop (or the
  /// whole picture) for the square icon when none is given, so a square
  /// equal to that is dropped.
  ImageBox? get effectiveSquare {
    final q = square;
    if (q == null || boxEquals(q, crop ?? fullBox, eps: 1e-4)) return null;
    return q;
  }

  bool get hasAdjustment =>
      !isFullBox(crop) || (bg != null && bg != 'keep') || rotate != 0 || effectiveSquare != null;

  /// The value to store: the plain id when nothing is adjusted, else the
  /// object with only the parts that matter (a full crop is dropped, as
  /// is `keep`, a rotation of 0 and a square equal to the crop).
  Object toJson() {
    if (!hasAdjustment) return asset;
    final c = crop;
    final q = effectiveSquare;
    return <String, Object?>{
      'asset': asset,
      if (c != null && !isFullBox(c)) 'crop': tidyBox(c).toJson(),
      if (bg != null && bg != 'keep') 'bg': bg,
      if (rotate != 0) 'rotate': rotate,
      if (q != null) 'square': tidyBox(q).toJson(),
    };
  }

  ImageRef copyWith({
    Object? crop = _keep,
    Object? bg = _keep,
    int? rotate,
    Object? square = _keep,
  }) => ImageRef(
    asset,
    crop: identical(crop, _keep) ? this.crop : crop as ImageBox?,
    bg: identical(bg, _keep) ? this.bg : bg as String?,
    rotate: rotate ?? this.rotate,
    square: identical(square, _keep) ? this.square : square as ImageBox?,
  );

  static const Object _keep = Object();

  @override
  bool operator ==(Object other) =>
      other is ImageRef &&
      other.asset == asset &&
      boxEquals(other.crop, crop) &&
      other.bg == bg &&
      other.rotate == rotate &&
      boxEquals(other.square, square);

  @override
  int get hashCode => Object.hash(asset, bg, rotate);

  @override
  String toString() => 'ImageRef(${toJson()})';
}

/// The crop screen's state: the picture (after rotation, [image] px) drawn
/// at [scale] with its top-left at [offset] in the editor's coordinates,
/// under a fixed [frame]. The crop box is the frame read in picture
/// coordinates. [contain] lets the picture sit inside the frame (centred,
/// with empty bars) instead of always covering it.
class CropGeometry {
  const CropGeometry({
    required this.image,
    required this.frame,
    required this.scale,
    required this.offset,
    this.contain = false,
  });

  /// The picture fitted to [frame] from [crop]: for a covering frame the
  /// crop fills it (from the crop's centre when its shape differs); for a
  /// containing frame the crop sits inside it, centred.
  factory CropGeometry.fit({
    required Size image,
    required Rect frame,
    ImageBox? crop,
    bool contain = false,
  }) {
    final c = crop ?? fullBox;
    final cw = c.w * image.width;
    final ch = c.h * image.height;
    final sx = frame.width / cw;
    final sy = frame.height / ch;
    final scale = contain ? math.min(sx, sy) : math.max(sx, sy);
    final centre = Offset((c.x + c.w / 2) * image.width, (c.y + c.h / 2) * image.height);
    final offset = frame.center - centre * scale;
    return CropGeometry(image: image, frame: frame, scale: scale, offset: offset, contain: contain).clamped();
  }

  final Size image;
  final Rect frame;
  final double scale;
  final Offset offset;
  final bool contain;

  /// Where the picture is drawn.
  Rect get shown => offset & (image * scale);

  /// The scale at which the picture just covers the frame.
  double get coverScale => math.max(frame.width / image.width, frame.height / image.height);

  /// The scale at which the whole picture just fits inside the frame.
  double get containScale => math.min(frame.width / image.width, frame.height / image.height);

  double get minScale => contain ? containScale : coverScale;

  double get maxScale => math.max(minScale, coverScale * 6);

  /// The frame in picture coordinates, inside 0..1 (a containing frame
  /// wider than the picture reads as the whole width, and so on).
  ImageBox get crop {
    final s = shown;
    final x0 = ((frame.left - s.left) / s.width).clamp(0.0, 1.0);
    final y0 = ((frame.top - s.top) / s.height).clamp(0.0, 1.0);
    final x1 = ((frame.right - s.left) / s.width).clamp(0.0, 1.0);
    final y1 = ((frame.bottom - s.top) / s.height).clamp(0.0, 1.0);
    return tidyBox(ImageBox(x: x0, y: y0, w: x1 - x0, h: y1 - y0));
  }

  CropGeometry copyWith({Rect? frame, double? scale, Offset? offset}) => CropGeometry(
    image: image,
    frame: frame ?? this.frame,
    scale: scale ?? this.scale,
    offset: offset ?? this.offset,
    contain: contain,
  );

  /// Scale inside the limits; on each axis the picture covers the frame
  /// when it is bigger than the frame, and is centred when it is smaller
  /// (which only a containing frame allows).
  CropGeometry clamped() {
    final s = scale.clamp(minScale, maxScale);
    final w = image.width * s;
    final h = image.height * s;
    double axis(double o, double size, double fLeft, double fRight) {
      // The picture covers the frame when its far edge can reach the
      // frame's far edge while its near edge is at or before the frame's.
      final lo = fRight - size;
      final hi = fLeft;
      if (lo <= hi + 1e-6) return o.clamp(math.min(lo, hi), hi);
      return fLeft + ((fRight - fLeft) - size) / 2;
    }
    final dx = axis(offset.dx, w, frame.left, frame.right);
    final dy = axis(offset.dy, h, frame.top, frame.bottom);
    return copyWith(scale: s, offset: Offset(dx, dy));
  }

  /// Moves the picture by [delta].
  CropGeometry pan(Offset delta) => copyWith(offset: offset + delta).clamped();

  /// Scales by [factor] keeping the picture point under [focal] still.
  CropGeometry zoomAt(double factor, Offset focal) {
    final s = (scale * factor).clamp(minScale, maxScale);
    final q = (focal - offset) / scale;
    return copyWith(scale: s, offset: focal - q * s).clamped();
  }

  /// A new frame (free shape): kept inside the editor area [bounds] and
  /// over the picture, at least [minSide] px a side; the picture then
  /// covers it.
  CropGeometry withFrame(Rect next, {required Rect bounds, double minSide = 24}) {
    final limit = bounds.intersect(shown);
    var l = next.left.clamp(limit.left, limit.right - minSide);
    var t = next.top.clamp(limit.top, limit.bottom - minSide);
    final r = next.right.clamp(l + minSide, limit.right);
    final b = next.bottom.clamp(t + minSide, limit.bottom);
    if (r - l < minSide) l = r - minSide;
    if (b - t < minSide) t = b - minSide;
    return copyWith(frame: Rect.fromLTRB(l, t, r, b)).clamped();
  }
}

/// The largest frame of [aspect] centred in [area].
Rect frameFor(Rect area, double aspect) {
  final double w;
  final double h;
  if (area.width / area.height > aspect) {
    h = area.height;
    w = h * aspect;
  } else {
    w = area.width;
    h = w / aspect;
  }
  return Rect.fromCenter(center: area.center, width: w, height: h);
}

/// The free-frame start: the whole picture fitted inside [area] and the
/// frame over [crop] (the whole picture when null).
CropGeometry freeGeometry({required Size image, required Rect area, ImageBox? crop}) {
  final scale = math.min(area.width / image.width, area.height / image.height);
  final shownSize = image * scale;
  final offset = area.center - Offset(shownSize.width / 2, shownSize.height / 2);
  final c = crop ?? fullBox;
  final frame = Rect.fromLTWH(
    offset.dx + c.x * shownSize.width,
    offset.dy + c.y * shownSize.height,
    c.w * shownSize.width,
    c.h * shownSize.height,
  );
  return CropGeometry(image: image, frame: frame, scale: scale, offset: offset);
}
