// The surau-level live notice the box keeps (release 2026.11.13, W6): created
// when a YouTube live starts, whichever device started it, shared by every
// holder of `live:control`, ended with the live. This file reads it
// (`GET /api/live/notice`), saves the edited text (`PATCH /api/live/notice`)
// and fetches its still frame (`GET /api/live/notice/frame.jpg`).
//
// An older box has no such route: every read here then answers null and the
// screens fall back to the notice built on the device (live_notice.dart), no
// frame, the kuliah card made on the device. The answer is parsed defensively: anything that is
// not a valid public watch link is no notice.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../people/phone.dart' show isE164;
import '../shell/box_gateway.dart';
import '../shell/permissions.dart';
import 'live_controller.dart' show liveBoxProvider;
import 'live_notice.dart';

/// The kuliah a box notice names (all fields may be missing).
class BoxNoticeKuliah {
  const BoxNoticeKuliah({this.title, this.speaker, this.time});

  final String? title;
  final String? speaker;

  /// `HH:MM`, local time of the surau.
  final String? time;
}

/// One answer of `GET /api/live/notice` with `active: true`.
class BoxLiveNotice {
  const BoxLiveNotice({
    required this.videoId,
    this.kuliah,
    this.editedText,
    this.editedBy,
    this.editedAt,
    this.startedAt,
    this.frame = false,
  });

  final String videoId;
  final BoxNoticeKuliah? kuliah;

  /// The text an admin changed; null while the original stands.
  final String? editedText;
  final String? editedBy;
  final DateTime? editedAt;
  final DateTime? startedAt;

  /// The box can give a still frame of the live.
  final bool frame;

  /// Null for `{"active": false}`, a missing or malformed body and any watch
  /// link that is not a public YouTube link.
  static BoxLiveNotice? fromJson(Object? j) {
    if (j is! Map || j['active'] != true) return null;
    String? str(Object? v, [int max = 1000]) => v is String && v.trim().isNotEmpty && v.length <= max ? v : null;
    final id = isLiveVideoId(j['videoId'] as String?)
        ? j['videoId'] as String
        : liveNoticeVideoId(j['watchUrl'] is String ? j['watchUrl'] as String : null);
    if (id == null) return null;
    final k = j['kuliah'];
    return BoxLiveNotice(
      videoId: id,
      kuliah: k is Map
          ? BoxNoticeKuliah(title: str(k['title'], 200), speaker: str(k['speaker'], 200), time: str(k['time'], 5))
          : null,
      editedText: str(j['editedText'], 1000),
      editedBy: str(j['editedBy'], 200),
      editedAt: j['editedAt'] is String ? DateTime.tryParse(j['editedAt'] as String) : null,
      startedAt: j['startedAt'] is String ? DateTime.tryParse(j['startedAt'] as String) : null,
      frame: j['frame'] == true,
    );
  }

  /// What the original sentence is built from: the kuliah's title (as the
  /// label), its speaker and today's start time.
  LiveNoticeInput toInput({String? surau, DateTime? today}) {
    DateTime? start;
    final t = kuliah?.time;
    final m = t == null ? null : RegExp(r'^(\d{2}):(\d{2})$').firstMatch(t);
    if (m != null && today != null) {
      start = DateTime(today.year, today.month, today.day, int.parse(m.group(1)!), int.parse(m.group(2)!));
    }
    return LiveNoticeInput(
      videoId: videoId,
      label: kuliah?.title,
      speaker: kuliah?.speaker,
      start: start,
      surau: surau,
    );
  }
}

