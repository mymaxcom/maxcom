// Waking the cloud (Plan 6, "On-demand cloud"). The cloud VM is not up all
// day: a device that needs it sends a signed `POST <cloud>/wake` and the
// Worker starts the VM (at most once per 5 min). Normal API calls never wake
// it. The signature is the device key's, over
// `maxcom-wake-dev\n<boxId>\n<deviceId>\n<ts>`, in IEEE P1363 `r||s` form
// (the same key and encoding as `surau-unlock`).
//
// The call is fire and forget: it never blocks the UI and a failure is only
// remembered, never shown as an error (`waking` and `offline` are normal).

import 'dart:async';

import 'package:http/http.dart' as http;

import '../box/box_client.dart';
import '../box/device_key.dart';
import 'canonical.dart';

/// What the Worker answered to a wake.
enum WakeResult {
  /// 204: the VM was already up.
  up,

  /// 202: the VM is starting; ask again after [WakeOutcome.retryAfterSec].
  waking,

  /// 401: unsigned or unknown device. Never starts the VM.
  refused,

  /// 429: over the Worker's start limit.
  limited,

  /// Not sent: asked again inside the debounce window.
  debounced,

  /// The Worker could not be reached or answered something else.
  failed,
}

class WakeOutcome {
  const WakeOutcome(this.result, {this.retryAfterSec});

  final WakeResult result;
  final int? retryAfterSec;
}

/// At most one wake per [minGap] per device, in memory and (through
/// [loadLast] / [saveLast]) across restarts.
class CloudWake {
  CloudWake({
    required this.clientFor,
    required this.key,
    required this.boxId,
    required this.deviceId,
    DateTime Function()? now,
    this.minGap = const Duration(minutes: 10),
    this.timeout = const Duration(seconds: 8),
    this.loadLast,
    this.saveLast,
  }) : now = now ?? DateTime.now;

  final Future<BoxClient> Function(Uri cloud) clientFor;
  final DeviceKey key;
  final String boxId;
  final String deviceId;
  final DateTime Function() now;
  final Duration minGap;
  final Duration timeout;
  final Future<int?> Function()? loadLast;
  final Future<void> Function(int ms)? saveLast;

  int? _lastMs;
  bool _loaded = false;

  /// Starts a wake without waiting for it. Never throws.
  void wakeSoon(Uri cloud) {
    unawaited(wake(cloud).then((_) {}, onError: (Object _) {}));
  }

  /// Sends the wake unless one went out in the last [minGap] (or [force]).
  Future<WakeOutcome> wake(Uri cloud, {bool force = false}) async {
    if (!_loaded) {
      _loaded = true;
      try {
        _lastMs ??= await loadLast?.call();
      } on Object {
        // a lost debounce record only allows one extra wake
      }
    }
    final nowMs = now().millisecondsSinceEpoch;
    final last = _lastMs;
    if (!force && last != null && nowMs - last < minGap.inMilliseconds) {
      return const WakeOutcome(WakeResult.debounced);
    }
    _lastMs = nowMs;
    try {
      await saveLast?.call(nowMs);
    } on Object {
      // ignore: the in-memory record still debounces this run
    }
    try {
      final sig = b64url(
        await key.sign(wakeDeviceMessage(boxId, deviceId, nowMs)),
      );
      final bc = await clientFor(cloud);
      final req = http.Request('POST', cloud.replace(path: '/wake'))
        ..headers['X-Maxcom-Device'] = deviceId
        ..headers['X-Maxcom-Box'] = boxId
        ..headers['X-Maxcom-Ts'] = '$nowMs'
        ..headers['X-Maxcom-Sig'] = sig;
      final streamed = await bc.client.send(req).timeout(timeout);
      final res = await http.Response.fromStream(streamed).timeout(timeout);
      final retry = int.tryParse(res.headers['retry-after'] ?? '');
      switch (res.statusCode) {
        case 204:
          return const WakeOutcome(WakeResult.up);
        case 202:
          return WakeOutcome(WakeResult.waking, retryAfterSec: retry ?? 60);
        case 401:
          return const WakeOutcome(WakeResult.refused);
        case 429:
          return WakeOutcome(WakeResult.limited, retryAfterSec: retry);
        default:
          return const WakeOutcome(WakeResult.failed);
      }
    } on Object {
      return const WakeOutcome(WakeResult.failed);
    }
  }
}

/// App open or resume: wake the cloud when the box is not on this network
/// (not reachable within [boxProbe]) or edits are waiting in the outbox.
class ForegroundWaker {
  ForegroundWaker({
    required this.wake,
    required this.boxReachable,
    required this.outboxCount,
    required this.cloud,
    this.boxProbe = const Duration(seconds: 2),
  });

  final CloudWake wake;

  /// Whether the box answers (the caller's own locate of the box only).
  final Future<bool> Function() boxReachable;
  final Future<int> Function() outboxCount;
  final Uri? Function() cloud;
  final Duration boxProbe;

  /// Returns at once. The probe and the wake run in the background.
  void onForeground() {
    final target = cloud();
    if (target == null) return;
    unawaited(_run(target));
  }

  Future<bool> _run(Uri target) async {
    try {
      var needed = (await outboxCount()) > 0;
      if (!needed) {
        bool reachable;
        try {
          reachable = await boxReachable().timeout(boxProbe);
        } on Object {
          reachable = false;
        }
        needed = !reachable;
      }
      if (!needed) return false;
      wake.wakeSoon(target);
      return true;
    } on Object {
      return false;
    }
  }

  /// For tests: the same decision, awaited. True when a wake was started.
  Future<bool> onForegroundForTest() async {
    final target = cloud();
    if (target == null) return false;
    return _run(target);
  }
}
