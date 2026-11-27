// What the link routes answer (`GET /api/link/status` and the answers of the
// other link routes), read into plain values. The Dart twin of `LinkView` in
// apps/box-server/src/link/session.ts and of the pure rules in
// packages/core/src/link/protocol.ts (the advice line is computed here the
// same way `adviseMaster` does). A field of the wrong type makes the whole
// read fail with [FormatException]: the screens then say they could not read
// the answer rather than show a half truth.

/// Which of the two boxes of a session: the one that shows the QR, or the one that scans it.
enum LinkSide {
  show,
  scan;

  LinkSide get other => this == LinkSide.show ? LinkSide.scan : LinkSide.show;

  static LinkSide parse(Object? v) {
    if (v == 'show') return LinkSide.show;
    if (v == 'scan') return LinkSide.scan;
    throw const FormatException('side');
  }

  String get wire => name;
}

/// Q3: what happens to the phones of the people of the box whose data is replaced or moved. `direct`: all of them,
/// admins included, reconnect to the main Box by themselves; `code`: the admins ask an admin of the main Box for a
/// join code. A box from before this question sends none, which means `code`.
enum LinkPhones {
  direct,
  code;

  static LinkPhones parse(Object? v) => v == 'direct' ? LinkPhones.direct : LinkPhones.code;

  String get wire => name;
}

/// `windows`, `android` or `other`: what the box runs on.
enum LinkDevice { windows, android, other }

class LinkFacts {
  const LinkFacts({
    required this.content,
    required this.posters,
    required this.videos,
    required this.finance,
    required this.people,
    required this.lastEditAt,
    required this.device,
    required this.wired,
    required this.freeBytes,
    required this.youtube,
    required this.cloud,
  });

  factory LinkFacts.fromJson(Object? j) {
    final m = _map(j);
    return LinkFacts(
      content: _int(m['content']),
      posters: _int(m['posters']),
      videos: _int(m['videos']),
      finance: _int(m['finance']),
      people: _int(m['people']),
      lastEditAt: m['lastEditAt'] is String ? DateTime.tryParse(m['lastEditAt'] as String) : null,
      device: switch (m['device']) {
        'windows' => LinkDevice.windows,
        'android' => LinkDevice.android,
        _ => LinkDevice.other,
      },
      wired: m['wired'] is bool ? m['wired'] as bool : null,
      freeBytes: _int(m['freeBytes']),
      youtube: m['youtube'] == true,
      cloud: m['cloud'] == true,
    );
  }

  final int content;
  final int posters;
  final int videos;
  final int finance;
  final int people;

  /// The last edit on this box, or null for a box with no data.
  final DateTime? lastEditAt;
  final LinkDevice device;

  /// Cable (true), Wi-Fi (false) or not known (null).
  final bool? wired;
  final int freeBytes;
  final bool youtube;
  final bool cloud;
}

/// One of the two boxes as the session shows it.
class LinkFace {
  const LinkFace({
    required this.boxId,
    required this.name,
    required this.keyFp,
    required this.setUp,
    required this.followers,
    required this.facts,
    this.release,
  });

  factory LinkFace.fromJson(Object? j) {
    final m = _map(j);
    return LinkFace(
      boxId: _str(m['boxId']),
      name: _str(m['name']),
      keyFp: _str(m['keyFp']),
      setUp: m['setUp'] == true,
      followers: _int(m['followers']),
      facts: LinkFacts.fromJson(m['facts']),
      // Not sent today: the version stop names the release only when the box says it.
      release: m['release'] is String ? m['release'] as String : null,
    );
  }

  final String boxId;
  final String name;
  final String keyFp;
  final bool setUp;
  final int followers;
  final LinkFacts facts;
  final String? release;
}

/// What each admin was shown under "Yang akan diganti": part of what is agreed to.
class LinkReplaced {
  const LinkReplaced({required this.content, required this.posters, required this.videos, required this.finance});

  factory LinkReplaced.fromJson(Object? j) {
    final m = _map(j);
    return LinkReplaced(
      content: _int(m['content']),
      posters: _int(m['posters']),
      videos: _int(m['videos']),
      finance: _int(m['finance']),
    );
  }

  final int content;
  final int posters;
  final int videos;
  final int finance;

  bool get isEmpty => content == 0 && posters == 0 && videos == 0 && finance == 0;
}

/// The two answers of the questions screen, with their revision.
class LinkAnswers {
  const LinkAnswers({
    required this.rev,
    required this.keep,
    required this.master,
    required this.roles,
    required this.financeTick,
    required this.replaced,
    this.same = const <String>[],
    this.phones = LinkPhones.code,
  });

