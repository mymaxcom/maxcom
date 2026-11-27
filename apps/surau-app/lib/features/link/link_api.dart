// The link routes of the box, one method each. The calls go straight through
// the box client instead of `BoxGateway.get/put/post` for two reasons:
//
//  - a coded 401 here is a refusal of the PIN (`pin_required`, `wrong_pin`),
//    not an ended session: only an answer without such a code reaches the
//    gateway's `onSessionExpired`;
//  - the refusals carry extra fields next to `code` (`behind` for a version
//    stop, `rev` for a stale revision, `master` for a follower) that the box
//    client's error type drops.
//
// Every request still goes through the box client's own HTTP client, so the
// pinned certificate and the timeouts are the app's usual ones.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../box/box_client.dart';
import '../shell/box_gateway.dart';
import 'link_backup.dart';
import 'link_models.dart';

/// A refusal of a link route: the status, the box's `code` and the other fields of the answer.
class LinkRefusal implements Exception {
  const LinkRefusal(this.status, this.code, [this.extra = const <String, dynamic>{}]);

  final int status;

  /// The box's reason code (`lan_only`, `version`, ...); `unknown` when the answer carried none.
  final String code;
  final Map<String, dynamic> extra;

  /// For a version stop: which box is behind (`show` or `scan`), when the box said it.
  LinkSide? get behind => extra['behind'] == 'show'
      ? LinkSide.show
      : extra['behind'] == 'scan'
      ? LinkSide.scan
      : null;

  /// The revision the box holds now (`stale_revision`).
  int? get rev => extra['rev'] is num ? (extra['rev'] as num).toInt() : null;

  /// A follower's pointer to its master (409 `follower`): the master's name.
  String? get masterName {
    final m = extra['master'];
    return m is Map && m['name'] is String ? m['name'] as String : null;
  }

  @override
  String toString() => 'LinkRefusal($status, $code)';
}

/// One JSON call to the box: the decoded answer, or [LinkRefusal] / [BoxUnreachable] / [SessionExpired].
typedef BoxCall = Future<Map<String, dynamic>> Function(String method, String path, {Object? json});

/// The call of [gateway]'s box, as described at the top of this file.
BoxCall boxCallOf(BoxGateway gateway) {
  return (String method, String path, {Object? json}) async {
    final c = gateway.client;
    final req = http.Request(method, c.box.replace(path: '', query: null).resolve(path));
    if (gateway.token.isNotEmpty) req.headers['authorization'] = 'Bearer ${gateway.token}';
    if (json != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(json);
    }
    final http.Response res;
    try {
      final total = c.connect + c.read;
      final clock = Stopwatch()..start();
      final streamed = await c.client.send(req).timeout(total);
      final left = total - clock.elapsed;
      res = await http.Response.fromStream(streamed).timeout(left > Duration.zero ? left : Duration.zero);
    } on TimeoutException catch (e) {
      throw BoxUnreachable.sent(e);
    } on Exception catch (e) {
      throw BoxUnreachable(e);
    }
    Map<String, dynamic> body = const <String, dynamic>{};
    try {
      final d = jsonDecode(utf8.decode(res.bodyBytes));
      if (d is Map) body = Map<String, dynamic>.from(d);
    } on FormatException {
      // an answer that is not JSON
    }
    if (res.statusCode >= 400) {
      final c0 = body['code'];
      final code = c0 is String && c0.isNotEmpty && c0.length <= 64 ? c0 : null;
      // An ended session is a 401 without a code of its own; a coded 401 is the PIN's refusal.
      if (res.statusCode == 401 && (code == null || code == 'no_session' || code == 'session_expired')) {
        gateway.onSessionExpired();
        throw SessionExpired(BoxError.genericMessage, code: code);
      }
      throw LinkRefusal(res.statusCode, code ?? 'unknown', body);
    }
    return body;
  };
}

