// Role names in plain BM, and the calm sentence form for a person who
// holds several: "Pentadbir", "Pentadbir dan Media",
// "Pentadbir, Bendahari dan Media". Unknown roles are shown as given.

import '../../l10n/generated/s.dart';

/// Display order, the box's own: admin first, then money, media, committee.
const List<String> roleOrder = ['superadmin', 'admin', 'live', 'treasurer', 'media', 'ajk'];

String roleLabel(S s, String role) => switch (role) {
  'superadmin' => s.roleSuperadmin,
  'admin' => s.roleAdmin,
  'treasurer' => s.roleTreasurer,
  'live' => s.roleLive,
  'media' => s.roleMedia,
  'ajk' => s.roleAjk,
  'support' => s.ra5RoleSupport,
  _ => role,
};

/// Every role the person holds, in display order, joined with the language's
/// comma and a final "dan"; empty string for no roles.
String rolesSentence(S s, List<String> roles) {
  final seen = <String>{};
  final ordered = <String>[
    for (final r in roleOrder)
      if (roles.contains(r) && seen.add(r)) r,
    for (final r in roles)
      if (seen.add(r)) r,
  ];
  final labels = ordered.map((r) => roleLabel(s, r)).toList(growable: false);
  if (labels.isEmpty) return '';
  if (labels.length == 1) return labels.single;
  final head = labels.sublist(0, labels.length - 1).join(s.ra5ListSeparator);
  return s.rolesJoin(head, labels.last);
}
