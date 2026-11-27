// The sheet of one side of the unlink ("Putuskan pautan: Ruang Muslimat"): what this box does with its data afterwards
// (the choices the box offers, each with its consequences in numbers), the finance tick of a follower that carries on,
// the people switch of the main box, and "Setuju". Drawn from the status alone, so the golden images and the tests use
// it without a box; the screen wires the callbacks to the controller.

import 'package:flutter/material.dart';

import '../../app/app_lang.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../common/ltr.dart';
import '../link/link_text.dart' show linkBytesWords;
import '../link/link_widgets.dart';
import 'unlink_models.dart';
import 'unlink_text.dart';

/// "Video ini tidak muat di Box itu dan tidak disalin", each with its size. The list is known only after the copy
/// started, so the sheet, the progress and the result all draw it from the same numbers.
class UnlinkVideosNotFit extends StatelessWidget {
  const UnlinkVideosNotFit({super.key, required this.videos});

  final List<UnlinkVideo> videos;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final style = Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.ink);
    return Column(
      key: const ValueKey('unlink-num-videos'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(top: 4), child: Text(s.unlinkVideosNotFitTitle, style: style)),
        for (final video in videos)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(s.unlinkVideoLine(video.title, ltr(linkBytesWords(video.bytes))), style: style),
          ),
      ],
    );
  }
}

class UnlinkSheetView extends StatelessWidget {
  const UnlinkSheetView({
    super.key,
    required this.session,
    required this.side,
    required this.lang,
    required this.tick,
    required this.busy,
    required this.staleNotice,
    required this.onChoose,
    required this.onRemovePeople,
    required this.onTick,
    required this.onAgree,
    required this.onCancel,
    this.error,
    this.toLocal = _local,
  });

  final UnlinkView session;
  final UnlinkSide side;
  final AppLang lang;

  /// The finance tick as this phone has it.
  final bool tick;
  final bool busy;
  final bool staleNotice;
  final String? error;
  final ValueChanged<UnlinkChoice> onChoose;
  final ValueChanged<bool> onRemovePeople;
  final ValueChanged<bool> onTick;
  final VoidCallback onAgree;
  final VoidCallback onCancel;
  final DateTime Function(DateTime) toLocal;

  static DateTime _local(DateTime d) => d.toLocal();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final v = session.sideView(side);
    final isFollower = side == UnlinkSide.follower;
    final choice = v.choice;
    final needsTick = isFollower && choice == UnlinkChoice.carryOn;
    final canAgree = choice != null && !busy && (!needsTick || tick);

