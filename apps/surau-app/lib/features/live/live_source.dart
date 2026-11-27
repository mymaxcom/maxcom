// The picture source and the audio mix of the Live tab (plan rev 4, task C2):
// what the person chose ("Sumber video", "Audio"), remembered on this device,
// pushed to the publisher, and turned into the rows and messages of the
// screen. The pure functions at the bottom ([buildAudioRows],
// [buildAudioNotices]) hold every rule of plan 4.4 and 4.7 and the accepted
// mockups, so the widgets only draw.
//
// The camera address is fetched when a session is prepared or started and
// handed to the publisher in [PublisherConfig.camera]; it is never kept in
// state, storage or logs.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/app_lang.dart' show AppLang, appLangProvider;
import '../../app/providers.dart';
import '../../box/box_client.dart' show BoxError;
import '../../l10n/s_lookup.dart' show sFor;
import '../labels_cam.dart';
import '../shell/box_gateway.dart' show BoxGateway;
import '../settings_defaults.dart';
import '../shell/live_camera_gateway.dart';
import 'live_controller.dart';
import 'publisher.dart';
import 'web_publisher.dart';

// ---- the mix ----

const String idCamera = 'camera';
const String idDeviceMic = 'deviceMic';
const String idBoxInput = 'boxInput';

/// Volumes move in steps of 5 (plan 4.2).
int stepVolume(num v) => ((v.clamp(0, 100)) / 5).round() * 5;

/// The mix a video source starts with (core `defaultAudioMix`): the external
/// camera's own audio at 100, or the phone's own microphone with today's mute.
LiveAudioMix defaultMix(VideoSourceKind video) => LiveAudioMix(
  camera: AudioSourceMix(enabled: video == VideoSourceKind.external, volume: 100),
  deviceMic: AudioSourceMix(enabled: video == VideoSourceKind.phone, volume: 100),
  boxInput: const AudioSourceMix(enabled: false, volume: 100),
);

/// The mix of a live the BOX pulls when the box has a jack input (build 4): the box microphone is the main sound at
/// 100 and the camera sound stays in the graph at 0 (raised only for the sound of the hall).
LiveAudioMix boxMainMix(LiveAudioMix m) => LiveAudioMix(
  camera: AudioSourceMix(enabled: m.camera.enabled, volume: 0),
  deviceMic: m.deviceMic,
  boxInput: const AudioSourceMix(enabled: true, volume: 100),
);

/// The untouched default of an external camera (camera 100, nothing else): a remembered mix equal to it counts as
/// "never chosen", so the box-pull default may replace it.
bool isPlainExternalDefault(LiveAudioMix m) =>
    m.camera.enabled && m.camera.volume == 100 && !m.deviceMic.enabled && !m.boxInput.enabled;

/// The box keeps the sound of its microphone this many ms behind the picture before the offset is added: the box's
/// `delayMs` of a source is the headroom plus the offset, while the stepper of the app counts the offset.
const int boxSyncHeadroomMs = 2000;

/// The offset (0 to 2000 ms) behind an absolute `delayMs` the box reports.
int boxSyncOffsetOf(int delayMs) => (delayMs - boxSyncHeadroomMs).clamp(0, 2000);

/// The same offset rounded to a step of 50 ms, to seed the stepper from what the box was using.
int boxSyncSeedOf(int delayMs) => ((boxSyncOffsetOf(delayMs) / 50).round() * 50).clamp(0, 2000);

/// The offset the sync block shows, on the one scale of every state (auto, busy, manual).
///
/// While the person is stepping here ([localManual]) the remembered value is the truth and a late status never moves
/// the stepper back. A box that reports `manual` and sends its delay says the value itself; without one the remembered
/// value stays. Auto and busy show the delay the box is using, as an offset.
int boxSyncShown({
  required bool localManual,
  required String? alignState,
  required int? delayMs,
  required int remembered,
}) {
  if (localManual) return remembered;
  if (delayMs == null) return remembered;
  return boxSyncOffsetOf(delayMs);
}

AudioSourceMix mixOf(LiveAudioMix m, String id) => switch (id) {
  idCamera => m.camera,
  idDeviceMic => m.deviceMic,
  _ => m.boxInput,
};

LiveAudioMix withSource(LiveAudioMix m, String id, AudioSourceMix v) => LiveAudioMix(
  camera: id == idCamera ? v : m.camera,
  deviceMic: id == idDeviceMic ? v : m.deviceMic,
  boxInput: id == idBoxInput ? v : m.boxInput,
);

/// One sound only (build 6, core `soloAudioMix`): the same priority, the box microphone first.
const List<String> soloPriority = [idBoxInput, idDeviceMic, idCamera];

/// A copy of [m] with at most ONE source enabled: [prefer] when it is enabled, else the first enabled source of
/// [soloPriority] (a source at volume 0 loses to an audible one). Volumes stay as they are; none enabled stays none.
LiveAudioMix soloMix(LiveAudioMix m, {String? prefer}) {
  final on = [for (final id in soloPriority) if (mixOf(m, id).enabled) id];
  if (on.isEmpty) return m;
  final String keep;
  if (prefer != null && on.contains(prefer)) {
    keep = prefer;
  } else {
    final audible = [for (final id in on) if (mixOf(m, id).volume > 0) id];
    keep = (audible.isEmpty ? on : audible).first;
  }
  AudioSourceMix one(String id) => AudioSourceMix(enabled: id == keep, volume: mixOf(m, id).volume);
  return LiveAudioMix(camera: one(idCamera), deviceMic: one(idDeviceMic), boxInput: one(idBoxInput));
}

/// The source that is on air in [m] (enabled and above 0), or null.
String? soundOn(LiveAudioMix m) {
  for (final id in soloPriority) {
    final s = mixOf(m, id);
    if (s.enabled && s.volume > 0) return id;
  }
  return null;
}

/// [m] with [id] turned on (its last volume, or 100 when that was 0) and every other source off.
LiveAudioMix turnOn(LiveAudioMix m, String id) {
  final cur = mixOf(m, id);
  return soloMix(withSource(m, id, AudioSourceMix(enabled: true, volume: cur.volume == 0 ? 100 : cur.volume)), prefer: id);
}

bool _mixEquals(LiveAudioMix a, LiveAudioMix b) =>
    jsonEncode(a.toJson()) == jsonEncode(b.toJson());

/// Every source off or at volume 0 (the all-muted warning). [muted] is the
/// phone microphone's own mute (today's flow).
bool mixAllMuted(LiveAudioMix m, {bool muted = false, bool phone = true}) {
  bool audible(AudioSourceMix s, {bool mute = false}) => s.enabled && s.volume > 0 && !mute;
  // the phone's mute silences everything the phone sends: its microphone and the camera sound it relays
  return !(audible(m.camera, mute: muted && phone) || audible(m.deviceMic, mute: muted) || audible(m.boxInput));
}

// ---- what the camera is ----

/// The external camera as the screen knows it: the switch and name from the
/// settings, the last test from the box record. Never holds the address.
class LiveCameraInfo {
  const LiveCameraInfo({
    this.enabled = false,
    this.name = '',
    this.configured = false,
    this.hasAudio,
    this.reachable,
    this.spec,
    this.control = const LiveCameraControl(),
  });

  /// "Tawarkan kamera luaran" is on.
  final bool enabled;
  final String name;
  final bool configured;

  /// From the last test; null while unknown.
  final bool? hasAudio;

  /// The last test reached the camera; null while untested.
  final bool? reachable;

  /// `1080p, 25 bingkai sesaat`, when known.
  final String? spec;

  /// Lane X: the network control opt-in of the saved camera (off unless the box says so).
  final LiveCameraControl control;

  /// Offered in the picker: switched on and an address is saved.
  bool get offered => enabled && configured;

