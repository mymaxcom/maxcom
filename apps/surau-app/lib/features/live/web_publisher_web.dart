// The browser publisher (Plan 5 Task 9): iPad Safari and Chrome on a PC.
//
// One camera and microphone capture feeds three independent things:
//   - the kiosk leg: an RTCPeerConnection that sends H.264 to the box over
//     WHIP (`POST /api/live/whip`, SDP body, Bearer header, no trickle ICE),
//     reconnected with backoff while live; the box relays to YouTube;
//   - the recorder: MediaRecorder segments written to IndexedDB, which a
//     dropped or failing WHIP leg never touches (anti-goal 4);
//   - the screen wake lock, so the iPad keeps the camera running.
//
// Only the box origin path `/api/live/whip` (and the `Location` it answers,
// `/api/live/whip/<id>`) is ever contacted. The token travels only in the
// Authorization header; nothing here logs a token, an SDP or a URL.
//
// The browser objects sit behind small seams ([CaptureStream], [PeerLink],
// [SegmentRecorder], [WhipFetch], [PageEnv]) so the logic is tested in
// Chrome with fakes.

import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import '../../l10n/generated/s.dart';
import '../../l10n/s_lookup.dart';
import '../shell/live_camera_gateway.dart'
    show AudioSourceMix, LiveAudioMix;
import 'android_publisher.dart' show PublisherException;
import 'publisher.dart';
import 'recordings_store.dart';
import 'web_external_live.dart';

export 'web_external_live.dart';

// ---- seams ----

/// What `getUserMedia` returned.
abstract class CaptureStream {
  /// The browser `MediaStream` (null for a fake).
  JSObject? get native;

  /// Fires once when the browser ended the camera (the iPad does when the
  /// screen locks or the tab goes away).
  Stream<void> get ended;
  bool get hasEnded;
  void setAudioEnabled(bool enabled);

  /// Stops every track (the camera light goes off).
  void stop();
}

typedef GetUserMedia = Future<CaptureStream> Function(
  Map<String, Object?> constraints,
);

class OfferResult {
  const OfferResult(this.sdp, {required this.h264First});
  final String sdp;

  /// False when the browser offers no H.264: the box leg still works, but
  /// the YouTube relay has to re-encode.
  final bool h264First;
}

class PeerStats {
  const PeerStats({
    this.bitrateKbps = 0,
    this.fps = 0,
    this.rttMs,
    this.lost = 0,
  });
  final int bitrateKbps;
  final int fps;
  final int? rttMs;
  final int lost;
}

abstract class PeerLink {
  /// Adds the tracks, prefers H.264, caps the bitrate, makes the offer and
  /// waits for ICE gathering (2 s cap). Returns the complete local SDP.
  Future<OfferResult> createOffer(
    CaptureStream s, {
    required int maxBitrateBps,
  });
  Future<void> applyAnswer(String sdp);

  /// `new`, `connecting`, `connected`, `disconnected`, `failed`, `closed`.
  Stream<String> get connectionStates;
  Future<PeerStats> stats();
  Future<void> replaceTracks(CaptureStream s);
  void close();
}

typedef PeerFactory = PeerLink Function();

/// The receiving side (WHEP) of the box's combined stream: the preview, and
/// the source of the recording in an external-camera live (plan 4.6, 5).
abstract class ReceiverLink {
  /// A receive-only offer for one video and one audio track, with ICE
  /// gathering complete (2 s cap). Returns the local SDP.
  Future<String> createOffer();
  Future<void> applyAnswer(String sdp);

  /// `new`, `connecting`, `connected`, `disconnected`, `failed`, `closed`.
  Stream<String> get connectionStates;

  /// The browser `MediaStream` the received tracks are added to (null for a
  /// fake). It exists from the start; tracks arrive once connected.
  JSObject? get stream;
  void close();
}

typedef ReceiverFactory = ReceiverLink Function();

/// Sends the mix of a running box-combined live to the box
/// (`BoxGatewayLiveCamera.changeLiveAudio`: `POST /api/live/audio`).
typedef AudioChanger = Future<void> Function(LiveAudioMix mix);

/// The same call with the optional additions of the box's audio route:
/// [video] (`phone` = the iPad's own camera, `external` = back to the
/// camera; a mid-live switch) and [avOffsetMs] (the hand-set offset of the
/// iPad microphone, 0 to 2000 ms in steps of 50). A tear-off of
/// `BoxGatewayLiveCamera.changeLiveAudio` fits it.
typedef AudioChangeSender =
    Future<void> Function(LiveAudioMix mix, {String? video, int? avOffsetMs});

/// Stores the fallback "Imbangan masa audio" of an added source (`deviceMic`
/// or `boxInput`, 0 to 2000 ms) in the camera settings.
typedef OffsetSaver = Future<void> Function(String id, int ms);

/// One MediaRecorder run: its data arrives in chunks and the whole run is
/// one self-contained file.
abstract class SegmentRecorder {
  String get mime;
  void start(
    void Function(Object chunk, int size) onChunk,
    void Function(String code) onError,
  );

  /// Completes after the last chunk was delivered.
  Future<void> stop();
}

typedef RecorderFactory = SegmentRecorder Function(CaptureStream s);

class WhipRequest {
  const WhipRequest(this.method, this.path, this.headers, {this.body});
  final String method;
  final String path;
  final Map<String, String> headers;
  final String? body;

  @override
  String toString() => 'WhipRequest($method $path)';
}

class WhipReply {
  const WhipReply(this.status, this.body, {this.location});
  final int status;
  final String body;
  final String? location;
}

typedef WhipFetch = Future<WhipReply> Function(WhipRequest r);

abstract class WakeHandle {
  Future<void> release();
}

/// The page: visibility and the screen wake lock.
abstract class PageEnv {
  bool get visible;
  Stream<bool> get visibility;
  Future<WakeHandle?> requestWakeLock();
  void dispose();
}

// ---- the publisher ----

class WebPublisher implements LivePublisher, LiveMicControl {
  WebPublisher({
    this.tokenProvider,
    Uri? box,
    this.segmentMinutes = 15,
    this.maxBitrateKbps = 2500,
    GetUserMedia? getUserMedia,
    bool Function()? portraitProvider,
    PeerFactory? peerFactory,
    RecorderFactory? recorderFactory,
    WhipFetch? fetch,
    RecordingsStore? store,
    Future<int?> Function()? freeBytes,
    PageEnv? page,
    ReceiverFactory? receiverFactory,
    this.audioChanger,
    this.audioSender,
    this.offsetSaver,
    S Function()? lang,
    bool Function()? canRecordReceived,
    this.recordWatchdog = const Duration(seconds: 12),
  }) : _origin = box ?? Uri.base,
       _lang = lang,
       _getUserMedia = getUserMedia ?? browserGetUserMedia,
       _portraitProvider = portraitProvider ?? _windowIsPortrait,
       _receiverFactory = receiverFactory ?? (() => RtcReceiverLink()),
       _canRecordReceived =
           canRecordReceived ?? (() => pickRecorderMime() != null),
       _peerFactory = peerFactory ?? (() => RtcPeerLink()),
       _recorderFactory = recorderFactory ?? browserRecorder,
       _store = store ?? openRecordingsStore(),
       _freeBytes = freeBytes ?? browserFreeBytes,
       _page = page ?? BrowserPage() {
    _fetch = fetch ?? _browserFetch;
    _visSub = _page.visibility.listen(_onVisibility);
  }

  /// The WHIP path on the box (the only one the publisher posts to).
  static const String whipPath = '/api/live/whip';

  /// The WHEP path of the starting device's preview (box task B2, plan 4.6:
  /// "new proxy route for the starting device"). The other path the
  /// publisher talks to.
  static const String whepPath = '/api/live/preview/whep';

  /// How long a received-stream recorder may stay silent before the browser
  /// is judged unable to record it (T0 item 7 is unproven on iPad Safari).
  final Duration recordWatchdog;

  /// `POST /api/live/audio`; the caller passes the gateway's method.
  final AudioChanger? audioChanger;

  /// `POST /api/live/audio` with `video` and `avOffsetMs` too. Without it
  /// the switch of the camera and the offset during a live cannot reach the
  /// box ([audioChanger] sends the mix only).
  final AudioChangeSender? audioSender;

  /// Saves the fallback offset of an added source in the camera settings.
  final OffsetSaver? offsetSaver;

  /// The app language now; BM when the caller gives none.
  final S Function()? _lang;
  S get _s => _lang?.call() ?? sBm;
  final ReceiverFactory _receiverFactory;
  final bool Function() _canRecordReceived;

  /// The session token for the Authorization header.
  final Future<String?> Function()? tokenProvider;
  final int segmentMinutes;
  final int maxBitrateKbps;

  final Uri _origin;
  final GetUserMedia _getUserMedia;
  final bool Function() _portraitProvider;

  static bool _windowIsPortrait() =>
      web.window.innerHeight > web.window.innerWidth;
  final PeerFactory _peerFactory;
  final RecorderFactory _recorderFactory;
  late final WhipFetch _fetch;
  final RecordingsStore _store;
  final Future<int?> Function() _freeBytes;
  final PageEnv _page;

  final _controller = StreamController<PublisherState>.broadcast();
  PublisherState _state = PublisherState.initial;

