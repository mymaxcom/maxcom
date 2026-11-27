// The Live tab (Plan 5 Task 7): today's kuliah pre-selected, the camera in
// a broadcast monitor, the two legs (Skrin surau always, YouTube when it
// can) and the recorder as rows with status lights, and one big button.
// Stopping asks first and ends with a summary. An admin also connects the
// surau's YouTube account here by Google's device code.
//
// The screen talks to a [LivePublisher] and reads the box's side of the
// live from [liveBoxProvider] (the controller of live_controller.dart,
// which starts and stops the session on the box and polls its status).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../labels.dart' show appLangOfS;
import '../../app/app_lang.dart' show AppLang;
import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../common/bidi.dart';
import '../common/time_words.dart';
import '../common/ui_flags.dart';
import '../labels.dart' show appLangOf;
import '../labels_cam.dart';
import '../registry.g.dart' as reg;
import '../shell/connection_icons.dart' show LinkGlyph, LinkKind, LinkState;
import '../shell/live_camera_gateway.dart' show AudioSourceMix, BoxGatewayLiveCamera, LiveAudioMix;
import '../screens/screens_data.dart';
import '../screens/tv_profile.dart' show selfTvId, tvProfileOf;
import '../shell/permissions.dart';
import '../../upload/upload_queue.dart' show NoRecordings;
import '../upload/cleanup_providers.dart';
import '../upload/earlier_recordings.dart' show gapReplaceThresholdSec;
import '../upload/join_providers.dart';
import '../../upload/recording_join.dart' show JoinOutcome, JoinSave;
import '../upload/upload_widgets.dart';
import '../../box/wire.dart' show cameraUseBlocksPull, externalCameraId;
import 'audio_inputs.dart';
import 'live_control_card.dart';
import 'live_controller.dart';
import 'live_destinations.dart';
import 'live_fold.dart';
import 'box_mic_test.dart';
import 'live_notice.dart';
import 'live_tv_show_card.dart';
import 'live_notice_box.dart';
import 'live_notice_sheet.dart';
import 'live_source.dart';
import 'live_source_widgets.dart';
import 'live_widgets.dart';
import 'live_youtube_later_gate.dart';
import 'mic_watch.dart';
import 'publisher.dart';
import 'web_publisher.dart';

export 'live_controller.dart';
export 'live_fold.dart';

// ---- the kuliah ----

class LiveKuliah {
  const LiveKuliah({
    required this.id,
    required this.date,
    required this.time,
    required this.label,
    this.penceramah,
    this.topic,
    this.slot,
    this.kitab,
  });

  final String id;

  /// `2026-11-04`, Malaysian date.
  final String date;

  /// `21:00`.
  final String time;
  final String label;
  final String? penceramah;
  final String? topic;

  /// `subuh`, `zohor`, `asar`, `maghrib`, `isyak` or `lain`.
  final String? slot;

  /// The kitab's title when the kuliah names one.
  final String? kitab;

  int get minutes {
    final p = time.split(':');
    if (p.length < 2) return 0;
    return (int.tryParse(p[0]) ?? 0) * 60 + (int.tryParse(p[1]) ?? 0);
  }

  DateTime get at {
    final d = DateTime.tryParse(date) ?? DateTime(2000);
    return DateTime(d.year, d.month, d.day, minutes ~/ 60, minutes % 60);
  }
}

class LiveKuliahChoice {
  const LiveKuliahChoice({
    required this.today,
    required this.upcoming,
    required this.preselected,
  });

  final List<LiveKuliah> today;
  final List<LiveKuliah> upcoming;

  /// Today's kuliah nearest to now, or null for none today.
  final String? preselected;

  LiveKuliah? byId(String? id) {
    for (final k in [...today, ...upcoming]) {
      if (k.id == id) return k;
    }
    return null;
  }
}

/// What the live notice is built from: the chosen kuliah (null: the sentence
/// about the surau's live), the watch link's id and the surau's name.
LiveNoticeInput liveNoticeInputFor(String videoId, LiveKuliah? k, String? surau) => LiveNoticeInput(
  videoId: videoId,
  slot: k?.slot,
  label: k?.label,
  start: k?.at,
  speaker: k?.penceramah,
  kitab: k?.kitab,
  topic: k?.topic,
  surau: surau,
);

