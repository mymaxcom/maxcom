// "Paparkan siaran langsung": the per-box switch card (build 5, mockup B1). Rows, the server badge, the off line,
// the all-off note, a disabled card, the accessibility label of a switch, and goldens at phone size.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/live_tv_show_card.dart';

import '../../golden_sizes.dart';

TvShowTexts _texts() => TvShowTexts(
  title: 'Paparkan siaran langsung',
  hint: 'Matikan bagi kotak yang perlahan semasa siaran. TV kotak itu kekal dengan paparan biasa.',
  serverBadge: 'Pelayan siaran',
  offLine: 'Paparan biasa semasa siaran',
  allOffNote: 'Tiada TV akan memaparkan siaran.',
  switchLabel: (name) => 'Paparkan siaran langsung, $name',
);

List<TvShowRow> _rows({bool mainShow = true, bool otherShow = true, bool otherBusy = false, String? cpu = 'CPU 92% semasa siaran lepas'}) => [
  TvShowRow(tvId: 'self', name: 'Kotak contoh A', kindLabel: 'PC mini Windows', server: true, show: mainShow, cpuLine: cpu),
  TvShowRow(tvId: 'dev-b', name: 'Kotak contoh B', kindLabel: 'Kotak TV Android', server: false, show: otherShow, busy: otherBusy),
];

Widget _app(Widget child, {TextDirection dir = TextDirection.ltr}) => MaterialApp(
  theme: SurauTheme.light(),
  home: Directionality(
    textDirection: dir,
    child: Scaffold(
      backgroundColor: SurauColors.paper,
      body: Padding(padding: const EdgeInsets.all(16), child: SingleChildScrollView(child: child)),
    ),
  ),
);

