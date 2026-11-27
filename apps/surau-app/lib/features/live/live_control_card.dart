// The control card of a live the BOX pulls (2026.11.15 build 4, mockups U1 and U2).
//
// While the MAXCOM Kiosk Box pulls the camera this device only controls: no picture, no preview, no still. The card
// takes the place of the picture and merges the old three-row status card (screen, YouTube, recording) into one:
// the running time, the TVs, YouTube, the camera, one level bar per sound source and, on the iPad, the recording of
// the received stream. Berhenti stays in the action bar of the screen.
//
// A pure widget: the screen works out every value from the box's status and hands it over, so an older box (no
// camera rate, no TV list) simply shows fewer lines.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../box/wire.dart' show LiveViewerDto;
import '../../l10n/generated/s.dart';
import '../common/bidi.dart' show bidiIsolate;
import 'live_source_widgets.dart' show LevelMeter;
import 'live_widgets.dart';

/// How the camera of a box-pulled live stands.
enum ControlCamera { ok, slow, gone }

/// What YouTube is doing for this live.
enum ControlYoutube { onAir, waiting, off }

/// One sound source of the card: its name, what it does now and its level bar.
class ControlSource {
  const ControlSource({
    required this.id,
    required this.name,
    required this.sub,
    required this.level,
    this.dim = false,
    this.bad = false,
  });

  final String id;
  final String name;
  final String sub;

  /// 0.0 to 1.0.
  final double level;

  /// Not on air (volume 0, benched or waiting): drawn quiet.
  final bool dim;

  /// The sub line is a fault (the box microphone has no sound): drawn in the danger ink.
  final bool bad;
}

/// The recording of the received stream on the iPad ("Merakam" row).
class ControlRecording {
  const ControlRecording({required this.bytes, required this.segments, required this.running});

  final int bytes;
  final int segments;
  final bool running;
}

class LiveControlCard extends StatelessWidget {
  const LiveControlCard({
    super.key,
    required this.seconds,
    required this.camera,
    required this.cameraName,
    required this.cameraKbps,
    required this.youtube,
    required this.youtubeLabel,
    required this.viewers,
    required this.kioskOn,
    required this.sources,
    this.startedBy,
    this.recording,
    this.onWatchYoutube,
  });

  /// The running time by the box's clock.
  final int seconds;
  final ControlCamera camera;
  final String cameraName;

  /// The camera's 30 s average in kbps; null when the box does not say (an older box).
  final double? cameraKbps;
  final ControlYoutube youtube;

  /// The channel name under the YouTube row.
  final String youtubeLabel;
  final List<LiveViewerDto> viewers;

  /// The TV screen is sent to (Skrin on); false when the person switched it off for this live.
  final bool kioskOn;
  final List<ControlSource> sources;

  /// "Dimulakan oleh X dari Y, 19:31": only on a device that did not start the live.
  final String? startedBy;
  final ControlRecording? recording;

  /// Opens the watch page; null while YouTube has none.
  final VoidCallback? onWatchYoutube;

