import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

// Browser tests do not load the golden fonts/comparator of test/flutter_test_config.dart
// (dart:io is unavailable in the browser); the nearest config wins.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  await testMain();
}
