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

import '../labels.dart' show appLangOfS;
import '../../app/app_lang.dart' show AppLang;
import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart' show BoxError;
import '../../l10n/generated/s.dart';
import '../common/bidi.dart';
import '../common/time_words.dart';
import '../common/ui_flags.dart';
import '../labels.dart' show appLangOf;
import '../labels_cam.dart';
import '../registry.g.dart' as reg;
import '../shell/connection_icons.dart' show LinkGlyph, LinkKind, LinkState;
import '../shell/live_camera_gateway.dart' show AudioSourceMix, LiveAudioMix;
import '../shell/permissions.dart';
import '../../upload/upload_queue.dart' show NoRecordings;
import '../upload/cleanup_providers.dart';
import '../upload/upload_widgets.dart';
import 'live_controller.dart';
import 'live_fold.dart';
import 'live_notice.dart';
import 'live_notice_box.dart';
import 'live_notice_sheet.dart';
import 'live_source.dart';
import 'live_source_widgets.dart';
import 'live_widgets.dart';
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
  // The surau's choice for the next live is the setting `liveYoutube.nextLiveOn`, one for the whole surau.
  // [_pendingWanted] is this phone's tap until the box has answered; [_localWanted] serves a box that has no
  // such setting yet (an older box): today's in-memory choice, default on.
  bool? _pendingWanted;
  // The answer of the dedicated route, kept until this phone's copy of the settings shows it (or a minute passes).
  bool? _confirmedWanted;
  DateTime? _confirmedAt;
  bool _localWanted = true;

  /// The folded or open state of the idle sections (kept while the screen lives).
  final Map<String, bool> _open = {};

  /// This live started with the external camera (so "Tukar ke kamera luaran" can offer the way back).
  bool _startedExternal = false;

  /// The camera was lost during this live (the "kembali" message follows its return).
  bool _cameraWasLost = false;

  /// The engine's end of a lost camera was already turned into a stop.
  bool _endHandled = false;

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
      }
    });
    if (_state.phase == PublisherPhase.idle ||
        _state.phase == PublisherPhase.stopped) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _prepare());
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _controller.attach();
      // what this device remembers and what the box says about the camera (also when the publisher is ready already)
      unawaited(ref.read(liveSourceProvider.notifier).ensureLoaded());
      // a microphone plugged in is picked up by itself
      ref.read(micAutoProvider.notifier).start();
    });
  }

  ScaffoldMessengerState? _messenger;
  MicAutoNotifier? _micAuto;
  String _stillLiveText = '';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.maybeOf(context);
    _micAuto = ref.read(micAutoProvider.notifier);
    _stillLiveText = S.of(context).ra4StillLive;
  }

  @override
  void dispose() {
    _micAuto?.stop();
    _controller.detach();
    // The live goes on without this page (its heartbeat is the controller's): say so once.
    if (_controller.takeLeaveReminder()) {
      final messenger = _messenger;
      final text = _stillLiveText;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        try {
          messenger?.showSnackBar(SnackBar(content: Text(text)));
        } on Object {
          // the app is closing or has no page to show it on
        }
      });
    }
    _sub?.cancel();
    super.dispose();
  }

  bool get _recordingOn {
    final settings = ref.read(settingsProvider).value?.value;
    final v = settings?['recording'];
    if (v is Map && v['enabled'] is bool) return v['enabled'] as bool;
    return reg.features.firstWhere((f) => f.key == 'recording').defaultEnabled;
  }

  Future<void> _prepare() {
    _cameraWasLost = false;
    return ref
        .read(liveSourceProvider.notifier)
        .prepare(recording: _recordingOn, frontCamera: _state.frontCamera);
  }

  Future<void> _stopForLostCamera() async {
    final lang = appLangOf(context);
    await ref.read(liveBoxProvider.notifier).stopLive(notice: liveCameraLostMinutes(lang));
    if (!mounted) return;
    await _prepare();
  }

  /// Why YouTube cannot be used now, or null when it can.
  ///
  /// [asReason] gives the same cause as a clause for "YouTube tidak dapat digunakan sekarang: ...", without
  /// "YouTube:" in front (the dialog already starts with the name).
  String? _youtubeBlock(S s, LiveBoxStatus box, bool canSignIn, {bool asReason = false}) {
    if (!box.internet) return asReason ? s.liveYoutubeWhyNoInternet : s.liveWarnNoInternet;
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

  /// The surau's choice: the box's setting when it has one (shared by every phone), else this run's own.
  bool _wantedFrom(Map<String, dynamic>? settings) {
    final pending = _pendingWanted;
    if (pending != null) return pending;
    final f = settings?['liveYoutube'];
    final confirmed = _confirmedWanted;
    if (confirmed != null) {
      final fresh = _confirmedAt != null && ref.read(appDepsProvider).now().difference(_confirmedAt!) < const Duration(minutes: 1);
      final caughtUp = f is Map && f['nextLiveOn'] == confirmed;
      if (fresh && !caughtUp) return confirmed;
      _confirmedWanted = null;
    }
    if (f is Map && f['nextLiveOn'] is bool) return f['nextLiveOn'] as bool;
    return _localWanted;
  }

  bool _boxKnowsChoice(Map<String, dynamic>? settings) {
    final f = settings?['liveYoutube'];
    return f is Map && f['nextLiveOn'] is bool;
  }

  /// A tap on the chip: written to the surau setting (optimistic, put back with a message when the box refuses).
  Future<void> _setWanted(bool next, {required bool boxKnows}) async {
    if (!boxKnows) {
      setState(() => _localWanted = next);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    final failed = S.of(context).liveYoutubeChoiceFailed;
    final messenger = _messenger;
    setState(() => _pendingWanted = next);
    try {
      if (gateway == null) throw StateError('no box');
      try {
        // The dedicated route: live:control is enough (the settings route needs settings:write).
        final answer = await gateway.put('/api/live/youtube/next-live', {'on': next});
        _confirmedWanted = answer['nextLiveOn'] is bool ? answer['nextLiveOn'] as bool : next;
        _confirmedAt = ref.read(appDepsProvider).now();
      } on BoxError catch (e) {
        // An older box has no such route: the settings field, as before.
        if (e.status != 404) rethrow;
        await gateway.put('/api/settings/liveYoutube', {'nextLiveOn': next});
      }
      ref.invalidate(settingsProvider);
      await ref.read(settingsProvider.future);
    } on Object {
      if (mounted) messenger?.showSnackBar(SnackBar(content: Text(failed)));
    } finally {
      if (mounted) setState(() => _pendingWanted = null);
    }
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
    try {
      _startedExternal = source.external;
      await ref
          .read(liveBoxProvider.notifier)
          .startLive(kuliahId: _kuliahId, youtube: youtube, video: source.video, mix: source.mix);
    } catch (_) {
      // the controller has put the reason on the screen
    } finally {
      if (mounted) setState(() => _starting = false);
    }
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
        title: Text(s.liveStopConfirm),
        content: Text(s.liveStopConfirmBody),
        actions: [
          TextButton(
            onPressed: () =>
                Navigator.of(dialogContext, rootNavigator: true).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: LiveColors.onAir,
              foregroundColor: Colors.white,
            ),
            onPressed: () =>
                Navigator.of(dialogContext, rootNavigator: true).pop(true),
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
    final duration = _state.durationSec;
    final youtubeUsed = _state.outputs.youtube != null;
    final recorded = _state.recording.on;
    final boxSession = ref.read(liveBoxProvider).sessionId;
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
    final cleanupKeepDays = await _registerCleanup(
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
        liveNeedsCatchUp(durationSec: duration, youtubeSeconds: youtubeSeconds);
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
        cleanupKeepDays: cleanupKeepDays,
        onWatch: (url) => ref.read(appDepsProvider).openUrl(Uri.parse(url)),
        onSave: () => ref.read(liveBoxProvider.notifier).savePending(),
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

  /// Tells the clean-up which files this live recorded (Plan 6 Task 13), and
  /// answers the kept days when YouTube's live leg alone covered the whole
  /// recording and the clean-up will therefore delete it, else null. The
  /// clean-up registers only files the app itself recorded.
  Future<int?> _registerCleanup({
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
      await cleanup.register(
        sessionId: session,
        kuliahId: kuliahId,
        durationSec: durationSec,
        youtubeSeconds: youtubeSeconds,
        liveVideoId: liveVideoId,
      );
      final rec = (await cleanup.records())[session];
      final s = ref.read(cleanupSettingsProvider);
      if (rec == null || !rec.liveCovered || !s.enabled) return null;
      unawaited(cleanup.run());
      return s.keepDays;
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
      switch (catchUpReplaceMode(ref.read(settingsProvider).value?.value)) {
        case 'always':
          replace = liveVideoId;
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
    try {
      await queue.enqueueFromSession(session, kuliahId, replaceLive: replace);
    } on NoRecordings {
      return false;
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

  Future<void> _openAdd() async {
    final id = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => AddAudioSheet(source: ref.read(liveSourceProvider), ipad: _ipad),
    );
    if (id != null && mounted) await ref.read(liveSourceProvider.notifier).add(id);
  }

  /// The stepper of the fallback "Imbangan masa audio" moved.
  void _stepOffset(String id, int delta) {
    final notifier = ref.read(liveSourceProvider.notifier);
    final ms = clampExternalOffset((ref.read(liveSourceProvider).offsets[id] ?? 0) + delta);
    notifier.rememberOffset(id, ms);
    _applyOffset(ms);
  }

  void _applyOffset(int ms) {
    final p = _publisher;
    if (p is WebPublisher) {
      p.setFallbackOffset(ms);
    } else if (p is LiveSourceControl) {
      unawaited((p as LiveSourceControl).setAvOffset(ms).catchError((_) {}));
    }
  }

  Future<void> _openClap(String id) async {
    final p = _publisher;
    final control = p is LiveSourceControl && p is! WebPublisher ? p as LiveSourceControl : null;
    final start = ref.read(liveSourceProvider).offsets[id] ?? 0;
    final saved = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (_) => ClapSheet(
        initialMs: start,
        control: control,
        clap: p.states.map((s) => s.clap).distinct(),
        onOffset: _applyOffset,
        onSave: (ms) async {
          if (p is WebPublisher) {
            p.setFallbackOffset(ms);
            await p.saveFallbackOffset();
          } else {
            await control?.setAvOffset(ms);
            await saveCameraOffset(ref.read(gatewayProvider), ref.read(settingsProvider).value?.value, id, ms);
          }
        },
      ),
    );
    if (saved != null && mounted) ref.read(liveSourceProvider.notifier).rememberOffset(id, saved);
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

  Future<void> _openNotice(LiveNoticeInput? input) async {
    await showLiveNoticeSheet(context, ref, input: input);
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

    final other = box.otherLive;
    final live = _state.isLive;
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
    final settingsMap = ref.watch(settingsProvider).value?.value;
    final boxKnowsChoice = _boxKnowsChoice(settingsMap);
    final wanted = _wantedFrom(settingsMap);
    // What the chip shows is the surau's choice; whether YouTube can be used right now is a separate matter
    // (a block is told beside it and asked about at Mula siaran, it never changes the choice).
    final youtubeChosen = youtubeFeature && wanted;
    final youtubeOn = youtubeChosen && block == null;
    final canChoose = can(roles, 'live:control');
    final canStart =
        kioskFeature &&
        !_starting &&
        !box.stopping &&
        !box.stopFailed &&
        _state.phase == PublisherPhase.ready &&
        box.boxReachable &&
        box.busyDevice == null &&
        other == null &&
        choice != null;

    final info = _rowInfo(box);
    final view = readOnly ? _viewFromBox(source, box) : source;
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
      micLabel: ref.watch(micAutoProvider.select((m) => m.mic))?.nameIn(lang),
    );
    final rows = buildAudioRows(source: view, ctx: ctx, info: info);
    final audioNotices = buildAudioNotices(source: view, ctx: ctx, info: info);
    final showMixer = view.external || view.mix.boxInput.enabled;
    final canAddAudio =
        !readOnly && ((view.external && !view.mix.deviceMic.enabled) || !view.mix.boxInput.enabled) && (!live || view.external);

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
      if (other != null && !live)
        LiveNotice(
          key: const ValueKey('live-other-device'),
          icon: Icons.sensors_rounded,
          title: liveOtherDeviceTitle(lang, other.starter),
          body: liveOtherDeviceBody(lang),
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
      if (box.notice != null && !(box.stopFailed && box.notice == s.ra4StopNotYet))
        LiveNotice(icon: Icons.info_outline_rounded, title: box.notice!),
      if (source.error != null && !live)
        LiveNotice(icon: Icons.info_outline_rounded, title: source.error!),
      if (box.warnings.contains(mediaPortsBlocked))
        LiveNotice(
          icon: Icons.shield_outlined,
          title: s.liveMediaPortsBlocked,
          danger: true,
        ),
      if (box.warnings.contains(noVideoFromDevice))
        LiveNotice(icon: Icons.videocam_off_rounded, title: s.liveNoVideo),
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

    final externalIdle = !live && !readOnly && source.external;
    final pullNote = externalIdle
        ? (ipad
              ? LiveNotice(
                  key: const ValueKey('live-pull-note'),
                  icon: Icons.dns_rounded,
                  title: liveBoxPullNote(lang, camName),
                )
              : LiveNotice(
                  key: const ValueKey('live-pull-note'),
                  icon: micInMix ? Icons.mic_rounded : Icons.smartphone_rounded,
                  title: livePhonePullNote(lang, camName, mic: micInMix),
                ))
        : null;

    final picture = showMixer
        ? Stack(
            fit: StackFit.expand,
            children: [
              _publisher.preview(context),
              PositionedDirectional(
                end: 10,
                top: 10,
                child: MixedLevelChip(
                  key: const ValueKey('live-mixed-level'),
                  level: _mixedLevel(view, info),
                  silent: mixAllMuted(view.mix, muted: _state.muted),
                ),
              ),
            ],
          )
        : _publisher.preview(context);
    final liveDest = live && (kioskFeature || youtubeFeature)
        ? Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              _state.outputs.youtube != null ? s.liveDestLive2 : s.liveDestLive1,
              key: const ValueKey('live-dest-summary'),
              style: Theme.of(context).textTheme.titleSmall,
            ),
          )
        : null;

    final monitor = <Widget>[
      ?liveDest,
      LivePreviewFrame(
        picture: picture,
        state: _state,
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
    ];

    final (kioskTone, kioskText) = outputStatus(
      s,
      live ? kioskLeg(_state.outputs.kiosk, box.ingestReady) : null,
      live: live,
    );
    // A leg the box relays is as healthy as the box says (the iPad only
    // sends one stream); otherwise the publisher knows.
    final ytOut = box.youtubeViaBox && _state.outputs.youtube != null
        ? (box.youtubeLeg ?? _state.outputs.youtube)
        : _state.outputs.youtube;
    final (ytTone, ytText) = live
        ? (ytOut == null
              ? (LightTone.idle, s.liveNotUsed)
              : outputStatus(s, ytOut, live: live))
        : (LightTone.idle, youtubeOn ? s.liveReady : s.liveNotUsed);
    final rec = _state.recording;
    final recordingOn = _recordingOn;

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
        subtitle: !recordingOn
            ? s.liveRecordingOff
            : (live || rec.segments > 0)
            ? s.liveRecordingParts(rec.segments, formatBytes(rec.bytes))
            : s.liveRecordingWithLive,
        tone: !recordingOn
            ? LightTone.idle
            : live && rec.on
            ? LightTone.onAir
            : LightTone.idle,
        status: !recordingOn
            ? s.liveRecordingOff
            : (live && rec.on ? s.liveRecordingOn : s.liveReady),
      ),
    ];
    final outputs = LiveCard(children: outputRows);

    // The destinations, always visible right above "Mula siaran" (not inside the folded card).
    final signedIn = box.youtube.signedIn;
    final unknownYoutube = box.youtube.phase == YoutubeAccountPhase.unknown;
    final destinations = (!live && !readOnly && (kioskFeature || youtubeFeature))
        ? _Destinations(
            kiosk: kioskFeature,
            youtube: youtubeFeature
                ? (
                    on: youtubeChosen,
                    label: youtubeChosen
                        ? ((box.youtube.channel ?? '').isEmpty ? s.liveDestOnPlain : s.liveDestOn(bidiIsolate(box.youtube.channel!)))
                        : s.liveDestOff,
                    enabled: canChoose && _pendingWanted == null && !busy && !_starting,
                    onTap: () => unawaited(_setWanted(!wanted, boxKnows: boxKnowsChoice)),
                  )
                : null,
            kioskLabel: s.liveKiosk,
            recordingOn: recordingOn,
            recordingLabel: recordingOn ? s.liveDestRec : s.liveDestRecOff,
            note: !youtubeFeature
                ? null
                : unknownYoutube
                ? youtubeUnknownText(s, box.youtube.channel)
                : (signedIn && block == null && !wanted)
                ? s.liveDestSkip
                : (!signedIn ? s.liveDestNone : null),
            noteIsSkip: signedIn || unknownYoutube,
            // Unknown with no last good channel (a box never signed in, its cloud away): Sambung is still offered.
            connectLabel: !signedIn && (!unknownYoutube || (box.youtube.channel ?? '').isEmpty) && canSettings
                ? s.liveDestLink
                : null,
            onConnect: () => setState(() => _open['set'] = true),
          )
        : null;
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
              cameraOn: source.camera.enabled,
              cameraName: camName,
              account: youtubeFeature && !live ? YoutubeAccountCard(box: box) : null,
            ),
          )
        : null;

    final button = LiveActionButton(
      // our own stop keeps the quiet "Menghentikan siaran" until the box is done
      phase: box.stopping ? PublisherPhase.stopping : _state.phase,
      onStart: canStart
          ? () => (youtubeChosen && block != null)
              ? _askTvOnly(_youtubeBlock(s, box, canSettings, asReason: true) ?? block)
              : _start(youtubeChosen)
          : null,
      onStop: _confirmStop,
    );

    // ---- the audio card (rows, messages) ----
    Widget audioBody() => AudioCardBody(
      rows: rows,
      notices: audioNotices,
      canAdd: canAddAudio,
      onAdd: _openAdd,
      onVolume: (id, v) => sourceNotifier.setVolume(id, v),
      onRemove: (id) => sourceNotifier.remove(id),
      onMute: () => _publisher.setMuted(!_state.muted),
      onUseOnly: (id) => sourceNotifier.useOnly(id),
      offsetBlock: canSettings && !readOnly
          ? (row) => OffsetBlock(
              ms: source.offsets[row.id] ?? 0,
              onStep: (d) => _stepOffset(row.id, d),
              onClap: () => _openClap(row.id),
            )
          : null,
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

    final idleSections = <Widget>[
      FoldSection(
        sectionKey: 'video',
        icon: Icons.videocam_rounded,
        title: liveSourceVideoTitle(lang),
        summary: DotSummary(videoTone, videoSummaryText),
        open: _isOpen('video'),
        onToggle: () => _toggle('video'),
        child: VideoSourceBody(
          source: source,
          ipad: ipad,
          readOnly: busy,
          onPick: (k) async {
            await sourceNotifier.selectVideo(k);
          },
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
        child: audioBody(),
      ),
      FoldSection(
        sectionKey: 'out',
        icon: Icons.tv_rounded,
        title: liveSectionOutputs(lang),
        summary: Text(ipad ? liveSectionOutputsSummaryIpad(lang) : liveSectionOutputsSummaryPhone(lang)),
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
      CameraLink.lost => ('Terputus', RowTone.off),
      CameraLink.connecting => ('Menyambung semula', RowTone.warn),
      _ => camBack ? ('Kembali', RowTone.ok) : ('Diterima', RowTone.ok),
    };
    final liveSources = (live || readOnly) && showMixer
        ? Card(
            key: const ValueKey('live-sources'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _CardHead(liveSourceVideoTitle(lang)),
                if (view.external)
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
                                ipad
                                    ? 'Ditarik oleh kotak MAXCOM'
                                    : (camLost ? 'Gambar terakhir' : (view.camera.spec ?? '')),
                                style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
                              ),
                            ],
                          ),
                        ),
                        ToneDot(liveCamStatus.$2),
                        const SizedBox(width: 6),
                        Text(
                          ipad ? 'Diterima' : liveCamStatus.$1,
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
              if (!source.external && _startedExternal && source.camera.offered)
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
    final Widget action = readOnly
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
                  children: [destinations, const SizedBox(height: 10), button],
                ));

    if (ref.watch(liveFoldedProvider)) {
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
              picture: _publisher.preview(context),
              state: _state,
              legs: [
                if (kioskFeature) FoldedLeg('kiosk', s.liveKiosk, kioskTone),
                if (youtubeFeature) FoldedLeg('youtube', s.liveYoutube, ytTone),
                if (recordingOn)
                  FoldedLeg(
                    'recording',
                    s.liveRecording,
                    live && rec.on ? LightTone.onAir : LightTone.idle,
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

    final idle = !live && !readOnly;
    List<Widget> controls(double gap) => [
      picker,
      SizedBox(height: gap),
      if (idle) ...[
        for (final w in idleSections) ...[w, SizedBox(height: gap)],
      ] else ...[
        ?liveSources,
        if (liveSources != null) SizedBox(height: gap),
        if (switchRow != null) ...[switchRow, SizedBox(height: gap)],
        outputs,
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

Color _toneInkOf(RowTone t) => switch (t) {
  RowTone.ok => LiveColors.healthyInk,
  RowTone.warn => LiveColors.waitingInk,
  RowTone.off => SurauColors.dangerInk,
  RowTone.idle => SurauColors.muted,
};

/// "Skrin surau / YouTube / Rakaman" as chips with a visible on or off state,
/// and the one-line note that makes a screen-only start a visible choice.
class _Destinations extends StatelessWidget {
  const _Destinations({
    required this.kiosk,
    required this.youtube,
    required this.kioskLabel,
    required this.recordingOn,
    required this.recordingLabel,
    required this.note,
    required this.noteIsSkip,
    required this.connectLabel,
    required this.onConnect,
  });

  final bool kiosk;
  final ({bool on, String label, bool enabled, VoidCallback onTap})? youtube;
  final String kioskLabel;
  final bool recordingOn;
  final String recordingLabel;
  final String? note;
  final bool noteIsSkip;
  final String? connectLabel;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final y = youtube;
    return Column(
      key: const ValueKey('live-destinations'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (kiosk) _DestChip(key: const ValueKey('live-dest-kiosk'), label: kioskLabel, on: true),
            if (y != null)
              _DestChip(
                key: const ValueKey('live-dest-youtube'),
                label: y.label,
                on: y.on,
                onTap: y.enabled ? y.onTap : null,
              ),
            _DestChip(key: const ValueKey('live-dest-recording'), label: recordingLabel, on: recordingOn),
          ],
        ),
        if (note != null) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              Icon(
                Icons.info_outline_rounded,
                size: 18,
                color: noteIsSkip ? LiveColors.waitingInk : SurauColors.muted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  note!,
                  key: ValueKey(noteIsSkip ? 'live-dest-skip' : 'live-dest-none'),
                  style: text.bodySmall!.copyWith(color: noteIsSkip ? LiveColors.waitingInk : SurauColors.muted),
                ),
              ),
              if (connectLabel != null)
                TextButton(
                  key: const ValueKey('live-dest-connect'),
                  onPressed: onConnect,
                  child: Text(connectLabel!),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

class _DestChip extends StatelessWidget {
  const _DestChip({super.key, required this.label, required this.on, this.onTap});

  final String label;
  final bool on;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ink = on ? LiveColors.healthyInk : SurauColors.muted;
    return Material(
      color: on ? ink.withValues(alpha: 0.12) : Colors.transparent,
      shape: StadiumBorder(side: BorderSide(color: on ? ink : SurauColors.line)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(12, 6, 14, 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(on ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded, size: 20, color: ink),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(label, style: Theme.of(context).textTheme.labelLarge!.copyWith(color: ink)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
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
  const _SettingsLinks({required this.cameraOn, required this.cameraName, this.account});

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
        content: Text(s.liveSignOutConfirmBody),
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
  final camera = (cameraOn ? liveSettingsCameraOn(lang) : liveSettingsCameraOff(lang)).toLowerCase();
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
    this.cleanupKeepDays,
  });

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

  /// Set when the live leg gave YouTube the whole recording and the clean-up
  /// will delete it from this device after this many days (0: as soon as
  /// YouTube confirms).
  final int? cleanupKeepDays;

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
              if (cleanupKeepDays != null && recorded && !short) ...[
                const SizedBox(height: 12),
                Row(
                  key: const ValueKey('live-cleanup-note'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.auto_delete_rounded,
                      size: 20,
                      color: SurauColors.teal,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        cleanupKeepDays == 0
                            ? s.liveCleanupNow
                            : s.liveCleanupAfterDays(cleanupKeepDays!),
                        style: text.bodyMedium!.copyWith(
                          color: SurauColors.muted,
                        ),
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
