// What the unlink routes answer (`GET /api/unlink/status` and the answers of the other unlink routes), read into plain
// values. The Dart twin of `UnlinkStatus` in docs/design/plans/2026-11-23-unlink-contract.md. A field of the wrong type
// or a word this app does not know makes the whole read fail with [FormatException]: the screens then say they could
// not read the answer rather than show a half truth.

import '../link/move_flow.dart' show MovePointer, originOf;

/// Which of the two boxes of an unlink: the main box, or the follower that leaves.
enum UnlinkSide {
  master,
  follower;

  static UnlinkSide parse(Object? v) => switch (v) {
    'master' => UnlinkSide.master,
    'follower' => UnlinkSide.follower,
    _ => throw const FormatException('side'),
  };

  String get wire => name;

  UnlinkSide get other => this == UnlinkSide.master ? UnlinkSide.follower : UnlinkSide.master;
}

/// What a box does with its data after the unlink.
enum UnlinkChoice {
  back('back'),
  carryOn('carry-on'),
  empty('empty');

  const UnlinkChoice(this.wire);

  final String wire;

  static UnlinkChoice parse(Object? v) {
    for (final c in values) {
      if (c.wire == v) return c;
    }
    throw const FormatException('choice');
  }

  static UnlinkChoice? parseOrNull(Object? v) => v == null ? null : parse(v);
}

/// `answers`, `working`, `join` or `done`.
enum UnlinkStage {
  answers,
  working,
  join,
  done;

  static UnlinkStage parse(Object? v) {
    for (final c in values) {
      if (c.name == v) return c;
    }
    throw const FormatException('stage');
  }
}

/// How the follower side is eligible to answer: a person who was Pentadbir there before the link, or any Pentadbir.
enum UnlinkEligible {
  before,
  any;

  static UnlinkEligible? parseOrNull(Object? v) => switch (v) {
    null => null,
    'before' => UnlinkEligible.before,
    'any' => UnlinkEligible.any,
    _ => throw const FormatException('eligible'),
  };
}

/// What happens to the YouTube sign-in of this box.
enum UnlinkYoutube {
  kept('kept'),
  returns('returns'),
  signInAgain('sign-in-again'),
  none('none');

  const UnlinkYoutube(this.wire);

  final String wire;

  static UnlinkYoutube parse(Object? v) {
    for (final c in values) {
      if (c.wire == v) return c;
    }
    throw const FormatException('youtube');
  }
}

/// The step of the work the box reports.
enum UnlinkStep {
  copy,
  back,
  carryOn('carry-on'),
  empty,
  join;

  const UnlinkStep([this._wire]);

  final String? _wire;

  String get wire => _wire ?? name;

  static UnlinkStep parse(Object? v) {
    for (final c in values) {
      if (c.wire == v) return c;
    }
    throw const FormatException('step');
  }
}

class UnlinkProgress {
  const UnlinkProgress({required this.step, required this.stepNo, required this.steps, required this.percent});

  factory UnlinkProgress.fromJson(Object? j) {
    final m = _map(j);
    final percent = m['percent'];
    if (percent != null && percent is! num) throw const FormatException('percent');
    return UnlinkProgress(
      step: UnlinkStep.parse(m['step']),
      stepNo: _int(m['stepNo']),
      steps: _int(m['steps']),
      percent: percent == null ? null : (percent as num).toInt().clamp(0, 100),
    );
  }

  final UnlinkStep step;
  final int stepNo;
  final int steps;

  /// 0 to 100, or null when the step has no measure.
  final int? percent;
}

class UnlinkBackupOption {
  const UnlinkBackupOption({required this.available, required this.backupAt, required this.backupBytes});

  factory UnlinkBackupOption.fromJson(Object? j) {
    final m = _map(j);
    return UnlinkBackupOption(
      available: _bool(m['available']),
      backupAt: _dateOrNull(m['backupAt']),
      backupBytes: _intOrNull(m['backupBytes']),
    );
  }

