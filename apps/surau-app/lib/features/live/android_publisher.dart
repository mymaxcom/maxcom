// The Android side of the Live tab (Plan 5, Task 10): a thin client for the
// in-repo Kotlin plugin `my.maxcom.app.live` (RootEncoder). One camera
// capture and one encoder feed the kiosk leg (SRT to the box), the optional
// YouTube leg (RTMPS) and a segmented MP4 recording, inside a foreground
// service. This file only maps the MethodChannel and EventChannel to the
// [LivePublisher] seam. The stream key and passphrase cross the channel once
// in `start`; nothing here stores, logs or prints them, and engine messages
// that are not plain reason codes are replaced before they reach a state.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../shell/live_camera_gateway.dart' show LiveAudioMix;
import 'publisher.dart';

/// A refusal from the native plugin; [code] is a reason code, never a URL.
class PublisherException implements Exception {
  const PublisherException(this.code);
  final String code;

  @override
  String toString() => 'PublisherException($code)';
}

class _MetricsWatcher with WidgetsBindingObserver {
  _MetricsWatcher(this.onTurn);
  final void Function() onTurn;

  @override
  void didChangeMetrics() => onTurn();
}

class AndroidPublisher implements LivePublisher, LiveSourceControl {
  AndroidPublisher({
    this.segmentMinutes = 15,
    this.videoBitrateKbps = 2500,
    this.recordDir = 'Movies/MAXCOM',
    bool Function()? portraitProvider,
  }) : _portraitProvider = portraitProvider ?? _deviceIsPortrait {
    WidgetsBinding.instance.addObserver(_metrics);
    _events = eventChannel.receiveBroadcastStream().listen(
      _onEvent,
      onError: (Object _) {},
    );
  }

  static const methodChannel = MethodChannel('my.maxcom/live');
  static const eventChannel = EventChannel('my.maxcom/live/events');
  static const previewViewType = 'my.maxcom/live/preview';

  /// `recording.segmentMinutes` from the box settings.
  final int segmentMinutes;

  /// The kiosk leg's fixed bitrate (`liveYoutube.maxBitrateKbps` caps it).
  final int videoBitrateKbps;

  /// A label for where recordings land (shown, not a path the plugin trusts).
  final String recordDir;

  final bool Function() _portraitProvider;
  late final _metrics = _MetricsWatcher(deviceTurned);

  /// True when the first view is taller than wide.
  static bool _deviceIsPortrait() {
    final views = WidgetsBinding.instance.platformDispatcher.views;
    if (views.isEmpty) return false;
    final size = views.first.physicalSize;
    return size.height > size.width;
  }

  final _controller = StreamController<PublisherState>.broadcast();
  StreamSubscription<dynamic>? _events;
  PublisherState _state = PublisherState.initial;
  bool _recordingOn = true;

  @override
  Stream<PublisherState> get states => _controller.stream;

  @override
  PublisherState get current => _state;

  void _emit(PublisherState s) {
    _state = s;
    if (!_controller.isClosed) _controller.add(s);
  }

  @override
  Future<void> prepare(PublisherConfig c) async {
    _recordingOn = c.recording;
    final portrait = c.portrait ?? _portraitProvider();
    if (c.video == VideoSourceKind.external && c.camera == null) {
      _emit(_state.copyWith(phase: PublisherPhase.error));
      return;
    }
    _emit(
      _state.copyWith(
        phase: PublisherPhase.preparing,
        portrait: portrait,
        clearEndReason: true,
      ),
    );
    try {
      final r = await methodChannel.invokeMethod<Map<Object?, Object?>>(
        'prepare',
        {
          'facing': c.frontCamera ? 'front' : 'back',
          // The output is always 16:9 1280x720, upright. Held in portrait,
          // the plugin crops a centred 16:9 band of the camera.
          'width': 1280,
          'height': 720,
          'fps': 30,
          'portrait': portrait,
          ..._sourceArgs(c.video, c.camera, c.mix, c.avOffsetMs),
        },
      );
      if (r != null && r['ok'] == false) {
        _emit(_state.copyWith(phase: PublisherPhase.error));
        return;
      }
      _emit(
        _state.copyWith(
          phase: PublisherPhase.ready,
          frontCamera: c.frontCamera,
          recording: RecordingState(on: c.recording),
          video: c.video,
          clearExternal: c.video == VideoSourceKind.phone,
        ),
      );
    } on PlatformException {
      _emit(_state.copyWith(phase: PublisherPhase.error));
    }
  }

