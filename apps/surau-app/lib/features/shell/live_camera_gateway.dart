// The external camera on the box (plan 4.2, 4.3) and the audio mix of a
// running live (4.2): the typed face of `/api/live/camera*` and
// `/api/live/audio`.
//
// The camera login never comes back whole: `GET /api/live/camera` answers
// the address with the password as dots plus `hasPassword`. Only
// [BoxGatewayLiveCamera.liveCameraSource] (`live:control`) returns the full
// address, for the phone that pulls the camera itself; it is held in
// memory by the caller and never written down here.

import 'dart:convert';

import '../../sync/camera_relay_seal.dart';
import 'box_gateway.dart';

/// The last "Uji sambungan" of the box, stored with the record.
class CameraTestOutcome {
  const CameraTestOutcome({
    required this.code,
    required this.ok,
    required this.hasAudio,
    required this.codecs,
    required this.transport,
    this.message,
    this.at,
    this.reason,
  });

  factory CameraTestOutcome.fromJson(Map<String, dynamic> j) => CameraTestOutcome(
    code: j['code'] is String ? j['code'] as String : 'unavailable',
    ok: j['ok'] == true,
    hasAudio: j['hasAudio'] is bool ? j['hasAudio'] as bool : null,
    codecs: [
      if (j['codecs'] is List)
        for (final c in j['codecs'] as List)
          if (c is String) c,
    ],
    transport: j['transport'] is String ? j['transport'] as String : null,
    message: j['message'] is String ? j['message'] as String : null,
    at: j['at'] is String ? j['at'] as String : null,
    reason: j['reason'] is String ? j['reason'] as String : null,
  );

  /// `ok`, `unreachable`, `login`, `path`, `codec`, `busy`, `not_configured`, `bad_address` or `unavailable`.
  final String code;

  /// Only with `bad_address`: the rule the address broke (`not_rtsp`, `not_ipv4`, ...); null from an older box.
  final String? reason;
  final bool ok;

  /// Null when the camera was not reached.
  final bool? hasAudio;

  /// MediaMTX track names seen: `H264`, `H265`, `MPEG-4 Audio`, `G711`.
  final List<String> codecs;

  /// `tcp` or `udp`: the one that delivered the picture.
  final String? transport;

  /// The box's own fixed wording of the result (BM).
  final String? message;
  final String? at;
}

/// Where a camera change sent through the cloud is sealed to: the box, its public key and the number the change takes.
class CameraRelayTarget {
  const CameraRelayTarget({required this.boxId, required this.key, required this.seq});

  static CameraRelayTarget? fromJson(Object? j) {
    if (j is! Map) return null;
    final key = j['key'];
    final seq = j['seq'];
    if (j['boxId'] is! String || key is! Map || seq is! int) return null;
    return CameraRelayTarget(boxId: j['boxId'] as String, key: key.cast<String, dynamic>(), seq: seq);
  }

  final String boxId;
  final Map<String, dynamic> key;
  final int seq;
}

/// What `GET /api/live/camera` and `PUT /api/live/camera` answer: masked.
///
/// Over the cloud the answer also says whether a change sent from here still waits for the box ([pending]), why the
/// box refused the last one ([failure], a short code) and who to seal the next one to ([relay]).
class LiveCameraRecord {
  const LiveCameraRecord({
    required this.configured,
    required this.url,
    required this.username,
    required this.hasPassword,
    required this.lastTest,
    this.pending = false,
    this.failure,
    this.relay,
    this.passwordNeeded = false,
  });

  factory LiveCameraRecord.fromJson(Map<String, dynamic> j) => LiveCameraRecord(
    configured: j['configured'] == true,
    url: j['url'] is String ? j['url'] as String : '',
    username: j['username'] is String ? j['username'] as String : null,
    hasPassword: j['hasPassword'] == true,
    lastTest: j['lastTest'] is Map ? CameraTestOutcome.fromJson((j['lastTest'] as Map).cast<String, dynamic>()) : null,
    pending: j['pending'] == true,
    failure: j['failure'] is String ? j['failure'] as String : null,
    relay: CameraRelayTarget.fromJson(j['relay']),
    passwordNeeded: j['passwordNeeded'] == true,
  );

  static const LiveCameraRecord none = LiveCameraRecord(
    configured: false,
    url: '',
    username: null,
    hasPassword: false,
    lastTest: null,
  );

  final bool configured;

  /// The address with the password replaced by dots.
  final String url;
  final String? username;
  final bool hasPassword;
  final CameraTestOutcome? lastTest;

  /// Cloud only: a change sent from here waits for the box (it applies it on its next check).
  final bool pending;

  /// Cloud only: the box refused the last change; `bad_address`, `bad_login`, `password_again`, `unreadable` or `error`.
  final String? failure;

  /// Cloud only: what the next change is sealed to; null when no box is linked to the cloud.
  final CameraRelayTarget? relay;

  /// The camera came back from the cloud backup, which never holds the password: it must be typed again here.
  final bool passwordNeeded;

  LiveCameraRecord withTest(CameraTestOutcome? t) => LiveCameraRecord(
    configured: configured,
    url: url,
    username: username,
    hasPassword: hasPassword,
    lastTest: t,
    pending: pending,
    failure: failure,
    relay: relay,
    passwordNeeded: passwordNeeded,
  );
}

/// One camera that answered the ONVIF probe (task O1): the name from its own scopes and its address.
class DiscoveredCamera {
  const DiscoveredCamera({required this.name, required this.ip});

  final String name;
  final String ip;
}

/// One entry of the audio mix: on or off, and a volume 0 to 100 in steps of 5.
class AudioSourceMix {
  const AudioSourceMix({required this.enabled, required this.volume});

  final bool enabled;
  final int volume;

