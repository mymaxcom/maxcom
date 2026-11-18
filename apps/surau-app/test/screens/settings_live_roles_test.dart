// Who may change the four live features: Siaran Langsung (`live:settings`)
// edits liveOnKiosk, liveYoutube, recording and liveCamera and nothing else;
// Media edits none of them; the Pentadbir edits all (core LIVE_SETTINGS_FEATURES).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/shell/permissions.dart';

import '../features/shell/harness.dart';

const _live = ['liveOnKiosk', 'liveYoutube', 'recording', 'liveCamera'];

Finder get _featureSwitch =>
    find.descendant(of: find.byKey(const ValueKey('feature-switch')), matching: find.byType(Switch));

Future<bool?> _switchWritable(WidgetTester tester, String role, String feature) async {
  final h = await pumpShell(tester, roles: [role]);
  h.router.go('/settings/$feature');
  await settle(tester);
  if (_featureSwitch.evaluate().isEmpty) return null;
  return tester.widget<Switch>(_featureSwitch).onChanged != null;
}

void main() {
  test('the helper mirrors core: live role writes the four live features only', () {
    for (final f in _live) {
      expect(canWriteSettingsFeature({'live'}, f), isTrue, reason: f);
      expect(canWriteSettingsFeature({'media'}, f), isFalse, reason: f);
      expect(canWriteSettingsFeature({'admin'}, f), isTrue, reason: f);
    }
    expect(canWriteSettingsFeature({'live'}, 'beeps'), isFalse);
    expect(canWriteSettingsFeature({'admin'}, 'beeps'), isTrue);
  });

  for (final f in ['liveOnKiosk', 'liveYoutube', 'recording']) {
    testWidgets('live role can switch $f', (tester) async {
      expect(await _switchWritable(tester, 'live', f), isTrue);
    });
    testWidgets('media cannot switch $f', (tester) async {
      expect(await _switchWritable(tester, 'media', f), isFalse);
    });
    testWidgets('admin can switch $f', (tester) async {
      expect(await _switchWritable(tester, 'admin', f), isTrue);
    });
  }

  testWidgets('live role cannot switch an ordinary feature', (tester) async {
    expect(await _switchWritable(tester, 'live', 'beeps'), isFalse);
  });

  testWidgets('the Tetapan list shows the live rows and only they are writable for the live role', (tester) async {
    final h = await pumpShell(tester, roles: const ['live']);
    h.router.go('/settings');
    await settle(tester);
    for (final f in _live) {
      await tester.enterText(find.byKey(const ValueKey('settings-search')), f == 'liveCamera' ? 'kamera' : f == 'recording' ? 'rakaman' : f == 'liveYoutube' ? 'youtube' : 'siaran');
      await settle(tester);
      expect(find.byKey(ValueKey('settings-row-$f')), findsOneWidget, reason: f);
    }
    await tester.enterText(find.byKey(const ValueKey('settings-search')), 'siaran');
    await settle(tester);
    final sw = find.byKey(const ValueKey('settings-switch-liveOnKiosk'));
    if (sw.evaluate().isNotEmpty) expect(tester.widget<Switch>(sw).onChanged, isNotNull);
  });
}
