// A microphone plugged into the publishing device (a USB or Lightning mic on
// the iPad, a USB or Bluetooth mic on an Android phone) is picked up by
// itself: the device microphone source uses it and is switched on the first
// time it is seen (task W7). A microphone seen before is not switched on
// again; one that was in use, unplugged and plugged back is used again.
//
// How the change is noticed: the browser fires `devicechange` (and the list
// is read again every 10 s); Android has no Dart callback, so the Live tab
// reads the system's input list every 3 s while it is open (one small method
// `audioInputs` on the existing live channel, no new plugin). On Android the
// system itself routes the recording to a newly plugged USB or wired mic and
// back to the built-in one when it goes, so there only the name, the mix and
// the notices are handled here.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/app_lang.dart' show AppLang;
import '../../app/providers.dart' show appDepsProvider;
import '../labels_cam.dart';
import '../shell/live_camera_gateway.dart' show AudioSourceMix;
import 'live_controller.dart' show livePublisherProvider;
import 'live_source.dart';
import 'mic_devices.dart';
import 'publisher.dart';

/// One microphone the device offers.
class MicInfo {
  const MicInfo({required this.deviceId, required this.label, this.kind = ''});

  /// What the platform gives (the browser's deviceId; on Android type and
  /// product name, which stay the same when the mic is plugged in again).
  final String deviceId;
  final String label;

  /// Android: `builtin` or `external`, a neutral kind the app words in its own language when the system gave no
  /// product name. Empty where the platform gives a label (the browser).
  final String kind;

  /// What "seen before" is judged by: the id, else the label.
  String get key => deviceId.isNotEmpty ? deviceId : label.trim();

  /// The name to show: the product name, else the kind in the app language; null when there is neither.
  String? nameIn(AppLang l) {
    if (label.trim().isNotEmpty) return label.trim();
    return switch (kind) {
      'builtin' => liveMicBuiltinName(l),
      'external' => liveMicExternalName(l),
      _ => null,
    };
  }
}

abstract class MicDevices {
  Future<List<MicInfo>> list();

  /// Fires when the platform says the list changed (may never fire).
  Stream<void> get changes;

  /// Also read the list this often (null = only on [changes]).
  Duration? get pollEvery;

  /// Android: a plain 3-pole plug in a 4-pole jack shows as headphones with no microphone.
  Future<bool> headphonesWithoutMic() async => false;
}

/// Android: the system's input devices through the live channel.
class ChannelMicDevices implements MicDevices {
  ChannelMicDevices([MethodChannel? channel]) : _channel = channel ?? const MethodChannel('my.maxcom/live');
  final MethodChannel _channel;

  @override
  Duration? get pollEvery => const Duration(seconds: 3);

  @override
  Stream<void> get changes => const Stream.empty();

  @override
  Future<bool> headphonesWithoutMic() async {
    try {
      return await _channel.invokeMethod<bool>('headphonesWithoutMic') ?? false;
    } on Object {
      return false;
    }
  }

  @override
  Future<List<MicInfo>> list() async {
    final List<dynamic>? l;
    try {
      l = await _channel.invokeMethod<List<dynamic>>('audioInputs');
    } on MissingPluginException {
      return const []; // no live plugin here (tests, an older build)
    }
    return [
      for (final m in l ?? const <dynamic>[])
        if (m is Map)
          MicInfo(
            deviceId: '${m['id']}',
            label: m['name'] is String ? m['name'] as String : '',
            kind: m['kind'] == 'builtin' || m['kind'] == 'external' ? m['kind'] as String : '',
          ),
    ];
  }
}

/// The microphones this device has met, small and capped.
abstract class SeenMicsStore {
  /// Null until the first run recorded the built-in ones.
  Future<List<String>?> load();
  Future<void> save(List<String> keys);
}

const int seenMicsCap = 40;

class PrefsSeenMicsStore implements SeenMicsStore {
  const PrefsSeenMicsStore();
  static const _key = 'live.seenMics.v1';

  @override
  Future<List<String>?> load() async {
    try {
      return (await SharedPreferences.getInstance()).getStringList(_key);
    } on Object {
      return null;
    }
  }

