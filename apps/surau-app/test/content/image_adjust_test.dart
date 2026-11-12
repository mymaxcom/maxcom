// The adjust screen on its own: the frame in the slot's real shape (the
// logo's free frame on the trim box, a circle for a speaker, 16:9 for a
// poster), the logo's background choice preselected from the box's
// analysis with the before/after, the square icon step with the app icon
// and browser icon, zoom, rotate, reset, keyboard, the free frame's
// handles, Batal; what `Simpan` hands back (the plain id when nothing is
// adjusted). Goldens: image_adjust_logo, image_adjust_square,
// image_adjust_penceramah_circle, image_adjust_poster.

import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/content/adjusted_picture.dart';
import 'package:surau_app/content/image_adjust.dart';
import 'package:surau_app/content/image_bg.dart';
import 'package:surau_app/content/image_ref.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../features/shell/harness.dart' show fixtureMaxcomPng, settleImages, sha256Hex;
import '../golden_sizes.dart';

/// A 640 x 480 photo with a light sky, a dark ground and a warm disc, so
/// a crop or rotation shows.
Uint8List photo({int w = 640, int h = 480}) {
  final im = img.Image(width: w, height: h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final sky = y < h * 0.6;
      im.setPixelRgb(
        x,
        y,
        sky ? 120 + (y * 60 ~/ h) : 60,
        sky ? 160 + (y * 40 ~/ h) : 90 - (y * 20 ~/ h),
        sky ? 200 : 70,
      );
    }
  }
  img.fillCircle(im, x: w * 3 ~/ 4, y: h ~/ 4, radius: h ~/ 8, color: im.getColor(240, 201, 122));
  return Uint8List.fromList(img.encodeJpg(im, quality: 90));
}

/// Holds the result of the screen (null on Batal) once it pops.
class Host extends StatefulWidget {
  const Host({super.key, required this.screen, required this.onResult});

  final Widget screen;
  final void Function(ImageRef? result) onResult;

  @override
  State<Host> createState() => _HostState();
}

class _HostState extends State<Host> {
  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: FilledButton(
        key: const ValueKey('open'),
        onPressed: () async {
          final r = await Navigator.of(context)
              .push<ImageRef>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => widget.screen));
          widget.onResult(r);
        },
        child: const Text('Buka'),
      ),
    ),
  );
}

Widget app(Widget home, Map<String, Uint8List> assets) => ProviderScope(
  overrides: [
    assetBytesProvider.overrideWith((ref, id) async => assets[id]),
    processImageProvider.overrideWithValue((bytes) async => removeBackgroundPng(bytes)),
  ],
  child: MaterialApp(
    key: UniqueKey(),
    debugShowCheckedModeBanner: false,
    theme: SurauTheme.light(),
    locale: const Locale('ms'),
    localizationsDelegates: S.localizationsDelegates,
    supportedLocales: S.supportedLocales,
    home: home,
  ),
);

/// Builds the app with the screen behind an `open` button; [open] pushes it.
({Widget app, ImageRef? Function() result, bool Function() popped}) screenFor({
  required Uint8List bytes,
  required ImageSlot slot,
  ImageRef? initial,
  ImageAnalysis? analysis,
}) {
  final id = sha256Hex(bytes);
  ImageRef? result;
  var popped = false;
  final w = app(
    Host(
      screen: ImageAdjustScreen(bytes: bytes, initial: initial ?? ImageRef(id), slot: slot, analysis: analysis),
      onResult: (r) {
        result = r;
        popped = true;
      },
    ),
    {id: bytes},
  );
  return (app: w, result: () => result, popped: () => popped);
}

Future<void> open(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('open')));
  await tester.pumpAndSettle();
  await settleImages(tester);
}

ImageAnalysis analyse(Uint8List bytes) => ImageAnalysis.fromJson(analyzeBytes(bytes)!.cast<String, dynamic>());

Finder key(String k) => find.byKey(ValueKey(k));

/// The crop editor's frame as the painter draws it.
Rect frameOf(WidgetTester tester) {
  final c = tester.widget<CropEditor>(find.byType(CropEditor)).controller;
  return c.geometry!.frame;
}

CropController controllerOf(WidgetTester tester) => tester.widget<CropEditor>(find.byType(CropEditor)).controller;

