// Plan 14 Task 26: texts of `Daftar peranti MAXCOM` (BM first, English second).
// Ops build only; no arb entry, so the public binary carries none of them.
// BM is Bahasa Malaysia. No em dashes in any text.

class OpsEnrolTexts {
  const OpsEnrolTexts._(this.en);

  /// Picks the language by the locale's language code (`ms` default).
  factory OpsEnrolTexts.of(String languageCode) =>
      OpsEnrolTexts._(languageCode == 'en');

  final bool en;
  String _t(String ms, String enText) => en ? enText : ms;

  String get entry => _t('Daftar peranti MAXCOM', 'Enrol a MAXCOM device');
  String get entryHint => _t(
    'Anda perlukan kod sekali guna daripada sesi pelayan MAXCOM.',
    'You need a one-time code from the MAXCOM server session.',
  );
  String get appBarKicker => 'MAXCOM OPS';
  String get whereTitle => _t('Dari mana kod ini?', 'Where does this code come from?');
  String get whereBody => _t(
    'Kod dikeluarkan oleh sesi pelayan MAXCOM sahaja, bukan oleh kotak surau. Jika anda tidak mempunyai kod, minta Pentadbir MAXCOM menjananya.',
    'The code is issued by the MAXCOM server session only, never by a surau box. If you have no code, ask the MAXCOM administrator to create one.',
  );
  String get step1 => _t('Di sesi pelayan MAXCOM: ops-enrol --name "<nama>"', 'In the MAXCOM server session: ops-enrol --name "<name>"');
  String get step2 => _t('Taip kod 12 aksara yang dipaparkan, dalam masa 10 minit.', 'Type the 12 character code shown, within 10 minutes.');
  String get step3 => _t('Telefon ini menjadi peranti MAXCOM dan membuka Senarai surau.', 'This phone becomes a MAXCOM device and opens the surau list.');
  String get codeLabel => _t('Kod pendaftaran', 'Enrolment code');
  String get deviceLabel => _t('Nama peranti ini', 'Name of this device');
  String get deviceHelp => _t('Nama ini dilihat dalam ops-devices di pelayan.', 'This name shows in ops-devices on the server.');
  String get defaultDeviceName => 'Telefon MAXCOM 1';
  String get submit => _t('Daftar', 'Enrol');
  String get working => _t('Mendaftar...', 'Enrolling...');
  String get tls => _t('Disambungkan ke awan MAXCOM (TLS awam).', 'Connected to the MAXCOM cloud (public TLS).');

  // refusals
  String get badCode => _t('Kod tidak sah atau sudah tamat tempoh. Minta kod baharu.', 'The code is invalid or has expired. Ask for a new one.');
  String get appRequired => _t('Kod ini hanya boleh digunakan dalam MAXCOM Ops.', 'This code can only be used in MAXCOM Ops.');
  String get limit => _t('Akaun ini sudah ada 3 peranti MAXCOM. Batalkan satu di pelayan dahulu.', 'This account already has 3 MAXCOM devices. Revoke one on the server first.');
  String get tooMany => _t('Terlalu banyak cubaan. Tunggu sebentar dan cuba lagi.', 'Too many attempts. Wait a moment and try again.');
  String get offline => _t('Tiada sambungan ke awan. Semak internet telefon dan cuba lagi. Kod masih sah sehingga tamat 10 minit.', 'No connection to the cloud. Check the phone internet and try again. The code stays valid for 10 minutes.');
  String get already => _t('Telefon ini sudah didaftarkan. Padam pendaftaran lama dahulu.', 'This phone is already enrolled. Remove the old enrolment first.');
  String get saveFailed => _t('Pendaftaran tidak dapat disimpan pada telefon ini. Kod itu sudah digunakan; minta MAXCOM mengeluarkan kod baharu.', 'The enrolment could not be saved on this phone. That code is used up; ask MAXCOM to issue a new one.');
  String get tlsFailed => _t('Sambungan selamat ke awan MAXCOM gagal.', 'Secure connection to the MAXCOM cloud failed.');
  String get generic => _t('Pendaftaran gagal. Cuba lagi.', 'Enrolment failed. Try again.');

  // done
  String get doneBar => _t('Peranti didaftar', 'Device enrolled');
  String get doneTitle => _t('Telefon ini kini peranti MAXCOM', 'This phone is now a MAXCOM device');
  String get doneBody => _t(
    'Kuasa Pentadbir MAXCOM hanya berfungsi pada telefon ini dan peranti MAXCOM lain yang didaftar dengan kod pelayan.',
    'MAXCOM administrator powers work only on this phone and other MAXCOM devices enrolled with a server code.',
  );
  String get doneKey => _t(
    'Telefon ini menyimpan kunci peranti. Jika hilang, batalkan di pelayan dengan revoke-device.',
    'This phone keeps the device key. If it is lost, revoke it on the server with revoke-device.',
  );
  String get next => _t('Teruskan ke buka kunci', 'Continue to unlock');

  // unmarked
  String get unmarkedTitle => _t('Peranti ini bukan lagi peranti MAXCOM', 'This device is no longer a MAXCOM device');
  String get unmarkedRetry => _t('Cuba lagi', 'Try again');
  String get unmarkedDevice => _t('Buka halaman peranti ini', 'Open this device page');
  String get unmarkedBody => _t(
    'Pentadbir MAXCOM telah menarik balik tanda ops telefon ini. Tiada skrin MAXCOM Ops dibuka. Untuk kembali, daftar semula dengan kod baharu.',
    'The MAXCOM administrator withdrew the ops mark of this phone. No MAXCOM Ops screen opens. To return, enrol again with a new code.',
  );
}
