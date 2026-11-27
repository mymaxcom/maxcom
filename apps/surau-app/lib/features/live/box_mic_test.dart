// The test of every box microphone before Start (2026.11.15 build 5, mockup B5).
//
// One row per capture device of the MAXCOM Kiosk Box: a radio for the chosen device, the result of the 5 second test
// as a chip, a level bar, and, when the chosen device tested silent, a warning block. A pure widget: no text of its
// own (every string arrives in [MicTestTexts]) and no network call; the screen runs the test and saves the choice.
//
// Keys: card `box-mic-test`, row `box-mic-test-row-<index>`, chip `box-mic-test-chip-<index>`,
// warning `box-mic-test-silent`, button `box-mic-test-again`.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'live_source_widgets.dart' show LevelMeter;
import 'live_widgets.dart' show LiveColors;

/// Where one device stands in the test.
enum MicTestState { none, testing, sound, silent, failed }

/// The level bar value (0.0 to 1.0) of a mean level in dBFS; null when there is none (as `LiveStatusDto.meter`).
double? micMeterOf(num? meanDb) => meanDb == null ? null : ((meanDb + 60) / 60).clamp(0.0, 1.0).toDouble();

class MicTestRow {
  const MicTestRow({required this.name, required this.selected, required this.state, this.meter});

  final String name;

  /// The device the box will use (the radio).
  final bool selected;
  final MicTestState state;

  /// 0.0 to 1.0; null draws no bar.
  final double? meter;
}

/// Every visible string of the card, finished by the caller.
class MicTestTexts {
  const MicTestTexts({
    required this.hint,
    required this.testing,
    required this.sound,
    required this.silent,
    required this.failed,
    required this.none,
    required this.again,
    required this.testedAt,
    required this.silentTitle,
    required this.silentBody,
  });

  final String hint;
  final String testing;
  final String sound;
  final String silent;
  final String failed;
  final String none;
  final String again;
  final String silentTitle;
  final String silentBody;

  /// The finished sentence ("Diuji pada 7:28 PTG."); null before the first test.
  final String? testedAt;
}

class BoxMicTestCard extends StatelessWidget {
  const BoxMicTestCard({
    super.key,
    required this.rows,
    required this.texts,
    required this.testing,
    this.onPick,
    this.onTestAgain,
  });

  final List<MicTestRow> rows;
  final MicTestTexts texts;

  /// A test is running: the button waits.
  final bool testing;

  /// Null: the radios are disabled.
  final void Function(String name)? onPick;

  /// Null: the button is hidden.
  final VoidCallback? onTestAgain;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final chosen = rows.indexWhere((r) => r.selected);
    final showWarning = chosen >= 0 && rows[chosen].state == MicTestState.silent;
    return Card(
      key: const ValueKey('box-mic-test'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 16, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 1),
                  child: Icon(Icons.mic_rounded, color: SurauColors.teal),
                ),
                const SizedBox(width: 14),
                Expanded(child: Text(texts.hint, style: text.bodyMedium!.copyWith(color: SurauColors.muted, height: 1.4))),
              ],
            ),
          ),
          for (var i = 0; i < rows.length; i++)
            _MicRow(index: i, row: rows[i], texts: texts, onPick: onPick),
          if (showWarning)
            Container(
              key: const ValueKey('box-mic-test-silent'),
              padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
              decoration: const BoxDecoration(
                color: SurauColors.dangerSoft,
                border: Border(top: BorderSide(color: SurauColors.line)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 1),
                    child: Icon(Icons.warning_amber_rounded, size: 22, color: SurauColors.danger),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(texts.silentTitle, style: text.titleSmall!.copyWith(color: SurauColors.dangerInk)),
                        const SizedBox(height: 2),
                        Text(texts.silentBody, style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk, height: 1.4)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          if (onTestAgain != null || texts.testedAt != null)
            Container(
              padding: const EdgeInsetsDirectional.fromSTEB(16, 6, 16, 14),
              decoration: const BoxDecoration(border: Border(top: BorderSide(color: SurauColors.line))),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (onTestAgain != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: OutlinedButton.icon(
                        key: const ValueKey('box-mic-test-again'),
                        style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
                        onPressed: testing ? null : onTestAgain,
                        icon: const Icon(Icons.sync_rounded, size: 20),
                        label: Text(texts.again),
                      ),
                    ),
                  if (texts.testedAt != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(texts.testedAt!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _MicRow extends StatelessWidget {
  const _MicRow({required this.index, required this.row, required this.texts, required this.onPick});

  final int index;
  final MicTestRow row;
  final MicTestTexts texts;
  final void Function(String name)? onPick;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final enabled = onPick != null;
    return Semantics(
      inMutuallyExclusiveGroup: true,
      checked: row.selected,
      enabled: enabled,
      child: InkWell(
        key: ValueKey('box-mic-test-row-$index'),
        onTap: enabled ? () => onPick!(row.name) : null,
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          decoration: BoxDecoration(
            color: row.selected ? SurauColors.tealSoft.withValues(alpha: 0.5) : null,
            border: BorderDirectional(
              top: const BorderSide(color: SurauColors.line),
              start: BorderSide(color: row.selected ? SurauColors.teal : Colors.transparent, width: 3),
            ),
          ),
          padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(padding: const EdgeInsets.only(top: 2), child: _Radio(selected: row.selected, enabled: enabled)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(row.name, style: text.titleSmall!.copyWith(color: enabled ? null : SurauColors.muted)),
                    const SizedBox(height: 6),
                    _Chip(key: ValueKey('box-mic-test-chip-$index'), state: row.state, texts: texts),
                  ],
                ),
              ),
              if (row.meter != null) ...[
                const SizedBox(width: 12),
                Padding(padding: const EdgeInsets.only(top: 4), child: LevelMeter(row.meter!)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Radio extends StatelessWidget {
  const _Radio({required this.selected, required this.enabled});

  final bool selected;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final ring = selected && enabled ? SurauColors.teal : SurauColors.outline;
    return Container(
      width: 20,
      height: 20,
      decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: ring, width: 2)),
      child: selected
          ? Padding(
              padding: const EdgeInsets.all(3),
              child: DecoratedBox(
                decoration: BoxDecoration(shape: BoxShape.circle, color: enabled ? SurauColors.teal : SurauColors.outline),
              ),
            )
          : null,
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.state, required this.texts});

  final MicTestState state;
  final MicTestTexts texts;

  @override
  Widget build(BuildContext context) {
    final (label, fg, bg, icon) = switch (state) {
      MicTestState.sound => (texts.sound, LiveColors.healthyInk, LiveColors.healthyInk.withValues(alpha: 0.12), Icons.check_rounded),
      MicTestState.silent => (texts.silent, SurauColors.danger, SurauColors.dangerSoft, Icons.close_rounded),
      MicTestState.failed => (texts.failed, LiveColors.waitingInk, LiveColors.waitingSoft, Icons.warning_amber_rounded),
      MicTestState.testing => (texts.testing, SurauColors.text, SurauColors.paperDeep, null),
      MicTestState.none => (texts.none, SurauColors.text, SurauColors.paperDeep, null),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (state == MicTestState.testing) ...[
            SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 2, color: fg)),
            const SizedBox(width: 6),
          ] else if (icon != null) ...[
            Icon(icon, size: 15, color: fg),
            const SizedBox(width: 5),
          ],
          Flexible(
            child: Text(label, style: Theme.of(context).textTheme.labelMedium!.copyWith(color: fg, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}
