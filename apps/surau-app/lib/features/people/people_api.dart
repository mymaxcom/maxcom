// The calls of the Peranti and Pengguna screens, over the gateway.
//
// Offline-first where the server allows it: a rename of a person and a
// reactivation are queued like roles and deactivation (`user.put`); everything
// else is live-only (`live_only.dart`) and throws [LiveOnly] when no base
// answers. Every call that exists only on a newer box turns a plain 404 (no
// route, no `code`) into [PeopleNeedsUpdate]: the screens then say
// `peopleNeedsUpdate` and nothing else breaks. A 404 that carries the box's own
// code (`not_found`) is the record being gone, and stays a [BoxError].
//
// Names are cleaned (`cleanedName`) and checked before anything is sent, so a
// name the box would refuse never leaves the phone. A phone number is
// normalised to E.164 the same way; a number that cannot be is [BadPhone], which
// never carries the number.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../shell/box_gateway.dart';
import 'people_words.dart';
import 'phone.dart';

/// The box answered 404 on a route of this feature: it is older than the app.
/// Screens show `S.peopleNeedsUpdate` (`errorText` does).
class PeopleNeedsUpdate implements Exception {
  const PeopleNeedsUpdate();

  @override
  String toString() => 'PeopleNeedsUpdate';
}

/// The text typed as a phone number is not a number the app can normalise. It
/// never holds the text. Screens show `S.phoneInvalid`.
class BadPhone implements Exception {
  const BadPhone();

  @override
  String toString() => 'BadPhone';
}

class PeopleApi {
  PeopleApi(this._gateway);

  /// Read at each call, so the api follows a gateway that was rebuilt.
  final BoxGateway? Function() _gateway;

  BoxGateway _gw(String path) {
    final g = _gateway();
    if (g == null) throw LiveOnly(path);
    return g;
  }

