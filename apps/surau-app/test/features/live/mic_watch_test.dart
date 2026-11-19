// A microphone plugged into the publishing device is picked up by itself
// (task W7): fake device lists, a memory store, a fake publisher.

import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/mic_watch.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';

class _Devices implements MicDevices {
  List<MicInfo> now = [];
  final _c = StreamController<void>.broadcast();

  @override
  Duration? get pollEvery => null;

  @override
  Stream<void> get changes => _c.stream;

  @override
  Future<List<MicInfo>> list() async => List.of(now);
}

class _Seen implements SeenMicsStore {
  List<String>? keys;

  @override
  Future<List<String>?> load() async => keys;

  @override
  Future<void> save(List<String> k) async => keys = List.of(k);
}

class _MemStore implements LiveSourceStore {
  @override
  Future<({VideoSourceKind video, LiveAudioMix mix, Map<String, int> offsets})?> read() async => null;

  @override
  Future<void> write(VideoSourceKind v, LiveAudioMix m) async {}
}

class _Pub extends FakePublisher implements LiveMicControl {
  final List<String?> mics = [];
  bool refuse = false;
  int failFirst = 0;
  int attempts = 0;

  @override
  Future<bool> setMicrophone(String? deviceId) async {
    attempts++;
    if (failFirst > 0) {
      failFirst--;
      return false;
    }
    if (refuse) return false;
    mics.add(deviceId);
    return true;
  }
}

class _Source extends LiveSourceNotifier {
  _Source(this.first);
  final LiveSourceState first;

  @override
  LiveSourceState build() => first;
}

const _builtIn = MicInfo(deviceId: 'built-in', label: 'Mikrofon iPad');
const _rode = MicInfo(deviceId: 'usb-1', label: 'Rode Lavalier');
const _shure = MicInfo(deviceId: 'usb-2', label: 'Shure MV7');

AudioSourceMix _m(bool on) => AudioSourceMix(enabled: on, volume: 70);

class _T {
  _T({bool external = true, bool micOn = false, bool control = true}) {
    pub = control ? _Pub() : FakePublisher();
    devices.now = [_builtIn];
    seen.keys = null;
    c = ProviderContainer(
      overrides: [
        micDevicesProvider.overrideWithValue(devices),
        seenMicsStoreProvider.overrideWithValue(seen),
        micRetryDelayProvider.overrideWithValue(Duration.zero),
        liveSourceStoreProvider.overrideWithValue(_MemStore()),
        livePublisherProvider.overrideWithValue(pub),
        liveSourceProvider.overrideWith(
          () => _Source(
            LiveSourceState(
              video: external ? VideoSourceKind.external : VideoSourceKind.phone,
              mix: LiveAudioMix(camera: _m(external), deviceMic: _m(micOn || !external), boxInput: _m(false)),
              loaded: true,
            ),
          ),
        ),
      ],
    );
  }

  late final LivePublisher pub;
  final devices = _Devices();
  final seen = _Seen();
  late final ProviderContainer c;

  MicAutoNotifier get n => c.read(micAutoProvider.notifier);
  MicAutoState get st => c.read(micAutoProvider);
  AudioSourceMix get micMix => c.read(liveSourceProvider).mix.deviceMic;
  List<String?> get mics => (pub as _Pub).mics;

  /// Starts the watcher and lets the first read (the built-in microphones are
  /// recorded as seen) finish.
  Future<void> boot() async {
    n.start();
    await pumpEventQueue();
  }

  Future<void> change(List<MicInfo> l) async {
    devices.now = l;
    await n.check();
    await pumpEventQueue();
  }

  void close() {
    n.stop();
    c.dispose();
  }
}

