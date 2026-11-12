// Kandungan Islamik: what the box keeps for the TV screen to show without
// internet (the Quran text for the ayat card and reader, recitation audio
// surah by surah for tilawah), and the admin's two downloads. A download
// is a job on the box: `POST /api/islamic/fetch` answers 202 with a job
// id, the screen polls `GET /api/islamic/jobs/:id` and draws its progress
// until `Selesai` or the box's reason for failing; a second download while
// one runs is the box's 409, `Sedang memuat turun`. The surah picker lists
// all 114 by number and BM name, the stored ones marked.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../features/data_sources.dart';
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';
import 'widgets/t9_surah_names.dart';

const String islamicStatusPath = '/api/islamic/status';
const String islamicFetchPath = '/api/islamic/fetch';

String islamicJobPath(String id) => '/api/islamic/jobs/$id';

/// `GET /api/islamic/status`, typed.
class IslamicStatus {
  const IslamicStatus({
    required this.quranPresent,
    this.quranVersion,
    this.ayatCount,
    required this.reciter,
    required this.surahs,
    required this.bytes,
    required this.cacheMaxMb,
  });

  factory IslamicStatus.fromJson(Map<String, dynamic> j) {
    final q = j['quran'] is Map
        ? (j['quran'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final a = j['audio'] is Map
        ? (j['audio'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    return IslamicStatus(
      quranPresent: q['present'] == true,
      quranVersion: q['version']?.toString(),
      ayatCount: (q['ayatCount'] as num?)?.toInt(),
      reciter: a['reciter']?.toString() ?? '',
      surahs: [
        for (final n in (a['surahs'] as List? ?? const []))
          if (n is num) n.toInt(),
      ],
      bytes: (a['bytes'] as num?)?.toInt() ?? 0,
      cacheMaxMb: (a['cacheMaxMb'] as num?)?.toInt() ?? 0,
    );
  }

  final bool quranPresent;
  final String? quranVersion;
  final int? ayatCount;
  final String reciter;
  final List<int> surahs;
  final int bytes;
  final int cacheMaxMb;

  int get usedMb => (bytes / (1024 * 1024)).round();

  double? get cacheFraction =>
      cacheMaxMb <= 0 ? null : (bytes / (cacheMaxMb * 1024 * 1024)).clamp(0.0, 1.0);
}

enum _JobState { running, done, failed }

class _Job {
  const _Job({
    required this.id,
    required this.what,
    this.surah,
    this.state = _JobState.running,
    this.progress = 0,
    this.error,
  });

  final String id;
  final String what;
  final int? surah;
  final _JobState state;
  final double progress;
  final String? error;

  _Job copyWith({_JobState? state, double? progress, String? error}) => _Job(
    id: id,
    what: what,
    surah: surah,
    state: state ?? this.state,
    progress: progress ?? this.progress,
    error: error ?? this.error,
  );
}

class IslamicScreen extends ConsumerStatefulWidget {
  const IslamicScreen({super.key, this.pollInterval = const Duration(seconds: 1)});

  /// How often a running job is asked for its progress.
  final Duration pollInterval;

  @override
  ConsumerState<IslamicScreen> createState() => _IslamicScreenState();
}

class _IslamicScreenState extends ConsumerState<IslamicScreen> {
  _Job? _job;
  String? _error;
  int? _surah;
  bool _starting = false;
  int _pollGeneration = 0;

  @override
  void dispose() {
    _pollGeneration++;
    super.dispose();
  }

  Future<void> _start(Map<String, Object> body, {int? surah}) async {
    final s = S.of(context);
    final t = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null || _starting) return;
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final out = await gateway.post(islamicFetchPath, body);
      final id = out['jobId']?.toString() ?? '';
      if (!mounted) return;
      setState(() {
        _starting = false;
        _job = _Job(id: id, what: body['what'] as String, surah: surah);
      });
      unawaited(_poll(id, ++_pollGeneration));
    } on BoxError catch (e) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = e.status == 409 ? t.islamicBusy : writeErrorText(s, e);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = writeErrorText(s, e);
      });
    }
  }

  /// Asks the box about [id] every [IslamicScreen.pollInterval] until it
  /// is done or failed, then re-reads the status. Straight on the client,
  /// not the gateway: a job's progress is never worth caching.
  Future<void> _poll(String id, int generation) async {
    final s = S.of(context);
    while (mounted && generation == _pollGeneration) {
      final client = ref.read(enrolledClientProvider).value;
      final session = ref.read(sessionProvider);
      if (client == null || session == null) return;
      try {
        final j = await client.getJson(islamicJobPath(id), token: session.token);
        if (!mounted || generation != _pollGeneration) return;
        final state = switch (j['state']) {
          'done' => _JobState.done,
          'failed' => _JobState.failed,
          _ => _JobState.running,
        };
        final progress = ((j['progress'] as num?)?.toDouble() ?? 0).clamp(0.0, 1.0);
        setState(() {
          _job = _job?.copyWith(state: state, progress: progress, error: j['error']?.toString());
        });
        if (state != _JobState.running) {
          await ref.read(boxJsonProvider(islamicStatusPath).notifier).refresh();
          return;
        }
      } on SessionExpired {
        ref.read(sessionProvider.notifier).clear();
        return;
      } catch (e) {
        if (!mounted || generation != _pollGeneration) return;
        setState(() {
          _job = _job?.copyWith(state: _JobState.failed, error: writeErrorText(s, e));
        });
        return;
      }
      await Future<void>.delayed(widget.pollInterval);
    }
  }

  Future<void> _pickSurah(IslamicStatus status) async {
    final chosen = await showModalBottomSheet<int>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxWidth: 520,
        maxHeight: MediaQuery.sizeOf(context).height * 0.9,
      ),
      builder: (context) => _SurahSheet(stored: status.surahs.toSet()),
    );
    if (chosen != null && mounted) setState(() => _surah = chosen);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    final canFetch = can(ref.watch(rolesProvider), 'islamic:fetch');
    final busy = _starting || _job?.state == _JobState.running;
    // The sources named on the buttons (Settings > Sumber data internet).
    final settings = ref.watch(settingsProvider).value?.value;
    final quranSource = dataSourceName(settings, 'quranText');
    final audioSource = dataSourceName(settings, 'quranAudio');

    return ShellPage(
      title: s.navIslamic,
      body: SurauTheme.page(
        children: [
          Text(t.islamicIntro, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 16),
          if (_job != null) ...[
            _JobCard(job: _job!, onDismiss: () => setState(() => _job = null)),
            const SizedBox(height: 16),
          ],
          if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 16)],
          BoxReadView(
            path: islamicStatusPath,
            builder: (context, body) {
              final status = IslamicStatus.fromJson(body);
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SectionLabel(t.islamicQuranTitle),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _StatusRow(
                            icon: Icons.menu_book_rounded,
                            present: status.quranPresent,
                            title: status.quranPresent
                                ? t.islamicQuranPresent
                                : t.islamicQuranAbsent,
                            detail: status.quranPresent
                                ? t.islamicQuranDetail(status.ayatCount ?? 0, status.quranVersion ?? '')
                                : t.islamicQuranHint,
                          ),
                          if (canFetch) ...[
                            const SizedBox(height: 16),
                            if (status.quranPresent)
                              OutlinedButton.icon(
                                onPressed: busy ? null : () => _start(const {'what': 'quran'}),
                                icon: const Icon(Icons.download_rounded),
                                label: Text(t.refetchFromSource(quranSource), textAlign: TextAlign.center),
                              )
                            else
                              FilledButton.icon(
                                onPressed: busy ? null : () => _start(const {'what': 'quran'}),
                                icon: const Icon(Icons.download_rounded),
                                label: Text(t.fetchFromSource(quranSource), textAlign: TextAlign.center),
                              ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  SectionLabel(t.islamicAudioTitle),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _StatusRow(
                            icon: Icons.graphic_eq_rounded,
                            present: status.surahs.isNotEmpty,
                            title: status.surahs.isEmpty
                                ? t.islamicNoSurahs
                                : t.islamicSurahsStored(status.surahs.length),
                            detail: t.islamicReciter(status.reciter),
                          ),
                          const SizedBox(height: 14),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: LinearProgressIndicator(
                              value: status.cacheFraction ?? 0,
                              minHeight: 8,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            t.islamicCacheUsage(status.usedMb, status.cacheMaxMb),
                            style: text.bodySmall!.copyWith(
                              fontFeatures: const [FontFeature.tabularFigures()],
                            ),
                          ),
                          if (canFetch) ...[
                            const SizedBox(height: 16),
                            _SurahField(
                              label: _surah == null ? t.islamicSurahPick : surahLabel(_surah!),
                              chosen: _surah != null,
                              onTap: busy ? null : () => _pickSurah(status),
                            ),
                            const SizedBox(height: 12),
                            FilledButton.icon(
                              onPressed: busy || _surah == null
                                  ? null
                                  : () => _start({'what': 'audio', 'surah': _surah!}, surah: _surah),
                              icon: const Icon(Icons.download_rounded),
                              label: Text(t.fetchFromSource(audioSource), textAlign: TextAlign.center),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                  if (!canFetch) ...[
                    const SizedBox(height: 16),
                    Text(
                      t.islamicReadOnly,
                      textAlign: TextAlign.center,
                      style: text.bodySmall,
                    ),
                  ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

/// Icon in a soft disc (teal when the thing is there, paper when not),
/// a one-line state and a detail under it.
class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.icon,
    required this.present,
    required this.title,
    required this.detail,
  });

  final IconData icon;
  final bool present;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: present ? SurauColors.tealSoft : SurauColors.paperDeep,
            shape: BoxShape.circle,
          ),
          child: Icon(icon, size: 26, color: present ? SurauColors.teal : SurauColors.muted),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: text.titleSmall),
              const SizedBox(height: 2),
              Text(detail, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            ],
          ),
        ),
      ],
    );
  }
}

