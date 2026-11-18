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
import '../../l10n/s_lookup.dart' show sFor;
import '../labels_cam.dart';
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

bool _mixEquals(LiveAudioMix a, LiveAudioMix b) =>
    jsonEncode(a.toJson()) == jsonEncode(b.toJson());

/// Every source off or at volume 0 (the all-muted warning). [muted] is the
/// phone microphone's own mute (today's flow).
bool mixAllMuted(LiveAudioMix m, {bool muted = false}) {
  bool audible(AudioSourceMix s, {bool mute = false}) => s.enabled && s.volume > 0 && !mute;
  return !(audible(m.camera) || audible(m.deviceMic, mute: muted) || audible(m.boxInput));
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
  });

  /// "Guna kamera luaran" is on.
  final bool enabled;
  final String name;
  final bool configured;

  /// From the last test; null while unknown.
  final bool? hasAudio;

  /// The last test reached the camera; null while untested.
  final bool? reachable;

  /// `1080p, 25 bingkai sesaat`, when known.
  final String? spec;

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
  });

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

  bool get external => video == VideoSourceKind.external;

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
  }) => LiveSourceState(
    video: video ?? this.video,
    mix: mix ?? this.mix,
    offsets: offsets ?? this.offsets,
    camera: camera ?? this.camera,
    boxInputAvailable: boxInputAvailable ?? this.boxInputAvailable,
    boxInputReason: identical(boxInputReason, _k) ? this.boxInputReason : boxInputReason as String?,
    loaded: loaded ?? this.loaded,
    error: identical(error, _k) ? this.error : error as String?,
  );
}