  // ---- the external camera and the audio mix (K2) ----

  /// The channel arguments of a source: `source` = `{kind, url, transport}`,
  /// `mix` and `avOffsetMs`. The address (it may hold the login) is sent for
  /// the external camera only, here and nowhere else; it is not kept.
  static Map<String, Object?> _sourceArgs(
    VideoSourceKind kind,
    ExternalCameraSource? camera,
    LiveAudioMix? mix,
    int avOffsetMs,
  ) => {
    'source': {
      'kind': kind.name,
      if (kind == VideoSourceKind.external && camera != null) ...{
        'url': camera.url,
        'transport': camera.transport,
      },
    },
    'mix': mix?.toJson(),
    'avOffsetMs': avOffsetMs,
  };

  @override
  Future<void> setVideoSource(
    VideoSourceKind kind, {
    ExternalCameraSource? camera,
    LiveAudioMix? mix,
    int avOffsetMs = 0,
  }) async {
    if (kind == VideoSourceKind.external && camera == null) {
      throw const PublisherException('camera_source_missing');
    }
    try {
      await methodChannel.invokeMethod<void>(
        'setSource',
        _sourceArgs(kind, camera, mix, avOffsetMs),
      );
    } on PlatformException catch (e) {
      throw PublisherException(_code(e.code) ?? 'error');
    }
    _emit(
      _state.copyWith(
        video: kind,
        clearExternal: kind == VideoSourceKind.phone,
      ),
    );
  }

  @override
  Future<void> setAudioMix(LiveAudioMix mix) => _call('setMix', {
    'source': {'kind': _state.video.name},
    'mix': mix.toJson(),
  });

  @override
  Future<void> setAvOffset(int ms) => _call('setAvOffset', ms);

  @override
  Future<void> clapCapture() => _call('clapCapture');

  @override
  Future<void> clapReplay(int offsetMs) => _call('clapReplay', offsetMs);

  @override
  Future<void> clapOffset(int offsetMs) => _call('clapOffset', offsetMs);

  @override
  Future<void> clapStop() => _call('clapStop');

  Future<void> _call(String method, [Object? args]) async {
    try {
      await methodChannel.invokeMethod<void>(method, args);
    } on PlatformException catch (e) {
      throw PublisherException(_code(e.code) ?? 'error');
    }
  }

  /// The device was turned: the picture follows (crop band or full frame)
  /// without touching the encoder, so a live stream is not dropped.
  void deviceTurned() {
    final portrait = _portraitProvider();
    if (portrait == _state.portrait) return;
    _emit(_state.copyWith(portrait: portrait));
    unawaited(
      methodChannel
          .invokeMethod<void>('setPortrait', portrait)
          .catchError((Object _) {}),
    );
  }

  @override
  Future<void> start(PublisherTargets t) async {
    deviceTurned(); // the framing at Mula siaran is the one in hand
    final args = <String, Object?>{
      'srt': t.outputs.kiosk ? _srtTarget(t.ingestUrl) : null,
      'rtmps': t.outputs.youtube ? _rtmpsTarget(t.youtubeUrl) : null,
      'record': _recordingOn
          ? {
              'dir': recordDir,
              'prefix': _prefix(t.kuliahId),
              'segmentMinutes': segmentMinutes,
            }
          : null,
      'video': {'bitrateKbps': videoBitrateKbps, 'fps': 30, 'gopSeconds': 2},
      'audio': {'bitrateKbps': 128, 'sampleRate': 48000, 'stereo': false},
    };
    _emit(
      _state.copyWith(
        phase: PublisherPhase.starting,
        outputs: PublisherOutputs(
          kiosk: t.outputs.kiosk ? OutputState.connecting : null,
          youtube: t.outputs.youtube ? OutputState.connecting : null,
        ),
        recording: RecordingState(on: _recordingOn),
      ),
    );
    try {
      await methodChannel.invokeMethod<void>('start', args);
    } on PlatformException catch (e) {
      _emit(_state.copyWith(phase: PublisherPhase.error));
      throw PublisherException(_code(e.code) ?? 'error');
    }
  }

