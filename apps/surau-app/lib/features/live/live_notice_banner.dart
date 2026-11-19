// The dashboard's "Siaran sedang berlangsung. Kongsi pautan" banner: shown to
// every holder of `live:control` while the box has a live notice (a YouTube
// live runs), whichever device started it. Read when the app opens or
// resumes; there is no push in this release.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/generated/s.dart';
import 'live_notice_box.dart';
import 'live_notice_sheet.dart';
import 'live_widgets.dart' show LiveNotice;

class LiveNoticeBanner extends ConsumerWidget {
  const LiveNoticeBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notice = ref.watch(liveBoxNoticeProvider).value;
    if (notice == null) return const SizedBox.shrink();
    final s = S.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: LiveNotice(
        key: const ValueKey('dash-live-notice-banner'),
        icon: Icons.campaign_rounded,
        title: s.liveNoticeStarted,
        action: FilledButton.icon(
          key: const ValueKey('dash-live-notice-share'),
          onPressed: () => showLiveNoticeSheet(context, ref),
          icon: const Icon(Icons.share_rounded),
          label: Text(s.liveNoticeShare),
        ),
      ),
    );
  }
}
