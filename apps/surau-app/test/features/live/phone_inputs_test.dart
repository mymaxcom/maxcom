// Lane P1 (2026.11.15): every input the live can hear is its own row, the loudness lift per source, Bluetooth
// microphones. Fake device lists, a memory store, a fake publisher; the rows are built by the real functions.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart' show AppLang;
import 'package:surau_app/features/labels_cam.dart';
import 'package:surau_app/features/live/audio_inputs.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_controller.dart';
import 'package:surau_app/features/live/live_source.dart';
import 'package:surau_app/features/live/live_source_widgets.dart';
import 'package:surau_app/features/live/mic_watch.dart';
import 'package:surau_app/features/live/publisher.dart';
import 'package:surau_app/features/shell/live_camera_gateway.dart';

class _Devices implements MicDevices {
  List<MicInfo> now = [];

  @override
  Future<bool> headphonesWithoutMic() async => false;

  @override
  Duration? get pollEvery => null;

  @override
  Stream<void> get changes => const Stream.empty();

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

class _Prefs implements AudioPrefsStore {
  Map<String, SourcePref> saved = {};

  @override
  Future<Map<String, SourcePref>> load() async => Map.of(saved);

  @override
  Future<void> save(Map<String, SourcePref> p) async => saved = Map.of(p);
}

class _Pub extends FakePublisher implements LiveMicControl, LiveLiftControl {
  final List<String?> mics = [];
  final List<(String, bool)> lifts = [];
  bool refuseBluetooth = false;

  @override
  String? get ownMicrophoneId => 'own';

  @override
  Future<bool> setMicrophone(String? deviceId) async {
    if (refuseBluetooth && (deviceId ?? '').startsWith('7:')) return false;
    mics.add(deviceId);
    return true;
  }

  @override
  Future<void> setLift(String id, bool on) async => lifts.add((id, on));
}

class _Source extends LiveSourceNotifier {
  _Source(this.first);
  final LiveSourceState first;