String _ymd(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';

/// Today's and upcoming `aktif` kuliah with their penceramah's names, and
/// the one to pre-select: the slot nearest to now.
LiveKuliahChoice pickKuliah(
  List<Map<String, dynamic>> kuliah,
  List<Map<String, dynamic>> penceramah,
  DateTime localNow, {
  List<Map<String, dynamic>> kitab = const [],
}) {
  final names = {
    for (final p in penceramah)
      if (p['id'] is String && p['name'] is String)
        p['id'] as String: p['name'] as String,
  };
  final kitabTitles = {
    for (final k in kitab)
      if (k['id'] is String && k['title'] is String) k['id'] as String: k['title'] as String,
  };
  final today = _ymd(localNow);
  final all = <LiveKuliah>[
    for (final k in kuliah)
      if (k['status'] == 'aktif' && k['id'] is String && k['date'] is String)
        LiveKuliah(
          id: k['id'] as String,
          date: k['date'] as String,
          time: (k['time'] as String?) ?? '00:00',
          label: (k['label'] as String?) ?? 'Kuliah',
          penceramah: names[k['penceramahId']],
          topic: (k['topic'] as String?)?.trim().isEmpty ?? true
              ? null
              : k['topic'] as String,
          slot: k['slot'] as String?,
          kitab: kitabTitles[k['kitabId']],
        ),
  ]..sort((a, b) => a.at.compareTo(b.at));
  final todays = all.where((k) => k.date == today).toList();
  final upcoming = all
      .where((k) => k.date.compareTo(today) > 0)
      .take(6)
      .toList();
  final nowMin = localNow.hour * 60 + localNow.minute;
  LiveKuliah? nearest;
  for (final k in todays) {
    if (nearest == null ||
        (k.minutes - nowMin).abs() < (nearest.minutes - nowMin).abs()) {
      nearest = k;
    }
  }
  return LiveKuliahChoice(
    today: todays,
    upcoming: upcoming,
    preselected: nearest?.id,
  );
}

final liveKuliahProvider = FutureProvider<LiveKuliahChoice>((ref) async {
  ref.watch(dataVersionProvider);
  final gateway = ref.watch(gatewayProvider);
  final deps = ref.watch(appDepsProvider);
  if (gateway == null) {
    return const LiveKuliahChoice(today: [], upcoming: [], preselected: null);
  }
  List<Map<String, dynamic>> items(Map<String, dynamic> body) => [
    for (final i in (body['items'] as List? ?? const []))
      if (i is Map) i.cast<String, dynamic>(),
  ];
  final kuliah = items((await gateway.get('/api/content/kuliah')).value);
  final penceramah = items(
    (await gateway.get('/api/content/penceramah')).value,
  );
  // The kitab titles are a help for the live notice: a failed read leaves them out.
  var kitab = const <Map<String, dynamic>>[];
  try {
    kitab = items((await gateway.get('/api/content/kitab')).value);
  } catch (_) {}
  return pickKuliah(kuliah, penceramah, deps.toLocal(deps.now()), kitab: kitab);
});

// ---- the screen ----

/// The id a recording of the live that just ended is filed under: the
/// browser publisher's own id (read before it stopped), or the box session for
/// Android's files. Null when the browser's id is unknown: the catch-up then
/// does nothing rather than take another live's file.
String? catchUpSessionId({
  required bool web,
  required String? publisherSession,
  required String? boxSession,
}) => web ? publisherSession : boxSession;

class LiveScreen extends ConsumerStatefulWidget {
  const LiveScreen({super.key, this.openSettings = false});

  /// `?tetapan=1`: opened from Konfigurasi's pointer, so the Tetapan siaran card is open.
  final bool openSettings;

  @override
  ConsumerState<LiveScreen> createState() => _LiveScreenState();
}

/// The phone's remembered choice for the Tetapan siaran card (per phone, like the app's other small flags).
const _settingsChosenKey = 'live.settingsCardChosen';
const _settingsOpenKey = 'live.settingsCardOpen';

class _LiveScreenState extends ConsumerState<LiveScreen> {
  late final LivePublisher _publisher;
  StreamSubscription<PublisherState>? _sub;
  late PublisherState _state;
  late final LiveBoxNotifier _controller;
  bool _starting = false;

  bool _kuliahChosen = false;
  String? _kuliahId;
  // The YouTube choice for the next live is THIS BOX's own (`nextLiveOn` in its live status): it lives in
  // [liveDestinationsProvider], not in this screen, so a rebuilt screen shows the same choice (B5).

  /// The folded or open state of the idle sections (kept while the screen lives).
  final Map<String, bool> _open = {};

  /// What the destination strip shows, published after each build so the "Destinasi siaran" sheet (its own
  /// route) follows every change while it is open; null when the strip is not shown.
  final ValueNotifier<_Dest?> _dest = ValueNotifier<_Dest?>(null);

  /// The sheet is open (it may outlive this screen: see [dispose]).
  bool _sheetOpen = false;

  /// The camera was lost during this live (the "kembali" message follows its return).
  bool _cameraWasLost = false;

  /// The engine's end of a lost camera was already turned into a stop.
  bool _endHandled = false;

  /// The live the person said "Bukan sekarang" to for the busy suggestion (kept on this screen only).
  String? _busyLaterFor;

  /// The start screen has asked for the first test of the box microphones.
  bool _micTestAsked = false;

  /// The last answer of [youtubeLaterGate], so a change of it is written to the log once.
  YoutubeLaterGate? _lastLaterGate;

  @override
  void initState() {
    super.initState();
    if (widget.openSettings) _open['set'] = true;
    _publisher = ref.read(livePublisherProvider);
    _controller = ref.read(liveBoxProvider.notifier);
    _state = _publisher.current;
    _sub = _publisher.states.listen((s) {
      if (!mounted) return;
      setState(() => _state = s);
      if (s.camera?.isLost ?? false) _cameraWasLost = true;
      // a new session (live, no end reason) can end by itself again
      if (s.isLive && s.endReason == null) _endHandled = false;
      if (s.endReason == endedCameraLost && !_endHandled) {
        // The lost camera ran out its 10 minutes: the normal stop, with the reason on the screen.
        _endHandled = true;
        unawaited(_stopForLostCamera());
      } else if ((s.endReason == endedNotificationStop || s.endReason == endedUnattended) && !_endHandled) {
        // The engine has stopped already (the notification's "Hentikan siaran", or an unattended live it gave
        // up): the box session is ended too, and a stop nobody tapped for on this screen says why (B12).
        _endHandled = true;
        unawaited(_stopForEngineEnd(s.endReason!));
      }
    });
    final idleStart = _state.phase == PublisherPhase.idle || _state.phase == PublisherPhase.stopped;
    if (idleStart) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        // the camera switch may have changed while no live page was open: read it before the first prepare
        if (mounted) await _reloadSource();
        if (mounted) await _prepare();
      });
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _controller.attach();
      // what this device remembers and what the box says about the camera (also when the publisher is ready already)
      if (idleStart || _state.isLive) {
        unawaited(ref.read(liveSourceProvider.notifier).ensureLoaded());
      } else if (_state.phase == PublisherPhase.ready) {
        // Only where a re-prepare can follow: in the other phases (preparing, starting, stopping,
        // error) the publisher keeps what it has, and the source state must not move under it.
        unawaited(_reloadSource().then((changed) async {
          if (changed && mounted && _state.phase == PublisherPhase.ready) await _prepare();
        }));
      }
      // a microphone plugged in is picked up by itself
      ref.read(micAutoProvider.notifier).start();
    });
  }

  ScaffoldMessengerState? _messenger;
  MicAutoNotifier? _micAuto;
  String _stillLiveText = '';
  String _stillLiveBoxText = '';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.maybeOf(context);
    _micAuto = ref.read(micAutoProvider.notifier);
    _stillLiveText = S.of(context).ra4StillLive;
    _stillLiveBoxText = S.of(context).liveLeaveBoxPulled;
  }

  @override
  void dispose() {
    _micAuto?.stop();
    _controller.detach();
    // The live goes on without this page (its heartbeat is the controller's): say so once.
    if (_controller.takeLeaveReminder()) {
      final messenger = _messenger;
      // a live the box pulls goes on in MAXCOM's hands: the reminder says so (build 4, U8)
      final text = _controller.leaveReminderBoxPulled ? _stillLiveBoxText : _stillLiveText;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        try {
          messenger?.showSnackBar(SnackBar(content: Text(text)));
        } on Object {
          // the app is closing or has no page to show it on
        }
      });
    }
    _sub?.cancel();
    if (_sheetOpen) {
      // The sheet is still up (a root route): it closes itself on a null value; _openDestSheet releases the notifier.
      final d = _dest;
      WidgetsBinding.instance.addPostFrameCallback((_) => d.value = null);
    } else {
      _dest.dispose();
    }
    super.dispose();
  }

  bool get _recordingOn {
    final settings = ref.read(settingsProvider).value?.value;
    final v = settings?['recording'];
    if (v is Map && v['enabled'] is bool) return v['enabled'] as bool;
    return reg.features.firstWhere((f) => f.key == 'recording').defaultEnabled;
  }

  /// Reads the camera part of the source again (not during a live: its changes wait for the stop).
  /// True when the chosen video source changed because of it.
  Future<bool> _reloadSource() async {
    if (_state.isLive) return false;
    final before = ref.read(liveSourceProvider).video;
    await ref.read(liveSourceProvider.notifier).reloadForPage();
    return ref.read(liveSourceProvider).video != before;
  }

  Future<void> _prepare() {
    _cameraWasLost = false;
    // B11: while this phone only controls a live the box pulls, it opens no camera of its own
    if (_controlsOnly(ref.read(liveBoxProvider))) return _releasePrepared();
    return ref
        .read(liveSourceProvider.notifier)
        .prepare(recording: _recordingChosen(ref.read(liveSourceProvider)), frontCamera: _state.frontCamera);
  }

  static bool _controlsOnly(LiveBoxStatus box) => box.controlOnly && box.sessionId != null;

  /// Lets go of a camera (or a pull) the publisher prepared before this phone became the controller only.
  Future<void> _releasePrepared() async {
    final p = _publisher;
    if (p is LivePreparedRelease && !p.current.isLive) await (p as LivePreparedRelease).releasePrepared();
  }

  /// A stop nobody tapped for: the engine gave the lost camera up. It says why (B12).
  Future<void> _stopForLostCamera() async {
    final s = S.of(context);
    await ref.read(liveBoxProvider.notifier).stopLive(notice: s.liveStoppedCameraLost, path: 'camera_lost');
    if (!mounted) return;
    await _prepare();
  }

  Future<void> _stopForEngineEnd(String reason) async {
    final s = S.of(context);
    await ref
        .read(liveBoxProvider.notifier)
        .stopLive(notice: reason == endedUnattended ? s.liveStoppedUnattended : null, path: reason);
    if (!mounted) return;
    await _prepare();
  }

  /// "Sambung semula" on the card of this device's own live (B9): the publisher is made ready, then the box gives
  /// the session back with fresh targets.
  Future<void> _resumeMine() async {
    if (_resuming) return;
    setState(() => _resuming = true);
    try {
      if (_state.phase != PublisherPhase.ready) await _prepare();
      if (!mounted) return;
      await ref.read(liveBoxProvider.notifier).resumeLive();
    } catch (_) {
      // the controller has put the reason on the screen
    } finally {
      if (mounted) setState(() => _resuming = false);
    }
  }

  bool _resuming = false;

  /// Why YouTube cannot be used now, or null when it can.
  ///
  /// [asReason] gives the same cause as a clause for "YouTube tidak dapat digunakan sekarang: ...", without
  /// "YouTube:" in front (the dialog already starts with the name).
  String? _youtubeBlock(S s, LiveBoxStatus box, bool canSignIn, {bool asReason = false}) {
    if (!box.internet) return asReason ? s.liveYoutubeWhyNoInternet : s.liveWarnNoInternet;
    // The box's own word for what stands in the way (Y9): said as it is, not as a generic failure.
    final own = switch (box.youtubeError) {
      'live_not_enabled' => s.errcYoutubeLiveNotEnabled,
      'clock_wrong' => s.errcBoxClockWrong,
      'busy_other_box' => s.errcYoutubeBusyOtherBox,
      'client_refused' => s.errcYoutubeClientRefused,
      _ => null,
    };
    if (own != null && box.youtube.signedIn) return own;
    if (box.youtube.phase == YoutubeAccountPhase.unknown) {
      return asReason ? youtubeUnknownReason(s, box.youtube.channel) : youtubeUnknownText(s, box.youtube.channel);
    }
    if (!box.youtube.signedIn) {
      if (box.youtube.reason == YoutubeSignOutReason.revoked) {
        return asReason ? s.liveYoutubeWhyRevoked : s.liveYoutubeRevoked;
      }
      if (asReason) return canSignIn ? s.liveYoutubeWhyNeedsSignIn : s.liveYoutubeWhyAskAdmin;
      return canSignIn ? s.liveYoutubeNeedsSignIn : s.liveYoutubeAskAdmin;
    }
    return null;
  }

  /// "Destinasi siaran": the full text of each destination, the YouTube switch and Sambung, opened from any pill.
  Future<void> _openDestSheet() async {
    if (_dest.value == null || _sheetOpen) return;
    _sheetOpen = true;
    var popping = false;
    try {
      await _showDestSheet(() => popping, () => popping = true);
    } finally {
      _sheetOpen = false;
      // The screen went first (see dispose): the notifier is ours to release now that the sheet is gone.
      if (!mounted) _dest.dispose();
    }
  }

  Future<void> _showDestSheet(bool Function() popping, VoidCallback markPopping) {
    // The sheet can outlive this screen: the choice is the provider's, reached without this widget's ref.
    final destinations = ref.read(liveDestinationsProvider.notifier);
    return showModalBottomSheet<void>(
      context: context,
      // over the whole app, the navigation bar included (mockup live-dest-strip, option A)
      useRootNavigator: true,
      isScrollControlled: true,
      showDragHandle: false,
      barrierColor: SurauColors.glass.withValues(alpha: 0.45),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (sheetContext) => ValueListenableBuilder<_Dest?>(
        valueListenable: _dest,
        builder: (context, dest, _) {
          if (dest == null) {
            // The strip went away (a live started, another device's live, the screen closed): so does its sheet,
            // popped once.
            if (!popping()) {
              markPopping();
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (sheetContext.mounted && ModalRoute.of(sheetContext)?.isCurrent == true) {
                  Navigator.of(sheetContext).pop();
                }
              });
            }
            return const SizedBox.shrink();
          }
          return _DestSheet(
            dest: dest,
            // A tap while a write is on its way is queued by the provider and applied after it, never dropped (B5).
            onYoutube: dest.youtubeEnabled ? (_) => unawaited(destinations.choose(!dest.wanted)) : null,
            onKiosk: (on) => unawaited(_setKiosk(on)),
            onRecording: (on) => unawaited(_setRecording(on)),
            onConnect: () {
              Navigator.of(sheetContext).pop();
              if (mounted) setState(() => _open['set'] = true);
            },
          );
        },
      ),
    );
  }

  /// Mula siaran with YouTube chosen but not usable: ask, never start TV only silently.
  Future<void> _askTvOnly(String reason) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        key: const ValueKey('live-youtube-ask'),
        title: Text(s.liveYoutubeAskTitle),
        content: Text(s.liveYoutubeAskBody(reason)),
        actions: [
          TextButton(
            key: const ValueKey('live-youtube-ask-cancel'),
            onPressed: () => Navigator.of(dialogContext, rootNavigator: true).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('live-youtube-ask-yes'),
            onPressed: () => Navigator.of(dialogContext, rootNavigator: true).pop(true),
            child: Text(s.liveYoutubeAskYes),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _start(false);
  }

  Future<void> _start(bool youtube) async {
    if (_starting) return;
    setState(() => _starting = true);
    final source = ref.read(liveSourceProvider);
    // a new live starts from what the box measures: the hand-set offset of the last one is not carried over
    ref.read(liveSourceProvider.notifier).rememberOffset(idBoxInput, 0);
    try {
      ref.read(liveSourceProvider.notifier).liveStarting();
      await ref
          .read(liveBoxProvider.notifier)
          .startLive(
            kuliahId: _kuliahId,
            youtube: youtube,
            video: source.video,
            mix: source.mix,
            // the box pulls the camera only by the admin's choice, on a phone (a browser's external live is always the box's)
            videoPath: source.boxPull && !_ipad ? videoPathBox : null,
            kiosk: ref.read(liveKioskChoiceProvider) || !ref.read(liveBoxProvider).canToggleKiosk,
            recording: _recordingChosen(source),
          );
    } catch (_) {
      // the controller has put the reason on the screen
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  /// Rakam for the next live: the person's switch, else today's `recording` setting; never on a phone that only
  /// controls (the box pulls the camera, nothing arrives to record).
  bool _recordingChosen(LiveSourceState source) {
    if (source.boxPull && !_ipad) return false;
    return ref.read(liveRecordingChoiceProvider) ?? _recordingOn;
  }

  /// The Skrin switch in "Destinasi siaran": before the start it is kept on this device; during the live the box
  /// is asked (`POST /api/live/outputs`) and the screen follows its answer.
  Future<void> _setKiosk(bool on) async {
    final box = ref.read(liveBoxProvider);
    if (box.sessionId != null) {
      // the box counts its destinations by what it was told: say whether the recording really runs now, so its
      // `last_output` rule and the screen's count agree
      final source = ref.read(liveSourceProvider);
      final recAvailable = !((source.boxPull && !_ipad) || (box.controlOnly && box.sessionId != null));
      await ref
          .read(liveBoxProvider.notifier)
          .setOutputs(kiosk: on, recording: recAvailable && box.canToggleKiosk ? _state.recording.active : null);
    } else {
      await ref.read(liveKioskChoiceProvider.notifier).set(on);
    }
  }

  /// The Rakam switch: before the start the choice is held for that start; during the live the recording of this
  /// device stops (what is recorded so far is kept) or starts again.
  Future<void> _setRecording(bool on) async {
    final box = ref.read(liveBoxProvider);
    final pub = _publisher;
    if (box.sessionId != null) {
      if (pub is! LiveRecordingControl) return;
      // the box is asked first (its last-destination rule may refuse); the local recording changes only when it agreed.
      // A box without the outputs route has nothing to ask.
      if (box.canToggleKiosk && !await ref.read(liveBoxProvider.notifier).setOutputs(recording: on)) return;
      try {
        await (pub as LiveRecordingControl).setRecording(on);
      } on Object {
        // the box agreed but this device could not: tell the box what really runs
        if (box.canToggleKiosk) await ref.read(liveBoxProvider.notifier).setOutputs(recording: !on);
      }
      return;
    }
    ref.read(liveRecordingChoiceProvider.notifier).set(on);
    if (pub is LiveRecordingControl) {
      await (pub as LiveRecordingControl).setRecording(on);
    } else if (!_state.isLive) {
      unawaited(_prepare());
    }
  }

  Future<void> _openWatch(String? url) async {
    final uri = watchUri(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } on Object {
      // no browser to open it: the link is in the notice
    }
  }

  /// U6: another person's live the box pulls is stopped from here; the sheet names who started it and says both
  /// names are written to the change log.
  Future<void> _confirmStopOther(OtherLive other) async {
    final s = S.of(context);
    final name = other.starterName;
    final device = other.starterDevice;
    final at = other.startedAt;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          key: const ValueKey('live-stop-other-sheet'),
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(header: true, child: Text(s.liveStopOtherTitle, style: Theme.of(sheetContext).textTheme.titleMedium)),
              const SizedBox(height: 12),
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: SurauColors.tealSoft,
                    child: Text(name.isEmpty ? '' : name.characters.first.toUpperCase()),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      [
                        bidiIsolate(name),
                        if (at != null) TimeOfDay.fromDateTime(at.toLocal()).format(sheetContext),
                      ].join(', '),
                      key: const ValueKey('live-stop-other-who'),
                      style: Theme.of(sheetContext).textTheme.titleSmall,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                device == null ? s.liveStopOtherBodyNoDevice(bidiIsolate(name)) : s.liveStopOtherBody(bidiIsolate(name), bidiIsolate(device)),
                key: const ValueKey('live-stop-other-body'),
              ),
              const SizedBox(height: 6),
              Text(s.liveStopConfirmBody),
              const SizedBox(height: 6),
              Text(
                s.liveStopOtherLog(bidiIsolate(name)),
                style: Theme.of(sheetContext).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const ValueKey('live-stop-other-cancel'),
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      onPressed: () => Navigator.of(sheetContext, rootNavigator: true).pop(false),
                      child: Text(s.actionCancel),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      key: const ValueKey('live-stop-other-confirm'),
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(48),
                        backgroundColor: LiveColors.onAir,
                        foregroundColor: Colors.white,
                      ),
                      onPressed: () => Navigator.of(sheetContext, rootNavigator: true).pop(true),
                      child: Text(s.liveStopConfirmAction),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
    if (ok == true && mounted) await ref.read(liveBoxProvider.notifier).emergencyStop();
  }

  Future<void> _confirmStop() async {
    if (_stopAsked) return;
    _stopAsked = true;
    try {
      await _askAndStop();
    } finally {
      _stopAsked = false;
    }
  }

  // A second tap while the first stop is asking or running does nothing.
  bool _stopAsked = false;

  Future<void> _askAndStop() async {
    final s = S.of(context);
    // The dialog sits on the root navigator and closes itself through its
    // OWN context on that navigator: the pop can only ever remove the dialog
    // route, whatever the screen underneath rebuilds into.
    final ok = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        key: const ValueKey('live-stop-dialog'),
        title: Text(s.liveStopConfirm),
        content: Text(s.liveStopConfirmBody),
        actions: [
          TextButton(
            key: const ValueKey('live-stop-cancel'),
            onPressed: () =>
                Navigator.of(dialogContext, rootNavigator: true).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('live-stop-confirm'),
            style: FilledButton.styleFrom(
              backgroundColor: LiveColors.onAir,
              foregroundColor: Colors.white,
            ),
            onPressed: () {
              // B12: a second tap of a fast double tap on Berhenti must never
              // land here. The confirm takes a tap only once the dialog has
              // fully opened (it has been seen), not while it is flying in.
              final opening = ModalRoute.of(dialogContext)?.animation;
              if (opening != null && opening.status != AnimationStatus.completed) return;
              Navigator.of(dialogContext, rootNavigator: true).pop(true);
            },
            child: Text(s.liveStopConfirmAction),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    // The real stop starts only once the dialog route is fully gone (its
    // close animation is over), never while a route is still popping.
    await Future<void>.delayed(const Duration(milliseconds: 250));
    if (!mounted) return;
    final boxBefore = ref.read(liveBoxProvider);
    // The box pulls the camera and this phone only controlled: no engine clock, no leg and no recording of its own.
    final control = boxBefore.controlOnly && boxBefore.sessionId != null;
    final duration = _state.isLive ? _state.durationSec : boxBefore.runSeconds(ref.read(appDepsProvider).now());
    final youtubeUsed = control ? boxBefore.youtubeViaBox : _state.outputs.youtube != null;
    final recorded = !control && _state.recording.on;
    final boxSession = boxBefore.sessionId;
    // The browser's own id of this recording, read before the stop (the catch-up names it).
    final publisherSession = _publisher.recordingSessionId;
    final kuliahId = _kuliahId;
    await ref.read(liveBoxProvider.notifier).stopLive();
    if (!mounted) return;
    final stopped = !ref.read(liveBoxProvider).stopFailed;
    final web = ref.read(appDepsProvider).platform != 'android';
    final youtubeSeconds = youtubeUsed
        ? ref.read(liveBoxProvider).youtubeSeconds
        : null;
    final watchUrl = youtubeUsed ? ref.read(liveBoxProvider).watchUrl : null;
    final summaryNotice = _noticeInput(watchUrl, ref.read(liveKuliahProvider).value?.byId(kuliahId));
    // Android: the names the engine wrote bind the recording to this live.
    if (recorded && !web) await _rememberRecordings(boxSession);
    // The pieces of this live become ONE file (the old per-piece clean-up is replaced by one question later).
    final join = recorded ? await _joinPieces(web: web, boxSession: boxSession, publisherSession: publisherSession) : null;
    final cleanupCovered = await _registerCleanup(
      join: join,
      recorded: recorded,
      web: web,
      boxSession: boxSession,
      publisherSession: publisherSession,
      kuliahId: kuliahId,
      durationSec: duration,
      youtubeSeconds: youtubeSeconds,
      liveVideoId: youtubeVideoId(watchUrl),
    );
    if (!mounted) return;
    if (!stopped) {
      // The box has not confirmed the stop: the retry notice stays and no summary is made yet.
      await _prepare();
      return;
    }
    // The catch-up: YouTube never had the live, or had a minute less than
    // the whole, and this device holds the recording.
    final catchUp =
        recorded &&
        ref.read(featureFlagsProvider).isOn('youtubeCatchUp') &&
        ref.read(catchUpQueueProvider) != null &&
        // the phone's own count of the YouTube leg, or the gaps the BOX recorded for this live (D1: a dropped
        // stream the phone's count never saw)
        (liveNeedsCatchUp(durationSec: duration, youtubeSeconds: youtubeSeconds) ||
            ref.read(liveBoxProvider).endedGapSeconds >= gapReplaceThresholdSec);
    final goUpload = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => LiveSummarySheet(
        durationSec: duration,
        youtubeSeconds: youtubeSeconds,
        recorded: recorded,
        web: web,
        kuliah: ref.read(liveKuliahProvider).value?.byId(kuliahId),
        watchUrl: watchUrl,
        recordingNotes: recorded ? _recordingNotes(join, cleanupCovered, web: web) : const [],
        // said plainly, never hidden: why this live has no recording on the phone
        noRecordingWhy: control ? S.of(context).liveRecNoBoxPullSummary : null,
        onWatch: (url) => ref.read(appDepsProvider).openUrl(Uri.parse(url)),
        onSave: () => _saveRecording(),
        onShareNotice: summaryNotice == null
            ? null
            : () => showLiveNoticeSheet(sheetContext, ref, input: summaryNotice),
        onCatchUp: catchUp
            ? (sheetContext) => _catchUp(
                sheetContext,
                boxSession: boxSession,
                publisherSession: publisherSession,
                kuliahId: kuliahId,
                liveVideoId: youtubeVideoId(watchUrl),
                web: web,
              )
            : null,
      ),
    );
    if (!mounted) return;
    if (goUpload == true) {
      GoRouter.of(context).go(AppRoutes.upload);
      return;
    }
    await _prepare();
  }

  /// Stores the exact file names the live engine reported for [session]
  /// (Android). The clean-up and the catch-up upload use only these.
  Future<void> _rememberRecordings(String? session) async {
    final files = ref.read(sessionFilesProvider);
    if (session == null || files == null) return;
    try {
      await files.save(
        session,
        await ref.read(livePublisherProvider).sessionRecordings(),
      );
    } on Object {
      // no names stored: nothing of this live is deleted or uploaded by itself
    }
  }

  /// Joins the pieces of the live that just ended into one file (Android: on the phone with MediaMuxer; web: the box
  /// joins the pieces the browser uploads). Never throws; a failure keeps every piece.
  Future<JoinOutcome> _joinPieces({
    required bool web,
    required String? boxSession,
    required String? publisherSession,
  }) async {
    try {
      if (!web) {
        final files = ref.read(sessionFilesProvider);
        if (boxSession == null || files == null) return const JoinOutcome.nothing();
        final names = await files.names(boxSession);
        final out = await ref.read(androidRecordingJoinerProvider).join(names);
        if (!out.joined) return out;
        // The phone has already removed the pieces and named the joined file: that name is the truth from now on, so a
        // failed save is tried again and never turns the join into a failure. The joined file is the recording of this
        // live (upload, clean-up and the question use it); pieces the phone could not remove stay in the record too.
        final record = [out.name!, ...out.leftoverNames];
        for (var attempt = 0; attempt < 2; attempt++) {
          try {
            await files.save(boxSession, record);
            return out;
          } on Object {
            // try once more
          }
        }
        return out.untracked();
      }
      final joiner = ref.read(webRecordingJoinProvider);
      if (joiner == null || boxSession == null || publisherSession == null) return const JoinOutcome.nothing();
      final out = await joiner.upload(liveId: boxSession, sessionId: publisherSession);
      ref
          .read(webJoinedProvider.notifier)
          .set(out.joined ? WebJoined(liveId: boxSession, sessionId: publisherSession, fileName: out.name!) : null);
      return out;
    } on Object {
      return const JoinOutcome.failed('join_failed');
    }
  }

  /// "Simpan rakaman": the joined file (web) in one tap, else the pieces one by one as before.
  Future<void> _saveRecording() async {
    final joined = ref.read(webJoinedProvider);
    final joiner = ref.read(webRecordingJoinProvider);
    if (joined != null && joiner != null) {
      final r = await joiner.saveJoined(liveId: joined.liveId, sessionId: joined.sessionId);
      if (r == JoinSave.handedOver) {
        // A click on a download link does not prove the browser kept the file: nothing is deleted until the person says so.
        if (!mounted) return;
        final yes = await _askSavedInDownloads();
        if (yes == true) {
          await joiner.confirmSaved(liveId: joined.liveId, sessionId: joined.sessionId);
          ref.read(webJoinedProvider.notifier).set(null);
        } else if (mounted) {
          await _tell(S.of(context).liveRecSavedNotYetNote);
        }
        return;
      }
      if (r == JoinSave.tooBig && mounted) await _tell(S.of(context).liveRecSaveTooBigNote);
    }
    await ref.read(liveBoxProvider.notifier).savePending();
  }

  /// "Is the recording saved in Files/Downloads?" Yes deletes the local pieces and the box copy; Not yet keeps both.
  Future<bool?> _askSavedInDownloads() {
    final s = S.of(context);
    return showDialog<bool>(
      context: context,
      useRootNavigator: true,
      barrierDismissible: false,
      builder: (d) => AlertDialog(
        content: Text(s.liveRecSavedAsk, key: const ValueKey('rec-saved-ask')),
        actions: [
          TextButton(
            key: const ValueKey('rec-saved-no'),
            onPressed: () => Navigator.of(d, rootNavigator: true).pop(false),
            child: Text(s.liveRecSavedNo),
          ),
          FilledButton(
            key: const ValueKey('rec-saved-yes'),
            onPressed: () => Navigator.of(d, rootNavigator: true).pop(true),
            child: Text(s.liveRecSavedYes),
          ),
        ],
      ),
    );
  }

  Future<void> _tell(String text) {
    final s = S.of(context);
    return showDialog<void>(
      context: context,
      useRootNavigator: true,
      builder: (d) => AlertDialog(
        content: Text(text, key: const ValueKey('rec-tell')),
        actions: [
          FilledButton(onPressed: () => Navigator.of(d, rootNavigator: true).pop(), child: Text(s.actionClose)),
        ],
      ),
    );
  }

  /// The words under the summary about the recording: joined or not, and what happens with it.
  List<String> _recordingNotes(JoinOutcome? join, bool? covered, {required bool web}) => recordingNotesFor(join, covered, web: web);

  /// Tells the clean-up which files this live recorded (Plan 6 Task 13). Nothing of it is deleted by itself any more
  /// (2026.11.14): once YouTube has the whole of it and the file is one joined file, the person is asked once. A failed
  /// join keeps everything for good. Answers true when the live leg alone covered the whole recording (the question
  /// will come), false when not, null when the clean-up is not in use.
  Future<bool?> _registerCleanup({
    required JoinOutcome? join,
    required bool recorded,
    required bool web,
    required String? boxSession,
    required String? publisherSession,
    required String? kuliahId,
    required int durationSec,
    required int? youtubeSeconds,
    required String? liveVideoId,
  }) async {
    final cleanup = ref.read(recordingCleanupProvider);
    if (!recorded || cleanup == null) return null;
    try {
      final session = catchUpSessionId(web: web, publisherSession: publisherSession, boxSession: boxSession);
      if (session == null) return null;
      // Web: the pieces go with the save of the joined file; the app cannot delete what the browser saved: nothing to ask.
      final keepForGood = web || (join?.failed ?? false);
      await cleanup.register(
        sessionId: session,
        kuliahId: kuliahId,
        durationSec: durationSec,
        youtubeSeconds: youtubeSeconds,
        liveVideoId: liveVideoId,
        ask: true,
        keepForGood: keepForGood,
      );
      final rec = (await cleanup.records())[session];
      final s = ref.read(cleanupSettingsProvider);
      if (rec == null || !s.enabled) return null;
      unawaited(cleanup.run());
      return rec.liveCovered;
    } on Object {
      return null;
    }
  }

  /// Asks (when the setting says `ask` and the live has a video) whether
  /// the gappy live is replaced, enqueues the recording and answers true
  /// once the job is in the queue.
  Future<bool> _catchUp(
    BuildContext sheetContext, {
    required String? boxSession,
    required String? publisherSession,
    required String? kuliahId,
    required String? liveVideoId,
    required bool web,
  }) async {
    final queue = ref.read(catchUpQueueProvider);
    if (queue == null) return false;
    String? replace;
    if (liveVideoId != null) {
      final ended = ref.read(liveBoxProvider);
      // A box that records gaps (it named the broadcasts of the live) decides "always" by its own measure: the
      // live is replaced only when its gap passes the threshold. An older box says nothing: as before.
      final boxMeasures = ended.endedBroadcastIds.isNotEmpty;
      switch (catchUpReplaceMode(ref.read(settingsProvider).value?.value)) {
        case 'always':
          replace = !boxMeasures || ended.endedGapSeconds >= gapReplaceThresholdSec ? liveVideoId : null;
        case 'never':
          replace = null;
        default:
          final choice = await showModalBottomSheet<bool>(
            context: sheetContext,
            isScrollControlled: true,
            builder: (_) => const ReplaceLiveSheet(),
          );
          if (choice == null) return false;
          replace = choice ? liveVideoId : null;
      }
    }
    // The browser files its recording under its own session id, read before
    // the stop; Android files go by the box session. Never "the newest file".
    final session = catchUpSessionId(web: web, publisherSession: publisherSession, boxSession: boxSession);
    if (session == null) return false;
    // Right after a stop the phone may still be publishing the files to its gallery (U2): a first look that finds
    // nothing is tried again briefly before the offer is given up (the recording stays under "Muat naik rakaman
    // terdahulu" either way).
    for (var attempt = 0; ; attempt++) {
      try {
        await queue.enqueueFromSession(session, kuliahId, replaceLive: replace);
        break;
      } on NoRecordings {
        if (web || attempt >= 2) return false;
        await Future<void>.delayed(const Duration(seconds: 1));
      }
    }
    unawaited(queue.kick());
    return true;
  }

  /// `Muat naik` on the unsaved-recordings banner: every session still on
  /// this device that is not in the queue yet goes in, oldest first.
  Future<void> _uploadPending() async {
    final queue = ref.read(catchUpQueueProvider);
    final store = ref.read(recordingsStoreProvider);
    if (queue == null || store == null) return;
    final known = {for (final j in await queue.jobs()) j.sessionId};
    final files = await store.pending()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final sessions = <String, String?>{};
    for (final f in files) {
      if (known.contains(f.sessionId)) continue;
      sessions.putIfAbsent(
        f.sessionId,
        () => f.label == 'siaran' ? null : f.label,
      );
    }
    for (final e in sessions.entries) {
      try {
        await queue.enqueueFromSession(e.key, e.value);
      } on NoRecordings {
        // nothing left of that session
      }
    }
    unawaited(queue.kick());
    if (mounted) GoRouter.of(context).go(AppRoutes.upload);
  }

  Future<void> _pickKuliah(LiveKuliahChoice choice) async {
    final picked = await showModalBottomSheet<_Picked>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _KuliahSheet(choice: choice, selected: _kuliahId),
    );
    if (picked != null && mounted) {
      setState(() {
        _kuliahChosen = true;
        _kuliahId = picked.id;
      });
    }
  }

  bool get _ipad => ref.read(liveDeviceKindProvider) == 'ipad';

  // ---- the source and the audio mix ----

  /// What the engine and the box say per source: the box's rows first, the
  /// engine's own (the phone mixes its camera and microphone) over them.
  Map<String, LiveRowInfo> _rowInfo(LiveBoxStatus box) {
    final m = <String, LiveRowInfo>{
      for (final a in box.audio)
        a.id: LiveRowInfo(
          volume: a.volume,
          level: a.meter,
          state: a.state,
          alignState: a.alignState,
          delayMs: a.delayMs,
        ),
    };
    final pa = _state.audio;
    if (pa != null) {
      for (final r in pa.rows) {
        m[r.id] = LiveRowInfo(
          volume: r.volume,
          level: r.level,
          state: r.state,
          alignState: r.alignState,
          delayMs: r.delayMs,
        );
      }
    }
    return m;
  }

  /// The mix of a live another device runs, read from the box (read-only).
  LiveSourceState _viewFromBox(LiveSourceState base, LiveBoxStatus box) {
    final other = box.otherLive;
    AudioSourceMix of(String id, AudioSourceMix d) {
      final a = box.audioOf(id);
      return a == null ? d : AudioSourceMix(enabled: a.enabled, volume: a.volume);
    }

    final ext = other?.video == 'external' || box.audioOf(idCamera) != null;
    const off = AudioSourceMix(enabled: false, volume: 100);
    return base.copyWith(
      listed: {...base.listed, for (final a in box.audio) a.id},
      video: ext ? VideoSourceKind.external : VideoSourceKind.phone,
      mix: LiveAudioMix(
        camera: of(idCamera, off),
        deviceMic: of(idDeviceMic, AudioSourceMix(enabled: !ext, volume: 100)),
        boxInput: of(idBoxInput, off),
      ),
    );
  }

  double _mixedLevel(LiveSourceState view, Map<String, LiveRowInfo> info) {
    final pa = _state.audio;
    if (pa != null) return pa.mixed;
    var best = 0.0;
    for (final id in [idCamera, idDeviceMic, idBoxInput]) {
      final m = mixOf(view.mix, id);
      if (!m.enabled || m.volume == 0) continue;
      final l = info[id]?.level ?? 0.5;
      if (l > best) best = l;
    }
    return best;
  }

  /// "Tambah audio": the new source is on and every other one off. During a live that takes the sound from the one
  /// on air, so the person is asked first.
  Future<void> _openAdd() async {
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => AddAudioSheet(source: ref.read(liveSourceProvider), ipad: _ipad),
    );
    if (id == null || !mounted) return;
    if (!await _confirmSoundSwitch(id)) return;
    await ref.read(liveSourceProvider.notifier).add(id);
  }

  /// During a live, putting another source on air restarts the sound for 2 to 3 seconds: ask first. True = go on.
  Future<bool> _confirmSoundSwitch(String id) async {
    final live = _publisher.current.isLive || ref.read(liveBoxProvider).sessionId != null;
    if (!live || !ref.read(liveSourceProvider.notifier).switchesTo(id)) return true;
    final s = S.of(context);
    final ok = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(20, 8, 20, 16),
          child: Column(
            key: const ValueKey('audio-switch-confirm'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(s.liveAudioSwitchConfirm, style: Theme.of(ctx).textTheme.titleMedium),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const ValueKey('audio-switch-cancel'),
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      onPressed: () => Navigator.pop(ctx, false),
                      child: Text(s.liveAudioSwitchCancel),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton(
                      key: const ValueKey('audio-switch-do'),
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: Text(s.liveAudioSwitchDo),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
    return ok == true;
  }

  /// A row's own mute button: a row that is on mutes and unmutes; a row that is off is turned on (the other one goes off).
  Future<void> _rowMute(String id, List<PhoneInput> inputs) async {
    final cur = mixOf(ref.read(liveSourceProvider).mix, id);
    if (cur.enabled) {
      await ref.read(audioRowActionsProvider).muteRow(id);
      return;
    }
    if (!await _confirmSoundSwitch(id) || !mounted) return;
    await ref.read(liveSourceProvider.notifier).setVolume(id, cur.volume == 0 ? 100 : cur.volume);
  }

  /// A phone input's switch turned on with the external camera makes the phone microphone the one sound.
  Future<void> _inputToggle(String id, bool on, List<PhoneInput> inputs) async {
    final st = ref.read(liveSourceProvider);
    if (on && st.external && !st.mix.deviceMic.enabled && !await _confirmSoundSwitch(idDeviceMic)) return;
    if (!mounted) return;
    await ref.read(audioRowActionsProvider).toggle(id, on, inputs);
  }

  /// The live ended: what this screen held for it (the Rakam choice of that start) goes.
  void _liveEnded() {
    ref.read(liveRecordingChoiceProvider.notifier).set(null);
  }

  Future<void> _confirmEmergency(String starter) async {
    final lang = appLangOf(context);
    final ok = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        key: const ValueKey('live-emergency-dialog'),
        title: Text(liveEmergencyTitle(lang, starter)),
        content: Text(liveEmergencyBody(lang, starter)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext, rootNavigator: true).pop(false),
            child: Text(S.of(context).actionCancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: LiveColors.onAir, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(dialogContext, rootNavigator: true).pop(true),
            child: Text(liveEmergencyStop(lang)),
          ),
        ],
      ),
    );
    if (ok == true && mounted) await ref.read(liveBoxProvider.notifier).emergencyStop();
  }

  bool _isOpen(String key) => _open[key] ?? false;

  void _toggle(String key) => setState(() => _open[key] = !_isOpen(key));

  /// The Tetapan siaran card: what the person chose on this phone, else open when no live runs and folded during one.
  /// A sign-in under way keeps it open (its code is the task at hand).
  bool _settingsOpen({required bool running, required bool signingIn}) {
    if (signingIn) return true;
    final now = _open['set'];
    if (now != null) return now;
    final chosen = ref.watch(uiFlagProvider(_settingsChosenKey)).value ?? false;
    if (chosen) return ref.watch(uiFlagProvider(_settingsOpenKey)).value ?? !running;
    return !running;
  }

  Future<void> _toggleSettings(bool open) async {
    setState(() => _open['set'] = !open);
    await setUiFlag(ref, _settingsChosenKey, true);
    await setUiFlag(ref, _settingsOpenKey, !open);
  }

  /// The notice for the running live: needs a public YouTube watch link and a
  /// holder of `live:control` (Siaran Langsung or Pentadbir).
  LiveNoticeInput? _noticeInput(String? watchUrl, LiveKuliah? kuliah) {
    final id = liveNoticeVideoId(watchUrl);
    if (id == null || !can(ref.read(rolesProvider), 'live:control')) return null;
    return liveNoticeInputFor(id, kuliah, ref.read(surauInfoProvider)?.name);
  }

  /// F4: "Siarkan ke YouTube" first asks for the title (prefilled) and the privacy (never more open than the surau's
  /// setting) and waits for a confirm; only then the box is called.
  Future<void> _askYoutubeLater() async {
    final settings = ref.read(settingsProvider).value?.value;
    final yt = settings?['liveYoutube'];
    final p = yt is Map ? yt['privacy'] : null;
    final max = p is String && const {'private', 'unlisted', 'public'}.contains(p) ? p : 'unlisted';
    final k = ref.read(liveKuliahProvider).value?.byId(_kuliahId);
    final surau = ref.read(surauInfoProvider)?.name;
    final prefill = k != null
        ? [k.label, if ((k.penceramah ?? '').isNotEmpty) k.penceramah!].join(': ')
        : ((surau ?? '').isNotEmpty ? 'Kuliah $surau' : S.of(context).liveYoutubeLaterSheetTitle);
    final choice = await showYoutubeLaterSheet(context, title: prefill, maxPrivacy: max);
    if (choice == null || !mounted) return;
    await ref.read(liveBoxProvider.notifier).startYoutubeLater(title: choice.title, privacy: choice.privacy);
  }

  Future<void> _openNotice(LiveNoticeInput? input) async {
    await showLiveNoticeSheet(context, ref, input: input);
  }

  /// What the control card of a box-pulled live shows, read from the box's status.
  /// The name of this box's own TV in the viewer list, else the name of the box the app is enrolled on.
  String _selfTvName(LiveBoxStatus box) {
    for (final v in box.viewers) {
      if (v.tvId == selfTvId && v.name.isNotEmpty && v.name != selfTvId) return v.name;
    }
    return ref.read(enrolledBoxProvider)?.name ?? 'MAXCOM';
  }

  /// "Matikan paparan siaran pada kotak ini": the box's own TV goes back to its normal display; the suggestion is
  /// done for this live either way.
  Future<void> _switchOwnTvOff(String? sessionId) async {
    final ok = await ref.read(liveTvShowProvider.notifier).set(selfTvId, false);
    if (!mounted) return;
    if (ok) {
      setState(() => _busyLaterFor = sessionId);
    } else {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(S.of(context).liveTvShowFailed)));
    }
  }

  Widget _controlCard({
    required S s,
    required LiveBoxStatus box,
    required LiveSourceState view,
    required AudioContext ctx,
    required Map<String, LiveRowInfo> info,
    required OtherLive? other,
    required bool ipad,
    required bool live,
    required bool boxCameraGone,
  }) {
    final now = ref.read(appDepsProvider).now();
    final seconds = box.startedAt != null ? box.runSeconds(now) : (_state.isLive ? _state.durationSec : 0);
    final camera = boxCameraGone
        ? ControlCamera.gone
        : box.warnings.contains(cameraSlow)
        ? ControlCamera.slow
        : ControlCamera.ok;
    final ytOn = box.sessionYoutube ?? box.youtubeViaBox;
    final ytLeg = box.youtubeLeg;
    final youtube = !ytOn
        ? ControlYoutube.off
        : (ytLeg == null ? box.youtubeSeconds > 0 : ytLeg.phase == OutputPhase.up)
        ? ControlYoutube.onAir
        : ControlYoutube.waiting;
    final benched = box.boxMicBenched;
    final micGone = box.boxMicLostSilent;
    final mix = view.mix;
    ControlSource? source(String id, String name, AudioSourceMix m) {
      if (!m.enabled) return null;
      final on = m.volume > 0;
      var sub = on ? s.liveCtlSubOnAir(m.volume) : s.liveCtlSubOff(m.volume);
      var dim = !on;
      var bad = false;
      if (boxCameraGone) {
        sub = s.liveCtlSubWaitingCam;
        dim = true;
      } else if (benched && id == idBoxInput) {
        sub = s.liveCtlSubBenched;
        dim = true;
      } else if (micGone && id == idBoxInput) {
        sub = s.liveCtlSubMicLost;
        dim = true;
      } else if (benched && id == idCamera) {
        sub = s.liveCtlSubMeanwhile;
        dim = false;
      } else if (id == idBoxInput && on && box.boxMicNoSignalSeconds != null && (box.boxMicSilent || box.boxMicSilentCovered)) {
        // build 5: the microphone is on air but sends no signal; with the camera sound carrying it reads plainly
        final since = TimeOfDay.fromDateTime(now.subtract(Duration(seconds: box.boxMicNoSignalSeconds!)).toLocal());
        sub = box.boxMicSilentCovered ? s.liveCtlSubNoSound : s.liveMicSilentRow(since.format(context));
        bad = box.boxMicSilent;
      }
      return ControlSource(id: id, name: name, sub: sub, level: info[id]?.level ?? 0, dim: dim, bad: bad);
    }

    final sources = <ControlSource>[
      ?source(idBoxInput, s.liveAudioBoxMicMain, mix.boxInput),
      ?source(idDeviceMic, ctx.micName, mix.deviceMic),
      ?source(idCamera, liveAudioCameraRow(ctx.lang), mix.camera),
    ];
    final rec = _state.recording;
    final recordingRow = ipad && live && rec.on
        ? ControlRecording(bytes: rec.bytes, segments: rec.segments, running: rec.active)
        : null;
    String? by;
    if (other != null) {
      final at = other.startedAt;
      final time = at == null ? '' : TimeOfDay.fromDateTime(at.toLocal()).format(context);
      final device = other.starterDevice;
      by = device == null
          ? s.liveCtlStartedByNoDevice(bidiIsolate(other.starterName), time)
          : s.liveCtlStartedBy(bidiIsolate(other.starterName), bidiIsolate(device), time);
    }
    return LiveControlCard(
      seconds: seconds,
      camera: camera,
      cameraName: view.camera.name,
      cameraKbps: box.cameraKbps,
      youtube: youtube,
      youtubeLabel: box.youtube.channel ?? s.liveYoutubeHint,
      viewers: box.viewers,
      kioskOn: box.sessionKiosk ?? true,
      sources: sources,
      startedBy: by,
      recording: recordingRow,
      onWatchYoutube: box.watchUrl == null ? null : () => unawaited(_openWatch(box.watchUrl)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final s = S.of(context);
    final flags = ref.watch(featureFlagsProvider);
    final box = ref.watch(liveBoxProvider);
    final roles = ref.watch(rolesProvider);
    final canSettings = can(roles, 'live:settings');
    final canEmergency = can(roles, 'settings:write');
    final source = ref.watch(liveSourceProvider);
    final sourceNotifier = ref.read(liveSourceProvider.notifier);
    // A live that got (or lost) its watch link: the box's notice is read again.
    ref.listen(micAutoProvider.select((m) => m.toast), (_, t) {
      if (t == null) return;
      final mic = ref.read(micAutoProvider.notifier);
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(
          content: Text(MicAutoNotifier.toastText(t, lang)),
          action: t.undo ? SnackBarAction(label: liveMicUndo(lang), onPressed: () => unawaited(mic.undo())) : null,
        ),
      );
    });
    ref.listen(liveBoxProvider.select((b) => b.watchUrl), (_, _) => ref.invalidate(liveBoxNoticeProvider));
    ref.listen(settingsProvider, (_, _) async {
      // The camera switch or its name changed in Tetapan: read it again (not during a live).
      if (!mounted || _state.isLive) return;
      final before = ref.read(liveSourceProvider).video;
      await sourceNotifier.refresh();
      if (!mounted) return;
      if (ref.read(liveSourceProvider).video != before && _state.phase == PublisherPhase.ready) {
        await _prepare();
      }
    });
    // the moment the sign-in completes while this screen is open: said once, with the channel
    ref.listen<LiveBoxStatus>(liveBoxProvider, (prev, next) {
      if (!mounted || prev == null) return;
      // B11: this phone became the controller of a live the box pulls (a start, or its own session found again):
      // a camera prepared before that is closed
      if (_controlsOnly(next) && !_controlsOnly(prev)) unawaited(_releasePrepared());
      if (prev.sessionId != null && next.sessionId == null) _liveEnded();
      if (!prev.canToggleKiosk && next.canToggleKiosk) sourceNotifier.boxCapabilityKnown();
      if (prev.youtube.phase == YoutubeAccountPhase.signingIn && next.youtube.phase == YoutubeAccountPhase.signedIn) {
        final t = S.of(context);
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(t.liveYoutubeConnectedSnack(bidiIsolate(next.youtube.channel ?? t.liveYoutube)))),
        );
      }
    });
    final choiceAsync = ref.watch(liveKuliahProvider);
    final choice = choiceAsync.value;
    if (choice != null && !_kuliahChosen) {
      _kuliahChosen = true;
      _kuliahId = choice.preselected;
    }

    // a write of the YouTube choice the box refused or never answered: said once
    ref.listen(liveDestinationsProvider.select((d) => d.failures), (prev, next) {
      if (!mounted || prev == null || next <= prev) return;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(S.of(context).liveYoutubeChoiceFailed)));
    });
    // The box's "camera in use" flag: this device opens no pull of a camera another device, or the box, holds.
    final cameraBlocked = cameraUseBlocksPull(box.cameraUse);
    if (cameraBlocked != source.cameraInUse) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) sourceNotifier.cameraUseKnown(cameraBlocked);
      });
    }
    final other = box.otherLive;
    // The box pulls the camera and this phone only controls: the live is the box's status, there is no engine state.
    final control = box.controlOnly && box.sessionId != null;
    final live = _state.isLive || control;
    // This device's own live the box pulls, found again after a reload: the control card and the notices show at once
    // while "Sambung semula" runs, not the start screen.
    final heldBoxPulled = !live && other == null && box.sessionId != null && box.boxPulled && !box.stopFailed;
    // Before a live with the box pulling, the phone's engine prepares nothing: the frame is not "getting ready".
    final idleBoxPull = !_state.isLive && !control && source.boxPull && ref.read(liveDeviceKindProvider) != 'ipad' &&
        (_state.phase == PublisherPhase.idle || _state.phase == PublisherPhase.preparing || _state.phase == PublisherPhase.stopped);
    final shown = control && !_state.isLive
        ? _state.copyWith(phase: PublisherPhase.live, durationSec: box.runSeconds(ref.read(appDepsProvider).now()))
        : (idleBoxPull ? _state.copyWith(phase: PublisherPhase.ready) : _state);
    // This device's own live, found on the box after the app was reopened, with no picture going out from here.
    final resumeNeeded = !live && box.sessionId != null && box.resume == LiveResume.needed && !box.stopFailed;
    final sessionHeld = !live && box.sessionId != null && !box.stopFailed;
    final noticeInput = (live || other != null) ? _noticeInput(box.watchUrl, choice?.byId(_kuliahId)) : null;
    // The surau's notice on the box: every live:control holder sees it, whichever device started the live.
    final boxNotice = ref.watch(liveBoxNoticeProvider).value;
    final readOnly = !live && other != null;
    final ipad = _ipad;
    final busy =
        box.stopping ||
        _state.phase == PublisherPhase.starting ||
        _state.phase == PublisherPhase.stopping;
    final youtubeFeature = flags.isOn('liveYoutube');
    final kioskFeature = flags.isOn('liveOnKiosk');
    final block = youtubeFeature ? _youtubeBlock(s, box, canSettings) : s.liveNotUsed;
    final destChoice = ref.watch(liveDestinationsProvider);
    final wanted = destChoice.wanted;
    final boxPull = source.boxPull && !ipad;
    // The box pulls the camera of this live (build 4): no picture, no preview and no still on this device, a control
    // card instead. Another device's live counts when the box says it pulls it.
    final boxPulledLive =
        control ||
        heldBoxPulled ||
        (ipad && _state.isLive && source.external) ||
        // the box's own word (`session.boxPulled`) decides; false after a switch to the iPad's own camera
        (readOnly &&
            (other.boxPulled ??
                (other.videoPath == 'box' ||
                    box.cameraUse.any((u) => u.cameraId == externalCameraId && u.via == 'box'))));
    // Before the start with the box set to pull: the start screen says there will be no picture here.
    final boxPullIdle = !live && !heldBoxPulled && !readOnly && source.external && (boxPull || ipad);
    // The box's own camera signals: the warning `no_video_from_camera` or the camera row reading `lost`
    final boxCameraGone =
        boxPulledLive && (box.warnings.contains(noVideoFromCamera) || box.audioOf(idCamera)?.state == 'lost');
    // What the chip shows is the surau's choice; whether YouTube can be used right now is a separate matter
    // (a block is told beside it and asked about at Mula siaran, it never changes the choice).
    final youtubeChosen = youtubeFeature && wanted;
    final youtubeOn = youtubeChosen && block == null;
    final canChoose = can(roles, 'live:control');
    // Stop for another person's box-pulled live: live control on a box that has the new controls, or the Pentadbir.
    final mayStopOther = canChoose && (box.canToggleKiosk || canEmergency);
    // A live STARTED box-pulled never ends by itself (`session.startedBoxPulled`): the Stop right and the quiet notice
    // follow it, also after a switch to the iPad's own camera (the control card and "no video" still follow boxPulled).
    final startedPulledLive = boxPulledLive || (readOnly && other.startedPulled);
    // The destinations as they stand now: Skrin (kept on this device per box, always on for a box that cannot switch
    // it), YouTube, and Rakam (this device's own recording; never on a phone that only controls).
    final kioskOn = live ? (box.sessionKiosk ?? true) : (ref.watch(liveKioskChoiceProvider) || !box.canToggleKiosk);
    final recAvailable = !(boxPull || control);
    // a recording that has stopped (no data, storage low, stopped) is not a destination any more
    final recordingOn =
        recAvailable && (live ? _state.recording.active : (ref.watch(liveRecordingChoiceProvider) ?? _recordingOn));
    final youtubeNow = live ? (box.sessionYoutube ?? box.youtubeViaBox) : youtubeOn;
    final destCount = ((kioskFeature && kioskOn) ? 1 : 0) + (youtubeNow ? 1 : 0) + (recordingOn ? 1 : 0);
    final canStart =
        destCount > 0 &&
        kioskFeature &&
        !_starting &&
        !box.stopping &&
        !box.stopFailed &&
        // with the box pulling the camera this phone publishes nothing: its engine need not be ready
        (_state.phase == PublisherPhase.ready || (boxPull && _state.phase != PublisherPhase.starting && _state.phase != PublisherPhase.stopping)) &&
        box.boxReachable &&
        box.busyDevice == null &&
        box.sessionId == null &&
        other == null &&
        choice != null;

    final info = _rowInfo(box);
    final view = readOnly ? _viewFromBox(source, box) : source;
    // the box microphone is the main sound whenever the box pulls the camera, before the start and during the live
    final boxPulledAudio = boxPulledLive || (source.external && (boxPull || ipad));
    final camLost = live && (_state.camera?.isLost ?? false);
    final micInfo = info[idDeviceMic];
    final camBack =
        live &&
        _cameraWasLost &&
        !camLost &&
        _state.camera?.link == CameraLink.playing &&
        view.mix.deviceMic.enabled &&
        micInfo?.alignState != 'locked' &&
        micInfo?.alignState != 'holding';
    final ctx = AudioContext(
      dev: ipad ? 'ipad' : 'phone',
      live: live || readOnly,
      readOnly: readOnly,
      camLost: camLost,
      camBack: camBack,
      muted: _state.muted,
      lang: lang,
      micLabel: _routedMicName(ref.watch(micAutoProvider.select((m) => m.mic)), _state.micRoute, lang),
      micUnavailable: _state.micUnavailable,
      trrsHint: ref.watch(micAutoProvider.select((m) => m.trrsHint)),
      // every input the live can hear is its own row; the lift and the volume of each are remembered (P1)
      inputs: phoneInputs(ref.watch(micAutoProvider), routedId: _state.micRoute?.id, lang: lang),
      lifts: ref.watch(audioPrefsProvider).lifts,
      inputVolumes: ref.watch(audioPrefsProvider).inputVolumes,
      // the main-microphone rows and the sync block belong to a box that has the new controls
      boxPulled: boxPulledAudio && box.canToggleKiosk,
    );
    final rows = buildAudioRows(source: view, ctx: ctx, info: info);
    final audioNotices = buildAudioNotices(source: view, ctx: ctx, info: info);
    final showMixer = view.external || view.mix.boxInput.enabled;
    final canAddAudio =
        !readOnly && ((view.external && !view.listed.contains(idDeviceMic)) || !view.listed.contains(idBoxInput)) && (!live || view.external);

    final catchUpOn =
        flags.isOn('youtubeCatchUp') && ref.watch(catchUpQueueProvider) != null;
    final saveButton = FilledButton.icon(
      onPressed: () => ref.read(liveBoxProvider.notifier).savePending(),
      icon: const Icon(Icons.download_rounded),
      label: Text(s.liveSaveRecording),
    );

    final camName = view.camera.name;
    final lostSec = _state.camera?.lostSec ?? 0;
    final micInMix = view.mix.deviceMic.enabled && view.external;
    final notices = <Widget>[
      if (noticeInput != null || boxNotice != null)
        LiveNotice(
          key: const ValueKey('live-notice-banner'),
          icon: Icons.campaign_rounded,
          title: s.liveNoticeStarted,
          action: FilledButton.icon(
            key: const ValueKey('live-notice-banner-share'),
            onPressed: () => _openNotice(noticeInput),
            icon: const Icon(Icons.share_rounded),
            label: Text(s.liveNoticeShare),
          ),
        ),
      if (!box.boxReachable && !box.stopping)
        LiveNotice(
          icon: Icons.cloud_off_rounded,
          leading: const LinkGlyph(kind: LinkKind.box, state: LinkState.disconnected, onDark: false),
          title: s.liveBoxUnreachable,
          danger: true,
        ),
      if (box.busyDevice != null)
        LiveNotice(
          icon: Icons.sensors_rounded,
          title: s.liveBusy(box.busyDevice!),
          danger: true,
        ),
      // a live the box pulls can be stopped by any holder of live control: the card says who started it instead
      if (other != null && !live && !(startedPulledLive && mayStopOther))
        LiveNotice(
          key: const ValueKey('live-other-device'),
          icon: Icons.sensors_rounded,
          title: liveOtherDeviceTitle(lang, other.starter),
          body: liveOtherDeviceBody(lang),
        ),
      if (cameraBlocked && !control)
        for (final u in box.cameraUse.where((u) => u.cameraId == externalCameraId).take(1))
          LiveNotice(
            key: const ValueKey('live-camera-in-use'),
            icon: Icons.videocam_rounded,
            title: u.via == 'box'
                ? s.liveCameraInUseByBox(_sinceText(context, u.since))
                : s.liveCameraInUseBy(bidiIsolate(u.byName.isEmpty ? s.liveOtherDevice : u.byName), _sinceText(context, u.since)),
            // the shared picture, through the box: never a second pull of the same camera (no picture at all in a
            // box-pulled live, where the note would promise one)
            body: boxPulledLive ? null : s.liveCameraJoinNote,
          ),
      if (resumeNeeded)
        LiveNotice(
          key: const ValueKey('live-mine'),
          icon: Icons.sensors_rounded,
          title: s.liveMineTitle,
          action: Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton(
                key: const ValueKey('live-mine-stop'),
                style: OutlinedButton.styleFrom(foregroundColor: LiveColors.onAir, side: const BorderSide(color: LiveColors.onAir)),
                onPressed: box.stopping || _resuming ? null : _confirmStop,
                child: Text(s.liveStop),
              ),
              FilledButton(
                key: const ValueKey('live-mine-resume'),
                onPressed: box.stopping || _resuming ? null : () => unawaited(_resumeMine()),
                child: Text(s.liveMineResume),
              ),
            ],
          ),
        ),
      if (live && !control && box.resume == LiveResume.sending)
        LiveNotice(
          key: const ValueKey('live-mine-sending'),
          icon: Icons.sensors_rounded,
          title: s.liveMineStillSending,
        ),
      if (control)
        LiveNotice(
          key: const ValueKey('live-control-only'),
          icon: Icons.dns_rounded,
          title: s.liveVideoPathBoxNote,
        ),
      if (box.stopFailed)
        LiveNotice(
          key: const ValueKey('live-stop-failed'),
          icon: Icons.sensors_rounded,
          title: s.ra4StopNotYet,
          danger: true,
          action: FilledButton(
            key: const ValueKey('live-stop-retry'),
            style: FilledButton.styleFrom(backgroundColor: LiveColors.onAir, foregroundColor: Colors.white),
            onPressed: box.stopping ? null : () => unawaited(ref.read(liveBoxProvider.notifier).retryStop()),
            child: Text(s.ra4StopRetry),
          ),
        ),
      if (_state.recording.lastError == recordingEmpty)
        LiveNotice(
          key: const ValueKey('live-rec-empty'),
          icon: Icons.videocam_off_rounded,
          title: s.uploadErrorEmptyFile,
        ),
      if (box.notice != null && !(box.stopFailed && box.notice == s.ra4StopNotYet))
        LiveNotice(icon: Icons.info_outline_rounded, title: box.notice!),
      if (source.error != null)
        LiveNotice(icon: Icons.info_outline_rounded, title: source.error!),
      if (box.warnings.contains(mediaPortsBlocked))
        LiveNotice(
          icon: Icons.shield_outlined,
          title: s.liveMediaPortsBlocked,
          danger: true,
        ),
      if (box.warnings.contains(noVideoFromDevice))
        LiveNotice(icon: Icons.videocam_off_rounded, title: s.liveNoVideo),
      if (box.warnings.contains(cameraH265))
        LiveNotice(key: const ValueKey('live-warn-camera-h265'), icon: Icons.videocam_off_rounded, title: s.liveWarnCameraH265),
      if (box.warnings.contains(cameraBitrateHigh))
        LiveNotice(key: const ValueKey('live-warn-camera-heavy'), icon: Icons.speed_rounded, title: s.liveCameraHeavyWarn),
      if (boxPullIdle) ...[
        LiveNotice(key: const ValueKey('live-no-video-note'), icon: Icons.dns_rounded, title: s.liveCtlNoVideo),
        LiveNotice(
          key: const ValueKey('live-close-camera-app'),
          icon: Icons.warning_amber_rounded,
          title: s.liveCtlCloseApp,
          body: s.liveCtlCloseAppWhy,
        ),
      ],
      // YouTube did not deliver: the box put the TV screen back on by itself (the Skrin switch reads on from the status)
      if (box.warnings.contains(kioskRestored) && (live || other != null))
        LiveNotice(
          key: const ValueKey('live-kiosk-restored'),
          icon: Icons.tv_rounded,
          title: s.liveKioskRestored,
        ),
      if (startedPulledLive && box.warnings.contains(controllerQuiet))
        LiveNotice(
          key: const ValueKey('live-controller-quiet'),
          icon: Icons.warning_amber_rounded,
          title: s.liveQuietTitle,
          body: s.liveQuietBody(((box.controllerQuietSeconds ?? 600) / 60).floor().clamp(10, 99999)),
          action: (other != null ? mayStopOther : canChoose)
              ? OutlinedButton.icon(
                  key: const ValueKey('live-quiet-stop'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: LiveColors.onAir,
                    side: const BorderSide(color: LiveColors.onAir),
                    minimumSize: const Size(48, 48),
                  ),
                  onPressed: other != null ? () => _confirmStopOther(other) : _confirmStop,
                  icon: const Icon(Icons.stop_rounded),
                  label: Text(s.liveQuietStop),
                )
              : null,
        ),
      if (boxPulledLive && box.warnings.contains(cameraSlow))
        LiveNotice(
          key: const ValueKey('live-warn-camera-slow'),
          icon: Icons.speed_rounded,
          title: s.liveCamSlowTitle,
          body: '${s.liveCtlCloseApp} ${s.liveCtlCloseAppWhy}',
        ),
      // the box microphone benched while the camera sound carries the live: the broadcast is not silent
      if (boxPulledLive && box.boxMicBenched)
        LiveNotice(
          key: const ValueKey('live-warn-audio-lost'),
          icon: Icons.mic_off_rounded,
          title: s.liveMicBenchedTitle,
          body: s.liveMicBenchedBody,
        ),
      // the box microphone is gone and the camera sound is not carrying (at 0, or lost too): honest, it may be silent
      if (boxPulledLive && box.boxMicLostSilent)
        LiveNotice(
          key: const ValueKey('live-warn-box-mic-lost'),
          icon: Icons.mic_off_rounded,
          title: s.liveMicLostBoxTitle,
          body: s.liveMicLostBoxBody,
          danger: true,
        ),
      // build 5: the box microphone is on air but sends no signal
      if (boxPulledLive && box.boxMicSilent)
        LiveNotice(
          key: const ValueKey('live-warn-box-mic-silent'),
          icon: Icons.mic_off_rounded,
          title: s.liveMicSilentTitle,
          body:
              '${s.liveMicSilentBody(((box.boxMicNoSignalSeconds ?? 60) / 60).floor().clamp(1, 99999))}\n'
              '\u2022 ${s.liveMicSilentTip1}\n\u2022 ${s.liveMicSilentTip2}\n\u2022 ${s.liveMicSilentTip3}',
          danger: true,
          // only the device that started the live, and only when the camera has a sound to use
          action: (live || heldBoxPulled) && !readOnly && view.external && source.camera.hasAudio != false
              ? FilledButton.icon(
                  key: const ValueKey('live-mic-use-camera'),
                  style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                  onPressed: () => unawaited(sourceNotifier.setVolume(idCamera, 100)),
                  icon: const Icon(Icons.videocam_rounded),
                  label: Text(s.liveMicSilentUseCamera),
                )
              : null,
        ),
      if (boxPulledLive && box.boxMicSilentCovered)
        LiveNotice(
          key: const ValueKey('live-warn-box-mic-covered'),
          icon: Icons.check_circle_outline_rounded,
          title: s.liveMicSilentCamTitle,
          body: s.liveMicSilentCamBody,
        ),
      // build 5: the live server is too busy; a holder of live:settings may switch this box's TV to its normal display
      if (box.serverBusy && canSettings && (live || other != null) && _busyLaterFor != (box.sessionId ?? other?.sessionId))
        LiveNotice(
          key: const ValueKey('live-warn-server-busy'),
          icon: Icons.speed_rounded,
          title: s.liveBusyTitle(bidiIsolate(_selfTvName(box)), box.cpuPercent ?? 0),
          body: s.liveBusyBody,
          action: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton.icon(
                key: const ValueKey('live-busy-off'),
                style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
                onPressed: () => unawaited(_switchOwnTvOff(box.sessionId ?? other?.sessionId)),
                icon: const Icon(Icons.tv_off_rounded),
                label: Text(s.liveBusyAction, textAlign: TextAlign.center),
              ),
              const SizedBox(height: 4),
              TextButton(
                key: const ValueKey('live-busy-later'),
                style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                onPressed: () => setState(() => _busyLaterFor = box.sessionId ?? other?.sessionId),
                child: Text(s.liveBusyLater),
              ),
            ],
          ),
        ),
      // build 6: the box microphone drops frames; the YouTube leg is behind; its picture was lowered; it reconnected
      if ((live || other != null) && box.boxMicDrops)
        LiveNotice(
          key: const ValueKey('live-warn-box-mic-drops'),
          icon: Icons.mic_off_rounded,
          title: s.liveWarnMicDropsTitle,
          body: s.liveWarnMicDropsBody,
        ),
      if ((live || other != null) && box.uploadBehind)
        LiveNotice(
          key: const ValueKey('live-warn-upload-behind'),
          icon: Icons.upload_rounded,
          title: s.liveWarnBehindTitle,
          body: s.liveWarnBehindBody(box.relayBehindSeconds ?? 0),
        ),
      if ((live || other != null) && box.qualityLowered)
        LiveNotice(
          key: const ValueKey('live-warn-quality-lowered'),
          icon: Icons.speed_rounded,
          title: s.liveWarnQualityTitle,
          body: s.liveWarnQualityBody,
        ),
      if ((live || other != null) && box.relayRestarts > 0)
        LiveNotice(
          key: const ValueKey('live-relay-reconnects'),
          icon: Icons.sync_rounded,
          title: s.liveRelayReconnects(box.relayRestarts),
        ),
      if (boxPulledLive && box.deviceMicLost)
        LiveNotice(
          key: const ValueKey('live-warn-device-mic-lost'),
          icon: Icons.mic_off_rounded,
          title: s.liveMicLostDeviceTitle,
          body: s.liveMicLostDeviceBody,
          danger: true,
        ),
      if (boxPulledLive && boxCameraGone)
        LiveNotice(
          key: const ValueKey('live-camera-gone'),
          icon: Icons.error_outline_rounded,
          title: s.liveCamGoneTitle,
          body: s.liveCamGoneBody,
          danger: true,
        ),
      if (box.warnings.contains(cloudUnreachable))
        LiveNotice(
          icon: Icons.cloud_off_rounded,
          leading: const LinkGlyph(kind: LinkKind.cloud, state: LinkState.disconnected, onDark: false),
          title: s.liveCloudUnreachable,
        ),
      if (live && camLost && lostSec < 60)
        LiveNotice(
          key: const ValueKey('live-camera-reconnecting'),
          icon: Icons.warning_amber_rounded,
          title: liveCameraLostTitle(lang),
          body: liveCameraReconnectBody(lang, mic: micInMix && !(info[idDeviceMic]?.state == 'lost'), source: ctx.micShort),
        ),
      if (live && camLost && lostSec >= 60)
        LiveNotice(
          key: const ValueKey('live-camera-lost'),
          icon: Icons.error_outline_rounded,
          title: liveCameraLostSeconds(lang, camName, (lostSec / 60).floor()),
          body: liveCameraLostBody(lang, 
            mic: micInMix,
            source: ctx.micShort,
            minutesLeft: (10 - (lostSec / 60).floor()).clamp(0, 10),
          ),
          danger: true,
        ),
      if (camBack)
        LiveNotice(
          key: const ValueKey('live-camera-back'),
          icon: Icons.check_circle_outline_rounded,
          title: liveCameraBackTitle(lang, camName),
          body: liveCameraBackBody(lang, ctx.micShort),
        ),
      if (box.recordingsPending > 0 && !live)
        LiveNotice(
          icon: Icons.video_file_rounded,
          title: s.liveRecordingsPending,
          body: s.liveRecordingsPendingBody(box.recordingsPending),
          action: catchUpOn
              ? Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      key: const ValueKey('live-pending-upload'),
                      onPressed: _uploadPending,
                      icon: const Icon(Icons.cloud_upload_rounded),
                      label: Text(s.actionUpload),
                    ),
                    saveButton,
                  ],
                )
              : saveButton,
        ),
    ];

    final externalIdle = !live && !heldBoxPulled && !readOnly && source.external;
    final pullNote = externalIdle
        ? (ipad
              ? LiveNotice(
                  key: const ValueKey('live-pull-note'),
                  icon: Icons.dns_rounded,
                  title: liveBoxPullNote(lang, camName),
                )
              : boxPull
              // Rakam is not offered in this mode, and the start screen says clearly why (never silently hidden)
              ? LiveNotice(
                  key: const ValueKey('live-rec-no-box-pull'),
                  icon: Icons.dns_rounded,
                  title: s.liveRecNoBoxPullStart,
                )
              : LiveNotice(
                  key: const ValueKey('live-pull-note'),
                  icon: micInMix ? Icons.mic_rounded : Icons.smartphone_rounded,
                  title: livePhonePullNote(lang, camName, mic: micInMix),
                ))
        : null;

    // The picture of a live this device does not pull itself comes THROUGH the box (its own still of the running
    // live), never from a second pull of the camera: another device's external-camera live, or the box's own pull.
    final joinShared = control || (readOnly && (cameraBlocked || source.cameraRefused));
    final gatewayNow = ref.read(gatewayProvider);
    final Widget ownPicture = joinShared && gatewayNow != null
        ? SharedPictureView(fetch: () => gatewayNow.getBytes('/api/live/notice/frame.jpg'))
        : idleBoxPull
        // nothing is pulled by this phone: no preview of its own
        ? const ColoredBox(
            key: ValueKey('live-box-pull-idle'),
            color: SurauColors.glass,
            child: Center(child: Icon(Icons.dns_rounded, size: 44, color: Colors.white54)),
          )
        : _publisher.preview(context);
    final picture = showMixer
        ? Stack(
            fit: StackFit.expand,
            children: [
              ownPicture,
              PositionedDirectional(
                end: 10,
                top: 10,
                child: MixedLevelChip(
                  key: const ValueKey('live-mixed-level'),
                  level: _mixedLevel(view, info),
                  silent: mixAllMuted(view.mix, muted: _state.muted, phone: !ipad),
                ),
              ),
            ],
          )
        : ownPicture;
    final liveSummaryText = live && (kioskFeature || youtubeFeature)
        ? _liveSummary(
            s,
            kiosk: kioskOn,
            youtube: box.sessionYoutube ?? (control ? box.youtubeViaBox : _state.outputs.youtube != null),
            recording: recAvailable && !boxPulledLive,
          )
        : null;
    final liveDest = liveSummaryText == null
        ? null
        : Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              liveSummaryText,
              key: const ValueKey('live-dest-summary'),
              style: Theme.of(context).textTheme.titleSmall,
            ),
          );

    // O34: a live that runs without YouTube offers to add it (the box signed in, the starter of this live).
    final laterGate = youtubeLaterGate(
      sessionOpen: box.sessionId != null || other != null,
      own: live || heldBoxPulled,
      readOnly: readOnly,
      youtubeFeature: youtubeFeature,
      youtubeOn: box.sessionYoutube ?? (control ? box.youtubeViaBox : _state.outputs.youtube != null),
      accountPhase: box.youtube.phase,
      boxReachable: box.boxReachable,
      stopping: box.stopping,
    );
    if (laterGate != _lastLaterGate) {
      // the log line is written after the frame: build changes no state
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || laterGate == _lastLaterGate) return;
        _lastLaterGate = laterGate;
        debugPrint('live youtube-later gate: ${laterGate.name}');
      });
    }
    final laterWhy = switch (laterGate) {
      YoutubeLaterGate.notSignedIn => s.liveYoutubeLaterWhySignIn,
      YoutubeLaterGate.unreachable => s.liveYoutubeLaterWhyUnreachable,
      YoutubeLaterGate.notStarter => s.liveYoutubeLaterWhyStarter,
      _ => null,
    };
    // The control card of a live the box pulls: the running time, TVs, YouTube, camera, one level per sound source and
    // (iPad) the recording of the received stream. It replaces the picture and the old three-row status card.
    final Widget controlCard = boxPulledLive
        ? _controlCard(
            s: s,
            box: box,
            view: view,
            ctx: ctx,
            info: info,
            other: other,
            ipad: ipad,
            live: live,
            boxCameraGone: boxCameraGone,
          )
        : const SizedBox.shrink();
    final monitor = <Widget>[
      ?liveDest,
      if (laterGate != YoutubeLaterGate.hidden)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              OutlinedButton.icon(
                key: const ValueKey('live-youtube-later'),
                onPressed: laterGate != YoutubeLaterGate.ok || box.youtubeStarting
                    ? null
                    : () => unawaited(_askYoutubeLater()),
                icon: const Icon(Icons.live_tv_rounded),
                label: Text(box.youtubeStarting ? s.liveYoutubeLaterStarting : s.liveYoutubeLaterButton),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              ),
              const SizedBox(height: 6),
              if (laterWhy != null)
                Text(
                  laterWhy,
                  key: const ValueKey('live-youtube-later-why'),
                  style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
                )
              else
                Text(
                  s.liveYoutubeLaterHint,
                  key: const ValueKey('live-youtube-later-hint'),
                  style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
                ),
            ],
          ),
        ),
      if (boxPulledLive)
        controlCard
      else if (!boxPullIdle) ...[
        LivePreviewFrame(
          picture: picture,
          state: shown,
          onFlip: _state.phase == PublisherPhase.idle || source.external
              ? null
              : () => _publisher.switchCamera(),
          onMute: _state.phase == PublisherPhase.idle
              ? null
              : () => _publisher.setMuted(!_state.muted),
          onMinimise: () => ref.read(liveFoldedProvider.notifier).set(true),
        ),
        const SizedBox(height: 16),
        LiveStatsStrip(state: _state),
        if (_state.warnings.isNotEmpty) ...[
          const SizedBox(height: 16),
          WarningChips(warnings: _state.warnings),
        ],
        if (box.viewers.isNotEmpty) ...[
          const SizedBox(height: 16),
          LiveViewerChips(viewers: box.viewers),
        ],
      ],
    ];

    final (kioskTone, kioskText) = outputStatus(
      s,
      live
          ? (control
                ? (box.ingestReady == true ? OutputState.up : OutputState.connecting)
                : kioskLeg(_state.outputs.kiosk, box.ingestReady))
          : null,
      live: live,
    );
    // A leg the box relays is as healthy as the box says (the iPad only
    // sends one stream); otherwise the publisher knows.
    final ytOut = control
        ? box.youtubeLeg
        : box.youtubeViaBox && _state.outputs.youtube != null
        ? (box.youtubeLeg ?? _state.outputs.youtube)
        : _state.outputs.youtube;
    final (ytTone, ytText) = live
        ? (ytOut == null
              ? (LightTone.idle, s.liveNotUsed)
              : outputStatus(s, ytOut, live: live))
        : (LightTone.idle, youtubeOn ? s.liveReady : s.liveNotUsed);
    final rec = _state.recording;
    // With the box pulling the camera the phone receives no picture: nothing can be recorded on it.
    final recordingWhy = (boxPull || control) && _recordingOn ? s.liveDestRecUnavailable : null;
    // a recording switched off (or stopped) during the live: what was recorded so far is kept, and the row says so
    final recStopped = live && recAvailable && !recordingOn && (rec.segments > 0 || rec.bytes > 0 || rec.lastError != null);

    final outputRows = <Widget>[
      if (kioskFeature)
        OutputRow(
          key: const ValueKey('live-kiosk'),
          icon: Icons.tv_rounded,
          title: s.liveKiosk,
          subtitle: s.liveKioskHint,
          tone: kioskTone,
          status: kioskText,
        ),
      if (youtubeFeature)
        OutputRow(
          key: const ValueKey('live-youtube'),
          icon: Icons.smart_display_rounded,
          title: s.liveYoutube,
          subtitle: block ?? box.youtube.channel ?? s.liveYoutubeHint,
          reason: block != null,
          tone: ytTone,
          // A blocked leg says why in its subtitle; no status words beside it.
          status: block != null && !live ? '' : ytText,
          // The leg is chosen with the chip above "Mula siaran" (single control, the surau setting liveYoutube.nextLiveOn).
        ),
      OutputRow(
        key: const ValueKey('live-recording'),
        icon: Icons.fiber_manual_record_rounded,
        title: s.liveRecording,
        subtitle: recordingWhy != null
            ? s.liveVideoPathBoxNote
            : !recordingOn
            ? (recStopped ? s.liveRecordingStopped : s.liveRecordingOff)
            : (live || rec.segments > 0)
            ? s.liveRecordingParts(rec.segments, formatBytes(rec.bytes))
            : s.liveRecordingWithLive,
        tone: !recordingOn
            ? LightTone.idle
            : live && rec.active
            ? LightTone.onAir
            : LightTone.idle,
        status: !recordingOn
            ? s.liveRecordingOff
            : (live && rec.active ? s.liveRecordingOn : s.liveReady),
      ),
    ];
    final outputs = LiveCard(children: outputRows);

    // The destinations, always visible right above "Mula siaran" (not inside the folded card).
    final signedIn = box.youtube.signedIn;
    final unknownYoutube = box.youtube.phase == YoutubeAccountPhase.unknown;
    final lastOne = live && destCount == 1;
    final _Dest? dest = (!readOnly && !heldBoxPulled && (kioskFeature || youtubeFeature) && (!live || canChoose))
        ? (
            kiosk: kioskFeature,
            kioskOn: kioskOn,
            kioskEnabled: kioskFeature && box.canToggleKiosk && canChoose && !busy && !_starting && !(lastOne && kioskOn),
            kioskNote: !box.canToggleKiosk
                ? s.liveDestKioskOldBox
                : (lastOne && kioskOn)
                ? s.liveDestLastOne
                : null,
            live: live,
            youtube: youtubeFeature,
            youtubeState: live
                ? (youtubeNow ? _DestState.on : _DestState.off)
                : unknownYoutube
                ? _DestState.unknown
                : !signedIn
                ? _DestState.warn
                : (youtubeChosen ? _DestState.on : _DestState.off),
            youtubeOn: live ? youtubeNow : youtubeChosen,
            youtubeLabel: (live ? youtubeNow : youtubeChosen)
                ? ((box.youtube.channel ?? '').isEmpty ? s.liveDestOnPlain : s.liveDestOn(bidiIsolate(box.youtube.channel!)))
                : s.liveDestOff,
            youtubeEnabled: canChoose && !busy && !_starting && !live,
            wanted: wanted,
            saving: destChoice.saving,
            // shown from an old copy: the box has not agreed with the last write, or does not answer now
            unconfirmed: !live && (destChoice.unconfirmed || (!box.boxReachable && !destChoice.saving)),
            recordingOn: recordingOn,
            recordingLabel: recordingWhy ?? (recordingOn ? s.liveDestRec : s.liveDestRecOff),
            recordingWhy: recordingWhy != null ? s.liveRecNoBoxPullStart : (recStopped ? s.liveRecordingStopped : null),
            recordingEnabled:
                recAvailable && canChoose && !busy && !_starting && (!live || _publisher is LiveRecordingControl) && !(lastOne && recordingOn),
            recordingNote: !recAvailable
                ? null
                : (lastOne && recordingOn)
                ? s.liveDestLastOne
                : (live && _publisher is! LiveRecordingControl)
                ? s.liveDestRecSwitchNotNow
                : null,
            pickNote: !live && destCount == 0 ? s.liveDestPickOne : null,
            note: live || !youtubeFeature
                ? null
                : unknownYoutube
                ? youtubeUnknownText(s, box.youtube.channel)
                : (signedIn && block == null && !wanted)
                ? s.liveDestSkip
                : (!signedIn ? s.liveDestNone : null),
            noteIsSkip: signedIn || unknownYoutube,
            // Unknown with no last good channel (a box never signed in, its cloud away): Sambung is still offered.
            connectLabel: !live && !signedIn && (!unknownYoutube || (box.youtube.channel ?? '').isEmpty) && canSettings
                ? s.liveDestLink
                : null,
          )
        : null;
    // The open sheet is its own route: it reads the same values once this frame is built.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _dest.value = dest;
    });
    final destinations = dest == null ? null : _DestStrip(dest: dest, onOpen: _openDestSheet);
    final picker = _KuliahTile(
      choice: choice,
      kuliah: choice?.byId(_kuliahId),
      enabled: !live && !busy && choice != null && !readOnly,
      onTap: choice == null ? null : () => _pickKuliah(choice),
    );

    // "Tetapan siaran": the four live forms and the YouTube account in ONE card, for a holder of `live:settings`.
    final settingsCard = canSettings
        ? FoldSection(
            sectionKey: 'set',
            icon: Icons.tune_rounded,
            title: liveSectionSettings(lang),
            summary: _settingsSummary(s, lang, box.youtube, source.camera.enabled),
            open: _settingsOpen(
              running: live || readOnly,
              signingIn: youtubeFeature && !live && box.youtube.phase == YoutubeAccountPhase.signingIn,
            ),
            onToggle: () => _toggleSettings(
              _settingsOpen(
                running: live || readOnly,
                signingIn: youtubeFeature && !live && box.youtube.phase == YoutubeAccountPhase.signingIn,
              ),
            ),
            child: _SettingsLinks(
              leading: const _TvShowSection(),
              cameraOn: source.camera.enabled,
              cameraName: camName,
              account: youtubeFeature && !live ? YoutubeAccountCard(box: box) : null,
            ),
          )
        : null;

    final button = LiveActionButton(
      // our own stop keeps the quiet "Menghentikan siaran" until the box is done
      phase: box.stopping ? PublisherPhase.stopping : shown.phase,
      // this device holds a session on the box though its publisher is not live (it failed, or the app was
      // reopened): Berhenti, never Mula siaran (S7, B9)
      sessionHeld: sessionHeld,
      onStart: canStart
          ? () => (youtubeChosen && block != null)
              ? _askTvOnly(_youtubeBlock(s, box, canSettings, asReason: true) ?? block)
              : _start(youtubeChosen)
          : null,
      onStop: _confirmStop,
    );

    // build 5: the 5 second test of every box microphone, on the start screen of a live the box pulls
    final showMicTest = boxPulledAudio && !live && !readOnly && !heldBoxPulled && source.boxInputAvailable;
    if (showMicTest && !_micTestAsked) {
      _micTestAsked = true;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted) return;
        final n = ref.read(boxMicTestProvider.notifier);
        await n.loadDevices();
        if (mounted) await n.test();
      });
    }
    final Widget? micTest = showMicTest ? _MicTestSection(canPick: canSettings) : null;

    // ---- the audio card (rows, messages) ----
    Widget audioBody() => AudioCardBody(
      rows: rows,
      notices: audioNotices,
      canAdd: canAddAudio,
      onAdd: _openAdd,
      onVolume: (id, v) => ref.read(audioRowActionsProvider).volume(id, v, ctx.inputs),
      onRemove: (id) => sourceNotifier.remove(id),
      onMute: () => _publisher.setMuted(!_state.muted),
      onUseOnly: (id) => sourceNotifier.useOnly(id),
      onToggle: (id, on) => _inputToggle(id, on, ctx.inputs),
      onLift: (id, on) => ref.read(audioRowActionsProvider).lift(id, on, ctx.inputs),
      onRowMute: (id) => _rowMute(id, ctx.inputs),
    );

    final audioSum = audioSummary(view, ctx, info);
    final cam = view.camera;
    final videoTone = !view.external
        ? RowTone.ok
        : cam.reachable == false
        ? RowTone.off
        : RowTone.ok;
    final videoSummaryText = view.external
        ? (cam.reachable == false ? s.liveCamUnreachable(camName) : s.liveCamReady(camName))
        : (ipad ? liveSourceIpadCamera(lang) : liveSourcePhoneCamera(lang));

    // Lane X: the camera's control row, only while the opt-in is on, the external camera is the picture, and this device
    // may act on the live. The box refuses the call itself (404) when the opt-in is off.
    final controlGateway = ref.read(gatewayProvider);
    final Widget? cameraControlRow =
        !readOnly && source.external && source.camera.offered && source.camera.control.enabled && controlGateway != null
        ? CameraControlRow(
            key: const ValueKey('live-camera-control'),
            hasBrightness: source.camera.control.hasBrightness,
            profile: source.camera.control.profile,
            send: ({exposure, preset, resetPosition = false, aiTracking, applyProfile = false}) => controlGateway.controlLiveCamera(
              exposure: exposure,
              preset: preset,
              resetPosition: resetPosition,
              aiTracking: aiTracking,
              applyProfile: applyProfile,
            ),
          )
        : null;

    final idleSections = <Widget>[
      FoldSection(
        sectionKey: 'video',
        icon: Icons.videocam_rounded,
        title: liveSourceVideoTitle(lang),
        summary: DotSummary(videoTone, videoSummaryText),
        open: _open['video'] ?? (!live && !readOnly),
        onToggle: () => _toggle('video'),
        child: VideoSourceBody(
          source: source,
          ipad: ipad,
          readOnly: busy,
          onPick: (k) async {
            await sourceNotifier.selectVideo(k);
          },
          // "Video diambil oleh": the phone by default, the box by the admin's choice (a browser has no choice)
          onPath: ipad ? null : (path) => unawaited(sourceNotifier.setVideoPath(path)),
          onOpenCamera: canSettings ? () => GoRouter.of(context).go(AppRoutes.liveSettingsFor('liveCamera')) : null,
        ),
      ),
      FoldSection(
        sectionKey: 'audio',
        icon: Icons.volume_up_rounded,
        title: liveAudioTitle(lang),
        summary: DotSummary(
          audioSum.warn ? RowTone.warn : RowTone.ok,
          audioSum.text,
          trailing: const LevelMeter(0.6),
        ),
        open: _isOpen('audio'),
        onToggle: () => _toggle('audio'),
        child: micTest == null
            ? audioBody()
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [micTest, audioBody()]),
      ),
      FoldSection(
        sectionKey: 'out',
        icon: Icons.tv_rounded,
        title: liveSectionOutputs(lang),
        summary: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              liveSectionOutputsSummary(
                lang,
                screen: kioskFeature && kioskOn,
                youtube: youtubeNow,
                recording: recordingOn,
                ipad: ipad,
              ),
              key: const ValueKey('live-out-summary'),
            ),
            if (!recAvailable)
              Text(
                liveSectionOutputsNoRecording(lang),
                key: const ValueKey('live-out-summary-norec'),
                style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
              ),
          ],
        ),
        open: _isOpen('out'),
        onToggle: () => _toggle('out'),
        child: Column(
          children: [
            for (var i = 0; i < outputRows.length; i++) ...[
              if (i > 0) const Divider(height: 1, indent: 20, endIndent: 20),
              outputRows[i],
            ],
          ],
        ),
      ),
      ?settingsCard,
      Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(6, 0, 6, 0),
        child: Text(
          liveSourcesRemembered(lang),
          style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
        ),
      ),
    ];

    // ---- during a live (this device's or another's): the sources card ----
    final liveCamStatus = switch (_state.camera?.link) {
      CameraLink.lost => (liveCamLinkLost(lang), RowTone.off),
      CameraLink.connecting => (liveCamLinkReconnecting(lang), RowTone.warn),
      _ => camBack ? (liveCamLinkBack(lang), RowTone.ok) : (liveCamLinkReceived(lang), RowTone.ok),
    };
    final liveSources = (live || readOnly) && showMixer
        ? Card(
            key: const ValueKey('live-sources'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!boxPulledLive) _CardHead(liveSourceVideoTitle(lang)),
                if (view.external && !boxPulledLive)
                  Padding(
                    padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 16, 12),
                    child: Row(
                      children: [
                        const Icon(Icons.videocam_rounded, color: SurauColors.teal),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(camName, style: Theme.of(context).textTheme.titleSmall),
                              Text(
                                ipad || control
                                    ? liveCamPulledByBox(lang)
                                    : (camLost ? liveCamLastPicture(lang) : (view.camera.spec ?? '')),
                                style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
                              ),
                            ],
                          ),
                        ),
                        ToneDot(liveCamStatus.$2),
                        const SizedBox(width: 6),
                        Text(
                          ipad ? liveCamLinkReceived(lang) : liveCamStatus.$1,
                          style: Theme.of(context).textTheme.labelMedium!.copyWith(color: _toneInkOf(liveCamStatus.$2)),
                        ),
                      ],
                    ),
                  ),
                _CardHead(liveAudioTitle(lang)),
                audioBody(),
              ],
            ),
          )
        : null;
    final canSwitch = live && (_publisher is LiveSourceControl || _publisher is WebPublisher);
    final switchRow = canSwitch
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (source.external)
                OutlinedButton.icon(
                  key: const ValueKey('live-switch-phone'),
                  onPressed: () => sourceNotifier.selectVideo(VideoSourceKind.phone),
                  icon: const Icon(Icons.smartphone_rounded),
                  label: Text(ipad ? liveSwitchToIpad(lang) : liveSwitchToPhone(lang)),
                ),
              if (!source.external && source.startedExternal && source.camera.offered)
                OutlinedButton.icon(
                  key: const ValueKey('live-switch-external'),
                  onPressed: () => sourceNotifier.selectVideo(VideoSourceKind.external),
                  icon: const Icon(Icons.videocam_rounded),
                  label: Text(liveSwitchToExternal(lang)),
                ),
              if (source.external && !ipad && camLost)
                Padding(
                  padding: const EdgeInsetsDirectional.only(top: 6),
                  child: Text(
                    liveSwitchToPhoneHint(lang),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                ),
            ],
          )
        : null;

    // ---- the action area ----
    final starterName = other?.starter ?? '';
    final Widget action = readOnly && startedPulledLive && mayStopOther
        // K1: any holder of live control may stop a live the box pulls; the sheet names who started it (U6)
        ? FilledButton.icon(
            key: const ValueKey('live-stop-other'),
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(60),
              backgroundColor: LiveColors.onAir,
              foregroundColor: Colors.white,
            ),
            onPressed: box.stopping ? null : () => _confirmStopOther(other),
            icon: const Icon(Icons.stop_rounded, size: 28),
            label: Text(s.liveStop),
          )
        : readOnly
        ? Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton.icon(
                key: const ValueKey('live-stop-disabled'),
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(60)),
                onPressed: null,
                icon: const Icon(Icons.stop_rounded, size: 28),
                label: Text(s.liveStop),
              ),
              const SizedBox(height: 8),
              Text(
                liveOnlyStarterStops(lang, starterName),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
              ),
              if (canEmergency) ...[
                const SizedBox(height: 10),
                OutlinedButton.icon(
                  key: const ValueKey('live-emergency-stop'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: LiveColors.onAir,
                    side: const BorderSide(color: LiveColors.onAir),
                    minimumSize: const Size.fromHeight(48),
                  ),
                  onPressed: () => _confirmEmergency(starterName),
                  icon: const Icon(Icons.report_gmailerrorred_rounded),
                  label: Text(liveEmergencyStop(lang)),
                ),
              ],
            ],
          )
        : (destinations == null
              ? button
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    destinations,
                    if (dest?.pickNote != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(
                          dest!.pickNote!,
                          key: const ValueKey('live-dest-pick-one'),
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall!.copyWith(color: LiveColors.waitingInk),
                        ),
                      ),
                    const SizedBox(height: 10),
                    button,
                  ],
                ));

    if (ref.watch(liveFoldedProvider) && !boxPulledLive) {
      // The preview alone, edge to edge inside the safe areas: no title bar
      // (and the shell hides its navigation). Back unfolds first.
      return PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) ref.read(liveFoldedProvider.notifier).set(false);
        },
        child: Scaffold(
          backgroundColor: SurauColors.glass,
          body: SafeArea(
            child: LiveFoldedView(
              picture: ownPicture,
              state: shown,
              legs: [
                if (kioskFeature) FoldedLeg('kiosk', s.liveKiosk, kioskTone),
                if (youtubeFeature) FoldedLeg('youtube', s.liveYoutube, ytTone),
                if (recordingOn)
                  FoldedLeg(
                    'recording',
                    s.liveRecording,
                    live && rec.active ? LightTone.onAir : LightTone.idle,
                  ),
              ],
              onFlip: _state.phase == PublisherPhase.idle || source.external
                  ? null
                  : () => _publisher.switchCamera(),
              onMute: _state.phase == PublisherPhase.idle
                  ? null
                  : () => _publisher.setMuted(!_state.muted),
              // Berhenti still asks first, as unfolded.
              onStop: _confirmStop,
              onExpand: () => ref.read(liveFoldedProvider.notifier).set(false),
            ),
          ),
        ),
      );
    }

    final idle = !live && !readOnly && !heldBoxPulled;
    List<Widget> controls(double gap) => [
      picker,
      SizedBox(height: gap),
      if (idle) ...[
        for (final (i, w) in idleSections.indexed) ...[
          w,
          SizedBox(height: gap),
          // the control row sits right under "Sumber video"
          if (i == 0 && cameraControlRow != null) ...[cameraControlRow, SizedBox(height: gap)],
        ],
      ] else ...[
        ?liveSources,
        if (liveSources != null) SizedBox(height: gap),
        if (switchRow != null) ...[switchRow, SizedBox(height: gap)],
        if (cameraControlRow != null) ...[cameraControlRow, SizedBox(height: gap)],
        if (!boxPulledLive) outputs,
        if (noticeInput != null || boxNotice != null) ...[
          SizedBox(height: gap),
          OutlinedButton.icon(
            key: const ValueKey('live-notice-share'),
            onPressed: () => _openNotice(noticeInput),
            icon: const Icon(Icons.share_rounded),
            label: Text(s.liveNoticeShare),
          ),
        ],
        if (settingsCard != null) ...[SizedBox(height: gap), settingsCard],
      ],
    ];

    return ShellPage(
      title: s.liveTitle,
      body: LayoutBuilder(
        builder: (context, c) {
          final wide = c.maxWidth >= 840;
          if (wide) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsetsDirectional.fromSTEB(28, 20, 24, 32),
                    children: [
                      ...notices.expand((n) => [n, const SizedBox(height: 16)]),
                      ...monitor,
                      if (pullNote != null) ...[const SizedBox(height: 16), pullNote],
                    ],
                  ),
                ),
                Container(
                  width: 380,
                  decoration: const BoxDecoration(
                    color: SurauColors.paperDeep,
                    border: BorderDirectional(start: BorderSide(color: SurauColors.line)),
                  ),
                  child: Column(
                    children: [
                      Expanded(
                        child: ListView(
                          padding: const EdgeInsetsDirectional.fromSTEB(20, 20, 20, 20),
                          children: controls(16),
                        ),
                      ),
                      _ActionBar(child: action),
                    ],
                  ),
                ),
              ],
            );
          }
          return Column(
            children: [
              Expanded(
                child: ContentColumn(
                  child: ListView(
                    padding: const EdgeInsetsDirectional.fromSTEB(16, 16, 16, 24),
                    children: [
                      ...notices.expand((n) => [n, const SizedBox(height: 12)]),
                      ...monitor,
                      if (pullNote != null) ...[const SizedBox(height: 14), pullNote],
                      const SizedBox(height: 14),
                      ...controls(14),
                    ],
                  ),
                ),
              ),
              _ActionBar(child: ContentColumn(child: action)),
            ],
          );
        },
      ),
    );
  }
}

