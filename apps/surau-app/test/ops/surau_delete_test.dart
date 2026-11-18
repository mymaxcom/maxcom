// Delete an empty surau from the fleet detail, the Empty chip, and the held note of Kotak menunggu. Run with
// --dart-define=MAXCOM_OPS=true; the widget groups are skipped in the public build.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/ops/fleet/fleet_models.dart';
import 'package:surau_app/ops/fleet/fleet_providers.dart';
import 'package:surau_app/ops/fleet/fleet_texts.dart';
import 'package:surau_app/ops/ops_build.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import 'fleet_support.dart';

ValueKey<String> _key(String k) => ValueKey<String>(k);

Map<String, Object?> _empty(String id, String name) => {
  ...surau(id, name, status: 'Menunggu MAXCOM', linkedAt: null, used: 0),
  'empty': true,
};

List<Map<String, Object?>> _fleet() => [
  ...fleetFixture(),
  _empty('kosong-contoh', 'Surau Kosong Contoh'),
  {...surau('penuh-contoh', 'Surau Penuh Contoh'), 'empty': false},
];

Future<void> _tap(WidgetTester tester, String key) async {
  final f = find.byKey(_key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await settle(tester);
}

Future<ShellHarness> _open(
  WidgetTester tester,
  String id, {
  List<String> roles = const ['superadmin'],
  List<Map<String, Object?>>? suraus,
}) async {
  final h = await openCloud(tester, roles: roles, suraus: suraus ?? _fleet());
  h.router.go('/ops/suraus/$id');
  await settle(tester);
  return h;
}

void main() {
  const skip = !kOpsBuild;

  group('parsing', () {
    test('empty is read, and false when the field is absent', () {
      expect(FleetSurau.fromJson(_empty('a', 'A')).empty, isTrue);
      expect(FleetSurau.fromJson({...surau('a', 'A'), 'empty': false}).empty, isFalse);
      expect(FleetSurau.fromJson(surau('a', 'A')).empty, isFalse);
    });

    test('held is read, and an older server reads from heldByCap', () {
      PendingBox p(Map<String, Object?> extra) => PendingBox.fromJson({'boxId': 'aaaa', 'name': 'X', ...extra});
      expect(p({'held': 'daily_cap'}).held, 'daily_cap');
      expect(p({'held': 'other'}).held, 'other');
      expect(p({'held': 'weird'}).held, isNull);
      expect(p({'heldByCap': true}).held, 'daily_cap');
      expect(p({'heldByCap': false}).held, isNull);
      expect(p({}).held, isNull);
    });

    test('the new words exist in both languages', () {
      expect(FleetT.ms.deleteSurau, 'Padam surau kosong');
      expect(FleetT.en.deleteSurau, 'Delete empty surau');
      expect(FleetT.ms.stateEmpty, 'Kosong');
      expect(FleetT.en.stateEmpty, 'Empty');
      expect(FleetT.ms.pendingHeldOther, 'Tertahan');
      expect(FleetT.en.pendingHeldOther, 'Held');
      expect(FleetT.ms.pendingNote, startsWith('Kotak memaut sendiri secara automatik.'));
      expect(FleetT.en.pendingNote, startsWith('Boxes link themselves automatically.'));
    });
  });

  group('delete an empty surau', skip: skip, () {
    testWidgets('the button shows for an empty surau and a Pentadbir MAXCOM', (tester) async {
      await _open(tester, 'kosong-contoh');
      expect(find.byKey(_key('delete-empty-surau')), findsOneWidget);
      expect(find.text('Padam surau kosong'), findsOneWidget);
      expect(find.byKey(_key('detail-empty-chip')), findsOneWidget);
    });

    testWidgets('a surau that is not empty has no button', (tester) async {
      await _open(tester, 'penuh-contoh');
      expect(find.byKey(_key('delete-empty-surau')), findsNothing);
      expect(find.byKey(_key('detail-empty-chip')), findsNothing);
    });

    testWidgets('Sokongan MAXCOM has no button on an empty surau', (tester) async {
      await _open(tester, 'kosong-contoh', roles: const ['support']);
      expect(find.byKey(_key('delete-empty-surau')), findsNothing);
    });

    testWidgets('the name must be typed; nothing is sent before', (tester) async {
      final h = await _open(tester, 'kosong-contoh');
      await _tap(tester, 'delete-empty-surau');
      expect(find.byKey(_key('typed-confirm-field')), findsOneWidget);
      bool enabled() => tester.widget<FilledButton>(find.byKey(_key('typed-confirm-submit'))).onPressed != null;
      expect(enabled(), isFalse);
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'Surau Kosong');
      await tester.pump();
      expect(enabled(), isFalse);
      expect(h.box.seen.where((r) => r.method == 'DELETE'), isEmpty);
      await _tap(tester, 'typed-confirm-cancel');
      expect(h.box.seen.where((r) => r.method == 'DELETE'), isEmpty);
    });

    testWidgets('200: deleted, toast, back to the list, list read again, acting surau cleared', (tester) async {
      var list = _fleet();
      final h = await _open(tester, 'kosong-contoh', suraus: list);
      h.handlers['GET /api/suraus'] = (r) async => jsonResponse(200, {'suraus': list});
      h.handlers['DELETE /api/fleet/suraus/kosong-contoh'] = (r) async {
        list = [
          for (final s in list)
            if (s['id'] != 'kosong-contoh') s,
        ];
        return jsonResponse(200, {'deleted': true});
      };
      h.container
          .read(actingSurauProvider.notifier)
          .choose(const ActingSurau(id: 'kosong-contoh', name: 'Surau Kosong Contoh'));
      await settle(tester);
      final before = seenAt(h, '/api/suraus').length;
      await _tap(tester, 'delete-empty-surau');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'surau kosong contoh');
      await tester.pump();
      await _tap(tester, 'typed-confirm-submit');
      expect(seenAt(h, '/api/fleet/suraus/kosong-contoh'), hasLength(1));
      expect(seenAt(h, '/api/fleet/suraus/kosong-contoh').single.method, 'DELETE');
      expect(find.text('Surau dipadam'), findsOneWidget);
      expect(h.container.read(actingSurauProvider), isNull);
      expect(seenAt(h, '/api/suraus').length, greaterThan(before));
      expect(find.byKey(_key('fleet-card-kosong-contoh')), findsNothing);
      expect(find.byKey(_key('fleet-card-al-hidayah')), findsOneWidget);
    });

    testWidgets('200 for another acting surau leaves that choice alone', (tester) async {
      final h = await _open(tester, 'kosong-contoh');
      h.handlers['DELETE /api/fleet/suraus/kosong-contoh'] = (r) async => jsonResponse(200, {'deleted': true});
      h.container.read(actingSurauProvider.notifier).choose(const ActingSurau(id: 'dwaqaf', name: 'Surau Dwaqaf'));
      await settle(tester);
      await _tap(tester, 'delete-empty-surau');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'Surau Kosong Contoh');
      await tester.pump();
      await _tap(tester, 'typed-confirm-submit');
      expect(h.container.read(actingSurauProvider)?.id, 'dwaqaf');
    });

    testWidgets('409 not_empty: says so, stays, keeps the acting surau, reads the list again', (tester) async {
      final h = await _open(tester, 'kosong-contoh');
      h.handlers['DELETE /api/fleet/suraus/kosong-contoh'] = (r) async => jsonResponse(409, {
        'errors': ['x'],
        'code': 'not_empty',
      });
      h.container
          .read(actingSurauProvider.notifier)
          .choose(const ActingSurau(id: 'kosong-contoh', name: 'Surau Kosong Contoh'));
      await settle(tester);
      final before = seenAt(h, '/api/suraus').length;
      await _tap(tester, 'delete-empty-surau');
      await tester.enterText(find.byKey(_key('typed-confirm-field')), 'Surau Kosong Contoh');
      await tester.pump();
      await _tap(tester, 'typed-confirm-submit');
      expect(find.text('Surau ini tidak kosong lagi'), findsOneWidget);
      expect(h.container.read(actingSurauProvider)?.id, 'kosong-contoh');
      expect(seenAt(h, '/api/suraus').length, greaterThan(before));
    });
  });

  group('the list chip', skip: skip, () {
    testWidgets('Kosong shows on empty suraus only', (tester) async {
      await openCloud(tester, suraus: _fleet());
      expect(find.byKey(_key('empty-chip-kosong-contoh')), findsOneWidget);
      expect(find.byKey(_key('empty-chip-penuh-contoh')), findsNothing);
      expect(find.byKey(_key('empty-chip-al-hidayah')), findsNothing);
    });
  });

  group('Kotak menunggu', skip: skip, () {
    testWidgets('the new note and the held words', (tester) async {
      final h = await openCloud(tester, suraus: _fleet());
      h.handlers['GET /api/fleet/pending'] = (r) async => jsonResponse(200, {
        'pending': [
          {'boxId': 'aaaa1111aaaa1111', 'name': 'Satu', 'held': 'daily_cap'},
          {'boxId': 'bbbb2222bbbb2222', 'name': 'Dua', 'held': 'other'},
          {'boxId': 'cccc3333cccc3333', 'name': 'Tiga'},
        ],
      });
      h.router.go('/ops/pending');
      await settle(tester);
      expect(
        find.text(
          'Kotak memaut sendiri secara automatik. Hanya kotak yang tertahan muncul di sini; ia akan memaut sendiri apabila had harian dibuka semula. Luluskan hanya jika perlu segera.',
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: find.byKey(_key('pending-held-aaaa1111aaaa1111')), matching: find.text('Ditahan oleh had harian')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: find.byKey(_key('pending-held-bbbb2222bbbb2222')), matching: find.text('Tertahan')),
        findsOneWidget,
      );
      expect(find.byKey(_key('pending-held-cccc3333cccc3333')), findsNothing);
    });
  });
}