    return Column(
      key: ValueKey('unlink-sheet-${side.name}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.unlinkSheetTitle(session.followerName), key: const ValueKey('unlink-sheet-title'), style: text.titleLarge),
        const SizedBox(height: 6),
        Text(
          isFollower ? s.unlinkSheetLineFollower : s.unlinkSheetLineMaster(session.followerName),
          style: text.bodyMedium!.copyWith(color: SurauColors.muted),
        ),
        if (isFollower) ...[
          const SizedBox(height: 12),
          if (v.eligible == UnlinkEligible.any)
            LinkNote(
              key: const ValueKey('unlink-eligible-any'),
              tone: LinkTone.gold,
              icon: Icons.admin_panel_settings_outlined,
              text: s.unlinkEligibleAny(session.followerName),
            ),
          if (v.eligible == UnlinkEligible.any) const SizedBox(height: 8),
          LinkNote(
            key: const ValueKey('unlink-phone-note'),
            tone: LinkTone.grey,
            icon: Icons.phone_android_rounded,
            text: s.unlinkPhoneNote(session.followerName),
          ),
        ],
        if (v.answeredBy != null && v.agreed == false && v.answeredBy!.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(s.unlinkAnsweredBy(v.answeredBy!), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        ],
        if (staleNotice) ...[
          const SizedBox(height: 12),
          LinkNote(key: const ValueKey('unlink-stale'), tone: LinkTone.gold, icon: Icons.sync_problem_rounded, text: s.linkStaleNotice),
        ],
        const SizedBox(height: 16),
        for (final c in UnlinkChoice.values)
          if (v.available(c) || v.choice == c) ...[
            LinkBoxCard(
              key: ValueKey('unlink-choice-${c.wire}'),
              title: _choiceTitle(s, c, v),
              subtitle: _choiceNote(s, c),
              selected: choice == c,
              enabled: !busy,
              onTap: choice == c ? null : () => onChoose(c),
              children: choice == c ? _details(context, s, c, v) : const [],
            ),
            const SizedBox(height: 10),
          ],
        if (error != null) ...[
          LinkNote(
            key: const ValueKey('unlink-error'),
            tone: LinkTone.red,
            icon: Icons.error_outline_rounded,
            text: unlinkCodeText(s, error!),
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 6),
        FilledButton(key: const ValueKey('unlink-agree'), onPressed: canAgree ? onAgree : null, child: Text(s.unlinkAgree)),
        const SizedBox(height: 8),
        TextButton(key: const ValueKey('unlink-cancel'), onPressed: busy ? null : onCancel, child: Text(s.actionCancel)),
      ],
    );
  }

  String _choiceTitle(S s, UnlinkChoice c, UnlinkSideView v) => switch (c) {
    UnlinkChoice.back => v.back.backupAt == null
        ? s.unlinkChoiceBackNoDate
        : s.unlinkChoiceBack(ltr(unlinkDate(toLocal(v.back.backupAt!), lang))),
    UnlinkChoice.carryOn => s.unlinkChoiceCarry,
    UnlinkChoice.empty => s.unlinkChoiceEmpty,
  };

  String _choiceNote(S s, UnlinkChoice c) => switch (c) {
    UnlinkChoice.back => s.unlinkChoiceBackNote,
    UnlinkChoice.carryOn => side == UnlinkSide.follower ? s.unlinkChoiceCarryNoteFollower : s.unlinkChoiceCarryNoteMaster,
    UnlinkChoice.empty => s.unlinkChoiceEmptyNote,
  };

  /// The consequences in numbers under the chosen card.
  List<Widget> _details(BuildContext context, S s, UnlinkChoice c, UnlinkSideView v) {
    final text = Theme.of(context).textTheme;
    final n = v.numbers;
    final muted = text.bodySmall!.copyWith(color: SurauColors.ink);
    Widget line(String t, {Key? key}) => Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(t, key: key, style: muted),
    );
    final out = <Widget>[];
    switch (c) {
      case UnlinkChoice.back:
        final at = v.back.backupAt;
        final date = at == null ? null : ltr(unlinkDate(toLocal(at), lang));
        final changes = n.changesSinceBackup;
        if (changes != null) {
          out.add(
            line(
              changes == 0 || date == null ? s.unlinkNumNoChanges : s.unlinkNumChanges(changes, date),
              key: const ValueKey('unlink-num-changes'),
            ),
          );
        }
        if (date != null && (n.peopleBack.isNotEmpty || n.peopleAbsent.isNotEmpty)) {
          out.add(line(s.unlinkNumPeopleLead(date)));
        }
        if (n.peopleBack.isNotEmpty) {
          out.add(line(s.unlinkNumPeopleBack(n.peopleBack.length, unlinkNames(s, n.peopleBack)), key: const ValueKey('unlink-num-back')));
        }
        if (n.peopleAbsent.isNotEmpty) {
          out.add(line(s.unlinkNumPeopleAbsent(n.peopleAbsent.length, unlinkNames(s, n.peopleAbsent)), key: const ValueKey('unlink-num-absent')));
        }
        out.add(line(s.unlinkNumKept7, key: const ValueKey('unlink-num-kept')));
        // A restore revokes every phone of this box by design; the first Pentadbir comes back with the recovery code.
        if (side == UnlinkSide.master) out.add(line(s.unlinkNumBackRecovery, key: const ValueKey('unlink-num-recovery')));
      case UnlinkChoice.carryOn:
        if (side == UnlinkSide.follower) {
          final left = n.financeEntriesLeft;
          if (left != null) out.add(line(s.unlinkNumFinance(left), key: const ValueKey('unlink-num-finance')));
          if (n.videosNotFit.isNotEmpty) out.add(UnlinkVideosNotFit(videos: n.videosNotFit));
          out.add(
            CheckboxListTile(
              key: const ValueKey('unlink-finance-tick'),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              value: tick,
              onChanged: busy ? null : (on) => onTick(on ?? false),
              title: Text(s.unlinkTickLabel, style: text.bodyMedium),
            ),
          );
        } else if (n.peopleFromFollower != null) {
          out.add(
            SwitchListTile(
              key: const ValueKey('unlink-remove-people'),
              contentPadding: EdgeInsets.zero,
              dense: true,
              value: v.removePeople,
              onChanged: busy ? null : onRemovePeople,
              title: Text(s.unlinkRemovePeople(session.followerName, n.peopleFromFollower!), style: text.bodyMedium),
            ),
          );
        }
      case UnlinkChoice.empty:
        break;
    }
    if (c != UnlinkChoice.empty) {
      out.add(line(unlinkYoutubeText(s, v.youtube), key: const ValueKey('unlink-youtube')));
    }
    return out;
  }
}
