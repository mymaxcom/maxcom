// The destinations of the next live as the MAXCOM Kiosk Box holds them
// (2026.11.15 Siaran langsung revamp, B5).
//
// The box is the single truth: its own `nextLiveOn` travels in the live
// status answer and this provider shows it. A tapped choice is kept until the
// status agrees (no one-minute window, no widget-state fallback), and a tap
// made while a write is pending is queued and applied after it, never dropped.
// The state lives in the provider, not in the screen, so a rebuilt screen
// shows the same choice.
//
// The choice is held PER BOX: each MAXCOM Kiosk Box streams to its own YouTube
// channel, so nothing here is surau-wide; another enrolled box starts clean.
// Shapes: docs/design/plans/2026-11-22-live-revamp-route-shapes.md.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../common/ui_flags.dart';
import '../settings_defaults.dart';
import '../shell/box_gateway.dart';

class LiveDestinations {
  const LiveDestinations({
    this.fromBox,
    this.fromSettings,
    this.confirmed,
    this.writing,
    this.queued,
    this.failures = 0,
  });

  /// `nextLiveOn` of the last live status answer; null until the box said it
  /// (an older box never does).
  final bool? fromBox;

  /// `liveYoutube.nextLiveOn` of the settings as last read: what an older box
  /// (no `nextLiveOn` in its status) is shown from.
  final bool? fromSettings;

  /// The box's answer to this device's own write, kept until a status (or, for
  /// an older box, the settings) agrees with it.
  final bool? confirmed;

  /// The value being written right now.
  final bool? writing;

  /// A tap made while [writing]: applied as soon as that write is done.
  final bool? queued;

  /// Counts the writes the box refused or never answered (the screen says so once per count).
  final int failures;

  /// What the YouTube pill shows and what Mula siaran sends.
  bool get wanted => queued ?? writing ?? confirmed ?? fromBox ?? fromSettings ?? defaultOn;

  /// A write is on its way: the pill shows a small progress mark.
  bool get saving => writing != null;

  /// The box reports its own choice and has not yet agreed with this device's
  /// last write: "Belum dapat disahkan dengan MAXCOM". (An older box, which
  /// never reports the choice, is not "unconfirmed" for ever; the screen adds
  /// the case of a box that does not answer at all.)
  bool get unconfirmed => !saving && fromBox != null && confirmed != null && confirmed != fromBox;

  /// The registry default of `liveYoutube.nextLiveOn`.
  static bool get defaultOn => featureValue('liveYoutube', null, 'nextLiveOn') != false;

  LiveDestinations _with({
    Object? fromBox = _k,
    Object? fromSettings = _k,
    Object? confirmed = _k,
    Object? writing = _k,
    Object? queued = _k,
    int? failures,
  }) => LiveDestinations(
    fromBox: identical(fromBox, _k) ? this.fromBox : fromBox as bool?,
    fromSettings: identical(fromSettings, _k) ? this.fromSettings : fromSettings as bool?,
    confirmed: identical(confirmed, _k) ? this.confirmed : confirmed as bool?,
    writing: identical(writing, _k) ? this.writing : writing as bool?,
    queued: identical(queued, _k) ? this.queued : queued as bool?,
    failures: failures ?? this.failures,
  );
}

const Object _k = Object();

class LiveDestinationsNotifier extends Notifier<LiveDestinations> {
  @override
  LiveDestinations build() {
    // Per box: another enrolled box has its own channel and its own memory.
    ref.watch(enrolledBoxProvider.select((b) => b?.boxId));
    // the settings copy serves an older box; it is never the truth of a box that reports its own choice
    ref.listen(settingsProvider, (_, next) => _fromSettings(next.value?.value), fireImmediately: true);
    return const LiveDestinations();
  }

  void _fromSettings(Map<String, dynamic>? settings) {
    final f = settings?['liveYoutube'];
    final v = f is Map && f['nextLiveOn'] is bool ? f['nextLiveOn'] as bool : null;
    if (!ref.mounted) return;
    Future<void>.microtask(() {
      if (!ref.mounted) return;
      var next = state._with(fromSettings: v);
      // an older box: the settings catching up is its way of agreeing
      if (next.fromBox == null && next.confirmed != null && v == next.confirmed) next = next._with(confirmed: null);
      state = next;
    });
  }

