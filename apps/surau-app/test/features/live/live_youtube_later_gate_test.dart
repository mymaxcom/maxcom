// The gate of "Siarkan ke YouTube" (2026.11.15 build 5): every input that changes the answer.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/live_controller.dart' show YoutubeAccountPhase;
import 'package:surau_app/features/live/live_youtube_later_gate.dart';

YoutubeLaterGate _gate({
  bool sessionOpen = true,
  bool own = true,
  bool readOnly = false,
  bool youtubeFeature = true,
  bool youtubeOn = false,
  YoutubeAccountPhase phase = YoutubeAccountPhase.signedIn,
  bool boxReachable = true,
  bool stopping = false,
}) => youtubeLaterGate(
  sessionOpen: sessionOpen,
  own: own,
  readOnly: readOnly,
  youtubeFeature: youtubeFeature,
  youtubeOn: youtubeOn,
  accountPhase: phase,
  boxReachable: boxReachable,
  stopping: stopping,
);

void main() {
  test('the starter of an open live without YouTube, signed in: ok', () {
    expect(_gate(), YoutubeLaterGate.ok);
  });

  test('an account that is still unknown passes: the box is the judge', () {
    expect(_gate(phase: YoutubeAccountPhase.unknown), YoutubeLaterGate.ok);
  });

  test('a signed out or signing in account gives the reason, not a hidden button', () {
    expect(_gate(phase: YoutubeAccountPhase.signedOut), YoutubeLaterGate.notSignedIn);
    expect(_gate(phase: YoutubeAccountPhase.signingIn), YoutubeLaterGate.notSignedIn);
  });

  test('a box that cannot be reached gives its reason, also for a signed out account', () {
    expect(_gate(boxReachable: false), YoutubeLaterGate.unreachable);
    expect(_gate(boxReachable: false, phase: YoutubeAccountPhase.signedOut), YoutubeLaterGate.unreachable);
  });

  test('another device\'s live says only the starter may add YouTube', () {
    expect(_gate(own: false, readOnly: true), YoutubeLaterGate.notStarter);
    expect(_gate(readOnly: true), YoutubeLaterGate.notStarter);
  });

  test('hidden: no session, feature off, YouTube already on, or the live is ending', () {
    expect(_gate(sessionOpen: false), YoutubeLaterGate.hidden);
    expect(_gate(youtubeFeature: false), YoutubeLaterGate.hidden);
    expect(_gate(youtubeOn: true), YoutubeLaterGate.hidden);
    expect(_gate(stopping: true), YoutubeLaterGate.hidden);
    // hidden wins over the reason lines
    expect(_gate(readOnly: true, youtubeOn: true), YoutubeLaterGate.hidden);
    expect(_gate(boxReachable: false, stopping: true), YoutubeLaterGate.hidden);
  });

  test('a session that is not this device\'s and not another device\'s live shows nothing', () {
    expect(_gate(own: false), YoutubeLaterGate.hidden);
  });
}
