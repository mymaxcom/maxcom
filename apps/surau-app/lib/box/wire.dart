/// DTOs copied from the box's JSON shapes (apps/box-server). Parsing is lenient
/// about extra fields and strict about the fields the app relies on.
library;

List<String> _strings(Object? v) =>
    v is List ? v.map((e) => e.toString()).toList(growable: false) : const [];

class UserDto {
  const UserDto({
    required this.id,
    required this.name,
    required this.roles,
    required this.active,
    required this.pinRequired,
    this.pinLockedUntil,
  });

  factory UserDto.fromJson(Map<String, dynamic> j) => UserDto(
        id: j['id'] as String,
        name: j['name'] as String,
        roles: _strings(j['roles']),
        active: j['active'] == true,
        pinRequired: j['pinRequired'] == true,
        pinLockedUntil: j['pinLockedUntil'] as String?,
      );

  final String id;
  final String name;
  final List<String> roles;
  final bool active;
  final bool pinRequired;
  final String? pinLockedUntil;
}

class DeviceDto {
  const DeviceDto({
    required this.id,
    required this.userId,
    required this.name,
    required this.platform,
    required this.revoked,
  });

  factory DeviceDto.fromJson(Map<String, dynamic> j) => DeviceDto(
        id: j['id'] as String,
        userId: j['userId'] as String,
        name: j['name'] as String,
        platform: j['platform'] as String,
        revoked: j['revoked'] == true,
      );

  final String id;
  final String userId;
  final String name;
  final String platform;
  final bool revoked;
}

class SessionUser {
  const SessionUser({
    required this.id,
    required this.name,
    required this.roles,
  });

  factory SessionUser.fromJson(Map<String, dynamic> j) => SessionUser(
        id: j['id'] as String,
        name: j['name'] as String,
        roles: _strings(j['roles']),
      );

  final String id;
  final String name;
  final List<String> roles;
}

class SessionDto {
  const SessionDto({
    required this.token,
    required this.expiresAt,
    required this.user,
    this.via = viaBox,
    this.base,
  });

  factory SessionDto.fromJson(Map<String, dynamic> j) => SessionDto(
        token: j['token'] as String,
        expiresAt: j['expiresAt'] as String,
        user: SessionUser.fromJson(j['user'] as Map<String, dynamic>),
      );

  /// The app's offline session: who was last signed in on this phone, from
  /// the sealed local profile. It carries no token (the servers re-check
  /// every queued operation when it is pushed); the roles only drive the UI.
  factory SessionDto.offline(SessionUser user) => SessionDto(
        token: '',
        expiresAt: '',
        user: user,
        via: viaOffline,
      );

  static const String viaBox = 'box';
  static const String viaCloud = 'cloud';
  static const String viaOffline = 'offline';

  final String token;
  final String expiresAt;
  final SessionUser user;

  /// Which base issued [token]: [viaBox], [viaCloud], or [viaOffline] for the
  /// token-less offline session.
  final String via;

  /// The origin that issued [token]; null for the enrolled box address.
  final Uri? base;

  bool get offline => via == viaOffline;

  /// The same session, marked as issued by [at] ([viaBox] or [viaCloud]).
  SessionDto issuedBy(Uri at, String by) => SessionDto(
        token: token,
        expiresAt: expiresAt,
        user: user,
        via: by,
        base: at,
      );
}

typedef UnlockResult = SessionDto;

class TlsInfo {
  const TlsInfo({
    required this.mode,
    required this.notAfter,
    required this.daysLeft,
    required this.ipSan,
  });

  factory TlsInfo.fromJson(Map<String, dynamic> j) => TlsInfo(
        mode: j['mode'] as String,
        notAfter: j['notAfter'] as String,
        daysLeft: (j['daysLeft'] as num).toInt(),
        ipSan: _strings(j['ipSan']),
      );

  final String mode;
  final String notAfter;
  final int daysLeft;
  final List<String> ipSan;
}

/// The box's own daily e-Solat top-up, as `GET /api/health` reports it
/// (admin answers only). [lastOk] is null before the first attempt.
class AutoFetchDto {
  const AutoFetchDto({required this.enabled, this.lastAttemptAt, this.lastOk, this.lastError});

  factory AutoFetchDto.fromJson(Map<String, dynamic> j) => AutoFetchDto(
        enabled: j['enabled'] == true,
        lastAttemptAt: j['lastAttemptAt'] as String?,
        lastOk: j['lastOk'] as bool?,
        lastError: j['lastError'] as String?,
      );

  final bool enabled;
  final String? lastAttemptAt;
  final bool? lastOk;
  final String? lastError;
}