  @override
  LiveSourceState build() => first;
}

const _own = MicInfo(deviceId: '15:', label: '', kind: 'builtin');
const _wired = MicInfo(deviceId: '3:Headset Mic', label: 'Headset Mic', kind: 'external');
const _usb = MicInfo(deviceId: '11:USB Audio', label: 'USB Audio', kind: 'external');
const _bt = MicInfo(deviceId: '7:Headset Contoh', label: 'Headset Contoh', kind: 'bluetooth');

AudioSourceMix _m(bool on, [int v = 70]) => AudioSourceMix(enabled: on, volume: v);

class _T {
  _T({bool external = false, bool micOn = false}) {
    devices.now = [_own];
    seen.keys = null;
    c = ProviderContainer(
      overrides: [
        micDevicesProvider.overrideWithValue(devices),
        seenMicsStoreProvider.overrideWithValue(seen),
        micRetryDelayProvider.overrideWithValue(Duration.zero),
        liveSourceStoreProvider.overrideWithValue(_MemStore()),
        audioPrefsStoreProvider.overrideWithValue(prefs),
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

  final pub = _Pub();
  final devices = _Devices();
  final seen = _Seen();
  final prefs = _Prefs();
  late final ProviderContainer c;

  MicAutoNotifier get n => c.read(micAutoProvider.notifier);
  MicAutoState get st => c.read(micAutoProvider);
  AudioPrefsState get ap => c.read(audioPrefsProvider);
  AudioRowActions get actions => c.read(audioRowActionsProvider);
  LiveSourceState get source => c.read(liveSourceProvider);

  Future<void> boot() async {
    c.read(audioPrefsProvider); // alive, as the screen keeps it
    n.start();
    await pumpEventQueue();
  }

  Future<void> change(List<MicInfo> l) async {
    devices.now = l;
    await n.check();
    await pumpEventQueue();
  }

  List<PhoneInput> inputs({String? routedId}) => phoneInputs(st, routedId: routedId, lang: AppLang.ms);

  void close() {
    n.stop();
    c.dispose();
  }
}

AudioContext _ctx({List<PhoneInput> inputs = const [], Map<String, bool> lifts = const {}, String dev = 'phone', bool readOnly = false}) =>
    AudioContext(dev: dev, live: false, lang: AppLang.ms, inputs: inputs, lifts: lifts, readOnly: readOnly);

LiveSourceState _src({bool external = false, bool micOn = true, int micVol = 70}) => LiveSourceState(
  video: external ? VideoSourceKind.external : VideoSourceKind.phone,
  mix: LiveAudioMix(camera: _m(external), deviceMic: _m(micOn, micVol), boxInput: _m(false)),
  camera: const LiveCameraInfo(enabled: true, configured: true, hasAudio: true, reachable: true),
  loaded: true,
);

void main() {
  group('the inputs of the Audio card', () {
    test('a device that is met stays as a row and is greyed when it goes away', () async {
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _wired]);
      expect(t.inputs().map((i) => i.key), ['15:', '3:Headset Mic']);
      expect(t.inputs().every((i) => i.present), isTrue);
      await t.change([_own]);
      final rows = t.inputs();
      expect(rows.map((i) => i.key), ['15:', '3:Headset Mic'], reason: 'the unplugged one stays, greyed');
      expect(rows.firstWhere((i) => i.key == _wired.key).present, isFalse);
      expect(rows.firstWhere((i) => i.key == _own.key).present, isTrue);
    });

    test('the device in use: the chosen one, else the routed one, else the plugged one, else the own microphone', () async {
      final both = [_own, _usb];
      expect(activeInputKey(both), '15:');
      expect(activeInputKey(both, micKey: _usb.key), _usb.key);
      expect(activeInputKey(both, routedId: _usb.key), _usb.key);
      expect(activeInputKey(both, routedId: _usb.key, chosenKey: '15:'), '15:');
      // an id that is not listed is ignored
      expect(activeInputKey(both, routedId: '99:x', chosenKey: '98:y'), '15:');
      expect(activeInputKey(const []), isNull);
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _usb]);
      // the first-plug rule took the USB microphone: exactly one input is active
      expect(t.inputs().where((i) => i.active).map((i) => i.key), [_usb.deviceId]);
    });

    test('a Bluetooth microphone is a row, off, and is never switched on by itself', () async {
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _bt]);
      expect(t.pub.mics, isEmpty, reason: 'no automatic choice of a Bluetooth microphone');
      final bt = t.inputs().firstWhere((i) => i.key == _bt.deviceId);
      expect(bt.active, isFalse);
      expect(bt.bluetooth, isTrue);
      expect(bt.name, 'Headset Contoh');
      // met once: not taken later either
      await t.change([_own, _bt, _usb]);
      expect(t.pub.mics, [_usb.deviceId], reason: 'the USB microphone follows the first-plug rule, the Bluetooth one does not');
    });

    test('the iPad browser lists a Bluetooth microphone as a row, off, and does not take it by itself', () async {
      // the browser gives a label only; the kind is read from it
      expect(kindFromBrowserLabel('Headset (Bluetooth)'), 'bluetooth');
      expect(kindFromBrowserLabel('USB Audio'), '');
      const web = MicInfo(deviceId: 'abc', label: 'Headset (Bluetooth)', kind: 'bluetooth');
      const mic = MicInfo(deviceId: 'def', label: 'Mikrofon iPad');
      final t = _T();
      addTearDown(t.close);
      t.devices.now = [mic]; // the device's own microphone, met at the start
      await t.boot();
      await t.change([mic, web]);
      expect(t.pub.mics, isEmpty);
      final rows = t.inputs();
      expect(rows.map((i) => i.key), ['def', 'abc']);
      final bt = rows.firstWhere((i) => i.key == 'abc');
      expect(bt.bluetooth, isTrue);
      expect(bt.name, 'Headset (Bluetooth)');
      expect(bt.active, isFalse);
    });