  final bool available;
  final DateTime? backupAt;
  final int? backupBytes;
}

class UnlinkVideo {
  const UnlinkVideo({required this.title, required this.bytes});

  factory UnlinkVideo.fromJson(Object? j) {
    final m = _map(j);
    return UnlinkVideo(title: _str(m['title']), bytes: _int(m['bytes']));
  }

  final String title;
  final int bytes;
}

/// The consequences in numbers for one box.
class UnlinkNumbers {
  const UnlinkNumbers({
    required this.changesSinceBackup,
    required this.peopleBack,
    required this.peopleAbsent,
    required this.financeEntriesLeft,
    required this.videosNotFit,
    required this.peopleFromFollower,
  });

  factory UnlinkNumbers.fromJson(Object? j) {
    final m = _map(j);
    return UnlinkNumbers(
      changesSinceBackup: _intOrNull(m['changesSinceBackup']),
      peopleBack: _strings(m['peopleBack']),
      peopleAbsent: _strings(m['peopleAbsent']),
      financeEntriesLeft: _intOrNull(m['financeEntriesLeft']),
      videosNotFit: [for (final v in _list(m['videosNotFit'])) UnlinkVideo.fromJson(v)],
      peopleFromFollower: _intOrNull(m['peopleFromFollower']),
    );
  }

  final int? changesSinceBackup;
  final List<String> peopleBack;
  final List<String> peopleAbsent;
  final int? financeEntriesLeft;
  final List<UnlinkVideo> videosNotFit;
  final int? peopleFromFollower;
}

/// One side of the unlink as THIS phone sees it.
class UnlinkSideView {
  const UnlinkSideView({
    required this.asked,
    required this.eligible,
    required this.mayAnswer,
    required this.choice,
    required this.answeredBy,
    required this.agreed,
    required this.needsTyped,
    required this.back,
    required this.carryOnAvailable,
    required this.emptyAvailable,
    required this.numbers,
    required this.removePeople,
    required this.youtube,
    required this.financeTick,
  });

  factory UnlinkSideView.fromJson(Object? j) {
    final m = _map(j);
    final options = _map(m['options']);
    return UnlinkSideView(
      asked: _bool(m['asked']),
      eligible: UnlinkEligible.parseOrNull(m['eligible']),
      mayAnswer: _bool(m['mayAnswer']),
      choice: UnlinkChoice.parseOrNull(m['choice']),
      answeredBy: _strOrNull(m['answeredBy']),
      agreed: _bool(m['agreed']),
      needsTyped: _bool(m['needsTyped']),
      back: UnlinkBackupOption.fromJson(options['back']),
      carryOnAvailable: _bool(_map(options['carryOn'])['available']),
      emptyAvailable: _bool(_map(options['empty'])['available']),
      numbers: UnlinkNumbers.fromJson(m['numbers']),
      removePeople: _bool(m['removePeople']),
      youtube: UnlinkYoutube.parse(m['youtube']),
      financeTick: _bool(m['financeTick']),
    );
  }

  final bool asked;
  final UnlinkEligible? eligible;
  final bool mayAnswer;
  final UnlinkChoice? choice;
  final String? answeredBy;
  final bool agreed;
  final bool needsTyped;
  final UnlinkBackupOption back;
  final bool carryOnAvailable;
  final bool emptyAvailable;
  final UnlinkNumbers numbers;
  final bool removePeople;
  final UnlinkYoutube youtube;

  /// The follower's tick "Rekod kewangan tidak disalin" as the box holds it.
  final bool financeTick;

  bool available(UnlinkChoice c) => switch (c) {
    UnlinkChoice.back => back.available,
    UnlinkChoice.carryOn => carryOnAvailable,
    UnlinkChoice.empty => emptyAvailable,
  };
}

/// The pointer to the follower for the phone that answered for it, at stage `join`.
class UnlinkJoin {
  const UnlinkJoin({required this.name, required this.pointer, this.box, this.user, this.expMs});

