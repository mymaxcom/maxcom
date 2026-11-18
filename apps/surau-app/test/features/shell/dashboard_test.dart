// The shell and the home screen (operator round 1): the surau and the
// person lead, the menu is the union of the roles, "Perlu perhatian" only
// when something needs doing, no "Tugas biasa", the status board folded
// under "Butiran sistem" (folded every time), two columns on an iPad,
// warnings are gold, the person's sheet reaches help and the device page,
// a refused page sends the person home with the notice; the certificate
// is never mentioned unless its automatic renewal is failing close to
// expiry (admin only). Goldens: dashboard, dashboard_three_roles,
// dashboard_offline, dashboard_tech_check, dashboard_en, dashboard_ar,
// dashboard_system_open, menu, forbidden.

import 'dart:io';

import 'package:flutter/material.dart'
    show BackButton, Icons, RichText, Size, Text, ValueKey;
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/shell.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;

import '../../golden_sizes.dart';
import '../fakes.dart' show jsonResponse;
import 'harness.dart';

/// Opens "Butiran sistem" (folded whenever the dashboard is built).
Future<void> openSystem(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('dash-system-toggle')));
  await settle(tester);
}

void main() {
  testWidgets('one role: surau, greeting, role, health rows, three entries', (
    tester,
  ) async {
    final h = await pumpShell(tester, roles: const ['ajk']);
    expect(find.text('Surau D\'Waqaf'), findsOneWidget);
    expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
    expect(find.text('AJK'), findsOneWidget);
    expect(
      find.textContaining('127.0.0.1'),
      findsNothing,
      reason: 'never an address',
    );
    expect(
      find.textContaining('Kotak'),
      findsNothing,
      reason: 'the box is MAXCOM',
    );

    expect(find.text('Tugas biasa'), findsNothing, reason: 'removed by the operator');
    expect(find.text('Perlu perhatian'), findsNothing, reason: 'all is well');
    expect(find.text('Butiran sistem'), findsOneWidget);
    expect(find.text('Dihubungi 10:30 malam'), findsOneWidget, reason: 'under the fold title');
    expect(find.text('Data waktu solat'), findsNothing, reason: 'folded');
    expect(find.text('Lihat skrin TV'), findsOneWidget);
    expect(find.text('Di skrin TV sekarang'), findsOneWidget);
    await expectGoldens(tester, h.app, 'dashboard');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await openSystem(tester);
    expect(find.text('Keadaan MAXCOM'), findsOneWidget);
    expect(find.text('Melalui MAXCOM di surau'), findsOneWidget);
    expect(find.text('Data waktu solat'), findsOneWidget);
    expect(find.text('212 hari lagi'), findsOneWidget);
    // Certificate renewal is automatic: no row, no countdown, no word
    // "sijil" on a normal screen (operator 2026-11-04).
    expect(find.textContaining('Sijil'), findsNothing);
    expect(find.textContaining('sijil'), findsNothing);
    expect(find.text('364 hari lagi'), findsNothing);
    expect(find.text('Pengguna dikunci'), findsOneWidget);
    expect(find.text('Versi data'), findsNothing, reason: 'admin only');
    expect(find.text('17'), findsNothing);
    expect(find.text('Versi aplikasi'), findsOneWidget);
    expect(
      find.text('Muat naik data waktu solat tahun baharu sebelum habis.'),
      findsNothing,
    );
    expect(find.textContaining('semakan teknikal'), findsNothing);
    expect(
      h.box.byPath('/api/pki/status'),
      isNull,
      reason: 'an AJK never asks',
    );

    for (final label in ['Papan pemuka', 'Kandungan', 'Konfigurasi']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    for (final label in [
      'Pengguna & peranti',
      'Log perubahan',
      'Lagi',
      'Kewangan',
    ]) {
      expect(find.text(label), findsNothing, reason: label);
    }
    expect(h.location, '/');
  });

  testWidgets(
    'with a logo: beside the surau name in the header, in the rail on the iPad; without one nothing is drawn',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['ajk'], logo: true);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('surau-logo')),
        findsOneWidget,
        reason: 'the phone header',
      );
      expect(h.box.byPath('/surau-logo'), isNotNull);
      expect(
        h.box.byPath('/surau-logo')!.headers.containsKey('authorization'),
        isFalse,
        reason: 'public route',
      );
      await settleImages(tester);
      await expectGoldens(tester, h.app, 'dashboard_logo');

      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      expect(
        find.byKey(const ValueKey('surau-logo')),
        findsNWidgets(2),
        reason: 'rail and header',
      );
      expect(
        h.box.seen.where((r) => r.url.path == '/surau-logo').length,
        1,
        reason: 'fetched once per logo',
      );

      final plain = await pumpShell(tester, roles: const ['ajk']);
      expect(find.byKey(const ValueKey('surau-logo')), findsNothing);
      expect(
        plain.box.byPath('/surau-logo'),
        isNull,
        reason: 'no logo named: nothing asked',
      );
    },
  );

  testWidgets(
    'a wide wordmark with showName off: the header and the rail draw the logo by height in its own shape, no text name',
    (tester) async {
      final h = await pumpShell(
        tester,
        roles: const ['ajk'],
        wideLogo: true,
        showName: false,
      );
      await settleImages(tester);
      expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
      expect(
        find.text('Surau D\'Waqaf'),
        findsNothing,
        reason: 'the logo carries the name',
      );
      expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
      final logo = tester.getSize(find.byKey(const ValueKey('surau-logo')));
      expect(logo.height, 48);
      // Dark ink on transparency sits on a light card: 10 % padding on every side, the outer height unchanged.
      expect(
        logo.width / logo.height,
        closeTo((0.8 * 465 / 119) + 0.2, 0.1),
        reason: 'natural aspect plus the card padding, sized by height',
      );
      await expectGoldens(tester, h.app, 'dashboard_wide_logo');

      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      expect(
        find.byKey(const ValueKey('surau-logo')),
        findsNWidgets(2),
        reason: 'rail and header',
      );
      expect(find.text('Surau D\'Waqaf'), findsNothing);

      // The same wordmark with the name wanted too: both are drawn.
      final both = await pumpShell(
        tester,
        roles: const ['ajk'],
        wideLogo: true,
      );
      await settleImages(tester);
      expect(find.byKey(const ValueKey('surau-logo')), findsOneWidget);
      expect(find.text('Surau D\'Waqaf'), findsOneWidget);
      expect(both.box.byPath('/surau-logo'), isNotNull);
    },
  );

  testWidgets(
    'three roles: the union in the header and the menu, Lagi on a phone',
    (tester) async {
      final h = await pumpShell(
        tester,
        roles: const ['admin', 'treasurer', 'media'],
        features: const {'finance': true},
      );
      expect(find.text('Pentadbir, Bendahari dan Media'), findsOneWidget);
      for (final label in ['Papan pemuka', 'Kewangan', 'Kandungan', 'Lagi']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(
        find.text('Konfigurasi'),
        findsNothing,
        reason: 'behind Lagi on a phone',
      );

      await expectGoldens(tester, h.app, 'dashboard_three_roles');

      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await openSystem(tester);
      expect(
        find.text('Versi data'),
        findsOneWidget,
        reason: 'the admin sees it',
      );
      expect(find.text('17'), findsOneWidget);
      await expectGoldens(tester, h.app, 'dashboard_system_open', sizes: const [GoldenSize.phone]);

      // On the iPad the rail shows every entry.
      await pumpAtSize(tester, h.app, GoldenSize.ipadMiniLandscape);
      for (final label in [
        'Papan pemuka',
        'Kandungan',
        'Konfigurasi',
        'Pengguna & peranti',
        'Log perubahan',
        'Siaran langsung',
        'Kewangan',
      ]) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.text('Lagi'), findsNothing);
      expect(find.text('Jemaah'), findsNothing, reason: 'jemaahPage off');
    },
  );

  testWidgets('offline: the banner says when the data was last fresh', (
    tester,
  ) async {
    final h = await pumpShell(
      tester,
      roles: const ['admin', 'treasurer', 'media'],
      features: const {'finance': true},
    );
    h.boxAway = true;
    await h.container.read(healthProvider.notifier).refresh();
    await settle(tester);
    expect(
      find.text(
        'MAXCOM tidak dapat dihubungi. Menunjukkan data terakhir (10:30 malam).',
      ),
      findsOneWidget,
    );
    expect(find.text('Tidak dapat dihubungi'), findsOneWidget);
    expect(find.bySemanticsLabel('MAXCOM di surau: tidak dapat dihubungi'), findsOneWidget);
    await expectGoldens(tester, h.app, 'dashboard_offline');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await openSystem(tester);
    expect(
      find.text('212 hari lagi'),
      findsOneWidget,
      reason: 'last data still shown',
    );
  });

  testWidgets(
    'prayer data under 30 days is flagged in gold with a BM hint; a short certificate is not',
    (tester) async {
      final h = await pumpShell(
        tester,
        roles: const ['admin'],
        health: {
          ...healthyJson,
          'daysAhead': 12,
          'tls': {
            'mode': 'self',
            'notAfter': 'x',
            'daysLeft': 9,
            'ipSan': <String>[],
          },
          'lockedUsers': 2,
        },
      );
      expect(find.text('Perlu perhatian'), findsOneWidget);
      expect(find.text('Data waktu solat tinggal 12 hari'), findsOneWidget);
      expect(
        find.text('Muat naik data waktu solat tahun baharu sebelum habis.'),
        findsOneWidget,
      );
      expect(find.text('2 pengguna dikunci'), findsOneWidget);
      expect(
        find.textContaining('Import'),
        findsNothing,
        reason: 'BM Malaysia wording',
      );
      expect(
        find.text('9 hari lagi'),
        findsNothing,
        reason: 'no certificate countdown',
      );
      expect(find.textContaining('ijil'), findsNothing);
      await openSystem(tester);
      expect(find.text('12 hari lagi'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      // The admin's app did ask the box; the 404 of a box without the route
      // (or any other error) reads as nothing to say.
      expect(h.box.byPath('/api/pki/status'), isNotNull);
      expect(find.textContaining('semakan teknikal'), findsNothing);
    },
  );

  testWidgets('no prayer data at all says so, not "before it runs out"', (
    tester,
  ) async {
    await pumpShell(
      tester,
      roles: const ['admin'],
      health: {...healthyJson, 'daysAhead': 0},
    );
    expect(
      find.text(
        'Belum ada data waktu solat. Muat turun atau muat naik sekarang.',
      ),
      findsOneWidget,
    );
    expect(
      find.text('Muat naik data waktu solat tahun baharu sebelum habis.'),
      findsNothing,
    );
  });

  group('prayer data warning with automatic fetch', () {
    const hint = 'Muat naik data waktu solat tahun baharu sebelum habis.';

    Future<void> pumpWith(
      WidgetTester tester,
      int days,
      Object? autoFetch,
    ) async {
      await pumpShell(
        tester,
        roles: const ['admin'],
        health: {...healthyJson, 'daysAhead': days, 'autoFetch': ?autoFetch},
      );
    }

    testWidgets('on and healthy: 20 days left is not flagged', (tester) async {
      await pumpWith(tester, 20, {
        'enabled': true,
        'lastAttemptAt': null,
        'lastOk': null,
      });
      expect(find.text(hint), findsNothing);
      expect(find.text('Perlu perhatian'), findsNothing);
      await openSystem(tester);
      expect(find.text('20 hari lagi'), findsOneWidget);
    });

    testWidgets('on and healthy: under 14 days is flagged', (tester) async {
      await pumpWith(tester, 13, {
        'enabled': true,
        'lastAttemptAt': 'x',
        'lastOk': true,
      });
      expect(find.text(hint), findsOneWidget);
    });

    testWidgets(
      'on but the last attempt failed: the old 30 day limit applies',
      (tester) async {
        await pumpWith(tester, 20, {
          'enabled': true,
          'lastAttemptAt': 'x',
          'lastOk': false,
          'lastError': 'gagal',
        });
        expect(find.text(hint), findsOneWidget);
      },
    );

    testWidgets('off: the old 30 day limit applies', (tester) async {
      await pumpWith(tester, 20, {
        'enabled': false,
        'lastAttemptAt': null,
        'lastOk': null,
      });
      expect(find.text(hint), findsOneWidget);
    });

    testWidgets('no autoFetch in the answer: the old 30 day limit applies', (
      tester,
    ) async {
      await pumpWith(tester, 20, null);
      expect(find.text(hint), findsOneWidget);
    });
  });

  testWidgets('the admin sees the app lock state from health; others and unknown do not', (tester) async {
    await pumpShell(
      tester,
      roles: const ['admin'],
      health: {...healthyJson, 'appLock': false},
    );
    await openSystem(tester);
    expect(find.byKey(const ValueKey('status-app-lock')), findsOneWidget);
    expect(find.text('Kunci aplikasi'), findsOneWidget);
    expect(find.text('Dimatikan'), findsOneWidget);
  });

  testWidgets('[A11] a Pentadbir MAXCOM sees the data-version and app-lock rows', (tester) async {
    await pumpShell(
      tester,
      roles: const ['superadmin'],
      health: {...healthyJson, 'appLock': true},
    );
    await openSystem(tester);
    expect(find.text('Versi data'), findsOneWidget);
    expect(find.byKey(const ValueKey('status-app-lock')), findsOneWidget);
  });

  test('[A11] the dashboard asks by permission, never by the name of a role', () {
    final src = File('lib/features/shell/dashboard_screen.dart').readAsStringSync();
    expect(src.contains("roles.contains('admin')"), isFalse);
  });

  testWidgets('no app lock row when health does not say', (tester) async {
    await pumpShell(tester, roles: const ['admin']);
    await openSystem(tester);
    expect(find.byKey(const ValueKey('status-app-lock')), findsNothing);
  });

  testWidgets('an anonymous health answer reads honestly', (tester) async {
    await pumpShell(
      tester,
      roles: const ['admin'],
      health: {'ok': true, 'version': 3},
    );
    await openSystem(tester);
    expect(find.text('Belum diketahui'), findsNWidgets(2));
    expect(find.textContaining('ijil'), findsNothing);
    expect(find.text('Versi data'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
  });

  group('technical check (failure only)', () {
    const line =
        'MAXCOM perlukan semakan teknikal. Hubungi Encik Hafiz, 012-345 6789.';

    /// The sentence as one rich text (the phone is an inline widget).
    Finder lineFinder() => find.byWidgetPredicate(
      (w) =>
          w is RichText &&
          w.text.toPlainText(includePlaceholders: false) ==
              line.replaceFirst('012-345 6789', ''),
    );

    Future<ShellHarness> pumpWithPki(
      WidgetTester tester, {
      List<String> roles = const ['admin'],
      required Object answer,
      int status = 200,
      GoldenSize size = GoldenSize.phone,
    }) async {
      final h = ShellHarness(roles: roles);
      h.handlers['GET /api/pki/status'] = (_) async =>
          jsonResponse(status, answer);
      h.unlock();
      await pumpAtSize(tester, h.app, size);
      await settle(tester);
      return h;
    }

    Map<String, Object?> pki({int? days, bool? ok, String? attempt}) => {
      'leafNotAfter': '2026-11-13T00:00:00.000Z',
      'leafDaysLeft': days,
      'rootNotAfter': '2046-11-01T00:00:00.000Z',
      'lastRenewOk': ?ok,
      'lastRenewAttempt': ?attempt,
    };

    testWidgets(
      'under 14 days with a failed renewal: one calm line, figures behind Butiran teknikal',
      (tester) async {
        final h = await pumpWithPki(
          tester,
          answer: pki(days: 9, ok: false, attempt: '2026-11-03T18:00:00.000Z'),
        );
        expect(lineFinder(), findsOneWidget);
        expect(find.text('Butiran teknikal'), findsOneWidget);
        expect(find.textContaining('ijil'), findsNothing, reason: 'folded');
        expect(
          find.text('Butiran sistem'),
          findsOneWidget,
          reason: 'the board stays',
        );

        await expectGoldens(tester, h.app, 'dashboard_tech_check');

        await pumpAtSize(tester, h.app, GoldenSize.phone);
        await tester.tap(find.text('Butiran teknikal'));
        await settle(tester);
        expect(find.text('Sijil MAXCOM tamat dalam'), findsOneWidget);
        expect(find.text('9 hari lagi'), findsOneWidget);
        expect(find.text('Pembaharuan automatik terakhir'), findsOneWidget);
        expect(find.text('Gagal 2:00 pagi'), findsOneWidget);
      },
    );

    testWidgets(
      'the phone number never breaks across lines, even on a narrow card',
      (tester) async {
        await pumpWithPki(
          tester,
          answer: pki(days: 9, ok: false, attempt: '2026-11-03T18:00:00.000Z'),
        );
        final phone = find.text('012-345 6789');
        expect(phone, findsOneWidget);
        final style = tester.widget<Text>(phone).style!;
        expect(tester.widget<Text>(phone).softWrap, isFalse);
        expect(
          tester.getSize(phone).height,
          lessThan(style.fontSize! * (style.height ?? 1.5) * 1.6),
          reason: 'one line high',
        );
      },
    );

    testWidgets(
      'under 14 days with no renewal attempt yet: the line, Belum pernah berjaya',
      (tester) async {
        await pumpWithPki(tester, answer: pki(days: 5));
        expect(lineFinder(), findsOneWidget);
        await tester.tap(find.text('Butiran teknikal'));
        await settle(tester);
        expect(find.text('Belum pernah berjaya'), findsOneWidget);
      },
    );

    testWidgets('renewal working: nothing, however few days are left', (
      tester,
    ) async {
      await pumpWithPki(
        tester,
        answer: pki(days: 3, ok: true, attempt: '2026-11-04T02:00:00.000Z'),
      );
      expect(find.textContaining('semakan teknikal'), findsNothing);
      expect(find.text('Butiran teknikal'), findsNothing);
    });

    testWidgets('14 days or more: nothing, even with a failed attempt', (
      tester,
    ) async {
      await pumpWithPki(
        tester,
        answer: pki(days: 14, ok: false, attempt: '2026-11-04T02:00:00.000Z'),
      );
      expect(find.textContaining('semakan teknikal'), findsNothing);
    });

    testWidgets('a read error shows nothing: never alarm on a hiccup', (
      tester,
    ) async {
      await pumpWithPki(
        tester,
        answer: {
          'errors': ['ralat'],
        },
        status: 500,
      );
      expect(find.textContaining('semakan teknikal'), findsNothing);
      await pumpWithPki(tester, answer: 'not an object');
      expect(find.textContaining('semakan teknikal'), findsNothing);
    });

    testWidgets('only Pentadbir asks: a treasurer never calls the route', (
      tester,
    ) async {
      final h = await pumpWithPki(
        tester,
        roles: const ['treasurer', 'media'],
        answer: pki(days: 2, ok: false, attempt: '2026-11-04T02:00:00.000Z'),
      );
      expect(h.box.byPath('/api/pki/status'), isNull);
      expect(find.textContaining('semakan teknikal'), findsNothing);
    });
  });

  testWidgets('the menu sheet: this device, help with the contact, lock', (
    tester,
  ) async {
    final h = await pumpShell(
      tester,
      roles: const ['admin', 'treasurer', 'media'],
      features: const {'finance': true},
    );
    for (final size in GoldenSize.values) {
      await pumpAtSize(tester, h.app, size);
      final wide = size.width >= AppShell.wideBreakpoint;
      await tester.tap(wide ? find.text('UA') : find.text('Lagi'));
      await settle(tester);
      expect(find.text('Peranti ini'), findsOneWidget);
      expect(find.text('Perlukan bantuan?'), findsOneWidget);
      expect(find.text('Log keluar'), findsOneWidget);
      expect(
        find.text('Pentadbir, Bendahari dan Media'),
        findsNWidgets(wide && size.width >= 1000 ? 3 : 2),
      );
      if (!wide) {
        for (final label in [
          'Konfigurasi',
          'Pengguna & peranti',
          'Log perubahan',
          'Siaran langsung',
        ]) {
          expect(find.text(label), findsOneWidget, reason: label);
        }
      }
      await expectLater(
        find.byWidget(h.app),
        matchesGoldenFile('menu_${size.name}.png'),
        reason: 'golden menu at ${size.name}',
      );
      // Close the sheet before the next size.
      await tester.tapAt(const Offset(5, 5));
      await settle(tester);
    }

    // Help from the sheet: the contact with call buttons and the technical
    // details behind their fold.
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.text('Lagi'));
    await settle(tester);
    await tester.tap(find.text('Perlukan bantuan?'));
    await settle(tester);
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    expect(find.text('Telefon'), findsOneWidget);
    expect(find.text('Butiran teknikal'), findsOneWidget);
    expect(find.textContaining('127.0.0.1'), findsNothing, reason: 'folded');
    await tester.tap(find.text('WhatsApp'));
    expect(h.opener.opened.single.toString(), contains('wa.me'));

    // Overflow entries open their page.
    await tester.tapAt(const Offset(5, 5));
    await settle(tester);
    await tester.tap(find.text('Lagi'));
    await settle(tester);
    await tester.tap(find.text('Log perubahan'));
    await settle(tester);
    expect(h.location, '/audit');
  });

  testWidgets(
    'a page outside the roles sends the person home with the notice',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['ajk']);
      h.router.go('/users');
      await settle(tester);
      expect(h.location, '/');
      expect(find.text('Tiada kebenaran untuk tindakan ini'), findsOneWidget);
      await expectGoldens(tester, h.app, 'forbidden');

      // A page within the roles opens, with its own title and the way back
      // (the clock's settings page since Task 7; its parent is the list).
      h.router.go('/settings/clock');
      await settle(tester);
      expect(h.location, '/settings/clock');
      expect(find.text('Jam'), findsWidgets);
      expect(find.text('Sentiasa hidup'), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await settle(tester);
      expect(h.location, '/settings');
    },
  );

  testWidgets(
    'the Data waktu solat row opens the import page for an admin and is plain for an AJK',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      await openSystem(tester);
      final row = find.byKey(const ValueKey('status-prayer-data'));
      expect(
        find.descendant(
          of: row,
          matching: find.byIcon(Icons.chevron_right_rounded),
        ),
        findsOneWidget,
      );
      expect(tester.getRect(row).height, greaterThanOrEqualTo(48));
      await tester.tap(row);
      await settle(tester);
      expect(h.location, '/prayer-data');

      final ajk = await pumpShell(tester, roles: const ['ajk']);
      await openSystem(tester);
      final plain = find.byKey(const ValueKey('status-prayer-data'));
      expect(
        find.descendant(
          of: plain,
          matching: find.byIcon(Icons.chevron_right_rounded),
        ),
        findsNothing,
      );
      await tester.tap(plain);
      await settle(tester);
      expect(ajk.location, '/');
    },
  );

  testWidgets('Lihat skrin TV and the bar navigate', (tester) async {
    final h = await pumpShell(tester, roles: const ['live']);
    await tester.tap(find.text('Lihat skrin TV'));
    await settle(tester);
    expect(h.location, '/preview');
    expect(find.text('Pratonton'), findsOneWidget);
    await tester.tap(find.text('Siaran langsung'));
    await settle(tester);
    expect(h.location, '/live');
    await tester.tap(find.text('Papan pemuka'));
    await settle(tester);
    expect(h.location, '/');
  });

  testWidgets('Butiran sistem: folded, opens to the old board, folded again next time', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin']);
    expect(find.byKey(const ValueKey('status-prayer-data')), findsNothing);
    await openSystem(tester);
    for (final label in ['Keadaan MAXCOM', 'Data waktu solat', 'Pengguna dikunci', 'Versi data']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    // Away and back: built again, folded again.
    h.router.go('/settings');
    await settle(tester);
    h.router.go('/');
    await settle(tester);
    expect(find.byKey(const ValueKey('status-prayer-data')), findsNothing);
    // A new start of the app: folded too (nothing remembered).
    await pumpShell(tester, roles: const ['admin']);
    expect(find.byKey(const ValueKey('status-prayer-data')), findsNothing);
    expect(find.text('Butiran sistem'), findsOneWidget);
  });

  testWidgets('locked people need attention only for whoever can unlock them', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], health: {...healthyJson, 'lockedUsers': 1});
    expect(find.text('1 pengguna dikunci'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('attention-locked')));
    await settle(tester);
    expect(h.location, '/users');

    await pumpShell(tester, roles: const ['ajk'], health: {...healthyJson, 'lockedUsers': 1});
    expect(find.text('Perlu perhatian'), findsNothing);
  });

  testWidgets('an iPad at 1024 x 768: two columns side by side', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], health: {...healthyJson, 'daysAhead': 12});
    tester.view.physicalSize = const Size(1024, 768) * 2;
    tester.view.devicePixelRatio = 2;
    await tester.pumpWidget(h.app);
    await settle(tester);
    final start = tester.getRect(find.byKey(const ValueKey('dash-col-start')));
    final end = tester.getRect(find.byKey(const ValueKey('dash-col-end')));
    expect(end.left, greaterThan(start.right), reason: 'beside, not under');
    expect((end.top - start.top).abs(), lessThan(1));
    expect(find.descendant(of: find.byKey(const ValueKey('dash-col-start')), matching: find.text('Perlu perhatian')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('dash-col-end')), matching: find.text('Butiran sistem')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('English and Arabic', (tester) async {
    for (final lang in [AppLang.en, AppLang.ar]) {
      final h = await pumpShell(
        tester,
        roles: const ['admin', 'treasurer', 'media'],
        features: const {'finance': true},
        health: {...healthyJson, 'daysAhead': 12, 'lockedUsers': 1},
        overrides: [
          livePublisherProvider.overrideWithValue(FakePublisher()),
          appLangStoreProvider.overrideWithValue(MemoryAppLangStore(lang)),
        ],
      );
      expect(find.text(lang == AppLang.en ? 'System details' : 'تفاصيل النظام'), findsOneWidget);
      await expectGoldens(tester, h.app, 'dashboard_${lang.code}', sizes: const [GoldenSize.phone]);
    }
  });

  testWidgets('not enrolled: the app opens on enrolment', (tester) async {
    final h = ShellHarness(roles: const ['ajk']);
    await h.container.read(enrolledBoxProvider.notifier).forget();
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    expect(h.location, '/enrol');
    expect(find.text('Daftar peranti ini'), findsOneWidget);
  });

  testWidgets('enrolled but locked: the app opens on unlock', (tester) async {
    final h = await pumpShell(tester, roles: const ['ajk'], unlocked: false);
    expect(h.location, '/unlock');
    expect(find.text('Assalamualaikum, Ustaz Ali'), findsOneWidget);
  });
}
