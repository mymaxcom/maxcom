// The whole app over a fake world (the box at 127.0.0.1, the MAXCOM cloud
// at api.mymaxcom.my), with a sealed local store:
//
// * cold start with no network and a kept profile lands in the app offline
//   (auto mode at once, PIN mode after the local PIN);
// * box down, cloud up: the unlock happens at the cloud by itself, the
//   gateway talks to the cloud with the cloud's token; when the box comes
//   back the app switches silently, never through /unlock;
// * box down, cloud waking: progress, a signed wake, an automatic retry;
// * a phone enrolled with no cloud keeps the one the box's health names;
// * an edit made offline waits in the outbox and is pushed after reconnect.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/shell/box_gateway.dart' show LiveOnly;
import 'package:surau_app/features/live/live_screen.dart'
    show livePublisherProvider;
import 'package:surau_app/features/unlock/offline_vault.dart';
import 'package:surau_app/features/unlock/pin_pad.dart';
import 'package:surau_app/features/unlock/session_keeper.dart';
import 'package:surau_app/main.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../sync/sync_fakes.dart';

Future<Uint8List> _inline(String pin, Uint8List salt, int it) async =>
    pbkdf2Sha256(pin, salt, it);

class World {
  World({this.lockOn = false});

  bool lockOn;
  bool boxUp = true;
  bool cloudUp = true;

  /// The cloud's Worker answers 503 with this Retry-After.
  int? cloudWaking;

  /// `cloud` in the box's health answer.
  String? healthCloud;
  final FakeSyncServer sync = FakeSyncServer();
  final List<http.Request> seen = [];

  late final FakeBox fake = FakeBox(handle);

  static const boxHost = '127.0.0.1';
  static const cloudHost = 'api.mymaxcom.my';

  List<http.Request> at(String host, String path) => [
    for (final r in seen)
      if (r.url.host == host && r.url.path == path) r,
  ];

  Future<http.Response> handle(http.Request r) async {
    seen.add(r);
    final atBox = r.url.host == boxHost;
    if (atBox && !boxUp) throw http.ClientException('box away');
    if (!atBox && !cloudUp) throw http.ClientException('no network');
    if (!atBox && r.url.path == '/wake') {
      return http.Response('', cloudWaking == null ? 204 : 202);
    }
    final waking = cloudWaking;
    if (!atBox && waking != null) {
      return jsonResponse(503, {
        'state': 'waking',
      }, headers: {'retry-after': '$waking'});
    }
    final via = atBox ? 'box' : 'cloud';
    switch (r.url.path) {
      case '/api/health':
        return jsonResponse(200, {
          'ok': true,
          'version': 1,
          if (atBox && healthCloud != null) 'cloud': healthCloud,
        });
      case '/api/auth/challenge':
        return jsonResponse(200, {
          'nonce': 'n-$via',
          'expiresAt': 'x',
          'appLock': lockOn,
        });
      case '/api/auth/unlock':
        return jsonResponse(200, {
          ...sessionJson,
          'token': 'tok-$via',
        });
      case '/api/surau/info':
        return jsonResponse(200, fixtureInfoJson);
      case '/api/sync/ops':
      case '/api/sync/changes':
      case '/api/sync/snapshot':
        return sync.handle(r);
    }
    return jsonResponse(200, <String, Object?>{});
  }
}

class Rig {
  Rig(this.world, {this.withProfile = false, String? pin}) {
    final enrolled = fixtureBox(appLock: world.lockOn);
    boxes = MemoryEnrolledBoxStore()..save(enrolled);
    vault = OfflineVault(
      store: store,
      now: fixedNow,
      derive: _inline,
      iterations: 1000,
      minIterations: 1000,
    );
    deps = AppDeps(
      boxStore: boxes,
      surauInfoStore: MemorySurauInfoStore(
        SurauInfo.fromJson(fixtureInfoJson),
      ),
      key: FakeDeviceKey(present: true),
      trust: FakeTrust(),
      biometric: FakeBiometricPin(),
      clientFor: (uri) => world.fake.client(uri),
      enrolledClient: (b) async => world.fake.client(b.box),
      platform: 'android',
      cameraAvailable: false,
      scannerBuilder: (_, _, _) => const SizedBox.shrink(),
      healthPollInterval: null,
      now: fixedNow,
      toLocal: fixedToLocal,
      initialBox: enrolled,
      initialSurau: SurauInfo.fromJson(fixtureInfoJson),
      localStoreBuilder: () => store,
    );
    container = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(deps),
        offlineVaultProvider.overrideWith((ref) async => vault),
        livePublisherProvider.overrideWithValue(FakePublisher()),
      ],
    );
    _pin = pin;
  }

  final World world;
  final bool withProfile;
  final MemoryLocalStore store = MemoryLocalStore();
  late final MemoryEnrolledBoxStore boxes;
  late final OfflineVault vault;
  late final AppDeps deps;
  late final ProviderContainer container;
  String? _pin;

  Future<void> seed() async {
    if (withProfile) {
      await vault.saveProfile(
        OfflineProfile(
          userId: 'u1',
          name: 'Ustaz Ali',
          roles: const ['admin'],
          at: DateTime.utc(2026, 11, 10),
          surauName: 'Surau D\'Waqaf',
        ),
      );
    }
    final pin = _pin;
    if (pin != null) await vault.savePin(pin);
  }

  SessionDto? get session => container.read(sessionProvider);

  String get location => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .uri
      .path;

  Future<void> start(WidgetTester t) async {
    SharedPreferences.setMockInitialValues({});
    await t.runAsync(seed);
    await t.pumpWidget(
      UncontrolledProviderScope(container: container, child: const SurauApp()),
    );
    await frames(t);
  }

  /// Unmounts the app and ends every provider (engine and reconnector
  /// timers with them).
  Future<void> stop(WidgetTester t) async {
    await t.pumpWidget(const SizedBox.shrink());
    container.dispose();
    await t.pump();
  }
}

