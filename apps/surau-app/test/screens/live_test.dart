// The Live tab (Plan 5 Task 7) over the realistic box and a fake
// publisher: today's kuliah pre-selected, `Mula siaran` with the YouTube
// toggle, the reasons YouTube is off, a retrying leg, the stop confirm
// and summary, and the six goldens at the three sizes.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/providers.dart' show settingsProvider;
import 'package:surau_app/features/common/bidi.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_notice_box.dart' show liveBoxNoticeProvider;
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/live/live_widgets.dart';
import 'package:surau_app/features/live/publisher.dart';

import '../features/fakes.dart' show jsonResponse;
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

const _signedIn = LiveBoxStatus(
  youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
);

class _Live {
  _Live(this.h, this.pub);

  final ShellHarness h;
  final FakePublisher pub;

  LiveBoxNotifier get box => h.container.read(liveBoxProvider.notifier);

  bool get folded => h.container.read(liveFoldedProvider);

  /// The user opens the settings again (the icon, same notifier).
  void unfold() => h.container.read(liveFoldedProvider.notifier).set(false);
}

/// The surau's Isyak kuliah tonight is on (the fixture has it cancelled).
void _isyakTonight(ShellHarness h) {
  final k = h.content['kuliah']!;
  final i = k.indexWhere((x) => x['id'] == 'c3');
  k[i] = {
    ...k[i],
    'status': 'aktif',
    'kitabId': 'k1',
    'topic': 'Sabar ketika diuji',
  };
}

Future<_Live> _open(
  WidgetTester tester, {
  List<String> roles = const ['live'],
  LiveBoxStatus box = _signedIn,
  bool tonight = true,
}) async {
  final pub = FakePublisher();
  final h = await pumpShell(
    tester,
    roles: roles,
    overrides: [
      livePublisherProvider.overrideWithValue(pub),
      liveBoxProvider.overrideWith(() => LiveBoxNotifier(box)),
    ],
  );
  if (tonight) _isyakTonight(h);
  h.router.go('/live');
  await settle(tester);
  return _Live(h, pub);
}

Finder get _start => find.byKey(const ValueKey('live-start'));
Finder get _stop => find.byKey(const ValueKey('live-stop'));
/// Opens the idle section [key] (`video`, `audio`, `out`, `set`) when it is folded.
Future<void> _openSection(WidgetTester tester, String key) async {
  final body = find.byKey(ValueKey('live-section-$key'));
  await reveal(tester, body);
  final head = find.byKey(ValueKey('live-section-$key-head'));
  await tester.ensureVisible(head);
  await tester.tap(head);
  await settle(tester);
}

Finder get _youtubeChip => find.byKey(const ValueKey('live-dest-youtube'));

bool _chipTappable(WidgetTester tester) =>
    tester.widget<InkWell>(find.descendant(of: _youtubeChip, matching: find.byType(InkWell))).onTap != null;

PublisherState _running({
  OutputState youtube = OutputState.up,
  Set<Warning> warnings = const {},
  int duration = 1421,
}) => PublisherState(
  phase: PublisherPhase.live,
  outputs: PublisherOutputs(kiosk: OutputState.up, youtube: youtube),
  recording: const RecordingState(on: true, segments: 2, bytes: 1395864371),
  stats: const StreamStats(bitrateKbps: 2450, fps: 30, rttMs: 18),
  warnings: warnings,
  durationSec: duration,
);

const _blocked =
    'Port media disekat oleh firewall komputer MAXCOM. Video tidak sampai '
    'ke kiosk atau YouTube. Jalankan pemasangan sebagai pentadbir.';
const _noVideo =
    'Video belum sampai ke MAXCOM. Semak Wi-Fi telefon dan komputer MAXCOM '
    'berada pada rangkaian yang sama.';

class _RetryProbe extends LiveBoxNotifier {
  _RetryProbe(super.initial);

  int retries = 0;

  @override
  Future<void> retryStop() async => retries++;
}