/// `GET /api/health`. Anonymous callers only get `ok` and `version`.
class HealthDto {
  const HealthDto({
    required this.ok,
    required this.version,
    this.tls,
    this.users,
    this.devices,
    this.lockedUsers,
    this.daysAhead,
    this.autoFetch,
    this.assetsBytes,
    this.appLock,
    this.cloud,
  });

  factory HealthDto.fromJson(Map<String, dynamic> j) {
    final tls = j['tls'];
    return HealthDto(
      ok: j['ok'] == true,
      version: (j['version'] as num).toInt(),
      tls: tls is Map<String, dynamic> ? TlsInfo.fromJson(tls) : null,
      users: (j['users'] as num?)?.toInt(),
      devices: (j['devices'] as num?)?.toInt(),
      lockedUsers: (j['lockedUsers'] as num?)?.toInt(),
      daysAhead: (j['daysAhead'] as num?)?.toInt(),
      autoFetch: j['autoFetch'] is Map<String, dynamic>
          ? AutoFetchDto.fromJson(j['autoFetch'] as Map<String, dynamic>)
          : null,
      assetsBytes: (j['assetsBytes'] as num?)?.toInt(),
      appLock: j['appLock'] is bool ? j['appLock'] as bool : null,
      cloud: j['cloud'] is String ? j['cloud'] as String : null,
    );
  }

  final bool ok;
  final int version;
  final TlsInfo? tls;
  final int? users;
  final int? devices;
  final int? lockedUsers;
  final int? daysAhead;
  final AutoFetchDto? autoFetch;
  final int? assetsBytes;

  /// Whether the app lock is on (admin answer only); null when unknown.
  final bool? appLock;

  /// The https origin of the MAXCOM cloud the box is linked to; null when
  /// the box has none (or is older).
  final String? cloud;
}

class AuditEntry {
  const AuditEntry({
    required this.id,
    required this.at,
    required this.actor,
    required this.entity,
    this.userName,
    this.deviceId,
    this.entityId,
    this.before,
    this.after,
  });

  factory AuditEntry.fromJson(Map<String, dynamic> j) => AuditEntry(
        id: (j['id'] as num).toInt(),
        at: j['at'] as String,
        actor: j['actor'] as String,
        userName: j['userName'] as String?,
        deviceId: j['deviceId'] as String?,
        entity: j['entity'] as String,
        entityId: j['entityId'] as String?,
        before: j['before'],
        after: j['after'],
      );

  final int id;
  final String at;
  final String actor;
  final String? userName;
  final String? deviceId;
  final String entity;
  final String? entityId;
  final Object? before;
  final Object? after;
}

class AssetMeta {
  const AssetMeta({
    required this.id,
    required this.mime,
    required this.bytes,
    this.width,
    this.height,
  });

  factory AssetMeta.fromJson(Map<String, dynamic> j) => AssetMeta(
        id: j['id'] as String,
        mime: j['mime'] as String,
        bytes: (j['bytes'] as num).toInt(),
        width: (j['width'] as num?)?.toInt(),
        height: (j['height'] as num?)?.toInt(),
      );

  final String id;
  final String mime;
  final int bytes;
  final int? width;
  final int? height;
}

/// A normalised box (0..1 of the picture): top-left corner and size.
class ImageBox {
  const ImageBox({required this.x, required this.y, required this.w, required this.h});

  factory ImageBox.fromJson(Map<String, dynamic> j) => ImageBox(
        x: (j['x'] as num).toDouble(),
        y: (j['y'] as num).toDouble(),
        w: (j['w'] as num).toDouble(),
        h: (j['h'] as num).toDouble(),
      );

  Map<String, dynamic> toJson() => {'x': x, 'y': y, 'w': w, 'h': h};

  final double x;
  final double y;
  final double w;
  final double h;
}

/// `GET /api/assets/<id>/analyze`: what the adjust screen starts from.
class ImageAnalysis {
  const ImageAnalysis({
    required this.width,
    required this.height,
    required this.trim,
    required this.plainBackground,
    required this.backgroundColour,
    required this.backgroundConfidence,
    required this.transparent,
    required this.suggested,
  });

  factory ImageAnalysis.fromJson(Map<String, dynamic> j) {
    final bg = j['background'] as Map<String, dynamic>;
    return ImageAnalysis(
      width: (j['width'] as num).toInt(),
      height: (j['height'] as num).toInt(),
      trim: ImageBox.fromJson(j['trim'] as Map<String, dynamic>),
      plainBackground: bg['plain'] == true,
      backgroundColour: bg['colour'] as String?,
      backgroundConfidence: (bg['confidence'] as num).toDouble(),
      transparent: bg['transparent'] == true,
      suggested: bg['suggested'] == 'remove' ? 'remove' : 'keep',
    );
  }

