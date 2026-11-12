import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/upload/resumable_client.dart';
import 'package:surau_app/upload/upload_loop.dart';
import 'package:surau_app/upload/upload_queue.dart';

class _Cloud implements UploadApi {
  final List<UploadBeginRequest> begins = [];
  final List<(String, String)> dones = [];
  Object? beginError;
  Object? doneError;
  int n = 0;

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async {
    begins.add(r);
    final e = beginError;
    if (e != null) throw e;
    n++;
    return UploadBegun(
      uploadId: 'up$n',
      uploadUri: 'https://www.googleapis.com/upload/session/$n',
      expiresAt: DateTime.utc(2026, 11, 13),
      title: 't',
    );
  }

  @override
  Future<void> done(String uploadId, String videoId) async {
    final e = doneError;
    if (e != null) throw e;
    dones.add((uploadId, videoId));
  }

  @override
  Future<UploadQuotaInfo> quota() async => UploadQuotaInfo(
    uploadsToday: 100,
    uploadLimit: 100,
    resetsAt: DateTime.utc(2026, 11, 7, 8),
  );
}

/// A cloud that answers `begin` with an address of its own choosing.
class _BadUriCloud extends _Cloud {
  _BadUriCloud(this.uri);
  final String uri;

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async => UploadBegun(
    uploadId: 'upBad',
    uploadUri: uri,
    expiresAt: DateTime.utc(2026, 11, 13),
    title: 't',
  );
}

class _Mem implements SliceSource {
  _Mem(int n) : bytes = Uint8List(n);
  final Uint8List bytes;
  @override
  int get length => bytes.length;
  @override
  Future<Uint8List> slice(int s, int e) async =>
      Uint8List.sublistView(bytes, s, e);
}

http.Response _ok(String id) => http.Response(jsonEncode({'id': id}), 200);

UploadJob _job({List<UploadPart>? parts, String? replace, int n = 1}) =>
    UploadJob(
      id: 'J',
      sessionId: 's',
      kuliahId: 'k',
      parts:
          parts ??
          [
            for (var i = 1; i <= n; i++)
              UploadPart(index: i, source: 'web:$i', bytes: 100),
          ],
      joined: false,
      allowMobile: false,
      createdAt: DateTime.utc(2026, 11, 6),
      replaceLiveVideoId: replace,
    );

