// The picture that goes with the live notice: a 1200 x 630 JPEG made on the
// device. With the box's still frame of the live it is that frame under the
// words; without one it is TODAY'S KULIAH CARD (the penceramah's photo, the
// slot, the penceramah's name, the title, the time, the surau's name and
// logo, as the TV card shows them), or, when the live has no kuliah, a plain
// card with the surau's name and logo and "Siaran langsung". Never a YouTube
// thumbnail or any other picture. Nothing but what the notice text already
// says: no phone number, no address (see [liveCardFields]). The JPEG is
// encoded from pixels, so it carries no metadata.

import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show compute;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image/image.dart' as img;

const int liveCardWidth = 1200;
const int liveCardHeight = 630;

/// What the card draws, by role (not by position). A field that is empty or
/// looks like an address, a link or a phone number is null.
class LiveCardFields {
  const LiveCardFields({this.badge, this.surau, this.title, this.speaker, this.slot, this.time});

  final String? badge;
  final String? surau;
  final String? title;
  final String? speaker;

  /// The kuliah's slot name ("Kuliah Maghrib").
  final String? slot;

  /// `HH:MM`.
  final String? time;

  bool get isEmpty =>
      badge == null && surau == null && title == null && speaker == null && slot == null && time == null;

  /// The live has a kuliah to show (otherwise the plain card is made).
  bool get hasKuliah => title != null || speaker != null || slot != null || time != null;

  @override
  bool operator ==(Object other) =>
      other is LiveCardFields &&
      other.badge == badge &&
      other.surau == surau &&
      other.title == title &&
      other.speaker == speaker &&
      other.slot == slot &&
      other.time == time;

  @override
  int get hashCode => Object.hash(badge, surau, title, speaker, slot, time);

  @override
  String toString() => 'LiveCardFields($badge, $surau, $title, $speaker, $slot, $time)';
}

/// The fields with each one cleaned; one that is empty or looks like an
/// address, a link or a phone number is left out (null).
LiveCardFields liveCardFields({
  String? badge,
  String? surau,
  String? title,
  String? speaker,
  String? slot,
  String? time,
}) {
  String? ok(String? v) {
    if (v == null) return null;
    final t = v.replaceAll(RegExp(r'[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]'), ' ').trim().replaceAll(RegExp(r'\s+'), ' ');
    if (t.isEmpty || t.contains('://') || t.contains('www.') || RegExp(r'\d{7,}').hasMatch(t.replaceAll(RegExp(r'[\s()+-]'), ''))) {
      return null;
    }
    return t.runes.length > 90 ? '${String.fromCharCodes(t.runes.take(90)).trimRight()}...' : t;
  }

  final tm = time == null ? null : (RegExp(r'^\d{2}:\d{2}$').hasMatch(time.trim()) ? time.trim() : null);
  return LiveCardFields(
    badge: ok(badge),
    surau: ok(surau),
    title: ok(title),
    speaker: ok(speaker),
    slot: ok(slot),
    time: tm,
  );
}

/// Makes the card. [background] is the box's JPEG still of the live, or null
/// for the kuliah card. [photo] is the penceramah's picture and [logo] the
/// surau's, either may be null. [rtl] draws right to left (Arabic).
typedef LiveCardBuilder = Future<Uint8List> Function({
  required LiveCardFields fields,
  Uint8List? background,
  Uint8List? photo,
  Uint8List? logo,
  bool rtl,
});

final liveNoticeCardProvider = Provider<LiveCardBuilder>((ref) => renderLiveCard);

const Color _teal = Color(0xFF06302B);
const Color _gold = Color(0xFFF0C97A);
const Color _cream = Color(0xFFE9DFC8);
const Color _plate = Color(0xFFF6F1E4);
const List<String> _fallbackFonts = ['NotoNaskhArabic'];

Future<ui.Image?> _decode(Uint8List? bytes) async {
  if (bytes == null || bytes.isEmpty) return null;
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    return (await codec.getNextFrame()).image;
  } on Object {
    return null;
  }
}

