// Plan 14 Tasks 14 and 15: the words of the MAXCOM Ops fleet screens, Bahasa Malaysia first and English second.
// Plain Dart constants (not the arb files) so the public build, which never reaches this file, carries none of
// them. In the ops app "kotak" is the surau's box and "peranti MAXCOM" a MAXCOM phone (mockup decision 3).
// ASCII only, no dashes, arrows or approximation signs (test/ops/fleet_texts_test.dart reads every string here).

import 'package:flutter/widgets.dart';

import '../../l10n/generated/s.dart';
import 'fleet_models.dart';

class FleetT {
  const FleetT._(this._en);

  factory FleetT.of(BuildContext context) => FleetT._(Localizations.localeOf(context).languageCode == 'en');

  /// For a place that has the app's strings but no context (the menu).
  factory FleetT.ofS(S s) => FleetT._(s.localeName.startsWith('en'));

  /// For tests and the text scan: both languages.
  static const FleetT ms = FleetT._(false);
  static const FleetT en = FleetT._(true);

  final bool _en;

  String _t(String ms, String en) => _en ? en : ms;

  // ---- menu and titles ----
  String get armadaTitle => _t('Senarai surau', 'Surau list');
  String get pendingMenu => _t('Kotak menunggu', 'Waiting boxes');
  String get switcherTitle => _t('Pilih surau', 'Choose surau');
  String get detailBoxes => _t('Kotak', 'Boxes');

  String get localOnlyTitle => _t('Tidak tersedia', 'Not available');
  String get localOnlyBody => _t(
    'Tidak tersedia semasa bertindak sebagai MAXCOM. Gunakan telefon pentadbir surau itu.',
    'Not available while acting as MAXCOM. Use the phone of that surau administrator.',
  );

  // ---- list ----
  String get searchHint => _t('Cari surau atau ID kotak', 'Search surau or box ID');
  String get filterAll => _t('Semua', 'All');
  String get armadaEmpty => _t('Tiada surau dijumpai', 'No surau found');
  String get armadaChooseFirst => _t(
    'Pilih satu surau untuk bekerja di dalamnya. Skrin surau meminta surau dipilih dahulu.',
    'Choose a surau to work in. The surau screens ask for one first.',
  );
  String get stateOk => _t('OK', 'OK');
  String get stateOffline => _t('Luar talian', 'Offline');
  String get stateWaiting => _t('Menunggu MAXCOM', 'Waiting for MAXCOM');
  String get stateSuspended => _t('Digantung', 'Suspended');
  String stateLabel(SurauState s) => switch (s) {
    SurauState.ok => stateOk,
    SurauState.offline => stateOffline,
    SurauState.waiting => stateWaiting,
    SurauState.suspended => stateSuspended,
  };
  String boxCount(int n) => _t('$n kotak', n == 1 ? '1 box' : '$n boxes');
  String get storage => _t('Storan', 'Storage');
  String get neverSeen => _t('Belum dilihat', 'Not seen yet');
  String ago(Duration d) {
    if (d.inMinutes < 1) return _t('sebentar tadi', 'just now');
    if (d.inMinutes < 60) return _t('${d.inMinutes} minit lalu', '${d.inMinutes} min ago');
    if (d.inHours < 24) return _t('${d.inHours} jam lalu', '${d.inHours} h ago');
    return _t('${d.inDays} hari lalu', '${d.inDays} days ago');
  }

  // ---- detail ----
  String get viewAs => _t('Lihat sebagai MAXCOM', 'View as MAXCOM');
  String get detailSurauId => _t('ID surau', 'Surau ID');
  String get detailStorage => _t('Storan awan', 'Cloud storage');
  String detailStorageOf(String used, String limit) => _t('$used daripada $limit', '$used of $limit');
  String get detailNoBox => _t('Belum ada kotak yang memaut', 'No box has linked yet');
  String get boxPrimary => _t('utama', 'primary');
  String get boxRevoked => _t('Dibatalkan', 'Revoked');
  String get stateEmpty => _t('Kosong', 'Empty');
  String get suspendedBecause => _t('Sebab', 'Reason');

