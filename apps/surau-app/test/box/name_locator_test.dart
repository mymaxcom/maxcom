import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/discovery.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/box/routes.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';

const _id = 'a1b2c3d4e5f60718';
const _other = '0000000000000000';

EnrolledBox _enrolled({
  String? name,
  String? lastIp,
  String host = '10.168.0.10',
}) => EnrolledBox(
  box: Uri.parse('https://$host:8443'),
  boxId: _id,
  deviceId: 'dev1',
  userId: 'u1',
  userName: 'Ali',
  roles: const ['admin'],
  caSha256: 'ab',
  name: name,
  lastIp: lastIp,
);

class _Disc implements BoxDiscovery {
  _Disc(this.boxes, {this.gate});
  final List<DiscoveredBox> boxes;
  final Future<void>? gate;
  int calls = 0;

  @override
  Future<List<DiscoveredBox>> discover({
    Duration timeout = const Duration(seconds: 1),
  }) async {
    calls++;
    if (gate != null) await gate;
    return boxes;
  }
}

class _Probe {
  _Probe(this.table);

  /// `host|ip` (ip empty when none) -> the box id that answers, or null when
  /// the TLS/pin check fails (BoxUnreachable). A key not in the table cannot
  /// be reached at all.
  final Map<String, String?> table;
  final List<String> calls = [];
  String? name;