/// The live notice of the box now; null when there is none, the person
/// cannot control the live, or the box is older than this route.
final liveBoxNoticeProvider = FutureProvider<BoxLiveNotice?>((ref) async {
  ref.watch(dataVersionProvider);
  // someone edited the text: the notice is read again
  ref.watch(liveBoxProvider.select((b) => b.noticeRev));
  // a session opened or ended (here or on another device): the notice is read again
  ref.watch(liveBoxProvider.select((b) => b.sessionId != null || b.otherLive != null));
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null || !can(ref.watch(rolesProvider), 'live:control')) return null;
  try {
    final notice = BoxLiveNotice.fromJson(await gateway.getFresh('/api/live/notice'));
    if (notice == null) return null;
    // The notice follows the BOX's live session: when the session is over the banner and the share buttons go, even
    // if YouTube still says the broadcast is live. A status that does not answer, or does not say, keeps the notice.
    // While this device's own live is running or starting (the controller holds its session id) a momentary
    // `session: null` is a race with the box, not the end: the notice is kept.
    if (ref.read(liveBoxProvider).sessionId == null) {
      final over = await _boxSessionOver(gateway);
      if (over == true) return null;
      // The banner follows the box (B13): while it is shown, a slow poll of the box's status stays alive, so it
      // goes within one poll after the live ends. A read that failed is tried again by the same poll instead of
      // leaving the banner up for good.
      _watchForEnd(ref);
    }
    return notice;
  } on Object {
    return null;
  }
});

/// How often the dashboard banner asks the box whether the live is still on.
final liveNoticePollIntervalProvider = Provider<Duration>((_) => const Duration(seconds: 10));

/// One slow look at the box while the notice is shown outside the Live tab: the provider is read again, which
/// drops the notice once the box says the session is over.
///
/// Only while something shows the notice: with no listener left the timer is dropped, and a listener that comes
/// back reads the box again at once.
void _watchForEnd(Ref ref) {
  final timer = Timer(ref.read(liveNoticePollIntervalProvider), () {
    if (ref.mounted) ref.invalidateSelf();
  });
  var dropped = false;
  ref.onDispose(timer.cancel);
  ref.onCancel(() {
    dropped = timer.isActive;
    timer.cancel();
  });
  ref.onResume(() {
    if (dropped && ref.mounted) ref.invalidateSelf();
  });
}

/// True when `GET /api/live/status` answers with `session: null` (no live session on the box), false when it
/// names a session, null when the read failed or does not say.
Future<bool?> _boxSessionOver(BoxGateway gateway) async {
  try {
    final status = await gateway.getFresh('/api/live/status', quiet: () => true);
    if (!status.containsKey('session')) return null;
    return status['session'] == null;
  } on Object {
    return null;
  }
}

/// Saves [text] as the notice's edited text, or null for "back to the
/// original". Returns false when the box did not take it (an older box, no
/// box); the sheet then keeps the text on this device only. [onNotice] gets
/// the notice the box answers with (who edited, when).
Future<bool> saveLiveNoticeText(BoxGateway? gateway, String? text, {void Function(BoxLiveNotice)? onNotice}) async {
  if (gateway == null) return false;
  try {
    final body = await gateway.patch('/api/live/notice', {'editedText': text});
    final n = BoxLiveNotice.fromJson(body);
    if (n != null) onNotice?.call(n);
    return true;
  } on Object {
    return false;
  }
}

/// The still frame of the live from the box, or null (no frame, 404, an older
/// box). Never cached on the device.
Future<Uint8List?> fetchBoxNoticeFrame(BoxGateway? gateway) async {
  if (gateway == null) return null;
  try {
    final b = await gateway.getBytes('/api/live/notice/frame.jpg');
    return b.isEmpty ? null : b;
  } on Object {
    return null;
  }
}

/// The signed-in person's own phone number (E.164) from their profile, or
/// null. `GET /api/auth/me` first (a box that carries `user.phone`), else the
/// person's own row of `GET /api/users` when they may read it.
final liveNoticeOwnPhoneProvider = FutureProvider<String?>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  final me = ref.watch(sessionProvider)?.user;
  if (gateway == null || me == null) return null;
  try {
    final body = await gateway.getFresh('/api/auth/me');
    final u = body['user'];
    if (u is Map && u['phone'] is String && isE164(u['phone'] as String)) return u['phone'] as String;
  } on Object {
    // fall through to the user list
  }
  if (!can(ref.watch(rolesProvider), 'users:manage')) return null;
  try {
    final body = await gateway.getFresh('/api/users');
    for (final u in (body['users'] as List? ?? const [])) {
      if (u is Map && u['id'] == me.id && u['phone'] is String && isE164(u['phone'] as String)) {
        return u['phone'] as String;
      }
    }
  } on Object {
    return null;
  }
  return null;
});
