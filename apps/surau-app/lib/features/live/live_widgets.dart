// The pieces of the Live tab. One element carries the weight: the
// preview, framed like a broadcast monitor in the kiosk's glass with a red
// tally edge while the surau is on air. Everything around it stays on
// paper and quiet: the kuliah being broadcast, the legs as rows with a
// status light, one big button. Camera-first simplicity: the
// person sees what is going out, where, and how to stop it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'publisher.dart';

/// Colours of the Live tab beyond the app theme: the on-air red of a
/// tally light and the green of a healthy leg.
abstract final class LiveColors {
  static const Color onAir = Color(0xFFD93025);
  static const Color onAirSoft = Color(0xFFFDECEA);
  static const Color healthy = Color(0xFF1E8E5A);
  static const Color waiting = Color(0xFFC48A12);
  static const Color waitingSoft = Color(0xFFFFF4DC);
  static const Color waitingInk = Color(0xFF8A5A00);
  static const Color healthyInk = Color(0xFF16714A);
}

/// `01:02:03`, or `02:03` under an hour.
String formatDuration(int seconds) {
  final h = seconds ~/ 3600;
  final m = (seconds % 3600) ~/ 60;
  final s = seconds % 60;
  String two(int v) => v.toString().padLeft(2, '0');
  return h > 0 ? '${two(h)}:${two(m)}:${two(s)}' : '${two(m)}:${two(s)}';
}

/// `850 MB`, `1.4 GB`.
String formatBytes(int bytes) {
  const mb = 1024 * 1024;
  const gb = 1024 * mb;
  if (bytes >= gb) return '${(bytes / gb).toStringAsFixed(1)} GB';
  if (bytes >= mb) return '${(bytes / mb).round()} MB';
  return '${(bytes / 1024).ceil()} KB';
}

/// `2.4 Mbps` or `850 kbps`.
String formatBitrate(int kbps) =>
    kbps >= 1000 ? '${(kbps / 1000).toStringAsFixed(1)} Mbps' : '$kbps kbps';

// ---- status light ----

enum LightTone { idle, waiting, healthy, failed, onAir }

Color lightColor(LightTone tone) => switch (tone) {
  LightTone.idle => SurauColors.outline,
  LightTone.waiting => LiveColors.waiting,
  LightTone.healthy => LiveColors.healthy,
  LightTone.failed => SurauColors.danger,
  LightTone.onAir => LiveColors.onAir,
};

/// [lightColor] dark enough for words on paper (4.5:1 on white).
Color lightInk(LightTone tone) => switch (tone) {
  LightTone.waiting => LiveColors.waitingInk,
  LightTone.healthy => LiveColors.healthyInk,
  _ => lightColor(tone),
};

class StatusLight extends StatelessWidget {
  const StatusLight(this.tone, {super.key, this.size = 12});

  final LightTone tone;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = lightColor(tone);
    final lit = tone != LightTone.idle;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: lit ? c : Colors.transparent,
        border: Border.all(color: c, width: 2),
        boxShadow: lit
            ? [
                BoxShadow(
                  color: c.withValues(alpha: 0.35),
                  blurRadius: 6,
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
    );
  }
}

/// The light and words for one leg.
(LightTone, String) outputStatus(S s, OutputState? o, {required bool live}) {
  if (o == null) return (LightTone.idle, s.liveReady);
  return switch (o.phase) {
    OutputPhase.connecting => (LightTone.waiting, s.liveConnecting),
    OutputPhase.up => (live ? LightTone.healthy : LightTone.idle, s.liveOn),
    OutputPhase.retrying => (LightTone.waiting, s.liveRetry(o.retryInSec ?? 0)),
    OutputPhase.down => (LightTone.failed, s.liveDown),
  };
}

// ---- the monitor ----

/// The camera preview in a 16:9 glass frame, with the tally edge, the
/// on-air pill and timer, and the flip and mute buttons over the picture.
class LivePreviewFrame extends StatelessWidget {
  const LivePreviewFrame({
    super.key,
    required this.picture,
    required this.state,
    required this.onFlip,
    required this.onMute,
    this.onMinimise,
  });