  LiveCameraInfo copyWith({bool? enabled, String? name, bool? configured, Object? hasAudio = _k, Object? reachable = _k}) =>
      LiveCameraInfo(
        enabled: enabled ?? this.enabled,
        name: name ?? this.name,
        configured: configured ?? this.configured,
        hasAudio: identical(hasAudio, _k) ? this.hasAudio : hasAudio as bool?,
        reachable: identical(reachable, _k) ? this.reachable : reachable as bool?,
        spec: spec,
        control: control,
      );
}

const Object _k = Object();

// ---- state ----

class LiveSourceState {
  const LiveSourceState({
    this.video = VideoSourceKind.phone,
    required this.mix,
    this.offsets = const {idDeviceMic: 0, idBoxInput: 0},
    this.camera = const LiveCameraInfo(),
    this.boxInputAvailable = false,
    this.boxInputReason,
    this.loaded = false,
    this.error,
    this.startedExternal = false,
    this.videoPath = videoPathDevice,
    this.cameraInUse = false,
    this.cameraRefused = false,
    this.listed = const {},
  });

  /// The sound rows the Audio card lists (build 6). The box keeps ONE source enabled, so a row that another pick turned
  /// off stays listed here as an off row; only its X button (or never having been added) takes it out of the list.
  final Set<String> listed;

  /// The box refused this device the camera's address (`camera_in_use`) at the
  /// last prepare: another device holds it. Cleared when the source is read again.
  final bool cameraRefused;

  /// No pull of the camera by this device: the flag, or the box's refusal, says it is taken.
  bool get cameraBusy => cameraInUse || cameraRefused;

  /// Who pulls the external camera on an Android phone ("Video diambil oleh"):
  /// [videoPathDevice] (this phone, the default) or [videoPathBox] (the MAXCOM
  /// Kiosk Box: the phone only controls and records nothing).
  final String videoPath;

  /// The box's "camera in use" flag says another device (or the box) pulls
  /// the camera: this device opens no pull of its own and shows the shared
  /// picture through the box.
  final bool cameraInUse;

  final VideoSourceKind video;
  final LiveAudioMix mix;

  /// "Imbangan masa audio" per added source (a camera with no audio only).
  final Map<String, int> offsets;
  final LiveCameraInfo camera;
  final bool boxInputAvailable;
  final String? boxInputReason;
  final bool loaded;

  /// A problem the screen words (the camera address could not be fetched).
  final String? error;

  /// The running (or just stopped) live began on the external camera: kept here, not in the
  /// screen, so "Tukar ke kamera luaran" is still offered after the page is rebuilt mid-live.
  final bool startedExternal;

  bool get external => video == VideoSourceKind.external;

  /// The external camera with the box pulling it by the admin's choice.
  bool get boxPull => external && videoPath == videoPathBox;

  /// The camera has no audio track (known from a test).
  bool get cameraNoAudio => external && camera.hasAudio == false;

  LiveSourceState copyWith({
    VideoSourceKind? video,
    LiveAudioMix? mix,
    Map<String, int>? offsets,
    LiveCameraInfo? camera,
    bool? boxInputAvailable,
    Object? boxInputReason = _k,
    bool? loaded,
    Object? error = _k,
    bool? startedExternal,
    String? videoPath,
    bool? cameraInUse,
    bool? cameraRefused,
    Set<String>? listed,
  }) => LiveSourceState(
    listed: listed ?? this.listed,
    cameraRefused: cameraRefused ?? this.cameraRefused,
    videoPath: videoPath ?? this.videoPath,
    cameraInUse: cameraInUse ?? this.cameraInUse,
    video: video ?? this.video,
    mix: mix ?? this.mix,
    offsets: offsets ?? this.offsets,
    camera: camera ?? this.camera,
    boxInputAvailable: boxInputAvailable ?? this.boxInputAvailable,
    boxInputReason: identical(boxInputReason, _k) ? this.boxInputReason : boxInputReason as String?,
    loaded: loaded ?? this.loaded,
    error: identical(error, _k) ? this.error : error as String?,
    startedExternal: startedExternal ?? this.startedExternal,
  );
}

const String videoPathDevice = 'device';
const String videoPathBox = 'box';

// ---- remembered on this device ----

/// "Video diambil oleh", kept per device beside the source choice. Its own
/// small store, so the source store's shape stays as it is.
abstract class LiveVideoPathStore {
  Future<String?> read();
  Future<void> write(String path);
}

class PrefsLiveVideoPathStore implements LiveVideoPathStore {
  const PrefsLiveVideoPathStore();

  static const _key = 'live.videoPath.v1';

  @override
  Future<String?> read() async {
    try {
      final v = (await SharedPreferences.getInstance()).getString(_key);
      return v == videoPathBox || v == videoPathDevice ? v : null;
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(String path) async {
    try {
      await (await SharedPreferences.getInstance()).setString(_key, path);
    } on Object {
      // storage can be blocked: the choice lasts for this run
    }
  }
}

final liveVideoPathStoreProvider = Provider<LiveVideoPathStore>((_) => const PrefsLiveVideoPathStore());

/// Whether the box-main default (box microphone 100, camera sound 0) has been applied once, or the person chose a mix
/// by hand: from then on a camera-only mix the person set is never rewritten (the rollback of the plan keeps working).
abstract class LiveBoxMainStore {
  Future<bool> read();
  Future<void> markDecided();
}

class PrefsLiveBoxMainStore implements LiveBoxMainStore {
  const PrefsLiveBoxMainStore();

  static const _key = 'live.boxMainDecided.v1';

  @override
  Future<bool> read() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(_key) ?? false;
    } on Object {
      return false;
    }
  }

  @override
  Future<void> markDecided() async {
    try {
      await (await SharedPreferences.getInstance()).setBool(_key, true);
    } on Object {
      // storage can be blocked: the choice lasts for this run
    }
  }
}

final liveBoxMainStoreProvider = Provider<LiveBoxMainStore>((_) => const PrefsLiveBoxMainStore());

/// The last video source and mix, kept per device (app preferences, browser
/// storage). Not a registry setting: nothing unused or conflicting is added.
abstract class LiveSourceStore {
  Future<({VideoSourceKind video, LiveAudioMix mix, Map<String, int> offsets})?> read();
  Future<void> write(VideoSourceKind video, LiveAudioMix mix);
}

class PrefsLiveSourceStore implements LiveSourceStore {
  const PrefsLiveSourceStore();

  static const _key = 'live.source.v1';

  @override
  Future<({VideoSourceKind video, LiveAudioMix mix, Map<String, int> offsets})?> read() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return null;
      final j = jsonDecode(raw);
      if (j is! Map) return null;
      final video = j['video'] == 'external' ? VideoSourceKind.external : VideoSourceKind.phone;
      AudioSourceMix one(Object? v, AudioSourceMix d) => v is Map
          ? AudioSourceMix(
              enabled: v['enabled'] == true,
              volume: v['volume'] is num ? stepVolume(v['volume'] as num) : d.volume,
            )
          : d;
      final base = defaultMix(video);
      final m = j['mix'];
      final mix = m is Map
          ? LiveAudioMix(
              camera: one(m['camera'], base.camera),
              deviceMic: one(m['deviceMic'], base.deviceMic),
              boxInput: one(m['boxInput'], base.boxInput),
            )
          : base;
      return (video: video, mix: mix, offsets: const {idDeviceMic: 0, idBoxInput: 0});
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(VideoSourceKind video, LiveAudioMix mix) async {
    try {
      await (await SharedPreferences.getInstance()).setString(
        _key,
        jsonEncode({'video': video == VideoSourceKind.external ? 'external' : 'phone', 'mix': mix.toJson()}),
      );
    } on Object {
      // storage can be blocked (private window): the choice lasts for this run
    }
  }
}

/// `phone` (Android: the phone pulls the camera) or `ipad` (the browser: the box pulls it). Tests override it.
final liveDeviceKindProvider = Provider<String>(
  (ref) => ref.watch(appDepsProvider).platform == 'android' ? 'phone' : 'ipad',
);

