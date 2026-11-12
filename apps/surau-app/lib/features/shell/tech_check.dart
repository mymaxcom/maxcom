// The failure-only technical check (operator rule 2026-11-04): certificate
// renewal on the box is automatic, so the dashboard normally says nothing
// about it. Only the admin's app reads `GET /api/pki/status`, and only when
// the certificate is under [PkiStatus.warnDays] AND the renewal is not
// working does the dashboard show one calm line. Any read error (box away,
// 403, a hiccup) shows nothing.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';

/// `GET /api/pki/status` (admin only): the fields the check needs.
class PkiStatus {
  const PkiStatus({this.leafDaysLeft, this.lastRenewOk, this.lastRenewAttempt});

  factory PkiStatus.fromJson(Map<String, dynamic> j) => PkiStatus(
    leafDaysLeft: (j['leafDaysLeft'] as num?)?.toInt(),
    lastRenewOk: j['lastRenewOk'] is bool ? j['lastRenewOk'] as bool : null,
    lastRenewAttempt: j['lastRenewAttempt'] as String?,
  );

  /// Below this many days a failing renewal is worth a line.
  static const int warnDays = 14;

  final int? leafDaysLeft;

  /// Null when the box has not tried a renewal yet (no log line).
  final bool? lastRenewOk;
  final String? lastRenewAttempt;

  /// Under [warnDays] with no renewal known to have worked: the last
  /// attempt failed, or there has been no successful attempt at all.
  bool get needsCheck {
    final days = leafDaysLeft;
    return days != null && days < warnDays && lastRenewOk != true;
  }
}

/// Null unless the person is an admin and the box answered the route:
/// every error reads as "nothing to say". Read once per unlock (the
/// client and session providers rebuild on enrol and unlock).
final techCheckProvider = FutureProvider<PkiStatus?>((ref) async {
  if (!ref.watch(rolesProvider).contains('admin')) return null;
  final client = ref.watch(enrolledClientProvider).value;
  final session = ref.watch(sessionProvider);
  if (client == null || session == null) return null;
  try {
    final body = await client.getJson('/api/pki/status', token: session.token);
    return PkiStatus.fromJson(body);
  } catch (_) {
    return null;
  }
});