  final Widget picture;
  final PublisherState state;
  final VoidCallback? onFlip;
  final VoidCallback? onMute;

  /// Folds the settings away so the picture fills the screen (null: no button).
  final VoidCallback? onMinimise;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final live = state.isLive;
    final preparing =
        state.phase == PublisherPhase.idle ||
        state.phase == PublisherPhase.preparing;
    return Container(
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard + 4),
        border: Border.all(
          color: live ? LiveColors.onAir : SurauColors.goldHairline,
          width: live ? 2 : 1,
        ),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard - 2),
        child: AspectRatio(
          aspectRatio: 16 / 9,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (preparing) _Preparing(label: s.livePreparing) else picture,
              // Shade at top and bottom so the overlays read on any picture.
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Color(0x8006302B),
                      Color(0x0006302B),
                      Color(0x0006302B),
                      Color(0x9906302B),
                    ],
                    stops: [0, 0.28, 0.62, 1],
                  ),
                ),
              ),
              Positioned(
                left: 12,
                top: 12,
                child: live
                    ? OnAirPill(seconds: state.durationSec)
                    : _ReadyPill(label: s.liveReady),
              ),
              if (state.muted)
                Positioned(
                  right: 12,
                  top: 12,
                  child: _GlassTag(
                    icon: Icons.mic_off_rounded,
                    label: s.liveMuted,
                    tone: LiveColors.onAir,
                  ),
                ),
              if (onMinimise != null)
                Positioned(
                  left: 10,
                  bottom: 10,
                  child: _GlassButton(
                    key: const ValueKey('live-minimise'),
                    icon: Icons.fullscreen_rounded,
                    tooltip: s.liveMinimise,
                    onPressed: onMinimise,
                  ),
                ),
              Positioned(
                right: 10,
                bottom: 10,
                child: Row(
                  children: [
                    _GlassButton(
                      icon: Icons.cameraswitch_rounded,
                      tooltip: s.liveFlip,
                      onPressed: onFlip,
                    ),
                    const SizedBox(width: 10),
                    _GlassButton(
                      icon: state.muted
                          ? Icons.mic_off_rounded
                          : Icons.mic_rounded,
                      tooltip: state.muted ? s.liveUnmute : s.liveMute,
                      onPressed: onMute,
                      alert: state.muted,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Preparing extends StatelessWidget {
  const _Preparing({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: SurauColors.glass,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(
                color: SurauColors.gold,
                strokeWidth: 3,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              label,
              style: Theme.of(context).textTheme.bodyMedium!
                  .copyWith(color: Colors.white),
            ),
          ],
        ),
      ),
    );
  }
}

/// Red pill with the pulsing dot's still frame and the running time.
class OnAirPill extends StatelessWidget {
  const OnAirPill({super.key, required this.seconds});

  final int seconds;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 6, 12, 6),
      decoration: BoxDecoration(
        color: LiveColors.onAir,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 9,
            height: 9,
            decoration: const BoxDecoration(
              color: Colors.white,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            s.liveOn,
            style: text.labelMedium!.copyWith(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            formatDuration(seconds),
            style: text.labelMedium!.copyWith(
              color: Colors.white,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

class _ReadyPill extends StatelessWidget {
  const _ReadyPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => _GlassTag(
    icon: Icons.videocam_rounded,
    label: label,
    tone: SurauColors.gold,
  );
}

class _GlassTag extends StatelessWidget {
  const _GlassTag({
    required this.icon,
    required this.label,
    required this.tone,
  });

  final IconData icon;
  final String label;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 5, 12, 5),
      decoration: BoxDecoration(
        color: SurauColors.glass.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: tone),
          const SizedBox(width: 6),
          Text(
            label,
            style: Theme.of(context).textTheme.labelMedium!
                .copyWith(color: Colors.white),
          ),
        ],
      ),
    );
  }
}

