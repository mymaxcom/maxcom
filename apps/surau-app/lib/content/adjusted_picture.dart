// A picture drawn the way the box will show it, before the box has
// rendered anything: rotated, cropped to the chosen box, its plain
// background removed or put on a light plate, in the slot's shape (a
// circle for a person, 16:9 for a poster, the logo's own shape). Used by
// the thumbnails in lists and forms and by the adjust screen's previews.
// The crop is a plain clip (no pixel work); only `remove` and `card` run
// the box's background removal on the device, once per asset.

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/theme.dart';
import '../box/box_client.dart' show BoxError, SessionExpired;
import '../l10n/generated/s.dart';
import 'image_bg.dart';
import 'image_ref.dart';

/// The bytes of `/assets/<id>` through the gateway (so a 401 ends the
/// session like any other request), kept for the run. Null when there is
/// no session or the box says the id is unknown. A fetch that failed
/// because the box could not be reached is an error, not a null, so the
/// failure is not remembered as "no picture": the thumbnail offers a retry
/// (`ref.invalidate`) and does not retry by itself.
final assetBytesProvider = FutureProvider.family<Uint8List?, String>(retry: (_, _) => null, (ref, id) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  try {
    return await gateway.getBytes('/assets/$id');
  } on SessionExpired {
    return null;
  } on BoxError catch (e) {
    if (e.status == 404) return null;
    rethrow;
  }
});

/// Runs [removeBackgroundAsync]; tests override it to run on their thread.
final processImageProvider = Provider<Future<Uint8List?> Function(Uint8List bytes)>((ref) => removeBackgroundAsync);

/// The asset with its plain background made transparent (a preview-sized
/// PNG), once per asset; null while unknown, when the box is away or when
/// the background is not plain (the picture is then shown as it is).
final bgRemovedProvider = FutureProvider.family<Uint8List?, String>(retry: (_, _) => null, (ref, id) async {
  final bytes = await ref.watch(assetBytesProvider(id).future);
  if (bytes == null) return null;
  return ref.read(processImageProvider)(bytes);
});

/// The plate behind a `card` picture.
const Color plateColour = Color(0xFFF8F6F0);

/// Draws [bytes] as [ref] says, in [slot]'s shape. Give [width] or
/// [height] (the other follows the slot's aspect; a free logo follows the
/// crop's own shape, no wider than [maxWidth]).
class AdjustedPicture extends ConsumerWidget {
  const AdjustedPicture({
    super.key,
    required this.bytes,
    required this.ref,
    required this.slot,
    this.width,
    this.height,
    this.maxWidth,
    this.radius = 0,
    this.background,
  });

  final Uint8List bytes;
  final ImageRef ref;
  final ImageSlot slot;
  final double? width;
  final double? height;
  final double? maxWidth;
  final double radius;
  final Color? background;

