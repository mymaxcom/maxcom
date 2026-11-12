@TestOn('vm')
library;

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/trust.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart' show EnrolledBox;
import 'package:surau_app/sync/transport.dart' show boxAt;
import 'package:surau_app/upload/upload_providers.dart' show uploadCaDer;

EnrolledBox _box(String box, String? cloud, {String? sha = 'ab'}) =>
    EnrolledBox(
      box: Uri.parse(box),
      boxId: 'b',
      deviceId: 'd',
      userId: 'u',
      userName: 'U',
      roles: const [],
      caSha256: sha,
      cloud: cloud == null ? null : Uri.parse(cloud),
    );

class _Cas implements CaDerSource {
  _Cas(this.der);
  final Uint8List? der;
  int loads = 0;

  @override
  Future<Uint8List?> loadCaDer(String sha256) async {
    loads++;
    return der;
  }
}

void main() {
  group('usesPublicTls', () {
    test('true for a DNS cloud with the same origin', () {
      expect(
        usesPublicTls(
          _box('https://api.mymaxcom.my', 'https://api.mymaxcom.my'),
        ),
        isTrue,
      );
      expect(
        usesPublicTls(
          _box('https://api.mymaxcom.my:443', 'https://api.mymaxcom.my'),
        ),
        isTrue,
      );
    });

    test('false when the cloud is an IPv4 or IPv6 literal', () {
      expect(
        usesPublicTls(_box('https://10.0.0.5:8443', 'https://10.0.0.5:8443')),
        isFalse,
      );
      expect(
        usesPublicTls(_box('https://[fd00::1]:8443', 'https://[fd00::1]:8443')),
        isFalse,
      );
    });

    test('false for any domain other than mymaxcom.my', () {
      for (final origin in const [
        'https://attacker.example',
        'https://mymaxcom.my.attacker.example',
        'https://notmymaxcom.my',
        'https://box.local',
      ]) {
        expect(usesPublicTls(_box(origin, origin)), isFalse, reason: origin);
      }
    });

    test('false for http', () {
      expect(
        usesPublicTls(_box('http://api.mymaxcom.my', 'http://api.mymaxcom.my')),
        isFalse,
      );
    });

    test('false for a different host or port', () {
      expect(
        usesPublicTls(_box('https://other.example', 'https://api.mymaxcom.my')),
        isFalse,
      );
      expect(
        usesPublicTls(
          _box('https://api.mymaxcom.my:8443', 'https://api.mymaxcom.my'),
        ),
        isFalse,
      );
    });

    test('false when there is no cloud', () {
      expect(usesPublicTls(_box('https://api.mymaxcom.my', null)), isFalse);
    });

    test('false for the LAN box with a DNS cloud set', () {
      expect(
        usesPublicTls(
          _box('https://10.168.0.154:8443', 'https://api.mymaxcom.my'),
        ),
        isFalse,
      );
    });
  });

  group('TrustStore.boxClient', () {
    final store = TrustStore();

    test('cloud on public TLS needs no CA', () async {
      final cas = _Cas(null);
      final b = _box(
        'https://api.mymaxcom.my',
        'https://api.mymaxcom.my',
        sha: null,
      );
      final c = await store.boxClient(b, cas);
      expect(c, isNotNull);
      expect(cas.loads, 0);
    });

    test('LAN box with a stored CA goes down the pinned path', () async {
      // Not a certificate: only the pinned path can reject it, and it must
      // have loaded the stored CA to do so. A system-roots client would not.
      final cas = _Cas(Uint8List.fromList([1, 2, 3]));
      await expectLater(
        store.boxClient(
          _box('https://10.168.0.154:8443', 'https://api.mymaxcom.my'),
          cas,
        ),
        throwsA(isA<TrustError>()),
      );
      expect(cas.loads, 1);
    });

    test('LAN box with a DNS cloud and no CA is a TrustError', () async {
      final b = _box(
        'https://10.168.0.154:8443',
        'https://api.mymaxcom.my',
      );
      await expectLater(
        store.boxClient(b, _Cas(null)),
        throwsA(isA<TrustError>()),
      );
      await expectLater(
        store.boxClient(
          _box(
            'https://10.168.0.154:8443',
            'https://api.mymaxcom.my',
            sha: null,
          ),
          _Cas(null),
        ),
        throwsA(isA<TrustError>()),
      );
    });

    test('cloud by IP and no CA is still a TrustError', () async {
      final b = _box('https://10.0.0.5:8443', 'https://10.0.0.5:8443');
      await expectLater(
        store.boxClient(b, _Cas(null)),
        throwsA(isA<TrustError>()),
      );
    });
  });

  group('uploadCaDer', () {
    final ca = Uint8List.fromList([1, 2, 3]);
    final lan = _box('https://10.168.0.154:8443', 'https://api.mymaxcom.my');

    test('public TLS cloud passes no CA', () async {
      final cas = _Cas(ca);
      final r = await uploadCaDer(boxAt(lan, lan.cloud!), cas);
      expect(r, isNull);
      expect(cas.loads, 0);
    });

    test('cloud by IP passes the pinned CA', () async {
      final ipCloud = _box('https://10.168.0.154:8443', 'https://10.0.0.5:8443');
      final r = await uploadCaDer(boxAt(ipCloud, ipCloud.cloud!), _Cas(ca));
      expect(r, ca);
    });
  });
}
