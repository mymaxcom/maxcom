// The ONE questions screen (step `questions`): Q1 whose data is kept, Q2 which box becomes the master, what is
// replaced, the backup line, the finance tick, the folded details and one button worded with the answer. It is the
// whole agreement; there is no summary after it. Both admins see the same answers at once; any change makes the next
// revision and clears both agreements, and "Setuju" counts only for the revision on the screen.

import 'package:flutter/material.dart';

import '../../app/app_lang.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show ErrorLine, SectionLabel;
import '../common/ltr.dart' show ltr;
import 'link_models.dart';
import 'link_people_view.dart';
import 'link_text.dart';
import 'link_widgets.dart';

class LinkQuestionsView extends StatelessWidget {
  const LinkQuestionsView({
    super.key,
    required this.session,
    required this.caseX,
    required this.nowLocal,
    required this.lang,
    required this.busy,
    required this.staleNotice,
    required this.error,
    required this.onKeep,
    required this.onMaster,
    required this.onTick,
    required this.onAgree,
    this.onRole,
    this.onSame,
    this.onPhones,
  });

  final LinkSession session;

  /// `checks.caseX`: the kept data and the master may be different boxes in this release.
  final bool caseX;

  /// The phone's time now, in its own zone (the backup line).
  final DateTime nowLocal;
  final AppLang lang;
  final bool busy;
  final bool staleNotice;

  /// The refusal of the last action, when it is one to show here.
  final String? error;
  final void Function(LinkSide side) onKeep;
  final void Function(LinkSide side) onMaster;
  final void Function(bool on) onTick;
  final VoidCallback onAgree;

  /// The people part (null on a screen that has no people answers): one role of the other box added for a person,
  /// and "same person" for a same-name question.
  final void Function(String phoneKey, String? role)? onRole;
  final void Function(String id, bool same)? onSame;

  /// Q3: the phones of the other box's people (null on a screen that does not ask it).
  final void Function(LinkPhones phones)? onPhones;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final a = session.answers;
    final show = session.face(LinkSide.show);
    final scan = session.face(LinkSide.scan);
    if (a == null || show == null || scan == null) return const SizedBox.shrink();
    final faces = {LinkSide.show: show, LinkSide.scan: scan};
    final kept = faces[a.keep]!;
    final replaced = faces[a.keep.other]!;
    final master = faces[a.master]!;
    final advised = adviseMaster(show, scan);
    final newBox = session.oneNewBox;
    final tickNeeded = a.replaced.finance > 0;
    final canAgree = !busy && !session.ownAgreed && (!tickNeeded || a.financeTick);
    final shownError = error;

    Widget q1Card(LinkSide side) {
      final f = faces[side]!;
      return LinkBoxCard(
        key: ValueKey('link-q1-${side.name}'),
        title: f.name,
        subtitle: linkHardware(s, f.facts),
        selected: a.keep == side,
        enabled: session.fixedKeep == null && f.setUp,
        onTap: () => onKeep(side),
        badges: [if (side == session.role) s.linkBoxThis],
        children: f.setUp
            ? [
                LinkFact(s.linkFactContent, s.linkFactContentValue(f.facts.content, f.facts.posters, f.facts.videos)),
                LinkFact(s.linkFactFinance, '${f.facts.finance}'),
                LinkFact(s.linkFactPeople, '${f.facts.people}'),
                LinkFact(
                  s.linkFactLastEdit,
                  f.facts.lastEditAt == null ? s.linkNoEdit : linkDateWords(f.facts.lastEditAt!.toLocal(), lang),
                ),
              ]
            : [Text(s.linkFixedNew, style: text.bodyMedium)],
      );
    }

    Widget q2Card(LinkSide side) {
      final f = faces[side]!;
      final fixed = session.fixedMaster != null;
      return LinkBoxCard(
        key: ValueKey('link-q2-${side.name}'),
        title: f.name,
        subtitle: linkHardware(s, f.facts),
        selected: a.master == side,
        enabled: !fixed && (caseX || side == a.keep),
        onTap: () => onMaster(side),
        badges: [
          if (side == session.role) s.linkBoxThis,
          if (!fixed && advised == side) s.linkRecommended,
        ],
        children: [
          LinkFact(s.linkFactDevice, linkHardware(s, f.facts)),
          LinkFact(s.linkFactStorage, ltr(linkBytesWords(f.facts.freeBytes))),
          LinkFact(s.linkFactYoutube, f.facts.youtube ? s.linkYes : s.linkNo),
          LinkFact(s.linkFactCloud, f.facts.cloud ? s.linkYes : s.linkNo),
        ],
      );
    }

