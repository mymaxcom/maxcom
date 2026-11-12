// Plan 4 Task 12: every screen has its golden at phone, iPad mini portrait
// and iPad mini landscape. The screens are rendered by their own tests
// (one golden name is owned by exactly one test, so two tests never fight
// over a PNG); this test is the index: it fails when any required PNG is
// missing, is not a real PNG at the expected pixel size, or is not listed
// in test/goldens/README.md.
//
// Rendering lives in: enrol_* (test/features/enrol/enrol_screen_test.dart),
// unlock (test/features/unlock/unlock_screen_test.dart), dashboard*,
// forbidden (test/features/shell/dashboard_test.dart), settings_*
// (test/screens/settings_test.dart), content_* (content_test.dart),
// preview, islamic, prayer_data (preview_test, islamic_test,
// prayer_data_test), users (users_test.dart), enrol_qr (users_test.dart),
// devices, pairing (devices_test.dart), audit (audit_test.dart),
// this_device (this_device_test.dart), arabic_fonts
// (test/app/arabic_fonts_test.dart). All of them render through the
// production providers over the realistic box of test/support/fake_box.dart.

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import '../golden_sizes.dart';
import '../support/golden_index.dart';

const _dir = 'test/goldens';

/// Width and height of a PNG from its IHDR chunk (bytes 16 to 23).
(int, int) _pngSize(Uint8List b) {
  final d = ByteData.sublistView(b);
  return (d.getUint32(16), d.getUint32(20));
}

const _pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

void main() {
  final required = requiredGoldenFiles();

  test('the plan lists 22 screens at 3 sizes plus the extras', () {
    expect(requiredScreens.length, 22);
    expect(requiredScreens.toSet().length, 22, reason: 'no duplicate names');
    expect(required.length, 22 * 3 + requiredExtraScreens.length * 3 + requiredPhoneOnly.length);
  });

  test('every required golden PNG exists', () {
    final missing = [
      for (final name in required)
        if (!File('$_dir/$name.png').existsSync()) '$name.png',
    ];
    expect(missing, isEmpty, reason: 'run `flutter test --update-goldens`');
  });

  test('every required golden is a real PNG at its size x pixel ratio', () {
    for (final name in required) {
      final file = File('$_dir/$name.png');
      if (!file.existsSync()) continue; // reported above
      final bytes = file.readAsBytesSync();
      expect(bytes.length, greaterThan(1024), reason: '$name is empty');
      expect(bytes.sublist(0, 8), _pngSignature, reason: '$name is not a PNG');
      final size = GoldenSize.values.firstWhere((s) => name.endsWith('_${s.name}'));
      final (w, h) = _pngSize(bytes);
      expect(w, (size.width * goldenPixelRatio).round(), reason: '$name width');
      expect(h, (size.height * goldenPixelRatio).round(), reason: '$name height');
    }
  });

  test('test/goldens/README.md names every golden', () {
    final readme = File('$_dir/README.md');
    expect(readme.existsSync(), isTrue, reason: 'the index must exist');
    final text = readme.readAsStringSync();
    final names = {...requiredScreens, ...requiredExtraScreens, ...requiredPhoneOnly};
    final unlisted = [
      for (final n in names)
        if (!text.contains('`$n`')) n,
    ];
    expect(unlisted, isEmpty, reason: 'add these to README.md');
  });
}
