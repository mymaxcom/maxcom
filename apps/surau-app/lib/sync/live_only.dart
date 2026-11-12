// The operations that need a live connection to the box or the cloud
// (Plan 6 Task 8). They are never queued: the app sends them straight to the
// network and, when no base answers, refuses them aloud with [LiveOnly], so
// the person is told instead of an edit vanishing. Task 9's dialog shows
// [liveOnlyList].

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

/// One entry of the list: what the person cannot do without a connection.
class LiveOnlyEntry {
  const LiveOnlyEntry(this.method, this.pattern, this.label, {this.why});

  /// `GET`, `POST`, `PUT`, `DELETE` or `*` for any.
  final String method;
  final RegExp pattern;

  /// Bahasa Malaysia, as the dialog shows it.
  final String label;

  /// Why it cannot wait in the queue, when the reason is not obvious.
  final String? why;

  bool matches(String m, String path) =>
      (method == '*' || method == m.toUpperCase()) && pattern.hasMatch(path);
}

const String _prayerOpsLabel = 'Import, pembetulan dan carian waktu solat';
final RegExp _importFile = RegExp(r'^/api/prayer/import/file$');
final RegExp _importUndo = RegExp(r'^/api/prayer/imports/[^/]+/undo$');
final RegExp _correction = RegExp(r'^/api/prayer/corrections/[^/]+/[^/]+$');
final RegExp _zonesRefresh = RegExp(r'^/api/prayer/zones/refresh$');
final RegExp _locationSearch = RegExp(r'^/api/location/search$');

final List<LiveOnlyEntry> liveOnlyList = [
  LiveOnlyEntry('POST', RegExp(r'^/api/enrol/begin$'), 'Daftar peranti baharu'),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/devices/[^/]+/revoke$'),
    'Batalkan peranti',
    why: 'Pembatalan mesti dilihat berjaya oleh pentadbir',
  ),
  LiveOnlyEntry('POST', RegExp(r'^/api/users$'), 'Tambah pengguna'),
  LiveOnlyEntry(
    'PUT',
    RegExp(r'^/api/users/[^/]+/pin$'),
    'Tetapkan semula PIN',
  ),
  LiveOnlyEntry('PUT', RegExp(r'^/api/settings/appLock$'), 'Kunci aplikasi'),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/kiosk/pair(/|$)'),
    'Luluskan pasangan paparan',
  ),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/(live/)?youtube(/|$)'),
    'Log masuk dan log keluar YouTube',
  ),
  LiveOnlyEntry('*', RegExp(r'^/api/live(/|$)'), 'Siaran langsung'),
  // Plan 13: imports, undo, corrections, the zone refresh and the place
  // search reach outside the box or change official days; none can queue.
  LiveOnlyEntry('POST', _importFile, _prayerOpsLabel),
  LiveOnlyEntry('POST', _importUndo, _prayerOpsLabel),
  LiveOnlyEntry('PUT', _correction, _prayerOpsLabel),
  LiveOnlyEntry('DELETE', _correction, _prayerOpsLabel),
  LiveOnlyEntry('POST', _zonesRefresh, _prayerOpsLabel),
  LiveOnlyEntry('POST', _locationSearch, _prayerOpsLabel),
  LiveOnlyEntry('*', RegExp(r'^/api/prayer/'), 'Data waktu solat'),
  LiveOnlyEntry('*', RegExp(r'^/api/islamic/'), 'Kandungan Islam'),
  LiveOnlyEntry('*', RegExp(r'^/api/assets/[^/]+/analyze$'), 'Analisis gambar'),
  LiveOnlyEntry(
    '*',
    RegExp(r'^/api/cloud/youtube(/|$)'),
    'Muat naik rakaman ke YouTube',
  ),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/sync/(now|run)$'),
    'Selaraskan sekarang',
  ),
  LiveOnlyEntry('*', RegExp(r'^/api/auth/pin$'), 'Tukar PIN'),
  // Plan 7 finance: the entries, lookups, months and photo uploads queue like
  // any edit; the PDF, a stored photo, the share record and the audit view
  // are made or kept only by the box.
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/report/[^/]+\.pdf$'),
    'Muat turun PDF laporan',
  ),
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/photos/[^/]+$'),
    'Lihat foto helaian kiraan',
  ),
  LiveOnlyEntry(
    'POST',
    RegExp(r'^/api/finance/report/[^/]+/shared$'),
    'Rekod perkongsian laporan',
  ),
  LiveOnlyEntry(
    'GET',
    RegExp(r'^/api/finance/audit$'),
    'Sejarah audit kewangan',
  ),
];

/// Whether `METHOD path` needs a live connection and can never be queued.
bool isLiveOnly(String method, String path) {
  final p = path.split('?').first;
  return liveOnlyList.any((e) => e.matches(method, p));
}
