// The app's client for the prayer-sources routes of the box (Plan 13): the
// resolved days with their cross-check, the status, countries and zones,
// the place search, file imports with their undo, and corrections.
// Everything goes straight to the network (these
// routes are live-only, see sync/live_only.dart); nothing is cached here.
//
// Answers are parsed leniently: a missing optional field takes its default,
// so a box one step ahead or behind does not break a screen. Failures are
// [PrayerError] with Bahasa Malaysia wording; a lost session, an unreachable
// box and a [LiveOnly] refusal pass through unchanged for the shell.

import 'dart:convert';
import 'dart:typed_data';

import '../../box/box_client.dart';
import '../shell/box_gateway.dart';

// ---- errors ----

enum PrayerFailure {
  invalid,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  offline,
  upstream,
  other,
}

/// A request the box refused. [message] is the text to show.
class PrayerError implements Exception {
  const PrayerError(this.kind, this.message, {this.status});

  final PrayerFailure kind;
  final String message;
  final int? status;

  static const String forbiddenMessage = 'Tiada kebenaran untuk tindakan ini';
  static const String notFoundMessage = 'Tidak dijumpai';
  static const String rateLimitedMessage =
      'Terlalu banyak carian. Cuba lagi sebentar lagi';
  static const String offlineMessage =
      'Carian lokasi perlukan sambungan internet pada MAXCOM';
  static const String upstreamMessage =
      'Sumber waktu solat tidak menjawab. Cuba lagi nanti';
  static const String conflictMessage = 'Tindakan ini tidak boleh dibuat lagi';
  static const String tooLargeMessage = 'Fail terlalu besar. Pilih fail yang lebih kecil';
  static const String badTypeMessage = 'Jenis fail tidak disokong';
  static const String unavailableMessage =
      'Perkhidmatan tidak tersedia buat masa ini';

  @override
  String toString() => 'PrayerError($kind, $message)';
}

const String _genericBoxMessage = 'Permintaan gagal';

// ---- small readers ----

Map<String, dynamic> _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : const <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? v) => [
  for (final e in (v is List ? v : const [])) if (e is Map) e.cast<String, dynamic>(),
];

List<String> _strings(Object? v) => [
  for (final e in (v is List ? v : const [])) if (e is String) e,
];

int _int(Object? v, [int fallback = 0]) => v is num ? v.toInt() : fallback;

double? _double(Object? v) => v is num ? v.toDouble() : null;

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

Map<String, int> _intMap(Object? v) => {
  for (final e in _map(v).entries)
    if (e.value is num) e.key: (e.value as num).toInt(),
};

Map<String, String> _stringMap(Object? v) => {
  for (final e in _map(v).entries)
    if (e.value is String) e.key: e.value as String,
};

// ---- DTOs ----

class HijriDate {
  const HijriDate(this.y, this.m, this.d);

  factory HijriDate.fromJson(Object? j) {
    final m = _map(j);
    return HijriDate(_int(m['y']), _int(m['m']), _int(m['d']));
  }

  final int y;
  final int m;
  final int d;
}

/// One day as the box resolved it. [source] is `official`, `calc` or `file`.
class ResolvedDay {
  const ResolvedDay({
    required this.date,
    required this.times,
    this.hijri,
    this.dhuha,
    this.overrides,
    this.imsakDerived = false,
    this.source = 'calc',
    this.corrected = const [],
    this.officialChanged = const [],
    this.correctionIgnored = const [],
    this.emergency = false,
    this.hijriSource,
  });

  factory ResolvedDay.fromJson(Map<String, dynamic> j) => ResolvedDay(
    date: _str(j['date']) ?? '',
    hijri: j['hijri'] is Map ? HijriDate.fromJson(j['hijri']) : null,
    times: _stringMap(j['times']),
    dhuha: _str(j['dhuha']),
    overrides: j['overrides'] is Map ? _stringMap(j['overrides']) : null,
    imsakDerived: j['imsakDerived'] == true,
    source: _str(j['source']) ?? 'calc',
    corrected: _strings(j['corrected']),
    officialChanged: _strings(j['officialChanged']),
    correctionIgnored: _strings(j['correctionIgnored']),
    emergency: j['emergency'] == true,
    hijriSource: _str(j['hijriSource']),
  );