/// "sejak 9:05 PTG": when the camera was taken, in the phone's own time; empty words when the box did not say.
String _sinceText(BuildContext context, DateTime? since) =>
    since == null ? '' : TimeOfDay.fromDateTime(since.toLocal()).format(context);

Color _toneInkOf(RowTone t) => switch (t) {
  RowTone.ok => LiveColors.healthyInk,
  RowTone.warn => LiveColors.waitingInk,
  RowTone.off => SurauColors.dangerInk,
  RowTone.idle => SurauColors.muted,
};

/// How a destination pill reads at a glance: its colour and the small badge on its icon.
enum _DestState {
  /// Chosen and usable: green with a check.
  on,

  /// Not chosen: grey with a dash.
  off,

  /// YouTube not connected (or its access withdrawn): amber with "!", Sambung is in the sheet.
  warn,

  /// YouTube cannot be checked now: grey with "?".
  unknown,
}

/// Everything the strip and its sheet show (a record: equal values publish no change to an open sheet).
typedef _Dest = ({
  bool kiosk,
  bool kioskOn,
  bool kioskEnabled,
  String? kioskNote,
  bool live,
  bool recordingEnabled,
  String? recordingNote,
  String? pickNote,
  bool youtube,
  _DestState youtubeState,
  bool youtubeOn,
  String youtubeLabel,
  bool youtubeEnabled,
  bool wanted,
  bool saving,
  bool unconfirmed,
  bool recordingOn,
  String recordingLabel,
  String? recordingWhy,
  String? note,
  bool noteIsSkip,
  String? connectLabel,
});

