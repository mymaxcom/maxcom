// Plan 14 Task 15: Kotak menunggu, the approve sheet, and revoke or restore a box with a typed confirmation, in the
// ops build. Run with --dart-define=MAXCOM_OPS=true; skipped in the public build (it has no such screen).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/ops/fleet/approve_sheet.dart';
import 'package:surau_app/ops/fleet/box_actions.dart' show rejectPath;
import 'package:surau_app/ops/fleet/fleet_models.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import 'fleet_support.dart';

ValueKey<String> _key(String k) => ValueKey<String>(k);

const _boxA = '9f02b7aa1c4e0d11';
const _boxB = '51d308e9f6b0aa22';

List<Map<String, Object?>> pendingFixture() => [
  {
    'boxId': _boxA,
    'name': 'Surau Kampung Contoh',
    'at': iso(const Duration(minutes: 30)),
    'boxName': 'KotakTV Ruang Solat',
    'platform': 'android',
    'version': '2026.11.6',
    'heldByCap': true,
  },
  {'boxId': _boxB, 'name': 'Masjid Kariah Contoh', 'at': iso(const Duration(hours: 3)), 'platform': 'windows', 'heldByCap': false},
];

/// The fleet plus a surau whose only box was revoked (it may take a new box) and a suspended one with no box.
List<Map<String, Object?>> fleetWithJoinable() => [
  ...fleetFixture(),
  surau(
    'lama-contoh',
    'Masjid Kariah Lama Contoh',
    boxes: [box('3c88e1d02a5f1111', name: 'Kotak lama', seen: const Duration(days: 9), revoked: true)],
  ),
  surau('senyap-contoh', 'Surau Senyap Contoh', status: 'Digantung', suspendedAt: '2026-11-02T08:00:00.000Z', reason: 'x', linkedAt: null),
];

Future<ShellHarness> openPending(
  WidgetTester tester, {
  List<String> roles = const ['superadmin'],
  List<Map<String, Object?>>? pending,
}) async {
  final h = await openCloud(tester, roles: roles, suraus: fleetWithJoinable());
  h.handlers['GET /api/fleet/pending'] = (r) async => jsonResponse(200, {'pending': pending ?? pendingFixture()});
  h.router.go('/ops/pending');
  await settle(tester);
  return h;
}

Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(_key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await settle(tester);
}

bool _enabled(WidgetTester tester, String key) {
  final b = tester.widget<FilledButton>(find.byKey(_key(key)));
  return b.onPressed != null;
}