  final String date;
  final HijriDate? hijri;
  final Map<String, String> times;
  final String? dhuha;
  final Map<String, String>? overrides;
  final bool imsakDerived;
  final String source;
  final List<String> corrected;

  /// Corrected prayers whose official time moved since the correction was made.
  final List<String> officialChanged;

  /// Corrected prayers whose correction is not used because it would put the day out of order.
  final List<String> correctionIgnored;
  final bool emergency;
  final String? hijriSource;
}

/// A day where a source differs from the calculation by more than the
/// tolerance; [diffs] are source minus calculation, in minutes.
class CrossFlag {
  const CrossFlag({required this.date, required this.source, required this.diffs});

  factory CrossFlag.fromJson(Map<String, dynamic> j) => CrossFlag(
    date: _str(j['date']) ?? '',
    source: _str(j['source']) ?? '',
    diffs: _intMap(j['diffs']),
  );

  final String date;
  final String source;
  final Map<String, int> diffs;
}

class CrossCheck {
  const CrossCheck({
    this.flagged = const [],
    this.maxDiff = const {},
    this.medianDiff = const {},
    this.compared = 0,
  });

  factory CrossCheck.fromJson(Object? v) {
    final j = _map(v);
    return CrossCheck(
      flagged: [for (final f in _maps(j['flagged'])) CrossFlag.fromJson(f)],
      maxDiff: _intMap(j['maxDiff']),
      medianDiff: _intMap(j['medianDiff']),
      compared: _int(j['compared']),
    );
  }

  final List<CrossFlag> flagged;
  final Map<String, int> maxDiff;
  final Map<String, int> medianDiff;
  final int compared;
}

class PrayerSources {
  const PrayerSources({
    this.order = const [],
    this.country,
    this.hasOfficial = false,
    this.zone,
    this.located = false,
    this.timezone,
  });

  factory PrayerSources.fromJson(Object? v) {
    final j = _map(v);
    return PrayerSources(
      order: _strings(j['order']),
      country: _str(j['country']),
      hasOfficial: j['hasOfficial'] == true,
      zone: _str(j['zone']),
      located: j['located'] == true,
      timezone: _str(j['timezone']),
    );
  }

  final List<String> order;
  final String? country;
  final bool hasOfficial;
  final String? zone;
  final bool located;
  final String? timezone;
}

/// `GET /api/prayer/days`.
class PrayerDays {
  const PrayerDays({
    required this.days,
    required this.crossCheck,
    required this.sources,
  });

  factory PrayerDays.fromJson(Map<String, dynamic> j) => PrayerDays(
    days: [for (final d in _maps(j['days'])) ResolvedDay.fromJson(d)],
    crossCheck: CrossCheck.fromJson(j['crossCheck']),
    sources: PrayerSources.fromJson(j['sources']),
  );

  final List<ResolvedDay> days;
  final CrossCheck crossCheck;
  final PrayerSources sources;
}

class TodayStatus {
  const TodayStatus({required this.date, required this.source, this.emergency = false});

  final String date;
  final String source;
  final bool emergency;
}

class OfficialYear {
  const OfficialYear({required this.year, required this.days, this.fetchedAt});

  final int year;
  final int days;
  final String? fetchedAt;
}

class AutoFetchStatus {
  const AutoFetchStatus({
    this.enabled = false,
    this.lastAttemptAt,
    this.lastOk,
    this.lastError,
  });

  final bool enabled;
  final String? lastAttemptAt;
  final bool? lastOk;
  final String? lastError;
}

/// `GET /api/prayer/status`.
class PrayerStatus {
  const PrayerStatus({
    this.country,
    this.hasOfficial = false,
    this.zone,
    this.timezone,
    this.located = false,
    this.order = const [],
    this.today,
    this.daysResolved = 0,
    this.daysOfficial = 0,
    this.daysFile = 0,
    this.officialZone,
    this.officialYears = const [],
    this.zonesFetchedAt,
    this.zonesCount = 0,
    this.zonesSelectedKnown = true,
    this.zonesWarning,
    this.autoFetch = const AutoFetchStatus(),
    this.warnings = const [],
  });

