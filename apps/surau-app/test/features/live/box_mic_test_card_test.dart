// The box microphone test card (build 5, mockup B5): every chip state, the silent warning for the chosen row only,
// the button hidden without a callback, a disabled radio list, the level helper, and goldens for the three mockup
// states (chosen device silent, test running, a USB device chosen).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/box_mic_test.dart';
import 'package:surau_app/features/live/live_source_widgets.dart' show LevelMeter;

import '../../golden_sizes.dart';

MicTestTexts _texts({String? testedAt = 'Diuji pada 7:28 PTG.'}) => MicTestTexts(
  hint: 'Cakap ke mikrofon semasa ujian 5 saat. Pilih input yang ada bunyi.',
  testing: 'Menguji...',
  sound: 'Diuji: ada bunyi',
  silent: 'Diuji: senyap',
  failed: 'Tidak dapat diuji',
  none: 'Belum diuji',
  again: 'Uji semula (5 saat)',
  testedAt: testedAt,
  silentTitle: 'Input yang dipilih senyap',
  silentBody: 'Siaran akan ke udara tanpa suara penceramah. Pilih input lain atau semak kabel, kemudian uji semula.',
);

List<MicTestRow> _before() => const [
  MicTestRow(name: 'Mikrofon MAXCOM', selected: true, state: MicTestState.silent, meter: 0.0),
  MicTestRow(name: 'Kad bunyi USB', selected: false, state: MicTestState.sound, meter: 0.55),
];
List<MicTestRow> _busy() => const [
  MicTestRow(name: 'Mikrofon MAXCOM', selected: true, state: MicTestState.testing),
  MicTestRow(name: 'Kad bunyi USB', selected: false, state: MicTestState.testing),
];
List<MicTestRow> _after() => const [
  MicTestRow(name: 'Mikrofon MAXCOM', selected: false, state: MicTestState.silent, meter: 0.0),
  MicTestRow(name: 'Kad bunyi USB', selected: true, state: MicTestState.sound, meter: 0.55),
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

BoxMicTestCard _card(List<MicTestRow> rows, {bool testing = false, MicTestTexts? texts, void Function(String)? onPick, VoidCallback? again}) =>
    BoxMicTestCard(rows: rows, texts: texts ?? _texts(), testing: testing, onPick: onPick, onTestAgain: again);

void main() {
  test('micMeterOf follows the status meter: -60 dB is 0, 0 dB is 1, clamped, null stays null', () {
    expect(micMeterOf(null), isNull);
    expect(micMeterOf(-60), 0.0);
    expect(micMeterOf(-90), 0.0);
    expect(micMeterOf(-30), 0.5);
    expect(micMeterOf(0), 1.0);
    expect(micMeterOf(12), 1.0);
  });

  testWidgets('every chip state shows its own words', (tester) async {
    const rows = [
      MicTestRow(name: 'A', selected: false, state: MicTestState.none),
      MicTestRow(name: 'B', selected: false, state: MicTestState.testing),
      MicTestRow(name: 'C', selected: false, state: MicTestState.sound),
      MicTestRow(name: 'D', selected: false, state: MicTestState.silent),
      MicTestRow(name: 'E', selected: false, state: MicTestState.failed),
    ];
    await tester.pumpWidget(_app(_card(rows, testing: true, again: () {})));
    String chip(int i) => tester.widget<Text>(find.descendant(of: find.byKey(ValueKey('box-mic-test-chip-$i')), matching: find.byType(Text))).data!;
    expect([for (var i = 0; i < 5; i++) chip(i)], ['Belum diuji', 'Menguji...', 'Diuji: ada bunyi', 'Diuji: senyap', 'Tidak dapat diuji']);
    for (var i = 0; i < 5; i++) {
      expect(find.byKey(ValueKey('box-mic-test-row-$i')), findsOneWidget);
    }
    // only the testing chip has a spinner
    expect(find.descendant(of: find.byKey(const ValueKey('box-mic-test-chip-1')), matching: find.byType(CircularProgressIndicator)), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('box-mic-test-chip-2')), matching: find.byType(CircularProgressIndicator)), findsNothing);
  });

  testWidgets('the silent warning shows only when the CHOSEN row tested silent', (tester) async {
    await tester.pumpWidget(_app(_card(_before(), onPick: (_) {}, again: () {})));
    expect(find.byKey(const ValueKey('box-mic-test-silent')), findsOneWidget);
    expect(find.text('Input yang dipilih senyap'), findsOneWidget);
    // a silent row that is not chosen does not warn
    await tester.pumpWidget(_app(_card(_after(), onPick: (_) {}, again: () {})));
    expect(find.byKey(const ValueKey('box-mic-test-silent')), findsNothing);
    // nothing chosen: no warning
    await tester.pumpWidget(_app(_card(const [MicTestRow(name: 'A', selected: false, state: MicTestState.silent)])));
    expect(find.byKey(const ValueKey('box-mic-test-silent')), findsNothing);
    // chosen but not tested silent
    await tester.pumpWidget(_app(_card(const [MicTestRow(name: 'A', selected: true, state: MicTestState.failed)])));
    expect(find.byKey(const ValueKey('box-mic-test-silent')), findsNothing);
  });

  testWidgets('the button is hidden when onTestAgain is null, waits while testing, and otherwise calls back', (tester) async {
    await tester.pumpWidget(_app(_card(_before())));
    expect(find.byKey(const ValueKey('box-mic-test-again')), findsNothing);
    var n = 0;
    await tester.pumpWidget(_app(_card(_before(), testing: true, again: () => n++)));
    expect(tester.widget<OutlinedButton>(find.byKey(const ValueKey('box-mic-test-again'))).onPressed, isNull);
    await tester.pumpWidget(_app(_card(_before(), again: () => n++)));
    await tester.tap(find.byKey(const ValueKey('box-mic-test-again')));
    expect(n, 1);
    expect(find.text('Uji semula (5 saat)'), findsOneWidget);
  });

  testWidgets('the tested-at line shows only after a first test', (tester) async {
    await tester.pumpWidget(_app(_card(_before(), again: () {})));
    expect(find.text('Diuji pada 7:28 PTG.'), findsOneWidget);
    await tester.pumpWidget(_app(_card(_before(), texts: _texts(testedAt: null), again: () {})));
    expect(find.textContaining('Diuji pada'), findsNothing);
  });

  testWidgets('picking a row reports its name; a null onPick disables the radios', (tester) async {
    final picked = <String>[];
    await tester.pumpWidget(_app(_card(_before(), onPick: picked.add)));
    await tester.tap(find.byKey(const ValueKey('box-mic-test-row-1')));
    expect(picked, ['Kad bunyi USB']);
    await tester.pumpWidget(_app(_card(_before())));
    await tester.tap(find.byKey(const ValueKey('box-mic-test-row-1')));
    expect(picked, ['Kad bunyi USB'], reason: 'no onPick, no call');
    expect(tester.widget<InkWell>(find.byKey(const ValueKey('box-mic-test-row-1'))).onTap, isNull);
  });

  testWidgets('the level bar is drawn only for a row with a meter', (tester) async {
    await tester.pumpWidget(_app(_card(const [
      MicTestRow(name: 'A', selected: true, state: MicTestState.sound, meter: 0.6),
      MicTestRow(name: 'B', selected: false, state: MicTestState.none),
    ])));
    expect(find.descendant(of: find.byKey(const ValueKey('box-mic-test-row-0')), matching: find.byType(LevelMeter)), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('box-mic-test-row-1')), matching: find.byType(LevelMeter)), findsNothing);
  });

  testWidgets('every row is at least 48 dp tall to tap', (tester) async {
    await tester.pumpWidget(_app(_card(_before(), onPick: (_) {})));
    for (var i = 0; i < 2; i++) {
      expect(tester.getSize(find.byKey(ValueKey('box-mic-test-row-$i'))).height, greaterThanOrEqualTo(48));
    }
  });

  group('golden at phone size (the three mockup states)', () {
    Future<void> shot(WidgetTester tester, String name, Widget card, {TextDirection dir = TextDirection.ltr}) async {
      // a spinner never settles: one pump is enough for a still picture
      final view = tester.view;
      view.physicalSize = GoldenSize.phone.size * goldenPixelRatio;
      view.devicePixelRatio = goldenPixelRatio;
      addTearDown(view.resetPhysicalSize);
      addTearDown(view.resetDevicePixelRatio);
      await tester.pumpWidget(_app(card, dir: dir));
      await tester.pump();
      await expectLater(find.byKey(const ValueKey('box-mic-test')), matchesGoldenFile('box_mic_test_${name}_phone.png'));
    }

    testWidgets('chosen device tested silent', (tester) => shot(tester, 'silent', _card(_before(), onPick: (_) {}, again: () {})));
    testWidgets('test running', (tester) => shot(tester, 'busy', _card(_busy(), testing: true, texts: _texts(testedAt: null), onPick: (_) {}, again: () {})));
    testWidgets('USB device chosen', (tester) => shot(tester, 'usb', _card(_after(), onPick: (_) {}, again: () {})));
    testWidgets('right to left', (tester) => shot(tester, 'rtl', _card(_before(), onPick: (_) {}, again: () {}), dir: TextDirection.rtl));
  });
}