  /// Strict read: the same checks as the phone move's pointer (box id, certificate hash, addresses, ticket).
  factory UnlinkJoin.fromJson(Object? j, {required String linkId, required DateTime expiresAt}) {
    final m = _map(j);
    final name = _str(m['name']);
    final MovePointer pointer;
    try {
      pointer = MovePointer.fromJson({
        'pointer': {
          'v': 1,
          'linkId': linkId,
          // The follower's own id is the box the pointer names; the unlink has no earlier box to name.
          'fromBoxId': _str(m['boxId']),
          'master': {
            'name': name,
            'boxId': m['boxId'],
            'caSha256': m['caSha256'],
            'keyFp': m['keyFp'],
            'addresses': m['addresses'],
          },
          'ticket': m['ticket'],
          'expiresAt': expiresAt.toUtc().toIso8601String(),
        },
        // The unlink pointer is not signed by an old box: the session of the main box vouches for it.
        'sig': 'unlink',
      });
    } on FormatException {
      rethrow;
    } on TypeError {
      throw const FormatException('join');
    }
    // What the follower's own web app needs for an enrolment text, when the box says it (`box`, `user`, `exp`).
    final box = m['box'];
    final user = m['user'];
    final exp = m['exp'];
    return UnlinkJoin(
      name: name,
      pointer: pointer,
      box: box is String ? originOf(box) : null,
      user: user is String && user.isNotEmpty && user.length <= 80 ? user : null,
      expMs: exp is num && exp.isFinite && exp > 0 ? exp.toInt() : null,
    );
  }

  /// The follower's https origin as the box wrote it, or null (the first address of the pointer is used then).
  final String? box;

  /// The name the follower's enrol page shows, or null (this person's own name is used then).
  final String? user;

  /// When the ticket ends, epoch milliseconds, or null (the pointer's expiry is used then).
  final int? expMs;

  /// The follower's name.
  final String name;
  final MovePointer pointer;
}

class UnlinkView {
  const UnlinkView({
    required this.id,
    required this.rev,
    required this.stage,
    required this.expiresAt,
    required this.masterName,
    required this.followerName,
    required this.master,
    required this.follower,
    required this.progress,
    required this.join,
  });

  factory UnlinkView.fromJson(Object? j) {
    final m = _map(j);
    final id = _str(m['id']);
    final expiresAt = _date(m['expiresAt']);
    return UnlinkView(
      id: id,
      rev: _int(m['rev']),
      stage: UnlinkStage.parse(m['stage']),
      expiresAt: expiresAt,
      masterName: _str(m['masterName']),
      followerName: _str(m['followerName']),
      master: UnlinkSideView.fromJson(m['master']),
      follower: UnlinkSideView.fromJson(m['follower']),
      progress: m['progress'] == null ? null : UnlinkProgress.fromJson(m['progress']),
      join: m['join'] == null ? null : UnlinkJoin.fromJson(m['join'], linkId: id, expiresAt: expiresAt),
    );
  }

  final String id;
  final int rev;
  final UnlinkStage stage;
  final DateTime expiresAt;
  final String masterName;
  final String followerName;
  final UnlinkSideView master;
  final UnlinkSideView follower;
  final UnlinkProgress? progress;
  final UnlinkJoin? join;

  UnlinkSideView sideView(UnlinkSide s) => s == UnlinkSide.master ? master : follower;

  /// The side whose box carries [s]'s name in the title: the follower's name on both sheets.
  String get title => followerName;

  /// The sides this phone may answer for, follower first.
  List<UnlinkSide> get mine => [
    if (follower.mayAnswer) UnlinkSide.follower,
    if (master.asked && master.mayAnswer) UnlinkSide.master,
  ];

  /// Every asked side agreed.
  bool get allAgreed => follower.agreed && (!master.asked || master.agreed);
}

class UnlinkLast {
  const UnlinkLast({required this.id, required this.outcome, required this.finishedAt, required this.followerName});

