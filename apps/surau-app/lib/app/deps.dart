// Everything the shell needs from the platform, in one object so the real
// app and the tests build the same widget tree. [AppDeps.forPlatform]
// assembles the real set from Task 4's trust store, session store and
// device key; tests pass fakes.

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../box/box_client.dart';
import '../box/device_key.dart';
import '../box/session_store.dart';
import '../box/trust.dart';
import '../features/common/contact_links.dart';
import '../features/common/surau_info.dart';
import '../features/enrol/browser_probe.dart';
import '../features/enrol/enrol_flow.dart';
import '../features/enrol/enrol_screen.dart';
import '../features/live/android_publisher.dart';
import '../features/live/fake_publisher.dart';
import '../features/live/publisher.dart';
import '../features/live/web_publisher.dart';
import '../features/shell/read_cache.dart';
import '../features/unlock/biometric_pin.dart';
import '../store/local_store.dart';
import '../store/local_store_stub.dart' as store_stub;
import '../store/local_store_stub.dart'
    if (dart.library.io) '../store/local_store_android.dart'
    as store_io;
import '../store/local_store_stub.dart'
    if (dart.library.js_interop) '../store/local_store_web.dart'
    as store_web;
import '../upload/upload_runner.dart';

class AppDeps {
  const AppDeps({
    required this.boxStore,
    required this.surauInfoStore,
    required this.key,
    required this.trust,
    required this.biometric,
    required this.clientFor,
    required this.enrolledClient,
    required this.platform,
    required this.cameraAvailable,
    required this.initialBox,
    this.initialSurau,
    this.cacheStore,
    this.boxLeaf,
    this.scannerBuilder,
    this.localStoreBuilder,
    this.uploadRunnerBuilder,
    this.healthPollInterval = const Duration(seconds: 15),
    this.openUrl = launchOutside,
    this.now = DateTime.now,
    this.toLocal = _toLocal,
  });

  /// Where the enrolled box is remembered ([SessionStore] in the app).
  final EnrolledBoxStore boxStore;

  /// Where the surau's name and helper are remembered.
  final SurauInfoStore surauInfoStore;
  final DeviceKey key;

  /// Trust on first use: Android pins the enrolled CA, the browser trusts
  /// the installed root ([PinnedEnrolTrust]).
  final EnrolTrust trust;
  final BiometricPin biometric;

  /// Client for the box named in a payload, during enrolment only
  /// (pinned to the CA just checked).
  final BoxClient Function(Uri box) clientFor;

  /// Client for the enrolled box, pinned to the CA kept at enrolment.
  /// Throws [TrustError] when that CA is gone: the app must enrol again.
  final Future<BoxClient> Function(EnrolledBox box) enrolledClient;

  /// `android`, `web` or `ios-web`, as sent to the box.
  final String platform;
  final bool cameraAvailable;

  /// Loaded from [boxStore] before the first frame so the first route is
  /// right without a loading screen.
  final EnrolledBox? initialBox;
  final SurauInfo? initialSurau;

  /// Android: the leaf certificate the enrolled box presents, got over the
  /// pinned connection (the preview WebView compares against it). Null in
  /// tests and on the web.
  final Future<Uint8List?> Function(EnrolledBox box)? boxLeaf;

  /// Persistent read cache; null keeps the cache for one run.
  final ReadCacheStore? cacheStore;

  /// Tests pass a placeholder; null uses the camera scanner.
  final ScannerBuilder? scannerBuilder;

  /// Makes the (unopened) local store of the enrolled box. Null turns the
  /// offline-first sync off: the gateway keeps the Plan 4 behaviour (tests).
  final LocalStore Function()? localStoreBuilder;

  /// Makes the platform's catch-up upload runner (the browser loop, the
  /// Android worker client). Null leaves the upload queue off (tests).
  final UploadRunner Function()? uploadRunnerBuilder;

  /// How often `GET /api/health` is polled while the app is in front; null
  /// disables polling (tests).
  final Duration? healthPollInterval;
  final UrlOpener openUrl;

  /// Clock and zone, injectable so goldens are stable.
  final DateTime Function() now;
  final DateTime Function(DateTime) toLocal;

  static DateTime _toLocal(DateTime t) => t.toLocal();

  /// The real app, on Android or in the browser.
  static Future<AppDeps> forPlatform() async {
    final prefs = await SharedPreferences.getInstance();
    final session = SessionStore(prefs);
    final surauStore = SurauInfoPrefsStore(prefs);
    final trustStore = TrustStore();
    final trust = PinnedEnrolTrust(trustStore, session);
    final platform = detectEnrolPlatform(
      isWeb: kIsWeb,
      userAgent: currentUserAgent(),
    );
    return AppDeps(
      boxStore: session,
      surauInfoStore: surauStore,
      key: platformDeviceKey(),
      trust: trust,
      biometric: kIsWeb ? const NoBiometricPin() : AndroidBiometricPin(),
      clientFor: trust.clientFor,
      enrolledClient: (box) => trustStore.boxClient(box, session),
      boxLeaf: (box) => trustStore.boxLeaf(box, session),
      platform: platform,
      cameraAvailable: cameraLikelyAvailable(),
      initialBox: await session.load(),
      initialSurau: await surauStore.load(),
      cacheStore: PrefsReadCacheStore(prefs),
      localStoreBuilder: () => localStoreFor(platform),
      uploadRunnerBuilder: () => uploadRunnerFor(platform),
    );
  }
}

/// The Live tab's publisher for this platform: the browser one on the web
/// (iPad Safari, Chrome on a PC), the RootEncoder plugin on Android, and
/// the fake only for an unknown platform (tests that do not override it).
///
/// [tokenProvider] gives the session token for the web WHIP request and
/// [box] the box origin; [segmentMinutes] is `recording.segmentMinutes` and
/// [maxBitrateKbps] is `liveYoutube.maxBitrateKbps` from the box settings.
LivePublisher publisherFor(
  String platform, {
  Uri? box,
  Future<String?> Function()? tokenProvider,
  int segmentMinutes = 15,
  int maxBitrateKbps = 2500,
}) {
  if (kIsWeb || platform == 'web' || platform == 'ios-web') {
    return WebPublisher(
      tokenProvider: tokenProvider,
      box: box,
      segmentMinutes: segmentMinutes,
      maxBitrateKbps: maxBitrateKbps,
    );
  }
  if (platform == 'android') {
    return AndroidPublisher(
      segmentMinutes: segmentMinutes,
      videoBitrateKbps: maxBitrateKbps,
    );
  }
  return FakePublisher();
}

/// Releases what [publisherFor] made (channels, streams, timers).
Future<void> disposePublisher(LivePublisher p) async {
  if (p is WebPublisher) return p.dispose();
  if (p is AndroidPublisher) return p.dispose();
  if (p is FakePublisher) return p.dispose();
}

/// The local store for this platform: Keystore-sealed files on Android,
/// IndexedDB in the browser, memory for anything else (tests, unknown).
LocalStore localStoreFor(String platform) {
  if (kIsWeb || platform == 'web' || platform == 'ios-web') {
    return store_web.webLocalStore();
  }
  if (platform == 'android') return store_io.androidLocalStore();
  return store_stub.androidLocalStore();
}