  /// The live status answered: [nextLiveOn] is the box's own stored choice
  /// (null on an older box, which changes nothing here).
  void fromStatus(bool? nextLiveOn) {
    if (nextLiveOn == null) return;
    var next = state._with(fromBox: nextLiveOn);
    // the box agrees with what it answered to our write: nothing left to hold
    if (next.confirmed == nextLiveOn) next = next._with(confirmed: null);
    if (next.fromBox != state.fromBox || next.confirmed != state.confirmed) state = next;
  }

  /// A tap on the YouTube switch. One write at a time; a tap during a write
  /// waits for it and is then written too (when it still differs).
  Future<void> choose(bool on) async {
    if (state.writing != null) {
      state = state._with(queued: on);
      return;
    }
    var want = on;
    while (true) {
      state = state._with(writing: want, queued: null);
      final ok = await _write(want);
      if (!ref.mounted) return;
      if (!ok) {
        // nothing was stored: the pill goes back to what the box holds, and the screen says so
        state = state._with(writing: null, queued: null, failures: state.failures + 1);
        return;
      }
      final queued = state.queued;
      if (queued == null || queued == state.confirmed) {
        state = state._with(writing: null, queued: null);
        return;
      }
      want = queued;
    }
  }

  Future<bool> _write(bool on) async {
    final BoxGateway? gateway = ref.read(gatewayProvider);
    if (gateway == null) return false;
    try {
      try {
        // The dedicated route: live:control is enough (the settings route needs settings:write).
        final answer = await gateway.put('/api/live/youtube/next-live', {'on': on});
        if (!ref.mounted) return true;
        state = state._with(confirmed: answer['nextLiveOn'] is bool ? answer['nextLiveOn'] as bool : on);
      } on BoxError catch (e) {
        // An older box has no such route: the settings field, as before.
        if (e.status != 404) rethrow;
        await gateway.put('/api/settings/liveYoutube', {'nextLiveOn': on});
        if (!ref.mounted) return true;
        state = state._with(confirmed: on);
        ref.invalidate(settingsProvider);
      }
      return true;
    } on Object {
      return false;
    }
  }
}

/// THIS BOX's YouTube choice for its next live, as the screen shows it.
final liveDestinationsProvider = NotifierProvider<LiveDestinationsNotifier, LiveDestinations>(
  LiveDestinationsNotifier.new,
);

/// Skrin (the TV screen) for the NEXT live, kept on this device per box between lives. Default ON; an old box
/// that cannot switch it keeps it on whatever is stored. The flag is stored inverted (`kioskOff`): a flag that
/// cannot be read counts as not set, which then means ON.
class LiveKioskChoiceNotifier extends Notifier<bool> {
  String get _key => 'live.kioskOff.${ref.read(enrolledBoxProvider)?.boxId ?? ''}';

  @override
  bool build() {
    final key = 'live.kioskOff.${ref.watch(enrolledBoxProvider.select((b) => b?.boxId)) ?? ''}';
    final off = ref.watch(uiFlagProvider(key)).value ?? false;
    return !off;
  }

  /// The person's choice at once; the flag follows.
  Future<void> set(bool on) async {
    state = on;
    final key = _key;
    await ref.read(uiFlagsStoreProvider).set(key, !on);
  }
}

final liveKioskChoiceProvider = NotifierProvider<LiveKioskChoiceNotifier, bool>(LiveKioskChoiceNotifier.new);

/// Rakam (the local recording) for the NEXT live: null follows today's `recording` setting; a tap on the switch
/// is held for this start only.
class LiveRecordingChoiceNotifier extends Notifier<bool?> {
  @override
  bool? build() => null;

  void set(bool? on) => state = on;
}

final liveRecordingChoiceProvider = NotifierProvider<LiveRecordingChoiceNotifier, bool?>(
  LiveRecordingChoiceNotifier.new,
);