/// "Skrin / YouTube / Rakam" in one row of equal pills right above "Mula siaran"; any pill opens the sheet.
class _DestStrip extends StatelessWidget {
  const _DestStrip({required this.dest, required this.onOpen});

  final _Dest dest;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final hint = s.liveDestTapHint;
    // The note (not connected, cannot check, or off by choice: screen only) is said in the pill's label too.
    final ytSpoken = switch (dest.youtubeState) {
      _DestState.warn || _DestState.unknown || _DestState.off when dest.note != null =>
        '${_noStop(dest.youtubeLabel)}. ${dest.note}',
      _ => dest.youtubeLabel,
    };
    final pills = <Widget>[
      if (dest.kiosk)
        _DestPill(
          key: const ValueKey('live-dest-kiosk'),
          icon: Icons.desktop_windows_outlined,
          label: s.liveDestShortKiosk,
          spoken: dest.kioskOn ? s.liveKiosk : s.liveDestKioskLabelOff,
          hint: hint,
          state: dest.kioskOn ? _DestState.on : _DestState.off,
          onTap: onOpen,
        ),
      if (dest.youtube)
        _DestPill(
          key: const ValueKey('live-dest-youtube'),
          icon: Icons.smart_display_rounded,
          label: s.liveDestShortYoutube,
          spoken: dest.saving ? '$ytSpoken. ${s.liveDestSaving}' : ytSpoken,
          hint: hint,
          state: dest.youtubeState,
          saving: dest.saving,
          onTap: onOpen,
        ),
      _DestPill(
        key: const ValueKey('live-dest-recording'),
        icon: Icons.radio_button_checked_rounded,
        label: s.liveDestShortRecording,
        spoken: dest.recordingLabel,
        hint: hint,
        state: dest.recordingOn ? _DestState.on : _DestState.off,
        onTap: onOpen,
      ),
    ];
    return Row(
      key: const ValueKey('live-destinations'),
      children: [
        for (var i = 0; i < pills.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Expanded(child: pills[i]),
        ],
      ],
    );
  }
}

