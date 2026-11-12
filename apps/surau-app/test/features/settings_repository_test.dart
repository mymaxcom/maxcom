// The settings data layer over a fake box: load with the read cache, save
// only changed keys, reset to defaults, typed errors, and the offline
// refusal (`Cuba lagi di surau`, no request sent).

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/settings_repository.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import 'fakes.dart';

class _Reach implements ReachSink {
  BoxReach state = BoxReach.unknown;

  @override
  BoxReach get reach => state;

  @override
  void markUp(DateTime at) => state = state.up(at);

  @override
  void markDown(DateTime at) => state = state.failed(at);
}

final _t0 = DateTime.utc(2026, 11, 4, 14);

Map<String, dynamic> _allSettings() => {
  for (final f in features)
    f.key: {
      'enabled': f.defaultEnabled,
      ...jsonDecode(jsonEncode(f.defaults)) as Map<String, dynamic>,
    },
};

class _Rig {
  _Rig(Future<http.Response> Function(http.Request r) handler) {
    box = FakeBox(handler);
    gateway = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: cache,
      reach: reach,
      now: () => _t0,
      onSessionExpired: () => expired++,
    );
    repo = SettingsRepository(gateway, onSaved: () => saved++);
  }

  late final FakeBox box;
  final cache = ReadCache();
  final reach = _Reach();
  late final BoxGateway gateway;
  late final SettingsRepository repo;
  int expired = 0;
  int saved = 0;
}

