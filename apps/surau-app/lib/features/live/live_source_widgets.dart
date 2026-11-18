// The pieces of the Live tab that choose and show the picture source and the
// audio mix (plan rev 4, task C2): the collapsible sections, the "Sumber
// video" picker, the "Audio" card (one row per source with its
// "Kelantangan" slider and level meter), the alignment chip, the messages,
// the "Tambah audio" sheet and the fallback "Imbangan masa audio" with
// "Uji tepukan". They draw what live_source.dart computed and hold no state
// of their own beyond a stepper value.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../labels.dart' show appLangOf;
import '../labels_cam.dart';
import 'live_source.dart';
import 'live_widgets.dart';
import 'publisher.dart';

// ---- small parts ----

Color _toneColor(RowTone t) => switch (t) {
  RowTone.ok => LiveColors.healthy,
  RowTone.warn => LiveColors.waiting,
  RowTone.off => SurauColors.danger,
  RowTone.idle => SurauColors.outline,
};

Color _toneInk(RowTone t) => switch (t) {
  RowTone.ok => LiveColors.healthyInk,
  RowTone.warn => LiveColors.waitingInk,
  RowTone.off => SurauColors.dangerInk,
  RowTone.idle => SurauColors.muted,
};

class ToneDot extends StatelessWidget {
  const ToneDot(this.tone, {super.key});

  final RowTone tone;

  @override
  Widget build(BuildContext context) => Container(
    width: 10,
    height: 10,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: tone == RowTone.idle ? Colors.transparent : _toneColor(tone),
      border: Border.all(color: _toneColor(tone), width: 2),
    ),
  );
}

/// Eight bars; [level] 0.0 to 1.0.
class LevelMeter extends StatelessWidget {
  const LevelMeter(this.level, {super.key});

  final double level;

  @override
  Widget build(BuildContext context) {
    final on = (level.clamp(0.0, 1.0) * 8).round();
    return Semantics(
      label: 'Paras audio',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (var i = 0; i < 8; i++)
            Container(
              width: 4,
              height: 6.0 + i * 1.5,
              margin: const EdgeInsetsDirectional.only(start: 2),
              decoration: BoxDecoration(
                color: i < on ? (i > 5 ? LiveColors.waiting : SurauColors.teal) : SurauColors.line,
                borderRadius: BorderRadius.circular(1.5),
              ),
            ),
        ],
      ),
    );
  }
}

/// The alignment chip of an added row.
class AlignChip extends StatelessWidget {
  const AlignChip(this.model, {super.key});

  final AlignChipModel model;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final (bg, fg, icon) = switch (model.kind) {
      ChipKind.ok => (SurauColors.tealSoft, SurauColors.teal, Icons.check_rounded),
      ChipKind.bad => (SurauColors.dangerSoft, SurauColors.dangerInk, Icons.warning_amber_rounded),
      ChipKind.searching => (SurauColors.paperDeep, SurauColors.ink, null),
      _ => (SurauColors.paperDeep, SurauColors.muted, null),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (model.kind == ChipKind.searching)
            const Padding(
              padding: EdgeInsetsDirectional.only(end: 6),
              child: Icon(Icons.sync_rounded, size: 14, color: SurauColors.muted),
            )
          else if (icon != null)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 4),
              child: Icon(icon, size: 14, color: fg),
            ),
          Flexible(
            child: Text(model.text, style: text.labelMedium!.copyWith(color: fg)),
          ),
        ],
      ),
    );
  }
}

/// A calm message under the audio rows.
class AudioNoticeTile extends StatelessWidget {
  const AudioNoticeTile({super.key, required this.notice, this.onAction});

