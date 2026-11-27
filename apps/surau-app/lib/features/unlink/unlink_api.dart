// The unlink routes of the main box, one method each. They go through the same call as the link routes
// (`boxCallOf`, see ../link/link_api.dart): a coded 401 is the PIN's refusal, not an ended session, and a refusal is
// a [LinkRefusal] carrying its `code` and the other fields of the answer.

import '../link/link_api.dart' show BoxCall, LinkRefusal;
import 'unlink_models.dart';

/// The unlink routes as the controller and the screens use them.
abstract class UnlinkApi {
  /// `GET /api/unlink/status`.
  Future<UnlinkStatus> status();

  /// `POST /api/unlink/start`: [deviceId] is the follower's TV device id; [pin] is null when the app lock is off.
  Future<UnlinkStatus> start({required String deviceId, String? pin});

  /// `PUT /api/unlink/answer`. [removePeople] only for the master side with `carry-on`.
  Future<UnlinkStatus> answer({
    required UnlinkSide side,
    required UnlinkChoice choice,
    bool? removePeople,
    bool? financeTick,
  });

  /// `POST /api/unlink/agree`: answers the new status. [confirm] is true after the typed word was checked in the app.
  Future<UnlinkStatus> agree({required UnlinkSide side, required int rev, bool confirm = false, String? pin});

  /// `POST /api/unlink/cancel`.
  Future<void> cancel();

  /// `POST /api/unlink/switch` ("Tukar pilihan").
  Future<UnlinkStatus> switchChoice({required UnlinkSide side, String? pin});

  /// `POST /api/unlink/drop-kept` ("Buang data lama").
  Future<void> dropKept({required UnlinkSide side, String? pin});
}

class BoxUnlinkApi implements UnlinkApi {
  const BoxUnlinkApi(this._call);

  final BoxCall _call;

  Future<UnlinkStatus> _status(String method, String path, {Object? json}) async =>
      UnlinkStatus.fromJson(await _call(method, path, json: json));

  @override
  Future<UnlinkStatus> status() => _status('GET', '/api/unlink/status');

  @override
  Future<UnlinkStatus> start({required String deviceId, String? pin}) =>
      _status('POST', '/api/unlink/start', json: {'deviceId': deviceId, 'pin': ?pin});

  @override
  Future<UnlinkStatus> answer({
    required UnlinkSide side,
    required UnlinkChoice choice,
    bool? removePeople,
    bool? financeTick,
  }) => _status(
    'PUT',
    '/api/unlink/answer',
    json: {'side': side.wire, 'choice': choice.wire, 'removePeople': ?removePeople, 'financeTick': ?financeTick},
  );

  @override
  Future<UnlinkStatus> agree({required UnlinkSide side, required int rev, bool confirm = false, String? pin}) =>
      _status('POST', '/api/unlink/agree', json: {'side': side.wire, 'rev': rev, if (confirm) 'confirm': true, 'pin': ?pin});

  @override
  Future<void> cancel() async {
    await _call('POST', '/api/unlink/cancel', json: const <String, dynamic>{});
  }

  @override
  Future<UnlinkStatus> switchChoice({required UnlinkSide side, String? pin}) =>
      _status('POST', '/api/unlink/switch', json: {'side': side.wire, 'pin': ?pin, 'confirm': true});

  @override
  Future<void> dropKept({required UnlinkSide side, String? pin}) async {
    await _call('POST', '/api/unlink/drop-kept', json: {'side': side.wire, 'pin': ?pin, 'confirm': true});
  }
}

/// True for the refusal that ends this phone's part: another admin's change or a session that is gone.
bool isStaleRefusal(LinkRefusal e) => e.code == 'stale_revision' || e.code == 'stale_session';