void main() {
  late _Cloud cloud;
  late List<UploadEvent> events;

  UploadLoop loop(http.Client c) => UploadLoop(
    resumable: ResumableClient(client: c, sleep: (_) async {}),
    openSource: (_) async => _Mem(100),
    emit: events.add,
  );

  UploadAuth auth() => UploadAuth(
    api: cloud,
    base: Uri.parse('https://cloud.example'),
    token: 't',
  );

  setUp(() {
    cloud = _Cloud();
    events = [];
  });

  test('a single part is begun without a part ref; done is called once', () async {
    await loop(MockClient((_) async => _ok('v1'))).run(
      _job(replace: 'live1'),
      auth(),
      shouldStop: () => false,
    );
    expect(cloud.begins.single.part, isNull);
    expect(cloud.begins.single.replaceLiveVideoId, 'live1');
    expect(cloud.dones, [('up1', 'v1')]);
  });

  test('only the last part carries replaceLiveVideoId', () async {
    await loop(MockClient((_) async => _ok('v'))).run(
      _job(n: 2, replace: 'live1'),
      auth(),
      shouldStop: () => false,
    );
    expect(cloud.begins.map((b) => b.replaceLiveVideoId), [null, 'live1']);
  });

  test('a 410 on the session starts a fresh session from the cloud', () async {
    var puts = 0;
    final c = MockClient((r) async {
      puts++;
      return puts == 1 ? http.Response('', 410) : _ok('v2');
    });
    await loop(c).run(_job(), auth(), shouldStop: () => false);
    expect(cloud.begins, hasLength(2));
    expect(cloud.dones, [('up2', 'v2')]);
    expect(
      events.any((e) => e.clearSession && e.state == UploadPartState.queued),
      isTrue,
    );
  });

  test('a stored session is probed before sending and resumes there', () async {
    final seen = <String>[];
    final c = MockClient((r) async {
      seen.add(r.headers['content-range'] ?? '');
      if (seen.length == 1) {
        return http.Response('', 308, headers: {'range': 'bytes=0-59'});
      }
      return _ok('v3');
    });
    final job = _job(
      parts: [
        const UploadPart(
          index: 1,
          source: 'web:1',
          bytes: 100,
          uploadId: 'upX',
          uploadUri: 'https://www.googleapis.com/upload/session/X',
          offset: 10,
          state: UploadPartState.queued,
        ),
      ],
    );
    await loop(c).run(job, auth(), shouldStop: () => false);
    expect(cloud.begins, isEmpty);
    expect(seen, ['bytes */100', 'bytes 60-99/100']);
    expect(cloud.dones, [('upX', 'v3')]);
  });

  group('the upload address must be Google (S1)', () {
    test('only https on googleapis.com or a subdomain passes', () {
      for (final ok in [
        'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x',
        'https://upload.googleapis.com/x',
        'https://a.b.googleapis.com/x',
        'https://WWW.GOOGLEAPIS.COM/x',
      ]) {
        expect(isYoutubeUploadUri(ok), isTrue, reason: ok);
      }
      for (final bad in [
        'http://www.googleapis.com/x',
        'https://evil.example/x',
        'https://googleapis.com.evil.example/x',
        'https://evilgoogleapis.com/x',
        'https://googleapis.com/x',
        'https://www.googleapis.com@evil.example/x',
        'https://user:pw@www.googleapis.com/x',
        'ftp://www.googleapis.com/x',
        '//www.googleapis.com/x',
        '/upload/x',
        '',
        'not a uri',
      ]) {
        expect(isYoutubeUploadUri(bad), isFalse, reason: bad);
      }
    });

    test('a begin answer pointing elsewhere fails the part, nothing is sent',
        () async {
      var puts = 0;
      final bad = _BadUriCloud('https://evil.example/steal');
      final c = MockClient((_) async {
        puts++;
        return _ok('v');
      });
      await loop(c).run(
        _job(),
        UploadAuth(
          api: bad,
          base: Uri.parse('https://cloud.example'),
          token: 't',
        ),
        shouldStop: () => false,
      );
      expect(puts, 0);
      final last = events.last;
      expect(last.state, UploadPartState.failed);
      expect(last.error, 'bad_upload_uri');
      expect(events.map((e) => e.toString()).join(), isNot(contains('evil')));
      expect(bad.dones, isEmpty);
    });

    test('plain http fails the same way', () async {
      var puts = 0;
      final c = MockClient((_) async {
        puts++;
        return _ok('v');
      });
      await loop(c).run(
        _job(),
        UploadAuth(
          api: _BadUriCloud('http://www.googleapis.com/upload/x'),
          base: Uri.parse('https://cloud.example'),
          token: 't',
        ),
        shouldStop: () => false,
      );
      expect(puts, 0);
      expect(events.last.error, 'bad_upload_uri');
    });

    test('a stored session address that is not Google is never probed or sent to',
        () async {
      var puts = 0;
      final c = MockClient((_) async {
        puts++;
        return _ok('v');
      });
      final job = _job(
        parts: [
          const UploadPart(
            index: 1,
            source: 'web:1',
            bytes: 100,
            uploadId: 'upX',
            uploadUri: 'https://evil.example/resume',
            offset: 10,
            state: UploadPartState.queued,
          ),
        ],
      );
      await loop(c).run(job, auth(), shouldStop: () => false);
      expect(puts, 0);
      expect(cloud.begins, isEmpty);
      expect(events.last.state, UploadPartState.failed);
      expect(events.last.error, 'bad_upload_uri');
      expect(events.last.clearSession, isTrue);
    });
  });

  test('a mid-upload quota answer stops with the cloud reset time', () async {
    final c = MockClient(
      (_) async => http.Response(
        jsonEncode({
          'error': {
            'errors': [
              {'reason': 'uploadLimitExceeded'},
            ],
          },
        }),
        403,
      ),
    );
    await loop(c).run(_job(n: 2), auth(), shouldStop: () => false);
    final q = events.lastWhere((e) => e.state == UploadPartState.quota);
    expect(q.resetsAt, DateTime.utc(2026, 11, 7, 8));
    expect(cloud.begins, hasLength(1), reason: 'the second part never starts');
    expect(cloud.dones, isEmpty);
  });

  test('begin answering youtube_quota stops with its resetsAt', () async {
    cloud.beginError = UploadQuotaException(DateTime.utc(2026, 11, 7, 7));
    await loop(MockClient((_) async => _ok('v'))).run(
      _job(),
      auth(),
      shouldStop: () => false,
    );
    expect(events.last.state, UploadPartState.quota);
    expect(events.last.resetsAt, DateTime.utc(2026, 11, 7, 7));
  });

  test('begin answering youtube_reauthorise fails with its code', () async {
    cloud.beginError = const UploadApiException('youtube_reauthorise');
    await loop(MockClient((_) async => _ok('v'))).run(
      _job(),
      auth(),
      shouldStop: () => false,
    );
    expect(events.last.state, UploadPartState.failed);
    expect(events.last.error, 'youtube_reauthorise');
  });

  test('if done fails the video id is kept so a retry only calls done', () async {
    cloud.doneError = const UploadApiException('done_503');
    await loop(MockClient((_) async => _ok('v9'))).run(
      _job(),
      auth(),
      shouldStop: () => false,
    );
    final f = events.last;
    expect(f.state, UploadPartState.failed);
    expect(f.videoId, 'v9');

    cloud.doneError = null;
    var puts = 0;
    final retryJob = _job(
      parts: [
        const UploadPart(
          index: 1,
          source: 'web:1',
          bytes: 100,
          uploadId: 'up1',
          videoId: 'v9',
          offset: 100,
        ),
      ],
    );
    await loop(MockClient((_) async {
      puts++;
      return _ok('x');
    })).run(retryJob, auth(), shouldStop: () => false);
    expect(puts, 0, reason: 'no bytes are sent again');
    expect(cloud.dones, [('up1', 'v9')]);
  });

  test('no event ever carries a token', () async {
    await loop(MockClient((_) async => _ok('v'))).run(
      _job(),
      auth(),
      shouldStop: () => false,
    );
    expect(events.map((e) => e.toString()).join(), isNot(contains('googleapis.com')));
  });
}
