// [PP-A1] The wire shapes of the people routes, the two live providers and the
// calls of PeopleApi. The box is a fake: the shapes below are the real answers
// of apps/box-server (S2 to S10), copied from the route code.

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/people/people_activity.dart';
import 'package:surau_app/features/people/people_api.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import '../fakes.dart';

class _Reach implements ReachSink {
  BoxReach _r = BoxReach.unknown;
  @override
  BoxReach get reach => _r;
  @override
  void markUp(DateTime at) => _r = _r.up(at);
  @override
  void markDown(DateTime at) => _r = _r.failed(at);
}

Map<String, Object?> _activity({String authority = 'box'}) => {
  'now': '2026-11-18T03:00:00.000Z',
  'authority': authority,
  'limits': {'deviceDays': 60, 'tvDays': 30, 'noDeviceDays': 3, 'userDays': 90},
  'devices': [
    {
      'id': 'd1',
      'ref': 'D-0001',
      'userId': 'u1',
      'kind': 'device',
      'enrolledAt': '2026-05-01T02:00:00.000Z',
      'lastSeenAt': '2026-11-17T02:00:00.000Z',
      'idleDays': 1,
      'inactive': false,
    },
    {
      'id': 'd2',
      'ref': null,
      'userId': 'u2',
      'kind': 'device',
      'enrolledAt': '2026-05-01T02:00:00.000Z',
      'lastSeenAt': null,
      'idleDays': 200,
      'inactive': true,
    },
    {
      'id': 'd3',
      'ref': 'D-C0003',
      'userId': 'u1',
      'kind': 'tv',
      'enrolledAt': '2026-10-01T02:00:00.000Z',
      'lastSeenAt': '2026-10-01T02:00:00.000Z',
      'idleDays': 48,
      'inactive': true,
    },
  ],
  'users': [
    {
      'id': 'u1',
      'ref': 'U-0001',
      'createdAt': '2026-05-01T02:00:00.000Z',
      'createdByName': 'Encik Rahman',
      'deviceCount': 1,
      'lastActiveAt': '2026-11-15T03:00:00.000Z',
      'locked': false,
      'pinLockedUntil': null,
      'needs': <String>[],
      'suggestDeactivate': false,
    },
    {
      'id': 'u2',
      'ref': 'U-0002',
      'createdAt': '2026-11-10T02:00:00.000Z',
      'createdByName': null,
      'deviceCount': 0,
      'lastActiveAt': null,
      'locked': true,
      'pinLockedUntil': '2026-11-18T04:00:00.000Z',
      'needs': ['locked', 'no_device', 'phone'],
      'suggestDeactivate': true,
    },
  ],
};