  CaptureStream? _capture;
  StreamSubscription<void>? _endedSub;
  StreamSubscription<bool>? _visSub;
  web.HTMLVideoElement? _video;

  bool _recordingOn = true;
  bool _front = false;
  bool _muted = false;
  bool _h264Missing = false;

  // Session.
  bool _live = false;
  int _epoch = 0;
  String _whip = whipPath;
  String _label = 'siaran';
  String? _sessionId;
  int _attempt = 0;
  PeerLink? _peer;
  StreamSubscription<String>? _peerSub;
  String? _location;
  Timer? _retryTimer;
  Timer? _disconnectTimer;
  Timer? _tick;
  int _ticks = 0;
  bool _polling = false;
  WakeHandle? _wake;

  // Recorder.
  SegmentRecorder? _recorder;
  Timer? _segmentTimer;
  int _segIndex = 0;
  int _segCount = 0;
  int _recBytes = 0;
  bool _rotating = false;
  Future<void> _storeQueue = Future.value();
  Future<void> _ending = Future.value();
  String? _recError;
  bool _recStopped = false;

  // External camera (plan 4.6): the box pulls the camera and combines it;
  // the iPad controls, previews (WHEP) and records what it receives.
  bool _extMode = false;
  bool _audioOnly = false; // the capture is the microphone alone
  LiveAudioMix? _mix;
  ExternalLiveState _ext = ExternalLiveState.idle;
  final _extController = StreamController<ExternalLiveState>.broadcast();
  ReceiverLink? _recv;
  StreamSubscription<String>? _recvSub;
  String? _recvLocation;
  ReceivedCapture? _recvCapture;
  Timer? _recvRetry;
  Timer? _recvDisconnect;
  int _recvAttempt = 0;
  Timer? _micRetry;
  Timer? _recWatch;
  Future<void> _mixChain = Future.value();
  int _mixSeq = 0;
  List<String> _boxWarnings = const [];

  /// The id the session's recorded files are filed under in the store.
  String? get sessionId => _sessionId;

  /// True when the browser offers no H.264 (the YouTube relay re-encodes).
  bool get h264Missing => _h264Missing;

  /// The recordings store (the Live screen lists and saves from it).
  RecordingsStore get recordings => _store;

  @override
  Stream<PublisherState> get states => _controller.stream;

  @override
  PublisherState get current => _state;

  void _emit(PublisherState s) {
    _state = s;
    if (!_controller.isClosed) _controller.add(s);
  }

  /// The external-camera side of the session (idle outside one).
  Stream<ExternalLiveState> get external => _extController.stream;
  ExternalLiveState get externalState => _ext;

  void _setKiosk(OutputState? o) => _emit(
    _state.copyWith(
      outputs: PublisherOutputs(kiosk: o, youtube: _state.outputs.youtube),
    ),
  );

  void _warn(Warning w, bool on) {
    final has = _state.warnings.contains(w);
    if (on == has) return;
    final next = {..._state.warnings};
    on ? next.add(w) : next.remove(w);
    _emit(_state.copyWith(warnings: next));
  }

  static Map<String, Object?> constraintsFor({required bool front, String? micId}) => {
    'video': {
      'facingMode': front ? 'user' : 'environment',
      // Always a 16:9 1280x720 track, whatever way the device is held. Where
      // the browser honours these two it crops to the band itself; where it
      // does not, [browserGetUserMedia] crops through a canvas.
      'width': 1280,
      'height': 720,
      'aspectRatio': 16 / 9,
      'resizeMode': 'crop-and-scale',
      'frameRate': 30,
    },
    // A PA microphone: no processing.
    'audio': _audioConstraints(micId),
  };

  static Map<String, Object?> _audioConstraints(String? micId) => {
    if (micId != null) 'deviceId': {'exact': micId},
    'echoCancellation': false,
    'noiseSuppression': false,
    'autoGainControl': false,
  };

  /// The microphone the person's device switched to by itself (a USB or
  /// Lightning mic plugged in); null = the browser's default.
  String? _micId;

  /// getUserMedia with the chosen microphone; one that was unplugged since
  /// falls back to the browser's default instead of failing the capture.
  Future<CaptureStream> _openCapture(
    Map<String, Object?> Function(String? micId) build,
  ) async {
    final id = _micId;
    if (id != null) {
      try {
        return await _getUserMedia(build(id));
      } catch (_) {
        _micId = null;
      }
    }
    return _getUserMedia(build(null));
  }

  // ---- prepare and preview ----

  @override
  Future<void> prepare(PublisherConfig c) async {
    _extMode = false;
    _audioOnly = false;
    _setExt(ExternalLiveState.idle);
    _recordingOn = c.recording;
    _front = c.frontCamera;
    _emit(
      _state.copyWith(
        phase: PublisherPhase.preparing,
        portrait: c.portrait ?? _portraitProvider(),
      ),
    );
    try {
      await _acquire();
    } catch (_) {
      _emit(_state.copyWith(phase: PublisherPhase.error));
      return;
    }
    _emit(
      _state.copyWith(
        phase: PublisherPhase.ready,
        frontCamera: _front,
        recording: RecordingState(on: _recordingOn),
      ),
    );
  }

  Future<void> _acquire() async {
    final cap = await _openCapture(
      (id) => _extMode && _audioOnly
          ? micConstraints(micId: id)
          : constraintsFor(front: _front, micId: id),
    );
    _swapCapture(cap);
  }

  /// The iPad microphone alone (an added source of the box's mix): raw, for
  /// a PA, like the camera capture's audio.
  static Map<String, Object?> micConstraints({String? micId}) => {
    'audio': _audioConstraints(micId),
  };

  void _swapCapture(CaptureStream cap) {
    final old = _capture;
    _endedSub?.cancel();
    _capture = cap;
    cap.setAudioEnabled(!_muted);
    _endedSub = cap.ended.listen((_) => _onCaptureEnded(cap));
    _attachPreview();
    if (old != null && !identical(old, cap)) old.stop();
  }

  void _attachPreview() {
    final v = _video;
    // An external-camera live shows the box's combined stream, never the
    // microphone capture; otherwise the capture itself.
    final n = _extMode ? _recv?.stream : _capture?.native;
    if (v == null) return;
    if (_extMode) v.muted = !_ext.previewSound;
    v.srcObject = n as web.MediaStream?;
    if (n != null) {
      unawaited(
        v.play().toDart.catchError((Object _) {
          // Safari refuses sound without a gesture: play muted instead.
          if (_extMode && !v.muted) {
            v.muted = true;
            _setExt(_ext.copyWith(previewSound: false));
            unawaited(v.play().toDart.catchError((Object _) => null));
          }
          return null;
        }),
      );
    }
  }

  @override
  Widget preview(BuildContext context) => HtmlElementView.fromTagName(
    tagName: 'video',
    onElementCreated: (Object element) {
      final v = element as web.HTMLVideoElement
        ..muted = true
        ..autoplay = true
        ..setAttribute('playsinline', '')
        ..setAttribute('muted', '');
      v.style
        ..width = '100%'
        ..height = '100%'
        ..objectFit = 'cover'
        ..backgroundColor = 'black';
      _video = v;
      _attachPreview();
    },
  );

  @override
  Future<void> startYoutube(String url) async =>
      throw UnsupportedError('Penerbit pelayar: YouTube ikut kotak');

  // ---- start ----