final liveSourceStoreProvider = Provider<LiveSourceStore>((_) => const PrefsLiveSourceStore());

// ---- the notifier ----

final liveSourceProvider = NotifierProvider<LiveSourceNotifier, LiveSourceState>(LiveSourceNotifier.new);

class LiveSourceNotifier extends Notifier<LiveSourceState> {
  Future<void>? _loading;

  // The external camera was chosen (and stays the saved choice) but its address
  // could not be fetched: for this page the phone camera is used, in memory
  // only. [_fallbackCamera] is the camera setting (switch + address saved) it
  // happened under; a change of that setting, the user picking the external
  // camera again or reopening the page ([reloadForPage]) ends the fallback.
  bool _fellBack = false;
  String? _fallbackCamera;
  int _selectGen = 0; // bumped by every [selectVideo]: a stale rollback is dropped

  // The box-main default is for a fresh mix, once, and only on a box that has the new controls (`canToggleKiosk`).
  bool _boxMainDecided = false;

  bool get _newBox {
    try {
      return ref.read(liveBoxProvider).canToggleKiosk;
    } on Object {
      return false;
    }
  }

  bool _mayApplyBoxMain(LiveAudioMix mix) => !_boxMainDecided && _newBox && isPlainExternalDefault(mix);

  /// The external camera goes through the box now (the web always does): only a change made then settles the default.
  bool get _pathIsBox => state.external && (_isWeb || state.videoPath == videoPathBox);

  void _decideBoxMain() {
    if (_boxMainDecided) return;
    _boxMainDecided = true;
    unawaited(ref.read(liveBoxMainStoreProvider).markDecided());
  }

  /// The box has just told that it has the new controls: a fresh mix of a live the box pulls gets the box-main default now.
  void boxCapabilityKnown() {
    if (!state.loaded || _publisher.current.isLive) return;
    final pulledByBox = _isWeb || state.videoPath == videoPathBox;
    if (state.external && pulledByBox && state.boxInputAvailable && _mayApplyBoxMain(state.mix)) {
      _set(state.copyWith(mix: _normalise(state.video, boxMainMix(state.mix), state.camera)));
      _decideBoxMain();
    }
  }

  @override
  LiveSourceState build() => LiveSourceState(mix: defaultMix(VideoSourceKind.phone));

  LivePublisher get _publisher => ref.read(livePublisherProvider);

  /// Reads what this device remembers and what the box says about the camera
  /// and Mic-in. Once; [refresh] asks again.
  Future<void> ensureLoaded() => _loading ??= _load();

  Future<void> refresh() {
    _loading = null;
    return ensureLoaded();
  }

  /// The live page was (re)opened: the camera switch may have changed in Tetapan while no page was
  /// listening, so a state that is already loaded is read again; a first load is just joined.
  Future<void> reloadForPage() {
    _fellBack = false;
    return state.loaded ? refresh() : ensureLoaded();
  }

  /// A live is starting with the current source: remembered for the "Tukar ke kamera luaran" way back.
  void liveStarting() => state = state.copyWith(startedExternal: state.external, error: null);

  Future<void> _load() async {
    try {
      // the camera switch and name live in the settings: wait for them (briefly)
      await ref.read(settingsProvider.future).timeout(const Duration(seconds: 3));
    } on Object {
      // no settings yet: the box record below tells enough
    }
    final saved = await ref.read(liveSourceStoreProvider).read();
    _boxMainDecided = _boxMainDecided || await ref.read(liveBoxMainStoreProvider).read();
    // The starting phone pulls by default (operator decision of 22 Nov 2026); the box pull is a remembered choice.
    final savedPath = _isWeb ? null : await ref.read(liveVideoPathStoreProvider).read();
    var camera = _cameraFromSettings();
    var boxOk = false;
    String? boxReason;
    final gateway = ref.read(gatewayProvider);
    if (gateway != null) {
      try {
        final rec = await gateway.liveCamera();
        final t = rec.lastTest;
        camera = LiveCameraInfo(
          enabled: camera.enabled,
          name: camera.name,
          configured: rec.configured,
          hasAudio: t?.hasAudio,
          reachable: t?.ok,
          control: rec.control,
        );
      } on Object {
        // not a `live:settings` holder, or the box is away: the settings tell enough
        camera = camera.copyWith(configured: camera.enabled);
      }
      try {
        final v = await gateway.getFresh('/api/live/audio-inputs');
        boxOk = v['available'] == true;
        boxReason = v['reason'] is String ? v['reason'] as String : null;
      } on Object {
        boxOk = false;
      }
    }
    var video = saved?.video ?? VideoSourceKind.phone;
    var mix = saved?.mix ?? defaultMix(video);
    if (_fellBack && _fallbackCamera != _cameraSignature(camera)) _fellBack = false;
    if (_fellBack && video == VideoSourceKind.external) {
      // an unrelated refresh: the phone camera stays in use, the notice is not shown again
      video = VideoSourceKind.phone;
      mix = defaultMix(video);
    } else if (video == VideoSourceKind.external && !camera.offered) {
      // the camera was switched off: it is not offered, the phone camera is used
      video = VideoSourceKind.phone;
      mix = defaultMix(video);
    }
    if (!boxOk && mix.boxInput.enabled) {
      // the box microphone is gone: the camera sound (or the phone's own microphone) is the sound again
      mix = withSource(mix, idBoxInput, const AudioSourceMix(enabled: false, volume: 100));
      mix = withSource(mix, idCamera, AudioSourceMix(enabled: video == VideoSourceKind.external, volume: mix.camera.volume == 0 ? 100 : mix.camera.volume));
    }
    // a live the box pulls, on a box with a jack input: its microphone is the main sound unless the person chose otherwise
    final pulledByBox = _isWeb || (savedPath ?? state.videoPath) == videoPathBox;
    if (video == VideoSourceKind.external && pulledByBox && boxOk && _mayApplyBoxMain(mix)) {
      mix = boxMainMix(mix);
      _decideBoxMain();
    }
    final seeded = _enabledIds(mix);
    state = state.copyWith(
      video: video,
      listed: {...state.listed, ...seeded, ..._enabledIds(_normalise(video, mix, camera))},
      mix: _normalise(video, mix, camera),
      camera: camera,
      boxInputAvailable: boxOk,
      boxInputReason: boxReason,
      loaded: true,
      videoPath: savedPath ?? state.videoPath,
      cameraRefused: false,
    );
  }

  /// "Video diambil oleh": this phone or the MAXCOM Kiosk Box. Remembered on
  /// this device; before a live the publisher is prepared again for it (with
  /// the box pulling, the phone opens no pull of the camera at all).
  Future<void> setVideoPath(String path) async {
    if (path != videoPathDevice && path != videoPathBox) return;
    if (path == state.videoPath || _publisher.current.isLive) return;
    state = state.copyWith(videoPath: path, error: null);
    if (path == videoPathBox && state.external && state.boxInputAvailable && _mayApplyBoxMain(state.mix)) {
      _set(state.copyWith(mix: _normalise(state.video, boxMainMix(state.mix), state.camera)));
      _decideBoxMain();
    }
    unawaited(ref.read(liveVideoPathStoreProvider).write(path));
    final phase = _publisher.current.phase;
    if (phase == PublisherPhase.ready || phase == PublisherPhase.idle || phase == PublisherPhase.stopped) {
      try {
        await prepare(recording: _publisher.current.recording.on, frontCamera: _publisher.current.frontCamera);
      } on Object catch (e) {
        debugPrint('live video path prepare failed: ${e.runtimeType}');
      }
    }
  }

  /// The box's "camera in use" flag as the last live status had it: true
  /// while another device, or the box, pulls the camera.
  void cameraUseKnown(bool blocked) {
    if (state.cameraInUse == blocked) return;
    state = state.copyWith(cameraInUse: blocked);
  }

