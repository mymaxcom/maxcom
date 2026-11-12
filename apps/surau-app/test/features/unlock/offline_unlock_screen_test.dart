// The unlock screen when nothing answers: with a kept offline profile the
// app opens offline (at once in auto mode, after the local PIN in PIN mode;
// five wrong PINs lock it for five minutes); without one the screen tries
// again by itself every 10 s; a waking cloud is progress with an automatic
// retry after its Retry-After, never a red error.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/unlock/offline_vault.dart';
import 'package:surau_app/features/unlock/pin_pad.dart';
import 'package:surau_app/features/unlock/unlock_flow.dart';
import 'package:surau_app/features/unlock/unlock_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/transport.dart';

import '../fakes.dart';

Future<Uint8List> _inline(String pin, Uint8List salt, int it) async =>
    pbkdf2Sha256(pin, salt, it);

final _profile = OfflineProfile(
  userId: 'u1',
  name: 'Ustaz Ali',
  roles: const ['admin'],
  at: DateTime.utc(2026, 11, 11),
  surauName: 'Surau D\'Waqaf',
);

class _Entered {
  OfflineProfile? profile;
  String? pin;
  Future<SessionDto>? inFlight;
  int calls = 0;
}

/// A locator that answers from [answers] in order (a [Located] or a throw).
class _ScriptedLocator implements BoxLocator {
  _ScriptedLocator(this.answers);

  final List<Object> answers;
  int calls = 0;

  @override
  Future<Located> locate(EnrolledBox b) async {
    calls++;
    final a = answers.length > 1 ? answers.removeAt(0) : answers.first;
    if (a is Located) return a;
    throw a;
  }
}

