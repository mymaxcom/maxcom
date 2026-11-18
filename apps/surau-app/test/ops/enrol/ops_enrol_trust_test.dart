// The ops enrolment reaches the cloud through the REAL PinnedEnrolTrust /
// TrustStore wiring on a pinning platform (Android): no QR was scanned, so
// no CA exists, and the flow must still send its requests (system trust,
// public cloud origin only).
@TestOn('vm')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/cloud_origin.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/box/session_store.dart';
import 'package:surau_app/box/trust.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/ops/enrol/ops_enrol_flow.dart';
import 'package:surau_app/ops/enrol/ops_enrol_texts.dart';

import '../../features/fakes.dart';

void main() {
  late List<http.Request> seen;
  late TrustStore store0;
  late PinnedEnrolTrust trust;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    seen = [];
    store0 = TrustStore(
      systemClient: (_) => MockClient((r) async {
        seen.add(r);
        switch (r.url.path) {
          case '/api/box/info':
            return jsonResponse(200, {'boxId': '2239217507948bed'});
          case '/api/enrol/complete':
            return jsonResponse(200, {
              'deviceId': 'dev-ops',
              'userId': 'u-ops',
              'roles': ['superadmin'],
              'pinRequired': true,
              'appLock': true,
            });
        }
        return jsonResponse(404, {
          'errors': ['tiada'],
        });
      }),
    );
    trust = PinnedEnrolTrust(store0, SessionStore(prefs));
  });

  test('the pinning platform premise: the QR flow client has no CA', () {
    expect(store0.pinsCa, isTrue);
    expect(
      () => trust.clientFor(defaultCloudOrigin),
      throwsA(isA<TrustError>()),
    );
  });

  test(
    'ops enrolment reaches the cloud with system trust and no pinned CA',
    () async {
      final mem = MemoryEnrolledBoxStore();
      final flow = OpsEnrolFlow(
        clientFor: trust.publicCloudClient,
        key: FakeDeviceKey(),
        store: mem,
        platform: 'android',
      );
      final out = await flow.run('K7QM-2XP9-H4TW', deviceName: 'Telefon');
      expect(seen.map((r) => r.url.path), [
        '/api/box/info',
        '/api/enrol/complete',
      ]);
      expect(out.box.cloud, defaultCloudOrigin);
      // Later requests of the saved enrolment also use public TLS.
      final saved = (await mem.load())!;
      expect(usesPublicTls(saved), isTrue);
      final c = await store0.boxClient(saved, _NoCas());
      expect((await c.getJson('/api/box/info'))['boxId'], '2239217507948bed');
    },
  );

  test('a non-mymaxcom origin is refused, never an unpinned client', () {
    for (final o in [
      'https://evil.example',
      'https://mymaxcom.my.evil.example',
      'https://notmymaxcom.my',
      'http://api.mymaxcom.my',
      'https://10.0.0.5:8443',
    ]) {
      expect(
        () => trust.publicCloudClient(Uri.parse(o)),
        throwsA(isA<TrustError>()),
        reason: o,
      );
    }
    expect(seen, isEmpty);
    expect(isPublicCloudOrigin(Uri.parse('https://mymaxcom.my')), isTrue);
    expect(
      isPublicCloudOrigin(Uri.parse('https://api.mymaxcom.my:8443')),
      isTrue,
    );
  });

  test('a TrustError reads as a clear message in both languages', () {
    expect(OpsEnrolTexts.of('ms').tlsFailed, contains('awan MAXCOM'));
    expect(OpsEnrolTexts.of('en').tlsFailed, contains('MAXCOM cloud'));
  });
}

class _NoCas implements CaDerSource {
  @override
  Future<Null> loadCaDer(String sha256) async => null;
}
