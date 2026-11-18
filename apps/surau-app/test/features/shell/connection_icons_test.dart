// The MAXCOM cloud and box icons in the top bar of every page (operator
// round 1, screen 16): four states each, told apart by shape as well as
// colour, each icon with its own state, both kept on a narrow phone with a
// long title, and a tap opens what the app already had (the sync sheet for
// the cloud, the box's check again for the box).
//
// Goldens: connection_icons_cloud_<state>, connection_icons_box_<state>.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/shell/connection_icons.dart';
import 'package:surau_app/features/sync/sync_actions.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../../golden_sizes.dart';
import 'harness.dart';

class _FakeSync implements SyncActions {
  _FakeSync(this.view);
  SyncView view;
  int calls = 0;

  @override
  Future<SyncView> syncNow() async {
    calls++;
    return view;
  }

  @override
  Future<List<Map<String, dynamic>>> conflicts() async => const [];

  @override
  Future<void> discard(String opId) async {}

  @override
  Future<void> reapply(Map<String, dynamic> conflict) async {}
}

final DateTime _lastSync = DateTime.utc(2026, 11, 4, 14, 25);

Future<ShellHarness> _shell(
  WidgetTester tester,
  SyncView? view, {
  GoldenSize size = GoldenSize.phone,
  String path = '/settings',
}) async {
  final fake = view == null ? null : _FakeSync(view);
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    size: size,
    overrides: [
      livePublisherProvider.overrideWithValue(FakePublisher()),
      if (fake != null) ...[
        syncActionsProvider.overrideWithValue(fake),
        syncViewProvider.overrideWith((ref) => Stream.value(fake.view)),
      ],
    ],
  );
  h.router.go(path);
  await settle(tester);
  return h;
}

Widget _strip(LinkState? cloud, LinkState box) => MaterialApp(
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  theme: SurauTheme.light(),
  home: Scaffold(
    backgroundColor: SurauColors.glass,
    body: Center(
      child: ConnectionIconsView(cloud: cloud, box: box),
    ),
  ),
);

