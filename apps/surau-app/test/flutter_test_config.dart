// Runs once before every test file (flutter_test convention).
//
// 1. Loads the real Plus Jakarta Sans files so goldens show the app's
//    typography instead of the Ahem test font, and the Material icon
//    font from the Flutter SDK cache so icons render.
// 2. Roots golden files at `test/goldens/` whichever test file asks.

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  await _loadAppFonts();
  await _loadMaterialIcons();
  goldenFileComparator = LocalFileComparator(
    Uri.file('${Directory.current.path}/test/goldens/placeholder.png'),
  );
  await testMain();
}

const _fontDir = 'assets/fonts';
const _fontFiles = <String>[
  'PlusJakartaSans-Regular.ttf',
  'PlusJakartaSans-Medium.ttf',
  'PlusJakartaSans-SemiBold.ttf',
  'PlusJakartaSans-Bold.ttf',
  'PlusJakartaSans-ExtraBold.ttf',
];

/// The Arabic families of `pubspec.yaml` (assets/fonts/ARABIC-FONTS.md),
/// so goldens with Arabic text are shaped by the bundled fonts, as on the
/// box's web build.
const _arabicFamilies = <String, List<String>>{
  'QpcHafs': ['qpc-hafs/KFGQPC-Hafs-V30.ttf'],
  'AmiriQuran': ['amiri-quran/AmiriQuran.ttf'],
  'NotoNaskhArabic': [
    'noto-naskh-arabic/NotoNaskhArabic-Regular.ttf',
    'noto-naskh-arabic/NotoNaskhArabic-Bold.ttf',
  ],
};

Future<void> _loadAppFonts() async {
  await _loadFamily('PlusJakartaSans', _fontFiles);
  for (final e in _arabicFamilies.entries) {
    await _loadFamily(e.key, e.value);
  }
}

Future<void> _loadFamily(String family, List<String> files) async {
  final loader = FontLoader(family);
  for (final name in files) {
    final file = File('$_fontDir/$name');
    if (!file.existsSync()) {
      throw StateError('Font file missing: ${file.path}');
    }
    loader.addFont(_bytes(file));
  }
  await loader.load();
}

Future<void> _loadMaterialIcons() async {
  final root = _flutterRoot();
  if (root == null) return;
  final file = File(
    '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  );
  if (!file.existsSync()) return;
  final loader = FontLoader('MaterialIcons')..addFont(_bytes(file));
  await loader.load();
}

/// The Flutter SDK root: `FLUTTER_ROOT` when set, else derived from the
/// Dart VM running the tests (`<root>/bin/cache/dart-sdk/bin/dart`).
String? _flutterRoot() {
  final env = Platform.environment['FLUTTER_ROOT'];
  if (env != null && env.isNotEmpty) return env;
  final dart = File(Platform.resolvedExecutable);
  final candidate = dart.parent.parent.parent.parent.parent;
  if (File('${candidate.path}/bin/flutter').existsSync()) {
    return candidate.path;
  }
  return null;
}

Future<ByteData> _bytes(File file) async {
  final data = await file.readAsBytes();
  return ByteData.sublistView(data);
}
