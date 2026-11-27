// The unlink routes' answers as test data (the contract of docs/design/plans/2026-11-23-unlink-contract.md): one
// session at each stage, both sides, and a fake of the unlink API the controller tests drive. Names are neutral
// (Dewan Utama is the main box, Ruang Muslimat the follower).

import 'package:surau_app/box/box_client.dart' show BoxUnreachable;
import 'package:surau_app/features/link/link_api.dart' show LinkRefusal;
import 'package:surau_app/features/unlink/unlink_api.dart';
import 'package:surau_app/features/unlink/unlink_models.dart';

const String backupAt = '2026-11-20T01:41:00.000Z';

Map<String, Object?> numbersJson({
  int? changes,
  List<String> back = const [],
  List<String> absent = const [],
  int? finance,
  List<Map<String, Object?>> videos = const [],
  int? peopleFromFollower,
}) => {
  'changesSinceBackup': changes,
  'peopleBack': back,
  'peopleAbsent': absent,
  'financeEntriesLeft': finance,
  'videosNotFit': videos,
  'peopleFromFollower': peopleFromFollower,
};

Map<String, Object?> sideJson({
  bool asked = true,
  String? eligible,
  bool mayAnswer = true,
  String? choice,
  String? answeredBy,
  bool agreed = false,
  bool needsTyped = false,
  bool back = true,
  String? at = backupAt,
  bool carry = true,
  bool empty = false,
  Map<String, Object?>? numbers,
  bool removePeople = false,
  bool financeTick = false,
  String youtube = 'kept',
}) => {
  'asked': asked,
  'eligible': eligible,
  'mayAnswer': mayAnswer,
  'choice': choice,
  'answeredBy': answeredBy,
  'agreed': agreed,
  'needsTyped': needsTyped,
  'options': {
    'back': {'available': back, 'backupAt': back ? at : null, 'backupBytes': back ? 52428800 : null},
    'carryOn': {'available': carry},
    'empty': {'available': empty},
  },
  'numbers': numbers ?? numbersJson(),
  'removePeople': removePeople,
  'financeTick': financeTick,
  'youtube': youtube,
};

Map<String, Object?> joinJson({String ticket = 'ABCD-EFGH-2345'}) => {
  'name': 'Ruang Muslimat',
  'boxId': 'b2b2b2b2b2b2b2b2',
  'addresses': ['https://10.168.50.12:8443'],
  'caSha256': 'ab' * 32,
  'keyFp': 'b2b2b2b2b2b2b2b2',
  'ticket': ticket,
};

Map<String, Object?> sessionJson({
  String id = 'u1',
  int rev = 1,
  String stage = 'answers',
  Map<String, Object?>? master,
  Map<String, Object?>? follower,
  Map<String, Object?>? progress,
  Map<String, Object?>? join,
}) => {
  'id': id,
  'rev': rev,
  'stage': stage,
  'expiresAt': '2026-11-23T10:20:00.000Z',
  'masterName': 'Dewan Utama',
  'followerName': 'Ruang Muslimat',
  'master': master ?? sideJson(asked: false, mayAnswer: false),
  'follower': follower ?? sideJson(eligible: 'before'),
  'progress': progress,
  'join': join,
};

Map<String, Object?> keptJson({String side = 'follower', String chosen = 'back', String until = '2026-11-27T12:00:00.000Z'}) => {
  'side': side,
  'followerName': 'Ruang Muslimat',
  'masterName': 'Dewan Utama',
  'keptUntil': until,
  'chosen': chosen,
};

Map<String, Object?> lastJson({String outcome = 'done', String id = 'u1'}) => {
  'id': id,
  'outcome': outcome,
  'finishedAt': '2026-11-23T10:30:00.000Z',
  'followerName': 'Ruang Muslimat',
};

Map<String, Object?> unlinkStatusJson({Map<String, Object?>? session, Map<String, Object?>? last, List<Map<String, Object?>> kept = const []}) => {
  'session': session,
  'last': last,
  'kept': kept,
};

UnlinkStatus statusOf(Map<String, Object?> j) => UnlinkStatus.fromJson(Map<String, dynamic>.from(j));

/// The follower answers with the backup chosen and a number line under it.
Map<String, Object?> followerBack({bool agreed = false, bool needsTyped = true}) => sideJson(
  eligible: 'before',
  choice: 'back',
  answeredBy: 'Aminah',
  agreed: agreed,
  needsTyped: needsTyped,
  numbers: numbersJson(changes: 312, back: ['Zainab', 'Hasan'], absent: ['Khalid', 'Mariam', 'Yusuf']),
);

/// The follower carries on: finance left behind, one video that does not fit.
Map<String, Object?> followerCarry({bool agreed = false, bool financeTick = false, List<Map<String, Object?>>? videos}) => sideJson(
  eligible: 'before',
  choice: 'carry-on',
  answeredBy: 'Aminah',
  agreed: agreed,
  financeTick: financeTick,
  youtube: 'none',
  numbers: numbersJson(
    finance: 42,
    videos: videos ?? [
      {'title': 'Kuliah Maghrib', 'bytes': 734003200},
    ],
  ),
);

/// A fake of the unlink API the controller tests drive.
class FakeUnlinkApi implements UnlinkApi {
  FakeUnlinkApi(Map<String, Object?> status) : _status = status;

  Map<String, Object?> _status;
  final List<String> calls = [];
  final List<Map<String, Object?>> bodies = [];

  /// Thrown by the next call of that name (`start`, `answer`, `agree`, `cancel`, `switch`, `drop`).
  final Map<String, Object> failNext = {};
  bool unreachable = false;

  /// What a successful write answers and the box holds afterwards; defaults to the current status.
  Map<String, Object?>? afterWrite;

  void set(Map<String, Object?> status) => _status = status;

  void _record(String name, Map<String, Object?> body) {
    calls.add(name);
    bodies.add(body);
    if (unreachable) throw const BoxUnreachable();
    final f = failNext.remove(name);
    if (f != null) throw f;
    if (afterWrite != null) _status = afterWrite!;
  }

  @override
  Future<UnlinkStatus> status() async {
    calls.add('status');
    if (unreachable) throw const BoxUnreachable();
    return statusOf(_status);
  }

  @override
  Future<UnlinkStatus> start({required String deviceId, String? pin}) async {
    _record('start', {'deviceId': deviceId, 'pin': pin});
    return statusOf(_status);
  }

  @override
  Future<UnlinkStatus> answer({
    required UnlinkSide side,
    required UnlinkChoice choice,
    bool? removePeople,
    bool? financeTick,
  }) async {
    _record('answer', {'side': side.wire, 'choice': choice.wire, 'removePeople': removePeople, 'financeTick': financeTick});
    return statusOf(_status);
  }

  @override
  Future<UnlinkStatus> agree({required UnlinkSide side, required int rev, bool confirm = false, String? pin}) async {
    _record('agree', {'side': side.wire, 'rev': rev, 'confirm': confirm, 'pin': pin});
    return statusOf(_status);
  }

  @override
  Future<void> cancel() async => _record('cancel', {});

  @override
  Future<UnlinkStatus> switchChoice({required UnlinkSide side, String? pin}) async {
    _record('switch', {'side': side.wire, 'pin': pin});
    return statusOf(_status);
  }

  @override
  Future<void> dropKept({required UnlinkSide side, String? pin}) async => _record('drop', {'side': side.wire, 'pin': pin});
}

LinkRefusal refusal(String code, [int status = 409, Map<String, dynamic> extra = const {}]) => LinkRefusal(status, code, {'code': code, ...extra});
