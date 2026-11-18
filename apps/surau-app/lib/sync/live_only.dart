// The operations that need a live connection to the box or the cloud
// (Plan 6 Task 8). They are never queued: the app sends them straight to the
// network and, when no base answers, refuses them aloud with [LiveOnly], so
// the person is told instead of an edit vanishing. Task 9's dialog shows
// [liveOnlyList].

import '../l10n/generated/s.dart';

/// The wording shown when a live-only operation has no connection. Equals
/// `liveOnlyNeedsConnection` in app_ms.arb (a test checks). The operator's
/// rule keeps the word "kotak" out of user text: the box is MAXCOM.
const String liveOnlyMessage = 'Perlukan sambungan ke MAXCOM atau awan';

/// A live-only operation was attempted with neither the box nor the cloud
/// reachable. Nothing was sent.
class LiveOnly implements Exception {
  const LiveOnly(this.path);

  final String path;

  static const String message = liveOnlyMessage;

  @override
  String toString() => 'LiveOnly($path)';
}

/// A write that was SENT to the box and got no answer in time: the box may
/// have done it. It is not sent again through any other route; the person
/// checks first (`S.errcUncertain`).
class Uncertain implements Exception {
  const Uncertain(this.path);

  final String path;

  @override
  String toString() => 'Uncertain($path)';
}

/// `METHOD path` pairs that belong to the surau's own box and never go to the
/// cloud: with the box away they throw [LiveOnly] instead. The app lock is
/// the surau's, and the cloud would keep a value the surau's phones never see.
const List<(String, String)> boxLocalOnly = [
  ('PUT', '/api/settings/appLock'),
];

/// Whether `METHOD path` may only be sent to the surau's own box.
bool isBoxLocalOnly(String method, String path) {
  final p = path.split('?').first;
  return boxLocalOnly.any((e) => e.$1 == method.toUpperCase() && e.$2 == p);
}

/// One entry of the list: what the person cannot do without a connection.
class LiveOnlyEntry {
  LiveOnlyEntry(this.method, this.pattern, this.label, {this.why});

  /// `GET`, `POST`, `PUT`, `DELETE` or `*` for any.
  final String method;
  final RegExp pattern;

  /// The action in words, in the language of the [S] given, as the dialog shows it.
  final String Function(S s) label;

  /// Why it cannot wait in the queue, when the reason is not obvious.
  final String Function(S s)? why;

  bool matches(String m, String path) =>
      (method == '*' || method == m.toUpperCase()) && pattern.hasMatch(path);
}

String _prayerOpsLabel(S s) => s.liveOnlyPrayerOps;
final RegExp _importFile = RegExp(r'^/api/prayer/import/file$');
final RegExp _importUndo = RegExp(r'^/api/prayer/imports/[^/]+/undo$');
final RegExp _correction = RegExp(r'^/api/prayer/corrections/[^/]+/[^/]+$');
final RegExp _zonesRefresh = RegExp(r'^/api/prayer/zones/refresh$');
final RegExp _locationSearch = RegExp(r'^/api/location/search$');

