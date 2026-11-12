import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/upload/resumable_client.dart';

const int _mb8 = 8 * 1024 * 1024;

class _Seen {
  _Seen(this.method, this.headers, this.length);
  final String method;
  final Map<String, String> headers;
  final int length;
  String get range => headers['content-range'] ?? '';
}

/// Scripted answers, one per request, in order.
class _Script {
  _Script(this.answers);
  final List<Object> answers; // http.Response or Exception
  final List<_Seen> seen = [];

  Future<http.Response> call(http.Request r) async {
    seen.add(_Seen(r.method, r.headers, r.bodyBytes.length));
    if (answers.isEmpty) throw StateError('unscripted request');
    final a = answers.removeAt(0);
    if (a is http.Response) return a;
    throw a;
  }
}

http.Response _r308([String? range]) =>
    http.Response('', 308, headers: {'range': ?range});

http.Response _done(String id) => http.Response(
  jsonEncode({'kind': 'youtube#video', 'id': id}),
  200,
  headers: {'content-type': 'application/json'},
);

http.Response _err(int status, [String reason = '']) => http.Response(
  jsonEncode({
    'error': {
      'code': status,
      'errors': [
        if (reason.isNotEmpty) {'reason': reason},
      ],
    },
  }),
  status,
  headers: {'content-type': 'application/json'},
);

ResumableClient _client(_Script s, List<Duration> slept, {int? chunk}) =>
    ResumableClient(
      client: MockClient(s.call),
      chunkSize: chunk ?? _mb8,
      sleep: (d) async => slept.add(d),
    );

