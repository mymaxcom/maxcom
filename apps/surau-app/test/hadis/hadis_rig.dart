// A fake box for the hadis controllers: the real gateway and repository over
// a MockClient that answers `/api/hadis/*` and `/api/content/hadis` from
// in-memory state, recording every request.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/hadis/hadis_api.dart';
import 'package:surau_app/hadis/hadis_providers.dart';

import '../features/fakes.dart';

class Reach implements ReachSink {
  BoxReach state = BoxReach.unknown;

  @override
  BoxReach get reach => state;

  @override
  void markUp(DateTime at) => state = state.up(at);

  @override
  void markDown(DateTime at) => state = state.failed(at);
}

final DateTime t0 = DateTime.utc(2026, 11, 9, 4);

Map<String, dynamic> ext(String id) => {
  'provider': 'hadeethenc',
  'id': id,
  'attributionAr': 'رواه البخاري ومسلم',
  'gradeAr': 'صحيح',
  'categories': ['59'],
  'fetchedAt': '2026-11-09T01:00:00.000Z',
  'digest': 'a' * 64,
};

Map<String, dynamic> providerItem(
  String id, {
  int? order,
  bool? shown,
  String text = 'Teks hadis.',
}) => {
  'id': 'hadeethenc-$id',
  'textMs': text,
  'textAr': 'نص',
  'source': 'Muttafaq alaih',
  'title': 'Tajuk $id',
  'intro': 'Daripada A:',
  'grade': 'sahih',
  'shown': ?shown,
  'order': ?order,
  'ext': ext(id),
  'updatedAt': '2026-11-09T01:00:00.000Z',
  'updatedBy': 'user:u1',
};

Map<String, dynamic> ownItem(
  String id, {
  int? order,
  bool? shown,
  String text = 'Hadis sendiri.',
  String source = 'Riwayat Muslim',
  String updatedAt = '2026-11-01T00:00:00.000Z',
}) => {
  'id': id,
  'textMs': text,
  'source': source,
  'shown': ?shown,
  'order': ?order,
  'updatedAt': updatedAt,
  'updatedBy': 'user:u1',
};