    String fixedReason(LinkSide side) {
      final f = faces[side]!;
      return f.followers > 0 ? s.linkFixedFollowers(f.name) : s.linkFixedNew;
    }

    final orderedSides = [LinkSide.show, LinkSide.scan];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (staleNotice) ...[
          LinkNote(
            key: const ValueKey('link-stale'),
            tone: LinkTone.gold,
            icon: Icons.sync_problem_rounded,
            text: s.linkStaleNotice,
          ),
          const SizedBox(height: 12),
        ],
        LinkNote(
          tone: LinkTone.teal,
          icon: Icons.link_rounded,
          title: s.linkQIntroTitle,
          text: s.linkQIntro(show.name, scan.name),
        ),
        const SizedBox(height: 20),
        LinkQuestionTitle(number: 1, title: s.linkQ1Title, hint: s.linkQ1Hint),
        const SizedBox(height: 10),
        for (final side in orderedSides) ...[q1Card(side), const SizedBox(height: 10)],
        if (session.fixedKeep != null)
          LinkNote(
            key: const ValueKey('link-q1-fixed'),
            tone: LinkTone.grey,
            icon: Icons.lock_outline_rounded,
            text: fixedReason(session.fixedKeep!),
          ),
        const SizedBox(height: 16),
        LinkQuestionTitle(number: 2, title: s.linkQ2Title, hint: s.linkQ2Hint),
        const SizedBox(height: 10),
        for (final side in orderedSides) ...[q2Card(side), const SizedBox(height: 10)],
        if (session.fixedMaster != null)
          LinkNote(
            key: const ValueKey('link-q2-fixed'),
            tone: LinkTone.grey,
            icon: Icons.lock_outline_rounded,
            text: fixedReason(session.fixedMaster!),
          )
        else ...[
          LinkNote(
            key: const ValueKey('link-advice'),
            tone: LinkTone.grey,
            icon: Icons.thumb_up_alt_outlined,
            text: s.linkAdvice(faces[advised]!.name, linkHardware(s, faces[advised]!.facts)),
          ),
          if (!caseX) ...[
            const SizedBox(height: 8),
            LinkNote(
              key: const ValueKey('link-casex-off'),
              tone: LinkTone.grey,
              icon: Icons.info_outline_rounded,
              text: s.linkCaseXOff,
            ),
          ],
        ],
        if (a.crossed) ...[
          const SizedBox(height: 8),
          LinkNote(
            key: const ValueKey('link-cross'),
            tone: LinkTone.gold,
            icon: Icons.swap_horiz_rounded,
            title: s.linkCrossTitle,
            text: s.linkCrossBody(kept.name, master.name, faces[a.master.other]!.name),
          ),
        ],
        const SizedBox(height: 20),
        SectionLabel(s.linkReplacedTitle),
        if (replaced.setUp)
          LinkNote(
            key: const ValueKey('link-replaced'),
            tone: LinkTone.red,
            icon: Icons.warning_amber_rounded,
            text: s.linkReplacedLine(
              replaced.name,
              a.replaced.content,
              a.replaced.posters,
              a.replaced.videos,
              a.replaced.finance,
              kept.name,
            ),
          )
        else
          LinkNote(
            key: const ValueKey('link-replaced'),
            tone: LinkTone.teal,
            icon: Icons.check_circle_outline_rounded,
            text: s.linkReplacedNone(kept.name),
          ),
        if (!newBox) ...[
          const SizedBox(height: 10),
          LinkNote(
            key: const ValueKey('link-backup'),
            tone: LinkTone.gold,
            icon: Icons.shield_outlined,
            text: s.linkBackupLine(linkNowWords(nowLocal, lang)),
          ),
        ],
        if (tickNeeded) ...[
          const SizedBox(height: 10),
          Card(
            margin: EdgeInsets.zero,
            child: CheckboxListTile(
              key: const ValueKey('link-tick'),
              value: a.financeTick,
              onChanged: busy ? null : (v) => onTick(v == true),
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(s.linkFinanceTick(replaced.name)),
              subtitle: Text(s.linkFinanceCount(a.replaced.finance, replaced.name)),
            ),
          ),
        ],
        // Q3 is asked when people move: the box whose data is replaced has people, or the data is moved to the master.
        if (!newBox || a.crossed) ...[
          const SizedBox(height: 20),
          LinkQuestionTitle(number: 3, title: s.linkQ3Title, hint: s.linkQ3Hint(replaced.name)),
          const SizedBox(height: 10),
          LinkBoxCard(
            key: const ValueKey('link-q3-direct'),
            title: s.linkQ3Direct,
            subtitle: s.linkQ3DirectHint,
            selected: a.phones == LinkPhones.direct,
            enabled: !busy,
            onTap: () => onPhones?.call(LinkPhones.direct),
            children: const [],
          ),
          const SizedBox(height: 10),
          LinkBoxCard(
            key: const ValueKey('link-q3-code'),
            title: s.linkQ3Code,
            subtitle: s.linkQ3CodeHint,
            selected: a.phones == LinkPhones.code,
            enabled: !busy,
            onTap: () => onPhones?.call(LinkPhones.code),
            children: const [],
          ),
        ],
        if (session.people != null && !newBox) ...[
          const SizedBox(height: 20),
          LinkPeopleSection(
            people: session.people!,
            otherName: replaced.name,
            busy: busy,
            onRole: onRole ?? (_, _) {},
            onSame: onSame ?? (_, _) {},
          ),
        ],
        const SizedBox(height: 10),
        Card(
          margin: EdgeInsets.zero,
          child: ExpansionTile(
            key: const ValueKey('link-more'),
            title: Text(s.linkMore),
            shape: const Border(),
            collapsedShape: const Border(),
            childrenPadding: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 12),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!newBox) _MoreLine(s.linkMorePeople(show.facts.people, show.name, scan.facts.people, scan.name)),
              if (kept.facts.youtube)
                _MoreLine(s.linkMoreYoutubeKept(kept.name))
              else if (replaced.facts.youtube)
                _MoreLine(s.linkMoreYoutubeAgain),
              if (show.facts.cloud || scan.facts.cloud) _MoreLine(s.linkMoreCloud),
              _MoreLine(s.linkMoreCamera),
              _MoreLine(s.linkMoreBrowser),
            ],
          ),
        ),
        const SizedBox(height: 20),
        if (shownError != null) ...[ErrorLine(linkCodeText(s, shownError)), const SizedBox(height: 10)],
        FilledButton(
          key: const ValueKey('link-agree'),
          onPressed: canAgree ? onAgree : null,
          child: Text(
            session.ownAgreed ? s.linkWaitingFor(session.peer?.name ?? '') : s.linkAgreeButton(kept.name, master.name),
            textAlign: TextAlign.center,
          ),
        ),
        const SizedBox(height: 10),
        _AgreedLine(
          key: const ValueKey('link-agreed-own'),
          name: session.own.name,
          agreed: session.ownAgreed,
        ),
        _AgreedLine(
          key: const ValueKey('link-agreed-peer'),
          name: session.peer?.name ?? '',
          agreed: session.peerAgreed,
        ),
        if (tickNeeded && !a.financeTick) ...[
          const SizedBox(height: 6),
          Text(s.linkFinanceFirst, style: text.bodySmall),
        ],
        const SizedBox(height: 6),
        Text(s.linkAnswersChangeable, style: text.bodySmall),
      ],
    );
  }
}

class _MoreLine extends StatelessWidget {
  const _MoreLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Align(
      alignment: AlignmentDirectional.centerStart,
      child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
    ),
  );
}

class _AgreedLine extends StatelessWidget {
  const _AgreedLine({super.key, required this.name, required this.agreed});

  final String name;
  final bool agreed;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Icon(
            agreed ? Icons.check_circle_rounded : Icons.hourglass_empty_rounded,
            size: 18,
            color: agreed ? SurauColors.success : SurauColors.muted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              agreed ? s.linkNameAgreed(name) : s.linkNameNotYet(name),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}
