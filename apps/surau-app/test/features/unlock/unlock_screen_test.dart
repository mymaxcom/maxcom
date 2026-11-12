// Unlock screen: surau name and greeting, PIN pad, lockout with the exact
// time and the help card, new PIN after an admin reset, revoked device,
// box away, biometrics, Lupa PIN, Bukan anda. Goldens: unlock,
// unlock_three_roles, unlock_new_pin, unlock_locked, unlock_unreachable,
// unlock_revoked, unlock_forgot_pin.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/unlock/biometric_pin.dart';
import 'package:surau_app/features/unlock/pin_pad.dart';
import 'package:surau_app/features/unlock/session.dart';
import 'package:surau_app/features/unlock/unlock_flow.dart';
import 'package:surau_app/features/unlock/unlock_screen.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';
import '../shell/harness.dart'
    show
        fixtureInfoWithLogoJson,
        fixtureLogoPng,
        fixtureMaxcomRemovedPng,
        settleImages;

late FakeDeviceKey key;
late FakeBiometricPin bio;
late FakeBox lastBox;
late List<String> roles;

/// The app lock the enrolled box record carries (the default is on).
bool boxAppLock = true;

UnlockFlow flowFor(
  FakeBox box, {
  bool keyPresent = true,
  List<String> withRoles = const ['admin'],
  bool appLock = true,
}) {
  boxAppLock = appLock;
  key = FakeDeviceKey(present: keyPresent);
  bio = FakeBiometricPin();
  lastBox = box;
  roles = withRoles;
  final enrolled = fixtureBox(roles: roles, appLock: boxAppLock);
  return UnlockFlow(
    client: box.client(enrolled.box),
    key: key,
    box: enrolled,
    biometric: bio,
  );
}

late ProviderContainer container;
late FakeOpener opener;

/// [cachedInfo]: the surau details the enrolment seeded, as on a real
/// device; false starts with nothing cached.
Widget screen(
  UnlockFlow flow, {
  void Function(SessionDto)? onUnlocked,
  VoidCallback? onEnrolAgain,
  bool cachedInfo = true,
}) {
  container = ProviderContainer();
  addTearDown(container.dispose);
  opener = FakeOpener();
  final enrolled = fixtureBox(roles: roles, appLock: boxAppLock);
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      key: UniqueKey(),
      debugShowCheckedModeBanner: false,
      theme: SurauTheme.light(),
      locale: const Locale('ms'),
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      home: UnlockScreen(
        flow: flow,
        box: enrolled,
        surauInfo: SurauInfoLoader(
          client: lastBox.client(enrolled.box),
          store: MemorySurauInfoStore(
            cachedInfo ? SurauInfo.fromJson(fixtureInfoJson) : null,
          ),
        ),
        onUnlocked: onUnlocked ?? (_) {},
        onEnrolAgain: onEnrolAgain ?? () {},
        openUrl: opener.call,
        now: fixedNow,
        toLocal: fixedToLocal,
      ),
    ),
  );
}