  @override
  Widget build(BuildContext context, WidgetRef wref) {
    final r = ref;
    final turns = (r.rotate ~/ 90) % 4;
    final natural = pictureSize(bytes);
    final rotated = natural == null
        ? null
        : turns.isOdd
        ? Size(natural.height, natural.width)
        : natural;
    final crop = r.crop ?? fullBox;
    final processed = r.bg == 'remove' || r.bg == 'card' ? wref.watch(bgRemovedProvider(r.asset)).value : null;

    Widget pic = Image.memory(
      processed ?? bytes,
      fit: BoxFit.fill,
      gaplessPlayback: true,
      filterQuality: FilterQuality.medium,
      errorBuilder: (_, _, _) => const SizedBox.shrink(),
    );
    if (turns != 0) pic = RotatedBox(quarterTurns: turns, child: pic);
    if (!isFullBox(crop)) {
      // Align sized to a fraction of the picture shows exactly the crop box.
      double along(double start, double span) => span >= 1 ? 0 : 2 * start / (1 - span) - 1;
      pic = ClipRect(
        child: Align(
          alignment: Alignment(along(crop.x, crop.w), along(crop.y, crop.h)),
          widthFactor: crop.w,
          heightFactor: crop.h,
          child: pic,
        ),
      );
    }
    if (r.bg == 'card') {
      final cw = rotated == null ? 100.0 : crop.w * rotated.width;
      final ch = rotated == null ? 100.0 : crop.h * rotated.height;
      final pad = math.max(2.0, (math.min(cw, ch) * 0.1).roundToDouble());
      final side = math.min(cw, ch) + pad * 2;
      pic = Container(
        padding: EdgeInsets.all(pad),
        decoration: BoxDecoration(color: plateColour, borderRadius: BorderRadius.circular(side * 0.18)),
        child: pic,
      );
    }

    // The box the picture is shown in.
    final cropAspect = rotated == null ? 1.0 : (crop.w * rotated.width) / (crop.h * rotated.height);
    final aspect = slot.aspect ?? (r.bg == 'card' ? _cardAspect(cropAspect) : cropAspect);
    double boxW;
    double boxH;
    if (width != null && height != null) {
      boxW = width!;
      boxH = height!;
    } else if (height != null) {
      boxH = height!;
      boxW = boxH * aspect;
    } else {
      boxW = width ?? 88;
      boxH = boxW / aspect;
    }
    final cap = maxWidth;
    if (cap != null && boxW > cap) {
      boxW = cap;
      if (slot.free) boxH = height ?? boxW / aspect;
    }

    Widget out = SizedBox(
      width: boxW,
      height: boxH,
      child: FittedBox(
        fit: slot.contain || slot.free ? BoxFit.contain : BoxFit.cover,
        clipBehavior: Clip.hardEdge,
        child: pic,
      ),
    );
    final bg = background;
    if (bg != null) out = ColoredBox(color: bg, child: out);
    if (slot.circle) return ClipOval(child: out);
    if (radius > 0) return ClipRRect(borderRadius: BorderRadius.circular(radius), child: out);
    return out;
  }

  /// A plate adds 10 % of the short side on every edge.
  static double _cardAspect(double a) => a >= 1 ? (a + 0.2) / 1.2 : (1 + 0.2) / (1 / a + 0.2);
}

/// An image field's value (plain id or adjusted object) as a thumbnail in
/// [slot]'s shape, fetched through the pinned client; a calm placeholder
/// while it loads or when it cannot be fetched.
class AssetPicture extends ConsumerWidget {
  const AssetPicture({
    super.key,
    required this.value,
    required this.slot,
    this.size = 88,
    this.maxWidth,
    this.radius = SurauTheme.radiusControl,
    this.background,
  });

  final Object? value;
  final ImageSlot slot;

  /// The height (and the width of a square or fixed-shape slot follows).
  final double size;
  final double? maxWidth;
  final double radius;
  final Color? background;

  @override
  Widget build(BuildContext context, WidgetRef wref) {
    final ref = ImageRef.parse(value);
    final fetched = ref == null ? null : wref.watch(assetBytesProvider(ref.asset));
    final bytes = fetched?.value;
    final failed = fetched != null && fetched.hasError && !fetched.isLoading;
    final fill = background ?? SurauColors.paperDeep;
    if (ref == null || bytes == null) {
      Widget box = Container(
        width: slot.free ? size : size * (slot.aspect ?? 1),
        height: size,
        color: fill,
        child: Icon(
          ref == null
              ? Icons.broken_image_outlined
              : failed
              ? Icons.refresh
              : Icons.image_outlined,
          size: size * 0.4,
          color: SurauColors.outline,
        ),
      );
      if (ref != null && failed) {
        // The box could not be reached: tap to ask again.
        box = Semantics(
          button: true,
          label: S.of(context).actionRetry,
          child: GestureDetector(
            key: const ValueKey('picture-retry'),
            behavior: HitTestBehavior.opaque,
            onTap: () => wref.invalidate(assetBytesProvider(ref.asset)),
            child: box,
          ),
        );
      }
      if (slot.circle) return ClipOval(child: box);
      return ClipRRect(borderRadius: BorderRadius.circular(radius), child: box);
    }
    return AdjustedPicture(
      bytes: bytes,
      ref: ref,
      slot: slot,
      height: size,
      maxWidth: maxWidth ?? (slot.free ? size * 3 : null),
      radius: slot.circle ? 0 : radius,
      background: fill,
    );
  }
}