  final AudioNotice notice;
  final void Function(String id)? onAction;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    if (notice.kind == 'help') {
      return Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 4, 20, 4),
        child: Text(notice.body!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
      );
    }
    final bad = notice.kind == 'bad';
    final info = notice.kind == 'info';
    final ink = bad ? SurauColors.dangerInk : SurauColors.ink;
    return Container(
      margin: const EdgeInsetsDirectional.fromSTEB(12, 4, 12, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: bad
            ? SurauColors.dangerSoft
            : info
            ? SurauColors.tealSoft
            : SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            bad
                ? Icons.error_outline_rounded
                : info
                ? Icons.info_outline_rounded
                : Icons.warning_amber_rounded,
            color: ink,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (notice.title != null) Text(notice.title!, style: text.titleSmall!.copyWith(color: ink)),
                if (notice.body != null) Text(notice.body!, style: text.bodyMedium!.copyWith(color: ink)),
                if (notice.action != null && notice.actionId != null) ...[
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    key: const ValueKey('audio-use-only'),
                    onPressed: onAction == null ? null : () => onAction!(notice.actionId!),
                    icon: const Icon(Icons.mic_rounded, size: 18),
                    label: Text(notice.action!),
                  ),
                  const SizedBox(height: 6),
                  Text(liveAudioUseOnlyNote(lang), style: text.bodySmall!.copyWith(color: ink)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---- collapsible section ----

/// One folded-or-open card of the idle screen: icon, title, a summary line
/// that stays visible folded, and the body when open.
class FoldSection extends StatelessWidget {
  const FoldSection({
    super.key,
    required this.sectionKey,
    required this.icon,
    required this.title,
    required this.summary,
    required this.open,
    required this.onToggle,
    required this.child,
  });

  final String sectionKey;
  final IconData icon;
  final String title;
  final Widget summary;
  final bool open;
  final VoidCallback onToggle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Card(
      key: ValueKey('live-section-$sectionKey'),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            key: ValueKey('live-section-$sectionKey-head'),
            onTap: onToggle,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 64),
              child: Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
                child: Row(
                  children: [
                    Icon(icon, color: SurauColors.teal, size: 26),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(title, style: text.titleSmall),
                          const SizedBox(height: 2),
                          DefaultTextStyle(
                            style: text.bodySmall!.copyWith(color: SurauColors.muted),
                            child: summary,
                          ),
                        ],
                      ),
                    ),
                    Icon(open ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: SurauColors.muted),
                  ],
                ),
              ),
            ),
          ),
          if (open) ...[const Divider(height: 1), child],
        ],
      ),
    );
  }
}

/// A one-line summary: a dot and text.
class DotSummary extends StatelessWidget {
  const DotSummary(this.tone, this.text, {super.key, this.trailing});

  final RowTone tone;
  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      ToneDot(tone),
      const SizedBox(width: 8),
      Flexible(child: Text(text)),
      if (trailing != null) ...[const SizedBox(width: 8), trailing!],
    ],
  );
}

// ---- "Sumber video" ----

class VideoSourceBody extends StatelessWidget {
  const VideoSourceBody({
    super.key,
    required this.source,
    required this.ipad,
    required this.readOnly,
    required this.onPick,
    this.onOpenCamera,
  });

  final LiveSourceState source;
  final bool ipad;
  final bool readOnly;
  final void Function(VideoSourceKind kind) onPick;