String _noStop(String text) => text.endsWith('.') ? text.substring(0, text.length - 1) : text;

class _DestPill extends StatelessWidget {
  const _DestPill({
    super.key,
    required this.icon,
    required this.label,
    required this.spoken,
    required this.hint,
    required this.state,
    required this.onTap,
    this.saving = false,
  });

  final IconData icon;
  final String label;
  final String spoken;
  final String hint;
  final _DestState state;
  final VoidCallback onTap;

  /// A write of this choice is on its way to the box: a small progress mark in place of the badge.
  final bool saving;

  @override
  Widget build(BuildContext context) {
    final (ink, border, fill) = switch (state) {
      _DestState.on => (LiveColors.healthyInk, LiveColors.healthyInk, LiveColors.healthyInk.withValues(alpha: 0.10)),
      _DestState.warn => (LiveColors.waitingInk, LiveColors.waiting, LiveColors.waitingSoft),
      _DestState.off || _DestState.unknown => (SurauColors.muted, SurauColors.line, Colors.transparent),
    };
    const radius = BorderRadius.all(Radius.circular(14));
    return Semantics(
      button: true,
      label: spoken,
      hint: hint,
      onTap: onTap,
      excludeSemantics: true,
      child: Material(
        color: fill,
        shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: border)),
        child: InkWell(
          borderRadius: radius,
          onTap: onTap,
          child: SizedBox(
            height: 48,
            child: Padding(
              padding: const EdgeInsetsDirectional.symmetric(horizontal: 6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  _BadgedIcon(icon: icon, color: ink, state: state, saving: saving),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      softWrap: false,
                      style: Theme.of(context).textTheme.labelMedium!.copyWith(color: ink),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A 22 px icon with the 16 px status badge on its top end corner.
class _BadgedIcon extends StatelessWidget {
  const _BadgedIcon({required this.icon, required this.color, required this.state, this.saving = false});

  final IconData icon;
  final Color color;
  final _DestState state;
  final bool saving;

  @override
  Widget build(BuildContext context) {
    final bg = switch (state) {
      _DestState.on => LiveColors.healthy,
      _DestState.warn => LiveColors.waiting,
      _DestState.off || _DestState.unknown => SurauColors.outline,
    };
    const mark = TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w800, height: 1);
    final Widget glyph = switch (state) {
      _DestState.on => const Icon(Icons.check_rounded, size: 11, color: Colors.white),
      _DestState.off => const Icon(Icons.remove_rounded, size: 11, color: Colors.white),
      _DestState.warn => const Text('!', style: mark, textScaler: TextScaler.noScaling),
      _DestState.unknown => const Text('?', style: mark, textScaler: TextScaler.noScaling),
    };
    return SizedBox(
      width: 22,
      height: 22,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Icon(icon, size: 22, color: color),
          PositionedDirectional(
            end: -7,
            top: -6,
            child: saving
                ? Container(
                    key: const ValueKey('live-dest-saving'),
                    width: 16,
                    height: 16,
                    padding: const EdgeInsets.all(2),
                    decoration: const BoxDecoration(color: SurauColors.card, shape: BoxShape.circle),
                    child: CircularProgressIndicator(strokeWidth: 2, color: color),
                  )
                : Container(
                    key: ValueKey('live-dest-badge-${state.name}'),
                    width: 16,
                    height: 16,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: bg,
                      shape: BoxShape.circle,
                      border: Border.all(color: SurauColors.card, width: 2),
                    ),
                    child: glyph,
                  ),
          ),
        ],
      ),
    );
  }
}

/// The sheet behind the strip: each destination's full text, the YouTube switch, the note and Sambung.
class _DestSheet extends StatelessWidget {
  const _DestSheet({
    required this.dest,
    required this.onYoutube,
    required this.onConnect,
    required this.onKiosk,
    required this.onRecording,
  });

  final _Dest dest;
  final ValueChanged<bool>? onYoutube;
  final ValueChanged<bool>? onKiosk;
  final ValueChanged<bool>? onRecording;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final note = dest.note;
    final warnNote = note != null && dest.connectLabel != null;
    final noteInk = dest.noteIsSkip || warnNote ? LiveColors.waitingInk : SurauColors.muted;
    final blocks = <Widget>[
      if (dest.kiosk)
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            MergeSemantics(
              child: _DestSheetRow(
                icon: Icons.desktop_windows_outlined,
                title: s.liveKiosk,
                subtitle: dest.kioskOn ? s.liveKioskHint : s.liveDestKioskOffSub,
                trailing: SizedBox(
                  width: 60,
                  height: 48,
                  child: Center(
                    child: Switch(
                      key: const ValueKey('live-dest-kiosk-switch'),
                      value: dest.kioskOn,
                      onChanged: dest.kioskEnabled ? onKiosk : null,
                    ),
                  ),
                ),
              ),
            ),
            if (dest.kioskNote != null)
              Padding(
                padding: const EdgeInsetsDirectional.only(start: 58, bottom: 10),
                child: Text(
                  dest.kioskNote!,
                  key: const ValueKey('live-dest-kiosk-note'),
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
              ),
          ],
        ),
      if (dest.youtube && dest.live)
        // YouTube keeps the way it works during a live: it can be turned on (Siarkan ke YouTube), never off here.
        _DestSheetRow(
          icon: Icons.smart_display_rounded,
          title: dest.youtubeLabel,
          subtitle: s.liveDestYoutubeLive,
          trailing: _DestTick(on: dest.youtubeOn),
        ),
      if (dest.youtube && !dest.live)
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // One node for the screen reader: the row's text with the switch state.
            MergeSemantics(
              child: _DestSheetRow(
                icon: Icons.smart_display_rounded,
                title: dest.youtubeLabel,
                trailing: SizedBox(
                  width: 60,
                  height: 48,
                  child: Center(
                    child: Switch(
                      key: const ValueKey('live-dest-youtube-switch'),
                      value: dest.youtubeOn,
                      onChanged: onYoutube,
                    ),
                  ),
                ),
              ),
            ),
            if (note != null)
              Padding(
                padding: const EdgeInsetsDirectional.only(start: 58, bottom: 10),
                child: Container(
                  decoration: warnNote
                      ? const BoxDecoration(
                          color: LiveColors.waitingSoft,
                          borderRadius: BorderRadius.all(Radius.circular(12)),
                        )
                      : null,
                  padding: warnNote ? const EdgeInsetsDirectional.only(start: 10, end: 4) : EdgeInsets.zero,
                  constraints: BoxConstraints(minHeight: warnNote ? 48 : 0),
                  child: Row(
                    children: [
                      if (warnNote) ...[
                        const Icon(Icons.warning_amber_rounded, size: 20, color: LiveColors.waitingInk),
                        const SizedBox(width: 8),
                      ],
                      Expanded(
                        child: Text(
                          note,
                          key: ValueKey(dest.noteIsSkip ? 'live-dest-skip' : 'live-dest-none'),
                          style: text.bodySmall!.copyWith(color: noteInk),
                        ),
                      ),
                      if (dest.connectLabel != null)
                        TextButton(
                          key: const ValueKey('live-dest-connect'),
                          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                          onPressed: onConnect,
                          child: Text(dest.connectLabel!),
                        ),
                    ],
                  ),
                ),
              ),
            if (dest.saving || dest.unconfirmed)
              Padding(
                padding: const EdgeInsetsDirectional.only(start: 58, bottom: 10),
                child: Text(
                  dest.saving ? s.liveDestSaving : s.liveDestUnconfirmed,
                  key: ValueKey(dest.saving ? 'live-dest-saving-line' : 'live-dest-unconfirmed'),
                  style: text.bodySmall!.copyWith(color: dest.saving ? SurauColors.muted : LiveColors.waitingInk),
                ),
              ),
            // The memory is this box's own: each MAXCOM Kiosk Box has its own YouTube channel (operator decision).
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 58, bottom: 10),
              child: Text(
                s.liveDestPerBoxNote,
                key: const ValueKey('live-dest-per-box'),
                style: text.bodySmall!.copyWith(color: SurauColors.muted),
              ),
            ),
          ],
        ),
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MergeSemantics(
            child: _DestSheetRow(
              icon: Icons.radio_button_checked_rounded,
              title: dest.recordingLabel,
              // not offered with the box pulling the camera, and the sheet says why
              subtitle: dest.recordingWhy ?? (dest.recordingOn ? s.liveRecordingWithLive : null),
              trailing: SizedBox(
                width: 60,
                height: 48,
                child: Center(
                  child: Switch(
                    key: const ValueKey('live-dest-recording-switch'),
                    value: dest.recordingOn,
                    onChanged: dest.recordingEnabled ? onRecording : null,
                  ),
                ),
              ),
            ),
          ),
          if (dest.recordingNote != null)
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 58, bottom: 10),
              child: Text(
                dest.recordingNote!,
                key: const ValueKey('live-dest-recording-note'),
                style: text.bodySmall!.copyWith(color: SurauColors.muted),
              ),
            ),
        ],
      ),
    ];
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        key: const ValueKey('live-dest-sheet'),
        padding: const EdgeInsetsDirectional.fromSTEB(20, 8, 20, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(top: 4, bottom: 10),
                decoration: const BoxDecoration(
                  color: SurauColors.line,
                  borderRadius: BorderRadius.all(Radius.circular(2)),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Semantics(header: true, child: Text(s.liveDestSheetTitle, style: text.titleMedium)),
            ),
            for (var i = 0; i < blocks.length; i++)
              DecoratedBox(
                decoration: BoxDecoration(
                  border: i < blocks.length - 1 ? const Border(bottom: BorderSide(color: SurauColors.line)) : null,
                ),
                child: blocks[i],
              ),
            if (dest.pickNote != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  dest.pickNote!,
                  key: const ValueKey('live-dest-pick-one-sheet'),
                  style: text.bodySmall!.copyWith(color: LiveColors.waitingInk),
                ),
              ),
            const SizedBox(height: 10),
            OutlinedButton(
              key: const ValueKey('live-dest-close'),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                foregroundColor: SurauColors.teal,
                side: const BorderSide(color: SurauColors.teal),
                shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(14))),
              ),
              onPressed: () => Navigator.of(context).pop(),
              child: Text(s.actionClose),
            ),
          ],
        ),
      ),
    );
  }
}