  @override
  Future<void> start(PublisherTargets t) async {
    if (!_extMode && _capture == null) {
      throw const PublisherException('not_prepared');
    }
    if (_live) return;
    final path = _whipTarget(t.ingestUrl);
    _live = true;
    _epoch++;
    final epoch = _epoch;
    _whip = path;
    _label = safeLabel(t.kuliahId);
    _sessionId = 's${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}';
    _attempt = 0;
    _ticks = 0;
    _location = null;
    _recError = null;
    _recStopped = false;
    _segIndex = 0;
    _segCount = 0;
    _recBytes = 0;
    _emit(
      _state.copyWith(
        phase: PublisherPhase.starting,
        outputs: PublisherOutputs(
          kiosk: OutputState.connecting,
          youtube: t.outputs.youtube ? OutputState.connecting : null,
        ),
        recording: RecordingState(on: _recordingOn),
        warnings: const {},
        durationSec: 0,
        stats: StreamStats.zero,
      ),
    );
    unawaited(_requestWake());
    if (_extMode) {
      await _startExternal(epoch);
      return;
    }
    await _startRecording(epoch);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick(epoch));
    _emit(_state.copyWith(phase: PublisherPhase.live));
    await _connectOnce(epoch);
  }

  /// Only the box's WHIP path is ever posted to.
  String _whipTarget(String? ingestUrl) {
    if (ingestUrl == null || ingestUrl.isEmpty) return whipPath;
    final u = Uri.tryParse(ingestUrl);
    if (u == null) throw const PublisherException('bad_target');
    if (u.hasAuthority && !_sameOrigin(u)) {
      throw const PublisherException('bad_target');
    }
    if (u.path != whipPath || u.hasQuery) {
      throw const PublisherException('bad_target');
    }
    return whipPath;
  }

  bool _sameOrigin(Uri u) =>
      u.scheme == _origin.scheme &&
      u.host == _origin.host &&
      u.port == _origin.port;

  bool _active(int epoch) => _live && epoch == _epoch;

  // ---- the kiosk leg (WHIP) ----

  Future<void> _connectOnce(int epoch) async {
    if (!_active(epoch)) return;
    final capture = _capture;
    if (capture == null || capture.hasEnded) return;
    _setKiosk(OutputState.connecting);
    PeerLink? peer;
    try {
      peer = _peerFactory();
      _peer = peer;
      unawaited(_peerSub?.cancel());
      _peerSub = peer.connectionStates.listen(
        (s) => _onConnection(epoch, peer!, s),
      );
      final offer = await peer.createOffer(
        capture,
        maxBitrateBps: maxBitrateKbps * 1000,
      );
      if (!_audioOnly) _h264Missing = !offer.h264First;
      if (!_active(epoch) || _staleLeg(capture)) {
        peer.close();
        return;
      }
      final token = await tokenProvider?.call();
      final reply = await _fetch(
        WhipRequest('POST', _whip, {
          'Content-Type': 'application/sdp',
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
        }, body: offer.sdp),
      ).timeout(const Duration(seconds: 10));
      final location = _safeLocation(reply.location);
      if (!_active(epoch) || _staleLeg(capture)) {
        peer.close();
        if (location != null) unawaited(_deleteWhip(location));
        return;
      }
      if (reply.status != 201 && reply.status != 200) {
        throw _WhipRefused(reply.status);
      }
      _location = location;
      await peer.applyAnswer(reply.body);
    } catch (e) {
      final failed = peer;
      if (failed != null) {
        failed.close();
        if (identical(_peer, failed)) _peer = null;
      }
      if (!_active(epoch) || _staleLeg(capture)) return;
      _scheduleRetry(epoch, _codeOf(e));
    }
  }

  /// An external-camera live drops and swaps its capture (the microphone
  /// leaves, the iPad camera comes): a connect started for an older capture
  /// must not go on.
  bool _staleLeg(CaptureStream c) => _extMode && !identical(c, _capture);

  static String _codeOf(Object e) {
    if (e is _WhipRefused) {
      return e.status == 401 || e.status == 403
          ? 'session_refused'
          : 'whip_${e.status}';
    }
    if (e is TimeoutException) return 'timeout';
    return 'connect_failed';
  }

  void _onConnection(int epoch, PeerLink peer, String s) {
    if (!_active(epoch) || !identical(peer, _peer)) return;
    switch (s) {
      case 'connected':
        _attempt = 0;
        _disconnectTimer?.cancel();
        _setKiosk(OutputState.up);
        if (_extMode) {
          _setExt(_ext.copyWith(mic: ExternalMic.ok));
          _refreshNotice();
        }
      case 'disconnected':
        _disconnectTimer?.cancel();
        _disconnectTimer = Timer(
          const Duration(seconds: 3),
          () => _recover(epoch, peer),
        );
      case 'failed':
        _disconnectTimer?.cancel();
        _recover(epoch, peer);
    }
  }

  void _recover(int epoch, PeerLink peer) {
    if (!_active(epoch) || !identical(peer, _peer)) return;
    final loc = _location;
    _location = null;
    _peer = null;
    _peerSub?.cancel();
    peer.close();
    if (loc != null) unawaited(_deleteWhip(loc));
    _scheduleRetry(epoch, 'connection_lost');
  }

  /// 2, 4, 8, 16, 30, 30 ... seconds, unlimited while live.
  void _scheduleRetry(int epoch, String code) {
    _retryTimer?.cancel();
    final delay = _attempt >= 4 ? 30 : (2 << _attempt);
    _attempt++;
    var remaining = delay;
    _setKiosk(
      OutputState(OutputPhase.retrying, retryInSec: remaining, message: code),
    );
    _retryTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!_active(epoch)) {
        t.cancel();
        return;
      }
      remaining--;
      if (remaining <= 0) {
        t.cancel();
        _retryTimer = null;
        unawaited(_connectOnce(epoch));
      } else {
        _setKiosk(
          OutputState(
            OutputPhase.retrying,
            retryInSec: remaining,
            message: code,
          ),
        );
      }
    });
  }

  /// A same-origin `/api/live/whip/<id>` path, or null.
  String? _safeLocation(String? loc, {String base = whipPath}) {
    if (loc == null || loc.isEmpty) return null;
    final u = Uri.tryParse(loc);
    if (u == null) return null;
    if (u.hasAuthority && !_sameOrigin(u)) return null;
    if (!RegExp('^${RegExp.escape(base)}/[A-Za-z0-9._~-]{1,128}\$')
        .hasMatch(u.path)) {
      return null;
    }
    return u.path;
  }

  Future<void> _deleteWhip(String path) async {
    try {
      final token = await tokenProvider?.call();
      await _fetch(
        WhipRequest('DELETE', path, {
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
        }),
      ).timeout(const Duration(seconds: 5));
    } catch (_) {
      // Best effort: the box times the session out on its own.
    }
  }

  // ---- tick: duration, stats, storage ----

  void _onTick(int epoch) {
    if (!_active(epoch)) return;
    _ticks++;
    _emit(_state.copyWith(durationSec: _state.durationSec + 1));
    if (_ticks % 2 == 0) unawaited(_pollStats(epoch));
    if (_ticks % 60 == 0) unawaited(_checkStorage(epoch));
  }

  Future<void> _pollStats(int epoch) async {
    final peer = _peer;
    if (peer == null || _polling) return;
    _polling = true;
    try {
      final s = await peer.stats();
      if (_active(epoch)) {
        _emit(
          _state.copyWith(
            stats: StreamStats(
              bitrateKbps: s.bitrateKbps,
              fps: s.fps,
              rttMs: s.rttMs,
              dropped: s.lost,
            ),
          ),
        );
      }
    } catch (_) {
      // Stats are a nicety.
    } finally {
      _polling = false;
    }
  }

  // ---- the recorder (independent of the WHIP leg) ----

  Future<void> _startRecording(int epoch) async {
    if (!_recordingOn) return;
    final free = await _freeBytes();
    if (free != null && free < _stopBytes) {
      _recError = 'storage_low';
      _recStopped = true;
      _publishRecording();
      _warn(Warning.lowStorage, true);
      return;
    }
    if (free != null && free < _warnBytes) _warn(Warning.lowStorage, true);
    _beginSegment();
    _segmentTimer = Timer.periodic(
      Duration(minutes: segmentMinutes),
      (_) => unawaited(_rotate(epoch)),
    );
  }

  static const int _warnBytes = 1500 * 1000 * 1000;
  static const int _stopBytes = 300 * 1000 * 1000;

  void _beginSegment() {
    final cap = _extMode ? _recvCapture : _capture;
    final sid = _sessionId;
    if (cap == null || sid == null || _recStopped) return;
    final index = _segIndex;
    try {
      final rec = _recorderFactory(cap);
      _recorder = rec;
      _segCount = index + 1;
      rec.start((chunk, size) => _onChunk(sid, index, rec.mime, chunk, size), (
        code,
      ) {
        _recError = code;
        _publishRecording();
      });
      _publishRecording();
    } catch (_) {
      _recorder = null;
      _recError = 'recorder_unavailable';
      _publishRecording();
    }
  }

  void _onChunk(String sid, int index, String mime, Object chunk, int size) {
    _recBytes += size;
    _publishRecording();
    if (_extMode && _ext.recording != ExternalRecording.running) {
      _setExt(_ext.copyWith(recording: ExternalRecording.running));
      _refreshNotice();
    }
    _storeQueue = _storeQueue.then((_) async {
      try {
        await _store.appendPart(
          sessionId: sid,
          index: index,
          mime: mime,
          label: _label,
          chunk: chunk,
          size: size,
        );
      } catch (_) {
        _recError = 'store_failed';
        _publishRecording();
      }
    });
  }

  void _publishRecording() => _emit(
    _state.copyWith(
      recording: RecordingState(
        on: _recordingOn,
        segments: _segCount,
        bytes: _recBytes,
        lastError: _recError,
      ),
    ),
  );

  /// Stops the running recorder and files its segment.
  Future<void> _endSegment() async {
    final rec = _recorder;
    final sid = _sessionId;
    _recorder = null;
    if (rec == null || sid == null) return;
    try {
      await rec.stop();
    } catch (_) {}
    try {
      await _storeQueue;
      await _store.finishSegment(sid, _segIndex);
    } catch (_) {
      _recError = 'store_failed';
    }
  }

  Future<void> _rotate(int epoch) async {
    if (!_active(epoch) || _rotating || _recorder == null) return;
    _rotating = true;
    try {
      await _endSegment();
      _segIndex++;
      if (_active(epoch)) _beginSegment();
    } finally {
      _rotating = false;
    }
  }

  Future<void> _checkStorage(int epoch) async {
    if (!_recordingOn || _recStopped) return;
    final free = await _freeBytes();
    if (free == null || !_active(epoch)) return;
    if (free < _stopBytes) {
      _segmentTimer?.cancel();
      await _endSegment();
      _recStopped = true;
      _recError = 'storage_low';
      _warn(Warning.lowStorage, true);
      _publishRecording();
    } else {
      _warn(Warning.lowStorage, free < _warnBytes);
    }
  }

  // ---- wake lock, visibility, a camera the iPad ended ----

  Future<void> _requestWake() async {
    try {
      await _wake?.release();
    } catch (_) {}
    _wake = null;
    if (!_live) return;
    _wake = await _page.requestWakeLock();
    if (!_live) {
      await _wake?.release();
      _wake = null;
    }
  }

  void _onVisibility(bool visible) {
    if (!_live) return;
    if (!visible) {
      _warn(Warning.screenLockRisk, true);
      return;
    }
    _warn(Warning.screenLockRisk, false);
    unawaited(_requestWake());
    if (_extMode) {
      _attachPreview();
      if (_ext.mic == ExternalMic.lost) unawaited(_reacquireExt(_epoch));
      return;
    }
    if (_capture?.hasEnded ?? false) unawaited(_reacquire(_epoch));
  }

  void _onCaptureEnded(CaptureStream cap) {
    if (!identical(cap, _capture) || !_live) return;
    if (_extMode) {
      _onExtCaptureEnded(cap);
      return;
    }
    final epoch = _epoch;
    _retryTimer?.cancel();
    _disconnectTimer?.cancel();
    final loc = _location;
    _location = null;
    final peer = _peer;
    _peer = null;
    _peerSub?.cancel();
    peer?.close();
    if (loc != null) unawaited(_deleteWhip(loc));
    _warn(Warning.screenLockRisk, true);
    _setKiosk(
      OutputState(OutputPhase.down, message: _s.ra4CameraStoppedByIpad),
    );
    // What was recorded so far is filed; a new segment starts with the
    // camera that comes back.
    _segmentTimer?.cancel();
    _ending = _endSegment().then((_) => _segIndex++);
    if (_page.visible) unawaited(_reacquire(epoch));
  }

  /// The person came back to the page: get the camera again and resume.
  Future<void> _reacquire(int epoch) async {
    if (!_active(epoch)) return;
    try {
      await _acquire();
    } catch (_) {
      return; // stays down with the message
    }
    if (!_active(epoch)) return;
    _warn(Warning.screenLockRisk, false);
    _attempt = 0;
    if (_recordingOn && !_recStopped) {
      await _ending;
      await _storeQueue;
      _beginSegment();
      _segmentTimer?.cancel();
      _segmentTimer = Timer.periodic(
        Duration(minutes: segmentMinutes),
        (_) => unawaited(_rotate(epoch)),
      );
    }
    await _connectOnce(epoch);
  }

  // ---- controls ----

  /// The browser files its segments by session id; no names to report.
  @override
  Future<List<String>> sessionRecordings() async => const [];

  @override
  String? get recordingSessionId => _sessionId;

  @override
  Future<void> switchCamera() async {
    final front = !_front;
    final CaptureStream next;
    try {
      next = await _openCapture((id) => constraintsFor(front: front, micId: id));
    } catch (_) {
      return; // the camera stays as it was
    }
    await _applyRecapture(next, front);
  }

  /// The new capture (camera and microphone) replaces the running one; a live
  /// goes on over the same connection, the recording starts a new segment.
  Future<void> _applyRecapture(CaptureStream next, bool front) async {
    final epoch = _epoch;
    final liveNow = _live;
    if (liveNow) {
      _segmentTimer?.cancel();
      await _endSegment();
      _segIndex++;
    }
    _front = front;
    _swapCapture(next);
    if (liveNow && _active(epoch)) {
      try {
        await _peer?.replaceTracks(next);
      } catch (_) {}
      if (_recordingOn && !_recStopped) {
        _beginSegment();
        _segmentTimer = Timer.periodic(
          Duration(minutes: segmentMinutes),
          (_) => unawaited(_rotate(epoch)),
        );
      }
    }
    _emit(_state.copyWith(frontCamera: front));
  }

  /// A microphone plugged in (or unplugged) while this device publishes: the
  /// sound comes from [deviceId] (null = the default one) from now on. A live
  /// goes on over the same connection (the track is replaced); false when the
  /// microphone could not be opened (nothing changes).
  @override
  Future<bool> setMicrophone(String? deviceId) async {
    final prev = _micId;
    _micId = deviceId;
    final cap = _capture;
    if (cap == null) return true; // the next capture uses it
    if (cap.hasEnded) {
      // the unplugged microphone ended the capture: take a new one now
      if (_live) {
        if (_extMode && _ext.mic == ExternalMic.lost) {
          unawaited(_reacquireExt(_epoch));
        } else if (!_extMode) {
          unawaited(_reacquire(_epoch));
        }
      }
      return true;
    }
    final audioOnly = _extMode && _audioOnly;
    final CaptureStream next;
    try {
      next = await _getUserMedia(
        audioOnly
            ? micConstraints(micId: deviceId)
            : constraintsFor(front: _front, micId: deviceId),
      );
    } catch (_) {
      _micId = prev;
      return false;
    }
    if (!identical(cap, _capture)) {
      next.stop();
      return true;
    }
    if (audioOnly) {
      _swapCapture(next);
      if (_live) {
        try {
          await _peer?.replaceTracks(next);
        } catch (_) {}
      }
    } else {
      await _applyRecapture(next, _front);
    }
    return true;
  }

  @override
  void setMuted(bool muted) {
    _muted = muted;
    _capture?.setAudioEnabled(!muted);
    _emit(_state.copyWith(muted: muted));
  }

  // ---- stop ----

  @override
  Future<void> stop() async {
    _emit(_state.copyWith(phase: PublisherPhase.stopping));
    _live = false;
    _epoch++;
    _retryTimer?.cancel();
    _disconnectTimer?.cancel();
    _tick?.cancel();
    _segmentTimer?.cancel();
    _micRetry?.cancel();
    _recWatch?.cancel();
    // The last segment is finalised before anything else can fail.
    await _endSegment();
    if (_extMode) await _closeReceiver();
    final loc = _location;
    _location = null;
    final peer = _peer;
    _peer = null;
    await _peerSub?.cancel();
    peer?.close();
    if (loc != null) await _deleteWhip(loc);
    try {
      await _wake?.release();
    } catch (_) {}
    _wake = null;
    _capture?.stop();
    if (_extMode) _setExt(ExternalLiveState.idle);
    _emit(
      _state.copyWith(
        phase: PublisherPhase.stopped,
        outputs: PublisherOutputs(
          kiosk: _state.outputs.kiosk == null ? null : OutputState.down,
          youtube: _state.outputs.youtube == null ? null : OutputState.down,
        ),
        warnings: const {},
      ),
    );
  }

  Future<void> dispose() async {
    final wasLive = _live;
    if (wasLive) await stop();
    _capture?.stop();
    await _endedSub?.cancel();
    await _visSub?.cancel();
    await _peerSub?.cancel();
    await _closeReceiver();
    _micRetry?.cancel();
    _recWatch?.cancel();
    _page.dispose();
    await _extController.close();
    await _controller.close();
  }

  // ---- external camera (plan 4.6 and 5, task C4) ----
  //
  // The box pulls the camera and combines its sound with the iPad
  // microphone. This device: sends the microphone alone by WHIP when it is
  // in the mix (nothing at all otherwise), plays the box's combined stream
  // by WHEP, records that received stream, and changes the mix through
  // `POST /api/live/audio`. Volumes and the alignment state are the box's
  // (`applyBoxStatus`).

  /// What an external-camera live starts with: the camera at full volume, no
  /// other source (plan 4.4).
  static LiveAudioMix defaultExternalMix() => const LiveAudioMix(
    camera: AudioSourceMix(enabled: true, volume: 100),
    deviceMic: AudioSourceMix(enabled: false, volume: 100),
    boxInput: AudioSourceMix(enabled: false, volume: 100),
  );

  LiveAudioMix get _mixNow => _mix ?? defaultExternalMix();

  /// The mix this device last sent (or will start with).
  LiveAudioMix get externalMix => _mixNow;

  void _setExt(ExternalLiveState s) {
    _ext = s;
    if (!_extController.isClosed) _extController.add(s);
  }

  void _refreshNotice() {
    if (!_extMode) return;
    final m = _mixNow;
    final n = externalNoticeFor(
      mix: m,
      mic: _ext.mic,
      sources: _ext.sources,
      warnings: _boxWarnings,
      cameraHasAudio: _ext.cameraHasAudio,
      micInMix: m.deviceMic.enabled,
      recording: _ext.recording,
      recordingAsked: _recordingOn,
      lang: _s,
    );
    _setExt(
      n == null
          ? _ext.copyWith(clearNotice: true, canUseMicOnly: false)
          : _ext.copyWith(
              notice: n.message,
              noticeHint: n.hint,
              canUseMicOnly: n.micOnlyAction,
            ),
    );
  }

  /// Prepares a live whose picture the box pulls from the external camera.
  /// No camera is opened here; the microphone only when it is in [mix], at
  /// start (on the person's tap).
  Future<void> prepareExternal(
    PublisherConfig c, {
    LiveAudioMix? mix,
    bool cameraHasAudio = true,
    int fallbackOffsetMs = 0,
  }) async {
    _extMode = true;
    _audioOnly = true;
    _front = false;
    _recordingOn = c.recording;
    _offsetSent = clampExternalOffset(fallbackOffsetMs);
    final m = mix ?? defaultExternalMix();
    _mix = m;
    _boxWarnings = const [];
    _setExt(
      ExternalLiveState(
        active: true,
        // With the iPad microphone near the speaker the preview starts
        // muted (it would feed back); the person can turn it on with
        // headphones.
        previewSound: !m.deviceMic.enabled,
        cameraHasAudio: cameraHasAudio,
        fallbackOffsetMs: clampExternalOffset(fallbackOffsetMs),
      ),
    );
    _emit(
      _state.copyWith(
        phase: PublisherPhase.ready,
        portrait: c.portrait ?? _portraitProvider(),
        recording: RecordingState(on: _recordingOn),
      ),
    );
    _refreshNotice();
  }

  Future<void> _startExternal(int epoch) async {
    final m = _mixNow;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick(epoch));
    // Controller only: nothing is sent, so there is nothing to connect.
    _setKiosk(m.deviceMic.enabled ? OutputState.connecting : OutputState.up);
    _emit(_state.copyWith(phase: PublisherPhase.live));
    unawaited(_connectPreview(epoch));
    if (m.deviceMic.enabled) await _startMic(epoch);
  }

  // The microphone leg ---------------------------------------------------

  Future<void> _startMic(int epoch) async {
    if (!_active(epoch)) return;
    _setExt(_ext.copyWith(mic: ExternalMic.starting));
    final CaptureStream cap;
    try {
      cap = await _openCapture((id) => micConstraints(micId: id));
    } catch (_) {
      if (!_active(epoch)) return;
      await _micRefused();
      return;
    }
    if (!_active(epoch) || _ext.video != ExternalVideo.external) {
      cap.stop();
      return;
    }
    _audioOnly = true;
    _swapCapture(cap);
    await _connectOnce(epoch);
  }

  /// Permission refused (or no microphone): the live goes on with the
  /// camera audio, and the box is told the microphone is not in the mix.
  Future<void> _micRefused() async {
    final m = _mixNow;
    final next = LiveAudioMix(
      camera: m.camera,
      deviceMic: AudioSourceMix(enabled: false, volume: m.deviceMic.volume),
      boxInput: m.boxInput,
    );
    _mix = next;
    _setKiosk(OutputState.up);
    _setExt(
      _ext.copyWith(
        mic: ExternalMic.off,
        notice: externalMicRefusedMessage(_s),
        canUseMicOnly: false,
      ),
    );
    try {
      await _audioCall?.call(next);
    } catch (_) {
      // The next status poll shows what the box really holds.
    }
  }

  /// Ends the leg that sends from this device (microphone or camera) and
  /// releases the capture.
  Future<void> _dropLeg() async {
    _retryTimer?.cancel();
    _disconnectTimer?.cancel();
    _micRetry?.cancel();
    final loc = _location;
    _location = null;
    final peer = _peer;
    _peer = null;
    await _peerSub?.cancel();
    peer?.close();
    if (loc != null) await _deleteWhip(loc);
    await _endedSub?.cancel();
    _endedSub = null;
    _capture?.stop();
    _capture = null;
    _attempt = 0;
  }

  Future<void> _stopMic() async {
    await _dropLeg();
    _setExt(_ext.copyWith(mic: ExternalMic.off));
    _setKiosk(OutputState.up);
    _refreshNotice();
  }

  /// The browser ended the microphone (or the iPad camera): Safari hidden,
  /// screen locked. The live goes on without it (plan 4.6); it comes back
  /// by itself when the person returns.
  void _onExtCaptureEnded(CaptureStream cap) {
    _retryTimer?.cancel();
    _disconnectTimer?.cancel();
    final loc = _location;
    _location = null;
    final peer = _peer;
    _peer = null;
    _peerSub?.cancel();
    peer?.close();
    if (loc != null) unawaited(_deleteWhip(loc));
    _warn(Warning.screenLockRisk, true);
    _setKiosk(const OutputState(OutputPhase.down, message: 'microphone_lost'));
    _setExt(_ext.copyWith(mic: ExternalMic.lost));
    _refreshNotice();
    _micRetry?.cancel();
    final epoch = _epoch;
    _micRetry = Timer.periodic(const Duration(seconds: 5), (t) {
      if (!_active(epoch) || _ext.mic != ExternalMic.lost) {
        t.cancel();
        return;
      }
      if (_page.visible) unawaited(_reacquireExt(epoch));
    });
    if (_page.visible) unawaited(_reacquireExt(epoch));
  }

  Future<void> _reacquireExt(int epoch) async {
    if (!_active(epoch) || _ext.mic != ExternalMic.lost) return;
    try {
      await _acquire();
    } catch (_) {
      return; // stays lost; the timer tries again
    }
    if (!_active(epoch)) return;
    _micRetry?.cancel();
    _warn(Warning.screenLockRisk, false);
    _attempt = 0;
    _setExt(_ext.copyWith(mic: ExternalMic.starting));
    await _connectOnce(epoch);
  }

  // The preview and the recording of the received stream -------------------

  Future<void> _connectPreview(int epoch) async {
    if (!_active(epoch) || !_extMode) return;
    _setExt(
      _ext.copyWith(
        preview: _recvAttempt == 0
            ? ExternalPreview.connecting
            : ExternalPreview.retrying,
      ),
    );
    ReceiverLink? r;
    try {
      r = _receiverFactory();
      _recv = r;
      _recvCapture = ReceivedCapture(r.stream);
      unawaited(_recvSub?.cancel());
      final link = r;
      _recvSub = r.connectionStates.listen((s) => _onRecvState(epoch, link, s));
      _attachPreview();
      final offer = await r.createOffer();
      if (!_active(epoch) || !identical(_recv, r)) {
        r.close();
        return;
      }
      final token = await tokenProvider?.call();
      final reply = await _fetch(
        WhipRequest('POST', whepPath, {
          'Content-Type': 'application/sdp',
          if (token != null && token.isNotEmpty)
            'Authorization': 'Bearer $token',
        }, body: offer),
      ).timeout(const Duration(seconds: 10));
      final location = _safeLocation(reply.location, base: whepPath);
      if (!_active(epoch) || !identical(_recv, r)) {
        r.close();
        if (location != null) unawaited(_deleteWhip(location));
        return;
      }
      if (reply.status != 201 && reply.status != 200) {
        throw _WhipRefused(reply.status);
      }
      _recvLocation = location;
      await r.applyAnswer(reply.body);
    } catch (_) {
      final failed = r;
      if (failed != null) {
        failed.close();
        if (identical(_recv, failed)) _recv = null;
      }
      if (_active(epoch)) _scheduleRecvRetry(epoch);
    }
  }

  void _onRecvState(int epoch, ReceiverLink r, String s) {
    if (!_active(epoch) || !identical(r, _recv)) return;
    switch (s) {
      case 'connected':
        _recvAttempt = 0;
        _recvDisconnect?.cancel();
        _setExt(_ext.copyWith(preview: ExternalPreview.playing));
        unawaited(_onReceivedUp(epoch));
      case 'disconnected':
        _recvDisconnect?.cancel();
        _recvDisconnect = Timer(
          const Duration(seconds: 3),
          () => _recoverRecv(epoch, r),
        );
      case 'failed':
        _recvDisconnect?.cancel();
        _recoverRecv(epoch, r);
    }
  }

  void _recoverRecv(int epoch, ReceiverLink r) {
    if (!_active(epoch) || !identical(r, _recv)) return;
    final loc = _recvLocation;
    _recvLocation = null;
    _recv = null;
    _recvSub?.cancel();
    r.close();
    if (loc != null) unawaited(_deleteWhip(loc));
    _scheduleRecvRetry(epoch);
  }

  /// 2, 4, 8, 16, 30 ... seconds while live (the box restarts its combiner
  /// when a source is added or removed, so a short break is normal).
  void _scheduleRecvRetry(int epoch) {
    _recvRetry?.cancel();
    final delay = _recvAttempt >= 4 ? 30 : (2 << _recvAttempt);
    _recvAttempt++;
    _setExt(_ext.copyWith(preview: ExternalPreview.retrying));
    _recvRetry = Timer(Duration(seconds: delay), () {
      _recvRetry = null;
      unawaited(_connectPreview(epoch));
    });
  }

  Future<void> _closeReceiver() async {
    _recvRetry?.cancel();
    _recvDisconnect?.cancel();
    final r = _recv;
    _recv = null;
    _recvCapture = null;
    final loc = _recvLocation;
    _recvLocation = null;
    await _recvSub?.cancel();
    _recvSub = null;
    r?.close();
    if (loc != null) await _deleteWhip(loc);
    _recvAttempt = 0;
  }

  /// The combined stream arrived: start recording it, or, after a
  /// reconnect, file the segment of the old stream and start a new one.
  Future<void> _onReceivedUp(int epoch) async {
    if (!_recordingOn || _recStopped || !_active(epoch)) return;
    if (_segmentTimer == null) {
      if (!_canRecordReceived()) {
        _recordingUnavailable('no_recorder');
        return;
      }
      await _startRecording(epoch);
    } else {
      await _endSegment();
      _segIndex++;
      if (!_active(epoch)) return;
      _beginSegment();
    }
    if (_recorder == null) {
      if (!_recStopped) {
        _recordingUnavailable(_recError ?? 'recorder_unavailable');
      }
      return;
    }
    _armRecordWatch(epoch);
  }

  /// T0 item 7 is unproven: Safari may accept a received stream and then
  /// deliver no data. No data within [recordWatchdog] means "cannot record".
  void _armRecordWatch(int epoch) {
    _recWatch?.cancel();
    final base = _recBytes;
    _recWatch = Timer(recordWatchdog, () async {
      if (!_active(epoch) || _recBytes > base || _recorder == null) return;
      _segmentTimer?.cancel();
      await _endSegment();
      _recordingUnavailable('no_data');
    });
  }

  void _recordingUnavailable(String code) {
    _recStopped = true;
    _recError = code;
    _publishRecording();
    _setExt(_ext.copyWith(recording: ExternalRecording.unavailable));
    _refreshNotice();
  }

  /// The box's own view (the decoded `GET /api/live/status` body): the
  /// volumes, the health and the alignment state of every source, and the
  /// standing warnings. The caller passes it on each poll.
  void applyBoxStatus(Map<String, dynamic> status) {
    if (!_extMode) return;
    _boxWarnings = parseExternalWarnings(status);
    _setExt(_ext.copyWith(sources: parseExternalAudio(status)));
    _refreshNotice();
  }

  /// Changes the mix. Before the live it is only remembered; during it the
  /// whole mix goes to the box (`POST /api/live/audio`, the starting device
  /// only). Adding the iPad microphone starts its WHIP after the box has
  /// accepted the change (it provisions the ingest); removing it stops the
  /// WHIP after. Throws what the call throws; the mix is then unchanged.
  Future<void> setExternalMix(LiveAudioMix mix) async {
    if (!_extMode) throw const PublisherException('not_external');
    final prev = _mixNow;
    final micAdded = !prev.deviceMic.enabled && mix.deviceMic.enabled;
    final micRemoved = prev.deviceMic.enabled && !mix.deviceMic.enabled;
    if (!_live) {
      _mix = mix;
      _setExt(_ext.copyWith(previewSound: !mix.deviceMic.enabled));
      _refreshNotice();
      return;
    }
    final changer = _audioCall;
    if (changer == null) throw const PublisherException('no_audio_channel');
    await _sendMix(changer, mix, structural: micAdded || micRemoved);
    _mix = mix;
    final epoch = _epoch;
    if (_ext.video == ExternalVideo.external) {
      if (micAdded) {
        _setExt(_ext.copyWith(previewSound: false));
        _attachPreview();
        await _startMic(epoch);
      } else if (micRemoved) {
        await _stopMic();
      }
    }
    _refreshNotice();
  }

  /// The call that reaches the box: the sender when there is one, else the
  /// plain mix changer (which cannot carry [video] or [avOffsetMs]).
  AudioChangeSender? get _audioCall {
    final sender = audioSender;
    if (sender != null) return sender;
    final changer = audioChanger;
    if (changer == null) return null;
    return (mix, {video, avOffsetMs}) {
      if (video != null || avOffsetMs != null) {
        throw const PublisherException('no_audio_channel');
      }
      return changer(mix);
    };
  }

  /// The offset the box last accepted (what the camera settings held at
  /// the start, until a change was sent).
  int _offsetSent = 0;

  /// Every send carries the whole mix and goes after the one before; a
  /// volume change that a newer request already replaced is skipped (a
  /// slider dragged fast sends only its latest value). The hand-set offset
  /// rides along whenever it differs from what the box holds.
  Future<void> _sendMix(
    AudioChangeSender changer,
    LiveAudioMix mix, {
    required bool structural,
    String? video,
  }) {
    final seq = ++_mixSeq;
    final run = _mixChain.then((_) async {
      if (!structural && seq != _mixSeq) return;
      final offset = _ext.fallbackOffsetMs;
      final send = offset != _offsetSent;
      await changer(mix, video: video, avOffsetMs: send ? offset : null);
      if (send) _offsetSent = offset;
    });
    _mixChain = run.then((_) {}, onError: (Object _) {});
    return run;
  }

  /// "Guna Mikrofon iPad sahaja": the camera volume goes to 0 so the
  /// microphone plays at once (plan 4.3a).
  Future<void> useMicOnly() {
    final m = _mixNow;
    return setExternalMix(
      LiveAudioMix(
        camera: AudioSourceMix(enabled: m.camera.enabled, volume: 0),
        deviceMic: m.deviceMic,
        boxInput: m.boxInput,
      ),
    );
  }

  /// The preview's sound on or off (headphones: on, with the iPad
  /// microphone in the mix).
  void setPreviewSound(bool on) {
    _setExt(_ext.copyWith(previewSound: on));
    _attachPreview();
  }

  /// "Imbangan masa audio" for a camera with no audio: the value being tried
  /// against the preview (0 to 2000 ms, steps of 50). Held here until
  /// [saveFallbackOffset].
  void setFallbackOffset(int ms) {
    _setExt(_ext.copyWith(fallbackOffsetMs: clampExternalOffset(ms)));
    // During a live the box applies it at once (its delay = headroom + offset).
    final changer = _audioCall;
    if (_extMode && _live && _ext.video == ExternalVideo.external) {
      if (changer != null && _ext.fallbackOffsetMs != _offsetSent) {
        unawaited(
          _sendMix(changer, _mixNow, structural: false).catchError((Object _) {
            // Held here; the next change of the mix sends it again.
          }),
        );
      }
    }
  }

  /// Stores the tried value in the camera settings ("Simpan").
  Future<void> saveFallbackOffset() async {
    final saver = offsetSaver;
    if (saver == null) throw const PublisherException('no_offset_saver');
    await saver('deviceMic', _ext.fallbackOffsetMs);
  }

  /// "Tukar ke kamera iPad": the iPad sends its own camera and microphone to
  /// the box (WHIP) and the box combines that as the unit; the preview and
  /// the recording follow the box's stream, which restarts for a few
  /// seconds. False when the camera could not be opened (nothing changed).
  Future<bool> switchToIpadCamera() async {
    if (!_extMode || !_live || _ext.video == ExternalVideo.ipadCamera) {
      return false;
    }
    final epoch = _epoch;
    final CaptureStream cam;
    try {
      cam = await _openCapture((id) => constraintsFor(front: _front, micId: id));
    } catch (_) {
      return false;
    }
    if (!_active(epoch)) {
      cam.stop();
      return false;
    }
    // The box moves the picture to this device's stream first (it also
    // allows the publisher on its new path), then this device sends.
    final changer = _audioCall;
    if (changer == null) {
      cam.stop();
      return false;
    }
    try {
      await _sendMix(changer, _mixNow, structural: true, video: 'phone');
    } catch (_) {
      cam.stop();
      return false;
    }
    if (!_active(epoch)) {
      cam.stop();
      return false;
    }
    await _dropLeg();
    _audioOnly = false;
    _setExt(
      _ext.copyWith(video: ExternalVideo.ipadCamera, mic: ExternalMic.starting),
    );
    _setKiosk(OutputState.connecting);
    _swapCapture(cam);
    await _connectOnce(epoch);
    return true;
  }

  /// Back to the external camera: the iPad sends only its microphone again
  /// when that is in the mix, else nothing.
  Future<bool> switchToExternalCamera() async {
    if (!_extMode || !_live || _ext.video == ExternalVideo.external) {
      return false;
    }
    final epoch = _epoch;
    final changer = _audioCall;
    if (changer == null) return false;
    try {
      await _sendMix(changer, _mixNow, structural: true, video: 'external');
    } catch (_) {
      return false;
    }
    if (!_active(epoch)) return false;
    await _dropLeg();
    _audioOnly = true;
    _setExt(_ext.copyWith(video: ExternalVideo.external, mic: ExternalMic.off));
    if (_mixNow.deviceMic.enabled) {
      await _startMic(epoch);
    } else {
      _setKiosk(OutputState.up);
    }
    _refreshNotice();
    return true;
  }

  // ---- default fetch ----

  Future<WhipReply> _browserFetch(WhipRequest r) async {
    final ok = [whipPath, whepPath].any(
      (b) => r.path == b || r.path.startsWith('$b/'),
    );
    if (!ok) throw const PublisherException('bad_target');
    final url = Uri(
      scheme: _origin.scheme,
      host: _origin.host,
      port: _origin.hasPort ? _origin.port : null,
      path: r.path,
    );
    final headers = web.Headers();
    r.headers.forEach((k, v) => headers.append(k, v));
    final init = web.RequestInit(
      method: r.method,
      headers: headers,
      credentials: 'omit',
      cache: 'no-store',
    );
    if (r.body != null) init.body = r.body!.toJS;
    final res = await web.window.fetch(url.toString().toJS, init).toDart;
    final text = r.method == 'POST' ? (await res.text().toDart).toDart : '';
    return WhipReply(res.status, text, location: res.headers.get('location'));
  }
}

