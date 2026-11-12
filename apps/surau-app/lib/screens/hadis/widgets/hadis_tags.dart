// The small pieces every hadis screen is built from, drawn after the mockup:
// the tags on a row (source badge, grade, attribution, `Panjang untuk TV`...),
// the online line, a segmented control, a tinted note, the `-` value `+`
// stepper, section titles and the remove dialog.

import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../hadis/hadis_api.dart';
import '../../../hadis/hadis_list_controller.dart';
import '../../../l10n/generated/s.dart';

/// HadeethEnc's own badge colours (the mockup's `--heBlue`, `--heSoft`).
abstract final class HadisColors {
  static const Color heBlue = Color(0xFF2F527A);
  static const Color heSoft = Color(0xFFE3ECF6);
  static const Color updateFill = Color(0xFFFFF1C9);
  static const Color updateInk = Color(0xFF7A5600);
  static const Color updateLine = Color(0xFFE9CF94);
}

class HadisTagChip extends StatelessWidget {
  const HadisTagChip({
    super.key,
    required this.label,
    required this.background,
    required this.foreground,
    this.icon,
    this.border,
  });

  final String label;
  final Color background;
  final Color foreground;
  final IconData? icon;
  final Color? border;

  factory HadisTagChip.of(S s, HadisTag tag) {
    switch (tag.kind) {
      case HadisTagKind.own:
        return HadisTagChip.own(s);
      case HadisTagKind.hadeethenc:
        return HadisTagChip.provider(s);
      case HadisTagKind.grade:
        return HadisTagChip(
          label: tag.value ?? '',
          background: SurauColors.tealSoft,
          foreground: SurauColors.teal,
        );
      case HadisTagKind.attribution:
        return HadisTagChip.attribution(tag.value ?? '');
      case HadisTagKind.longText:
        return HadisTagChip(
          label: s.hadisTagLong,
          background: SurauColors.goldSoft,
          foreground: HadisColors.updateInk,
        );
      case HadisTagKind.textUpdated:
        return HadisTagChip(
          label: s.hadisTagUpdated,
          icon: Icons.refresh_rounded,
          background: HadisColors.updateFill,
          foreground: HadisColors.updateInk,
          border: HadisColors.updateLine,
        );
      case HadisTagKind.hidden:
        return HadisTagChip(
          label: s.hadisTagHidden,
          background: SurauColors.paperDeep,
          foreground: SurauColors.muted,
        );
      case HadisTagKind.gradeBlocked:
        return HadisTagChip(
          label: s.hadisTagGradeBlocked,
          icon: Icons.visibility_off_rounded,
          background: HadisColors.updateFill,
          foreground: HadisColors.updateInk,
          border: HadisColors.updateLine,
        );
      case HadisTagKind.unstatedSource:
        return HadisTagChip.attribution(s.hadisTagUnstated);
      case HadisTagKind.pending:
        return HadisTagChip(
          label: s.hadisTagPending,
          icon: Icons.schedule_rounded,
          background: SurauColors.paperDeep,
          foreground: SurauColors.muted,
        );
    }
  }

  factory HadisTagChip.own(S s) => HadisTagChip(
    label: s.hadisFilterOwn,
    icon: Icons.edit_rounded,
    background: SurauColors.paperDeep,
    foreground: SurauColors.glass,
  );

  factory HadisTagChip.provider(S s) => HadisTagChip(
    label: s.hadisFilterProvider,
    icon: Icons.bookmark_rounded,
    background: HadisColors.heSoft,
    foreground: HadisColors.heBlue,
  );

  factory HadisTagChip.attribution(String label) => HadisTagChip(
    label: label,
    background: SurauColors.card,
    foreground: SurauColors.muted,
    border: SurauColors.line,
  );

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(6),
        border: border == null ? null : Border.all(color: border!),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: foreground),
            const SizedBox(width: 5),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                height: 18 / 11.5,
                color: foreground,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The tags of a saved hadis, with the typed source of an own-list hadis
/// after its badge (the controller only gives its kind).
List<Widget> hadisRowTags(S s, HadisItem item, List<HadisTag> tags) {
  final out = <Widget>[];
  for (final t in tags) {
    out.add(HadisTagChip.of(s, t));
    if (t.kind == HadisTagKind.own &&
        item.source.isNotEmpty &&
        !tags.any((x) => x.kind == HadisTagKind.unstatedSource)) {
      out.add(HadisTagChip.attribution(item.source));
    }
  }
  return out;
}

/// `MAXCOM dalam talian.` / `MAXCOM tiada internet.`
class HadisNetBar extends StatelessWidget {
  const HadisNetBar({super.key, required this.online});

  final bool online;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final dot = online ? const Color(0xFF2E9E5B) : SurauColors.danger;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: SurauColors.card,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.line),
      ),
      child: Row(
        children: [
          Container(
            width: 9,
            height: 9,
            decoration: BoxDecoration(
              color: dot,
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: dot.withValues(alpha: 0.18), spreadRadius: 3)],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: online ? s.hadisNetOnlineTitle : s.hadisNetOfflineTitle,
                    style: const TextStyle(color: SurauColors.text, fontWeight: FontWeight.w700),
                  ),
                  TextSpan(text: ' ${online ? s.hadisNetOnlineBody : s.hadisNetOfflineBody}'),
                ],
              ),
              style: text.bodySmall!.copyWith(fontSize: 13.5),
            ),
          ),
        ],
      ),
    );
  }
}

class HadisSegment<T> {
  const HadisSegment(this.value, this.label, {this.enabled = true, this.key});

  final T value;
  final String label;
  final bool enabled;
  final Key? key;
}