  /// This phone would pull the camera itself for a live started now.
  bool get _phonePulls => state.external && !_isWeb && !state.boxPull && !state.cameraBusy;

  LiveCameraInfo _cameraFromSettings() {
    final settings = ref.read(settingsProvider).value?.value;
    final f = settings?['liveCamera'];
    // the stored switch, else the registry default: the one defaults helper (B2)
    final enabled = featureOnIn(f is Map ? f : null, 'liveCamera');
    final name = f is Map && f['name'] is String && (f['name'] as String).trim().isNotEmpty ? f['name'] as String : sFor(ref.read(appLangProvider)).ra4CameraName;
    return LiveCameraInfo(enabled: enabled, name: name);
  }

  /// Core's `normaliseAudioMix` for the screen: volumes in steps, the camera
  /// row only with the external camera and only while it has audio.
  LiveAudioMix _normalise(VideoSourceKind video, LiveAudioMix m, LiveCameraInfo cam) {
    AudioSourceMix s(AudioSourceMix v, {bool? on}) => AudioSourceMix(enabled: on ?? v.enabled, volume: stepVolume(v.volume));
    final ext = video == VideoSourceKind.external;
    return soloMix(LiveAudioMix(
      camera: s(m.camera, on: ext && cam.hasAudio != false && m.camera.enabled),
      deviceMic: s(m.deviceMic, on: ext ? m.deviceMic.enabled : true),
      boxInput: s(m.boxInput),
    ));
  }

  static Set<String> _enabledIds(LiveAudioMix m) => {for (final id in soloPriority) if (mixOf(m, id).enabled) id};

  static String _cameraSignature(LiveCameraInfo c) => '${c.enabled}|${c.configured}';

  void _set(LiveSourceState next, {bool persist = true}) {
    state = next.copyWith(listed: {...next.listed, ..._enabledIds(next.mix)});
    // while the phone camera stands in for the saved external one, nothing is saved
    if (persist && !_fellBack) unawaited(ref.read(liveSourceStoreProvider).write(next.video, next.mix));
  }

  /// "Sumber video": the phone's (or iPad's) camera or the external camera.
  Future<void> selectVideo(VideoSourceKind kind) async {
    if (kind == state.video) {
      if (_fellBack) {
        // the phone camera was picked on purpose: that is now the saved choice
        _fellBack = false;
        _set(state);
      }
      return;
    }
    if (kind == VideoSourceKind.external && !state.camera.offered) return;
    // a failed push must restore the fallback too: the saved choice stays what it was
    final wasFellBack = _fellBack;
    final gen = ++_selectGen;
    _fellBack = false;
    final old = state.mix;
    final prevVideo = state.video;
    var mix = defaultMix(kind);
    // what is added stays added: Mic-in, and the device microphone with the camera
    mix = withSource(mix, idBoxInput, old.boxInput);
    if (kind == VideoSourceKind.external) mix = withSource(mix, idDeviceMic, const AudioSourceMix(enabled: false, volume: 100));
    if (kind == VideoSourceKind.external && (_isWeb || state.boxPull) && state.boxInputAvailable && _mayApplyBoxMain(mix)) {
      mix = boxMainMix(mix);
      _decideBoxMain();
    }
    mix = _normalise(kind, mix, state.camera);
    _set(state.copyWith(video: kind, mix: mix, error: null));
    if (await _push(videoChanged: true)) return;
    // a newer choice arrived while this one was awaited: it decides, nothing is rolled back over it
    if (gen != _selectGen) return;
    // the picture did not change: the screen and the remembered choice go back to the source that is really in use
    // (with the fallback back on, the saved external choice is not written over)
    _fellBack = wasFellBack;
    _set(state.copyWith(video: prevVideo, mix: old, error: liveSourceSwitchFailed(ref.read(appLangProvider))));
    if (!_publisher.current.isLive) {
      try {
        await prepare(recording: _publisher.current.recording.on, frontCamera: _publisher.current.frontCamera);
      } on Object catch (e) {
        debugPrint('live source restore failed: ${e.runtimeType}');
      }
    }
  }

  /// True when turning [id] on would take the sound from another source that is on air now (a live then restarts
  /// its sound for 2 to 3 seconds, so the screen asks first).
  bool switchesTo(String id) {
    final on = soundOn(state.mix);
    return on != null && on != id;
  }

  /// A change of the mix, kept to ONE source on (build 6) and shaped for this video source.
  LiveAudioMix _solo(LiveAudioMix m, {String? prefer}) => _normalise(state.video, soloMix(m, prefer: prefer), state.camera);

  Future<void> setVolume(String id, int v) async {
    final cur = mixOf(state.mix, id);
    final vol = stepVolume(v);
    // raising a source that is not on air turns it on and every other one off
    final turningOn = vol > 0 && !(cur.enabled && cur.volume > 0);
    final next = turningOn
        ? _solo(withSource(state.mix, id, AudioSourceMix(enabled: true, volume: vol)), prefer: id)
        : withSource(state.mix, id, AudioSourceMix(enabled: cur.enabled, volume: vol));
    if (_mixEquals(next, state.mix)) return;
    if (_pathIsBox) _decideBoxMain();
    final prev = state.mix;
    _set(state.copyWith(mix: next));
    await _commitMix(prev);
  }

  /// "Tambah audio": the new source is on and every other one off, at its last volume (100 when that was 0).
  Future<void> add(String id) async {
    if (id == idBoxInput && !state.boxInputAvailable) return;
    final next = _solo(turnOn(state.mix, id), prefer: id);
    if (_pathIsBox) _decideBoxMain();
    final prev = state.mix;
    _set(state.copyWith(mix: next));
    await _commitMix(prev);
  }

  /// A microphone was plugged in (or the person undid that): the device
  /// microphone on or off with its volume, only with the external camera
  /// (with the phone camera it is always in). On means the only sound.
  Future<void> setDeviceMic(AudioSourceMix m) async {
    if (!state.external) return;
    final vol = stepVolume(m.volume);
    final next = m.enabled
        ? _solo(withSource(state.mix, idDeviceMic, AudioSourceMix(enabled: true, volume: vol == 0 ? 100 : vol)), prefer: idDeviceMic)
        : withSource(state.mix, idDeviceMic, AudioSourceMix(enabled: false, volume: vol));
    if (_mixEquals(next, state.mix)) return;
    final prev = state.mix;
    _set(state.copyWith(mix: next));
    await _commitMix(prev);
  }

  Future<void> remove(String id) async {
    if (id == idCamera) return;
    if (id == idDeviceMic && !state.external) return; // the phone's own microphone is today's flow
    final next = _normalise(state.video, withSource(state.mix, id, AudioSourceMix(enabled: false, volume: mixOf(state.mix, id).volume)), state.camera);
    if (_pathIsBox) _decideBoxMain();
    final prev = state.mix;
    final prevListed = state.listed;
    _set(state.copyWith(mix: next, listed: {...state.listed}..remove(id)));
    await _commitMix(prev, prevListed: prevListed);
  }

  /// "Guna `<sumber>` sahaja": that source is the only sound.
  Future<void> useOnly(String id) async {
    final next = _solo(turnOn(state.mix, id), prefer: id);
    if (_pathIsBox) _decideBoxMain();
    final prev = state.mix;
    _set(state.copyWith(mix: next));
    await _commitMix(prev);
  }

  /// Sends a changed mix; when it could not be applied (the box refused it, or the engine failed) the mix on screen and
  /// the phone engine go back to [prev] and the person is told, as for a refused change of picture.
  Future<void> _commitMix(LiveAudioMix prev, {Set<String>? prevListed}) async {
    if (await _push(prevMix: prev)) return;
    final failed = state.mix;
    _set(state.copyWith(
      mix: prev,
      listed: prevListed ?? state.listed,
      error: liveSourceSwitchFailed(ref.read(appLangProvider)),
    ));
    // the engine (and the box, when it was told) hear the old mix again; a second failure changes nothing more
    await _push(prevMix: failed);
  }

