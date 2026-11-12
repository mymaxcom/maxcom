@TestOn('browser')
library;

import 'dart:convert';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/upload/upload_queue.dart';
import 'package:surau_app/upload/upload_runner_web.dart';
import 'package:web/web.dart' as web;

class _FakeCloud implements UploadApi {
  final List<UploadBeginRequest> begins = [];
  final List<(String, String)> dones = [];

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async {
    begins.add(r);
    return UploadBegun(
      uploadId: 'up${r.part?.index ?? 0}',
      uploadUri: 'https://www.googleapis.com/upload/s/${r.part?.index ?? 0}',
      expiresAt: DateTime.utc(2026, 11, 13),
      title: 'Kuliah',
    );
  }

  @override
  Future<void> done(String uploadId, String videoId) async =>
      dones.add((uploadId, videoId));

  @override
  Future<UploadQuotaInfo> quota() async => UploadQuotaInfo(
    uploadsToday: 1,
    uploadLimit: 100,
    resetsAt: DateTime.utc(2026, 11, 7, 8),
  );
}

class _SpySlices implements SliceSource {
  _SpySlices(this.bytes);
  final Uint8List bytes;
  final List<(int, int)> slices = [];

  @override
  int get length => bytes.length;

  @override
  Future<Uint8List> slice(int start, int end) async {
    slices.add((start, end));
    return Uint8List.sublistView(bytes, start, end);
  }
}

void main() {
  test('each segment is one video, begun with part {i, n}, read in slices, and done posts the video id', () async {
    final cloud = _FakeCloud();
    final spies = <String, _SpySlices>{
      'seg-a': _SpySlices(Uint8List(10)),
      'seg-b': _SpySlices(Uint8List(10)),
      'seg-c': _SpySlices(Uint8List(10)),
    };
    final puts = <String>[];
    final client = MockClient((http.Request r) async {
      puts.add(r.headers['content-range'] ?? '');
      final m = RegExp(r'bytes (\d+)-(\d+)/(\d+)').firstMatch(puts.last);
      if (m != null && int.parse(m.group(2)!) + 1 == int.parse(m.group(3)!)) {
        return http.Response(jsonEncode({'id': 'vid-${r.url.pathSegments.last}'}), 200);
      }
      return http.Response('', 308, headers: {'range': 'bytes=0-${m!.group(2)}'});
    });
    final runner = WebUploadRunner(
      openSource: (id) async => spies[id.substring(4)]!,
      httpClient: client,
      chunkSize: 4,
    );
    final events = <UploadEvent>[];
    runner.events.listen(events.add);
    final job = UploadJob(
      id: 'J1',
      sessionId: 's1',
      kuliahId: 'k1',
      parts: [
        for (final (i, s) in ['seg-a', 'seg-b', 'seg-c'].indexed)
          UploadPart(index: i + 1, source: 'web:$s', bytes: 10),
      ],
      joined: false,
      allowMobile: false,
      createdAt: DateTime.utc(2026, 11, 6),
    );
    await runner.start(
      job,
      UploadAuth(api: cloud, base: Uri.parse('https://cloud.example'), token: 't'),
    );

    expect(cloud.begins.map((b) => (b.part?.index, b.part?.count)), [
      (1, 3),
      (2, 3),
      (3, 3),
    ]);
    expect(cloud.begins.every((b) => b.kuliahId == 'k1' && b.bytes == 10), isTrue);
    expect(spies['seg-a']!.slices, [(0, 4), (4, 8), (8, 10)]);
    expect(spies.values.every((s) => s.slices.every((x) => x.$2 - x.$1 <= 4)), isTrue);
    expect(cloud.dones, [('up1', 'vid-1'), ('up2', 'vid-2'), ('up3', 'vid-3')]);
    expect(events.where((e) => e.state == UploadPartState.done).length, 3);
  });

  test('a blob is read in slices, never whole', () async {
    final blob = web.Blob(
      [Uint8List.fromList(List.generate(10, (i) => i)).toJS].toJS,
    );
    final src = BlobSliceSource(blob);
    expect(src.length, 10);
    expect(await src.slice(3, 7), [3, 4, 5, 6]);
  });
}