final List<LiveOnlyEntry> liveOnlyList = [
  LiveOnlyEntry('POST', RegExp(r'^/api/enrol/begin$'), (s) => s.liveOnlyEnrol),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/devices/[^/]+/revoke$'),
    (s) => s.liveOnlyRevoke,
    why: (s) => s.liveOnlyRevokeWhy,
  ),
  LiveOnlyEntry('POST', RegExp(r'^/api/users$'), (s) => s.liveOnlyAddUser),
  LiveOnlyEntry(
    'PUT',
    RegExp(r'^/api/users/[^/]+/pin$'),
    (s) => s.liveOnlyResetPin,
  ),
  LiveOnlyEntry('PUT', RegExp(r'^/api/settings/appLock$'), (s) => s.liveOnlyAppLock),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/kiosk/pair(/|$)'),
    (s) => s.liveOnlyPairDisplay,
  ),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/(live/)?youtube(/|$)'),
    (s) => s.liveOnlyYoutubeSign,
  ),
  LiveOnlyEntry('*', RegExp(r'^/api/live(/|$)'), (s) => s.liveOnlyLive),
  // Plan 13: imports, undo, corrections, the zone refresh and the place
  // search reach outside the box or change official days; none can queue.
  LiveOnlyEntry('POST', _importFile, _prayerOpsLabel),
  LiveOnlyEntry('POST', _importUndo, _prayerOpsLabel),
  LiveOnlyEntry('PUT', _correction, _prayerOpsLabel),
  LiveOnlyEntry('DELETE', _correction, _prayerOpsLabel),
  LiveOnlyEntry('POST', _zonesRefresh, _prayerOpsLabel),
  LiveOnlyEntry('POST', _locationSearch, _prayerOpsLabel),
  LiveOnlyEntry('*', RegExp(r'^/api/prayer/'), (s) => s.liveOnlyPrayerData),
  LiveOnlyEntry('*', RegExp(r'^/api/islamic/'), (s) => s.liveOnlyIslamic),
  LiveOnlyEntry('*', RegExp(r'^/api/assets/[^/]+/analyze$'), (s) => s.liveOnlyAnalyse),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/cloud/youtube(/|$)'),
    (s) => s.liveOnlyUploadRecording,
  ),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/sync/(now|run)$'),
    (s) => s.liveOnlySyncNow,
  ),
  LiveOnlyEntry('*', RegExp(r'^/api/auth/pin$'), (s) => s.liveOnlyChangePin),
  // Peranti and Pengguna relook (plan 2026-11-18): the box re-checks these
  // against its own clock and records, so none of them waits in the queue. A
  // person's rename and "Aktifkan semula" are not here: they queue as a
  // `user.put` like roles and deactivation.
  LiveOnlyEntry('PUT', RegExp(r'^/api/devices/[^/]+/name$'), (s) => s.liveOnlyRename),
  LiveOnlyEntry('PUT', RegExp(r'^/api/auth/device/name$'), (s) => s.liveOnlyRename),
  LiveOnlyEntry('POST', RegExp(r'^/api/users/[^/]+/unlock$'), (s) => s.liveOnlyUnlock),
  LiveOnlyEntry('POST', RegExp(r'^/api/enrol/cancel$'), (s) => s.liveOnlyCodes),
  LiveOnlyEntry('GET', RegExp(r'^/api/enrol/(open|recent)$'), (s) => s.liveOnlyCodes),
  LiveOnlyEntry('POST', RegExp(r'^/api/devices/revoke-inactive$'), (s) => s.liveOnlyRevoke),
  LiveOnlyEntry('GET', RegExp(r'^/api/people/activity$'), (s) => s.liveOnlyActivity),
  LiveOnlyEntry('POST', RegExp(r'^/api/users/[^/]+/delete$'), (s) => s.liveOnlyDeleteUser),
  LiveOnlyEntry('POST', RegExp(r'^/api/users/[^/]+/restore$'), (s) => s.liveOnlyRestoreUser),
  LiveOnlyEntry('PUT', RegExp(r'^/api/users/[^/]+/phone$'), (s) => s.liveOnlyPhone),
  // Release 2026.11.12 (K13): themes, the recovery code, leaving and signing
  // out also need the box or the cloud; the dialog must name them.
  LiveOnlyEntry('POST', RegExp(r'^/api/themes/check$'), (s) => s.liveOnlyThemeCheck),
  LiveOnlyEntry('POST', RegExp(r'^/api/themes/install$'), (s) => s.liveOnlyThemeInstall),
  LiveOnlyEntry('DELETE', RegExp(r'^/api/themes/[^/]+$'), (s) => s.liveOnlyThemeDelete),
  LiveOnlyEntry('POST', RegExp(r'^/api/recovery/code$'), (s) => s.liveOnlyRecoveryCode),
  LiveOnlyEntry('POST', RegExp(r'^/api/auth/leave$'), (s) => s.liveOnlyLeave),
  LiveOnlyEntry('POST', RegExp(r'^/api/auth/logout$'), (s) => s.liveOnlyLogout),
  // Plan 7 finance: the entries, lookups, months and photo uploads queue like
  // any edit; the PDF, a stored photo, the share record and the audit view
  // are made or kept only by the box.
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/report/[^/]+\.pdf$'),
    (s) => s.liveOnlyReportPdf,
  ),
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/photos/[^/]+$'),
    (s) => s.liveOnlyCountPhoto,
  ),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/finance/report/[^/]+/shared$'),
    (s) => s.liveOnlyReportShared,
  ),
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/audit$'),
    (s) => s.liveOnlyFinanceAudit,
  ),
];

/// Whether `METHOD path` needs a live connection and can never be queued.
bool isLiveOnly(String method, String path) {
  final p = path.split('?').first;
  return liveOnlyList.any((e) => e.matches(method, p));
}