  /// "Buka Kamera luaran", for holders of `live:settings`.
  final VoidCallback? onOpenCamera;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final cam = source.camera;
    final phoneOn = source.video == VideoSourceKind.phone;
    Widget option({
      required Key key,
      required bool selected,
      required IconData icon,
      required String title,
      required List<Widget> lines,
      VoidCallback? onTap,
    }) => InkWell(
      key: key,
      onTap: readOnly ? null : onTap,
      child: Container(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
        decoration: BoxDecoration(
          color: selected ? SurauColors.tealSoft.withValues(alpha: 0.5) : null,
          border: BorderDirectional(start: BorderSide(color: selected ? SurauColors.teal : Colors.transparent, width: 3)),
        ),
        child: Row(
          children: [
            Icon(selected ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded,
                color: selected ? SurauColors.teal : SurauColors.outline),
            const SizedBox(width: 12),
            Icon(icon, color: SurauColors.teal),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [Text(title, style: text.titleSmall), ...lines],
              ),
            ),
          ],
        ),
      ),
    );

    final children = <Widget>[
      option(
        key: const ValueKey('video-pick-phone'),
        selected: phoneOn,
        icon: Icons.smartphone_rounded,
        title: ipad ? liveSourceIpadCamera(lang) : liveSourcePhoneCamera(lang),
        lines: [
          Text(ipad ? liveSourceIpadCameraHint(lang) : liveSourcePhoneCameraHint(lang),
              style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        ],
        onTap: () => onPick(VideoSourceKind.phone),
      ),
    ];
    if (!cam.enabled || !cam.configured) {
      if (cam.configured || cam.enabled) {
        // switched off: not offered during a live, the person is told why
        children.add(
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline_rounded, color: SurauColors.muted),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(liveSourceExternalOffTitle(lang), style: text.titleSmall),
                      Text(liveSourceExternalOffBody(lang, cam.name),
                          style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                      if (onOpenCamera != null)
                        TextButton(
                          key: const ValueKey('video-open-camera'),
                          onPressed: onOpenCamera,
                          child: Text(liveSourceOpenCamera(lang)),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      }
    } else {
      final (tone, status) = switch (cam.reachable) {
        true => (RowTone.ok, '${liveSourceCameraReady(lang)}${cam.spec == null ? '' : ', ${cam.spec}'}'),
        false => (RowTone.off, liveSourceCameraUnreachable(lang)),
        null => (RowTone.idle, liveSourceCameraUntested(lang)),
      };
      children.add(
        option(
          key: const ValueKey('video-pick-external'),
          selected: !phoneOn,
          icon: Icons.videocam_rounded,
          title: cam.name,
          lines: [
            Text(liveSourceExternalHint(lang), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
            Padding(
              padding: const EdgeInsetsDirectional.only(top: 2),
              child: Row(
                children: [
                  ToneDot(tone),
                  const SizedBox(width: 6),
                  Flexible(child: Text(status, style: text.bodySmall!.copyWith(color: _toneInk(tone)))),
                ],
              ),
            ),
          ],
          onTap: () => onPick(VideoSourceKind.external),
        ),
      );
      if (!phoneOn && cam.reachable == false) {
        children.add(
          Container(
            key: const ValueKey('video-unreachable-note'),
            padding: const EdgeInsets.all(14),
            color: SurauColors.goldSoft,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.warning_amber_rounded, color: SurauColors.ink),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(liveSourceCameraUnreachableNote(lang, cam.name),
                      style: text.bodyMedium!.copyWith(color: SurauColors.ink)),
                ),
              ],
            ),
          ),
        );
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }
}

// ---- "Audio" ----

class AudioCardBody extends StatelessWidget {
  const AudioCardBody({
    super.key,
    required this.rows,
    required this.notices,
    required this.canAdd,
    required this.onAdd,
    required this.onVolume,
    required this.onRemove,
    required this.onMute,
    required this.onUseOnly,
    this.offsetBlock,
  });

  final List<AudioRowModel> rows;
  final List<AudioNotice> notices;
  final bool canAdd;
  final VoidCallback onAdd;
  final void Function(String id, int volume) onVolume;
  final void Function(String id) onRemove;
  final VoidCallback onMute;
  final void Function(String id) onUseOnly;

  /// The fallback block of a camera with no audio (built by the screen).
  final Widget Function(AudioRowModel row)? offsetBlock;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < rows.length; i++) ...[
          if (i > 0) const Divider(height: 1),
          AudioRowTile(
            row: rows[i],
            onVolume: onVolume,
            onRemove: onRemove,
            onMute: onMute,
            extra: rows[i].manual && offsetBlock != null ? offsetBlock!(rows[i]) : null,
          ),
        ],
        if (canAdd) ...[
          if (rows.isNotEmpty) const Divider(height: 1),
          InkWell(
            key: const ValueKey('audio-add'),
            onTap: onAdd,
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 16, 14),
              child: Row(
                children: [
                  const Icon(Icons.add_rounded, color: SurauColors.teal),
                  const SizedBox(width: 14),
                  Text(liveAudioAdd(lang), style: text.titleSmall!.copyWith(color: SurauColors.teal)),
                ],
              ),
            ),
          ),
        ],
        if (notices.isNotEmpty) const SizedBox(height: 4),
        for (final n in notices) AudioNoticeTile(notice: n, onAction: onUseOnly),
        if (notices.isNotEmpty) const SizedBox(height: 8),
      ],
    );
  }
}

