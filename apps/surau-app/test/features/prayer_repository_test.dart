// The prayer repository over a fake box: the right paths, methods and
// bodies, the fixtures parsed into their DTOs (success paths), tolerant
// parsing of missing fields, and errors in Bahasa Malaysia.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/prayer/prayer_repository.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';

import 'fakes.dart';

class _Reach implements ReachSink {
  BoxReach state = BoxReach.unknown;

  @override
  BoxReach get reach => state;

  @override
  void markUp(DateTime at) => state = state.up(at);

  @override
  void markDown(DateTime at) => state = state.failed(at);
}

final _t0 = DateTime.utc(2026, 11, 10, 2);

class _Rig {
  _Rig(Future<http.Response> Function(http.Request r) handler, {RawPost? rawPost}) {
    box = FakeBox(handler);
    final gateway = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: ReadCache(),
      reach: _Reach(),
      now: () => _t0,
      onSessionExpired: () => expired++,
    );
    repo = PrayerRepository(gateway, rawPost: rawPost);
  }

  late final FakeBox box;
  late final PrayerRepository repo;
  int expired = 0;

  http.Request get last => box.seen.last;
  Map<String, dynamic> get lastBody => jsonDecode(last.body) as Map<String, dynamic>;
}

Map<String, Object?> _day(String date, {String source = 'official'}) => {
  'date': date,
  'hijri': {'y': 1448, 'm': 5, 'd': 22},
  'times': {
    'imsak': '05:50',
    'subuh': '06:00',
    'syuruk': '07:10',
    'zohor': '13:10',
    'asar': '16:20',
    'maghrib': '19:10',
    'isyak': '20:20',
  },
  'dhuha': '07:30',
  'source': source,
  'corrected': ['subuh'],
  if (source == 'official') 'officialChanged': ['subuh'],
  'emergency': false,
  'hijriSource': 'table',
};

