// The picture that goes with the live notice: a 1200 x 630 JPEG made on the
// device. A still frame of the live (or its YouTube thumbnail, else a plain
// branded background), the surau's name, the kuliah's title and speaker and a
// red "SIARAN LANGSUNG" badge. Nothing but what the notice text already says:
// no phone number, no address (see [liveCardLines]). The JPEG is encoded from
// pixels, so it carries no metadata.

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
  const LiveCardFields({this.badge, this.surau, this.title, this.speaker});

  final String? badge;
  final String? surau;
  final String? title;
  final String? speaker;

  bool get isEmpty => badge == null && surau == null && title == null && speaker == null;

  @override
  bool operator ==(Object other) =>
      other is LiveCardFields &&
      other.badge == badge &&
      other.surau == surau &&
      other.title == title &&
      other.speaker == speaker;

  @override
  int get hashCode => Object.hash(badge, surau, title, speaker);

  @override
  String toString() => 'LiveCardFields($badge, $surau, $title, $speaker)';
}

/// The fields with each one cleaned; one that is empty or looks like an
/// address, a link or a phone number is left out (null).
LiveCardFields liveCardFields({String? badge, String? surau, String? title, String? speaker}) {
  String? ok(String? v) {
    if (v == null) return null;
    final t = v.replaceAll(RegExp(r'[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]'), ' ').trim().replaceAll(RegExp(r'\s+'), ' ');
    if (t.isEmpty || t.contains('://') || t.contains('www.') || RegExp(r'\d{7,}').hasMatch(t.replaceAll(RegExp(r'[\s()+-]'), ''))) {
      return null;
    }
    return t.runes.length > 90 ? '${String.fromCharCodes(t.runes.take(90)).trimRight()}...' : t;
  }

  return LiveCardFields(badge: ok(badge), surau: ok(surau), title: ok(title), speaker: ok(speaker));
}

/// Makes the card. [background] is a JPEG or PNG still, or null for the plain
/// branded card. [rtl] draws the lines right to left (Arabic).
typedef LiveCardBuilder = Future<Uint8List> Function({
  required LiveCardFields fields,
  Uint8List? background,
  bool rtl,
});

final liveNoticeCardProvider = Provider<LiveCardBuilder>((ref) => renderLiveCard);

Future<Uint8List> renderLiveCard({
  required LiveCardFields fields,
  Uint8List? background,
  bool rtl = false,
}) async {
  final w = liveCardWidth.toDouble();
  final h = liveCardHeight.toDouble();
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, w, h));
  // The plain branded background: deep teal, the app's own colour.
  canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = const Color(0xFF06302B));
  ui.Image? still;
  if (background != null) {
    try {
      final codec = await ui.instantiateImageCodec(background);
      still = (await codec.getNextFrame()).image;
    } on Object {
      still = null;
    }
  }
  if (still != null) {
    // cover: fill the card, centred
    final sw = still.width.toDouble();
    final sh = still.height.toDouble();
    final scale = (w / sw) > (h / sh) ? w / sw : h / sh;
    final dw = sw * scale;
    final dh = sh * scale;
    canvas.drawImageRect(
      still,
      Rect.fromLTWH(0, 0, sw, sh),
      Rect.fromLTWH((w - dw) / 2, (h - dh) / 2, dw, dh),
      Paint()..filterQuality = FilterQuality.medium,
    );
  }
  // A dark fade from the bottom so the words read on any picture.
  canvas.drawRect(
    Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(
        Offset(0, h * 0.2),
        Offset(0, h),
        [const Color(0x00000000), const Color(0xE6000000)],
      ),
  );
  final dir = rtl ? TextDirection.rtl : TextDirection.ltr;
  TextPainter paint(String t, double size, FontWeight weight, Color color, double maxWidth) =>
      TextPainter(
        text: TextSpan(text: t, style: TextStyle(fontSize: size, fontWeight: weight, color: color, height: 1.15)),
        textDirection: dir,
        maxLines: 2,
        ellipsis: '...',
      )..layout(maxWidth: maxWidth);

  const pad = 64.0;
  final inner = w - pad * 2;
  double y = h - pad;
  // Draw from the bottom up: speaker, title, surau; the badge sits at the top.
  for (final (t, size, weight, color) in [
    (fields.speaker, 34.0, FontWeight.w500, const Color(0xFFE9DFC8)),
    (fields.title, 58.0, FontWeight.w800, Colors.white),
    (fields.surau, 36.0, FontWeight.w600, const Color(0xFFF0C97A)),
  ]) {
    if (t == null) continue;
    final p = paint(t, size, weight, color, inner);
    y -= p.height;
    p.paint(canvas, Offset(rtl ? w - pad - p.width : pad, y));
    y -= 12;
  }
  final badge = fields.badge;
  if (badge != null) {
    final p = paint(badge, 34, FontWeight.w800, Colors.white, inner - 48);
    final bw = p.width + 48;
    final bh = p.height + 24;
    final left = rtl ? w - pad - bw : pad;
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(left, pad, bw, bh), const Radius.circular(10)),
      Paint()..color = const Color(0xFFD32F2F),
    );
    p.paint(canvas, Offset(left + 24, pad + 12));
  }
  final pic = recorder.endRecording();
  final image = await pic.toImage(liveCardWidth, liveCardHeight);
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  image.dispose();
  still?.dispose();
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
