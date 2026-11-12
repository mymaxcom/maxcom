// The people-and-place part of the enrolment payload: which surau, the
// roles the person will hold, who invited them and whom to call for help.
// These fields are additive (contract 2026-11-04); a payload from an older
// box lacks them and every field here is then null or empty. The required
// fields are validated by `EnrolPayload.parse` (lib/box/payload.dart); this
// reader never throws, so a strict payload stays the single gate.

import 'dart:convert';

import 'surau_info.dart';

class EnrolPayloadExtras {
  const EnrolPayloadExtras({
    this.surau,
    this.help,
    this.roles = const [],
    this.invitedBy,
  });

  static const EnrolPayloadExtras none = EnrolPayloadExtras();

  /// Name and kind of the surau (no address or help; see [help]).
  final SurauInfo? surau;
  final HelpContact? help;

  /// Roles of the user being enrolled, in the box's words
  /// (`admin`, `treasurer`, `media`, `ajk`).
  final List<String> roles;

  /// Display name of the admin who created the invitation.
  final String? invitedBy;

  /// The surau with its help contact folded in, ready for the store.
  SurauInfo? get surauWithHelp {
    final s = surau;
    if (s == null) return null;
    return SurauInfo(name: s.name, kind: s.kind, help: help);
  }

  static const String _prefix = 'surau1:';

  /// Reads the optional fields of a `surau1:` payload; [none] for anything
  /// unreadable.
  static EnrolPayloadExtras parse(String text) {
    final s = text.trim();
    if (!s.startsWith(_prefix) || s.length > 4096) return none;
    final Object? raw;
    try {
      final body = s.substring(_prefix.length);
      final padded = body + '=' * ((4 - body.length % 4) % 4);
      raw = jsonDecode(utf8.decode(base64Url.decode(padded)));
    } on FormatException {
      return none;
    } on ArgumentError {
      return none;
    }
    if (raw is! Map<String, dynamic>) return none;

    final surauRaw = raw['surau'];
    final helpRaw = raw['help'];
    final rolesRaw = raw['roles'];
    final invitedBy = raw['invitedBy'];

    final help = helpRaw is Map<String, dynamic>
        ? HelpContact.fromJson(helpRaw)
        : null;
    return EnrolPayloadExtras(
      surau: surauRaw is Map<String, dynamic>
          ? SurauInfo.fromJson(surauRaw)
          : null,
      help: help == null || help.isEmpty ? null : help,
      roles: rolesRaw is List
          ? rolesRaw.whereType<String>().toList(growable: false)
          : const [],
      invitedBy: invitedBy is String && invitedBy.trim().isNotEmpty
          ? invitedBy.trim()
          : null,
    );
  }
}