  @override
  Future<void> startYoutube(String url) async {
    final target = _rtmpsTarget(url);
    if (target == null) return;
    _emit(
      _state.copyWith(
        outputs: PublisherOutputs(
          kiosk: _state.outputs.kiosk,
          youtube: OutputState.connecting,
        ),
      ),
    );
    try {
      await methodChannel.invokeMethod<void>('startYoutube', target);
    } on PlatformException catch (e) {
      throw PublisherException(_code(e.code) ?? 'error');
    }
  }

  @override
  Future<void> stop() async {
    _emit(_state.copyWith(phase: PublisherPhase.stopping));
    try {
      await methodChannel.invokeMethod<void>('stop');
    } on PlatformException {
      _emit(_state.copyWith(phase: PublisherPhase.error));
    }
  }

  @override
  String? get recordingSessionId => null;

  @override
  Future<List<String>> sessionRecordings() async {
    try {
      final l = await methodChannel.invokeMethod<List<dynamic>>(
        'sessionRecordings',
      );
      return [
        for (final n in l ?? const <dynamic>[])
          if (n is String) n,
      ];
    } on PlatformException {
      return const [];
    } on MissingPluginException {
      return const [];
    }
  }

  @override
  Future<void> switchCamera() async {
    try {
      await methodChannel.invokeMethod<void>('switchCamera');
      _emit(_state.copyWith(frontCamera: !_state.frontCamera));
    } on PlatformException {
      // The camera stays as it was; the next state event says so.
    }
  }

  @override
  void setMuted(bool muted) {
    _emit(_state.copyWith(muted: muted));
    unawaited(
      methodChannel
          .invokeMethod<void>('setMuted', muted)
          .catchError((Object _) {}),
    );
  }

  @override
  Widget preview(BuildContext context) => PlatformViewLink(
    viewType: previewViewType,
    surfaceFactory: (context, controller) => AndroidViewSurface(
      controller: controller as AndroidViewController,
      gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
      hitTestBehavior: PlatformViewHitTestBehavior.transparent,
    ),
    onCreatePlatformView: (params) =>
        PlatformViewsService.initSurfaceAndroidView(
            id: params.id,
            viewType: previewViewType,
            layoutDirection: TextDirection.ltr,
            creationParamsCodec: const StandardMessageCodec(),
            onFocus: () => params.onFocusChanged(true),
          )
          ..addOnPlatformViewCreatedListener(params.onPlatformViewCreated)
          ..create(),
  );

  Future<void> dispose() async {
    WidgetsBinding.instance.removeObserver(_metrics);
    await _events?.cancel();
    await _controller.close();
  }

  @override
  String toString() => 'AndroidPublisher(${_state.phase.name})';

  // ---- targets ----

  /// `srt://host:port?streamid=...&passphrase=...` from the box's start
  /// answer, split for the plugin. Null when the URL is missing or bad.
  static Map<String, Object?>? _srtTarget(String? url) {
    if (url == null || url.isEmpty) return null;
    final u = Uri.tryParse(url);
    if (u == null || u.host.isEmpty || u.port == 0) return null;
    final pass = u.queryParameters['passphrase'];
    return {
      'host': u.host,
      'port': u.port,
      'streamId': u.queryParameters['streamid'] ?? '',
      'passphrase': (pass == null || pass.isEmpty) ? null : pass,
    };
  }

  /// A full `rtmps://` URL is used as given; a bare stream key is placed on
  /// YouTube's ingest address.
  static Map<String, Object?>? _rtmpsTarget(String? urlOrKey) {
    if (urlOrKey == null || urlOrKey.isEmpty) return null;
    final url = urlOrKey.startsWith('rtmps://')
        ? urlOrKey
        : 'rtmps://a.rtmps.youtube.com:443/live2/$urlOrKey';
    return {'url': url};
  }

