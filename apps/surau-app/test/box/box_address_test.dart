import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_address.dart';
import 'package:surau_app/box/payload.dart';

import '../features/fakes.dart';

void main() {
  final p = EnrolPayload.parse(fixturePayload());
  EnrolPayload make({String? name}) => EnrolPayload(
    mode: p.mode,
    box: 'https://10.168.0.154:8443',
    boxId: p.boxId,
    caSha256: p.caSha256,
    code: p.code,
    user: p.user,
    exp: p.exp,
    name: name,
    ips: const ['10.168.0.154', '10.168.0.155'],
  );
  final named = make(name: 'box1-surau.local');

  group('enrolOrigin', () {
    test('page at the box name: the page origin', () {
      expect(
        enrolOrigin(
          named,
          page: Uri.parse('https://box1-surau.local:8443/app/'),
        ).toString(),
        'https://box1-surau.local:8443',
      );
    });

    test('page at the box IP: the IP', () {
      expect(
        enrolOrigin(
          named,
          page: Uri.parse('https://10.168.0.154:8443/app/'),
        ).toString(),
        'https://10.168.0.154:8443',
      );
      expect(
        enrolOrigin(
          named,
          page: Uri.parse('https://10.168.0.155:8443/app/x?y=1'),
        ).toString(),
        'https://10.168.0.155:8443',
      );
    });

    test('unrelated host, port or scheme: payload.box', () {
      for (final page in [
        'https://evil.example:8443/',
        'https://box2-surau.local:8443/',
        'https://box1-surau.local:8444/',
        'http://box1-surau.local:8443/',
        'https://10.168.0.9:8443/',
      ]) {
        expect(
          enrolOrigin(named, page: Uri.parse(page)).toString(),
          'https://10.168.0.154:8443',
          reason: page,
        );
      }
    });

    test('no page: payload.box', () {
      expect(enrolOrigin(named).toString(), 'https://10.168.0.154:8443');
    });

    test('a payload name that is not a box name never selects an origin', () {
      final odd = make(name: 'evil.example');
      expect(
        enrolOrigin(odd, page: Uri.parse('https://evil.example:8443/')).toString(),
        'https://10.168.0.154:8443',
      );
    });
  });

  group('boxAddressText', () {
    test('the name first, the IP on a second line', () {
      expect(
        boxAddressText(
          Uri.parse('https://10.168.0.154:8443'),
          name: 'box1-surau.local',
        ),
        'https://box1-surau.local:8443\nhttps://10.168.0.154:8443',
      );
    });

    test('no name (or a box already at its name): just the address', () {
      expect(
        boxAddressText(Uri.parse('https://10.168.0.154:8443')),
        'https://10.168.0.154:8443',
      );
      expect(
        boxAddressText(
          Uri.parse('https://box1-surau.local:8443'),
          name: 'box1-surau.local',
        ),
        'https://box1-surau.local:8443',
      );
      expect(
        boxAddressText(
          Uri.parse('https://10.168.0.154:8443'),
          name: 'not a name',
        ),
        'https://10.168.0.154:8443',
      );
    });
  });
}
