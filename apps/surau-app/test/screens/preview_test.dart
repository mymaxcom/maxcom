// Pratonton: the real kiosk page in a frame, read only, with six state
// buttons that hand the page a clock (`now`) computed from today's row of
// the bundle exactly as the box's own state machine would place it; the
// Android certificate help when the WebView cannot trust the box. Golden:
// preview.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/screens/preview_screen.dart';

import '../features/fakes.dart' show fixtureInfoJson;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 't9_fakes.dart';

/// Records every request the screen makes of its host and draws a TV-ish
/// placeholder in its place.
class _FakeHost {
  final List<PreviewRequest> requests = [];

  Widget build(BuildContext context, PreviewRequest r) {
    requests.add(r);
    return Container(
      color: SurauColors.glass,
      alignment: Alignment.center,
      child: Text(
        r.now == null ? 'live' : formatKl(r.now!),
        style: const TextStyle(color: SurauColors.gold, fontSize: 18),
      ),
    );
  }

  PreviewRequest get last => requests.last;
}

void main() {
  group('previewNowFor (pure)', () {
    final bundle = t9Bundle().cast<String, dynamic>();

    test('Biasa is the live clock', () {
      expect(previewNowFor(PreviewPhase.biasa, bundle), isNull);
    });

    test('Iqamah for the 2026-11-03 fixture is 16:25 Malaysian time', () {
      final now = previewNowFor(PreviewPhase.iqamah, bundle);
      expect(now, isNotNull);
      expect(formatKl(now!), '2026-11-03T16:25:00+08:00');
    });

    test('Azan and Solat land inside their asar stages', () {
      expect(formatKl(previewNowFor(PreviewPhase.azan, bundle)!), '2026-11-03T16:15:00+08:00');
      expect(formatKl(previewNowFor(PreviewPhase.solat, bundle)!), '2026-11-03T16:37:00+08:00');
    });

    test('Jumaat is the khutbah on the coming Friday', () {
      expect(formatKl(previewNowFor(PreviewPhase.jumaat, bundle)!), '2026-11-06T13:21:00+08:00');
    });

    test('Jumaat is unavailable when the feature is off or no Friday is loaded', () {
      final off = t9Bundle(settings: t9PhaseSettings(jumaat: false)).cast<String, dynamic>();
      expect(previewNowFor(PreviewPhase.jumaat, off), isNull);
      final noFriday = t9Bundle(days: [t9Day('2026-11-03')]).cast<String, dynamic>();
      expect(previewNowFor(PreviewPhase.jumaat, noFriday), isNull);
    });

    test('Tiada data is noon on the day after the last row', () {
      expect(formatKl(previewNowFor(PreviewPhase.tiadaData, bundle)!), '2026-11-09T12:00:00+08:00');
    });

    test('a stage that is switched off has no preview', () {
      final s = t9PhaseSettings();
      s['azanCountdown'] = {'enabled': false};
      final b = t9Bundle(settings: s).cast<String, dynamic>();
      expect(previewNowFor(PreviewPhase.azan, b), isNull);
      expect(formatKl(previewNowFor(PreviewPhase.iqamah, b)!), '2026-11-03T16:25:00+08:00');
    });

    test('after isyak the reference prayer is isyak itself', () {
      final b = t9Bundle().cast<String, dynamic>();
      b['serverTime'] = '2026-11-03T14:00:00.000Z'; // 22:00 Malaysian time
      expect(formatKl(previewNowFor(PreviewPhase.iqamah, b)!), '2026-11-03T20:25:00+08:00');
    });

    test('no row for today: only Biasa and Tiada data', () {
      final b = t9Bundle(days: [t9Day('2026-11-08')]).cast<String, dynamic>();
      expect(previewNowFor(PreviewPhase.iqamah, b), isNull);
      expect(formatKl(previewNowFor(PreviewPhase.tiadaData, b)!), '2026-11-09T12:00:00+08:00');
    });

    test('formatKl writes the Malaysian offset', () {
      expect(formatKl(DateTime.utc(2026, 11, 3, 8, 25)), '2026-11-03T16:25:00+08:00');
    });

    test('a surau at +03:00 (Nairobi): stages and clock follow its offset', () {
      // The same wall-clock times, three hours from UTC: the server time
      // 07:52Z is 10:52 there, so the next prayer is zohor at 13:10.
      final iqamah = previewNowFor(PreviewPhase.iqamah, bundle, utcOffsetMinutes: 180)!;
      expect(formatKl(iqamah, utcOffsetMinutes: 180), '2026-11-03T13:15:00+03:00');
      expect(iqamah, DateTime.utc(2026, 11, 3, 10, 15));
      final none = previewNowFor(PreviewPhase.tiadaData, bundle, utcOffsetMinutes: 180)!;
      expect(formatKl(none, utcOffsetMinutes: 180), '2026-11-09T12:00:00+03:00');
      expect(none, DateTime.utc(2026, 11, 9, 9));
    });

    test('formatKl writes negative and half-hour offsets', () {
      final t = DateTime.utc(2026, 11, 3, 12, 0);
      expect(formatKl(t, utcOffsetMinutes: -300), '2026-11-03T07:00:00-05:00');
      expect(formatKl(t, utcOffsetMinutes: 330), '2026-11-03T17:30:00+05:30');
    });

    test('utcOffsetOf reads the info answer and falls back to 480', () {
      expect(utcOffsetOf({'utcOffsetMinutes': 180}), 180);
      expect(utcOffsetOf({'utcOffsetMinutes': -300}), -300);
      expect(utcOffsetOf({}), 480);
      expect(utcOffsetOf(null), 480);
      expect(utcOffsetOf({'utcOffsetMinutes': 'x'}), 480);
      expect(utcOffsetOf({'utcOffsetMinutes': 90.5}), 480);
      expect(utcOffsetOf({'utcOffsetMinutes': 5000}), 480);
    });
  });

  testWidgets('the host gets the box, the token and no clock; Iqamah reloads it at 16:25', (
    tester,
  ) async {
    final host = _FakeHost();
    final t = await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
    );
    expect(find.text('Pratonton'), findsWidgets);
    expect(host.requests, isNotEmpty);
    expect(host.last.box, Uri.parse('https://127.0.0.1:8443'));
    expect(host.last.token, 'tok-1');
    expect(host.last.now, isNull);
    expect(find.text('Masa sebenar'), findsOneWidget);
    expect(t.h.box.byPath('/api/kiosk/bundle'), isNotNull, reason: 'the phase buttons need the bundle');

    await tester.tap(find.text('Iqamah'));
    await settle(tester);
    expect(host.last.now, isNotNull);
    expect(formatKl(host.last.now!), '2026-11-03T16:25:00+08:00');
    expect(find.text('Jam skrin bermula 4:25 petang, 3 Nov'), findsOneWidget);

    await tester.tap(find.text('Tiada data'));
    await settle(tester);
    expect(formatKl(host.last.now!), '2026-11-09T12:00:00+08:00');

    await tester.tap(find.text('Biasa'));
    await settle(tester);
    expect(host.last.now, isNull);

    await expectGoldens(tester, t.app, 'preview');
  });

  testWidgets('Muat semula rebuilds the host with the same clock', (tester) async {
    final host = _FakeHost();
    await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
    );
    await tester.tap(find.text('Azan'));
    await settle(tester);
    final before = host.last.generation;
    await tester.tap(find.byTooltip('Muat semula'));
    await settle(tester);
    expect(host.last.generation, greaterThan(before));
    expect(formatKl(host.last.now!), '2026-11-03T16:15:00+08:00');
  });

  testWidgets('without the bundle only Biasa is pressable, with a calm note', (tester) async {
    final host = _FakeHost();
    await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
      setup: (h) {
        h.handlers['GET /api/kiosk/bundle'] = (_) async => jsonResponse(503, {
          'errors': ['busy'],
        });
      },
    );
    expect(find.text('Butang keadaan perlukan data waktu solat dari MAXCOM.'), findsOneWidget);
    final iqamah = tester.widget<ChoiceChip>(
      find.ancestor(of: find.text('Iqamah'), matching: find.byType(ChoiceChip)),
    );
    expect(iqamah.onSelected, isNull);
    final biasa = tester.widget<ChoiceChip>(
      find.ancestor(of: find.text('Biasa'), matching: find.byType(ChoiceChip)),
    );
    expect(biasa.onSelected, isNotNull);
    // The frame itself still shows: the preview needs no bundle.
    expect(host.requests, isNotEmpty);
    // Riverpod retries the failed read with backoff (10 tries, 38 s in
    // all); let them run out so no timer outlives the test.
    await tester.pump(const Duration(seconds: 60));
    await settle(tester);
  });

  testWidgets('a refused certificate shows one calm line, a retry and the figures behind Butiran teknikal',
      (tester) async {
    final host = _FakeHost();
    final t = await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
    );
    const line = 'Pratonton tidak dapat disambung dengan selamat. Cuba lagi.';
    expect(find.text(line), findsNothing);
    host.last.onSslError('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
    await settle(tester);
    expect(find.text(line), findsOneWidget);
    // the old root-certificate card is gone
    expect(find.textContaining('sijil akar'), findsNothing);
    expect(find.text('Muat turun sijil'), findsNothing);
    expect(t.h.opener.opened, isEmpty);
    // the figures are collapsed
    expect(find.text('Butiran teknikal'), findsOneWidget);
    expect(find.text('aaaaaaaaaaaaaaaa'), findsNothing);
    await tester.tap(find.text('Butiran teknikal'));
    await settle(tester);
    expect(find.text('aaaaaaaaaaaaaaaa'), findsOneWidget);
    expect(find.text('bbbbbbbbbbbbbbbb'), findsOneWidget);
    await tester.tap(find.text('Butiran teknikal'));
    await settle(tester);

    final before = host.last.generation;
    await tester.tap(find.text('Cuba lagi'));
    await settle(tester);
    expect(find.text(line), findsNothing);
    expect(host.last.generation, before + 1);

    // The failure at each size: a size change rebuilds the shell and the
    // screen's state, so the error is raised again after every pump.
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, t.app, size);
      host.last.onSslError('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb');
      await settle(tester);
      expect(find.text(line), findsOneWidget, reason: size.name);
      await expectLater(
        find.byWidget(t.app),
        matchesGoldenFile('preview_ssl_${size.name}.png'),
      );
    }
  });

  testWidgets('the host gets a pinned-leaf fetcher only when the app has one', (tester) async {
    final host = _FakeHost();
    await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
    );
    expect(host.last.pinnedLeaf, isNull, reason: 'the test deps have no pinned leaf');
  });

  testWidgets('the screen uses utcOffsetMinutes of /api/surau/info (180)', (tester) async {
    final host = _FakeHost();
    await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
      setup: (h) {
        h.handlers['GET /api/surau/info'] = (_) async => jsonResponse(200, {
          ...fixtureInfoJson,
          'utcOffsetMinutes': 180,
        });
      },
    );
    await tester.tap(find.text('Tiada data'));
    await settle(tester);
    expect(host.last.now, DateTime.utc(2026, 11, 9, 9), reason: 'noon at +03:00');
    expect(formatKl(host.last.now!, utcOffsetMinutes: 180), '2026-11-09T12:00:00+03:00');
  });

  testWidgets('without utcOffsetMinutes the screen keeps Kuala Lumpur (480)', (tester) async {
    final host = _FakeHost();
    await pumpT9(
      tester,
      PreviewScreen(previewBuilder: host.build),
      location: AppRoutes.preview,
    );
    await tester.tap(find.text('Tiada data'));
    await settle(tester);
    expect(host.last.now, DateTime.utc(2026, 11, 9, 4), reason: 'noon at +08:00');
  });
}