  /// [run], with a route-less 404 turned into [PeopleNeedsUpdate].
  Future<T> _newRoute<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      if (e.status == 404 && e.code == null) throw const PeopleNeedsUpdate();
      rethrow;
    }
  }

  String _name(String raw) {
    if (!nameIsValid(raw)) throw ArgumentError('name');
    return cleanedName(raw);
  }

  // ---- names (Pentadbir; the owner for their own device) ----

  /// `PUT /api/users/<id>/name`. Queued offline like roles.
  Future<void> renameUser(String id, String name) async {
    final path = '/api/users/$id/name';
    final clean = _name(name);
    await _newRoute(() => _gw(path).put(path, {'name': clean}));
  }

  /// `PUT /api/devices/<id>/name`. Live-only.
  Future<void> renameDevice(String id, String name) async {
    final path = '/api/devices/$id/name';
    final clean = _name(name);
    await _newRoute(() => _gw(path).put(path, {'name': clean}));
  }

  /// `PUT /api/auth/device/name`: the phone this session runs on. Live-only.
  Future<void> renameOwnDevice(String name) async {
    const path = '/api/auth/device/name';
    final clean = _name(name);
    await _newRoute(() => _gw(path).put(path, {'name': clean}));
  }

  // ---- state of a person ----

  /// `POST /api/users/<id>/unlock`: clears the wrong-PIN count and the lock;
  /// the PIN stays. Live-only.
  Future<void> unlockUser(String id) async {
    final path = '/api/users/$id/unlock';
    await _newRoute(() => _gw(path).post(path, const <String, dynamic>{}));
  }

  /// `POST /api/users/<id>/activate`: active again, with no devices. Queued
  /// offline as `user.put {active: true}`.
  Future<void> activateUser(String id) async {
    final path = '/api/users/$id/activate';
    await _newRoute(() => _gw(path).post(path, const <String, dynamic>{}));
  }

  /// `POST /api/users/<id>/delete {ref}`: a soft delete. [ref] is the ID shown
  /// to the person (`U-0001`) the box compares with the row (`ref_mismatch`
  /// otherwise); for a person that has no ID yet, the user's own id. Live-only.
  Future<void> deleteUser(String id, String ref) async {
    final path = '/api/users/$id/delete';
    await _newRoute(() => _gw(path).post(path, {'ref': ref}));
  }

  /// `POST /api/users/<id>/restore`: comes back deactivated with no devices.
  /// Live-only.
  Future<void> restoreUser(String id) async {
    final path = '/api/users/$id/restore';
    await _newRoute(() => _gw(path).post(path, const <String, dynamic>{}));
  }

  /// `PUT /api/users/<id>/phone`. [phone] is what was typed; it is normalised
  /// to E.164 here and [BadPhone] is thrown (nothing sent) when it cannot be.
  /// An empty [phone] clears the number (`{"phone": ""}`). Live-only.
  Future<void> setPhone(String id, String phone) async {
    final path = '/api/users/$id/phone';
    if (phone.trim().isEmpty) {
      await _newRoute(() => _gw(path).put(path, {'phone': ''}));
      return;
    }
    final e164 = normalisePhone(phone);
    if (e164 == null) throw const BadPhone();
    await _newRoute(() => _gw(path).put(path, {'phone': e164}));
  }

  /// `POST /api/users`: a new person. The phone is optional: null or empty
  /// sends no `phone` field. Live-only (an old route: a 404 is not "update").
  Future<UserDto> createUser({
    required String name,
    required List<String> roles,
    String? phone,
  }) async {
    const path = '/api/users';
    final clean = _name(name);
    final typed = phone?.trim() ?? '';
    final body = <String, dynamic>{'name': clean, 'roles': roles};
    if (typed.isNotEmpty) {
      final e164 = normalisePhone(typed);
      if (e164 == null) throw const BadPhone();
      body['phone'] = e164;
    }
    final out = await _gw(path).post(path, body);
    return UserDto.fromJson(out);
  }

  /// The live person holding [e164], read fresh from the box (a stale copy
  /// answers null). Used after a create that got no answer in time.
  Future<UserDto?> findUserByPhone(String e164) async {
    const path = '/api/users';
    final read = await _gw(path).get(path);
    if (read.stale) return null;
    for (final u in (read.value['users'] as List? ?? const [])) {
      final user = UserDto.fromJson(u as Map<String, dynamic>);
      if (!user.deleted && user.phone == e164) return user;
    }
    return null;
  }

  /// The person just added with no phone number, after an uncertain answer:
  /// the same name, no number, not deleted and made in the last ten minutes
  /// (the newest when several match). Null when the box holds none, or when
  /// the list is not live.
  Future<UserDto?> findUserJustAdded(String name, {DateTime? now}) async {
    const path = '/api/users';
    final clean = _name(name);
    final read = await _gw(path).get(path);
    if (read.stale) return null;
    final at = now ?? DateTime.now();
    UserDto? found;
    for (final u in (read.value['users'] as List? ?? const [])) {
      final user = UserDto.fromJson(u as Map<String, dynamic>);
      final made = user.createdAt;
      if (user.deleted || user.phone != null || user.name != clean || made == null) continue;
      if (at.difference(made).abs() > const Duration(minutes: 10)) continue;
      if (found == null || made.isAfter(found.createdAt!)) found = user;
    }
    return found;
  }

  // ---- devices ----

  /// `POST /api/devices/<id>/revoke`: "Padam peranti". A 409
  /// `last_admin_device` is the box refusing the last Pentadbir phone. Live-only.
  Future<void> revokeDevice(String id) async {
    final path = '/api/devices/$id/revoke';
    await _gw(path).post(path, const <String, dynamic>{});
  }

  /// `POST /api/devices/revoke-inactive {ids}` (at most 50): the box
  /// re-checks every id against its own clock and skips, with a reason, what
  /// is the caller's own device, a TV screen, in use, or the last Pentadbir
  /// phone (`own_device`, `is_tv`, `in_use`, `last_admin_device`, `not_found`).
  /// Live-only.
  Future<({List<String> revoked, List<({String id, String reason})> skipped})> revokeInactive(
    List<String> ids,
  ) {
    const path = '/api/devices/revoke-inactive';
    return _newRoute(() async {
      final out = await _gw(path).post(path, {'ids': ids});
      return (
        revoked: [
          for (final r in (out['revoked'] as List? ?? const [])) r.toString(),
        ],
        skipped: [
          for (final s in (out['skipped'] as List? ?? const []))
            if (s is Map) (id: s['id'].toString(), reason: s['reason'].toString()),
        ],
      );
    });
  }

  // ---- enrolment codes ----

  /// `POST /api/enrol/begin`. Live-only; the code only works on the surau
  /// Wi-Fi (the cloud answers 409 `box_only`).
  Future<InvitationDto> beginEnrol({
    required String userId,
    required String deviceName,
    required int ttlMinutes,
  }) async {
    const path = '/api/enrol/begin';
    final out = await _gw(path).post(path, {
      'userId': userId,
      'deviceName': deviceName,
      'ttlMinutes': ttlMinutes,
    });
    return InvitationDto.fromJson(out);
  }

  /// `GET /api/enrol/recent`: the caller's own codes of the last 24 hours.
  Future<List<RecentCodeDto>> recentCodes() {
    const path = '/api/enrol/recent';
    return _newRoute(() async {
      final out = await _gw(path).getFresh(path);
      return [
        for (final c in (out['codes'] as List? ?? const []))
          if (c is Map<String, dynamic>) RecentCodeDto.fromJson(c),
      ];
    });
  }

  /// `POST /api/enrol/cancel {id, userId}`: "Tamatkan kod". True when a code
  /// was ended; false when it was already used or ended. Live-only.
  Future<bool> cancelCode({required int id, required String userId}) {
    const path = '/api/enrol/cancel';
    return _newRoute(() async {
      final out = await _gw(path).post(path, {'id': id, 'userId': userId});
      return out['cancelled'] == true;
    });
  }
}

/// The calls of the people screens; reads the gateway at each call.
final peopleApiProvider = Provider<PeopleApi>(
  (ref) => PeopleApi(() => ref.read(gatewayProvider)),
);