/// The hosts "Lihat di YouTube" may open.
const _watchHosts = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'};

/// The box's watch link as a link that may be opened: a secure address on YouTube's own hosts, nothing else (the link
/// comes from the box's word and is never trusted to be a web page).
@visibleForTesting
Uri? watchUri(String? url) {
  final uri = url == null ? null : Uri.tryParse(url.trim());
  if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) return null;
  if (!_watchHosts.contains(uri.host.toLowerCase())) return null;
  return uri;
}

/// The one line above the controls of a running live: where it goes now. Skrin off is said, not hidden.
///
/// Null when the screen and YouTube are both off and this device cannot record: "recording only" would be wrong.
String? _liveSummary(S s, {required bool kiosk, required bool youtube, required bool recording}) => kiosk
    ? (youtube ? s.liveDestLive2 : s.liveDestLive1)
    : (youtube ? s.liveDestLiveYt : (recording ? s.liveDestLiveRec : null));

class _DestSheetRow extends StatelessWidget {
  const _DestSheetRow({required this.icon, required this.title, this.subtitle, required this.trailing});

  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 64),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: const BoxDecoration(
                color: SurauColors.tealSoft,
                borderRadius: BorderRadius.all(Radius.circular(12)),
              ),
              child: Icon(icon, color: SurauColors.teal, size: 22),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: text.titleSmall),
                  if (subtitle != null) Text(subtitle!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            trailing,
          ],
        ),
      ),
    );
  }
}

