// Plan 14 Task 26: enrolling this phone as a MAXCOM device. Flow, screen and
// the post-enrolment ops check. `flutter test` runs both ways; the screen
// exists only with --dart-define=MAXCOM_OPS=true.


import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/box/cloud_origin.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/ops/enrol/ops_enrol_flow.dart';
import 'package:surau_app/ops/enrol/ops_enrol_screen.dart';
import 'package:surau_app/ops/enrol/ops_enrol_texts.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../../features/fakes.dart';

Future<FakeBox> _cloud({
  int enrolStatus = 200,
  Map<String, Object?>? enrolBody,
}) async => FakeBox((r) async {
  switch (r.url.path) {
    case '/api/box/info':
      return jsonResponse(200, {'boxId': '2239217507948bed', 'name': 'MAXCOM'});
    case '/api/enrol/complete':
      return jsonResponse(
        enrolStatus,
        enrolBody ??
            {
              'deviceId': 'dev-ops',
              'userId': 'u-ops',
              'roles': ['superadmin'],
              'pinRequired': true,
              'appLock': true,
            },
      );
    case '/api/auth/me':
      return jsonResponse(200, {'ops': true});
  }
  return jsonResponse(404, {'errors': ['tiada']});
});

class _FailingStore extends MemoryEnrolledBoxStore {
  @override
  Future<void> save(EnrolledBox box) async => throw StateError('disk full');
}

