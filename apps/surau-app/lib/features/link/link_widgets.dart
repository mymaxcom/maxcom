// The small pieces the link screens share: a note with an icon, a label and value row, a section title with its
// number, the box card of the two questions, and the six digits of the matching code.

import 'package:flutter/material.dart';

import '../../app/theme.dart';

enum LinkTone { teal, gold, red, grey }

/// A soft box with an icon: the notes of the mockups (teal, gold, red and grey).
class LinkNote extends StatelessWidget {
  const LinkNote({super.key, required this.tone, required this.icon, required this.text, this.title});

  final LinkTone tone;
  final IconData icon;
  final String text;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    final (bg, fg, ink) = switch (tone) {
      LinkTone.teal => (SurauColors.tealSoft.withValues(alpha: 0.6), SurauColors.teal, SurauColors.text),
      LinkTone.gold => (SurauColors.goldSoft, const Color(0xFF7A5A12), SurauColors.ink),
      LinkTone.red => (SurauColors.dangerSoft, SurauColors.danger, SurauColors.dangerInk),
      LinkTone.grey => (SurauColors.paperDeep, SurauColors.muted, SurauColors.text),
    };
    return Container(
      padding: const EdgeInsetsDirectional.fromSTEB(14, 12, 14, 12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(SurauTheme.radiusControl)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(top: 2),
            child: Icon(icon, size: 22, color: fg),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title != null) Text(title!, style: style.titleSmall!.copyWith(color: ink)),
                Text(text, style: style.bodyMedium!.copyWith(color: ink)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// `label` over `value`, the facts of a box card.
class LinkFact extends StatelessWidget {
  const LinkFact(this.label, this.value, {super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(flex: 4, child: Text(label, style: style.bodyMedium!.copyWith(color: SurauColors.muted))),
          const SizedBox(width: 8),
          Expanded(flex: 6, child: Text(value, style: style.bodyMedium)),
        ],
      ),
    );
  }
}

/// "1  Data kotak mana yang dikekalkan?" over its one line of help.
class LinkQuestionTitle extends StatelessWidget {
  const LinkQuestionTitle({super.key, required this.number, required this.title, this.hint});

  final int number;
  final String title;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: const BoxDecoration(color: SurauColors.teal, shape: BoxShape.circle),
              child: Text('$number', style: style.labelLarge!.copyWith(color: Colors.white)),
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(title, style: style.titleMedium)),
          ],
        ),
        if (hint != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 38, top: 4),
            child: Text(hint!, style: style.bodyMedium!.copyWith(color: SurauColors.muted)),
          ),
      ],
    );
  }
}

/// One of the two cards of a question: a box with its facts, a tap to choose it, greyed when it cannot be chosen.
class LinkBoxCard extends StatelessWidget {
  const LinkBoxCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.enabled,
    required this.onTap,
    required this.children,
    this.badges = const [],
  });

  final String title;
  final String subtitle;
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;
  final List<Widget> children;
  final List<String> badges;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    final card = Material(
      color: selected ? SurauColors.tealSoft.withValues(alpha: 0.45) : SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        side: BorderSide(color: selected ? SurauColors.teal : SurauColors.line, width: selected ? 2 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsetsDirectional.only(top: 2, end: 10),
                    child: Icon(
                      selected ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded,
                      size: 22,
                      color: selected ? SurauColors.teal : SurauColors.outline,
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: style.titleSmall),
                        Text(subtitle, style: style.bodySmall!.copyWith(color: SurauColors.muted)),
                      ],
                    ),
                  ),
                ],
              ),
              if (badges.isNotEmpty)
                Padding(
                  padding: const EdgeInsetsDirectional.only(start: 32, top: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      for (final b in badges)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: SurauColors.goldSoft,
                            borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                          ),
                          child: Text(b, style: style.labelSmall!.copyWith(color: SurauColors.ink)),
                        ),
                    ],
                  ),
                ),
              if (children.isNotEmpty)
                Padding(
                  padding: const EdgeInsetsDirectional.only(start: 32, top: 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
                ),
            ],
          ),
        ),
      ),
    );
    return enabled ? card : Opacity(opacity: 0.62, child: card);
  }
}

/// The six digits in two groups of three, always read left to right.
class LinkCodeDigits extends StatelessWidget {
  const LinkCodeDigits(this.groups, {super.key});

  /// `482 193`.
  final String groups;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Directionality(
      key: const ValueKey('link-code-ltr'),
      textDirection: TextDirection.ltr,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 18),
        decoration: BoxDecoration(
          color: SurauColors.glass,
          borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        ),
        child: Text(
          groups,
          key: const ValueKey('link-code'),
          textAlign: TextAlign.center,
          style: style.displaySmall!.copyWith(
            color: SurauColors.gold,
            letterSpacing: 6,
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ),
    );
  }
}