/// The green check (on) or the grey ring (off) beside a destination with no switch.
class _DestTick extends StatelessWidget {
  const _DestTick({required this.on});

  final bool on;

  @override
  Widget build(BuildContext context) => Icon(
    on ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
    size: 24,
    color: on ? LiveColors.healthy : SurauColors.outline,
  );
}


class _CardHead extends StatelessWidget {
  const _CardHead(this.title);

  final String title;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 16, 6),
    child: Text(
      title,
      style: Theme.of(context).textTheme.labelLarge!.copyWith(color: SurauColors.muted),
    ),
  );
}

/// "Tetapan siaran": where the holder of `live:settings` changes the camera, the screen, YouTube and the recording.
class _SettingsLinks extends StatelessWidget {
  const _SettingsLinks({required this.cameraOn, required this.cameraName, this.account, this.leading});

  /// The first item of the block (the card "Paparkan siaran langsung").
  final Widget? leading;

  final bool cameraOn;
  final String cameraName;

  /// The YouTube account entry, last (null while a live runs or YouTube is not used).
  final Widget? account;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    Widget row(String key, IconData icon, String title, Widget sub) => InkWell(
      key: ValueKey('live-settings-$key'),
      onTap: () => GoRouter.of(context).go(AppRoutes.liveSettingsFor(key)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 64),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(20, 10, 12, 10),
          child: Row(
            children: [
              Icon(icon, color: SurauColors.teal),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    DefaultTextStyle(style: text.bodySmall!.copyWith(color: SurauColors.muted), child: sub),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
            ],
          ),
        ),
      ),
    );

    return Column(
      children: [
        ?leading,
        row(
          'liveCamera',
          Icons.videocam_rounded,
          liveSettingsCameraRow(lang),
          DotSummary(cameraOn ? RowTone.ok : RowTone.idle, cameraOn ? '${liveSettingsCameraOn(lang)}, $cameraName' : liveSettingsCameraOff(lang)),
        ),
        row('liveOnKiosk', Icons.tv_rounded, liveSettingsKioskRow(lang), Text(liveSettingsKioskHint(lang))),
        row('liveYoutube', Icons.smart_display_rounded, liveSettingsYoutubeRow(lang), Text(liveSettingsYoutubeHint(lang))),
        row('recording', Icons.fiber_manual_record_rounded, liveSettingsRecordingRow(lang), Text(liveSettingsRecordingHint(lang))),
        if (account != null) ...[const Divider(height: 1, indent: 20, endIndent: 20), account!],
      ],
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: SurauColors.card,
        border: Border(top: BorderSide(color: SurauColors.line)),
      ),
      padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
      child: SafeArea(top: false, child: child),
    );
  }
}

// ---- kuliah tile and sheet ----

class _KuliahTile extends StatelessWidget {
  const _KuliahTile({
    required this.choice,
    required this.kuliah,
    required this.enabled,
    required this.onTap,
  });

  final LiveKuliahChoice? choice;
  final LiveKuliah? kuliah;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final k = kuliah;
    final noneToday = choice != null && choice!.today.isEmpty;
    final String title;
    final String subtitle;
    if (choice == null) {
      title = s.liveKuliahPick;
      subtitle = '';
    } else if (k != null) {
      title = k.label;
      subtitle = [k.penceramah, k.topic].whereType<String>().join(', ');
    } else {
      title = noneToday ? s.liveNoKuliah : s.liveNoKuliahOption;
      subtitle = noneToday ? s.liveNoKuliahOption : s.liveNoKuliahHint;
    }
    return Card(
      child: InkWell(
        key: const ValueKey('live-kuliah'),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 8, 14),
          child: Row(
            children: [
              _DateBadge(kuliah: k),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleMedium),
                    if (subtitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: text.bodyMedium!.copyWith(
                          color: SurauColors.muted,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (enabled)
                TextButton(onPressed: onTap, child: Text(s.liveKuliahChange)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The kuliah's time on a small glass tile, like the kiosk's next-prayer
/// box; an empty calendar when no kuliah is chosen.
class _DateBadge extends StatelessWidget {
  const _DateBadge({required this.kuliah});

  final LiveKuliah? kuliah;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      width: 64,
      height: 60,
      decoration: BoxDecoration(
        color: kuliah == null ? SurauColors.paperDeep : SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      alignment: Alignment.center,
      child: kuliah == null
          ? const Icon(
              Icons.event_busy_rounded,
              color: SurauColors.muted,
              size: 26,
            )
          : Text(
              kuliah!.time,
              style: text.titleMedium!.copyWith(
                color: SurauColors.gold,
                fontWeight: FontWeight.w800,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
    );
  }
}

class _Picked {
  const _Picked(this.id);

  final String? id;
}

class _KuliahSheet extends ConsumerWidget {
  const _KuliahSheet({required this.choice, required this.selected});

  final LiveKuliahChoice choice;
  final String? selected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final today = deps.toLocal(deps.now());
    Widget row(LiveKuliah? k) {
      final on = k?.id == selected;
      return ListTile(
        leading: Icon(
          on
              ? Icons.radio_button_checked_rounded
              : Icons.radio_button_off_rounded,
          color: on ? SurauColors.teal : SurauColors.outline,
        ),
        title: Text(k == null ? s.liveNoKuliahOption : k.label),
        subtitle: Text(
          k == null
              ? s.liveNoKuliahHint
              : [
                  whenWords(k.at, today: today, lang: appLangOfS(s)),
                  k.penceramah,
                ].whereType<String>().join(', '),
        ),
        onTap: () => Navigator.pop(context, _Picked(k?.id)),
      );
    }

    Widget head(String t) => Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 20, 4),
      child: Text(
        t,
        style: text.labelMedium!.copyWith(color: SurauColors.muted),
      ),
    );

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsetsDirectional.only(bottom: 16),
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 4),
              child: Text(s.liveKuliahPick, style: text.titleLarge),
            ),
            head(s.liveKuliahToday),
            if (choice.today.isEmpty)
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 20, 8),
                child: Text(
                  s.liveNoKuliah,
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
              ),
            ...choice.today.map(row),
            if (choice.upcoming.isNotEmpty) ...[
              head(s.liveKuliahUpcoming),
              ...choice.upcoming.map(row),
            ],
            const Divider(indent: 20, endIndent: 20),
            row(null),
          ],
        ),
      ),
    );
  }
}

// ---- YouTube account ----

/// "YouTube: tidak dapat disemak sekarang (kali terakhir: saluran)": the sign-in could not be read, which is not a sign-out.
String youtubeUnknownText(S s, String? lastChannel) =>
    (lastChannel == null || lastChannel.isEmpty) ? s.liveYoutubeUnknownNoLast : s.liveYoutubeUnknown(bidiIsolate(lastChannel));

/// The same cause as [youtubeUnknownText] as a clause after "YouTube tidak dapat digunakan sekarang:", without the
/// "YouTube:" prefix that the dialog's own first words already carry.
String youtubeUnknownReason(S s, String? lastChannel) =>
    (lastChannel == null || lastChannel.isEmpty) ? s.liveYoutubeWhyUnknownNoLast : s.liveYoutubeWhyUnknown(bidiIsolate(lastChannel));

class YoutubeAccountCard extends ConsumerWidget {
  const YoutubeAccountCard({super.key, required this.box});

  final LiveBoxStatus box;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final yt = box.youtube;
    final notifier = ref.read(liveBoxProvider.notifier);
    final open = ref.read(appDepsProvider).openUrl;