  factory LinkAnswers.fromJson(Object? j) {
    final m = _map(j);
    final roles = m['roles'] is Map ? Map<String, dynamic>.from(m['roles'] as Map) : const <String, dynamic>{};
    return LinkAnswers(
      rev: _int(m['rev']),
      keep: LinkSide.parse(m['keep']),
      master: LinkSide.parse(m['master']),
      roles: {for (final e in roles.entries) if (e.value is String) e.key: e.value as String},
      // A box from before the people part sends no list: nobody was marked the same person.
      same: m['same'] is List ? [for (final v in m['same'] as List) if (v is String) v] : const <String>[],
      phones: LinkPhones.parse(m['phones']),
      financeTick: m['financeTick'] == true,
      replaced: LinkReplaced.fromJson(m['replaced']),
    );
  }

  /// Starts at 1; any change makes the next number and clears both agreements.
  final int rev;

  /// Q1: whose data is kept.
  final LinkSide keep;

  /// Q2: which box is the master (kotak utama).
  final LinkSide master;

  /// Phone number (the key the box gave in the role differences) to the ONE role of the other box that is added.
  final Map<String, String> roles;

  /// Ids of the people of the other box the admins marked "Orang yang sama" (same name, no matching number).
  final List<String> same;

  /// Q3: the phones of the other box's people.
  final LinkPhones phones;
  final bool financeTick;
  final LinkReplaced replaced;

  /// The kept data sits on the box that becomes the follower (case X).
  bool get crossed => keep != master;
}

/// A person of the box whose data is replaced, added to the kept list as a new person.
class LinkPersonAdd {
  const LinkPersonAdd({required this.id, required this.name, required this.roles});

  factory LinkPersonAdd.fromJson(Object? j) {
    final m = _map(j);
    return LinkPersonAdd(id: _str(m['id']), name: _str(m['name']), roles: _strings(m['roles']));
  }

  final String id;
  final String name;
  final List<String> roles;
}

/// A person found on both boxes by phone number: one entry, the kept roles stay.
class LinkPersonSame {
  const LinkPersonSame({
    required this.id,
    required this.name,
    required this.keptName,
    required this.keptRoles,
    required this.rolesAfter,
  });

  factory LinkPersonSame.fromJson(Object? j) {
    final m = _map(j);
    return LinkPersonSame(
      id: _str(m['id']),
      name: _str(m['name']),
      keptName: _str(m['keptName']),
      keptRoles: _strings(m['keptRoles']),
      rolesAfter: _strings(m['rolesAfter']),
    );
  }

  final String id;
  final String name;
  final String keptName;
  final List<String> keptRoles;
  final List<String> rolesAfter;
}

/// A person on both boxes (same phone number) whose roles differ.
class LinkRoleDiff {
  const LinkRoleDiff({
    required this.phoneKey,
    required this.phone4,
    required this.name,
    required this.keptRoles,
    required this.otherRoles,
    required this.chosen,
  });

  factory LinkRoleDiff.fromJson(Object? j) {
    final m = _map(j);
    return LinkRoleDiff(
      phoneKey: _str(m['phone']),
      phone4: _str(m['phone4']),
      name: _str(m['name']),
      keptRoles: _strings(m['keptRoles']),
      otherRoles: _strings(m['otherRoles']),
      chosen: m['chosen'] is String ? m['chosen'] as String : null,
    );
  }

  /// The full number: only the key of `answers.roles`. It is sent back to the box and never shown.
  final String phoneKey;

  /// The last four digits: the only part of the number the screen shows.
  final String phone4;
  final String name;
  final List<String> keptRoles;
  final List<String> otherRoles;

  /// The one role of the other box already added, or null.
  final String? chosen;

  /// The roles of the other box that may be added: not held already, never an ops role.
  List<String> get addable => [
    for (final r in otherRoles)
      if (!keptRoles.contains(r) && r != 'superadmin' && r != 'support') r,
  ];

  @override
  String toString() => 'LinkRoleDiff($name, $phone4)';
}

/// Same name on both boxes, no matching number: "Orang yang sama" or "Orang berbeza" (the default).
class LinkNameAsk {
  const LinkNameAsk({required this.id, required this.name, required this.keptName, required this.same});

  factory LinkNameAsk.fromJson(Object? j) {
    final m = _map(j);
    return LinkNameAsk(id: _str(m['id']), name: _str(m['name']), keptName: _str(m['keptName']), same: m['same'] == true);
  }

  final String id;
  final String name;
  final String keptName;
  final bool same;
}

/// The people part of the questions screen (`LinkView.people`, the Dart twin of `LinkPeopleView` in
/// packages/core/src/link/people.ts). Phone numbers are not in it except as the key of a role answer and the last
/// four digits.
class LinkPeople {
  const LinkPeople({
    required this.add,
    required this.same,
    required this.roleDiffs,
    required this.nameAsk,
    required this.adminsAfter,
    required this.tickets,
  });

