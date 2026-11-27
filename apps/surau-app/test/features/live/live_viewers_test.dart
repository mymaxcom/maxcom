// The TV chips of the Live tab: the box's additive `viewers` list in the status, drawn as one chip per TV with a state
// dot while a live runs; no list or an empty one draws nothing (the existing live goldens pin that).
// Goldens: the running live with the chips in BM, English and Arabic.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/box/wire.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/live/publisher.dart';

import '../../golden_sizes.dart';
import '../shell/harness.dart';

const _viewers = [
  LiveViewerDto(tvId: 'self', name: 'Dewan Utama', state: 'playing'),
  LiveViewerDto(tvId: 'dev-b3', name: 'Foyer', state: 'connecting'),
  LiveViewerDto(tvId: 'dev-b2', name: 'Ruang Muslimat', state: 'off'),
];

Future<(ShellHarness, FakePublisher)> open(WidgetTester tester, {AppLang lang = AppLang.ms, List<LiveViewerDto> viewers = const []}) async {
  final pub = FakePublisher();
  final h = await pumpShell(
    tester,
    roles: const ['live'],
    overrides: [
      appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
      livePublisherProvider.overrideWithValue(pub),
      liveBoxProvider.overrideWith(() => LiveBoxNotifier(LiveBoxStatus(youtube: const YoutubeAccount.signedIn('Surau Al-Hidayah'), viewers: viewers))),
    ],
  );
  h.router.go('/live');
  await settle(tester);
  pub.emit(
    const PublisherState(
      phase: PublisherPhase.live,
      outputs: PublisherOutputs(kiosk: OutputState.up, youtube: OutputState.up),
      recording: RecordingState(on: true, segments: 2, bytes: 1395864371),
      stats: StreamStats(bitrateKbps: 2450, fps: 30, rttMs: 18),
      durationSec: 1421,
    ),
  );
  await settle(tester);
  h.container.read(liveFoldedProvider.notifier).set(false);
  await settle(tester);
  return (h, pub);
}

Finder _spoken(String label) => find.byWidgetPredicate((w) => w is Semantics && w.properties.label == label);

Finder chips() => find.byKey(const ValueKey('live-viewers'));

void main() {
  test('the status reads the list; a missing list, a bad entry and a non-list are left out', () {
    final base = <String, dynamic>{'session': {'id': 's1'}};
    expect(LiveStatusDto.fromJson(base).viewers, isEmpty);
    expect(LiveStatusDto.fromJson({...base, 'viewers': 'x'}).viewers, isEmpty);
    final d = LiveStatusDto.fromJson({
      ...base,
      'viewers': [
        {'tvId': 'self', 'name': 'Dewan Utama', 'state': 'playing'},
        {'tvId': 'x'},
        'junk',
        {'tvId': 'dev-b3', 'name': 'Foyer', 'state': 'connecting'},
      ],
    });
    expect([for (final v in d.viewers) '${v.tvId}:${v.name}:${v.state}'], ['self:Dewan Utama:playing', 'dev-b3:Foyer:connecting']);
  });

  testWidgets('a running live with the list shows one chip per TV, named, with its state for a screen reader', (tester) async {
    await open(tester, viewers: _viewers);
    expect(chips(), findsOneWidget);
    expect(find.text('TV yang memaparkan siaran'), findsOneWidget);
    for (final n in ['Dewan Utama', 'Foyer', 'Ruang Muslimat']) {
      expect(find.descendant(of: chips(), matching: find.text(n)), findsOneWidget);
    }
    expect(_spoken('Foyer, menyambung'), findsOneWidget);
    expect(_spoken('Ruang Muslimat, tidak memaparkan siaran'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 10));
  });

  testWidgets('no list, or an empty one: no chips', (tester) async {
    await open(tester);
    expect(chips(), findsNothing);
    expect(find.text('TV yang memaparkan siaran'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 10));
  });

  testWidgets('English and Arabic words', (tester) async {
    await open(tester, lang: AppLang.en, viewers: _viewers);
    expect(find.text('TVs showing the live'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 10));
    await open(tester, lang: AppLang.ar, viewers: _viewers);
    expect(find.text('الشاشات التي تعرض البث'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(milliseconds: 10));
  });

  for (final lang in AppLang.values) {
    testWidgets('golden: the running live with the chips in ${lang.name}', (tester) async {
      final (h, _) = await open(tester, lang: lang, viewers: _viewers);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(chips());
      await expectGoldens(tester, h.app, 'live_viewers_${lang.name}', sizes: const [GoldenSize.phone]);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 10));
    });
  }
}
