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

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../common/time_words.dart';
import '../registry.g.dart' as reg;
import '../shell/permissions.dart';
import '../../upload/upload_queue.dart' show NoRecordings;
import '../upload/cleanup_providers.dart';
import '../upload/upload_widgets.dart';
import 'live_controller.dart';
import 'live_fold.dart';
import 'live_widgets.dart';
import 'publisher.dart';

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
  });

  final String id;

  /// `2026-11-04`, Malaysian date.
  final String date;

  /// `21:00`.
  final String time;
  final String label;
  final String? penceramah;
  final String? topic;

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

String _ymd(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';

/// Today's and upcoming `aktif` kuliah with their penceramah's names, and
/// the one to pre-select: the slot nearest to now.
LiveKuliahChoice pickKuliah(
  List<Map<String, dynamic>> kuliah,
  List<Map<String, dynamic>> penceramah,
  DateTime localNow,
) {
  final names = {
    for (final p in penceramah)
      if (p['id'] is String && p['name'] is String)
        p['id'] as String: p['name'] as String,
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
  return pickKuliah(kuliah, penceramah, deps.toLocal(deps.now()));
});

// ---- the screen ----

class LiveScreen extends ConsumerStatefulWidget {
  const LiveScreen({super.key});

  @override
  ConsumerState<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends ConsumerState<LiveScreen> {
  late final LivePublisher _publisher;
  StreamSubscription<PublisherState>? _sub;
  late PublisherState _state;
  late final LiveBoxNotifier _controller;
  bool _starting = false;

  bool _kuliahChosen = false;
  String? _kuliahId;
  bool _youtubeWanted = true;

  @override
  void initState() {
    super.initState();
    _publisher = ref.read(livePublisherProvider);
    _controller = ref.read(liveBoxProvider.notifier);
    _state = _publisher.current;
    _sub = _publisher.states.listen((s) {
      if (mounted) setState(() => _state = s);
    });
    if (_state.phase == PublisherPhase.idle ||
        _state.phase == PublisherPhase.stopped) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _prepare());
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.attach();
    });
  }

  @override
  void dispose() {
    _controller.detach();
    _sub?.cancel();
    super.dispose();
  }

  bool get _recordingOn {
    final settings = ref.read(settingsProvider).value?.value;
    final v = settings?['recording'];
    if (v is Map && v['enabled'] is bool) return v['enabled'] as bool;
    return reg.features.firstWhere((f) => f.key == 'recording').defaultEnabled;
  }

  Future<void> _prepare() => _publisher.prepare(
    PublisherConfig(recording: _recordingOn, frontCamera: _state.frontCamera),
  );

  /// Why YouTube cannot be used now, or null when it can.
  String? _youtubeBlock(S s, LiveBoxStatus box, bool admin) {
    if (!box.internet) return s.liveWarnNoInternet;
    if (!box.youtube.signedIn) {
      return admin ? s.liveYoutubeNeedsSignIn : s.liveYoutubeAskAdmin;
    }
    return null;
  }

  Future<void> _start(bool youtube) async {
    if (_starting) return;
    setState(() => _starting = true);
    try {
      await ref
          .read(liveBoxProvider.notifier)
          .startLive(kuliahId: _kuliahId, youtube: youtube);
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
    final kuliahId = _kuliahId;
    await ref.read(liveBoxProvider.notifier).stopLive();
    if (!mounted) return;
    final web = ref.read(appDepsProvider).platform != 'android';
    final youtubeSeconds = youtubeUsed
        ? ref.read(liveBoxProvider).youtubeSeconds
        : null;
    final watchUrl = youtubeUsed ? ref.read(liveBoxProvider).watchUrl : null;
    // Android: the names the engine wrote bind the recording to this live.
    if (recorded && !web) await _rememberRecordings(boxSession);
    final cleanupKeepDays = await _registerCleanup(
      recorded: recorded,
      web: web,
      boxSession: boxSession,
      kuliahId: kuliahId,
      durationSec: duration,
      youtubeSeconds: youtubeSeconds,
      liveVideoId: youtubeVideoId(watchUrl),
    );
    if (!mounted) return;
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
      builder: (_) => LiveSummarySheet(
        durationSec: duration,
        youtubeSeconds: youtubeSeconds,
        recorded: recorded,
        web: web,
        kuliah: ref.read(liveKuliahProvider).value?.byId(kuliahId),
        watchUrl: watchUrl,
        cleanupKeepDays: cleanupKeepDays,
        onWatch: (url) => ref.read(appDepsProvider).openUrl(Uri.parse(url)),
        onSave: () => ref.read(liveBoxProvider.notifier).savePending(),
        onCatchUp: catchUp
            ? (sheetContext) => _catchUp(
                sheetContext,
                boxSession: boxSession,
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
    required String? kuliahId,
    required int durationSec,
    required int? youtubeSeconds,
    required String? liveVideoId,
  }) async {
    final cleanup = ref.read(recordingCleanupProvider);
    if (!recorded || cleanup == null) return null;
    try {
      var session = boxSession;
      if (web) session = await _latestRecordingSession() ?? boxSession;
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
    // The browser files its recording under its own session id: the newest
    // unsaved file names it. Android files go by the box session.
    var session = boxSession;
    if (web) session = await _latestRecordingSession() ?? boxSession;
    if (session == null) return false;
    try {
      await queue.enqueueFromSession(session, kuliahId, replaceLive: replace);
    } on NoRecordings {
      return false;
    }
    unawaited(queue.kick());
    return true;
  }

  Future<String?> _latestRecordingSession() async {
    final store = ref.read(recordingsStoreProvider);
    if (store == null) return null;
    final files = await store.pending();
    if (files.isEmpty) return null;
    files.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return files.last.sessionId;
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

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final flags = ref.watch(featureFlagsProvider);
    final box = ref.watch(liveBoxProvider);
    final roles = ref.watch(rolesProvider);
    final admin = can(roles, 'users:manage');
    final choiceAsync = ref.watch(liveKuliahProvider);
    final choice = choiceAsync.value;
    if (choice != null && !_kuliahChosen) {
      _kuliahChosen = true;
      _kuliahId = choice.preselected;
    }

    final live = _state.isLive;
    final busy =
        box.stopping ||
        _state.phase == PublisherPhase.starting ||
        _state.phase == PublisherPhase.stopping;
    final youtubeFeature = flags.isOn('liveYoutube');
    final kioskFeature = flags.isOn('liveOnKiosk');
    final block = youtubeFeature ? _youtubeBlock(s, box, admin) : s.liveNotUsed;
    final youtubeOn = youtubeFeature && block == null && _youtubeWanted;
    final canStart =
        !_starting &&
        !box.stopping &&
        _state.phase == PublisherPhase.ready &&
        box.boxReachable &&
        box.busyDevice == null &&
        choice != null;

    final catchUpOn =
        flags.isOn('youtubeCatchUp') && ref.watch(catchUpQueueProvider) != null;
    final saveButton = FilledButton.icon(
      onPressed: () => ref.read(liveBoxProvider.notifier).savePending(),
      icon: const Icon(Icons.download_rounded),
      label: Text(s.liveSaveRecording),
    );

    final notices = <Widget>[
      if (!box.boxReachable && !box.stopping)
        LiveNotice(
          icon: Icons.cloud_off_rounded,
          title: s.liveBoxUnreachable,
          danger: true,
        ),
      if (box.busyDevice != null)
        LiveNotice(
          icon: Icons.sensors_rounded,
          title: s.liveBusy(box.busyDevice!),
          danger: true,
        ),
      if (box.notice != null)
        LiveNotice(icon: Icons.info_outline_rounded, title: box.notice!),
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
          title: s.liveCloudUnreachable,
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

    final monitor = <Widget>[
      LivePreviewFrame(
        picture: _publisher.preview(context),
        state: _state,
        onFlip: _state.phase == PublisherPhase.idle
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

    final outputs = LiveCard(
      children: [
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
            // The leg is chosen before the start; while live the light says it all.
            trailing: live || busy
                ? null
                : Switch(
                    value: youtubeOn,
                    onChanged: block != null
                        ? null
                        : (v) => setState(() => _youtubeWanted = v),
                  ),
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
      ],
    );

    final picker = _KuliahTile(
      choice: choice,
      kuliah: choice?.byId(_kuliahId),
      enabled: !live && !busy && choice != null,
      onTap: choice == null ? null : () => _pickKuliah(choice),
    );

    final signIn = admin && youtubeFeature && !live
        ? YoutubeAccountCard(box: box)
        : null;

    // A sign-in under way is the task at hand: its code goes to the top.
    final signInFirst =
        signIn != null && box.youtube.phase == YoutubeAccountPhase.signingIn;

    final button = LiveActionButton(
      // our own stop keeps the quiet "Menghentikan siaran" until the box is done
      phase: box.stopping ? PublisherPhase.stopping : _state.phase,
      onStart: canStart ? () => _start(youtubeOn) : null,
      onStop: _confirmStop,
    );

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
              onFlip: _state.phase == PublisherPhase.idle
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
                    padding: const EdgeInsets.fromLTRB(28, 20, 24, 32),
                    children: [
                      ...notices.expand((n) => [n, const SizedBox(height: 16)]),
                      ...monitor,
                    ],
                  ),
                ),
                Container(
                  width: 380,
                  decoration: const BoxDecoration(
                    color: SurauColors.paperDeep,
                    border: Border(left: BorderSide(color: SurauColors.line)),
                  ),
                  child: Column(
                    children: [
                      Expanded(
                        child: ListView(
                          padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
                          children: [
                            if (signInFirst) ...[
                              signIn,
                              const SizedBox(height: 16),
                            ],
                            picker,
                            const SizedBox(height: 16),
                            outputs,
                            if (signIn != null && !signInFirst) ...[
                              const SizedBox(height: 16),
                              signIn,
                            ],
                          ],
                        ),
                      ),
                      _ActionBar(child: button),
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
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                    children: [
                      ...notices.expand((n) => [n, const SizedBox(height: 12)]),
                      if (signInFirst) ...[signIn, const SizedBox(height: 14)],
                      picker,
                      const SizedBox(height: 14),
                      ...monitor,
                      const SizedBox(height: 18),
                      outputs,
                      if (signIn != null && !signInFirst) ...[
                        const SizedBox(height: 16),
                        signIn,
                      ],
                    ],
                  ),
                ),
              ),
              _ActionBar(child: ContentColumn(child: button)),
            ],
          );
        },
      ),
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
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
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
          padding: const EdgeInsets.fromLTRB(16, 14, 8, 14),
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
                  whenWords(k.at, today: today),
                  k.penceramah,
                ].whereType<String>().join(', '),
        ),
        onTap: () => Navigator.pop(context, _Picked(k?.id)),
      );
    }

    Widget head(String t) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
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
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
              child: Text(s.liveKuliahPick, style: text.titleLarge),
            ),
            head(s.liveKuliahToday),
            if (choice.today.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
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
    switch (yt.phase) {
      case YoutubeAccountPhase.signedIn:
        body = [
          Text(
            s.liveSignedInAs(yt.channel ?? s.liveYoutube),
            style: text.bodyMedium,
          ),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: notifier.signOut,
              child: Text(s.liveSignOut),
            ),
          ),
        ];
      case YoutubeAccountPhase.signedOut:
        body = [
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
        final url = yt.verificationUrl ?? 'https://www.google.com/device';
        body = [
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
            label: Text(s.liveSignInOpen),
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
              Expanded(child: Text(s.liveSignInWaiting, style: text.bodySmall)),
            ],
          ),
        ];
    }

    return Card(
      key: const ValueKey('live-youtube-account'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
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
                if (yt.signedIn) const StatusLight(LightTone.healthy),
              ],
            ),
            const SizedBox(height: 10),
            ...body,
          ],
        ),
      ),
    );
  }
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
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
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
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(s.actionClose),
            ),
          ],
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
          padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
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
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
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