class _WhipRefused implements Exception {
  const _WhipRefused(this.status);
  final int status;

  @override
  String toString() => '_WhipRefused($status)';
}

// ---- H.264 preference (pure, tested) ----

/// The order to hand to `setCodecPreferences`: H.264 with packetization
/// mode 1 (profile 42e01f first), then other H.264, then everything else,
/// each group in the browser's own order.
class CodecOrder {
  const CodecOrder(this.indexes, {required this.hasH264});
  final List<int> indexes;
  final bool hasH264;
}

CodecOrder codecOrder(List<({String mime, String fmtp})> codecs) {
  int rank(({String mime, String fmtp}) c) {
    if (c.mime.toLowerCase() != 'video/h264') return 3;
    final f = c.fmtp.toLowerCase();
    if (f.contains('packetization-mode=1')) {
      return f.contains('profile-level-id=42e01f') ? 0 : 1;
    }
    return 2;
  }

  final idx = List<int>.generate(codecs.length, (i) => i);
  idx.sort((a, b) {
    final c = rank(codecs[a]).compareTo(rank(codecs[b]));
    return c != 0 ? c : a.compareTo(b);
  });
  return CodecOrder(
    idx,
    hasH264: codecs.any((c) => c.mime.toLowerCase() == 'video/h264'),
  );
}

