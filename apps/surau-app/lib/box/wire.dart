/// DTOs copied from the box's JSON shapes (apps/box-server). Parsing is lenient
/// about extra fields and strict about the fields the app relies on.
library;

import '../features/people/ref.dart' show refOf;

List<String> _strings(Object? v) =>
    v is List ? v.map((e) => e.toString()).toList(growable: false) : const [];

/// An ISO instant as a [DateTime], or null when absent or unreadable.
DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

int _int(Object? v, [int fallback = 0]) => v is num ? v.toInt() : fallback;

class UserDto {
  const UserDto({
    required this.id,
    required this.name,
    required this.roles,
    required this.active,
    required this.pinRequired,
    this.pinLockedUntil,
    this.createdAt,
    this.ref,
    this.phone,
    this.deleted = false,
    this.deletedAt,
    this.deletedBy,
    this.deactivatedAt,
  });

  factory UserDto.fromJson(Map<String, dynamic> j) => UserDto(
        id: j['id'] as String,
        name: j['name'] as String,
        roles: _strings(j['roles']),
        active: j['active'] == true,
        pinRequired: j['pinRequired'] == true,
        pinLockedUntil: j['pinLockedUntil'] as String?,
        createdAt: _date(j['createdAt']),
        ref: refOf(
          ref: j['ref'] is String ? j['ref'] as String : null,
          kind: 'user',
          no: j['no'] is num ? (j['no'] as num).toInt() : null,
          noSrc: j['noSrc'] is String ? j['noSrc'] as String : null,
        ),
        phone: j['phone'] is String ? j['phone'] as String : null,
        deleted: j['deleted'] == true,
        deletedAt: _date(j['deletedAt']),
        deletedBy: j['deletedBy'] is String ? j['deletedBy'] as String : null,
        deactivatedAt: _date(j['deactivatedAt']),
      );

  final String id;
  final String name;
  final List<String> roles;
  final bool active;
  final bool pinRequired;
  final String? pinLockedUntil;

  /// When the person was added.
  final DateTime? createdAt;

  /// The ID (`U-0001`) as the server stored it; null while it has none.
  final String? ref;

  /// E.164. Personal data: only a Pentadbir's list and the person's own
  /// answers carry it; never shown in a list row, never logged.
  final String? phone;

  /// Soft deleted (seen from the feed copy or an ops view; a surau's list
  /// never serves such a person).
  final bool deleted;
  final DateTime? deletedAt;
  final String? deletedBy;

  /// When the person was deactivated (server instant); null while active or
  /// from an older box.
  final DateTime? deactivatedAt;
}

class DeviceDto {
  const DeviceDto({
    required this.id,
    required this.userId,
    required this.name,
    required this.platform,
    required this.revoked,
    this.enrolledAt,
    this.ref,
  });

  factory DeviceDto.fromJson(Map<String, dynamic> j) => DeviceDto(
        id: j['id'] as String,
        userId: j['userId'] as String,
        name: j['name'] as String,
        platform: j['platform'] as String,
        revoked: j['revoked'] == true,
        enrolledAt: _date(j['enrolledAt']),
        ref: refOf(
          ref: j['ref'] is String ? j['ref'] as String : null,
          kind: 'device',
          no: j['no'] is num ? (j['no'] as num).toInt() : null,
          noSrc: j['noSrc'] is String ? j['noSrc'] as String : null,
        ),
      );

  final String id;
  final String userId;
  final String name;
  final String platform;
  final bool revoked;

  /// When the device was enrolled.
  final DateTime? enrolledAt;

  /// The ID (`D-0001`); null while it has none.
  final String? ref;
}

// ---- GET /api/people/activity (server task S6) ----

/// One phone, tablet, computer or TV screen in the activity answer. The day
/// count and the flag are the server's, computed from the server's clock.
class DeviceActivityDto {
  const DeviceActivityDto({
    required this.id,
    required this.userId,
    required this.kind,
    required this.idleDays,
    required this.inactive,
    this.ref,
    this.enrolledAt,
    this.lastSeenAt,
  });

