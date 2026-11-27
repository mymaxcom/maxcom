// The people part of the questions screen: who is added from the box whose data is replaced, who is the same person
// (same phone number), every role difference with the kept roles staying and one control to add the other box's role,
// every same-name question ("Orang yang sama" / "Orang berbeza", the second is the default), the Pentadbir after the
// link and how many phones will be asked to move. Any answer here is a new revision and clears both agreements.
//
// Phone numbers never reach the screen: only the last four digits are shown. The full number is the key the box wants
// back in `answers.roles`; it travels as [LinkRoleDiff.phoneKey] from the controller to the request and is not drawn.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show SectionLabel;
import '../common/roles.dart';
import 'link_models.dart';

class LinkPeopleSection extends StatelessWidget {
  const LinkPeopleSection({
    super.key,
    required this.people,
    required this.otherName,
    required this.busy,
    required this.onRole,
    required this.onSame,
  });

  final LinkPeople people;

  /// The box whose data is replaced: its people are the ones added or compared.
  final String otherName;
  final bool busy;

  /// Adds [role] for the person with the key [phoneKey]; null takes the choice back.
  final void Function(String phoneKey, String? role) onRole;

  /// "Orang yang sama" (true) or "Orang berbeza" (false) for the person [id].
  final void Function(String id, bool same) onSame;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final groups = <Widget>[];

    String rolesOf(List<String> r) => r.isEmpty ? s.linkPeopleNoRole : rolesSentence(s, r);

    // Added from the other box.
    groups.add(
      Column(
        key: const ValueKey('link-people-add'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            people.add.isEmpty ? s.linkPeopleAddedNone(otherName) : s.linkPeopleAdded(people.add.length, otherName),
            style: text.titleSmall,
          ),
          for (final p in people.add)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                key: ValueKey('link-people-add-${p.id}'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(flex: 5, child: Text(p.name, style: text.bodyMedium)),
                  const SizedBox(width: 8),
                  Expanded(
                    flex: 5,
                    child: Text(rolesOf(p.roles), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );

    // The same person by phone number.
    if (people.same.isNotEmpty) {
      groups.add(
        Column(
          key: const ValueKey('link-people-same'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.linkPeopleSameTitle, style: text.titleSmall),
            for (final p in people.same)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(
                  key: ValueKey('link-people-same-${p.id}'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(flex: 5, child: Text(p.keptName, style: text.bodyMedium)),
                    const SizedBox(width: 8),
                    Expanded(
                      flex: 5,
                      child: Text(rolesOf(p.rolesAfter), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 6),
            Text(s.linkPeopleSameHint, style: text.bodySmall),
          ],
        ),
      );
    }

    // Roles that differ: the kept roles stay, one role of the other box may be added.
    if (people.roleDiffs.isNotEmpty) {
      groups.add(
        Column(
          key: const ValueKey('link-people-roles'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.linkPeopleRolesTitle, style: text.titleSmall),
            for (var i = 0; i < people.roleDiffs.length; i++) ...[
              const SizedBox(height: 10),
              _RoleDiffCard(
                index: i,
                diff: people.roleDiffs[i],
                otherName: otherName,
                busy: busy,
                onRole: onRole,
              ),
            ],
          ],
        ),
      );
    }

    // Same name, no matching number.
    if (people.nameAsk.isNotEmpty) {
      groups.add(
        Column(
          key: const ValueKey('link-people-names'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.linkPeopleNamesTitle, style: text.titleSmall),
            for (final a in people.nameAsk) ...[
              const SizedBox(height: 10),
              Text(s.linkPeopleNameAsk(a.name, otherName, a.keptName), style: text.bodyMedium),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  ChoiceChip(
                    key: ValueKey('link-same-${a.id}-yes'),
                    label: Text(s.linkPeopleSameYes),
                    selected: a.same,
                    onSelected: busy || a.same ? null : (_) => onSame(a.id, true),
                  ),
                  ChoiceChip(
                    key: ValueKey('link-same-${a.id}-no'),
                    label: Text(s.linkPeopleSameNo),
                    selected: !a.same,
                    onSelected: busy || !a.same ? null : (_) => onSame(a.id, false),
                  ),
                ],
              ),
            ],
          ],
        ),
      );
    }

    // Who administers afterwards: always shown.
    groups.add(
      Column(
        key: const ValueKey('link-people-admins'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.linkPeopleAdminsTitle, style: text.titleSmall),
          const SizedBox(height: 4),
          if (people.adminsAfter.isEmpty)
            Text(s.linkPeopleAdminsNone, style: text.bodyMedium!.copyWith(color: SurauColors.muted))
          else
            for (final name in people.adminsAfter) Padding(padding: const EdgeInsets.only(top: 2), child: Text(name, style: text.bodyMedium)),
        ],
      ),
    );

    // How many phones are asked to move.
    groups.add(
      Row(
        key: const ValueKey('link-people-tickets'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsetsDirectional.only(top: 2),
            child: Icon(Icons.phone_android_rounded, size: 20, color: SurauColors.teal),
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(s.linkPeopleTickets(people.tickets), style: text.bodyMedium)),
        ],
      ),
    );

    return Column(
      key: const ValueKey('link-people'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(s.linkPeopleTitle),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < groups.length; i++) ...[
                  if (i > 0) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Divider(height: 1)),
                  groups[i],
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _RoleDiffCard extends StatelessWidget {
  const _RoleDiffCard({
    required this.index,
    required this.diff,
    required this.otherName,
    required this.busy,
    required this.onRole,
  });

  final int index;
  final LinkRoleDiff diff;
  final String otherName;
  final bool busy;
  final void Function(String phoneKey, String? role) onRole;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    String rolesOf(List<String> r) => r.isEmpty ? s.linkPeopleNoRole : rolesSentence(s, r);
    return Container(
      key: ValueKey('link-role-$index'),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: SurauColors.paperDeep,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.linkPeopleRoleHead(diff.name, diff.phone4), style: text.titleSmall),
          const SizedBox(height: 4),
          Text(s.linkPeopleRoleStays(rolesOf(diff.keptRoles)), style: text.bodyMedium),
          Text(s.linkPeopleRoleOther(otherName, rolesOf(diff.otherRoles)), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          if (diff.addable.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(s.linkPeopleRoleAddLabel(otherName), style: text.bodyMedium),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final role in diff.addable)
                  FilterChip(
                    key: ValueKey('link-role-$index-$role'),
                    label: Text(roleLabel(s, role)),
                    selected: diff.chosen == role,
                    onSelected: busy ? null : (on) => onRole(diff.phoneKey, on ? role : null),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(s.linkPeopleRoleChangeNote, key: ValueKey('link-role-$index-note'), style: text.bodySmall),
          ],
        ],
      ),
    );
  }
}