  factory PrayerStatus.fromJson(Map<String, dynamic> j) {
    final today = j['today'] is Map ? _map(j['today']) : null;
    final ahead = _map(j['daysAhead']);
    final official = _map(j['official']);
    final zones = _map(j['zones']);
    final auto = _map(j['autoFetch']);
    return PrayerStatus(
      country: _str(j['country']),
      hasOfficial: j['hasOfficial'] == true,
      zone: _str(j['zone']),
      timezone: _str(j['timezone']),
      located: j['located'] == true,
      order: _strings(j['order']),
      today: today == null
          ? null
          : TodayStatus(
              date: _str(today['date']) ?? '',
              source: _str(today['source']) ?? '',
              emergency: today['emergency'] == true,
            ),
      daysResolved: _int(ahead['resolved']),
      daysOfficial: _int(ahead['official']),
      daysFile: _int(ahead['file']),
      officialZone: _str(official['zone']),
      officialYears: [
        for (final y in _maps(official['years']))
          OfficialYear(
            year: _int(y['year']),
            days: _int(y['days']),
            fetchedAt: _str(y['fetchedAt']),
          ),
      ],
      zonesFetchedAt: _str(zones['fetchedAt']),
      zonesCount: _int(zones['count']),
      zonesSelectedKnown: zones['selectedKnown'] != false,
      zonesWarning: _str(zones['warning']),
      autoFetch: AutoFetchStatus(
        enabled: auto['enabled'] == true,
        lastAttemptAt: _str(auto['lastAttemptAt']),
        lastOk: auto['lastOk'] is bool ? auto['lastOk'] as bool : null,
        lastError: _str(auto['lastError']),
      ),
      warnings: _strings(j['warnings']),
    );
  }

  final String? country;
  final bool hasOfficial;
  final String? zone;
  final String? timezone;
  final bool located;
  final List<String> order;
  final TodayStatus? today;
  final int daysResolved;
  final int daysOfficial;
  final int daysFile;
  final String? officialZone;
  final List<OfficialYear> officialYears;
  final String? zonesFetchedAt;
  final int zonesCount;
  final bool zonesSelectedKnown;
  final String? zonesWarning;
  final AutoFetchStatus autoFetch;
  final List<String> warnings;
}

class CountryInfo {
  const CountryInfo({
    required this.code,
    required this.name,
    this.timezones = const [],
    this.method,
    this.madhab,
    this.hasOfficial = false,
  });

  factory CountryInfo.fromJson(Map<String, dynamic> j) {
    final d = _map(j['defaults']);
    return CountryInfo(
      code: _str(j['code']) ?? '',
      name: _str(j['name']) ?? '',
      timezones: _strings(j['timezones']),
      method: _str(d['method']),
      madhab: _str(d['madhab']),
      hasOfficial: j['hasOfficial'] == true,
    );
  }

  final String code;
  final String name;
  final List<String> timezones;
  final String? method;
  final String? madhab;
  final bool hasOfficial;
}

class ZoneInfo {
  const ZoneInfo({
    required this.code,
    required this.name,
    this.state,
    this.lat,
    this.lon,
    this.removed = false,
    this.years = const [],
  });

  factory ZoneInfo.fromJson(Map<String, dynamic> j) => ZoneInfo(
    code: _str(j['code']) ?? '',
    name: _str(j['name']) ?? '',
    state: _str(j['state']),
    lat: _double(j['lat']),
    lon: _double(j['lon']),
    removed: j['removed'] == true,
    years: [for (final y in (j['years'] is List ? j['years'] as List : const [])) if (y is num) y.toInt()],
  );

  final String code;
  final String name;
  final String? state;
  final double? lat;
  final double? lon;
  final bool removed;
  final List<int> years;
}

class ZoneSuggestion {
  const ZoneSuggestion({required this.code, required this.distanceKm});

  final String code;
  final double distanceKm;
}