  factory DeviceActivityDto.fromJson(Map<String, dynamic> j) => DeviceActivityDto(
        id: j['id'] as String,
        userId: j['userId'] as String,
        kind: j['kind'] == 'tv' ? 'tv' : 'device',
        idleDays: _int(j['idleDays']),
        inactive: j['inactive'] == true,
        ref: j['ref'] is String ? j['ref'] as String : null,
        enrolledAt: _date(j['enrolledAt']),
        lastSeenAt: _date(j['lastSeenAt']),
      );

  final String id;
  final String? ref;
  final String userId;

  /// `device` (phone, tablet, computer) or `tv` (a paired TV screen).
  final String kind;
  final DateTime? enrolledAt;
  final DateTime? lastSeenAt;

  /// Whole days unused, by the server's clock.
  final int idleDays;

  /// "Tidak aktif": 60 days for a device, 30 for a TV screen.
  final bool inactive;

  bool get isTv => kind == 'tv';
}

/// One active person in the activity answer.
class UserActivityDto {
  const UserActivityDto({
    required this.id,
    required this.deviceCount,
    required this.locked,
    required this.needs,
    required this.suggestDeactivate,
    this.ref,
    this.createdAt,
    this.createdByName,
    this.createdByRef,
    this.lastActiveAt,
    this.pinLockedUntil,
  });

  factory UserActivityDto.fromJson(Map<String, dynamic> j) => UserActivityDto(
        id: j['id'] as String,
        deviceCount: _int(j['deviceCount']),
        locked: j['locked'] == true,
        needs: _strings(j['needs']),
        suggestDeactivate: j['suggestDeactivate'] == true,
        ref: j['ref'] is String ? j['ref'] as String : null,
        createdAt: _date(j['createdAt']),
        createdByName: j['createdByName'] is String ? j['createdByName'] as String : null,
        createdByRef: j['createdByRef'] is String ? j['createdByRef'] as String : null,
        lastActiveAt: _date(j['lastActiveAt']),
        pinLockedUntil: _date(j['pinLockedUntil']),
      );

  final String id;
  final String? ref;
  final DateTime? createdAt;
  final String? createdByName;

  /// The adder's ID (`U-0001`) as the server stored it; null for the system.
  final String? createdByRef;
  final int deviceCount;

  /// The latest `lastSeenAt` of the person's phones; null when none was seen.
  final DateTime? lastActiveAt;
  final bool locked;
  final DateTime? pinLockedUntil;

  /// What needs doing, from the server: `locked`, `no_device`, `phone`,
  /// `phone_duplicate`.
  final List<String> needs;

  /// Every phone unused for 90 days: "Nyahaktifkan?" (a suggestion only).
  final bool suggestDeactivate;

  bool get needsLocked => needs.contains('locked');
  bool get needsNoDevice => needs.contains('no_device');
  bool get needsPhone => needs.contains('phone');
  bool get needsPhoneDuplicate => needs.contains('phone_duplicate');
}

class PeopleActivityDto {
  const PeopleActivityDto({
    required this.now,
    required this.authorityIsBox,
    required this.devices,
    required this.users,
    this.deviceDays = 60,
    this.tvDays = 30,
    this.noDeviceDays = 3,
    this.userDays = 90,
    this.deactivatedDays = 365,
    this.noAdminPhone = false,
  });

  factory PeopleActivityDto.fromJson(Map<String, dynamic> j) {
    final limits = j['limits'] is Map ? Map<String, dynamic>.from(j['limits'] as Map) : const <String, dynamic>{};
    final now = _date(j['now']);
    if (now == null) throw const FormatException('now');
    return PeopleActivityDto(
      now: now,
      authorityIsBox: j['authority'] == 'box',
      noAdminPhone: j['noAdminPhone'] == true,
      deviceDays: _int(limits['deviceDays'], 60),
      tvDays: _int(limits['tvDays'], 30),
      noDeviceDays: _int(limits['noDeviceDays'], 3),
      userDays: _int(limits['userDays'], 90),
      deactivatedDays: _int(limits['deactivatedDays'], 365),
      devices: [
        for (final d in (j['devices'] as List? ?? const []))
          if (d is Map<String, dynamic>) DeviceActivityDto.fromJson(d),
      ],
      users: [
        for (final u in (j['users'] as List? ?? const []))
          if (u is Map<String, dynamic>) UserActivityDto.fromJson(u),
      ],
    );
  }

