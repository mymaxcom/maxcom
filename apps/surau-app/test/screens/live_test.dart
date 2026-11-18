// The Live tab (Plan 5 Task 7) over the realistic box and a fake
// publisher: today's kuliah pre-selected, `Mula siaran` with the YouTube
// toggle, the reasons YouTube is off, a retrying leg, the stop confirm
// and summary, and the six goldens at the three sizes.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/live/live_widgets.dart';
import 'package:surau_app/features/live/publisher.dart';

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

Finder get _youtubeSwitch => find.descendant(
  of: find.byKey(const ValueKey('live-youtube')),
  matching: find.byType(Switch),
);

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
    await _openSection(tester, 'out');
    await tester.tap(_youtubeSwitch);
    await settle(tester);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.last.outputs.youtube, isFalse);
  });

  testWidgets('no internet disables YouTube with the reason', (tester) async {
    final t = await _open(tester, box: _signedIn.copyWith(internet: false));
    await _openSection(tester, 'out');
    expect(find.text('Tiada internet: YouTube dimatikan'), findsOneWidget);
    expect(tester.widget<Switch>(_youtubeSwitch).onChanged, isNull);
    await tester.tap(_start);
    await settle(tester);
    expect(t.pub.started.last.outputs.youtube, isFalse);
  });

  testWidgets('YouTube not signed in: the Siaran Langsung role signs in itself, not the admin', (
    tester,
  ) async {
    await _open(tester, box: const LiveBoxStatus());
    await _openSection(tester, 'out');
    expect(find.text('Log masuk YouTube dahulu'), findsOneWidget);
    expect(find.text('Minta Pentadbir log masuk YouTube'), findsNothing);
    expect(tester.widget<Switch>(_youtubeSwitch).onChanged, isNull);
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
    await reveal(tester, find.text('Buka google.com/device'));
    await tester.tap(find.text('Buka google.com/device'));
    await settle(tester);
    expect(
      t.h.opener.opened.single.toString(),
      'https://www.google.com/device',
    );
  });

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

    testWidgets('live_recordings_pending', (tester) async {
      final t = await _open(
        tester,
        box: _signedIn.copyWith(recordingsPending: 3),
      );
      expect(find.text('Rakaman belum disimpan'), findsOneWidget);
      await expectGoldens(tester, t.h.app, 'live_recordings_pending');
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

    testWidgets('[PP-L1] a YouTube live shows the button and a banner once per live session', (tester) async {
      final t = await _open(tester, box: _signedIn.copyWith(watchUrl: watch, sessionId: 's1'));
      await tall(tester);
      expect(share(), findsNothing, reason: 'not before the live');
      t.pub.emit(_running());
      await settle(tester);
      t.unfold(); // a starting live folds the screen by itself
      await settle(tester);
      expect(share(), findsOneWidget);
      expect(banner(), findsOneWidget);
      expect(find.text('Siaran sudah bermula. Kongsi pautan kepada AJK dan jemaah.'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('live-notice-banner-close')));
      await settle(tester);
      expect(banner(), findsNothing);
      expect(share(), findsOneWidget, reason: 'the button stays for the whole live');
      // the same session never brings the banner back; a new session does
      t.box.set(_signedIn.copyWith(watchUrl: watch, sessionId: 's1', youtubeSeconds: 10));
      await settle(tester);
      expect(banner(), findsNothing);
      t.box.set(_signedIn.copyWith(watchUrl: watch, sessionId: 's2'));
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
      final field = tester.widget<TextField>(find.byKey(const ValueKey('live-notice-field')));
      final text = field.controller!.text;
      expect(text, contains('https://www.youtube.com/live/AAAAAAAAAAA'));
      expect(text, isNot(contains('youtu.be')));
      expect(text, isNot(contains('watch?v=')));
      expect(banner(), findsNothing, reason: 'used once');
      expect(share(), findsOneWidget);
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
