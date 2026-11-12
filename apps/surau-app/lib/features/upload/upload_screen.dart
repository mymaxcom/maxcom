// Muat naik YouTube (Plan 6 Task 11, spec 12b B): the kuliah recordings
// this device is sending to the surau's channel because the live did not
// reach YouTube in full. The quota line on top, one card per job with a
// bar per part, and the controls: pause, resume, try again, mobile data,
// remove from the list (removing a card never deletes the recording; only the
// verified clean-up does, and the card says when).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../upload/upload_queue.dart';
import '../live/live_widgets.dart' show LiveColors;
import 'cleanup_providers.dart';
import 'upload_widgets.dart';

export 'upload_widgets.dart';

class UploadScreen extends ConsumerStatefulWidget {
  const UploadScreen({super.key});

  @override
  ConsumerState<UploadScreen> createState() => _UploadScreenState();
}

class _UploadScreenState extends ConsumerState<UploadScreen> {
  final Set<String> _busy = {};

  @override
  void initState() {
    super.initState();
    // Opening the screen is a good moment to look at the queue again.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final q = ref.read(catchUpQueueProvider);
      if (q == null) return;
      try {
        await q.load();
        await q.kick();
      } on Object {
        // the cards show whatever the queue holds
      }
    });
  }

  Future<void> _act(
    String jobId,
    Future<void> Function(UploadQueue q) run,
  ) async {
    final q = ref.read(catchUpQueueProvider);
    if (q == null || _busy.contains(jobId)) return;
    setState(() => _busy.add(jobId));
    try {
      await run(q);
      await q.kick();
    } finally {
      if (mounted) setState(() => _busy.remove(jobId));
    }
  }

  Future<void> _confirmRemove(UploadJob job) async {
    final s = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      useRootNavigator: true,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.delete_outline_rounded),
        title: Text(s.uploadRemove),
        content: Text(s.uploadRemoveConfirm),
        actions: [
          TextButton(
            onPressed: () =>
                Navigator.of(dialogContext, rootNavigator: true).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: SurauColors.danger,
              foregroundColor: Colors.white,
            ),
            onPressed: () =>
                Navigator.of(dialogContext, rootNavigator: true).pop(true),
            child: Text(s.uploadRemoveAction),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _act(job.id, (q) => q.remove(job.id));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final queue = ref.watch(catchUpQueueProvider);
    final jobs = ref.watch(catchUpJobsProvider).value;
    final network =
        ref.watch(catchUpNetworkProvider).value ?? UploadNetwork.unknown;
    final quota = ref.watch(catchUpQuotaProvider).value;
    final kuliah = ref.watch(catchUpKuliahProvider).value ?? const {};
    final settings = ref.watch(settingsProvider).value?.value;
    final cleanups = ref.watch(cleanupRecordsProvider).value ?? const {};
    final keepDays = ref.watch(cleanupSettingsProvider).keepDays;
    final android = deps.platform == 'android';
    // The browser cannot tell Wi-Fi from mobile data: the toggle means
    // something only where the policy can wait for Wi-Fi.
    final mobileToggle = android && catchUpWifiOnly(settings);
    DateTime localOf(DateTime t) => deps.toLocal(t.toUtc());

    final List<Widget> children;
    if (jobs == null) {
      children = const [
        Padding(
          padding: EdgeInsets.symmetric(vertical: 24),
          child: LinearProgressIndicator(minHeight: 2),
        ),
      ];
    } else {
      children = [
        if (quota != null) ...[
          UploadQuotaStrip(quota: quota),
          const SizedBox(height: 16),
        ],
        if (jobs.isEmpty)
          ..._empty(s, text)
        else ...[
          Text(
            s.uploadIntro,
            style: text.bodyLarge!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 16),
          // Newest first: the kuliah just ended is the one being looked for.
          for (final job in jobs.reversed) ...[
            UploadJobCard(
              key: ValueKey('upload-job-${job.id}'),
              job: job,
              kuliah: job.kuliahId == null ? null : kuliah[job.kuliahId],
              policy: queue?.policy(job, network) ?? UploadPolicy.run,
              localOf: localOf,
              showMobileToggle: mobileToggle,
              busy: _busy.contains(job.id),
              onPause: () => _act(job.id, (q) => q.pause(job.id)),
              onResume: () => _act(job.id, (q) => q.resume(job.id)),
              onRetry: () => _act(job.id, (q) => q.retry(job.id)),
              onAllowMobile: (v) =>
                  _act(job.id, (q) => q.allowMobileData(job.id, v)),
              onRemove: () => _confirmRemove(job),
              onWatch: (id) => deps.openUrl(youtubeWatchUri(id)),
              cleanup: cleanups[job.sessionId],
              keepDays: keepDays,
            ),
            const SizedBox(height: 14),
          ],
          _Footer(
            icon: android ? Icons.sync_rounded : Icons.tab_rounded,
            text: android ? s.uploadBackgroundAndroid : s.uploadKeepOpenWeb,
          ),
        ],
      ];
    }

    return ShellPage(
      title: s.uploadTitle,
      body: SurauTheme.page(children: children),
    );
  }

  List<Widget> _empty(S s, TextTheme text) => [
    const SizedBox(height: 40),
    Center(
      child: Container(
        width: 76,
        height: 76,
        alignment: Alignment.center,
        decoration: const BoxDecoration(
          color: SurauColors.tealSoft,
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.cloud_done_rounded,
          size: 40,
          color: SurauColors.teal,
        ),
      ),
    ),
    const SizedBox(height: 18),
    Text(s.uploadEmpty, textAlign: TextAlign.center, style: text.titleLarge),
    const SizedBox(height: 6),
    Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Text(
        s.uploadEmptyHint,
        textAlign: TextAlign.center,
        style: text.bodyLarge!.copyWith(color: SurauColors.muted),
      ),
    ),
  ];
}

class _Footer extends StatelessWidget {
  const _Footer({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
      child: Row(
        children: [
          Icon(icon, size: 20, color: LiveColors.healthyInk),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: theme.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        ],
      ),
    );
  }
}