/// `GET /api/prayer/zones`.
class ZoneList {
  const ZoneList({
    required this.zones,
    this.fetchedAt,
    this.warning,
    this.suggested,
  });

  factory ZoneList.fromJson(Map<String, dynamic> j) {
    final s = j['suggested'] is Map ? _map(j['suggested']) : null;
    final code = s == null ? null : _str(s['code']);
    return ZoneList(
      zones: [for (final z in _maps(j['zones'])) ZoneInfo.fromJson(z)],
      fetchedAt: _str(j['fetchedAt']),
      warning: _str(j['warning']),
      suggested: code == null
          ? null
          : ZoneSuggestion(code: code, distanceKm: _double(s!['distanceKm']) ?? 0),
    );
  }

  final List<ZoneInfo> zones;
  final String? fetchedAt;
  final String? warning;
  final ZoneSuggestion? suggested;
}

class ZoneRefreshResult {
  const ZoneRefreshResult({
    this.added = const [],
    this.removed = const [],
    this.renamed = const [],
    this.count = 0,
  });

  factory ZoneRefreshResult.fromJson(Map<String, dynamic> j) => ZoneRefreshResult(
    added: _strings(j['added']),
    removed: _strings(j['removed']),
    renamed: _strings(j['renamed']),
    count: _int(j['count']),
  );

  final List<String> added;
  final List<String> removed;
  final List<String> renamed;
  final int count;
}

class LocationHit {
  const LocationHit({
    required this.label,
    required this.lat,
    required this.lon,
    this.city,
    this.country,
  });

  factory LocationHit.fromJson(Map<String, dynamic> j) => LocationHit(
    label: _str(j['label']) ?? '',
    city: _str(j['city']),
    lat: _double(j['lat']) ?? 0,
    lon: _double(j['lon']) ?? 0,
    country: _str(j['country']),
  );

  final String label;
  final String? city;
  final double lat;
  final double lon;
  final String? country;
}

class LocationSearch {
  const LocationSearch({
    required this.results,
    this.cached = false,
    this.attribution,
  });

  factory LocationSearch.fromJson(Map<String, dynamic> j) => LocationSearch(
    results: [for (final h in _maps(j['results'])) LocationHit.fromJson(h)],
    cached: j['cached'] == true,
    attribution: _str(j['attribution']),
  );

  final List<LocationHit> results;
  final bool cached;
  final String? attribution;
}

class ImportRowError {
  const ImportRowError(this.row, this.message);

  final int row;
  final String message;
}

/// The answer to a dry run of a file import. [hint] is `official` when the
/// file is an e-Solat yearly CSV: the app then imports it as official days
/// with [PrayerRepository.importOfficialCsv].
class ImportPreview {
  const ImportPreview({
    required this.format,
    this.hint,
    this.sha256,
    this.sheets = const [],
    this.columns = const [],
    this.errors = const [],
    this.rangeFrom,
    this.rangeTo,
    this.perMonth = const {},
    this.firstWeek = const [],
    this.lastWeek = const [],
    this.overlaps = const {},
    this.wouldInsert = 0,
    this.wouldReplace = 0,
    this.wouldSkip = 0,
    this.crossCheck = const CrossCheck(),
    this.fileShadowed = false,
  });

  factory ImportPreview.fromJson(Map<String, dynamic> j) {
    final p = _map(j['preview']);
    final range = _map(p['range']);
    final w = _map(p['wouldWrite']);
    return ImportPreview(
      format: _str(j['format']) ?? '',
      hint: _str(j['hint']),
      sha256: _str(j['sha256']),
      sheets: _strings(j['sheets']),
      columns: _strings(j['columns']),
      errors: [
        for (final e in _maps(j['errors']))
          ImportRowError(_int(e['row']), _str(e['message']) ?? ''),
      ],
      rangeFrom: _str(range['from']),
      rangeTo: _str(range['to']),
      perMonth: _intMap(p['perMonth']),
      firstWeek: [for (final d in _maps(p['firstWeek'])) ResolvedDay.fromJson(d)],
      lastWeek: [for (final d in _maps(p['lastWeek'])) ResolvedDay.fromJson(d)],
      overlaps: _intMap(p['overlaps']),
      wouldInsert: _int(w['inserted']),
      wouldReplace: _int(w['replaced']),
      wouldSkip: _int(w['skipped']),
      crossCheck: CrossCheck.fromJson(p['crossCheck']),
      fileShadowed: p['fileShadowed'] == true,
    );
  }

