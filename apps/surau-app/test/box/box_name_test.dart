import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_name.dart';
import 'package:surau_app/box/payload.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';

String _enc(Map<String, Object?> m) =>
    'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';

Map<String, Object?> _good() => {
  'v': 1,
  'mode': 'ip',
  'box': 'https://10.168.0.154:8443',
  'boxId': '0123456789abcdef',
  'caSha256': 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  'code': 'ABCD-EFGH-2345',
  'user': 'Ustaz Ali',
  'exp': 1893456000000,
};

Map<String, Object?> _oldJson() => {
  'box': 'https://10.168.0.154:8443',
  'boxId': '0123456789abcdef',
  'deviceId': 'dev1',
  'userId': 'u1',
  'userName': 'Ali',
  'roles': ['admin'],
  'caSha256': 'ab',
  'appLock': true,
};

void main() {
  group('isBoxName', () {
    test('accepts box1..box99 only', () {
      for (final n in ['box1-surau.local', 'box9-surau.local', 'box10-surau.local', 'box99-surau.local']) {
        expect(isBoxName(n), isTrue, reason: n);
      }
    });
    test('refuses everything else', () {
      for (final n in [
        'box0-surau.local', 'box100-surau.local', 'box01-surau.local',
        'box.surau.local', 'box1.surau.local', 'box1-surau.local.', 'xbox1-surau.local',
        'box1-surau.local.evil.com', 'BOX1-surau.local', 'box1-surau.localx', '', 'box-surau.local',
        'box1-surau.local\n',
      ]) {
        expect(isBoxName(n), isFalse, reason: n);
      }
    });
  });

  test('isIpv4', () {
    expect(isIpv4('10.168.0.154'), isTrue);
    expect(isIpv4('256.1.1.1'), isFalse);
    expect(isIpv4('1.2.3'), isFalse);
    expect(isIpv4('01.2.3.4'), isFalse);
    expect(isIpv4('::1'), isFalse);
  });

  group('EnrolledBox JSON', () {
    test('an old record (no name/lastIp/caSha256Next) still loads', () {
      final b = EnrolledBox.fromJson(_oldJson());
      expect(b.name, isNull);
      expect(b.lastIp, isNull);
      expect(b.caSha256Next, isNull);
      expect(b.toJson().containsKey('name'), isFalse);
      expect(b.toJson().containsKey('lastIp'), isFalse);
    });

    test('name, lastIp and caSha256Next round-trip', () {
      final j = _oldJson()
        ..['name'] = 'box2-surau.local'
        ..['lastIp'] = '10.168.0.20'
        ..['caSha256Next'] = 'cd';
      final b = EnrolledBox.fromJson(j);
      expect(b.name, 'box2-surau.local');
      expect(b.lastIp, '10.168.0.20');
      final back = EnrolledBox.fromJson(b.toJson());
      expect(back.name, b.name);
      expect(back.lastIp, b.lastIp);
      expect(back.caSha256Next, 'cd');
    });

    test('a stored name or IP of the wrong shape is dropped', () {
      final b = EnrolledBox.fromJson(
        _oldJson()..['name'] = 'evil.example.com'..['lastIp'] = 'evil.example.com',
      );
      expect(b.name, isNull);
      expect(b.lastIp, isNull);
    });

    test('withAppLock/withCloud keep the name fields; withName/withLastIp keep the rest', () {
      final b = EnrolledBox.fromJson(_oldJson()..['name'] = 'box1-surau.local'..['lastIp'] = '10.0.0.5');
      final c = b.withAppLock(false).withCloud(Uri.parse('https://x.mymaxcom.my'));
      expect(c.name, 'box1-surau.local');
      expect(c.lastIp, '10.0.0.5');
      expect(c.appLock, isFalse);
      final d = EnrolledBox.fromJson(_oldJson()).withName('box3-surau.local').withLastIp('10.0.0.9');
      expect(d.name, 'box3-surau.local');
      expect(d.lastIp, '10.0.0.9');
      expect(d.userName, 'Ali');
      expect(d.withCloud(null).cloud, isNull);
    });
  });

  group('EnrolPayload name and ips', () {
    test('absent: name null, ips empty (older box)', () {
      final p = EnrolPayload.parse(_enc(_good()));
      expect(p.name, isNull);
      expect(p.ips, isEmpty);
    });

    test('present: parsed', () {
      final p = EnrolPayload.parse(
        _enc(_good()..['name'] = 'box1-surau.local'..['ips'] = ['10.168.0.154', '10.0.0.2']),
      );
      expect(p.name, 'box1-surau.local');
      expect(p.ips, ['10.168.0.154', '10.0.0.2']);
      expect(p.box, 'https://10.168.0.154:8443');
    });

    test('a bad name is dropped (hint only), not fatal; bad ips are filtered and capped', () {
      final p = EnrolPayload.parse(
        _enc(
          _good()
            ..['name'] = 'evil.com'
            ..['ips'] = ['1.2.3.4', 'x', 5, '1.2.3.4', ...List.generate(20, (i) => '10.0.0.${i + 1}')],
        ),
      );
      expect(p.name, isNull);
      expect(p.ips.length, EnrolPayload.maxIps);
      expect(p.ips.first, '1.2.3.4');
      expect(p.ips.toSet().length, p.ips.length);
    });

    test('ips of the wrong type is ignored', () {
      expect(EnrolPayload.parse(_enc(_good()..['ips'] = 'x')).ips, isEmpty);
    });

    test('host validation accepts a .local name origin', () {
      final p = EnrolPayload.parse(_enc(_good()..['box'] = 'https://box1-surau.local:8443'));
      expect(p.box, 'https://box1-surau.local:8443');
    });
  });
}
