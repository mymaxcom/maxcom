// The one controller of the link flow. While the flow is open (the screen calls [LinkController.startPolling]) it
// asks the box for `GET /api/link/status` every two seconds (the box has no push for the app) and the screen follows what the answer says: [linkPhaseOf] turns a
// [LinkState] into the phase to draw. Every action (show a code, scan one, approve, answer, agree, cancel) is one call
// and its answer is the new status, so the screen never waits for the next poll to see its own change.
//
// Rules kept here:
//  - the PIN is typed when it is needed and goes into exactly one request; it is never kept;
//  - an answer's revision is remembered; a poll that finds another revision than this admin last saw (and did not
//    write) raises the "other admin changed this" notice;
//  - the box answering 409 `follower` ends the flow: this phone's box now follows another one;
//  - a result (`last`) is drawn once; the person's "Selesai" dismisses that session id for the rest of the run.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart' show BoxUnreachable, SessionExpired;
import 'link_api.dart';
import 'link_models.dart';
import '../../box/box_qr.dart' show BoxQrPayload;

/// Which screen of the flow is showing.
enum LinkPhase {
  loading,

  /// This phone's box follows another box: the flow is over.
  follower,

  /// Nothing is running: the checks and the two choices.
  entry,

  /// The camera, then the confirmation of the scanned box.
  scanning,

  /// This box shows its QR on the TV and waits for the other admin to scan it.
  waiting,

  /// The scanning box is calling the other one.
  calling,

  /// The matching code, and the approval buttons for the side that approves.
  code,
  questions,
  progress,
  done,

  /// A refusal that ends the attempt: version, protocol, database level.
  stop,
}

/// A refusal that ends the attempt, with what the screen needs to word it.
class LinkStop {
  const LinkStop({required this.code, this.behind, this.peerName, this.ownName, this.ownRelease});

  /// `version`, `protocol` or `db_level`.
  final String code;
  final LinkSide? behind;

  /// The name in the scanned QR, when this phone's box scanned it.
  final String? peerName;
  final String? ownName;
  final String? ownRelease;
}

const Object _keep = Object();

class LinkState {
  const LinkState({
    this.status,
    this.unreachable = false,
    this.unreadable = false,
    this.busy = false,
    this.error,
    this.errorUntil,
    this.stop,
    this.scanning = false,
    this.scanned,
    this.staleNotice = false,
    this.dismissedId,
    this.recent,
    this.ownName,
    this.ownRelease,
    this.recoveryCode,
  });

  /// The last answer of the box; null until the first one.
  final LinkStatus? status;

  /// The last poll did not reach the box.
  final bool unreachable;

  /// The last answer could not be read.
  final bool unreadable;

  /// An action is in flight.
  final bool busy;

  /// The code of the last refused action (shown beside the buttons), or null.
  final String? error;

  /// The date a refusal names (`kept_data`: the data of the unlink is held until then), or null.
  final DateTime? errorUntil;
  final LinkStop? stop;

  /// The person chose "Imbas kod kotak lain".
  final bool scanning;

  /// A verified QR waiting for "Teruskan".
  final BoxQrPayload? scanned;

  /// "Pentadbir lain menukar pilihan. Semak dan setuju sekali lagi."
  final bool staleNotice;

  /// The session id whose result the person has seen.
  final String? dismissedId;

  /// The last session seen with its answers: names for the done screen.
  final LinkSession? recent;

  /// This phone's box: name and release, read once from `GET /api/boxes` (null while unknown).
  final String? ownName;
  final String? ownRelease;

  /// The new recovery code of this box (case X or N-X), held in memory only until the person has written it down:
  /// the box gives it once, it is not stored and not logged, and a reload of the app does not bring it back.
  final String? recoveryCode;

