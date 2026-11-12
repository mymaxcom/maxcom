// Test aids for the prayer-source screens (Plan 13 Tasks 8 and 9): a fake
// PrayerRepository with realistic answers and a pump that puts one screen
// inside the shell chrome. Settings still go through the harness's box.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/shell.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/prayer/location_screen.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/main.dart';

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

export '../features/fakes.dart' show jsonResponse;

const List<CountryInfo> fakeCountries = [
  CountryInfo(code: 'ID', name: 'Indonesia', timezones: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'], method: 'kemenag', madhab: 'shafi'),
  CountryInfo(code: 'KE', name: 'Kenya', timezones: ['Africa/Nairobi'], method: 'mwl', madhab: 'shafi'),
  CountryInfo(code: 'MY', name: 'Malaysia', timezones: ['Asia/Kuala_Lumpur', 'Asia/Kuching'], method: 'jakim', madhab: 'shafi', hasOfficial: true),
];

const List<ZoneInfo> fakeZones = [
  ZoneInfo(code: 'JHR02', name: 'Johor Bahru, Kota Tinggi, Mersing, Kulai', state: 'Johor', lat: 1.6, lon: 103.8),
  ZoneInfo(code: 'SGR01', name: 'Gombak, Petaling, Sepang, Hulu Langat, Hulu Selangor, S.Alam', state: 'Selangor', lat: 3.2, lon: 101.6, years: [2026, 2027]),
  ZoneInfo(code: 'SGR02', name: 'Kuala Selangor, Sabak Bernam', state: 'Selangor', lat: 3.5, lon: 101.1),
  ZoneInfo(code: 'WLY01', name: 'Kuala Lumpur, Putrajaya', state: 'Wilayah Persekutuan', lat: 3.15, lon: 101.7),
];

const Map<String, String> fakeJakimTimes = {
  'imsak': '05:44',
  'subuh': '05:54',
  'syuruk': '07:06',
  'zohor': '13:06',
  'asar': '16:24',
  'maghrib': '19:04',
  'isyak': '20:17',
};

const Map<String, String> fakeCalcTimes = {
  'imsak': '05:41',
  'subuh': '05:51',
  'syuruk': '07:06',
  'zohor': '13:05',
  'asar': '16:24',
  'maghrib': '19:03',
  'isyak': '20:17',
};

ResolvedDay fakeDay(
  String date, {
  String source = 'official',
  Map<String, String> times = fakeJakimTimes,
  List<String> corrected = const [],
  List<String> officialChanged = const [],
  List<String> correctionIgnored = const [],
  bool emergency = false,
}) => ResolvedDay(
  date: date,
  times: times,
  source: source,
  corrected: corrected,
  officialChanged: officialChanged,
  correctionIgnored: correctionIgnored,
  emergency: emergency,
  hijri: const HijriDate(1448, 5, 24),
);

/// `today` of the harness clock (2026-11-04 22:30 in Malaysia).
const String fakeToday = '2026-11-04';

/// Plays the box's prayer routes. A test sets the fields it cares about and
/// reads the calls back.
class FakePrayerRepo implements PrayerRepository {
  FakePrayerRepo({this.status_ = const PrayerStatus(country: 'MY', hasOfficial: true, zone: 'SGR01', located: true)});

  PrayerStatus status_;
  List<CountryInfo> countriesList = fakeCountries;
  ZoneList zoneList = ZoneList(zones: fakeZones, fetchedAt: '2026-11-04T01:14:00.000Z');
  ZoneRefreshResult refreshResult = const ZoneRefreshResult(count: 60);
  Object? refreshError;
  LocationSearch searchResult = const LocationSearch(results: []);
  Object? searchError;
  ResolvedDay? calc = fakeDay(fakeToday, source: 'calc', times: fakeCalcTimes);
  CrossCheck cross = const CrossCheck();
  List<ResolvedDay>? daysList;

  /// Days for a request: [daysList] when set, else one official day per date.
  PrayerDays Function(String from, String to)? daysOf;

  final List<String> searches = [];
  final List<(String, String)> dayRanges = [];
  int refreshes = 0;

  @override
  Future<PrayerStatus> status() async => status_;

  @override
  Future<List<CountryInfo>> countries({String lang = 'ms'}) async => countriesList;

  /// Longitudes asked about, as (country, lon).
  final List<(String, double)> timezoneAsks = [];

  @override
  Future<String?> suggestTimezone(String country, double lon) async {
    timezoneAsks.add((country, lon));
    if (country == 'ID') return lon < 115 ? 'Asia/Jakarta' : lon < 126 ? 'Asia/Makassar' : 'Asia/Jayapura';
    return null;
  }

  @override
  Future<ZoneList> zones() async => zoneList;

  @override
  Future<ZoneRefreshResult> refreshZones() async {
    refreshes++;
    if (refreshError != null) throw refreshError!;
    return refreshResult;
  }

  @override
  Future<LocationSearch> searchLocation(String query) async {
    searches.add(query);
    if (searchError != null) throw searchError!;
    return searchResult;
  }

  @override
  Future<ResolvedDay?> calcPreview(String date) async => calc;

  @override
  Future<PrayerDays> days(String from, String to) async {
    dayRanges.add((from, to));
    final custom = daysOf;
    if (custom != null) return custom(from, to);
    return PrayerDays(
      days: daysList ?? [fakeDay(fakeToday)],
      crossCheck: cross,
      sources: PrayerSources(
        order: status_.order,
        country: status_.country,
        hasOfficial: status_.hasOfficial,
        zone: status_.zone,
        located: status_.located,
      ),
    );
  }

  // ---- imports and corrections (Task 9) ----

  final List<(String, String, String, String)> corrections = [];
  final List<(String, String)> removedCorrections = [];
  Object? correctionError;

  @override
  Future<Map<String, dynamic>> putCorrection(String date, String prayer, String time, String reason) async {
    if (correctionError != null) throw correctionError!;
    corrections.add((date, prayer, time, reason));
    return {'ok': true};
  }

  @override
  Future<void> removeCorrection(String date, String prayer) async {
    removedCorrections.add((date, prayer));
  }

  /// The dry run for an overlap choice.
  ImportPreview Function(String overlap)? previewOf;
  Object? previewError;
  final List<String> previewOverlaps = [];
  final List<Map<String, Object?>> applied = [];
  final List<(String, String)> officialImports = [];
  ImportApplied appliedResult = const ImportApplied(id: 'imp1', inserted: 31);

  @override
  Future<ImportPreview> previewImportFile({
    required String kind,
    required String name,
    String? text,
    Uint8List? bytes,
    String? sheet,
    String overlap = 'keep',
  }) async {
    if (previewError != null) throw previewError!;
    previewOverlaps.add(overlap);
    return previewOf!(overlap);
  }

  @override
  Future<ImportApplied> applyImportFile({
    required String kind,
    required String name,
    String? text,
    Uint8List? bytes,
    String? sheet,
    required String overlap,
    required String expectSha256,
    String? confirmName,
  }) async {
    applied.add({'kind': kind, 'name': name, 'overlap': overlap, 'sha': expectSha256});
    return appliedResult;
  }

  @override
  Future<Map<String, dynamic>> importOfficialCsv(String zone, String csv) async {
    officialImports.add((zone, csv));
    return {'inserted': 365, 'replaced': 0};
  }

  List<ImportRecord> records = const [];
  Object? undoError;
  final List<String> undone = [];

  @override
  Future<List<ImportRecord>> imports() async => records;

  @override
  Future<int> undoImport(String id) async {
    if (undoError != null) throw undoError!;
    undone.add(id);
    return 31;
  }

  final List<String> templates = [];

  @override
  Future<Uint8List> templateBytes(String kind, int year) async {
    templates.add('$kind:$year');
    return Uint8List.fromList('date,subuh\n'.codeUnits);
  }

  @override
  BoxGateway get gateway => throw UnimplementedError();

  @override
  RawPost get rawPost => throw UnimplementedError();

  @override
  Future<ImportRecord> importDetail(String id) => throw UnimplementedError();
}

class PrayerApp {
  PrayerApp(this.h, this.app, this.repo);

  final ShellHarness h;
  final Widget app;
  final FakePrayerRepo repo;
}

/// Puts [screen] in the shell at [size] over a harness holding [settings].
Future<PrayerApp> pumpPrayer(
  WidgetTester tester,
  Widget screen, {
  required String location,
  FakePrayerRepo? repo,
  Map<String, Map<String, Object?>> settings = const {},
  List<String> roles = const ['admin'],
  void Function(ShellHarness h)? setup,
  GoldenSize size = GoldenSize.phone,
}) async {
  final fake = repo ?? FakePrayerRepo();
  final h = ShellHarness(
    roles: roles,
    overrides: [
      prayerRepositoryProvider.overrideWithValue(fake),
      livePublisherProvider.overrideWithValue(FakePublisher()),
    ],
  );
  h.settings['zone'] = {'enabled': true, 'zone': 'SGR01', 'autoFetch': true};
  h.settings['location'] = {
    'enabled': true,
    'country': 'MY',
    'timezone': 'Asia/Kuala_Lumpur',
    'latitude': 3.2486,
    'longitude': 101.6556,
    'city': 'Batu Caves',
  };
  settings.forEach((k, v) => h.settings[k] = v);
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
  return PrayerApp(h, app, fake);
}

/// Taps a widget that may be below the fold of the page's list.
Future<void> tapRevealed(WidgetTester tester, Finder finder) async {
  await reveal(tester, finder);
  await tester.tap(finder.first);
  await settle(tester);
}

/// A 404-free stand-in so a Task 9 screen can read the users list.
Map<String, Object?> usersBody() => {
  'users': [
    {'id': 'u1', 'name': 'Ustaz Ali', 'roles': ['admin'], 'active': true},
  ],
};

/// Convenience for handlers.
Future<dynamic> okJson(Object body) async => jsonResponse(200, body);