class AudioRowTile extends StatelessWidget {
  const AudioRowTile({
    super.key,
    required this.row,
    required this.onVolume,
    required this.onRemove,
    required this.onMute,
    this.extra,
  });

  final AudioRowModel row;
  final void Function(String id, int volume) onVolume;
  final void Function(String id) onRemove;
  final VoidCallback onMute;
  final Widget? extra;

  IconData get _icon => switch (row.id) {
    idCamera => row.dim ? Icons.videocam_off_rounded : Icons.videocam_rounded,
    idBoxInput => Icons.settings_input_component_rounded,
    _ => row.mute && row.tone == RowTone.idle ? Icons.mic_off_rounded : Icons.mic_rounded,
  };

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Opacity(
      opacity: row.dim ? 0.6 : 1,
      child: Padding(
        key: ValueKey('audio-row-${row.id}'),
        padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 8, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(_icon, color: SurauColors.teal),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(row.name, style: text.titleSmall),
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          ToneDot(row.tone),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              row.status,
                              key: ValueKey('audio-status-${row.id}'),
                              style: text.bodySmall!.copyWith(color: _toneInk(row.tone), fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                      ),
                      if (row.chip != null)
                        Padding(
                          padding: const EdgeInsetsDirectional.only(top: 6),
                          child: Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: KeyedSubtree(key: ValueKey('audio-chip-${row.id}'), child: AlignChip(row.chip!)),
                          ),
                        ),
                    ],
                  ),
                ),
                if (row.slider || row.mute) Padding(padding: const EdgeInsetsDirectional.only(top: 6), child: LevelMeter(row.level)),
                if (row.removable)
                  IconButton(
                    key: ValueKey('audio-remove-${row.id}'),
                    tooltip: '${liveAudioRemove(lang)} ${row.name}',
                    onPressed: () => onRemove(row.id),
                    icon: const Icon(Icons.close_rounded),
                  )
                else
                  const SizedBox(width: 12),
              ],
            ),
            if (row.slider)
              Padding(
                padding: const EdgeInsetsDirectional.only(end: 12),
                child: Row(
                  children: [
                    Text(liveAudioVolume(lang), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                    Expanded(
                      child: Slider(
                        key: ValueKey('audio-volume-${row.id}'),
                        value: row.volume.toDouble(),
                        min: 0,
                        max: 100,
                        divisions: 20,
                        semanticFormatterCallback: (v) => '${v.round()}%',
                        onChanged: row.readOnly ? null : (v) => onVolume(row.id, v.round()),
                      ),
                    ),
                    SizedBox(
                      width: 48,
                      child: Text(
                        '${row.volume}%',
                        key: ValueKey('audio-volume-text-${row.id}'),
                        textAlign: TextAlign.end,
                        style: text.labelLarge!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
                      ),
                    ),
                  ],
                ),
              ),
            if (row.mute && !row.readOnly)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: 8, end: 12),
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: OutlinedButton.icon(
                    key: const ValueKey('audio-mute'),
                    onPressed: onMute,
                    icon: Icon(row.tone == RowTone.idle ? Icons.mic_rounded : Icons.mic_off_rounded, size: 18),
                    label: Text(row.tone == RowTone.idle ? liveAudioUnmute(lang) : liveAudioMute(lang)),
                  ),
                ),
              ),
            if (row.hint != null)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: 6, end: 12),
                child: Text(row.hint!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
              ),
            if (extra != null) Padding(padding: const EdgeInsetsDirectional.only(top: 10, end: 12), child: extra),
          ],
        ),
      ),
    );
  }
}

// ---- "Tambah audio" ----

/// Bottom sheet: the sources that can still be added, the unavailable ones
/// greyed with their reason. Pops the chosen id.
class AddAudioSheet extends StatelessWidget {
  const AddAudioSheet({super.key, required this.source, required this.ipad});

