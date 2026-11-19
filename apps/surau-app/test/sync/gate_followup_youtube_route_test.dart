// Release 2026.11.13 (YouTube held by the box only): the YouTube sign-in
// routes (`/api/live/youtube/*`) and `/api/youtube/*` go to the box this
// gateway talks to and NEVER to the cloud link, whatever cloudSync says. A box
// that does not answer is not replaced by the cloud: LiveOnly (the app says
// it is made on the surau Wi-Fi). (Before: plan Task 8 sent them to the cloud.)

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/transport.dart';

import '../features/fakes.dart';
import 'sync_fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

final Uri _cloudUri = Uri.parse('https://cloud.example');

EnrolledBox _enrolled({Uri? cloud}) {
  final b = fixtureBox();
  return EnrolledBox(
    box: b.box,
    boxId: b.boxId,
    deviceId: b.deviceId,
    userId: b.userId,
    userName: b.userName,
    roles: b.roles,
    caSha256: b.caSha256,
    appLock: b.appLock,
    cloud: cloud,
  );
}

/// The cloud-aware transport: gives a cloud link when a cloud token exists.
class _Transport extends FakeTransport implements CloudLinkSource {
  _Transport(super.server, this.cloudBox, {this.cloudToken = 'cloud-tok'});

  final FakeBox cloudBox;
  final String? cloudToken;

  @override
  Future<SyncLink?> cloudLink() async {
    final t = cloudToken;
    if (t == null) return null;
    return SyncLink(
      base: _cloudUri,
      via: 'cloud',
      client: cloudBox.client(_cloudUri),
      token: t,
    );
  }
}

class _NoLocator implements BoxLocator {
  @override
  Future<Located> locate(EnrolledBox box) =>
      throw const BoxUnreachable('tiada');
}

void main() {
  late MemoryLocalStore store;
  late FakeBox box;
  late FakeBox cloud;
  late bool cloudAway;

  Future<BoxGateway> gateway({
    Uri? cloudUrl,
    String? cloudToken = 'cloud-tok',
  }) async {
    final engine = SyncEngine(
      store: store,
      key: FakeDeviceKey(present: true),
      box: _enrolled(cloud: cloudUrl),
      transport: _Transport(FakeSyncServer(), cloud, cloudToken: cloudToken),
      now: fixedNow,
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    return BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'box-tok',
      cache: ReadCache(),
      reach: _Reach(),
      now: fixedNow,
      onSessionExpired: () {},
      store: store,
      engine: engine,
    );
  }

  setUp(() async {
    store = MemoryLocalStore();
    await store.open('0123456789abcdef');
    cloudAway = false;
    box = FakeBox((r) async => jsonResponse(200, {'from': 'box'}));
    cloud = FakeBox((r) async {
      if (cloudAway) throw http.ClientException('cloud away');
      return jsonResponse(200, {'from': 'cloud'});
    });
  });

  test('cloud known, cloudSync on (default): sign-in goes to the BOX with '
      'the box token; the cloud is never asked', () async {
    final gw = await gateway(cloudUrl: _cloudUri);
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'box');
    expect(cloud.seen, isEmpty);
    expect(box.seen.single.url.path, '/api/live/youtube/signin');
    expect(box.seen.single.headers['authorization'], contains('box-tok'));
  });

  test('the poll, sign-out, the status read, quota, upload begin/done and '
      'verify all go to the box; none reaches the cloud link', () async {
    final gw = await gateway(cloudUrl: _cloudUri);
    await gw.post('/api/live/youtube/signin/poll', const {});
    await gw.post('/api/live/youtube/signout', const {});
    await gw.getFresh('/api/live/youtube/status');
    await gw.getFresh('/api/youtube/quota');
    await gw.post('/api/youtube/upload/begin', const {'bytes': 1});
    await gw.post('/api/youtube/upload/done', const {'uploadId': 'u'});
    await gw.post('/api/youtube/verify', const {'videoIds': ['a']});
    expect(box.seen.map((r) => r.url.path), [
      '/api/live/youtube/signin/poll',
      '/api/live/youtube/signout',
      '/api/live/youtube/status',
      '/api/youtube/quota',
      '/api/youtube/upload/begin',
      '/api/youtube/upload/done',
      '/api/youtube/verify',
    ]);
    expect(cloud.seen, isEmpty);
  });

  test('cloudSync on in the local settings, or no cloud session: still the '
      'box', () async {
    await store.putDoc('settings', 'cloudSync', {
      '_feature': 'cloudSync',
      'enabled': true,
      'rev': 'r1',
    });
    final on = await gateway(cloudUrl: _cloudUri);
    expect((await on.post('/api/live/youtube/signin', const {}))['from'], 'box');
    final noSession = await gateway(cloudUrl: _cloudUri, cloudToken: null);
    expect((await noSession.post('/api/live/youtube/signin', const {}))['from'], 'box');
    expect(cloud.seen, isEmpty);
  });

  test('the box does not answer: LiveOnly for every YouTube route, and the '
      'cloud is never asked in its place', () async {
    box = FakeBox((r) async => throw http.ClientException('box away'));
    final gw = await gateway(cloudUrl: _cloudUri);
    for (final path in [
      '/api/live/youtube/signin',
      '/api/live/youtube/signin/poll',
      '/api/live/youtube/signout',
      '/api/youtube/upload/begin',
      '/api/youtube/upload/done',
      '/api/youtube/verify',
    ]) {
      await expectLater(
        gw.post(path, const {}),
        throwsA(isA<LiveOnly>()),
        reason: path,
      );
    }
    await expectLater(
      gw.getFresh('/api/live/youtube/status'),
      throwsA(anyOf(isA<LiveOnly>(), isA<BoxUnreachable>())),
    );
    expect(cloud.seen, isEmpty);
  });

  test('the route pattern: every YouTube route but the ingest read', () {
    for (final p in [
      '/api/live/youtube/signin',
      '/api/live/youtube/status',
      '/api/youtube/upload/begin',
      '/api/youtube/quota?x=1',
    ]) {
      expect(BoxGateway.youtubeRoute.hasMatch(p.split('?').first), isTrue, reason: p);
    }
    expect(BoxGateway.youtubeRoute.hasMatch('/api/live/youtube/ingest'), isFalse);
    // Q8: the next-live choice is not a "surau only" route, so it may go through the cloud when away
    expect(BoxGateway.youtubeRoute.hasMatch('/api/live/youtube/next-live'), isFalse);
    expect(BoxGateway.youtubeRoute.hasMatch('/api/live/youtube/next-liver'), isTrue);
    expect(BoxGateway.youtubeRoute.hasMatch('/api/live/status'), isFalse);
  });

  test('LocatorTransport.cloudLink: the cloud base with the cloud token, '
      'null with no cloud or no token', () async {
    final enrolled = _enrolled(cloud: _cloudUri);
    LocatorTransport build({required EnrolledBox b, String? token}) =>
        LocatorTransport(
          locator: _NoLocator(),
          box: () => b,
          clientFor: (base) async => cloud.client(base),
          tokenFor: (base) => base == _cloudUri ? token : 'box-tok',
        );
    final ok = await build(b: enrolled, token: 'ct').cloudLink();
    expect(ok!.via, 'cloud');
    expect(ok.base, _cloudUri);
    expect(ok.token, 'ct');
    expect(await build(b: enrolled).cloudLink(), isNull);
    expect(await build(b: _enrolled(), token: 'ct').cloudLink(), isNull);
  });
}