  static String _mbps(double kbps) => (kbps / 1000).toStringAsFixed(1);

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final showing = viewers.where((v) => v.state == 'playing').toList();
    final playing = showing.length;
    final shown = viewers.isEmpty ? 0 : playing;
    // Build 5: with one to three TVs showing, the title names them; a TV on its normal display is told, not hidden.
    final tvTitle = playing >= 1 && playing <= 3
        ? s.liveCtlTvsShowing(playing, showing.map((v) => bidiIsolate(v.name)).join(', '))
        : s.liveCtlTvsTitle;
    final normalTvs = viewers.where((v) => v.state == 'off').toList();
    final tvSub = !kioskOn
        ? s.liveCtlTvsOff
        : camera == ControlCamera.gone
        ? s.liveCtlTvsWaiting
        : s.liveCtlTvsSub;
    final camText = switch (camera) {
      ControlCamera.gone => s.liveCtlCamGone,
      ControlCamera.slow => cameraKbps == null ? s.liveCtlCamConnected : s.liveCtlCamSlow(_mbps(cameraKbps!)),
      ControlCamera.ok => cameraKbps == null ? s.liveCtlCamConnected : s.liveCtlCamOk(_mbps(cameraKbps!)),
    };
    final camInk = switch (camera) {
      ControlCamera.gone => SurauColors.dangerInk,
      ControlCamera.slow => LiveColors.waitingInk,
      ControlCamera.ok => LiveColors.healthyInk,
    };
    final rows = <Widget>[
      _Row(
        key: const ValueKey('live-control-tvs'),
        icon: Icons.tv_rounded,
        title: tvTitle,
        sub: tvSub,
        extra: [
          for (final v in normalTvs)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Container(
                key: ValueKey('live-control-tv-normal-${v.tvId}'),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: SurauColors.paperDeep,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                ),
                child: Text(
                  s.liveCtlTvNormal(bidiIsolate(v.name)),
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
              ),
            ),
        ],
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '${viewers.isEmpty ? '' : shown}',
              key: const ValueKey('live-control-tv-count'),
              style: text.titleMedium,
            ),
            if (viewers.isNotEmpty) const Icon(Icons.chevron_right_rounded, color: SurauColors.muted),
          ],
        ),
        onTap: viewers.isEmpty ? null : () => showLiveViewersSheet(context, viewers),
      ),
      _Row(
        key: const ValueKey('live-control-youtube'),
        icon: Icons.smart_display_rounded,
        title: s.liveYoutube,
        sub: youtubeLabel,
        trailing: _Pill(
          key: const ValueKey('live-control-youtube-pill'),
          text: switch (youtube) {
            ControlYoutube.onAir => s.liveOn,
            ControlYoutube.waiting => s.liveCtlYtWaiting,
            ControlYoutube.off => s.liveCtlYtNo,
          },
          ink: switch (youtube) {
            ControlYoutube.onAir => LiveColors.healthyInk,
            ControlYoutube.waiting => LiveColors.waitingInk,
            ControlYoutube.off => SurauColors.muted,
          },
        ),
      ),
      _Row(
        key: const ValueKey('live-control-camera'),
        icon: camera == ControlCamera.gone ? Icons.videocam_off_rounded : Icons.videocam_rounded,
        title: cameraName,
        sub: camText,
        subInk: camInk,
      ),
      if (sources.isNotEmpty)
        Padding(
          key: const ValueKey('live-control-levels'),
          padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 16, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.liveCtlLevels, style: text.labelLarge!.copyWith(color: SurauColors.muted)),
              const SizedBox(height: 4),
              for (final src in sources)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    key: ValueKey('live-control-source-${src.id}'),
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(src.name, style: text.titleSmall!.copyWith(color: src.dim ? SurauColors.muted : null)),
                            Text(
                              src.sub,
                              key: ValueKey('live-control-source-sub-${src.id}'),
                              style: text.bodySmall!.copyWith(color: src.bad ? SurauColors.dangerInk : SurauColors.muted),
                            ),
                          ],
                        ),
                      ),
                      LevelMeter(src.dim ? 0 : src.level),
                    ],
                  ),
                ),
            ],
          ),
        ),
      if (recording != null)
        _Row(
          key: const ValueKey('live-control-recording'),
          icon: Icons.fiber_manual_record_rounded,
          title: s.liveCtlRecHere,
          sub: s.liveRecordingParts(recording!.segments, formatBytes(recording!.bytes)),
          trailing: _Pill(
            text: recording!.running ? s.liveRecordingOn : s.liveRecordingOff,
            ink: recording!.running ? LiveColors.onAir : SurauColors.muted,
          ),
        ),
    ];
    return Card(
      key: const ValueKey('live-control-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 16, 8),
            child: Row(
              children: [
                _Pill(text: s.liveOn, ink: Colors.white, fill: LiveColors.onAir),
                const Spacer(),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      formatDuration(seconds),
                      key: const ValueKey('live-control-time'),
                      style: text.headlineSmall!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
                    ),
                    Text(s.liveCtlDuration, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ],
            ),
          ),
          if (startedBy != null)
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 16, 8),
              child: Row(
                children: [
                  const Icon(Icons.person_outline_rounded, size: 18, color: SurauColors.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      startedBy!,
                      key: const ValueKey('live-control-by'),
                      style: text.bodySmall!.copyWith(color: SurauColors.muted),
                    ),
                  ),
                ],
              ),
            ),
          for (final r in rows) ...[const Divider(height: 1, indent: 20, endIndent: 20), r],
          const Divider(height: 1, indent: 20, endIndent: 20),
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(20, 10, 8, 10),
            child: Row(
              key: const ValueKey('live-control-novideo'),
              children: [
                const Icon(Icons.visibility_off_outlined, size: 20, color: SurauColors.muted),
                const SizedBox(width: 10),
                Expanded(child: Text(s.liveCtlNoVideo, style: text.bodySmall!.copyWith(color: SurauColors.muted))),
                if (onWatchYoutube != null)
                  TextButton(
                    key: const ValueKey('live-control-watch'),
                    style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
                    onPressed: onWatchYoutube,
                    child: Text(s.liveCtlWatchYoutube),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    super.key,
    required this.icon,
    required this.title,
    required this.sub,
    this.trailing,
    this.onTap,
    this.subInk,
    this.extra = const [],
  });

  final IconData icon;

  /// Small lines under the sub line.
  final List<Widget> extra;
  final String title;
  final String sub;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Color? subInk;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(20, 8, 16, 8),
          child: Row(
            children: [
              Icon(icon, color: SurauColors.teal),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    Text(sub, style: text.bodySmall!.copyWith(color: subInk ?? SurauColors.muted)),
                    ...extra,
                  ],
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({super.key, required this.text, required this.ink, this.fill});

  final String text;
  final Color ink;
  final Color? fill;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(
      color: fill ?? ink.withValues(alpha: 0.10),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: Theme.of(context).textTheme.labelMedium!.copyWith(color: ink, fontWeight: FontWeight.w700),
    ),
  );
}