/// Looks like an input, opens the picker: "Pilih surah" or "36. Yasin".
class _SurahField extends StatelessWidget {
  const _SurahField({required this.label, required this.chosen, required this.onTap});

  final String label;
  final bool chosen;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Material(
      color: SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        side: const BorderSide(color: SurauColors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 12, 14),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: text.bodyLarge!.copyWith(
                    color: chosen ? SurauColors.text : SurauColors.muted,
                    fontWeight: chosen ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
              const Icon(Icons.expand_more_rounded, color: SurauColors.outline),
            ],
          ),
        ),
      ),
    );
  }
}

/// The running, done or failed download, in one card at the top.
class _JobCard extends StatelessWidget {
  const _JobCard({required this.job, required this.onDismiss});

  final _Job job;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    final what = job.what == 'quran'
        ? t.islamicJobQuran
        : t.islamicJobSurah(job.surah == null ? '' : surahLabel(job.surah!));
    switch (job.state) {
      case _JobState.done:
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: DoneLine(
                t.islamicJobDone,
                detail: job.what == 'quran'
                    ? t.islamicJobDoneQuran
                    : t.islamicJobDoneSurah(job.surah == null ? '' : surahLabel(job.surah!)),
              ),
            ),
            IconButton(
              tooltip: S.of(context).actionClose,
              onPressed: onDismiss,
              icon: const Icon(Icons.close_rounded, color: SurauColors.muted),
            ),
          ],
        );
      case _JobState.failed:
        final reason = job.error;
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: ErrorLine(
                reason == null || reason.isEmpty
                    ? t.islamicJobFailed
                    : '${t.islamicJobFailed}: $reason',
              ),
            ),
            IconButton(
              tooltip: S.of(context).actionClose,
              onPressed: onDismiss,
              icon: const Icon(Icons.close_rounded, color: SurauColors.muted),
            ),
          ],
        );
      case _JobState.running:
        final pct = (job.progress * 100).round();
        return Card(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(what, style: text.titleSmall)),
                    const SizedBox(width: 12),
                    Text(
                      '$pct%',
                      style: text.titleSmall!.copyWith(
                        color: SurauColors.teal,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(value: job.progress, minHeight: 8),
                ),
              ],
            ),
          ),
        );
    }
  }
}