  /// The SERVER's time of the answer. Every day count on screen comes from
  /// here or from the server's own `idleDays`, never from the phone's clock.
  final DateTime now;

  /// True when the box itself answered; false from the cloud, which cannot
  /// see unlocks made on the surau Wi-Fi (the screens then show no flags).
  final bool authorityIsBox;

  /// True when no active Pentadbir of the surau has a phone that is still
  /// enrolled (the box flags it; shown under "Perlu tindakan").
  final bool noAdminPhone;
  final int deviceDays;
  final int tvDays;
  final int noDeviceDays;
  final int userDays;

  /// Days a person stays deactivated before the box deletes them by itself.
  final int deactivatedDays;
  final List<DeviceActivityDto> devices;
  final List<UserActivityDto> users;

  DeviceActivityDto? deviceOf(String id) {
    for (final d in devices) {
      if (d.id == id) return d;
    }
    return null;
  }

  UserActivityDto? userOf(String id) {
    for (final u in users) {
      if (u.id == id) return u;
    }
    return null;
  }

  /// Whole days from [u]'s last use to the server's [now]; null when never seen.
  int? lastActiveDays(UserActivityDto u) {
    final at = u.lastActiveAt;
    if (at == null) return null;
    final days = now.difference(at).inDays;
    return days < 0 ? 0 : days;
  }
}

// ---- enrolment codes (server tasks S2 and S5) ----

/// One code that is still open (`GET /api/enrol/open`).
class OpenCodeDto {
  const OpenCodeDto({
    required this.id,
    required this.userId,
    required this.userName,
    required this.deviceName,
    required this.expiresAt,
    required this.createdByName,
    this.userRef,
  });

