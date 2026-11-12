import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/upload/session_files.dart';

void main() {
  late MemoryLocalStore store;
  late SessionFiles files;
  setUp(() async {
    store = MemoryLocalStore();
    await store.open('box1');
    files = SessionFiles(store);
  });

  test('scheme 2 names pass; the older scheme and renamed copies never do', () {
    expect(isRecordingName('MAXCOM-2026-11-06-1015-siaran-01.mp4'), isTrue);
    expect(isRecordingName('MAXCOM-2026-11-06-2359-kuliah_1-12.mp4'), isTrue);
    // older scheme: untouched for ever
    expect(isRecordingName('MAXCOM-2026-11-06-siaran-01.mp4'), isFalse);
    // MediaStore's own rename
    expect(isRecordingName('MAXCOM-2026-11-06-1015-siaran-01 (1).mp4'), isFalse);
    expect(isRecordingName('MAXCOM-2026-11-06-siaran-01 (1).mp4'), isFalse);
    // not a time
    expect(isRecordingName('MAXCOM-2026-11-06-2460-siaran-01.mp4'), isFalse);
    expect(isRecordingName('../MAXCOM-2026-11-06-1015-siaran-01.mp4'), isFalse);
    expect(isRecordingName('MAXCOM-2026-11-06-1015-siaran-01.mp4\n'), isFalse);
  });

  test('saves the valid names of a session in order and reads them back', () async {
    await files.save('s1', [
      'MAXCOM-2026-11-06-1015-siaran-01.mp4',
      'MAXCOM-2026-11-06-1015-siaran-01 (1).mp4',
      'MAXCOM-2026-11-06-siaran-02.mp4',
      'MAXCOM-2026-11-06-1015-siaran-02.mp4',
      'MAXCOM-2026-11-06-1015-siaran-01.mp4',
    ]);
    expect(await files.names('s1'), [
      'MAXCOM-2026-11-06-1015-siaran-01.mp4',
      'MAXCOM-2026-11-06-1015-siaran-02.mp4',
    ]);
  });

  test('an unknown session has no names; nothing valid writes nothing', () async {
    expect(await files.names('nope'), isEmpty);
    await files.save('s1', ['MAXCOM-2026-11-06-1015-siaran-01.mp4']);
    await files.save('s1', ['photo.jpg']);
    expect(await files.names('s1'), ['MAXCOM-2026-11-06-1015-siaran-01.mp4']);
  });

  test('two sessions never share names', () async {
    await files.save('a', ['MAXCOM-2026-11-06-1015-siaran-01.mp4']);
    await files.save('b', ['MAXCOM-2026-11-06-1140-siaran-01.mp4']);
    expect(await files.names('a'), ['MAXCOM-2026-11-06-1015-siaran-01.mp4']);
    expect(await files.names('b'), ['MAXCOM-2026-11-06-1140-siaran-01.mp4']);
  });
}
