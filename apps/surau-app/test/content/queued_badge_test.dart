// A picture still waiting in the outbox wears a "Memuat naik..." chip on its
// thumbnail; it goes when the id leaves the queue. The queue is a fake.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/adjusted_picture.dart';
import 'package:surau_app/content/image_ref.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/sync/sync_providers.dart';

final _id = 'a' * 64;
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);

class _Queue extends Notifier<Set<String>> {
  @override
  Set<String> build() => {_id};
  void set(Set<String> v) => state = v;
}

final _queueProvider = NotifierProvider<_Queue, Set<String>>(_Queue.new);

Widget _app(ProviderContainer c, {double size = 88}) => UncontrolledProviderScope(
  container: c,
  child: MaterialApp(
    localizationsDelegates: S.localizationsDelegates,
    supportedLocales: S.supportedLocales,
    locale: const Locale('ms'),
    home: Scaffold(
      body: Center(child: AssetPicture(value: _id, slot: ImageSlot.poster, size: size)),
    ),
  ),
);

class _Lost extends Notifier<Set<String>> {
  @override
  Set<String> build() => {};
  void set(Set<String> v) => state = v;
}

final _lostProvider = NotifierProvider<_Lost, Set<String>>(_Lost.new);

ProviderContainer _container() => ProviderContainer(
  overrides: [
    lostAssetIdsProvider.overrideWith((ref) async => ref.watch(_lostProvider)),
    queuedAssetIdsProvider.overrideWith((ref) async => ref.watch(_queueProvider)),
    assetBytesProvider(_id).overrideWith((ref) async => Uint8List.fromList(_png)),
  ],
);

void main() {
  testWidgets('shows the chip while queued and drops it when the id leaves the queue', (tester) async {
    final c = _container();
    addTearDown(c.dispose);
    await tester.pumpWidget(_app(c));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('queued-chip')), findsOneWidget);
    expect(find.text('Memuat naik…'), findsOneWidget);

    c.read(_queueProvider.notifier).set({});
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('queued-chip')), findsNothing);
    expect(find.text('Memuat naik…'), findsNothing);
  });

  testWidgets('another id in the queue does not mark this picture', (tester) async {
    final c = _container();
    addTearDown(c.dispose);
    c.read(_queueProvider.notifier).set({'b' * 64});
    await tester.pumpWidget(_app(c));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('queued-chip')), findsNothing);
  });

  testWidgets('a small thumbnail keeps the icon only', (tester) async {
    final c = _container();
    addTearDown(c.dispose);
    await tester.pumpWidget(_app(c, size: 56));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('queued-chip')), findsOneWidget);
    expect(find.text('Memuat naik…'), findsNothing);
  });

  testWidgets('a picture whose bytes were lost says Gagal dimuat naik, not Memuat naik', (tester) async {
    final c = _container();
    addTearDown(c.dispose);
    c.read(_lostProvider.notifier).set({_id});
    await tester.pumpWidget(_app(c));
    await tester.pumpAndSettle();
    expect(find.text('Gagal dimuat naik'), findsOneWidget);
    expect(find.text('Memuat naik…'), findsNothing);

    c.read(_lostProvider.notifier).set({});
    await tester.pumpAndSettle();
    expect(find.text('Gagal dimuat naik'), findsNothing);
    expect(find.text('Memuat naik…'), findsOneWidget);
  });
}
