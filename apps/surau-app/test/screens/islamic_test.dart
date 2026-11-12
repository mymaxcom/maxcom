// Kandungan Islamik: what the box has cached (Quran text, recitation
// audio per surah), a download of the text or of one surah picked by its
// BM name, the job's progress until `Selesai`, and the box's `409` as
// `Sedang memuat turun`. Golden: islamic.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/screens/islamic_screen.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 't9_fakes.dart';

void main() {
  testWidgets('status: text present with its size, two surah stored, cache usage', (
    tester,
  ) async {
    final t = await pumpT9(
      tester,
      const IslamicScreen(pollInterval: Duration(seconds: 1)),
      location: AppRoutes.islamic,
    );
    expect(find.text('Kandungan Islamik'), findsWidgets);
    expect(find.text('Teks Al-Quran tersedia'), findsOneWidget);
    expect(find.text('6236 ayat, versi quranenc-2024'), findsOneWidget);
    expect(find.text('Qari: Alafasy_128kbps'), findsOneWidget);
    expect(find.text('2 surah tersimpan'), findsOneWidget);
    expect(find.text('48 MB daripada 500 MB digunakan'), findsOneWidget);
    expect(find.text('Muat turun semula dari QuranEnc'), findsOneWidget);
    expect(find.text('Muat turun dari EveryAyah ke dalam MAXCOM'), findsOneWidget);
    expect(find.text('Pilih surah'), findsOneWidget);
    await expectGoldens(tester, t.app, 'islamic');
  });

  testWidgets('no text yet: Teks Al-Quran belum dimuat turun, then a job runs to Selesai', (
    tester,
  ) async {
    var present = false;
    var polls = 0;
    final t = await pumpT9(
      tester,
      const IslamicScreen(pollInterval: Duration(seconds: 1)),
      location: AppRoutes.islamic,
      setup: (h) {
        h.handlers['GET /api/islamic/status'] = (_) async =>
            jsonResponse(200, t9IslamicStatus(present: present, surahs: const []));
        h.handlers['POST /api/islamic/fetch'] = (_) async => jsonResponse(202, {'jobId': 'j1'});
        h.handlers['GET /api/islamic/jobs/j1'] = (_) async {
          polls++;
          if (polls == 1) return jsonResponse(200, {'state': 'running', 'progress': 0.4});
          present = true;
          return jsonResponse(200, {'state': 'done', 'progress': 1});
        };
      },
    );
    expect(find.text('Teks Al-Quran belum dimuat turun'), findsOneWidget);
    expect(find.text('Belum ada surah tersimpan'), findsOneWidget);

    await tester.tap(find.text('Muat turun dari QuranEnc ke dalam MAXCOM'));
    await settle(tester);
    final body = jsonDecode(t.h.box.byPath('/api/islamic/fetch')!.body);
    expect(body, {'what': 'quran'});
    expect(find.text('Memuat turun teks Al-Quran'), findsOneWidget);
    expect(find.text('40%'), findsOneWidget);
    final bar = tester.widget<LinearProgressIndicator>(
      find.descendant(of: find.byType(Card), matching: find.byType(LinearProgressIndicator)).first,
    );
    expect(bar.value, closeTo(0.4, 0.001));

    await tester.pump(const Duration(seconds: 1));
    await settle(tester);
    expect(find.text('Selesai'), findsOneWidget);
    expect(find.text('Teks Al-Quran tersedia'), findsOneWidget, reason: 'status re-read after the job');
    expect(polls, 2);
  });

  testWidgets('the surah picker searches by BM name and the download names the surah', (
    tester,
  ) async {
    final t = await pumpT9(
      tester,
      const IslamicScreen(pollInterval: Duration(seconds: 1)),
      location: AppRoutes.islamic,
      setup: (h) {
        h.handlers['POST /api/islamic/fetch'] = (_) async => jsonResponse(202, {'jobId': 'j2'});
        h.handlers['GET /api/islamic/jobs/j2'] = (_) async =>
            jsonResponse(200, {'state': 'done', 'progress': 1});
      },
    );
    // Nothing chosen yet: the download waits.
    final idle = tester.widget<FilledButton>(
      find.ancestor(of: find.text('Muat turun dari EveryAyah ke dalam MAXCOM'), matching: find.byType(FilledButton)),
    );
    expect(idle.onPressed, isNull);

    await tester.tap(find.text('Pilih surah'));
    await settle(tester);
    expect(find.text('1. Al-Fatihah'), findsOneWidget);
    expect(find.text('Tersimpan'), findsWidgets, reason: 'surah 1 is cached');
    await tester.enterText(find.byType(TextField), 'yasin');
    await settle(tester);
    expect(find.text('1. Al-Fatihah'), findsNothing);
    expect(find.text('36. Yasin'), findsOneWidget);
    await tester.tap(find.text('36. Yasin'));
    await settle(tester);
    expect(find.text('36. Yasin'), findsOneWidget, reason: 'shown in the picker field');

    await tester.tap(find.text('Muat turun dari EveryAyah ke dalam MAXCOM'));
    await settle(tester);
    expect(jsonDecode(t.h.box.byPath('/api/islamic/fetch')!.body), {'what': 'audio', 'surah': 36});
    await tester.pump(const Duration(seconds: 1));
    await settle(tester);
    expect(find.text('Selesai'), findsOneWidget);
    expect(find.text('Surah 36. Yasin sudah disimpan di MAXCOM.'), findsOneWidget);
  });

  testWidgets('409 reads Sedang memuat turun; a failed job shows the box reason', (tester) async {
    await pumpT9(
      tester,
      const IslamicScreen(pollInterval: Duration(seconds: 1)),
      location: AppRoutes.islamic,
      setup: (h) {
        h.handlers['POST /api/islamic/fetch'] = (_) async => jsonResponse(409, {
          'errors': ['another fetch is already running'],
        });
      },
    );
    await tester.tap(find.text('Muat turun semula dari QuranEnc'));
    await settle(tester);
    expect(find.text('Sedang memuat turun'), findsOneWidget);
  });

  testWidgets('a failed job shows the box reason', (tester) async {
    await pumpT9(
      tester,
      const IslamicScreen(pollInterval: Duration(seconds: 1)),
      location: AppRoutes.islamic,
      setup: (h) {
        h.handlers['POST /api/islamic/fetch'] = (_) async => jsonResponse(202, {'jobId': 'j3'});
        h.handlers['GET /api/islamic/jobs/j3'] = (_) async =>
            jsonResponse(200, {'state': 'failed', 'progress': 0.1, 'error': 'HTTP 502 from quranenc'});
      },
    );
    await tester.tap(find.text('Muat turun semula dari QuranEnc'));
    await settle(tester);
    expect(find.text('Muat turun gagal: HTTP 502 from quranenc'), findsOneWidget);
  });

  testWidgets('a treasurer sees the status only', (tester) async {
    await pumpT9(
      tester,
      const IslamicScreen(),
      location: AppRoutes.islamic,
      roles: const ['treasurer'],
    );
    expect(find.text('Teks Al-Quran tersedia'), findsOneWidget);
    expect(find.text('Muat turun semula dari QuranEnc'), findsNothing);
    expect(find.text('Muat turun dari EveryAyah ke dalam MAXCOM'), findsNothing);
    expect(find.text('Hanya pentadbir boleh memuat turun kandungan.'), findsOneWidget);
  });
}