// ---- browser implementations ----

Future<CaptureStream> browserGetUserMedia(
  Map<String, Object?> constraints,
) async {
  final stream = await web.window.navigator.mediaDevices
      .getUserMedia(constraints.jsify() as web.MediaStreamConstraints)
      .toDart;
  final plain = BrowserCapture(stream);
  // A touch device can be turned at any time, and Safari may ignore
  // `aspectRatio` and `resizeMode`: crop through a canvas there. A desktop
  // webcam that already delivers 16:9 is left alone (no extra CPU).
  final tracks = stream.getVideoTracks().toDart;
  if (tracks.isEmpty) return plain;
  var crop = web.window.navigator.maxTouchPoints > 0;
  final st = tracks.first.getSettings();
  if (st.width > 0 && st.height > 0) {
    crop = crop || !isSixteenNine(st.width, st.height);
  }
  return crop ? CroppedCapture(plain) : plain;
}

/// True when [w] x [h] is 16:9 within 2 percent.
bool isSixteenNine(int w, int h) => h > 0 && ((w / h) - 16 / 9).abs() < 0.04;

/// The centred rectangle of a [srcW] x [srcH] frame that covers a
/// [dstW] x [dstH] output with no bars and no squash: [x, y, w, h] in source
/// pixels. A portrait frame gives the centred 16:9 band.
List<double> coverRect(int srcW, int srcH, int dstW, int dstH) {
  if (srcW <= 0 || srcH <= 0) return [0, 0, srcW.toDouble(), srcH.toDouble()];
  final srcAspect = srcW / srcH;
  final dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    final w = srcH * dstAspect;
    return [(srcW - w) / 2, 0, w, srcH.toDouble()];
  }
  final h = srcW / dstAspect;
  return [0, (srcH - h) / 2, srcW.toDouble(), h];
}