  /// A fallback "Imbangan masa audio" saved: kept on screen at once.
  void rememberOffset(String id, int ms) =>
      state = state.copyWith(offsets: {...state.offsets, id: ms});

  /// The camera address for a session about to be prepared or started. Held
  /// in a local variable by the caller only.
  Future<ExternalCameraSource?> cameraSource() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return null;
    final url = await gateway.liveCameraSource();
    if (url.isEmpty) return null;
    final settings = ref.read(settingsProvider).value?.value;
    final f = settings?['liveCamera'];
    final t = f is Map && f['transport'] is String ? f['transport'] as String : 'auto';
    return ExternalCameraSource(url: url, transport: const {'auto', 'tcp', 'udp'}.contains(t) ? t : 'auto');
  }

  bool get _isWeb => _publisher is WebPublisher;

  /// Prepares the publisher for the chosen source (idle screen): the first
  /// prepare of a session and every change of picture before the start.
  Future<void> prepare({required bool recording, required bool frontCamera}) async {
    await ensureLoaded();
    final p = _publisher;
    // a new session is being prepared: the one that ended no longer offers a way back
    if (state.startedExternal) state = state.copyWith(startedExternal: false, error: null);
    final st = state;
    ExternalCameraSource? camera;
    var video = st.video;
    if (st.external && !_isWeb && !_phonePulls) {
      // The box pulls the camera (the admin's choice), or the camera is in use
      // by another device: this phone asks for no address and opens NO pull of
      // its own (never a second RTSP pull of a busy camera). What an earlier
      // prepare opened (the phone camera, or this phone's own pull) is let go;
      // the screen shows the shared picture through the box.
      if (p is LivePreparedRelease && !p.current.isLive) await (p as LivePreparedRelease).releasePrepared();
      return;
    }
    if (st.external && !_isWeb) {
      var inUse = false;
      try {
        camera = await cameraSource();
      } on BoxError catch (e) {
        camera = null;
        // the box refuses the address while another device holds the camera
        inUse = e.code == 'camera_in_use';
      } on Object {
        camera = null;
      }
      if (inUse) {
        state = state.copyWith(cameraRefused: true, error: null);
        return;
      }
      if (camera == null) {
        // no address to pull: fall back to the phone camera and say so
        video = VideoSourceKind.phone;
        // only for now: the saved choice stays the external camera. [_fellBack] keeps an unrelated
        // refresh from bringing the external camera back and the notice again.
        _fellBack = true;
        _fallbackCamera = _cameraSignature(st.camera);
        state = state.copyWith(video: video, mix: defaultMix(video), error: liveCameraSourceFailed(ref.read(appLangProvider)));
      }
    }
    final cfg = PublisherConfig(
      recording: recording,
      frontCamera: frontCamera,
      video: video,
      camera: camera,
      // always sent: the phone microphone's volume applies to the phone camera too
      mix: state.mix,
      avOffsetMs: st.offsets[idDeviceMic] ?? 0,
    );
    if (p is WebPublisher && st.external) {
      await p.prepareExternal(
        cfg,
        mix: st.mix,
        cameraHasAudio: st.camera.hasAudio != false,
        fallbackOffsetMs: st.offsets[idDeviceMic] ?? 0,
      );
      return;
    }
    await p.prepare(cfg);
  }

  /// Pushes a change to the publisher and, in a box-combined live, to the box.
  /// False when the change could not be applied (the caller puts the screen back).
  Future<bool> _push({bool videoChanged = false, LiveAudioMix? prevMix}) async {
    final p = _publisher;
    final st = state;
    try {
      // A live the box pulls and this phone only controls has no engine: the mix goes to the box itself.
      final live = ref.read(liveBoxProvider);
      if (!p.current.isLive && live.controlOnly && live.sessionId != null && !videoChanged) {
        await ref.read(gatewayProvider)?.changeLiveAudio(st.mix);
        return true;
      }
      if (p.current.isLive) {
        if (p is WebPublisher) {
          if (videoChanged) {
            if (st.external) {
              await p.switchToExternalCamera();
            } else {
              await p.switchToIpadCamera();
            }
          } else {
            await p.setExternalMix(st.mix);
          }
          return true;
        }
        if (p is LiveSourceControl) {
          final ctl = p as LiveSourceControl;
          if (videoChanged) {
            // never a second pull of a camera another device holds
            if (st.external && st.cameraBusy) return false;
            final cam = st.external ? await cameraSource() : null;
            await ctl.setVideoSource(st.video, camera: cam, mix: st.mix, avOffsetMs: st.offsets[idDeviceMic] ?? 0);
            // O4: this phone pulled the camera itself and now sends its own: the box's "camera in use" flag clears.
            if (!st.external && !st.boxPull) await _releaseCameraOnBox();
          } else {
            await ctl.setAudioMix(st.mix);
          }
          // the box combines this live while the box microphone is on, or was on in the mix before this change: a switch
          // away from it must reach the box too, or the box keeps playing its own microphone
          if (st.mix.boxInput.enabled || (prevMix?.boxInput.enabled ?? false)) {
            await ref.read(gatewayProvider)?.changeLiveAudio(st.mix);
          }
        }
        return true;
      }
      if (videoChanged) {
        final phase = p.current.phase;
        if (phase == PublisherPhase.ready || phase == PublisherPhase.idle || phase == PublisherPhase.stopped) {
          await prepare(recording: p.current.recording.on, frontCamera: p.current.frontCamera);
        }
        return true;
      }
      if (p is WebPublisher) {
        if (st.external) await p.setExternalMix(st.mix);
      } else if (p is LiveSourceControl && p.current.phase == PublisherPhase.ready) {
        await (p as LiveSourceControl).setAudioMix(st.mix);
      }
      return true;
    } on Object catch (e) {
      debugPrint('live source change failed: ${e.runtimeType}');
      return false;
    }
  }

  /// O4: tells the box this phone no longer holds the camera. Best effort, never a reason to undo the switch.
  Future<void> _releaseCameraOnBox() async {
    final sid = ref.read(liveBoxProvider).sessionId;
    final gateway = ref.read(gatewayProvider);
    if (sid == null || gateway == null) return;
    try {
      await gateway.releaseLiveCamera(sid);
    } on Object catch (e) {
      debugPrint('camera release not sent: ${e.runtimeType}');
    }
  }

  /// The camera's own audio, when a test or the engine finds none.
  void cameraAudioKnown(bool hasAudio) {
    if (state.camera.hasAudio == hasAudio) return;
    state = state.copyWith(camera: state.camera.copyWith(hasAudio: hasAudio));
  }
}

// ---- rows ----

enum RowTone { ok, warn, off, idle }

enum ChipKind { searching, ok, bad, wait, manual }

class AlignChipModel {
  const AlignChipModel(this.kind, this.text);

  final ChipKind kind;
  final String text;
}

/// What the engine or the box reports for one source (one row of
/// [PublisherAudio] or of `LiveStatus.audio.sources`).
class LiveRowInfo {
  const LiveRowInfo({
    this.volume,
    this.level,
    this.state = 'ok',
    this.alignState,
    this.delayMs,
  });

  final int? volume;
  final double? level;

  /// `ok`, `silent` or `lost`.
  final String state;
  final String? alignState;
  final int? delayMs;
}

class AudioRowModel {
  const AudioRowModel({
    required this.id,
    required this.name,
    required this.volume,
    required this.level,
    required this.status,
    required this.tone,
    this.chip,
    this.hint,
    this.removable = false,
    this.slider = true,
    this.mute = false,
    this.dim = false,
    this.manual = false,
    this.readOnly = false,
    this.lift,
    this.toggle,
    this.toggleEnabled = true,
    this.rowMute = false,
    this.on = true,
  });