  final int width;
  final int height;

  /// The tight box around the content (the empty margin cut off).
  final ImageBox trim;

  /// The corners and most of the border are one plain colour.
  final bool plainBackground;

  /// `#rrggbb` of that colour, or null.
  final String? backgroundColour;
  final double backgroundConfidence;

  /// The picture already has a transparent background.
  final bool transparent;

  /// `remove` (offer "Buang latar putih" first) or `keep`.
  final String suggested;
}

class EnrolResult {
  const EnrolResult({
    required this.deviceId,
    required this.userId,
    required this.roles,
    required this.pinRequired,
    this.appLock,
  });

  factory EnrolResult.fromJson(Map<String, dynamic> j) => EnrolResult(
        deviceId: j['deviceId'] as String,
        userId: j['userId'] as String,
        roles: _strings(j['roles']),
        pinRequired: j['pinRequired'] == true,
        appLock: j['appLock'] is bool ? j['appLock'] as bool : null,
      );

  final String deviceId;
  final String userId;
  final List<String> roles;
  final bool pinRequired;

  /// The box's app lock at enrolment; null from an older box.
  final bool? appLock;
}

class Challenge {
  const Challenge({
    required this.nonce,
    required this.expiresAt,
    this.appLock,
  });

  factory Challenge.fromJson(Map<String, dynamic> j) => Challenge(
        nonce: j['nonce'] as String,
        expiresAt: j['expiresAt'] as String,
        appLock: j['appLock'] is bool ? j['appLock'] as bool : null,
      );

  final String nonce;
  final String expiresAt;

  /// The box's app lock right now; null from an older box.
  final bool? appLock;
}

// ---- live (Plan 5): shapes of /api/live/* and /api/kiosk/live ----

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : const <String, dynamic>{};

/// The SRT target of the start answer. The passphrase and the stream id
/// (which holds the per-session credential) are secrets: held in memory
/// for one session, never printed.
class LiveSrtTarget {
  const LiveSrtTarget({
    required this.host,
    required this.port,
    required this.streamId,
    required this.passphrase,
  });

  final String host;
  final int port;
  final String streamId;
  final String passphrase;

  /// `srt://host:port?streamid=...&passphrase=...` (query values encoded).
  String get url => Uri(
        scheme: 'srt',
        host: host,
        port: port,
        queryParameters: {'streamid': streamId, 'passphrase': passphrase},
      ).toString();

  @override
  String toString() => 'LiveSrtTarget($host:$port)';
}

/// The YouTube leg of the start answer. `via` is `device` (the phone pushes
/// RTMPS with [key]) or `box` (the box relays; no key reaches the app).
class LiveYoutubeTarget {
  const LiveYoutubeTarget({
    required this.via,
    this.ingest,
    this.key,
    this.starting = false,
  });

  final String via;
  final String? ingest;
  final String? key;

  /// The box is still making the broadcast (`state: starting`): the key
  /// comes later from `GET /api/live/youtube/ingest`.
  final bool starting;

  @override
  String toString() => 'LiveYoutubeTarget($via)';
}

/// `GET /api/live/youtube/ingest`: `state` is `none|starting|ready|failed`;
/// [ingest] and [key] are set only when ready. Never printed.
class LiveYoutubeIngest {
  const LiveYoutubeIngest({required this.state, this.ingest, this.key});

  factory LiveYoutubeIngest.fromJson(Map<String, dynamic> j) =>
      LiveYoutubeIngest(
        state: _str(j['state']) ?? 'none',
        ingest: _str(j['ingest']),
        key: _str(j['key']),
      );

  final String state;
  final String? ingest;
  final String? key;

  @override
  String toString() => 'LiveYoutubeIngest($state)';
}

/// `POST /api/live/start` answer. Carries the credentials once.
class LiveStartResult {
  const LiveStartResult({
    required this.sessionId,
    required this.whip,
    this.srt,
    this.youtube,
    this.warnings = const [],
  });

  factory LiveStartResult.fromJson(Map<String, dynamic> j) {
    final ingest = _map(j['ingest']);
    final srt = _map(ingest['srt']);
    final yt = _map(j['youtube']);
    return LiveStartResult(
      sessionId: _str(_map(j['session'])['id']) ?? '',
      whip: _str(ingest['whip']) ?? '/api/live/whip',
      srt: srt['host'] is String && srt['port'] is int
          ? LiveSrtTarget(
              host: srt['host'] as String,
              port: srt['port'] as int,
              streamId: (srt['streamId'] as String?) ?? '',
              passphrase: (srt['passphrase'] as String?) ?? '',
            )
          : null,
      youtube: yt['via'] is String
          ? LiveYoutubeTarget(
              via: yt['via'] as String,
              ingest: _str(yt['ingest']),
              key: _str(yt['key']),
              starting: yt['state'] == 'starting',
            )
          : null,
      warnings: _strings(j['warnings']),
    );
  }

