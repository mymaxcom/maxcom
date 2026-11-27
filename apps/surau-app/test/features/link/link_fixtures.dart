// The link routes' answers as test data: two boxes of one surau, a session at each step, and a fake of the link API
// the controller tests drive. Names are neutral (Surau Al-Hidayah, Dewan Utama, Ruang Muslimat).

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:surau_app/box/box_client.dart' show BoxUnreachable;
import 'package:surau_app/box/box_qr.dart' show keyFingerprint;
import 'package:surau_app/box/device_key.dart' show b64url;
import 'package:surau_app/box/device_key_software.dart' show SoftwareDeviceKey;
import 'package:surau_app/sync/canonical.dart' show canonicalJson, sha256HexOf;
import 'package:surau_app/features/link/link_backup.dart';
import 'package:surau_app/features/link/link_api.dart';
import 'package:surau_app/features/link/link_models.dart';

Map<String, Object?> factsJson({
  int content = 14,
  int posters = 3,
  int videos = 2,
  int finance = 0,
  int people = 5,
  String? lastEditAt = '2026-11-20T10:10:00.000Z',
  String device = 'android',
  bool? wired,
  int freeBytes = 1800000000,
  bool youtube = false,
  bool cloud = false,
}) => {
  'content': content,
  'posters': posters,
  'videos': videos,
  'finance': finance,
  'people': people,
  'lastEditAt': lastEditAt,
  'device': device,
  'wired': wired,
  'freeBytes': freeBytes,
  'youtube': youtube,
  'cloud': cloud,
};

Map<String, Object?> faceJson(
  String name, {
  String boxId = '0123456789abcdef',
  String keyFp = '4f2a9c1e77b0d3a1',
  bool setUp = true,
  int followers = 0,
  Map<String, Object?>? facts,
  String? release,
}) => {
  'boxId': boxId,
  'name': name,
  'keyFp': keyFp,
  'setUp': setUp,
  'followers': followers,
  'facts': facts ?? factsJson(),
  'release': ?release,
};

/// Dewan Utama: a Windows PC on a cable, three people, finance records.
Map<String, Object?> dewanUtama({bool setUp = true, int followers = 0, int finance = 148}) => faceJson(
  'Dewan Utama',
  boxId: 'a1a1a1a1a1a1a1a1',
  keyFp: 'a1a1a1a1a1a1a1a1',
  setUp: setUp,
  followers: followers,
  facts: factsJson(
    content: 9,
    posters: 3,
    videos: 1,
    finance: finance,
    people: 3,
    lastEditAt: '2026-11-02T08:00:00.000Z',
    device: 'windows',
    wired: true,
    freeBytes: 52000000000,
    cloud: true,
  ),
);

/// Ruang Muslimat: a T95 on Wi-Fi with more content and YouTube.
Map<String, Object?> ruangMuslimat({bool setUp = true}) => faceJson(
  'Ruang Muslimat',
  boxId: 'b2b2b2b2b2b2b2b2',
  keyFp: 'b2b2b2b2b2b2b2b2',
  setUp: setUp,
  facts: setUp
      ? factsJson(content: 14, posters: 6, videos: 6, finance: 0, people: 5, wired: false, youtube: true)
      : factsJson(content: 0, posters: 0, videos: 0, finance: 0, people: 0, lastEditAt: null),
);

Map<String, Object?> answersJson({
  int rev = 1,
  String keep = 'scan',
  String master = 'scan',
  bool financeTick = false,
  Map<String, int>? replaced,
  Map<String, String> roles = const {},
  List<String>? same,
  String phones = 'direct',
}) => {
  'rev': rev,
  'keep': keep,
  'master': master,
  'roles': roles,
  'same': ?same,
  'phones': phones,
  'financeTick': financeTick,
  'replaced': replaced ?? {'content': 9, 'posters': 3, 'videos': 1, 'finance': 148},
};

