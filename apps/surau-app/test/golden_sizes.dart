import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Screen sizes every golden is captured at (logical pixels).
///
/// `phone` is a common Android phone (412 x 915, like a Pixel 7);
/// the two iPad mini sizes are the 6th generation iPad mini in Safari
/// with its browser chrome subtracted.
enum GoldenSize {
  phone(412, 915),
  ipadMiniPortrait(744, 1133),
  ipadMiniLandscape(1133, 744);

  const GoldenSize(this.width, this.height);

  final double width;
  final double height;

  Size get size => Size(width, height);
}

/// Device pixel ratio used for every golden PNG.
const double goldenPixelRatio = 2;

/// Pumps [widget] at each [GoldenSize] and compares it with
/// `test/goldens/<name>_<size>.png` (the comparator root is set to
/// `test/goldens` by `flutter_test_config.dart`).
///
/// Run `flutter test --update-goldens` to (re)generate the PNGs.
Future<void> expectGoldens(
  WidgetTester tester,
  Widget widget,
  String name, {
  List<GoldenSize> sizes = GoldenSize.values,
}) async {
  for (final size in sizes) {
    await pumpAtSize(tester, widget, size);
    await expectLater(
      find.byWidget(widget),
      matchesGoldenFile('${name}_${size.name}.png'),
      reason: 'golden $name at ${size.name}',
    );
  }
}

/// Sizes the test window to [size] at [goldenPixelRatio], pumps [widget]
/// and settles. The window is reset when the test ends.
Future<void> pumpAtSize(
  WidgetTester tester,
  Widget widget,
  GoldenSize size,
) async {
  final view = tester.view;
  view.physicalSize = size.size * goldenPixelRatio;
  view.devicePixelRatio = goldenPixelRatio;
  addTearDown(view.resetPhysicalSize);
  addTearDown(view.resetDevicePixelRatio);
  await tester.pumpWidget(widget);
  await tester.pumpAndSettle();
}