/// The box. Change [items], [online] and the answers below, then read
/// [FakeBox.seen] for what the app sent.
class HadisRig {
  HadisRig() {
    box = FakeBox(_handle);
    gateway = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: ReadCache(),
      reach: reach,
      now: () => t0,
      onSessionExpired: () => expired++,
    );
    repo = HadisRepository(gateway);
    container = ProviderContainer(
      overrides: [
        hadisRepositoryProvider.overrideWithValue(repo),
        hadisTimingProvider.overrideWithValue(
          const HadisTiming(
            searchDebounce: Duration(milliseconds: 20),
            statusPoll: Duration(milliseconds: 40),
            jobPoll: Duration(milliseconds: 5),
          ),
        ),
      ],
    );
  }

  late final FakeBox box;
  late final BoxGateway gateway;
  late final HadisRepository repo;
  late final ProviderContainer container;
  final reach = Reach();
  int expired = 0;

  List<Map<String, dynamic>> items = [];
  bool online = true;
  bool unreachable = false;
  List<Map<String, dynamic>> categories = [];
  Map<String, List<Map<String, dynamic>>> categoryItems = {};
  List<Map<String, dynamic>> searchResults = [];
  Map<String, dynamic> detail = {};
  List<Map<String, dynamic>> updates = [];

  /// What `POST /api/hadis/add` answers: status and body.
  int addStatus = 201;
  Map<String, dynamic> addBody = {};

  /// Answers of `GET /api/hadis/jobs/j1`, one per call; the last repeats.
  List<Map<String, dynamic>> jobAnswers = [
    {'id': 'j1', 'state': 'done', 'progress': 1.0, 'done': 1, 'total': 1},
  ];
  int refreshStatus = 202;
  int _jobCall = 0;
  int statusCalls = 0;

  Map<String, dynamic> catalog = {
    'entries': 0,
    'categories': 0,
    'fetchedAt': null,
    'job': null,
  };

  void dispose() => container.dispose();

  List<http.Request> requests(String method, String path) => [
    for (final r in box.seen)
      if (r.method == method && r.url.path == path) r,
  ];

  /// While set, a category's item pages wait for it before answering.
  Completer<void>? categoryGate;

  Future<http.Response> _handle(http.Request r) async {
    if (unreachable) throw http.ClientException('no route');
    final path = r.url.path;
    final m = r.method;
    if (m == 'GET' && path == '/api/hadis/status') {
      statusCalls++;
      return jsonResponse(200, {
        'online': online,
        'catalog': catalog,
        'saved': items.length,
        'max': 500,
        'updates': updates.length,
      });
    }
    if (m == 'GET' && path == '/api/hadis/categories') {
      return jsonResponse(200, {'categories': categories});
    }
    final catItems = RegExp(r'^/api/hadis/categories/(\d+)/items$').firstMatch(path);
    if (m == 'GET' && catItems != null) {
      final gate = categoryGate;
      if (gate != null) await gate.future;
      final all = categoryItems[catItems.group(1)] ?? const [];
      final page = int.parse(r.url.queryParameters['page'] ?? '1');
      final per = int.parse(r.url.queryParameters['perPage'] ?? '30');
      final start = (page - 1) * per;
      return jsonResponse(200, {
        'items': all.skip(start).take(per).toList(),
        'total': all.length,
      });
    }
    if (m == 'GET' && path == '/api/hadis/search') {
      return jsonResponse(200, {'items': searchResults});
    }
    if (m == 'GET' && path.startsWith('/api/hadis/hadeethenc/')) {
      return jsonResponse(200, {'hadith': detail});
    }
    if (m == 'POST' && path == '/api/hadis/add') {
      return jsonResponse(addStatus, addBody);
    }
    if (m == 'PUT' && path == '/api/hadis/order') {
      final ids = (jsonDecode(r.body) as Map<String, dynamic>)['ids'] as List<dynamic>;
      final byId = {for (final i in items) i['id'] as String: i};
      items = [
        for (var k = 0; k < ids.length; k++)
          {...byId[ids[k]]!, 'order': (k + 1) * 1000},
      ];
      return jsonResponse(200, {'ok': true, 'count': ids.length});
    }
    if (m == 'GET' && path == '/api/hadis/updates') {
      return jsonResponse(200, {'updates': updates});
    }
    if (m == 'POST' && path.endsWith('/accept-update')) {
      return jsonResponse(200, {'item': <String, dynamic>{}, 'gradeBlocked': false});
    }
    if (m == 'POST' && path == '/api/hadis/refresh') {
      return refreshStatus == 202
          ? jsonResponse(202, {'jobId': 'j1'})
          : jsonResponse(refreshStatus, {'errors': ['x'], 'code': 'busy'});
    }
    if (m == 'GET' && path == '/api/hadis/jobs/j1') {
      final a = jobAnswers[_jobCall < jobAnswers.length ? _jobCall : jobAnswers.length - 1];
      _jobCall++;
      return jsonResponse(200, a);
    }
    if (m == 'GET' && path == '/api/content/hadis') {
      return jsonResponse(200, {'items': items});
    }
    final one = RegExp(r'^/api/content/hadis/([A-Za-z0-9_-]+)$').firstMatch(path);
    if (m == 'PUT' && one != null) {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      final id = one.group(1)!;
      // The box puts a HadeethEnc hadis's own text back under a body that has only shown / order.
      Map<String, dynamic> merged(Map<String, dynamic> old) =>
          old['ext'] is Map && body.keys.every((k) => k == 'shown' || k == 'order')
              ? {...old, ...body, 'id': id}
              : {...body, 'id': id};
      items = [
        for (final i in items) i['id'] == id ? merged(i) : i,
      ];
      return jsonResponse(200, {'item': merged(items.firstWhere((i) => i['id'] == id))});
    }
    if (m == 'DELETE' && one != null) {
      items = [
        for (final i in items)
          if (i['id'] != one.group(1)) i,
      ];
      return http.Response('', 204);
    }
    return jsonResponse(404, {'errors': ['not found: $m $path']});
  }
}