  static String _prefix(String? kuliahId) {
    final s = (kuliahId ?? '').replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '-');
    if (s.isEmpty) return 'siaran';
    return s.length > 40 ? s.substring(0, 40) : s;
  }

  // ---- events ----

  static final _codeRe = RegExp(r'^[a-z0-9_]{1,40}$');

  /// Engine messages are reason codes; anything else may hold a URL.
  static String? _code(Object? m) {
    if (m is! String || m.isEmpty) return null;
    return _codeRe.hasMatch(m) ? m : 'error';
  }

  void _onEvent(dynamic e) {
    if (e is! Map) return;
    switch (e['type']) {
      case 'phase':
        final p = _byName(PublisherPhase.values, e['value']);
        if (p != null) _emit(_state.copyWith(phase: p));
      case 'output':
        final st = _byName(OutputPhase.values, e['state']);
        final name = e['name'];
        if (st == null || (name != 'kiosk' && name != 'youtube')) return;
        final retry = e['retryInSec'];
        final o = OutputState(
          st,
          retryInSec: retry is int ? retry : null,
          message: _code(e['message']),
        );
        _emit(
          _state.copyWith(
            outputs: PublisherOutputs(
              kiosk: name == 'kiosk' ? o : _state.outputs.kiosk,
              youtube: name == 'youtube' ? o : _state.outputs.youtube,
            ),
          ),
        );
      case 'stats':
        _emit(
          _state.copyWith(
            stats: StreamStats(
              bitrateKbps: _int(e['bitrateKbps']),
              fps: _int(e['fps']),
              dropped: _int(e['dropped']),
              rttMs: e['rttMs'] is int ? e['rttMs'] as int : null,
            ),
            durationSec: e['durationSec'] is int
                ? e['durationSec'] as int
                : null,
          ),
        );
      case 'recording':
        _emit(
          _state.copyWith(
            recording: RecordingState(
              on: _state.recording.on,
              segments: _int(e['segments']),
              bytes: _int(e['bytes']),
              lastError: _code(e['lastError']),
            ),
          ),
        );
      case 'warning':
        final w = _byName(Warning.values, e['kind']);
        if (w == null) return;
        final next = {..._state.warnings};
        if (e['active'] == false) {
          next.remove(w);
        } else {
          next.add(w);
        }
        _emit(_state.copyWith(warnings: next));
      case 'audio':
        _onAudio(e);
      case 'ended':
        final reason = _code(e['reason']);
        if (reason != null) _emit(_state.copyWith(endReason: reason));
      case 'clap':
        final c = _byName(ClapPhase.values, e['state']);
        if (c != null) _emit(_state.copyWith(clap: c));
    }
  }

  /// The phone's own mix: a row per source with its meter and alignment, the
  /// mixed level and the camera link. Anything unexpected is dropped.
  void _onAudio(Map<dynamic, dynamic> e) {
    final rows = <AudioRow>[];
    final src = e['sources'];
    if (src is List) {
      for (final r in src) {
        if (r is! Map || r['id'] is! String) continue;
        final align = r['align'];
        rows.add(
          AudioRow(
            id: r['id'] as String,
            enabled: r['enabled'] == true,
            volume: _int(r['volume']),
            level: _level(r['level']),
            state: _stateWord(r['state']),
            alignState: align is Map ? _alignWord(align['state']) : null,
            delayMs: align is Map && align['delayMs'] is num
                ? (align['delayMs'] as num).toInt()
                : null,
            residualMs: align is Map && align['residualMs'] is num
                ? (align['residualMs'] as num).toDouble()
                : null,
          ),
        );
      }
    }
    final cam = e['camera'];
    _emit(
      _state.copyWith(
        audio: PublisherAudio(
          rows: rows,
          mixed: _level(e['mixed']),
          micFailed: e['micFailed'] == true,
        ),
        camera: cam is Map
            ? CameraStatus(
                link:
                    _byName(CameraLink.values, cam['link']) ?? CameraLink.idle,
                hasAudio: cam['hasAudio'] is bool
                    ? cam['hasAudio'] as bool
                    : null,
                lostSec: _int(cam['lostSec']),
                transport:
                    cam['transport'] == 'tcp' || cam['transport'] == 'udp'
                    ? cam['transport'] as String
                    : null,
                width: _int(cam['width']),
                height: _int(cam['height']),
              )
            : null,
      ),
    );
  }

  static double _level(Object? v) =>
      v is num ? v.toDouble().clamp(0.0, 1.0) : 0.0;

  static String _stateWord(Object? v) =>
      v == 'lost' || v == 'silent' ? v as String : 'ok';

  static String? _alignWord(Object? v) {
    const words = {'searching', 'locked', 'holding', 'failed', 'manual'};
    return v is String && words.contains(v) ? v : null;
  }

  static int _int(Object? v) => v is num ? v.toInt() : 0;

  static T? _byName<T extends Enum>(List<T> values, Object? name) {
    if (name is! String) return null;
    for (final v in values) {
      if (v.name == name) return v;
    }
    return null;
  }
}