  final LiveSourceState source;
  final bool ipad;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final ext = source.external;
    final mix = source.mix;
    Widget item({
      required String id,
      required IconData icon,
      required String title,
      required String hint,
      required bool added,
      String? reason,
    }) {
      final off = reason != null;
      return Opacity(
        opacity: off ? 0.6 : 1,
        child: Padding(
          key: ValueKey('add-audio-$id'),
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            children: [
              Icon(icon, color: SurauColors.teal),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    off
                        ? Row(
                            children: [
                              const ToneDot(RowTone.idle),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(reason, style: text.bodySmall!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w600)),
                              ),
                            ],
                          )
                        : Text(hint, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
              if (added)
                Text(liveAudioAdded(lang), style: text.labelMedium!.copyWith(color: SurauColors.teal))
              else if (!off)
                OutlinedButton.icon(
                  key: ValueKey('add-audio-button-$id'),
                  onPressed: () => Navigator.pop(context, id),
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: Text(liveAudioAddButton(lang)),
                ),
            ],
          ),
        ),
      );
    }

    return SafeArea(
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 16),
        child: Column(
          key: const ValueKey('add-audio-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(liveAudioAdd(lang), style: text.titleLarge),
            const SizedBox(height: 4),
            Text(ext ? liveAudioAddHelpCamera(lang) : liveAudioAddHelpPhone(lang),
                style: text.bodySmall!.copyWith(color: SurauColors.muted)),
            if (ext)
              item(
                id: idDeviceMic,
                icon: Icons.mic_rounded,
                title: ipad ? liveAudioIpadMicRow(lang) : liveAudioPhoneMicRow(lang),
                hint: liveAudioMicHint(lang, ipad),
                added: mix.deviceMic.enabled,
              ),
            item(
              id: idBoxInput,
              icon: Icons.settings_input_component_rounded,
              title: liveAudioBoxInputRow(lang),
              hint: liveAudioAddBoxHint(lang),
              added: mix.boxInput.enabled,
              reason: source.boxInputAvailable ? null : (source.boxInputReason ?? liveAudioBoxInputMissing(lang)),
            ),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(onPressed: () => Navigator.pop(context), child: Text(liveAudioClose(lang))),
            ),
          ],
        ),
      ),
    );
  }
}

// ---- "Imbangan masa audio" and "Uji tepukan" ----

/// The fallback for a camera with no audio track: a stepper (0 to 2000 ms,
/// steps of 50) and the clap test.
class OffsetBlock extends StatelessWidget {
  const OffsetBlock({super.key, required this.ms, required this.onStep, required this.onClap});

  final int ms;
  final void Function(int delta) onStep;
  final VoidCallback onClap;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: SurauColors.paperDeep,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(liveAudioOffsetTitle(lang), style: text.titleSmall),
          Text(liveAudioOffsetHelp(lang), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 8),
          Row(
            children: [
              IconButton.outlined(
                key: const ValueKey('audio-offset-minus'),
                tooltip: 'Kurangkan',
                onPressed: ms <= 0 ? null : () => onStep(-50),
                icon: const Icon(Icons.remove_rounded),
              ),
              Expanded(
                child: Text(
                  liveAudioOffsetValue(lang, ms),
                  key: const ValueKey('audio-offset-value'),
                  textAlign: TextAlign.center,
                  style: text.titleMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
                ),
              ),
              IconButton.outlined(
                key: const ValueKey('audio-offset-plus'),
                tooltip: 'Tambah',
                onPressed: ms >= 2000 ? null : () => onStep(50),
                icon: const Icon(Icons.add_rounded),
              ),
            ],
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            key: const ValueKey('audio-clap'),
            onPressed: onClap,
            icon: const Icon(Icons.sync_rounded, size: 18),
            label: Text(liveAudioClapTest(lang)),
          ),
        ],
      ),
    );
  }
}

/// "Uji tepukan" on Android: record about five seconds of picture and sound,
/// replay them in a loop while the stepper moves the offset, "Simpan" keeps it.
/// On the iPad the same stepper runs against the box's live preview (no
/// recording step).
class ClapSheet extends StatefulWidget {
  const ClapSheet({
    super.key,
    required this.initialMs,
    required this.control,
    required this.clap,
    required this.onSave,
    required this.onOffset,
  });

  final int initialMs;

  /// Android: the engine's clap test; null on the iPad.
  final LiveSourceControl? control;

  /// The engine's clap phase while recording and replaying.
  final Stream<ClapPhase> clap;
  final Future<void> Function(int ms) onSave;