  /// "Naikkan suara perlahan" on or off; null = this row has no such switch.
  final bool? lift;

  /// The row's on/off switch (a phone input among several): its state; null = no switch.
  final bool? toggle;
  final bool toggleEnabled;

  /// A mute button that sets this row's volume to 0 and back (the camera sound and Mic-in).
  final bool rowMute;

  /// This source is the one sound of the live (enabled); a row that is off has its slider disabled.
  final bool on;

  final String id;
  final String name;
  final int volume;
  final double level;
  final String status;
  final RowTone tone;
  final AlignChipModel? chip;
  final String? hint;
  final bool removable;

  /// A "Kelantangan" slider; false for the phone microphone with the phone
  /// camera (today's mute only) and for a camera with no audio.
  final bool slider;

  /// The phone microphone's own mute button.
  final bool mute;
  final bool dim;

  /// The fallback "Imbangan masa audio" block (a camera with no audio).
  final bool manual;
  final bool readOnly;
}

/// One input the phone (or iPad) can hear, as the Audio card shows it: its own row.
class PhoneInput {
  const PhoneInput({
    required this.key,
    required this.name,
    this.kind = '',
    this.present = true,
    this.active = false,
    this.denied = false,
  });

  /// What the platform gave as its id (stays the same when plugged in again).
  final String key;

  /// The name in the app language.
  final String name;

  /// `builtin`, `external`, `bluetooth` or empty (the browser).
  final String kind;

  /// Attached now; false = greyed.
  final bool present;

  /// The sound of the live comes from this input.
  final bool active;

  /// A Bluetooth input whose permission was refused.
  final bool denied;

  bool get bluetooth => kind == 'bluetooth';

  /// The id of its row: the active one keeps `deviceMic` (its meter, alignment and mix entry), the others `mic:<key>`.
  String get rowId => active ? idDeviceMic : '$micRowPrefix$key';

  /// The lift's key.
  String get liftKey => '$micRowPrefix$key';
}

const String micRowPrefix = 'mic:';

/// Where the screen runs and the moment of the session, for [buildAudioRows].
class AudioContext {
  const AudioContext({
    required this.dev,
    required this.live,
    this.readOnly = false,
    this.camLost = false,
    this.camBack = false,
    this.muted = false,
    this.lang = AppLang.ms,
    this.micLabel,
    this.micUnavailable,
    this.trrsHint = false,
    this.inputs = const [],
    this.lifts = const {},
    this.inputVolumes = const {},
    this.boxPulled = false,
  });

  /// The box pulls the camera of this live (or the one about to start): its jack microphone is the main sound and
  /// comes first, the camera sound second at 0 with its hint, and the sync is the three-state block.
  final bool boxPulled;

  /// Every phone input the live can hear (2026.11.15): empty = not known, the rows are then as before.
  final List<PhoneInput> inputs;

  /// The loudness lift per source key (`camera`, `mic:<input key>`); a missing key is on.
  final Map<String, bool> lifts;

  /// The saved volume of each phone input that is not the active one, by input key.
  final Map<String, int> inputVolumes;

  bool liftOn(String key) => lifts[key] ?? true;

  /// The lift switch of the device microphone: the phone's engine, or the browser's automatic gain on the iPad.
  bool get liftAvailable => dev == 'phone' || dev == 'ipad';

  /// The camera's own sound is lifted by the phone engine only; the iPad plays it as it comes.
  bool get cameraLiftAvailable => dev == 'phone';

  /// The name of the microphone plugged in and in use (null = the device's own).
  final String? micLabel;

  /// A microphone was wanted but the system would not route to it: the live uses the phone's own.
  final String? micUnavailable;

  /// Headphones are in the jack but no microphone: a 4-pole (TRRS) plug is needed.
  final bool trrsHint;

  /// `phone` or `ipad`.
  final String dev;

  /// A live is running (this device's or another's); false = before the start.
  final bool live;

  /// Another device's live: no changes from here.
  final bool readOnly;

  /// The picture is lost (the phone's lost-camera state) or back again.
  final bool camLost;
  final bool camBack;

  /// The phone microphone is muted (today's mute).
  final bool muted;

  /// The app language the row and notice texts are in.
  final AppLang lang;

  bool get ipad => dev == 'ipad';
  String get micName => micLabel ?? (ipad ? liveAudioIpadMicRow(lang) : liveAudioPhoneMicRow(lang));
  String get micShort => ipad ? liveAudioIpadMicShort(lang) : liveAudioPhoneMicShort(lang);
}

/// "Mikrofon telefon", "Mikrofon iPad" or "Mic-in pada kotak": `<sumber>` of
/// the plan 4.7 messages.
String sourceShort(String id, AudioContext c) => id == idBoxInput ? liveAudioBoxInputRow(c.lang) : c.micShort;