/// The link routes as the controller and the screens use them.
abstract class LinkApi {
  Future<LinkStatus> status();
  Future<LinkStatus> pin(String? pin);
  Future<LinkStatus> show(String? pin);
  Future<LinkStatus> scan(String? pin, String qr);
  Future<LinkStatus> approve(bool ok);
  Future<LinkStatus> setAnswers({
    required LinkSide keep,
    required LinkSide master,
    required Map<String, String> roles,
    required List<String> same,
    required LinkPhones phones,
    required bool financeTick,
  });
  Future<LinkStatus> agree(int rev);
  Future<LinkStatus> cancel();

  /// `GET /api/boxes`.
  Future<Map<String, dynamic>> boxes();

  /// `DELETE /api/boxes/:id` ("Tanggalkan").
  Future<void> removeBox(String id);

  /// `GET /api/link/backup`: the backup before the link, the data kept after an unlink, the free room.
  Future<LinkBackupInfo> backup();

  /// `POST /api/link/backup/drop` ("Buang sandaran"; [kept] true for "Buang data lama"). [pin] is null when the app
  /// lock is off.
  Future<void> dropBackup({String? pin, required String linkId, bool kept = false});

  /// `POST /api/link/backup/restore` ("Kembali ke data sebelum dipautkan").
  Future<void> restoreBackup({String? pin, required String linkId});
}

class BoxLinkApi implements LinkApi {
  const BoxLinkApi(this._call);

  final BoxCall _call;

  Future<LinkStatus> _status(String method, String path, {Object? json}) async =>
      LinkStatus.fromJson(await _call(method, path, json: json));

  @override
  Future<LinkStatus> status() async {
    try {
      return await _status('GET', '/api/link/status');
    } on LinkRefusal catch (e) {
      // A follower answers 409 `follower` on this route too.
      if (e.code == 'follower') {
        return LinkStatus(
          follower: true,
          session: null,
          last: null,
          progress: null,
          checks: const LinkChecks(lan: true, live: false, caseX: false, setUp: true),
          master: e.masterName,
        );
      }
      rethrow;
    }
  }

  @override
  Future<LinkStatus> pin(String? pin) => _status('POST', '/api/link/pin', json: {'pin': ?pin});

  @override
  Future<LinkStatus> show(String? pin) => _status('POST', '/api/link/show', json: {'pin': ?pin});

  @override
  Future<LinkStatus> scan(String? pin, String qr) => _status('POST', '/api/link/scan', json: {'pin': ?pin, 'qr': qr});

  @override
  Future<LinkStatus> approve(bool ok) => _status('POST', '/api/link/approve', json: {'ok': ok});

  @override
  Future<LinkStatus> setAnswers({
    required LinkSide keep,
    required LinkSide master,
    required Map<String, String> roles,
    required List<String> same,
    required LinkPhones phones,
    required bool financeTick,
  }) => _status(
    'PUT',
    '/api/link/answers',
    // `same` is sent every time, empty included: the box treats a missing list as "nobody", but the answer is whole.
    json: {'keep': keep.wire, 'master': master.wire, 'roles': roles, 'same': same, 'phones': phones.wire, 'financeTick': financeTick},
  );

  @override
  Future<LinkStatus> agree(int rev) => _status('POST', '/api/link/agree', json: {'rev': rev});

  @override
  Future<LinkStatus> cancel() => _status('POST', '/api/link/cancel', json: const <String, dynamic>{});

  @override
  Future<Map<String, dynamic>> boxes() => _call('GET', '/api/boxes');

  @override
  Future<void> removeBox(String id) async {
    await _call('DELETE', '/api/boxes/${Uri.encodeComponent(id)}');
  }

  @override
  Future<LinkBackupInfo> backup() async => LinkBackupInfo.fromJson(await _call('GET', '/api/link/backup'));

  @override
  Future<void> dropBackup({String? pin, required String linkId, bool kept = false}) async {
    await _call('POST', '/api/link/backup/drop', json: {'pin': ?pin, 'linkId': linkId, 'confirm': true, if (kept) 'which': 'kept'});
  }

  @override
  Future<void> restoreBackup({String? pin, required String linkId}) async {
    await _call('POST', '/api/link/backup/restore', json: {'pin': ?pin, 'linkId': linkId, 'confirm': true});
  }
}
