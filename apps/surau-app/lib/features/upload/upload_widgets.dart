// The pieces of the YouTube catch-up screen (Plan 6 Task 11, spec 12b B):
// the providers the screen and the Live tab read the upload queue through,
// the words for each part's state, and the job card. The look follows the
// Live tab: paper cards, a teal tile for the thing, status lights with
// their words, one quiet progress bar per part.
//
// Nothing here ever shows an upload URI, an upload id or a token: a part is
// named by its position (`Bahagian 2 daripada 4`) and its numbers only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../upload/recording_cleanup.dart'
    show CleanupPhase, CleanupRecord;
import '../../upload/upload_providers.dart' show uploadQueueProvider;
import '../../upload/upload_queue.dart';
import '../live/live_screen.dart' show LiveKuliah;
import '../live/live_widgets.dart';
import '../registry.g.dart' as reg;

// ---- providers ----

/// The catch-up queue the screens use: the app's [uploadQueueProvider]
/// (Task 10), null while there is none (no local store or no runner). A
/// seam of its own so screen tests can hand in a queue with a fake runner.
final catchUpQueueProvider = Provider<UploadQueue?>(
  (ref) => ref.watch(uploadQueueProvider),
);

/// Every job, oldest first, as the queue changes.
final catchUpJobsProvider = StreamProvider<List<UploadJob>>((ref) async* {
  final q = ref.watch(catchUpQueueProvider);
  if (q == null) {
    yield const [];
    return;
  }
  await q.load();
  yield await q.jobs();
  yield* q.changes;
});

/// Jobs not yet done (sending or waiting): the badge on the menu entry.
final catchUpActiveCountProvider = Provider<int>((ref) {
  final jobs = ref.watch(catchUpJobsProvider).value ?? const <UploadJob>[];
  return jobs.where((j) => !j.isDone).length;
});

/// The network the runner sees now, looked at again whenever a job changes.
final catchUpNetworkProvider = FutureProvider.autoDispose<UploadNetwork>((
  ref,
) async {
  ref.watch(catchUpJobsProvider);
  final q = ref.watch(catchUpQueueProvider);
  if (q == null) return UploadNetwork.unknown;
  try {
    return await q.runner.network();
  } on Object {
    return UploadNetwork.unknown;
  }
});

/// Today's YouTube uploads from the cloud; null when the cloud cannot be
/// reached (the line is then hidden).
final catchUpQuotaProvider = FutureProvider.autoDispose<UploadQuotaInfo?>((
  ref,
) async {
  final q = ref.watch(catchUpQueueProvider);
  final auth = q?.auth;
  if (auth == null) return null;
  try {
    final a = await auth();
    if (a == null) return null;
    return await a.api.quota();
  } on Object {
    return null;
  }
});

/// Kuliah by id with their penceramah's names, from the local copy (the
/// gateway reads offline-first), for the card titles.
final catchUpKuliahProvider =
    FutureProvider.autoDispose<Map<String, LiveKuliah>>((ref) async {
      ref.watch(dataVersionProvider);
      final gateway = ref.watch(gatewayProvider);
      if (gateway == null) return const {};
      List<Map<String, dynamic>> items(Map<String, dynamic> body) => [
        for (final i in (body['items'] as List? ?? const []))
          if (i is Map) i.cast<String, dynamic>(),
      ];
      try {
        final kuliah = items((await gateway.get('/api/content/kuliah')).value);
        final people = items(
          (await gateway.get('/api/content/penceramah')).value,
        );
        final names = {
          for (final p in people)
            if (p['id'] is String && p['name'] is String)
              p['id'] as String: p['name'] as String,
        };
        return {
          for (final k in kuliah)
            if (k['id'] is String)
              k['id'] as String: LiveKuliah(
                id: k['id'] as String,
                date: (k['date'] as String?) ?? '',
                time: (k['time'] as String?) ?? '00:00',
                label: (k['label'] as String?) ?? 'Kuliah',
                penceramah: names[k['penceramahId']],
              ),
        };
      } on Object {
        return const {};
      }
    });

