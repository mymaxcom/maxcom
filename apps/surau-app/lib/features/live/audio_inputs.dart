// The Audio card's rows for every input the live can hear (2026.11.15, lane P1): each phone input is its own row
// (on or off, volume, loudness lift), found by itself while the Live tab is open (mic_watch.dart keeps the list), the
// camera sound and Mic-in keep their rows. What the person sets per source (the lift and the volume of each phone
// input) is remembered on this device, like the camera's saved audio offset, and a plain `Naikkan suara perlahan`
// switch reaches the engine through [LiveLiftControl].
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/app_lang.dart';
import '../shell/live_camera_gateway.dart' show AudioSourceMix;
import 'live_controller.dart' show livePublisherProvider;
import 'live_source.dart';
import 'mic_watch.dart';
import 'publisher.dart' show LiveLiftControl;

// ---- the rows' inputs ----

/// The inputs of the Audio card from what the microphone watch has met. [routedId] is the device the system routed
/// the recording to (Android), null when not known. Empty while nothing is known.
List<PhoneInput> phoneInputs(MicAutoState s, {String? routedId, required AppLang lang}) {
  final active = sharedActiveInputKey(s, routedId: routedId);
  return [
    for (final m in s.inputs)
      PhoneInput(
        key: m.key,
        name: m.nameIn(lang) ?? liveMicBuiltinNameFor(lang),
        kind: m.kind,
        present: s.present.contains(m.key),
        active: m.key == active,
        denied: s.denied.contains(m.key),
      ),
  ];
}

/// The ONE place the active input key is worked out: the rows, the tap handler and the lift listener all call it.
String? sharedActiveInputKey(MicAutoState s, {String? routedId}) =>
    activeInputKey(s.inputs, chosenKey: s.chosenKey, routedId: routedId, micKey: s.mic?.key);

/// A name for an input that has neither a label nor a kind (the browser before it gave labels).
String liveMicBuiltinNameFor(AppLang l) => MicInfo(deviceId: '', label: '', kind: 'builtin').nameIn(l) ?? '';

// ---- what the person set per source ----

/// The lift and the volume saved for one source key (`camera`, `mic:<input key>`).
class SourcePref {
  const SourcePref({this.lift = true, this.volume});
  final bool lift;

  /// The volume of a phone input (only used when it is switched on); null = nothing saved.
  final int? volume;

  SourcePref copyWith({bool? lift, int? volume}) => SourcePref(lift: lift ?? this.lift, volume: volume ?? this.volume);

  Map<String, Object?> toJson() => {'lift': lift, if (volume != null) 'volume': volume};
}

abstract class AudioPrefsStore {
  Future<Map<String, SourcePref>> load();
  Future<void> save(Map<String, SourcePref> prefs);
}

/// How many sources are remembered (the oldest go first).
const int audioPrefsCap = 40;

class PrefsAudioPrefsStore implements AudioPrefsStore {
  const PrefsAudioPrefsStore();
  static const _key = 'live.audioPrefs.v1';

  @override
  Future<Map<String, SourcePref>> load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return const {};
      final j = jsonDecode(raw);
      if (j is! Map) return const {};
      final out = <String, SourcePref>{};
      for (final e in j.entries) {
        final v = e.value;
        if (e.key is! String || v is! Map) continue;
        final vol = v['volume'];
        out[e.key as String] = SourcePref(lift: v['lift'] is bool ? v['lift'] as bool : true, volume: vol is int ? vol.clamp(0, 100) : null);
      }
      return out;
    } on Object {
      return const {};
    }
  }

  @override
  Future<void> save(Map<String, SourcePref> prefs) async {
    try {
      await (await SharedPreferences.getInstance()).setString(
        _key,
        jsonEncode({for (final e in prefs.entries) e.key: e.value.toJson()}),
      );
    } on Object {
      // storage blocked: the choices last for this run
    }
  }
}