void main() {
  group('logo', () {
    testWidgets(
      'step 1: free frame on the trim box, Buang latar putih preselected, before/after; step 2: square icon (goldens)',
      (tester) async {
        final bytes = fixtureMaxcomPng();
        final a = analyse(bytes);
        final id = sha256Hex(bytes);
        final s = screenFor(
          bytes: bytes,
          slot: ImageSlot.logo,
          analysis: a,
          initial: ImageRef(id, crop: a.trim, bg: 'remove'),
        );
        await pumpAtSize(tester, s.app, GoldenSize.phone);
        await open(tester);
        expect(find.text('Laraskan logo'), findsOneWidget);
        expect(find.text('Langkah 1 daripada 2'), findsOneWidget);
        expect(find.text('Potong dan latar'), findsOneWidget);
        expect(tester.widget<ChoiceChip>(key('bg-remove')).selected, isTrue, reason: 'the analysis suggests remove');
        expect(find.text('Buang latar putih'), findsOneWidget);
        expect(find.text('Letak atas kad cerah'), findsOneWidget);
        expect(find.text('Kekalkan'), findsOneWidget);
        expect(find.text('Sebelum'), findsOneWidget);
        expect(find.text('Selepas'), findsOneWidget);
        expect(find.text('Seterusnya'), findsOneWidget);
        expect(find.text('Simpan'), findsNothing, reason: 'the square step comes first');
        final c = controllerOf(tester);
        expect(c.value.x, closeTo(a.trim.x, 2e-3));
        expect(c.value.w, closeTo(a.trim.w, 2e-3));
        for (final size in GoldenSize.values) {
          await pumpAtSize(tester, s.app, size);
          await settleImages(tester);
          await expectLater(find.byWidget(s.app), matchesGoldenFile('image_adjust_logo_${size.name}.png'));
        }

        await pumpAtSize(tester, s.app, GoldenSize.phone);
        await tester.tap(key('adjust-next'));
        await tester.pumpAndSettle();
        await settleImages(tester);
        expect(find.text('Langkah 2 daripada 2'), findsOneWidget);
        expect(find.text('Ikon segi empat'), findsOneWidget);
        expect(find.text('Ikon aplikasi'), findsOneWidget);
        expect(find.text('Ikon pelayar'), findsOneWidget);
        expect(find.text('Kembali'), findsOneWidget);
        final sq = controllerOf(tester);
        expect(sq.aspect, 1);
        expect(sq.value.w * 500, closeTo(sq.value.h * 126, 1), reason: 'a square in pixels, centred on the crop');
        for (final size in GoldenSize.values) {
          await pumpAtSize(tester, s.app, size);
          await settleImages(tester);
          await expectLater(find.byWidget(s.app), matchesGoldenFile('image_adjust_square_${size.name}.png'));
        }

        await pumpAtSize(tester, s.app, GoldenSize.phone);
        await tester.tap(key('adjust-save'));
        await tester.pumpAndSettle();
        final r = s.result()!;
        expect(r.bg, 'remove');
        expect(r.crop!.x, closeTo(a.trim.x, 2e-3));
        expect(r.square, isNotNull);
        final json = r.toJson() as Map;
        expect(json.keys.toSet(), {'asset', 'crop', 'bg', 'square'});
      },
    );

    testWidgets('Kekalkan drops the background choice; Kembali returns to step 1; Batal gives nothing', (tester) async {
      final bytes = fixtureMaxcomPng();
      final a = analyse(bytes);
      final s = screenFor(
        bytes: bytes,
        slot: ImageSlot.logo,
        analysis: a,
        initial: ImageRef(sha256Hex(bytes), crop: a.trim, bg: 'remove'),
      );
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      await tester.tap(key('bg-keep'));
      await tester.pumpAndSettle();
      expect(tester.widget<ChoiceChip>(key('bg-keep')).selected, isTrue);
      await tester.tap(key('bg-card'));
      await tester.pumpAndSettle();
      expect(tester.widget<ChoiceChip>(key('bg-card')).selected, isTrue);
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-back'));
      await tester.pumpAndSettle();
      expect(find.text('Langkah 1 daripada 2'), findsOneWidget);
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      expect(s.result()!.bg, 'card');

      final again = screenFor(bytes: bytes, slot: ImageSlot.logo, analysis: a);
      await pumpAtSize(tester, again.app, GoldenSize.phone);
      await open(tester);
      await tester.tap(key('adjust-cancel'));
      await tester.pumpAndSettle();
      expect(again.popped(), isTrue);
      expect(again.result(), isNull);
    });

    testWidgets('a picture already transparent offers no remove; a busy one warns', (tester) async {
      final clear = img.Image(width: 80, height: 40, numChannels: 4);
      img.fillCircle(clear, x: 40, y: 20, radius: 12, color: clear.getColor(10, 60, 50, 255));
      final bytes = Uint8List.fromList(img.encodePng(clear));
      final s = screenFor(bytes: bytes, slot: ImageSlot.logo, analysis: analyse(bytes));
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      expect(key('bg-remove'), findsNothing);
      expect(find.text('Latar gambar ini sudah lutsinar.'), findsOneWidget);

      final busy = screenFor(bytes: photo(), slot: ImageSlot.logo, analysis: analyse(photo()));
      await pumpAtSize(tester, busy.app, GoldenSize.phone);
      await open(tester);
      expect(key('bg-remove'), findsOneWidget);
      expect(find.text('Latar gambar ini tidak sekata. Membuang latar mungkin tidak kemas.'), findsOneWidget);
    });

    testWidgets('the free frame: dragging the right handle narrows the crop', (tester) async {
      final bytes = fixtureMaxcomPng();
      final s = screenFor(bytes: bytes, slot: ImageSlot.logo, analysis: analyse(bytes));
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      final before = controllerOf(tester).value;
      expect(before.w, 1, reason: 'the whole picture to start');
      final f = frameOf(tester);
      final origin = tester.getTopLeft(find.byType(CropEditor));
      await tester.dragFrom(origin + f.centerRight, const Offset(-80, 0));
      await tester.pumpAndSettle();
      final after = controllerOf(tester).value;
      expect(after.w, lessThan(0.9));
      expect(after.x, 0, reason: 'the left edge stayed');
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      expect(s.result()!.crop!.w, closeTo(after.w, 1e-3));
    });
  });

  group('logo steps', () {
    testWidgets('Set semula in step 2 returns to step 1', (tester) async {
      final bytes = fixtureMaxcomPng();
      final s = screenFor(bytes: bytes, slot: ImageSlot.logo, analysis: analyse(bytes));
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      expect(find.text('Langkah 2 daripada 2'), findsOneWidget);
      await tester.tap(key('adjust-reset'));
      await tester.pumpAndSettle();
      expect(find.text('Langkah 1 daripada 2'), findsOneWidget);
      expect(key('adjust-next'), findsOneWidget);
    });

    testWidgets('turning the picture in step 2 does not freeze the square; it still follows the crop', (tester) async {
      final bytes = fixtureMaxcomPng();
      final s = screenFor(bytes: bytes, slot: ImageSlot.logo, analysis: analyse(bytes));
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-rotate'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-back'));
      await tester.pumpAndSettle();
      // Narrow the crop from its right edge, then go on: the square is made from this crop.
      final f = frameOf(tester);
      final origin = tester.getTopLeft(find.byType(CropEditor));
      await tester.dragFrom(origin + f.centerRight, const Offset(-80, 0));
      await tester.pumpAndSettle();
      final crop = controllerOf(tester).value;
      await tester.tap(key('adjust-next'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      final out = s.result()!;
      final sq = out.square!;
      // The square is centred on the crop (a rotated picture swaps the sides, both are fractions).
      expect(sq.x + sq.w / 2, closeTo(crop.x + crop.w / 2, 0.08));
      expect(sq.y + sq.h / 2, closeTo(crop.y + crop.h / 2, 0.08));
    });
  });

  group('content pictures', () {
    testWidgets('a speaker photo: circle frame covering it (golden); Simpan with nothing moved gives the plain id', (
      tester,
    ) async {
      final bytes = photo();
      final s = screenFor(bytes: bytes, slot: ImageSlot.penceramah);
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      expect(find.text('Laraskan gambar'), findsOneWidget);
      expect(find.text('Langkah 1 daripada 2'), findsNothing);
      expect(find.text('Simpan'), findsOneWidget);
      final f = frameOf(tester);
      expect(f.width, closeTo(f.height, 1e-6), reason: 'a circle');
      for (final size in GoldenSize.values) {
        await pumpAtSize(tester, s.app, size);
        await settleImages(tester);
        await expectLater(find.byWidget(s.app), matchesGoldenFile('image_adjust_penceramah_circle_${size.name}.png'));
      }
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      // The frame covers the photo's height: the crop is the centre square.
      final c = controllerOf(tester).value;
      expect(c.h, 1);
      expect(c.w, closeTo(480 / 640, 1e-3));
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      final r = s.result()!;
      expect(r.crop!.w, closeTo(0.75, 1e-3));
      expect(r.toJson(), isA<Map<String, Object?>>());
    });

    testWidgets('a poster: 16:9 frame with the whole picture inside (golden); untouched it stays the plain id', (
      tester,
    ) async {
      final bytes = photo(w: 480, h: 640);
      final s = screenFor(bytes: bytes, slot: ImageSlot.poster);
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      final f = frameOf(tester);
      expect(f.width / f.height, closeTo(16 / 9, 1e-6));
      final g = controllerOf(tester).geometry!;
      expect(g.shown.height, closeTo(f.height, 1e-6), reason: 'a tall poster fits the frame height, bars at the sides');
      expect(controllerOf(tester).value.toJson(), fullBox.toJson());
      for (final size in GoldenSize.values) {
        await pumpAtSize(tester, s.app, size);
        await settleImages(tester);
        await expectLater(find.byWidget(s.app), matchesGoldenFile('image_adjust_poster_${size.name}.png'));
      }
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      expect(s.result()!.toJson(), sha256Hex(bytes), reason: 'nothing adjusted: the plain id');
    });

    testWidgets('zoom in crops; rotate turns the picture and the crop; Set semula gives the plain id back', (
      tester,
    ) async {
      final bytes = photo();
      final s = screenFor(bytes: bytes, slot: ImageSlot.poster);
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      await tester.tap(key('adjust-zoom-in'));
      await tester.pumpAndSettle();
      final zoomed = controllerOf(tester).value;
      expect(zoomed.h, lessThan(1), reason: 'the 4:3 photo is taller than the 16:9 frame once zoomed');
      expect(zoomed.w, 1, reason: 'still narrower than the frame: full width, bars at the sides');
      await tester.tap(key('adjust-zoom-in'));
      await tester.tap(key('adjust-zoom-in'));
      await tester.pumpAndSettle();
      expect(controllerOf(tester).value.w, lessThan(1), reason: 'wider than the frame now');
      await tester.tap(key('adjust-rotate'));
      await tester.pumpAndSettle();
      final c = controllerOf(tester);
      expect(c.image, const Size(480, 640), reason: 'a quarter turn swaps the sides');
      await tester.tap(key('adjust-reset'));
      await tester.pumpAndSettle();
      expect(controllerOf(tester).image, const Size(640, 480));
      expect(controllerOf(tester).value.toJson(), fullBox.toJson());
      await tester.tap(key('adjust-rotate'));
      await tester.pumpAndSettle();
      await tester.tap(key('adjust-save'));
      await tester.pumpAndSettle();
      final r = s.result()!;
      expect(r.rotate, 90);
      expect(r.crop, isNull, reason: 'the whole turned picture fits the 16:9 frame');
      expect(r.toJson(), {'asset': sha256Hex(bytes), 'rotate': 90});
    });

    testWidgets('keyboard: arrows move, plus and minus zoom, R rotates; the wheel zooms too', (tester) async {
      final bytes = photo();
      final s = screenFor(bytes: bytes, slot: ImageSlot.kitab);
      await pumpAtSize(tester, s.app, GoldenSize.phone);
      await open(tester);
      final f = frameOf(tester);
      expect(f.width / f.height, closeTo(2 / 3, 1e-6));
      await tester.tap(find.byType(CropEditor));
      await tester.pumpAndSettle();
      final start = controllerOf(tester).value;
      await tester.sendKeyEvent(LogicalKeyboardKey.equal);
      await tester.pumpAndSettle();
      final zoomed = controllerOf(tester).value;
      expect(zoomed.w, lessThan(start.w));
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pumpAndSettle();
      expect(
        controllerOf(tester).value.x,
        lessThan(zoomed.x),
        reason: 'the picture moved right, the frame reads further left',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.minus);
      await tester.pumpAndSettle();
      expect(controllerOf(tester).value.w, greaterThan(zoomed.w));
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pumpAndSettle();
      expect(controllerOf(tester).image, const Size(480, 640));

      final before = controllerOf(tester).value;
      final centre = tester.getCenter(find.byType(CropEditor));
      final pointer = TestPointer(1, PointerDeviceKind.mouse);
      await tester.sendEventToBinding(pointer.hover(centre));
      await tester.sendEventToBinding(pointer.scroll(const Offset(0, -200)));
      await tester.pumpAndSettle();
      expect(controllerOf(tester).value.w, lessThan(before.w), reason: 'wheel up zooms in');
    });
  });
}