/// `GET /api/link/status`'s `session`, this phone's box being [role]. The own box is Dewan Utama when it shows the QR,
/// Ruang Muslimat when it scans.
Map<String, Object?> linkSession({
  String role = 'show',
  String step = 'questions',
  String id = 'l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1l1',
  String expiresAt = '2026-11-21T09:50:00.000Z',
  String? code,
  Map<String, Object?>? show,
  Map<String, Object?>? scan,
  Map<String, Object?>? answers,
  Map<String, String> fixed = const {},
  bool ownAgreed = false,
  bool peerAgreed = false,
  bool pinFresh = true,
  bool finished = false,
  String? outcome,
  Map<String, Object?>? people,
}) {
  final showFace = show ?? dewanUtama();
  final scanFace = scan ?? ruangMuslimat();
  final own = role == 'show' ? showFace : scanFace;
  final peer = role == 'show' ? scanFace : showFace;
  return {
    'id': id,
    'role': role,
    'step': step,
    'expiresAt': expiresAt,
    'finished': finished,
    'outcome': outcome,
    'code': step == 'code' ? (code ?? '482193') : null,
    'own': own,
    'peer': step == 'qr' ? null : peer,
    'answers': answers,
    'fixed': fixed,
    'case': answers == null ? null : (answers['keep'] == answers['master'] ? 'S' : 'X'),
    'ownAgreed': ownAgreed,
    'peerAgreed': peerAgreed,
    'pinFresh': pinFresh,
    'people': ?people,
  };
}

/// `session.people` as the box computes it. Neutral names; phone numbers only from the tests' own range
/// (the reserved test range, see publicNames.test.ts); the full number is the key of `answers.roles`, the screen shows the last four digits only.
const kamalPhone = '+60120000001';
const aminahPhone = '+60120000002';

Map<String, Object?> peopleJson({
  List<Map<String, Object?>>? add,
  List<Map<String, Object?>>? same,
  List<Map<String, Object?>>? roleDiffs,
  List<Map<String, Object?>>? nameAsk,
  List<String>? adminsAfter,
  int tickets = 2,
}) => {
  'add': add ?? [
    {'id': 'p-farid-0001', 'name': 'Farid', 'roles': ['treasurer']},
    {'id': 'p-hasnah-002', 'name': 'Hasnah', 'roles': ['ajk', 'media']},
  ],
  'same': same ?? [
    {'id': 'p-aminah-003', 'name': 'Aminah', 'keptName': 'Puan Aminah', 'keptRoles': ['ajk'], 'rolesAfter': ['ajk']},
  ],
  'roleDiffs': roleDiffs ?? [
    {'phone': aminahPhone, 'phone4': '0002', 'name': 'Aminah', 'keptRoles': ['ajk'], 'otherRoles': ['admin', 'ajk'], 'chosen': null},
  ],
  'nameAsk': nameAsk ?? [
    {'id': 'p-razak-0004', 'name': 'Razak', 'keptName': 'Razak', 'same': false},
  ],
  'adminsAfter': adminsAfter ?? ['Aminah', 'Razak'],
  'tickets': tickets,
};

Map<String, Object?> statusJson({
  String mode = 'main',
  Map<String, Object?>? session,
  Map<String, Object?>? last,
  Map<String, Object?>? progress,
  bool lan = true,
  bool live = false,
  bool caseX = true,
  bool setUp = true,
  String? recoveryCode,
}) => {
  'mode': mode,
  'session': session,
  'last': last,
  'recoveryCode': recoveryCode,
  'progress': progress,
  'checks': {'lan': lan, 'live': live, 'caseX': caseX, 'setUp': setUp},
};

LinkStatus statusOf(Map<String, Object?> json) => LinkStatus.fromJson(json);

/// The link API with a script: what `status()` answers now, what the next call of each kind throws, and a log.
class FakeLinkApi implements LinkApi {
  FakeLinkApi(Map<String, Object?> status) : _status = status;

  Map<String, Object?> _status;
  final List<String> calls = [];
  final List<Map<String, Object?>> bodies = [];

  /// Thrown by the next call whose name is the key (`show`, `scan`, `agree`, `answers`, `pin`, `approve`, `cancel`).
  final Map<String, Object> failNext = {};
  bool unreachable = false;
  Object? statusError;

  /// What a successful write answers; defaults to the current status.
  Map<String, Object?>? afterWrite;

  void set(Map<String, Object?> status) => _status = status;