/// All 114 surah by number and BM name, a search box on top, the stored
/// ones marked; pops the chosen number.
class _SurahSheet extends StatefulWidget {
  const _SurahSheet({required this.stored});

  final Set<int> stored;

  @override
  State<_SurahSheet> createState() => _SurahSheetState();
}

class _SurahSheetState extends State<_SurahSheet> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    final q = _query.trim().toLowerCase();
    final shown = [
      for (var n = 1; n <= 114; n++)
        if (q.isEmpty ||
            '$n' == q ||
            surahNamesMs[n - 1].toLowerCase().replaceAll("'", '').contains(q.replaceAll("'", '')))
          n,
    ];
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.islamicSurahPick, style: text.titleLarge),
              const SizedBox(height: 12),
              TextField(
                autofocus: false,
                decoration: InputDecoration(
                  hintText: t.islamicSurahSearch,
                  prefixIcon: const Icon(Icons.search_rounded),
                  isDense: true,
                ),
                onChanged: (v) => setState(() => _query = v),
              ),
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: ListView.separated(
            itemCount: shown.length,
            separatorBuilder: (_, _) => const Divider(),
            itemBuilder: (context, i) {
              final n = shown[i];
              return ListTile(
                title: Text(surahLabel(n)),
                trailing: widget.stored.contains(n)
                    ? StateChip(
                        label: t.islamicSurahStored,
                        background: SurauColors.tealSoft,
                        foreground: SurauColors.teal,
                      )
                    : null,
                onTap: () => Navigator.of(context).pop(n),
              );
            },
          ),
        ),
      ],
    );
  }
}