  Future<BoxClient> call(Uri origin, String? ip) async {
    final key = '${origin.host}|${ip ?? ''}';
    calls.add(key);
    if (!table.containsKey(key)) throw const BoxUnreachable('tiada laluan');
    final id = table[key];
    if (id == null) throw const BoxUnreachable('tls');
    return BoxClient(
      origin,
      MockClient((r) async {
        final body = r.url.path == '/api/box/info'
            ? {'boxId': id}
            : {'ok': true, 'version': 3, if (name != null) 'name': name};
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
  }
}

class _Legacy implements BoxLocator {
  _Legacy(this.health);
  final HealthDto health;
  int calls = 0;

  @override
  Future<Located> locate(EnrolledBox b) async {
    calls++;
    return Located(base: b.box, via: 'box', health: health);
  }
}

class _Fixed implements BoxLocator {
  _Fixed(this.via);
  final String via;

  @override
  Future<Located> locate(EnrolledBox b) async => Located(
    base: b.box,
    via: via,
    health: const HealthDto(ok: true, version: 1),
  );
}

DiscoveredBox _d(String name, String ip, {String? id = _id}) =>
    DiscoveredBox(name: name, ip: ip, port: 8443, id: id);

void main() {
  const name = 'box1-surau.local';

  late BoxRoutes routes;
  late List<String?> reached;
  late List<String> learned;
  setUp(() {
    routes = BoxRoutes();
    reached = [];
    learned = [];
  });

  NameAwareLocator make(_Probe p, _Disc d, {BoxLocator? legacy}) =>
      NameAwareLocator(
        legacy: legacy ?? _Legacy(const HealthDto(ok: true, version: 1)),
        probeClient: p.call,
        discovery: d,
        routes: routes,
        onReached: reached.add,
        onNameLearned: learned.add,
      );

  test('IP changed: discovery finds the name at the new IP, base is the name origin, route and last IP kept', () async {
    final p = _Probe({
      '$name|10.0.0.77': _id,
      '10.0.0.5|': null,
    }); // old IP: dead
    final out = await make(
      p,
      _Disc([_d(name, '10.0.0.77')]),
    ).locate(_enrolled(name: name, lastIp: '10.0.0.5'));
    expect(out.via, 'box');
    expect(out.base.toString(), 'https://$name:8443');
    expect(routes.addressOf(name), '10.0.0.77');
    expect(reached, ['10.0.0.77']);
  });

  test('last known IP that still answers wins and does not wait for slow discovery', () async {
    final gate = Completer<void>();
    final p = _Probe({'10.0.0.5|': _id});
    final out = await make(
      p,
      _Disc([], gate: gate.future),
    ).locate(_enrolled(name: name, lastIp: '10.0.0.5'));
    expect(out.base.toString(), 'https://10.0.0.5:8443');
    expect(reached, ['10.0.0.5']);
    expect(routes.addressOf(name), isNull);
    gate.complete();
  });

  test(
    'a box that passes TLS but has another boxId is refused on every path',
    () async {
      final p = _Probe({
        '10.0.0.5|': _other,
        '$name|10.0.0.77': _other,
        '$name|': _other,
      });
      await expectLater(
        make(
          p,
          _Disc([_d(name, '10.0.0.77', id: _other)]),
        ).locate(_enrolled(name: name, lastIp: '10.0.0.5')),
        throwsA(isA<BoxUnreachable>()),
      );
      expect(routes.addressOf(name), isNull);
      expect(reached, isEmpty);
    },
  );

  test('a TXT id that lies (the right id advertised by an impostor) still needs the boxId from the box itself', () async {
    final p = _Probe({'$name|10.0.0.66': _other, '$name|': null});
    await expectLater(
      make(
        p,
        _Disc([_d(name, '10.0.0.66', id: _id)]),
      ).locate(_enrolled(name: name)),
      throwsA(isA<BoxUnreachable>()),
    );
    expect(routes.addressOf(name), isNull);
  });

  test('an advertisement with a different TXT id is not even probed', () async {
    final p = _Probe({'$name|': null});
    await expectLater(
      make(
        p,
        _Disc([_d(name, '10.0.0.66', id: _other)]),
      ).locate(_enrolled(name: name)),
      throwsA(isA<BoxUnreachable>()),
    );
    expect(p.calls, isNot(contains('$name|10.0.0.66')));
  });

  test('an advertisement for another name is ignored', () async {
    final p = _Probe({'$name|': null});
    await expectLater(
      make(
        p,
        _Disc([_d('box2-surau.local', '10.0.0.66')]),
      ).locate(_enrolled(name: name)),
      throwsA(isA<BoxUnreachable>()),
    );
    expect(p.calls.where((c) => c.contains('10.0.0.66')), isEmpty);
  });

  test(
    'the system resolver path (no discovery) works through the name alone',
    () async {
      final p = _Probe({'$name|': _id});
      final out = await make(p, _Disc([])).locate(_enrolled(name: name));
      expect(out.base.toString(), 'https://$name:8443');
      expect(reached, [null]);
      expect(routes.addressOf(name), isNull);
    },
  );

  test('a TrustError from a probe (no CA kept) is passed on, not turned into "away"', () async {
    Future<BoxClient> probe(Uri o, String? ip) async =>
        throw const TrustError('Sijil akar tiada');
    final loc = NameAwareLocator(
      legacy: _Legacy(const HealthDto(ok: true, version: 1)),
      probeClient: probe,
      discovery: _Disc([]),
      routes: routes,
    );
    await expectLater(
      loc.locate(_enrolled(name: name)),
      throwsA(isA<TrustError>()),
    );
  });

  test(
    'stale route: a failed probe through the name removes the route',
    () async {
      routes.set(name, '10.0.0.99');
      final p = _Probe({});
      await expectLater(
        make(p, _Disc([])).locate(_enrolled(name: name)),
        throwsA(isA<BoxUnreachable>()),
      );
      expect(routes.addressOf(name), isNull);
    },
  );

  test('reached by IP: the route follows that IP only when the box carries the name, else it is cleared', () async {
    routes.set(name, '10.0.0.99');
    final p = _Probe({'10.0.0.5|': _id})..name = name;
    await make(p, _Disc([])).locate(_enrolled(name: name, lastIp: '10.0.0.5'));
    expect(routes.addressOf(name), '10.0.0.5');

    routes.set(name, '10.0.0.99');
    final q = _Probe({'10.0.0.5|': _id});
    await make(q, _Disc([])).locate(_enrolled(name: name, lastIp: '10.0.0.5'));
    expect(routes.addressOf(name), isNull);
  });

  test('all candidates fail: BoxUnreachable, so the composite goes on to the cloud', () async {
    final p = _Probe({});
    final out = await CompositeLocator([make(p, _Disc([])), _Fixed('cloud')])
        .locate(_enrolled(name: name, lastIp: '10.0.0.5'));
    expect(out.via, 'cloud');
  });

  group('legacy and migration', () {
    test('a box without a name keeps the legacy locator; no probe, no name learned', () async {
      final p = _Probe({});
      final legacy = _Legacy(const HealthDto(ok: true, version: 1));
      final out = await make(
        p,
        _Disc([_d(name, '10.0.0.77')]),
        legacy: legacy,
      ).locate(_enrolled());
      expect(out.base.host, '10.168.0.10');
      expect(legacy.calls, 1);
      expect(p.calls, isEmpty);
      expect(learned, isEmpty);
    });

    test('health names the box and a handshake by that name with the same boxId works: name learned, route set', () async {
      final p = _Probe({'$name|10.0.0.77': _id});
      final loc = make(
        p,
        _Disc([_d(name, '10.0.0.77')]),
        legacy: _Legacy(const HealthDto(ok: true, version: 1, name: name)),
      );
      final out = await loc.locate(_enrolled());
      expect(
        out.base.host,
        '10.168.0.10',
        reason: 'this locate still answers by the enrolled IP',
      );
      await loc.lastMigration;
      expect(learned, [name]);
      expect(routes.addressOf(name), '10.0.0.77');
    });

    test(
      'health names the box but the name leads to another box: nothing learned',
      () async {
        final p = _Probe({'$name|10.0.0.77': _other, '$name|': _other});
        final loc = make(
          p,
          _Disc([_d(name, '10.0.0.77', id: null)]),
          legacy: _Legacy(const HealthDto(ok: true, version: 1, name: name)),
        );
        await loc.locate(_enrolled());
        await loc.lastMigration;
        expect(learned, isEmpty);
        expect(routes.addressOf(name), isNull);
      },
    );

    test('health names the box but the handshake by the name fails (wrong CA / name not in leaf): nothing learned', () async {
      final p = _Probe({'$name|10.0.0.77': null, '$name|': null});
      final loc = make(
        p,
        _Disc([_d(name, '10.0.0.77')]),
        legacy: _Legacy(const HealthDto(ok: true, version: 1, name: name)),
      );
      await loc.locate(_enrolled());
      await loc.lastMigration;
      expect(learned, isEmpty);
    });

    test('a health name of the wrong shape is ignored', () async {
      final p = _Probe({});
      final loc = make(
        p,
        _Disc([]),
        legacy: _Legacy(
          const HealthDto(ok: true, version: 1, name: 'evil.example.com'),
        ),
      );
      await loc.locate(_enrolled());
      expect(loc.lastMigration, isNull);
      expect(p.calls, isEmpty);
    });

    test(
      'a renumbered box (health says box2) is followed once box2 is proven',
      () async {
        const n2 = 'box2-surau.local';
        final p = _Probe({'10.168.0.10|': _id, '$n2|10.0.0.77': _id})
          ..name = n2;
        final loc = make(p, _Disc([_d(n2, '10.0.0.77')]));
        final out = await loc.locate(
          _enrolled(name: name, lastIp: '10.168.0.10'),
        );
        expect(out.base.host, '10.168.0.10');
        await loc.lastMigration;
        expect(learned, [n2]);
      },
    );
  });
}