  @override
  Future<void> save(List<String> keys) async {
    try {
      await (await SharedPreferences.getInstance()).setStringList(_key, keys);
    } on Object {
      // storage blocked: the list lasts for this run
    }
  }
}

final micDevicesProvider = Provider<MicDevices?>((ref) {
  final platform = ref.watch(appDepsProvider).platform;
  if (platform == 'android') return ChannelMicDevices();
  return browserMicDevices();
});

final seenMicsStoreProvider = Provider<SeenMicsStore>((_) => const PrefsSeenMicsStore());

/// How long a microphone that could not be opened waits before the one retry.
final micRetryDelayProvider = Provider<Duration>((_) => const Duration(seconds: 2));

enum MicToastKind { added, unplugged }

class MicToast {
  const MicToast(this.seq, this.kind, this.name, {this.undo = false, this.micKind = ''});
  final int seq;
  final MicToastKind kind;
  final String name;

  /// The microphone's neutral kind, worded in [MicAutoNotifier.toastText] when [name] is empty.
  final String micKind;

  /// "Batal" is offered.
  final bool undo;
}

class MicAutoState {
  const MicAutoState({this.mic, this.toast, this.trrsHint = false});

  /// Headphones are plugged in but no microphone: the person needs a 4-pole (TRRS) plug.
  final bool trrsHint;

  /// The plugged-in microphone in use; null = the device's own.
  final MicInfo? mic;
  final MicToast? toast;

  String? get label => mic?.label;
}

class _Undo {
  const _Undo(this.mic, this.mix);
  final MicInfo? mic;
  final AudioSourceMix? mix;
}

final micAutoProvider = NotifierProvider<MicAutoNotifier, MicAutoState>(MicAutoNotifier.new);

class MicAutoNotifier extends Notifier<MicAutoState> {
  Timer? _timer;
  StreamSubscription<void>? _sub;
  bool _running = false;
  bool _busy = false;
  bool _again = false;
  int _seq = 0;
  List<String>? _seen;
  MicInfo? _returning;
  _Undo? _undo;

  @override
  MicAutoState build() {
    ref.onDispose(stop);
    return const MicAutoState();
  }

  /// The Live tab is open: watch the microphones.
  void start() {
    if (_running) return;
    final d = ref.read(micDevicesProvider);
    if (d == null) return;
    _running = true;
    _sub = d.changes.listen((_) => unawaited(check()));
    final every = d.pollEvery;
    if (every != null) _timer = Timer.periodic(every, (_) => unawaited(check()));
    unawaited(check());
  }

  void stop() {
    _running = false;
    _timer?.cancel();
    _timer = null;
    _sub?.cancel();
    _sub = null;
  }

  /// Reads the list and reacts. Calls that overlap run one after the other.
  Future<void> check() async {
    if (!_running) return;
    if (_busy) {
      _again = true;
      return;
    }
    _busy = true;
    try {
      do {
        _again = false;
        await _reconcile();
      } while (_again && _running);
    } on Object catch (e) {
      debugPrint('mic watch failed: ${e.runtimeType}');
    } finally {
      _busy = false;
    }
  }

  LiveMicControl? get _control {
    final p = ref.read(livePublisherProvider);
    return p is LiveMicControl ? p as LiveMicControl : null;
  }

