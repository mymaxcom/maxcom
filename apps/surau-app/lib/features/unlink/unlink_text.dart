// The words of the unlink screens: a refusal code in the person's language, the names of the work's steps, the lines
// under a choice. Every sentence is in the catalogues (S); a code this app does not know (a newer box) gets the link
// flow's one generic sentence, never the box's own text.

import '../../app/app_lang.dart';
import '../../l10n/generated/s.dart';
import '../link/link_text.dart';
import 'unlink_models.dart';

/// A refusal code of the unlink routes (or a link code they share), as a sentence.
String unlinkCodeText(S s, String code) => switch (code) {
  'unlink_open' => s.unlinkCodeOpen,
  'not_linked' => s.unlinkCodeNotLinked,
  'not_allowed_to_answer' => s.unlinkCodeNotAllowed,
  'same_phone' => s.unlinkCodeSamePhone,
  'option_unavailable' => s.unlinkCodeOptionUnavailable,
  'stale_session' => s.unlinkCodeStaleSession,
  'kept_window_over' => s.unlinkCodeKeptOver,
  'no_kept_data' => s.unlinkCodeNoKept,
  'not_local' => s.unlinkCodeNotLocal,
  'wrong_code' => s.unlinkCodeWrongCode,
  'has_backup' => s.unlinkCodeHasBackup,
  // `no_backup`, `lan_only`, `pin_required`, `wrong_pin`, `locked`, `live_on`, `linking`, `stale_revision`,
  // `finance_tick`, `confirm_required`, the session outcomes and the rest are worded by the link flow.
  _ => linkCodeText(s, code),
};

/// "menyalin data": the name of a step of the work (`progress.step`).
String unlinkStepName(S s, UnlinkStep step) => switch (step) {
  UnlinkStep.copy => s.unlinkStepCopy,
  UnlinkStep.back => s.unlinkStepBack,
  UnlinkStep.carryOn => s.unlinkStepCarryOn,
  UnlinkStep.empty => s.unlinkStepEmpty,
  UnlinkStep.join => s.unlinkStepJoin,
};

/// The list of names of a line, joined with the language's comma.
String unlinkNames(S s, List<String> names) => names.join(linkComma(s));

/// The sentence of what the box does with its YouTube sign-in.
String unlinkYoutubeText(S s, UnlinkYoutube y) => switch (y) {
  UnlinkYoutube.kept => s.unlinkYoutubeKept,
  UnlinkYoutube.returns => s.unlinkYoutubeReturns,
  UnlinkYoutube.signInAgain => s.unlinkYoutubeSignIn,
  UnlinkYoutube.none => s.unlinkYoutubeNone,
};

/// A date of the sheet as `20 Nov 2026`, in the language of the app.
String unlinkDate(DateTime local, AppLang lang) => linkDateWords(local, lang);
