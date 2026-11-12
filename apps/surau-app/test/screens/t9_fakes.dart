// Task 9 test aids: the box's answers for the preview, Islamic content
// and prayer data screens (the shared harness has none of these routes),
// and a pump that puts one screen inside the real shell chrome without the
// router (the routes are wired by the controller after this task lands).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/shell.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/main.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

export '../features/fakes.dart' show jsonResponse;

/// One prayer day as `GET /api/kiosk/bundle` carries it (asar at 16:20).
Map<String, Object?> t9Day(String date, {int hijriDay = 22}) => {
  'date': date,
  'hijri': {'y': 1448, 'm': 5, 'd': hijriDay},
  'times': {
    'imsak': '05:50',
    'subuh': '06:00',
    'syuruk': '07:10',
    'zohor': '13:10',
    'asar': '16:20',
    'maghrib': '19:10',
    'isyak': '20:20',
  },
};

/// Registry defaults for the features that shape the kiosk's phases, as
/// `GET /api/settings` and the bundle carry them.
Map<String, Object?> t9PhaseSettings({bool jumaat = true}) => {
  'zone': {'enabled': true, 'zone': 'SGR01'},
  'azanCountdown': {
    'enabled': true,
    'beep': true,
    'minutesBefore': {'subuh': 10, 'zohor': 10, 'asar': 10, 'maghrib': 10, 'isyak': 10},
  },
  'masukWaktu': {'enabled': true, 'screenSeconds': 60, 'beep': true},
  'iqamahCountdown': {
    'enabled': true,
    'beep': true,
    'endWarningSeconds': 30,
    'minutes': {
      for (final d in ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu'])
        d: {'subuh': 10, 'zohor': 10, 'asar': 10, 'maghrib': 10, 'isyak': 10},
    },
  },
  'solatScreen': {
    'enabled': true,
    'minutes': {
      for (final d in ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu'])
        d: {'subuh': 15, 'zohor': 15, 'asar': 15, 'maghrib': 15, 'isyak': 15},
    },
  },
  'jumaat': {'enabled': jumaat, 'khutbahMinutes': 20, 'iqamahMinutes': 7, 'solatMinutes': 15},
};

/// `GET /api/kiosk/bundle` on Tuesday 2026-11-03 at 15:52 Malaysian time
/// (the kiosk tests' clock): a week of days around it, Friday included.
Map<String, Object?> t9Bundle({Map<String, Object?>? settings, List<Object?>? days}) => {
  'version': 17,
  'zone': 'SGR01',
  'days': days ??
      [
        for (var d = 2; d <= 8; d++) t9Day('2026-11-0$d', hijriDay: 20 + d),
      ],
  'settings': settings ?? t9PhaseSettings(),
  'serverTime': '2026-11-03T07:52:00.000Z',
};

/// `GET /api/islamic/status`: the text present or not, two surah cached
/// for the default reciter, 48 MB of a 500 MB cache used.
Map<String, Object?> t9IslamicStatus({
  bool present = true,
  List<int> surahs = const [1, 36],
  int bytes = 48 * 1024 * 1024,
}) => {
  'quran': present
      ? {'present': true, 'version': 'quranenc-2024', 'fetchedAt': '2026-10-01T02:00:00.000Z', 'ayatCount': 6236}
      : {'present': false},
  'audio': {'reciter': 'Alafasy_128kbps', 'surahs': surahs, 'bytes': bytes, 'cacheMaxMb': 500},
};

/// `GET /api/settings` with the zone the prayer data screen needs.
Map<String, Object?> t9Settings() => {...settingsJson(), ...t9PhaseSettings()};

/// Installs the Task 9 routes on [h] with happy defaults; a test overrides
/// any of them afterwards through `h.handlers`.
void installT9Routes(ShellHarness h) {
  h.handlers['GET /api/settings'] = (_) async => jsonResponse(200, t9Settings());
  h.handlers['GET /api/kiosk/bundle'] = (_) async => jsonResponse(200, t9Bundle());
  h.handlers['GET /api/islamic/status'] = (_) async => jsonResponse(200, t9IslamicStatus());
  h.handlers['GET /api/prayer/status'] = (_) async => jsonResponse(200, {
    'country': 'MY',
    'hasOfficial': true,
    'zone': 'SGR01',
    'timezone': 'Asia/Kuala_Lumpur',
    'located': true,
    'order': ['official', 'calc', 'file'],
    'today': {'date': '2026-11-04', 'source': 'official', 'emergency': false},
    'official': {
      'zone': 'SGR01',
      'years': [
        {'year': 2026, 'days': 365, 'fetchedAt': '2026-01-02T01:00:00.000Z'},
      ],
    },
    'warnings': <String>[],
  });
  h.handlers['GET /api/prayer/days'] = (_) async => jsonResponse(200, {
    'days': [
      for (var d = 2; d <= 8; d++) {...t9Day('2026-11-0$d'), 'source': 'official', 'corrected': <String>[], 'emergency': false},
    ],
    'crossCheck': {'flagged': <Object>[], 'maxDiff': <String, int>{}, 'medianDiff': <String, int>{}, 'compared': 0},
    'sources': {'order': ['official', 'calc', 'file'], 'country': 'MY', 'hasOfficial': true, 'zone': 'SGR01', 'located': true},
  });
}

class T9App {
  T9App(this.h, this.app);

  final ShellHarness h;

  /// One instance, so goldens can find it by identity across sizes.
  final Widget app;
}

/// Builds [screen] inside the shell chrome (rail or bar by width), unlocked
/// with [roles], over a harness with the Task 9 routes installed, and pumps
/// it at [size].
Future<T9App> pumpT9(
  WidgetTester tester,
  Widget screen, {
  required String location,
  List<String> roles = const ['admin'],
  void Function(ShellHarness h)? setup,
  GoldenSize size = GoldenSize.phone,
}) async {
  final h = ShellHarness(roles: roles);
  installT9Routes(h);
  setup?.call(h);
  h.unlock();
  final app = UncontrolledProviderScope(
    container: h.container,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: SurauTheme.light(),
      locale: defaultLocale,
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      home: AppShell(location: location, child: screen),
    ),
  );
  await pumpAtSize(tester, app, size);
  await settle(tester);
  return T9App(h, app);
}
