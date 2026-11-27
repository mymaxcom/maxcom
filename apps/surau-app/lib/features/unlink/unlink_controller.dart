// The controller of the unlink screens. While the screen is open (it calls [UnlinkController.startPolling]) it asks the
// box for `GET /api/unlink/status` every two seconds (as the link controller does) and [unlinkPhaseOf] turns what
// the box said into the screen to draw. Every action is one call; the answer of a call that returns a status is the
// new status, so the screen never waits for the next poll to see its own change.
//
// Rules kept here:
//  - a PIN is typed when it is needed and goes into exactly one request; it is never kept;
//  - the typed confirmation word is checked by the sheet in the app; the request only says `confirm: true`;
//  - a refusal is a code; the screens word it (unlink_text.dart);
//  - a result (`last`) is drawn once; "Selesai" dismisses that id for the rest of the run.

import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart' show BoxUnreachable, SessionExpired;
import '../enrol/enrol_flow.dart' show EnrolledBox;
import '../link/link_api.dart' show LinkRefusal, boxCallOf;
import '../shell/permissions.dart' show canSee;
import '../link/move_flow.dart' show MoveAway, MoveFlow, MovePointer;
import 'unlink_api.dart';
import 'unlink_models.dart';

/// Which screen of the flow is showing.
enum UnlinkPhase {
  loading,

  /// No session and a follower to leave: the intro and "Mula".
  start,

  /// No session, nothing to start: the kept data rows only.
  idle,

  /// The sheet of a side this phone answers for.
  answers,

  /// "Menunggu pentadbir yang satu lagi".
  waiting,

  /// The work runs.
  progress,

  /// This phone joins the follower (the 2C move flow).
  join,

  /// The follower waits for its admin's phone to join.
  joinWait,

  /// A finished session: done, cancelled, failed or expired.
  result,
}

const Object _keep = Object();

class UnlinkState {
  const UnlinkState({
    this.status,
    this.unreachable = false,
    this.unreadable = false,
    this.busy = false,
    this.error,
    this.staleNotice = false,
    this.dismissedId,
    this.editing,
  });

  /// The last answer of the box; null until the first one.
  final UnlinkStatus? status;
  final bool unreachable;
  final bool unreadable;
  final bool busy;

  /// The code of the last refused action, or null.
  final String? error;

  /// "Pentadbir lain menukar pilihan. Semak dan setuju sekali lagi."
  final bool staleNotice;

  /// The result whose id the person has seen.
  final String? dismissedId;

  /// The side whose sheet is open again after it was agreed ("Ubah jawapan").
  final UnlinkSide? editing;

  UnlinkState copyWith({
    Object? status = _keep,
    bool? unreachable,
    bool? unreadable,
    bool? busy,
    Object? error = _keep,
    bool? staleNotice,
    Object? dismissedId = _keep,
    Object? editing = _keep,
  }) => UnlinkState(
    status: identical(status, _keep) ? this.status : status as UnlinkStatus?,
    unreachable: unreachable ?? this.unreachable,
    unreadable: unreadable ?? this.unreadable,
    busy: busy ?? this.busy,
    error: identical(error, _keep) ? this.error : error as String?,
    staleNotice: staleNotice ?? this.staleNotice,
    dismissedId: identical(dismissedId, _keep) ? this.dismissedId : dismissedId as String?,
    editing: identical(editing, _keep) ? this.editing : editing as UnlinkSide?,
  );
}

/// The screen [s] calls for. [canStart] is true when the route was opened from a follower's row.
UnlinkPhase unlinkPhaseOf(UnlinkState s, {required bool canStart}) {
  final st = s.status;
  if (st == null) return UnlinkPhase.loading;
  final session = st.session;
  if (session != null) {
    switch (session.stage) {
      case UnlinkStage.answers:
        final side = unlinkSideToAnswer(session, s.editing);
        return side == null ? UnlinkPhase.waiting : UnlinkPhase.answers;
      case UnlinkStage.working:
        return UnlinkPhase.progress;
      case UnlinkStage.join:
        return session.join != null ? UnlinkPhase.join : UnlinkPhase.joinWait;
      case UnlinkStage.done:
        return UnlinkPhase.result;
    }
  }
  final last = st.last;
  if (last != null && last.id != s.dismissedId) return UnlinkPhase.result;
  return canStart ? UnlinkPhase.start : UnlinkPhase.idle;
}

/// The side whose sheet this phone shows: the one being edited again, else the first of its sides that has not
/// agreed yet; null when there is none (every side of this phone agreed, or this phone answers for none).
UnlinkSide? unlinkSideToAnswer(UnlinkView session, UnlinkSide? editing) {
  final mine = session.mine;
  if (editing != null && mine.contains(editing)) return editing;
  for (final side in mine) {
    if (!session.sideView(side).agreed) return side;
  }
  return null;
}

/// How often the box is asked while the screen is open.
final unlinkPollEveryProvider = Provider<Duration>((ref) => const Duration(seconds: 2));