/// [image] scaled to cover [dst], centred.
void _drawCover(Canvas canvas, ui.Image image, Rect dst) {
  final sw = image.width.toDouble();
  final sh = image.height.toDouble();
  final scale = (dst.width / sw) > (dst.height / sh) ? dst.width / sw : dst.height / sh;
  final dw = sw * scale;
  final dh = sh * scale;
  canvas.save();
  canvas.clipRect(dst);
  canvas.drawImageRect(
    image,
    Rect.fromLTWH(0, 0, sw, sh),
    Rect.fromLTWH(dst.left + (dst.width - dw) / 2, dst.top + (dst.height - dh) / 2, dw, dh),
    Paint()..filterQuality = FilterQuality.medium,
  );
  canvas.restore();
}

Future<Uint8List> renderLiveCard({
  required LiveCardFields fields,
  Uint8List? background,
  Uint8List? photo,
  Uint8List? logo,
  bool rtl = false,
}) async {
  final w = liveCardWidth.toDouble();
  final h = liveCardHeight.toDouble();
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, w, h));
  canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = _teal);
  final still = await _decode(background);
  final photoImg = await _decode(photo);
  final logoImg = await _decode(logo);
  final dir = rtl ? TextDirection.rtl : TextDirection.ltr;

  TextPainter paint(String t, double size, FontWeight weight, Color color, double maxWidth, {int maxLines = 2}) =>
      TextPainter(
        text: TextSpan(
          text: t,
          style: TextStyle(
            fontFamily: 'PlusJakartaSans',
            fontFamilyFallback: _fallbackFonts,
            fontSize: size,
            fontWeight: weight,
            color: color,
            height: 1.15,
          ),
        ),
        textDirection: dir,
        maxLines: maxLines,
        ellipsis: '...',
      )..layout(maxWidth: maxWidth);

  const pad = 56.0;
  final inner = w - pad * 2;
  // x of a box of [width] that starts at the reading side after [offset].
  double xAt(double offset, double width) => rtl ? w - pad - offset - width : pad + offset;

  void badgePill(String text, double top, {double? centreX}) {
    final p = paint(text, 32, FontWeight.w800, Colors.white, inner - 48, maxLines: 1);
    final bw = p.width + 48;
    final bh = p.height + 24;
    final left = centreX != null ? centreX - bw / 2 : xAt(0, bw);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(left, top, bw, bh), const Radius.circular(10)),
      Paint()..color = const Color(0xFFD32F2F),
    );
    p.paint(canvas, Offset(left + 24, top + 12));
  }

  /// The logo on its light plate, [height] high, at the end side of the top row (or at [left]/[top]).
  Size logoPlate({required double height, double? left, required double top, double maxWidth = 260}) {
    final lw = logoImg!.width.toDouble();
    final lh = logoImg.height.toDouble();
    var ih = height;
    var iw = lw * ih / lh;
    if (iw > maxWidth) {
      iw = maxWidth;
      ih = lh * iw / lw;
    }
    const inset = 10.0;
    final pw = iw + inset * 2;
    final ph = ih + inset * 2;
    final x = left ?? (rtl ? pad : w - pad - pw);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(x, top, pw, ph), const Radius.circular(14)),
      Paint()..color = _plate,
    );
    canvas.drawImageRect(
      logoImg,
      Rect.fromLTWH(0, 0, lw, lh),
      Rect.fromLTWH(x + inset, top + inset, iw, ih),
      Paint()..filterQuality = FilterQuality.medium,
    );
    return Size(pw, ph);
  }

  final kuliahLine = [fields.slot, fields.time].whereType<String>().join('  ');

  if (still != null) {
    // The box's frame of the live: cover the card, a dark fade, the words from the bottom up.
    _drawCover(canvas, still, Rect.fromLTWH(0, 0, w, h));
    canvas.drawRect(
      Rect.fromLTWH(0, 0, w, h),
      Paint()
        ..shader = ui.Gradient.linear(Offset(0, h * 0.2), Offset(0, h), [const Color(0x00000000), const Color(0xE6000000)]),
    );
    double y = h - pad;
    for (final (t, size, weight, color) in [
      (fields.speaker, 34.0, FontWeight.w500, _cream),
      (fields.title, 52.0, FontWeight.w800, Colors.white),
      (kuliahLine.isEmpty ? null : kuliahLine, 36.0, FontWeight.w700, _gold),
      (fields.surau, 32.0, FontWeight.w600, _cream),
    ]) {
      if (t == null) continue;
      final p = paint(t, size, weight, color, inner);
      y -= p.height;
      p.paint(canvas, Offset(rtl ? w - pad - p.width : pad, y));
      y -= 12;
    }
    if (fields.badge != null) badgePill(fields.badge!, pad);
    if (logoImg != null) logoPlate(height: 64, top: pad);
  } else if (fields.hasKuliah) {
    // Today's kuliah card, as the TV card: photo, slot, name, title, time; the surau's name and logo.
    if (fields.badge != null) badgePill(fields.badge!, pad);
    if (logoImg != null) logoPlate(height: 64, top: pad);
    const top = 170.0;
    final bottom = h - pad - (fields.surau != null ? 60 : 0);
    final cy = (top + bottom) / 2;
    var textOffset = 0.0;
    if (photoImg != null) {
      const d = 280.0;
      final left = xAt(0, d);
      final rect = Rect.fromLTWH(left, cy - d / 2, d, d);
      canvas.save();
      canvas.clipPath(Path()..addOval(rect));
      _drawCover(canvas, photoImg, rect);
      canvas.restore();
      canvas.drawCircle(rect.center, d / 2, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 6
        ..color = _gold);
      textOffset = d + 48;
    }
    final colW = inner - textOffset;
    final painters = <TextPainter>[
      if (fields.slot != null) paint(fields.slot!, 40, FontWeight.w700, _gold, colW),
      if (fields.speaker != null) paint(fields.speaker!, 58, FontWeight.w800, Colors.white, colW),
      if (fields.title != null) paint(fields.title!, 40, FontWeight.w500, _cream, colW),
      if (fields.time != null) paint(fields.time!, 46, FontWeight.w700, Colors.white, colW, maxLines: 1),
    ];
    const gap = 14.0;
    final total = painters.fold<double>(0, (a, p) => a + p.height) + gap * (painters.length - 1);
    var y = cy - total / 2;
    for (final p in painters) {
      p.paint(canvas, Offset(xAt(textOffset, p.width), y));
      y += p.height + gap;
    }
    if (fields.surau != null) {
      final p = paint(fields.surau!, 36, FontWeight.w700, _gold, inner, maxLines: 1);
      p.paint(canvas, Offset(rtl ? w - pad - p.width : pad, h - pad - p.height));
    }
  } else {
    // No kuliah for this live: the surau's name and logo and "Siaran langsung".
    final name = fields.surau == null ? null : paint(fields.surau!, 76, FontWeight.w800, Colors.white, inner);
    final badge = fields.badge;
    final badgeP = badge == null ? null : paint(badge, 32, FontWeight.w800, Colors.white, inner - 48, maxLines: 1);
    final logoH = logoImg == null ? 0.0 : 140.0;
    final parts = <double>[
      if (logoImg != null) logoH + 20,
      if (name != null) name.height,
      if (badgeP != null) badgeP.height + 24,
    ];
    final total = parts.fold<double>(0, (a, b) => a + b) + 32.0 * (parts.length > 1 ? parts.length - 1 : 0);
    var y = (h - total) / 2;
    if (logoImg != null) {
      final lw = logoImg.width.toDouble();
      final lh = logoImg.height.toDouble();
      var iw = lw * logoH / lh;
      if (iw > 420) iw = 420;
      logoPlate(height: logoH, left: (w - (iw + 20)) / 2, top: y, maxWidth: 420);
      y += logoH + 20 + 32;
    }
    if (name != null) {
      name.paint(canvas, Offset((w - name.width) / 2, y));
      y += name.height + 32;
    }
    if (badge != null) badgePill(badge, y, centreX: w / 2);
  }
  final pic = recorder.endRecording();
  final image = await pic.toImage(liveCardWidth, liveCardHeight);
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  image.dispose();
  still?.dispose();
  photoImg?.dispose();
  logoImg?.dispose();
  if (data == null) throw StateError('card');
  // The pixels are drawn on the UI isolate (dart:ui); the JPEG encode, the
  // slow part, runs on another one.
  return compute(_encodeCard, data.buffer.asUint8List());
}

Uint8List _encodeCard(Uint8List rgba) {
  final raw = img.Image.fromBytes(
    width: liveCardWidth,
    height: liveCardHeight,
    bytes: rgba.buffer,
    numChannels: 4,
  );
  return Uint8List.fromList(img.encodeJpg(raw, quality: 82));
}