  factory UnlinkLast.fromJson(Object? j) {
    final m = _map(j);
    final outcome = m['outcome'];
    if (outcome != 'done' && outcome != 'cancelled' && outcome != 'failed' && outcome != 'expired') {
      throw const FormatException('outcome');
    }
    return UnlinkLast(
      id: _str(m['id']),
      outcome: outcome as String,
      finishedAt: _date(m['finishedAt']),
      followerName: _str(m['followerName']),
    );
  }

  final String id;

  /// `done`, `cancelled`, `failed` or `expired`.
  final String outcome;
  final DateTime finishedAt;
  final String followerName;

  bool get done => outcome == 'done';
}

/// Data kept after a finished unlink, changeable until [keptUntil].
class UnlinkKept {
  const UnlinkKept({
    required this.side,
    required this.followerName,
    required this.masterName,
    required this.keptUntil,
    required this.chosen,
    this.switchable = true,
  });

  factory UnlinkKept.fromJson(Object? j) {
    final m = _map(j);
    final chosen = UnlinkChoice.parse(m['chosen']);
    if (chosen == UnlinkChoice.empty) throw const FormatException('chosen');
    return UnlinkKept(
      side: UnlinkSide.parse(m['side']),
      // A kept row can come with an empty name (the box did not know it): the row then says it without one.
      followerName: _nameOrEmpty(m['followerName']),
      masterName: _nameOrEmpty(m['masterName']),
      keptUntil: _date(m['keptUntil']),
      chosen: chosen,
      // Absent means switchable (an older box); false hides "Tukar pilihan".
      switchable: m['switchable'] != false,
    );
  }

  final UnlinkSide side;
  final String followerName;

  /// The main box's name, for the master row.
  final String masterName;
  final DateTime keptUntil;

  /// False: the choice of this row cannot be changed any more, so "Tukar pilihan" is not shown (only "Buang data lama").
  final bool switchable;

  /// `back` or `carry-on`: what the box does now; "Tukar pilihan" makes it the other.
  final UnlinkChoice chosen;

  UnlinkChoice get otherChoice => chosen == UnlinkChoice.back ? UnlinkChoice.carryOn : UnlinkChoice.back;
}

class UnlinkStatus {
  const UnlinkStatus({required this.session, required this.last, required this.kept});

  factory UnlinkStatus.fromJson(Map<String, dynamic> m) => UnlinkStatus(
    session: m['session'] == null ? null : UnlinkView.fromJson(m['session']),
    last: m['last'] == null ? null : UnlinkLast.fromJson(m['last']),
    kept: [for (final k in _list(m['kept'])) UnlinkKept.fromJson(k)],
  );

  final UnlinkView? session;
  final UnlinkLast? last;
  final List<UnlinkKept> kept;
}

// ---- strict readers ----

Map<String, dynamic> _map(Object? v) {
  if (v is Map) return Map<String, dynamic>.from(v);
  throw const FormatException('object');
}

List<Object?> _list(Object? v) {
  if (v == null) return const <Object?>[];
  if (v is List) return v;
  throw const FormatException('list');
}

String _str(Object? v) {
  if (v is String && v.isNotEmpty && v.length <= 500) return v;
  throw const FormatException('string');
}

/// A name that may be the empty string (the box did not know it) but must still be a string.
String _nameOrEmpty(Object? v) {
  if (v is String && v.length <= 500) return v;
  throw const FormatException('string');
}

String? _strOrNull(Object? v) => v == null ? null : _str(v);

List<String> _strings(Object? v) => [for (final x in _list(v)) _str(x)];

int _int(Object? v) {
  if (v is int) return v;
  if (v is num && v == v.roundToDouble()) return v.toInt();
  throw const FormatException('int');
}

int? _intOrNull(Object? v) => v == null ? null : _int(v);

bool _bool(Object? v) {
  if (v is bool) return v;
  throw const FormatException('bool');
}

DateTime _date(Object? v) => DateTime.parse(_str(v));

DateTime? _dateOrNull(Object? v) => v == null ? null : _date(v);