/// Pumps by hand: while the lock-off view waits, its spinner never lets
/// `pumpAndSettle` finish (and a test's `onUnlocked` does not navigate away).
Future<void> pumpFrames(WidgetTester t, Widget w, GoldenSize size) async {
  t.view.physicalSize = size.size * goldenPixelRatio;
  t.view.devicePixelRatio = goldenPixelRatio;
  addTearDown(t.view.resetPhysicalSize);
  addTearDown(t.view.resetDevicePixelRatio);
  await t.pumpWidget(w);
  for (var i = 0; i < 4; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> typeDigits(WidgetTester t, String digits) async {
  for (final d in digits.split('')) {
    await t.tap(find.widgetWithText(PinKey, d));
    await t.pump();
  }
  await t.pumpAndSettle();
}

/// Unlock answers [status] with [message] (challenge and info succeed).
FakeBox boxAnswering(
  int status,
  String message, {
  Map<String, String>? headers,
  Map<String, Object?> extra = const {},
}) => FakeBox((r) async {
  if (r.url.path != '/api/auth/unlock') return happyBox(r);
  return jsonResponse(status, {
    'errors': [message],
    ...extra,
  }, headers: headers);
});

void main() {
  testWidgets(
    'leads with the surau, greets the user by name and role; 6 digits unlock',
    (tester) async {
      final box = FakeBox(happyBox);
      SessionDto? got;
      await pumpAtSize(
        tester,
        screen(flowFor(box), onUnlocked: (s) => got = s),
        GoldenSize.phone,
      );
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
      expect(find.text('Pentadbir'), findsOneWidget);
      expect(find.text('Masukkan PIN untuk teruskan'), findsOneWidget);
      expect(
        find.textContaining('127.0.0.1'),
        findsNothing,
        reason: 'no address up front',
      );
      // Ten digits and the backspace; no biometric key without a sealed PIN.
      expect(find.byType(PinKey), findsNWidgets(11));
      expect(find.text('Guna cap jari'), findsNothing);
      expect(find.text('Lupa PIN?'), findsOneWidget);
      expect(
        find.text('Bukan anda? Daftar peranti ini semula'),
        findsOneWidget,
      );

      await typeDigits(tester, '280419');

      expect(box.bodyOf('/api/auth/unlock')['pin'], '280419');
      expect(got?.token, 'tok-1');
      expect(container.read(sessionProvider)?.token, 'tok-1');
    },
  );

  testWidgets('several roles read as one calm sentence', (tester) async {
    await pumpAtSize(
      tester,
      screen(
        flowFor(FakeBox(happyBox), withRoles: ['media', 'admin', 'treasurer']),
      ),
      GoldenSize.phone,
    );
    expect(find.text('Pentadbir, Bendahari dan Media'), findsOneWidget);
  });

  testWidgets(
    'no cached info and a box that is away: the product name, not an address',
    (tester) async {
      final box = FakeBox((r) async => throw const BoxUnreachable());
      await pumpAtSize(
        tester,
        screen(flowFor(box), cachedInfo: false),
        GoldenSize.phone,
      );
      expect(find.text('MAXCOM'), findsOneWidget);
      expect(find.textContaining('Kotak'), findsNothing);
    },
  );

  testWidgets('the surau name refreshes from GET /api/surau/info', (
    tester,
  ) async {
    final box = FakeBox((r) async {
      if (r.url.path == '/api/surau/info') {
        return jsonResponse(200, {'name': 'Surau Baharu', 'kind': 'surau'});
      }
      return happyBox(r);
    });
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    expect(find.text('Surau Baharu'), findsOneWidget);
    final req = box.byPath('/api/surau/info')!;
    expect(req.headers.containsKey('authorization'), isFalse);
  });

  testWidgets(
    'the surau logo shows above the name when GET /api/surau/info names one, through the same client',
    (tester) async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/surau/info') {
          return jsonResponse(200, fixtureInfoWithLogoJson());
        }
        if (r.url.path == '/surau-logo') {
          return http.Response.bytes(
            fixtureLogoPng(),
            200,
            headers: {'content-type': 'image/png'},
          );
        }
        return happyBox(r);
      });
      await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
      expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
      final req = box.byPath('/surau-logo')!;
      expect(
        req.url.query,
        'v=d3d3d3d3d3d3d3d3',
        reason: 'the version tag travels with it',
      );
      expect(req.headers.containsKey('authorization'), isFalse);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
    },
  );

  testWidgets(
    'a logo the box cannot serve leaves the door exactly as without one',
    (tester) async {
      final box = FakeBox((r) async {
        if (r.url.path == '/api/surau/info') {
          return jsonResponse(200, fixtureInfoWithLogoJson());
        }
        if (r.url.path == '/surau-logo') {
          return jsonResponse(404, {
            'errors': ['not found'],
          });
        }
        return happyBox(r);
      });
      await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
      expect(find.byKey(const ValueKey('surau-logo')), findsNothing);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
    },
  );

  testWidgets('backspace removes the last digit', (tester) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    await typeDigits(tester, '28041');
    await tester.tap(find.bySemanticsLabel('Padam digit'));
    await tester.pump();
    await typeDigits(tester, '19');
    expect(box.bodyOf('/api/auth/unlock')['pin'], '280419');
  });

  testWidgets('wrong PIN: box message shown, dots cleared, pad still live', (
    tester,
  ) async {
    final box = boxAnswering(401, 'PIN salah');
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    await typeDigits(tester, '280418');
    expect(find.text('PIN salah'), findsOneWidget);
    expect(
      find.text('Perlukan bantuan?'),
      findsNothing,
      reason: 'not stuck yet',
    );
    await typeDigits(tester, '280419');
    expect(box.seen.where((r) => r.url.path == '/api/auth/unlock').length, 2);
  });

  testWidgets(
    'two wrong PINs in a row: pad stays live and the help card shows',
    (tester) async {
      final box = boxAnswering(401, 'PIN salah');
      await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
      await typeDigits(tester, '280418');
      expect(find.text('Perlukan bantuan?'), findsNothing);
      await typeDigits(tester, '280417');
      expect(find.text('PIN salah'), findsOneWidget);
      expect(find.text('Perlukan bantuan?'), findsOneWidget);
      await typeDigits(tester, '280416');
      expect(box.seen.where((r) => r.url.path == '/api/auth/unlock').length, 3);
    },
  );

  testWidgets('423: the exact unlock time, the help card, and a dim pad', (
    tester,
  ) async {
    final box = boxAnswering(
      423,
      'Akaun dikunci. Cuba lagi dalam 15 minit',
      headers: {'retry-after': '900'},
    );
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    await typeDigits(tester, '280419');
    expect(find.text('PIN dikunci sementara'), findsOneWidget);
    expect(find.text('Cuba lagi pada 10:45 malam'), findsOneWidget);
    expect(find.text('Perlukan bantuan?'), findsOneWidget);
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    await tester.tap(find.text('Telefon'));
    expect(opener.opened.single.toString(), 'tel:0123456789');
    await typeDigits(tester, '280419');
    expect(box.seen.where((r) => r.url.path == '/api/auth/unlock').length, 1);
  });

  testWidgets(
    '409: asks for a new PIN twice, refuses a weak one, sends newPin',
    (tester) async {
      var unlockCalls = 0;
      final box = FakeBox((r) async {
        if (r.url.path != '/api/auth/unlock') return happyBox(r);
        unlockCalls++;
        if (r.body.contains('newPin')) return jsonResponse(200, sessionJson);
        return jsonResponse(409, {
          'errors': ['PIN baharu diperlukan'],
          'pinRequired': true,
        });
      });
      SessionDto? got;
      await pumpAtSize(
        tester,
        screen(flowFor(box), onUnlocked: (s) => got = s),
        GoldenSize.phone,
      );
      await typeDigits(tester, '280419');
      expect(find.text('Tetapkan PIN baharu'), findsOneWidget);
      expect(
        find.text('Lupa PIN?'),
        findsNothing,
        reason: 'no PIN to forget yet',
      );
      expect(unlockCalls, 1);

      await typeDigits(tester, '123456');
      expect(find.textContaining('PIN terlalu mudah'), findsOneWidget);
      expect(unlockCalls, 1);

      await typeDigits(tester, '280419');
      expect(find.text('Masukkan PIN sekali lagi'), findsOneWidget);
      await typeDigits(tester, '280418');
      expect(find.text('PIN tidak sepadan'), findsOneWidget);
      expect(unlockCalls, 1);

      await typeDigits(tester, '280419');
      await typeDigits(tester, '280419');
      expect(unlockCalls, 2);
      final last = box.bodyOf('/api/auth/unlock');
      expect(box.seen.last.body, contains('"newPin":"280419"'));
      expect(last.containsKey('deviceId'), isTrue);
      expect(got?.token, 'tok-1');
    },
  );

  testWidgets(
    'revoked device: explanation, help card, Daftar semula; pad gone',
    (tester) async {
      final box = boxAnswering(401, 'Peranti telah dibatalkan');
      var again = 0;
      await pumpAtSize(
        tester,
        screen(flowFor(box), onEnrolAgain: () => again++),
        GoldenSize.phone,
      );
      await typeDigits(tester, '280419');
      expect(find.text('Peranti telah dibatalkan'), findsOneWidget);
      expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
      expect(find.byType(PinKey), findsNothing);
      expect(find.text('Daftar semula'), findsOneWidget);
      await tester.tap(find.text('Daftar semula'));
      expect(again, 1);
    },
  );

  testWidgets('missing device key: no request, Daftar semula offered', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    await pumpAtSize(
      tester,
      screen(flowFor(box, keyPresent: false)),
      GoldenSize.phone,
    );
    await typeDigits(tester, '280419');
    expect(box.seen.where((r) => r.url.path != '/api/surau/info'), isEmpty);
    expect(find.text('Kunci peranti tiada'), findsOneWidget);
    expect(find.text('Daftar semula'), findsOneWidget);
    expect(find.text('Perlukan bantuan?'), findsOneWidget);
  });

  testWidgets('box away: named by the surau, Cuba lagi, help card, pad live', (
    tester,
  ) async {
    final box = FakeBox((r) async => throw const BoxUnreachable());
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    await typeDigits(tester, '280419');
    expect(
      find.text('Tidak dapat menghubungi Surau D\'Waqaf'),
      findsOneWidget,
    );
    expect(find.text('Cuba lagi'), findsOneWidget);
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    expect(find.byType(PinKey), findsNWidgets(11));
    await tester.tap(find.text('Cuba lagi'));
    await tester.pumpAndSettle();
    expect(find.text('Perlukan bantuan?'), findsNothing);
  });

  testWidgets(
    'Lupa PIN? opens the help sheet with the technical details inside',
    (tester) async {
      final box = FakeBox(happyBox);
      await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
      await tester.tap(find.text('Lupa PIN?'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Pentadbir boleh tetapkan semula PIN anda'),
        findsOneWidget,
      );
      expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
      expect(find.text('https://127.0.0.1:8443'), findsNothing);
      await tester.tap(find.text('Butiran teknikal'));
      await tester.pumpAndSettle();
      expect(find.text('https://127.0.0.1:8443'), findsOneWidget);
      expect(
        find.text('abcd ef01 2345 6789\nabcd ef01 2345 6789'),
        findsOneWidget,
      );
      await tester.tap(find.text('WhatsApp'));
      expect(opener.opened.single.toString(), 'https://wa.me/60123456789');
      await tester.tap(find.text('Tutup'));
      await tester.pumpAndSettle();
      expect(find.text('Hubungi Encik Hafiz'), findsNothing);
    },
  );

  testWidgets('Bukan anda? asks first, then enrols again', (tester) async {
    var again = 0;
    await pumpAtSize(
      tester,
      screen(flowFor(FakeBox(happyBox)), onEnrolAgain: () => again++),
      GoldenSize.phone,
    );
    await tester.tap(find.text('Bukan anda? Daftar peranti ini semula'));
    await tester.pumpAndSettle();
    expect(find.text('Daftar peranti ini semula?'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await tester.pumpAndSettle();
    expect(again, 0);
    await tester.tap(find.text('Bukan anda? Daftar peranti ini semula'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Daftar semula'));
    await tester.pumpAndSettle();
    expect(again, 1);
  });

  testWidgets(
    'biometric button only with strong biometrics and a sealed PIN; it unlocks',
    (tester) async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      bio
        ..isAvailable = true
        ..sealed = '280419';
      SessionDto? got;
      await pumpAtSize(
        tester,
        screen(flow, onUnlocked: (s) => got = s),
        GoldenSize.phone,
      );
      expect(find.text('Guna cap jari'), findsOneWidget);
      await tester.tap(find.text('Guna cap jari'));
      await tester.pumpAndSettle();
      expect(got?.token, 'tok-1');
      expect(box.bodyOf('/api/auth/unlock')['pin'], '280419');
    },
  );

  testWidgets('a cancelled biometric prompt falls back to the pad', (
    tester,
  ) async {
    final box = FakeBox(happyBox);
    final flow = flowFor(box);
    bio
      ..isAvailable = true
      ..sealed = '280419'
      ..onOpen = () => null;
    await pumpAtSize(tester, screen(flow), GoldenSize.phone);
    await tester.tap(find.text('Guna cap jari'));
    await tester.pumpAndSettle();
    expect(find.text('Cap jari tidak dikenali. Masukkan PIN.'), findsOneWidget);
    expect(box.seen.where((r) => r.url.path != '/api/surau/info'), isEmpty);
    await typeDigits(tester, '280419');
    expect(box.bodyOf('/api/auth/unlock')['pin'], '280419');
  });

  testWidgets(
    'closing the fingerprint prompt says nothing; a lockout says so; a mismatch says not recognised',
    (tester) async {
      final box = FakeBox(happyBox);
      final flow = flowFor(box);
      bio
        ..isAvailable = true
        ..sealed = '280419'
        ..openThrows = const BiometricCancelled();
      await pumpAtSize(tester, screen(flow), GoldenSize.phone);
      await tester.tap(find.text('Guna cap jari'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Cap jari'), findsNothing);
      expect(find.text('Menunggu cap jari'), findsNothing);
      expect(
        find.text('Guna cap jari'),
        findsOneWidget,
        reason: 'the button stays',
      );

      bio.openThrows = const BiometricLockedOut();
      await tester.tap(find.text('Guna cap jari'));
      await tester.pumpAndSettle();
      expect(
        find.text('Cap jari dikunci sementara. Guna PIN.'),
        findsOneWidget,
      );

      bio
        ..openThrows = null
        ..onOpen = () => null;
      await tester.tap(find.text('Guna cap jari'));
      await tester.pumpAndSettle();
      expect(
        find.text('Cap jari tidak dikenali. Masukkan PIN.'),
        findsOneWidget,
      );
    },
  );

  testWidgets('a generic 500 shows the box message and Cuba lagi', (
    tester,
  ) async {
    final box = FakeBox((r) async {
      if (r.url.path != '/api/auth/unlock') return happyBox(r);
      return http.Response('oops', 500);
    });
    await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
    await typeDigits(tester, '280419');
    expect(find.text('Permintaan gagal'), findsOneWidget);
    expect(find.text('Cuba lagi'), findsOneWidget);
  });

  group('app lock off', () {
    Future<http.Response> Function(http.Request) lockOffBox(
      Future<http.Response> Function(http.Request) unlock,
    ) => (r) async {
      if (r.url.path == '/api/auth/challenge') {
        return jsonResponse(200, {
          'nonce': 'nonce-1',
          'expiresAt': 'x',
          'appLock': false,
        });
      }
      if (r.url.path == '/api/auth/unlock') return unlock(r);
      return happyBox(r);
    };

    testWidgets('opens by itself: no pad, no tap, the device proof only', (
      tester,
    ) async {
      final box = FakeBox(
        lockOffBox((r) async => jsonResponse(200, sessionJson)),
      );
      SessionDto? got;
      await pumpFrames(
        tester,
        screen(flowFor(box, appLock: false), onUnlocked: (s) => got = s),
        GoldenSize.phone,
      );
      expect(got?.token, 'tok-1');
      expect(container.read(sessionProvider)?.token, 'tok-1');
      expect(find.byType(PinKey), findsNothing);
      expect(box.bodyOf('/api/auth/unlock').keys.toSet(), {
        'deviceId',
        'nonce',
        'signature',
      });
    });

    testWidgets('a Pentadbir MAXCOM still gets the PIN pad: no automatic open even when the stored lock is off', (
      tester,
    ) async {
      final box = FakeBox(
        lockOffBox((r) async => jsonResponse(200, sessionJson)),
      );
      SessionDto? got;
      await pumpFrames(
        tester,
        screen(flowFor(box, appLock: false, withRoles: const ['admin', 'superadmin']), onUnlocked: (s) => got = s),
        GoldenSize.phone,
      );
      expect(got, isNull);
      expect(find.byType(PinKey), findsWidgets);
      expect(box.byPath('/api/auth/unlock'), isNull, reason: 'no unlock posted without a PIN');
    });

    testWidgets(
      'while the box answers: the surau, Membuka kunci and a spinner',
      (tester) async {
        final never = Completer<http.Response>();
        final box = FakeBox(lockOffBox((r) => never.future));
        await tester.binding.setSurfaceSize(const Size(412, 915));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(screen(flowFor(box, appLock: false)));
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.text('Membuka kunci'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('unlock-auto-spinner')),
          findsOneWidget,
        );
        expect(find.text('Surau D\'Waqaf'), findsOneWidget);
        expect(
          find.text('Bukan anda? Daftar peranti ini semula'),
          findsOneWidget,
        );
        expect(find.byType(PinKey), findsNothing);
        // Let the request end so no client timeout is left pending.
        never.complete(jsonResponse(200, sessionJson));
        await tester.pump();
      },
    );

    testWidgets(
      'the box away: MAXCOM tidak dapat dihubungi and Cuba lagi, which then opens',
      (tester) async {
        var up = false;
        final box = FakeBox((r) async {
          if (r.url.path == '/api/auth/challenge' && !up) {
            throw const BoxUnreachable();
          }
          return lockOffBox((r) async => jsonResponse(200, sessionJson))(r);
        });
        SessionDto? got;
        await pumpAtSize(
          tester,
          screen(flowFor(box, appLock: false), onUnlocked: (s) => got = s),
          GoldenSize.phone,
        );
        expect(find.text('MAXCOM tidak dapat dihubungi'), findsOneWidget);
        expect(got, isNull);
        up = true;
        await tester.tap(find.text('Cuba lagi'));
        for (var i = 0; i < 4; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(got?.token, 'tok-1');
      },
    );

    testWidgets(
      'pin_missing: the admin turned the lock on, so the pad appears',
      (tester) async {
        final box = FakeBox(
          lockOffBox(
            (r) async => jsonResponse(401, {
              'errors': ['PIN diperlukan'],
              'code': 'pin_missing',
            }),
          ),
        );
        await pumpAtSize(
          tester,
          screen(flowFor(box, appLock: false)),
          GoldenSize.phone,
        );
        expect(find.byType(PinKey), findsNWidgets(11));
        expect(find.text('PIN diperlukan'), findsOneWidget);
        expect(find.text('Membuka kunci'), findsNothing);
      },
    );

    testWidgets(
      '409: the new-PIN view with the hint that the admin turned the lock on',
      (tester) async {
        final box = FakeBox(
          lockOffBox(
            (r) async => jsonResponse(409, {
              'errors': ['PIN baharu diperlukan'],
              'code': 'pin_required',
              'pinRequired': true,
            }),
          ),
        );
        await pumpAtSize(
          tester,
          screen(flowFor(box, appLock: false)),
          GoldenSize.phone,
        );
        expect(find.text('Tetapkan PIN baharu'), findsOneWidget);
        expect(
          find.text(
            'Pentadbir telah menghidupkan kunci aplikasi. Pilih 6 digit baharu.',
          ),
          findsOneWidget,
        );
        expect(find.byType(PinKey), findsNWidgets(11));
      },
    );

    testWidgets('a revoked device is told so, with Daftar semula', (
      tester,
    ) async {
      final box = FakeBox(
        lockOffBox(
          (r) async => jsonResponse(401, {
            'errors': ['Peranti telah dibatalkan'],
            'code': 'device_revoked',
          }),
        ),
      );
      await pumpAtSize(
        tester,
        screen(flowFor(box, appLock: false)),
        GoldenSize.phone,
      );
      expect(find.text('Peranti telah dibatalkan'), findsOneWidget);
      expect(find.byType(PinKey), findsNothing);
    });

    testWidgets(
      'lock on (the default): the pad, nothing sent before six digits',
      (tester) async {
        final box = FakeBox(happyBox);
        await pumpAtSize(tester, screen(flowFor(box)), GoldenSize.phone);
        expect(find.byType(PinKey), findsNWidgets(11));
        expect(find.text('Membuka kunci'), findsNothing);
        expect(box.byPath('/api/auth/unlock'), isNull);
      },
    );
  });

  group('goldens', () {
    // The spinner is the state: frames are pumped by hand because an
    // indeterminate indicator never settles.
    testWidgets('unlock_auto', (tester) async {
      for (final size in GoldenSize.values) {
        final never = Completer<http.Response>();
        final box = FakeBox((r) async {
          if (r.url.path == '/api/auth/challenge') {
            return jsonResponse(200, {
              'nonce': 'nonce-1',
              'expiresAt': 'x',
              'appLock': false,
            });
          }
          if (r.url.path == '/api/auth/unlock') return never.future;
          return happyBox(r);
        });
        final w = screen(flowFor(box, appLock: false));
        tester.view.physicalSize = size.size * goldenPixelRatio;
        tester.view.devicePixelRatio = goldenPixelRatio;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(w);
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Membuka kunci'), findsOneWidget);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_auto_${size.name}.png'),
        );
        never.complete(jsonResponse(200, sessionJson));
        await tester.pump();
      }
    });

    testWidgets('unlock', (tester) async {
      for (final size in GoldenSize.values) {
        final flow = flowFor(FakeBox(happyBox));
        bio
          ..isAvailable = true
          ..sealed = '280419';
        final w = screen(flow);
        await pumpAtSize(tester, w, size);
        await typeDigits(tester, '28');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_logo', (tester) async {
      for (final size in GoldenSize.values) {
        final box = FakeBox((r) async {
          if (r.url.path == '/api/surau/info') {
            return jsonResponse(200, fixtureInfoWithLogoJson());
          }
          if (r.url.path == '/surau-logo') {
            return http.Response.bytes(
              fixtureLogoPng(),
              200,
              headers: {'content-type': 'image/png'},
            );
          }
          return happyBox(r);
        });
        final flow = flowFor(box);
        bio
          ..isAvailable = true
          ..sealed = '280419';
        final w = screen(flow);
        await pumpAtSize(tester, w, size);
        expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
        await settleImages(tester);
        await typeDigits(tester, '28');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_logo_${size.name}.png'),
        );
      }
    });

    // The wordmark with showName off: the door draws the logo wide by its
    // own shape and no text name under it.
    testWidgets('unlock_wide_logo', (tester) async {
      for (final size in GoldenSize.values) {
        final box = FakeBox((r) async {
          if (r.url.path == '/api/surau/info') {
            return jsonResponse(200, fixtureInfoWithLogoJson(showName: false));
          }
          if (r.url.path == '/surau-logo') {
            return http.Response.bytes(
              fixtureMaxcomRemovedPng(),
              200,
              headers: {'content-type': 'image/png'},
            );
          }
          return happyBox(r);
        });
        final flow = flowFor(box);
        bio
          ..isAvailable = true
          ..sealed = '280419';
        final w = screen(flow, cachedInfo: false);
        await pumpAtSize(tester, w, size);
        expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
        await settleImages(tester);
        expect(
          find.text('Surau D\'Waqaf'),
          findsNothing,
          reason: 'the logo is the name',
        );
        expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
        final logo = tester.getSize(find.byKey(const ValueKey('surau-logo')));
        expect(logo.height, 72);
        expect(logo.width, greaterThan(200), reason: 'wide, by height');
        await typeDigits(tester, '28');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_wide_logo_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_three_roles', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(
            FakeBox(happyBox),
            withRoles: ['admin', 'treasurer', 'media'],
          ),
        );
        await pumpAtSize(tester, w, size);
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_three_roles_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_new_pin', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(
            boxAnswering(
              409,
              'PIN baharu diperlukan',
              extra: {'pinRequired': true},
            ),
          ),
        );
        await pumpAtSize(tester, w, size);
        await typeDigits(tester, '280419');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_new_pin_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_locked', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(
            boxAnswering(
              423,
              'Akaun dikunci. Cuba lagi dalam 15 minit',
              headers: {'retry-after': '900'},
            ),
          ),
        );
        await pumpAtSize(tester, w, size);
        await typeDigits(tester, '280419');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_locked_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_unreachable', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(FakeBox((r) async => throw const BoxUnreachable())),
        );
        await pumpAtSize(tester, w, size);
        await typeDigits(tester, '280419');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_unreachable_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_revoked', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(
          flowFor(boxAnswering(401, 'Peranti telah dibatalkan')),
        );
        await pumpAtSize(tester, w, size);
        await typeDigits(tester, '280419');
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_revoked_${size.name}.png'),
        );
      }
    });

    testWidgets('unlock_forgot_pin', (tester) async {
      for (final size in GoldenSize.values) {
        final w = screen(flowFor(FakeBox(happyBox)));
        await pumpAtSize(tester, w, size);
        await tester.tap(find.text('Lupa PIN?'));
        await tester.pumpAndSettle();
        await expectLater(
          find.byWidget(w),
          matchesGoldenFile('unlock_forgot_pin_${size.name}.png'),
        );
      }
    });
  });
}