/// The list of TVs and what each does ("TV yang memaparkan siaran").
Future<void> showLiveViewersSheet(BuildContext context, List<LiveViewerDto> viewers) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    builder: (_) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
        child: Column(
          key: const ValueKey('live-viewers-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _ViewerList(viewers: viewers),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: () => Navigator.of(context, rootNavigator: true).pop(), child: Text(S.of(context).actionClose)),
          ],
        ),
      ),
    ),
  );
}

/// One line per TV in the sheet: its name and whether it shows the live or keeps its normal display, then the hint
/// that says where that is changed.
class _ViewerList extends StatelessWidget {
  const _ViewerList({required this.viewers});

  final List<LiveViewerDto> viewers;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    String word(String st) => switch (st) {
      'playing' => s.liveViewerShowing,
      'connecting' => s.liveViewerConnecting,
      _ => s.liveViewerNormal,
    };
    Color dot(String st) => switch (st) {
      'playing' => LiveColors.healthy,
      'connecting' => LiveColors.waiting,
      _ => SurauColors.outline,
    };
    return Column(
      key: const ValueKey('live-viewers'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.liveViewersTitle, style: text.titleMedium),
        const SizedBox(height: 8),
        for (final v in viewers)
          Semantics(
            label: '${v.name}, ${word(v.state)}',
            excludeSemantics: true,
            child: Container(
              key: ValueKey('live-viewer-${v.tvId}'),
              constraints: const BoxConstraints(minHeight: 48),
              child: Row(
                children: [
                  Container(width: 10, height: 10, decoration: BoxDecoration(color: dot(v.state), shape: BoxShape.circle)),
                  const SizedBox(width: 12),
                  Expanded(child: Text(bidiIsolate(v.name), style: text.titleSmall)),
                  const SizedBox(width: 8),
                  Text(
                    word(v.state),
                    key: ValueKey('live-viewer-state-${v.tvId}'),
                    style: text.bodyMedium!.copyWith(
                      color: v.state == 'playing' ? LiveColors.healthyInk : SurauColors.muted,
                      fontWeight: v.state == 'playing' ? FontWeight.w600 : FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ),
        const SizedBox(height: 4),
        Text(
          s.liveViewersHint,
          key: const ValueKey('live-viewers-hint'),
          style: text.bodySmall!.copyWith(color: SurauColors.muted),
        ),
      ],
    );
  }
}