  final String sessionId;
  final String whip;
  final LiveSrtTarget? srt;
  final LiveYoutubeTarget? youtube;
  final List<String> warnings;

  @override
  String toString() => 'LiveStartResult($sessionId)';
}

/// `GET /api/live/status`.
class LiveStatusDto {
  const LiveStatusDto({
    this.sessionId,
    this.startedBy,
    this.ingestReady = false,
    this.relayState = 'off',
    this.youtubeSignedIn = false,
    this.channelTitle,
    this.youtubeState = 'none',
    this.youtubeHealth,
    this.watchUrl,
    this.youtubeError,
    this.warnings = const [],
  });

  factory LiveStatusDto.fromJson(Map<String, dynamic> j) {
    final s = _map(j['session']);
    final yt = _map(j['youtube']);
    return LiveStatusDto(
      sessionId: _str(s['id']),
      startedBy: _str(s['startedBy']),
      ingestReady: _map(j['ingest'])['ready'] == true,
      relayState: _str(_map(j['relay'])['state']) ?? 'off',
      youtubeSignedIn: yt['signedIn'] == true,
      channelTitle: _str(yt['channelTitle']),
      youtubeState: _str(yt['state']) ?? 'none',
      youtubeHealth: _str(yt['health']),
      watchUrl: _str(yt['watchUrl']),
      youtubeError: _str(yt['lastError']),
      warnings: _strings(j['warnings']),
    );
  }

  final String? sessionId;
  final String? startedBy;
  final bool ingestReady;

  /// Standing warning codes: `media_ports_blocked`, `no_video_from_device`.
  final List<String> warnings;

  /// `off|starting|running|retrying|failed` (the box relay).
  final String relayState;
  final bool youtubeSignedIn;
  final String? channelTitle;

  /// `none|created|testing|live|complete|error`.
  final String youtubeState;

  /// `noData|bad|ok|good`, null until YouTube reports.
  final String? youtubeHealth;
  final String? watchUrl;
  final String? youtubeError;

  /// YouTube is receiving the picture now.
  bool get youtubeReceiving => youtubeHealth != null && youtubeState == 'live';
}

/// `GET /api/kiosk/live`.
class KioskLiveDto {
  const KioskLiveDto({required this.live, this.since});

  factory KioskLiveDto.fromJson(Map<String, dynamic> j) =>
      KioskLiveDto(live: j['live'] == true, since: _str(j['since']));

  final bool live;
  final String? since;
}

/// `GET /api/live/youtube/status`.
class YoutubeStatusDto {
  const YoutubeStatusDto({
    required this.configured,
    required this.signedIn,
    this.channelTitle,
    this.lastError,
  });

  factory YoutubeStatusDto.fromJson(Map<String, dynamic> j) => YoutubeStatusDto(
        configured: j['configured'] == true,
        signedIn: j['signedIn'] == true,
        channelTitle: _str(j['channelTitle']),
        lastError: _str(j['lastError']),
      );

  final bool configured;
  final bool signedIn;
  final String? channelTitle;
  final String? lastError;
}

/// `POST /api/live/youtube/signin`: the code to type at Google.
class YoutubeSignInDto {
  const YoutubeSignInDto({
    required this.userCode,
    required this.verificationUrl,
    required this.interval,
  });

  factory YoutubeSignInDto.fromJson(Map<String, dynamic> j) => YoutubeSignInDto(
        userCode: (j['userCode'] as String?) ?? '',
        verificationUrl: (j['verificationUrl'] as String?) ?? '',
        interval: j['interval'] is num ? (j['interval'] as num).toInt() : 5,
      );

  final String userCode;
  final String verificationUrl;

  /// Seconds between polls.
  final int interval;
}

/// `POST /api/live/youtube/signin/poll`.
class YoutubeSignInPoll {
  const YoutubeSignInPoll({
    required this.state,
    required this.signedIn,
    this.channelTitle,
    this.interval,
  });

  factory YoutubeSignInPoll.fromJson(Map<String, dynamic> j) =>
      YoutubeSignInPoll(
        state: (j['state'] as String?) ?? 'error',
        signedIn: j['signedIn'] == true,
        channelTitle: _str(j['channelTitle']),
        interval: j['interval'] is num ? (j['interval'] as num).toInt() : null,
      );

  /// `none|pending|signed_in|denied|expired|error`.
  final String state;
  final bool signedIn;
  final String? channelTitle;
  final int? interval;
}
