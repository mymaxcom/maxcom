import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/session_files.dart';
import 'package:surau_app/upload/recording_cleanup.dart';
import 'package:surau_app/upload/recording_remover.dart';

Future<void> _segment(
  RecordingsStore s,
  String session,
  int index, {
  int size = 100,
}) async {
  await s.appendPart(
    sessionId: session,
    index: index,
    mime: 'video/mp4',
    label: 'k1',
    chunk: Object(),
    size: size,
  );
  await s.finishSegment(session, index);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('web: only that session\'s segments', () {
    test('the footprint lists the session\'s files and sizes', () async {
      final store = MemoryRecordingsStore();
      await _segment(store, 'a', 1, size: 100);
      await _segment(store, 'a', 2, size: 250);
      await _segment(store, 'b', 1, size: 999);
      final r = WebRecordingRemover(store);
      final fp = (await r.footprint('a', 'k1'))!;
      expect(fp.names, ['a-1', 'a-2']);
      expect(fp.sizes, [100, 250]);
      expect(fp.bytes, 350);
      expect(await r.footprint('nothing', null), isNull);
    });

    test('remove deletes those segments and no other session\'s', () async {
      final store = MemoryRecordingsStore();
      await _segment(store, 'a', 1);
      await _segment(store, 'a', 2);
      await _segment(store, 'b', 1);
      final r = WebRecordingRemover(store);
      final fp = (await r.footprint('a', null))!;
      final out = await r.remove('a', fp);
      expect(out.deleted, 2);
      expect(out.skipped, 0);
      expect(out.bytes, 200);
      expect(await store.forSession('a'), isEmpty);
      expect((await store.forSession('b')), hasLength(1));
    });

    test('a name that belongs to another session is never deleted', () async {
      final store = MemoryRecordingsStore();
      await _segment(store, 'a', 1);
      await _segment(store, 'b', 1);
      final r = WebRecordingRemover(store);
      final out = await r.remove(
        'a',
        const RecordingFootprint(names: ['a-1', 'b-1'], bytes: 200),
      );
      expect(out.deleted, 1);
      expect(await store.forSession('b'), hasLength(1));
    });
  });

  group('android: by name through the channel', () {
    const channel = MethodChannel('my.maxcom/upload');
    final calls = <MethodCall>[];
    Object? Function(MethodCall) handler = (_) => null;

    setUp(() {
      calls.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (c) async {
            calls.add(c);
            return handler(c);
          });
    });
    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    // A fake MediaStore: the files on the device, answered by the names asked.
    final onDevice = <Map<String, Object>>[
      // an earlier same-day live that was never registered
      {'uri': 'content://x/1', 'name': 'MAXCOM-2026-11-06-1015-k1-01.mp4', 'bytes': 5},
      // the older scheme
      {'uri': 'content://x/2', 'name': 'MAXCOM-2026-11-06-k1-01.mp4', 'bytes': 6},
      // MediaStore's rename of a clash
      {'uri': 'content://x/3', 'name': 'MAXCOM-2026-11-06-1015-k1-01 (1).mp4', 'bytes': 7},
      // this live
      {'uri': 'content://x/4', 'name': 'MAXCOM-2026-11-06-1140-k1-01.mp4', 'bytes': 9},
      {'uri': 'content://x/5', 'name': 'MAXCOM-2026-11-06-1140-k1-02.mp4', 'bytes': 11},
    ];
    Object? mediaStore(MethodCall c) {
      if (c.method != 'findSegments') return null;
      final asked = ((c.arguments as Map)['names'] as List).cast<String>();
      return [
        for (final n in asked)
          for (final f in onDevice)
            if (f['name'] == n) f,
      ];
    }

    Future<AndroidRecordingRemover> remover({
      Map<String, List<String>> stored = const {},
    }) async {
      final store = MemoryLocalStore();
      await store.open('box1');
      final files = SessionFiles(store);
      for (final e in stored.entries) {
        await files.save(e.key, e.value);
      }
      return AndroidRecordingRemover(sessionFiles: files);
    }

    test('the footprint is exactly the names stored for that session', () async {
      handler = mediaStore;
      final r = await remover(stored: {
        's2': [
          'MAXCOM-2026-11-06-1140-k1-01.mp4',
          'MAXCOM-2026-11-06-1140-k1-02.mp4',
        ],
      });
      final fp = (await r.footprint('s2', 'k1'))!;
      expect(fp.names, [
        'MAXCOM-2026-11-06-1140-k1-01.mp4',
        'MAXCOM-2026-11-06-1140-k1-02.mp4',
      ]);
      expect(fp.sizes, [9, 11]);
      expect(fp.bytes, 20);
      expect(calls.single.method, 'findSegments');
      expect(calls.single.arguments, {
        'names': [
          'MAXCOM-2026-11-06-1140-k1-01.mp4',
          'MAXCOM-2026-11-06-1140-k1-02.mp4',
        ],
      });
      expect(fp.toString().contains('content://'), isFalse);
    });

    test('an unregistered earlier file of the same day and prefix is never in the footprint',
        () async {
      handler = mediaStore;
      final r = await remover(stored: {
        's2': ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
      });
      final fp = (await r.footprint('s2', 'k1'))!;
      expect(fp.names, ['MAXCOM-2026-11-06-1140-k1-01.mp4']);
      // the earlier live's file was not asked for, so it is not even looked at
      expect(
        (calls.single.arguments as Map)['names'],
        isNot(contains('MAXCOM-2026-11-06-1015-k1-01.mp4')),
      );
    });

    test('a renamed "(1)" file and the older scheme are never in a footprint',
        () async {
      handler = mediaStore;
      // even a hand-made doc is read through the same filter
      final store = MemoryLocalStore();
      await store.open('box1');
      await store.putDoc(Collections.sessionFiles, 's3', {
        'sessionId': 's3',
        'names': [
          'MAXCOM-2026-11-06-1015-k1-01 (1).mp4',
          'MAXCOM-2026-11-06-k1-01.mp4',
        ],
      });
      final r = AndroidRecordingRemover(sessionFiles: SessionFiles(store));
      expect(await r.footprint('s3', 'k1'), isNull);
      expect(calls, isEmpty);
    });

    test('a session with no stored names has no footprint and nothing is asked',
        () async {
      handler = mediaStore;
      final r = await remover();
      expect(await r.footprint('unknown', 'k1'), isNull);
      expect(calls, isEmpty);
      // and a remover with no store at all
      expect(await AndroidRecordingRemover().footprint('s', 'k1'), isNull);
    });

    test('the device answering with a file that was not asked for is ignored',
        () async {
      handler = (c) => onDevice; // a careless answer: every file
      final r = await remover(stored: {
        's2': ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
      });
      final fp = (await r.footprint('s2', 'k1'))!;
      expect(fp.names, ['MAXCOM-2026-11-06-1140-k1-01.mp4']);
    });

    test('no files, or the channel missing: no footprint', () async {
      handler = (_) => <dynamic>[];
      final r = await remover(stored: {
        's2': ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
      });
      expect(await r.footprint('s2', 'k1'), isNull);
    });

    test('a renamed "(1)" file is never sent for deletion', () async {
      handler = (_) => {'deleted': 1, 'skipped': 0, 'bytes': 9};
      await AndroidRecordingRemover().remove(
        's',
        const RecordingFootprint(
          names: [
            'MAXCOM-2026-11-06-1140-k1-01 (1).mp4',
            'MAXCOM-2026-11-06-k1-01.mp4',
            'MAXCOM-2026-11-06-1140-k1-01.mp4',
          ],
          bytes: 9,
        ),
      );
      expect(calls.single.arguments, {
        'names': ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
      });
    });

    test('remove sends names only, never an address', () async {
      handler = (_) => {'deleted': 2, 'skipped': 0, 'bytes': 16};
      final out = await AndroidRecordingRemover().remove(
        's',
        const RecordingFootprint(
          names: ['MAXCOM-2026-11-06-1140-k1-01.mp4', 'MAXCOM-2026-11-06-1140-k1-02.mp4'],
          bytes: 16,
        ),
      );
      expect(out.deleted, 2);
      expect(out.bytes, 16);
      final c = calls.single;
      expect(c.method, 'deleteRecordings');
      expect(c.arguments, {
        'names': ['MAXCOM-2026-11-06-1140-k1-01.mp4', 'MAXCOM-2026-11-06-1140-k1-02.mp4'],
      });
    });

    test('names that are not our recording names are not even sent', () async {
      handler = (_) => {'deleted': 0, 'skipped': 0, 'bytes': 0};
      await AndroidRecordingRemover().remove(
        's',
        const RecordingFootprint(
          names: ['../../x.mp4', 'photo.jpg', 'MAXCOM-2026-11-06-1140-k1-01.mp4'],
          bytes: 1,
        ),
      );
      expect(calls.single.arguments, {
        'names': ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
      });
    });

    test('a refusal counts the files as skipped, so nothing is marked deleted',
        () async {
      handler = (_) => throw PlatformException(code: 'denied');
      final out = await AndroidRecordingRemover().remove(
        's',
        const RecordingFootprint(
          names: ['MAXCOM-2026-11-06-1140-k1-01.mp4'],
          bytes: 1,
        ),
      );
      expect(out.deleted, 0);
      expect(out.skipped, 1);
    });
  });
}
