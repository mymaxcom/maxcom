// The cloud a phone falls back to: its enrolment's, else the one the box
// reports in health (kept only when it passes the public-TLS rule), else
// the default. A phone enrolled before the box was linked is no longer
// stuck with "tiada awan".

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/cloud_origin.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/box/trust.dart' show usesPublicTls;
import 'package:surau_app/sync/transport.dart' show boxAt;

import '../features/fakes.dart';

void main() {
  final box = fixtureBox();

  group('acceptedCloudOrigin', () {
    test('keeps an https origin on mymaxcom.my or a subdomain', () {
      expect(
        acceptedCloudOrigin(box, 'https://api.mymaxcom.my'),
        Uri.parse('https://api.mymaxcom.my'),
      );
      expect(
        acceptedCloudOrigin(box, 'https://mymaxcom.my/'),
        Uri.parse('https://mymaxcom.my'),
      );
      expect(
        acceptedCloudOrigin(box, 'https://Eu.API.mymaxcom.my:8443'),
        Uri.parse('https://eu.api.mymaxcom.my:8443'),
      );
    });

    test('refuses anything else', () {
      for (final bad in <Object?>[
        null,
        42,
        '',
        'http://api.mymaxcom.my',
        'https://api.mymaxcom.my.evil.example',
        'https://evilmymaxcom.my',
        'https://10.168.0.154:8443',
        'https://api.mymaxcom.my/api',
        'https://api.mymaxcom.my?x=1',
        'https://user@api.mymaxcom.my',
        'not a url',
      ]) {
        expect(acceptedCloudOrigin(box, bad), isNull, reason: '$bad');
      }
    });
  });

  test('without its own cloud a box falls back to the default', () {
    expect(box.cloud, isNull);
    expect(usesDefaultCloud(box), isTrue);
    expect(cloudOriginOf(box), Uri.parse('https://api.mymaxcom.my'));
    final cloud = Uri.parse('https://eu.mymaxcom.my');
    expect(cloudOriginOf(box.withCloud(cloud)), cloud);
    expect(usesDefaultCloud(box.withCloud(cloud)), isFalse);
  });

  test('a client to the default cloud uses the public roots, the box stays '
      'pinned', () {
    expect(usesPublicTls(boxAt(box, defaultCloudOrigin)), isTrue);
    expect(usesPublicTls(boxAt(box, box.box)), isFalse);
  });

  test('CloudLocator asks the default cloud when the box names none, within '
      'a 12 s budget', () async {
    final seen = <Uri>[];
    final world = FakeBox((r) async {
      seen.add(r.url);
      return jsonResponse(200, {'ok': true, 'version': 3});
    });
    final locator = CloudLocator(clientFor: (c) async => world.client(c));
    expect(locator.timeout, const Duration(seconds: 12));
    final at = await locator.locate(box);
    expect(at.via, 'cloud');
    expect(at.base, Uri.parse('https://api.mymaxcom.my'));
    expect(seen.single.host, 'api.mymaxcom.my');
  });

  test('DirectBoxLocator hands every health answer on (the cloud field '
      'included)', () async {
    HealthDto? got;
    final world = FakeBox(
      (r) async => jsonResponse(200, {
        'ok': true,
        'version': 3,
        'cloud': 'https://api.mymaxcom.my',
      }),
    );
    await DirectBoxLocator(
      clientFor: (b) async => world.client(b.box),
      onHealth: (h) => got = h,
    ).locate(box);
    expect(got?.cloud, 'https://api.mymaxcom.my');
  });

  test('CompositeLocator says which locator failed before trying the next',
      () async {
    final failed = <int>[];
    final world = FakeBox((r) async {
      if (r.url.host == '127.0.0.1') throw http.ClientException('away');
      return jsonResponse(200, {'ok': true, 'version': 3});
    });
    final at = await CompositeLocator([
      DirectBoxLocator(clientFor: (b) async => world.client(b.box)),
      CloudLocator(clientFor: (c) async => world.client(c)),
    ], onFailed: failed.add).locate(box);
    expect(at.via, 'cloud');
    expect(failed, [0]);
  });
}