/// The rows of the "Audio" card, one per source in the mix (mockup rule set).
/// [info] holds what the engine or the box reports per source id.
List<AudioRowModel> buildAudioRows({
  required LiveSourceState source,
  required AudioContext ctx,
  Map<String, LiveRowInfo> info = const {},
  bool cameraAddressKnown = true,
}) {
  final lang = ctx.lang;
  final ls = sFor(lang);
  final rows = <AudioRowModel>[];
  final ext = source.external;
  final boxMain = ctx.boxPulled && ext;
  final mix = source.mix;
  final live = ctx.live;
  final noAud = source.cameraNoAudio;
  final unreach = !live && ext && source.camera.reachable == false;
  double lvl(String id, double fallback, int vol) {
    if (vol == 0) return 0;
    return info[id]?.level ?? fallback;
  }

  if (ext) {
    if (noAud) {
      rows.add(
        AudioRowModel(
          id: idCamera,
          name: liveAudioCameraRow(lang),
          volume: 0,
          level: 0,
          status: liveAudioCameraNone(lang),
          tone: RowTone.idle,
          slider: false,
          dim: true,
        ),
      );
    } else {
      final cam = info[idCamera];
      var status = live ? liveAudioStatusReceived(lang) : liveAudioStatusReady(lang);
      var tone = RowTone.ok;
      var level = lvl(idCamera, 0.5, mix.camera.volume);
      if (unreach) {
        status = liveCameraUnreachableShort(lang);
        tone = RowTone.off;
        level = 0;
      }
      if (ctx.camLost || cam?.state == 'lost') {
        status = liveAudioStatusCameraLost(lang);
        tone = RowTone.off;
        level = 0;
      }
      if (ctx.camBack) {
        status = liveAudioStatusCameraBack(lang);
        tone = RowTone.warn;
        level = 0;
      }
      final camOn = mix.camera.enabled;
      if (!camOn) {
        // another source is the sound: this row is off until it is turned on (which turns the other one off)
        status = liveAudioStatusOff(lang);
        tone = RowTone.idle;
        level = 0;
      }
      rows.add(
        AudioRowModel(
          id: idCamera,
          name: liveAudioCameraRow(lang),
          volume: mix.camera.volume,
          level: level,
          status: camOn && boxMain && mix.camera.volume == 0 && tone == RowTone.ok ? ls.liveAudioCamNotOnAir : status,
          tone: tone,
          on: camOn,
          hint: boxMain ? ls.liveAudioCamBoxHint : (live ? null : liveAudioCameraVolumeHint(lang)),
          readOnly: ctx.readOnly,
          lift: ctx.cameraLiftAvailable ? liftOf(ctx, 'camera') : null,
          rowMute: !ctx.readOnly,
        ),
      );
    }
  } else {
    // the phone camera: today's flow, the device microphone with today's mute (the volume and the lift are new)
    final act = activeInput(ctx);
    rows.add(
      AudioRowModel(
        id: idDeviceMic,
        name: ctx.micName,
        volume: mix.deviceMic.volume,
        level: ctx.muted || !mix.deviceMic.enabled ? 0 : (info[idDeviceMic]?.level ?? 0.6),
        status: !mix.deviceMic.enabled ? liveAudioStatusOff(lang) : (ctx.muted ? liveAudioStatusMuted(lang) : liveAudioStatusReady(lang)),
        tone: ctx.muted || !mix.deviceMic.enabled ? RowTone.idle : RowTone.ok,
        on: mix.deviceMic.enabled,
        // the iPad's own camera sends no mix: a volume slider there would move and do nothing
        slider: ctx.dev != 'ipad',
        mute: true,
        readOnly: ctx.readOnly,
        lift: liftOf(ctx, act?.liftKey),
        toggle: shownInputs(ctx).length > 1 ? true : null,
        toggleEnabled: false,
        hint: act == null ? null : inputHint(ctx, act, off: false),
      ),
    );
    rows.addAll(offInputRows(ctx, source));
  }

  AudioRowModel added(String id) {
    final name = id == idDeviceMic ? ctx.micName : liveAudioBoxInputRow(lang);
    final vol = mixOf(mix, id).volume;
    final r = info[id];
    // one sound only (build 6): no mixing words, no alignment chip, no delay block on a row
    var status = live ? ls.liveAudioBoxMicOnAir : liveAudioStatusReady(lang);
    var tone = RowTone.ok;
    if (!ext) {
      status = id == idBoxInput
          ? (source.boxInputAvailable ? liveAudioStatusBoxSignal(lang) : liveAudioBoxInputMissing(lang))
          : status;
    } else if (noAud) {
      status = liveAudioStatusAlone(lang);
    } else if (r?.state == 'lost') {
      status = liveAudioStatusMicLost(lang);
      tone = RowTone.off;
    }
    final act = id == idDeviceMic ? activeInput(ctx) : null;
    final main = boxMain && id == idBoxInput;
    // another pick turned this listed row off: it stays, off, with its slider disabled
    final rowOn = mixOf(mix, id).enabled;
    if (!rowOn) {
      status = liveAudioStatusOff(lang);
      tone = RowTone.idle;
    }
    return AudioRowModel(
      id: id,
      name: main ? ls.liveAudioBoxMicMain : name,
      volume: vol,
      level: rowOn ? lvl(id, 0.6, vol) : 0,
      on: rowOn,
      status: rowOn && main && r?.state != 'lost' ? (vol > 0 ? ls.liveAudioBoxMicOnAir : ls.liveAudioCamNotOnAir) : status,
      tone: tone,
      // the box microphone of a box-pulled live may be removed too: then there is no sound, or the camera sound is chosen
      removable: !ctx.readOnly && !(id == idDeviceMic && !ext),
      readOnly: ctx.readOnly,
      lift: id == idDeviceMic ? liftOf(ctx, act?.liftKey) : null,
      toggle: id == idDeviceMic && shownInputs(ctx).length > 1 ? true : null,
      rowMute: (id == idBoxInput || !rowOn) && !ctx.readOnly,
      hint: main ? ls.liveAudioBoxMicMainHint : (act == null ? null : inputHint(ctx, act, off: false)),
    );
  }

  if (ext && (mix.deviceMic.enabled || source.listed.contains(idDeviceMic))) rows.add(added(idDeviceMic));
  if (ext) rows.addAll(offInputRows(ctx, source));
  if (mix.boxInput.enabled || source.listed.contains(idBoxInput)) {
    final box = added(idBoxInput);
    // the box microphone is the main sound of a box-pulled live: first
    if (boxMain) {
      rows.insert(0, box);
    } else {
      rows.add(box);
    }
  }
  return rows;
}

/// The inputs the card shows: none while another device's live is only being watched.
List<PhoneInput> shownInputs(AudioContext ctx) => ctx.readOnly ? const [] : ctx.inputs;

PhoneInput? activeInput(AudioContext ctx) {
  for (final i in shownInputs(ctx)) {
    if (i.active) return i;
  }
  return null;
}

/// The lift switch of a source key (`camera`, `mic:<key>`), on the phone only; null where there is none.
bool? liftOf(AudioContext ctx, String? key) => ctx.liftAvailable && !ctx.readOnly ? ctx.liftOn(key ?? 'mic:own') : null;

/// The small print under an input row: one microphone at a time, and the Bluetooth notes.
String? inputHint(AudioContext ctx, PhoneInput i, {required bool off}) {
  final lang = ctx.lang;
  final parts = <String>[
    if (i.denied) liveAudioBluetoothDenied(lang) else if (i.bluetooth) liveAudioBluetoothQuality(lang),
    if (off && shownInputs(ctx).length > 1 && i.present && !i.denied) liveAudioOnePhoneInput(lang),
  ];
  return parts.isEmpty ? null : parts.join(' ');
}

/// The rows of the inputs that are not in use: off (or greyed when gone), each with its own volume and lift. With the
/// external camera the active input is also listed here while the device microphone is off.
List<AudioRowModel> offInputRows(AudioContext ctx, LiveSourceState source) {
  final lang = ctx.lang;
  final out = <AudioRowModel>[];
  final micOn = source.external ? source.mix.deviceMic.enabled : true;
  for (final i in shownInputs(ctx)) {
    if (i.active && micOn) continue;
    final vol = i.active ? source.mix.deviceMic.volume : (ctx.inputVolumes[i.key] ?? 100);
    out.add(
      AudioRowModel(
        id: i.rowId,
        name: i.name,
        volume: vol,
        level: 0,
        status: i.present ? liveAudioStatusOff(lang) : liveAudioInputGone(lang),
        tone: RowTone.idle,
        dim: !i.present,
        readOnly: !i.present,
        lift: liftOf(ctx, i.liftKey),
        toggle: false,
        toggleEnabled: i.present,
        hint: inputHint(ctx, i, off: true),
      ),
    );
  }
  return out;
}

/// One message under the rows.
class AudioNotice {
  const AudioNotice(this.kind, this.title, {this.body, this.action, this.actionId});

  /// `gold`, `bad`, `info` or `help`.
  final String kind;
  final String? title;
  final String? body;

  /// "Guna `<sumber>` sahaja" and which source it concerns.
  final String? action;
  final String? actionId;
}

/// The messages of plan 4.7 for the current mix and state, in priority order.
List<AudioNotice> buildAudioNotices({
  required LiveSourceState source,
  required AudioContext ctx,
  Map<String, LiveRowInfo> info = const {},
}) {
  final lang = ctx.lang;
  final out = <AudioNotice>[];
  final mix = source.mix;
  final ext = source.external;
  final live = ctx.live;
  final noAud = source.cameraNoAudio;
  final camAudible = ext && mix.camera.enabled && mix.camera.volume > 0;
  final micOn = ext && mix.deviceMic.enabled;
  final boxOn = mix.boxInput.enabled;
  final src = ctx.micShort;
  final unavail = ctx.micUnavailable;
  if (unavail != null) {
    out.add(AudioNotice('bad', null, body: liveMicUnavailable(lang, unavail)));
  } else if (ctx.trrsHint && !ctx.ipad) {
    out.add(AudioNotice('help', null, body: liveMicTrrsHint(lang)));
  }
  if (mixAllMuted(mix, muted: ctx.muted, phone: ctx.dev == 'phone') && (ext || boxOn || ctx.muted)) {
    out.add(AudioNotice('gold', liveAudioAllMuted(lang), body: liveAudioAllMutedBody(lang)));
  }
  if (ext && noAud) {
    final added = [if (micOn) src, if (boxOn) liveAudioBoxInputRow(lang)];
    out.add(
      added.isEmpty
          ? AudioNotice('gold', null, body: liveAudioNoCameraNoneAdded(lang))
          : AudioNotice('gold', null, body: liveAudioCameraNoAudioAdded(lang, liveAudioJoin(lang, added))),
    );
  }
  final lostSource = [idDeviceMic, idBoxInput].where((id) => mixOf(mix, id).enabled && info[id]?.state == 'lost');
  for (final id in lostSource) {
    out.add(
      AudioNotice(
        'bad',
        camAudible ? liveAudioSourceLostAudible(lang, sourceShort(id, ctx)) : liveAudioSourceLostMuted(lang, sourceShort(id, ctx)),
      ),
    );
  }
  if (boxOn && !live) {
    if (!ext) out.add(AudioNotice('gold', null, body: liveAudioBoxInputInPhoneLive(lang)));
    if (!ctx.ipad) out.add(AudioNotice('info', null, body: liveBoxLateNote(lang)));
  }
  return out;
}

