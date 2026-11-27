// The words of the link flow: a refusal code or a session outcome in the person's language, the step names of the
// work, a box's hardware and numbers. Every sentence is in the catalogues (S); a code this app does not know (a newer
// box) gets one generic sentence, never the box's own text.

import '../../app/app_lang.dart';
import '../../content/kinds.dart' show dateTimeWords, dateWords, timeWords;
import '../../l10n/generated/s.dart';
import 'link_models.dart';

/// A refusal code of the link routes, or a session outcome, as a sentence.
String linkCodeText(S s, String code) => switch (code) {
  'lan_only' => s.linkCheckLan,
  'pin_required' => s.linkCodePinRequired,
  'wrong_pin' => s.linkCodeWrongPin,
  'locked' => s.linkCodeLocked,
  'no_session' => s.errorSessionExpired,
  'wrong_step' => s.linkCodeWrongStep,
  'wrong_side' => s.linkCodeWrongSide,
  'session_open' => s.linkCodeSessionOpen,
  'live_on' => s.linkCheckLive,
  'follower' => s.linkCheckFollower,
  'no_https' => s.linkCodeNoHttps,
  'link_locked' => s.linkCodeLinkLocked,
  'bad_qr' => s.linkCodeBadQr,
  'same_box' => s.linkCodeSameBox,
  'code_used' => s.linkCodeCodeUsed,
  'code_expired' => s.linkCodeCodeExpired,
  'peer_unreachable' => s.linkCodePeerUnreachable,
  'peer_refused' => s.linkCodePeerRefused,
  'bad_hello' => s.linkCodeBadHello,
  'version' || 'protocol' || 'db_level' => s.linkCodeVersion,
  'both_have_followers' => s.linkCodeBothHaveFollowers,
  'both_new' => s.linkCodeBothNew,
  'fixed_answer' => s.linkCodeFixedAnswer,
  'keep_new_box' => s.linkCodeKeepNewBox,
  'finance_tick' => s.linkCodeFinanceTick,
  'people_answer' => s.linkCodePeopleAnswer,
  'stale_revision' => s.linkStaleNotice,
  'rejected' => s.linkCodeRejected,
  'case_x_unavailable' => s.linkCaseXOff,
  'linking' => s.linkCodeLinking,
  'not_found' => s.linkCodeNotFound,
  'bad_message' => s.linkCodeBadMessage,
  'unreachable' => s.errorBoxUnreachable,
  'has_followers' => s.linkCodeHasFollowers,
  'kept_exists' => s.linkCodeKeptExists,
  'other_volume' => s.linkCodeOtherVolume,
  'confirm_required' => s.linkCodeConfirmRequired,
  'no_backup' => s.linkCodeNoBackup,
  'kept_data' => s.linkCodeKeptDataNoDate,
  // session outcomes
  'failed' => s.linkOutcomeFailed,
  'cancelled' => s.linkOutcomeCancelled,
  'cancelled_by_peer' => s.linkOutcomeCancelledByPeer,
  'rejected_by_peer' => s.linkOutcomeRejectedByPeer,
  'expired' => s.linkOutcomeExpired,
  'approve_timeout' => s.linkOutcomeApproveTimeout,
  'restart' => s.linkOutcomeRestart,
  _ => s.linkCodeUnknown,
};

/// [linkCodeText] for a start that the box refused: `kept_data` names the date when the box said it ([until]).
String linkErrorText(S s, String code, DateTime? until, AppLang lang) =>
    code == 'kept_data' && until != null ? s.linkCodeKeptData(linkDateWords(until, lang)) : linkCodeText(s, code);

/// The session outcome of a result that is not `linked`, as the reason under "Pautan dibatalkan".
String linkOutcomeText(S s, String? outcome) => linkCodeText(s, outcome ?? 'failed');

/// "memindahkan data": the name of a step of the work (`progress.step`).
String linkStepName(S s, String step) => switch (step) {
  'backup' => s.linkStepBackup,
  'people' => s.linkStepPeople,
  'commit' => s.linkStepCommit,
  'finish' => s.linkStepFinish,
  _ => s.linkStepWorking,
};

/// "PC Windows, kabel": what a box runs on and how it is connected.
String linkHardware(S s, LinkFacts f) {
  final device = switch (f.device) {
    LinkDevice.windows => s.linkDeviceWindows,
    LinkDevice.android => s.linkDeviceAndroid,
    LinkDevice.other => s.linkDeviceOther,
  };
  final conn = switch (f.wired) {
    true => s.linkConnCable,
    false => s.linkConnWifi,
    null => null,
  };
  return conn == null ? device : '$device${linkComma(s)}$conn';
}

/// `1.8 GB` or `640 MB`: free storage in words (digits stay 0-9 in every language).
String linkBytesWords(int bytes) {
  const gb = 1024 * 1024 * 1024;
  if (bytes >= gb) {
    final v = bytes / gb;
    return '${v >= 10 ? v.round() : (v * 10).round() / 10} GB';
  }
  return '${(bytes / (1024 * 1024)).round()} MB';
}

/// The date of the last edit as `20 Nov 2026`; empty when the box has no edit.
String linkDateWords(DateTime? local, AppLang lang) {
  if (local == null) return '';
  return dateWords(_isoDate(local), lang, weekday: false);
}

/// The phone's time now as `Jumaat, 20 Nov 2026, 9:41 malam` (the backup line).
String linkNowWords(DateTime local, AppLang lang) => dateTimeWords(_isoDateTime(local), lang);

/// `20 Nov 2026, 9:41 malam`: a moment of the backup line, without the weekday.
String linkDateTimeWords(DateTime local, AppLang lang) =>
    '${linkDateWords(local, lang)}${lang == AppLang.ar ? '، ' : ', '}${timeWords('${_two(local.hour)}:${_two(local.minute)}', lang)}';

/// The list comma of the language ('، ' in Arabic).
String linkComma(S s) => s.localeName == 'ar' ? '، ' : ', ';

/// `4:52` for a countdown of [d] (never negative).
String linkCountdown(Duration d) {
  final secs = d.isNegative ? 0 : d.inSeconds;
  return '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}';
}

/// `482 193` from `482193`.
String linkCodeGroups(String code) => code.length == 6 ? '${code.substring(0, 3)} ${code.substring(3)}' : code;

String _two(int n) => n.toString().padLeft(2, '0');
String _isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${_two(d.month)}-${_two(d.day)}';
String _isoDateTime(DateTime d) => '${_isoDate(d)}T${_two(d.hour)}:${_two(d.minute)}';
