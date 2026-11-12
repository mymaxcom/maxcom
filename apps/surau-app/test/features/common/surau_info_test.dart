// SurauInfo: parse the box's answer leniently, keep the last good copy,
// never raise on a box that is away.

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';

import '../fakes.dart';

void main() {
  test('parses the full answer and omits empty help fields', () {
    final info = SurauInfo.fromJson(fixtureInfoJson)!;
    expect(info.name, 'Surau D\'Waqaf');
    expect(info.kind, 'surau');
    expect(info.shortAddress, 'Jalan Mahabbah 3, Taman Mahabbah');
    expect(info.help!.name, 'Encik Hafiz');
    expect(info.help!.phone, '012-345 6789');
    expect(info.help!.email, 'hafiz@contoh.my');
    expect(info.help!.reachable, isTrue);

    final bare = SurauInfo.fromJson({
      'name': ' Masjid Al-Falah ',
      'kind': 'masjid',
      'help': {'name': '', 'phone': ' '},
    })!;
    expect(bare.name, 'Masjid Al-Falah');
    expect(bare.kind, 'masjid');
    expect(bare.shortAddress, isNull);
    expect(bare.help, isNull, reason: 'all-empty help is dropped');
  });

  test('the logo is kept only as the box public path, and round-trips', () {
    final info = SurauInfo.fromJson({...fixtureInfoJson, 'logo': '/surau-logo?v=0123456789abcdef'})!;
    expect(info.logo, '/surau-logo?v=0123456789abcdef');
    expect(SurauInfo.fromJson(info.toJson())!.logo, info.logo);
    expect(SurauInfo.fromJson({'name': 'X', 'logo': '/surau-logo'})!.logo, '/surau-logo');
    expect(SurauInfo.fromJson(fixtureInfoJson)!.logo, isNull);
    expect(SurauInfo.fromJson(fixtureInfoJson)!.toJson().containsKey('logo'), isFalse);
    for (final bad in [
      'https://evil.example/logo.png',
      '//evil.example/surau-logo',
      '/assets/${'a' * 64}',
      '/surau-logo?v=abc&x=1',
      'javascript:alert(1)',
      42,
      null,
    ]) {
      expect(SurauInfo.fromJson({'name': 'X', 'logo': bad})!.logo, isNull, reason: '$bad');
      expect(surauLogoPath(bad), isNull, reason: '$bad');
    }
  });

  test('showName is on unless the box says false; it decides the text name only with a logo', () {
    final on = SurauInfo.fromJson(fixtureInfoJson)!;
    expect(on.showName, isTrue);
    expect(on.toJson().containsKey('showName'), isFalse);
    final off = SurauInfo.fromJson({...fixtureInfoJson, 'showName': false, 'logo': '/surau-logo?v=ab'})!;
    expect(off.showName, isFalse);
    expect(off.nameShown(hasLogo: true), isFalse);
    expect(off.nameShown(hasLogo: false), isTrue, reason: 'without a logo the name always shows');
    expect(SurauInfo.fromJson(off.toJson())!.showName, isFalse, reason: 'round-trips through the cache');
    expect(SurauInfo.fromJson({...fixtureInfoJson, 'showName': 'no'})!.showName, isTrue, reason: 'only exactly false');
  });

  test('a missing or blank name is no info; an odd kind becomes surau', () {
    expect(SurauInfo.fromJson({}), isNull);
    expect(SurauInfo.fromJson({'name': '  '}), isNull);
    expect(SurauInfo.fromJson({'name': 'X', 'kind': 'church'})!.kind, 'surau');
  });

  test('round-trips through JSON for the local cache', () {
    final info = SurauInfo.fromJson(fixtureInfoJson)!;
    final again = SurauInfo.fromJson(info.toJson())!;
    expect(again.toJson(), info.toJson());
    final noHelp = const SurauInfo(name: 'Surau A').toJson();
    expect(noHelp.containsKey('help'), isFalse);
    expect(noHelp.containsKey('shortAddress'), isFalse);
  });

  test('HelpContact.isEmpty and reachable', () {
    expect(const HelpContact().isEmpty, isTrue);
    expect(const HelpContact(name: 'A').isEmpty, isFalse);
    expect(const HelpContact(name: 'A').reachable, isFalse);
    expect(const HelpContact(email: 'a@b.my').reachable, isTrue);
  });

  group('SurauInfoLoader', () {
    test(
      'refresh asks GET /api/surau/info without a token and caches it',
      () async {
        final box = FakeBox(happyBox);
        final store = MemorySurauInfoStore();
        final loader = SurauInfoLoader(
          client: box.client(Uri.parse('https://127.0.0.1:8443')),
          store: store,
        );
        expect(await loader.cached(), isNull);
        final info = await loader.refresh();
        expect(info!.name, 'Surau D\'Waqaf');
        final req = box.byPath('/api/surau/info')!;
        expect(req.method, 'GET');
        expect(req.headers.containsKey('authorization'), isFalse);
        expect((await store.load())!.name, 'Surau D\'Waqaf');
      },
    );

    test(
      'an unreachable box answers from the cache, not with an error',
      () async {
        final box = FakeBox((r) async => throw const BoxUnreachable());
        final store = MemorySurauInfoStore(const SurauInfo(name: 'Surau Lama'));
        final loader = SurauInfoLoader(
          client: box.client(Uri.parse('https://127.0.0.1:8443')),
          store: store,
        );
        expect((await loader.refresh())!.name, 'Surau Lama');
      },
    );

    test('a 404 (older box) or junk body keeps the cache untouched', () async {
      final store = MemorySurauInfoStore(const SurauInfo(name: 'Surau Lama'));
      for (final handler in <Future<http.Response> Function(http.Request)>[
        (r) async => jsonResponse(404, {
          'errors': ['tiada'],
        }),
        (r) async => http.Response('<html>', 200),
        (r) async => jsonResponse(200, {'name': ''}),
      ]) {
        final loader = SurauInfoLoader(
          client: FakeBox(handler).client(Uri.parse('https://127.0.0.1:8443')),
          store: store,
        );
        expect((await loader.refresh())!.name, 'Surau Lama');
      }
    });

    test('the box away: the cloud answers the same route, and the logo is '
        'then fetched from it', () async {
      final box = FakeBox((r) async => throw const BoxUnreachable());
      final cloud = FakeBox(happyBox);
      final store = MemorySurauInfoStore(const SurauInfo(name: 'Surau Lama'));
      final cloudClient = cloud.client(Uri.parse('https://api.mymaxcom.my'));
      final loader = SurauInfoLoader(
        client: box.client(Uri.parse('https://127.0.0.1:8443')),
        store: store,
        fallback: () async => cloudClient,
      );
      expect((await loader.refresh())!.name, 'Surau D\'Waqaf');
      expect(cloud.byPath('/api/surau/info')!.url.host, 'api.mymaxcom.my');
      expect(identical(loader.servedBy, cloudClient), isTrue);
      expect((await store.load())!.name, 'Surau D\'Waqaf');
    });

    test('the box answers: the cloud is not asked', () async {
      final cloud = FakeBox(happyBox);
      final loader = SurauInfoLoader(
        client: FakeBox(happyBox).client(Uri.parse('https://127.0.0.1:8443')),
        store: MemorySurauInfoStore(),
        fallback: () async => cloud.client(Uri.parse('https://api.mymaxcom.my')),
      );
      await loader.refresh();
      expect(cloud.seen, isEmpty);
    });
  });
}
