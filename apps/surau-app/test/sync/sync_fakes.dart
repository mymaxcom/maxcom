// A small in-memory sync server and transport for the engine and gateway
// tests: it speaks `/api/sync/ops`, `/changes` and `/snapshot` the way the
// box does, with the verdicts the test decides.

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/sync/sync_engine.dart';

import '../features/fakes.dart';

class FakeSyncServer {
  /// Every `ops` request body, in order.
  final List<Map<String, dynamic>> opBatches = [];
  final List<String> paths = [];

  /// Decides each op's verdict; default: applied with a fresh rev.
  Map<String, dynamic> Function(Map<String, dynamic> op)? verdict;

  int seq = 0;
  List<Map<String, dynamic>> entries = [];
  Map<String, dynamic> snapshot = {
    'surauId': 'sdm',
    'boxId': '0123456789abcdef',
    'seq': 0,
    'settings': <String, dynamic>{},
    'content': <String, dynamic>{},
    'surauInfo': {'name': 'Surau'},
    'serverTime': '2026-11-05T10:00:00.000Z',
  };

  /// Set to fail every request with this status.
  int? failStatus;
  Map<String, String> failHeaders = const {};
  bool away = false;
  int snapshotCalls = 0;
  int changesCalls = 0;

  int _rev = 0;

  Map<String, dynamic> applied(Map<String, dynamic> op) => {
    'opId': op['opId'],
    'status': 'applied',
    'rev': '2026-11-05T10:00:00.${(++_rev).toString().padLeft(3, '0')}Z|dev-1',
    'reason': null,
    'winner': null,
  };

  Future<http.Response> handle(http.Request r) async {
    if (away) throw http.ClientException('away');
    paths.add('${r.method} ${r.url.path}');
    final f = failStatus;
    if (f != null) {
      return jsonResponse(f, {'state': 'waking'}, headers: failHeaders);
    }
    switch (r.url.path) {
      case '/api/sync/ops':
        final body = jsonDecode(r.body) as Map<String, dynamic>;
        opBatches.add(body);
        final ops = (body['ops'] as List).cast<Map<String, dynamic>>();
        return jsonResponse(200, {
          'results': [for (final o in ops) (verdict ?? applied)(o)],
          'seq': seq,
        });
      case '/api/sync/changes':
        changesCalls++;
        return jsonResponse(200, {
          'entries': entries,
          'next': null,
          'seq': seq,
          'head': seq,
        });
      case '/api/sync/snapshot':
        snapshotCalls++;
        return jsonResponse(200, snapshot);
      case '/api/health':
        return jsonResponse(200, {'ok': true, 'version': 1});
    }
    return jsonResponse(404, {
      'errors': ['tiada'],
    });
  }

  BoxClient client(Uri base) => BoxClient(base, MockClient(handle));
}

/// Hands the engine a link to [server] (or whatever [onConnect] throws).
class FakeTransport implements SyncTransport {
  FakeTransport(this.server, {this.via = 'box'});

  final FakeSyncServer server;
  final String via;
  Object? connectError;
  int connects = 0;

  @override
  Future<SyncLink> connect() async {
    connects++;
    final e = connectError;
    if (e != null) throw e;
    final base = Uri.parse('https://127.0.0.1:8443');
    return SyncLink(
      base: base,
      via: via,
      client: server.client(base),
      token: 'tok-1',
    );
  }
}

EnrolledBox syncBox() => fixtureBox();