  LinkState copyWith({
    Object? status = _keep,
    bool? unreachable,
    bool? unreadable,
    bool? busy,
    Object? error = _keep,
    Object? errorUntil = _keep,
    Object? stop = _keep,
    bool? scanning,
    Object? scanned = _keep,
    bool? staleNotice,
    Object? dismissedId = _keep,
    Object? recent = _keep,
    Object? ownName = _keep,
    Object? ownRelease = _keep,
    Object? recoveryCode = _keep,
  }) => LinkState(
    status: identical(status, _keep) ? this.status : status as LinkStatus?,
    unreachable: unreachable ?? this.unreachable,
    unreadable: unreadable ?? this.unreadable,
    busy: busy ?? this.busy,
    error: identical(error, _keep) ? this.error : error as String?,
    errorUntil: identical(errorUntil, _keep) ? this.errorUntil : errorUntil as DateTime?,
    stop: identical(stop, _keep) ? this.stop : stop as LinkStop?,
    scanning: scanning ?? this.scanning,
    scanned: identical(scanned, _keep) ? this.scanned : scanned as BoxQrPayload?,
    staleNotice: staleNotice ?? this.staleNotice,
    dismissedId: identical(dismissedId, _keep) ? this.dismissedId : dismissedId as String?,
    recent: identical(recent, _keep) ? this.recent : recent as LinkSession?,
    ownName: identical(ownName, _keep) ? this.ownName : ownName as String?,
    ownRelease: identical(ownRelease, _keep) ? this.ownRelease : ownRelease as String?,
    recoveryCode: identical(recoveryCode, _keep) ? this.recoveryCode : recoveryCode as String?,
  );
}

/// The screen [s] calls for. The order is the order of precedence: a follower ends everything; a running session
/// (or progress) is drawn by its step; then a stop, a scan in hand, a result not yet dismissed, and the entry.
LinkPhase linkPhaseOf(LinkState s) {
  final st = s.status;
  if (st == null) return LinkPhase.loading;
  if (st.follower) return LinkPhase.follower;
  final session = st.session;
  if (session != null && !session.finished) {
    return switch (session.step) {
      LinkStep.qr => LinkPhase.waiting,
      LinkStep.calling => LinkPhase.calling,
      LinkStep.code => LinkPhase.code,
      LinkStep.questions => LinkPhase.questions,
      LinkStep.agreed || LinkStep.working || LinkStep.done => LinkPhase.progress,
    };
  }
  if (st.progress != null) return LinkPhase.progress;
  // A recovery code the box gave once is shown before anything else is dismissed.
  if (s.recoveryCode != null) return LinkPhase.done;
  if (s.stop != null) return LinkPhase.stop;
  if (s.scanning || s.scanned != null) return LinkPhase.scanning;
  final last = st.last;
  if (last != null && last.id != s.dismissedId) return LinkPhase.done;
  return LinkPhase.entry;
}

/// What the person may do about the checks of the entry screen: null when linking can start.
enum LinkBlock { notLan, live, follower }

LinkBlock? linkBlockOf(LinkStatus st) {
  if (st.follower) return LinkBlock.follower;
  if (!st.checks.lan) return LinkBlock.notLan;
  if (st.checks.live) return LinkBlock.live;
  return null;
}

/// How often the box is asked while the flow is open.
final linkPollEveryProvider = Provider<Duration>((ref) => const Duration(seconds: 2));

/// The link routes of the box this phone talks to; null while locked.
final linkApiProvider = Provider<LinkApi?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  return gateway == null ? null : BoxLinkApi(boxCallOf(gateway));
});

/// The session ids whose result the person dismissed: one run of the app.
final linkDismissedProvider = NotifierProvider<LinkDismissed, String?>(LinkDismissed.new);

class LinkDismissed extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String id) => state = id;
}

final linkControllerProvider = NotifierProvider.autoDispose<LinkController, LinkState>(LinkController.new);

class LinkController extends Notifier<LinkState> {
  Timer? _timer;
  bool _polling = false;
  int? _seenRev;
  String? _seenSession;
  LinkRefusal? _refused;

  LinkApi? get _api => ref.read(linkApiProvider);

  /// Whether this admin's requests need a PIN (the app lock is on).
  bool get pinRequired => ref.read(appLockProvider);

