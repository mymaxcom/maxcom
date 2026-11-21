// The live notice picture (W22 item 4): today's kuliah card made on the phone
// when the box has no frame of the live, and the plain card when the live has
// no kuliah. Goldens in BM, EN and AR at phone size, plus what the field
// cleaner keeps out of the picture.

import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/features/live/live_notice_card.dart';

import '../../golden_sizes.dart';
import '../shell/harness.dart' show fixtureLogoPng;

/// A made-up portrait (no real person): a head and shoulders on a soft gradient.
Uint8List _portrait() {
  final im = img.Image(width: 300, height: 300);
  for (var y = 0; y < 300; y++) {
    for (var x = 0; x < 300; x++) {
      im.setPixelRgb(x, y, 120 + (y ~/ 4), 150 + (x ~/ 6), 170);
    }
  }
  img.fillCircle(im, x: 150, y: 120, radius: 55, color: img.ColorRgb8(226, 190, 160));
  img.fillCircle(im, x: 150, y: 330, radius: 130, color: img.ColorRgb8(235, 235, 235));
  return Uint8List.fromList(img.encodePng(im));
}

Future<ui.Image> _card(
  WidgetTester tester,
  LiveCardFields fields, {
  Uint8List? photo,
  Uint8List? logo,
  bool rtl = false,
}) async {
  late ui.Image image;
  await tester.runAsync(() async {
    final jpg = await renderLiveCard(fields: fields, photo: photo, logo: logo, rtl: rtl);
    expect(jpg.sublist(0, 2), [0xFF, 0xD8], reason: 'a JPEG');
    final codec = await ui.instantiateImageCodec(jpg);
    image = (await codec.getNextFrame()).image;
  });
  expect(image.width, liveCardWidth);
  expect(image.height, liveCardHeight);
  return image;
}

Widget _frame(ui.Image image, {required bool rtl}) => Directionality(
  textDirection: rtl ? TextDirection.rtl : TextDirection.ltr,
  child: ColoredBox(
    color: const Color(0xFFEFEFEF),
    child: Center(child: RepaintBoundary(child: SizedBox(width: 380, height: 380 * 630 / 1200, child: RawImage(image: image, fit: BoxFit.fill)))),
  ),
);

const _bm = LiveCardFields(
  badge: 'SIARAN LANGSUNG',
  surau: 'Surau Perintis Contoh',
  slot: 'Kuliah Maghrib',
  speaker: 'Ustaz Ahmad Fauzi',
  title: 'Adab Menuntut Ilmu',
  time: '19:15',
);
const _en = LiveCardFields(
  badge: 'LIVE NOW',
  surau: 'Surau Perintis Contoh',
  slot: 'Maghrib Talk',
  speaker: 'Ustaz Ahmad Fauzi',
  title: 'Manners of Seeking Knowledge',
  time: '19:15',
);
const _ar = LiveCardFields(
  badge: 'بث مباشر',
  surau: 'Surau Perintis Contoh',
  slot: 'درس المغرب',
  speaker: 'Ustaz Ahmad Fauzi',
  title: 'آداب طلب العلم',
  time: '19:15',
);

void main() {
  group('[W22-4] the kuliah card (no frame from the box)', () {
    for (final (name, fields, rtl) in [('bm', _bm, false), ('en', _en, false), ('ar', _ar, true)]) {
      testWidgets('golden: kuliah card with photo and logo, $name', (tester) async {
        final image = await _card(tester, fields, photo: _portrait(), logo: fixtureLogoPng(), rtl: rtl);
        await pumpAtSize(tester, _frame(image, rtl: rtl), GoldenSize.phone);
        await expectLater(find.byType(RepaintBoundary).last, matchesGoldenFile('live_notice_card_kuliah_$name.png'));
      });
    }

    testWidgets('golden: kuliah card without a photo or a logo (BM)', (tester) async {
      final image = await _card(tester, _bm);
      await pumpAtSize(tester, _frame(image, rtl: false), GoldenSize.phone);
      await expectLater(find.byType(RepaintBoundary).last, matchesGoldenFile('live_notice_card_kuliah_nophoto_bm.png'));
    });

    testWidgets('a photo or a logo that cannot be decoded is left out, the card is still made', (tester) async {
      final image = await _card(tester, _bm, photo: Uint8List.fromList([1, 2, 3]), logo: Uint8List.fromList([4, 5, 6]));
      expect(image.width, liveCardWidth);
    });
  });

  group('[W22-4] the plain card (no kuliah for the live)', () {
    for (final (name, badge, rtl) in [('bm', 'SIARAN LANGSUNG', false), ('en', 'LIVE NOW', false), ('ar', 'بث مباشر', true)]) {
      testWidgets('golden: plain card with the surau name and logo, $name', (tester) async {
        final image = await _card(
          tester,
          LiveCardFields(badge: badge, surau: 'Surau Perintis Contoh'),
          logo: fixtureLogoPng(),
          rtl: rtl,
        );
        await pumpAtSize(tester, _frame(image, rtl: rtl), GoldenSize.phone);
        await expectLater(find.byType(RepaintBoundary).last, matchesGoldenFile('live_notice_card_plain_$name.png'));
      });
    }

    testWidgets('only the badge, or nothing at all, still gives a picture', (tester) async {
      expect((await _card(tester, const LiveCardFields(badge: 'LIVE NOW'))).width, liveCardWidth);
      expect((await _card(tester, const LiveCardFields())).width, liveCardWidth);
    });
  });

  group('[W22-4] the fields', () {
    test('slot and time are kept; an address, a link or a number is left out; a bad time is dropped', () {
      final f = liveCardFields(
        badge: 'LIVE NOW',
        surau: 'Surau Contoh',
        slot: 'Kuliah Maghrib',
        title: 'https://evil.example/x',
        speaker: 'Ustaz 60120000001',
        time: '19:15',
      );
      expect(f.slot, 'Kuliah Maghrib');
      expect(f.time, '19:15');
      expect(f.title, isNull);
      expect(f.speaker, isNull);
      expect(liveCardFields(time: '7pm').time, isNull);
      expect(liveCardFields(time: '19:15').hasKuliah, isTrue);
      expect(liveCardFields(badge: 'x', surau: 'y').hasKuliah, isFalse);
    });
  });
}
