// "Skrin TV dan MAXCOM Kiosk Box": the main box, the follower boxes (connected, away, removed) and the browser screens; Tanggalkan
// with its confirmation; the LAN-only and older-box answers; the way to the link flow and to the choices of one TV.
// Goldens: the list in BM, English and Arabic.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/screens/screens_list.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart';

/// The box's `GET /api/boxes` at 2026-11-04 14:30 UTC: the main box, one follower connected 40 seconds ago, one away
/// since 25 minutes, one that was removed.
Map<String, Object?> boxesJson() => {
  'self': {
    'boxId': 'a1a1a1a1a1a1a1a1',
    'name': 'Dewan Utama',
    'keyFp': 'a1a1a1a1a1a1a1a1',
    'version': '2026.11.14',
    'mode': 'main',
    'master': null,
  },
  'boxes': [
    {
      'id': 'dev-b2',
      'boxId': 'b2b2b2b2b2b2b2b2',
      'keyFp': 'b2b2b2b2b2b2b2b2',
      'name': 'Ruang Muslimat',
      'version': '2026.11.14',
      'linkedAt': '2026-11-02T01:45:00.000Z',
      'linkId': 'l' * 32,
      'lastSeenAt': '2026-11-04T14:29:20.000Z',
      'removedAt': null,
    },
    {
      'id': 'dev-b3',
      'boxId': 'c3c3c3c3c3c3c3c3',
      'keyFp': 'c3c3c3c3c3c3c3c3',
      'name': 'Foyer',
      'version': '2026.11.13',
      'linkedAt': '2026-10-28T01:45:00.000Z',
      'linkId': 'm' * 32,
      'lastSeenAt': '2026-11-04T14:05:00.000Z',
      'removedAt': null,
    },
    {
      'id': 'dev-b4',
      'boxId': 'd4d4d4d4d4d4d4d4',
      'keyFp': 'd4d4d4d4d4d4d4d4',
      'name': 'Beranda',
      'version': '2026.11.14',
      'linkedAt': '2026-10-20T01:45:00.000Z',
      'linkId': 'n' * 32,
      'lastSeenAt': '2026-11-03T10:00:00.000Z',
      'removedAt': '2026-11-03T11:00:00.000Z',
    },
  ],
};

Map<String, Object?> device(String id, String name, String platform, {bool revoked = false}) => {
  'id': id,
  'userId': 'u1',
  'name': name,
  'platform': platform,
  'revoked': revoked,
  'enrolledAt': '2026-10-02T09:00:00.000Z',
};

Future<ShellHarness> openList(
  WidgetTester tester, {
  AppLang lang = AppLang.ms,
  RouteHandler? boxes,
  List<Override> extra = const [],
}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(FakePublisher()),
      appLockProvider.overrideWithValue(false),
      linkPollEveryProvider.overrideWithValue(const Duration(hours: 1)),
      ...extra,
    ],
  );
  h.devices = [
    device('dev-1', 'Telefon Ali', 'android'),
    // the TV devices of the two follower boxes: not browser screens
    device('dev-b2', 'Ruang Muslimat', 'kiosk'),
    device('dev-b3', 'Foyer', 'kiosk'),
    device('tv-9', 'Bilik kelas', 'kiosk'),
    device('tv-old', 'Skrin lama', 'kiosk', revoked: true),
  ];
  h.handlers['GET /api/boxes'] = boxes ?? (r) async => jsonResponse(200, boxesJson());
  h.router.go('/screens');
  await settle(tester);
  return h;
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
}

Finder row(String id) => find.byKey(ValueKey('tv-row-$id'));