  Future<void> _reconcile() async {
    final dev = ref.read(micDevicesProvider);
    if (dev == null) return;
    final byKey = <String, MicInfo>{};
    for (final m in await dev.list()) {
      // the browser's virtual "default" and "communications" entries repeat a real one
      if (m.deviceId == 'default' || m.deviceId == 'communications') continue;
      if (m.key.isEmpty) continue;
      byKey.putIfAbsent(m.key, () => m);
    }
    final list = byKey.values.toList();
    await _trrs(dev, list);
    // no microphone permission yet: the browser gives empty labels. Wait.
    if (list.isEmpty || list.any((m) => m.label.trim().isEmpty && m.kind.isEmpty)) return;
    final store = ref.read(seenMicsStoreProvider);
    var seen = _seen ??= await store.load();
    if (seen == null) {
      // first run: what is here now is the device's own (or already attached)
      _seen = _capped([for (final m in list) m.key]);
      await store.save(_seen!);
      return;
    }
    final inUse = state.mic;
    if (inUse != null && !byKey.containsKey(inUse.key)) {
      await _unplugged(inUse);
    }
    final fresh = [
      for (final m in list)
        if (!seen.contains(m.key)) m,
    ];
    if (fresh.isNotEmpty) {
      // A mic counts as seen only after it was used: one that could not be
      // opened (once more after a short wait) is tried again at the next read.
      final pick = fresh.last;
      var used = await _use(pick, announce: true);
      if (!used && _running) {
        await Future<void>.delayed(ref.read(micRetryDelayProvider));
        if (_running) used = await _use(pick, announce: true);
      }
      if (used) {
        seen = _seen = _capped([...seen, for (final m in fresh) m.key]);
        await store.save(seen);
      }
      return;
    }
    final back = _returning;
    if (back != null && state.mic == null && byKey.containsKey(back.key)) {
      _returning = null;
      await _use(byKey[back.key]!, announce: false);
    }
  }

  /// Headphones without a microphone seen and no external microphone listed: say the plug must be 4-pole (TRRS).
  Future<void> _trrs(MicDevices dev, List<MicInfo> list) async {
    final hint = list.every((m) => m.kind != 'external') && await dev.headphonesWithoutMic();
    if (hint != state.trrsHint) state = MicAutoState(mic: state.mic, toast: state.toast, trrsHint: hint);
  }

  List<String> _capped(List<String> keys) => keys.length <= seenMicsCap ? keys : keys.sublist(keys.length - seenMicsCap);

  Future<bool> _use(MicInfo mic, {required bool announce}) async {
    final src = ref.read(liveSourceProvider.notifier);
    final before = ref.read(liveSourceProvider).mix.deviceMic;
    final ctl = _control;
    if (ctl != null && !await ctl.setMicrophone(mic.deviceId)) return false;
    final prev = state.mic;
    state = MicAutoState(mic: mic, toast: state.toast, trrsHint: state.trrsHint);
    if (!announce) return true;
    final wasOff = ref.read(liveSourceProvider).external && !before.enabled;
    if (wasOff) await src.setDeviceMic(const AudioSourceMix(enabled: true, volume: 100));
    // Android: the system chose the microphone, only the mix can be undone
    final canUndo = ctl != null || wasOff;
    _undo = canUndo ? _Undo(prev, wasOff ? before : null) : null;
    state = MicAutoState(
      mic: mic,
      toast: MicToast(++_seq, MicToastKind.added, mic.label, undo: canUndo, micKind: mic.kind),
      trrsHint: state.trrsHint,
    );
    return true;
  }

  Future<void> _unplugged(MicInfo gone) async {
    _returning = gone;
    _undo = null;
    await _control?.setMicrophone(null);
    state = MicAutoState(toast: MicToast(++_seq, MicToastKind.unplugged, gone.label, micKind: gone.kind), trrsHint: state.trrsHint);
  }

  /// "Batal": back to the microphone and the on or off state before; the
  /// microphone stays "seen" so it is not switched on again.
  Future<void> undo() async {
    final u = _undo;
    if (u == null) return;
    _undo = null;
    final ctl = _control;
    // Android: "own" keeps the device microphone chosen (null would pick the plugged-in one again)
    if (ctl != null) await ctl.setMicrophone(u.mic?.deviceId ?? ctl.ownMicrophoneId);
    state = MicAutoState(mic: u.mic, trrsHint: state.trrsHint);
    final m = u.mix;
    if (m != null) await ref.read(liveSourceProvider.notifier).setDeviceMic(m);
  }

  /// The words of a toast in the app language.
  static String toastText(MicToast t, AppLang lang) {
    final name = MicInfo(deviceId: '', label: t.name, kind: t.micKind).nameIn(lang) ?? t.name;
    return t.kind == MicToastKind.added ? liveMicNewToast(lang, name) : liveMicUnplugged(lang, name);
  }
}