  LinkStatus _answer(String name, Map<String, Object?> body) {
    calls.add(name);
    bodies.add(body);
    if (unreachable) throw const BoxUnreachable();
    final f = failNext.remove(name);
    if (f != null) throw f;
    if (afterWrite != null) _status = afterWrite!;
    return statusOf(_status);
  }

  @override
  Future<LinkStatus> status() async {
    calls.add('status');
    if (unreachable) throw const BoxUnreachable();
    final e = statusError;
    if (e != null) throw e;
    final st = statusOf(_status);
    if (st.follower) {
      return st.asFollower(null);
    }
    return st;
  }

  @override
  Future<LinkStatus> pin(String? pin) async => _answer('pin', {'pin': pin});

  @override
  Future<LinkStatus> show(String? pin) async => _answer('show', {'pin': pin});

  @override
  Future<LinkStatus> scan(String? pin, String qr) async => _answer('scan', {'pin': pin, 'qr': qr});

  @override
  Future<LinkStatus> approve(bool ok) async => _answer('approve', {'ok': ok});

  @override
  Future<LinkStatus> setAnswers({
    required LinkSide keep,
    required LinkSide master,
    required Map<String, String> roles,
    required List<String> same,
    required LinkPhones phones,
    required bool financeTick,
  }) async => _answer('answers', {'keep': keep.wire, 'master': master.wire, 'roles': roles, 'same': same, 'phones': phones.wire, 'financeTick': financeTick});

  @override
  Future<LinkStatus> agree(int rev) async => _answer('agree', {'rev': rev});

  @override
  Future<LinkStatus> cancel() async => _answer('cancel', {});

  @override
  Future<Map<String, dynamic>> boxes() async => {
    'self': {'boxId': 'b2b2b2b2b2b2b2b2', 'name': 'Ruang Muslimat', 'keyFp': 'b2b2b2b2b2b2b2b2', 'version': '2026.11.14', 'mode': 'main', 'master': null},
    'boxes': <Object?>[],
  };

  @override
  Future<void> removeBox(String id) async {
    calls.add('remove:$id');
  }

  @override
  Future<LinkBackupInfo> backup() async => const LinkBackupInfo();

  @override
  Future<void> dropBackup({String? pin, required String linkId, bool kept = false}) async {
    calls.add(kept ? 'drop-kept' : 'drop');
    bodies.add({'pin': pin, 'linkId': linkId});
  }

  @override
  Future<void> restoreBackup({String? pin, required String linkId}) async {
    calls.add('restore');
    bodies.add({'pin': pin, 'linkId': linkId});
  }
}

/// Waits for the microtasks of a fake call to finish.
Future<void> flush() => Future<void>.delayed(Duration.zero);

/// A link QR text signed by a fresh key, as the box that shows the code makes it. [type] other than `link` and a
/// [tamper]ed name make it invalid.
Future<String> signedLinkQr({String type = 'link', String name = 'MAXCOM Dewan Utama', bool tamper = false}) async {
  final key = SoftwareDeviceKey.random();
  final pub = await key.publicJwk();
  final payload = <String, dynamic>{
    'v': 1,
    'type': type,
    'boxId': 'a1a1a1a1a1a1a1a1',
    'keyFp': keyFingerprint(pub),
    'name': name,
    'box': 'https://10.168.50.10:8443',
    'caSha256': 'c' * 64,
    'linked': false,
    'nonce': 'XDEmJK-uEm2ZdjkX4kN3l09a-gC3tFkiDDUfgLAlRvg',
    'iat': 1795000000,
    'exp': 1795000300,
    'pub': {'crv': pub['crv'], 'kty': pub['kty'], 'x': pub['x'], 'y': pub['y']},
  };
  final message = utf8.encode('maxcom-qr\n${payload['boxId']}\n$type\n${sha256HexOf(utf8.encode(canonicalJson(payload)))}');
  final sig = await key.sign(Uint8List.fromList(message));
  payload['sig'] = b64url(sig);
  if (tamper) payload['name'] = '${payload['name']} X';
  return 'maxcom1:${b64url(Uint8List.fromList(utf8.encode(jsonEncode(payload))))}';
}