void main() {
  group('[PP-A1] PeopleActivityDto parses the S6 shape', () {
    test('[PP-A1] every field, with the server clock as now', () {
      final a = PeopleActivityDto.fromJson(_activity());
      expect(a.now, DateTime.utc(2026, 11, 18, 3));
      expect(a.authorityIsBox, isTrue);
      expect(a.deviceDays, 60);
      expect(a.tvDays, 30);
      expect(a.noDeviceDays, 3);
      expect(a.userDays, 90);
      expect(a.devices, hasLength(3));
      final d2 = a.devices[1];
      expect(d2.id, 'd2');
      expect(d2.ref, isNull);
      expect(d2.userId, 'u2');
      expect(d2.isTv, isFalse);
      expect(d2.lastSeenAt, isNull);
      expect(d2.idleDays, 200);
      expect(d2.inactive, isTrue);
      expect(a.devices[2].isTv, isTrue);
      expect(a.devices[0].lastSeenAt, DateTime.utc(2026, 11, 17, 2));
      final u2 = a.users[1];
      expect(u2.ref, 'U-0002');
      expect(u2.createdByName, isNull);
      expect(u2.deviceCount, 0);
      expect(u2.locked, isTrue);
      expect(u2.pinLockedUntil, DateTime.utc(2026, 11, 18, 4));
      expect(u2.needs, ['locked', 'no_device', 'phone']);
      expect(u2.needsNoDevice, isTrue);
      expect(u2.needsPhoneDuplicate, isFalse);
      expect(u2.suggestDeactivate, isTrue);
      expect(a.userOf('u1')!.createdAt, DateTime.utc(2026, 5, 1, 2));
      expect(a.userOf('nobody'), isNull);
      expect(a.deviceOf('d3')!.ref, 'D-C0003');
    });

    test('[PP-A1] a cloud answer is not authoritative', () {
      expect(PeopleActivityDto.fromJson(_activity(authority: 'cloud')).authorityIsBox, isFalse);
    });

    test('[PP-A1] day counts are the server\'s: a phone clock of 2026-01-01 changes nothing', () {
      final a = PeopleActivityDto.fromJson(_activity());
      // The server's idleDays are carried as they came.
      expect(a.deviceOf('d2')!.idleDays, 200);
      // lastActiveAt counted against the server's now (2026-11-18), not the phone's.
      expect(a.lastActiveDays(a.userOf('u1')!), 3);
      expect(a.lastActiveDays(a.userOf('u2')!), isNull);
      // 2026-01-01 on the phone is before every instant in the answer: never negative.
      expect(DateTime.utc(2026, 1, 1).isBefore(a.now), isTrue);
    });

    test('[PP-A1] a missing key does not throw', () {
      final a = PeopleActivityDto.fromJson({'now': '2026-11-18T03:00:00.000Z', 'authority': 'box'});
      expect(a.devices, isEmpty);
      expect(a.users, isEmpty);
      expect(a.deviceDays, 60);
    });
  });

  group('[PP-A1] open codes and recent codes parse', () {
    test('[PP-A1] OpenCodeDto', () {
      final c = OpenCodeDto.fromJson({
        'id': 7,
        'userId': 'u2',
        'userRef': 'U-0002',
        'userName': 'Puan Aminah',
        'deviceName': 'Telefon Puan Aminah',
        'expiresAt': '2026-11-18T03:30:00.000Z',
        'createdByName': 'Encik Rahman',
      });
      expect(c.id, 7);
      expect(c.userId, 'u2');
      expect(c.userRef, 'U-0002');
      expect(c.userName, 'Puan Aminah');
      expect(c.deviceName, 'Telefon Puan Aminah');
      expect(c.expiresAt, DateTime.utc(2026, 11, 18, 3, 30));
      expect(c.createdByName, 'Encik Rahman');
    });

    test('[PP-A1] RecentCodeDto with and without the device that used it', () {
      final used = RecentCodeDto.fromJson({
        'id': 3,
        'cancelledAt': null,
        'device': {
          'id': 'd9',
          'name': 'Telefon Kak Siti',
          'platform': 'android',
          'enrolledAt': '2026-11-18T02:00:00.000Z',
          'ref': 'D-0009',
        },
        'userId': 'u3',
        'userRef': 'U-0003',
        'userName': 'Kak Siti',
        'deviceName': 'Telefon Kak Siti',
        'expiresAt': '2026-11-18T02:30:00.000Z',
        'usedAt': '2026-11-18T02:00:00.000Z',
        'reuseAttempts': 2,
      });
      expect(used.device!.name, 'Telefon Kak Siti');
      expect(used.device!.platform, 'android');
      expect(used.device!.enrolledAt, DateTime.utc(2026, 11, 18, 2));
      expect(used.device!.ref, 'D-0009');
      expect(used.usedAt, DateTime.utc(2026, 11, 18, 2));
      expect(used.reuseAttempts, 2);
      expect(used.cancelledAt, isNull);
      final open = RecentCodeDto.fromJson({
        'id': 4,
        'cancelledAt': '2026-11-18T02:10:00.000Z',
        'device': null,
        'userId': 'u3',
        'userRef': null,
        'userName': 'Kak Siti',
        'deviceName': 'x',
        'expiresAt': '2026-11-18T02:30:00.000Z',
        'usedAt': null,
        'reuseAttempts': 0,
      });
      expect(open.device, isNull);
      expect(open.usedAt, isNull);
      expect(open.cancelledAt, DateTime.utc(2026, 11, 18, 2, 10));
    });

    test('[PP-A1] InvitationDto: sharePayload is null when the box sent none', () {
      final a = InvitationDto.fromJson({
        'id': 9,
        'code': 'ABCD-EFGH-2345',
        'expiresAt': '2026-11-18T03:30:00.000Z',
        'payload': 'surau1:AAAA',
      });
      expect(a.id, 9);
      expect(a.sharePayload, isNull);
      expect(a.expiresAt, DateTime.utc(2026, 11, 18, 3, 30));
      final b = InvitationDto.fromJson({
        'id': 9,
        'code': 'ABCD-EFGH-2345',
        'expiresAt': '2026-11-18T03:30:00.000Z',
        'payload': 'surau1:AAAA',
        'sharePayload': 'surau1:BBBB',
      });
      expect(b.sharePayload, 'surau1:BBBB');
    });
  });

  group('[PP-A1] providers and calls', () {
    late FakeBox box;
    late bool away;
    late Map<String, http.Response Function(http.Request)> routes;
    late ProviderContainer container;
    late BoxGateway gw;

    http.Response answer(http.Request r) {
      final h = routes['${r.method} ${r.url.path}'];
      if (h != null) return h(r);
      return jsonResponse(404, {'errors': ['not found: ${r.method} ${r.url.path}']});
    }

    setUp(() {
      away = false;
      routes = {};
      box = FakeBox((r) async {
        if (away) throw http.ClientException('away');
        return answer(r);
      });
      gw = BoxGateway(
        client: box.client(Uri.parse('https://box.test:8443')),
        token: 'tok-1',
        cache: ReadCache(),
        reach: _Reach(),
        now: () => DateTime.utc(2026, 1, 1),
        onSessionExpired: () {},
      );
      container = ProviderContainer(overrides: [gatewayProvider.overrideWithValue(gw)]);
      addTearDown(container.dispose);
    });

    PeopleApi api() => container.read(peopleApiProvider);

    test('[PP-A1] the activity provider gives the shape from a box', () async {
      routes['GET /api/people/activity'] = (_) => jsonResponse(200, _activity());
      final a = await container.read(peopleActivityProvider.future);
      expect(a, isNotNull);
      expect(a!.users, hasLength(2));
    });

    test('[PP-A1] the activity provider is null on a 404 (an older box)', () async {
      expect(await container.read(peopleActivityProvider.future), isNull);
    });

    test('[PP-A1] the activity provider is null when the box is away', () async {
      away = true;
      expect(await container.read(peopleActivityProvider.future), isNull);
    });

    test('[PP-A1] the activity provider is null on a cloud link (authority is not box)', () async {
      routes['GET /api/people/activity'] = (_) => jsonResponse(200, _activity(authority: 'cloud'));
      expect(await container.read(peopleActivityProvider.future), isNull);
    });

    test('[PP-A1] the activity provider is null on any other refusal and on an answer it cannot read', () async {
      routes['GET /api/people/activity'] = (_) => jsonResponse(403, {'errors': ['x'], 'code': 'forbidden'});
      expect(await container.read(peopleActivityProvider.future), isNull);
      container.invalidate(peopleActivityProvider);
      routes['GET /api/people/activity'] = (_) => jsonResponse(200, {'now': 5});
      expect(await container.read(peopleActivityProvider.future), isNull);
    });

    test('[PP-A1] the activity provider lets an ended session through', () async {
      routes['GET /api/people/activity'] = (_) => jsonResponse(401, {'errors': ['x'], 'code': 'no_session'});
      // a screen watches the provider: keep it alive while the error is read
      final sub = container.listen(peopleActivityProvider, (_, _) {}, onError: (_, _) {});
      addTearDown(sub.close);
      await expectLater(container.read(peopleActivityProvider.future), throwsA(isA<SessionExpired>()));
    });

    test('[PP-A1] the open codes follow the same null rules', () async {
      routes['GET /api/people/activity'] = (_) => jsonResponse(200, _activity());
      routes['GET /api/enrol/open'] = (_) => jsonResponse(200, {
        'codes': [
          {
            'id': 7,
            'userId': 'u2',
            'userRef': 'U-0002',
            'userName': 'Puan Aminah',
            'deviceName': 'Telefon Puan Aminah',
            'expiresAt': '2026-11-18T03:30:00.000Z',
            'createdByName': 'Encik Rahman',
          },
        ],
      });
      final codes = await container.read(openCodesProvider.future);
      expect(codes, hasLength(1));
      expect(codes!.single.userName, 'Puan Aminah');

      // an older box: no route
      routes.remove('GET /api/enrol/open');
      container.invalidate(openCodesProvider);
      expect(await container.read(openCodesProvider.future), isNull);

      // a cloud link
      routes['GET /api/people/activity'] = (_) => jsonResponse(200, _activity(authority: 'cloud'));
      routes['GET /api/enrol/open'] = (_) => jsonResponse(200, {'codes': <Object>[]});
      container.invalidate(peopleActivityProvider);
      container.invalidate(openCodesProvider);
      expect(await container.read(openCodesProvider.future), isNull);
    });

    test('[PP-A1] renameUser, renameDevice and renameOwnDevice send the cleaned name to their routes', () async {
      routes['PUT /api/users/u1/name'] = (_) => jsonResponse(200, {'ok': true});
      routes['PUT /api/devices/d1/name'] = (_) => jsonResponse(200, {'ok': true});
      routes['PUT /api/auth/device/name'] = (_) => jsonResponse(200, {'ok': true});
      await api().renameUser('u1', '  Encik   Rahman ');
      await api().renameDevice('d1', 'Telefon  Ustaz Ahmad');
      await api().renameOwnDevice('iPad meja bendahari');
      expect(box.bodyOf('/api/users/u1/name'), {'name': 'Encik Rahman'});
      expect(box.bodyOf('/api/devices/d1/name'), {'name': 'Telefon Ustaz Ahmad'});
      expect(box.bodyOf('/api/auth/device/name'), {'name': 'iPad meja bendahari'});
    });

    test('[PP-A1] a name the box would refuse is not sent', () async {
      routes['PUT /api/users/u1/name'] = (_) => jsonResponse(200, {'ok': true});
      await expectLater(api().renameUser('u1', ''), throwsArgumentError);
      await expectLater(api().renameUser('u1', 'a' * 81), throwsArgumentError);
      await expectLater(api().renameDevice('d1', 'Telefon\u202EX'), throwsArgumentError);
      expect(box.seen, isEmpty);
    });

    test('[PP-A1] unlock, activate, restore and delete post to their routes', () async {
      routes['POST /api/users/u1/unlock'] = (_) => jsonResponse(200, {'ok': true});
      routes['POST /api/users/u1/activate'] = (_) => jsonResponse(200, {'ok': true});
      routes['POST /api/users/u1/restore'] = (_) => jsonResponse(200, {'ok': true});
      routes['POST /api/users/u1/delete'] = (_) => jsonResponse(200, {'ok': true});
      routes['POST /api/devices/d1/revoke'] = (_) => jsonResponse(200, {'ok': true});
      await api().unlockUser('u1');
      await api().activateUser('u1');
      await api().restoreUser('u1');
      await api().deleteUser('u1', 'U-0001');
      await api().revokeDevice('d1');
      expect(box.bodyOf('/api/users/u1/delete'), {'ref': 'U-0001'});
      expect(box.seen.map((r) => '${r.method} ${r.url.path}'), [
        'POST /api/users/u1/unlock',
        'POST /api/users/u1/activate',
        'POST /api/users/u1/restore',
        'POST /api/users/u1/delete',
        'POST /api/devices/d1/revoke',
      ]);
    });

    test('[PP-A1] setPhone sends E.164 and refuses what is not a number, never echoing it', () async {
      routes['PUT /api/users/u1/phone'] = (_) => jsonResponse(200, {'ok': true});
      await api().setPhone('u1', '012-000 0001');
      expect(box.bodyOf('/api/users/u1/phone'), {'phone': '+60120000001'});
      Object? error;
      try {
        await api().setPhone('u1', 'abc');
      } catch (e) {
        error = e;
      }
      expect(error, isA<BadPhone>());
      expect(error.toString(), isNot(contains('abc')));
      expect(box.seen, hasLength(1));
    });

    test('[PP-A1] createUser carries the E.164 phone and answers the user', () async {
      routes['POST /api/users'] = (_) => jsonResponse(201, {
        'id': 'u9',
        'name': 'Haji Osman',
        'roles': ['ajk'],
        'active': true,
        'pinRequired': false,
        'ref': 'U-0009',
        'phone': '+60120000009',
        'createdAt': '2026-11-18T03:00:00.000Z',
      });
      final u = await api().createUser(name: ' Haji   Osman ', roles: const ['ajk'], phone: '012-000 0009');
      expect(box.bodyOf('/api/users'), {'name': 'Haji Osman', 'roles': ['ajk'], 'phone': '+60120000009'});
      expect(u.id, 'u9');
      expect(u.ref, 'U-0009');
      expect(u.phone, '+60120000009');
    });

    test('findUserJustAdded finds the newest person of that name with no number made in the last ten minutes', () async {
      Map<String, dynamic> person(String id, String name, String made, {String? phone, bool deleted = false}) => {
            'id': id,
            'name': name,
            'roles': ['ajk'],
            'active': true,
            'pinRequired': true,
            'createdAt': made,
            if (phone != null) 'phone': phone,
            if (deleted) 'deleted': true,
          };
      routes['GET /api/users'] = (_) => jsonResponse(200, {
        'users': [
          person('old', 'Haji Osman', '2026-11-18T01:00:00.000Z'),
          person('numbered', 'Haji Osman', '2026-11-18T03:00:00.000Z', phone: '+60120000009'),
          person('gone', 'Haji Osman', '2026-11-18T03:00:30.000Z', deleted: true),
          person('other', 'Kak Siti', '2026-11-18T03:00:40.000Z'),
          person('first', 'Haji Osman', '2026-11-18T02:58:00.000Z'),
          person('new', 'Haji Osman', '2026-11-18T03:00:50.000Z'),
        ],
      });
      final now = DateTime.parse('2026-11-18T03:01:00.000Z');
      expect((await api().findUserJustAdded(' Haji   Osman ', now: now))?.id, 'new');
      expect(await api().findUserJustAdded('Tiada Orang', now: now), isNull);
      // an hour later the same list holds nobody "just added"
      expect(await api().findUserJustAdded('Haji Osman', now: now.add(const Duration(hours: 1))), isNull);
    });

    test('[PP-A1] revokeInactive sends the ids and reads revoked and skipped', () async {
      routes['POST /api/devices/revoke-inactive'] = (_) => jsonResponse(200, {
        'revoked': ['d2'],
        'skipped': [
          {'id': 'd1', 'reason': 'in_use'},
          {'id': 'd4', 'reason': 'last_admin_device'},
        ],
      });
      final r = await api().revokeInactive(['d1', 'd2', 'd4']);
      expect(box.bodyOf('/api/devices/revoke-inactive'), {'ids': ['d1', 'd2', 'd4']});
      expect(r.revoked, ['d2']);
      expect(r.skipped.map((e) => (e.id, e.reason)), [('d1', 'in_use'), ('d4', 'last_admin_device')]);
    });

    test('[PP-A1] beginEnrol, recentCodes and cancelCode', () async {
      routes['POST /api/enrol/begin'] = (_) => jsonResponse(200, {
        'id': 12,
        'code': 'ABCD-EFGH-2345',
        'expiresAt': '2026-11-18T03:30:00.000Z',
        'payload': 'surau1:AAAA',
        'sharePayload': 'surau1:BBBB',
      });
      routes['GET /api/enrol/recent'] = (_) => jsonResponse(200, {'codes': <Object>[]});
      routes['POST /api/enrol/cancel'] = (_) => jsonResponse(200, {'ok': true, 'cancelled': true});
      final inv = await api().beginEnrol(userId: 'u1', deviceName: 'Telefon Kak Siti', ttlMinutes: 30);
      expect(box.bodyOf('/api/enrol/begin'), {'userId': 'u1', 'deviceName': 'Telefon Kak Siti', 'ttlMinutes': 30});
      expect(inv.id, 12);
      expect(inv.sharePayload, 'surau1:BBBB');
      expect(await api().recentCodes(), isEmpty);
      expect(await api().cancelCode(id: 12, userId: 'u1'), isTrue);
      expect(box.bodyOf('/api/enrol/cancel'), {'id': 12, 'userId': 'u1'});
    });

    test('[PP-A1] a 404 without a code on any new route is PeopleNeedsUpdate', () async {
      final calls = <String, Future<Object?> Function()>{
        'renameUser': () => api().renameUser('u1', 'Kak Siti'),
        'renameDevice': () => api().renameDevice('d1', 'Telefon'),
        'renameOwnDevice': () => api().renameOwnDevice('Telefon'),
        'unlockUser': () => api().unlockUser('u1'),
        'activateUser': () => api().activateUser('u1'),
        'restoreUser': () => api().restoreUser('u1'),
        'deleteUser': () => api().deleteUser('u1', 'U-0001'),
        'setPhone': () => api().setPhone('u1', '012-000 0001'),
        'revokeInactive': () => api().revokeInactive(['d1']),
        'recentCodes': () => api().recentCodes(),
        'cancelCode': () => api().cancelCode(id: 1, userId: 'u1'),
      };
      for (final e in calls.entries) {
        await expectLater(e.value(), throwsA(isA<PeopleNeedsUpdate>()), reason: e.key);
      }
    });

    test('[PP-A1] a 404 with the box\'s own code stays a BoxError the screen can read', () async {
      routes['POST /api/users/u1/delete'] = (_) => jsonResponse(404, {'errors': ['Tidak dijumpai'], 'code': 'not_found'});
      await expectLater(
        api().deleteUser('u1', 'U-0001'),
        throwsA(isA<BoxError>().having((e) => e.code, 'code', 'not_found')),
      );
    });

    test('[PP-A1] a 409 last_admin_device is a BoxError the caller reads by code', () async {
      routes['POST /api/devices/d1/revoke'] = (_) =>
          jsonResponse(409, {'errors': ['Daftarkan peranti Pentadbir lain dahulu'], 'code': 'last_admin_device'});
      await expectLater(
        api().revokeDevice('d1'),
        throwsA(isA<BoxError>().having((e) => e.code, 'code', 'last_admin_device')),
      );
    });

    test('[PP-A1] phone_taken carries the other person\'s ID in detail', () async {
      routes['PUT /api/users/u1/phone'] = (_) =>
          http.Response(jsonEncode({'ref': 'U-0004', 'errors': ['x'], 'code': 'phone_taken'}), 409, headers: {'content-type': 'application/json'});
      await expectLater(
        api().setPhone('u1', '012-000 0001'),
        throwsA(isA<BoxError>().having((e) => e.detail['ref'], 'ref', 'U-0004')),
      );
    });
  });
}
