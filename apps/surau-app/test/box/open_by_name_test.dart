import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/open_by_name.dart';
import 'package:surau_app/box/payload.dart';

import '../features/fakes.dart';

EnrolPayload _payload({String? name = 'box1-surau.local', String box = 'https://10.168.0.154:8443', List<String>? ips}) {
  final base = fixturePayload();
  final m = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(base.substring(7))))) as Map<String, dynamic>;
  m['box'] = box;
  m['name'] = name;
  m['ips'] = ips ?? ['10.168.0.154', '10.0.0.5'];
  return EnrolPayload.parse('surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}');
}

void main() {
  group('enrolNameOriginToOffer', () {
    final page = Uri.parse('https://10.168.0.154:8443');
    test('page at the payload box IP: the name origin with the page port', () {
      expect(enrolNameOriginToOffer(page: page, payload: _payload()).toString(), 'https://box1-surau.local:8443');
    });
    test('page at another IP the payload lists: offered', () {
      expect(enrolNameOriginToOffer(page: Uri.parse('https://10.0.0.5:8443'), payload: _payload()), isNotNull);
    });
    test('page at an IP the payload does not list: nothing', () {
      expect(enrolNameOriginToOffer(page: Uri.parse('https://10.9.9.9:8443'), payload: _payload()), isNull);
    });
    test('a different port or scheme: nothing', () {
      expect(enrolNameOriginToOffer(page: Uri.parse('https://10.168.0.154:9443'), payload: _payload()), isNull);
      expect(enrolNameOriginToOffer(page: Uri.parse('http://10.168.0.154:8443'), payload: _payload()), isNull);
    });
    test('page already at the name or a domain: nothing', () {
      expect(enrolNameOriginToOffer(page: Uri.parse('https://box1-surau.local:8443'), payload: _payload()), isNull);
      expect(enrolNameOriginToOffer(page: Uri.parse('https://app.example.com:8443'), payload: _payload()), isNull);
    });
    test('no page (native): nothing', () {
      expect(enrolNameOriginToOffer(page: null, payload: _payload()), isNull);
    });
    test('no or invalid name: nothing', () {
      expect(enrolNameOriginToOffer(page: page, payload: _payload(name: null)), isNull);
      expect(enrolNameOriginToOffer(page: page, payload: _payload(name: 'evil.example.com')), isNull);
    });
  });

  test('mayOpenOrigin: https and a box name only', () {
    expect(mayOpenOrigin(Uri.parse('https://box1-surau.local:8443')), isTrue);
    expect(mayOpenOrigin(Uri.parse('http://box1-surau.local:8443')), isFalse);
    expect(mayOpenOrigin(Uri.parse('https://10.168.0.154:8443')), isFalse);
    expect(mayOpenOrigin(Uri.parse('https://evil.example.com')), isFalse);
  });

  test('native helpers: no page origin, opening does nothing', () {
    expect(pageOrigin(), isNull);
    openOrigin(Uri.parse('https://box1-surau.local:8443'));
  });
}