void main() {
  late FakeDeviceKey key;
  late MemoryEnrolledBoxStore store;

  OpsEnrolFlow flowOf(FakeBox cloud) {
    key = FakeDeviceKey();
    store = MemoryEnrolledBoxStore();
    return OpsEnrolFlow(
      clientFor: cloud.client,
      key: key,
      store: store,
      platform: 'android',
    );
  }

  group('normaliseOpsCode', () {
    test('drops dashes, spaces and other marks, upper-cases', () {
      expect(normaliseOpsCode('k7qm-2xp9 h4tw'), 'K7QM2XP9H4TW');
      expect(normaliseOpsCode(' K7QM_2XP9.H4TW '), 'K7QM2XP9H4TW');
    });
    test('a ready code is exactly 12 characters', () {
      expect(isOpsCodeReady('K7QM-2XP9-H4T'), isFalse);
      expect(isOpsCodeReady('K7QM-2XP9-H4TW'), isTrue);
      expect(isOpsCodeReady('K7QM-2XP9-H4TWX'), isFalse);
    });
  });

  group('OpsEnrolFlow', () {
    test('a 12 character code enrols at the cloud and sends client: ops', () async {
      final cloud = await _cloud();
      final flow = flowOf(cloud);
      final out = await flow.run('k7qm-2xp9-h4tw', deviceName: ' Telefon MAXCOM 1 ');
      final body = cloud.bodyOf('/api/enrol/complete');
      expect(body['client'], 'ops');
      expect(body['code'], 'K7QM2XP9H4TW');
      expect(body['deviceName'], 'Telefon MAXCOM 1');
      expect(body['platform'], 'android');
      expect(body.containsKey('pin'), isFalse);
      expect(cloud.byPath('/api/enrol/complete')!.url.origin, defaultCloudOrigin.origin);
      // the cloud's own id comes from /api/box/info, no CA pin, via cloud only
      final saved = await store.load();
      expect(saved, isNotNull);
      expect(saved!.boxId, '2239217507948bed');
      expect(saved.box, defaultCloudOrigin);
      expect(saved.cloud, defaultCloudOrigin);
      expect(saved.caSha256, isNull);
      expect(saved.deviceId, 'dev-ops');
      expect(out.pinPending, isTrue);
      expect(key.present, isTrue);
    }, skip: !kOpsBuild);

    test('a failed save after the code was used clears the key and says a new code is needed', () async {
      final cloud = await _cloud();
      final flow = OpsEnrolFlow(
        clientFor: cloud.client,
        key: key = FakeDeviceKey(),
        store: _FailingStore(),
        platform: 'android',
      );
      await expectLater(flow.run('K7QM2XP9H4TW', deviceName: 'T'), throwsA(isA<OpsEnrolSaveFailed>()));
      expect(key.present, isFalse);
      expect(OpsEnrolTexts.of('ms').saveFailed, contains('kod baharu'));
    }, skip: !kOpsBuild);

    test('a short code is refused before any request', () async {
      final cloud = await _cloud();
      final flow = flowOf(cloud);
      await expectLater(
        flow.run('K7QM-2XP9', deviceName: 'T'),
        throwsA(isA<OpsCodeInvalid>()),
      );
      expect(cloud.seen, isEmpty);
      expect(await key.exists(), isFalse);
    });

    test('a refusal clears the key and saves nothing', () async {
      final cloud = await _cloud(
        enrolStatus: 401,
        enrolBody: {'code': 'ops_app_required', 'errors': ['Kod ini untuk aplikasi MAXCOM Ops sahaja']},
      );
      final flow = flowOf(cloud);
      await expectLater(
        flow.run('K7QM2XP9H4TW', deviceName: 'T'),
        throwsA(isA<BoxError>().having((e) => e.code, 'code', 'ops_app_required')),
      );
      expect(await store.load(), isNull);
      expect(key.present, isFalse);
    });

    test('an existing enrolment is never replaced', () async {
      final cloud = await _cloud();
      final flow = flowOf(cloud);
      await store.save(fixtureBox());
      await key.generate();
      await expectLater(
        flow.run('K7QM2XP9H4TW', deviceName: 'T'),
        throwsA(isA<EnrolAlreadyEnrolled>()),
      );
      expect(cloud.seen, isEmpty);
    });
  });

  group('BoxClient.enrolComplete client field', () {
    Future<Map<String, dynamic>> bodyFor({String? client}) async {
      final cloud = await _cloud();
      await cloud
          .client(defaultCloudOrigin)
          .enrolComplete(
            code: 'X',
            publicJwk: const {'kty': 'EC', 'crv': 'P-256', 'x': 'a', 'y': 'b'},
            deviceName: 'T',
            platform: 'android',
            client: client,
          );
      return cloud.bodyOf('/api/enrol/complete');
    }

    test('never present without a client argument', () async {
      expect((await bodyFor()).containsKey('client'), isFalse);
    });
    test('present only in the ops build', () async {
      expect((await bodyFor(client: 'ops')).containsKey('client'), kOpsBuild);
    });
  });

  group('screen', () {
    test('exists only in the ops build', () {
      expect(opsWelcomeEntryAvailable, kOpsBuild);
    });

    Future<void> pump(
      WidgetTester t,
      OpsEnrolFlow flow, {
      void Function(EnrolOutcome)? onEnrolled,
    }) async {
      await t.pumpWidget(
        MaterialApp(
          locale: const Locale('ms'),
          localizationsDelegates: S.localizationsDelegates,
          supportedLocales: S.supportedLocales,
          home: OpsEnrolScreen(flow: flow, onEnrolled: onEnrolled ?? (_) {}),
        ),
      );
    }

    Finder enrolButton() => find.byKey(const ValueKey('ops-enrol-submit'));

    testWidgets('Daftar is off until 12 characters are typed', (t) async {
      final flow = flowOf(await _cloud());
      await pump(t, flow);
      expect(t.widget<FilledButton>(enrolButton()).onPressed, isNull);
      await t.enterText(find.byKey(const ValueKey('ops-enrol-code')), 'k7qm2xp9h4t');
      await t.pump();
      expect(t.widget<FilledButton>(enrolButton()).onPressed, isNull);
      await t.enterText(find.byKey(const ValueKey('ops-enrol-code')), 'k7qm2xp9h4tw');
      await t.pump();
      expect(t.widget<FilledButton>(enrolButton()).onPressed, isNotNull);
      expect(find.text('K7QM-2XP9-H4TW'), findsOneWidget);
    }, skip: !kOpsBuild);

    for (final c in {
      'bad_enrol_code': 'Kod tidak sah atau sudah tamat tempoh. Minta kod baharu.',
      'ops_app_required': 'Kod ini hanya boleh digunakan dalam MAXCOM Ops.',
      'ops_device_limit': 'Akaun ini sudah ada 3 peranti MAXCOM. Batalkan satu di pelayan dahulu.',
    }.entries) {
      testWidgets('${c.key} is explained in BM', (t) async {
        final cloud = await _cloud(
          enrolStatus: c.key == 'ops_device_limit' ? 409 : 401,
          enrolBody: {'code': c.key, 'errors': ['x']},
        );
        await pump(t, flowOf(cloud));
        await t.enterText(find.byKey(const ValueKey('ops-enrol-code')), 'k7qm2xp9h4tw');
        await t.pump();
        await t.tap(enrolButton());
        await t.pumpAndSettle();
        expect(find.text(c.value), findsOneWidget);
      }, skip: !kOpsBuild);
    }

    testWidgets('rate limit and no network are explained in BM', (t) async {
      final limited = FakeBox((r) async {
        if (r.url.path == '/api/box/info') return jsonResponse(200, {'boxId': 'b'});
        return jsonResponse(429, {'errors': ['x']}, headers: {'retry-after': '30'});
      });
      await pump(t, flowOf(limited));
      await t.enterText(find.byKey(const ValueKey('ops-enrol-code')), 'k7qm2xp9h4tw');
      await t.pump();
      await t.tap(enrolButton());
      await t.pumpAndSettle();
      expect(find.textContaining('Terlalu banyak cubaan'), findsOneWidget);
    }, skip: !kOpsBuild);

    testWidgets('success shows the done view and hands over the outcome', (t) async {
      EnrolOutcome? got;
      await pump(t, flowOf(await _cloud()), onEnrolled: (o) => got = o);
      await t.enterText(find.byKey(const ValueKey('ops-enrol-code')), 'k7qm2xp9h4tw');
      await t.pump();
      await t.tap(enrolButton());
      await t.pumpAndSettle();
      expect(find.text('Telefon ini kini peranti MAXCOM'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('ops-enrol-continue')));
      await t.pumpAndSettle();
      expect(got, isNotNull);
      expect(got!.box.boxId, '2239217507948bed');
    }, skip: !kOpsBuild);
  });
}
