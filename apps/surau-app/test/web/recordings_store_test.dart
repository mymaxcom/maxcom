@TestOn('browser')
library;

import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:web/web.dart' as web;

web.Blob blobOf(List<int> bytes, String mime) => web.Blob(
  [Uint8List.fromList(bytes).toJS].toJS,
  web.BlobPropertyBag(type: mime),
);

int _n = 0;
String freshDb() =>
    'test-recordings-${DateTime.now().microsecondsSinceEpoch}-${_n++}';

void main() {
  test('parts are joined into one file per segment, in order', () async {
    final db = freshDb();
    final store = openRecordingsStore(dbName: db);
    for (var i = 0; i < 3; i++) {
      await store.appendPart(
        sessionId: 's1',
        index: 0,
        mime: 'video/mp4',
        label: 'Kuliah Maghrib',
        chunk: blobOf([i, i, i], 'video/mp4'),
        size: 3,
      );
    }
    final seg = await store.finishSegment('s1', 0);
    expect(seg, isNotNull);
    expect(seg!.bytes, 9);
    expect(seg.mime, 'video/mp4');
    expect(seg.index, 0);
    final all = await store.forSession('s1');
    expect(all.map((e) => e.id), ['s1-0']);
    expect(await store.finishSegment('s1', 7), isNull);
  });

  test(
    'a reload lists the unsaved session, and a crash mid-segment is recovered',
    () async {
      final db = freshDb();
      final first = openRecordingsStore(dbName: db);
      await first.appendPart(
        sessionId: 'sx',
        index: 0,
        mime: 'video/mp4',
        label: 'a',
        chunk: blobOf([1, 2], 'video/mp4'),
        size: 2,
      );
      await first.finishSegment('sx', 0);
      // Segment 1 never finishes: the tab died.
      await first.appendPart(
        sessionId: 'sx',
        index: 1,
        mime: 'video/mp4',
        label: 'a',
        chunk: blobOf([3, 4, 5], 'video/mp4'),
        size: 3,
      );

      final reopened = openRecordingsStore(dbName: db);
      final pending = await reopened.pending();
      expect(pending.map((e) => e.id), ['sx-0', 'sx-1']);
      expect(pending.map((e) => e.bytes), [2, 3]);
    },
  );

  test('a segment being recorded now is not joined by pending()', () async {
    final store = openRecordingsStore(dbName: freshDb());
    await store.appendPart(
      sessionId: 'live',
      index: 0,
      mime: 'video/mp4',
      label: 'a',
      chunk: blobOf([1], 'video/mp4'),
      size: 1,
    );
    expect(await store.pending(), isEmpty);
    await store.finishSegment('live', 0);
    expect((await store.pending()).length, 1);
  });

  test('save downloads with the MAXCOM file name, markSaved hides it, delete removes it', () async {
    final names = <String>[];
    final store = openRecordingsStore(
      dbName: freshDb(),
      downloader: (name, blob) async {
        expect(blob, isA<web.Blob>());
        names.add(name);
      },
    );
    await store.appendPart(
      sessionId: 's2',
      index: 3,
      mime: 'video/mp4',
      label: 'Kuliah Maghrib!',
      chunk: blobOf([9, 9], 'video/mp4'),
      size: 2,
    );
    final seg = (await store.finishSegment('s2', 3))!;
    await store.save(seg.id);
    expect(
      names.single,
      matches(RegExp(r'^MAXCOM-\d{4}-\d{2}-\d{2}-Kuliah-Maghrib-3\.mp4$')),
    );
    expect(names.single, seg.fileName);

    await store.markSaved(seg.id);
    expect(await store.pending(), isEmpty);
    expect((await store.forSession('s2')).single.saved, isTrue);

    await store.delete(seg.id);
    expect(await store.forSession('s2'), isEmpty);
  });

  test('webm recordings keep a .webm name; the label is made safe', () {
    final s = SegmentInfo(
      id: 'a-0',
      sessionId: 'a',
      index: 0,
      mime: 'video/webm;codecs=vp8,opus',
      bytes: 1,
      createdAt: DateTime(2026, 11, 5, 21),
      label: '../x y',
    );
    expect(s.fileName, 'MAXCOM-2026-11-05-x-y-0.webm');
    expect(safeLabel(null), 'siaran');
    expect(safeLabel('###'), 'siaran');
  });
}