// ---- settings ----

Map<String, Object?> _catchUpDefaults() =>
    reg.features.firstWhere((f) => f.key == 'youtubeCatchUp').defaults;

Object? _catchUpSetting(Map<String, dynamic>? settings, String key) {
  final v = settings?['youtubeCatchUp'];
  if (v is Map && v.containsKey(key)) return v[key];
  return _catchUpDefaults()[key];
}

/// `youtubeCatchUp.wifiOnly` (default true).
bool catchUpWifiOnly(Map<String, dynamic>? settings) =>
    _catchUpSetting(settings, 'wifiOnly') != false;

/// `youtubeCatchUp.replaceGappyLive`: `ask`, `always` or `never`.
String catchUpReplaceMode(Map<String, dynamic>? settings) {
  final v = _catchUpSetting(settings, 'replaceGappyLive');
  return v is String && const ['ask', 'always', 'never'].contains(v)
      ? v
      : 'ask';
}

/// The video id of a YouTube watch page (`watch?v=<id>` or `youtu.be/<id>`).
String? youtubeVideoId(String? watchUrl) {
  final u = watchUrl == null ? null : Uri.tryParse(watchUrl);
  if (u == null) return null;
  final v = u.queryParameters['v'];
  if (v != null && v.isNotEmpty) return v;
  if (u.host.endsWith('youtu.be') && u.pathSegments.isNotEmpty) {
    return u.pathSegments.first;
  }
  return null;
}

Uri youtubeWatchUri(String videoId) =>
    Uri.https('www.youtube.com', '/watch', {'v': videoId});

// ---- words ----

const List<String> _monthsMs = [
  'Jan',
  'Feb',
  'Mac',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Ogos',
  'Sep',
  'Okt',
  'Nov',
  'Dis',
];

String shortMonth(int month) => _monthsMs[month - 1];

/// `16:00` in the reader's zone ([local] already converted).
String clockWords(DateTime local) =>
    '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';

int percentOf(UploadPart p) {
  if (p.isDone) return 100;
  if (p.bytes <= 0) return 0;
  return (p.offset * 100 ~/ p.bytes).clamp(0, 100);
}

int megabytes(int bytes) => (bytes / (1024 * 1024)).round();

/// A part's light and words while it is not sending ([UploadPartState
/// .uploading] shows its percentage instead).
(LightTone, String) partStatus(
  S s,
  UploadPart p,
  UploadPolicy policy, {
  required String? quotaTime,
}) {
  switch (p.state) {
    case UploadPartState.done:
      return (LightTone.healthy, s.uploadDone);
    case UploadPartState.quota:
      return (LightTone.waiting, s.uploadQuotaShort(quotaTime ?? '--:--'));
    case UploadPartState.paused:
      return (LightTone.idle, s.uploadPaused);
    case UploadPartState.failed:
      return (LightTone.failed, s.uploadFailed);
    case UploadPartState.queued:
    case UploadPartState.joining:
    case UploadPartState.beginning:
    case UploadPartState.uploading:
      if (policy == UploadPolicy.waitWifi) {
        return (LightTone.waiting, s.uploadWaitWifi);
      }
      if (policy == UploadPolicy.waitNetwork) {
        return (LightTone.waiting, s.uploadWaitNetwork);
      }
      return switch (p.state) {
        UploadPartState.joining => (LightTone.waiting, s.uploadJoining),
        UploadPartState.beginning => (LightTone.waiting, s.uploadBeginning),
        UploadPartState.uploading => (LightTone.healthy, s.uploadSending),
        _ => (LightTone.idle, s.uploadQueued),
      };
  }
}