Future<void> frames(WidgetTester t, [int n = 6]) async {
  for (var i = 0; i < n; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> typeDigits(WidgetTester t, String digits) async {
  for (final d in digits.split('')) {
    await t.tap(find.widgetWithText(PinKey, d));
    await t.pump();
  }
  await frames(t);
}

const _banner =
    'Luar talian: menggunakan data tersimpan. Perubahan akan diselaraskan '
    'secara automatik.';

void main() {
  testWidgets('cold start, no network, auto mode: straight into the app '
      'offline, with the calm banner', (t) async {
    final world = World()
      ..boxUp = false
      ..cloudUp = false;
    final rig = Rig(world, withProfile: true);
    await rig.start(t);
    await frames(t, 10);
    expect(rig.session?.offline, isTrue);
    expect(rig.session?.user.name, 'Ustaz Ali');
    expect(rig.location, AppRoutes.dashboard);
    expect(find.text(_banner), findsWidgets);
    expect(rig.container.read(rolesProvider), {'admin'});
    await rig.stop(t);
  });

  testWidgets('cold start, no network, PIN mode: in after the local PIN; the '
      'PIN is kept in memory only', (t) async {
    final world = World(lockOn: true)
      ..boxUp = false
      ..cloudUp = false;
    final rig = Rig(world, withProfile: true, pin: '280419');
    await rig.start(t);
    expect(rig.location, AppRoutes.unlock);
    await typeDigits(t, '280419');
    await frames(t, 10);
    expect(rig.session?.offline, isTrue);
    expect(rig.location, AppRoutes.dashboard);
    expect(rig.container.read(pinMemoryProvider).value, '280419');
    await rig.stop(t);
  });

  testWidgets('a never-unlocked phone keeps the unlock screen and retries',
      (t) async {
    final world = World()
      ..boxUp = false
      ..cloudUp = false;
    final rig = Rig(world);
    await rig.start(t);
    await frames(t, 10);
    expect(rig.location, AppRoutes.unlock);
    expect(find.text('MAXCOM tidak dapat dihubungi'), findsOneWidget);
    world.boxUp = true;
    await t.pump(const Duration(seconds: 10));
    await frames(t, 10);
    expect(rig.session?.via, 'box');
    expect(rig.location, AppRoutes.dashboard);
    await rig.stop(t);
  });

  testWidgets('box down, cloud up: unlocks at the cloud by itself; then the '
      'box returns and the app switches silently', (t) async {
    final world = World()..boxUp = false;
    final rig = Rig(world);
    await rig.start(t);
    await frames(t, 10);
    final atCloud = rig.session!;
    expect(atCloud.via, 'cloud');
    expect(atCloud.token, 'tok-cloud');
    expect(atCloud.base, Uri.parse('https://api.mymaxcom.my'));
    expect(rig.location, AppRoutes.dashboard);
    expect(rig.container.read(isCloudGatewayProvider), isTrue);
    // The cloud tried was the default: this box never named one.
    expect(world.at(World.cloudHost, '/api/auth/unlock'), hasLength(1));
    final gw = rig.container.read(gatewayProvider)!;
    expect(gw.client.box.host, World.cloudHost);
    expect(gw.token, 'tok-cloud');
    // The profile for the next offline start was kept (never a token).
    final kept = await t.runAsync(() => rig.vault.profile());
    expect(kept?.userId, 'u1');
    expect(jsonEncode(await t.runAsync(() => rig.store.list('offline'))),
        isNot(contains('tok-')));

    world.boxUp = true;
    var visitedUnlock = false;
    rig.container.read(routerProvider).routerDelegate.addListener(() {
      if (rig.location == AppRoutes.unlock) visitedUnlock = true;
    });
    // The reconnector probes the box after 15 s.
    await t.pump(const Duration(seconds: 15));
    await frames(t, 10);
    expect(rig.session?.via, 'box');
    expect(rig.session?.token, 'tok-box');
    expect(rig.container.read(isCloudGatewayProvider), isFalse);
    final gw2 = rig.container.read(gatewayProvider)!;
    expect(gw2.client.box.host, World.boxHost);
    expect(gw2.token, 'tok-box');
    expect(visitedUnlock, isFalse);
    expect(rig.location, AppRoutes.dashboard);
    await rig.stop(t);
  });

  testWidgets('box down, cloud waking: a signed wake, progress, then in by '
      'itself after Retry-After', (t) async {
    final world = World()
      ..boxUp = false
      ..cloudWaking = 35;
    final rig = Rig(world);
    await rig.start(t);
    await frames(t, 10);
    expect(rig.location, AppRoutes.unlock);
    expect(find.text('Menghidupkan awan MAXCOM...'), findsOneWidget);
    expect(find.text('Cuba lagi'), findsNothing);
    final wake = world.at(World.cloudHost, '/wake');
    expect(wake, hasLength(1));
    expect(wake.single.method, 'POST');
    expect(wake.single.headers['x-maxcom-device'], 'dev-1');
    expect(wake.single.headers['x-maxcom-sig'], isNotEmpty);
    world.cloudWaking = null;
    await t.pump(const Duration(seconds: 35));
    await frames(t, 10);
    expect(rig.session?.via, 'cloud');
    expect(rig.location, AppRoutes.dashboard);
    await rig.stop(t);
  });

  testWidgets('a phone enrolled with no cloud keeps the one the box health '
      'names (and only a MAXCOM https origin)', (t) async {
    final world = World()..healthCloud = 'https://eu.mymaxcom.my';
    final rig = Rig(world);
    expect(rig.deps.initialBox!.cloud, isNull);
    await rig.start(t);
    await frames(t, 10);
    expect(rig.session?.via, 'box');
    final box = rig.container.read(enrolledBoxProvider)!;
    expect(box.cloud, Uri.parse('https://eu.mymaxcom.my'));
    final saved = await t.runAsync(() => rig.boxes.load());
    expect(saved!.cloud, Uri.parse('https://eu.mymaxcom.my'));
    await rig.stop(t);

    final world2 = World()..healthCloud = 'https://evil.example';
    final rig2 = Rig(world2);
    await rig2.start(t);
    await frames(t, 10);
    expect(rig2.container.read(enrolledBoxProvider)!.cloud, isNull);
    await rig2.stop(t);
  });

  testWidgets('an edit made offline waits in the outbox and is pushed after '
      'the reconnect (PIN from memory)', (t) async {
    final world = World(lockOn: true)
      ..boxUp = false
      ..cloudUp = false;
    final rig = Rig(world, withProfile: true, pin: '280419');
    await rig.start(t);
    await typeDigits(t, '280419');
    await frames(t, 10);
    expect(rig.session?.offline, isTrue);

    final gw = rig.container.read(gatewayProvider)!;
    await t.runAsync(
      () => gw.put('/api/settings/clock', {
        'enabled': true,
        'showSeconds': true,
      }),
    );
    final engine = rig.container.read(syncEngineProvider)!;
    expect(await t.runAsync(() => engine.outbox.count), 1);
    expect(world.sync.opBatches, isEmpty);
    // A live-only action says it needs a connection (nothing is queued).
    Object? refused;
    await t.runAsync(() async {
      try {
        await gw.post('/api/enrol/begin', {'userId': 'u2'});
      } on Object catch (e) {
        refused = e;
      }
    });
    expect(refused, isA<LiveOnly>());
    expect(LiveOnly.message, 'Perlukan sambungan ke MAXCOM atau awan');
    expect(await t.runAsync(() => engine.outbox.count), 1);

    world
      ..boxUp = true
      ..cloudUp = true;
    rig.container.read(sessionKeeperProvider).kick();
    await frames(t, 20);
    expect(rig.session?.via, 'box');
    expect(rig.location, AppRoutes.dashboard);
    // The silent unlock sent the PIN kept in memory.
    final unlocks = world.at(World.boxHost, '/api/auth/unlock');
    expect(jsonDecode(unlocks.last.body)['pin'], '280419');
    await t.runAsync(() => pumpEventQueue());
    await frames(t, 10);
    expect(world.sync.opBatches, isNotEmpty);
    final ops = (world.sync.opBatches.last['ops'] as List)
        .cast<Map<String, dynamic>>();
    expect(ops.single['kind'], 'settings.put');
    expect(ops.single['entityId'], 'clock');
    await rig.stop(t);
  });
}
