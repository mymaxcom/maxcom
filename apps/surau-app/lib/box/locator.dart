// Finding the box: the LAN address from enrolment first, then (Plan 6) the
// cloud copy, which answers the same API.

import 'dart:async';

import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import 'box_client.dart';
import 'cloud_origin.dart';

class Located {
  const Located({required this.base, required this.via, required this.health});

  final Uri base;

  /// `box` (direct) or `cloud` (Plan 6).
  final String via;
  final HealthDto health;
}

abstract class BoxLocator {
  /// Throws [BoxUnreachable] when the box cannot be reached this way.
  Future<Located> locate(EnrolledBox b);
}

/// `GET /api/health` on the enrolled address with a client pinned to the
/// enrolled CA (2 s connect, 10 s read from the [BoxClient]).
class DirectBoxLocator implements BoxLocator {
  DirectBoxLocator({required this.clientFor, this.onHealth});

  final Future<BoxClient> Function(EnrolledBox b) clientFor;

  /// Told every health answer the box gives (the app keeps the box's cloud
  /// origin from it). Failures of the callback never fail the locate.
  final void Function(HealthDto health)? onHealth;

  @override
  Future<Located> locate(EnrolledBox b) async {
    final client = await clientFor(b);
    final json = await client.getJson('/api/health');
    final HealthDto health;
    try {
      health = HealthDto.fromJson(json);
    } on Object {
      throw const BoxUnreachable('jawapan kesihatan tidak sah');
    }
    try {
      onHealth?.call(health);
    } on Object {
      // learning the cloud is a convenience
    }
    return Located(base: b.box, via: 'box', health: health);
  }
}

/// The cloud answered 503 `waking`: its VM is being started and `Retry-After`
/// says when to ask again. Normal, never an error to show in red.
class CloudWaking extends BoxError {
  const CloudWaking({super.retryAfterSec})
    : super(503, 'Awan sedang dihidupkan', code: 'waking');
}

/// Gives [inner] a short budget: a box that does not answer within
/// [timeout] counts as away, so the app moves on to the cloud at once.
class TimeoutLocator implements BoxLocator {
  TimeoutLocator(this.inner, this.timeout);

  final BoxLocator inner;
  final Duration timeout;

  @override
  Future<Located> locate(EnrolledBox b) async {
    try {
      return await inner.locate(b).timeout(timeout);
    } on TimeoutException catch (e) {
      throw BoxUnreachable(e);
    }
  }
}

/// `GET <cloud>/api/health` on the cloud origin ([cloudOriginOf]: the one
/// kept at enrolment or learnt from the box, else the default), within 12 s
/// so the Worker's own down-detection can answer. The cloud serves the same
/// API as the box, so the challenge/unlock protocol and the sync routes work
/// against `Located.base` unchanged. A 503 from the Worker is [CloudWaking].
class CloudLocator implements BoxLocator {
  CloudLocator({
    required this.clientFor,
    this.timeout = const Duration(seconds: 12),
  });

  /// A client for the cloud origin (Android: the same root CA; web: the
  /// browser's trust).
  final Future<BoxClient> Function(Uri cloud) clientFor;
  final Duration timeout;

  @override
  Future<Located> locate(EnrolledBox b) async {
    final cloud = cloudOriginOf(b);
    try {
      return await _probe(cloud).timeout(timeout);
    } on TimeoutException catch (e) {
      throw BoxUnreachable(e);
    }
  }

  Future<Located> _probe(Uri cloud) async {
    final client = await clientFor(cloud);
    final Map<String, dynamic> json;
    try {
      json = await client.getJson('/api/health');
    } on BoxError catch (e) {
      if (e.status == 503) throw CloudWaking(retryAfterSec: e.retryAfterSec);
      rethrow;
    }
    final HealthDto health;
    try {
      health = HealthDto.fromJson(json);
    } on Object {
      throw const BoxUnreachable('jawapan kesihatan tidak sah');
    }
    return Located(base: cloud, via: 'cloud', health: health);
  }
}

/// Tries each locator in order and returns the first that answers.
class CompositeLocator implements BoxLocator {
  CompositeLocator(List<BoxLocator> locators, {this.onFailed})
    : locators = List.unmodifiable(locators);

  final List<BoxLocator> locators;

  /// Told the index of each locator that did not answer, before the next
  /// is tried (the app wakes the cloud when the box is away).
  final void Function(int index)? onFailed;

  @override
  Future<Located> locate(EnrolledBox b) async {
    Object? last;
    for (var i = 0; i < locators.length; i++) {
      try {
        return await locators[i].locate(b);
      } on BoxUnreachable catch (e) {
        last = e;
      } on BoxError catch (e) {
        last = e;
      }
      try {
        onFailed?.call(i);
      } on Object {
        // a wake that cannot start never stops the search
      }
    }
    if (last is CloudWaking) throw last;
    if (last is BoxUnreachable) throw last;
    throw BoxUnreachable(last);
  }
}