/// Canvas crop to a fixed 1280x720 at 30 fps: the output track keeps its size
/// when the source turns (landscape to portrait and back), so the stream and
/// the recording stay upright 16:9. Cost: one 720p `drawImage` per frame on
/// the GPU-backed canvas; frame callbacks stop in a hidden tab, as the camera
/// does on an iPad that locks its screen (the wake lock keeps it awake).
class CroppedCapture implements CaptureStream {
  CroppedCapture(this._inner) {
    final src = _inner.stream;
    _video = web.HTMLVideoElement()
      ..muted = true
      ..autoplay = true
      ..setAttribute('playsinline', '')
      ..srcObject = src;
    unawaited(_video.play().toDart.catchError((Object _) => null));
    _canvas = web.HTMLCanvasElement()
      ..width = 1280
      ..height = 720;
    _ctx = _canvas.getContext('2d')! as web.CanvasRenderingContext2D;
    final out = _canvas.captureStream(30);
    for (final a in src.getAudioTracks().toDart) {
      out.addTrack(a);
    }
    _out = out;
    _schedule();
  }

  final BrowserCapture _inner;
  late final web.HTMLVideoElement _video;
  late final web.HTMLCanvasElement _canvas;
  late final web.CanvasRenderingContext2D _ctx;
  late final web.MediaStream _out;
  bool _stopped = false;