/// The job's reason code in BM, or null when there is nothing to say.
String? jobErrorWords(S s, UploadJob job) => switch (job.lastError) {
  null || 'quota' => null,
  'join_failed' => s.uploadJoinFailed,
  'no_cloud' => s.uploadErrorNoCloud,
  'needs_unlock' => s.uploadErrorUnlock,
  'youtube_reauthorise' => s.uploadErrorReauth,
  _ =>
    job.parts.any((p) => p.state == UploadPartState.failed)
        ? s.uploadErrorOther
        : null,
};

// ---- the job card ----

class UploadJobCard extends StatelessWidget {
  const UploadJobCard({
    super.key,
    required this.job,
    required this.kuliah,
    required this.policy,
    required this.localOf,
    required this.showMobileToggle,
    required this.busy,
    required this.onPause,
    required this.onResume,
    required this.onRetry,
    required this.onAllowMobile,
    required this.onRemove,
    required this.onWatch,
    this.cleanup,
    this.keepDays = 1,
  });

  final UploadJob job;
  final LiveKuliah? kuliah;
  final UploadPolicy policy;
  final DateTime Function(DateTime utc) localOf;
  final bool showMobileToggle;
  final bool busy;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onRetry;
  final ValueChanged<bool> onAllowMobile;
  final VoidCallback onRemove;
  final ValueChanged<String> onWatch;

  /// The clean-up's record of this recording, when it watches it: says when
  /// the files leave this device once YouTube has verified them, and after.
  final CleanupRecord? cleanup;

  /// `recordingCleanup.keepDays`.
  final int keepDays;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final k = kuliah;
    final day = k != null && DateTime.tryParse(k.date) != null
        ? DateTime.parse(k.date)
        : localOf(job.createdAt);
    final dateWords = '${day.day} ${shortMonth(day.month)} ${day.year}';
    final subtitle = [k?.penceramah, dateWords].whereType<String>().join(', ');
    final resets = job.quotaResetsAt;
    final quotaTime = resets == null ? null : clockWords(localOf(resets));
    final error = jobErrorWords(s, job);
    final done = job.isDone;
    final paused = job.isPaused;
    final stuck = job.parts.any(
      (p) =>
          p.state == UploadPartState.failed || p.state == UploadPartState.quota,
    );
    final count = job.parts.length;
    final String? cleanupWords = switch (cleanup?.phase) {
      CleanupPhase.deleted => s.uploadDeleted,
      CleanupPhase.scheduled => () {
        final at = cleanup!.deleteAt(keepDays)!;
        final d = localOf(at.toUtc());
        return s.uploadDeleteOn('${d.day} ${shortMonth(d.month)} ${d.year}');
      }(),
      _ => null,
    };