/// One choice of several, side by side.
class HadisSegments<T> extends StatelessWidget {
  const HadisSegments({
    super.key,
    required this.segments,
    required this.value,
    required this.onChanged,
  });

  final List<HadisSegment<T>> segments;
  final T value;
  final void Function(T value)? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: SurauColors.card,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.line),
      ),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < segments.length; i++) ...[
              if (i > 0) const VerticalDivider(width: 1, thickness: 1, color: SurauColors.line),
              Expanded(child: _segment(context, segments[i])),
            ],
          ],
        ),
      ),
    );
  }

  Widget _segment(BuildContext context, HadisSegment<T> seg) {
    final selected = seg.value == value;
    final active = seg.enabled && onChanged != null;
    final fg = !seg.enabled
        ? SurauColors.outline
        : selected
        ? SurauColors.glass
        : SurauColors.teal;
    return Material(
      color: selected ? SurauColors.tealSoft : SurauColors.card,
      child: InkWell(
        key: seg.key,
        onTap: active && !selected ? () => onChanged!(seg.value) : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 50),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  seg.label,
                  maxLines: 1,
                  style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: fg, height: 1.2),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum HadisNoteTone { teal, gold, red }

/// A tinted note with an icon.
class HadisNote extends StatelessWidget {
  const HadisNote({
    super.key,
    required this.tone,
    required this.icon,
    required this.child,
  });

  final HadisNoteTone tone;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      HadisNoteTone.teal => (SurauColors.tealSoft, SurauColors.glass),
      HadisNoteTone.gold => (SurauColors.goldSoft, SurauColors.ink),
      HadisNoteTone.red => (SurauColors.dangerSoft, SurauColors.dangerInk),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 24, color: fg),
          const SizedBox(width: 12),
          Expanded(
            child: DefaultTextStyle.merge(
              style: TextStyle(fontSize: 14.5, height: 1.45, color: fg),
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}

/// A muted section title with something on the right.
class HadisSection extends StatelessWidget {
  const HadisSection(this.label, {super.key, this.trailing, this.top = 20});

  final String label;
  final Widget? trailing;
  final double top;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(4, top, 4, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(
              label,
              style: text.titleSmall!.copyWith(color: SurauColors.muted),
            ),
          ),
          if (trailing != null) ...[
            const SizedBox(width: 12),
            Flexible(
              child: Align(alignment: Alignment.centerRight, child: trailing),
            ),
          ],
        ],
      ),
    );
  }
}

/// `-` value `+`, the mockup's stepper. [step] may be more than one.
class HadisStepper extends StatelessWidget {
  const HadisStepper({
    super.key,
    required this.keyPrefix,
    required this.value,
    required this.label,
    required this.min,
    required this.max,
    required this.onChanged,
    this.step = 1,
    this.dim = false,
  });

  final String keyPrefix;
  final int value;
  final String label;
  final int min;
  final int max;
  final int step;
  final bool dim;
  final void Function(int value)? onChanged;

  Widget _button(BuildContext context, IconData icon, String tooltip, Key key, int? next) {
    final enabled = onChanged != null && next != null;
    return SizedBox(
      width: 46,
      height: 46,
      child: Material(
        color: SurauColors.paper,
        child: InkWell(
          key: key,
          onTap: enabled ? () => onChanged!(next) : null,
          child: Tooltip(
            message: tooltip,
            child: Icon(icon, size: 22, color: enabled ? SurauColors.teal : SurauColors.outline),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Opacity(
      opacity: dim ? 0.45 : 1,
      child: Container(
        width: 150,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: SurauColors.card,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: SurauColors.line),
        ),
        child: Row(
          children: [
            _button(context, Icons.remove_rounded, s.settingsDecrease, ValueKey('$keyPrefix-minus'), value - step >= min ? value - step : null),
            Expanded(
              child: Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 1,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ),
            _button(context, Icons.add_rounded, s.settingsIncrease, ValueKey('$keyPrefix-plus'), value + step <= max ? value + step : null),
          ],
        ),
      ),
    );
  }
}

/// `Buang hadis ini?`: red and permanent for an own hadis, teal for a
/// HadeethEnc one (it can be added again). True when confirmed.
Future<bool> confirmRemoveHadis(
  BuildContext context, {
  required String title,
  required bool own,
}) async {
  final s = S.of(context);
  final excerpt = title.length > 90
      ? '${title.substring(0, 90).replaceFirst(RegExp(r'\s+\S*$'), '')}...'
      : title;
  final out = await showDialog<bool>(
    context: context,
    builder: (context) {
      final text = Theme.of(context).textTheme;
      return AlertDialog(
        title: Text(s.hadisRemoveTitle),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 500),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(excerpt, style: text.bodyMedium!.copyWith(fontStyle: FontStyle.italic)),
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: own ? HadisTagChip.own(s) : HadisTagChip.provider(s),
              ),
              const SizedBox(height: 12),
              HadisNote(
                tone: own ? HadisNoteTone.red : HadisNoteTone.teal,
                icon: own ? Icons.warning_rounded : Icons.info_outline_rounded,
                child: own
                    ? Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: '${s.hadisRemoveOwnBold} ',
                              style: const TextStyle(fontWeight: FontWeight.w700),
                            ),
                            TextSpan(text: s.hadisRemoveOwnBody),
                          ],
                        ),
                      )
                    : Text(s.hadisRemoveProviderBody),
              ),
            ],
          ),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton.icon(
            key: const ValueKey('hadis-remove-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: SurauColors.danger,
              foregroundColor: Colors.white,
            ),
            icon: const Icon(Icons.delete_rounded, size: 20),
            label: Text(own ? s.hadisRemoveOwnConfirm : s.hadisRemoveConfirm),
          ),
        ],
      );
    },
  );
  return out ?? false;
}