/// The unlink routes of the box this phone talks to; null while locked.
final unlinkApiProvider = Provider<UnlinkApi?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  return gateway == null ? null : BoxUnlinkApi(boxCallOf(gateway));
});

/// The data kept after an unlink, for the line on the screens list. Empty for a person who may not manage devices, for
/// a box that does not answer and for a follower box: the line is a hint, it never blocks the list.
final unlinkKeptProvider = FutureProvider.autoDispose<List<UnlinkKept>>((ref) async {
  final api = ref.watch(unlinkApiProvider);
  if (api == null || !canSee(ref.watch(rolesProvider), 'devices:manage')) return const <UnlinkKept>[];
  try {
    return (await api.status()).kept;
  } on Object {
    return const <UnlinkKept>[];
  }
});

/// The result id the person dismissed, kept for one run of the app.
final unlinkDismissedProvider = NotifierProvider<UnlinkDismissed, String?>(UnlinkDismissed.new);

class UnlinkDismissed extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String id) => state = id;
}

/// Joins the follower with the pointer of the unlink: the 2C move flow's `connect` (new device key, ticket, new PIN).
/// The new enrolment is returned, not yet adopted; the screen adopts it on "Teruskan".
typedef UnlinkJoinRunner = Future<EnrolledBox> Function(MovePointer pointer, String newPin, String deviceName);

/// Whether this run is the web app (a browser cannot join the follower directly); a seam for the tests.
final unlinkIsWebProvider = Provider<bool>((ref) => kIsWeb);

final unlinkJoinProvider = Provider<UnlinkJoinRunner>((ref) {
  return (pointer, newPin, deviceName) async {
    final deps = ref.read(appDepsProvider);
    final box = ref.read(enrolledBoxProvider);
    final client = await ref.read(enrolledClientProvider.future);
    if (box == null || client == null) throw const MoveAway();
    final flow = MoveFlow(
      box: box,
      oldClient: client,
      key: deps.key,
      trust: deps.trust,
      clientFor: deps.clientFor,
      store: deps.boxStore,
      platform: deps.platform,
    );
    final out = await flow.connect(pointer, newPin: newPin, deviceName: deviceName);
    return out.box;
  };
});

final unlinkControllerProvider = NotifierProvider.autoDispose<UnlinkController, UnlinkState>(UnlinkController.new);

class UnlinkController extends Notifier<UnlinkState> {
  Timer? _timer;
  bool _polling = false;
  int? _seenRev;
  String? _seenSession;

  UnlinkApi? get _api => ref.read(unlinkApiProvider);

  /// Whether this admin's requests need a PIN (the app lock is on).
  bool get pinRequired => ref.read(appLockProvider);

  @override
  UnlinkState build() {
    ref.onDispose(() => _timer?.cancel());
    unawaited(Future<void>.microtask(refresh));
    return UnlinkState(dismissedId: ref.read(unlinkDismissedProvider));
  }

  /// Asks the box every [unlinkPollEveryProvider] until [stopPolling]; the screen that shows the flow owns this.
  void startPolling() {
    _timer?.cancel();
    _timer = Timer.periodic(ref.read(unlinkPollEveryProvider), (_) => unawaited(refresh()));
  }

  void stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  /// One poll. Never throws; a poll in flight, or an action in flight, makes this one wait for the next tick.
  Future<void> refresh() async {
    final api = _api;
    if (api == null || _polling || state.busy || !ref.mounted) return;
    _polling = true;
    try {
      _apply(await api.status());
    } on BoxUnreachable {
      if (ref.mounted) state = state.copyWith(unreachable: true);
    } on LinkRefusal catch (e) {
      if (ref.mounted) state = state.copyWith(unreachable: false, error: e.code);
    } on SessionExpired {
      _timer?.cancel();
    } on FormatException {
      if (ref.mounted) state = state.copyWith(unreachable: false, unreadable: true);
    } on TypeError {
      if (ref.mounted) state = state.copyWith(unreachable: false, unreadable: true);
    } finally {
      _polling = false;
    }
  }

  /// Takes a status answer: the revision watch (another admin's change raises the notice), the flags cleared.
  void _apply(UnlinkStatus st, {bool ownWrite = false}) {
    final session = st.session;
    var stale = state.staleNotice;
    if (session == null || session.id != _seenSession) {
      _seenRev = null;
      _seenSession = session?.id;
      stale = false;
    }
    if (session != null) {
      if (_seenRev != null && session.rev != _seenRev && !ownWrite) stale = true;
      _seenRev = session.rev;
      // Agreeing to the revision on the screen answers the notice.
      if (session.mine.any((side) => session.sideView(side).agreed)) stale = false;
    }
    var editing = state.editing;
    if (session == null || (editing != null && !session.mine.contains(editing))) editing = null;
    state = state.copyWith(status: st, unreachable: false, unreadable: false, staleNotice: stale, editing: editing);
  }