  factory LinkPeople.fromJson(Object? j) {
    final m = _map(j);
    List<T> list<T>(Object? v, T Function(Object?) read) {
      if (v == null) return <T>[];
      if (v is! List) throw const FormatException('list');
      return [for (final e in v) read(e)];
    }

    return LinkPeople(
      add: list(m['add'], LinkPersonAdd.fromJson),
      same: list(m['same'], LinkPersonSame.fromJson),
      roleDiffs: list(m['roleDiffs'], LinkRoleDiff.fromJson),
      nameAsk: list(m['nameAsk'], LinkNameAsk.fromJson),
      adminsAfter: _strings(m['adminsAfter']),
      tickets: m['tickets'] is num ? (m['tickets'] as num).toInt() : 0,
    );
  }

  final List<LinkPersonAdd> add;
  final List<LinkPersonSame> same;
  final List<LinkRoleDiff> roleDiffs;
  final List<LinkNameAsk> nameAsk;

  /// Names of everyone who is a Pentadbir after the link.
  final List<String> adminsAfter;

  /// How many phones will be asked to move to the main Box.
  final int tickets;
}

enum LinkStep { qr, calling, code, questions, agreed, working, done }

class LinkSession {
  const LinkSession({
    required this.id,
    required this.role,
    required this.step,
    required this.expiresAt,
    required this.finished,
    required this.outcome,
    required this.code,
    required this.own,
    required this.peer,
    required this.answers,
    required this.fixedKeep,
    required this.fixedMaster,
    required this.caseName,
    required this.ownAgreed,
    required this.peerAgreed,
    required this.pinFresh,
    this.people,
  });

  factory LinkSession.fromJson(Object? j) {
    final m = _map(j);
    final fixed = m['fixed'] is Map ? Map<String, dynamic>.from(m['fixed'] as Map) : const <String, dynamic>{};
    return LinkSession(
      id: _str(m['id']),
      role: LinkSide.parse(m['role']),
      step: LinkStep.values.firstWhere((s) => s.name == m['step'], orElse: () => throw const FormatException('step')),
      expiresAt: DateTime.parse(_str(m['expiresAt'])),
      finished: m['finished'] == true,
      outcome: m['outcome'] is String ? m['outcome'] as String : null,
      code: m['code'] is String ? m['code'] as String : null,
      own: LinkFace.fromJson(m['own']),
      peer: m['peer'] == null ? null : LinkFace.fromJson(m['peer']),
      answers: m['answers'] == null ? null : LinkAnswers.fromJson(m['answers']),
      fixedKeep: fixed['keep'] == null ? null : LinkSide.parse(fixed['keep']),
      fixedMaster: fixed['master'] == null ? null : LinkSide.parse(fixed['master']),
      caseName: m['case'] is String ? m['case'] as String : null,
      ownAgreed: m['ownAgreed'] == true,
      peerAgreed: m['peerAgreed'] == true,
      pinFresh: m['pinFresh'] == true,
      // Absent on a box from before the people part, null until both lists are stored.
      people: m['people'] == null ? null : LinkPeople.fromJson(m['people']),
    );
  }

  final String id;

  /// `show`: this box shows the QR; `scan`: this phone's box scanned it.
  final LinkSide role;
  final LinkStep step;
  final DateTime expiresAt;
  final bool finished;
  final String? outcome;

  /// The six digits, only at the step `code`.
  final String? code;
  final LinkFace own;
  final LinkFace? peer;
  final LinkAnswers? answers;
  final LinkSide? fixedKeep;
  final LinkSide? fixedMaster;

  /// `S`, `X`, `N-S` or `N-X`.
  final String? caseName;
  final bool ownAgreed;
  final bool peerAgreed;

  /// This admin typed the PIN lately enough for "Setuju".
  final bool pinFresh;

  /// The people merge as it stands with the current answers; null on an older box or before the lists are stored.
  final LinkPeople? people;

  /// The box of [side] (show or scan), or null when the peer is not known yet.
  LinkFace? face(LinkSide side) => side == role ? own : peer;

  /// True when the box that showed the QR was never set up (case N): the scanning admin compares the code there.
  bool get showIsNew => (role == LinkSide.show ? own : peer)?.setUp == false;

  /// The admin of this phone's box approves the code: the box that showed the QR, or the scanning one when the
  /// showing box is new and has no admin.
  bool get approvesCode => role == (showIsNew ? LinkSide.scan : LinkSide.show);

  /// Exactly one party (one box is new): one question is fixed and the new box agrees by itself.
  bool get oneNewBox => own.setUp == false || peer?.setUp == false;
}

class LinkProgress {
  const LinkProgress({required this.linkId, required this.step, required this.stepNo, required this.steps, required this.percent});

