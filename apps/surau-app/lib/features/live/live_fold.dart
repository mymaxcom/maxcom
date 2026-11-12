// Whether the Live tab has its settings folded away (the preview alone).
// Kept in memory for the app session: it survives leaving the tab and a
// rebuild, and is forgotten when the app restarts. The app shell reads it
// to hide its navigation while the Live tab is folded.
//
// It folds by itself when a live starts (the publisher goes live) and
// unfolds by itself when the live ends, whatever the reason (Berhenti, the
// box ended it, an error stop). It lives with the app, not with the screen,
// so a live that ends while another tab is open still unfolds. The icon
// works both ways during a live; a manual unfold stays until the next start.
//
// The unfold waits for the stop to be over: while the publisher is
// `stopping` (the recorder is finishing the MP4) the screen stays as it is,
// and the unfold itself runs after a frame, never inside a route change.
// Swapping the screen's tree while the camera view is being finished must
// not touch the preview under the recorder.

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'live_controller.dart' show livePublisherProvider;
import 'publisher.dart' show PublisherPhase;

class LiveFoldedNotifier extends Notifier<bool> {
  @override
  bool build() {
    final publisher = ref.watch(livePublisherProvider);
    var wasLive = publisher.current.isLive;
    var disposed = false;
    final sub = publisher.states.listen((s) {
      if (s.isLive) {
        if (wasLive) return;
        wasLive = true;
        state = true;
        return;
      }
      if (!wasLive) return;
      // the stop is still running: unfold when it has finished
      if (s.phase == PublisherPhase.stopping) return;
      wasLive = false;
      _unfoldAfterFrame(() => disposed || wasLive);
    });
    ref.onDispose(() {
      disposed = true;
      sub.cancel();
    });
    return false;
  }

  void _unfoldAfterFrame(bool Function() cancelled) {
    final binding = WidgetsBinding.instance;
    binding.addPostFrameCallback((_) {
      if (cancelled()) return; // gone, or a new live began meanwhile
      state = false;
    });
    binding.scheduleFrame();
  }

  void set(bool folded) => state = folded;
}

final liveFoldedProvider = NotifierProvider<LiveFoldedNotifier, bool>(
  LiveFoldedNotifier.new,
);