void main() {
  group('diffPatch', () {
    test('only changed keys, nested down to the changed cell', () {
      final original = {
        'minutes': {
          'jumaat': {'subuh': 12, 'zohor': 10},
          'isnin': {'subuh': 12},
        },
        'beep': true,
        'endWarningSeconds': 30,
      };
      final edited = {
        'minutes': {
          'jumaat': {'subuh': 15, 'zohor': 10},
          'isnin': {'subuh': 12},
        },
        'beep': true,
        'endWarningSeconds': 30,
      };
      expect(diffPatch(original, edited), {
        'minutes': {
          'jumaat': {'subuh': 15},
        },
      });
    });

    test('nothing changed gives an empty patch; lists go whole', () {
      final original = {
        'images': ['a', 'b'],
        'rotate': 'daily',
      };
      expect(diffPatch(original, {...original}), isEmpty);
      expect(
        diffPatch(original, {
          'images': ['a'],
          'rotate': 'daily',
        }),
        {
          'images': ['a'],
        },
      );
    });

    test('the logo image reference goes whole: a changed part sends the asset with it', () {
      const id = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
      final original = {
        'name': 'Surau',
        'logo': {'asset': id, 'crop': {'x': 0.1, 'y': 0, 'w': 0.8, 'h': 1}, 'bg': 'remove'},
      };
      final edited = {
        'name': 'Surau',
        'logo': {'asset': id, 'crop': {'x': 0.1, 'y': 0, 'w': 0.8, 'h': 1}, 'bg': 'card'},
      };
      expect(diffPatch(original, edited), {'logo': edited['logo']}, reason: 'not {logo: {bg: card}}');
      expect(diffPatch(original, {...original, 'logo': id}), {'logo': id});
      expect(diffPatch(original, {'name': 'Surau', 'logo': {...original['logo']! as Map}}), isEmpty);
    });

    test('a null that becomes text and back', () {
      expect(diffPatch({'override': null}, {'override': 'light'}), {
        'override': 'light',
      });
      expect(diffPatch({'override': 'light'}, {'override': null}), {
        'override': null,
      });
    });
  });

  test('load returns the settings and then the cached copy offline', () async {
    var away = false;
    final rig = _Rig((r) async {
      if (away) throw http.ClientException('away');
      return jsonResponse(200, _allSettings());
    });
    final fresh = await rig.repo.load();
    expect(fresh.stale, isFalse);
    expect(fresh.value['iqamahCountdown'], isA<Map<String, dynamic>>());
    away = true;
    final cached = await rig.repo.load();
    expect(cached.stale, isTrue);
    expect(cached.value['clock'], isNotNull);
  });

  test('save sends PUT with only the patch and caches the answer', () async {
    final answer = _allSettings();
    final rig = _Rig((r) async => jsonResponse(200, answer));
    final out = await rig.repo.save('iqamahCountdown', {
      'minutes': {
        'jumaat': {'subuh': 15},
      },
    });
    expect(out, answer);
    final put = rig.box.seen.single;
    expect(put.method, 'PUT');
    expect(put.url.path, '/api/settings/iqamahCountdown');
    expect(jsonDecode(put.body), {
      'minutes': {
        'jumaat': {'subuh': 15},
      },
    });
    expect(put.headers['authorization'], 'Bearer tok-1');
    expect(rig.cache.get('/api/settings')?.body, answer);
    expect(rig.saved, 1);
  });

  test('resetToDefaults sends enabled plus every default', () async {
    final rig = _Rig((r) async => jsonResponse(200, _allSettings()));
    await rig.repo.resetToDefaults('iqamahCountdown');
    final body = jsonDecode(rig.box.seen.single.body) as Map<String, dynamic>;
    final f = features.firstWhere((x) => x.key == 'iqamahCountdown');
    expect(body['enabled'], f.defaultEnabled);
    expect(body.keys.toSet(), {'enabled', ...f.defaults.keys});
    expect((((body['minutes'] as Map<String, dynamic>)['jumaat']) as Map<String, dynamic>)['subuh'], 12);
    expect(rig.box.seen.single.url.path, '/api/settings/iqamahCountdown');

    await rig.repo.resetToDefaults('appLock');
    expect(jsonDecode(rig.box.seen.last.body), {'enabled': false});
    await rig.repo.resetToDefaults('clock');
    expect(jsonDecode(rig.box.seen.last.body), {
      'enabled': true,
      'showSeconds': false,
    });
  });

  test('reset of an unknown feature is not found and sends nothing', () async {
    final rig = _Rig((r) async => jsonResponse(200, _allSettings()));
    await expectLater(
      () => rig.repo.resetToDefaults('nope'),
      throwsA(
        isA<SettingsSaveError>().having(
          (e) => e.kind,
          'kind',
          SettingsFailure.notFound,
        ),
      ),
    );
    expect(rig.box.seen, isEmpty);
  });

  test('400 carries errors[0]', () async {
    final rig = _Rig(
      (r) async => jsonResponse(400, {
        'errors': ['minutes.jumaat.subuh must be an integer 0..120', 'second'],
      }),
    );
    await expectLater(
      rig.repo.save('iqamahCountdown', {
        'minutes': {
          'jumaat': {'subuh': -3},
        },
      }),
      throwsA(
        isA<SettingsSaveError>()
            .having((e) => e.kind, 'kind', SettingsFailure.invalid)
            .having(
              (e) => e.message,
              'message',
              'minutes.jumaat.subuh must be an integer 0..120',
            ),
      ),
    );
    expect(rig.saved, 0);
  });

  test('404 and 403 are typed with BM messages', () async {
    var status = 404;
    final rig = _Rig(
      (r) async => jsonResponse(status, {
        'errors': ['x'],
      }),
    );
    await expectLater(
      rig.repo.save('clock', {'showSeconds': true}),
      throwsA(
        isA<SettingsSaveError>()
            .having((e) => e.kind, 'kind', SettingsFailure.notFound)
            .having((e) => e.message, 'message', 'Ciri tidak dijumpai'),
      ),
    );
    status = 403;
    await expectLater(
      rig.repo.save('clock', {'showSeconds': true}),
      throwsA(
        isA<SettingsSaveError>()
            .having((e) => e.kind, 'kind', SettingsFailure.forbidden)
            .having(
              (e) => e.message,
              'message',
              'Tiada kebenaran untuk tindakan ini',
            ),
      ),
    );
  });

  test('401 on save is SessionExpired and clears the session', () async {
    final rig = _Rig(
      (r) async => jsonResponse(401, {
        'errors': ['Sesi tamat'],
      }),
    );
    await expectLater(
      rig.repo.save('clock', {'showSeconds': true}),
      throwsA(isA<SessionExpired>()),
    );
    expect(rig.expired, 1);
  });

  test('box away: the save is refused with Cuba lagi di surau', () async {
    var away = false;
    final rig = _Rig((r) async {
      if (away) throw http.ClientException('away');
      return jsonResponse(200, _allSettings());
    });
    await rig.repo.load();
    away = true;
    await rig.repo.load(); // the cached read marks the box down
    final before = rig.box.seen.length;
    await expectLater(
      rig.repo.save('clock', {'showSeconds': true}),
      throwsA(isA<OfflineWriteRefused>()),
    );
    expect(rig.box.seen.length, before, reason: 'no request left the device');
    expect(OfflineWriteRefused.message, contains('Cuba lagi di surau'));
  });

  test('a save that cannot reach the box is the same refusal', () async {
    final rig = _Rig((r) async => throw http.ClientException('away'));
    await expectLater(
      rig.repo.save('clock', {'showSeconds': true}),
      throwsA(isA<OfflineWriteRefused>()),
    );
  });
}