  void _schedule() {
    if (_stopped) return;
    web.window.requestAnimationFrame(
      ((num _) {
        _draw();
        _schedule();
      }).toJS,
    );
  }

  void _draw() {
    final w = _video.videoWidth;
    final h = _video.videoHeight;
    if (w == 0 || h == 0 || _video.readyState < 2) return;
    final r = coverRect(w, h, 1280, 720);
    _ctx.drawImage(_video, r[0], r[1], r[2], r[3], 0, 0, 1280, 720);
  }

  @override
  JSObject? get native => _out;

  @override
  Stream<void> get ended => _inner.ended;

  @override
  bool get hasEnded => _inner.hasEnded;

  @override
  void setAudioEnabled(bool enabled) => _inner.setAudioEnabled(enabled);

  @override
  void stop() {
    _stopped = true;
    _video.srcObject = null;
    for (final t in _out.getVideoTracks().toDart) {
      t.stop();
    }
    _inner.stop();
  }
}

class BrowserCapture implements CaptureStream {
  BrowserCapture(this.stream) {
    // The picture decides; a microphone-only capture (external camera live)
    // is decided by its audio track.
    for (final t in _primary) {
      t.addEventListener(
        'ended',
        ((web.Event _) {
          _hasEnded = true;
          if (!_ended.isClosed) _ended.add(null);
        }).toJS,
      );
    }
  }

  List<web.MediaStreamTrack> get _primary {
    final v = stream.getVideoTracks().toDart;
    return v.isNotEmpty ? v : stream.getAudioTracks().toDart;
  }

  final web.MediaStream stream;
  final _ended = StreamController<void>.broadcast();
  bool _hasEnded = false;

  @override
  JSObject? get native => stream;

  @override
  Stream<void> get ended => _ended.stream;

  @override
  bool get hasEnded =>
      _hasEnded || _primary.every((t) => t.readyState == 'ended');

  @override
  void setAudioEnabled(bool enabled) {
    for (final t in stream.getAudioTracks().toDart) {
      t.enabled = enabled;
    }
  }

  @override
  void stop() {
    for (final t in stream.getTracks().toDart) {
      t.stop();
    }
  }
}

/// The box's combined stream, received by WHEP, as the source the recorder
/// is fed from (an external-camera live records what it receives).
class ReceivedCapture implements CaptureStream {
  ReceivedCapture(this.stream);

  final JSObject? stream;

  @override
  JSObject? get native => stream;

  @override
  Stream<void> get ended => const Stream<void>.empty();

  @override
  bool get hasEnded => false;

  @override
  void setAudioEnabled(bool enabled) {}

  /// The receiver owns the tracks; nothing to stop here.
  @override
  void stop() {}
}

/// WHEP receive-only link to the box: one video and one audio track, no ICE
/// servers (flat surau network), full gathering before the offer is read.
class RtcReceiverLink implements ReceiverLink {
  RtcReceiverLink({this.gatherCap = const Duration(seconds: 2)});

  final Duration gatherCap;
  web.RTCPeerConnection? _pc;
  final web.MediaStream _stream = web.MediaStream();
  final _states = StreamController<String>.broadcast();

  @override
  Stream<String> get connectionStates => _states.stream;

  @override
  JSObject? get stream => _stream;

  @override
  Future<String> createOffer() async {
    final pc = web.RTCPeerConnection(
      web.RTCConfiguration(iceServers: <web.RTCIceServer>[].toJS),
    );
    _pc = pc;
    pc.onconnectionstatechange = ((web.Event _) {
      if (!_states.isClosed) _states.add(pc.connectionState);
    }).toJS;
    pc.ontrack = ((web.RTCTrackEvent e) {
      _stream.addTrack(e.track);
    }).toJS;
    for (final kind in const ['video', 'audio']) {
      pc.addTransceiver(
        kind.toJS,
        web.RTCRtpTransceiverInit(direction: 'recvonly'),
      );
    }
    final offer = await pc.createOffer().toDart;
    if (offer == null) throw StateError('no offer');
    await pc
        .setLocalDescription(
          web.RTCLocalSessionDescriptionInit(type: 'offer', sdp: offer.sdp),
        )
        .toDart;
    final done = Completer<void>();
    pc.onicegatheringstatechange = ((web.Event _) {
      if (pc.iceGatheringState == 'complete' && !done.isCompleted) {
        done.complete();
      }
    }).toJS;
    if (pc.iceGatheringState != 'complete') {
      await done.future.timeout(gatherCap, onTimeout: () {});
    }
    final sdp = pc.localDescription?.sdp;
    if (sdp == null || sdp.isEmpty) throw StateError('no sdp');
    return sdp;
  }

  @override
  Future<void> applyAnswer(String sdp) async {
    await _pc!
        .setRemoteDescription(
          web.RTCSessionDescriptionInit(type: 'answer', sdp: sdp),
        )
        .toDart;
  }

  @override
  void close() {
    final pc = _pc;
    _pc = null;
    if (pc != null) {
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.close();
    }
    if (!_states.isClosed) _states.close();
  }
}

/// WebRTC to the box: no ICE servers (the surau network is flat), full
/// gathering before the offer is read.
class RtcPeerLink implements PeerLink {
  RtcPeerLink({this.gatherCap = const Duration(seconds: 2)});