class _GlassButton extends StatelessWidget {
  const _GlassButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.alert = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool alert;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: alert
            ? LiveColors.onAir
            : SurauColors.glass.withValues(alpha: 0.72),
        shape: const CircleBorder(
          side: BorderSide(color: SurauColors.goldHairline),
        ),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: SizedBox(
            width: 48,
            height: 48,
            child: Icon(
              icon,
              color: Colors.white,
              size: 24,
              semanticLabel: tooltip,
            ),
          ),
        ),
      ),
    );
  }
}

// ---- the folded view ----

/// One output of the folded overlay: its status light and a short name.
class FoldedLeg {
  const FoldedLeg(this.key, this.label, this.tone);

  final String key;
  final String label;
  final LightTone tone;
}

/// The Live tab with the settings folded away: the preview fills the screen
/// and a slim overlay keeps the duration, a light per output, mute, flip,
/// Berhenti while live and the way back. Along the top in portrait, down the
/// right edge in landscape so the middle of the picture stays clear.
class LiveFoldedView extends StatelessWidget {
  const LiveFoldedView({
    super.key,
    required this.picture,
    required this.state,
    required this.legs,
    required this.onFlip,
    required this.onMute,
    required this.onStop,
    required this.onExpand,
  });

  final Widget picture;
  final PublisherState state;
  final List<FoldedLeg> legs;
  final VoidCallback? onFlip;
  final VoidCallback? onMute;
  final VoidCallback onStop;
  final VoidCallback onExpand;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final live = state.isLive;
    final preparing =
        state.phase == PublisherPhase.idle ||
        state.phase == PublisherPhase.preparing;
    final stopping = state.phase == PublisherPhase.stopping;
    return LayoutBuilder(
      builder: (context, c) {
        final landscape = c.maxWidth > c.maxHeight;
        final pill = live
            ? OnAirPill(seconds: state.durationSec)
            : _ReadyPill(label: s.liveReady);
        final chips = [
          for (final l in legs)
            _LegChip(key: ValueKey('folded-${l.key}'), leg: l),
        ];
        final mute = _GlassButton(
          key: const ValueKey('live-folded-mute'),
          icon: state.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
          tooltip: state.muted ? s.liveUnmute : s.liveMute,
          onPressed: onMute,
          alert: state.muted,
        );
        final flip = _GlassButton(
          key: const ValueKey('live-folded-flip'),
          icon: Icons.cameraswitch_rounded,
          tooltip: s.liveFlip,
          onPressed: onFlip,
        );
        final expand = _GlassButton(
          key: const ValueKey('live-expand'),
          icon: Icons.fullscreen_exit_rounded,
          tooltip: s.liveExpand,
          onPressed: onExpand,
        );
        final stop = live || stopping
            ? FilledButton.icon(
                key: const ValueKey('live-stop'),
                style: FilledButton.styleFrom(
                  backgroundColor: LiveColors.onAir,
                  foregroundColor: Colors.white,
                  minimumSize: const Size(0, 48),
                  textStyle: Theme.of(context).textTheme.titleSmall!
                      .copyWith(fontWeight: FontWeight.w700),
                ),
                onPressed: stopping ? null : onStop,
                icon: const Icon(Icons.stop_rounded, size: 24),
                label: Text(s.liveStop),
              )
            : null;
        final Widget overlay = landscape
            ? Align(
                alignment: Alignment.centerRight,
                child: Container(
                  key: const ValueKey('folded-side'),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: SurauColors.glass.withValues(alpha: 0.55),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        pill,
                        for (final ch in chips) ...[
                          const SizedBox(height: 6),
                          ch,
                        ],
                        const SizedBox(height: 12),
                        mute,
                        const SizedBox(height: 10),
                        flip,
                        if (stop != null) ...[const SizedBox(height: 10), stop],
                        const SizedBox(height: 10),
                        expand,
                      ],
                    ),
                  ),
                ),
              )
            : Column(
                key: const ValueKey('folded-top'),
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      pill,
                      const SizedBox(width: 8),
                      Expanded(
                        child: Wrap(
                          alignment: WrapAlignment.end,
                          spacing: 6,
                          runSpacing: 6,
                          children: chips,
                        ),
                      ),
                    ],
                  ),
                  const Spacer(),
                  Row(
                    children: [
                      mute,
                      const SizedBox(width: 10),
                      flip,
                      const Spacer(),
                      if (stop != null) ...[stop, const SizedBox(width: 10)],
                      expand,
                    ],
                  ),
                ],
              );
        return ColoredBox(
          color: SurauColors.glass,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRect(
                child: preparing ? _Preparing(label: s.livePreparing) : picture,
              ),
              if (live)
                IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      border: Border.all(color: LiveColors.onAir, width: 3),
                    ),
                  ),
                ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: overlay,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _LegChip extends StatelessWidget {
  const _LegChip({super.key, required this.leg});

  final FoldedLeg leg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 6, 12, 6),
      decoration: BoxDecoration(
        color: SurauColors.glass.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          StatusLight(leg.tone, size: 10),
          const SizedBox(width: 7),
          Text(
            leg.label,
            style: Theme.of(context).textTheme.labelMedium!
                .copyWith(color: Colors.white),
          ),
        ],
      ),
    );
  }
}