void main() {
  late OfflineVault vault;
  late _Entered entered;

  Future<OfflineVault> vaultWithPin(String pin) async {
    vault = OfflineVault(
      store: MemoryLocalStore(),
      now: fixedNow,
      derive: _inline,
      iterations: 1000,
      minIterations: 1000,
    );
    await vault.saveProfile(_profile);
    await vault.savePin(pin);
    return vault;
  }

  OfflineDoor door({bool withProfile = true}) {
    entered = _Entered();
    return OfflineDoor(
      profile: () async => withProfile ? _profile : null,
      checkPin: (pin) => vault.checkPin(pin),
      enter: (p, {pin, inFlight}) {
        entered
          ..profile = p
          ..pin = pin
          ..inFlight = inFlight;
        entered.calls++;
      },
    );
  }

  UnlockFlow plainFlow(FakeBox box, {bool appLock = true}) {
    final enrolled = fixtureBox(appLock: appLock);
    return UnlockFlow(
      client: box.client(enrolled.box),
      key: FakeDeviceKey(present: true),
      box: enrolled,
      biometric: FakeBiometricPin(),
    );
  }

  Widget screen(
    UnlockFlow flow, {
    OfflineDoor? offline,
    bool appLock = true,
    void Function(SessionDto)? onUnlocked,
  }) {
    final enrolled = fixtureBox(appLock: appLock);
    final info = FakeBox(happyBox);
    return ProviderScope(
      child: MaterialApp(
        theme: SurauTheme.light(),
        locale: const Locale('ms'),
        localizationsDelegates: S.localizationsDelegates,
        supportedLocales: S.supportedLocales,
        home: UnlockScreen(
          flow: flow,
          box: enrolled,
          offline: offline,
          surauInfo: SurauInfoLoader(
            client: info.client(enrolled.box),
            store: MemorySurauInfoStore(SurauInfo.fromJson(fixtureInfoJson)),
          ),
          onUnlocked: onUnlocked ?? (_) {},
          onEnrolAgain: () {},
          now: fixedNow,
          toLocal: fixedToLocal,
        ),
      ),
    );
  }

  Future<void> frames(WidgetTester t, [int n = 4]) async {
    for (var i = 0; i < n; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> typeDigits(WidgetTester t, String digits) async {
    for (final d in digits.split('')) {
      await t.tap(find.widgetWithText(PinKey, d));
      await t.pump();
    }
    await frames(t);
  }

  final away = FakeBox((r) async => throw http.ClientException('no network'));

  group('a kept offline profile', () {
    testWidgets('auto mode, no network: opens offline at once', (t) async {
      await t.pumpWidget(
        screen(
          plainFlow(away, appLock: false),
          offline: door(),
          appLock: false,
        ),
      );
      await frames(t);
      expect(entered.calls, 1);
      expect(entered.profile!.userId, 'u1');
      expect(entered.pin, isNull);
      expect(find.text('MAXCOM tidak dapat dihubungi'), findsNothing);
    });

    testWidgets('auto mode, nothing answers in 3 s: opens offline with the '
        'unlock still under way', (t) async {
      final never = Completer<http.Response>();
      final silent = FakeBox((r) => never.future);
      await t.pumpWidget(
        screen(
          plainFlow(silent, appLock: false),
          offline: door(),
          appLock: false,
        ),
      );
      await frames(t);
      expect(entered.calls, 0);
      await t.pump(const Duration(seconds: 3));
      await frames(t);
      expect(entered.calls, 1);
      expect(entered.inFlight, isNotNull, reason: 'the reconnector adopts it');
      never.complete(jsonResponse(500, {'errors': ['x']}));
      await frames(t);
    });

    testWidgets('PIN mode, no network: the right PIN opens offline and is '
        'kept in memory', (t) async {
      await vaultWithPin('280419');
      await t.pumpWidget(screen(plainFlow(away), offline: door()));
      await frames(t);
      expect(find.byType(PinKey), findsNWidgets(11));
      await typeDigits(t, '280419');
      expect(entered.calls, 1);
      expect(entered.pin, '280419');
    });

    testWidgets('PIN mode: five wrong PINs lock offline unlock for 5 minutes',
        (t) async {
      await vaultWithPin('280419');
      await t.pumpWidget(screen(plainFlow(away), offline: door()));
      await frames(t);
      for (var left = 4; left >= 1; left--) {
        await typeDigits(t, '111111');
        expect(find.text('PIN salah. $left cubaan lagi.'), findsOneWidget);
      }
      await typeDigits(t, '111111');
      expect(find.text('PIN dikunci sementara'), findsOneWidget);
      // 14:30 UTC + 5 min, in Malaysian time.
      expect(find.text('Cuba lagi pada 10:35 malam'), findsOneWidget);
      // Locked: even the right PIN is not taken.
      await typeDigits(t, '280419');
      expect(entered.calls, 0);
    });

    testWidgets('the box answers in time: the online unlock wins', (t) async {
      await vaultWithPin('280419');
      SessionDto? got;
      await t.pumpWidget(
        screen(
          plainFlow(FakeBox(happyBox)),
          offline: door(),
          onUnlocked: (s) => got = s,
        ),
      );
      await frames(t);
      await typeDigits(t, '280419');
      expect(got?.token, 'tok-1');
      expect(entered.calls, 0);
    });
  });

  group('never unlocked online', () {
    testWidgets('auto mode: the error stays, and it tries again every 10 s',
        (t) async {
      var up = false;
      final box = FakeBox((r) async {
        if (!up) throw http.ClientException('away');
        if (r.url.path == '/api/auth/challenge') {
          return jsonResponse(200, {
            'nonce': 'n',
            'expiresAt': 'x',
            'appLock': false,
          });
        }
        return happyBox(r);
      });
      SessionDto? got;
      await t.pumpWidget(
        screen(
          plainFlow(box, appLock: false),
          offline: door(withProfile: false),
          appLock: false,
          onUnlocked: (s) => got = s,
        ),
      );
      await frames(t);
      expect(find.text('MAXCOM tidak dapat dihubungi'), findsOneWidget);
      expect(find.text('Mencuba lagi secara automatik.'), findsOneWidget);
      expect(find.text('Cuba lagi'), findsOneWidget);
      await t.pump(const Duration(seconds: 10));
      await frames(t);
      expect(got, isNull, reason: 'still away');
      up = true;
      await t.pump(const Duration(seconds: 10));
      await frames(t);
      expect(got?.token, 'tok-1');
      expect(entered.calls, 0);
    });

    testWidgets('PIN mode: the same PIN is tried again after 10 s', (t) async {
      var up = false;
      final box = FakeBox((r) async {
        if (!up) throw http.ClientException('away');
        return happyBox(r);
      });
      SessionDto? got;
      await t.pumpWidget(
        screen(plainFlow(box), onUnlocked: (s) => got = s),
      );
      await frames(t);
      await typeDigits(t, '280419');
      expect(
        find.text('Tidak dapat menghubungi Surau D\'Waqaf'),
        findsOneWidget,
      );
      up = true;
      await t.pump(const Duration(seconds: 10));
      await frames(t);
      expect(got?.token, 'tok-1');
    });
  });

  group('the cloud is waking (503 Retry-After)', () {
    final cloud = Uri.parse('https://api.mymaxcom.my');
    final atCloud = Located(
      base: cloud,
      via: 'cloud',
      health: const HealthDto(ok: true, version: 1),
    );

    UnlockFlow locatedFlow(_ScriptedLocator locator, {bool appLock = true}) {
      final enrolled = fixtureBox(appLock: appLock);
      final world = FakeBox((r) async {
        if (r.url.path == '/api/auth/challenge') {
          return jsonResponse(200, {
            'nonce': 'n',
            'expiresAt': 'x',
            'appLock': appLock,
          });
        }
        return happyBox(r);
      });
      return LocatedUnlockFlow(
        client: world.client(enrolled.box),
        key: FakeDeviceKey(present: true),
        box: enrolled,
        biometric: FakeBiometricPin(),
        locator: locator,
        clientFor: (base) async => world.client(base),
        tokens: SessionTokens(),
      );
    }

    testWidgets('auto mode: progress, then by itself after Retry-After',
        (t) async {
      final locator = _ScriptedLocator([
        const CloudWaking(retryAfterSec: 35),
        atCloud,
      ]);
      SessionDto? got;
      await t.pumpWidget(
        screen(
          locatedFlow(locator, appLock: false),
          appLock: false,
          onUnlocked: (s) => got = s,
        ),
      );
      await frames(t);
      expect(find.text('Menghidupkan awan MAXCOM...'), findsOneWidget);
      expect(find.text('Cuba lagi'), findsNothing, reason: 'not an error');
      expect(find.text('Awan sedang dihidupkan'), findsNothing);
      await t.pump(const Duration(seconds: 34));
      expect(locator.calls, 1);
      await t.pump(const Duration(seconds: 1));
      await frames(t);
      expect(locator.calls, 2);
      expect(got?.via, 'cloud');
      expect(got?.base, cloud);
    });

    testWidgets('PIN mode: progress under the dots, the PIN retried after '
        'Retry-After (at most 90 s)', (t) async {
      final locator = _ScriptedLocator([
        const CloudWaking(retryAfterSec: 600),
        atCloud,
      ]);
      SessionDto? got;
      await t.pumpWidget(
        screen(locatedFlow(locator), onUnlocked: (s) => got = s),
      );
      await frames(t);
      await typeDigits(t, '280419');
      expect(find.text('Menghidupkan awan MAXCOM...'), findsOneWidget);
      expect(find.text('Cuba lagi'), findsNothing);
      await t.pump(const Duration(seconds: 90));
      await frames(t);
      expect(got?.via, 'cloud');
    });
  });
}