  // ---- switcher and banner ----
  String get switcherTooltip => _t('Tukar surau', 'Change surau');
  String get switcherNone => _t('Tiada surau dipilih', 'No surau chosen');
  String get switcherNote => _t(
    'Pilihan tidak diingat selepas aplikasi ditutup.',
    'The choice is not remembered when the app is closed.',
  );
  String get switcherSuspendedNote => _t('Digantung', 'Suspended');
  String bannerText(String name) => _t('Anda melihat sebagai MAXCOM: $name', 'You are viewing as MAXCOM: $name');
  String get bannerExit => _t('Keluar', 'Exit');
  String get bannerChange => _t('Tukar', 'Change');

  // ---- pending boxes (Task 15) ----
  String get pendingNote => _t(
    'Kotak memaut sendiri secara automatik. Hanya kotak yang tertahan muncul di sini; ia akan memaut sendiri apabila had harian dibuka semula. Luluskan hanya jika perlu segera.',
    'Boxes link themselves automatically. Only held boxes show here; they link themselves when the daily limit reopens. Approve only when it is urgent.',
  );
  String get pendingEmpty => _t('Tiada kotak menunggu', 'No box is waiting');
  String get pendingHeld => _t('Ditahan oleh had harian', 'Held by the daily limit');
  String get pendingHeldOther => _t('Tertahan', 'Held');
  String pendingBoxName(String n) => _t('Kotak: $n', 'Box: $n');
  String pendingPlatform(String p) => _t('Platform: $p', 'Platform: $p');
  String pendingVersion(String v) => _t('Versi $v', 'Version $v');
  String pendingId(String id) => _t('ID kotak $id', 'Box ID $id');
  String pendingRegistered(String ago) => _t('Mendaftar $ago', 'Registered $ago');
  String get approveAction => _t('Luluskan', 'Approve');

  // ---- approve sheet ----
  String get approveTitle => _t('Luluskan kotak', 'Approve box');
  String approveFor(String box) => _t('Untuk kotak $box.', 'For box $box.');
  String get targetNew => _t('Surau baharu', 'New surau');
  String get targetExisting => _t('Surau yang sudah ada', 'Existing surau');
  String get newNameLabel => _t('Nama surau (daripada pendaftaran kotak)', 'Surau name (from the box registration)');
  String get newNameNote => _t(
    'Surau dicipta sekarang dengan nama ini. ID dijana oleh awan.',
    'The surau is created now with this name. The cloud makes the ID.',
  );
  String get existingNote => _t(
    'Hanya surau tanpa kotak hidup dan tidak digantung.',
    'Only suraus with no live box that are not suspended.',
  );
  String get existingNone => _t('Tiada surau tanpa kotak hidup', 'No surau without a live box');
  String get existingConfirmLabel => _t('Taip nama surau untuk sahkan', 'Type the surau name to confirm');
  String get approveSubmit => _t('Luluskan', 'Approve');
  String get approvedNew => _t('Kotak diluluskan. Surau baharu dicipta.', 'Box approved. A new surau was created.');
  String get approvedExisting => _t('Kotak diluluskan ke surau sedia ada.', 'Box approved into the existing surau.');

  // ---- revoke and restore a box ----
  String get revokeBox => _t('Batal kotak', 'Revoke box');
  String revokeTitle(String box) => _t('Batal $box?', 'Revoke $box?');
  String get revokeBody => _t(
    'Kunci kotak ini di awan mati serta-merta. Kotak terus berfungsi sendiri di surau tetapi tidak lagi menyegerak. Surau, datanya dan akses awan telefon surau kekal.',
    'This box key dies on the cloud at once. The box keeps working on its own at the surau but no longer syncs. The surau, its data and its phones cloud access stay.',
  );
  String get revokeWord => _t('BATAL', 'REVOKE');
  String revokeTypeLabel(String word) => _t('Taip $word untuk sahkan', 'Type $word to confirm');
  String get revokeSubmit => _t('Batal kotak', 'Revoke box');
  String get revoked => _t('Kotak dibatalkan', 'Box revoked');
  String get unrevokeBox => _t('Pulihkan kotak', 'Restore box');
  String unrevokeTitle(String box) => _t('Pulihkan $box?', 'Restore $box?');
  String get unrevokeBody => _t(
    'Kotak ini dibenarkan memaut semula sekali, dengan sendiri, ke surau asalnya sahaja. Selepas ia memaut, kebenaran ini habis.',
    'This box may link again once, by itself, to its own surau only. After it links, this permission ends.',
  );
  String get restored => _t('Kotak dipulihkan', 'Box restored');

