// Web only: the address a join ticket arrived in. The ticket of an unlink travels in the URL fragment
// (`/app/#/enrol?join=surau1:...`), which a browser never sends to a server. The enrol page reads it once and this
// removes it from the address bar and the history entry, so it is not left in a bookmark, a screenshot or a share.

import 'join_address_stub.dart' if (dart.library.js_interop) 'join_address_web.dart' as platform;

/// The query key the join text rides under.
const String joinQueryKey = 'join';

/// Replaces the current address with the plain enrol page (history replace, no new entry). Does nothing on native.
void scrubJoinAddress() => platform.scrubJoinAddress();

/// The join text in the fragment of a web address (`/enrol?join=surau1:...`), or null.
String? joinFromFragment(String fragment) {
  if (!fragment.contains('$joinQueryKey=')) return null;
  try {
    final v = Uri.parse(fragment.startsWith('/') ? fragment : '/$fragment').queryParameters[joinQueryKey];
    return v == null || v.isEmpty ? null : v;
  } on FormatException {
    return null;
  }
}

String? _held;

/// The join text taken from the address at app start, kept in memory for the enrol page; null when none.
String? get heldJoinText => _held;

/// Forgets the held join text (the enrolment used it, or it is not wanted).
void clearHeldJoin() => _held = null;

/// At app start, for ANY route: when [fragment] carries a join ticket, keeps it in memory and calls [scrub] so it does
/// not stay in the address bar, the history or a bookmark, even if the guard sends the page somewhere else.
void captureJoinFrom(String fragment, void Function() scrub) {
  final v = joinFromFragment(fragment);
  if (v == null) return;
  _held = v;
  scrub();
}

/// [captureJoinFrom] for the address this page was opened at. Does nothing on native.
void captureAndScrubJoinAddress() => captureJoinFrom(platform.currentFragment(), scrubJoinAddress);
