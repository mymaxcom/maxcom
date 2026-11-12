// Peranti: a cancelled device or paired screen is never listed (operator
// rule 2026-11-06). After `Batalkan` it leaves the list at once, even
// before the box's next answer; a revoked row from the store or the box is
// never drawn; with nothing left the empty state reads right.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../features/shell/harness.dart';

Map<String, Object?> dev(
  String id,
  String name, {
  String platform = 'android',
  bool revoked = false,
  String userId = 'u1',
}) => {
  'id': id,
  'userId': userId,
  'name': name,
  'platform': platform,
  'revoked': revoked,
};

Future<ShellHarness> open(
  WidgetTester tester,
  List<Map<String, Object?>> devices,
) async {
  final h = await pumpShell(tester, roles: const ['admin']);
  h.devices = devices;
  h.router.go('/devices');
  await settle(tester);
  return h;
}

Future<void> cancel(WidgetTester tester, String id, String name) async {
  final row = find.byKey(ValueKey('device-$id'));
  await tester.tap(find.descendant(of: row, matching: find.text('Batalkan')));
  await settle(tester);
  await tester.tap(find.widgetWithText(FilledButton, 'Batalkan'));
  await settle(tester);
}

void main() {
  testWidgets('three listed, cancel one, two at once, with the toast', (tester) async {
    final h = await open(tester, [
      dev('a', 'Telefon A'),
      dev('b', 'iPad B', platform: 'ios-web'),
      dev('c', 'Skrin C', platform: 'kiosk'),
    ]);
    expect(find.byKey(const ValueKey('device-a')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-b')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-c')), findsOneWidget);

    // The fake box does not change its list on revoke: only the optimistic
    // removal can make the row go.
    await cancel(tester, 'b', 'iPad B');
    expect(h.box.byPath('/api/devices/b/revoke')?.method, 'POST');
    expect(find.text('iPad B dibatalkan.'), findsOneWidget);
    expect(find.byKey(const ValueKey('device-b')), findsNothing);
    expect(find.byKey(const ValueKey('device-a')), findsOneWidget);
    expect(find.byKey(const ValueKey('device-c')), findsOneWidget);
    expect(find.text('Dibatalkan'), findsNothing);

    await cancel(tester, 'c', 'Skrin C');
    expect(find.byKey(const ValueKey('device-c')), findsNothing);
    expect(find.byKey(const ValueKey('device-a')), findsOneWidget);
  });

  testWidgets('a revoked device or screen from the box or store is never shown', (tester) async {
    await open(tester, [
      dev('a', 'Telefon A'),
      dev('old', 'Telefon lama', revoked: true),
      dev('tv-old', 'Skrin lama', platform: 'kiosk', revoked: true),
    ]);
    expect(find.byKey(const ValueKey('device-a')), findsOneWidget);
    expect(find.text('Telefon lama'), findsNothing);
    expect(find.text('Skrin lama'), findsNothing);
    expect(find.text('Dibatalkan'), findsNothing);
    expect(find.byKey(const ValueKey('device-tv-old')), findsNothing);
  });

  testWidgets('empty state when nothing live is left', (tester) async {
    await open(tester, [dev('a', 'Telefon A'), dev('old', 'Telefon lama', revoked: true)]);
    expect(find.text('Belum ada peranti didaftarkan.'), findsNothing);
    await cancel(tester, 'a', 'Telefon A');
    expect(find.byKey(const ValueKey('device-a')), findsNothing);
    expect(find.text('Belum ada peranti didaftarkan.'), findsOneWidget);
  });

  testWidgets('only revoked rows: the empty state, not a grey list', (tester) async {
    await open(tester, [dev('old', 'Telefon lama', revoked: true)]);
    expect(find.text('Belum ada peranti didaftarkan.'), findsOneWidget);
    expect(find.text('Telefon lama'), findsNothing);
  });
}