  /// The stepper moved (iPad: against the preview; Android: the replay).
  final void Function(int ms) onOffset;

  @override
  State<ClapSheet> createState() => _ClapSheetState();
}

class _ClapSheetState extends State<ClapSheet> {
  late int _ms = widget.initialMs;
  ClapPhase _phase = ClapPhase.idle;
  StreamSubscription<ClapPhase>? _sub;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _sub = widget.clap.listen((p) {
      if (!mounted) return;
      final wasCapturing = _phase == ClapPhase.capturing;
      setState(() => _phase = p);
      if (wasCapturing && p == ClapPhase.ready) unawaited(widget.control?.clapReplay(_ms));
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    unawaited(widget.control?.clapStop());
    super.dispose();
  }

  void _step(int d) {
    final next = (_ms + d).clamp(0, 2000);
    setState(() => _ms = next);
    widget.onOffset(next);
    if (_phase == ClapPhase.replaying) unawaited(widget.control?.clapOffset(next));
  }

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final android = widget.control != null;
    final busy = _phase == ClapPhase.capturing;
    final replaying = _phase == ClapPhase.replaying || _phase == ClapPhase.ready;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 16),
        child: Column(
          key: const ValueKey('clap-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(liveAudioClapTest(lang), style: text.titleLarge),
            const SizedBox(height: 6),
            Text(android ? liveAudioClapIntro(lang) : liveAudioClapIpadIntro(lang),
                style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            if (android && !replaying)
              FilledButton.icon(
                key: const ValueKey('clap-record'),
                onPressed: busy ? null : () => widget.control!.clapCapture(),
                icon: Icon(busy ? Icons.hourglass_top_rounded : Icons.fiber_manual_record_rounded),
                label: Text(busy ? liveAudioClapRecording(lang) : liveAudioClapRecord(lang)),
              ),
            if (_phase == ClapPhase.failed)
              Padding(
                padding: const EdgeInsetsDirectional.only(top: 8),
                child: Text(liveAudioClapFailed(lang), style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk)),
              ),
            if (!android || replaying) ...[
              OffsetBlockStepper(ms: _ms, onStep: _step),
              const SizedBox(height: 12),
              FilledButton(
                key: const ValueKey('clap-save'),
                onPressed: _saving
                    ? null
                    : () async {
                        setState(() => _saving = true);
                        try {
                          await widget.onSave(_ms);
                          if (context.mounted) Navigator.pop(context, _ms);
                        } finally {
                          if (mounted) setState(() => _saving = false);
                        }
                      },
                child: Text(liveAudioClapSave(lang)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Just the stepper of [OffsetBlock].
class OffsetBlockStepper extends StatelessWidget {
  const OffsetBlockStepper({super.key, required this.ms, required this.onStep});

  final int ms;
  final void Function(int delta) onStep;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Row(
      children: [
        IconButton.outlined(
          key: const ValueKey('clap-minus'),
          tooltip: 'Kurangkan',
          onPressed: ms <= 0 ? null : () => onStep(-50),
          icon: const Icon(Icons.remove_rounded),
        ),
        Expanded(
          child: Text(
            liveAudioOffsetValue(lang, ms),
            key: const ValueKey('clap-value'),
            textAlign: TextAlign.center,
            style: text.titleMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
          ),
        ),
        IconButton.outlined(
          key: const ValueKey('clap-plus'),
          tooltip: 'Tambah',
          onPressed: ms >= 2000 ? null : () => onStep(50),
          icon: const Icon(Icons.add_rounded),
        ),
      ],
    );
  }
}

/// "Campuran" over the preview: the mixed level.
class MixedLevelChip extends StatelessWidget {
  const MixedLevelChip({super.key, required this.level, required this.silent});

  final double level;
  final bool silent;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(silent ? Icons.volume_off_rounded : Icons.volume_up_rounded, color: Colors.white, size: 16),
          const SizedBox(width: 6),
          Text(silent ? liveNoSound(lang) : liveMixedLevel(lang), style: text.labelMedium!.copyWith(color: Colors.white)),
          if (!silent) ...[const SizedBox(width: 8), LevelMeter(level)],
        ],
      ),
    );
  }
}