  /// One action. [call] returns the new status, or null for a route that answers without one (the next poll, run
  /// here at once, reads the state). Returns the refusal code, or null when the box accepted.
  Future<String?> _act(Future<UnlinkStatus?> Function(UnlinkApi api) call) async {
    final api = _api;
    if (api == null) return 'unreachable';
    if (state.busy) return null;
    state = state.copyWith(busy: true, error: null);
    try {
      final st = await call(api);
      if (!ref.mounted) return null;
      if (st != null) _apply(st, ownWrite: true);
      state = state.copyWith(busy: false);
      if (st == null) await refresh();
      return null;
    } on LinkRefusal catch (e) {
      if (!ref.mounted) return e.code;
      state = state.copyWith(busy: false, error: e.code);
      if (e.code == 'stale_revision' || e.code == 'stale_session') {
        state = state.copyWith(staleNotice: true, error: null);
        _seenRev = null;
        unawaited(refresh());
        return null;
      }
      if (e.code == 'no_session' || e.code == 'unlink_open' || e.code == 'not_allowed_to_answer') unawaited(refresh());
      return e.code;
    } on BoxUnreachable {
      if (ref.mounted) state = state.copyWith(busy: false, unreachable: true, error: 'unreachable');
      return 'unreachable';
    } on SessionExpired {
      if (ref.mounted) state = state.copyWith(busy: false);
      _timer?.cancel();
      return 'no_session';
    } on FormatException {
      if (ref.mounted) state = state.copyWith(busy: false, unreadable: true);
      return 'unknown';
    } on TypeError {
      if (ref.mounted) state = state.copyWith(busy: false, unreadable: true);
      return 'unknown';
    }
  }

  String? _pinOrNull(String? pin) => pinRequired ? pin : null;

  /// "Mula": opens the unlink of the follower [deviceId]. The PIN only when the app lock is on.
  Future<String?> start(String deviceId, String? pin) => _act((api) => api.start(deviceId: deviceId, pin: _pinOrNull(pin)));

  /// A choice of [side]. Any answer clears every agreement at the box.
  Future<String?> choose(UnlinkSide side, UnlinkChoice choice) {
    final v = state.status?.session?.sideView(side);
    return _answer(side, choice, removePeople: choice == UnlinkChoice.carryOn && side == UnlinkSide.master ? (v?.removePeople ?? false) : null);
  }

  /// The people switch of the master side ("Buang pengguna yang datang dari ...").
  Future<String?> setRemovePeople(bool on) {
    final v = state.status?.session?.master;
    if (v == null || v.choice != UnlinkChoice.carryOn) return Future<String?>.value(null);
    return _answer(UnlinkSide.master, UnlinkChoice.carryOn, removePeople: on);
  }

  /// The finance tick of the follower's `carry-on`.
  Future<String?> setFinanceTick(bool on) {
    final v = state.status?.session?.follower;
    if (v == null || v.choice != UnlinkChoice.carryOn) return Future<String?>.value(null);
    return _answer(UnlinkSide.follower, UnlinkChoice.carryOn, financeTick: on);
  }

  Future<String?> _answer(UnlinkSide side, UnlinkChoice choice, {bool? removePeople, bool? financeTick}) {
    // The box holds the tick: a change of choice sends the one it holds, a change of the tick sends the new one.
    final held = state.status?.session?.sideView(side).financeTick;
    final tick = financeTick ?? (side == UnlinkSide.follower && choice == UnlinkChoice.carryOn ? held : null);
    return _act(
      (api) => api.answer(side: side, choice: choice, removePeople: removePeople, financeTick: tick),
    );
  }

  /// "Setuju" for [side] on the revision on show. [confirm] is true after the typed word matched in the sheet.
  Future<String?> agree(UnlinkSide side, {bool confirm = false, String? pin}) {
    final rev = state.status?.session?.rev;
    if (rev == null) return Future<String?>.value('no_session');
    return _act((api) => api.agree(side: side, rev: rev, confirm: confirm, pin: _pinOrNull(pin)));
  }

  /// "Ubah jawapan": the sheet of [side] again.
  void edit(UnlinkSide side) => state = state.copyWith(editing: side, error: null);

  /// "Batal": ends the session until the work started.
  Future<String?> cancel() => _act((api) async {
    await api.cancel();
    return null;
  });

  /// "Tukar pilihan" for the kept data of [side]; the answer is a new session (a short work run).
  Future<String?> switchChoice(UnlinkSide side, String? pin) => _act((api) => api.switchChoice(side: side, pin: _pinOrNull(pin)));

  /// "Buang data lama" for [side].
  Future<String?> dropKept(UnlinkSide side, String? pin) => _act((api) async {
    await api.dropKept(side: side, pin: _pinOrNull(pin));
    return null;
  });

  /// "Selesai" on a result.
  void dismissResult() {
    final id = state.status?.last?.id;
    if (id == null) return;
    ref.read(unlinkDismissedProvider.notifier).set(id);
    state = state.copyWith(dismissedId: id, error: null);
  }

  void clearError() => state = state.copyWith(error: null);

  void acknowledgeStale() => state = state.copyWith(staleNotice: false);
}