  // ---- delete an empty surau ----
  String get deleteSurau => _t('Padam surau kosong', 'Delete empty surau');
  String deleteSurauTitle(String name) => _t('Padam $name?', 'Delete $name?');
  String get deleteSurauBody => _t(
    'Surau ini kosong: tiada kandungan, kewangan atau pengguna di dalamnya. Ia dipadam kekal daripada senarai. Taip nama surau untuk sahkan.',
    'This surau is empty: no content, finance or users in it. It is removed from the list for good. Type the surau name to confirm.',
  );
  String get deleteSurauDone => _t('Surau dipadam', 'Surau deleted');
  String get deleteSurauNotEmpty => _t('Surau ini tidak kosong lagi', 'This surau is no longer empty');

  // ---- reject a waiting box ----
  String get rejectAction => _t('Tolak', 'Reject');
  String rejectTitle(String box) => _t('Tolak $box?', 'Reject $box?');
  String get rejectBody => _t(
    'Pendaftaran kotak ini dibuang daripada senarai menunggu. Tiada surau dicipta dan tiada apa yang dipautkan. Kotak boleh mendaftar semula kemudian.',
    'This box registration is removed from the waiting list. No surau is created and nothing is linked. The box can register again later.',
  );
  String get rejectWord => _t('TOLAK', 'REJECT');
  String get rejectSubmit => _t('Tolak kotak', 'Reject box');
  String get rejected => _t('Kotak ditolak', 'Box rejected');

  // ---- what the cloud said (by its reason code) ----
  String? refusal(String? code) => switch (code) {
    'surau_has_box' => _t(
      'Surau ini sudah ada kotak yang aktif. Batalkan kotak itu dahulu.',
      'This surau already has a live box. Revoke that box first.',
    ),
    'foreign_surau' => _t(
      'Kotak ini milik surau lain dan tidak boleh dipindahkan.',
      'This box belongs to another surau and cannot be moved.',
    ),
    'bad_code' => _t('Kod tidak sah atau sudah tamat tempoh.', 'The code is not valid or has expired.'),
    'worker_unreachable' => _t(
      'MAXCOM tidak dapat menyemak pendaftaran kotak sekarang. Cuba lagi.',
      'MAXCOM cannot check the box registration now. Try again.',
    ),
    'no_worker' => _t('Pendaftaran kotak belum ditetapkan pada awan ini.', 'Box registration is not set up on this cloud.'),
    'not_registered' => _t(
      'Kotak ini belum mendaftar atau pendaftarannya sudah tamat.',
      'This box has not registered or its registration has expired.',
    ),
    'surau_not_found' => _t('Surau tidak dijumpai.', 'The surau was not found.'),
    'surau_required' => _t('Pilih surau baharu atau surau yang sudah ada.', 'Choose a new surau or an existing one.'),
    'not_linked' => _t('Kotak ini sudah dibatalkan.', 'This box is already revoked.'),
    'not_revoked' => _t('Kotak ini tidak dibatalkan.', 'This box is not revoked.'),
    'linked' => _t('Kotak ini sudah dipautkan.', 'This box is already linked.'),
    'already_linked' => _t(
      'Kotak ini sudah dipautkan atau diluluskan; guna Batal kotak, bukan Tolak.',
      'This box is already linked or approved; use Revoke box, not Reject.',
    ),
    _ => null,
  };
}