  final String format;
  final String? hint;
  final String? sha256;
  final List<String> sheets;
  final List<String> columns;
  final List<ImportRowError> errors;
  final String? rangeFrom;
  final String? rangeTo;
  final Map<String, int> perMonth;
  final List<ResolvedDay> firstWeek;
  final List<ResolvedDay> lastWeek;
  final Map<String, int> overlaps;
  final int wouldInsert;
  final int wouldReplace;
  final int wouldSkip;
  final CrossCheck crossCheck;

  /// The source order puts the local calculation above the file, so this timetable would not be used.
  final bool fileShadowed;

  bool get isOfficialHint => hint == 'official';
}

/// What an applied file import wrote.
class ImportApplied {
  const ImportApplied({
    required this.id,
    this.inserted = 0,
    this.replaced = 0,
    this.skipped = 0,
  });

  factory ImportApplied.fromJson(Map<String, dynamic> j) => ImportApplied(
    id: j['id'] is num ? (j['id'] as num).toString() : (_str(j['id']) ?? ''),
    inserted: _int(j['inserted']),
    replaced: _int(j['replaced']),
    skipped: _int(j['skipped']),
  );

  final String id;
  final int inserted;
  final int replaced;
  final int skipped;
}

/// One past file import. [days] is filled by `GET /api/prayer/imports/:id`.
class ImportRecord {
  const ImportRecord({
    required this.id,
    this.kind,
    this.fileName,
    this.sha256,
    this.rows = 0,
    this.dateFrom,
    this.dateTo,
    this.overlap,
    this.inserted = 0,
    this.replaced = 0,
    this.skipped = 0,
    this.actor,
    this.createdAt,
    this.undoneAt,
    this.undoneBy,
    this.days = const [],
  });

  factory ImportRecord.fromJson(Map<String, dynamic> j) => ImportRecord(
    id: j['id'] is num ? (j['id'] as num).toString() : (_str(j['id']) ?? ''),
    kind: _str(j['kind']),
    fileName: _str(j['fileName']),
    sha256: _str(j['sha256']),
    rows: _int(j['rows']),
    dateFrom: _str(j['dateFrom']),
    dateTo: _str(j['dateTo']),
    overlap: _str(j['overlap']),
    inserted: _int(j['inserted']),
    replaced: _int(j['replaced']),
    skipped: _int(j['skipped']),
    actor: _str(j['actor']),
    createdAt: _str(j['createdAt']),
    undoneAt: _str(j['undoneAt']),
    undoneBy: _str(j['undoneBy']),
    days: [for (final d in _maps(j['days'])) ResolvedDay.fromJson(d)],
  );

  final String id;
  final String? kind;
  final String? fileName;
  final String? sha256;
  final int rows;
  final String? dateFrom;
  final String? dateTo;
  final String? overlap;
  final int inserted;
  final int replaced;
  final int skipped;
  final String? actor;
  final String? createdAt;
  final String? undoneAt;
  final String? undoneBy;
  final List<ResolvedDay> days;

  bool get undone => undoneAt != null;
}

/// Sends raw bytes with their own content type (for example a zip). The
/// repository uses the gateway's [BoxGateway.postRaw] unless a test supplies
/// its own.
typedef RawPost =
    Future<Map<String, dynamic>> Function(
      String path,
      Uint8List bytes,
      String contentType,
    );

// ---- the repository ----

class PrayerRepository {
  PrayerRepository(this.gateway, {RawPost? rawPost})
    : rawPost = rawPost ?? gateway.postRaw;

  final BoxGateway gateway;
  final RawPost rawPost;

  static const String base = '/api/prayer';

  static String _enc(String s) => Uri.encodeComponent(s);