void main() {
  testWidgets('the main box, the followers, the removed one and the browser screens', (tester) async {
    final h = await openList(tester);
    expect(find.text('Skrin TV dan MAXCOM Kiosk Box'), findsWidgets);
    expect(row('self'), findsOneWidget);
    expect(find.descendant(of: row('self'), matching: find.text('Dewan Utama')), findsOneWidget);
    expect(find.descendant(of: row('self'), matching: find.textContaining('Box utama, versi')), findsOneWidget);
    expect(find.descendant(of: row('self'), matching: find.textContaining('2026.11.14')), findsOneWidget);
    expect(find.descendant(of: row('self'), matching: find.text('Bersambung')), findsOneWidget, reason: 'the box this phone talks to');

    // connected: heard from 40 seconds ago
    expect(find.descendant(of: row('dev-b2'), matching: find.text('Bersambung')), findsOneWidget);
    expect(find.descendant(of: row('dev-b2'), matching: find.textContaining('Box pengikut, versi')), findsOneWidget);
    expect(find.descendant(of: row('dev-b2'), matching: find.textContaining('Dipautkan 2 Nov 2026')), findsOneWidget);
    // away: 25 minutes, past the 2 minute limit
    expect(find.descendant(of: row('dev-b3'), matching: find.text('Bersambung')), findsNothing);
    expect(find.descendant(of: row('dev-b3'), matching: find.textContaining('Tiada hubungan sejak')), findsOneWidget);
    // removed: greyed with its date, no actions
    expect(find.descendant(of: row('dev-b4'), matching: find.text('Ditanggalkan')), findsOneWidget);
    expect(find.descendant(of: row('dev-b4'), matching: find.textContaining('Ditanggalkan 3 Nov 2026')), findsOneWidget);
    expect(find.byKey(const ValueKey('tv-edit-dev-b4')), findsNothing);
    expect(find.byKey(const ValueKey('tv-remove-dev-b4')), findsNothing);
    // a browser screen; a phone, a revoked screen and a box's own TV device are not listed as one
    await tester.drag(find.byType(ListView).first, const Offset(0, -400));
    await tester.pump();
    expect(row('tv-9'), findsOneWidget);
    expect(find.descendant(of: row('tv-9'), matching: find.text('Bilik kelas')), findsOneWidget);
    expect(find.descendant(of: row('tv-9'), matching: find.text('Skrin pelayar')), findsOneWidget);
    expect(row('dev-1'), findsNothing);
    expect(row('tv-old'), findsNothing);
    expect(find.byKey(const ValueKey('tv-row-dev-b2')), findsOneWidget, reason: 'listed once, as a box');
    expect(find.byKey(const ValueKey('tv-remove-tv-9')), findsNothing, reason: 'a browser screen is not removed from here');
    expect(h.location, '/screens');
    await close(tester);
  });

  testWidgets('the count of screens that are connected', (tester) async {
    await openList(tester);
    // the main box, the follower heard from 40 seconds ago; not the one away, not the browser screen (no activity)
    expect(tester.widget<Text>(find.byKey(const ValueKey('tvs-count'))).data, '2 daripada 4 skrin bersambung');
    await close(tester);
  });

  testWidgets('every row has the empty slot for the backup line and the unlink button, and it draws nothing', (tester) async {
    await openList(tester);
    expect(find.byType(ScreenRowLinkSlot), findsWidgets);
    for (final e in tester.widgetList<ScreenRowLinkSlot>(find.byType(ScreenRowLinkSlot))) {
      expect(tester.getSize(find.byWidget(e)), Size.zero);
    }
    await close(tester);
  });

  testWidgets('Tetapan TV ini opens the choices of that TV; the main box is "self"', (tester) async {
    final h = await openList(tester);
    await tester.tap(find.byKey(const ValueKey('tv-edit-self')));
    await settle(tester);
    expect(h.location, '/screens/tv/self');
    h.router.go('/screens');
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('tv-edit-dev-b2')));
    await settle(tester);
    expect(h.location, '/screens/tv/dev-b2');
    await close(tester);
  });

  testWidgets('Pautkan MAXCOM Kiosk Box lain opens the link flow', (tester) async {
    final h = await openList(tester);
    h.handlers['GET /api/link/status'] = (r) async => jsonResponse(200, {
      'mode': 'main',
      'session': null,
      'last': null,
      'progress': null,
      'checks': {'lan': true, 'live': false, 'caseX': true, 'setUp': true},
    });
    await tester.tap(find.byKey(const ValueKey('tvs-link')));
    await settle(tester);
    expect(h.location, '/screens/link');
    await close(tester);
  });

  group('Tanggalkan', () {
    testWidgets('only on a follower box, after the confirmation of the plan', (tester) async {
      final h = await openList(tester);
      expect(find.byKey(const ValueKey('tv-remove-self')), findsNothing, reason: 'the main box is never removed');
      expect(find.byKey(const ValueKey('tv-remove-dev-b3')), findsOneWidget);
      h.handlers['DELETE /api/boxes/dev-b3'] = (r) async => jsonResponse(200, {'ok': true});
      await reveal(tester, find.byKey(const ValueKey('tv-remove-dev-b3')));
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      expect(find.text('Tanggalkan Foyer?'), findsOneWidget);
      expect(find.text('Tanggalkan: MAXCOM Kiosk Box ini dikosongkan, termasuk sandarannya.'), findsOneWidget);
      // Batal first: nothing is sent
      await tester.tap(find.widgetWithText(TextButton, 'Batal'));
      await settle(tester);
      expect(h.box.byPath('/api/boxes/dev-b3'), isNull);
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Tanggalkan'));
      await settle(tester);
      expect(h.box.byPath('/api/boxes/dev-b3')?.method, 'DELETE');
      expect(find.text('Foyer ditanggalkan.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('a refusal is worded in the language: away from the surau Wi-Fi', (tester) async {
      final h = await openList(tester);
      h.handlers['DELETE /api/boxes/dev-b3'] = (r) async => jsonResponse(403, {'code': 'lan_only', 'errors': ['lan_only']});
      await reveal(tester, find.byKey(const ValueKey('tv-remove-dev-b3')));
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Tanggalkan'));
      await settle(tester);
      expect(find.text('Pautan MAXCOM Kiosk Box hanya boleh dibuat di Wi-Fi surau.'), findsOneWidget);
      await close(tester);
    });

    testWidgets('while a link is running the box says so', (tester) async {
      final h = await openList(tester);
      h.handlers['DELETE /api/boxes/dev-b3'] = (r) async => jsonResponse(409, {'code': 'linking', 'errors': ['linking']});
      await reveal(tester, find.byKey(const ValueKey('tv-remove-dev-b3')));
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Tanggalkan'));
      await settle(tester);
      expect(find.text('Pautan sedang dibuat. Cuba sebentar lagi.'), findsOneWidget);
      await close(tester);
    });
  });

  group('a follower not seen for more than 3 days', () {
    /// The box lists the Foyer as not seen since 30 Oct (5 days before the list), as the master box does after 3 days.
    // ignore: prefer_function_declarations_over_variables
    final RouteHandler staleBoxes = (r) async {
      final j = boxesJson();
      final list = <Object?>[
        for (final b in (j['boxes']! as List).cast<Map<String, Object?>>())
          b['id'] == 'dev-b3' ? {...b, 'lastSeenAt': '2026-10-30T10:00:00.000Z', 'notSeenSince': '2026-10-30T10:00:00.000Z'} : b,
      ];
      return jsonResponse(200, {...j, 'boxes': list});
    };

    testWidgets('the row is greyed and says since when; a recent one keeps its chip; nothing is removed by itself', (tester) async {
      await openList(tester, boxes: staleBoxes);
      expect(find.descendant(of: row('dev-b3'), matching: find.text('Tidak dilihat sejak 30 Okt 2026')), findsOneWidget);
      expect(find.descendant(of: row('dev-b3'), matching: find.textContaining('Tiada hubungan sejak')), findsNothing);
      expect(find.descendant(of: row('dev-b3'), matching: find.text('Foyer')), findsOneWidget);
      expect(find.byKey(const ValueKey('tv-remove-dev-b3')), findsOneWidget, reason: 'it can still be taken off, by the person');
      // the connected follower is not marked
      expect(find.descendant(of: row('dev-b2'), matching: find.textContaining('Tidak dilihat sejak')), findsNothing);
      expect(find.descendant(of: row('dev-b2'), matching: find.text('Bersambung')), findsOneWidget);
      await close(tester);
    });

    testWidgets('Tanggalkan warns that the box empties itself if it returns, then removes it', (tester) async {
      final h = await openList(tester, boxes: staleBoxes);
      h.handlers['DELETE /api/boxes/dev-b3'] = (r) async => jsonResponse(200, {'ok': true});
      await reveal(tester, find.byKey(const ValueKey('tv-remove-dev-b3')));
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      expect(find.text('Tanggalkan Foyer?'), findsOneWidget);
      expect(find.textContaining('mengosongkan dirinya sendiri'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Batal'));
      await settle(tester);
      expect(h.box.byPath('/api/boxes/dev-b3'), isNull, reason: 'Batal sends nothing');
      await tester.tap(find.byKey(const ValueKey('tv-remove-dev-b3')));
      await settle(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Tanggalkan'));
      await settle(tester);
      expect(h.box.byPath('/api/boxes/dev-b3')?.method, 'DELETE');
      await close(tester);
    });

    testWidgets('English and Arabic words', (tester) async {
      await openList(tester, lang: AppLang.en, boxes: staleBoxes);
      expect(find.descendant(of: row('dev-b3'), matching: find.textContaining('Not seen since')), findsOneWidget);
      await close(tester);
      await openList(tester, lang: AppLang.ar, boxes: staleBoxes);
      expect(find.descendant(of: row('dev-b3'), matching: find.textContaining('لم يُشاهد منذ')), findsOneWidget);
      await close(tester);
    });
  });

  testWidgets('the box refuses the list off the surau Wi-Fi: the sentence, the browser screens still listed', (tester) async {
    await openList(tester, boxes: (r) async => jsonResponse(403, {'code': 'lan_only', 'errors': ['lan_only']}));
    expect(find.byKey(const ValueKey('tvs-lan-only')), findsOneWidget);
    expect(find.text('Pautan MAXCOM Kiosk Box hanya boleh dibuat di Wi-Fi surau.'), findsOneWidget);
    expect(row('self'), findsNothing);
    expect(row('tv-9'), findsOneWidget);
    await close(tester);
  });

  testWidgets('an older box without the route: only the browser screens, with the note', (tester) async {
    await openList(tester, boxes: (r) async => jsonResponse(404, {'errors': ['not found']}));
    expect(find.byKey(const ValueKey('tvs-older')), findsOneWidget);
    expect(row('tv-9'), findsOneWidget);
    await close(tester);
  });

  testWidgets('a phone whose box now follows another sees the pointer, and cannot start a link', (tester) async {
    await openList(
      tester,
      boxes: (r) async => jsonResponse(409, {
        'code': 'follower',
        'errors': ['follower'],
        'master': {'name': 'Dewan Utama', 'boxId': 'a1a1a1a1a1a1a1a1', 'addresses': <String>[], 'caSha256': 'c' * 64},
      }),
    );
    expect(find.text('Surau anda kini diurus dari MAXCOM Kiosk Box utama Dewan Utama.'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('tvs-link'))).onPressed, isNull);
    await close(tester);
  });

  testWidgets('English and Arabic words', (tester) async {
    await openList(tester, lang: AppLang.en);
    expect(find.text('TV screens and MAXCOM Kiosk Boxes'), findsWidgets);
    expect(find.text('Connected'), findsNWidgets(2));
    expect(find.text('Link another MAXCOM Kiosk Box'), findsOneWidget);
    await close(tester);
    await openList(tester, lang: AppLang.ar);
    expect(find.text('شاشات التلفاز وMAXCOM Kiosk Box'), findsWidgets);
    expect(find.text('متصل'), findsNWidgets(2));
    await close(tester);
  });

  for (final lang in AppLang.values) {
    testWidgets('golden: the list in ${lang.name}', (tester) async {
      final h = await openList(tester, lang: lang);
      expect(tester.takeException(), isNull);
      await expectGoldens(tester, h.app, 'screens_list_${lang.name}', sizes: const [GoldenSize.phone]);
      await close(tester);
    });
  }
}
