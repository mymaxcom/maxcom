// Build 5 gate fixes (app side): the microphone test call and the per-TV show switch.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../fakes.dart';

class _Gateway extends BoxGateway {
  _Gateway({required super.client, required super.reach}) : super(token: 'tok-1', cache: ReadCache(store: null, boxId: 'b'), now: fixedNow, onSessionExpired: () {});

  Duration? slowRead;

  @override
  Future<Map<String, dynamic>> postSlow(String path, Object body, {required Duration read}) {
    slowRead = read;
    return super.postSlow(path, body, read: read);
  }
}

/// Settings that a test serves and can hold back.
Map<String, dynamic> _served = {};
Completer<void>? _hold;

class _Settings extends SettingsNotifier {
  @override
  Future<Read<Map<String, dynamic>>?> build() async {
    final h = _hold;
    if (h != null) await h.future;
    return Read(Map<String, dynamic>.of(_served), at: fixedNow(), stale: false);
  }
}

class _Env {
  _Env(Map<String, Future<http.Response> Function(http.Request)> routes) {
    box = FakeBox((r) async {
      final h = routes['${r.method} ${r.url.path}'];
      if (h == null) return jsonResponse(404, {'errors': ['tiada']});
      return h(r);
    });
    container = ProviderContainer(
      overrides: [
        gatewayProvider.overrideWith(
          (ref) => gateway = _Gateway(client: box.client(Uri.parse('https://box.test:8443')), reach: ref.watch(connectivityProvider.notifier)),
        ),
        settingsProvider.overrideWith(_Settings.new),
      ],
    );
    addTearDown(container.dispose);
  }

  late final FakeBox box;
  late final ProviderContainer container;
  late _Gateway gateway;
}

Map<String, Object?> _list() => {
  'selected': 'A',
  'devices': [
    {'name': 'A', 'usable': true},
    {'name': 'B', 'usable': true},
  ],
};

Map<String, Object?> _result(String at, {String selected = 'A'}) => {
  'testedAt': at,
  'results': [
    {'name': 'A', 'code': 'silent', 'meanDb': -90, 'selected': selected == 'A'},
    {'name': 'B', 'code': 'ok', 'meanDb': -30, 'selected': selected == 'B'},
  ],
};

String _later() => DateTime.now().add(const Duration(minutes: 5)).toUtc().toIso8601String();

void main() {
  setUp(() {
    _served = {};
    _hold = null;
  });

  group('microphone test', () {
    test('the test call has a 25 s read budget', () async {
      final e = _Env({
        'GET /api/live/audio-inputs': (r) async => jsonResponse(200, _list()),
        'POST /api/live/audio-inputs/test': (r) async => jsonResponse(200, _result(_later())),
      });
      final n = e.container.read(boxMicTestProvider.notifier);
      await n.loadDevices();
      await n.test();
      expect(e.gateway.slowRead, const Duration(seconds: 25));
      expect(e.container.read(boxMicTestProvider).devices.firstWhere((d) => d.name == 'B').code, 'ok');
    });

    test('a failed call shows the box\'s last result when it is newer than this test', () async {
      final e = _Env({
        'GET /api/live/audio-inputs': (r) async => jsonResponse(200, _list()),
        'POST /api/live/audio-inputs/test': (r) async => jsonResponse(500, {'errors': ['x']}),
        'GET /api/live/audio-inputs/test': (r) async => jsonResponse(200, _result(_later())),
      });
      final n = e.container.read(boxMicTestProvider.notifier);
      await n.loadDevices();
      await n.test();
      final st = e.container.read(boxMicTestProvider);
      expect(st.testing, isFalse);
      expect(st.testedAt, isNotNull);
      expect(st.devices.firstWhere((d) => d.name == 'A').code, 'silent');
      expect(st.devices.firstWhere((d) => d.name == 'B').code, 'ok');
    });

    test('a last result older than this test is not shown', () async {
      final e = _Env({
        'GET /api/live/audio-inputs': (r) async => jsonResponse(200, _list()),
        'POST /api/live/audio-inputs/test': (r) async => jsonResponse(500, {'errors': ['x']}),
        'GET /api/live/audio-inputs/test': (r) async => jsonResponse(200, _result('2020-01-01T00:00:00.000Z')),
      });
      final n = e.container.read(boxMicTestProvider.notifier);
      await n.loadDevices();
      await n.test();
      final st = e.container.read(boxMicTestProvider);
      expect(st.testing, isFalse);
      expect(st.testedAt, isNull);
      expect(st.devices.every((d) => d.code == null), isTrue);
    });

    test('a pick made while the test runs is kept when the result arrives', () async {
      final release = Completer<void>();
      final e = _Env({
        'GET /api/live/audio-inputs': (r) async => jsonResponse(200, _list()),
        'PUT /api/live/audio-input': (r) async => jsonResponse(200, {'ok': true}),
        'POST /api/live/audio-inputs/test': (r) async {
          await release.future;
          return jsonResponse(200, _result(_later(), selected: 'A'));
        },
      });
      final n = e.container.read(boxMicTestProvider.notifier);
      await n.loadDevices();
      final running = n.test();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(e.container.read(boxMicTestProvider).testing, isTrue);
      expect(await n.pick('B'), isTrue);
      release.complete();
      await running;
      final st = e.container.read(boxMicTestProvider);
      expect(st.devices.firstWhere((d) => d.name == 'B').selected, isTrue);
      expect(st.devices.firstWhere((d) => d.name == 'A').selected, isFalse);
      expect(st.devices.firstWhere((d) => d.name == 'B').code, 'ok', reason: 'the result itself is still shown');
    });
  });

  group('TV show switch', () {
    test('the chosen value stays until the refreshed settings carry it', () async {
      final e = _Env({
        'PUT /api/live/tv-show': (r) async {
          _served = {'tvProfiles': {'tvs': {'self': {'live': {'show': false}}}}};
          return jsonResponse(200, {'ok': true});
        },
      });
      e.container.listen(settingsProvider, (_, _) {});
      await e.container.read(settingsProvider.future);
      _hold = Completer<void>();
      final done = e.container.read(liveTvShowProvider.notifier).set('self', false);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      var st = e.container.read(liveTvShowProvider);
      expect(st.pending, {'self': false}, reason: 'no flicker back while the settings are read again');
      _hold!.complete();
      expect(await done, isTrue);
      st = e.container.read(liveTvShowProvider);
      expect(st.pending, isEmpty);
      expect(st.busy, isEmpty);
    });

    test('a failed save puts the old value back', () async {
      final e = _Env({
        'PUT /api/live/tv-show': (r) async => jsonResponse(500, {'errors': ['x']}),
      });
      final ok = await e.container.read(liveTvShowProvider.notifier).set('self', false);
      expect(ok, isFalse);
      final st = e.container.read(liveTvShowProvider);
      expect(st.pending, isEmpty);
      expect(st.busy, isEmpty);
    });
  });
}