    final List<Widget> body;
    if (!box.youtubeSignInHere) {
      // Away from the surau (2026.11.13): the grant is held by the MAXCOM at the surau. The cloud shows the flag
      // it pushed; signing in, signing out and changing the channel are made on the surau Wi-Fi only.
      final flag = yt.signedIn
          ? s.liveYoutubeConnectedSnack(bidiIsolate(yt.channel ?? s.liveYoutube))
          : yt.phase == YoutubeAccountPhase.unknown
          ? youtubeUnknownText(s, yt.channel)
          : (yt.reason == YoutubeSignOutReason.revoked ? s.liveSignInRevoked : s.liveYoutubeNotConnected);
      body = [
        Row(
          key: const ValueKey('live-youtube-flag'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              yt.signedIn ? Icons.check_circle_rounded : Icons.info_outline_rounded,
              color: yt.signedIn ? LiveColors.healthy : LiveColors.waitingInk,
              size: 22,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                flag,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: text.titleSmall!.copyWith(color: yt.signedIn ? LiveColors.healthyInk : LiveColors.waitingInk),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Container(
          key: const ValueKey('live-youtube-at-surau'),
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 12),
          decoration: BoxDecoration(
            color: SurauColors.glass,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            border: Border.all(color: SurauColors.goldHairline),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.wifi_rounded, color: SurauColors.teal, size: 20),
              const SizedBox(width: 10),
              Expanded(child: Text(s.liveYoutubeAtSurauOnly, style: text.bodyMedium)),
            ],
          ),
        ),
      ];
    } else {
      switch (yt.phase) {
        case YoutubeAccountPhase.signedIn:
          body = [
            Row(
              key: const ValueKey('live-youtube-connected'),
              children: [
                const Icon(
                  Icons.check_circle_rounded,
                  color: LiveColors.healthy,
                  size: 22,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.liveYoutubeConnected,
                    style: text.titleSmall!.copyWith(color: LiveColors.healthyInk),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 30),
              child: Text(
                yt.channel ?? s.liveYoutube,
                key: const ValueKey('live-youtube-channel'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: text.titleMedium!.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(height: 4),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton(
                key: const ValueKey('live-youtube-signout'),
                onPressed: () => _confirmSignOut(context, s, notifier),
                child: Text(s.liveSignOutChange),
              ),
            ),
          ];
        case YoutubeAccountPhase.unknown:
          // not a sign-out: nothing to sign in to, the sign-in is only not readable now
          // (with no last good channel there is nothing to wait for: the sign-in is offered)
          body = [
            Row(
              key: const ValueKey('live-youtube-unknown'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline_rounded, color: LiveColors.waitingInk, size: 22),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    youtubeUnknownText(s, yt.channel),
                    style: text.titleSmall!.copyWith(color: LiveColors.waitingInk),
                  ),
                ),
              ],
            ),
            if ((yt.channel ?? '').isEmpty) ...[
              const SizedBox(height: 14),
              OutlinedButton.icon(
                key: const ValueKey('live-youtube-unknown-signin'),
                onPressed: notifier.signIn,
                icon: const Icon(Icons.login_rounded),
                label: Text(s.liveSignIn),
              ),
            ],
          ];
        case YoutubeAccountPhase.signedOut:
          final why = switch (yt.reason) {
            YoutubeSignOutReason.denied => s.liveSignInDenied,
            YoutubeSignOutReason.expired => s.liveSignInExpired,
            YoutubeSignOutReason.revoked => s.liveSignInRevoked,
            null => null,
          };
          body = [
            if (why != null)
              Row(
                key: const ValueKey('live-signin-outcome'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.info_outline_rounded,
                    color: LiveColors.waitingInk,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      why,
                      style: text.bodyMedium!.copyWith(color: LiveColors.waitingInk),
                    ),
                  ),
                ],
              )
            else
              Text(
                s.liveSignInHint,
                style: text.bodyMedium!.copyWith(color: SurauColors.muted),
              ),
            const SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: notifier.signIn,
              icon: const Icon(Icons.login_rounded),
              label: Text(s.liveSignIn),
            ),
          ];
        case YoutubeAccountPhase.signingIn:
          // always the one Google page: the address the box sends is not used
          final url = 'https://www.google.com/device';
          body = yt.byAdmin
              ? [
                  Row(
                    children: [
                      const Icon(Icons.hourglass_top_rounded, size: 18, color: SurauColors.muted),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          s.liveSignInByAdmin,
                          key: const ValueKey('live-signin-by-admin'),
                          style: text.bodyMedium,
                        ),
                      ),
                    ],
                  ),
                ]
              : [
            Text(s.liveSignInCode, style: text.bodyMedium),
            const SizedBox(height: 14),
            Container(
              key: const ValueKey('live-signin-code'),
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
              decoration: BoxDecoration(
                color: SurauColors.glass,
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                border: Border.all(color: SurauColors.goldHairline),
              ),
              alignment: Alignment.center,
              child: yt.userCode == null
                  ? const Icon(
                      Icons.more_horiz_rounded,
                      color: SurauColors.gold,
                      size: 40,
                    )
                  : FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        yt.userCode!,
                        maxLines: 1,
                        style: text.displaySmall!.copyWith(
                          color: SurauColors.gold,
                          letterSpacing: 3,
                        ),
                      ),
                    ),
            ),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: () => open(Uri.parse(url)),
              icon: const Icon(Icons.open_in_new_rounded),
              label: Text(s.liveSignInOpenGoogle),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                const Icon(
                  Icons.hourglass_top_rounded,
                  size: 18,
                  color: SurauColors.muted,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    key: const ValueKey('live-signin-waiting'),
                    yt.expiresAt == null
                        ? s.liveSignInWaiting
                        : s.liveSignInWaitingMin(_minutesLeft(ref, yt.expiresAt!)),
                    style: text.bodySmall,
                  ),
                ),
              ],
            ),
          ];
      }
    }

    // A flat entry of the Tetapan siaran card (no card of its own).
    return KeyedSubtree(
      key: const ValueKey('live-youtube-account'),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.smart_display_rounded,
                  color: SurauColors.teal,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(s.liveYoutubeAccount, style: text.titleSmall),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ...body,
          ],
        ),
      ),
    );
  }

  /// Whole minutes until the code stops working (never below 1 while it still works).
  static int _minutesLeft(WidgetRef ref, DateTime expiresAt) {
    final left = expiresAt.difference(ref.read(appDepsProvider).now());
    final m = (left.inSeconds / 60).ceil();
    return m < 1 ? 1 : m;
  }

  /// Changing the channel or signing out ends YouTube for the next live, so it is asked first.
  static Future<void> _confirmSignOut(
    BuildContext context,
    S s,
    LiveBoxNotifier notifier,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const ValueKey('live-youtube-signout-confirm'),
        title: Text(s.liveSignOutConfirmTitle),
        // Y5: the sign-out withdraws the access at Google, so every other box on the same account is signed out too
        content: Text('${s.liveSignOutConfirmBody}\n\n${s.liveYoutubeSignOutOtherBoxes}'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('live-youtube-signout-yes'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(s.liveSignOutConfirmAction),
          ),
        ],
      ),
    );
    if (ok == true) await notifier.signOut();
  }
}

/// The collapsed "Tetapan siaran" line: the connected channel with a check mark, else the plain summary.
Widget _settingsSummary(S s, AppLang lang, YoutubeAccount yt, bool cameraOn) {
  if (!yt.signedIn) return Text(liveSectionSettingsSummary(lang, cameraOn));
  final camera = liveSettingsCameraShort(lang, cameraOn);
  return Row(
    key: const ValueKey('live-settings-summary-connected'),
    children: [
      const Icon(Icons.check_circle_rounded, color: LiveColors.healthy, size: 16),
      const SizedBox(width: 6),
      Expanded(
        child: Text(
          s.liveSettingsSummaryConnected(yt.channel ?? s.liveYoutube, camera),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    ],
  );
}

// ---- after the stop ----

class LiveSummarySheet extends StatelessWidget {
  const LiveSummarySheet({
    super.key,
    required this.durationSec,
    required this.youtubeSeconds,
    required this.recorded,
    required this.web,
    required this.kuliah,
    required this.watchUrl,
    required this.onWatch,
    required this.onSave,
    this.onCatchUp,
    this.onShareNotice,
    this.recordingNotes = const [],
    this.noRecordingWhy,
  });

  /// Why this live was not recorded on the phone (the box pulled the camera): shown in place of the recording row.
  final String? noRecordingWhy;

  final int durationSec;

  /// Null when the YouTube leg was not used.
  final int? youtubeSeconds;
  final bool recorded;
  final bool web;
  final LiveKuliah? kuliah;
  final String? watchUrl;
  final void Function(String url) onWatch;
  final VoidCallback onSave;

  /// Offers `Kongsi pautan siaran` (the live notice) beside the watch button
  /// when set: only for a live with a public YouTube link, to a holder of
  /// `live:control`.
  final VoidCallback? onShareNotice;

  /// Offers `Muat naik rakaman penuh ke YouTube` when set: enqueues the
  /// recording (asking first where needed) and answers true when the sheet
  /// should close and the upload screen open.
  final Future<bool> Function(BuildContext sheetContext)? onCatchUp;

  /// What to say about the recording: `joined`, `joinFailed`, `askLater`, `keptUnconfirmed`.
  final List<String> recordingNotes;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final yt = youtubeSeconds;
    final short = yt != null && yt < durationSec - 60;
    final catchUp = onCatchUp;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(24, 0, 24, 20),
        child: SingleChildScrollView(
          child: Column(
            key: const ValueKey('live-summary'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: const BoxDecoration(
                      color: SurauColors.tealSoft,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.check_rounded,
                      color: SurauColors.teal,
                      size: 28,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(s.liveEnded, style: text.headlineSmall),
                        if (kuliah != null)
                          Text(
                            [
                              kuliah!.label,
                              kuliah!.penceramah,
                            ].whereType<String>().join(', '),
                            style: text.bodyMedium!.copyWith(
                              color: SurauColors.muted,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Text(
                formatDuration(durationSec),
                style: text.displayMedium!.copyWith(color: SurauColors.glass),
              ),
              Text(s.liveDuration, style: text.bodySmall),
              if (short) ...[
                const SizedBox(height: 16),
                LiveNotice(
                  icon: Icons.smart_display_rounded,
                  title: s.liveYoutubeShort(
                    (yt / 60).round(),
                    (durationSec / 60).round(),
                  ),
                ),
              ],
              const SizedBox(height: 20),
              if (recorded && web)
                FilledButton.icon(
                  onPressed: onSave,
                  icon: const Icon(Icons.download_rounded),
                  label: Text(s.liveSaveRecording),
                )
              else if (recorded)
                Row(
                  children: [
                    const Icon(Icons.folder_rounded, color: SurauColors.teal),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(s.liveRecordingSaved, style: text.bodyLarge),
                    ),
                  ],
                ),
              if (noRecordingWhy != null)
                Row(
                  key: const ValueKey('live-rec-none-why'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.info_outline_rounded, size: 20, color: SurauColors.teal),
                    const SizedBox(width: 10),
                    Expanded(child: Text(noRecordingWhy!, style: text.bodyMedium)),
                  ],
                ),
              for (final k in recordingNotes) ...[
                const SizedBox(height: 12),
                Row(
                  key: ValueKey('live-rec-note-$k'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      const {'joinFailed', 'joinNeedsWifi', 'badPiece', 'joinedUntracked', 'noSpace'}.contains(k)
                          ? Icons.warning_amber_rounded
                          : (k == 'joined' ? Icons.merge_type_rounded : Icons.info_outline_rounded),
                      size: 20,
                      color: SurauColors.teal,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        switch (k) {
                          'joined' => s.liveRecJoinedNote,
                          'joinFailed' => s.liveRecJoinFailedNote,
                          'joinNeedsWifi' => s.liveRecJoinNeedsWifiNote,
                          'badPiece' => s.liveRecBadPieceNote,
                          'noSpace' => s.liveRecNoSpaceNote,
                          'joinedUntracked' => s.liveRecJoinedUntrackedNote,
                          'askLater' => s.liveRecAskLaterNote,
                          _ => s.liveRecKeptUnconfirmedNote,
                        },
                        style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                      ),
                    ),
                  ],
                ),
              ],
              if (catchUp != null) ...[
                const SizedBox(height: 12),
                _CatchUpButton(onCatchUp: catchUp, explain: !short),
              ],
              if (watchUrl != null) ...[
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => onWatch(watchUrl!),
                  icon: const Icon(Icons.open_in_new_rounded),
                  label: Text(s.liveWatch),
                ),
              ],
              if (onShareNotice != null) ...[
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  key: const ValueKey('live-summary-notice'),
                  onPressed: onShareNotice,
                  icon: const Icon(Icons.share_rounded),
                  label: Text(s.liveNoticeShare),
                ),
              ],
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: Text(s.actionClose),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The live's YouTube leg was never up, or got a minute less than the whole.
bool liveNeedsCatchUp({
  required int durationSec,
  required int? youtubeSeconds,
}) {
  final yt = youtubeSeconds;
  if (yt == null || yt <= 0) return durationSec > 0;
  return yt < durationSec - 60;
}

/// The box's warning when the cloud (which holds the YouTube sign-in) could
/// not be reached at the start; the kiosk leg runs regardless.
const cloudUnreachable = 'cloud_unreachable';

/// `Muat naik rakaman penuh ke YouTube` on the summary, in the surau's
/// gold: the next thing to do when YouTube missed part of the kuliah.
class _CatchUpButton extends StatefulWidget {
  const _CatchUpButton({required this.onCatchUp, required this.explain});

  final Future<bool> Function(BuildContext sheetContext) onCatchUp;

  /// The leg was never up: one line says why the button is there (a short
  /// leg already has its notice above).
  final bool explain;

  @override
  State<_CatchUpButton> createState() => _CatchUpButtonState();
}

class _CatchUpButtonState extends State<_CatchUpButton> {
  bool _busy = false;

  Future<void> _tap() async {
    setState(() => _busy = true);
    try {
      final ok = await widget.onCatchUp(context);
      if (ok && mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.explain) ...[
          Text(
            s.uploadFromSummaryHint,
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 10),
        ],
        FilledButton.icon(
          key: const ValueKey('live-catchup'),
          style: FilledButton.styleFrom(
            backgroundColor: SurauColors.gold,
            foregroundColor: SurauColors.ink,
            minimumSize: const Size.fromHeight(56),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          ),
          onPressed: _busy ? null : _tap,
          // Disabled while the choice sheet is open; no spinner (the
          // enqueue itself is instant).
          icon: const Icon(Icons.cloud_upload_rounded),
          label: Text(s.uploadFromSummary),
        ),
      ],
    );
  }
}

/// `Gantikan siaran yang terputus` or `Simpan kedua-duanya`: true replaces.
class ReplaceLiveSheet extends StatelessWidget {
  const ReplaceLiveSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    Widget option({
      required Key key,
      required IconData icon,
      required String title,
      required String body,
      required bool value,
      required bool accent,
    }) => Card(
      key: key,
      margin: EdgeInsets.zero,
      color: accent ? SurauColors.goldSoft : SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        side: BorderSide(color: accent ? SurauColors.gold : SurauColors.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        onTap: () => Navigator.pop(context, value),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 12, 14),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: accent ? SurauColors.gold : SurauColors.tealSoft,
                  borderRadius: BorderRadius.circular(
                    SurauTheme.radiusChip + 2,
                  ),
                ),
                child: Icon(
                  icon,
                  color: accent ? SurauColors.ink : SurauColors.teal,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    const SizedBox(height: 2),
                    Text(body, style: text.bodySmall),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: SurauColors.muted),
            ],
          ),
        ),
      ),
    );

    return SafeArea(
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20),
        child: Column(
          key: const ValueKey('live-replace-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.uploadReplaceAsk, style: text.titleLarge),
            const SizedBox(height: 6),
            Text(
              s.uploadReplaceAskBody,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
            const SizedBox(height: 16),
            option(
              key: const ValueKey('live-replace-yes'),
              icon: Icons.swap_horiz_rounded,
              title: s.uploadReplaceLive,
              body: s.uploadReplaceNote,
              value: true,
              accent: true,
            ),
            const SizedBox(height: 10),
            option(
              key: const ValueKey('live-replace-no'),
              icon: Icons.video_library_rounded,
              title: s.uploadKeepBoth,
              body: s.uploadKeepBothNote,
              value: false,
              accent: false,
            ),
          ],
        ),
      ),
    );
  }
}


/// The microphone name under the meter: the device the system really routed (Android), else the one picked up by
/// the watcher. The built-in microphone is the device's own (no name).
String? _routedMicName(MicInfo? picked, MicRouteInfo? routed, AppLang lang) {
  if (routed != null) {
    if (routed.kind == 'builtin') return null;
    return MicInfo(deviceId: routed.id, label: routed.name, kind: routed.kind).nameIn(lang);
  }
  return picked?.nameIn(lang);
}

/// The words under the summary about the recording: joined or not, and what happens with it. When the join failed
/// the person is never told "you will be asked" or "kept, not confirmed": every piece is simply kept, and nobody is asked.
List<String> recordingNotesFor(JoinOutcome? join, bool? covered, {required bool web}) {
  final failed = join != null && join.failed;
  return [
    if (join != null && join.joined) 'joined',
    if (join != null && join.joined && !join.tracked) 'joinedUntracked',
    if (failed)
      switch (join.error) {
        'box_away' => 'joinNeedsWifi',
        'bad_piece' => 'badPiece',
        'no_space' => 'noSpace',
        _ => 'joinFailed',
      },
    if (!failed && !web && covered == true) 'askLater',
    if (!failed && !web && covered == false) 'keptUnconfirmed',
  ];
}

/// "Paparkan siaran langsung" (build 5): one switch per box in Tetapan siaran. A box that is a follower shows none; a box
/// without the route (a build 4 box) hides the card for the session.
class _TvShowSection extends ConsumerWidget {
  const _TvShowSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tv = ref.watch(liveTvShowProvider);
    if (tv.unavailable) return const SizedBox.shrink();
    final s = S.of(context);
    final data = ref.watch(screensDataProvider).value;
    if (data != null && data.isFollower) return const SizedBox.shrink();
    final settings = ref.watch(settingsProvider).value?.value;
    final box = ref.watch(liveBoxProvider);
    final enrolled = ref.watch(enrolledBoxProvider);
    final listed = data == null || data.lanOnly || data.olderBox ? const <ScreenRowData>[] : [for (final r in data.boxes) if (!r.removed) r];
    // the list could not be read: the one row `self` with the name the app already has
    final boxes = listed.isEmpty
        ? [ScreenRowData(kind: ScreenKind.main, id: selfTvId, name: enrolled?.name ?? '')]
        : listed;
    final cpu = box.cpuPercent;
    final last = box.lastLiveCpuPercent;
    final rows = [
      for (final r in boxes)
        TvShowRow(
          tvId: r.id,
          name: r.name.isEmpty ? (enrolled?.name ?? 'MAXCOM') : r.name,
          kindLabel: r.kind == ScreenKind.main ? s.tvsMainBox : s.tvsFollowerBox,
          server: r.kind == ScreenKind.main,
          show: tv.pending[r.id] ?? (tvProfileOf(settings, r.id).show != false),
          cpuLine: r.kind == ScreenKind.main
              ? (cpu != null ? s.liveTvShowCpuNow(cpu) : (last != null ? s.liveTvShowCpuLast(last) : null))
              : null,
          busy: tv.busy.contains(r.id),
        ),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      child: LiveTvShowCard(
        rows: rows,
        texts: TvShowTexts(
          title: s.liveTvShowTitle,
          hint: s.liveTvShowHint,
          serverBadge: s.liveTvShowServer,
          offLine: s.liveTvShowOff,
          allOffNote: s.liveTvShowAllOff,
          switchLabel: s.liveTvShowSwitch,
        ),
        onChanged: (tvId, show) async {
          final ok = await ref.read(liveTvShowProvider.notifier).set(tvId, show);
          if (!ok && context.mounted && !ref.read(liveTvShowProvider).unavailable) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(S.of(context).liveTvShowFailed)));
          }
        },
      ),
    );
  }
}

/// The 5 second test of every box microphone on the start screen (build 5). Never blocks Start.
class _MicTestSection extends ConsumerWidget {
  const _MicTestSection({required this.canPick});

  final bool canPick;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(boxMicTestProvider);
    if (st.testUnavailable || st.devices.isEmpty) return const SizedBox.shrink();
    final s = S.of(context);
    final notifier = ref.read(boxMicTestProvider.notifier);
    MicTestState stateOf(BoxMicDevice d) {
      if (st.testing) return MicTestState.testing;
      return switch (d.code) {
        'ok' => MicTestState.sound,
        'silent' => MicTestState.silent,
        null => MicTestState.none,
        _ => MicTestState.failed,
      };
    }

    final at = st.testedAt;
    return BoxMicTestCard(
      rows: [
        for (final d in st.devices)
          MicTestRow(name: d.name, selected: d.selected, state: stateOf(d), meter: micMeterOf(d.meanDb)),
      ],
      texts: MicTestTexts(
        hint: s.liveMicTestHint,
        testing: s.liveMicTestBusy,
        sound: s.liveMicTestSound,
        silent: s.liveMicTestSilent,
        failed: s.liveMicTestFailed,
        none: s.liveMicTestNone,
        again: s.liveMicTestAgain,
        testedAt: at == null ? null : s.liveMicTestAt(TimeOfDay.fromDateTime(at.toLocal()).format(context)),
        silentTitle: s.liveMicTestSilentTitle,
        silentBody: s.liveMicTestSilentBody,
      ),
      testing: st.testing,
      onPick: canPick ? (name) => unawaited(notifier.pick(name)) : null,
      onTestAgain: () => unawaited(notifier.test()),
    );
  }
}
