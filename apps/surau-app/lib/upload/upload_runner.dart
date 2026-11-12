// The upload runner of this platform (Plan 6 Task 10): the browser loop on the
// web, the WorkManager worker on Android, a do-nothing stub elsewhere.
// [uploadRunnerFor] mirrors `publisherFor` and `localStoreFor` in deps.dart.

import 'package:flutter/foundation.dart';

import 'upload_queue.dart';
import 'upload_runner_stub.dart' as stub;
import 'upload_runner_stub.dart'
    if (dart.library.io) 'upload_runner_android.dart'
    as io;
import 'upload_runner_stub.dart'
    if (dart.library.js_interop) 'upload_runner_web.dart'
    as web;

export 'upload_queue.dart' show UploadRunner;

/// `android`, `web` or `ios-web`, as in `AppDeps.platform`.
UploadRunner uploadRunnerFor(String platform) {
  if (kIsWeb || platform == 'web' || platform == 'ios-web') {
    return web.createWebRunner();
  }
  if (platform == 'android') return io.createAndroidRunner();
  return stub.createWebRunner();
}