// ---- remembered on this device ----

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

  Future<void> _load() async {
    try {
      // the camera switch and name live in the settings: wait for them (briefly)
      await ref.read(settingsProvider.future).timeout(const Duration(seconds: 3));
    } on Object {
      // no settings yet: the box record below tells enough
    }
    final saved = await ref.read(liveSourceStoreProvider).read();
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
    if (video == VideoSourceKind.external && !camera.offered) {
      // the camera was switched off: it is not offered, the phone camera is used
      video = VideoSourceKind.phone;
      mix = defaultMix(video);
    }
    if (!boxOk && mix.boxInput.enabled) mix = withSource(mix, idBoxInput, const AudioSourceMix(enabled: false, volume: 100));
    state = state.copyWith(
      video: video,
      mix: _normalise(video, mix, camera),
      camera: camera,
      boxInputAvailable: boxOk,
      boxInputReason: boxReason,
      loaded: true,
    );
  }

  LiveCameraInfo _cameraFromSettings() {
    final settings = ref.read(settingsProvider).value?.value;
    final f = settings?['liveCamera'];
    final enabled = f is Map && f['enabled'] == true;
    final name = f is Map && f['name'] is String && (f['name'] as String).trim().isNotEmpty ? f['name'] as String : sFor(ref.read(appLangProvider)).ra4CameraName;
    return LiveCameraInfo(enabled: enabled, name: name);
  }

  /// Core's `normaliseAudioMix` for the screen: volumes in steps, the camera
  /// row only with the external camera and only while it has audio.
  LiveAudioMix _normalise(VideoSourceKind video, LiveAudioMix m, LiveCameraInfo cam) {
    AudioSourceMix s(AudioSourceMix v, {bool? on}) => AudioSourceMix(enabled: on ?? v.enabled, volume: stepVolume(v.volume));
    final ext = video == VideoSourceKind.external;
    return LiveAudioMix(
      camera: s(m.camera, on: ext && cam.hasAudio != false),
      deviceMic: s(m.deviceMic, on: ext ? m.deviceMic.enabled : true),
      boxInput: s(m.boxInput),
    );
  }

  void _set(LiveSourceState next, {bool persist = true}) {
    state = next;
    if (persist) unawaited(ref.read(liveSourceStoreProvider).write(next.video, next.mix));
  }

  /// "Sumber video": the phone's (or iPad's) camera or the external camera.
  Future<void> selectVideo(VideoSourceKind kind) async {
    if (kind == state.video) return;
    if (kind == VideoSourceKind.external && !state.camera.offered) return;
    final old = state.mix;
    var mix = defaultMix(kind);
    // what is added stays added: Mic-in, and the device microphone with the camera
    mix = withSource(mix, idBoxInput, old.boxInput);
    if (kind == VideoSourceKind.external) mix = withSource(mix, idDeviceMic, const AudioSourceMix(enabled: false, volume: 100));
    mix = _normalise(kind, mix, state.camera);
    _set(state.copyWith(video: kind, mix: mix, error: null));
    await _push(videoChanged: true);
  }

  Future<void> setVolume(String id, int v) async {
    final cur = mixOf(state.mix, id);
    final next = withSource(state.mix, id, AudioSourceMix(enabled: cur.enabled, volume: stepVolume(v)));
    if (_mixEquals(next, state.mix)) return;
    _set(state.copyWith(mix: next));
    await _push();
  }

  Future<void> add(String id) async {
    if (id == idBoxInput && !state.boxInputAvailable) return;
    final next = withSource(state.mix, id, AudioSourceMix(enabled: true, volume: mixOf(state.mix, id).volume));
    _set(state.copyWith(mix: next));
    await _push();
  }

  Future<void> remove(String id) async {
    if (id == idCamera) return;
    if (id == idDeviceMic && !state.external) return; // the phone's own microphone is today's flow
    final next = withSource(state.mix, id, AudioSourceMix(enabled: false, volume: mixOf(state.mix, id).volume));
    _set(state.copyWith(mix: next));
    await _push();
  }

  /// "Guna `<sumber>` sahaja": the camera volume goes to 0, the microphone
  /// then plays at once (plan 4.3a).
  Future<void> useOnly(String id) async {
    final next = withSource(state.mix, idCamera, AudioSourceMix(enabled: state.mix.camera.enabled, volume: 0));
    _set(state.copyWith(mix: next));
    await _push();
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
    final st = state;
    ExternalCameraSource? camera;
    var video = st.video;
    if (st.external && !_isWeb) {
      try {
        camera = await cameraSource();
      } on Object {
        camera = null;
      }
      if (camera == null) {
        // no address to pull: fall back to the phone camera and say so
        video = VideoSourceKind.phone;
        state = state.copyWith(video: video, mix: defaultMix(video), error: liveCameraSourceFailed(ref.read(appLangProvider)));
      }
    }
    final cfg = PublisherConfig(
      recording: recording,
      frontCamera: frontCamera,
      video: video,
      camera: camera,
      mix: video == VideoSourceKind.external || state.mix.boxInput.enabled ? state.mix : null,
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
  Future<void> _push({bool videoChanged = false}) async {
    final p = _publisher;
    final st = state;
    try {
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
          return;
        }
        if (p is LiveSourceControl) {
          final ctl = p as LiveSourceControl;
          if (videoChanged) {
            final cam = st.external ? await cameraSource() : null;
            await ctl.setVideoSource(st.video, camera: cam, mix: st.mix, avOffsetMs: st.offsets[idDeviceMic] ?? 0);
          } else {
            await ctl.setAudioMix(st.mix);
          }
          if (st.mix.boxInput.enabled) await ref.read(gatewayProvider)?.changeLiveAudio(st.mix);
        }
        return;
      }
      if (videoChanged) {
        final phase = p.current.phase;
        if (phase == PublisherPhase.ready || phase == PublisherPhase.idle || phase == PublisherPhase.stopped) {
          await prepare(recording: p.current.recording.on, frontCamera: p.current.frontCamera);
        }
        return;
      }
      if (p is WebPublisher) {
        if (st.external) await p.setExternalMix(st.mix);
      } else if (p is LiveSourceControl && p.current.phase == PublisherPhase.ready) {
        await (p as LiveSourceControl).setAudioMix(st.mix);
      }
    } on Object catch (e) {
      debugPrint('live source change failed: ${e.runtimeType}');
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
  });

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
  });

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
  String get micName => ipad ? liveAudioIpadMicRow(lang) : liveAudioPhoneMicRow(lang);
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
  final rows = <AudioRowModel>[];
  final ext = source.external;
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
      rows.add(
        AudioRowModel(
          id: idCamera,
          name: liveAudioCameraRow(lang),
          volume: mix.camera.volume,
          level: level,
          status: status,
          tone: tone,
          hint: live ? null : liveAudioCameraVolumeHint(lang),
          readOnly: ctx.readOnly,
        ),
      );
    }
  } else {
    // the phone camera: today's flow, the device microphone with today's mute
    rows.add(
      AudioRowModel(
        id: idDeviceMic,
        name: ctx.micName,
        volume: mix.deviceMic.volume,
        level: ctx.muted ? 0 : (info[idDeviceMic]?.level ?? 0.6),
        status: ctx.muted ? liveAudioStatusMuted(lang) : liveAudioStatusReady(lang),
        tone: ctx.muted ? RowTone.idle : RowTone.ok,
        slider: false,
        mute: true,
        readOnly: ctx.readOnly,
      ),
    );
  }

  AudioRowModel added(String id) {
    final name = id == idDeviceMic ? ctx.micName : liveAudioBoxInputRow(lang);
    final vol = mixOf(mix, id).volume;
    final r = info[id];
    final boxMixed = id == idBoxInput || ctx.ipad;
    final aligned = r?.alignState;
    var status = live ? liveAudioStatusMixed(lang) : liveAudioStatusReadyMixed(lang);
    var tone = RowTone.ok;
    AlignChipModel? chip;
    var manual = false;
    if (!ext) {
      status = id == idBoxInput
          ? (source.boxInputAvailable ? liveAudioStatusBoxSignal(lang) : liveAudioBoxInputMissing(lang))
          : status;
      chip = AlignChipModel(live ? ChipKind.ok : ChipKind.wait, live ? liveAudioAligned(lang) : liveAudioAlignWhenLive(lang));
    } else if (noAud) {
      status = liveAudioStatusAlone(lang);
      manual = !live;
      if (live) chip = AlignChipModel(ChipKind.wait, liveAudioOffsetChip(lang, source.offsets[id] ?? 0));
    } else if (r?.state == 'lost') {
      status = liveAudioStatusMicLost(lang);
      tone = RowTone.off;
      chip = AlignChipModel(ChipKind.searching, liveAudioAlignAfterReturn(lang));
    } else if (unreach) {
      chip = AlignChipModel(ChipKind.wait, liveAudioAlignWhenCamera(lang));
    } else if (boxMixed && !live) {
      chip = AlignChipModel(ChipKind.wait, liveAudioAlignWhenLive(lang));
    } else if (ctx.camLost) {
      status = liveAudioStatusWithLastPicture(lang);
      chip = AlignChipModel(ChipKind.ok, liveAudioAligned(lang));
    } else if (ctx.camBack) {
      status = liveAudioStatusAtLastDelay(lang);
      chip = AlignChipModel(ChipKind.searching, liveAudioAligning(lang));
    } else {
      final camAudible = mix.camera.enabled && mix.camera.volume > 0;
      switch (aligned) {
        case 'locked' || 'holding' || 'manual':
          chip = AlignChipModel(ChipKind.ok, liveAudioAligned(lang));
        case 'failed':
          chip = AlignChipModel(ChipKind.bad, liveAudioNotAligned(lang));
          status = camAudible ? liveAudioStatusNotMixed(lang) : liveAudioStatusMixedMaybeOff(lang);
          tone = camAudible ? RowTone.warn : RowTone.ok;
        default:
          chip = AlignChipModel(ChipKind.searching, liveAudioAligning(lang));
          status = camAudible ? liveAudioStatusHeldOut(lang) : liveAudioStatusMixedPictureSoon(lang);
          tone = camAudible ? RowTone.warn : RowTone.ok;
      }
    }
    return AudioRowModel(
      id: id,
      name: name,
      volume: vol,
      level: lvl(id, 0.6, vol),
      status: status,
      tone: tone,
      chip: chip,
      removable: !ctx.readOnly && !(id == idDeviceMic && !ext),
      manual: manual,
      readOnly: ctx.readOnly,
    );
  }

  if (ext && mix.deviceMic.enabled) rows.add(added(idDeviceMic));
  if (mix.boxInput.enabled) rows.add(added(idBoxInput));
  return rows;
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
  if (mixAllMuted(mix, muted: ctx.muted) && (ext || boxOn || ctx.muted)) {
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
  final phoneAligns = ext && !noAud && micOn && !ctx.ipad && !ctx.readOnly && !ctx.camLost && !ctx.camBack;
  final micAlign = info[idDeviceMic]?.alignState;
  final unreach = !live && source.camera.reachable == false;
  if (phoneAligns && !unreach) {
    if (micAlign == 'failed') {
      out.add(
        camAudible
            ? AudioNotice(
                'bad',
                liveAudioNotAligned(lang),
                body: liveAudioAlignFailedAudible(lang, src),
                action: liveAudioUseSourceOnly(lang, src),
                actionId: idDeviceMic,
              )
            : AudioNotice('gold', null, body: liveAudioAlignFailedMuted(lang)),
      );
    } else if (micAlign == null || micAlign == 'searching') {
      out.add(
        AudioNotice(
          'help',
          null,
          body: camAudible ? liveAudioAligningHeldOut(lang, src) : liveAudioAligningMixed(lang, src),
        ),
      );
    }
  }
  // the box aligns the iPad microphone and Mic-in; its failure has the same words
  if (live && ext && !noAud && !ctx.readOnly) {
    for (final id in [if (ctx.ipad && micOn) idDeviceMic, if (boxOn) idBoxInput]) {
      if (info[id]?.alignState == 'failed') {
        out.add(
          camAudible
              ? AudioNotice(
                  'bad',
                  liveAudioNotAligned(lang),
                  body: liveAudioAlignFailedAudible(lang, sourceShort(id, ctx)),
                  action: liveAudioUseSourceOnly(lang, sourceShort(id, ctx)),
                  actionId: id,
                )
              : AudioNotice('gold', null, body: liveAudioAlignFailedMuted(lang)),
        );
      }
    }
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
  if (mixAllMuted(mix, muted: ctx.muted)) return (text: liveAudioSummaryMuted(lang), warn: true);
  final ext = source.external;
  final names = <String>[
    if (ext && !source.cameraNoAudio && mix.camera.volume > 0) liveAudioSummaryCamera(lang),
    if (ext && mix.deviceMic.enabled && mix.deviceMic.volume > 0) ctx.micShort,
    if (!ext && !ctx.muted) ctx.micShort,
    if (mix.boxInput.enabled && mix.boxInput.volume > 0) liveAudioBoxInputRow(lang),
  ];
  var tail = '';
  var warn = false;
  if (ext) {
    if (source.cameraNoAudio) {
      tail = liveAudioSummaryNoCameraAudio(lang);
    } else if (mix.deviceMic.enabled && !ctx.ipad && source.camera.reachable != false) {
      switch (info[idDeviceMic]?.alignState) {
        case 'locked' || 'holding' || 'manual':
          tail = liveAudioSummaryAligned(lang);
        case 'failed':
          tail = liveAudioSummaryNotAligned(lang);
          warn = true;
        default:
          tail = liveAudioSummarySearching(lang);
      }
    }
  }
  return (text: '${names.isEmpty ? liveAudioSummaryNone(lang) : names.join(' + ')}$tail', warn: warn);
}