    final Widget? primary;
    if (done) {
      primary = null;
    } else if (paused) {
      primary = FilledButton.icon(
        onPressed: busy ? null : onResume,
        icon: const Icon(Icons.play_arrow_rounded),
        label: Text(s.uploadResume),
      );
    } else if (stuck && !job.hasActive) {
      primary = FilledButton.icon(
        onPressed: busy ? null : onRetry,
        icon: const Icon(Icons.refresh_rounded),
        label: Text(s.uploadRetry),
      );
    } else {
      primary = OutlinedButton.icon(
        onPressed: busy ? null : onPause,
        icon: const Icon(Icons.pause_rounded),
        label: Text(s.uploadPause),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                _DayTile(day: day, done: done),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        k?.label ?? s.uploadNoKuliah,
                        style: text.titleMedium,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: text.bodyMedium!.copyWith(
                          color: SurauColors.muted,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (job.replaceLiveVideoId != null) ...[
              const SizedBox(height: 14),
              _ReplaceChip(),
            ],
            if (job.hasQuota && quotaTime != null) ...[
              const SizedBox(height: 14),
              _InlineNote(
                icon: Icons.schedule_rounded,
                text: s.uploadQuota(quotaTime),
              ),
            ],
            if (error != null) ...[
              const SizedBox(height: 14),
              _InlineNote(
                icon: job.lastError == 'join_failed'
                    ? Icons.info_outline_rounded
                    : Icons.error_outline_rounded,
                text: error,
                danger: job.lastError != 'join_failed',
              ),
            ],
            const SizedBox(height: 8),
            for (final p in job.parts)
              _PartRow(
                key: ValueKey('upload-part-${job.id}-${p.index}'),
                part: p,
                count: count,
                policy: policy,
                quotaTime: quotaTime,
                onWatch: onWatch,
              ),
            if (cleanupWords != null) ...[
              const SizedBox(height: 10),
              _CleanupNote(
                key: ValueKey('upload-cleanup-${job.id}'),
                text: cleanupWords,
                done: cleanup!.phase == CleanupPhase.deleted,
              ),
            ],
            if (showMobileToggle && !done) ...[
              const Divider(height: 20),
              _MobileToggle(
                value: job.allowMobile,
                megabytes: megabytes(job.totalBytes - job.sentBytes),
                onChanged: busy ? null : onAllowMobile,
              ),
            ],
            const SizedBox(height: 4),
            LayoutBuilder(
              builder: (context, c) {
                final remove = TextButton.icon(
                  style: TextButton.styleFrom(
                    foregroundColor: SurauColors.muted,
                    textStyle: text.labelMedium,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                  onPressed: busy ? null : onRemove,
                  icon: const Icon(Icons.delete_outline_rounded, size: 20),
                  label: Text(s.uploadRemove),
                );
                // A phone card has no room for both side by side: the
                // action goes full width, the removal under it.
                if (c.maxWidth < 420) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (primary != null) ...[
                        const SizedBox(height: 4),
                        primary,
                      ],
                      Align(alignment: Alignment.center, child: remove),
                    ],
                  );
                }
                return Row(children: [remove, const Spacer(), ?primary]);
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// The kuliah's day on a small glass tile, like the Live tab's time badge;
/// a green tick once the job is done.
class _DayTile extends StatelessWidget {
  const _DayTile({required this.day, required this.done});

  final DateTime day;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: 58,
          height: 60,
          decoration: BoxDecoration(
            color: SurauColors.glass,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          ),
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${day.day}',
                style: text.titleLarge!.copyWith(
                  color: SurauColors.gold,
                  fontWeight: FontWeight.w800,
                  height: 1.05,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              Text(
                shortMonth(day.month).toUpperCase(),
                style: text.labelSmall!.copyWith(
                  color: Colors.white.withValues(alpha: 0.82),
                  letterSpacing: 1.2,
                ),
              ),
            ],
          ),
        ),
        if (done)
          Positioned(
            right: -7,
            top: -7,
            child: Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                color: LiveColors.healthy,
                shape: BoxShape.circle,
                border: Border.all(color: SurauColors.card, width: 2),
              ),
              child: const Icon(
                Icons.check_rounded,
                size: 15,
                color: Colors.white,
              ),
            ),
          ),
      ],
    );
  }
}

class _ReplaceChip extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
      decoration: BoxDecoration(
        color: SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.gold),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.swap_horiz_rounded,
            size: 22,
            color: SurauColors.ink,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.uploadReplaceLive,
                  style: text.labelMedium!.copyWith(color: SurauColors.ink),
                ),
                const SizedBox(height: 2),
                Text(
                  s.uploadReplaceNote,
                  style: text.bodySmall!.copyWith(color: SurauColors.ink),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// `Akan dipadam daripada peranti pada {date}` or `Dipadam daripada peranti`:
/// a quiet teal line, not a warning.
class _CleanupNote extends StatelessWidget {
  const _CleanupNote({super.key, required this.text, required this.done});

  final String text;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
      decoration: BoxDecoration(
        color: SurauColors.tealSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            done ? Icons.check_circle_outline_rounded : Icons.auto_delete_rounded,
            size: 20,
            color: SurauColors.teal,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: theme.bodyMedium!.copyWith(color: SurauColors.glass),
            ),
          ),
        ],
      ),
    );
  }
}

class _InlineNote extends StatelessWidget {
  const _InlineNote({
    required this.icon,
    required this.text,
    this.danger = false,
  });

