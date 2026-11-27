// Whether "Siarkan ke YouTube" (adding YouTube to a live that started without it) may be pressed (2026.11.15 build 5).
//
// One pure function with no widget and no provider, so every input that changes the answer is a table row in a test.
// The button itself is drawn for every answer except [YoutubeLaterGate.hidden]; it is enabled only for
// [YoutubeLaterGate.ok], and the other answers give the reason line under it.

import 'live_controller.dart' show YoutubeAccountPhase;

/// The answer of [youtubeLaterGate].
enum YoutubeLaterGate {
  /// The button is enabled.
  ok,

  /// Nothing is drawn: no open live, the feature is off, YouTube is already on, or the live is ending.
  hidden,

  /// Another device started this live; only the starter (or a holder of settings:write) may add YouTube.
  notStarter,

  /// The box says YouTube is signed out on the MAXCOM.
  notSignedIn,

  /// The last look at the box failed.
  unreachable,
}

/// [sessionOpen]: the box has an open session (this device's own or another device's). [own]: the live is this
/// device's (its engine is live, or it holds its own box-pulled session). [readOnly]: the live belongs to another
/// device. [youtubeOn]: the running session already sends to YouTube.
///
/// An account that is `signedIn` OR `unknown` passes: the status poll cannot tell an unread account from a signed out
/// one, and the box is the judge (it refuses with `not_signed_in`, which the app already has words for).
YoutubeLaterGate youtubeLaterGate({
  required bool sessionOpen,
  required bool own,
  required bool readOnly,
  required bool youtubeFeature,
  required bool youtubeOn,
  required YoutubeAccountPhase accountPhase,
  required bool boxReachable,
  required bool stopping,
}) {
  if (!sessionOpen || !youtubeFeature || youtubeOn || stopping) return YoutubeLaterGate.hidden;
  if (readOnly) return YoutubeLaterGate.notStarter;
  if (!own) return YoutubeLaterGate.hidden;
  if (!boxReachable) return YoutubeLaterGate.unreachable;
  return switch (accountPhase) {
    YoutubeAccountPhase.signedIn || YoutubeAccountPhase.unknown => YoutubeLaterGate.ok,
    YoutubeAccountPhase.signedOut || YoutubeAccountPhase.signingIn => YoutubeLaterGate.notSignedIn,
  };
}
