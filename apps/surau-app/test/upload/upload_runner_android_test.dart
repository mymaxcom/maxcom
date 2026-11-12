import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/session_files.dart';
import 'package:surau_app/upload/upload_runner_android.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('my.maxcom/upload');
  const events = EventChannel('my.maxcom/upload/events');
  final calls = <MethodCall>[];

  // The pretend device: live 1 (never registered) and live 2 of the same
  // day, plus the older scheme and MediaStore's rename.
  final onDevice = <Map<String, Object>>[
    {'uri': 'content://x/1', 'name': 'MAXCOM-2026-11-06-1015-siaran-01.mp4', 'bytes': 5},
    {'uri': 'content://x/2', 'name': 'MAXCOM-2026-11-06-siaran-01.mp4', 'bytes': 6},
    {'uri': 'content://x/3', 'name': 'MAXCOM-2026-11-06-1015-siaran-01 (1).mp4', 'bytes': 7},
    {'uri': 'content://x/4', 'name': 'MAXCOM-2026-11-06-1140-siaran-01.mp4', 'bytes': 9},
    {'uri': 'content://x/5', 'name': 'MAXCOM-2026-11-06-1140-siaran-02.mp4', 'bytes': 11},
  ];

  late SessionFiles files;
  late AndroidUploadRunner runner;
  bool carelessDevice = false;

  setUp(() async {
    calls.clear();
    carelessDevice = false;
    final store = MemoryLocalStore();
    await store.open('box1');
    files = SessionFiles(store);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      ..setMockMethodCallHandler(channel, (c) async {
        calls.add(c);
        if (c.method == 'findSegments') {
          if (carelessDevice) return onDevice;
          final asked = ((c.arguments as Map)['names'] as List).cast<String>();
          return [
            for (final n in asked)
              for (final f in onDevice)
                if (f['name'] == n) f,
          ];
        }
        return null;
      })
      ..setMockMethodCallHandler(
        MethodChannel(events.name),
        (c) async => null,
      );
    runner = AndroidUploadRunner(sessionFiles: files);
  });
  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      ..setMockMethodCallHandler(channel, null)
      ..setMockMethodCallHandler(MethodChannel(events.name), null);
    await runner.dispose();
  });

  test('catch-up for live 2 uploads only live 2 files, in the order written',
      () async {
    await files.save('s2', [
      'MAXCOM-2026-11-06-1140-siaran-01.mp4',
      'MAXCOM-2026-11-06-1140-siaran-02.mp4',
    ]);
    final segs = await runner.segmentsFor('s2', null);
    expect([for (final s in segs) s.source], ['android:content://x/4', 'android:content://x/5']);
    expect([for (final s in segs) s.bytes], [9, 11]);
    final asked = (calls.singleWhere((c) => c.method == 'findSegments').arguments as Map)['names'];
    expect(asked, [
      'MAXCOM-2026-11-06-1140-siaran-01.mp4',
      'MAXCOM-2026-11-06-1140-siaran-02.mp4',
    ]);
  });

  test('a session with no stored names uploads nothing and asks nothing', () async {
    expect(await runner.segmentsFor('s9', null), isEmpty);
    expect(calls.where((c) => c.method == 'findSegments'), isEmpty);
    // an earlier live that was never registered is not found by its prefix or date either
    expect(await runner.segmentsFor('s1', 'siaran'), isEmpty);
  });

  test('a device answering with files that were not asked for is ignored', () async {
    carelessDevice = true;
    await files.save('s2', ['MAXCOM-2026-11-06-1140-siaran-02.mp4']);
    final segs = await runner.segmentsFor('s2', null);
    expect([for (final s in segs) s.source], ['android:content://x/5']);
  });

  test('a renamed copy or an older scheme file is never a segment', () async {
    final store = MemoryLocalStore();
    await store.open('box1');
    await store.putDoc(Collections.sessionFiles, 's3', {
      'sessionId': 's3',
      'names': [
        'MAXCOM-2026-11-06-1015-siaran-01 (1).mp4',
        'MAXCOM-2026-11-06-siaran-01.mp4',
      ],
    });
    final r = AndroidUploadRunner(sessionFiles: SessionFiles(store));
    expect(await r.segmentsFor('s3', null), isEmpty);
    await r.dispose();
  });
}