void main() {
  test('the microphones at first run are seen: nothing switched, no toast', () async {
    final t = _T();
    await t.boot();
    expect(t.seen.keys, ['built-in']);
    expect(t.st.toast, isNull);
    expect(t.st.mic, isNull);
    expect(t.micMix.enabled, isFalse);
    t.close();
  });

  test('a new mic before the live: used, switched on at 100, toast', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, _rode]);
    expect(t.mics, ['usb-1']);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.micMix.enabled, isTrue);
    expect(t.micMix.volume, 100);
    final toast = t.st.toast!;
    expect(toast.kind, MicToastKind.added);
    expect(toast.undo, isTrue);
    expect(MicAutoNotifier.toastText(toast, AppLang.ms), 'Mikrofon baharu: Rode Lavalier. Digunakan untuk siaran.');
    expect(t.seen.keys, ['built-in', 'usb-1']);
    t.close();
  });

  test('a new mic during the live: the track is swapped, the live is not stopped', () async {
    final t = _T(micOn: true);
    (t.pub as _Pub).emit(t.pub.current.copyWith(phase: PublisherPhase.live));
    await t.boot();
    await t.change([_builtIn, _rode]);
    expect(t.mics, ['usb-1']);
    expect((t.pub as _Pub).stops, 0);
    expect(t.pub.current.isLive, isTrue);
    expect(t.micMix.volume, 70, reason: 'a mic that was on keeps its volume');
    t.close();
  });

  test('Batal: the previous mic and the previous off state, the mic stays seen', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, _rode]);
    await t.n.undo();
    expect(t.mics, ['usb-1', null]);
    expect(t.st.mic, isNull);
    expect(t.micMix.enabled, isFalse);
    await t.change([_builtIn, _rode]);
    expect(t.st.mic, isNull, reason: 'seen: not switched on again');
    expect(t.micMix.enabled, isFalse);
    t.close();
  });

  test('a seen mic is not switched on again', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, _rode]);
    await t.n.undo();
    await t.change([_builtIn]);
    await t.change([_builtIn, _rode]);
    expect(t.mics, ['usb-1', null]);
    expect(t.micMix.enabled, isFalse);
    t.close();
  });

  test('unplugged while in use: back to the device mic with a toast; plugged back it is used again', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, _rode]);
    await t.change([_builtIn]);
    expect(t.mics, ['usb-1', null]);
    expect(t.st.mic, isNull);
    final toast = t.st.toast!;
    expect(toast.kind, MicToastKind.unplugged);
    expect(MicAutoNotifier.toastText(toast, AppLang.ms), 'Mikrofon Rode Lavalier dicabut. Kembali ke mikrofon peranti.');
    expect(t.micMix.enabled, isTrue, reason: 'the live goes on, only the mic changes');
    await t.change([_builtIn, _rode]);
    expect(t.mics, ['usb-1', null, 'usb-1']);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.st.toast!.kind, MicToastKind.unplugged, reason: 'no new toast for a mic used again');
    t.close();
  });

  test('a second new mic replaces the first', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, _rode]);
    await t.change([_builtIn, _rode, _shure]);
    expect(t.mics, ['usb-1', 'usb-2']);
    expect(t.st.label, 'Shure MV7');
    t.close();
  });

  test('label-less ids: the label is the key', () async {
    final t = _T();
    t.devices.now = const [MicInfo(deviceId: '', label: 'Mikrofon iPad')];
    await t.boot();
    await t.change(const [MicInfo(deviceId: '', label: 'Mikrofon iPad'), MicInfo(deviceId: '', label: 'Lightning Mic')]);
    expect(t.st.label, 'Lightning Mic');
    expect(t.seen.keys, ['Mikrofon iPad', 'Lightning Mic']);
    t.close();
  });

  test('no permission yet (empty labels): nothing is recorded or switched', () async {
    final t = _T();
    t.devices.now = const [MicInfo(deviceId: 'a', label: ''), MicInfo(deviceId: 'b', label: '')];
    await t.boot();
    expect(t.seen.keys, isNull);
    await t.change(const [MicInfo(deviceId: 'a', label: 'Mikrofon iPad'), MicInfo(deviceId: 'b', label: 'Rode')]);
    expect(t.seen.keys, ['a', 'b'], reason: 'first run once the labels are there');
    expect(t.st.mic, isNull);
    t.close();
  });

  test('the browser virtual default entries are ignored', () async {
    final t = _T();
    await t.boot();
    await t.change([_builtIn, const MicInfo(deviceId: 'default', label: 'Default - Rode'), const MicInfo(deviceId: 'communications', label: 'Communications')]);
    expect(t.st.mic, isNull);
    expect(t.seen.keys, ['built-in']);
    t.close();
  });

  test('the seen list is capped', () async {
    final t = _T();
    await t.boot();
    for (var i = 0; i < seenMicsCap + 10; i++) {
      await t.change([_builtIn, MicInfo(deviceId: 'u$i', label: 'Mic $i')]);
    }
    expect(t.seen.keys!.length, seenMicsCap);
    expect(t.seen.keys!.last, 'u${seenMicsCap + 9}');
    t.close();
  });

  test('a mic that cannot be opened leaves everything as it was', () async {
    final t = _T();
    await t.boot();
    (t.pub as _Pub).refuse = true;
    await t.change([_builtIn, _rode]);
    expect(t.st.mic, isNull);
    expect(t.micMix.enabled, isFalse);
    expect(t.st.toast, isNull);
    expect(t.seen.keys, ['built-in'], reason: 'a mic that was never used is not marked seen');
    // the next read, with the mic opening now, switches it on (M: seen only after use)
    (t.pub as _Pub).refuse = false;
    await t.change([_builtIn, _rode]);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.seen.keys, ['built-in', 'usb-1']);
    t.close();
  });

  test('a mic that fails once is retried after the wait and then used', () async {
    final t = _T();
    await t.boot();
    (t.pub as _Pub).failFirst = 1;
    await t.change([_builtIn, _rode]);
    expect((t.pub as _Pub).attempts, 2);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.seen.keys, ['built-in', 'usb-1']);
    t.close();
  });

  test('Android path: the system routes the mic; the name, the mix and the toast are handled', () async {
    final t = _T(control: false);
    await t.boot();
    await t.change([_builtIn, _rode]);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.micMix.enabled, isTrue);
    expect(t.st.toast!.undo, isTrue, reason: 'the switched-on state can be undone');
    await t.n.undo();
    expect(t.micMix.enabled, isFalse);
    await t.change([_builtIn, _rode, _shure]);
    await t.change([_builtIn, _rode]);
    expect(t.st.mic, isNull);
    t.close();
  });

  test('phone camera (mic always in): no on switch, no Batal on Android', () async {
    final t = _T(external: false, control: false);
    await t.boot();
    await t.change([_builtIn, _rode]);
    expect(t.st.label, 'Rode Lavalier');
    expect(t.st.toast!.undo, isFalse);
    t.close();
  });

  group('F12: the native side sends a neutral kind, the app words it', () {
    const channel = MethodChannel('my.maxcom/test-mics');
    setUp(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => [
            {'id': '15:', 'name': '', 'kind': 'builtin', 'builtin': true},
            {'id': '11:Rode Lavalier', 'name': 'Rode Lavalier', 'kind': 'external', 'builtin': false},
            {'id': '3:', 'name': '', 'kind': 'external', 'builtin': false},
          ]);
    });
    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    });

    test('built-in and nameless external are worded per language; a USB microphone keeps its product name', () async {
      final mics = await ChannelMicDevices(channel).list();
      expect(mics.map((m) => m.kind), ['builtin', 'external', 'external']);
      expect(mics.map((m) => m.nameIn(AppLang.ms)), ['Mikrofon peranti', 'Rode Lavalier', 'Mikrofon luaran']);
      expect(mics.map((m) => m.nameIn(AppLang.en)), ['Device microphone', 'Rode Lavalier', 'External microphone']);
      expect(mics.map((m) => m.nameIn(AppLang.ar)), ['ميكروفون الجهاز', 'Rode Lavalier', 'ميكروفون خارجي']);
    });

    test('the toast of a nameless external microphone reads in the app language', () {
      const toast = MicToast(1, MicToastKind.added, '', micKind: 'external');
      expect(MicAutoNotifier.toastText(toast, AppLang.ms), 'Mikrofon baharu: Mikrofon luaran. Digunakan untuk siaran.');
      expect(MicAutoNotifier.toastText(toast, AppLang.en), 'New microphone: External microphone. Used for the live.');
      expect(MicAutoNotifier.toastText(toast, AppLang.ar), contains('ميكروفون خارجي'));
      const gone = MicToast(2, MicToastKind.unplugged, '', micKind: 'external');
      expect(MicAutoNotifier.toastText(gone, AppLang.en), 'Microphone External microphone was unplugged. Back to the device microphone.');
    });

    test('no native words: a list of kinds with no name is not read as "no permission yet"', () async {
      final t = _T();
      t.devices.now = const [MicInfo(deviceId: '15:', label: '', kind: 'builtin')];
      await t.boot();
      expect(t.seen.keys, ['15:']);
      await t.change(const [MicInfo(deviceId: '15:', label: '', kind: 'builtin'), MicInfo(deviceId: '3:', label: '', kind: 'external')]);
      expect(t.st.mic?.nameIn(AppLang.en), 'External microphone');
      expect(MicAutoNotifier.toastText(t.st.toast!, AppLang.en), 'New microphone: External microphone. Used for the live.');
      t.close();
    });
  });
}