  Future<T> _guard<T>(Future<T> Function() run, {bool search = false, bool zones = false}) async {
    try {
      return await run();
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      throw _map2(e, search: search, zones: zones);
    }
  }

  PrayerError _map2(BoxError e, {bool search = false, bool zones = false}) {
    final box = e.message == _genericBoxMessage ? null : e.message;
    switch (e.status) {
      case 400:
        return PrayerError(PrayerFailure.invalid, box ?? 'Data tidak sah', status: 400);
      case 403:
        return const PrayerError(PrayerFailure.forbidden, PrayerError.forbiddenMessage, status: 403);
      case 404:
        return const PrayerError(PrayerFailure.notFound, PrayerError.notFoundMessage, status: 404);
      case 409:
        return PrayerError(PrayerFailure.conflict, box ?? PrayerError.conflictMessage, status: 409);
      case 413:
        return const PrayerError(PrayerFailure.invalid, PrayerError.tooLargeMessage, status: 413);
      case 415:
        return const PrayerError(PrayerFailure.invalid, PrayerError.badTypeMessage, status: 415);
      case 429:
        return const PrayerError(PrayerFailure.rateLimited, PrayerError.rateLimitedMessage, status: 429);
      case 502:
        return PrayerError(
          PrayerFailure.upstream,
          zones ? 'Senarai zon tidak dapat dimuat turun sekarang. Cuba lagi nanti' : PrayerError.upstreamMessage,
          status: 502,
        );
      case 503:
        return search
            ? const PrayerError(PrayerFailure.offline, PrayerError.offlineMessage, status: 503)
            : const PrayerError(PrayerFailure.other, PrayerError.unavailableMessage, status: 503);
      default:
        return PrayerError(PrayerFailure.other, box ?? _genericBoxMessage, status: e.status);
    }
  }

  // ---- days, status, countries ----

  /// `GET /api/prayer/days?from=&to=` (dates `YYYY-MM-DD`).
  Future<PrayerDays> days(String from, String to) => _guard(
    () async => PrayerDays.fromJson(
      await gateway.getFresh('$base/days?from=${_enc(from)}&to=${_enc(to)}'),
    ),
  );

  Future<PrayerStatus> status() =>
      _guard(() async => PrayerStatus.fromJson(await gateway.getFresh('$base/status')));

  /// The JSON at [path] whatever its top level is: [BoxClient.getJson] only
  /// takes objects, and these two routes answer a list and `null`.
  Future<Object?> _anyJson(String path) async {
    final bytes = await gateway.getBytes(path);
    if (bytes.isEmpty) return null;
    try {
      return jsonDecode(utf8.decode(bytes));
    } on FormatException {
      throw const BoxError(200, _genericBoxMessage);
    }
  }

  /// `GET /api/prayer/calc/preview?date=`: null when there is no location.
  Future<ResolvedDay?> calcPreview(String date) => _guard(() async {
    final body = await _anyJson('$base/calc/preview?date=${_enc(date)}');
    return body is Map && _str(body['date']) != null
        ? ResolvedDay.fromJson(body.cast<String, dynamic>())
        : null;
  });

  /// `GET /api/prayer/countries?lang=ms|en`.
  Future<List<CountryInfo>> countries({String lang = 'ms'}) => _guard(() async {
    final body = await _anyJson('$base/countries?lang=${_enc(lang)}');
    return [for (final c in _maps(body)) CountryInfo.fromJson(c)];
  });

  // ---- zones and location ----

  /// `GET /api/prayer/timezone?country=&lon=`: the zone of [country] that fits
  /// [lon]. A help only, so any failure is null and the page keeps its zone.
  Future<String?> suggestTimezone(String country, double lon) async {
    try {
      final body = await _anyJson('$base/timezone?country=${_enc(country)}&lon=${_enc('$lon')}');
      return body is Map ? _str(body['timezone']) : null;
    } catch (_) {
      return null;
    }
  }

  Future<ZoneList> zones() =>
      _guard(() async => ZoneList.fromJson(await gateway.getFresh('$base/zones')));

  Future<ZoneRefreshResult> refreshZones() => _guard(
    () async => ZoneRefreshResult.fromJson(await gateway.post('$base/zones/refresh', const {})),
    zones: true,
  );