void main() {
  const skip = !kOpsBuild;

  group('the helpers', () {
    test('the approval body has exactly one target and never a default', () {
      expect(approveBody(existing: false), {'newSurau': true});
      expect(approveBody(existing: true, surauId: 'a-b'), {'surauId': 'a-b'});
      expect(approvePath(_boxA), '/api/fleet/pending/$_boxA/approve');
    });

    test('only suraus with no live box that are not suspended can take a box', () {
      final all = parseSuraus({'suraus': fleetWithJoinable()});
      final ids = joinable(all, fixedNow()).map((s) => s.id).toSet();
      expect(ids, {'taman-contoh', 'lama-contoh'});
    });
  });

  group('the list', skip: skip, () {
    testWidgets('shows the name, box name, platform, version, id in groups, age and the cap note', (tester) async {
      await openPending(tester);
      final a = find.byKey(_key('pending-card-$_boxA'));
      expect(find.descendant(of: a, matching: find.text('Surau Kampung Contoh')), findsOneWidget);
      expect(find.descendant(of: a, matching: find.text('Kotak: KotakTV Ruang Solat')), findsOneWidget);
      expect(find.descendant(of: a, matching: find.text('Platform: Android')), findsOneWidget);
      expect(find.descendant(of: a, matching: find.text('Versi 2026.11.6')), findsOneWidget);
      expect(find.descendant(of: a, matching: find.text('ID kotak 9f02-b7aa-1c4e-0d11')), findsOneWidget);
      expect(find.descendant(of: a, matching: find.text('Mendaftar 30 minit lalu')), findsOneWidget);
      expect(find.byKey(_key('pending-held-$_boxA')), findsOneWidget);
      expect(find.byKey(_key('pending-held-$_boxB')), findsNothing);
      expect(find.byKey(_key('pending-card-$_boxB')), findsOneWidget);
    });

    testWidgets('says so when nothing waits', (tester) async {
      await openPending(tester, pending: const []);
      expect(find.byKey(_key('pending-empty')), findsOneWidget);
    });

    testWidgets('shows the cloud\'s own message when the Worker cannot be reached', (tester) async {
      final h = await openCloud(tester, suraus: fleetWithJoinable());
      h.handlers['GET /api/fleet/pending'] = (r) async =>
          jsonResponse(502, {'errors': ['MAXCOM tidak dapat menyemak pendaftaran kotak sekarang; cuba lagi'], 'code': 'worker_unreachable'});
      h.router.go('/ops/pending');
      await settle(tester);
      expect(find.text('MAXCOM tidak dapat menyemak pendaftaran kotak sekarang; cuba lagi'), findsOneWidget);
      expect(find.byKey(_key('fleet-retry')), findsOneWidget);
    });

    testWidgets('the menu has the row, and Sokongan MAXCOM reads but cannot approve', (tester) async {
      await openPending(tester, roles: const ['support']);
      expect(find.byKey(_key('pending-card-$_boxA')), findsOneWidget);
      expect(find.byKey(_key('pending-approve-$_boxA')), findsNothing);
    });

    testWidgets('golden: the list on a phone', (tester) async {
      final h = await openPending(tester);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_pending_phone.png'));
    });
  });

  group('approve', skip: skip, () {
    testWidgets('a new surau: the name is prefilled from the registration, the button is ready, the body is newSurau', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST /api/fleet/pending/$_boxA/approve'] = (r) async => jsonResponse(200, {'surauId': 'kampung-contoh', 'created': true});
      await tapKey(tester, 'pending-approve-$_boxA');
      expect(tester.widget<Text>(find.byKey(_key('approve-new-name'))).data, 'Surau Kampung Contoh');
      expect(_enabled(tester, 'approve-submit'), isTrue);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_approve_new_phone.png'));
      await tapKey(tester, 'approve-submit');
      final req = seenAt(h, '/api/fleet/pending/$_boxA/approve').single;
      expect(bodyOfRequest(req), {'newSurau': true});
      expect(find.byKey(_key('approve-submit')), findsNothing);
      expect(find.text('Kotak diluluskan. Surau baharu dicipta.'), findsOneWidget);
    });

    testWidgets('an existing surau lists only suraus without a live box, and needs the name typed', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST /api/fleet/pending/$_boxB/approve'] = (r) async => jsonResponse(200, {'surauId': 'taman-contoh', 'created': false});
      await tapKey(tester, 'pending-approve-$_boxB');
      await tapKey(tester, 'approve-existing');
      expect(find.byKey(_key('approve-surau-taman-contoh')), findsOneWidget);
      expect(find.byKey(_key('approve-surau-lama-contoh')), findsOneWidget);
      for (final id in ['dwaqaf', 'al-hidayah', 'masjid-contoh', 'bukit-contoh', 'senyap-contoh']) {
        expect(find.byKey(_key('approve-surau-$id')), findsNothing, reason: id);
      }
      // disabled until a target is chosen and its name typed
      expect(_enabled(tester, 'approve-submit'), isFalse);
      await tapKey(tester, 'approve-surau-taman-contoh');
      expect(_enabled(tester, 'approve-submit'), isFalse);
      await tester.enterText(find.byKey(_key('approve-confirm-name')), 'Surau Taman');
      await tester.pump();
      expect(_enabled(tester, 'approve-submit'), isFalse);
      await tester.enterText(find.byKey(_key('approve-confirm-name')), 'Surau Taman Contoh');
      await tester.pump();
      expect(_enabled(tester, 'approve-submit'), isTrue);
      await tester.pumpAndSettle(); // the button's colour change finishes before the picture
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_approve_existing_phone.png'));
      await tapKey(tester, 'approve-submit');
      expect(bodyOfRequest(seenAt(h, '/api/fleet/pending/$_boxB/approve').single), {'surauId': 'taman-contoh'});
      expect(find.text('Kotak diluluskan ke surau sedia ada.'), findsOneWidget);
    });

    testWidgets('picking another surau clears the typed name', (tester) async {
      await openPending(tester);
      await tapKey(tester, 'pending-approve-$_boxB');
      await tapKey(tester, 'approve-existing');
      await tapKey(tester, 'approve-surau-taman-contoh');
      await tester.enterText(find.byKey(_key('approve-confirm-name')), 'Surau Taman Contoh');
      await tester.pump();
      await tapKey(tester, 'approve-surau-lama-contoh');
      expect(_enabled(tester, 'approve-submit'), isFalse);
    });

    const refusals = {
      'surau_has_box': (409, 'Surau ini sudah ada kotak yang aktif. Batalkan kotak itu dahulu.'),
      'foreign_surau': (409, 'Kotak ini milik surau lain dan tidak boleh dipindahkan.'),
      'bad_code': (401, 'Kod tidak sah atau sudah tamat tempoh.'),
      'worker_unreachable': (502, 'MAXCOM tidak dapat menyemak pendaftaran kotak sekarang. Cuba lagi.'),
    };
    for (final e in refusals.entries) {
      testWidgets('the cloud says ${e.key}: shown in BM, the sheet stays open', (tester) async {
        final h = await openPending(tester);
        h.handlers['POST /api/fleet/pending/$_boxA/approve'] = (r) async =>
            jsonResponse(e.value.$1, {'errors': ['english or odd wording from the server'], 'code': e.key});
        await tapKey(tester, 'pending-approve-$_boxA');
        await tapKey(tester, 'approve-submit');
        expect(find.byKey(_key('approve-error')), findsOneWidget);
        expect(find.text(e.value.$2), findsOneWidget);
        expect(find.byKey(_key('approve-submit')), findsOneWidget);
        expect(_enabled(tester, 'approve-submit'), isTrue, reason: 'the person can try again');
      });
    }

    testWidgets('an unknown refusal shows the server\'s own message', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST /api/fleet/pending/$_boxA/approve'] = (r) async =>
          jsonResponse(400, {'errors': ['Nama diperlukan'], 'code': 'bad_args'});
      await tapKey(tester, 'pending-approve-$_boxA');
      await tapKey(tester, 'approve-submit');
      expect(find.text('Nama diperlukan'), findsOneWidget);
    });
  });

  group('reject a waiting box', skip: skip, () {
    final path = '/api/fleet/pending/$_boxA/reject';

    test('the path', () {
      expect(rejectPath(_boxA), path);
    });

    testWidgets('needs TOLAK typed; nothing is sent before; then posts once and the list reloads', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST $path'] = (r) async => jsonResponse(200, {'rejected': true});
      await tapKey(tester, 'pending-reject-$_boxA');
      expect(find.byKey(_key('typed-confirm-field')), findsOneWidget);
      expect(_enabled(tester, 'typed-confirm-submit'), isFalse);
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'TOLA');
      await tester.pump();
      expect(_enabled(tester, 'typed-confirm-submit'), isFalse);
      expect(seenAt(h, path), isEmpty);
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'tolak');
      await tester.pump();
      expect(_enabled(tester, 'typed-confirm-submit'), isTrue);
      await tester.pumpAndSettle();
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_reject_phone.png'));
      h.handlers['GET /api/fleet/pending'] = (r) async => jsonResponse(200, {'pending': [pendingFixture()[1]]});
      await tapKey(tester, 'typed-confirm-submit');
      expect(seenAt(h, path), hasLength(1));
      expect(find.text('Kotak ditolak'), findsOneWidget);
      expect(find.byKey(_key('pending-card-$_boxA')), findsNothing);
      expect(find.byKey(_key('pending-card-$_boxB')), findsOneWidget);
    });

    testWidgets('cancelling sends nothing', (tester) async {
      final h = await openPending(tester);
      await tapKey(tester, 'pending-reject-$_boxA');
      await tapKey(tester, 'typed-confirm-cancel');
      expect(h.box.seen.where((r) => r.method == 'POST'), isEmpty);
    });

    testWidgets('a linked box is refused with the BM reason', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST $path'] = (r) async => jsonResponse(409, {'errors': ['x'], 'code': 'already_linked'});
      await tapKey(tester, 'pending-reject-$_boxA');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'TOLAK');
      await tester.pump();
      await tapKey(tester, 'typed-confirm-submit');
      expect(find.text('Kotak ini sudah dipautkan atau diluluskan; guna Batal kotak, bukan Tolak.'), findsOneWidget);
    });

    testWidgets('Worker unreachable shows the BM reason', (tester) async {
      final h = await openPending(tester);
      h.handlers['POST $path'] = (r) async => jsonResponse(502, {'errors': ['x'], 'code': 'worker_unreachable'});
      await tapKey(tester, 'pending-reject-$_boxA');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'TOLAK');
      await tester.pump();
      await tapKey(tester, 'typed-confirm-submit');
      expect(find.text('MAXCOM tidak dapat menyemak pendaftaran kotak sekarang. Cuba lagi.'), findsOneWidget);
    });

    testWidgets('Sokongan MAXCOM has no Tolak button', (tester) async {
      await openPending(tester, roles: const ['support']);
      expect(find.byKey(_key('pending-card-$_boxA')), findsOneWidget);
      expect(find.byKey(_key('pending-reject-$_boxA')), findsNothing);
    });
  });

  group('revoke and restore', skip: skip, () {
    Future<ShellHarness> openDetail(WidgetTester tester, String id, {List<String> roles = const ['superadmin']}) async {
      final h = await openCloud(tester, roles: roles, suraus: fleetWithJoinable());
      h.router.go('/ops/suraus/$id');
      await settle(tester);
      return h;
    }

    testWidgets('revoking needs the word typed; nothing is sent before', (tester) async {
      final h = await openDetail(tester, 'dwaqaf');
      h.handlers['POST /api/fleet/boxes/3c88e1d02a5f0000/revoke'] = (r) async => jsonResponse(200, {'revoked': true});
      await tapKey(tester, 'revoke-3c88e1d02a5f0000');
      expect(find.byKey(_key('typed-confirm-field')), findsOneWidget);
      expect(_enabled(tester, 'typed-confirm-submit'), isFalse);
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'BATA');
      await tester.pump();
      expect(_enabled(tester, 'typed-confirm-submit'), isFalse);
      expect(seenAt(h, '/api/fleet/boxes/3c88e1d02a5f0000/revoke'), isEmpty);
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'batal');
      await tester.pump();
      expect(_enabled(tester, 'typed-confirm-submit'), isTrue);
      await tester.pumpAndSettle();
      await expectLater(find.byWidget(h.app), matchesGoldenFile('ops_revoke_phone.png'));
      await tapKey(tester, 'typed-confirm-submit');
      expect(seenAt(h, '/api/fleet/boxes/3c88e1d02a5f0000/revoke'), hasLength(1));
      expect(find.text('Kotak dibatalkan'), findsOneWidget);
    });

    testWidgets('cancelling the typed sheet sends nothing', (tester) async {
      final h = await openDetail(tester, 'dwaqaf');
      await tapKey(tester, 'revoke-3c88e1d02a5f0000');
      await tapKey(tester, 'typed-confirm-cancel');
      expect(h.box.seen.where((r) => r.method == 'POST'), isEmpty);
    });

    testWidgets('restoring a revoked box asks once and posts', (tester) async {
      final h = await openDetail(tester, 'lama-contoh');
      h.handlers['POST /api/fleet/boxes/3c88e1d02a5f1111/unrevoke'] = (r) async => jsonResponse(200, {'surauId': 'lama-contoh'});
      await tapKey(tester, 'unrevoke-3c88e1d02a5f1111');
      expect(seenAt(h, '/api/fleet/boxes/3c88e1d02a5f1111/unrevoke'), isEmpty);
      await tester.tap(find.text('Pulihkan kotak').last);
      await settle(tester);
      expect(seenAt(h, '/api/fleet/boxes/3c88e1d02a5f1111/unrevoke'), hasLength(1));
      expect(find.text('Kotak dipulihkan'), findsOneWidget);
    });

    testWidgets('a refused restore shows the BM reason', (tester) async {
      final h = await openDetail(tester, 'lama-contoh');
      h.handlers['POST /api/fleet/boxes/3c88e1d02a5f1111/unrevoke'] = (r) async =>
          jsonResponse(409, {'errors': ['x'], 'code': 'surau_has_box'});
      await tapKey(tester, 'unrevoke-3c88e1d02a5f1111');
      await tester.tap(find.text('Pulihkan kotak').last);
      await settle(tester);
      expect(find.text('Surau ini sudah ada kotak yang aktif. Batalkan kotak itu dahulu.'), findsOneWidget);
    });

    testWidgets('Sokongan MAXCOM sees the boxes with no revoke or restore button', (tester) async {
      await openDetail(tester, 'lama-contoh', roles: const ['support']);
      expect(find.byKey(_key('box-row-3c88e1d02a5f1111')), findsOneWidget);
      expect(find.byKey(_key('unrevoke-3c88e1d02a5f1111')), findsNothing);
      expect(find.byKey(_key('revoke-3c88e1d02a5f1111')), findsNothing);
    });
  });

  group('gate lows', skip: skip, () {
    testWidgets('the approve sheet says loading, then error with a retry, not "no surau"', (tester) async {
      final h = await openPending(tester);
      var fail = true;
      h.handlers['GET /api/suraus'] = (r) async =>
          fail ? jsonResponse(502, {'errors': ['MAXCOM tidak dapat dihubungi']}) : jsonResponse(200, {'suraus': fleetWithJoinable()});
      await tapKey(tester, 'pending-approve-$_boxB');
      await tapKey(tester, 'approve-existing');
      expect(find.byKey(_key('approve-none')), findsNothing);
      expect(find.byIcon(Icons.cloud_off_rounded), findsOneWidget);
      fail = false;
      await tester.tap(find.text('Cuba lagi'));
      await settle(tester);
      expect(find.byKey(_key('approve-surau-taman-contoh')), findsOneWidget);
    });

    testWidgets('the sheet cannot be dismissed while the approval is in flight', (tester) async {
      final h = await openPending(tester);
      final gate = Completer<http.Response>();
      h.handlers['POST /api/fleet/pending/$_boxA/approve'] = (r) => gate.future;
      await tapKey(tester, 'pending-approve-$_boxA');
      await tester.tap(find.byKey(_key('approve-submit')));
      await tester.pump();
      await tester.tapAt(const Offset(10, 10)); // the barrier
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(_key('approve-submit')), findsOneWidget);
      gate.complete(jsonResponse(200, {'surauId': 'x', 'created': true}));
      await settle(tester);
      expect(find.byKey(_key('approve-submit')), findsNothing);
    });

    testWidgets('a refusal (4xx) reads both lists again, so a stale card cannot error forever', (tester) async {
      final h = await openPending(tester);
      final path = '/api/fleet/pending/$_boxA/reject';
      h.handlers['POST $path'] = (r) async => jsonResponse(409, {'errors': ['x'], 'code': 'linked'});
      await tapKey(tester, 'pending-reject-$_boxA');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'TOLAK');
      await tester.pump();
      h.handlers['GET /api/fleet/pending'] = (r) async => jsonResponse(200, {'pending': [pendingFixture()[1]]});
      await tapKey(tester, 'typed-confirm-submit');
      expect(seenAt(h, path), hasLength(1));
      expect(find.byKey(_key('pending-card-$_boxA')), findsNothing);
      expect(find.byKey(_key('pending-card-$_boxB')), findsOneWidget);
    });
  });
}