void main() {
  testWidgets('[L2] a live-only role sees Stop for its own live that has not '
      'stopped on the box, and no "another device" notice', (tester) async {
    final probe = _RetryProbe(
      _signedIn.copyWith(
        sessionId: 's1',
        stopFailed: true,
        notice: 'Siaran belum berhenti. Cuba lagi.',
      ),
    );
    final pub = FakePublisher();
    final h = await pumpShell(
      tester,
      roles: const ['live'],
      overrides: [
        livePublisherProvider.overrideWithValue(pub),
        liveBoxProvider.overrideWith(() => probe),
      ],
    );
    h.router.go('/live');
    await settle(tester);
    final retry = find.byKey(const ValueKey('live-stop-retry'));
    expect(retry, findsOneWidget);
    expect(find.byKey(const ValueKey('live-other-device')), findsNothing);
    expect(find.text('Siaran belum berhenti. Cuba lagi.'), findsWidgets);
    await tester.ensureVisible(retry);
    await tester.tap(retry);
    await settle(tester);
    expect(probe.retries, 1);
  });

  test('[L5] catch-up files the recording under the publisher\'s own session '
      'id and never guesses the newest unsaved file', () {
    expect(
      catchUpSessionId(web: true, publisherSession: 's-mine', boxSession: 'box1'),
      's-mine',
    );
    expect(
      catchUpSessionId(web: true, publisherSession: null, boxSession: 'box1'),
      isNull,
      reason: 'no guess from an older unsaved file',
    );
    expect(
      catchUpSessionId(web: false, publisherSession: 's-mine', boxSession: 'box1'),
      'box1',
    );
    expect(
      File('lib/features/live/live_screen.dart').readAsStringSync(),
      isNot(contains('_latestRecordingSession')),
    );
  });

  testWidgets('media_ports_blocked shows the firewall banner and the screen '
      'stays usable', (tester) async {
    final t = await _open(
      tester,
      box: const LiveBoxStatus(
        youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
        warnings: {'media_ports_blocked'},
      ),
    );
    expect(find.text(_blocked), findsOneWidget);
    expect(find.text(_noVideo), findsNothing);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started, hasLength(1), reason: 'start is not blocked');
  });

  testWidgets('no_video_from_device shows the no-picture banner', (
    tester,
  ) async {
    await _open(
      tester,
      box: const LiveBoxStatus(
        youtube: YoutubeAccount.signedIn('Surau D\'Waqaf'),
        warnings: {'no_video_from_device'},
      ),
    );
    expect(find.text(_noVideo), findsOneWidget);
    expect(find.text(_blocked), findsNothing);
  });

  testWidgets('a clean status shows neither banner', (tester) async {
    await _open(tester);
    expect(find.text(_blocked), findsNothing);
    expect(find.text(_noVideo), findsNothing);
  });

  testWidgets('today\'s kuliah nearest to now is pre-selected', (tester) async {
    final t = await _open(tester);
    expect(t.h.location, '/live');
    expect(find.text('Siaran langsung'), findsWidgets);
    expect(find.text('Kuliah Isyak'), findsOneWidget);
    expect(find.text('Ustaz Ahmad Fauzi, Sabar ketika diuji'), findsOneWidget);
    expect(
      t.pub.prepared.single.recording,
      isTrue,
      reason: 'recording is on by default',
    );

    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.single.kuliahId, 'c3');
  });

  testWidgets('no kuliah today says so and broadcasts without one', (
    tester,
  ) async {
    final t = await _open(tester, tonight: false);
    expect(find.text('Tiada kuliah hari ini'), findsOneWidget);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.single.kuliahId, isNull);
  });

  testWidgets('the picker offers upcoming kuliah and Tanpa kuliah', (
    tester,
  ) async {
    final t = await _open(tester);
    await tester.tap(find.text('Tukar'));
    await settle(tester);
    expect(find.text('Pilih kuliah'), findsOneWidget);
    expect(find.text('Kuliah Subuh'), findsOneWidget, reason: 'tomorrow');
    expect(find.text('Kuliah Maghrib'), findsOneWidget, reason: 'Friday');
    await tester.tap(find.text('Tanpa kuliah'));
    await settle(tester);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.single.kuliahId, isNull);
  });

  testWidgets('Mula siaran sends YouTube as the toggle says', (tester) async {
    final t = await _open(tester);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.last.outputs.kiosk, isTrue);
    expect(t.pub.started.last.outputs.youtube, isTrue);
  });

  testWidgets('YouTube toggled off is not sent', (tester) async {
    final t = await _open(tester);
    await tester.tap(_youtubeChip);
    await settle(tester);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.last.outputs.youtube, isFalse);
  });

  testWidgets('no internet disables YouTube with the reason', (tester) async {
    final t = await _open(tester, box: _signedIn.copyWith(internet: false));
    await _openSection(tester, 'out');
    expect(find.text('Tiada internet: YouTube dimatikan'), findsOneWidget);
    // the choice is the surau's: a block never greys it
    expect(_chipTappable(tester), isTrue);
    await tester.tap(_start);
    await settle(tester);
    // never TV only silently: the person is asked first
    expect(t.pub.started, isEmpty);
    expect(find.byKey(const ValueKey('live-youtube-ask')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('live-youtube-ask-yes')));
    await settle(tester);
    expect(t.pub.started.last.outputs.youtube, isFalse);
  });

  testWidgets('the YouTube dialog gives the reason without repeating "YouTube:" in BM and English', (tester) async {
    for (final unknown in [false, true]) {
      final t = await _open(
        tester,
        box: unknown
            ? const LiveBoxStatus(youtube: YoutubeAccount.unknown(channel: 'Surau D\'Waqaf'))
            : _signedIn.copyWith(internet: false),
      );
      await tester.tap(_start);
      await settle(tester);
      final body = tester.widget<AlertDialog>(find.byKey(const ValueKey('live-youtube-ask'))).content! as Text;
      final text = body.data!;
      expect(text.startsWith('YouTube tidak dapat digunakan sekarang: '), isTrue);
      expect(text.substring('YouTube'.length).contains('YouTube'), isFalse, reason: text);
      expect(text, contains(unknown ? 'akaun tidak dapat disemak sekarang' : 'tiada internet'));
      if (unknown) expect(text, contains(bidiIsolate('Surau D\'Waqaf')));
      await tester.tap(find.byKey(const ValueKey('live-youtube-ask-cancel')));
      await settle(tester);
      expect(t.pub.started, isEmpty);
    }
  });

  testWidgets('YouTube not signed in: the Siaran Langsung role signs in itself, not the admin', (
    tester,
  ) async {
    await _open(tester, box: const LiveBoxStatus());
    await _openSection(tester, 'out');
    expect(find.text('Log masuk YouTube dahulu'), findsOneWidget);
    expect(find.text('Minta Pentadbir log masuk YouTube'), findsNothing);
    expect(_chipTappable(tester), isTrue);
    await reveal(tester, find.byKey(const ValueKey('live-youtube-account')));
    expect(find.byKey(const ValueKey('live-youtube-account')), findsOneWidget);
  });

  testWidgets('an admin signs in to YouTube with the device code', (
    tester,
  ) async {
    final t = await _open(
      tester,
      roles: const ['admin'],
      box: const LiveBoxStatus(),
    );
    await _openSection(tester, 'out');
    expect(find.text('Log masuk YouTube dahulu'), findsOneWidget);
    await reveal(tester, find.text('Log masuk YouTube'));
    await tester.tap(find.text('Log masuk YouTube'));
    await settle(tester);
    expect(t.box.state.youtube.phase, YoutubeAccountPhase.signingIn);
    t.box.set(
      const LiveBoxStatus(
        youtube: YoutubeAccount.signingIn(
          userCode: 'BQXR-TKMW',
          verificationUrl: 'https://www.google.com/device',
        ),
      ),
    );
    await settle(tester);
    expect(find.text('BQXR-TKMW'), findsOneWidget);
    await reveal(tester, find.text('Buka halaman Google'));
    await tester.tap(find.text('Buka halaman Google'));
    await settle(tester);
    expect(
      t.h.opener.opened.single.toString(),
      'https://www.google.com/device',
    );
  });

  testWidgets('a pending sign-in from the server shows the code, the Google button and the minutes left', (
    tester,
  ) async {
    final t = await _open(tester, roles: const ['admin'], box: const LiveBoxStatus());
    t.box.set(
      LiveBoxStatus(
        youtube: YoutubeAccount.signingIn(
          userCode: 'BQXR-TKMW',
          verificationUrl: 'https://www.google.com/device',
          expiresAt: DateTime.now().add(const Duration(minutes: 9, seconds: 30)),
        ),
      ),
    );
    await settle(tester);
    await reveal(tester, find.byKey(const ValueKey('live-signin-waiting')));
    expect(find.text('BQXR-TKMW'), findsOneWidget);
    expect(find.text('Buka halaman Google'), findsOneWidget);
    expect(find.textContaining('Menunggu pengesahan'), findsOneWidget);
  });

  testWidgets('the Google button always opens google.com/device, whatever address the box sent', (tester) async {
    final t = await _open(tester, roles: const ['admin'], box: const LiveBoxStatus());
    t.box.set(
      const LiveBoxStatus(
        youtube: YoutubeAccount.signingIn(userCode: 'BQXR-TKMW', verificationUrl: 'https://evil.example/device'),
      ),
    );
    await settle(tester);
    await reveal(tester, find.text('Buka halaman Google'));
    await tester.tap(find.text('Buka halaman Google'));
    await settle(tester);
    expect(t.h.opener.opened.single.toString(), 'https://www.google.com/device');
  });

  testWidgets('a pending sign-in with no code (live:control only) says an administrator is signing in, no code card', (
    tester,
  ) async {
    final t = await _open(tester, roles: const ['admin'], box: const LiveBoxStatus());
    t.box.set(const LiveBoxStatus(youtube: YoutubeAccount.signingIn(byAdmin: true)));
    await settle(tester);
    await reveal(tester, find.byKey(const ValueKey('live-signin-by-admin')));
    expect(find.text('Log masuk YouTube sedang dibuat oleh pentadbir.'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-signin-code')), findsNothing);
    expect(find.text('Buka halaman Google'), findsNothing);
  });

  testWidgets('signed in: the card says YouTube disambungkan with the channel on its own line, the summary says it too, and a snackbar says it once', (
    tester,
  ) async {
    final t = await _open(
      tester,
      roles: const ['admin'],
      box: const LiveBoxStatus(
        youtube: YoutubeAccount.signingIn(userCode: 'BQXR-TKMW', verificationUrl: 'https://www.google.com/device'),
      ),
    );
    t.box.set(const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau D\'Waqaf')));
    await tester.pump();
    expect(find.text('YouTube disambungkan: ${bidiIsolate('Surau D'Waqaf')}'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    // the same state again is not a new connection
    t.box.set(const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau D\'Waqaf')));
    await tester.pump();
    expect(find.text('YouTube disambungkan: ${bidiIsolate('Surau D'Waqaf')}'), findsOneWidget);
    await settle(tester);
    await reveal(tester, find.byKey(const ValueKey('live-settings-summary-connected')));
    expect(find.byKey(const ValueKey('live-settings-summary-connected')), findsOneWidget);
    await reveal(tester, find.byKey(const ValueKey('live-youtube-channel')));
    expect(find.text('YouTube disambungkan'), findsOneWidget);
    expect(find.byKey(const ValueKey('live-youtube-channel')), findsOneWidget);
    expect(find.text('Surau D\'Waqaf'), findsWidgets);
    expect(find.text('Tukar saluran / Log keluar'), findsOneWidget);
  });

  testWidgets('Tukar saluran / Log keluar asks first and says the next live will not reach YouTube', (tester) async {
    final t = await _open(tester, roles: const ['admin']);
    await reveal(tester, find.byKey(const ValueKey('live-youtube-signout')));
    await tester.tap(find.byKey(const ValueKey('live-youtube-signout')));
    await settle(tester);
    expect(find.byKey(const ValueKey('live-youtube-signout-confirm')), findsOneWidget);
    expect(find.textContaining('tidak akan sampai ke YouTube'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(t.box.state.youtube.signedIn, isTrue);
  });

  for (final c in <(YoutubeSignOutReason, String)>[
    (YoutubeSignOutReason.denied, 'Log masuk dibatalkan'),
    (YoutubeSignOutReason.expired, 'Kod tamat tempoh. Cuba lagi.'),
    (YoutubeSignOutReason.revoked, 'Akses YouTube telah ditarik balik atau tamat. Sila log masuk semula.'),
  ]) {
    testWidgets('signed out because ${c.$1.name}: the line says so beside the sign-in button', (tester) async {
      await _open(
        tester,
        roles: const ['admin'],
        box: LiveBoxStatus(youtube: YoutubeAccount.signedOut(reason: c.$1)),
      );
        await reveal(tester, find.byKey(const ValueKey('live-signin-outcome')));
      expect(find.text(c.$2), findsOneWidget);
      expect(find.text('Log masuk YouTube'), findsOneWidget);
    });
  }

  testWidgets('a retrying leg shows its countdown', (tester) async {
    final t = await _open(tester);
    t.pub.emit(
      _running(youtube: const OutputState(OutputPhase.retrying, retryInSec: 5)),
    );
    await settle(tester);
    t.unfold(); // the legs are listed in the unfolded screen
    await settle(tester);
    expect(find.text('Cuba lagi dalam 5 s'), findsOneWidget);
    expect(
      find.text('Bersiaran'),
      findsWidgets,
      reason: 'kiosk leg and the on-air pill',
    );
    expect(_stop, findsOneWidget);
  });

  testWidgets('the box away blocks the start', (tester) async {
    final t = await _open(tester, box: _signedIn.copyWith(boxReachable: false));
    expect(
      find.text(
        'MAXCOM tidak dapat dihubungi. Siaran ke skrin surau tidak boleh dimulakan.',
      ),
      findsOneWidget,
    );
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started, isEmpty);
  });

  testWidgets('Berhenti asks first; cancel keeps the live', (tester) async {
    final t = await _open(tester);
    t.pub.emit(_running());
    await settle(tester);
    await tester.tap(_stop);
    await settle(tester);
    expect(find.text('Hentikan siaran?'), findsOneWidget);
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(t.pub.stops, 0);
    expect(_stop, findsOneWidget);
  });

  testWidgets('stopping shows the summary with the short YouTube line', (
    tester,
  ) async {
    final t = await _open(tester);
    t.box.set(_signedIn.copyWith(youtubeSeconds: 1500));
    t.pub.emit(_running(duration: 2843));
    await settle(tester);
    await tester.tap(_stop);
    await settle(tester);
    await tester.tap(find.text('Hentikan'));
    await settle(tester);
    expect(t.pub.stops, 1);
    expect(find.text('Siaran tamat'), findsOneWidget);
    expect(find.text('47:23'), findsOneWidget);
    expect(
      find.text('YouTube menerima 25 minit daripada 47 minit'),
      findsOneWidget,
    );
    expect(
      find.text('Rakaman disimpan di Movies/MAXCOM'),
      findsOneWidget,
      reason: 'Android',
    );
  });

  testWidgets('a full YouTube leg has no short line', (tester) async {
    final t = await _open(tester);
    t.box.set(_signedIn.copyWith(youtubeSeconds: 2810));
    t.pub.emit(_running(duration: 2843));
    await settle(tester);
    await tester.tap(_stop);
    await settle(tester);
    await tester.tap(find.text('Hentikan'));
    await settle(tester);
    expect(find.text('Siaran tamat'), findsOneWidget);
    expect(find.textContaining('YouTube menerima'), findsNothing);
  });

  testWidgets('an AJK member never reaches the Live tab', (tester) async {
    final h = await pumpShell(tester);
    h.router.go('/live');
    await settle(tester);
    expect(h.location, '/');
    expect(find.text('Tiada kebenaran untuk tindakan ini'), findsOneWidget);
  });

  group('stop never closes the app', () {
    testWidgets('folded Berhenti keeps /live, the root route and the app', (
      tester,
    ) async {
      final t = await _open(tester);
      final platformCalls = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          platformCalls.add(call.method);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.tap(_start);
      await settle(tester);
      expect(t.folded, isTrue);
      final root = Navigator.of(
        tester.element(find.byType(Scaffold).first),
        rootNavigator: true,
      );
      expect(root.canPop(), isFalse);

      await tester.tap(_stop);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      // the dialog is a route on top of the root navigator
      expect(root.canPop(), isTrue);
      await tester.tap(find.text('Hentikan'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // the stop has not started while the dialog is still closing
      expect(t.pub.stops, 0);
      await settle(tester);

      expect(t.pub.stops, 1);
      expect(t.h.location, '/live');
      expect(root.canPop(), isFalse); // only the app's own root route is left
      expect(platformCalls, isNot(contains('SystemNavigator.pop')));
      expect(t.folded, isFalse);
      expect(find.byType(LiveFoldedView), findsNothing);
    });

    testWidgets('cancel closes only the dialog, still folded and live', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(_start);
      await settle(tester);
      await tester.tap(_stop);
      await settle(tester);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(t.h.location, '/live');
      expect(t.pub.stops, 0);
      expect(t.folded, isTrue);
    });

    testWidgets('the auto unfold waits for the stop to finish', (tester) async {
      final t = await _open(tester);
      await tester.tap(_start);
      await settle(tester);
      expect(t.folded, isTrue);

      // the recorder is finishing: nothing may unfold the screen yet
      t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopping));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(t.folded, isTrue);
      expect(find.byType(LiveFoldedView), findsOneWidget);

      // stopped: the unfold runs after a frame, not inside the state event
      t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopped));
      expect(t.folded, isTrue);
      await tester.pump();
      expect(t.folded, isFalse);
      await settle(tester);
      expect(find.byType(LiveFoldedView), findsNothing);
    });

    testWidgets('a new live before the unfold ran keeps the fold', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(_start);
      await settle(tester);
      t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopped));
      t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.live));
      await settle(tester);
      expect(t.folded, isTrue);
    });
  });

  group('fold', () {
    Finder minimise() => find.byKey(const ValueKey('live-minimise'));
    Finder expand() => find.byKey(const ValueKey('live-expand'));

    group('auto fold', () {
      testWidgets('Mula siaran folds the screen by itself', (tester) async {
        final t = await _open(tester);
        expect(t.folded, isFalse);
        expect(minimise(), findsOneWidget);
        await tester.tap(_start);
        await settle(tester);
        expect(t.pub.started, hasLength(1));
        expect(t.folded, isTrue);
        expect(expand(), findsOneWidget);
        expect(find.text('Kuliah Isyak'), findsNothing);
        expect(_stop, findsOneWidget);
      });

      testWidgets('Berhenti unfolds the screen by itself', (tester) async {
        final t = await _open(tester);
        await tester.tap(_start);
        await settle(tester);
        expect(t.folded, isTrue);
        await tester.tap(_stop);
        await settle(tester);
        await tester.tap(find.text('Hentikan'));
        await settle(tester);
        expect(t.pub.stops, 1);
        expect(t.folded, isFalse);
        expect(find.byType(LiveFoldedView), findsNothing);
      });

      testWidgets('a live the box ended unfolds the screen', (tester) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(t.folded, isTrue);
        // the controller stops the publisher when the box ends the live
        t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopped));
        await settle(tester);
        expect(t.folded, isFalse);
        expect(find.byType(LiveFoldedView), findsNothing);
      });

      testWidgets('an error stop unfolds the screen', (tester) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(t.folded, isTrue);
        t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.error));
        await settle(tester);
        expect(t.folded, isFalse);
      });

      testWidgets('a manual unfold during a live stays unfolded', (
        tester,
      ) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(t.folded, isTrue);
        await tester.tap(expand());
        await settle(tester);
        expect(t.folded, isFalse);
        // more of the same live (stats, a leg retrying) must not refold it
        t.pub.emit(_running(duration: 1500));
        await settle(tester);
        t.pub.emit(
          _running(
            youtube: const OutputState(OutputPhase.retrying, retryInSec: 5),
          ),
        );
        await settle(tester);
        expect(t.folded, isFalse);
        expect(minimise(), findsOneWidget);
        // the icon still folds it again
        await tester.tap(minimise());
        await settle(tester);
        expect(t.folded, isTrue);
      });

      testWidgets('the next start folds again', (tester) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        await tester.tap(expand());
        await settle(tester);
        t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopped));
        await settle(tester);
        expect(t.folded, isFalse);
        t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.ready));
        await settle(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(t.folded, isTrue);
      });

      testWidgets('a live that ends on another tab still unfolds', (
        tester,
      ) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(t.folded, isTrue);
        t.h.router.go('/');
        await settle(tester);
        t.pub.emit(t.pub.current.copyWith(phase: PublisherPhase.stopped));
        await settle(tester);
        t.h.router.go('/live');
        await settle(tester);
        expect(t.folded, isFalse);
        expect(find.byType(LiveFoldedView), findsNothing);
      });
    });

    testWidgets('minimising leaves the preview and the slim overlay', (
      tester,
    ) async {
      final t = await _open(tester);
      t.pub.emit(_running());
      await settle(tester);
      expect(t.folded, isTrue, reason: 'a live folds the screen by itself');
      t.unfold();
      await settle(tester);
      expect(find.text('Kuliah Isyak'), findsOneWidget, reason: 'unfolded');
      await tester.tap(minimise());
      await settle(tester);
      expect(
        find.text('Kuliah Isyak'),
        findsNothing,
        reason: 'picker folded away',
      );
      expect(find.byKey(const ValueKey('live-youtube')), findsNothing);
      expect(find.byType(FakeCameraPicture), findsOneWidget);
      expect(find.byKey(const ValueKey('folded-kiosk')), findsOneWidget);
      expect(find.byKey(const ValueKey('folded-youtube')), findsOneWidget);
      expect(find.byTooltip('Tukar kamera'), findsOneWidget);
      expect(find.byTooltip('Senyapkan mikrofon'), findsOneWidget);
      expect(find.byTooltip('Tunjuk tetapan'), findsOneWidget);
      expect(find.text('23:41'), findsOneWidget, reason: 'duration');
      expect(_stop, findsOneWidget);
      await tester.tap(expand());
      await settle(tester);
      expect(
        find.text('Kuliah Isyak'),
        findsOneWidget,
        reason: 'unfolded again',
      );
      expect(minimise(), findsOneWidget);
    });

    testWidgets(
      'folded hides the title bar and the navigation, unfolded brings them back',
      (tester) async {
        final t = await _open(tester);
        expect(find.byType(AppBar), findsOneWidget);
        expect(find.text('Papan pemuka'), findsWidgets, reason: 'navigation');
        await tester.tap(minimise());
        await settle(tester);
        expect(find.byType(AppBar), findsNothing);
        expect(find.text('Papan pemuka'), findsNothing);
        expect(find.text('Kandungan'), findsNothing);
        expect(find.text('Siaran langsung'), findsNothing);
        final screen = tester.getSize(find.byType(Scaffold).first);
        final view = tester.getRect(find.byType(LiveFoldedView));
        expect(view.width, screen.width, reason: 'edge to edge');
        await tester.tap(expand());
        await settle(tester);
        expect(find.byType(AppBar), findsOneWidget);
        expect(find.text('Papan pemuka'), findsWidgets);
        expect(t.h.location, '/live');
      },
    );

    testWidgets('leaving the tab while folded brings the navigation back', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(minimise());
      await settle(tester);
      t.h.router.go('/');
      await settle(tester);
      expect(find.text('Papan pemuka'), findsWidgets);
      expect(find.byType(LiveFoldedView), findsNothing);
    });

    testWidgets('Android back while folded unfolds and stays on the tab', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(minimise());
      await settle(tester);
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(t.h.location, '/live');
      expect(find.byType(LiveFoldedView), findsNothing);
      expect(t.h.container.read(liveFoldedProvider), isFalse);
      expect(find.text('Kuliah Isyak'), findsOneWidget);
    });

    testWidgets('Berhenti is reachable folded and still asks first', (
      tester,
    ) async {
      final t = await _open(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold();
      await settle(tester);
      await tester.tap(minimise());
      await settle(tester);
      await tester.tap(_stop);
      await settle(tester);
      expect(find.text('Hentikan siaran?'), findsOneWidget);
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(t.pub.stops, 0);
      expect(_stop, findsOneWidget);
      await tester.tap(_stop);
      await settle(tester);
      await tester.tap(find.text('Hentikan'));
      await settle(tester);
      expect(t.pub.stops, 1);
    });

    testWidgets('the mute button works folded', (tester) async {
      final t = await _open(tester);
      await tester.tap(minimise());
      await settle(tester);
      expect(_stop, findsNothing, reason: 'not live: no Berhenti');
      await tester.tap(find.byKey(const ValueKey('live-folded-mute')));
      await settle(tester);
      expect(t.pub.current.muted, isTrue);
    });

    testWidgets('folded before a live, the state is kept across a rebuild', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(minimise());
      await settle(tester);
      expect(t.h.container.read(liveFoldedProvider), isTrue);
      // leave the tab and come back: still folded
      t.h.router.go('/');
      await settle(tester);
      t.h.router.go('/live');
      await settle(tester);
      expect(find.byKey(const ValueKey('live-expand')), findsOneWidget);
      expect(find.text('Kuliah Isyak'), findsNothing);
      // a live starting while folded keeps it folded
      t.pub.emit(_running());
      await settle(tester);
      expect(find.byKey(const ValueKey('live-expand')), findsOneWidget);
      expect(_stop, findsOneWidget);
    });

    testWidgets('portrait: the overlay runs along the top and bottom', (
      tester,
    ) async {
      final t = await _open(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold();
      await settle(tester);
      await tester.tap(minimise());
      await settle(tester);
      expect(find.byKey(const ValueKey('folded-top')), findsOneWidget);
      expect(find.byKey(const ValueKey('folded-side')), findsNothing);
      final picture = tester.getRect(find.byType(FakeCameraPicture));
      final body = tester.getRect(find.byType(LiveFoldedView));
      expect(picture, body, reason: 'the preview fills the available screen');
    });

    testWidgets('landscape phone: the overlay sits along the side', (
      tester,
    ) async {
      final t = await _open(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold();
      await settle(tester);
      await tester.tap(minimise());
      await settle(tester);
      tester.view.physicalSize = const Size(915, 412) * goldenPixelRatio;
      await settle(tester);
      expect(find.byKey(const ValueKey('folded-side')), findsOneWidget);
      expect(find.byKey(const ValueKey('folded-top')), findsNothing);
      final side = tester.getRect(find.byKey(const ValueKey('folded-side')));
      expect(side.center.dx, greaterThan(915 * 0.8));
      expect(_stop, findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'fits 412 high');
    });

    for (final size in GoldenSize.values) {
      testWidgets('iPad and phone sizes fold and unfold: ${size.name}', (
        tester,
      ) async {
        final t = await _open(tester);
        t.pub.emit(_running());
        await settle(tester);
        t.unfold();
        await settle(tester);
        await pumpAtSize(tester, t.h.app, size);
        await tester.tap(minimise());
        await settle(tester);
        expect(find.byType(LiveFoldedView), findsOneWidget);
        expect(_stop, findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.tap(expand());
        await settle(tester);
        expect(find.byType(LiveFoldedView), findsNothing);
      });
    }
  });

  group('goldens', () {
    testWidgets('live_idle', (tester) async {
      final t = await _open(tester);
      await expectGoldens(tester, t.h.app, 'live_idle');
    });

    testWidgets('live_running', (tester) async {
      final t = await _open(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold();
      await settle(tester);
      await expectGoldens(tester, t.h.app, 'live_running');
    });

    testWidgets('live_warning', (tester) async {
      final t = await _open(tester);
      t.pub.emit(
        _running(
          youtube: const OutputState(OutputPhase.retrying, retryInSec: 5),
          warnings: const {
            Warning.lowBattery,
            Warning.hot,
            Warning.screenLockRisk,
          },
          duration: 3127,
        ),
      );
      await settle(tester);
      t.unfold();
      await settle(tester);
      await expectGoldens(tester, t.h.app, 'live_warning');
    });

    testWidgets('live_folded_running', (tester) async {
      final t = await _open(tester);
      t.pub.emit(_running()); // a live folds the screen by itself
      await settle(tester);
      await expectGoldens(tester, t.h.app, 'live_folded_running');
    });

    testWidgets('live_folded_idle', (tester) async {
      final t = await _open(tester);
      await tester.tap(find.byKey(const ValueKey('live-minimise')));
      await settle(tester);
      await expectGoldens(tester, t.h.app, 'live_folded_idle');
    });

    testWidgets('live_stopped', (tester) async {
      final t = await _open(tester);
      t.box.set(
        _signedIn.copyWith(
          youtubeSeconds: 1500,
          watchUrl: 'https://www.youtube.com/watch?v=abc123',
        ),
      );
      t.pub.emit(_running(duration: 2843));
      await settle(tester);
      await tester.tap(_stop);
      await settle(tester);
      await tester.tap(find.text('Hentikan'));
      await settle(tester);
      await expectGoldens(tester, t.h.app, 'live_stopped');
    });

    testWidgets('live_youtube_signin', (tester) async {
      final t = await _open(
        tester,
        roles: const ['admin'],
        box: const LiveBoxStatus(
          youtube: YoutubeAccount.signingIn(
            userCode: 'BQXR-TKMW',
            verificationUrl: 'https://www.google.com/device',
          ),
        ),
      );
      await expectGoldens(tester, t.h.app, 'live_youtube_signin');
    });

    // Arabic app, Arabic and Latin channel names: the chip and the dialog read in order (bidi isolation).
    for (final channel in ['قناة مصلى النور', 'Surau D\'Waqaf']) {
      final tag = channel.startsWith('ق') ? 'arch' : 'latch';
      testWidgets('live_youtube_chip_ar_$tag', (tester) async {
        final t = await _open(tester, box: LiveBoxStatus(youtube: YoutubeAccount.signedIn(channel)));
        await t.h.container.read(appLangProvider.notifier).set(AppLang.ar);
        await settle(tester);
        expect(
          tester.widget<Text>(find.descendant(of: find.byKey(const ValueKey('live-dest-youtube')), matching: find.byType(Text))).data,
          '\u2068YouTube\u2069: نعم، ${bidiIsolate(channel)}');
        await expectGoldens(tester, t.h.app, 'live_youtube_chip_ar_$tag');
      });

      testWidgets('live_youtube_ask_ar_$tag', (tester) async {
        final t = await _open(tester, box: LiveBoxStatus(youtube: YoutubeAccount.unknown(channel: channel)));
        await t.h.container.read(appLangProvider.notifier).set(AppLang.ar);
        await settle(tester);
        await tester.tap(_start);
        await settle(tester);
        final text = (tester.widget<AlertDialog>(find.byKey(const ValueKey('live-youtube-ask'))).content! as Text).data!;
        expect(text, contains(bidiIsolate(channel)));
        expect(text.split('YouTube').length, 2, reason: 'YouTube once: $text');
        await expectGoldens(tester, t.h.app, 'live_youtube_ask_ar_$tag');
      });
    }

    testWidgets('live_youtube_unknown', (tester) async {
      final t = await _open(
        tester,
        box: const LiveBoxStatus(youtube: YoutubeAccount.unknown(channel: 'Surau D\'Waqaf')),
      );
      expect(find.textContaining('tidak dapat disemak sekarang'), findsWidgets);
      await expectGoldens(tester, t.h.app, 'live_youtube_unknown');
    });

    testWidgets('live_recordings_pending', (tester) async {
      final t = await _open(
        tester,
        box: _signedIn.copyWith(recordingsPending: 3),
      );
      expect(find.text('Rakaman belum disimpan'), findsOneWidget);
      await expectGoldens(tester, t.h.app, 'live_recordings_pending');
    });
  });

  group('[PP-L2] the destinations above Mula siaran', () {
    Finder chip(String k) => find.byKey(ValueKey('live-dest-$k'));
    Text chipText(WidgetTester tester, String k) =>
        tester.widget<Text>(find.descendant(of: chip(k), matching: find.byType(Text)));

    testWidgets('[PP-L2] the chips are visible without opening any card; ticking YouTube changes at once', (tester) async {
      await _open(tester);
      expect(chip('kiosk'), findsOneWidget);
      expect(chipText(tester, 'youtube').data, 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
      expect(find.byKey(const ValueKey('live-dest-skip')), findsNothing);
      await tester.tap(chip('youtube'));
      await settle(tester);
      expect(chipText(tester, 'youtube').data, 'YouTube: Tidak');
      expect(
        find.text('YouTube tidak dipilih: siaran hanya ke skrin surau.'),
        findsOneWidget,
        reason: 'a screen-only start is a visible choice',
      );
      await tester.tap(chip('youtube'));
      await settle(tester);
      expect(chipText(tester, 'youtube').data, 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
      expect(find.byKey(const ValueKey('live-dest-skip')), findsNothing);
    });

    testWidgets('[PP-L2] YouTube not connected says so, with a way to the account card', (tester) async {
      await _open(tester, roles: const ['admin'], box: const LiveBoxStatus());
      expect(find.text('YouTube belum disambungkan'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-dest-connect')), findsOneWidget);
      expect(find.byKey(const ValueKey('live-dest-skip')), findsNothing);
    });

    testWidgets('[PP-L2] during a live the header says where it goes', (tester) async {
      final t = await _open(tester);
      t.pub.emit(_running(youtube: OutputState.up));
      await settle(tester);
      t.unfold();
      await settle(tester);
      expect(find.text('Ke skrin surau dan YouTube'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-destinations')), findsNothing);
    });

    testWidgets('[PP-L2] the chips sit above the start button', (tester) async {
      await _open(tester);
      expect(
        tester.getBottomLeft(find.byKey(const ValueKey('live-destinations'))).dy,
        lessThanOrEqualTo(tester.getTopLeft(_start).dy),
      );
      expect(tester.getSize(chip('youtube')).height, greaterThanOrEqualTo(44));
    });

    testWidgets('[PP-L2] another device live: read only, no chips', (tester) async {
      const other = OtherLive(sessionId: 's9', starter: 'iPad Ustaz Ali', video: 'phone');
      await _open(tester, box: _signedIn.copyWith(otherLive: other));
      expect(find.byKey(const ValueKey('live-destinations')), findsNothing);
      expect(chip('youtube'), findsNothing);
    });

    testWidgets('[PP-L2] no internet: the YouTube chip stays tappable (the choice is not greyed)', (tester) async {
      await _open(tester, box: _signedIn.copyWith(internet: false));
      expect(_chipTappable(tester), isTrue);
    });

    testWidgets('[PP-L2] a screen-only live says so', (tester) async {
      final t = await _open(tester);
      t.pub.emit(_running().copyWith(outputs: const PublisherOutputs(kiosk: OutputState.up)));
      await settle(tester);
      t.unfold();
      await settle(tester);
      expect(find.text('Ke skrin surau sahaja'), findsOneWidget);
    });

    testWidgets('[PP-L2] an off choice stays off through a sign-out and a new sign-in (a block never changes it)', (
      tester,
    ) async {
      final t = await _open(tester);
      await tester.tap(chip('youtube'));
      await settle(tester);
      expect(chipText(tester, 'youtube').data, 'YouTube: Tidak');
      t.box.set(const LiveBoxStatus());
      await settle(tester);
      expect(chipText(tester, 'youtube').data, 'YouTube: Tidak');
      t.box.set(_signedIn);
      await settle(tester);
      expect(chipText(tester, 'youtube').data, 'YouTube: Tidak');
    });
  });

  group('[W5] the surau-wide YouTube choice (liveYoutube.nextLiveOn)', () {
    Finder chip() => find.byKey(const ValueKey('live-dest-youtube'));
    String chipLabel(WidgetTester tester) =>
        tester.widget<Text>(find.descendant(of: chip(), matching: find.byType(Text))).data!;
    Object? stored(_Live t) => (t.h.settings['liveYoutube']! as Map)['nextLiveOn'];

    // A newer box carries the field in its settings; the harness merges a PUT as the box does.
    Future<void> boxSets(WidgetTester tester, _Live t, bool on) async {
      final f = (t.h.settings['liveYoutube'] as Map?)?.cast<String, Object?>() ?? <String, Object?>{};
      t.h.settings['liveYoutube'] = {...f, 'nextLiveOn': on};
      t.h.container.invalidate(settingsProvider);
      await settle(tester);
    }

    Future<_Live> openOn(
      WidgetTester tester, {
      bool on = true,
      LiveBoxStatus box = _signedIn,
    }) async {
      final t = await _open(tester, box: box);
      await boxSets(tester, t, on);
      return t;
    }

    testWidgets('the chip shows the setting, and a tap writes it to the box', (tester) async {
      final t = await openOn(tester);
      expect(chipLabel(tester), 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
      await tester.tap(chip());
      await settle(tester);
      expect(chipLabel(tester), 'YouTube: Tidak');
      expect(stored(t), false, reason: 'written to the surau setting, not kept in memory');
    });

    testWidgets('a second device sees the same choice (the setting, read fresh)', (tester) async {
      final t = await openOn(tester, on: false);
      expect(chipLabel(tester), 'YouTube: Tidak');
      // another admin sets it on; this phone reads the settings again (a change event or a resume)
      await boxSets(tester, t, true);
      expect(chipLabel(tester), 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
    });

    testWidgets('a refused write puts the chip back and says so', (tester) async {
      final t = await openOn(tester);
      t.h.failPuts = 5;
      await tester.tap(chip());
      await settle(tester);
      expect(chipLabel(tester), 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
      expect(find.text('Pilihan YouTube tidak dapat disimpan. Cuba lagi.'), findsOneWidget);
      expect(stored(t), true);
    });

    testWidgets('unknown is not signed out: last channel named, choice kept and tappable, no sign-in prompt', (
      tester,
    ) async {
      final t = await openOn(
        tester,
        box: const LiveBoxStatus(youtube: YoutubeAccount.unknown(channel: 'Surau D\'Waqaf')),
      );
      expect(find.text('YouTube: tidak dapat disemak sekarang (kali terakhir: ${bidiIsolate('Surau D'Waqaf')})'), findsWidgets);
      expect(find.text('Log masuk YouTube dahulu'), findsNothing);
      expect(find.byKey(const ValueKey('live-dest-connect')), findsNothing);
      expect(chipLabel(tester), 'YouTube: Ya, ${bidiIsolate('Surau D'Waqaf')}');
      expect(_chipTappable(tester), isTrue);
      expect(stored(t), true);
    });

    testWidgets('a live:control-only role writes the choice through the dedicated route, never the settings route', (
      tester,
    ) async {
      final t = await openOn(tester);
      final puts = <String>[];
      t.h.handlers['PUT /api/live/youtube/next-live'] = (r) async {
        puts.add(r.body);
        return jsonResponse(200, {'nextLiveOn': false});
      };
      t.h.handlers['PUT /api/settings/liveYoutube'] = (r) async => jsonResponse(403, {
        'errors': ['forbidden'],
      });
      await tester.tap(chip());
      await settle(tester);
      expect(puts, ['{"on":false}']);
      expect(find.text('Pilihan YouTube tidak dapat disimpan. Cuba lagi.'), findsNothing);
      expect(chipLabel(tester), 'YouTube: Tidak');
    });

    testWidgets('an older box (route 404) falls back to the settings field', (tester) async {
      final t = await openOn(tester);
      t.h.handlers['PUT /api/live/youtube/next-live'] = (r) async => jsonResponse(404, {
        'errors': ['tiada'],
      });
      await tester.tap(chip());
      await settle(tester);
      expect(stored(t), false);
      expect(find.text('Pilihan YouTube tidak dapat disimpan. Cuba lagi.'), findsNothing);
    });

    testWidgets('unknown with no last good channel still offers Sambung', (tester) async {
      await _open(tester, roles: const ['admin'], box: const LiveBoxStatus(youtube: YoutubeAccount.unknown()));
      expect(find.byKey(const ValueKey('live-dest-connect')), findsOneWidget);
    });

    testWidgets('Mula siaran with YouTube on and unusable asks; Batal starts nothing and keeps the choice', (
      tester,
    ) async {
      final t = await openOn(
        tester,
        box: const LiveBoxStatus(youtube: YoutubeAccount.unknown(channel: 'Surau D\'Waqaf')),
      );
      await tester.tap(_start);
      await settle(tester);
      expect(find.textContaining('Mulakan siaran ke skrin surau sahaja?'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('live-youtube-ask-cancel')));
      await settle(tester);
      expect(t.pub.started, isEmpty, reason: 'no silent TV-only start');
      expect(stored(t), true, reason: 'a block never changes the setting');
    });

    testWidgets('Ya starts the surau screen only, once asked, and the setting is untouched', (tester) async {
      final t = await openOn(tester, box: const LiveBoxStatus());
      await tester.tap(_start);
      await settle(tester);
      expect(find.byKey(const ValueKey('live-youtube-ask')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('live-youtube-ask-yes')));
      await settle(tester);
      expect(t.pub.started.single.outputs.kiosk, isTrue);
      expect(t.pub.started.single.outputs.youtube, isFalse);
      expect(stored(t), true);
    });

    testWidgets('YouTube chosen off and unusable starts without a question', (tester) async {
      final t = await openOn(tester, on: false, box: const LiveBoxStatus());
      await tester.tap(_start);
      await settle(tester);
      expect(find.byKey(const ValueKey('live-youtube-ask')), findsNothing);
      expect(t.pub.started.single.outputs.youtube, isFalse);
    });

    testWidgets('YouTube chosen on and usable starts with YouTube, no question', (tester) async {
      final t = await openOn(tester);
      await tester.tap(_start);
      await settle(tester);
      expect(find.byKey(const ValueKey('live-youtube-ask')), findsNothing);
      expect(t.pub.started.single.outputs.youtube, isTrue);
    });
  });

  group('[PP-L1] the live notice button', () {
    const watch = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    Finder banner() => find.byKey(const ValueKey('live-notice-banner'));
    Finder share() => find.byKey(const ValueKey('live-notice-share'));

    // A tall window builds the whole list, so "absent" means absent and not just off screen.
    Future<void> tall(WidgetTester tester) async {
      tester.view.physicalSize = const Size(700, 6000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await settle(tester);
    }

    testWidgets('[PP-L1] a YouTube live shows the button and a one-line banner with one button, for the whole live', (
      tester,
    ) async {
      final t = await _open(tester, box: _signedIn.copyWith(watchUrl: watch, sessionId: 's1'));
      await tall(tester);
      expect(share(), findsNothing, reason: 'not before the live');
      t.pub.emit(_running());
      await settle(tester);
      t.unfold(); // a starting live folds the screen by itself
      await settle(tester);
      expect(share(), findsOneWidget);
      expect(banner(), findsOneWidget);
      expect(find.text('Siaran sedang berlangsung.'), findsOneWidget);
      expect(find.text('Kongsi pautan'), findsWidgets);
      expect(find.byKey(const ValueKey('live-notice-banner-close')), findsNothing, reason: 'one button only');
      t.box.set(_signedIn.copyWith(watchUrl: watch, sessionId: 's1', youtubeSeconds: 10));
      await settle(tester);
      expect(banner(), findsOneWidget);
    });

    testWidgets('[PP-L1] the banner button opens the sheet with the public link only', (tester) async {
      final t = await _open(tester, box: _signedIn.copyWith(watchUrl: watch, sessionId: 's1'));
      await tall(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold(); // a starting live folds the screen by itself
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('live-notice-banner-share')));
      await settle(tester);
      final text = tester.widget<Text>(find.byKey(const ValueKey('live-notice-preview'))).data!;
      expect(text, contains('https://www.youtube.com/live/AAAAAAAAAAA'));
      expect(text, isNot(contains('youtu.be')));
      expect(text, isNot(contains('watch?v=')));
      expect(share(), findsOneWidget);
    });

    testWidgets('[W6b] admin B sees the banner for a live admin A started, from the box notice alone', (tester) async {
      final t = await _open(tester, roles: const ['admin']);
      t.h.handlers['GET /api/live/notice'] = (r) async => jsonResponse(200, {
        'active': true,
        'videoId': 'AAAAAAAAAAA',
        'watchUrl': 'https://www.youtube.com/live/AAAAAAAAAAA',
        'startedAt': '2026-11-04T14:00:00.000Z',
        'kuliah': {'title': 'Kuliah Maghrib', 'speaker': 'Ustaz Ahmad', 'time': '19:15'},
        'editedText': null,
        'frame': true,
      });
      t.h.container.invalidate(liveBoxNoticeProvider);
      await tall(tester);
      expect(banner(), findsOneWidget);
      // the same banner is on the dashboard
      t.h.router.go('/');
      await settle(tester);
      expect(find.byKey(const ValueKey('dash-live-notice-banner')), findsOneWidget);
      expect(find.text('Siaran sedang berlangsung.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('dash-live-notice-share')));
      await settle(tester);
      expect(find.byKey(const ValueKey('live-notice-sheet')), findsOneWidget);
    });

    testWidgets('[W6b] no banner on the dashboard without live:control, nor when no live runs', (tester) async {
      final t = await _open(tester, roles: const ['ajk']);
      t.h.handlers['GET /api/live/notice'] = (r) async => jsonResponse(200, {
        'active': true,
        'videoId': 'AAAAAAAAAAA',
        'watchUrl': 'https://www.youtube.com/live/AAAAAAAAAAA',
      });
      t.h.container.invalidate(liveBoxNoticeProvider);
      t.h.router.go('/');
      await settle(tester);
      expect(find.byKey(const ValueKey('dash-live-notice-banner')), findsNothing);
    });

    testWidgets('[PP-L1] a live another device started with a watch link shows the notice to live:control', (tester) async {
      const other = OtherLive(sessionId: 's9', starter: 'iPad Ustaz Ali', video: 'phone');
      await _open(tester, box: _signedIn.copyWith(watchUrl: watch, otherLive: other));
      await tall(tester);
      expect(banner(), findsOneWidget);
      expect(share(), findsOneWidget);
    });

    testWidgets('[PP-L1] another device live: no button without live:control', (tester) async {
      const other = OtherLive(sessionId: 's9', starter: 'iPad Ustaz Ali', video: 'phone');
      await _open(
        tester,
        roles: const ['ajk'],
        box: _signedIn.copyWith(watchUrl: watch, otherLive: other),
      );
      await tall(tester);
      expect(share(), findsNothing);
      expect(banner(), findsNothing);
    });

    testWidgets('[PP-L1] another device live without a watch link: no button', (tester) async {
      const other = OtherLive(sessionId: 's9', starter: 'iPad Ustaz Ali', video: 'phone');
      await _open(tester, box: _signedIn.copyWith(otherLive: other));
      await tall(tester);
      expect(share(), findsNothing);
      expect(banner(), findsNothing);
    });

    testWidgets('[PP-L1] a live without YouTube has no button and no banner', (tester) async {
      final t = await _open(tester, box: _signedIn.copyWith(sessionId: 's1'));
      await tall(tester);
      t.pub.emit(_running(youtube: OutputState.up));
      await settle(tester);
      expect(share(), findsNothing);
      expect(banner(), findsNothing);
    });

    testWidgets('[PP-L1] a watch link that is not a YouTube link gives no button', (tester) async {
      for (final bad in [
        'https://evil.example/watch?v=AAAAAAAAAAA',
        'http://192.0.2.10/live/AAAAAAAAAAA',
        'rtmp://a.rtmp.youtube.com/live2/AAAAAAAAAAA',
        'https://www.youtube.com/watch?v=short',
      ]) {
        final t = await _open(tester, box: _signedIn.copyWith(watchUrl: bad, sessionId: 's1'));
      await tall(tester);
        t.pub.emit(_running());
        await settle(tester);
        expect(share(), findsNothing, reason: bad);
        expect(banner(), findsNothing, reason: bad);
      }
    });

    testWidgets('[PP-L1] the end-of-live summary offers the notice beside the watch button', (tester) async {
      final t = await _open(tester, box: _signedIn.copyWith(watchUrl: watch, sessionId: 's1', youtubeSeconds: 2810));
      t.pub.emit(_running(duration: 2843));
      await settle(tester);
      await tester.tap(_stop);
      await settle(tester);
      await tester.tap(find.text('Hentikan'));
      await settle(tester);
      expect(find.text('Siaran tamat'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-summary-notice')), findsOneWidget);
      expect(find.text('Lihat di YouTube'), findsOneWidget);
    });

    testWidgets('[PP-L1] a summary of a live without YouTube has no notice button', (tester) async {
      final t = await _open(tester);
      t.pub.emit(_running(duration: 2843));
      await settle(tester);
      await tester.tap(_stop);
      await settle(tester);
      await tester.tap(find.text('Hentikan'));
      await settle(tester);
      expect(find.text('Siaran tamat'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-summary-notice')), findsNothing);
    });

    testWidgets('[PP-L1] a Pentadbir running the live also gets the button', (tester) async {
      final t = await _open(
        tester,
        roles: const ['admin'],
        box: _signedIn.copyWith(watchUrl: watch, sessionId: 's1'),
      );
      await tall(tester);
      t.pub.emit(_running());
      await settle(tester);
      t.unfold(); // a starting live folds the screen by itself
      await settle(tester);
      expect(share(), findsOneWidget);
    });
  });
}