  /// `POST /api/location/search`. Rate limited (429) and offline (503) are
  /// told apart by [PrayerFailure].
  Future<LocationSearch> searchLocation(String query) => _guard(
    () async => LocationSearch.fromJson(await gateway.post('/api/location/search', {'query': query})),
    search: true,
  );

  // ---- corrections ----

  Future<Map<String, dynamic>> putCorrection(String date, String prayer, String time, String reason) =>
      _guard(() => gateway.put('$base/corrections/${_enc(date)}/${_enc(prayer)}', {'time': time, 'reason': reason}));

  Future<void> removeCorrection(String date, String prayer) =>
      _guard(() => gateway.delete('$base/corrections/${_enc(date)}/${_enc(prayer)}'));

  // ---- file imports ----

  Map<String, dynamic> _fileBody({
    required String kind,
    required String name,
    String? text,
    Uint8List? bytes,
    String? sheet,
    required bool dryRun,
    required String overlap,
    String? expectSha256,
    String? confirmName,
  }) => {
    'kind': kind,
    'name': name,
    'text': ?text,
    if (bytes != null) 'base64': base64.encode(bytes),
    'sheet': ?sheet,
    'dryRun': dryRun,
    'overlap': overlap,
    'expectSha256': ?expectSha256,
    'confirmName': ?confirmName,
  };

  /// Dry run: parse and compare, write nothing. An e-Solat yearly CSV
  /// answers with [ImportPreview.isOfficialHint].
  Future<ImportPreview> previewImportFile({
    required String kind,
    required String name,
    String? text,
    Uint8List? bytes,
    String? sheet,
    String overlap = 'keep',
  }) => _guard(
    () async => ImportPreview.fromJson(
      await gateway.post(
        '$base/import/file',
        _fileBody(
          kind: kind,
          name: name,
          text: text,
          bytes: bytes,
          sheet: sheet,
          dryRun: true,
          overlap: overlap,
        ),
      ),
    ),
  );

  /// Apply what the dry run showed: [expectSha256] is the hash it returned,
  /// so a changed file is refused (400).
  Future<ImportApplied> applyImportFile({
    required String kind,
    required String name,
    String? text,
    Uint8List? bytes,
    String? sheet,
    required String overlap,
    required String expectSha256,
    String? confirmName,
  }) => _guard(
    () async => ImportApplied.fromJson(
      await gateway.post(
        '$base/import/file',
        _fileBody(
          kind: kind,
          name: name,
          text: text,
          bytes: bytes,
          sheet: sheet,
          dryRun: false,
          overlap: overlap,
          expectSha256: expectSha256,
          confirmName: confirmName,
        ),
      ),
    ),
  );

  /// The existing e-Solat route: official days for [zone] from the CSV text.
  Future<Map<String, dynamic>> importOfficialCsv(String zone, String csv) =>
      _guard(() => gateway.post('$base/import', {'zone': zone, 'csv': csv}));

  Future<List<ImportRecord>> imports() => _guard(() async {
    final body = await gateway.getFresh('$base/imports');
    return [for (final r in _maps(body['imports'])) ImportRecord.fromJson(r)];
  });

  Future<ImportRecord> importDetail(String id) =>
      _guard(() async => ImportRecord.fromJson(await gateway.getFresh('$base/imports/${_enc(id)}')));

  /// Rows restored, or a [PrayerError] of kind conflict (409) when the
  /// import can no longer be undone.
  Future<int> undoImport(String id) => _guard(() async {
    final body = await gateway.post('$base/imports/${_enc(id)}/undo', const {});
    return _int(body['restored']);
  });

  /// Path of the blank template (`kind` is `csv` or `xlsx`); download it
  /// with [templateBytes].
  static String templatePath(String kind, int year) {
    if (kind != 'csv' && kind != 'xlsx') throw ArgumentError.value(kind, 'kind');
    return '$base/template.$kind?year=$year';
  }

  Future<Uint8List> templateBytes(String kind, int year) =>
      _guard(() => gateway.getBytes(templatePath(kind, year)));
}