  @override
  LinkState build() {
    ref.onDispose(() => _timer?.cancel());
    unawaited(Future<void>.microtask(() async {
      await refresh();
      await _readOwnBox();
    }));
    return LinkState(dismissedId: ref.read(linkDismissedProvider));
  }

  /// Asks the box every [linkPollEveryProvider] until [stopPolling]; the screen that shows the flow owns this.
  void startPolling() {
    _timer?.cancel();
    if (state.status?.follower == true) return;
    _timer = Timer.periodic(ref.read(linkPollEveryProvider), (_) => unawaited(refresh()));
  }

  void stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _readOwnBox() async {
    final api = _api;
    if (api == null || !ref.mounted) return;
    try {
      final b = await api.boxes();
      final self = b['self'];
      if (self is Map && ref.mounted) {
        state = state.copyWith(
          ownName: self['name'] is String ? self['name'] as String : null,
          ownRelease: self['version'] is String ? self['version'] as String : null,
        );
      }
    } on Object {
      // the names only improve a sentence
    }
  }

  /// One poll. Never throws; a poll in flight, or an action in flight, makes this one wait for the next tick.
  Future<void> refresh() async {
    final api = _api;
    if (api == null || _polling || state.busy || !ref.mounted) return;
    _polling = true;
    try {
      final st = await api.status();
      if (!ref.mounted) return;
      _apply(st);
      if (st.follower) _timer?.cancel();
    } on BoxUnreachable {
      if (ref.mounted) state = state.copyWith(unreachable: true);
    } on LinkRefusal catch (e) {
      if (ref.mounted) state = state.copyWith(unreachable: false, error: e.code);
    } on SessionExpired {
      _timer?.cancel();
    } on FormatException {
      if (ref.mounted) state = state.copyWith(unreadable: true);
    } on TypeError {
      if (ref.mounted) state = state.copyWith(unreadable: true);
    } finally {
      _polling = false;
    }
  }

  /// Takes a status answer: the revision watch, the session kept for the done screen, the flags cleared.
  void _apply(LinkStatus st, {bool ownWrite = false}) {
    final session = st.session;
    var stale = state.staleNotice;
    if (session == null || session.id != _seenSession) {
      _seenRev = null;
      _seenSession = session?.id;
      stale = false;
    }
    final answers = session?.answers;
    if (answers != null) {
      if (_seenRev != null && answers.rev != _seenRev && !ownWrite) stale = true;
      _seenRev = answers.rev;
    }
    // Agreeing to the revision on the screen answers the notice.
    if (session != null && session.ownAgreed) stale = false;
    // The recovery code comes in whichever answer the box gives it to, once; it moves out of the status into the state.
    final code = st.recoveryCode;
    state = state.copyWith(
      status: code == null ? st : st.withoutRecoveryCode(),
      unreachable: false,
      unreadable: false,
      staleNotice: stale,
      recent: session != null && session.answers != null ? session : state.recent,
      recoveryCode: code ?? state.recoveryCode,
    );
  }

  Future<void> _act(Future<LinkStatus> Function(LinkApi api) call, {bool clearError = true}) async {
    final api = _api;
    if (api == null || state.busy) return;
    _refused = null;
    state = state.copyWith(busy: true, error: clearError ? null : _keep);
    try {
      final st = await call(api);
      if (!ref.mounted) return;
      _apply(st, ownWrite: true);
      state = state.copyWith(busy: false);
    } on LinkRefusal catch (e) {
      if (!ref.mounted) return;
      _refused = e;
      if (e.code == 'follower') {
        state = state.copyWith(busy: false, status: LinkStatus(follower: true, session: null, last: null, progress: null, checks: const LinkChecks(lan: true, live: false, caseX: false, setUp: true), master: e.masterName));
        _timer?.cancel();
        return;
      }
      if (e.code == 'stale_revision') {
        state = state.copyWith(busy: false, staleNotice: true);
        _seenRev = null;
        unawaited(refresh());
        return;
      }
      final until = e.extra['until'];
      state = state.copyWith(busy: false, error: e.code, errorUntil: until is String ? DateTime.tryParse(until)?.toLocal() : null);
      // `people_answer`: the answers no longer fit the people lists; look at the lists again.
      if (e.code == 'no_session' || e.code == 'wrong_step' || e.code == 'people_answer') unawaited(refresh());
    } on BoxUnreachable {
      if (ref.mounted) state = state.copyWith(busy: false, unreachable: true, error: 'unreachable');
    } on SessionExpired {
      if (ref.mounted) state = state.copyWith(busy: false);
      _timer?.cancel();
    } on FormatException {
      if (ref.mounted) state = state.copyWith(busy: false, unreadable: true);
    } on TypeError {
      if (ref.mounted) state = state.copyWith(busy: false, unreadable: true);
    }
  }