  factory OpenCodeDto.fromJson(Map<String, dynamic> j) => OpenCodeDto(
        id: _int(j['id']),
        userId: j['userId'] as String,
        userRef: j['userRef'] is String ? j['userRef'] as String : null,
        userName: j['userName'] is String ? j['userName'] as String : '',
        deviceName: j['deviceName'] is String ? j['deviceName'] as String : '',
        expiresAt: _date(j['expiresAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        createdByName: j['createdByName'] is String ? j['createdByName'] as String : '',
      );

  final int id;
  final String userId;
  final String? userRef;
  final String userName;
  final String deviceName;
  final DateTime expiresAt;
  final String createdByName;
}

/// The device that used a code.
class EnrolledDeviceDto {
  const EnrolledDeviceDto({
    required this.id,
    required this.name,
    required this.platform,
    this.enrolledAt,
    this.ref,
  });

  factory EnrolledDeviceDto.fromJson(Map<String, dynamic> j) => EnrolledDeviceDto(
        id: j['id'] as String,
        name: j['name'] is String ? j['name'] as String : '',
        platform: j['platform'] is String ? j['platform'] as String : '',
        enrolledAt: _date(j['enrolledAt']),
        ref: j['ref'] is String ? j['ref'] as String : null,
      );

  final String id;
  final String name;
  final String platform;
  final DateTime? enrolledAt;
  final String? ref;
}

/// One of the caller's own codes of the last 24 hours (`GET /api/enrol/recent`).
class RecentCodeDto {
  const RecentCodeDto({
    required this.id,
    required this.userId,
    required this.userName,
    required this.deviceName,
    required this.expiresAt,
    required this.reuseAttempts,
    this.userRef,
    this.usedAt,
    this.cancelledAt,
    this.device,
  });

  factory RecentCodeDto.fromJson(Map<String, dynamic> j) => RecentCodeDto(
        id: _int(j['id']),
        userId: j['userId'] as String,
        userRef: j['userRef'] is String ? j['userRef'] as String : null,
        userName: j['userName'] is String ? j['userName'] as String : '',
        deviceName: j['deviceName'] is String ? j['deviceName'] as String : '',
        expiresAt: _date(j['expiresAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        usedAt: _date(j['usedAt']),
        cancelledAt: _date(j['cancelledAt']),
        reuseAttempts: _int(j['reuseAttempts']),
        device: j['device'] is Map<String, dynamic>
            ? EnrolledDeviceDto.fromJson(j['device'] as Map<String, dynamic>)
            : null,
      );

  final int id;
  final String userId;
  final String? userRef;
  final String userName;
  final String deviceName;
  final DateTime expiresAt;

  /// Set once the code was used; the device that used it is [device].
  final DateTime? usedAt;
  final DateTime? cancelledAt;

  /// How many later attempts met this used code (another phone tried it).
  final int reuseAttempts;
  final EnrolledDeviceDto? device;
}

/// `POST /api/enrol/begin`'s answer.
class InvitationDto {
  const InvitationDto({
    required this.id,
    required this.code,
    required this.expiresAt,
    required this.payload,
    this.sharePayload,
  });

  factory InvitationDto.fromJson(Map<String, dynamic> j) => InvitationDto(
        id: _int(j['id']),
        code: j['code'] as String,
        expiresAt: DateTime.parse(j['expiresAt'] as String),
        payload: j['payload'] as String,
        sharePayload: j['sharePayload'] is String ? j['sharePayload'] as String : null,
      );

  final int id;

  /// The 12-character code (`ABCD-EFGH-2345`): a check value, never the whole
  /// invitation.
  final String code;
  final DateTime expiresAt;

  /// The text the QR carries and the manual field accepts (`surau1:...`).
  final String payload;

  /// The reduced text to hand over in a message (no LAN address, roles,
  /// inviter, help or cloud address); null when the box has no numbered local
  /// name: the app then offers no "Kongsi".
  final String? sharePayload;
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
    this.name,
    this.themes,
    this.themeHealth,
    this.features,
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
      name: j['name'] is String ? j['name'] as String : null,
      themes: j['themes'] is Map<String, dynamic>
          ? ThemeSupport.fromJson(j['themes'] as Map<String, dynamic>)
          : null,
      themeHealth: j['themeHealth'] is Map<String, dynamic> ? ThemeHealth.fromJson(j['themeHealth'] as Map<String, dynamic>) : null,
      features: j['features'] is List ? [for (final f in j['features'] as List) if (f is String) f] : null,
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

  /// The box's local name (`box1-surau.local`); null on a legacy root or an
  /// older box. A hint only: never trusted until a handshake proves it.
  final String? name;

  /// What display themes the box (or the cloud) supports; null on an older
  /// box that sends no `themes` block.
  final ThemeSupport? themes;

  /// What the display saw when it loaded the uploaded theme in use (admin answer only); null when there is no report.
  final ThemeHealth? themeHealth;

  /// What the box can do that older boxes cannot (`video`, `posterStretch`: 2026.11.13). Absent on an older box.
  final List<String>? features;

  /// Whether the box has [feature]; an older box (no `features`) has none of them.
  bool supports(String feature) => features?.contains(feature) ?? false;
}

/// The last health report of an uploaded theme: did the clock, the prayer
/// times, the countdowns, the next-prayer chip and the logo all still show.
class ThemeHealth {
  const ThemeHealth({required this.theme, required this.version, required this.ok, required this.screen, required this.failed});

  factory ThemeHealth.fromJson(Map<String, dynamic> j) => ThemeHealth(
    theme: j['theme'] is String ? j['theme'] as String : '',
    version: (j['version'] as num?)?.toInt() ?? 0,
    ok: j['ok'] != false,
    screen: j['screen'] is String ? j['screen'] as String : '',
    failed: [
      for (final f in (j['failed'] is List ? j['failed'] as List : const []))
        if (f is String) f,
    ],
  );

  final String theme;
  final int version;
  final bool ok;
  final String screen;
  final List<String> failed;
}

/// The `themes` block of `GET /api/health`: the theme contract version and
/// the built-in theme ids.
class ThemeSupport {
  const ThemeSupport({required this.contract, required this.builtIn});

  factory ThemeSupport.fromJson(Map<String, dynamic> j) => ThemeSupport(
        contract: (j['contract'] as num?)?.toInt() ?? 0,
        builtIn: [
          for (final b in (j['builtIn'] is List ? j['builtIn'] as List : const []))
            if (b is String) b,
        ],
      );

  final int contract;
  final List<String> builtIn;
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
    this.actorRef,
    this.entityRef,
    this.entityDeleted = false,
    this.phoneChanged = false,
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
        actorRef: j['actorRef'] is String ? j['actorRef'] as String : null,
        entityRef: j['entityRef'] is String ? j['entityRef'] as String : null,
        entityDeleted: j['entityDeleted'] == true,
        phoneChanged: j['phoneChanged'] == true,
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

  /// The ID (`U-0001`) of the person who acted; null for the system, a device
  /// or a person with no ID yet.
  final String? actorRef;

  /// The ID of the user or device the line is about.
  final String? entityRef;

  /// The user the line is about is deleted now ("Pulihkan" is offered).
  final bool entityDeleted;

  /// A user line in which the phone number changed (the number itself is
  /// never in an audit answer).
  final bool phoneChanged;
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
    this.video,
    this.audio = const [],
    this.signIn,
    this.youtubeSignInHere = true,
    this.noticeRev,
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
      signIn: YoutubeSignInInfo.maybe(yt),
      youtubeSignInHere: yt['signInHere'] != false,
      warnings: _strings(j['warnings']),
      video: _str(j['video']),
      noticeRev: j['noticeRev'] is num ? (j['noticeRev'] as num).toInt() : null,
      audio: [
        for (final a in (_map(j['audio'])['sources'] is List ? _map(j['audio'])['sources'] as List : const []))
          if (a is Map && a['id'] is String) LiveAudioSourceDto.fromJson(a.cast<String, dynamic>()),
      ],
    );
  }

  /// The picture source of the running live (`phone` or `external`); null while the box does not say.
  final String? video;

  /// Changes with every edit of the live notice text (`noticeRev` of the box); null while the box does not say.
  final int? noticeRev;

  /// Per-source health of the audio mix (plan 4.7); empty while the box does not report it.
  final List<LiveAudioSourceDto> audio;

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

  /// The device-code sign-in the server carries (`youtube.signIn`); null when nothing is pending or the box does not say.
  final YoutubeSignInInfo? signIn;

  /// False when the server answering cannot sign in or out (release 2026.11.13: the cloud; the grant is held by the
  /// MAXCOM at the surau). True on a box, and on an older server that does not say.
  final bool youtubeSignInHere;

  /// YouTube is receiving the picture now.
  bool get youtubeReceiving => youtubeHealth != null && youtubeState == 'live';
}

/// One entry of `LiveStatus.audio.sources` (core `LiveAudioSourceStatus`).
class LiveAudioSourceDto {
  const LiveAudioSourceDto({
    required this.id,
    required this.enabled,
    required this.volume,
    required this.state,
    this.alignState,
    this.delayMs,
    this.residualMs,
    this.level,
  });

  factory LiveAudioSourceDto.fromJson(Map<String, dynamic> j) {
    final align = _map(j['align']);
    final vol = j['volume'];
    final lvl = j['level'];
    return LiveAudioSourceDto(
      id: j['id'] as String,
      enabled: j['enabled'] == true,
      volume: vol is num ? vol.round().clamp(0, 100) : 0,
      state: _str(j['state']) ?? 'ok',
      alignState: _str(align['state']),
      delayMs: align['delayMs'] is num ? (align['delayMs'] as num).round() : null,
      residualMs: align['residualMs'] is num ? (align['residualMs'] as num).round() : null,
      level: lvl is num ? lvl.toDouble() : null,
    );
  }

  /// `camera`, `deviceMic` or `boxInput`.
  final String id;
  final bool enabled;
  final int volume;

  /// `ok`, `silent` or `lost`.
  final String state;

  /// `searching`, `locked`, `holding`, `failed` or `manual`; null on the reference.
  final String? alignState;
  final int? delayMs;
  final int? residualMs;

  /// dBFS, -90 to 0, while the box combiner runs.
  final double? level;

  /// The meter, 0.0 to 1.0, from [level] (null when the box sends none).
  double? get meter => level == null ? null : ((level! + 60) / 60).clamp(0.0, 1.0);
}

/// `GET /api/kiosk/live`.
class KioskLiveDto {
  const KioskLiveDto({required this.live, this.since});

  factory KioskLiveDto.fromJson(Map<String, dynamic> j) =>
      KioskLiveDto(live: j['live'] == true, since: _str(j['since']));

  final bool live;
  final String? since;
}

/// The server-held YouTube sign-in as a status read shows it (`youtube.signIn`): `pending` with the code to
/// show, or the `denied` / `expired` outcome for a couple of minutes after it ended.
class YoutubeSignInInfo {
  const YoutubeSignInInfo({
    required this.state,
    this.userCode,
    this.verificationUrl,
    this.expiresAt,
  });

  /// The `signIn` of a `youtube` object, or null when it is absent or says nothing is pending.
  static YoutubeSignInInfo? maybe(Map<String, dynamic> youtube) {
    final v = youtube['signIn'];
    if (v is! Map) return null;
    final m = v.cast<String, dynamic>();
    final state = _str(m['state']);
    if (state == 'denied' || state == 'expired') {
      return YoutubeSignInInfo(state: state!);
    }
    if (state == 'pending') {
      final code = _str(m['userCode']);
      if (code == null || code.isEmpty) return null;
      final at = _str(m['expiresAt']);
      return YoutubeSignInInfo(
        state: 'pending',
        userCode: code,
        verificationUrl: _str(m['verificationUrl']),
        expiresAt: at == null ? null : DateTime.tryParse(at)?.toLocal(),
      );
    }
    return null;
  }

  /// `pending|denied|expired`.
  final String state;
  final String? userCode;
  final String? verificationUrl;
  final DateTime? expiresAt;
}

String? _knownAccountState(Object? v) => v is String && const {'signedIn', 'signedOut', 'unknown'}.contains(v) ? v : null;

/// `GET /api/live/youtube/status`.
class YoutubeStatusDto {
  const YoutubeStatusDto({
    required this.configured,
    required this.signedIn,
    this.channelTitle,
    this.lastError,
    this.signIn,
    this.signInHere = true,
    this.state,
    this.lastGoodChannel,
  });

  factory YoutubeStatusDto.fromJson(Map<String, dynamic> j) => YoutubeStatusDto(
        state: _knownAccountState(j['state']),
        lastGoodChannel: j['lastGood'] is Map ? _str((j['lastGood'] as Map)['channelTitle']) : null,
        configured: j['configured'] == true,
        signedIn: j['signedIn'] == true,
        channelTitle: _str(j['channelTitle']),
        lastError: _str(j['lastError']),
        signIn: YoutubeSignInInfo.maybe(j),
        signInHere: j['signInHere'] != false,
      );

  final bool configured;
  final bool signedIn;
  final String? channelTitle;
  final String? lastError;
  final YoutubeSignInInfo? signIn;

  /// `signedIn` | `signedOut` | `unknown` from a newer box; null from an older one (the flag alone decides).
  final String? state;

  /// The channel the box last saw signed in (`lastGood.channelTitle`); shown beside an unknown state.
  final String? lastGoodChannel;

  /// False on the cloud (2026.11.13): sign-in, sign-out and a channel change are made at the surau only.
  final bool signInHere;
}

/// `POST /api/live/youtube/signin`: the code to type at Google.
class YoutubeSignInDto {
  const YoutubeSignInDto({
    required this.userCode,
    required this.verificationUrl,
    required this.interval,
    this.expiresAt,
  });

  factory YoutubeSignInDto.fromJson(Map<String, dynamic> j) => YoutubeSignInDto(
        userCode: (j['userCode'] as String?) ?? '',
        verificationUrl: (j['verificationUrl'] as String?) ?? '',
        interval: j['interval'] is num ? (j['interval'] as num).toInt() : 5,
        expiresAt: DateTime.tryParse((j['expiresAt'] as String?) ?? '')?.toLocal(),
      );

  final String userCode;
  final String verificationUrl;

  /// When the code stops working (null when the box does not say).
  final DateTime? expiresAt;

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
