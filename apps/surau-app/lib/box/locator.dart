// Finding the box: the LAN address from enrolment first, then (Plan 6) the
// cloud copy, which answers the same API.

import 'dart:async';

import '../features/enrol/enrol_flow.dart' show EnrolledBox, TrustError;
import 'box_client.dart';
import 'box_name.dart';
import 'cloud_origin.dart';
import 'discovery.dart';
import 'routes.dart';

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

/// A pinned client for one probe: [origin] is the URL, and when [ip] is set
/// that host opens [ip] (only for this client). TLS is still checked for the
/// URL's host against the enrolled CA.
typedef ProbeClientFactory = Future<BoxClient> Function(Uri origin, String? ip);

/// Finds a box that has a local name, or learns its name.
///
/// A name, a TXT record or an address from discovery is only a HINT. Every
/// candidate must (1) complete a TLS handshake to the enrolled, pinned CA for
/// the candidate's own host and (2) answer `GET /api/box/info` with the
/// enrolled `boxId`. Only then is it trusted and used.
///
/// Boxes without a name keep the plain [legacy] locator (IP origin); once a
/// pinned health answer carries a name, a handshake by that name migrates the
/// enrolment.
class NameAwareLocator implements BoxLocator {
  NameAwareLocator({
    required this.legacy,
    required this.probeClient,
    required this.discovery,
    required this.routes,
    this.onReached,
    this.onNameLearned,
    this.discoveryTimeout = const Duration(milliseconds: 1500),
  });

  /// The IP-origin locator used while the box has no proven name.
  final BoxLocator legacy;
  final ProbeClientFactory probeClient;
  final BoxDiscovery discovery;
  final BoxRoutes routes;

  /// A verified direct answer came from [ip] (null when unknown, for
  /// example through the system resolver).
  final void Function(String? ip)? onReached;

  /// A handshake by [name] to the pinned CA, with the right boxId, worked.
  final void Function(String name)? onNameLearned;
  final Duration discoveryTimeout;

  /// The last migration attempt, for tests.
  Future<void>? lastMigration;

  Future<List<DiscoveredBox>>? _discovering;

  Future<List<DiscoveredBox>> _discover() => _discovering ??= discovery
      .discover(timeout: discoveryTimeout)
      .whenComplete(() => _discovering = null);

  @override
  Future<Located> locate(EnrolledBox b) async {
    final name = b.name;
    if (name == null) {
      final out = await legacy.locate(b);
      _maybeMigrate(b, out.health);
      return out;
    }
    final out = await _race(b, name);
    _maybeMigrate(b, out.health);
    return out;
  }

  void _maybeMigrate(EnrolledBox b, HealthDto health) {
    final seen = health.name;
    if (seen == null || !isBoxName(seen) || seen == b.name) return;
    lastMigration = _migrate(b, seen);
  }

  /// A health answer from the enrolled box named [name]: believe it only
  /// after a handshake by that name and the same boxId.
  Future<void> _migrate(EnrolledBox b, String name) async {
    try {
      final found = await _byName(b, name);
      onNameLearned?.call(name);
      if (found.ip != null) routes.set(name, found.ip!);
    } on Object {
      // The name stays a hint; the IP keeps working.
    }
  }

  Uri _origin(EnrolledBox b, String host) => Uri(
    scheme: 'https',
    host: host,
    port: b.box.port == 443 ? null : b.box.port,
  );

  Future<({Located located, String? ip})> _probe(
    EnrolledBox b,
    Uri origin,
    String? ip,
  ) async {
    final client = await probeClient(origin, ip);
    final info = await client.getJson('/api/box/info');
    if (info['boxId'] != b.boxId) {
      throw const BoxUnreachable('bukan kotak ini');
    }
    final HealthDto health;
    try {
      health = HealthDto.fromJson(await client.getJson('/api/health'));
    } on BoxError {
      rethrow;
    } on Object {
      throw const BoxUnreachable('jawapan kesihatan tidak sah');
    }
    return (located: Located(base: origin, via: 'box', health: health), ip: ip);
  }

  /// The name through discovery, then through the system resolver.
  Future<({Located located, String? ip})> _byName(
    EnrolledBox b,
    String name,
  ) async {
    final origin = _origin(b, name);
    final seen = await _discover();
    for (final d in seen) {
      if (d.name != name) continue;
      // The TXT id is a hint that saves a probe; the boxId check decides.
      if (d.id != null && d.id != b.boxId) continue;
      try {
        return await _probe(b, origin, d.ip);
      } on BoxUnreachable {
        // try the next
      } on BoxError {
        // try the next
      }
    }
    try {
      return await _probe(b, origin, null);
    } on Object {
      // The name's route (or the system resolver) failed: a stale name to
      // address entry must not outlive its failure.
      routes.remove(name);
      rethrow;
    }
  }

  Future<Located> _race(EnrolledBox b, String name) {
    final done = Completer<Located>();
    var open = 0;
    Object? last;
    TrustError? trust;

    void fail(Object e) {
      if (e is TrustError) trust = e;
      last = e;
      if (--open == 0 && !done.isCompleted) {
        done.completeError(
          trust ?? (last is BoxUnreachable ? last! : BoxUnreachable(last)),
        );
      }
    }

    void start(Future<({Located located, String? ip})> Function() f) {
      open++;
      f().then((r) {
        if (done.isCompleted) return;
        final host = r.located.base.host;
        if (r.ip != null && host == name) {
          routes.set(name, r.ip!);
        } else if (isIpv4(host)) {
          // Reached by address: the name follows that address only when the
          // box (boxId verified, pinned CA) says it carries this name; else
          // the old route is dropped.
          if (r.located.health.name == name) {
            routes.set(name, host);
          } else {
            routes.remove(name);
          }
        }
        try {
          onReached?.call(
            r.ip ?? (isIpv4(r.located.base.host) ? r.located.base.host : null),
          );
        } on Object {
          // remembering the address never fails a locate
        }
        done.complete(r.located);
      }, onError: fail);
    }

    final ips = <String>{?b.lastIp, if (isIpv4(b.box.host)) b.box.host};
    for (final ip in ips) {
      start(() => _probe(b, _origin(b, ip), null));
    }
    start(() => _byName(b, name));
    return done.future;
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