  final IconData icon;
  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final ink = danger ? SurauColors.dangerInk : LiveColors.waitingInk;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
      decoration: BoxDecoration(
        color: danger ? SurauColors.dangerSoft : LiveColors.waitingSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: ink),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: theme.bodyMedium!.copyWith(color: ink)),
          ),
        ],
      ),
    );
  }
}

class _PartRow extends StatelessWidget {
  const _PartRow({
    super.key,
    required this.part,
    required this.count,
    required this.policy,
    required this.quotaTime,
    required this.onWatch,
  });

  final UploadPart part;
  final int count;
  final UploadPolicy policy;
  final String? quotaTime;
  final ValueChanged<String> onWatch;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final p = part;
    final pct = percentOf(p);
    final (tone, words) = partStatus(s, p, policy, quotaTime: quotaTime);
    final sending =
        p.state == UploadPartState.uploading && words == s.uploadSending;
    final whole = count == 1;
    final label = sending
        ? (whole ? s.uploadWhole(pct) : s.uploadPart(p.index, count, pct))
        : (whole ? s.uploadWholeName : s.uploadPartName(p.index, count));
    final barColour = switch (tone) {
      LightTone.healthy => p.isDone ? LiveColors.healthy : SurauColors.teal,
      LightTone.waiting => LiveColors.waiting,
      LightTone.failed => SurauColors.danger,
      _ => SurauColors.outline,
    };
    final sizeWords = p.isDone || p.offset == 0
        ? formatBytes(p.bytes)
        : '${formatBytes(p.offset)} / ${formatBytes(p.bytes)}';
    final video = p.videoId;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Expanded(
                child: Text(
                  label,
                  style: text.titleSmall!.copyWith(
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                sizeWords,
                style: text.bodySmall!.copyWith(
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct / 100,
              minHeight: 8,
              color: barColour,
              backgroundColor: SurauColors.paperDeep,
            ),
          ),
          if (words.isNotEmpty) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                StatusLight(tone, size: 10),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    words,
                    style: text.labelMedium!.copyWith(
                      color: tone == LightTone.idle
                          ? SurauColors.muted
                          : lightInk(tone),
                    ),
                  ),
                ),
                if (p.isDone && video != null)
                  TextButton.icon(
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      textStyle: text.labelMedium,
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                    ),
                    onPressed: () => onWatch(video),
                    icon: const Icon(Icons.open_in_new_rounded, size: 18),
                    label: Text(s.uploadWatch),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _MobileToggle extends StatelessWidget {
  const _MobileToggle({
    required this.value,
    required this.megabytes,
    required this.onChanged,
  });

  final bool value;
  final int megabytes;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Row(
      key: const ValueKey('upload-allow-mobile'),
      children: [
        const Icon(
          Icons.signal_cellular_alt_rounded,
          color: SurauColors.teal,
          size: 22,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.uploadAllowMobile, style: text.titleSmall),
              Text(s.uploadFileSize(megabytes), style: text.bodySmall),
            ],
          ),
        ),
        Switch(value: value, onChanged: onChanged),
      ],
    );
  }
}

/// The quota line on top: how many of today's uploads the channel has used.
class UploadQuotaStrip extends StatelessWidget {
  const UploadQuotaStrip({super.key, required this.quota});

  final UploadQuotaInfo quota;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final limit = quota.uploadLimit <= 0 ? 1 : quota.uploadLimit;
    final used = (quota.uploadsToday / limit).clamp(0.0, 1.0);
    return Container(
      key: const ValueKey('upload-quota'),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(
        color: SurauColors.paperDeep,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.smart_display_rounded,
            color: SurauColors.teal,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              s.uploadQuotaLine(quota.uploadsToday, quota.uploadLimit),
              style: text.labelMedium,
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 72,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: used,
                minHeight: 6,
                color: used >= 0.9 ? LiveColors.waiting : SurauColors.teal,
                backgroundColor: SurauColors.line,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