  String? _pinOrNull(String? pin) => pinRequired ? pin : null;

  /// "Papar kod di TV ini". Returns the refusal code (for the PIN sheet's own line), or null on success.
  Future<String?> showCode(String? pin) async {
    await _act((api) => api.show(_pinOrNull(pin)));
    return state.error;
  }

  /// The camera for "Imbas kod kotak lain".
  void beginScan() => state = state.copyWith(scanning: true, scanned: null, error: null);

  /// Leaves the scanning screens without a request.
  void endScan() => state = state.copyWith(scanning: false, scanned: null, error: null);

  /// A scanned text: kept for confirmation when it is a correctly signed link QR, else the error `bad_qr`.
  void onScanned(String text) {
    if (state.scanned != null || state.busy) return;
    try {
      state = state.copyWith(scanned: BoxQrPayload.parseLink(text), error: null);
    } on Object {
      state = state.copyWith(error: 'bad_qr');
    }
  }

  /// Back to the camera from the confirmation.
  void rescan() => state = state.copyWith(scanned: null, error: null);

  /// "Teruskan": the verified QR goes to this phone's own box. Returns the refusal code (for the PIN sheet's own
  /// line), or null on success; a version refusal ends the attempt on the stop screen and returns null.
  Future<String?> confirmScan(String? pin) async {
    final q = state.scanned;
    if (q == null) return 'bad_qr';
    await _act((api) => api.scan(_pinOrNull(pin), q.text));
    final e = state.error;
    if (e == null) {
      state = state.copyWith(scanning: false, scanned: null);
      return null;
    }
    final refused = _refused;
    if (refused != null && (e == 'version' || e == 'protocol' || e == 'db_level')) {
      _stopFrom(refused);
      return null;
    }
    return e;
  }

  /// Turns a version refusal of the scan into the stop screen.
  void _stopFrom(LinkRefusal e) {
    state = state.copyWith(
      stop: LinkStop(
        code: e.code,
        behind: e.behind,
        peerName: state.scanned?.name,
        ownName: state.ownName,
        ownRelease: state.ownRelease,
      ),
      scanning: false,
      scanned: null,
      error: null,
    );
  }

  /// "Setuju" / "Kod sama" or "Tolak" on the matching code.
  Future<void> approve(bool ok) async {
    await _act((api) => api.approve(ok));
    // "Tolak" ends the session and the box answers 409 `rejected` for it: that is the success of this button.
    if (!ok && state.error == 'rejected') {
      state = state.copyWith(error: null);
      await refresh();
    }
  }

  /// Q1: the data that is kept. The master follows unless it was set apart on purpose.
  Future<void> chooseKeep(LinkSide side) {
    final a = state.status?.session?.answers;
    if (a == null || a.keep == side) return Future<void>.value();
    final follows = a.keep == a.master;
    // The people lists are read from the kept side: another kept box means other differences and other questions,
    // so the people answers start again (an empty answer always fits).
    return _answer(
      keep: side,
      master: follows || state.status?.checks.caseX != true ? side : a.master,
      roles: const <String, String>{},
      same: const <String>[],
    );
  }

  /// Q2: the master.
  Future<void> chooseMaster(LinkSide side) {
    final a = state.status?.session?.answers;
    if (a == null || a.master == side) return Future<void>.value();
    return _answer(keep: a.keep, master: side);
  }