void main() {
  group('reads', () {
    test('days: path with dates, the whole answer parsed', () async {
      final rig = _Rig(
        (r) async => jsonResponse(200, {
          'days': [_day('2026-11-10'), _day('2026-11-11', source: 'calc')],
          'crossCheck': {
            'flagged': [
              {
                'date': '2026-11-11',
                'source': 'file',
                'diffs': {'subuh': 3, 'isyak': -2},
              },
            ],
            'maxDiff': {'subuh': 3},
            'medianDiff': {'subuh': 1},
            'compared': 2,
          },
          'sources': {
            'order': ['official', 'file', 'calc'],
            'country': 'MY',
            'hasOfficial': true,
            'zone': 'SGR01',
            'located': true,
            'timezone': 'Asia/Kuala_Lumpur',
          },
        }),
      );
      final d = await rig.repo.days('2026-11-10', '2026-11-11');
      expect(rig.last.method, 'GET');
      expect(rig.last.url.path, '/api/prayer/days');
      expect(rig.last.url.queryParameters, {'from': '2026-11-10', 'to': '2026-11-11'});
      expect(rig.last.headers['authorization'], 'Bearer tok-1');
      expect(d.days, hasLength(2));
      expect(d.days.first.times['subuh'], '06:00');
      expect(d.days.first.hijri!.d, 22);
      expect(d.days.first.dhuha, '07:30');
      expect(d.days.first.corrected, ['subuh']);
      expect(d.days.first.officialChanged, ['subuh']);
      expect(d.days.last.officialChanged, isEmpty, reason: 'absent from the answer means none');
      expect(d.days.last.source, 'calc');
      expect(d.crossCheck.flagged.single.diffs, {'subuh': 3, 'isyak': -2});
      expect(d.crossCheck.compared, 2);
      expect(d.sources.order, ['official', 'file', 'calc']);
      expect(d.sources.zone, 'SGR01');
      expect(d.sources.hasOfficial, isTrue);
    });

    test('status parsed; missing optional fields take defaults', () async {
      final rig = _Rig(
        (r) async => jsonResponse(200, {
          'country': 'MY',
          'hasOfficial': true,
          'zone': 'SGR01',
          'timezone': 'Asia/Kuala_Lumpur',
          'located': true,
          'order': ['official', 'file', 'calc'],
          'today': {'date': '2026-11-10', 'source': 'official', 'emergency': false},
          'daysAhead': {'resolved': 52, 'official': 50, 'file': 2},
          'official': {
            'zone': 'SGR01',
            'years': [
              {'year': 2026, 'days': 365, 'fetchedAt': '2026-01-02T00:00:00.000Z'},
            ],
          },
          'zones': {'fetchedAt': '2026-11-01T00:00:00.000Z', 'count': 58, 'selectedKnown': true, 'warning': null},
          'autoFetch': {'enabled': true, 'lastAttemptAt': '2026-11-09T01:00:00.000Z', 'lastOk': true},
          'warnings': ['Tiada data 2027'],
        }),
      );
      final s = await rig.repo.status();
      expect(rig.last.url.path, '/api/prayer/status');
      expect(s.zone, 'SGR01');
      expect(s.today!.source, 'official');
      expect(s.daysOfficial, 50);
      expect(s.daysFile, 2);
      expect(s.officialYears.single.days, 365);
      expect(s.zonesCount, 58);
      expect(s.autoFetch.enabled, isTrue);
      expect(s.autoFetch.lastOk, isTrue);
      expect(s.autoFetch.lastError, isNull);
      expect(s.warnings, ['Tiada data 2027']);

      final bare = _Rig((r) async => jsonResponse(200, {}));
      final b = await bare.repo.status();
      expect(b.today, isNull);
      expect(b.order, isEmpty);
      expect(b.daysResolved, 0);
      expect(b.autoFetch.enabled, isFalse);
      expect(b.zonesSelectedKnown, isTrue);
    });

    test('countries: a JSON list is parsed; lang goes in the query', () async {
      final rig = _Rig(
        (r) async => http.Response(
          jsonEncode([
            {
              'code': 'MY',
              'name': 'Malaysia',
              'timezones': ['Asia/Kuala_Lumpur', 'Asia/Kuching'],
              'defaults': {'method': 'jakim', 'madhab': 'shafi'},
              'hasOfficial': true,
            },
            {'code': 'KE', 'name': 'Kenya', 'timezones': ['Africa/Nairobi'], 'defaults': {'method': 'mwl', 'madhab': 'shafi'}},
          ]),
          200,
          headers: {'content-type': 'application/json'},
        ),
      );
      final c = await rig.repo.countries(lang: 'en');
      expect(rig.last.url.path, '/api/prayer/countries');
      expect(rig.last.url.queryParameters['lang'], 'en');
      expect(c.map((e) => e.code), ['MY', 'KE']);
      expect(c.first.timezones, hasLength(2));
      expect(c.first.method, 'jakim');
      expect(c.first.hasOfficial, isTrue);
      expect(c.last.hasOfficial, isFalse);
    });

    test('suggestTimezone: country and longitude go in the query; null when the box refuses or answers nothing', () async {
      final rig = _Rig((r) async => http.Response(jsonEncode({'timezone': 'Asia/Jayapura'}), 200, headers: {'content-type': 'application/json'}));
      expect(await rig.repo.suggestTimezone('ID', 140.7), 'Asia/Jayapura');
      expect(rig.last.url.path, '/api/prayer/timezone');
      expect(rig.last.url.queryParameters, {'country': 'ID', 'lon': '140.7'});
      final none = _Rig((r) async => http.Response(jsonEncode({'errors': ['x']}), 400, headers: {'content-type': 'application/json'}));
      expect(await none.repo.suggestTimezone('ID', 999), isNull, reason: 'a help, never an error');
    });

    test('calc preview: a day, or null when the box answers null', () async {
      final day = _Rig(
        (r) async => http.Response(jsonEncode(_day('2026-11-10', source: 'calc')), 200,
            headers: {'content-type': 'application/json'}),
      );
      final d = await day.repo.calcPreview('2026-11-10');
      expect(day.last.url.path, '/api/prayer/calc/preview');
      expect(day.last.url.queryParameters['date'], '2026-11-10');
      expect(d!.times['asar'], '16:20');

      final none = _Rig((r) async => http.Response('null', 200, headers: {'content-type': 'application/json'}));
      expect(await none.repo.calcPreview('2026-11-10'), isNull);
    });

    test('zones with a suggestion, and the refresh summary', () async {
      final rig = _Rig((r) async {
        if (r.method == 'POST') {
          return jsonResponse(200, {
            'added': ['SGR04'],
            'removed': <String>[],
            'renamed': ['SGR02'],
            'count': 59,
          });
        }
        return jsonResponse(200, {
          'zones': [
            {'code': 'SGR01', 'state': 'Selangor', 'name': 'Gombak', 'lat': 3.2, 'lon': 101.7, 'removed': false, 'years': [2026]},
            {'code': 'XXX01', 'name': 'Lama', 'removed': true},
          ],
          'fetchedAt': '2026-11-01T00:00:00.000Z',
          'warning': null,
          'suggested': {'code': 'SGR01', 'distanceKm': 7.5},
        });
      });
      final z = await rig.repo.zones();
      expect(rig.last.url.path, '/api/prayer/zones');
      expect(z.zones.first.lat, 3.2);
      expect(z.zones.first.years, [2026]);
      expect(z.zones.last.removed, isTrue);
      expect(z.zones.last.lat, isNull);
      expect(z.suggested!.code, 'SGR01');
      expect(z.suggested!.distanceKm, 7.5);

      final r = await rig.repo.refreshZones();
      expect(rig.last.method, 'POST');
      expect(rig.last.url.path, '/api/prayer/zones/refresh');
      expect(r.added, ['SGR04']);
      expect(r.renamed, ['SGR02']);
      expect(r.count, 59);
    });

    test('location search posts the query and parses the hits', () async {
      final rig = _Rig(
        (r) async => jsonResponse(200, {
          'ok': true,
          'results': [
            {'label': 'Shah Alam, Selangor', 'city': 'Shah Alam', 'lat': 3.0738, 'lon': 101.5183, 'country': 'MY'},
          ],
          'cached': true,
          'attribution': 'OpenStreetMap',
        }),
      );
      final s = await rig.repo.searchLocation('Shah Alam');
      expect(rig.last.method, 'POST');
      expect(rig.last.url.path, '/api/location/search');
      expect(rig.lastBody, {'query': 'Shah Alam'});
      expect(s.cached, isTrue);
      expect(s.attribution, 'OpenStreetMap');
      expect(s.results.single.lat, closeTo(3.0738, 1e-9));
      expect(s.results.single.country, 'MY');
    });
  });

  group('corrections', () {
    test('put and delete use the date and prayer in the path', () async {
      final rig = _Rig((r) async => jsonResponse(200, {'ok': true, 'removed': true, 'day': _day('2026-11-10')}));
      await rig.repo.putCorrection('2026-11-10', 'subuh', '06:03', 'Ikut jadual masjid');
      expect(rig.last.method, 'PUT');
      expect(rig.last.url.path, '/api/prayer/corrections/2026-11-10/subuh');
      expect(rig.lastBody, {'time': '06:03', 'reason': 'Ikut jadual masjid'});
      await rig.repo.removeCorrection('2026-11-10', 'subuh');
      expect(rig.last.method, 'DELETE');
      expect(rig.last.url.path, '/api/prayer/corrections/2026-11-10/subuh');
    });
  });

  group('file import', () {
    test('dry run of a csv sends text, never base64; the preview is parsed', () async {
      final rig = _Rig(
        (r) async => jsonResponse(200, {
          'format': 'grid-csv',
          'sha256': 'ab12',
          'columns': ['Tarikh', 'Subuh'],
          'errors': [
            {'row': 4, 'message': 'Masa tidak sah'},
          ],
          'preview': {
            'range': {'from': '2026-12-01', 'to': '2026-12-31'},
            'perMonth': {'2026-12': 31},
            'firstWeek': [_day('2026-12-01', source: 'file')],
            'lastWeek': [_day('2026-12-31', source: 'file')],
            'overlaps': {'official': 0, 'file': 3, 'calc': 28},
            'wouldWrite': {'inserted': 28, 'replaced': 3, 'skipped': 0},
            'crossCheck': {'compared': 31, 'flagged': <Object>[], 'maxDiff': <String, int>{}, 'medianDiff': <String, int>{}},
          },
        }),
      );
      final p = await rig.repo.previewImportFile(kind: 'csv', name: 'waktu.csv', text: 'a,b\n1,2');
      expect(rig.last.method, 'POST');
      expect(rig.last.url.path, '/api/prayer/import/file');
      expect(rig.lastBody, {
        'kind': 'csv',
        'name': 'waktu.csv',
        'text': 'a,b\n1,2',
        'dryRun': true,
        'overlap': 'keep',
      });
      expect(p.isOfficialHint, isFalse);
      expect(p.sha256, 'ab12');
      expect(p.errors.single.row, 4);
      expect(p.rangeFrom, '2026-12-01');
      expect(p.perMonth['2026-12'], 31);
      expect(p.firstWeek.single.source, 'file');
      expect(p.overlaps['calc'], 28);
      expect(p.wouldInsert, 28);
      expect(p.wouldReplace, 3);
      expect(p.crossCheck.compared, 31);
    });

    test('an e-Solat csv answers the official hint', () async {
      final rig = _Rig((r) async => jsonResponse(200, {'format': 'esolat-csv', 'hint': 'official'}));
      final p = await rig.repo.previewImportFile(kind: 'csv', name: 'SGR01.csv', text: 'x');
      expect(p.isOfficialHint, isTrue);
      expect(p.format, 'esolat-csv');
      expect(p.wouldInsert, 0);
    });

    test('an xlsx goes as base64 with its sheet', () async {
      final rig = _Rig((r) async => jsonResponse(200, {'format': 'grid-xlsx', 'sheets': ['A', 'B']}));
      final p = await rig.repo.previewImportFile(
        kind: 'xlsx',
        name: 'waktu.xlsx',
        bytes: Uint8List.fromList([80, 75, 3, 4]),
        sheet: 'B',
        overlap: 'fillEmpty',
      );
      expect(p.sheets, ['A', 'B']);
      expect(rig.lastBody['base64'], base64.encode([80, 75, 3, 4]));
      expect(rig.lastBody.containsKey('text'), isFalse);
      expect(rig.lastBody['sheet'], 'B');
      expect(rig.lastBody['overlap'], 'fillEmpty');
    });

    test('apply sends dryRun false with the hash and returns the counts', () async {
      final rig = _Rig((r) async => jsonResponse(200, {'id': 12, 'inserted': 28, 'replaced': 3, 'skipped': 1}));
      final a = await rig.repo.applyImportFile(
        kind: 'csv',
        name: 'waktu.csv',
        text: 'a',
        overlap: 'replace',
        expectSha256: 'ab12',
        confirmName: 'Surau D\'Waqaf',
      );
      expect(rig.lastBody['dryRun'], isFalse);
      expect(rig.lastBody['expectSha256'], 'ab12');
      expect(rig.lastBody['confirmName'], 'Surau D\'Waqaf');
      expect(rig.lastBody['overlap'], 'replace');
      expect(a.id, '12');
      expect(a.inserted, 28);
      expect(a.replaced, 3);
      expect(a.skipped, 1);
    });

    test('a changed file (sha_mismatch, 400) shows the box wording', () async {
      final rig = _Rig((r) async => jsonResponse(400, {'errors': ['Fail telah berubah. Semak semula']}));
      await expectLater(
        rig.repo.applyImportFile(kind: 'csv', name: 'a.csv', text: 'a', overlap: 'keep', expectSha256: 'zz'),
        throwsA(
          isA<PrayerError>()
              .having((e) => e.kind, 'kind', PrayerFailure.invalid)
              .having((e) => e.message, 'message', 'Fail telah berubah. Semak semula'),
        ),
      );
    });

    test('the e-Solat route gets zone and csv', () async {
      final rig = _Rig((r) async => jsonResponse(200, {'ok': true, 'days': 365}));
      final out = await rig.repo.importOfficialCsv('SGR01', 'csvtext');
      expect(rig.last.url.path, '/api/prayer/import');
      expect(rig.lastBody, {'zone': 'SGR01', 'csv': 'csvtext'});
      expect(out['days'], 365);
    });
  });

  group('import history', () {
    final rec = {
      'id': 12,
      'kind': 'csv',
      'fileName': 'waktu.csv',
      'sha256': 'ab12',
      'rows': 31,
      'dateFrom': '2026-12-01',
      'dateTo': '2026-12-31',
      'overlap': 'keep',
      'inserted': 28,
      'replaced': 3,
      'skipped': 0,
      'actor': 'u1',
      'createdAt': '2026-11-10T01:00:00.000Z',
      'undoneAt': null,
      'undoneBy': null,
    };

    test('list, detail with days, undo', () async {
      final rig = _Rig((r) async {
        final p = r.url.path;
        if (p == '/api/prayer/imports') return jsonResponse(200, {'imports': [rec]});
        if (p == '/api/prayer/imports/12') {
          return jsonResponse(200, {
            ...rec,
            'days': [_day('2026-12-01', source: 'file')],
          });
        }
        if (p == '/api/prayer/imports/12/undo') return jsonResponse(200, {'ok': true, 'restored': 3});
        return jsonResponse(404, {'errors': ['x']});
      });
      final list = await rig.repo.imports();
      expect(list.single.fileName, 'waktu.csv');
      expect(list.single.id, '12');
      expect(list.single.undone, isFalse);
      expect(list.single.days, isEmpty);

      final one = await rig.repo.importDetail('12');
      expect(one.days.single.date, '2026-12-01');

      final restored = await rig.repo.undoImport('12');
      expect(rig.last.method, 'POST');
      expect(rig.last.url.path, '/api/prayer/imports/12/undo');
      expect(restored, 3);
    });

    test('undo refused (409) carries the box reason (errors[0]) as the message', () async {
      const reason = 'Hari 2026-12-05 hingga 2026-12-10 telah diganti oleh import 2026-11-03';
      // The real route answers { ok: false, reason, errors: [reason] }.
      final rig = _Rig((r) async => jsonResponse(409, {'ok': false, 'reason': reason, 'errors': [reason]}));
      await expectLater(
        rig.repo.undoImport('12'),
        throwsA(
          isA<PrayerError>()
              .having((e) => e.kind, 'kind', PrayerFailure.conflict)
              .having((e) => e.status, 'status', 409)
              .having((e) => e.message, 'message', reason),
        ),
      );
    });

    test('undo refused (409) with no reason falls back to the BM conflict wording', () async {
      final rig = _Rig((r) async => jsonResponse(409, {'ok': false}));
      await expectLater(
        rig.repo.undoImport('12'),
        throwsA(isA<PrayerError>().having((e) => e.message, 'message', PrayerError.conflictMessage)),
      );
    });

    test('template paths and bytes', () async {
      final rig = _Rig((r) async => http.Response.bytes([1, 2, 3], 200));
      expect(PrayerRepository.templatePath('csv', 2027), '/api/prayer/template.csv?year=2027');
      expect(PrayerRepository.templatePath('xlsx', 2027), '/api/prayer/template.xlsx?year=2027');
      expect(() => PrayerRepository.templatePath('pdf', 2027), throwsArgumentError);
      final b = await rig.repo.templateBytes('xlsx', 2027);
      expect(b, [1, 2, 3]);
      expect(rig.last.url.path, '/api/prayer/template.xlsx');
      expect(rig.last.url.queryParameters['year'], '2027');
    });
  });

  group('errors', () {
    Future<PrayerError> failWith(int status, Object body, Future<void> Function(PrayerRepository r) call) async {
      final rig = _Rig((r) async => jsonResponse(status, body));
      try {
        await call(rig.repo);
      } on PrayerError catch (e) {
        return e;
      }
      fail('no PrayerError');
    }

    test('search: 429 is rate limited, 503 is offline, 400 keeps the box wording', () async {
      final limited = await failWith(429, {'errors': ['x']}, (r) => r.searchLocation('a'));
      expect(limited.kind, PrayerFailure.rateLimited);
      expect(limited.message, PrayerError.rateLimitedMessage);

      final off = await failWith(503, {'reason': 'offline', 'errors': ['x']}, (r) => r.searchLocation('a'));
      expect(off.kind, PrayerFailure.offline);
      expect(off.message, PrayerError.offlineMessage);

      final bad = await failWith(400, {'errors': ['Nama tempat terlalu pendek']}, (r) => r.searchLocation('a'));
      expect(bad.kind, PrayerFailure.invalid);
      expect(bad.message, 'Nama tempat terlalu pendek');
    });

    test('zone refresh upstream failure (502) reads in BM', () async {
      final e = await failWith(502, {'errors': ['bad gateway']}, (r) => r.refreshZones());
      expect(e.kind, PrayerFailure.upstream);
      expect(e.message, contains('zon'));
    });

    test('403 and 404 use the fixed wording', () async {
      expect((await failWith(403, {'errors': ['x']}, (r) => r.status())).message, PrayerError.forbiddenMessage);
      expect((await failWith(404, {'errors': ['x']}, (r) => r.importDetail('9'))).kind, PrayerFailure.notFound);
    });

    test('no user message carries a dash, arrow or approximation sign', () {
      for (final m in [
        PrayerError.forbiddenMessage,
        PrayerError.notFoundMessage,
        PrayerError.rateLimitedMessage,
        PrayerError.offlineMessage,
        PrayerError.upstreamMessage,
        PrayerError.conflictMessage,
        PrayerError.unavailableMessage,
      ]) {
        expect(m, isNot(matches(RegExp('[–—→≈~]'))), reason: m);
        expect(m.toLowerCase(), isNot(contains('kotak')), reason: m);
      }
    });

    test('a lost session passes through and reaches the gateway handler', () async {
      final rig = _Rig((r) async => jsonResponse(401, {'errors': ['Sesi tamat']}));
      await expectLater(rig.repo.status(), throwsA(isA<SessionExpired>()));
      expect(rig.expired, 1);
    });

    test('an unreachable box is not turned into a PrayerError', () async {
      final rig = _Rig((r) async => throw http.ClientException('down'));
      await expectLater(rig.repo.status(), throwsA(isA<BoxUnreachable>()));
    });

  });
}