final audioPrefsStoreProvider = Provider<AudioPrefsStore>((_) => const PrefsAudioPrefsStore());

class AudioPrefsState {
  const AudioPrefsState({this.by = const {}, this.loaded = false});
  final Map<String, SourcePref> by;
  final bool loaded;

  bool liftOf(String key) => by[key]?.lift ?? true;
  int? volumeOf(String key) => by[key]?.volume;

  /// The lifts as the Audio card reads them.
  Map<String, bool> get lifts => {for (final e in by.entries) e.key: e.value.lift};

  /// The volumes of the phone inputs by input key (the `mic:` prefix removed).
  Map<String, int> get inputVolumes => {
    for (final e in by.entries)
      if (e.key.startsWith(micRowPrefix) && e.value.volume != null) e.key.substring(micRowPrefix.length): e.value.volume!,
  };
}

final audioPrefsProvider = NotifierProvider<AudioPrefsNotifier, AudioPrefsState>(AudioPrefsNotifier.new);

class AudioPrefsNotifier extends Notifier<AudioPrefsState> {
  Future<void>? _loading;
  Map<String, bool> _pushed = {};

  @override
  AudioPrefsState build() {
    // the engine hears the lift of the input in use: tell it when the inputs or the choice change, or when the
    // system routes the recording to another device. The key is worked out in ONE place ([currentActiveKey]),
    // the same as the rows and the tap handler use.
    ref.listen<MicAutoState>(micAutoProvider, (_, _) {
      unawaited(sync(currentActiveKey()));
    });
    _watchRoute();
    ref.listen(livePublisherProvider, (_, _) => _watchRoute());
    ref.onDispose(() => _routeSub?.cancel());
    final first = _loading = _load();
    unawaited(first.then((_) => sync(currentActiveKey())));
    return const AudioPrefsState();
  }

  StreamSubscription<String?>? _routeSub;

  void _watchRoute() {
    _routeSub?.cancel();
    _routeSub = ref.read(livePublisherProvider).states.map((s) => s.micRoute?.id).distinct().listen((_) {
      unawaited(sync(currentActiveKey()));
    });
  }

  /// The key of the input in use now: the chosen one, else the one the system routed (the publisher's
  /// `micRoute`), else the plugged-in one, else the device's own.
  String? currentActiveKey() =>
      sharedActiveInputKey(ref.read(micAutoProvider), routedId: ref.read(livePublisherProvider).current.micRoute?.id);

  Future<void> ensureLoaded() => _loading ??= _load();

  Future<void> _load() async {
    final by = await ref.read(audioPrefsStoreProvider).load();
    state = AudioPrefsState(by: {...by, ...state.by}, loaded: true);
  }

  Future<void> setLift(String key, bool on) async {
    await ensureLoaded();
    final cur = state.by[key] ?? const SourcePref();
    _store(key, cur.copyWith(lift: on));
  }

  Future<void> setVolume(String key, int v) async {
    await ensureLoaded();
    final cur = state.by[key] ?? const SourcePref();
    _store(key, cur.copyWith(volume: v.clamp(0, 100)));
  }

  void _store(String key, SourcePref p) {
    final next = {...state.by}..remove(key);
    next[key] = p; // most recent last
    while (next.length > audioPrefsCap) {
      next.remove(next.keys.first);
    }
    state = AudioPrefsState(by: next, loaded: true);
    unawaited(ref.read(audioPrefsStoreProvider).save(next));
  }

  /// Tells the engine the lift of the camera sound and of the microphone in use ([activeInputKey]), when it changed.
  Future<void> sync(String? activeInputKey) async {
    await ensureLoaded();
    final p = ref.read(livePublisherProvider);
    if (p is! LiveLiftControl) return;
    final ctl = p as LiveLiftControl;
    final want = {
      'camera': state.liftOf('camera'),
      'deviceMic': state.liftOf('$micRowPrefix${activeInputKey ?? 'own'}'),
    };
    for (final e in want.entries) {
      if (_pushed[e.key] == e.value) continue;
      try {
        await ctl.setLift(e.key, e.value);
        _pushed = {..._pushed, e.key: e.value};
      } on Object catch (err) {
        debugPrint('live lift failed: ${err.runtimeType}');
      }
    }
  }
}