  /// L7: "Saya faham rekod kewangan ... tidak dibawa".
  Future<void> setFinanceTick(bool on) {
    final a = state.status?.session?.answers;
    if (a == null || a.financeTick == on) return Future<void>.value();
    return _answer(keep: a.keep, master: a.master, tick: on);
  }

  /// One role of the other box added for the person with [phoneKey] (the key the box gave); [role] null takes the
  /// choice back. One choice per person: a new one replaces the old. Any change is a new revision.
  Future<void> chooseRole(String phoneKey, String? role) {
    final a = state.status?.session?.answers;
    if (a == null) return Future<void>.value();
    final roles = {...a.roles};
    if (role == null) {
      if (roles.remove(phoneKey) == null) return Future<void>.value();
    } else {
      if (roles[phoneKey] == role) return Future<void>.value();
      roles[phoneKey] = role;
    }
    return _answer(keep: a.keep, master: a.master, roles: roles);
  }

  /// Q3: the phones of the other box's people.
  Future<void> choosePhones(LinkPhones phones) {
    final a = state.status?.session?.answers;
    if (a == null || a.phones == phones) return Future<void>.value();
    return _answer(keep: a.keep, master: a.master, phones: phones);
  }

  /// "Orang yang sama" ([same] true) or "Orang berbeza" for the person [id] of the other box.
  Future<void> setSame(String id, bool same) {
    final a = state.status?.session?.answers;
    if (a == null || a.same.contains(id) == same) return Future<void>.value();
    final next = same ? [...a.same, id] : [for (final x in a.same) if (x != id) x];
    return _answer(keep: a.keep, master: a.master, same: next);
  }

  Future<void> _answer({
    required LinkSide keep,
    required LinkSide master,
    bool? tick,
    Map<String, String>? roles,
    List<String>? same,
    LinkPhones? phones,
  }) {
    final a = state.status!.session!.answers!;
    return _act(
      (api) => api.setAnswers(
        keep: keep,
        master: master,
        roles: roles ?? a.roles,
        same: same ?? a.same,
        phones: phones ?? a.phones,
        financeTick: tick ?? a.financeTick,
      ),
    );
  }

  /// "Setuju" on the questions screen for the revision on show. A box that says `pin_required` has the person type
  /// the PIN ([agreeWithPin]); with the app lock off the box's proof is renewed here without asking.
  /// Returns true when the PIN sheet is needed.
  Future<bool> agree() async {
    final rev = state.status?.session?.answers?.rev;
    if (rev == null) return false;
    await _act((api) => api.agree(rev));
    if (state.error != 'pin_required') return false;
    if (!pinRequired) {
      await _act((api) async {
        await api.pin(null);
        return api.agree(rev);
      });
      return false;
    }
    state = state.copyWith(error: null);
    return true;
  }

  /// The PIN of the sheet, then "Setuju" again. Returns the refusal code (`wrong_pin`, `locked`, ...), or null.
  Future<String?> agreeWithPin(String pin) async {
    final rev = state.status?.session?.answers?.rev;
    if (rev == null) return 'wrong_step';
    await _act((api) async {
      await api.pin(pin);
      return api.agree(rev);
    });
    return state.error;
  }

  /// "Batal" / "Tutup kod sekarang": ends the session (a session of the other box is cancelled by the box itself).
  Future<void> cancel() => _act((api) => api.cancel());

  /// "Selesai" on a result: it is not drawn again in this run.
  void dismissResult() {
    final id = state.status?.last?.id;
    if (id == null) return;
    ref.read(linkDismissedProvider.notifier).set(id);
    state = state.copyWith(dismissedId: id, error: null);
  }

  /// The person wrote the recovery code down: it is dropped from memory and the box does not give it again.
  void ackRecoveryCode() => state = state.copyWith(recoveryCode: null);

  /// "Tutup" on the version stop.
  void dismissStop() => state = state.copyWith(stop: null, error: null);

  /// Clears the inline error line.
  void clearError() => state = state.copyWith(error: null);

  /// Marks the revision on screen as seen (the person looked again after the notice).
  void acknowledgeStale() => state = state.copyWith(staleNotice: false);
}