  final Duration gatherCap;
  web.RTCPeerConnection? _pc;
  final _states = StreamController<String>.broadcast();
  int _lastBytes = 0;
  int _lastAt = 0;

  @override
  Stream<String> get connectionStates => _states.stream;

  @override
  Future<OfferResult> createOffer(
    CaptureStream s, {
    required int maxBitrateBps,
  }) async {
    final stream = s.native as web.MediaStream;
    final pc = web.RTCPeerConnection(
      web.RTCConfiguration(iceServers: <web.RTCIceServer>[].toJS),
    );
    _pc = pc;
    pc.onconnectionstatechange = ((web.Event _) {
      if (!_states.isClosed) _states.add(pc.connectionState);
    }).toJS;
    var h264 = false;
    final videoSenders = <web.RTCRtpSender>[];
    for (final track in stream.getTracks().toDart) {
      final isVideo = track.kind == 'video';
      web.RTCRtpTransceiver tr;
      try {
        final init = web.RTCRtpTransceiverInit(direction: 'sendonly');
        if (isVideo) {
          init.sendEncodings = [
            web.RTCRtpEncodingParameters(
              maxBitrate: maxBitrateBps,
              maxFramerate: 30,
            ),
          ].toJS;
        }
        tr = pc.addTransceiver(track, init);
      } catch (_) {
        tr = pc.addTransceiver(
          track,
          web.RTCRtpTransceiverInit(direction: 'sendonly'),
        );
      }
      if (isVideo) {
        videoSenders.add(tr.sender);
        h264 = _preferH264(tr);
      }
    }
    final offer = await pc.createOffer().toDart;
    if (offer == null) throw StateError('no offer');
    await pc
        .setLocalDescription(
          web.RTCLocalSessionDescriptionInit(type: 'offer', sdp: offer.sdp),
        )
        .toDart;
    for (final sender in videoSenders) {
      await _capBitrate(sender, maxBitrateBps);
    }
    await _gathered(pc);
    final sdp = pc.localDescription?.sdp;
    if (sdp == null || sdp.isEmpty) throw StateError('no sdp');
    return OfferResult(sdp, h264First: h264);
  }

  bool _preferH264(web.RTCRtpTransceiver tr) {
    try {
      final caps = web.RTCRtpSender.getCapabilities('video')?.codecs.toDart;
      if (caps == null || caps.isEmpty) return false;
      final order = codecOrder([
        for (final c in caps)
          (
            mime: c.mimeType,
            fmtp: (c as JSObject).has('sdpFmtpLine') ? c.sdpFmtpLine : '',
          ),
      ]);
      if (!order.hasH264) return false;
      tr.setCodecPreferences([for (final i in order.indexes) caps[i]].toJS);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _capBitrate(web.RTCRtpSender sender, int bps) async {
    try {
      final params = sender.getParameters();
      final enc = (params as JSObject)['encodings'];
      if (enc == null || enc.isUndefinedOrNull) return;
      final list = (enc as JSArray<JSObject>).toDart;
      if (list.isEmpty) return;
      list.first['maxBitrate'] = bps.toJS;
      list.first['maxFramerate'] = 30.toJS;
      await sender.setParameters(params).toDart;
    } catch (_) {
      // The sendEncodings of the offer already carried the cap.
    }
  }

  Future<void> _gathered(web.RTCPeerConnection pc) {
    final c = Completer<void>();
    pc.onicegatheringstatechange = ((web.Event _) {
      if (pc.iceGatheringState == 'complete' && !c.isCompleted) c.complete();
    }).toJS;
    if (pc.iceGatheringState == 'complete') return Future.value();
    return c.future.timeout(gatherCap, onTimeout: () {});
  }

  @override
  Future<void> applyAnswer(String sdp) async {
    await _pc!
        .setRemoteDescription(
          web.RTCSessionDescriptionInit(type: 'answer', sdp: sdp),
        )
        .toDart;
  }

  @override
  Future<PeerStats> stats() async {
    final pc = _pc;
    if (pc == null) return const PeerStats();
    final report = await pc.getStats().toDart;
    var bytes = 0;
    var fps = 0;
    double? rtt;
    var lost = 0;
    final each = ((JSAny? v, JSAny? k) {
      if (v == null || v.isUndefinedOrNull) return;
      final o = v as JSObject;
      final type = (o['type'] as JSString?)?.toDart;
      num? num_(String key) => (o[key] as JSNumber?)?.toDartDouble;
      if (type == 'outbound-rtp') {
        bytes += num_('bytesSent')?.toInt() ?? 0;
        if ((o['kind'] as JSString?)?.toDart == 'video') {
          fps = num_('framesPerSecond')?.round() ?? fps;
        }
      } else if (type == 'remote-inbound-rtp') {
        final r = num_('roundTripTime');
        if (r != null) rtt = r * 1000;
        lost += num_('packetsLost')?.toInt() ?? 0;
      } else if (type == 'candidate-pair' &&
          (o['state'] as JSString?)?.toDart == 'succeeded' &&
          rtt == null) {
        final r = num_('currentRoundTripTime');
        if (r != null) rtt = r * 1000;
      }
    }).toJS;
    (report as JSObject).callMethod('forEach'.toJS, each);
    final now = DateTime.now().millisecondsSinceEpoch;
    var kbps = 0;
    if (_lastAt > 0 && now > _lastAt && bytes >= _lastBytes) {
      kbps = ((bytes - _lastBytes) * 8 / (now - _lastAt)).round();
    }
    _lastBytes = bytes;
    _lastAt = now;
    return PeerStats(
      bitrateKbps: kbps,
      fps: fps,
      rttMs: rtt?.round(),
      lost: lost,
    );
  }

  @override
  Future<void> replaceTracks(CaptureStream s) async {
    final pc = _pc;
    final stream = s.native;
    if (pc == null || stream == null) return;
    final tracks = (stream as web.MediaStream).getTracks().toDart;
    for (final sender in pc.getSenders().toDart) {
      final kind = sender.track?.kind;
      for (final t in tracks) {
        if (t.kind == kind) await sender.replaceTrack(t).toDart;
      }
    }
  }

  @override
  void close() {
    final pc = _pc;
    _pc = null;
    if (pc != null) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    if (!_states.isClosed) _states.close();
  }
}

/// MP4 where the browser records it (Safari), else webm.
String? pickRecorderMime() {
  const candidates = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (final m in candidates) {
    try {
      if (web.MediaRecorder.isTypeSupported(m)) return m;
    } catch (_) {}
  }
  return null;
}

SegmentRecorder browserRecorder(CaptureStream s) {
  final mime = pickRecorderMime();
  if (mime == null) throw StateError('no recorder');
  return BrowserRecorder(s.native as web.MediaStream, mime);
}

class BrowserRecorder implements SegmentRecorder {
  BrowserRecorder(web.MediaStream stream, this.mime)
    : _rec = web.MediaRecorder(
        stream,
        web.MediaRecorderOptions(
          mimeType: mime,
          videoBitsPerSecond: 2500000,
          audioBitsPerSecond: 128000,
        ),
      );

  @override
  final String mime;
  final web.MediaRecorder _rec;
  final _stopped = Completer<void>();

  @override
  void start(
    void Function(Object chunk, int size) onChunk,
    void Function(String code) onError,
  ) {
    _rec.ondataavailable = ((web.BlobEvent e) {
      final b = e.data;
      if (b.size > 0) onChunk(b, b.size.toInt());
    }).toJS;
    _rec.onerror = ((web.Event _) => onError('recorder_error')).toJS;
    _rec.onstop = ((web.Event _) {
      if (!_stopped.isCompleted) _stopped.complete();
    }).toJS;
    _rec.start(5000);
  }

  @override
  Future<void> stop() async {
    if (_rec.state == 'inactive') return;
    _rec.stop();
    await _stopped.future.timeout(const Duration(seconds: 5), onTimeout: () {});
  }
}

Future<int?> browserFreeBytes() async {
  try {
    final e = await web.window.navigator.storage.estimate().toDart;
    final quota = e.quota;
    final usage = e.usage;
    return quota - usage;
  } catch (_) {
    return null;
  }
}

class BrowserPage implements PageEnv {
  BrowserPage() {
    _listener = ((web.Event _) {
      if (!_c.isClosed) _c.add(visible);
    }).toJS;
    web.document.addEventListener('visibilitychange', _listener);
  }

  late final JSFunction _listener;
  final _c = StreamController<bool>.broadcast();

  @override
  bool get visible => web.document.visibilityState == 'visible';

  @override
  Stream<bool> get visibility => _c.stream;

  @override
  Future<WakeHandle?> requestWakeLock() async {
    try {
      if (!(web.window.navigator as JSObject).has('wakeLock')) return null;
      final s = await web.window.navigator.wakeLock.request('screen').toDart;
      return _BrowserWake(s);
    } catch (_) {
      return null;
    }
  }

  @override
  void dispose() {
    web.document.removeEventListener('visibilitychange', _listener);
    _c.close();
  }
}

class _BrowserWake implements WakeHandle {
  _BrowserWake(this._s);
  final web.WakeLockSentinel _s;

  @override
  Future<void> release() async {
    try {
      await _s.release().toDart;
    } catch (_) {}
  }
}
