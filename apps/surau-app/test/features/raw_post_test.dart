// The raw-body post: the client and the gateway send bytes with their own
// content type, with the JSON post's bearer token and error mapping.

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
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
  _Rig(Future<http.Response> Function(http.Request r) handler) {
    box = FakeBox(handler);
    gateway = BoxGateway(
      client: box.client(Uri.parse('https://127.0.0.1:8443')),
      token: 'tok-1',
      cache: ReadCache(),
      reach: _Reach(),
      now: () => _t0,
      onSessionExpired: () => expired++,
    );
  }

  late final FakeBox box;
  late final BoxGateway gateway;
  int expired = 0;
}

const _path = '/api/themes/check';
const _type = 'application/octet-stream';

void main() {
  final bytes = Uint8List.fromList([0x50, 0x4b, 3, 4, 9, 9]);

  test('the client sends the bytes with the given content type and the bearer token', () async {
    final rig = _Rig((r) async => jsonResponse(200, {'ok': true}));
    final out = await rig.box.client(Uri.parse('https://127.0.0.1:8443')).postRaw(_path, bytes, _type, token: 't');
    expect(out, {'ok': true});
    final r = rig.box.seen.last;
    expect(r.method, 'POST');
    expect(r.url.path, _path);
    expect(r.headers['content-type'], startsWith(_type));
    expect(r.headers['authorization'], 'Bearer t');
    expect(r.bodyBytes, bytes);
  });

  test('the gateway posts the bytes with its session token', () async {
    final rig = _Rig((r) async => jsonResponse(200, {'ok': true}));
    final out = await rig.gateway.postRaw(_path, bytes, _type);
    expect(out, {'ok': true});
    final r = rig.box.seen.last;
    expect(r.headers['content-type'], startsWith(_type));
    expect(r.headers['authorization'], 'Bearer tok-1');
    expect(r.bodyBytes, bytes);
  });

  test('a refusal with a reason surfaces as a typed error carrying that reason', () async {
    final rig = _Rig((r) async => jsonResponse(400, {'errors': ['File is damaged']}));
    await expectLater(
      rig.gateway.postRaw(_path, bytes, _type),
      throwsA(isA<BoxError>().having((e) => e.status, 'status', 400).having((e) => e.message, 'message', 'File is damaged')),
    );
  });

  test('a body over the server limit (413) and a wrong type (415) keep their status', () async {
    final big = _Rig((r) async => jsonResponse(413, {'errors': ['Request body is too large']}));
    await expectLater(
      big.gateway.postRaw(_path, bytes, _type),
      throwsA(isA<BoxError>().having((e) => e.status, 'status', 413).having((e) => e.message, 'message', 'Request body is too large')),
    );
    final type = _Rig((r) async => jsonResponse(415, {'errors': ['Unsupported Media Type']}));
    await expectLater(
      type.gateway.postRaw(_path, bytes, _type),
      throwsA(isA<BoxError>().having((e) => e.status, 'status', 415).having((e) => e.message, 'message', 'Unsupported Media Type')),
    );
  });

  test('a 401 reaches the session-expired hook, as with the JSON post', () async {
    final rig = _Rig((r) async => jsonResponse(401, {'errors': ['x']}));
    await expectLater(rig.gateway.postRaw(_path, bytes, _type), throwsA(isA<SessionExpired>()));
    expect(rig.expired, 1);
  });
}