void main() {
  final uri = Uri.parse('https://upload.example/session/abc');

  test('first PUT carries Content-Range for the first 8 MB chunk', () async {
    final total = 20 * 1024 * 1024;
    final s = _Script([
      _r308('bytes=0-${_mb8 - 1}'),
      _r308('bytes=0-${2 * _mb8 - 1}'),
      _done('vid1'),
    ]);
    final out = await _client(
      s,
      [],
    ).upload(uri, MemoryByteSource(Uint8List(total)));
    expect(s.seen.first.method, 'PUT');
    expect(s.seen.first.range, 'bytes 0-${_mb8 - 1}/$total');
    expect(s.seen.first.length, _mb8);
    expect(s.seen[1].range, 'bytes $_mb8-${2 * _mb8 - 1}/$total');
    expect(s.seen[2].range, 'bytes ${2 * _mb8}-${total - 1}/$total');
    expect(out, isA<UploadComplete>());
    expect((out as UploadComplete).videoId, 'vid1');
  });

  test('a 308 with Range continues after the last received byte', () async {
    final total = 3 * _mb8;
    // YouTube kept only part of the chunk.
    final s = _Script([
      _r308('bytes=0-99'),
      _r308('bytes=0-${_mb8 + 99}'),
      _r308('bytes=0-${total - 1}'),
      _done('v'),
    ]);
    final seen = <int>[];
    await _client(
      s,
      [],
    ).upload(uri, MemoryByteSource(Uint8List(total)), onProgress: seen.add);
    expect(s.seen[1].range, startsWith('bytes 100-'));
    expect(s.seen[2].range, startsWith('bytes ${_mb8 + 100}-'));
    expect(seen.first, 100);
  });

  test('a 308 continues at 8388608 after a full first chunk', () async {
    final total = 2 * _mb8 + 5;
    final s = _Script([_r308('bytes=0-${_mb8 - 1}'), _done('v')]);
    await _client(
      s,
      [],
      chunk: _mb8,
    ).upload(uri, MemoryByteSource(Uint8List(total)));
    expect(s.seen[1].range, startsWith('bytes 8388608-'));
  });

  test(
    'probe asks bytes */total with an empty body and reads the offset',
    () async {
      final s = _Script([_r308('bytes=0-4194303')]);
      final out = await _client(s, []).probe(uri, 10000000);
      expect(s.seen.single.method, 'PUT');
      expect(s.seen.single.range, 'bytes */10000000');
      expect(s.seen.single.length, 0);
      expect((out as UploadOffset).offset, 4194304);
    },
  );

  test('probe with no Range header means nothing was received', () async {
    final s = _Script([_r308()]);
    expect(((await _client(s, []).probe(uri, 50)) as UploadOffset).offset, 0);
  });

  test(
    'after a thrown request the client probes and resumes from the 308 offset',
    () async {
      final total = 3 * _mb8;
      final s = _Script([
        _r308('bytes=0-${_mb8 - 1}'),
        http.ClientException('connection reset'),
        _r308('bytes=0-${_mb8 - 1}'), // probe: server has the first chunk
        _r308('bytes=0-${2 * _mb8 - 1}'),
        _done('after-resume'),
      ]);
      final slept = <Duration>[];
      final out = await _client(
        s,
        slept,
      ).upload(uri, MemoryByteSource(Uint8List(total)));
      expect(slept, [const Duration(seconds: 5)]);
      expect(s.seen[2].range, 'bytes */$total');
      expect(s.seen[3].range, 'bytes $_mb8-${2 * _mb8 - 1}/$total');
      expect((out as UploadComplete).videoId, 'after-resume');
    },
  );

  test('404 and 410 on the session URI are session_lost', () async {
    for (final code in [404, 410]) {
      final s = _Script([_err(code)]);
      final out = await _client(
        s,
        [],
      ).upload(uri, MemoryByteSource(Uint8List(100)));
      expect(out, isA<UploadSessionLost>(), reason: '$code');
    }
    final s = _Script([_err(410)]);
    expect(await _client(s, []).probe(uri, 100), isA<UploadSessionLost>());
  });

  test('403 uploadLimitExceeded and quotaExceeded are quota', () async {
    for (final reason in ['uploadLimitExceeded', 'quotaExceeded']) {
      final s = _Script([_err(403, reason)]);
      final out = await _client(
        s,
        [],
      ).upload(uri, MemoryByteSource(Uint8List(100)));
      expect(out, isA<UploadQuotaHit>(), reason: reason);
      expect((out as UploadQuotaHit).reason, reason);
    }
  });

  test('another 403 is a refusal, not a retry loop', () async {
    final s = _Script([_err(403, 'forbidden')]);
    final out = await _client(
      s,
      [],
    ).upload(uri, MemoryByteSource(Uint8List(100)));
    expect(out, isA<UploadRejected>());
    expect((out as UploadRejected).status, 403);
    expect(s.seen, hasLength(1));
  });

  test('201 with the video JSON finishes with the video id', () async {
    final s = _Script([http.Response(jsonEncode({'id': 'abc123'}), 201)]);
    final out = await _client(
      s,
      [],
    ).upload(uri, MemoryByteSource(Uint8List(100)));
    expect((out as UploadComplete).videoId, 'abc123');
  });

  test('5xx retries after 5 s, then 15 s, then 60 s, then 5 min', () async {
    final s = _Script([
      _err(503), // PUT
      _err(500), // probe
      _err(502), // probe
      _err(503), // probe
      _err(503), // probe, backoff stays at 5 min
      _r308(), // probe: nothing received
      _done('late'),
    ]);
    final slept = <Duration>[];
    final out = await _client(
      s,
      slept,
    ).upload(uri, MemoryByteSource(Uint8List(100)));
    expect(slept, const [
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 60),
      Duration(minutes: 5),
      Duration(minutes: 5),
    ]);
    expect(out, isA<UploadComplete>());
  });

  test('shouldStop ends the loop with the offset reached', () async {
    final total = 3 * _mb8;
    final s = _Script([_r308('bytes=0-${_mb8 - 1}')]);
    var calls = 0;
    final out = await _client(s, []).upload(
      uri,
      MemoryByteSource(Uint8List(total)),
      shouldStop: () => ++calls > 1,
    );
    expect((out as UploadStopped).offset, _mb8);
  });

  test('resuming from an offset starts the Content-Range there', () async {
    final s = _Script([_done('v')]);
    await _client(
      s,
      [],
    ).upload(uri, MemoryByteSource(Uint8List(1000)), offset: 600);
    expect(s.seen.single.range, 'bytes 600-999/1000');
    expect(s.seen.single.length, 400);
  });
}
