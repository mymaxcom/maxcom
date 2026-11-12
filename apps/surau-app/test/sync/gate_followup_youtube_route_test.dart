// Gate follow-up item 3 (plan Task 8): the YouTube sign-in routes
// (`/api/live/youtube/*`) and `/api/youtube/*` go to the CLOUD when cloudSync
// is on and the box knows a cloud URL (and this device holds a session
// there), and to the box otherwise. Every other route stays on the box.

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

  test('cloud known, cloudSync on (default): sign-in goes to the cloud with '
      'the cloud token', () async {
    final gw = await gateway(cloudUrl: _cloudUri);
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'cloud');
    expect(box.seen, isEmpty);
    expect(cloud.seen.single.url.path, '/api/live/youtube/signin');
    expect(cloud.seen.single.headers['authorization'], contains('cloud-tok'));
    expect(
      cloud.seen.single.headers['authorization'],
      isNot(contains('box-tok')),
    );
  });

  test('the poll, sign-out, the status read and /api/youtube/* all go to the '
      'cloud; /api/live/start and /api/live/status stay on the box', () async {
    final gw = await gateway(cloudUrl: _cloudUri);
    await gw.post('/api/live/youtube/signin/poll', const {});
    await gw.post('/api/live/youtube/signout', const {});
    await gw.getFresh('/api/live/youtube/status');
    await gw.getFresh('/api/youtube/quota');
    expect(cloud.seen.map((r) => r.url.path), [
      '/api/live/youtube/signin/poll',
      '/api/live/youtube/signout',
      '/api/live/youtube/status',
      '/api/youtube/quota',
    ]);
    expect(box.seen, isEmpty);

    await gw.post('/api/live/start', const {});
    await gw.getFresh('/api/live/status');
    expect(box.seen.map((r) => r.url.path), [
      '/api/live/start',
      '/api/live/status',
    ]);
    expect(cloud.seen, hasLength(4));
  });

  test('the clean-up check POST /api/youtube/verify goes to the cloud when '
      'linked, to the box when not', () async {
    final linked = await gateway(cloudUrl: _cloudUri);
    await linked.post('/api/youtube/verify', const {'videoIds': ['a']});
    expect(cloud.seen.single.url.path, '/api/youtube/verify');
    expect(box.seen, isEmpty);

    final unlinked = await gateway();
    await unlinked.post('/api/youtube/verify', const {'videoIds': ['a']});
    expect(box.seen.single.url.path, '/api/youtube/verify');
  });

  test('no cloud URL known: the box', () async {
    final gw = await gateway();
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'box');
    expect(cloud.seen, isEmpty);
  });

  test('cloudSync switched off: the box', () async {
    await store.putDoc('settings', 'cloudSync', {
      '_feature': 'cloudSync',
      'enabled': false,
      'rev': 'r1',
    });
    final gw = await gateway(cloudUrl: _cloudUri);
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'box');
    expect(cloud.seen, isEmpty);
  });

  test('cloudSync on in the local settings: the cloud', () async {
    await store.putDoc('settings', 'cloudSync', {
      '_feature': 'cloudSync',
      'enabled': true,
      'rev': 'r1',
    });
    final gw = await gateway(cloudUrl: _cloudUri);
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'cloud');
  });

  test('no session on the cloud yet: the box answers, and the box token is '
      'never sent to the cloud', () async {
    final gw = await gateway(cloudUrl: _cloudUri, cloudToken: null);
    final out = await gw.post('/api/live/youtube/signin', const {});
    expect(out['from'], 'box');
    expect(cloud.seen, isEmpty);
  });

  test('cloud does not answer: LiveOnly, the box is not asked instead',
      () async {
    cloudAway = true;
    final gw = await gateway(cloudUrl: _cloudUri);
    await expectLater(
      gw.post('/api/live/youtube/signin', const {}),
      throwsA(isA<LiveOnly>()),
    );
    expect(box.seen, isEmpty);
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