  factory LinkProgress.fromJson(Object? j) {
    final m = _map(j);
    return LinkProgress(
      linkId: _str(m['linkId']),
      step: _str(m['step']),
      stepNo: _int(m['stepNo']),
      steps: _int(m['steps']),
      percent: m['percent'] is num ? (m['percent'] as num).toInt().clamp(0, 100) : null,
    );
  }

  final String linkId;

  /// `backup`, `people`, `commit` or `finish`.
  final String step;
  final int stepNo;
  final int steps;
  final int? percent;
}

class LinkLast {
  const LinkLast({required this.id, required this.outcome, required this.finishedAt, required this.role});

  factory LinkLast.fromJson(Object? j) {
    final m = _map(j);
    return LinkLast(
      id: _str(m['id']),
      outcome: m['outcome'] is String ? m['outcome'] as String : null,
      finishedAt: DateTime.parse(_str(m['finishedAt'])),
      role: m['role'] == 'scan' ? LinkSide.scan : LinkSide.show,
    );
  }

  final String id;
  final String? outcome;
  final DateTime finishedAt;
  final LinkSide role;

  bool get linked => outcome == 'linked';
}

class LinkChecks {
  const LinkChecks({required this.lan, required this.live, required this.caseX, required this.setUp});

  factory LinkChecks.fromJson(Object? j) {
    final m = j is Map ? Map<String, dynamic>.from(j) : const <String, dynamic>{};
    return LinkChecks(
      lan: m['lan'] != false,
      live: m['live'] == true,
      caseX: m['caseX'] == true,
      setUp: m['setUp'] != false,
    );
  }

  /// This phone reaches its box directly on the surau network.
  final bool lan;

  /// A live broadcast is on.
  final bool live;

  /// Different boxes for the kept data and the master are possible in this release.
  final bool caseX;
  final bool setUp;
}

class LinkStatus {
  const LinkStatus({
    required this.follower,
    required this.session,
    required this.last,
    required this.progress,
    required this.checks,
    this.master,
    this.recoveryCode,
  });

  factory LinkStatus.fromJson(Object? j) {
    final m = _map(j);
    return LinkStatus(
      follower: m['mode'] == 'follower',
      session: m['session'] == null ? null : LinkSession.fromJson(m['session']),
      last: m['last'] == null ? null : LinkLast.fromJson(m['last']),
      progress: m['progress'] == null ? null : LinkProgress.fromJson(m['progress']),
      checks: LinkChecks.fromJson(m['checks']),
      recoveryCode: m['recoveryCode'] is String && (m['recoveryCode'] as String).isNotEmpty ? m['recoveryCode'] as String : null,
    );
  }

  /// The box answers as a follower (`mode` in the status, or 409 `follower` on any route).
  final bool follower;
  final LinkSession? session;
  final LinkLast? last;
  final LinkProgress? progress;
  final LinkChecks checks;

  /// The master's name when the box said it (409 `follower`).
  final String? master;

  /// The new recovery code of a box that linked as case X or N-X. The box gives it ONCE, to the first admin read after
  /// the link: the controller takes it out of the status at once ([withoutRecoveryCode]) and the person writes it down.
  final String? recoveryCode;

  /// The same status without the recovery code, so it is never kept in a status that is read again.
  LinkStatus withoutRecoveryCode() => LinkStatus(follower: follower, session: session, last: last, progress: progress, checks: checks, master: master);

  LinkStatus asFollower(String? masterName) =>
      LinkStatus(follower: true, session: session, last: last, progress: progress, checks: checks, master: masterName);
}

/// The advice under Q2 (the twin of `adviseMaster`): a Windows PC before an Android box, a cable before Wi-Fi,
/// then the larger free storage. A box that is set up before one that was never set up.
LinkSide adviseMaster(LinkFace show, LinkFace scan) {
  if (show.setUp != scan.setUp) return show.setUp ? LinkSide.show : LinkSide.scan;
  int score(LinkFace h) => (h.facts.device == LinkDevice.windows ? 4 : 0) + (h.facts.wired == true ? 2 : 0);
  final d = score(show) - score(scan);
  if (d != 0) return d > 0 ? LinkSide.show : LinkSide.scan;
  return scan.facts.freeBytes > show.facts.freeBytes ? LinkSide.scan : LinkSide.show;
}

Map<String, dynamic> _map(Object? v) {
  if (v is Map) return Map<String, dynamic>.from(v);
  throw const FormatException('object');
}

String _str(Object? v) {
  if (v is String) return v;
  throw const FormatException('string');
}

List<String> _strings(Object? v) {
  if (v == null) return const <String>[];
  if (v is! List) throw const FormatException('list');
  return [for (final e in v) _str(e)];
}

int _int(Object? v) {
  if (v is num) return v.toInt();
  throw const FormatException('number');
}
