import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/box/device_key_software.dart';
import 'package:surau_app/sync/cloud_wake.dart';

final Uri _cloud = Uri.parse('https://203.0.113.10');

void main() {
  late SoftwareDeviceKey key;
  late List<http.Request> seen;
  late int status;
  late Map<String, String> reply;
  late DateTime t;
  late int? saved;

  CloudWake make({int? loaded, Duration gap = const Duration(minutes: 10)}) {
    saved = null;
    return CloudWake(
      clientFor: (cloud) async => BoxClient(
        cloud,
        MockClient((r) async {
          seen.add(r);
          return http.Response('', status, headers: reply);
        }),
      ),
      key: key,
      boxId: '0123456789abcdef',
      deviceId: 'dev-1',
      now: () => t,
      minGap: gap,
      loadLast: () async => loaded,
      saveLast: (ms) async => saved = ms,
    );
  }

  setUp(() {
    key = SoftwareDeviceKey.random();
    seen = [];
    status = 204;
    reply = {};
    t = DateTime.utc(2026, 11, 5, 10);
  });

  test(
    'POST /wake: empty body, device headers, P1363 signature that verifies',
    () async {
      final w = make();
      final out = await w.wake(_cloud);
      expect(out.result, WakeResult.up);
      final r = seen.single;
      expect(r.method, 'POST');
      expect(r.url.toString(), 'https://203.0.113.10/wake');
      expect(r.body, isEmpty);
      final ts = r.headers['X-Maxcom-Ts'] ?? r.headers['x-maxcom-ts'];
      expect(ts, '${t.millisecondsSinceEpoch}');
      expect(
        r.headers['X-Maxcom-Device'] ?? r.headers['x-maxcom-device'],
        'dev-1',
      );
      expect(
        r.headers['X-Maxcom-Box'] ?? r.headers['x-maxcom-box'],
        '0123456789abcdef',
      );
      final sig = unB64url(
        (r.headers['X-Maxcom-Sig'] ?? r.headers['x-maxcom-sig'])!,
      );
      expect(sig.length, 64);
      final msg = utf8.encode('maxcom-wake-dev\n0123456789abcdef\ndev-1\n$ts');
      expect(
        verifyP256(await key.publicJwk(), Uint8List.fromList(msg), sig),
        isTrue,
      );
      // Not the unlock family and not the op family.
      final wrong = utf8.encode('surau-unlock\n0123456789abcdef\ndev-1\n$ts');
      expect(
        verifyP256(await key.publicJwk(), Uint8List.fromList(wrong), sig),
        isFalse,
      );
    },
  );

  test('at most once per 10 minutes per device', () async {
    final w = make();
    expect((await w.wake(_cloud)).result, WakeResult.up);
    t = t.add(const Duration(minutes: 9));
    expect((await w.wake(_cloud)).result, WakeResult.debounced);
    expect(seen, hasLength(1));
    t = t.add(const Duration(minutes: 2));
    expect((await w.wake(_cloud)).result, WakeResult.up);
    expect(seen, hasLength(2));
    expect(saved, t.millisecondsSinceEpoch);
  });

  test('the debounce survives a restart (loaded from the store)', () async {
    final w = make(
      loaded: t.subtract(const Duration(minutes: 3)).millisecondsSinceEpoch,
    );
    expect((await w.wake(_cloud)).result, WakeResult.debounced);
    expect(seen, isEmpty);
    expect((await w.wake(_cloud, force: true)).result, WakeResult.up);
  });

  test(
    'answers: 202 waking with Retry-After, 401, 429, 500 and no network',
    () async {
      status = 202;
      reply = {'retry-after': '60'};
      var w = make();
      var out = await w.wake(_cloud);
      expect(out.result, WakeResult.waking);
      expect(out.retryAfterSec, 60);
      status = 401;
      w = make();
      expect((await w.wake(_cloud)).result, WakeResult.refused);
      status = 429;
      w = make();
      expect((await w.wake(_cloud)).result, WakeResult.limited);
      status = 500;
      w = make();
      expect((await w.wake(_cloud)).result, WakeResult.failed);
      final down = CloudWake(
        clientFor: (c) async => BoxClient(
          c,
          MockClient((r) async => throw http.ClientException('x')),
        ),
        key: key,
        boxId: 'b',
        deviceId: 'd',
      );
      out = await down.wake(_cloud);
      expect(out.result, WakeResult.failed);
    },
  );

  test('wakeSoon never throws and does not block', () async {
    final w = CloudWake(
      clientFor: (c) async => throw StateError('no client'),
      key: key,
      boxId: 'b',
      deviceId: 'd',
    );
    w.wakeSoon(_cloud); // returns at once
    await Future<void>.delayed(Duration.zero);
  });

  group('ForegroundWaker', () {
    Future<bool> run({
      required bool box,
      required int outbox,
      Uri? cloud,
      Duration probe = const Duration(milliseconds: 50),
      Future<bool> Function()? reachable,
    }) {
      final w = make();
      final waker = ForegroundWaker(
        wake: w,
        boxReachable: reachable ?? () async => box,
        outboxCount: () async => outbox,
        cloud: () => cloud,
        boxProbe: probe,
      );
      return waker.onForegroundForTest();
    }

    test('box reachable and nothing queued: no wake', () async {
      expect(await run(box: true, outbox: 0, cloud: _cloud), isFalse);
    });

    test('box not reachable: wake', () async {
      expect(await run(box: false, outbox: 0, cloud: _cloud), isTrue);
    });

    test('edits waiting: wake even on the surau network', () async {
      expect(await run(box: true, outbox: 2, cloud: _cloud), isTrue);
    });

    test(
      'a box that does not answer within the probe counts as away',
      () async {
        final slow = Completer<bool>();
        expect(
          await run(
            box: true,
            outbox: 0,
            cloud: _cloud,
            reachable: () => slow.future,
          ),
          isTrue,
        );
      },
    );

    test('no cloud linked: nothing', () async {
      expect(await run(box: false, outbox: 3), isFalse);
    });
  });
}