// ---- stats ----

/// Duration, bitrate and frames per second under the monitor.
class LiveStatsStrip extends StatelessWidget {
  const LiveStatsStrip({super.key, required this.state});

  final PublisherState state;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final live = state.isLive;
    String dash(String v) => live ? v : '--';
    return Row(
      children: [
        Expanded(
          child: _Stat(
            label: s.liveDuration,
            value: live ? formatDuration(state.durationSec) : '00:00',
          ),
        ),
        const _StatRule(),
        Expanded(
          child: _Stat(
            label: s.liveBitrate,
            value: dash(formatBitrate(state.stats.bitrateKbps)),
          ),
        ),
        const _StatRule(),
        Expanded(
          child: _Stat(label: s.liveFps, value: dash('${state.stats.fps}')),
        ),
      ],
    );
  }
}

class _StatRule extends StatelessWidget {
  const _StatRule();

  @override
  Widget build(BuildContext context) => Container(
    width: 1,
    height: 34,
    color: SurauColors.line,
    margin: const EdgeInsets.symmetric(horizontal: 12),
  );
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          maxLines: 1,
          style: text.titleLarge!.copyWith(
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: text.bodySmall,
        ),
      ],
    );
  }
}

// ---- warnings ----

String warningLabel(S s, Warning w) => switch (w) {
  Warning.lowBattery => s.liveWarnBattery,
  Warning.hot => s.liveWarnHot,
  Warning.screenLockRisk => s.liveWarnScreen,
  Warning.lowStorage => s.liveWarnStorage,
  Warning.noInternet => s.liveWarnNoInternet,
};

IconData _warningIcon(Warning w) => switch (w) {
  Warning.lowBattery => Icons.battery_alert_rounded,
  Warning.hot => Icons.device_thermostat_rounded,
  Warning.screenLockRisk => Icons.screen_lock_portrait_rounded,
  Warning.lowStorage => Icons.sd_card_alert_rounded,
  Warning.noInternet => Icons.wifi_off_rounded,
};

/// Device warnings, most serious first; each one a full sentence chip.
class WarningChips extends StatelessWidget {
  const WarningChips({super.key, required this.warnings});

  final Set<Warning> warnings;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ordered = [
      for (final w in Warning.values)
        if (warnings.contains(w)) w,
    ];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final w in ordered)
          Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: w == Warning.screenLockRisk
                  ? LiveColors.waitingSoft
                  : SurauColors.dangerSoft,
              borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _warningIcon(w),
                  size: 20,
                  color: w == Warning.screenLockRisk
                      ? LiveColors.waiting
                      : SurauColors.danger,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    warningLabel(s, w),
                    style: text.labelMedium!.copyWith(
                      color: w == Warning.screenLockRisk
                          ? SurauColors.ink
                          : SurauColors.dangerInk,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

// ---- rows ----

/// The paper card that holds the output rows, separated by hairlines.
class LiveCard extends StatelessWidget {
  const LiveCard({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const Divider(indent: 20, endIndent: 20),
            children[i],
          ],
        ],
      ),
    );
  }
}