// ---- what a tap on a row does ----

final audioRowActionsProvider = Provider<AudioRowActions>(AudioRowActions.new);

class AudioRowActions {
  AudioRowActions(this._ref);
  final Ref _ref;

  final Map<String, int> _beforeMute = {};

  PhoneInput? _input(String rowId, List<PhoneInput> inputs) {
    for (final i in inputs) {
      if (i.rowId == rowId) return i;
    }
    return null;
  }

  /// The source key a row's lift is saved under.
  String liftKeyOf(String rowId, List<PhoneInput> inputs) {
    if (rowId == idCamera) return 'camera';
    final i = _input(rowId, inputs);
    if (i != null) return i.liftKey;
    return '${micRowPrefix}own';
  }

  String? _activeKey(List<PhoneInput> inputs) {
    for (final i in inputs) {
      if (i.active) return i.key;
    }
    return null;
  }

  Future<void> volume(String rowId, int v, List<PhoneInput> inputs) async {
    final src = _ref.read(liveSourceProvider.notifier);
    final i = _input(rowId, inputs);
    if (rowId == idDeviceMic) {
      await src.setVolume(idDeviceMic, v);
      if (i != null) await _ref.read(audioPrefsProvider.notifier).setVolume(i.liftKey, v);
    } else if (i != null) {
      // an input that is off: only its saved volume moves (it applies when it is switched on)
      await _ref.read(audioPrefsProvider.notifier).setVolume(i.liftKey, v);
    } else {
      await src.setVolume(rowId, v);
    }
  }

  Future<void> lift(String rowId, bool on, List<PhoneInput> inputs) async {
    final prefs = _ref.read(audioPrefsProvider.notifier);
    await prefs.setLift(liftKeyOf(rowId, inputs), on);
    await prefs.sync(_activeKey(inputs));
  }

  /// A row's own mute: its volume to 0 and back to what it was.
  Future<void> muteRow(String rowId) async {
    final src = _ref.read(liveSourceProvider.notifier);
    final cur = mixOf(_ref.read(liveSourceProvider).mix, rowId).volume;
    if (cur > 0) {
      _beforeMute[rowId] = cur;
      await src.setVolume(rowId, 0);
    } else {
      await src.setVolume(rowId, _beforeMute[rowId] ?? 100);
    }
  }

  /// A phone input's switch. On: the sound comes from it (and the device microphone is switched on with the external
  /// camera); with the other phone input going off, as the engine takes one at a time. Off: only the input in use
  /// with the external camera can be switched off.
  Future<void> toggle(String rowId, bool on, List<PhoneInput> inputs) async {
    final src = _ref.read(liveSourceProvider.notifier);
    final i = _input(rowId, inputs);
    if (i == null) return;
    if (!on) {
      if (i.active) await src.remove(idDeviceMic);
      return;
    }
    final mic = _ref.read(micAutoProvider.notifier);
    final info = _ref.read(micAutoProvider).inputs.where((m) => m.key == i.key);
    if (info.isEmpty) return;
    if (!await mic.chooseInput(info.first)) return;
    final saved = _ref.read(audioPrefsProvider).volumeOf(i.liftKey);
    final st = _ref.read(liveSourceProvider);
    final vol = saved ?? st.mix.deviceMic.volume;
    if (st.external) {
      await src.setDeviceMic(AudioSourceMix(enabled: true, volume: vol));
    } else if (vol != st.mix.deviceMic.volume) {
      await src.setVolume(idDeviceMic, vol);
    }
    await _ref.read(audioPrefsProvider.notifier).sync(i.key);
  }
}