void main() {
  group('the states', () {
    const cloudWords = {
      LinkState.connected: 'Awan MAXCOM: bersambung',
      LinkState.connecting: 'Awan MAXCOM: sedang menyambung',
      LinkState.syncing: 'Awan MAXCOM: sedang menghantar perubahan',
      LinkState.disconnected: 'Awan MAXCOM: tidak bersambung',
      LinkState.error: 'Awan MAXCOM: ralat penyelarasan',
    };
    const boxWords = {
      LinkState.connected: 'MAXCOM di surau: bersambung',
      LinkState.connecting: 'MAXCOM di surau: sedang menyambung',
      LinkState.syncing: 'MAXCOM di surau: sedang menghantar perubahan',
      LinkState.disconnected: 'MAXCOM di surau: tidak dapat dihubungi',
      LinkState.error: 'MAXCOM di surau: ralat',
    };

    testWidgets('[CL-7] each of the ten reads its own words (error included)', (tester) async {
      final seen = <String>{};
      for (final state in LinkState.values) {
        await tester.pumpWidget(_strip(state, state));
        await tester.pumpAndSettle();
        expect(find.bySemanticsLabel(cloudWords[state]!), findsOneWidget);
        expect(find.bySemanticsLabel(boxWords[state]!), findsOneWidget);
        seen
          ..add(cloudWords[state]!)
          ..add(boxWords[state]!);
      }
      expect(seen, hasLength(10));
    });

    test('[CL-7] the error state has words in ms, en and ar for both links', () {
      expect(linkWords(SEn(), LinkKind.cloud, LinkState.error), 'MAXCOM cloud: sync error');
      expect(linkWords(SEn(), LinkKind.box, LinkState.error), 'MAXCOM at the surau: error');
      expect(linkWords(SAr(), LinkKind.cloud, LinkState.error), 'سحابة MAXCOM: خطأ في المزامنة');
      expect(linkWords(SAr(), LinkKind.box, LinkState.error), 'MAXCOM في المصلى: خطأ');
    });

    testWidgets('no cloud link: the box alone', (tester) async {
      await tester.pumpWidget(_strip(null, LinkState.connected));
      expect(find.byKey(const ValueKey('link-cloud')), findsNothing);
      expect(find.byKey(const ValueKey('link-box')), findsOneWidget);
    });

    testWidgets('[CL-7] the shape differs per state, not the colour only (five states)', (tester) async {
      final looks = <String>{};
      for (final state in LinkState.values) {
        await tester.pumpWidget(_strip(null, state));
        final glyph = tester.widget<LinkGlyph>(find.byType(LinkGlyph));
        looks.add('${glyph.dashed}/${glyph.badgeShape}');
      }
      expect(looks, hasLength(5));
    });

    for (final kind in LinkKind.values) {
      for (final state in LinkState.values) {
        testWidgets('golden ${kind.name} ${state.name}', (tester) async {
          tester.view.physicalSize = const Size(120, 72) * 2;
          tester.view.devicePixelRatio = 2;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final app = _strip(
            kind == LinkKind.cloud ? state : null,
            kind == LinkKind.box ? state : LinkState.connected,
          );
          await tester.pumpWidget(app);
          await tester.pumpAndSettle();
          await expectLater(
            find.byKey(ValueKey('link-${kind.name}')),
            matchesGoldenFile('connection_icons_${kind.name}_${state.name}.png'),
          );
        });
      }
    }
  });

  group('the state of each', () {
    test('the cloud follows the sync engine', () {
      SyncView v({int out = 0, SyncState state = SyncState.idle, String? err, DateTime? last}) =>
          SyncView(pendingOut: out, state: state, lastError: err, lastSync: last, via: 'box');
      expect(cloudStateOf(v(last: _lastSync)), LinkState.connected);
      expect(cloudStateOf(v()), LinkState.connecting, reason: 'never synced yet');
      expect(cloudStateOf(v(state: SyncState.waking, last: _lastSync)), LinkState.connecting);
      expect(cloudStateOf(v(state: SyncState.syncing, last: _lastSync)), LinkState.syncing);
      expect(cloudStateOf(v(out: 2, last: _lastSync)), LinkState.syncing);
      expect(cloudStateOf(v(state: SyncState.offline, out: 2, last: _lastSync)), LinkState.disconnected);
      expect(cloudStateOf(v(err: 'cloud_unreachable', last: _lastSync)), LinkState.disconnected);
    });

    testWidgets('box away, cloud answering: each icon shows its own state', (tester) async {
      final h = await _shell(tester, SyncView(lastSync: _lastSync, via: 'cloud'));
      h.boxAway = true;
      await h.container.read(healthProvider.notifier).refresh();
      await settle(tester);
      expect(find.bySemanticsLabel('MAXCOM di surau: tidak dapat dihubungi'), findsOneWidget);
      expect(find.bySemanticsLabel('Awan MAXCOM: bersambung'), findsOneWidget);
    });

    testWidgets('box answering, cloud away: each icon shows its own state', (tester) async {
      await _shell(tester, SyncView(lastSync: _lastSync, via: 'box', lastError: 'cloud_unreachable'));
      expect(find.bySemanticsLabel('MAXCOM di surau: bersambung'), findsOneWidget);
      expect(find.bySemanticsLabel('Awan MAXCOM: tidak bersambung'), findsOneWidget);
    });

    testWidgets('no sync engine: no cloud icon, the box still shows', (tester) async {
      await _shell(tester, null);
      expect(find.byKey(const ValueKey('link-cloud')), findsNothing);
      expect(find.bySemanticsLabel('MAXCOM di surau: bersambung'), findsOneWidget);
    });
  });

  testWidgets('a 320 dp phone with a long title: the title ends in dots, both icons stay whole', (tester) async {
    final h = await _shell(tester, SyncView(lastSync: _lastSync, via: 'box'), path: '/users');
    tester.view.physicalSize = const Size(320, 640) * 2;
    tester.view.devicePixelRatio = 2;
    await tester.pumpWidget(h.app);
    await settle(tester);
    final title = tester.widget<Text>(find.descendant(of: find.byType(AppBar), matching: find.text('Pengguna & peranti')));
    expect(title.overflow, TextOverflow.ellipsis);
    expect(title.maxLines, 1);
    for (final key in const ['link-cloud', 'link-box']) {
      final r = tester.getRect(find.byKey(ValueKey(key)));
      expect(r.left, greaterThanOrEqualTo(0), reason: key);
      expect(r.right, lessThanOrEqualTo(320), reason: key);
      expect(r.width, greaterThanOrEqualTo(40), reason: '$key tap target');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a tap on the cloud opens the sync sheet', (tester) async {
    await _shell(tester, SyncView(lastSync: _lastSync, via: 'box'));
    await tester.tap(find.byKey(const ValueKey('link-cloud')));
    await settle(tester);
    expect(find.text('Penyelarasan'), findsOneWidget);
    expect(find.text('Selaraskan sekarang'), findsOneWidget);
  });

  testWidgets('a tap on the box asks it again and says what it found', (tester) async {
    final h = await _shell(tester, SyncView(lastSync: _lastSync, via: 'box'));
    final before = h.box.seen.where((r) => r.url.path == '/api/health').length;
    await tester.tap(find.byKey(const ValueKey('link-box')));
    await settle(tester);
    expect(h.box.seen.where((r) => r.url.path == '/api/health').length, before + 1);
    expect(find.text('Dihubungi 10:30 malam'), findsOneWidget);
  });

  testWidgets('every page has the icons: a settings page and the content list', (tester) async {
    final h = await _shell(tester, SyncView(lastSync: _lastSync, via: 'box'));
    expect(find.byType(ConnectionIcons), findsOneWidget);
    h.router.go('/content');
    await settle(tester);
    expect(find.byType(ConnectionIcons), findsOneWidget);
  });
}
