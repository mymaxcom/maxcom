// The seam the app and the Android engine share for "my live survived the
// screen" (2026.11.15 revamp, frozen in Lane 0): a publisher that keeps the
// session facts answers LiveSessionHolder.status().

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/publisher.dart';

class _Holder implements LiveSessionHolder {
  PublisherSession? held;

  @override
  Future<PublisherSession?> status() async => held;
}

void main() {
  test('an idle engine holds no session', () async {
    expect(await _Holder().status(), isNull);
  });

  test('a running engine reports the session it still holds', () async {
    final started = DateTime.utc(2026, 11, 22, 12);
    final holder = _Holder()
      ..held = PublisherSession(
        sessionId: 'S1',
        startedAt: started,
        streaming: true,
        youtube: true,
        video: VideoSourceKind.external,
        recordings: const ['MAXCOM-1.mp4'],
      );
    final s = (await holder.status())!;
    expect(s.sessionId, 'S1');
    expect(s.startedAt, started);
    expect(s.streaming, isTrue);
    expect(s.youtube, isTrue);
    expect(s.video, VideoSourceKind.external);
    expect(s.recordings, ['MAXCOM-1.mp4']);
  });

  test('the defaults are a phone-camera live with no YouTube leg and no recording', () {
    final s = PublisherSession(
      sessionId: 'S2',
      startedAt: DateTime.utc(2026, 11, 22, 13),
      streaming: false,
    );
    expect(s.youtube, isFalse);
    expect(s.video, VideoSourceKind.phone);
    expect(s.recordings, isEmpty);
    // never a key, a passphrase or an address in the text form
    expect(s.toString(), 'PublisherSession(S2, streaming: false)');
  });
}