/// One leg: icon, name, a hint or the reason it is off, and the light
/// with its status words; [trailing] holds the YouTube switch.
class OutputRow extends StatelessWidget {
  const OutputRow({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.tone,
    required this.status,
    this.trailing,
    this.reason = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final LightTone tone;
  final String status;
  final Widget? trailing;

  /// True when [subtitle] says why the leg is unavailable.
  final bool reason;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 72),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: SurauColors.tealSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusChip + 2),
              ),
              child: Icon(icon, color: SurauColors.teal, size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(title, style: text.titleSmall)),
                      if (status.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        StatusLight(tone),
                        const SizedBox(width: 8),
                        Text(
                          status,
                          style: text.labelMedium!.copyWith(
                            color: tone == LightTone.idle
                                ? SurauColors.muted
                                : lightInk(tone),
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: text.bodySmall!.copyWith(
                      color: reason ? SurauColors.dangerInk : SurauColors.muted,
                    ),
                  ),
                ],
              ),
            ),
            if (trailing != null) ...[
              const SizedBox(width: 8),
              trailing!,
            ] else
              const SizedBox(width: 8),
          ],
        ),
      ),
    );
  }
}

/// A calm notice above the page: [tone] gold for a to-do, red for a block.
class LiveNotice extends StatelessWidget {
  const LiveNotice({
    super.key,
    required this.icon,
    required this.title,
    this.body,
    this.action,
    this.danger = false,
  });

  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final ink = danger ? SurauColors.dangerInk : SurauColors.ink;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: danger ? SurauColors.dangerSoft : SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        border: Border.all(
          color: danger
              ? SurauColors.danger.withValues(alpha: 0.25)
              : SurauColors.gold,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                icon,
                color: danger ? SurauColors.danger : SurauColors.ink,
                size: 24,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall!.copyWith(color: ink)),
                    if (body != null) ...[
                      const SizedBox(height: 2),
                      Text(body!, style: text.bodyMedium!.copyWith(color: ink)),
                    ],
                  ],
                ),
              ),
            ],
          ),
          if (action != null) ...[
            const SizedBox(height: 10),
            Align(alignment: Alignment.centerRight, child: action),
          ],
        ],
      ),
    );
  }
}

// ---- the button ----

/// `Mula siaran` in gold, `Berhenti` in on-air red, a quiet wait between.
class LiveActionButton extends StatelessWidget {
  const LiveActionButton({
    super.key,
    required this.phase,
    required this.onStart,
    required this.onStop,
  });

  final PublisherPhase phase;
  final VoidCallback? onStart;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    const size = Size.fromHeight(60);
    final label = text.titleMedium!.copyWith(fontWeight: FontWeight.w700);
    switch (phase) {
      case PublisherPhase.live:
        return FilledButton.icon(
          key: const ValueKey('live-stop'),
          style: FilledButton.styleFrom(
            backgroundColor: LiveColors.onAir,
            foregroundColor: Colors.white,
            minimumSize: size,
            textStyle: label,
          ),
          onPressed: onStop,
          icon: const Icon(Icons.stop_rounded, size: 28),
          label: Text(s.liveStop),
        );
      case PublisherPhase.starting:
      case PublisherPhase.stopping:
        return FilledButton.icon(
          style: FilledButton.styleFrom(minimumSize: size, textStyle: label),
          onPressed: null,
          icon: const SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2.5,
              color: SurauColors.muted,
            ),
          ),
          label: Text(
            phase == PublisherPhase.starting ? s.liveStarting : s.liveStopping,
          ),
        );
      default:
        return FilledButton.icon(
          key: const ValueKey('live-start'),
          style: FilledButton.styleFrom(minimumSize: size, textStyle: label),
          onPressed: onStart,
          icon: const Icon(Icons.sensors_rounded, size: 26),
          label: Text(s.liveStart),
        );
    }
  }
}