void main() {
  testWidgets('one row per box with its name, kind, switch and the server badge on the server row only', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(), texts: _texts(), onChanged: (_, _) {})));
    expect(find.byKey(const ValueKey('live-tv-show')), findsOneWidget);
    expect(find.text('Paparkan siaran langsung'), findsOneWidget);
    expect(find.text('Kotak contoh A'), findsOneWidget);
    expect(find.text('PC mini Windows'), findsOneWidget);
    expect(find.text('Kotak contoh B'), findsOneWidget);
    expect(find.text('Kotak TV Android'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-tv-show-self')), findsOneWidget);
    expect(find.byKey(const ValueKey('live-tv-show-dev-b')), findsOneWidget);
    expect(find.byKey(const ValueKey('live-tv-show-server')), findsOneWidget);
    expect(find.text('Pelayan siaran'), findsOneWidget);
    expect(find.text('CPU 92% semasa siaran lepas'), findsOneWidget);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('live-tv-show-self'))).value, isTrue);
    // nothing is off: no off line, no all-off note
    expect(find.text('Paparan biasa semasa siaran'), findsNothing);
    expect(find.byKey(const ValueKey('live-tv-show-all-off')), findsNothing);
  });

  testWidgets('a row that is off says its off line; the others do not', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(mainShow: false), texts: _texts(), onChanged: (_, _) {})));
    expect(find.text('Paparan biasa semasa siaran'), findsOneWidget);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('live-tv-show-self'))).value, isFalse);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('live-tv-show-dev-b'))).value, isTrue);
    expect(find.byKey(const ValueKey('live-tv-show-all-off')), findsNothing);
  });

  testWidgets('every row off adds the one muted line', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(mainShow: false, otherShow: false), texts: _texts(), onChanged: (_, _) {})));
    expect(find.byKey(const ValueKey('live-tv-show-all-off')), findsOneWidget);
    expect(find.text('Tiada TV akan memaparkan siaran.'), findsOneWidget);
    expect(find.text('Paparan biasa semasa siaran'), findsNWidgets(2));
  });

  testWidgets('no CPU figure means no CPU line; a follower never gets the badge or the line', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(cpu: null), texts: _texts(), onChanged: (_, _) {})));
    expect(find.textContaining('CPU'), findsNothing);
    expect(find.byKey(const ValueKey('live-tv-show-server')), findsOneWidget);
    const rows = [
      TvShowRow(tvId: 'dev-b', name: 'Kotak contoh B', kindLabel: 'Kotak TV Android', server: false, show: true, cpuLine: 'CPU 10%'),
    ];
    await tester.pumpWidget(_app(LiveTvShowCard(rows: rows, texts: _texts(), onChanged: (_, _) {})));
    expect(find.byKey(const ValueKey('live-tv-show-server')), findsNothing);
    expect(find.text('CPU 10%'), findsNothing);
  });

  testWidgets('a tap on a switch reports the TV id and the new value', (tester) async {
    final calls = <(String, bool)>[];
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(), texts: _texts(), onChanged: (id, v) => calls.add((id, v)))));
    await tester.tap(find.byKey(const ValueKey('live-tv-show-self')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('live-tv-show-dev-b')));
    await tester.pump();
    expect(calls, [('self', false), ('dev-b', false)]);
  });

  testWidgets('a null onChanged disables every switch', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(), texts: _texts(), onChanged: null)));
    for (final id in ['self', 'dev-b']) {
      final sw = tester.widget<Switch>(find.byKey(ValueKey('live-tv-show-$id')));
      expect(sw.onChanged, isNull, reason: id);
    }
  });

  testWidgets('a row with a save in flight has a disabled switch and a spinner; the other row stays live', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(otherBusy: true), texts: _texts(), onChanged: (_, _) {})));
    expect(tester.widget<Switch>(find.byKey(const ValueKey('live-tv-show-dev-b'))).onChanged, isNull);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('live-tv-show-self'))).onChanged, isNotNull);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('each switch has an accessibility label with the box name', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(), texts: _texts(), onChanged: (_, _) {})));
    expect(find.bySemanticsLabel(RegExp('Paparkan siaran langsung, Kotak contoh A')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('Paparkan siaran langsung, Kotak contoh B')), findsOneWidget);
    handle.dispose();
  });

  testWidgets('every switch row is at least 48 dp tall to tap', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: _rows(), texts: _texts(), onChanged: (_, _) {})));
    for (final id in ['self', 'dev-b']) {
      final row = find.ancestor(of: find.byKey(ValueKey('live-tv-show-$id')), matching: find.byType(ConstrainedBox)).first;
      expect(tester.getSize(row).height, greaterThanOrEqualTo(48), reason: id);
    }
  });

  testWidgets('an empty list draws only the heading', (tester) async {
    await tester.pumpWidget(_app(LiveTvShowCard(rows: const [], texts: _texts(), onChanged: (_, _) {})));
    expect(find.text('Paparkan siaran langsung'), findsOneWidget);
    expect(find.byType(Switch), findsNothing);
    expect(find.byKey(const ValueKey('live-tv-show-all-off')), findsNothing);
  });

  group('golden at phone size', () {
    final states = <String, List<TvShowRow>>{
      'default': _rows(),
      'server_off': _rows(mainShow: false),
      'all_off': _rows(mainShow: false, otherShow: false),
    };
    for (final e in states.entries) {
      testWidgets(e.key, (tester) async {
        final w = _app(LiveTvShowCard(rows: e.value, texts: _texts(), onChanged: (_, _) {}));
        await pumpAtSize(tester, w, GoldenSize.phone);
        await expectLater(find.byKey(const ValueKey('live-tv-show')), matchesGoldenFile('live_tv_show_card_${e.key}_phone.png'));
      });
    }
    testWidgets('right to left', (tester) async {
      final w = _app(LiveTvShowCard(rows: _rows(mainShow: false), texts: _texts(), onChanged: (_, _) {}), dir: TextDirection.rtl);
      await pumpAtSize(tester, w, GoldenSize.phone);
      await expectLater(find.byKey(const ValueKey('live-tv-show')), matchesGoldenFile('live_tv_show_card_rtl_phone.png'));
    });
  });
}