  Map<String, Object?> toJson() => {'enabled': enabled, 'volume': volume};
}

/// `LiveAudioMix` of core: one entry per source.
class LiveAudioMix {
  const LiveAudioMix({required this.camera, required this.deviceMic, required this.boxInput});

  final AudioSourceMix camera;
  final AudioSourceMix deviceMic;
  final AudioSourceMix boxInput;

  Map<String, Object?> toJson() => {
    'camera': camera.toJson(),
    'deviceMic': deviceMic.toJson(),
    'boxInput': boxInput.toJson(),
  };
}

/// The camera and mix calls of the box. Every call is live-only (never
/// queued): the box answers, or the usual [BoxUnreachable] reaches the caller.
extension BoxGatewayLiveCamera on BoxGateway {
  static const String liveCameraPath = '/api/live/camera';
  static const String liveCameraTestPath = '/api/live/camera/test';
  static const String liveCameraSourcePath = '/api/live/camera/source';
  static const String liveCameraDiscoverPath = '/api/live/camera/discover';
  static const String liveCameraFillPath = '/api/live/camera/discover/fill';
  static const String liveAudioPath = '/api/live/audio';

  /// `GET /api/live/camera` (`live:settings`): the masked record.
  Future<LiveCameraRecord> liveCamera() async => LiveCameraRecord.fromJson(await getFresh(liveCameraPath));

  /// `PUT /api/live/camera`. [password] left null keeps the stored one; an address that still holds the dots keeps it
  /// too. The answer is the masked record: the password is not in it.
  Future<LiveCameraRecord> saveLiveCamera({required String url, String? username, String? password}) async {
    final out = await put(liveCameraPath, {
      'url': url,
      'username': ?username,
      'password': ?password,
    });
    return LiveCameraRecord.fromJson(out);
  }

  /// `PUT /api/live/camera` over the cloud: the address and login are sealed to the BOX's key here, so the cloud only
  /// relays a value it cannot open. [url] may hold the dots in place of the password and [password] left null keeps the
  /// stored one (the box decides, as on its own form). The answer is the masked record with `pending: true` until the
  /// box has applied it. A 409 `stale` means another change got in first: read again ([liveCamera]) and send again.
  Future<LiveCameraRecord> saveLiveCameraViaCloud({
    required CameraRelayTarget relay,
    required String url,
    String? username,
    String? password,
  }) async {
    final plain = jsonEncode({
      'seq': relay.seq,
      'boxId': relay.boxId,
      'url': url,
      'username': ?username,
      'password': ?password,
    });
    final sealed = sealCameraRelay(
      boxPublicJwk: relay.key,
      plaintext: plain,
      aad: cameraRelayAad(relay.boxId, relay.seq),
    );
    final out = await put(liveCameraPath, {'boxId': relay.boxId, 'seq': relay.seq, 'sealed': sealed});
    return LiveCameraRecord.fromJson(out);
  }

  /// `DELETE /api/live/camera`: "Padam tetapan kamera" (box and cloud).
  Future<void> clearLiveCamera() => delete(liveCameraPath);

  /// `POST /api/live/camera/test` (`live:settings`): the box tries the saved address. [transport] is `auto`, `tcp`
  /// or `udp`; null lets the box use the setting. Refused with a [BoxError] `live_busy` while a live runs and
  /// `too_many` after six a minute.
  Future<CameraTestOutcome> testLiveCamera({String? transport}) async =>
      CameraTestOutcome.fromJson(await post(liveCameraTestPath, {'transport': ?transport}));

  /// `POST /api/live/camera/discover` (`live:settings`): the box probes its network for ONVIF cameras and answers
  /// name + address of each. An empty list is a normal answer. Refused with `too_many` after six a minute.
  Future<List<DiscoveredCamera>> discoverLiveCameras() async {
    final out = await post(liveCameraDiscoverPath, const {});
    final list = out['cameras'];
    return [
      if (list is List)
        for (final c in list)
          if (c is Map && c['ip'] is String)
            DiscoveredCamera(name: c['name'] is String ? c['name'] as String : '', ip: c['ip'] as String),
    ];
  }

  /// `POST /api/live/camera/discover/fill` (`live:settings`): the box asks the camera at [ip] for its RTSP address and
  /// answers it with the login merged in. The caller puts it in the form and saves it through [saveLiveCamera]; it is
  /// never kept here. Refused with a [BoxError] whose `code` is `login`, `not_onvif`, `no_stream`, `unreachable`,
  /// `bad_address` or `too_many`, and whose message is the box's own fixed BM wording.
  Future<String> fillDiscoveredCamera({required String ip, String username = '', String password = ''}) async {
    final out = await post(liveCameraFillPath, {'ip': ip, 'username': username, 'password': password});
    final url = out['url'];
    return url is String ? url : '';
  }

  /// `GET /api/live/camera/source` (`live:control`): the full address, for the phone that pulls the camera. Keep it in
  /// memory only.
  Future<String> liveCameraSource() async {
    final out = await getFresh(liveCameraSourcePath);
    final url = out['url'];
    return url is String ? url : '';
  }

  /// `POST /api/live/audio` (`live:control`, the starting device only): the mix of a box-combined live.
  ///
  /// [video] (`phone` or `external`) switches the picture of a live the box
  /// pulls; [avOffsetMs] (0 to 2000, steps of 50) is the hand-set delay of the
  /// iPad microphone. Both are left out of the body when null.
  Future<void> changeLiveAudio(
    LiveAudioMix mix, {
    String? video,
    int? avOffsetMs,
  }) async {
    await post(liveAudioPath, {
      'audio': mix.toJson(),
      'video': ?video,
      'avOffsetMs': ?avOffsetMs,
    });
  }
}