    test('a nameless Bluetooth input is named by its kind in the app language', () {
      const nameless = MicInfo(deviceId: '26:', label: '', kind: 'bluetooth');
      expect(nameless.nameIn(AppLang.ms), 'Mikrofon Bluetooth');
      expect(nameless.nameIn(AppLang.en), 'Bluetooth microphone');
      expect(nameless.nameIn(AppLang.ar), isNotEmpty);
    });

    test('switching an input on takes it; the other phone input is then the one that is off', () async {
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _wired]);
      // the wired one was met after the start: the first-plug rule took it. Take the own microphone back.
      expect(t.pub.mics, [_wired.deviceId]);
      final before = t.inputs();
      await t.actions.toggle(before.firstWhere((i) => i.key == _own.key).rowId, true, before);
      expect(t.pub.mics.last, 'own', reason: 'the device\'s own microphone is asked for as "own"');
      final after = t.inputs();
      expect(after.firstWhere((i) => i.key == _own.key).active, isTrue);
      expect(after.firstWhere((i) => i.key == _wired.key).active, isFalse);
    });

    test('a Bluetooth microphone refused its permission says so and the live keeps its microphone', () async {
      final t = _T();
      addTearDown(t.close);
      t.pub.refuseBluetooth = true;
      await t.boot();
      await t.change([_own, _bt]);
      final rows = t.inputs();
      await t.actions.toggle(rows.firstWhere((i) => i.key == _bt.deviceId).rowId, true, rows);
      final bt = t.inputs().firstWhere((i) => i.key == _bt.deviceId);
      expect(bt.denied, isTrue);
      expect(bt.active, isFalse);
      expect(t.inputs().firstWhere((i) => i.key == _own.key).active, isTrue);
      final r = buildAudioRows(source: _src(), ctx: _ctx(inputs: t.inputs()));
      final row = r.firstWhere((x) => x.id == bt.rowId);
      expect(row.hint, contains(liveAudioBluetoothDenied(AppLang.ms)));
    });

    test('with the external camera the phone input is switched on and off from its row', () async {
      final t = _T(external: true, micOn: false);
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _usb]);
      var rows = t.inputs();
      final usb = rows.firstWhere((i) => i.key == _usb.deviceId);
      await t.actions.toggle(usb.rowId, true, rows);
      expect(t.source.mix.deviceMic.enabled, isTrue);
      rows = t.inputs();
      await t.actions.toggle(rows.firstWhere((i) => i.key == _usb.deviceId).rowId, false, rows);
      expect(t.source.mix.deviceMic.enabled, isFalse);
    });
  });

  group('the rows', () {
    final inputs = [
      const PhoneInput(key: '15:', name: 'Mikrofon peranti', kind: 'builtin', active: true),
      const PhoneInput(key: '3:Headset Mic', name: 'Headset Mic', kind: 'external'),
      const PhoneInput(key: '7:Headset Contoh', name: 'Headset Contoh', kind: 'bluetooth'),
      const PhoneInput(key: '11:USB Audio', name: 'USB Audio', kind: 'external', present: false),
    ];

    test('the phone camera: the input in use plus one off row for each other input, each with a lift', () {
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: inputs));
      expect(rows.map((r) => r.id), [
        'deviceMic',
        'mic:3:Headset Mic',
        'mic:7:Headset Contoh',
        'mic:11:USB Audio',
      ]);
      expect(rows.first.toggle, isTrue);
      expect(rows.first.toggleEnabled, isFalse, reason: 'the phone camera always has a microphone');
      expect(rows.skip(1).every((r) => r.toggle == false), isTrue);
      expect(rows.every((r) => r.lift == true), isTrue, reason: 'the lift is on by default for every row');
      expect(rows.every((r) => r.slider), isTrue);
      final gone = rows.last;
      expect(gone.dim, isTrue);
      expect(gone.status, liveAudioInputGone(AppLang.ms));
      expect(gone.readOnly, isTrue);
      final live = rows[1];
      expect(live.status, liveAudioStatusOff(AppLang.ms));
      expect(live.hint, liveAudioOnePhoneInput(AppLang.ms));
    });

    test('a Bluetooth row says the sound is telephone quality', () {
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: inputs));
      final bt = rows.firstWhere((r) => r.id == 'mic:7:Headset Contoh');
      expect(bt.hint, contains(liveAudioBluetoothQuality(AppLang.ms)));
      // and when it is the one in use
      final active = [
        for (final i in inputs)
          PhoneInput(key: i.key, name: i.name, kind: i.kind, present: i.present, active: i.key == '7:Headset Contoh'),
      ];
      final r2 = buildAudioRows(source: _src(), ctx: _ctx(inputs: active));
      expect(r2.first.hint, liveAudioBluetoothQuality(AppLang.ms));
    });

    test('the lift of a source that was switched off shows off; the others stay on', () {
      final rows = buildAudioRows(
        source: _src(),
        ctx: _ctx(inputs: inputs, lifts: const {'mic:3:Headset Mic': false}),
      );
      expect(rows.firstWhere((r) => r.id == 'mic:3:Headset Mic').lift, isFalse);
      expect(rows.firstWhere((r) => r.id == 'deviceMic').lift, isTrue);
    });

    test('the external camera: its sound has a lift and a mute, the phone inputs are off until one is added', () {
      final rows = buildAudioRows(source: _src(external: true, micOn: false), ctx: _ctx(inputs: inputs));
      final cam = rows.first;
      expect(cam.id, 'camera');
      expect(cam.lift, isTrue);
      expect(cam.rowMute, isTrue);
      expect(rows.map((r) => r.id), ['camera', 'deviceMic', 'mic:3:Headset Mic', 'mic:7:Headset Contoh', 'mic:11:USB Audio']);
      // the active input is listed off, with its own switch
      expect(rows[1].toggle, isFalse);
      expect(rows[1].status, liveAudioStatusOff(AppLang.ms));
    });

    test('the external camera with the phone microphone added: that row is on, the others off', () {
      final rows = buildAudioRows(source: _src(external: true, micOn: true), ctx: _ctx(inputs: inputs));
      final mic = rows.firstWhere((r) => r.id == 'deviceMic');
      expect(mic.toggle, isTrue);
      expect(mic.lift, isTrue);
      expect(rows.where((r) => r.id.startsWith('mic:')), hasLength(3));
    });

    test('the camera lift can be switched off', () {
      final rows = buildAudioRows(source: _src(external: true), ctx: _ctx(lifts: const {'camera': false}));
      expect(rows.firstWhere((r) => r.id == 'camera').lift, isFalse);
    });

    test('the iPad has a lift switch for its microphone (the browser gain), none for the camera sound', () {
      final rows = buildAudioRows(source: _src(external: true), ctx: _ctx(dev: 'ipad'));
      expect(rows.firstWhere((r) => r.id == 'camera').lift, isNull);
      expect(rows.firstWhere((r) => r.id == 'deviceMic').lift, isTrue);
      final off = buildAudioRows(source: _src(external: true), ctx: _ctx(dev: 'ipad', lifts: const {'mic:own': false}));
      expect(off.firstWhere((r) => r.id == 'deviceMic').lift, isFalse);
    });

    test('the iPad own camera has no volume slider (no mix is sent), the phone has one', () {
      final ipad = buildAudioRows(source: _src(), ctx: _ctx(dev: 'ipad'));
      expect(ipad.firstWhere((r) => r.id == 'deviceMic').slider, isFalse);
      final phone = buildAudioRows(source: _src(), ctx: _ctx());
      expect(phone.firstWhere((r) => r.id == 'deviceMic').slider, isTrue);
      // with the external camera the iPad does send the mix: the slider stays
      final ext = buildAudioRows(source: _src(external: true), ctx: _ctx(dev: 'ipad'));
      expect(ext.firstWhere((r) => r.id == 'deviceMic').slider, isTrue);
    });

    test('mute is silence: the camera sound counts as silent when the phone is muted, not on the iPad', () {
      final m = LiveAudioMix(camera: _m(true), deviceMic: _m(true), boxInput: _m(false));
      expect(mixAllMuted(m), isFalse);
      expect(mixAllMuted(m, muted: true), isTrue);
      expect(mixAllMuted(m, muted: true, phone: false), isFalse, reason: 'the iPad relays the camera sound without its microphone');
    });

    test('a live of another device is only read: no input rows, no switches', () {
      final rows = buildAudioRows(source: _src(external: true, micOn: true), ctx: _ctx(inputs: inputs, readOnly: true));
      expect(rows.where((r) => r.id.startsWith('mic:')), isEmpty);
      expect(rows.every((r) => r.lift == null), isTrue);
    });

    test('with one input only the rows are as before plus the lift', () {
      final one = [const PhoneInput(key: '15:', name: 'Mikrofon peranti', kind: 'builtin', active: true)];
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: one));
      expect(rows.map((r) => r.id), ['deviceMic']);
      expect(rows.first.toggle, isNull);
      expect(rows.first.lift, isTrue);
    });
  });

  group('the lift, remembered per source', () {
    test('on by default; a change is saved and sent to the engine', () async {
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      expect(t.ap.liftOf('camera'), isTrue);
      expect(t.ap.liftOf('mic:15:'), isTrue);
      final rows = t.inputs();
      await t.actions.lift('camera', false, rows);
      expect(t.ap.liftOf('camera'), isFalse);
      expect(t.prefs.saved['camera']?.lift, isFalse);
      expect(t.pub.lifts.last, ('camera', false));
      // the microphone in use
      await t.change([_own, _wired]);
      await t.actions.lift('deviceMic', false, t.inputs());
      expect(t.ap.liftOf('mic:3:Headset Mic'), isFalse, reason: 'the wired microphone is the one in use');
      expect(t.pub.lifts.last, ('deviceMic', false));
    });

    test('the system routing to another device re-syncs the lift of that device (not the built-in one)', () async {
      final t = _T();
      addTearDown(t.close);
      t.prefs.saved = {'mic:7:Headset Contoh': const SourcePref(lift: false)};
      await t.boot();
      await t.change([_own, _bt]);
      expect(t.pub.lifts.last, ('deviceMic', true), reason: 'the built-in microphone is in use first');
      t.pub.emit(t.pub.current.copyWith(micRoute: const MicRouteInfo(id: '7:Headset Contoh', name: 'Headset Contoh', kind: 'external')));
      await pumpEventQueue();
      expect(t.pub.lifts.last, ('deviceMic', false));
    });

    test('a saved choice comes back after a restart', () async {
      final t = _T();
      addTearDown(t.close);
      t.prefs.saved = {'camera': const SourcePref(lift: false), 'mic:15:': const SourcePref(volume: 40)};
      await t.boot();
      await pumpEventQueue();
      expect(t.ap.liftOf('camera'), isFalse);
      expect(t.ap.volumeOf('mic:15:'), 40);
      expect(t.pub.lifts, contains(('camera', false)), reason: 'sent to the engine at the start');
    });

    test('the volume of an input that is off is kept and applies when it is switched on', () async {
      final t = _T();
      addTearDown(t.close);
      await t.boot();
      await t.change([_own, _usb]);
      var rows = t.inputs();
      final usb = rows.firstWhere((i) => i.key == _usb.deviceId);
      // the USB microphone was taken by the first-plug rule; go back to the own one, then set the USB volume
      await t.actions.toggle(rows.firstWhere((i) => i.key == _own.key).rowId, true, rows);
      rows = t.inputs();
      await t.actions.volume(rows.firstWhere((i) => i.key == _usb.deviceId).rowId, 35, rows);
      expect(t.ap.volumeOf(usb.liftKey), 35);
      expect(t.source.mix.deviceMic.volume, 70, reason: 'the input in use did not move');
      rows = t.inputs();
      await t.actions.toggle(rows.firstWhere((i) => i.key == _usb.deviceId).rowId, true, rows);
      expect(t.source.mix.deviceMic.volume, 35);
    });

    test('a row\'s own mute sets the volume to 0 and gives it back', () async {
      final t = _T(external: true, micOn: false);
      addTearDown(t.close);
      await t.boot();
      await t.actions.volume('camera', 55, const []);
      expect(t.source.mix.camera.volume, 55);
      await t.actions.muteRow('camera');
      expect(t.source.mix.camera.volume, 0);
      await t.actions.muteRow('camera');
      expect(t.source.mix.camera.volume, 55);
    });
  });

  group('the card draws the switches', () {
    Future<void> pump(WidgetTester tester, List<AudioRowModel> rows, {void Function(String, bool)? onToggle, void Function(String, bool)? onLift, void Function(String)? onRowMute}) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AudioCardBody(
                rows: rows,
                notices: const [],
                canAdd: false,
                onAdd: () {},
                onVolume: (_, _) {},
                onRemove: (_) {},
                onMute: () {},
                onUseOnly: (_) {},
                onToggle: onToggle,
                onLift: onLift,
                onRowMute: onRowMute,
              ),
            ),
          ),
        ),
      );
    }

    final inputs = [
      const PhoneInput(key: '15:', name: 'Mikrofon peranti', kind: 'builtin', active: true),
      const PhoneInput(key: '3:Headset Mic', name: 'Headset Mic', kind: 'external'),
      const PhoneInput(key: '11:USB Audio', name: 'USB Audio', kind: 'external', present: false),
    ];

    testWidgets('an off row has a switch that turns it on, a lift switch and a volume', (tester) async {
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: inputs));
      final toggled = <String>[];
      final lifted = <String>[];
      await pump(tester, rows, onToggle: (id, on) => toggled.add('$id:$on'), onLift: (id, on) => lifted.add('$id:$on'));
      expect(find.byKey(const ValueKey('audio-switch-mic:3:Headset Mic')), findsOneWidget);
      expect(find.byKey(const ValueKey('audio-volume-mic:3:Headset Mic')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('audio-switch-mic:3:Headset Mic')));
      await tester.pump();
      expect(toggled, ['mic:3:Headset Mic:true']);
      await tester.ensureVisible(find.byKey(const ValueKey('audio-lift-mic:3:Headset Mic')));
      await tester.tap(find.byKey(const ValueKey('audio-lift-mic:3:Headset Mic')));
      await tester.pump();
      expect(lifted, ['mic:3:Headset Mic:false']);
      expect(find.text(liveAudioLift(AppLang.en)), findsWidgets);
    });

    testWidgets('a row that is gone is greyed and its switches do nothing', (tester) async {
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: inputs));
      final toggled = <String>[];
      await pump(tester, rows, onToggle: (id, on) => toggled.add(id));
      expect(find.text(liveAudioInputGone(AppLang.ms)), findsOneWidget);
      final sw = tester.widget<Switch>(find.byKey(const ValueKey('audio-switch-mic:11:USB Audio')));
      expect(sw.onChanged, isNull);
      final lift = tester.widget<Switch>(find.byKey(const ValueKey('audio-lift-mic:11:USB Audio')));
      expect(lift.onChanged, isNull);
    });

    testWidgets('the input in use of the phone camera cannot be switched off', (tester) async {
      final rows = buildAudioRows(source: _src(), ctx: _ctx(inputs: inputs));
      await pump(tester, rows, onToggle: (_, _) {});
      final sw = tester.widget<Switch>(find.byKey(const ValueKey('audio-switch-deviceMic')));
      expect(sw.value, isTrue);
      expect(sw.onChanged, isNull);
    });

    testWidgets('the camera row has its own mute that follows its volume', (tester) async {
      final rows = buildAudioRows(source: _src(external: true, micOn: false), ctx: _ctx());
      final muted = <String>[];
      await pump(tester, rows, onRowMute: muted.add);
      expect(find.text(liveAudioMuteSource(AppLang.en)), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('audio-rowmute-camera')));
      await tester.pump();
      expect(muted, ['camera']);
    });
  });

}