/// The summary line of the folded "Audio" section.
({String text, bool warn}) audioSummary(LiveSourceState source, AudioContext ctx, Map<String, LiveRowInfo> info) {
  final lang = ctx.lang;
  final mix = source.mix;
  if (mixAllMuted(mix, muted: ctx.muted, phone: ctx.dev == 'phone')) return (text: liveAudioSummaryMuted(lang), warn: true);
  final ext = source.external;
  final names = <String>[
    if (ext && !source.cameraNoAudio && mix.camera.enabled && mix.camera.volume > 0) liveAudioSummaryCamera(lang),
    if (ext && mix.deviceMic.enabled && mix.deviceMic.volume > 0) ctx.micShort,
    if (!ext && mix.deviceMic.enabled && !ctx.muted) ctx.micShort,
    if (mix.boxInput.enabled && mix.boxInput.volume > 0) liveAudioBoxInputRow(lang),
  ];
  // one sound only: no alignment words in the summary
  final tail = ext && source.cameraNoAudio ? liveAudioSummaryNoCameraAudio(lang) : '';
  return (text: '${names.isEmpty ? liveAudioSummaryNone(lang) : names.join(' + ')}$tail', warn: false);
}

// ---- the test of every box microphone before Start (build 5) ----

/// One capture device of the box with what the 5 second test found.
class BoxMicDevice {
  const BoxMicDevice({required this.name, required this.selected, this.code, this.meanDb});

  final String name;

  /// The device the box will use.
  final bool selected;

  /// `ok`, `silent`, `access_denied` or `device_unavailable`; null while it was not tested.
  final String? code;
  final double? meanDb;
}

class BoxMicTestState {
  const BoxMicTestState({
    this.devices = const [],
    this.testing = false,
    this.testedAt,
    this.testUnavailable = false,
    this.loaded = false,
  });

  final List<BoxMicDevice> devices;
  final bool testing;
  final DateTime? testedAt;

  /// The box has no test route (a build 4 box): the chips are hidden.
  final bool testUnavailable;
  final bool loaded;

  BoxMicTestState copyWith({
    List<BoxMicDevice>? devices,
    bool? testing,
    Object? testedAt = _unset,
    bool? testUnavailable,
    bool? loaded,
  }) => BoxMicTestState(
    devices: devices ?? this.devices,
    testing: testing ?? this.testing,
    testedAt: identical(testedAt, _unset) ? this.testedAt : testedAt as DateTime?,
    testUnavailable: testUnavailable ?? this.testUnavailable,
    loaded: loaded ?? this.loaded,
  );
}

const Object _unset = Object();

class BoxMicTestNotifier extends Notifier<BoxMicTestState> {
  @override
  BoxMicTestState build() => const BoxMicTestState();

  /// The device list and the choice (`GET /api/live/audio-inputs`).
  Future<void> loadDevices() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    try {
      final v = await gateway.getFresh('/api/live/audio-inputs');
      if (!ref.mounted) return;
      final selected = v['selected'] is String ? v['selected'] as String : null;
      final old = {for (final d in state.devices) d.name: d};
      final list = <BoxMicDevice>[
        for (final d in (v['devices'] is List ? v['devices'] as List : const []))
          if (d is Map && d['name'] is String && d['usable'] != false)
            BoxMicDevice(
              name: d['name'] as String,
              selected: d['name'] == selected,
              code: old[d['name']]?.code,
              meanDb: old[d['name']]?.meanDb,
            ),
      ];
      state = state.copyWith(devices: list, loaded: true);
    } on Object {
      // the card shows what it has
    }
  }

  /// The device the person picked while a test ran: the test answer must not overwrite it.
  String? _pickedDuringTest;

  /// Runs the 5 second test of every device (`POST /api/live/audio-inputs/test`, 25 s read budget). A 404 hides the chips.
  /// When the call times out or fails, the last result the box kept (`GET`) is shown if it is newer than this test.
  Future<void> test() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null || state.testing || state.testUnavailable) return;
    final startedAt = DateTime.now();
    _pickedDuringTest = null;
    state = state.copyWith(testing: true);
    try {
      final v = await gateway.postSlow('/api/live/audio-inputs/test', const {}, read: const Duration(seconds: 25));
      if (!ref.mounted) return;
      _apply(v);
    } on BoxError catch (e) {
      if (!ref.mounted) return;
      if (e.status == 404) {
        state = state.copyWith(testing: false, testUnavailable: true);
        return;
      }
      // 409: a live runs, nothing to test.
      if (e.status == 409) {
        state = state.copyWith(testing: false);
        return;
      }
      await _lastResult(gateway, startedAt);
    } on Object {
      if (!ref.mounted) return;
      await _lastResult(gateway, startedAt);
    }
  }

  /// The box's own last test (`GET /api/live/audio-inputs/test`): shown only when it is newer than [startedAt].
  Future<void> _lastResult(BoxGateway gateway, DateTime startedAt) async {
    try {
      final v = await gateway.getFresh('/api/live/audio-inputs/test');
      if (!ref.mounted) return;
      final at = DateTime.tryParse(v['testedAt'] is String ? v['testedAt'] as String : '');
      if (at != null && at.isAfter(startedAt)) {
        _apply(v);
        return;
      }
    } on Object {
      // nothing newer to show
    }
    if (ref.mounted) state = state.copyWith(testing: false);
  }

  void _apply(Map<String, dynamic> v) {
    final rows = <String, Map<dynamic, dynamic>>{
      for (final r in (v['results'] is List ? v['results'] as List : const []))
        if (r is Map && r['name'] is String) r['name'] as String: r,
    };
    final at = DateTime.tryParse(v['testedAt'] is String ? v['testedAt'] as String : '');
    final names = {...state.devices.map((d) => d.name), ...rows.keys};
    final picked = _pickedDuringTest;
    state = state.copyWith(
      testing: false,
      testedAt: at,
      devices: [
        for (final n in names)
          BoxMicDevice(
            name: n,
            selected: picked != null ? n == picked : (rows[n]?['selected'] == true || (rows[n] == null && _selected(n))),
            code: rows[n]?['code'] is String ? rows[n]!['code'] as String : null,
            meanDb: rows[n]?['meanDb'] is num ? (rows[n]!['meanDb'] as num).toDouble() : null,
          ),
      ],
    );
  }

  bool _selected(String name) => state.devices.any((d) => d.name == name && d.selected);

  /// The box will use [name] (`PUT /api/live/audio-input`); the list is read again.
  Future<bool> pick(String name) async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return false;
    if (state.testing) _pickedDuringTest = name;
    try {
      await gateway.put('/api/live/audio-input', {'deviceName': name});
      if (!ref.mounted) return true;
      state = state.copyWith(
        devices: [for (final d in state.devices) BoxMicDevice(name: d.name, selected: d.name == name, code: d.code, meanDb: d.meanDb)],
      );
      return true;
    } on Object {
      if (_pickedDuringTest == name) _pickedDuringTest = null;
      return false;
    }
  }
}

final boxMicTestProvider = NotifierProvider<BoxMicTestNotifier, BoxMicTestState>(BoxMicTestNotifier.new);
