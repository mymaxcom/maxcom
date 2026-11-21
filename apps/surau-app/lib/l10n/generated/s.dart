import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 's_ar.dart';
import 's_en.dart';
import 's_ms.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of S
/// returned by `S.of(context)`.
///
/// Applications need to include `S.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/s.dart';
///
/// return MaterialApp(
///   localizationsDelegates: S.localizationsDelegates,
///   supportedLocales: S.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the S.supportedLocales
/// property.
abstract class S {
  S(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static S of(BuildContext context) {
    return Localizations.of<S>(context, S)!;
  }

  static const LocalizationsDelegate<S> delegate = _SDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('ar'),
    Locale('en'),
    Locale('ms'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In ms, this message translates to:
  /// **'Surau'**
  String get appTitle;

  /// No description provided for @actionSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan perubahan'**
  String get actionSave;

  /// No description provided for @actionCancel.
  ///
  /// In ms, this message translates to:
  /// **'Batal'**
  String get actionCancel;

  /// No description provided for @actionBack.
  ///
  /// In ms, this message translates to:
  /// **'Kembali'**
  String get actionBack;

  /// No description provided for @actionRetry.
  ///
  /// In ms, this message translates to:
  /// **'Cuba lagi'**
  String get actionRetry;

  /// No description provided for @actionDelete.
  ///
  /// In ms, this message translates to:
  /// **'Padam'**
  String get actionDelete;

  /// No description provided for @actionClose.
  ///
  /// In ms, this message translates to:
  /// **'Tutup'**
  String get actionClose;

  /// No description provided for @actionContinue.
  ///
  /// In ms, this message translates to:
  /// **'Teruskan'**
  String get actionContinue;

  /// No description provided for @actionAdd.
  ///
  /// In ms, this message translates to:
  /// **'Tambah'**
  String get actionAdd;

  /// No description provided for @actionEdit.
  ///
  /// In ms, this message translates to:
  /// **'Sunting'**
  String get actionEdit;

  /// No description provided for @actionUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik'**
  String get actionUpload;

  /// No description provided for @actionDownload.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun'**
  String get actionDownload;

  /// No description provided for @actionLogout.
  ///
  /// In ms, this message translates to:
  /// **'Log keluar'**
  String get actionLogout;

  /// No description provided for @actionEnrolAgain.
  ///
  /// In ms, this message translates to:
  /// **'Daftar semula'**
  String get actionEnrolAgain;

  /// No description provided for @savedToast.
  ///
  /// In ms, this message translates to:
  /// **'Perubahan disimpan'**
  String get savedToast;

  /// No description provided for @navDashboard.
  ///
  /// In ms, this message translates to:
  /// **'Papan pemuka'**
  String get navDashboard;

  /// No description provided for @navSettings.
  ///
  /// In ms, this message translates to:
  /// **'Konfigurasi'**
  String get navSettings;

  /// No description provided for @navContent.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan'**
  String get navContent;

  /// No description provided for @navPreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton'**
  String get navPreview;

  /// No description provided for @navIslamic.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan Islamik'**
  String get navIslamic;

  /// No description provided for @navPrayerData.
  ///
  /// In ms, this message translates to:
  /// **'Waktu solat'**
  String get navPrayerData;

  /// No description provided for @navUsers.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get navUsers;

  /// No description provided for @navDevices.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get navDevices;

  /// No description provided for @navPairing.
  ///
  /// In ms, this message translates to:
  /// **'Pasangan kiosk'**
  String get navPairing;

  /// No description provided for @navAudit.
  ///
  /// In ms, this message translates to:
  /// **'Log perubahan'**
  String get navAudit;

  /// No description provided for @navFinance.
  ///
  /// In ms, this message translates to:
  /// **'Kewangan'**
  String get navFinance;

  /// No description provided for @navLive.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung'**
  String get navLive;

  /// No description provided for @navJemaah.
  ///
  /// In ms, this message translates to:
  /// **'Jemaah'**
  String get navJemaah;

  /// No description provided for @navThisDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini'**
  String get navThisDevice;

  /// No description provided for @navMore.
  ///
  /// In ms, this message translates to:
  /// **'Lagi'**
  String get navMore;

  /// No description provided for @dashboardTitle.
  ///
  /// In ms, this message translates to:
  /// **'Papan pemuka'**
  String get dashboardTitle;

  /// No description provided for @settingsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Konfigurasi'**
  String get settingsTitle;

  /// No description provided for @enrolTitle.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti ini'**
  String get enrolTitle;

  /// No description provided for @unlockTitle.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci'**
  String get unlockTitle;

  /// No description provided for @previewRibbon.
  ///
  /// In ms, this message translates to:
  /// **'PRATONTON'**
  String get previewRibbon;

  /// No description provided for @enrolScanHint.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod QR yang ditunjukkan oleh pentadbir'**
  String get enrolScanHint;

  /// No description provided for @enrolManualHint.
  ///
  /// In ms, this message translates to:
  /// **'Atau tampal kod pendaftaran di sini'**
  String get enrolManualHint;

  /// No description provided for @enrolPinHaveOne.
  ///
  /// In ms, this message translates to:
  /// **'Saya sudah ada PIN'**
  String get enrolPinHaveOne;

  /// No description provided for @enrolPinCreate.
  ///
  /// In ms, this message translates to:
  /// **'Cipta PIN baharu'**
  String get enrolPinCreate;

  /// No description provided for @pinLabel.
  ///
  /// In ms, this message translates to:
  /// **'PIN'**
  String get pinLabel;

  /// No description provided for @pinHint.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan PIN'**
  String get pinHint;

  /// No description provided for @pinConfirmHint.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan PIN sekali lagi'**
  String get pinConfirmHint;

  /// No description provided for @pinMismatch.
  ///
  /// In ms, this message translates to:
  /// **'PIN tidak sepadan'**
  String get pinMismatch;

  /// No description provided for @biometricUse.
  ///
  /// In ms, this message translates to:
  /// **'Guna cap jari'**
  String get biometricUse;

  /// No description provided for @unlockButton.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci'**
  String get unlockButton;

  /// No description provided for @errorForbidden.
  ///
  /// In ms, this message translates to:
  /// **'Tiada kebenaran untuk tindakan ini'**
  String get errorForbidden;

  /// No description provided for @errorBoxUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menghubungi MAXCOM'**
  String get errorBoxUnreachable;

  /// No description provided for @errorDeviceRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Peranti telah dibatalkan'**
  String get errorDeviceRevoked;

  /// No description provided for @errorCaMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Sijil akar tidak sepadan'**
  String get errorCaMismatch;

  /// No description provided for @errorDeviceKeyMissing.
  ///
  /// In ms, this message translates to:
  /// **'Kunci peranti tiada'**
  String get errorDeviceKeyMissing;

  /// No description provided for @errorSessionExpired.
  ///
  /// In ms, this message translates to:
  /// **'Sesi telah tamat. Buka kunci semula.'**
  String get errorSessionExpired;

  /// No description provided for @errorUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Sesuatu tidak kena. Cuba lagi.'**
  String get errorUnknown;

  /// No description provided for @offlineBanner.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Menunjukkan data terakhir.'**
  String get offlineBanner;

  /// No description provided for @offlineWriteRefused.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Cuba lagi di surau.'**
  String get offlineWriteRefused;

  /// No description provided for @loading.
  ///
  /// In ms, this message translates to:
  /// **'Memuatkan'**
  String get loading;

  /// No description provided for @emptyList.
  ///
  /// In ms, this message translates to:
  /// **'Tiada rekod lagi'**
  String get emptyList;

  /// No description provided for @readOnlyHint.
  ///
  /// In ms, this message translates to:
  /// **'Paparan sahaja'**
  String get readOnlyHint;

  /// No description provided for @featureOn.
  ///
  /// In ms, this message translates to:
  /// **'Hidup'**
  String get featureOn;

  /// No description provided for @featureOff.
  ///
  /// In ms, this message translates to:
  /// **'Mati'**
  String get featureOff;

  /// No description provided for @featureLocked.
  ///
  /// In ms, this message translates to:
  /// **'Sentiasa hidup'**
  String get featureLocked;

  /// No description provided for @deviceLockAlwaysOn.
  ///
  /// In ms, this message translates to:
  /// **'Kunci peranti ini'**
  String get deviceLockAlwaysOn;

  /// No description provided for @roleSuperadmin.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir MAXCOM'**
  String get roleSuperadmin;

  /// No description provided for @roleSuperadminHint.
  ///
  /// In ms, this message translates to:
  /// **'Semua yang Pentadbir boleh, ditambah tetapan sistem MAXCOM (Lanjutan). Urus melalui awan MAXCOM sahaja'**
  String get roleSuperadminHint;

  /// No description provided for @superadminBadgeTooltip.
  ///
  /// In ms, this message translates to:
  /// **'Anda Pentadbir MAXCOM'**
  String get superadminBadgeTooltip;

  /// No description provided for @roleAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir'**
  String get roleAdmin;

  /// No description provided for @roleTreasurer.
  ///
  /// In ms, this message translates to:
  /// **'Bendahari'**
  String get roleTreasurer;

  /// No description provided for @roleMedia.
  ///
  /// In ms, this message translates to:
  /// **'Media'**
  String get roleMedia;

  /// No description provided for @roleAjk.
  ///
  /// In ms, this message translates to:
  /// **'AJK'**
  String get roleAjk;

  /// No description provided for @enrolScanButton.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod QR'**
  String get enrolScanButton;

  /// No description provided for @enrolManualButton.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan kod secara manual'**
  String get enrolManualButton;

  /// No description provided for @enrolPasteLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kod pendaftaran'**
  String get enrolPasteLabel;

  /// No description provided for @enrolPasteHint.
  ///
  /// In ms, this message translates to:
  /// **'surau1:...'**
  String get enrolPasteHint;

  /// No description provided for @enrolCodeShow.
  ///
  /// In ms, this message translates to:
  /// **'Tunjukkan kod'**
  String get enrolCodeShow;

  /// No description provided for @enrolCodeHide.
  ///
  /// In ms, this message translates to:
  /// **'Sembunyikan kod'**
  String get enrolCodeHide;

  /// No description provided for @enrolCameraUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Kamera tidak tersedia di sini. Tampal kod pendaftaran yang diberikan pentadbir.'**
  String get enrolCameraUnavailable;

  /// No description provided for @enrolCameraStarting.
  ///
  /// In ms, this message translates to:
  /// **'Membuka kamera'**
  String get enrolCameraStarting;

  /// No description provided for @enrolBoxLabel.
  ///
  /// In ms, this message translates to:
  /// **'Alamat MAXCOM'**
  String get enrolBoxLabel;

  /// No description provided for @enrolUserLabel.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get enrolUserLabel;

  /// No description provided for @enrolCaLabel.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari sijil'**
  String get enrolCaLabel;

  /// No description provided for @enrolCaCompare.
  ///
  /// In ms, this message translates to:
  /// **'Bandingkan dengan cetakan pentadbir sebelum teruskan.'**
  String get enrolCaCompare;

  /// No description provided for @enrolCaNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada sijil (sambungan ujian setempat)'**
  String get enrolCaNone;

  /// No description provided for @enrolDeviceNameLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama peranti'**
  String get enrolDeviceNameLabel;

  /// No description provided for @enrolDeviceNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Telefon Ali'**
  String get enrolDeviceNameHint;

  /// No description provided for @enrolDeviceNameRequired.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan nama peranti'**
  String get enrolDeviceNameRequired;

  /// No description provided for @enrolPinChoiceTitle.
  ///
  /// In ms, this message translates to:
  /// **'PIN anda'**
  String get enrolPinChoiceTitle;

  /// No description provided for @enrolPinHaveOneHint.
  ///
  /// In ms, this message translates to:
  /// **'PIN yang sama seperti di peranti anda yang lain'**
  String get enrolPinHaveOneHint;

  /// No description provided for @enrolPinCreateHint.
  ///
  /// In ms, this message translates to:
  /// **'6 digit. Bukan digit yang sama dan bukan turutan.'**
  String get enrolPinCreateHint;

  /// No description provided for @enrolPinNewHint.
  ///
  /// In ms, this message translates to:
  /// **'PIN baharu'**
  String get enrolPinNewHint;

  /// No description provided for @enrolPinAgainLabel.
  ///
  /// In ms, this message translates to:
  /// **'Sekali lagi'**
  String get enrolPinAgainLabel;

  /// No description provided for @enrolSubmit.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti'**
  String get enrolSubmit;

  /// No description provided for @enrolWorking.
  ///
  /// In ms, this message translates to:
  /// **'Mendaftar'**
  String get enrolWorking;

  /// No description provided for @enrolDone.
  ///
  /// In ms, this message translates to:
  /// **'Peranti didaftarkan'**
  String get enrolDone;

  /// No description provided for @enrolExpired.
  ///
  /// In ms, this message translates to:
  /// **'Kod pendaftaran telah tamat. Minta kod baharu daripada pentadbir.'**
  String get enrolExpired;

  /// No description provided for @enrolPinExists.
  ///
  /// In ms, this message translates to:
  /// **'Anda sudah ada PIN. Pilih \"Saya sudah ada PIN\".'**
  String get enrolPinExists;

  /// No description provided for @enrolPinKnownSet.
  ///
  /// In ms, this message translates to:
  /// **'Guna PIN yang sama seperti di peranti anda yang lain'**
  String get enrolPinKnownSet;

  /// No description provided for @enrolPinKnownNew.
  ///
  /// In ms, this message translates to:
  /// **'Cipta PIN 6 digit untuk akaun anda'**
  String get enrolPinKnownNew;

  /// No description provided for @enrolAlreadyEnrolled.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini sudah didaftarkan. Untuk mendaftar semula, pilih \"Daftar semula\" di skrin buka kunci.'**
  String get enrolAlreadyEnrolled;

  /// No description provided for @enrolPinPending.
  ///
  /// In ms, this message translates to:
  /// **'PIN belum ditetapkan. Anda akan diminta tetapkan PIN baharu semasa buka kunci.'**
  String get enrolPinPending;

  /// No description provided for @enrolAnother.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod lain'**
  String get enrolAnother;

  /// No description provided for @pinTooWeak.
  ///
  /// In ms, this message translates to:
  /// **'PIN terlalu mudah. Pilih 6 digit yang bukan sama dan bukan turutan.'**
  String get pinTooWeak;

  /// No description provided for @pinNewTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tetapkan PIN baharu'**
  String get pinNewTitle;

  /// No description provided for @pinNewHint.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir telah menetapkan semula PIN anda. Pilih 6 digit baharu.'**
  String get pinNewHint;

  /// No description provided for @pinConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan PIN sekali lagi'**
  String get pinConfirmTitle;

  /// No description provided for @pinDeleteDigit.
  ///
  /// In ms, this message translates to:
  /// **'Padam digit'**
  String get pinDeleteDigit;

  /// No description provided for @unlockHint.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan PIN untuk teruskan'**
  String get unlockHint;

  /// No description provided for @unlockChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menyemak'**
  String get unlockChecking;

  /// No description provided for @unlockRevokedHint.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini tidak lagi dibenarkan. Daftar semula dengan kod baharu daripada pentadbir.'**
  String get unlockRevokedHint;

  /// No description provided for @unlockNoKeyHint.
  ///
  /// In ms, this message translates to:
  /// **'Kunci peranti ini tiada. Daftar semula dengan kod baharu daripada pentadbir.'**
  String get unlockNoKeyHint;

  /// No description provided for @biometricFailed.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari tidak dikenali. Masukkan PIN.'**
  String get biometricFailed;

  /// No description provided for @biometricLocked.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari dikunci sementara. Guna PIN.'**
  String get biometricLocked;

  /// No description provided for @unlockNotVerified.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat mengesahkan peranti ini. Cuba lagi.'**
  String get unlockNotVerified;

  /// No description provided for @biometricChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu cap jari'**
  String get biometricChecking;

  /// No description provided for @productName.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM'**
  String get productName;

  /// No description provided for @greeting.
  ///
  /// In ms, this message translates to:
  /// **'Assalamualaikum, {name}'**
  String greeting(String name);

  /// No description provided for @rolesJoin.
  ///
  /// In ms, this message translates to:
  /// **'{head} dan {last}'**
  String rolesJoin(String head, String last);

  /// No description provided for @invitedByUntil.
  ///
  /// In ms, this message translates to:
  /// **'Dijemput oleh {admin}. Jemputan sah hingga {when}.'**
  String invitedByUntil(String admin, String when);

  /// No description provided for @validUntil.
  ///
  /// In ms, this message translates to:
  /// **'Jemputan sah hingga {when}.'**
  String validUntil(String when);

  /// No description provided for @enrolStepScan.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod'**
  String get enrolStepScan;

  /// No description provided for @enrolStepReview.
  ///
  /// In ms, this message translates to:
  /// **'Semak'**
  String get enrolStepReview;

  /// No description provided for @enrolStepPin.
  ///
  /// In ms, this message translates to:
  /// **'Tetapkan PIN'**
  String get enrolStepPin;

  /// No description provided for @enrolReviewHint.
  ///
  /// In ms, this message translates to:
  /// **'Semak nama anda dan surau ini sebelum teruskan.'**
  String get enrolReviewHint;

  /// No description provided for @enrolDoneHint.
  ///
  /// In ms, this message translates to:
  /// **'Lain kali, buka aplikasi ini dan masukkan PIN anda.'**
  String get enrolDoneHint;

  /// No description provided for @helpTitle.
  ///
  /// In ms, this message translates to:
  /// **'Perlukan bantuan?'**
  String get helpTitle;

  /// No description provided for @helpContact.
  ///
  /// In ms, this message translates to:
  /// **'Hubungi {name}'**
  String helpContact(String name);

  /// No description provided for @helpContactAnyone.
  ///
  /// In ms, this message translates to:
  /// **'Hubungi pentadbir surau'**
  String get helpContactAnyone;

  /// No description provided for @helpNoContact.
  ///
  /// In ms, this message translates to:
  /// **'Minta bantuan pentadbir surau anda.'**
  String get helpNoContact;

  /// No description provided for @helpCall.
  ///
  /// In ms, this message translates to:
  /// **'Telefon'**
  String get helpCall;

  /// No description provided for @helpWhatsApp.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp'**
  String get helpWhatsApp;

  /// No description provided for @helpEmail.
  ///
  /// In ms, this message translates to:
  /// **'E-mel'**
  String get helpEmail;

  /// No description provided for @techDetailsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Butiran teknikal'**
  String get techDetailsTitle;

  /// No description provided for @unlockForgotPin.
  ///
  /// In ms, this message translates to:
  /// **'Lupa PIN?'**
  String get unlockForgotPin;

  /// No description provided for @unlockForgotPinBody.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir boleh tetapkan semula PIN anda. Selepas itu, buka aplikasi ini dan tetapkan PIN baharu.'**
  String get unlockForgotPinBody;

  /// No description provided for @unlockNotYou.
  ///
  /// In ms, this message translates to:
  /// **'Bukan anda? Daftar peranti ini semula'**
  String get unlockNotYou;

  /// No description provided for @unlockNotYouTitle.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti ini semula?'**
  String get unlockNotYouTitle;

  /// No description provided for @unlockNotYouBody.
  ///
  /// In ms, this message translates to:
  /// **'Anda perlukan kod QR baharu daripada pentadbir. Pendaftaran semasa di peranti ini akan diganti.'**
  String get unlockNotYouBody;

  /// No description provided for @unlockLockedTitle.
  ///
  /// In ms, this message translates to:
  /// **'PIN dikunci sementara'**
  String get unlockLockedTitle;

  /// No description provided for @unlockLockedUntil.
  ///
  /// In ms, this message translates to:
  /// **'Cuba lagi pada {when}'**
  String unlockLockedUntil(String when);

  /// No description provided for @errorUnreachableNamed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menghubungi {name}'**
  String errorUnreachableNamed(String name);

  /// No description provided for @errorUnreachableHint.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan anda di rangkaian WiFi surau.'**
  String get errorUnreachableHint;

  /// No description provided for @navPeople.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna & peranti'**
  String get navPeople;

  /// No description provided for @offlineBannerAt.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Menunjukkan data terakhir ({when}).'**
  String offlineBannerAt(String when);

  /// No description provided for @offlineNoData.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Belum ada data untuk ditunjukkan.'**
  String get offlineNoData;

  /// No description provided for @statusTitle.
  ///
  /// In ms, this message translates to:
  /// **'Keadaan MAXCOM'**
  String get statusTitle;

  /// No description provided for @statusReachedAt.
  ///
  /// In ms, this message translates to:
  /// **'Dihubungi {when}'**
  String statusReachedAt(String when);

  /// No description provided for @statusChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menghubungi MAXCOM'**
  String get statusChecking;

  /// No description provided for @statusUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat dihubungi'**
  String get statusUnreachable;

  /// No description provided for @statusPrayerData.
  ///
  /// In ms, this message translates to:
  /// **'Data waktu solat'**
  String get statusPrayerData;

  /// No description provided for @statusLockedUsers.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna dikunci'**
  String get statusLockedUsers;

  /// No description provided for @statusDataVersion.
  ///
  /// In ms, this message translates to:
  /// **'Versi data'**
  String get statusDataVersion;

  /// No description provided for @daysLeft.
  ///
  /// In ms, this message translates to:
  /// **'{n} hari lagi'**
  String daysLeft(int n);

  /// No description provided for @statusPrayerDataWarning.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik data waktu solat tahun baharu sebelum habis.'**
  String get statusPrayerDataWarning;

  /// No description provided for @statusUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Belum diketahui'**
  String get statusUnknown;

  /// No description provided for @techCheckLine.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM perlukan semakan teknikal. Hubungi {contact}.'**
  String techCheckLine(String contact);

  /// No description provided for @techCheckContactAnyone.
  ///
  /// In ms, this message translates to:
  /// **'pentadbir surau'**
  String get techCheckContactAnyone;

  /// No description provided for @techCheckDaysLeft.
  ///
  /// In ms, this message translates to:
  /// **'Sijil MAXCOM tamat dalam'**
  String get techCheckDaysLeft;

  /// No description provided for @techCheckLastRenew.
  ///
  /// In ms, this message translates to:
  /// **'Pembaharuan automatik terakhir'**
  String get techCheckLastRenew;

  /// No description provided for @techCheckRenewFailed.
  ///
  /// In ms, this message translates to:
  /// **'Gagal {when}'**
  String techCheckRenewFailed(String when);

  /// No description provided for @techCheckRenewNever.
  ///
  /// In ms, this message translates to:
  /// **'Belum pernah berjaya'**
  String get techCheckRenewNever;

  /// No description provided for @techCheckExplain.
  ///
  /// In ms, this message translates to:
  /// **'Pembaharuan berjalan sendiri setiap hari. Jika ia terus gagal, MAXCOM perlu disemak sebelum tarikh di atas.'**
  String get techCheckExplain;

  /// No description provided for @previewShortcut.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton skrin'**
  String get previewShortcut;

  /// No description provided for @previewShortcutHint.
  ///
  /// In ms, this message translates to:
  /// **'Lihat apa yang dipaparkan di TV surau sekarang.'**
  String get previewShortcutHint;

  /// No description provided for @dashAttention.
  ///
  /// In ms, this message translates to:
  /// **'Perlu perhatian'**
  String get dashAttention;

  /// No description provided for @dashPrayerDaysLeft.
  ///
  /// In ms, this message translates to:
  /// **'Data waktu solat tinggal {n} hari'**
  String dashPrayerDaysLeft(int n);

  /// No description provided for @dashPrayerNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data waktu solat'**
  String get dashPrayerNone;

  /// No description provided for @dashLockedUsers.
  ///
  /// In ms, this message translates to:
  /// **'{n} pengguna dikunci'**
  String dashLockedUsers(int n);

  /// No description provided for @dashLockedHint.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci mereka di Pengguna & peranti.'**
  String get dashLockedHint;

  /// No description provided for @dashOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Di skrin TV sekarang'**
  String get dashOnTv;

  /// No description provided for @dashSeeTv.
  ///
  /// In ms, this message translates to:
  /// **'Lihat skrin TV'**
  String get dashSeeTv;

  /// No description provided for @dashSystem.
  ///
  /// In ms, this message translates to:
  /// **'Butiran sistem'**
  String get dashSystem;

  /// No description provided for @dashAppVersion.
  ///
  /// In ms, this message translates to:
  /// **'Versi aplikasi'**
  String get dashAppVersion;

  /// No description provided for @comingBody.
  ///
  /// In ms, this message translates to:
  /// **'Bahagian ini sedang dibina dan akan tersedia dalam kemas kini akan datang.'**
  String get comingBody;

  /// No description provided for @comingPlanned.
  ///
  /// In ms, this message translates to:
  /// **'Dijadualkan: {plan}'**
  String comingPlanned(String plan);

  /// No description provided for @backHome.
  ///
  /// In ms, this message translates to:
  /// **'Kembali ke papan pemuka'**
  String get backHome;

  /// No description provided for @comingSettings.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan atau matikan setiap ciri MAXCOM dan laraskan tetapannya: waktu iqamah, latar belakang, kandungan, audio dan lain-lain.'**
  String get comingSettings;

  /// No description provided for @comingContent.
  ///
  /// In ms, this message translates to:
  /// **'Urus kuliah, penceramah, pengumuman, poster, takwim dan kandungan lain yang dipaparkan di TV.'**
  String get comingContent;

  /// No description provided for @comingPreview.
  ///
  /// In ms, this message translates to:
  /// **'Lihat paparan TV surau secara langsung dari peranti ini.'**
  String get comingPreview;

  /// No description provided for @comingIslamic.
  ///
  /// In ms, this message translates to:
  /// **'Semak dan kemas kini kandungan Islamik yang disimpan di MAXCOM: ayat, hadis, zikir dan tilawah.'**
  String get comingIslamic;

  /// No description provided for @comingPrayerData.
  ///
  /// In ms, this message translates to:
  /// **'Import data waktu solat JAKIM untuk zon surau ini.'**
  String get comingPrayerData;

  /// No description provided for @comingUsers.
  ///
  /// In ms, this message translates to:
  /// **'Tambah AJK, tetapkan peranan mereka, set semula PIN dan urus peranti serta pasangan kiosk.'**
  String get comingUsers;

  /// No description provided for @comingDevices.
  ///
  /// In ms, this message translates to:
  /// **'Lihat peranti yang didaftarkan dan batalkan peranti yang hilang.'**
  String get comingDevices;

  /// No description provided for @comingPairing.
  ///
  /// In ms, this message translates to:
  /// **'Luluskan TV baharu yang meminta dipasangkan dengan MAXCOM.'**
  String get comingPairing;

  /// No description provided for @comingAudit.
  ///
  /// In ms, this message translates to:
  /// **'Lihat siapa mengubah apa dan bila.'**
  String get comingAudit;

  /// No description provided for @comingFinance.
  ///
  /// In ms, this message translates to:
  /// **'Rekod tabung, derma dan perbelanjaan surau, dengan kad tabung di TV.'**
  String get comingFinance;

  /// No description provided for @finTotalAll.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah semua tabung'**
  String get finTotalAll;

  /// No description provided for @finAsOf.
  ///
  /// In ms, this message translates to:
  /// **'Setakat {date}, {n} tabung'**
  String finAsOf(String date, int n);

  /// No description provided for @finMonthIn.
  ///
  /// In ms, this message translates to:
  /// **'Masuk bulan ini'**
  String get finMonthIn;

  /// No description provided for @finMonthOut.
  ///
  /// In ms, this message translates to:
  /// **'Keluar bulan ini'**
  String get finMonthOut;

  /// No description provided for @finActionKutipan.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan'**
  String get finActionKutipan;

  /// No description provided for @finActionBayaran.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran'**
  String get finActionBayaran;

  /// No description provided for @finActionPembetulan.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan'**
  String get finActionPembetulan;

  /// No description provided for @finActionLaporan.
  ///
  /// In ms, this message translates to:
  /// **'Laporan'**
  String get finActionLaporan;

  /// No description provided for @finActionLaporanBulanan.
  ///
  /// In ms, this message translates to:
  /// **'Laporan bulanan'**
  String get finActionLaporanBulanan;

  /// No description provided for @finActionTetapan.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan tabung'**
  String get finActionTetapan;

  /// No description provided for @finFundsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tabung'**
  String get finFundsTitle;

  /// No description provided for @finOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Di skrin TV'**
  String get finOnTv;

  /// No description provided for @finSyncTitle.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan'**
  String get finSyncTitle;

  /// No description provided for @finPendingTv.
  ///
  /// In ms, this message translates to:
  /// **'{n} catatan belum di skrin TV'**
  String finPendingTv(int n);

  /// No description provided for @finPendingHelp.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan di peranti ini. Dipaparkan di skrin TV selepas sampai ke MAXCOM di surau.'**
  String get finPendingHelp;

  /// No description provided for @finAllOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Semua catatan sudah sampai. Skrin TV sudah dikemas kini.'**
  String get finAllOnTv;

  /// No description provided for @finRecent.
  ///
  /// In ms, this message translates to:
  /// **'Catatan terkini'**
  String get finRecent;

  /// No description provided for @finNoEntries.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada catatan.'**
  String get finNoEntries;

  /// No description provided for @finViewOnly.
  ///
  /// In ms, this message translates to:
  /// **'Lihat sahaja. Kutipan, bayaran dan pembetulan dimasukkan oleh Bendahari.'**
  String get finViewOnly;

  /// No description provided for @finSuperBanner.
  ///
  /// In ms, this message translates to:
  /// **'Anda melihat Kewangan sebagai Pentadbir MAXCOM, akses penuh. Setiap paparan dan tindakan direkodkan dalam sejarah audit surau ini.'**
  String get finSuperBanner;

  /// No description provided for @finCorrectionsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Semua pembetulan'**
  String get finCorrectionsTitle;

  /// No description provided for @finCorrectionLine.
  ///
  /// In ms, this message translates to:
  /// **'{ref} bagi {orig}, {fund}'**
  String finCorrectionLine(String ref, String orig, String fund);

  /// No description provided for @finTagCorrected.
  ///
  /// In ms, this message translates to:
  /// **'Dibetulkan'**
  String get finTagCorrected;

  /// No description provided for @finTagPending.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu'**
  String get finTagPending;

  /// No description provided for @finCorrectionOf.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan bagi {ref}'**
  String finCorrectionOf(String ref);

  /// No description provided for @finUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Kewangan belum dapat dibuka. Cuba lagi sebentar.'**
  String get finUnavailable;

  /// No description provided for @finKutipanTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan baharu'**
  String get finKutipanTitle;

  /// No description provided for @finKutipanIntro.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan kutipan selepas tabung dibuka dan dikira. Berfungsi tanpa internet; disimpan di peranti dan diselaraskan kemudian.'**
  String get finKutipanIntro;

  /// No description provided for @finDate.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh'**
  String get finDate;

  /// No description provided for @finToday.
  ///
  /// In ms, this message translates to:
  /// **'Hari ini'**
  String get finToday;

  /// No description provided for @finLastFriday.
  ///
  /// In ms, this message translates to:
  /// **'Jumaat lepas'**
  String get finLastFriday;

  /// No description provided for @finPrevMonthWarn.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh ini dalam bulan lepas. Pastikan laporan bulan itu belum dimuktamadkan.'**
  String get finPrevMonthWarn;

  /// No description provided for @finDateFuture.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh tidak boleh lewat daripada hari ini.'**
  String get finDateFuture;

  /// No description provided for @finFund.
  ///
  /// In ms, this message translates to:
  /// **'Tabung'**
  String get finFund;

  /// No description provided for @finNoFunds.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada tabung. Pentadbir perlu menetapkan tabung dahulu.'**
  String get finNoFunds;

  /// No description provided for @finPerihal.
  ///
  /// In ms, this message translates to:
  /// **'Perihal'**
  String get finPerihal;

  /// No description provided for @finNoPerihal.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada perihal. Pentadbir perlu menetapkannya dahulu.'**
  String get finNoPerihal;

  /// No description provided for @finMethod.
  ///
  /// In ms, this message translates to:
  /// **'Cara diterima'**
  String get finMethod;

  /// No description provided for @finMethodTunai.
  ///
  /// In ms, this message translates to:
  /// **'Tunai'**
  String get finMethodTunai;

  /// No description provided for @finMethodBank.
  ///
  /// In ms, this message translates to:
  /// **'Pindahan bank'**
  String get finMethodBank;

  /// No description provided for @finMethodDuitnow.
  ///
  /// In ms, this message translates to:
  /// **'DuitNow'**
  String get finMethodDuitnow;

  /// No description provided for @finMethodCek.
  ///
  /// In ms, this message translates to:
  /// **'Cek'**
  String get finMethodCek;

  /// No description provided for @finAmount.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah'**
  String get finAmount;

  /// No description provided for @finAmountInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah tidak sah. Contoh: 1,356.80'**
  String get finAmountInvalid;

  /// No description provided for @finAmountZero.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah mesti lebih daripada RM 0.00'**
  String get finAmountZero;

  /// No description provided for @finDenomOpen.
  ///
  /// In ms, this message translates to:
  /// **'Kira mengikut pecahan wang (pilihan)'**
  String get finDenomOpen;

  /// No description provided for @finDenomClose.
  ///
  /// In ms, this message translates to:
  /// **'Sembunyi pecahan wang'**
  String get finDenomClose;

  /// No description provided for @finDenomCoins.
  ///
  /// In ms, this message translates to:
  /// **'Syiling (RM)'**
  String get finDenomCoins;

  /// No description provided for @finDenomSum.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah pecahan'**
  String get finDenomSum;

  /// No description provided for @finDenomMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Pecahan wang berjumlah {sum}, tidak sama dengan jumlah {amount}.'**
  String finDenomMismatch(String sum, String amount);

  /// No description provided for @finCounters.
  ///
  /// In ms, this message translates to:
  /// **'Dikira oleh (2 orang)'**
  String get finCounters;

  /// No description provided for @finCountersCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} daripada 2 dipilih'**
  String finCountersCount(int n);

  /// No description provided for @finCounterYou.
  ///
  /// In ms, this message translates to:
  /// **'anda'**
  String get finCounterYou;

  /// No description provided for @finCounterOther.
  ///
  /// In ms, this message translates to:
  /// **'Nama lain...'**
  String get finCounterOther;

  /// No description provided for @finCounterOtherLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama orang yang mengira'**
  String get finCounterOtherLabel;

  /// No description provided for @finCounterAdd.
  ///
  /// In ms, this message translates to:
  /// **'Tambah'**
  String get finCounterAdd;

  /// No description provided for @finReference.
  ///
  /// In ms, this message translates to:
  /// **'Nombor rujukan'**
  String get finReference;

  /// No description provided for @finReferenceHelp.
  ///
  /// In ms, this message translates to:
  /// **'Saksi tidak diperlukan untuk wang yang masuk terus ke akaun bank surau.'**
  String get finReferenceHelp;

  /// No description provided for @finReferenceShort.
  ///
  /// In ms, this message translates to:
  /// **'Nombor rujukan sekurang-kurangnya 3 aksara.'**
  String get finReferenceShort;

  /// No description provided for @finPhotoCount.
  ///
  /// In ms, this message translates to:
  /// **'Foto helaian kiraan'**
  String get finPhotoCount;

  /// No description provided for @finPhotoReceipt.
  ///
  /// In ms, this message translates to:
  /// **'Resit atau invois'**
  String get finPhotoReceipt;

  /// No description provided for @finPhotoVoucher.
  ///
  /// In ms, this message translates to:
  /// **'Akuan terima atau baucar'**
  String get finPhotoVoucher;

  /// No description provided for @finOptional.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan'**
  String get finOptional;

  /// No description provided for @finPhotoPick.
  ///
  /// In ms, this message translates to:
  /// **'Ambil foto atau pilih gambar'**
  String get finPhotoPick;

  /// No description provided for @finPhotoRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang foto'**
  String get finPhotoRemove;

  /// No description provided for @finPhotoReady.
  ///
  /// In ms, this message translates to:
  /// **'Foto sedia, {kb} KB'**
  String finPhotoReady(int kb);

  /// No description provided for @finPhotoNotImage.
  ///
  /// In ms, this message translates to:
  /// **'Fail itu bukan gambar yang boleh dibaca.'**
  String get finPhotoNotImage;

  /// No description provided for @finPhotoTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Foto masih terlalu besar selepas dikecilkan.'**
  String get finPhotoTooBig;

  /// No description provided for @finNote.
  ///
  /// In ms, this message translates to:
  /// **'Catatan'**
  String get finNote;

  /// No description provided for @finLockedInfo.
  ///
  /// In ms, this message translates to:
  /// **'Selepas disimpan, catatan ini tidak boleh dipadam atau diubah. Kesilapan dibetulkan dengan pembetulan bersebab.'**
  String get finLockedInfo;

  /// No description provided for @finReview.
  ///
  /// In ms, this message translates to:
  /// **'Semak dan simpan'**
  String get finReview;

  /// No description provided for @finConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Simpan kutipan ini?'**
  String get finConfirmTitle;

  /// No description provided for @finConfirmPayTitle.
  ///
  /// In ms, this message translates to:
  /// **'Simpan bayaran ini?'**
  String get finConfirmPayTitle;

  /// No description provided for @finConfirmHelp.
  ///
  /// In ms, this message translates to:
  /// **'Semak sekali lagi. Selepas disimpan, catatan tidak boleh diubah.'**
  String get finConfirmHelp;

  /// No description provided for @finBigTitle.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah besar'**
  String get finBigTitle;

  /// No description provided for @finBigWarn.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah ini lebih daripada {limit}. Semak sekali lagi supaya tiada salah taip.'**
  String finBigWarn(String limit);

  /// No description provided for @finConfirmSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get finConfirmSave;

  /// No description provided for @finCountedBy.
  ///
  /// In ms, this message translates to:
  /// **'Dikira oleh'**
  String get finCountedBy;

  /// No description provided for @finPhoto.
  ///
  /// In ms, this message translates to:
  /// **'Foto'**
  String get finPhoto;

  /// No description provided for @finPhotoOne.
  ///
  /// In ms, this message translates to:
  /// **'1 foto'**
  String get finPhotoOne;

  /// No description provided for @finNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada'**
  String get finNone;

  /// No description provided for @finSavedTitle.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan di peranti ini'**
  String get finSavedTitle;

  /// No description provided for @finSavedRef.
  ///
  /// In ms, this message translates to:
  /// **'Nombor rujukan {ref}'**
  String finSavedRef(String ref);

  /// No description provided for @finSavedWaiting.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu penyelarasan. Akan dihantar sendiri bila MAXCOM di surau atau awan dapat dihubungi.'**
  String get finSavedWaiting;

  /// No description provided for @finNotOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Belum di skrin TV'**
  String get finNotOnTv;

  /// No description provided for @finAnotherKutipan.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan lain'**
  String get finAnotherKutipan;

  /// No description provided for @finAnotherBayaran.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran lain'**
  String get finAnotherBayaran;

  /// No description provided for @finToHome.
  ///
  /// In ms, this message translates to:
  /// **'Ke Kewangan'**
  String get finToHome;

  /// No description provided for @finSaveFailed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menyimpan catatan. Semak semula maklumat.'**
  String get finSaveFailed;

  /// No description provided for @finBayaranTitle.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran baharu'**
  String get finBayaranTitle;

  /// No description provided for @finPayPenceramah.
  ///
  /// In ms, this message translates to:
  /// **'Penceramah'**
  String get finPayPenceramah;

  /// No description provided for @finPayOther.
  ///
  /// In ms, this message translates to:
  /// **'Perbelanjaan lain'**
  String get finPayOther;

  /// No description provided for @finKuliahLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah dari kalendar'**
  String get finKuliahLabel;

  /// No description provided for @finKuliahPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih kuliah'**
  String get finKuliahPick;

  /// No description provided for @finKuliahNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada kuliah untuk dibayar.'**
  String get finKuliahNone;

  /// No description provided for @finKuliahPaid.
  ///
  /// In ms, this message translates to:
  /// **'Dibayar'**
  String get finKuliahPaid;

  /// No description provided for @finKuliahDue.
  ///
  /// In ms, this message translates to:
  /// **'Belum dibayar'**
  String get finKuliahDue;

  /// No description provided for @finKuliahTonight.
  ///
  /// In ms, this message translates to:
  /// **'Malam ini'**
  String get finKuliahTonight;

  /// No description provided for @finKuliahFuture.
  ///
  /// In ms, this message translates to:
  /// **'Akan datang'**
  String get finKuliahFuture;

  /// No description provided for @finKuliahCancelled.
  ///
  /// In ms, this message translates to:
  /// **'Dibatalkan'**
  String get finKuliahCancelled;

  /// No description provided for @finKuliahCancelledWarn.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah ini dibatalkan. Pastikan bayaran ini memang perlu.'**
  String get finKuliahCancelledWarn;

  /// No description provided for @finKuliahTonightInfo.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah ini belum berlangsung (malam ini).'**
  String get finKuliahTonightInfo;

  /// No description provided for @finKuliahAlreadyPaid.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah ini sudah dibayar. Bayaran kedua perlu sebab yang jelas dalam catatan.'**
  String get finKuliahAlreadyPaid;

  /// No description provided for @finPenceramahName.
  ///
  /// In ms, this message translates to:
  /// **'Penceramah'**
  String get finPenceramahName;

  /// No description provided for @finNoPenceramahPerihal.
  ///
  /// In ms, this message translates to:
  /// **'Perihal Penceramah belum ada. Hubungi Pentadbir.'**
  String get finNoPenceramahPerihal;

  /// No description provided for @finSuggestFee.
  ///
  /// In ms, this message translates to:
  /// **'Dicadangkan daripada bayaran terakhir kepada penceramah ini: {amount}'**
  String finSuggestFee(String amount);

  /// No description provided for @finPaidFrom.
  ///
  /// In ms, this message translates to:
  /// **'Dibayar daripada'**
  String get finPaidFrom;

  /// No description provided for @finBalanceAfter.
  ///
  /// In ms, this message translates to:
  /// **'Baki {fund}: {balance}. Selepas bayaran ini: {after}'**
  String finBalanceAfter(String fund, String balance, String after);

  /// No description provided for @finOverdraw.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran ini melebihi baki tabung. Anda masih boleh menyimpannya.'**
  String get finOverdraw;

  /// No description provided for @finPayee.
  ///
  /// In ms, this message translates to:
  /// **'Dibayar kepada'**
  String get finPayee;

  /// No description provided for @finPayeeRequired.
  ///
  /// In ms, this message translates to:
  /// **'Isi nama penerima bayaran.'**
  String get finPayeeRequired;

  /// No description provided for @finPayMethod.
  ///
  /// In ms, this message translates to:
  /// **'Kaedah bayaran'**
  String get finPayMethod;

  /// No description provided for @finCorTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan'**
  String get finCorTitle;

  /// No description provided for @finCorIntro.
  ///
  /// In ms, this message translates to:
  /// **'Pilih catatan yang hendak dibetulkan. Catatan asal tidak diubah atau dipadam; pembetulan ditambah sebagai catatan baharu.'**
  String get finCorIntro;

  /// No description provided for @finCorSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari nombor, tabung atau perihal'**
  String get finCorSearch;

  /// No description provided for @finCorLocked.
  ///
  /// In ms, this message translates to:
  /// **'Catatan asal, dikunci'**
  String get finCorLocked;

  /// No description provided for @finCorKind.
  ///
  /// In ms, this message translates to:
  /// **'Jenis pembetulan'**
  String get finCorKind;

  /// No description provided for @finCorKindAmount.
  ///
  /// In ms, this message translates to:
  /// **'Laras jumlah'**
  String get finCorKindAmount;

  /// No description provided for @finCorKindVoid.
  ///
  /// In ms, this message translates to:
  /// **'Batalkan catatan'**
  String get finCorKindVoid;

  /// No description provided for @finCorKindFund.
  ///
  /// In ms, this message translates to:
  /// **'Tukar tabung'**
  String get finCorKindFund;

  /// No description provided for @finCorRightAmount.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah yang betul'**
  String get finCorRightAmount;

  /// No description provided for @finCorDelta.
  ///
  /// In ms, this message translates to:
  /// **'Pelarasan'**
  String get finCorDelta;

  /// No description provided for @finCorVoidInfo.
  ///
  /// In ms, this message translates to:
  /// **'Catatan {ref} akan dikira sifar dengan pembetulan {delta}. Catatan asal masih kelihatan dalam sejarah dan laporan.'**
  String finCorVoidInfo(String ref, String delta);

  /// No description provided for @finCorRightFund.
  ///
  /// In ms, this message translates to:
  /// **'Tabung yang betul'**
  String get finCorRightFund;

  /// No description provided for @finCorReason.
  ///
  /// In ms, this message translates to:
  /// **'Sebab pembetulan'**
  String get finCorReason;

  /// No description provided for @finCorRequired.
  ///
  /// In ms, this message translates to:
  /// **'Wajib'**
  String get finCorRequired;

  /// No description provided for @finCorReasonHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: kiraan semula oleh 2 AJK mendapati ...'**
  String get finCorReasonHint;

  /// No description provided for @finCorReasonCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} / sekurang-kurangnya 15 aksara'**
  String finCorReasonCount(int n);

  /// No description provided for @finCorReasonOk.
  ///
  /// In ms, this message translates to:
  /// **'{n} aksara'**
  String finCorReasonOk(int n);

  /// No description provided for @finPresetRecount.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan semula'**
  String get finPresetRecount;

  /// No description provided for @finPresetRecountText.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan semula: '**
  String get finPresetRecountText;

  /// No description provided for @finPresetTypo.
  ///
  /// In ms, this message translates to:
  /// **'Salah taip'**
  String get finPresetTypo;

  /// No description provided for @finPresetTypoText.
  ///
  /// In ms, this message translates to:
  /// **'Salah taip jumlah: '**
  String get finPresetTypoText;

  /// No description provided for @finPresetWrongFund.
  ///
  /// In ms, this message translates to:
  /// **'Salah tabung'**
  String get finPresetWrongFund;

  /// No description provided for @finPresetWrongFundText.
  ///
  /// In ms, this message translates to:
  /// **'Salah tabung: '**
  String get finPresetWrongFundText;

  /// No description provided for @finCorNote.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan ialah catatan baharu. Ia tidak boleh dipadam, dan semua Pentadbir boleh melihatnya bersama sebabnya.'**
  String get finCorNote;

  /// No description provided for @finCorSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan pembetulan'**
  String get finCorSave;

  /// No description provided for @finCorFillReason.
  ///
  /// In ms, this message translates to:
  /// **'Isi sebab untuk menyimpan.'**
  String get finCorFillReason;

  /// No description provided for @finCorSaved.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan disimpan di peranti ini ({ref}).'**
  String finCorSaved(String ref);

  /// No description provided for @finCorNoEntries.
  ///
  /// In ms, this message translates to:
  /// **'Tiada catatan untuk dibetulkan.'**
  String get finCorNoEntries;

  /// No description provided for @finCorCurrent.
  ///
  /// In ms, this message translates to:
  /// **'Nilai semasa {amount}'**
  String finCorCurrent(String amount);

  /// No description provided for @finCorSameFund.
  ///
  /// In ms, this message translates to:
  /// **'Pilih tabung yang berbeza.'**
  String get finCorSameFund;

  /// No description provided for @finHistTitle.
  ///
  /// In ms, this message translates to:
  /// **'Sejarah catatan'**
  String get finHistTitle;

  /// No description provided for @finHistOriginal.
  ///
  /// In ms, this message translates to:
  /// **'Asal: {what}'**
  String finHistOriginal(String what);

  /// No description provided for @finHistCorrection.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan {ref}'**
  String finHistCorrection(String ref);

  /// No description provided for @finHistCurrent.
  ///
  /// In ms, this message translates to:
  /// **'Nilai semasa {amount}'**
  String finHistCurrent(String amount);

  /// No description provided for @finHistAfter.
  ///
  /// In ms, this message translates to:
  /// **'Nilai semasa selepas {n} pembetulan. Asal {amount}.'**
  String finHistAfter(int n, String amount);

  /// No description provided for @finHistBy.
  ///
  /// In ms, this message translates to:
  /// **'Oleh'**
  String get finHistBy;

  /// No description provided for @finHistDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get finHistDevice;

  /// No description provided for @finHistEntered.
  ///
  /// In ms, this message translates to:
  /// **'Dimasukkan'**
  String get finHistEntered;

  /// No description provided for @finHistPhoto.
  ///
  /// In ms, this message translates to:
  /// **'Foto helaian kiraan'**
  String get finHistPhoto;

  /// No description provided for @finHistPhotoNote.
  ///
  /// In ms, this message translates to:
  /// **'Dilihat melalui MAXCOM di surau'**
  String get finHistPhotoNote;

  /// No description provided for @finHistFixAgain.
  ///
  /// In ms, this message translates to:
  /// **'Betulkan lagi'**
  String get finHistFixAgain;

  /// No description provided for @finHistLocked.
  ///
  /// In ms, this message translates to:
  /// **'Tiada padam dan tiada ubah di tempat. Sejarah ini sama di telefon, MAXCOM di surau dan awan.'**
  String get finHistLocked;

  /// No description provided for @finUnknownUser.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna tidak dikenali'**
  String get finUnknownUser;

  /// No description provided for @finKindIn.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan'**
  String get finKindIn;

  /// No description provided for @finKindOut.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran'**
  String get finKindOut;

  /// No description provided for @finKindAdjust.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan'**
  String get finKindAdjust;

  /// No description provided for @finKindOpening.
  ///
  /// In ms, this message translates to:
  /// **'Baki pembukaan'**
  String get finKindOpening;

  /// No description provided for @finFundChanged.
  ///
  /// In ms, this message translates to:
  /// **'Tabung ditukar kepada {fund}'**
  String finFundChanged(String fund);

  /// No description provided for @finVoided.
  ///
  /// In ms, this message translates to:
  /// **'Dibatalkan'**
  String get finVoided;

  /// No description provided for @finKuliahOn.
  ///
  /// In ms, this message translates to:
  /// **'{title}, {date}'**
  String finKuliahOn(String title, String date);

  /// No description provided for @comingLive.
  ///
  /// In ms, this message translates to:
  /// **'Siarkan kuliah secara langsung ke TV surau dan YouTube.'**
  String get comingLive;

  /// No description provided for @comingJemaah.
  ///
  /// In ms, this message translates to:
  /// **'Halaman jemaah dan suapan takwim untuk dikongsi dengan kariah.'**
  String get comingJemaah;

  /// No description provided for @comingThisDevice.
  ///
  /// In ms, this message translates to:
  /// **'Nama peranti ini, cap jari untuk buka kunci dan sijil MAXCOM.'**
  String get comingThisDevice;

  /// No description provided for @accountSheetHint.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini didaftarkan atas nama anda.'**
  String get accountSheetHint;

  /// No description provided for @loadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat memuatkan. Cuba lagi.'**
  String get loadFailed;

  /// No description provided for @errorTooMany.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak percubaan. Tunggu sebentar dan cuba lagi.'**
  String get errorTooMany;

  /// No description provided for @peopleTabUsers.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get peopleTabUsers;

  /// No description provided for @peopleTabDevices.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get peopleTabDevices;

  /// No description provided for @peopleTabPairing.
  ///
  /// In ms, this message translates to:
  /// **'Skrin TV'**
  String get peopleTabPairing;

  /// No description provided for @usersAdd.
  ///
  /// In ms, this message translates to:
  /// **'Tambah pengguna'**
  String get usersAdd;

  /// No description provided for @usersEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada pengguna.'**
  String get usersEmpty;

  /// No description provided for @usersInactive.
  ///
  /// In ms, this message translates to:
  /// **'Tidak aktif'**
  String get usersInactive;

  /// No description provided for @usersLocked.
  ///
  /// In ms, this message translates to:
  /// **'PIN dikunci'**
  String get usersLocked;

  /// No description provided for @usersPinPending.
  ///
  /// In ms, this message translates to:
  /// **'PIN belum ditetapkan'**
  String get usersPinPending;

  /// No description provided for @userNameLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama'**
  String get userNameLabel;

  /// No description provided for @userNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Aminah binti Yusof'**
  String get userNameHint;

  /// No description provided for @userNameRequired.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan nama pengguna'**
  String get userNameRequired;

  /// No description provided for @userRolesTitle.
  ///
  /// In ms, this message translates to:
  /// **'Peranan'**
  String get userRolesTitle;

  /// No description provided for @userRolesHint.
  ///
  /// In ms, this message translates to:
  /// **'Seorang boleh memegang lebih daripada satu peranan.'**
  String get userRolesHint;

  /// No description provided for @userRoleRequired.
  ///
  /// In ms, this message translates to:
  /// **'Pilih sekurang-kurangnya satu peranan.'**
  String get userRoleRequired;

  /// No description provided for @roleAdminHint.
  ///
  /// In ms, this message translates to:
  /// **'Semua tetapan, pengguna, peranti dan log perubahan'**
  String get roleAdminHint;

  /// No description provided for @roleTreasurerHint.
  ///
  /// In ms, this message translates to:
  /// **'Kewangan dan tabung surau'**
  String get roleTreasurerHint;

  /// No description provided for @roleMediaHint.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan dan poster'**
  String get roleMediaHint;

  /// No description provided for @roleLive.
  ///
  /// In ms, this message translates to:
  /// **'Siaran Langsung'**
  String get roleLive;

  /// No description provided for @roleLiveHint.
  ///
  /// In ms, this message translates to:
  /// **'Membuka menu Siaran langsung dan tetapannya: kamera luaran, sumber audio, skrin, YouTube dan rakaman'**
  String get roleLiveHint;

  /// No description provided for @usersMediaNoLiveHint.
  ///
  /// In ms, this message translates to:
  /// **'Peranan Media tidak lagi boleh membuat siaran langsung. Beri peranan Siaran Langsung kepada pengguna yang perlu.'**
  String get usersMediaNoLiveHint;

  /// No description provided for @roleAjkHint.
  ///
  /// In ms, this message translates to:
  /// **'Melihat tetapan dan kandungan sahaja, dan Kewangan (lihat sahaja)'**
  String get roleAjkHint;

  /// No description provided for @userCreated.
  ///
  /// In ms, this message translates to:
  /// **'{name} ditambah. Seterusnya, daftar peranti mereka.'**
  String userCreated(String name);

  /// No description provided for @userRolesSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan peranan'**
  String get userRolesSave;

  /// No description provided for @userRolesSaved.
  ///
  /// In ms, this message translates to:
  /// **'Peranan disimpan'**
  String get userRolesSaved;

  /// No description provided for @userEnrolDevice.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti'**
  String get userEnrolDevice;

  /// No description provided for @userEnrolDeviceHint.
  ///
  /// In ms, this message translates to:
  /// **'Jana kod QR untuk telefon atau iPad {name}.'**
  String userEnrolDeviceHint(String name);

  /// No description provided for @userResetPin.
  ///
  /// In ms, this message translates to:
  /// **'Set semula PIN'**
  String get userResetPin;

  /// No description provided for @userResetPinHint.
  ///
  /// In ms, this message translates to:
  /// **'{name} akan tetapkan PIN baharu semasa buka kunci seterusnya.'**
  String userResetPinHint(String name);

  /// No description provided for @userResetPinTitle.
  ///
  /// In ms, this message translates to:
  /// **'Set semula PIN {name}?'**
  String userResetPinTitle(String name);

  /// No description provided for @userResetPinLost.
  ///
  /// In ms, this message translates to:
  /// **'Adakah telefon ini hilang?'**
  String get userResetPinLost;

  /// No description provided for @userResetPinLostHint.
  ///
  /// In ms, this message translates to:
  /// **'Tandakan peranti yang hilang. Peranti itu dibatalkan serentak dan tidak boleh tetapkan PIN baharu.'**
  String get userResetPinLostHint;

  /// No description provided for @userResetPinNoDevices.
  ///
  /// In ms, this message translates to:
  /// **'{name} belum ada peranti.'**
  String userResetPinNoDevices(String name);

  /// No description provided for @userResetPinDone.
  ///
  /// In ms, this message translates to:
  /// **'PIN {name} diset semula.'**
  String userResetPinDone(String name);

  /// No description provided for @userResetPinDoneRevoked.
  ///
  /// In ms, this message translates to:
  /// **'PIN {name} diset semula. {n} peranti dibatalkan.'**
  String userResetPinDoneRevoked(String name, int n);

  /// No description provided for @userDeactivate.
  ///
  /// In ms, this message translates to:
  /// **'Nyahaktifkan'**
  String get userDeactivate;

  /// No description provided for @userDeactivateHint.
  ///
  /// In ms, this message translates to:
  /// **'Semua peranti dan kod {name} dibatalkan. Nama kekal dalam log dan rekod kewangan.'**
  String userDeactivateHint(String name);

  /// No description provided for @userDeactivateTitle.
  ///
  /// In ms, this message translates to:
  /// **'Nyahaktifkan {name}?'**
  String userDeactivateTitle(String name);

  /// No description provided for @userDeactivated.
  ///
  /// In ms, this message translates to:
  /// **'{name} dinyahaktifkan.'**
  String userDeactivated(String name);

  /// No description provided for @userNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna tidak dijumpai.'**
  String get userNotFound;

  /// No description provided for @enrolBoxOnly.
  ///
  /// In ms, this message translates to:
  /// **'Kod peranti mesti dibuat oleh MAXCOM di surau. Gunakan telefon Pentadbir Surau di Wi-Fi surau.'**
  String get enrolBoxOnly;

  /// No description provided for @enrolQrTitle.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti'**
  String get enrolQrTitle;

  /// No description provided for @enrolQrFor.
  ///
  /// In ms, this message translates to:
  /// **'Peranti untuk {name}'**
  String enrolQrFor(String name);

  /// No description provided for @enrolQrNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Telefon {name}'**
  String enrolQrNameHint(String name);

  /// No description provided for @enrolQrGenerate.
  ///
  /// In ms, this message translates to:
  /// **'Jana kod QR'**
  String get enrolQrGenerate;

  /// No description provided for @enrolQrScanHint.
  ///
  /// In ms, this message translates to:
  /// **'Minta {name} buka aplikasi MAXCOM di peranti mereka dan imbas kod ini.'**
  String enrolQrScanHint(String name);

  /// No description provided for @enrolQrCodeLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kod semakan'**
  String get enrolQrCodeLabel;

  /// No description provided for @enrolQrExpiresIn.
  ///
  /// In ms, this message translates to:
  /// **'Tamat dalam {time}'**
  String enrolQrExpiresIn(String time);

  /// No description provided for @enrolQrExpired.
  ///
  /// In ms, this message translates to:
  /// **'Kod telah tamat. Jana kod baharu.'**
  String get enrolQrExpired;

  /// No description provided for @enrolQrNew.
  ///
  /// In ms, this message translates to:
  /// **'Jana kod baharu'**
  String get enrolQrNew;

  /// No description provided for @enrolQrCopy.
  ///
  /// In ms, this message translates to:
  /// **'Salin kod'**
  String get enrolQrCopy;

  /// No description provided for @enrolQrCopied.
  ///
  /// In ms, this message translates to:
  /// **'Kod disalin'**
  String get enrolQrCopied;

  /// No description provided for @enrolQrCaHint.
  ///
  /// In ms, this message translates to:
  /// **'Minta mereka bandingkan cap jari sijil ini dengan yang di skrin mereka.'**
  String get enrolQrCaHint;

  /// No description provided for @devicesEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada peranti didaftarkan.'**
  String get devicesEmpty;

  /// No description provided for @devicesPair.
  ///
  /// In ms, this message translates to:
  /// **'Padankan skrin TV'**
  String get devicesPair;

  /// No description provided for @devicesRevoke.
  ///
  /// In ms, this message translates to:
  /// **'Padam'**
  String get devicesRevoke;

  /// No description provided for @devicesRevokeTitle.
  ///
  /// In ms, this message translates to:
  /// **'Padam {name}?'**
  String devicesRevokeTitle(String name);

  /// No description provided for @devicesRevokeBody.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini tidak lagi boleh buka kunci. Untuk guna semula, daftar dengan kod QR baharu.'**
  String get devicesRevokeBody;

  /// No description provided for @devicesRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Dipadam'**
  String get devicesRevoked;

  /// No description provided for @devicesRevokedToast.
  ///
  /// In ms, this message translates to:
  /// **'{name} dipadam.'**
  String devicesRevokedToast(String name);

  /// No description provided for @devicesKioskGroup.
  ///
  /// In ms, this message translates to:
  /// **'Skrin TV'**
  String get devicesKioskGroup;

  /// No description provided for @platformAndroid.
  ///
  /// In ms, this message translates to:
  /// **'Android'**
  String get platformAndroid;

  /// No description provided for @platformIosWeb.
  ///
  /// In ms, this message translates to:
  /// **'iPad (Safari)'**
  String get platformIosWeb;

  /// No description provided for @platformWeb.
  ///
  /// In ms, this message translates to:
  /// **'Pelayar web'**
  String get platformWeb;

  /// No description provided for @platformKiosk.
  ///
  /// In ms, this message translates to:
  /// **'Skrin TV'**
  String get platformKiosk;

  /// No description provided for @pairingTitle.
  ///
  /// In ms, this message translates to:
  /// **'Padankan skrin TV'**
  String get pairingTitle;

  /// No description provided for @pairingIntro.
  ///
  /// In ms, this message translates to:
  /// **'Semasa pertama kali dihidupkan, TV menunjukkan kod 6 digit. Masukkan kod itu di sini untuk meluluskan skrin tersebut.'**
  String get pairingIntro;

  /// No description provided for @pairingPendingTitle.
  ///
  /// In ms, this message translates to:
  /// **'Skrin yang menunggu'**
  String get pairingPendingTitle;

  /// No description provided for @pairingPendingNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada skrin sedang menunggu kelulusan.'**
  String get pairingPendingNone;

  /// No description provided for @pairingPendingRow.
  ///
  /// In ms, this message translates to:
  /// **'Dari {ip}, {age} yang lalu'**
  String pairingPendingRow(String ip, String age);

  /// No description provided for @pairingUnknownIp.
  ///
  /// In ms, this message translates to:
  /// **'alamat tidak diketahui'**
  String get pairingUnknownIp;

  /// No description provided for @pairingCodeLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kod di TV'**
  String get pairingCodeLabel;

  /// No description provided for @pairingCodeRequired.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan 6 digit yang ditunjukkan di TV.'**
  String get pairingCodeRequired;

  /// No description provided for @pairingNameLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama skrin (pilihan)'**
  String get pairingNameLabel;

  /// No description provided for @pairingNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Skrin utama'**
  String get pairingNameHint;

  /// No description provided for @pairingApprove.
  ///
  /// In ms, this message translates to:
  /// **'Luluskan'**
  String get pairingApprove;

  /// No description provided for @pairingDone.
  ///
  /// In ms, this message translates to:
  /// **'Skrin dipadankan: {name}'**
  String pairingDone(String name);

  /// No description provided for @pairingDoneDetail.
  ///
  /// In ms, this message translates to:
  /// **'Permintaan dari {ip}, kod berumur {age}.'**
  String pairingDoneDetail(String ip, String age);

  /// No description provided for @pairingStrangerHint.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan alamat itu TV surau anda, bukan peranti asing.'**
  String get pairingStrangerHint;

  /// No description provided for @ageSeconds.
  ///
  /// In ms, this message translates to:
  /// **'{n} saat'**
  String ageSeconds(int n);

  /// No description provided for @ageMinutes.
  ///
  /// In ms, this message translates to:
  /// **'{n} minit'**
  String ageMinutes(int n);

  /// No description provided for @auditEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada perubahan direkodkan.'**
  String get auditEmpty;

  /// No description provided for @auditFilterAll.
  ///
  /// In ms, this message translates to:
  /// **'Semua'**
  String get auditFilterAll;

  /// No description provided for @auditLoadMore.
  ///
  /// In ms, this message translates to:
  /// **'Muat lagi'**
  String get auditLoadMore;

  /// No description provided for @auditBefore.
  ///
  /// In ms, this message translates to:
  /// **'Sebelum'**
  String get auditBefore;

  /// No description provided for @auditAfter.
  ///
  /// In ms, this message translates to:
  /// **'Selepas'**
  String get auditAfter;

  /// No description provided for @auditNoDetail.
  ///
  /// In ms, this message translates to:
  /// **'Tiada butiran'**
  String get auditNoDetail;

  /// No description provided for @auditEmptyValue.
  ///
  /// In ms, this message translates to:
  /// **'kosong'**
  String get auditEmptyValue;

  /// No description provided for @auditKeyEnabled.
  ///
  /// In ms, this message translates to:
  /// **'Dihidupkan'**
  String get auditKeyEnabled;

  /// No description provided for @auditKeyName.
  ///
  /// In ms, this message translates to:
  /// **'Nama'**
  String get auditKeyName;

  /// No description provided for @auditKeyRoles.
  ///
  /// In ms, this message translates to:
  /// **'Peranan'**
  String get auditKeyRoles;

  /// No description provided for @auditKeyActive.
  ///
  /// In ms, this message translates to:
  /// **'Aktif'**
  String get auditKeyActive;

  /// No description provided for @auditKeyPinRequired.
  ///
  /// In ms, this message translates to:
  /// **'PIN perlu ditetapkan'**
  String get auditKeyPinRequired;

  /// No description provided for @auditKeyPlatform.
  ///
  /// In ms, this message translates to:
  /// **'Jenis peranti'**
  String get auditKeyPlatform;

  /// No description provided for @auditKeyRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Dibatalkan'**
  String get auditKeyRevoked;

  /// No description provided for @auditKeyUser.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get auditKeyUser;

  /// No description provided for @auditKeyId.
  ///
  /// In ms, this message translates to:
  /// **'ID'**
  String get auditKeyId;

  /// No description provided for @auditEntityUsers.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get auditEntityUsers;

  /// No description provided for @auditEntityDevices.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get auditEntityDevices;

  /// No description provided for @auditEntitySettings.
  ///
  /// In ms, this message translates to:
  /// **'Konfigurasi'**
  String get auditEntitySettings;

  /// No description provided for @auditEntityContent.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan'**
  String get auditEntityContent;

  /// No description provided for @auditEntityPrayer.
  ///
  /// In ms, this message translates to:
  /// **'Waktu solat'**
  String get auditEntityPrayer;

  /// No description provided for @auditEntityIslamic.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan Islamik'**
  String get auditEntityIslamic;

  /// No description provided for @auditEntityAssets.
  ///
  /// In ms, this message translates to:
  /// **'Fail'**
  String get auditEntityAssets;

  /// No description provided for @auditEntityPrayerDays.
  ///
  /// In ms, this message translates to:
  /// **'Data waktu solat'**
  String get auditEntityPrayerDays;

  /// No description provided for @auditKeyCount.
  ///
  /// In ms, this message translates to:
  /// **'Bilangan hari'**
  String get auditKeyCount;

  /// No description provided for @auditKeyFrom.
  ///
  /// In ms, this message translates to:
  /// **'Dari'**
  String get auditKeyFrom;

  /// No description provided for @auditKeyTo.
  ///
  /// In ms, this message translates to:
  /// **'Hingga'**
  String get auditKeyTo;

  /// No description provided for @auditKeySummary.
  ///
  /// In ms, this message translates to:
  /// **'Ringkasan'**
  String get auditKeySummary;

  /// No description provided for @auditKeyDetail.
  ///
  /// In ms, this message translates to:
  /// **'Butiran'**
  String get auditKeyDetail;

  /// No description provided for @auditActionIslamicFetch.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun'**
  String get auditActionIslamicFetch;

  /// No description provided for @auditSystem.
  ///
  /// In ms, this message translates to:
  /// **'Sistem'**
  String get auditSystem;

  /// No description provided for @thisDevicePlatform.
  ///
  /// In ms, this message translates to:
  /// **'Jenis'**
  String get thisDevicePlatform;

  /// No description provided for @thisDeviceUser.
  ///
  /// In ms, this message translates to:
  /// **'Didaftarkan atas nama'**
  String get thisDeviceUser;

  /// No description provided for @thisDeviceChangePin.
  ///
  /// In ms, this message translates to:
  /// **'Tukar PIN'**
  String get thisDeviceChangePin;

  /// No description provided for @thisDeviceChangePinHint.
  ///
  /// In ms, this message translates to:
  /// **'PIN yang sama digunakan di semua peranti anda.'**
  String get thisDeviceChangePinHint;

  /// No description provided for @pinCurrentLabel.
  ///
  /// In ms, this message translates to:
  /// **'PIN semasa'**
  String get pinCurrentLabel;

  /// No description provided for @pinChanged.
  ///
  /// In ms, this message translates to:
  /// **'PIN ditukar'**
  String get pinChanged;

  /// No description provided for @thisDeviceBiometricHint.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci dengan cap jari, tanpa taip PIN.'**
  String get thisDeviceBiometricHint;

  /// No description provided for @thisDeviceBiometricOnTitle.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan PIN anda'**
  String get thisDeviceBiometricOnTitle;

  /// No description provided for @thisDeviceBiometricOnBody.
  ///
  /// In ms, this message translates to:
  /// **'PIN disimpan dengan selamat di peranti ini dan dibuka dengan cap jari anda sahaja.'**
  String get thisDeviceBiometricOnBody;

  /// No description provided for @thisDeviceBiometricOn.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari dihidupkan'**
  String get thisDeviceBiometricOn;

  /// No description provided for @thisDeviceBiometricOff.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari dimatikan'**
  String get thisDeviceBiometricOff;

  /// No description provided for @thisDeviceLogoutHint.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi ini. Pendaftaran peranti kekal.'**
  String get thisDeviceLogoutHint;

  /// No description provided for @thisDeviceForget.
  ///
  /// In ms, this message translates to:
  /// **'Lupakan peranti ini'**
  String get thisDeviceForget;

  /// No description provided for @thisDeviceForgetHint.
  ///
  /// In ms, this message translates to:
  /// **'Padam kunci dan pendaftaran di peranti ini. Anda perlukan kod QR baharu untuk guna semula.'**
  String get thisDeviceForgetHint;

  /// No description provided for @thisDeviceForgetTitle.
  ///
  /// In ms, this message translates to:
  /// **'Lupakan peranti ini?'**
  String get thisDeviceForgetTitle;

  /// No description provided for @thisDeviceForgetConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Lupakan'**
  String get thisDeviceForgetConfirm;

  /// No description provided for @settingsListHint.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan atau matikan setiap ciri dan laraskan tetapannya.'**
  String get settingsListHint;

  /// No description provided for @settingsReadOnlyHint.
  ///
  /// In ms, this message translates to:
  /// **'Anda boleh melihat tetapan tetapi tidak mengubahnya.'**
  String get settingsReadOnlyHint;

  /// No description provided for @settingsLockedHint.
  ///
  /// In ms, this message translates to:
  /// **'Ciri asas ini sentiasa hidup dan tidak boleh dimatikan.'**
  String get settingsLockedHint;

  /// No description provided for @settingsFeatureOffHint.
  ///
  /// In ms, this message translates to:
  /// **'Ciri ini dimatikan. Tetapannya disimpan dan digunakan semula apabila dihidupkan.'**
  String get settingsFeatureOffHint;

  /// No description provided for @settingsNoSettings.
  ///
  /// In ms, this message translates to:
  /// **'Ciri ini tiada tetapan lain. Hidupkan atau matikan sahaja.'**
  String get settingsNoSettings;

  /// No description provided for @settingsSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get settingsSave;

  /// No description provided for @settingsSaved.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan disimpan'**
  String get settingsSaved;

  /// No description provided for @settingsChangedElsewhere.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan ini telah diubah di peranti lain. Simpan akan menggantikannya.'**
  String get settingsChangedElsewhere;

  /// No description provided for @settingsReset.
  ///
  /// In ms, this message translates to:
  /// **'Set semula kepada lalai'**
  String get settingsReset;

  /// No description provided for @settingsResetTitle.
  ///
  /// In ms, this message translates to:
  /// **'Set semula {feature}?'**
  String settingsResetTitle(String feature);

  /// No description provided for @settingsResetBody.
  ///
  /// In ms, this message translates to:
  /// **'Semua tetapan ciri ini kembali kepada nilai asal MAXCOM.'**
  String get settingsResetBody;

  /// No description provided for @settingsResetDone.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan asal dipulihkan'**
  String get settingsResetDone;

  /// No description provided for @settingsCopyToAllDays.
  ///
  /// In ms, this message translates to:
  /// **'Salin ke semua hari'**
  String get settingsCopyToAllDays;

  /// No description provided for @settingsCopiedToAllDays.
  ///
  /// In ms, this message translates to:
  /// **'Nilai {day} disalin ke semua hari'**
  String settingsCopiedToAllDays(String day);

  /// No description provided for @settingsOptionalHint.
  ///
  /// In ms, this message translates to:
  /// **'Biarkan kosong untuk tetapan asal.'**
  String get settingsOptionalHint;

  /// No description provided for @settingsShortNameHint.
  ///
  /// In ms, this message translates to:
  /// **'cth. SDM'**
  String get settingsShortNameHint;

  /// No description provided for @settingsShortNameHelper.
  ///
  /// In ms, this message translates to:
  /// **'Kosongkan untuk guna nama surau.'**
  String get settingsShortNameHelper;

  /// No description provided for @settingsDecrease.
  ///
  /// In ms, this message translates to:
  /// **'Kurang'**
  String get settingsDecrease;

  /// No description provided for @settingsIncrease.
  ///
  /// In ms, this message translates to:
  /// **'Tambah'**
  String get settingsIncrease;

  /// No description provided for @settingsNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Ciri tidak dijumpai.'**
  String get settingsNotFound;

  /// No description provided for @settingsSwitchedOn.
  ///
  /// In ms, this message translates to:
  /// **'{feature} dihidupkan'**
  String settingsSwitchedOn(String feature);

  /// No description provided for @settingsSwitchedOff.
  ///
  /// In ms, this message translates to:
  /// **'{feature} dimatikan'**
  String settingsSwitchedOff(String feature);

  /// No description provided for @settingsBackgroundsBuiltIn.
  ///
  /// In ms, this message translates to:
  /// **'Gambar sedia ada'**
  String get settingsBackgroundsBuiltIn;

  /// No description provided for @settingsBackgroundsUploaded.
  ///
  /// In ms, this message translates to:
  /// **'Gambar dimuat naik'**
  String get settingsBackgroundsUploaded;

  /// No description provided for @settingsBackgroundsHint.
  ///
  /// In ms, this message translates to:
  /// **'Gambar yang ditanda bergilir di TV mengikut tetapan Tukar gambar.'**
  String get settingsBackgroundsHint;

  /// No description provided for @settingsBackgroundsEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada gambar dipilih. TV menggunakan gambar pertama sedia ada.'**
  String get settingsBackgroundsEmpty;

  /// No description provided for @settingsBackgroundsNone.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada gambar dimuat naik.'**
  String get settingsBackgroundsNone;

  /// No description provided for @settingsBackgroundsOffline.
  ///
  /// In ms, this message translates to:
  /// **'Senarai gambar dimuat naik tidak dapat dibaca sekarang. Gambar sedia ada masih boleh dipilih.'**
  String get settingsBackgroundsOffline;

  /// No description provided for @settingsBackgroundsOrder.
  ///
  /// In ms, this message translates to:
  /// **'Nombor pada gambar ialah susunan giliran di TV. Ketik gambar mengikut susunan yang dikehendaki.'**
  String get settingsBackgroundsOrder;

  /// No description provided for @settingsBackgroundsUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik gambar latar'**
  String get settingsBackgroundsUpload;

  /// No description provided for @settingsBackgroundUploaded.
  ///
  /// In ms, this message translates to:
  /// **'Gambar latar disimpan, akan dimuat naik'**
  String get settingsBackgroundUploaded;

  /// No description provided for @settingsBackgroundTile.
  ///
  /// In ms, this message translates to:
  /// **'Gambar dimuat naik {n}'**
  String settingsBackgroundTile(int n);

  /// No description provided for @settingsBackgroundRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang {name}'**
  String settingsBackgroundRemove(String name);

  /// No description provided for @settingsBuiltInImage.
  ///
  /// In ms, this message translates to:
  /// **'Gambar {n}'**
  String settingsBuiltInImage(int n);

  /// No description provided for @contentKindsHint.
  ///
  /// In ms, this message translates to:
  /// **'Pilih jenis kandungan untuk dilihat atau disunting.'**
  String get contentKindsHint;

  /// No description provided for @contentAdd.
  ///
  /// In ms, this message translates to:
  /// **'Tambah {kind}'**
  String contentAdd(String kind);

  /// No description provided for @contentEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada {kind}.'**
  String contentEmpty(String kind);

  /// No description provided for @contentSearchHint.
  ///
  /// In ms, this message translates to:
  /// **'Cari'**
  String get contentSearchHint;

  /// No description provided for @contentNoMatch.
  ///
  /// In ms, this message translates to:
  /// **'Tiada padanan.'**
  String get contentNoMatch;

  /// No description provided for @contentCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} rekod'**
  String contentCount(int n);

  /// No description provided for @contentNew.
  ///
  /// In ms, this message translates to:
  /// **'{kind} baharu'**
  String contentNew(String kind);

  /// No description provided for @contentEdit.
  ///
  /// In ms, this message translates to:
  /// **'Sunting {kind}'**
  String contentEdit(String kind);

  /// No description provided for @contentSaved.
  ///
  /// In ms, this message translates to:
  /// **'{kind} disimpan.'**
  String contentSaved(String kind);

  /// No description provided for @contentDeleteTitle.
  ///
  /// In ms, this message translates to:
  /// **'Padam {kind} ini?'**
  String contentDeleteTitle(String kind);

  /// No description provided for @contentDeleteBody.
  ///
  /// In ms, this message translates to:
  /// **'Ia dikeluarkan daripada TV serta-merta dan tidak boleh dikembalikan.'**
  String get contentDeleteBody;

  /// No description provided for @contentDeleted.
  ///
  /// In ms, this message translates to:
  /// **'{kind} dipadam.'**
  String contentDeleted(String kind);

  /// No description provided for @contentNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Rekod tidak dijumpai.'**
  String get contentNotFound;

  /// No description provided for @contentCancelledBadge.
  ///
  /// In ms, this message translates to:
  /// **'Batal'**
  String get contentCancelledBadge;

  /// No description provided for @contentCancelledHint.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah yang dibatalkan ditanda Batal di TV dan tidak dipadam.'**
  String get contentCancelledHint;

  /// No description provided for @contentRefMissing.
  ///
  /// In ms, this message translates to:
  /// **'{what} tidak dijumpai'**
  String contentRefMissing(String what);

  /// No description provided for @contentRefUnknown.
  ///
  /// In ms, this message translates to:
  /// **'{what} tidak diketahui'**
  String contentRefUnknown(String what);

  /// No description provided for @contentPickRef.
  ///
  /// In ms, this message translates to:
  /// **'Pilih {what}'**
  String contentPickRef(String what);

  /// No description provided for @contentNoRefItems.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada {what}. Tambah dahulu di bahagian {what}.'**
  String contentNoRefItems(String what);

  /// No description provided for @contentDateHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: 2026-11-05'**
  String get contentDateHint;

  /// No description provided for @contentTimeHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: 19:15'**
  String get contentTimeHint;

  /// No description provided for @contentDateTimeHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: 2026-11-20T20:30'**
  String get contentDateTimeHint;

  /// No description provided for @contentPickDate.
  ///
  /// In ms, this message translates to:
  /// **'Pilih tarikh'**
  String get contentPickDate;

  /// No description provided for @contentPickTime.
  ///
  /// In ms, this message translates to:
  /// **'Pilih masa'**
  String get contentPickTime;

  /// No description provided for @contentDaysHint.
  ///
  /// In ms, this message translates to:
  /// **'Pilih hari ia dipaparkan.'**
  String get contentDaysHint;

  /// No description provided for @contentEveryDay.
  ///
  /// In ms, this message translates to:
  /// **'Setiap hari'**
  String get contentEveryDay;

  /// No description provided for @contentOptional.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan'**
  String get contentOptional;

  /// No description provided for @contentNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada'**
  String get contentNone;

  /// No description provided for @contentUntil.
  ///
  /// In ms, this message translates to:
  /// **'hingga'**
  String get contentUntil;

  /// No description provided for @contentShownFromTo.
  ///
  /// In ms, this message translates to:
  /// **'{from} hingga {to}'**
  String contentShownFromTo(String from, String to);

  /// No description provided for @contentSurah.
  ///
  /// In ms, this message translates to:
  /// **'Surah {n} · {name}'**
  String contentSurah(int n, String name);

  /// No description provided for @contentMinutesBefore.
  ///
  /// In ms, this message translates to:
  /// **'{n} minit sebelum {slot}'**
  String contentMinutesBefore(int n, String slot);

  /// No description provided for @contentOff.
  ///
  /// In ms, this message translates to:
  /// **'Dimatikan'**
  String get contentOff;

  /// No description provided for @contentOrder.
  ///
  /// In ms, this message translates to:
  /// **'Susunan {n}'**
  String contentOrder(int n);

  /// No description provided for @contentRepeat.
  ///
  /// In ms, this message translates to:
  /// **'{n} kali'**
  String contentRepeat(int n);

  /// No description provided for @contentCharsLeft.
  ///
  /// In ms, this message translates to:
  /// **'{n} aksara lagi'**
  String contentCharsLeft(int n);

  /// No description provided for @contentPhoneHint.
  ///
  /// In ms, this message translates to:
  /// **'Nombor ini untuk AJK sahaja dan tidak dipaparkan di TV.'**
  String get contentPhoneHint;

  /// No description provided for @contentAssetHint.
  ///
  /// In ms, this message translates to:
  /// **'Gambar dikecilkan secara automatik sebelum dimuat naik.'**
  String get contentAssetHint;

  /// No description provided for @imagePick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih gambar'**
  String get imagePick;

  /// No description provided for @imageChange.
  ///
  /// In ms, this message translates to:
  /// **'Tukar gambar'**
  String get imageChange;

  /// No description provided for @imageRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang gambar'**
  String get imageRemove;

  /// No description provided for @imagePreparing.
  ///
  /// In ms, this message translates to:
  /// **'Menyediakan gambar'**
  String get imagePreparing;

  /// No description provided for @imageUploading.
  ///
  /// In ms, this message translates to:
  /// **'Menyimpan gambar'**
  String get imageUploading;

  /// No description provided for @imageQueued.
  ///
  /// In ms, this message translates to:
  /// **'Memuat naik…'**
  String get imageQueued;

  /// No description provided for @imageLost.
  ///
  /// In ms, this message translates to:
  /// **'Gagal dimuat naik'**
  String get imageLost;

  /// No description provided for @imageChooseAgain.
  ///
  /// In ms, this message translates to:
  /// **'Pilih semula gambar'**
  String get imageChooseAgain;

  /// No description provided for @imageUploaded.
  ///
  /// In ms, this message translates to:
  /// **'Gambar dimuat naik'**
  String get imageUploaded;

  /// No description provided for @imageSaved.
  ///
  /// In ms, this message translates to:
  /// **'Gambar disimpan, akan dimuat naik'**
  String get imageSaved;

  /// No description provided for @imagePickFailed.
  ///
  /// In ms, this message translates to:
  /// **'Gambar tidak dapat dibaca. Cuba gambar lain.'**
  String get imagePickFailed;

  /// No description provided for @imageFailed.
  ///
  /// In ms, this message translates to:
  /// **'Gambar tidak dapat dimuat naik.'**
  String get imageFailed;

  /// No description provided for @imageNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada gambar'**
  String get imageNone;

  /// No description provided for @imageSize.
  ///
  /// In ms, this message translates to:
  /// **'{w} x {h} piksel'**
  String imageSize(int w, int h);

  /// No description provided for @imageAdjust.
  ///
  /// In ms, this message translates to:
  /// **'Laraskan gambar'**
  String get imageAdjust;

  /// No description provided for @imageAdjustLogo.
  ///
  /// In ms, this message translates to:
  /// **'Laraskan logo'**
  String get imageAdjustLogo;

  /// No description provided for @imageAdjusted.
  ///
  /// In ms, this message translates to:
  /// **'Gambar dilaraskan'**
  String get imageAdjusted;

  /// No description provided for @imageAdjustHint.
  ///
  /// In ms, this message translates to:
  /// **'Seret untuk mengalih, cubit atau gulung tetikus untuk zum. Papan kekunci: anak panah mengalih, tambah dan tolak zum, R putar.'**
  String get imageAdjustHint;

  /// No description provided for @imageFrameHint.
  ///
  /// In ms, this message translates to:
  /// **'Seret tepi bingkai untuk mengubah kawasan yang dipaparkan.'**
  String get imageFrameHint;

  /// No description provided for @imageZoomIn.
  ///
  /// In ms, this message translates to:
  /// **'Zum masuk'**
  String get imageZoomIn;

  /// No description provided for @imageZoomOut.
  ///
  /// In ms, this message translates to:
  /// **'Zum keluar'**
  String get imageZoomOut;

  /// No description provided for @imageRotate.
  ///
  /// In ms, this message translates to:
  /// **'Putar 90 darjah'**
  String get imageRotate;

  /// No description provided for @imageReset.
  ///
  /// In ms, this message translates to:
  /// **'Set semula'**
  String get imageReset;

  /// No description provided for @imageStep.
  ///
  /// In ms, this message translates to:
  /// **'Langkah {n} daripada {total}'**
  String imageStep(int n, int total);

  /// No description provided for @imageStepCrop.
  ///
  /// In ms, this message translates to:
  /// **'Potong dan latar'**
  String get imageStepCrop;

  /// No description provided for @imageStepSquare.
  ///
  /// In ms, this message translates to:
  /// **'Ikon segi empat'**
  String get imageStepSquare;

  /// No description provided for @imageStepNext.
  ///
  /// In ms, this message translates to:
  /// **'Seterusnya'**
  String get imageStepNext;

  /// No description provided for @imageStepBack.
  ///
  /// In ms, this message translates to:
  /// **'Kembali'**
  String get imageStepBack;

  /// No description provided for @imageBgTitle.
  ///
  /// In ms, this message translates to:
  /// **'Latar belakang'**
  String get imageBgTitle;

  /// No description provided for @imageBgRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang latar putih'**
  String get imageBgRemove;

  /// No description provided for @imageBgRemoveColour.
  ///
  /// In ms, this message translates to:
  /// **'Buang warna latar'**
  String get imageBgRemoveColour;

  /// No description provided for @imageBgCard.
  ///
  /// In ms, this message translates to:
  /// **'Letak atas kad cerah'**
  String get imageBgCard;

  /// No description provided for @imageBgKeep.
  ///
  /// In ms, this message translates to:
  /// **'Kekalkan'**
  String get imageBgKeep;

  /// No description provided for @imageBgNotPlain.
  ///
  /// In ms, this message translates to:
  /// **'Latar gambar ini tidak sekata. Membuang latar mungkin tidak kemas.'**
  String get imageBgNotPlain;

  /// No description provided for @imageBgTransparent.
  ///
  /// In ms, this message translates to:
  /// **'Latar gambar ini sudah lutsinar.'**
  String get imageBgTransparent;

  /// No description provided for @imageBefore.
  ///
  /// In ms, this message translates to:
  /// **'Sebelum'**
  String get imageBefore;

  /// No description provided for @imageAfter.
  ///
  /// In ms, this message translates to:
  /// **'Selepas'**
  String get imageAfter;

  /// No description provided for @imageSquareHint.
  ///
  /// In ms, this message translates to:
  /// **'Bahagian ini menjadi ikon aplikasi dan ikon pelayar.'**
  String get imageSquareHint;

  /// No description provided for @imageAppIcon.
  ///
  /// In ms, this message translates to:
  /// **'Ikon aplikasi'**
  String get imageAppIcon;

  /// No description provided for @imageFavicon.
  ///
  /// In ms, this message translates to:
  /// **'Ikon pelayar'**
  String get imageFavicon;

  /// No description provided for @logoHeaderPreview.
  ///
  /// In ms, this message translates to:
  /// **'Rupa di skrin TV dan aplikasi'**
  String get logoHeaderPreview;

  /// No description provided for @previewPhaseBiasa.
  ///
  /// In ms, this message translates to:
  /// **'Biasa'**
  String get previewPhaseBiasa;

  /// No description provided for @previewPhaseAzan.
  ///
  /// In ms, this message translates to:
  /// **'Azan'**
  String get previewPhaseAzan;

  /// No description provided for @previewPhaseIqamah.
  ///
  /// In ms, this message translates to:
  /// **'Iqamah'**
  String get previewPhaseIqamah;

  /// No description provided for @previewPhaseSolat.
  ///
  /// In ms, this message translates to:
  /// **'Solat'**
  String get previewPhaseSolat;

  /// No description provided for @previewPhaseJumaat.
  ///
  /// In ms, this message translates to:
  /// **'Jumaat'**
  String get previewPhaseJumaat;

  /// No description provided for @previewPhaseNoData.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data'**
  String get previewPhaseNoData;

  /// No description provided for @previewIntro.
  ///
  /// In ms, this message translates to:
  /// **'Paparan sebenar skrin TV surau. Pilih keadaan untuk melihat rupanya; paparan ini dibaca sahaja dan tidak mengubah apa-apa di MAXCOM.'**
  String get previewIntro;

  /// No description provided for @previewPhaseNeedsData.
  ///
  /// In ms, this message translates to:
  /// **'Butang keadaan perlukan data waktu solat dari MAXCOM.'**
  String get previewPhaseNeedsData;

  /// No description provided for @previewLive.
  ///
  /// In ms, this message translates to:
  /// **'Masa sebenar'**
  String get previewLive;

  /// No description provided for @previewClockFrom.
  ///
  /// In ms, this message translates to:
  /// **'Jam skrin bermula {when}'**
  String previewClockFrom(String when);

  /// No description provided for @previewReload.
  ///
  /// In ms, this message translates to:
  /// **'Muat semula'**
  String get previewReload;

  /// No description provided for @previewNoSession.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci semula untuk melihat pratonton.'**
  String get previewNoSession;

  /// No description provided for @previewTlsFailed.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton tidak dapat disambung dengan selamat. Cuba lagi.'**
  String get previewTlsFailed;

  /// No description provided for @previewLoadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton tidak dapat dipaparkan. Semak sambungan rangkaian, kemudian cuba lagi.'**
  String get previewLoadFailed;

  /// No description provided for @previewTlsExpected.
  ///
  /// In ms, this message translates to:
  /// **'Sijil dijangka (SHA-256)'**
  String get previewTlsExpected;

  /// No description provided for @previewTlsPresented.
  ///
  /// In ms, this message translates to:
  /// **'Sijil dipaparkan (SHA-256)'**
  String get previewTlsPresented;

  /// No description provided for @posterPreviewButton.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton di TV'**
  String get posterPreviewButton;

  /// No description provided for @posterPreviewTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton poster'**
  String get posterPreviewTitle;

  /// No description provided for @posterPreviewHint.
  ///
  /// In ms, this message translates to:
  /// **'Beginilah rupa poster ini di TV surau. Tiada apa yang berubah pada TV sebenar.'**
  String get posterPreviewHint;

  /// No description provided for @posterPreviewNeedsImage.
  ///
  /// In ms, this message translates to:
  /// **'Pilih gambar poster dahulu.'**
  String get posterPreviewNeedsImage;

  /// No description provided for @logoHint.
  ///
  /// In ms, this message translates to:
  /// **'PNG atau JPEG. Logo lebar atau segi empat sama; latar putih boleh dibuang selepas dipilih.'**
  String get logoHint;

  /// No description provided for @logoNotImage.
  ///
  /// In ms, this message translates to:
  /// **'Logo mesti gambar PNG atau JPEG.'**
  String get logoNotImage;

  /// No description provided for @logoMissing.
  ///
  /// In ms, this message translates to:
  /// **'Gambar logo tidak dijumpai di MAXCOM. Pilih semula.'**
  String get logoMissing;

  /// No description provided for @settingsPrayerDataHint.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun dari e-Solat atau muat naik CSV'**
  String get settingsPrayerDataHint;

  /// No description provided for @settingsIslamicRow.
  ///
  /// In ms, this message translates to:
  /// **'Al-Quran & audio tilawah'**
  String get settingsIslamicRow;

  /// No description provided for @settingsIslamicHint.
  ///
  /// In ms, this message translates to:
  /// **'Teks Al-Quran dan audio tilawah untuk skrin TV'**
  String get settingsIslamicHint;

  /// No description provided for @islamicIntro.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan yang disimpan di MAXCOM supaya skrin TV boleh memaparkannya tanpa internet.'**
  String get islamicIntro;

  /// No description provided for @islamicQuranTitle.
  ///
  /// In ms, this message translates to:
  /// **'Teks Al-Quran'**
  String get islamicQuranTitle;

  /// No description provided for @islamicQuranPresent.
  ///
  /// In ms, this message translates to:
  /// **'Teks Al-Quran tersedia'**
  String get islamicQuranPresent;

  /// No description provided for @islamicQuranAbsent.
  ///
  /// In ms, this message translates to:
  /// **'Teks Al-Quran belum dimuat turun'**
  String get islamicQuranAbsent;

  /// No description provided for @islamicQuranDetail.
  ///
  /// In ms, this message translates to:
  /// **'{ayat} ayat, versi {version}'**
  String islamicQuranDetail(int ayat, String version);

  /// No description provided for @islamicQuranHint.
  ///
  /// In ms, this message translates to:
  /// **'Dipaparkan pada kad ayat dan pembaca Al-Quran di skrin TV.'**
  String get islamicQuranHint;

  /// No description provided for @islamicAudioTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tilawah (audio)'**
  String get islamicAudioTitle;

  /// No description provided for @islamicReciter.
  ///
  /// In ms, this message translates to:
  /// **'Qari: {reciter}'**
  String islamicReciter(String reciter);

  /// No description provided for @islamicSurahsStored.
  ///
  /// In ms, this message translates to:
  /// **'{n} surah tersimpan'**
  String islamicSurahsStored(int n);

  /// No description provided for @islamicNoSurahs.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada surah tersimpan'**
  String get islamicNoSurahs;

  /// No description provided for @islamicCacheUsage.
  ///
  /// In ms, this message translates to:
  /// **'{used} MB daripada {max} MB digunakan'**
  String islamicCacheUsage(int used, int max);

  /// No description provided for @islamicSurahPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih surah'**
  String get islamicSurahPick;

  /// No description provided for @islamicSurahSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari nama atau nombor surah'**
  String get islamicSurahSearch;

  /// No description provided for @islamicSurahStored.
  ///
  /// In ms, this message translates to:
  /// **'Tersimpan'**
  String get islamicSurahStored;

  /// No description provided for @islamicBusy.
  ///
  /// In ms, this message translates to:
  /// **'Sedang memuat turun'**
  String get islamicBusy;

  /// No description provided for @islamicJobQuran.
  ///
  /// In ms, this message translates to:
  /// **'Memuat turun teks Al-Quran'**
  String get islamicJobQuran;

  /// No description provided for @islamicJobSurah.
  ///
  /// In ms, this message translates to:
  /// **'Memuat turun surah {surah}'**
  String islamicJobSurah(String surah);

  /// No description provided for @islamicJobDone.
  ///
  /// In ms, this message translates to:
  /// **'Selesai'**
  String get islamicJobDone;

  /// No description provided for @islamicJobDoneQuran.
  ///
  /// In ms, this message translates to:
  /// **'Teks Al-Quran sudah disimpan di MAXCOM.'**
  String get islamicJobDoneQuran;

  /// No description provided for @islamicJobDoneSurah.
  ///
  /// In ms, this message translates to:
  /// **'Surah {surah} sudah disimpan di MAXCOM.'**
  String islamicJobDoneSurah(String surah);

  /// No description provided for @islamicJobFailed.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun gagal'**
  String get islamicJobFailed;

  /// No description provided for @islamicReadOnly.
  ///
  /// In ms, this message translates to:
  /// **'Hanya pentadbir boleh memuat turun kandungan.'**
  String get islamicReadOnly;

  /// No description provided for @prayerDataDaysAhead.
  ///
  /// In ms, this message translates to:
  /// **'hari data waktu solat ke hadapan'**
  String get prayerDataDaysAhead;

  /// No description provided for @prayerDataDaysUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Belum diketahui'**
  String get prayerDataDaysUnknown;

  /// No description provided for @prayerDataZone.
  ///
  /// In ms, this message translates to:
  /// **'Zon {zone}'**
  String prayerDataZone(String zone);

  /// No description provided for @prayerDataZoneUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Zon waktu solat belum diketahui.'**
  String get prayerDataZoneUnknown;

  /// No description provided for @prayerDataLow.
  ///
  /// In ms, this message translates to:
  /// **'Data hampir habis. Muat turun tahun seterusnya sekarang.'**
  String get prayerDataLow;

  /// No description provided for @prayerDataNoYear.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada data waktu solat untuk tahun {year}.'**
  String prayerDataNoYear(int year);

  /// No description provided for @prayerDataYearChoose.
  ///
  /// In ms, this message translates to:
  /// **'Pilih tahun'**
  String get prayerDataYearChoose;

  /// No description provided for @prayerDataReplaceNote.
  ///
  /// In ms, this message translates to:
  /// **'Data sedia ada untuk tahun {year} akan diganti.'**
  String prayerDataReplaceNote(int year);

  /// No description provided for @prayerDataReplaceTitle.
  ///
  /// In ms, this message translates to:
  /// **'Ganti data sedia ada?'**
  String get prayerDataReplaceTitle;

  /// No description provided for @prayerDataReplaceAction.
  ///
  /// In ms, this message translates to:
  /// **'Ganti'**
  String get prayerDataReplaceAction;

  /// No description provided for @prayerDataPickFile.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail CSV'**
  String get prayerDataPickFile;

  /// No description provided for @prayerDataFileTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Fail terlalu besar. Had ialah 1 MB.'**
  String get prayerDataFileTooBig;

  /// No description provided for @prayerDataFileUnreadable.
  ///
  /// In ms, this message translates to:
  /// **'Fail tidak dapat dibaca.'**
  String get prayerDataFileUnreadable;

  /// No description provided for @statusPrayerDataNone.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada data waktu solat. Muat turun atau muat naik sekarang.'**
  String get statusPrayerDataNone;

  /// No description provided for @prayerDataUpdateTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini data'**
  String get prayerDataUpdateTitle;

  /// No description provided for @prayerDataYearLine.
  ///
  /// In ms, this message translates to:
  /// **'Data tahun {year}'**
  String prayerDataYearLine(int year);

  /// No description provided for @fetchFromSource.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun dari {source} ke dalam MAXCOM'**
  String fetchFromSource(String source);

  /// No description provided for @refetchFromSource.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun semula dari {source}'**
  String refetchFromSource(String source);

  /// No description provided for @prayerDataFetchHint.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM memuat turun terus dari e-Solat JAKIM. Perlukan internet di surau.'**
  String get prayerDataFetchHint;

  /// No description provided for @prayerDataUploadCsv.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik CSV'**
  String get prayerDataUploadCsv;

  /// No description provided for @prayerDataUploadHint.
  ///
  /// In ms, this message translates to:
  /// **'Fail CSV tahunan dari laman e-Solat untuk zon ini.'**
  String get prayerDataUploadHint;

  /// No description provided for @prayerDataPasteTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tampal kandungan CSV'**
  String get prayerDataPasteTitle;

  /// No description provided for @prayerDataPasteHint.
  ///
  /// In ms, this message translates to:
  /// **'Buka fail CSV e-Solat, salin semua kandungannya dan tampal di sini.'**
  String get prayerDataPasteHint;

  /// No description provided for @prayerDataPasteLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan CSV'**
  String get prayerDataPasteLabel;

  /// No description provided for @prayerDataPasteEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tampal kandungan CSV dahulu.'**
  String get prayerDataPasteEmpty;

  /// No description provided for @prayerDataWorkingFetch.
  ///
  /// In ms, this message translates to:
  /// **'Sedang memuat turun dari e-Solat'**
  String get prayerDataWorkingFetch;

  /// No description provided for @prayerDataWorkingUpload.
  ///
  /// In ms, this message translates to:
  /// **'Sedang memuat naik'**
  String get prayerDataWorkingUpload;

  /// No description provided for @prayerDataResultTitle.
  ///
  /// In ms, this message translates to:
  /// **'Data waktu solat dikemas kini'**
  String get prayerDataResultTitle;

  /// No description provided for @prayerDataResult.
  ///
  /// In ms, this message translates to:
  /// **'Ditambah {n}, diganti {m}'**
  String prayerDataResult(int n, int m);

  /// No description provided for @liveTitle.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung'**
  String get liveTitle;

  /// No description provided for @liveStart.
  ///
  /// In ms, this message translates to:
  /// **'Mula siaran'**
  String get liveStart;

  /// No description provided for @liveStop.
  ///
  /// In ms, this message translates to:
  /// **'Berhenti'**
  String get liveStop;

  /// No description provided for @liveStopConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Hentikan siaran?'**
  String get liveStopConfirm;

  /// No description provided for @liveStopConfirmBody.
  ///
  /// In ms, this message translates to:
  /// **'Skrin surau dan YouTube akan berhenti menerima siaran ini.'**
  String get liveStopConfirmBody;

  /// No description provided for @liveStopConfirmAction.
  ///
  /// In ms, this message translates to:
  /// **'Hentikan'**
  String get liveStopConfirmAction;

  /// No description provided for @liveStarting.
  ///
  /// In ms, this message translates to:
  /// **'Memulakan siaran'**
  String get liveStarting;

  /// No description provided for @liveStopping.
  ///
  /// In ms, this message translates to:
  /// **'Menghentikan siaran'**
  String get liveStopping;

  /// No description provided for @livePreparing.
  ///
  /// In ms, this message translates to:
  /// **'Menyediakan kamera'**
  String get livePreparing;

  /// No description provided for @liveKiosk.
  ///
  /// In ms, this message translates to:
  /// **'Skrin surau'**
  String get liveKiosk;

  /// No description provided for @liveKioskHint.
  ///
  /// In ms, this message translates to:
  /// **'Melalui Wi-Fi surau'**
  String get liveKioskHint;

  /// No description provided for @liveYoutube.
  ///
  /// In ms, this message translates to:
  /// **'YouTube'**
  String get liveYoutube;

  /// No description provided for @liveYoutubeHint.
  ///
  /// In ms, this message translates to:
  /// **'Saluran YouTube surau'**
  String get liveYoutubeHint;

  /// No description provided for @liveRecording.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman'**
  String get liveRecording;

  /// No description provided for @liveRecordingOn.
  ///
  /// In ms, this message translates to:
  /// **'Merakam'**
  String get liveRecordingOn;

  /// No description provided for @liveRecordingOff.
  ///
  /// In ms, this message translates to:
  /// **'Dimatikan'**
  String get liveRecordingOff;

  /// No description provided for @liveRecordingWithLive.
  ///
  /// In ms, this message translates to:
  /// **'Bermula bersama siaran'**
  String get liveRecordingWithLive;

  /// No description provided for @liveRecordingParts.
  ///
  /// In ms, this message translates to:
  /// **'{n} bahagian, {size}'**
  String liveRecordingParts(int n, String size);

  /// No description provided for @liveReady.
  ///
  /// In ms, this message translates to:
  /// **'Sedia'**
  String get liveReady;

  /// No description provided for @liveNotUsed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak digunakan'**
  String get liveNotUsed;

  /// No description provided for @liveConnecting.
  ///
  /// In ms, this message translates to:
  /// **'Menyambung'**
  String get liveConnecting;

  /// No description provided for @liveOn.
  ///
  /// In ms, this message translates to:
  /// **'Bersiaran'**
  String get liveOn;

  /// No description provided for @liveRetry.
  ///
  /// In ms, this message translates to:
  /// **'Cuba lagi dalam {n} s'**
  String liveRetry(int n);

  /// No description provided for @liveDown.
  ///
  /// In ms, this message translates to:
  /// **'Terputus'**
  String get liveDown;

  /// No description provided for @liveDuration.
  ///
  /// In ms, this message translates to:
  /// **'Tempoh'**
  String get liveDuration;

  /// No description provided for @liveBitrate.
  ///
  /// In ms, this message translates to:
  /// **'Kadar bit'**
  String get liveBitrate;

  /// No description provided for @liveFps.
  ///
  /// In ms, this message translates to:
  /// **'Bingkai sesaat'**
  String get liveFps;

  /// No description provided for @liveKuliahToday.
  ///
  /// In ms, this message translates to:
  /// **'Hari ini'**
  String get liveKuliahToday;

  /// No description provided for @liveKuliahUpcoming.
  ///
  /// In ms, this message translates to:
  /// **'Akan datang'**
  String get liveKuliahUpcoming;

  /// No description provided for @liveKuliahPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih kuliah'**
  String get liveKuliahPick;

  /// No description provided for @liveKuliahChange.
  ///
  /// In ms, this message translates to:
  /// **'Tukar'**
  String get liveKuliahChange;

  /// No description provided for @liveNoKuliah.
  ///
  /// In ms, this message translates to:
  /// **'Tiada kuliah hari ini'**
  String get liveNoKuliah;

  /// No description provided for @liveNoKuliahOption.
  ///
  /// In ms, this message translates to:
  /// **'Tanpa kuliah'**
  String get liveNoKuliahOption;

  /// No description provided for @liveNoKuliahHint.
  ///
  /// In ms, this message translates to:
  /// **'Siaran tanpa tajuk kuliah'**
  String get liveNoKuliahHint;

  /// No description provided for @liveFlip.
  ///
  /// In ms, this message translates to:
  /// **'Tukar kamera'**
  String get liveFlip;

  /// No description provided for @liveMinimise.
  ///
  /// In ms, this message translates to:
  /// **'Kecilkan tetapan'**
  String get liveMinimise;

  /// No description provided for @liveExpand.
  ///
  /// In ms, this message translates to:
  /// **'Tunjuk tetapan'**
  String get liveExpand;

  /// No description provided for @liveMute.
  ///
  /// In ms, this message translates to:
  /// **'Senyapkan mikrofon'**
  String get liveMute;

  /// No description provided for @liveUnmute.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan mikrofon'**
  String get liveUnmute;

  /// No description provided for @liveMuted.
  ///
  /// In ms, this message translates to:
  /// **'Mikrofon senyap'**
  String get liveMuted;

  /// No description provided for @liveWarnBattery.
  ///
  /// In ms, this message translates to:
  /// **'Bateri rendah'**
  String get liveWarnBattery;

  /// No description provided for @liveWarnHot.
  ///
  /// In ms, this message translates to:
  /// **'Telefon panas'**
  String get liveWarnHot;

  /// No description provided for @liveWarnScreen.
  ///
  /// In ms, this message translates to:
  /// **'Kekalkan skrin terbuka. Mengunci skrin akan menghentikan kamera.'**
  String get liveWarnScreen;

  /// No description provided for @liveWarnStorage.
  ///
  /// In ms, this message translates to:
  /// **'Storan hampir penuh'**
  String get liveWarnStorage;

  /// No description provided for @liveWarnNoInternet.
  ///
  /// In ms, this message translates to:
  /// **'Tiada internet: YouTube dimatikan'**
  String get liveWarnNoInternet;

  /// No description provided for @liveYoutubeNeedsSignIn.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube dahulu'**
  String get liveYoutubeNeedsSignIn;

  /// No description provided for @liveYoutubeAskAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Minta Pentadbir log masuk YouTube'**
  String get liveYoutubeAskAdmin;

  /// No description provided for @liveEnded.
  ///
  /// In ms, this message translates to:
  /// **'Siaran tamat'**
  String get liveEnded;

  /// No description provided for @liveYoutubeShort.
  ///
  /// In ms, this message translates to:
  /// **'YouTube menerima {got} minit daripada {total} minit'**
  String liveYoutubeShort(int got, int total);

  /// No description provided for @liveSaveRecording.
  ///
  /// In ms, this message translates to:
  /// **'Simpan rakaman'**
  String get liveSaveRecording;

  /// No description provided for @liveRecordingSaved.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman disimpan di Movies/MAXCOM'**
  String get liveRecordingSaved;

  /// No description provided for @liveWatch.
  ///
  /// In ms, this message translates to:
  /// **'Lihat di YouTube'**
  String get liveWatch;

  /// No description provided for @liveYoutubeAccount.
  ///
  /// In ms, this message translates to:
  /// **'Akaun YouTube surau'**
  String get liveYoutubeAccount;

  /// No description provided for @liveSignInHint.
  ///
  /// In ms, this message translates to:
  /// **'Sambungkan saluran YouTube surau kepada MAXCOM sekali sahaja. Selepas itu setiap kuliah boleh disiarkan ke YouTube.'**
  String get liveSignInHint;

  /// No description provided for @liveSignIn.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube'**
  String get liveSignIn;

  /// No description provided for @liveSignInCode.
  ///
  /// In ms, this message translates to:
  /// **'Buka google.com/device di telefon anda dan masukkan kod ini'**
  String get liveSignInCode;

  /// No description provided for @liveSignInOpen.
  ///
  /// In ms, this message translates to:
  /// **'Buka google.com/device'**
  String get liveSignInOpen;

  /// No description provided for @liveSignInWaiting.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu anda log masuk'**
  String get liveSignInWaiting;

  /// No description provided for @errcVideoBusy.
  ///
  /// In ms, this message translates to:
  /// **'Video lain sedang dimuat naik ke MAXCOM. Cuba sebentar lagi.'**
  String get errcVideoBusy;

  /// No description provided for @errcCameraStale.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan kamera telah berubah. Cuba lagi.'**
  String get errcCameraStale;

  /// No description provided for @errcCameraPasswordAgain.
  ///
  /// In ms, this message translates to:
  /// **'Taip semula kata laluan kamera.'**
  String get errcCameraPasswordAgain;

  /// No description provided for @liveSignInByAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube sedang dibuat oleh pentadbir.'**
  String get liveSignInByAdmin;

  /// No description provided for @liveSignedInAs.
  ///
  /// In ms, this message translates to:
  /// **'Disambungkan kepada {channel}'**
  String liveSignedInAs(String channel);

  /// No description provided for @liveSignOut.
  ///
  /// In ms, this message translates to:
  /// **'Log keluar YouTube'**
  String get liveSignOut;

  /// No description provided for @liveYoutubeConnected.
  ///
  /// In ms, this message translates to:
  /// **'YouTube disambungkan'**
  String get liveYoutubeConnected;

  /// No description provided for @liveYoutubeConnectedSnack.
  ///
  /// In ms, this message translates to:
  /// **'YouTube disambungkan: {channel}'**
  String liveYoutubeConnectedSnack(String channel);

  /// No description provided for @liveYoutubeAtSurauOnly.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk / tukar saluran YouTube hanya di Wi-Fi surau.'**
  String get liveYoutubeAtSurauOnly;

  /// No description provided for @liveYoutubeNotConnected.
  ///
  /// In ms, this message translates to:
  /// **'YouTube belum disambungkan'**
  String get liveYoutubeNotConnected;

  /// No description provided for @liveDestOn.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: Ya, {channel}'**
  String liveDestOn(String channel);

  /// No description provided for @liveDestOff.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: Tidak'**
  String get liveDestOff;

  /// No description provided for @liveDestSkip.
  ///
  /// In ms, this message translates to:
  /// **'YouTube tidak dipilih: siaran hanya ke skrin surau.'**
  String get liveDestSkip;

  /// No description provided for @liveDestNone.
  ///
  /// In ms, this message translates to:
  /// **'YouTube belum disambungkan'**
  String get liveDestNone;

  /// No description provided for @liveYoutubeUnknown.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: tidak dapat disemak sekarang (kali terakhir: {channel})'**
  String liveYoutubeUnknown(String channel);

  /// No description provided for @liveYoutubeUnknownNoLast.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: tidak dapat disemak sekarang'**
  String get liveYoutubeUnknownNoLast;

  /// No description provided for @liveYoutubeAskTitle.
  ///
  /// In ms, this message translates to:
  /// **'YouTube tidak dapat digunakan'**
  String get liveYoutubeAskTitle;

  /// No description provided for @liveYoutubeAskBody.
  ///
  /// In ms, this message translates to:
  /// **'YouTube tidak dapat digunakan sekarang: {reason}. Mulakan siaran ke skrin surau sahaja?'**
  String liveYoutubeAskBody(String reason);

  /// No description provided for @liveYoutubeWhyNoInternet.
  ///
  /// In ms, this message translates to:
  /// **'tiada internet'**
  String get liveYoutubeWhyNoInternet;

  /// No description provided for @liveYoutubeWhyRevoked.
  ///
  /// In ms, this message translates to:
  /// **'sambungan perlu dibuat semula'**
  String get liveYoutubeWhyRevoked;

  /// No description provided for @liveYoutubeWhyNeedsSignIn.
  ///
  /// In ms, this message translates to:
  /// **'belum log masuk'**
  String get liveYoutubeWhyNeedsSignIn;

  /// No description provided for @liveYoutubeWhyAskAdmin.
  ///
  /// In ms, this message translates to:
  /// **'belum log masuk, minta Pentadbir log masuk'**
  String get liveYoutubeWhyAskAdmin;

  /// No description provided for @liveYoutubeWhyUnknownNoLast.
  ///
  /// In ms, this message translates to:
  /// **'akaun tidak dapat disemak sekarang'**
  String get liveYoutubeWhyUnknownNoLast;

  /// No description provided for @liveYoutubeWhyUnknown.
  ///
  /// In ms, this message translates to:
  /// **'akaun tidak dapat disemak sekarang (kali terakhir: {channel})'**
  String liveYoutubeWhyUnknown(String channel);

  /// No description provided for @tvLangArNeedsUpdate.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini MAXCOM untuk Bahasa Arab'**
  String get tvLangArNeedsUpdate;

  /// No description provided for @tvLangArAskTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tukar bahasa skrin TV ke Bahasa Arab?'**
  String get tvLangArAskTitle;

  /// No description provided for @tvLangArAskBody.
  ///
  /// In ms, this message translates to:
  /// **'Tema Arabic Art paling sesuai dengan skrin TV berbahasa Arab. Anda boleh menukarnya semula di Bahasa skrin TV.'**
  String get tvLangArAskBody;

  /// No description provided for @tvLangArAskYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya'**
  String get tvLangArAskYes;

  /// No description provided for @tvLangArAskNo.
  ///
  /// In ms, this message translates to:
  /// **'Tidak'**
  String get tvLangArAskNo;

  /// No description provided for @liveYoutubeAskYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya'**
  String get liveYoutubeAskYes;

  /// No description provided for @liveYoutubeChoiceFailed.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan YouTube tidak dapat disimpan. Cuba lagi.'**
  String get liveYoutubeChoiceFailed;

  /// No description provided for @liveYoutubeRevoked.
  ///
  /// In ms, this message translates to:
  /// **'YouTube perlu disambung semula'**
  String get liveYoutubeRevoked;

  /// No description provided for @liveDestOnPlain.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: Ya'**
  String get liveDestOnPlain;

  /// No description provided for @liveDestLink.
  ///
  /// In ms, this message translates to:
  /// **'Sambung'**
  String get liveDestLink;

  /// No description provided for @liveDestLive2.
  ///
  /// In ms, this message translates to:
  /// **'Ke skrin surau dan YouTube'**
  String get liveDestLive2;

  /// No description provided for @liveDestLive1.
  ///
  /// In ms, this message translates to:
  /// **'Ke skrin surau sahaja'**
  String get liveDestLive1;

  /// No description provided for @liveDestRec.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman: Ya'**
  String get liveDestRec;

  /// No description provided for @liveDestRecOff.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman: Tidak'**
  String get liveDestRecOff;

  /// No description provided for @liveDestShortKiosk.
  ///
  /// In ms, this message translates to:
  /// **'Skrin'**
  String get liveDestShortKiosk;

  /// No description provided for @liveDestShortYoutube.
  ///
  /// In ms, this message translates to:
  /// **'YouTube'**
  String get liveDestShortYoutube;

  /// No description provided for @liveDestShortRecording.
  ///
  /// In ms, this message translates to:
  /// **'Rakam'**
  String get liveDestShortRecording;

  /// No description provided for @liveDestSheetTitle.
  ///
  /// In ms, this message translates to:
  /// **'Destinasi siaran'**
  String get liveDestSheetTitle;

  /// No description provided for @liveDestTapHint.
  ///
  /// In ms, this message translates to:
  /// **'Ketik untuk butiran.'**
  String get liveDestTapHint;

  /// No description provided for @liveSignInOpenGoogle.
  ///
  /// In ms, this message translates to:
  /// **'Buka halaman Google'**
  String get liveSignInOpenGoogle;

  /// No description provided for @liveSignInWaitingMin.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu pengesahan… (tamat dalam {minutes} min)'**
  String liveSignInWaitingMin(int minutes);

  /// No description provided for @liveSignInDenied.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk dibatalkan'**
  String get liveSignInDenied;

  /// No description provided for @liveSignInExpired.
  ///
  /// In ms, this message translates to:
  /// **'Kod tamat tempoh. Cuba lagi.'**
  String get liveSignInExpired;

  /// No description provided for @liveSignInRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Akses YouTube telah ditarik balik atau tamat. Sila log masuk semula.'**
  String get liveSignInRevoked;

  /// No description provided for @liveSignOutChange.
  ///
  /// In ms, this message translates to:
  /// **'Tukar saluran / Log keluar'**
  String get liveSignOutChange;

  /// No description provided for @liveSignOutConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tukar saluran atau log keluar?'**
  String get liveSignOutConfirmTitle;

  /// No description provided for @liveSignOutConfirmBody.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung seterusnya tidak akan sampai ke YouTube sehingga seseorang log masuk semula.'**
  String get liveSignOutConfirmBody;

  /// No description provided for @liveSignOutConfirmAction.
  ///
  /// In ms, this message translates to:
  /// **'Log keluar'**
  String get liveSignOutConfirmAction;

  /// No description provided for @liveSettingsSummaryConnected.
  ///
  /// In ms, this message translates to:
  /// **'YouTube disambungkan: {channel}. Kamera luaran {camera}'**
  String liveSettingsSummaryConnected(String channel, String camera);

  /// No description provided for @liveRecordingsPending.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman belum disimpan'**
  String get liveRecordingsPending;

  /// No description provided for @liveRecordingsPendingBody.
  ///
  /// In ms, this message translates to:
  /// **'{n} bahagian daripada siaran lepas masih dalam peranti ini.'**
  String liveRecordingsPendingBody(int n);

  /// No description provided for @liveBoxUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Siaran ke skrin surau tidak boleh dimulakan.'**
  String get liveBoxUnreachable;

  /// No description provided for @liveMediaPortsBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Port media disekat oleh firewall komputer MAXCOM. Video tidak sampai ke kiosk atau YouTube. Jalankan pemasangan sebagai pentadbir.'**
  String get liveMediaPortsBlocked;

  /// No description provided for @liveNoVideo.
  ///
  /// In ms, this message translates to:
  /// **'Video belum sampai ke MAXCOM. Semak Wi-Fi telefon dan komputer MAXCOM berada pada rangkaian yang sama.'**
  String get liveNoVideo;

  /// No description provided for @liveBusy.
  ///
  /// In ms, this message translates to:
  /// **'Siaran sedang berjalan dari {device}'**
  String liveBusy(String device);

  /// No description provided for @appLockTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi'**
  String get appLockTitle;

  /// No description provided for @appLockOffLine.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi dimatikan'**
  String get appLockOffLine;

  /// No description provided for @appLockOffHint.
  ///
  /// In ms, this message translates to:
  /// **'Sesiapa yang memegang peranti ini boleh membuka MAXCOM. Pentadbir boleh menghidupkan kunci di Konfigurasi.'**
  String get appLockOffHint;

  /// No description provided for @appLockEnrolHint.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi dimatikan oleh pentadbir. Peranti ini membuka MAXCOM tanpa PIN.'**
  String get appLockEnrolHint;

  /// No description provided for @appLockOnTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan kunci aplikasi?'**
  String get appLockOnTitle;

  /// No description provided for @appLockOnBody.
  ///
  /// In ms, this message translates to:
  /// **'Setiap pengguna akan diminta tetapkan PIN.'**
  String get appLockOnBody;

  /// No description provided for @appLockOnConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan'**
  String get appLockOnConfirm;

  /// No description provided for @appLockStatusOn.
  ///
  /// In ms, this message translates to:
  /// **'Dihidupkan'**
  String get appLockStatusOn;

  /// No description provided for @appLockStatusOff.
  ///
  /// In ms, this message translates to:
  /// **'Dimatikan'**
  String get appLockStatusOff;

  /// No description provided for @enrolDoneHintNoLock.
  ///
  /// In ms, this message translates to:
  /// **'Lain kali, buka aplikasi ini dan ia terbuka terus tanpa PIN.'**
  String get enrolDoneHintNoLock;

  /// No description provided for @unlockAuto.
  ///
  /// In ms, this message translates to:
  /// **'Membuka kunci'**
  String get unlockAuto;

  /// No description provided for @unlockAutoUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi'**
  String get unlockAutoUnreachable;

  /// No description provided for @unlockPinMissing.
  ///
  /// In ms, this message translates to:
  /// **'PIN diperlukan'**
  String get unlockPinMissing;

  /// No description provided for @unlockPinRequiredByAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir telah menghidupkan kunci aplikasi. Pilih 6 digit baharu.'**
  String get unlockPinRequiredByAdmin;

  /// No description provided for @auditKeyAppLock.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi'**
  String get auditKeyAppLock;

  /// No description provided for @syncSynced.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan'**
  String get syncSynced;

  /// No description provided for @syncSyncedAt.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan {time}'**
  String syncSyncedAt(String time);

  /// No description provided for @syncPending.
  ///
  /// In ms, this message translates to:
  /// **'{n} perubahan menunggu'**
  String syncPending(int n);

  /// No description provided for @syncPendingShort.
  ///
  /// In ms, this message translates to:
  /// **'{n} menunggu'**
  String syncPendingShort(int n);

  /// No description provided for @syncWakingShort.
  ///
  /// In ms, this message translates to:
  /// **'Menyambung...'**
  String get syncWakingShort;

  /// No description provided for @syncOffline.
  ///
  /// In ms, this message translates to:
  /// **'Luar talian, akan diselaraskan kemudian'**
  String get syncOffline;

  /// No description provided for @syncOfflineShort.
  ///
  /// In ms, this message translates to:
  /// **'Luar talian'**
  String get syncOfflineShort;

  /// No description provided for @syncWaking.
  ///
  /// In ms, this message translates to:
  /// **'Menyambung ke awan...'**
  String get syncWaking;

  /// No description provided for @syncRunning.
  ///
  /// In ms, this message translates to:
  /// **'Sedang menyelaraskan'**
  String get syncRunning;

  /// No description provided for @syncViaCloud.
  ///
  /// In ms, this message translates to:
  /// **'Melalui awan'**
  String get syncViaCloud;

  /// No description provided for @syncViaBox.
  ///
  /// In ms, this message translates to:
  /// **'Melalui MAXCOM di surau'**
  String get syncViaBox;

  /// No description provided for @syncConflicts.
  ///
  /// In ms, this message translates to:
  /// **'Konflik: {n}'**
  String syncConflicts(int n);

  /// No description provided for @linkCloudConnected.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM: bersambung'**
  String get linkCloudConnected;

  /// No description provided for @linkCloudConnecting.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM: sedang menyambung'**
  String get linkCloudConnecting;

  /// No description provided for @linkCloudSyncing.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM: sedang menghantar perubahan'**
  String get linkCloudSyncing;

  /// No description provided for @linkCloudDisconnected.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM: tidak bersambung'**
  String get linkCloudDisconnected;

  /// No description provided for @linkBoxConnected.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau: bersambung'**
  String get linkBoxConnected;

  /// No description provided for @linkBoxConnecting.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau: sedang menyambung'**
  String get linkBoxConnecting;

  /// No description provided for @linkBoxSyncing.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau: sedang menghantar perubahan'**
  String get linkBoxSyncing;

  /// No description provided for @linkBoxDisconnected.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau: tidak dapat dihubungi'**
  String get linkBoxDisconnected;

  /// No description provided for @syncNow.
  ///
  /// In ms, this message translates to:
  /// **'Selaraskan sekarang'**
  String get syncNow;

  /// No description provided for @syncSheetTitle.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan'**
  String get syncSheetTitle;

  /// No description provided for @syncConnection.
  ///
  /// In ms, this message translates to:
  /// **'Sambungan'**
  String get syncConnection;

  /// No description provided for @syncNoConnection.
  ///
  /// In ms, this message translates to:
  /// **'Tiada sambungan'**
  String get syncNoConnection;

  /// No description provided for @syncLastSync.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan terakhir'**
  String get syncLastSync;

  /// No description provided for @syncNever.
  ///
  /// In ms, this message translates to:
  /// **'Belum pernah'**
  String get syncNever;

  /// No description provided for @syncWaitingLabel.
  ///
  /// In ms, this message translates to:
  /// **'Perubahan menunggu'**
  String get syncWaitingLabel;

  /// No description provided for @syncErrorLabel.
  ///
  /// In ms, this message translates to:
  /// **'Ralat'**
  String get syncErrorLabel;

  /// No description provided for @syncErrUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM dan awan tidak dapat dihubungi'**
  String get syncErrUnreachable;

  /// No description provided for @syncCloudUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'Awan tidak dapat dihubungi'**
  String get syncCloudUnreachable;

  /// No description provided for @syncErrNeedsUnlock.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci semula untuk menyelaraskan'**
  String get syncErrNeedsUnlock;

  /// No description provided for @syncErrFailed.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan tidak berjaya. Akan dicuba lagi.'**
  String get syncErrFailed;

  /// No description provided for @syncDeviceRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini telah dibatalkan'**
  String get syncDeviceRevoked;

  /// No description provided for @syncDeviceRevokedHint.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir telah membatalkan peranti ini. Salinan tempatan telah dipadam. Daftar semula dengan kod QR baharu daripada pentadbir.'**
  String get syncDeviceRevokedHint;

  /// No description provided for @syncSeeConflicts.
  ///
  /// In ms, this message translates to:
  /// **'Lihat konflik'**
  String get syncSeeConflicts;

  /// No description provided for @syncOfflineHelp.
  ///
  /// In ms, this message translates to:
  /// **'Perubahan anda disimpan dalam peranti ini dan dihantar apabila ada sambungan.'**
  String get syncOfflineHelp;

  /// No description provided for @conflictsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Konflik'**
  String get conflictsTitle;

  /// No description provided for @conflictsIntro.
  ///
  /// In ms, this message translates to:
  /// **'Perubahan di bawah tidak digunakan. Guna versi anda semula, atau buang.'**
  String get conflictsIntro;

  /// No description provided for @conflictMine.
  ///
  /// In ms, this message translates to:
  /// **'Perubahan anda pada {time}'**
  String conflictMine(String time);

  /// No description provided for @conflictWinner.
  ///
  /// In ms, this message translates to:
  /// **'Menang: {name} pada {time}'**
  String conflictWinner(String name, String time);

  /// No description provided for @conflictSomeoneElse.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna lain'**
  String get conflictSomeoneElse;

  /// No description provided for @conflictRefusedForbidden.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: tiada kebenaran'**
  String get conflictRefusedForbidden;

  /// No description provided for @conflictRefusedLiveOnly.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: perlukan sambungan'**
  String get conflictRefusedLiveOnly;

  /// No description provided for @conflictRefusedTooLarge.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: fail terlalu besar'**
  String get conflictRefusedTooLarge;

  /// No description provided for @conflictRefusedInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: data tidak sah'**
  String get conflictRefusedInvalid;

  /// No description provided for @conflictRefusedOther.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak oleh pelayan'**
  String get conflictRefusedOther;

  /// No description provided for @conflictReapply.
  ///
  /// In ms, this message translates to:
  /// **'Guna versi saya semula'**
  String get conflictReapply;

  /// No description provided for @conflictDiscard.
  ///
  /// In ms, this message translates to:
  /// **'Buang'**
  String get conflictDiscard;

  /// No description provided for @conflictReapplied.
  ///
  /// In ms, this message translates to:
  /// **'Versi anda dihantar semula'**
  String get conflictReapplied;

  /// No description provided for @conflictDeleted.
  ///
  /// In ms, this message translates to:
  /// **'Anda memadam item ini'**
  String get conflictDeleted;

  /// No description provided for @conflictEntitySettings.
  ///
  /// In ms, this message translates to:
  /// **'Konfigurasi'**
  String get conflictEntitySettings;

  /// No description provided for @conflictEntityUser.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna'**
  String get conflictEntityUser;

  /// No description provided for @conflictEntityAsset.
  ///
  /// In ms, this message translates to:
  /// **'Gambar'**
  String get conflictEntityAsset;

  /// No description provided for @conflictEntityDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get conflictEntityDevice;

  /// No description provided for @conflictsEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada konflik'**
  String get conflictsEmpty;

  /// No description provided for @conflictsEmptyHint.
  ///
  /// In ms, this message translates to:
  /// **'Semua perubahan anda telah diterima.'**
  String get conflictsEmptyHint;

  /// No description provided for @liveOnlyTitle.
  ///
  /// In ms, this message translates to:
  /// **'Perlukan sambungan'**
  String get liveOnlyTitle;

  /// No description provided for @liveOnlyBody.
  ///
  /// In ms, this message translates to:
  /// **'Tindakan ini perlu sambungan ke MAXCOM di surau atau awan: {action}. Cuba lagi apabila ada rangkaian.'**
  String liveOnlyBody(String action);

  /// No description provided for @liveOnlyNeedsConnection.
  ///
  /// In ms, this message translates to:
  /// **'Perlukan sambungan ke MAXCOM atau awan'**
  String get liveOnlyNeedsConnection;

  /// No description provided for @liveOnlyOk.
  ///
  /// In ms, this message translates to:
  /// **'Faham'**
  String get liveOnlyOk;

  /// No description provided for @assetTooLarge.
  ///
  /// In ms, this message translates to:
  /// **'Gambar terlalu besar. Pilih gambar yang lebih kecil.'**
  String get assetTooLarge;

  /// No description provided for @syncSettingsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan awan'**
  String get syncSettingsTitle;

  /// No description provided for @syncSettingsEnabled.
  ///
  /// In ms, this message translates to:
  /// **'Hidupkan penyelarasan awan'**
  String get syncSettingsEnabled;

  /// No description provided for @syncSettingsUrl.
  ///
  /// In ms, this message translates to:
  /// **'Alamat awan'**
  String get syncSettingsUrl;

  /// No description provided for @syncSettingsUrlHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: https://api.surau.my'**
  String get syncSettingsUrlHint;

  /// No description provided for @syncSettingsUrlHttps.
  ///
  /// In ms, this message translates to:
  /// **'Alamat awan mesti bermula dengan https://'**
  String get syncSettingsUrlHttps;

  /// No description provided for @syncSettingsStatus.
  ///
  /// In ms, this message translates to:
  /// **'Status'**
  String get syncSettingsStatus;

  /// No description provided for @syncSettingsLinked.
  ///
  /// In ms, this message translates to:
  /// **'Dipautkan ke awan'**
  String get syncSettingsLinked;

  /// No description provided for @syncYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya'**
  String get syncYes;

  /// No description provided for @syncNo.
  ///
  /// In ms, this message translates to:
  /// **'Tidak'**
  String get syncNo;

  /// No description provided for @syncSettingsLastPush.
  ///
  /// In ms, this message translates to:
  /// **'Hantar terakhir'**
  String get syncSettingsLastPush;

  /// No description provided for @syncSettingsLastPull.
  ///
  /// In ms, this message translates to:
  /// **'Terima terakhir'**
  String get syncSettingsLastPull;

  /// No description provided for @syncSettingsNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada'**
  String get syncSettingsNone;

  /// No description provided for @syncSettingsStatusUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Status penyelarasan tidak dapat dibaca sekarang.'**
  String get syncSettingsStatusUnavailable;

  /// No description provided for @syncSettingsHelp.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau menghantar perubahan ke awan apabila ada internet, dan menyemak perubahan dari awan setiap dua minit. Perubahan dari rumah sampai ke skrin surau dalam beberapa minit.'**
  String get syncSettingsHelp;

  /// No description provided for @syncSettingsLinkNote.
  ///
  /// In ms, this message translates to:
  /// **'Pautan dibuat oleh pentadbir sistem di MAXCOM.'**
  String get syncSettingsLinkNote;

  /// No description provided for @syncSettingsRunDone.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan selesai'**
  String get syncSettingsRunDone;

  /// No description provided for @devicesEnrolNew.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti baharu'**
  String get devicesEnrolNew;

  /// No description provided for @devicesEnrolPick.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini untuk siapa?'**
  String get devicesEnrolPick;

  /// No description provided for @devicesEnrolViaCloud.
  ///
  /// In ms, this message translates to:
  /// **'Anda di luar rangkaian surau. Kod QR hanya boleh dibuat di Wi-Fi surau.'**
  String get devicesEnrolViaCloud;

  /// No description provided for @navUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik YouTube'**
  String get navUpload;

  /// No description provided for @uploadTitle.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik YouTube'**
  String get uploadTitle;

  /// No description provided for @uploadIntro.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman kuliah dari peranti ini dihantar terus ke saluran YouTube surau, dan disambung semula sendiri jika terputus.'**
  String get uploadIntro;

  /// No description provided for @uploadQuotaLine.
  ///
  /// In ms, this message translates to:
  /// **'{n} daripada {limit} muat naik hari ini'**
  String uploadQuotaLine(int n, int limit);

  /// No description provided for @uploadPart.
  ///
  /// In ms, this message translates to:
  /// **'Bahagian {i} daripada {n}: {pct}%'**
  String uploadPart(int i, int n, int pct);

  /// No description provided for @uploadPartName.
  ///
  /// In ms, this message translates to:
  /// **'Bahagian {i} daripada {n}'**
  String uploadPartName(int i, int n);

  /// No description provided for @uploadWhole.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman penuh: {pct}%'**
  String uploadWhole(int pct);

  /// No description provided for @uploadWholeName.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman penuh'**
  String get uploadWholeName;

  /// No description provided for @uploadWaitWifi.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu Wi-Fi'**
  String get uploadWaitWifi;

  /// No description provided for @uploadWaitNetwork.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu rangkaian'**
  String get uploadWaitNetwork;

  /// No description provided for @uploadQuota.
  ///
  /// In ms, this message translates to:
  /// **'Had muat naik YouTube untuk hari ini telah dicapai. Cuba lagi selepas {time}'**
  String uploadQuota(String time);

  /// No description provided for @uploadQuotaShort.
  ///
  /// In ms, this message translates to:
  /// **'Had kuota: cuba lagi selepas {time}'**
  String uploadQuotaShort(String time);

  /// No description provided for @uploadQueued.
  ///
  /// In ms, this message translates to:
  /// **'Dalam giliran'**
  String get uploadQueued;

  /// No description provided for @uploadJoining.
  ///
  /// In ms, this message translates to:
  /// **'Menyatukan rakaman'**
  String get uploadJoining;

  /// No description provided for @uploadBeginning.
  ///
  /// In ms, this message translates to:
  /// **'Menyediakan muat naik'**
  String get uploadBeginning;

  /// No description provided for @uploadPaused.
  ///
  /// In ms, this message translates to:
  /// **'Dijeda'**
  String get uploadPaused;

  /// No description provided for @uploadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik terhenti'**
  String get uploadFailed;

  /// No description provided for @uploadDone.
  ///
  /// In ms, this message translates to:
  /// **'Selesai'**
  String get uploadDone;

  /// No description provided for @uploadWatch.
  ///
  /// In ms, this message translates to:
  /// **'Lihat di YouTube'**
  String get uploadWatch;

  /// No description provided for @uploadPause.
  ///
  /// In ms, this message translates to:
  /// **'Jeda'**
  String get uploadPause;

  /// No description provided for @uploadResume.
  ///
  /// In ms, this message translates to:
  /// **'Sambung'**
  String get uploadResume;

  /// No description provided for @uploadRetry.
  ///
  /// In ms, this message translates to:
  /// **'Cuba lagi'**
  String get uploadRetry;

  /// No description provided for @uploadAllowMobile.
  ///
  /// In ms, this message translates to:
  /// **'Guna data mudah alih'**
  String get uploadAllowMobile;

  /// No description provided for @uploadFileSize.
  ///
  /// In ms, this message translates to:
  /// **'Fail ini {mb} MB'**
  String uploadFileSize(int mb);

  /// No description provided for @uploadRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang daripada senarai'**
  String get uploadRemove;

  /// No description provided for @uploadDeleteOn.
  ///
  /// In ms, this message translates to:
  /// **'Akan dipadam daripada peranti pada {date}'**
  String uploadDeleteOn(String date);

  /// No description provided for @uploadDeleted.
  ///
  /// In ms, this message translates to:
  /// **'Dipadam daripada peranti'**
  String get uploadDeleted;

  /// No description provided for @liveCleanupAfterDays.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman akan dipadam selepas {days} hari kerana YouTube sudah menerima siaran penuh'**
  String liveCleanupAfterDays(int days);

  /// No description provided for @liveCleanupNow.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman akan dipadam sebaik sahaja YouTube mengesahkan siaran penuh'**
  String get liveCleanupNow;

  /// No description provided for @uploadRemoveConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman kekal di peranti. Buang tugasan ini?'**
  String get uploadRemoveConfirm;

  /// No description provided for @uploadRemoveAction.
  ///
  /// In ms, this message translates to:
  /// **'Buang'**
  String get uploadRemoveAction;

  /// No description provided for @uploadKeepOpenWeb.
  ///
  /// In ms, this message translates to:
  /// **'Biarkan MAXCOM terbuka semasa muat naik (had Safari).'**
  String get uploadKeepOpenWeb;

  /// No description provided for @uploadBackgroundAndroid.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik berjalan di latar belakang.'**
  String get uploadBackgroundAndroid;

  /// No description provided for @uploadReplaceLive.
  ///
  /// In ms, this message translates to:
  /// **'Gantikan siaran yang terputus'**
  String get uploadReplaceLive;

  /// No description provided for @uploadKeepBoth.
  ///
  /// In ms, this message translates to:
  /// **'Simpan kedua-duanya'**
  String get uploadKeepBoth;

  /// No description provided for @uploadReplaceNote.
  ///
  /// In ms, this message translates to:
  /// **'Siaran asal akan dijadikan peribadi selepas muat naik selesai'**
  String get uploadReplaceNote;

  /// No description provided for @uploadReplaceAsk.
  ///
  /// In ms, this message translates to:
  /// **'Siaran YouTube tadi tidak lengkap'**
  String get uploadReplaceAsk;

  /// No description provided for @uploadReplaceAskBody.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman penuh akan dimuat naik sebagai video baharu. Siaran yang terputus boleh dijadikan peribadi selepas itu, atau disimpan bersama.'**
  String get uploadReplaceAskBody;

  /// No description provided for @uploadFromSummary.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik rakaman penuh ke YouTube'**
  String get uploadFromSummary;

  /// No description provided for @uploadFromSummaryHint.
  ///
  /// In ms, this message translates to:
  /// **'YouTube tidak menerima siaran ini sepenuhnya. Rakaman di peranti ini boleh dihantar sekarang.'**
  String get uploadFromSummaryHint;

  /// No description provided for @uploadJoinFailed.
  ///
  /// In ms, this message translates to:
  /// **'Fail rakaman dimuat naik satu per satu'**
  String get uploadJoinFailed;

  /// No description provided for @uploadNoKuliah.
  ///
  /// In ms, this message translates to:
  /// **'Siaran tanpa kuliah'**
  String get uploadNoKuliah;

  /// No description provided for @uploadEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada muat naik'**
  String get uploadEmpty;

  /// No description provided for @uploadEmptyHint.
  ///
  /// In ms, this message translates to:
  /// **'Jika siaran ke YouTube terputus atau tiada internet, rakaman kuliah boleh dihantar dari sini selepas siaran tamat.'**
  String get uploadEmptyHint;

  /// No description provided for @liveCloudUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: awan tidak dapat dihubungi'**
  String get liveCloudUnreachable;

  /// No description provided for @uploadErrorNoCloud.
  ///
  /// In ms, this message translates to:
  /// **'Awan tidak dapat dihubungi. Muat naik bermula sendiri apabila awan boleh dihubungi.'**
  String get uploadErrorNoCloud;

  /// No description provided for @uploadErrorNoBox.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik bermula sendiri apabila telefon berada di Wi-Fi surau.'**
  String get uploadErrorNoBox;

  /// No description provided for @uploadErrorUnlock.
  ///
  /// In ms, this message translates to:
  /// **'Buka MAXCOM dan buka kuncinya untuk meneruskan muat naik.'**
  String get uploadErrorUnlock;

  /// No description provided for @uploadErrorReauth.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube surau perlu diperbaharui oleh Pentadbir.'**
  String get uploadErrorReauth;

  /// No description provided for @uploadErrorOther.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik terhenti. Tekan Cuba lagi untuk menyambung.'**
  String get uploadErrorOther;

  /// No description provided for @uploadKeepBothNote.
  ///
  /// In ms, this message translates to:
  /// **'Siaran asal kekal di YouTube bersama video baharu'**
  String get uploadKeepBothNote;

  /// No description provided for @uploadSending.
  ///
  /// In ms, this message translates to:
  /// **'Sedang dimuat naik'**
  String get uploadSending;

  /// No description provided for @settingsCharMeter.
  ///
  /// In ms, this message translates to:
  /// **'{n} / {max} aksara'**
  String settingsCharMeter(int n, int max);

  /// No description provided for @settingsTitleTooLong.
  ///
  /// In ms, this message translates to:
  /// **'terlalu panjang untuk YouTube, akan dipotong'**
  String get settingsTitleTooLong;

  /// No description provided for @settingsTapToAdd.
  ///
  /// In ms, this message translates to:
  /// **'Ketik untuk tambah:'**
  String get settingsTapToAdd;

  /// No description provided for @settingsTemplatePreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton, kuliah malam ini'**
  String get settingsTemplatePreview;

  /// No description provided for @settingsUnknownPlaceholder.
  ///
  /// In ms, this message translates to:
  /// **'Tanda tidak dikenali: {list}'**
  String settingsUnknownPlaceholder(String list);

  /// No description provided for @settingsPresetHelp.
  ///
  /// In ms, this message translates to:
  /// **'Pilih satu atau tulis sendiri.'**
  String get settingsPresetHelp;

  /// No description provided for @settingsTestConnection.
  ///
  /// In ms, this message translates to:
  /// **'Cuba sambungan'**
  String get settingsTestConnection;

  /// No description provided for @settingsTestChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menyemak...'**
  String get settingsTestChecking;

  /// No description provided for @settingsTestOk.
  ///
  /// In ms, this message translates to:
  /// **'Berjaya: {ms} ms'**
  String settingsTestOk(int ms);

  /// No description provided for @settingsTestBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Alamat ini tidak dibenarkan'**
  String get settingsTestBlocked;

  /// No description provided for @settingsTestTimeout.
  ///
  /// In ms, this message translates to:
  /// **'Tiada jawapan dalam 5 saat'**
  String get settingsTestTimeout;

  /// No description provided for @settingsTestBadUrl.
  ///
  /// In ms, this message translates to:
  /// **'Alamat tidak sah'**
  String get settingsTestBadUrl;

  /// No description provided for @settingsTestStatus.
  ///
  /// In ms, this message translates to:
  /// **'Gagal, status {status}'**
  String settingsTestStatus(int status);

  /// No description provided for @settingsTestError.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menyemak sekarang'**
  String get settingsTestError;

  /// No description provided for @settingsLanjutan.
  ///
  /// In ms, this message translates to:
  /// **'Lanjutan'**
  String get settingsLanjutan;

  /// No description provided for @settingsLanjutanDimmed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak digunakan bila Telefon terus dipilih'**
  String get settingsLanjutanDimmed;

  /// No description provided for @settingsReencodeUnsupported.
  ///
  /// In ms, this message translates to:
  /// **'Kod semula tidak disokong pada MAXCOM ini. Gunakan Salin terus.'**
  String get settingsReencodeUnsupported;

  /// No description provided for @settingsComingSoon.
  ///
  /// In ms, this message translates to:
  /// **'Tersedia dalam keluaran akan datang'**
  String get settingsComingSoon;

  /// No description provided for @settingsHexLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kod warna (hex)'**
  String get settingsHexLabel;

  /// No description provided for @settingsHexHelp.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: #F6E7B8'**
  String get settingsHexHelp;

  /// No description provided for @settingsColourAutoHelp.
  ///
  /// In ms, this message translates to:
  /// **'Auto: MAXCOM pilih putih atau gelap ikut kecerahan setiap gambar latar.'**
  String get settingsColourAutoHelp;

  /// No description provided for @settingsColourFixedHelp.
  ///
  /// In ms, this message translates to:
  /// **'Warna ini dipakai pada semua gambar latar.'**
  String get settingsColourFixedHelp;

  /// No description provided for @settingsColourPreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton di atas gambar latar'**
  String get settingsColourPreview;

  /// No description provided for @swatchAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto'**
  String get swatchAuto;

  /// No description provided for @swatchWhite.
  ///
  /// In ms, this message translates to:
  /// **'Putih'**
  String get swatchWhite;

  /// No description provided for @swatchCream.
  ///
  /// In ms, this message translates to:
  /// **'Krim'**
  String get swatchCream;

  /// No description provided for @swatchGold.
  ///
  /// In ms, this message translates to:
  /// **'Emas'**
  String get swatchGold;

  /// No description provided for @swatchGreen.
  ///
  /// In ms, this message translates to:
  /// **'Hijau'**
  String get swatchGreen;

  /// No description provided for @swatchBlack.
  ///
  /// In ms, this message translates to:
  /// **'Hitam'**
  String get swatchBlack;

  /// No description provided for @swatchOther.
  ///
  /// In ms, this message translates to:
  /// **'Lain'**
  String get swatchOther;

  /// No description provided for @settingsAudioNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada fail'**
  String get settingsAudioNone;

  /// No description provided for @settingsAudioNoneHint.
  ///
  /// In ms, this message translates to:
  /// **'Azan pertama tidak dimainkan'**
  String get settingsAudioNoneHint;

  /// No description provided for @settingsAudioItem.
  ///
  /// In ms, this message translates to:
  /// **'Fail audio {n}'**
  String settingsAudioItem(int n);

  /// No description provided for @settingsAudioUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik audio'**
  String get settingsAudioUpload;

  /// No description provided for @settingsAudioUploading.
  ///
  /// In ms, this message translates to:
  /// **'Sedang dimuat naik...'**
  String get settingsAudioUploading;

  /// No description provided for @settingsAudioUploaded.
  ///
  /// In ms, this message translates to:
  /// **'Audio dimuat naik'**
  String get settingsAudioUploaded;

  /// No description provided for @settingsAudioWebOnly.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik fail MP3 melalui MAXCOM dalam pelayar.'**
  String get settingsAudioWebOnly;

  /// No description provided for @settingsAudioUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Senarai audio tidak dapat dibaca sekarang.'**
  String get settingsAudioUnavailable;

  /// No description provided for @settingsAudioNotMp3.
  ///
  /// In ms, this message translates to:
  /// **'Fail mesti MP3, paling besar 20 MB.'**
  String get settingsAudioNotMp3;

  /// No description provided for @settingsSurahSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari surah'**
  String get settingsSurahSearch;

  /// No description provided for @settingsAyatCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} ayat'**
  String settingsAyatCount(int n);

  /// No description provided for @settingsAyatHelp.
  ///
  /// In ms, this message translates to:
  /// **'{name} ada {n} ayat. Paling banyak 3 ayat sekali paparan.'**
  String settingsAyatHelp(String name, int n);

  /// No description provided for @settingsAyatCountLabel.
  ///
  /// In ms, this message translates to:
  /// **'Bilangan ayat'**
  String get settingsAyatCountLabel;

  /// No description provided for @settingsAyatSurahEnds.
  ///
  /// In ms, this message translates to:
  /// **'Surah ini tamat pada ayat {n}.'**
  String settingsAyatSurahEnds(int n);

  /// No description provided for @settingsAyatTv.
  ///
  /// In ms, this message translates to:
  /// **'Dipaparkan di TV: Surah {name} ({n}): ayat {a} hingga {b}'**
  String settingsAyatTv(String name, int n, int a, int b);

  /// No description provided for @settingsAyatTvOne.
  ///
  /// In ms, this message translates to:
  /// **'Dipaparkan di TV: Surah {name} ({n}): ayat {a}'**
  String settingsAyatTvOne(String name, int n, int a);

  /// No description provided for @settingsAyatTypeHint.
  ///
  /// In ms, this message translates to:
  /// **'Taip nombor ayat (1 hingga {n})'**
  String settingsAyatTypeHint(int n);

  /// No description provided for @settingsAyatTypeError.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan nombor antara 1 dan {n}'**
  String settingsAyatTypeError(int n);

  /// No description provided for @settingsAyatOldRange.
  ///
  /// In ms, this message translates to:
  /// **'Julat lama dipendekkan kepada 3 ayat.'**
  String get settingsAyatOldRange;

  /// No description provided for @settingsHijriMonthN.
  ///
  /// In ms, this message translates to:
  /// **'Bulan {n}'**
  String settingsHijriMonthN(int n);

  /// No description provided for @settingsReciterFolder.
  ///
  /// In ms, this message translates to:
  /// **'Nama folder EveryAyah'**
  String get settingsReciterFolder;

  /// No description provided for @settingsReciterFolderHelp.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Muhammad_Ayyoub_128kbps. Semak dengan Cuba sambungan sebelum disimpan.'**
  String get settingsReciterFolderHelp;

  /// No description provided for @settingsPickerNoMatch.
  ///
  /// In ms, this message translates to:
  /// **'Tiada padanan'**
  String get settingsPickerNoMatch;

  /// No description provided for @settingsSearchHint.
  ///
  /// In ms, this message translates to:
  /// **'Cari tetapan, contoh: azan'**
  String get settingsSearchHint;

  /// No description provided for @settingsWhyGroup.
  ///
  /// In ms, this message translates to:
  /// **'Kumpulan: {name}'**
  String settingsWhyGroup(String name);

  /// No description provided for @settingsWhyField.
  ///
  /// In ms, this message translates to:
  /// **'Medan: {name}'**
  String settingsWhyField(String name);

  /// No description provided for @settingsWhyChoice.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan: {name}'**
  String settingsWhyChoice(String name);

  /// No description provided for @settingsWhyKeyword.
  ///
  /// In ms, this message translates to:
  /// **'Kata kunci: {name}'**
  String settingsWhyKeyword(String name);

  /// No description provided for @settingsSearchFound.
  ///
  /// In ms, this message translates to:
  /// **'{n} tetapan sepadan. Kumpulan yang sepadan dibuka sendiri.'**
  String settingsSearchFound(int n);

  /// No description provided for @settingsGroupCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} ciri, {on} hidup'**
  String settingsGroupCount(int n, int on);

  /// No description provided for @settingsGroupMatches.
  ///
  /// In ms, this message translates to:
  /// **'{n} padanan'**
  String settingsGroupMatches(int n);

  /// No description provided for @settingsLanjutanSubtitle.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan sistem MAXCOM, tersembunyi daripada Pentadbir Surau'**
  String get settingsLanjutanSubtitle;

  /// No description provided for @settingsNoResults.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hasil'**
  String get settingsNoResults;

  /// No description provided for @settingsNoResultsBody.
  ///
  /// In ms, this message translates to:
  /// **'Tiada tetapan yang sepadan dengan \"{q}\". Cuba perkataan lain, contoh: azan, iqamah, warna atau YouTube.'**
  String settingsNoResultsBody(String q);

  /// No description provided for @settingsClearSearch.
  ///
  /// In ms, this message translates to:
  /// **'Kosongkan carian'**
  String get settingsClearSearch;

  /// No description provided for @settingsSavedShort.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan'**
  String get settingsSavedShort;

  /// No description provided for @settingsOrderRow.
  ///
  /// In ms, this message translates to:
  /// **'Susunan kad di skrin TV'**
  String get settingsOrderRow;

  /// No description provided for @settingsOrderRowHint.
  ///
  /// In ms, this message translates to:
  /// **'Seret untuk tukar giliran {n} kad.'**
  String settingsOrderRowHint(int n);

  /// No description provided for @settingsOrderIntro.
  ///
  /// In ms, this message translates to:
  /// **'Seret kad untuk tukar giliran di skrin TV. Kad yang dimatikan dilangkau.'**
  String get settingsOrderIntro;

  /// No description provided for @settingsOrderSeconds.
  ///
  /// In ms, this message translates to:
  /// **'{n} saat'**
  String settingsOrderSeconds(int n);

  /// No description provided for @settingsOrderOff.
  ///
  /// In ms, this message translates to:
  /// **'dimatikan'**
  String get settingsOrderOff;

  /// No description provided for @settingsOrderVideoLength.
  ///
  /// In ms, this message translates to:
  /// **'Sepanjang video'**
  String get settingsOrderVideoLength;

  /// No description provided for @settingsOrderUp.
  ///
  /// In ms, this message translates to:
  /// **'Naik'**
  String get settingsOrderUp;

  /// No description provided for @settingsOrderDown.
  ///
  /// In ms, this message translates to:
  /// **'Turun'**
  String get settingsOrderDown;

  /// No description provided for @settingsOrderSaved.
  ///
  /// In ms, this message translates to:
  /// **'Susunan disimpan'**
  String get settingsOrderSaved;

  /// No description provided for @settingsOrderRestore.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan susunan asal'**
  String get settingsOrderRestore;

  /// No description provided for @settingsOrderRestored.
  ///
  /// In ms, this message translates to:
  /// **'Susunan asal dipulihkan'**
  String get settingsOrderRestored;

  /// No description provided for @settingsDeviceLockSection.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini'**
  String get settingsDeviceLockSection;

  /// No description provided for @settingsDeviceLockTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kunci peranti ini'**
  String get settingsDeviceLockTitle;

  /// No description provided for @settingsDeviceLockBody.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh dimatikan. Akaun Pentadbir MAXCOM boleh mengubah tetapan sistem, jadi PIN atau cap jari sentiasa diperlukan bila MAXCOM dibuka di peranti ini. Pengguna lain tidak terjejas.'**
  String get settingsDeviceLockBody;

  /// No description provided for @syncSettingsUrlFixed.
  ///
  /// In ms, this message translates to:
  /// **'Ditetapkan semasa MAXCOM dipautkan ke awan'**
  String get syncSettingsUrlFixed;

  /// No description provided for @enrolTtlLabel.
  ///
  /// In ms, this message translates to:
  /// **'Kod sah selama'**
  String get enrolTtlLabel;

  /// No description provided for @enrolTtlHelp.
  ///
  /// In ms, this message translates to:
  /// **'10 minit ialah lalai. Pilih lebih lama jika peranti belum ada di tangan, contohnya dihantar kepada AJK yang belum sampai.'**
  String get enrolTtlHelp;

  /// No description provided for @enrolTtlMinutes.
  ///
  /// In ms, this message translates to:
  /// **'{n} minit'**
  String enrolTtlMinutes(int n);

  /// No description provided for @startNotJoined.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini belum menyertai mana-mana surau'**
  String get startNotJoined;

  /// No description provided for @startSetupHint.
  ///
  /// In ms, this message translates to:
  /// **'Jika MAXCOM ini baharu, imbas kod QR persediaan di skrin TV.'**
  String get startSetupHint;

  /// No description provided for @startJoinHint.
  ///
  /// In ms, this message translates to:
  /// **'Jika anda dijemput, imbas kod QR yang ditunjukkan oleh Pentadbir.'**
  String get startJoinHint;

  /// No description provided for @scanButton.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod QR'**
  String get scanButton;

  /// No description provided for @scanUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR tidak dikenali'**
  String get scanUnknown;

  /// No description provided for @setupFoundTitle.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ditemui'**
  String get setupFoundTitle;

  /// No description provided for @setupFoundHint.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini belum disediakan. Telefon pertama yang menyediakannya menjadi Pentadbir surau.'**
  String get setupFoundHint;

  /// No description provided for @setupNotSetUp.
  ///
  /// In ms, this message translates to:
  /// **'Belum disediakan'**
  String get setupNotSetUp;

  /// No description provided for @setupSurauName.
  ///
  /// In ms, this message translates to:
  /// **'Nama surau'**
  String get setupSurauName;

  /// No description provided for @setupYourName.
  ///
  /// In ms, this message translates to:
  /// **'Nama anda'**
  String get setupYourName;

  /// No description provided for @setupYourNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Haji Ali'**
  String get setupYourNameHint;

  /// No description provided for @setupPhoneName.
  ///
  /// In ms, this message translates to:
  /// **'Nama telefon ini'**
  String get setupPhoneName;

  /// No description provided for @setupBoxName.
  ///
  /// In ms, this message translates to:
  /// **'Nama MAXCOM ini'**
  String get setupBoxName;

  /// No description provided for @setupBoxNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: MAXCOM Dewan Utama'**
  String get setupBoxNameHint;

  /// No description provided for @setupFieldRequired.
  ///
  /// In ms, this message translates to:
  /// **'Ruangan ini diperlukan'**
  String get setupFieldRequired;

  /// No description provided for @setupConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Semak sebelum menyediakan'**
  String get setupConfirmTitle;

  /// No description provided for @setupConfirmHint.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan nama surau betul. Anda boleh mengubahnya di Konfigurasi kemudian.'**
  String get setupConfirmHint;

  /// No description provided for @setupFingerprintHint.
  ///
  /// In ms, this message translates to:
  /// **'Mesti sama dengan cap jari di bawah kod QR di skrin TV'**
  String get setupFingerprintHint;

  /// No description provided for @setupFingerprintLabel.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari'**
  String get setupFingerprintLabel;

  /// No description provided for @setupIdLabel.
  ///
  /// In ms, this message translates to:
  /// **'ID MAXCOM'**
  String get setupIdLabel;

  /// No description provided for @setupOnlyFirst.
  ///
  /// In ms, this message translates to:
  /// **'Hanya telefon pertama boleh menyediakan MAXCOM ini. Yang lain menyertai dengan kod daripada Pentadbir.'**
  String get setupOnlyFirst;

  /// No description provided for @setupSubmit.
  ///
  /// In ms, this message translates to:
  /// **'Sediakan MAXCOM'**
  String get setupSubmit;

  /// No description provided for @setupAlreadyDone.
  ///
  /// In ms, this message translates to:
  /// **'Surau sudah disediakan'**
  String get setupAlreadyDone;

  /// No description provided for @setupMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari tidak sepadan. Pastikan anda mengimbas skrin MAXCOM yang betul'**
  String get setupMismatch;

  /// No description provided for @setupCodeInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR sudah tamat atau sudah digunakan. Imbas kod yang baharu di skrin TV.'**
  String get setupCodeInvalid;

  /// No description provided for @setupExpired.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR sudah tamat. Imbas kod yang baharu di skrin TV.'**
  String get setupExpired;

  /// No description provided for @setupRetryAfter.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak percubaan. Cuba lagi dalam {minutes} minit.'**
  String setupRetryAfter(int minutes);

  /// No description provided for @recoveryCodeTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan anda'**
  String get recoveryCodeTitle;

  /// No description provided for @recoveryCodeOnce.
  ///
  /// In ms, this message translates to:
  /// **'Kod ini hanya ditunjukkan sekali'**
  String get recoveryCodeOnce;

  /// No description provided for @recoveryCodePaper.
  ///
  /// In ms, this message translates to:
  /// **'Tulis kod ini di atas kertas dan simpan di tempat selamat.'**
  String get recoveryCodePaper;

  /// No description provided for @recoveryCodeWhy.
  ///
  /// In ms, this message translates to:
  /// **'Jika semua Pentadbir kehilangan telefon, kod ini membolehkan Pentadbir baharu ditetapkan.'**
  String get recoveryCodeWhy;

  /// No description provided for @recoveryCodeNoShare.
  ///
  /// In ms, this message translates to:
  /// **'Jangan hantar melalui WhatsApp dan jangan ambil gambar skrin.'**
  String get recoveryCodeNoShare;

  /// No description provided for @recoveryCodeNoShotWeb.
  ///
  /// In ms, this message translates to:
  /// **'Skrin ini tidak dapat menghalang tangkapan skrin. Jangan ambil gambarnya.'**
  String get recoveryCodeNoShotWeb;

  /// No description provided for @recoveryCodeWritten.
  ///
  /// In ms, this message translates to:
  /// **'Saya sudah menulis kod ini di atas kertas'**
  String get recoveryCodeWritten;

  /// No description provided for @setupDoneTitle.
  ///
  /// In ms, this message translates to:
  /// **'{surau} sudah sedia'**
  String setupDoneTitle(String surau);

  /// No description provided for @setupDoneHint.
  ///
  /// In ms, this message translates to:
  /// **'Langkah seterusnya'**
  String get setupDoneHint;

  /// No description provided for @setupNextEnrol.
  ///
  /// In ms, this message translates to:
  /// **'Daftar telefon AJK lain'**
  String get setupNextEnrol;

  /// No description provided for @setupNextPair.
  ///
  /// In ms, this message translates to:
  /// **'Padankan skrin TV tambahan'**
  String get setupNextPair;

  /// No description provided for @setupNextLink.
  ///
  /// In ms, this message translates to:
  /// **'Pautkan ke awan MAXCOM'**
  String get setupNextLink;

  /// No description provided for @setupToDashboard.
  ///
  /// In ms, this message translates to:
  /// **'Ke papan pemuka'**
  String get setupToDashboard;

  /// No description provided for @probeOk.
  ///
  /// In ms, this message translates to:
  /// **'Sambungan ke MAXCOM berjaya'**
  String get probeOk;

  /// No description provided for @recoveryFoundTitle.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM dalam mod pemulihan'**
  String get recoveryFoundTitle;

  /// No description provided for @recoveryFoundHint.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini tiada Pentadbir yang boleh masuk. Masukkan kod pemulihan yang ditulis di atas kertas.'**
  String get recoveryFoundHint;

  /// No description provided for @recoveryLinkedHint.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini dipautkan ke awan. Pentadbir MAXCOM juga boleh meluluskan Pentadbir baharu dari awan (akan datang).'**
  String get recoveryLinkedHint;

  /// No description provided for @recoveryCodeField.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan'**
  String get recoveryCodeField;

  /// No description provided for @recoveryCodeFieldHint.
  ///
  /// In ms, this message translates to:
  /// **'16 aksara, contoh ABCD-EFGH-JKLM-NPQR'**
  String get recoveryCodeFieldHint;

  /// No description provided for @recoveryCodeShort.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan ada 16 aksara'**
  String get recoveryCodeShort;

  /// No description provided for @recoveryBadCode.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan salah. Kod QR di TV perlu diimbas semula'**
  String get recoveryBadCode;

  /// No description provided for @recoveryNotInRecovery.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini sudah ada Pentadbir aktif'**
  String get recoveryNotInRecovery;

  /// No description provided for @recoverySubmit.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan sebagai Pentadbir'**
  String get recoverySubmit;

  /// No description provided for @recoveryDoneTitle.
  ///
  /// In ms, this message translates to:
  /// **'Anda Pentadbir Surau'**
  String get recoveryDoneTitle;

  /// No description provided for @joinTitle.
  ///
  /// In ms, this message translates to:
  /// **'Sertai {surau}?'**
  String joinTitle(String surau);

  /// No description provided for @joinGreeting.
  ///
  /// In ms, this message translates to:
  /// **'Assalamualaikum, {name}'**
  String joinGreeting(String name);

  /// No description provided for @joinInvitedBy.
  ///
  /// In ms, this message translates to:
  /// **'Dijemput oleh {name}'**
  String joinInvitedBy(String name);

  /// No description provided for @joinValidUntil.
  ///
  /// In ms, this message translates to:
  /// **'Jemputan sah hingga {time}'**
  String joinValidUntil(String time);

  /// No description provided for @joinBoxFingerprintHint.
  ///
  /// In ms, this message translates to:
  /// **'Bandingkan dengan cap jari di skrin Pentadbir yang memberi kod'**
  String get joinBoxFingerprintHint;

  /// No description provided for @joinYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya, sertai surau ini'**
  String get joinYes;

  /// No description provided for @joinNo.
  ///
  /// In ms, this message translates to:
  /// **'Bukan surau saya'**
  String get joinNo;

  /// No description provided for @errCodeExpired.
  ///
  /// In ms, this message translates to:
  /// **'Kod sudah tamat'**
  String get errCodeExpired;

  /// No description provided for @errCodeExpiredBody.
  ///
  /// In ms, this message translates to:
  /// **'Kod ini tamat pada {time}. Minta kod baharu daripada Pentadbir.'**
  String errCodeExpiredBody(String time);

  /// No description provided for @errScanAnother.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod lain'**
  String get errScanAnother;

  /// No description provided for @errCodeUsed.
  ///
  /// In ms, this message translates to:
  /// **'Kod sudah digunakan'**
  String get errCodeUsed;

  /// No description provided for @errCodeUsedBody.
  ///
  /// In ms, this message translates to:
  /// **'Kod ini sudah digunakan. Jika bukan anda yang menggunakannya, maklumkan kepada Pentadbir.'**
  String get errCodeUsedBody;

  /// No description provided for @errOtherSurau.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini sudah menyertai surau lain'**
  String get errOtherSurau;

  /// No description provided for @errOtherSurauBody.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini sudah berdaftar dengan {surau}. Keluar dahulu.'**
  String errOtherSurauBody(String surau);

  /// No description provided for @errLeaveFirst.
  ///
  /// In ms, this message translates to:
  /// **'Keluar dari {surau}'**
  String errLeaveFirst(String surau);

  /// No description provided for @errCodeMayExpire.
  ///
  /// In ms, this message translates to:
  /// **'Kod baharu mungkin sudah tamat semasa anda keluar. Minta kod baharu jika perlu.'**
  String get errCodeMayExpire;

  /// No description provided for @errUnreachableTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menghubungi MAXCOM'**
  String get errUnreachableTitle;

  /// No description provided for @errUnreachableBody.
  ///
  /// In ms, this message translates to:
  /// **'Telefon tidak sampai ke MAXCOM ini. Cuba langkah berikut.'**
  String get errUnreachableBody;

  /// No description provided for @errTryFirst1.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan telefon di Wi-Fi utama surau, bukan Wi-Fi tetamu.'**
  String get errTryFirst1;

  /// No description provided for @errTryFirst2.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan skrin TV MAXCOM menyala dan menunjukkan kod.'**
  String get errTryFirst2;

  /// No description provided for @errTryFirst3.
  ///
  /// In ms, this message translates to:
  /// **'Matikan data mudah alih sebentar, kemudian cuba lagi.'**
  String get errTryFirst3;

  /// No description provided for @errRelaySoon.
  ///
  /// In ms, this message translates to:
  /// **'Pendaftaran melalui awan MAXCOM: akan datang'**
  String get errRelaySoon;

  /// No description provided for @errNoCloud.
  ///
  /// In ms, this message translates to:
  /// **'Surau ini belum dipautkan ke awan MAXCOM, jadi pendaftaran hanya boleh melalui Wi-Fi surau.'**
  String get errNoCloud;

  /// No description provided for @errRetry.
  ///
  /// In ms, this message translates to:
  /// **'Cuba semula'**
  String get errRetry;

  /// No description provided for @errMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari tidak sepadan. Pastikan anda mengimbas skrin MAXCOM yang betul'**
  String get errMismatch;

  /// No description provided for @devicesBoxRow.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM · {id}'**
  String devicesBoxRow(String id);

  /// No description provided for @devicesBoxRowHint.
  ///
  /// In ms, this message translates to:
  /// **'Skrin utama di surau. Sentiasa ada, tidak boleh dipadam.'**
  String get devicesBoxRowHint;

  /// No description provided for @devicesAwayBanner.
  ///
  /// In ms, this message translates to:
  /// **'Anda di luar rangkaian surau. Perubahan sampai ke MAXCOM pada penyelarasan seterusnya.'**
  String get devicesAwayBanner;

  /// No description provided for @devicesNeedLan.
  ///
  /// In ms, this message translates to:
  /// **'Perlukan rangkaian surau'**
  String get devicesNeedLan;

  /// No description provided for @devicesNeedLanBody.
  ///
  /// In ms, this message translates to:
  /// **'Memadankan skrin TV perlu dibuat di Wi-Fi surau. Sambung ke Wi-Fi surau dahulu.'**
  String get devicesNeedLanBody;

  /// No description provided for @devicesPairedMirrors.
  ///
  /// In ms, this message translates to:
  /// **'Skrin {screen} dipasangkan. Ia kini mencerminkan {box}.'**
  String devicesPairedMirrors(String screen, String box);

  /// No description provided for @leaveTitle.
  ///
  /// In ms, this message translates to:
  /// **'Keluar dari surau'**
  String get leaveTitle;

  /// No description provided for @leaveBody.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini akan dikeluarkan daripada {surau}. Kunci dan data di telefon ini dipadam. Anda perlukan kod QR baharu untuk menyertai semula.'**
  String leaveBody(String surau);

  /// No description provided for @leaveUnsynced.
  ///
  /// In ms, this message translates to:
  /// **'{n} perubahan belum diselaraskan'**
  String leaveUnsynced(int n);

  /// No description provided for @leaveSyncFirst.
  ///
  /// In ms, this message translates to:
  /// **'Selaraskan sekarang'**
  String get leaveSyncFirst;

  /// No description provided for @leaveConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Keluar'**
  String get leaveConfirm;

  /// No description provided for @leaveLastAdminTitle.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini satu-satunya peranti Pentadbir'**
  String get leaveLastAdminTitle;

  /// No description provided for @leaveLastAdminBody.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti Pentadbir lain dahulu, supaya surau tidak ditinggalkan tanpa Pentadbir.'**
  String get leaveLastAdminBody;

  /// No description provided for @leaveEnrolOther.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti Pentadbir lain'**
  String get leaveEnrolOther;

  /// No description provided for @leaveOfflineBody.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi. Peranti ini kekal aktif di MAXCOM sehingga Pentadbir membatalkannya.'**
  String get leaveOfflineBody;

  /// No description provided for @leaveForgetOnly.
  ///
  /// In ms, this message translates to:
  /// **'Lupakan peranti ini sahaja'**
  String get leaveForgetOnly;

  /// No description provided for @leftTitle.
  ///
  /// In ms, this message translates to:
  /// **'Anda sudah keluar'**
  String get leftTitle;

  /// No description provided for @leftBody.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini tidak lagi menyertai {surau}.'**
  String leftBody(String surau);

  /// No description provided for @leftJoinOther.
  ///
  /// In ms, this message translates to:
  /// **'Sertai surau lain'**
  String get leftJoinOther;

  /// No description provided for @scanEntry.
  ///
  /// In ms, this message translates to:
  /// **'Imbas kod QR'**
  String get scanEntry;

  /// No description provided for @scanEntryHint.
  ///
  /// In ms, this message translates to:
  /// **'Untuk kod persediaan, pemulihan atau pendaftaran'**
  String get scanEntryHint;

  /// No description provided for @netCheckEntry.
  ///
  /// In ms, this message translates to:
  /// **'Semakan rangkaian'**
  String get netCheckEntry;

  /// No description provided for @netCheckTitle.
  ///
  /// In ms, this message translates to:
  /// **'Semakan rangkaian'**
  String get netCheckTitle;

  /// No description provided for @netBoxReachable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM dapat dihubungi'**
  String get netBoxReachable;

  /// No description provided for @netBoxDown.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dihubungi'**
  String get netBoxDown;

  /// No description provided for @netCloudReachable.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM dapat dihubungi'**
  String get netCloudReachable;

  /// No description provided for @netCloudDown.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM tidak dapat dihubungi'**
  String get netCloudDown;

  /// No description provided for @netCloudNone.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dipautkan ke awan'**
  String get netCloudNone;

  /// No description provided for @netLastSync.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan {when}'**
  String netLastSync(String when);

  /// No description provided for @netNeverSynced.
  ///
  /// In ms, this message translates to:
  /// **'Belum pernah diselaraskan'**
  String get netNeverSynced;

  /// No description provided for @rotateRecoveryTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan baharu'**
  String get rotateRecoveryTitle;

  /// No description provided for @rotateRecoveryBody.
  ///
  /// In ms, this message translates to:
  /// **'Kod lama tamat serta-merta. Kod baharu ditunjukkan sekali sahaja.'**
  String get rotateRecoveryBody;

  /// No description provided for @rotateRecoveryConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Jana kod baharu'**
  String get rotateRecoveryConfirm;

  /// No description provided for @codeUsedAt.
  ///
  /// In ms, this message translates to:
  /// **'Digunakan {time}'**
  String codeUsedAt(String time);

  /// No description provided for @codeReuseAttempts.
  ///
  /// In ms, this message translates to:
  /// **'Cuba digunakan {n} kali'**
  String codeReuseAttempts(int n);

  /// No description provided for @enrolQrFingerprint.
  ///
  /// In ms, this message translates to:
  /// **'Cap jari MAXCOM: {fp}'**
  String enrolQrFingerprint(String fp);

  /// No description provided for @setupNotConfirmed.
  ///
  /// In ms, this message translates to:
  /// **'Jawapan daripada MAXCOM tidak sampai. Penyediaan mungkin sudah selesai. Tekan Cuba lagi untuk menghantar permintaan yang sama.'**
  String get setupNotConfirmed;

  /// No description provided for @recoveryNotConfirmed.
  ///
  /// In ms, this message translates to:
  /// **'Jawapan daripada MAXCOM tidak sampai. Pemulihan mungkin sudah selesai. Tekan Cuba lagi untuk menghantar permintaan yang sama.'**
  String get recoveryNotConfirmed;

  /// No description provided for @usersNoRecoveryWarning.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini belum ada kod pemulihan. Jika semua telefon Pentadbir hilang, tiada cara untuk masuk semula. Tekan Kod pemulihan baharu dan simpan kod itu di tempat selamat.'**
  String get usersNoRecoveryWarning;

  /// No description provided for @fingerprintCompare.
  ///
  /// In ms, this message translates to:
  /// **'Pastikan kod ini sama dengan kod pada skrin TV'**
  String get fingerprintCompare;

  /// No description provided for @fingerprintSame.
  ///
  /// In ms, this message translates to:
  /// **'Sama, teruskan'**
  String get fingerprintSame;

  /// No description provided for @fingerprintDifferent.
  ///
  /// In ms, this message translates to:
  /// **'Tidak sama, batalkan'**
  String get fingerprintDifferent;

  /// No description provided for @scanOnlyTvQr.
  ///
  /// In ms, this message translates to:
  /// **'Imbas hanya QR pada skrin TV MAXCOM. Jangan imbas QR daripada kertas, gambar atau mesej.'**
  String get scanOnlyTvQr;

  /// No description provided for @probeAskTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hantar ujian sambungan?'**
  String get probeAskTitle;

  /// No description provided for @probeAskBody.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini akan menghubungi {host}. Teruskan hanya jika alamat ini ialah MAXCOM anda.'**
  String probeAskBody(String host);

  /// No description provided for @probeAskConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Ya, hantar ujian'**
  String get probeAskConfirm;

  /// No description provided for @recoveryBoxLocked.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini telah digantung'**
  String get recoveryBoxLocked;

  /// No description provided for @recoveryBoxLockedBody.
  ///
  /// In ms, this message translates to:
  /// **'Pemulihan tidak boleh dibuat sekarang. Sila hubungi pemasang MAXCOM.'**
  String get recoveryBoxLockedBody;

  /// No description provided for @hadisReorderNeedsConnection.
  ///
  /// In ms, this message translates to:
  /// **'Susun semula perlukan sambungan ke MAXCOM'**
  String get hadisReorderNeedsConnection;

  /// No description provided for @hadisTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hadis'**
  String get hadisTitle;

  /// No description provided for @hadisListIntro.
  ///
  /// In ms, this message translates to:
  /// **'Hadis yang dipaparkan dalam kad hadis di TV. Semua disimpan di MAXCOM, jadi TV terus memaparkannya walaupun tiada internet.'**
  String get hadisListIntro;

  /// No description provided for @hadisNetOnlineTitle.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM dalam talian.'**
  String get hadisNetOnlineTitle;

  /// No description provided for @hadisNetOnlineBody.
  ///
  /// In ms, this message translates to:
  /// **'Carian HadeethEnc melalui MAXCOM.'**
  String get hadisNetOnlineBody;

  /// No description provided for @hadisNetOfflineTitle.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tiada internet.'**
  String get hadisNetOfflineTitle;

  /// No description provided for @hadisNetOfflineBody.
  ///
  /// In ms, this message translates to:
  /// **'Hadis yang tersimpan tetap dipaparkan di TV.'**
  String get hadisNetOfflineBody;

  /// No description provided for @hadisStatSaved.
  ///
  /// In ms, this message translates to:
  /// **'disimpan di MAXCOM'**
  String get hadisStatSaved;

  /// No description provided for @hadisStatShown.
  ///
  /// In ms, this message translates to:
  /// **'hidup di TV'**
  String get hadisStatShown;

  /// No description provided for @hadisStatProvider.
  ///
  /// In ms, this message translates to:
  /// **'dari HadeethEnc'**
  String get hadisStatProvider;

  /// No description provided for @hadisFind.
  ///
  /// In ms, this message translates to:
  /// **'Cari hadis'**
  String get hadisFind;

  /// No description provided for @hadisAddOwn.
  ///
  /// In ms, this message translates to:
  /// **'Tambah sendiri'**
  String get hadisAddOwn;

  /// No description provided for @hadisFindNeedsInternet.
  ///
  /// In ms, this message translates to:
  /// **'Cari hadis perlukan internet melalui MAXCOM. Tambah sendiri tetap boleh.'**
  String get hadisFindNeedsInternet;

  /// No description provided for @hadisOrderTitle.
  ///
  /// In ms, this message translates to:
  /// **'Susunan di TV'**
  String get hadisOrderTitle;

  /// No description provided for @hadisOrderHintSwitch.
  ///
  /// In ms, this message translates to:
  /// **'Suis: papar atau sembunyi. Tong sampah: buang'**
  String get hadisOrderHintSwitch;

  /// No description provided for @hadisOrderHintSort.
  ///
  /// In ms, this message translates to:
  /// **'Anak panah: susun. Tong sampah: buang'**
  String get hadisOrderHintSort;

  /// No description provided for @hadisFilterAll.
  ///
  /// In ms, this message translates to:
  /// **'Semua'**
  String get hadisFilterAll;

  /// No description provided for @hadisFilterOwn.
  ///
  /// In ms, this message translates to:
  /// **'Senarai sendiri'**
  String get hadisFilterOwn;

  /// No description provided for @hadisFilterProvider.
  ///
  /// In ms, this message translates to:
  /// **'HadeethEnc'**
  String get hadisFilterProvider;

  /// No description provided for @hadisSort.
  ///
  /// In ms, this message translates to:
  /// **'Susun'**
  String get hadisSort;

  /// No description provided for @hadisSortDone.
  ///
  /// In ms, this message translates to:
  /// **'Siap'**
  String get hadisSortDone;

  /// No description provided for @hadisNoneFiltered.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hadis dalam tapisan ini.'**
  String get hadisNoneFiltered;

  /// No description provided for @hadisNoneSaved.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada hadis disimpan. Tekan Cari hadis atau Tambah sendiri.'**
  String get hadisNoneSaved;

  /// No description provided for @hadisListHelp.
  ///
  /// In ms, this message translates to:
  /// **'Susunan ini ialah susunan giliran di TV bila sumber Kedua-dua. Tetapan sumber dan giliran di Konfigurasi, Hadis. Suis menyembunyikan hadis dari TV tetapi kekal tersimpan; Buang memadamnya dari senarai MAXCOM.'**
  String get hadisListHelp;

  /// No description provided for @hadisNearFull.
  ///
  /// In ms, this message translates to:
  /// **'Hampir penuh ({n}/{max})'**
  String hadisNearFull(int n, int max);

  /// No description provided for @hadisTagLong.
  ///
  /// In ms, this message translates to:
  /// **'Panjang untuk TV'**
  String get hadisTagLong;

  /// No description provided for @hadisTagShort.
  ///
  /// In ms, this message translates to:
  /// **'Pendek'**
  String get hadisTagShort;

  /// No description provided for @hadisTagMedium.
  ///
  /// In ms, this message translates to:
  /// **'Sederhana'**
  String get hadisTagMedium;

  /// No description provided for @hadisTagUpdated.
  ///
  /// In ms, this message translates to:
  /// **'Teks dikemas kini'**
  String get hadisTagUpdated;

  /// No description provided for @hadisTagHidden.
  ///
  /// In ms, this message translates to:
  /// **'Mati'**
  String get hadisTagHidden;

  /// No description provided for @hadisTagGradeBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Disembunyikan: darjat baharu tidak dibenarkan'**
  String get hadisTagGradeBlocked;

  /// No description provided for @hadisTagUnstated.
  ///
  /// In ms, this message translates to:
  /// **'Sumber tidak dinyatakan'**
  String get hadisTagUnstated;

  /// No description provided for @hadisTagPending.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu sambungan'**
  String get hadisTagPending;

  /// No description provided for @hadisGradeBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Darjat tidak dibenarkan'**
  String get hadisGradeBlocked;

  /// No description provided for @hadisGradeUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Darjat tidak dikenali'**
  String get hadisGradeUnknown;

  /// No description provided for @hadisShowOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Papar di TV'**
  String get hadisShowOnTv;

  /// No description provided for @hadisRemoveTip.
  ///
  /// In ms, this message translates to:
  /// **'Buang dari senarai'**
  String get hadisRemoveTip;

  /// No description provided for @hadisMoveUp.
  ///
  /// In ms, this message translates to:
  /// **'Naik'**
  String get hadisMoveUp;

  /// No description provided for @hadisMoveDown.
  ///
  /// In ms, this message translates to:
  /// **'Turun'**
  String get hadisMoveDown;

  /// No description provided for @hadisRemoveTitle.
  ///
  /// In ms, this message translates to:
  /// **'Buang hadis ini?'**
  String get hadisRemoveTitle;

  /// No description provided for @hadisRemoveOwnBold.
  ///
  /// In ms, this message translates to:
  /// **'Kekal, tidak boleh dibatalkan.'**
  String get hadisRemoveOwnBold;

  /// No description provided for @hadisRemoveOwnBody.
  ///
  /// In ms, this message translates to:
  /// **'Hadis senarai sendiri ini dipadam dari MAXCOM dan tiada salinan lain. Untuk menyembunyikan sahaja dari TV, guna suis.'**
  String get hadisRemoveOwnBody;

  /// No description provided for @hadisRemoveProviderBody.
  ///
  /// In ms, this message translates to:
  /// **'Hadis ini dipadam dari senarai MAXCOM dan tidak lagi dipaparkan di TV. Ia boleh ditambah semula dari Cari hadis bila MAXCOM ada internet. Untuk menyembunyikan sahaja, guna suis.'**
  String get hadisRemoveProviderBody;

  /// No description provided for @hadisRemoveOwnConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Buang kekal'**
  String get hadisRemoveOwnConfirm;

  /// No description provided for @hadisRemoveConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Buang'**
  String get hadisRemoveConfirm;

  /// No description provided for @hadisRemoved.
  ///
  /// In ms, this message translates to:
  /// **'Hadis dibuang dari senarai'**
  String get hadisRemoved;

  /// No description provided for @hadisUpdateTitle.
  ///
  /// In ms, this message translates to:
  /// **'Teks dikemas kini di HadeethEnc'**
  String get hadisUpdateTitle;

  /// No description provided for @hadisUpdateBody.
  ///
  /// In ms, this message translates to:
  /// **'HadeethEnc mengemas kini hadis {id} selepas ia disimpan di MAXCOM.'**
  String hadisUpdateBody(String id);

  /// No description provided for @hadisUpdateBody2.
  ///
  /// In ms, this message translates to:
  /// **'TV masih memaparkan teks yang disimpan. Semak teks baharu dahulu sebelum menggantikannya.'**
  String get hadisUpdateBody2;

  /// No description provided for @hadisUpdateNewText.
  ///
  /// In ms, this message translates to:
  /// **'Teks baharu'**
  String get hadisUpdateNewText;

  /// No description provided for @hadisUpdateKeep.
  ///
  /// In ms, this message translates to:
  /// **'Kekal teks lama'**
  String get hadisUpdateKeep;

  /// No description provided for @hadisUpdateUse.
  ///
  /// In ms, this message translates to:
  /// **'Guna teks baharu'**
  String get hadisUpdateUse;

  /// No description provided for @hadisUpdateDone.
  ///
  /// In ms, this message translates to:
  /// **'Teks baharu digunakan. TV dikemas kini dalam beberapa saat.'**
  String get hadisUpdateDone;

  /// No description provided for @hadisUpdateGradeBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Teks baharu digunakan, tetapi darjat barunya tidak dibenarkan. Hadis ini disembunyikan dari TV.'**
  String get hadisUpdateGradeBlocked;

  /// No description provided for @hadisUpdateNote.
  ///
  /// In ms, this message translates to:
  /// **'HadeethEnc mengemas kini teks hadis ini. TV masih memaparkan teks yang disimpan.'**
  String get hadisUpdateNote;

  /// No description provided for @hadisUpdateReview.
  ///
  /// In ms, this message translates to:
  /// **'Semak'**
  String get hadisUpdateReview;

  /// No description provided for @hadisSearchHint.
  ///
  /// In ms, this message translates to:
  /// **'Cari hadis, contoh: solat'**
  String get hadisSearchHint;

  /// No description provided for @hadisSearchGo.
  ///
  /// In ms, this message translates to:
  /// **'Cari'**
  String get hadisSearchGo;

  /// No description provided for @hadisTabCategories.
  ///
  /// In ms, this message translates to:
  /// **'Kategori'**
  String get hadisTabCategories;

  /// No description provided for @hadisTabResults.
  ///
  /// In ms, this message translates to:
  /// **'Hasil carian'**
  String get hadisTabResults;

  /// No description provided for @hadisPickToRead.
  ///
  /// In ms, this message translates to:
  /// **'Pilih hadis dari senarai untuk melihat butiran.'**
  String get hadisPickToRead;

  /// No description provided for @hadisOfflineTitle.
  ///
  /// In ms, this message translates to:
  /// **'Carian perlukan internet'**
  String get hadisOfflineTitle;

  /// No description provided for @hadisOfflineBody.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tiada sambungan internet sekarang. Hadis dicari di HadeethEnc melalui MAXCOM, bukan terus dari telefon.'**
  String get hadisOfflineBody;

  /// No description provided for @hadisOfflineSaved.
  ///
  /// In ms, this message translates to:
  /// **'{n} hadis tersimpan di MAXCOM'**
  String hadisOfflineSaved(int n);

  /// No description provided for @hadisOfflineSavedTail.
  ///
  /// In ms, this message translates to:
  /// **'dan terus dipaparkan di TV.'**
  String get hadisOfflineSavedTail;

  /// No description provided for @hadisManageSaved.
  ///
  /// In ms, this message translates to:
  /// **'Urus hadis tersimpan'**
  String get hadisManageSaved;

  /// No description provided for @hadisStillOffline.
  ///
  /// In ms, this message translates to:
  /// **'Masih tiada internet di MAXCOM. Semak kabel atau Wi-Fi.'**
  String get hadisStillOffline;

  /// No description provided for @hadisCatalogEmptyTitle.
  ///
  /// In ms, this message translates to:
  /// **'Senarai hadis HadeethEnc belum dimuat turun'**
  String get hadisCatalogEmptyTitle;

  /// No description provided for @hadisCatalogEmptyBody.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun senarai ini ke MAXCOM supaya hadis boleh dicari dan dipilih.'**
  String get hadisCatalogEmptyBody;

  /// No description provided for @hadisCatalogEmptyAsk.
  ///
  /// In ms, this message translates to:
  /// **'Minta Pentadbir memuat turun senarai ini.'**
  String get hadisCatalogEmptyAsk;

  /// No description provided for @hadisDownloadNow.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun sekarang'**
  String get hadisDownloadNow;

  /// No description provided for @hadisDownloading.
  ///
  /// In ms, this message translates to:
  /// **'Memuat turun {done} daripada {total}'**
  String hadisDownloading(int done, int total);

  /// No description provided for @hadisDownloadStarting.
  ///
  /// In ms, this message translates to:
  /// **'Memulakan muat turun'**
  String get hadisDownloadStarting;

  /// No description provided for @hadisDownloadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun terhenti. Tekan sekali lagi untuk menyambung.'**
  String get hadisDownloadFailed;

  /// No description provided for @hadisAllCategories.
  ///
  /// In ms, this message translates to:
  /// **'Semua kategori'**
  String get hadisAllCategories;

  /// No description provided for @hadisCatOriginalName.
  ///
  /// In ms, this message translates to:
  /// **'Nama asal dari API: {name}'**
  String hadisCatOriginalName(String name);

  /// No description provided for @hadisSubcategories.
  ///
  /// In ms, this message translates to:
  /// **'{n} subkategori'**
  String hadisSubcategories(int n);

  /// No description provided for @hadisCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} hadis'**
  String hadisCount(int n);

  /// No description provided for @hadisInCategory.
  ///
  /// In ms, this message translates to:
  /// **'Hadis dalam kategori ini'**
  String get hadisInCategory;

  /// No description provided for @hadisNoItems.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hadis.'**
  String get hadisNoItems;

  /// No description provided for @hadisLoadMore.
  ///
  /// In ms, this message translates to:
  /// **'Muat lagi'**
  String get hadisLoadMore;

  /// No description provided for @hadisCredit.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: HadeethEnc.com, Ensiklopedia Hadis Terjemahan. Bahasa Melayu.'**
  String get hadisCredit;

  /// No description provided for @hadisResultsCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} hasil untuk \"{q}\"'**
  String hadisResultsCount(int n, String q);

  /// No description provided for @hadisTypeKeyword.
  ///
  /// In ms, this message translates to:
  /// **'Taip kata kunci'**
  String get hadisTypeKeyword;

  /// No description provided for @hadisResultsScope.
  ///
  /// In ms, this message translates to:
  /// **'Tajuk dan teks BM'**
  String get hadisResultsScope;

  /// No description provided for @hadisNoResults.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hadis sepadan. Cuba kata lain atau buka kategori.'**
  String get hadisNoResults;

  /// No description provided for @hadisSearchExample.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: solat, doa, sedekah.'**
  String get hadisSearchExample;

  /// No description provided for @hadisDetailTitle.
  ///
  /// In ms, this message translates to:
  /// **'Butiran hadis'**
  String get hadisDetailTitle;

  /// No description provided for @hadisDetailKicker.
  ///
  /// In ms, this message translates to:
  /// **'HADIS {id}  HADEETHENC'**
  String hadisDetailKicker(String id);

  /// No description provided for @hadisTranslation.
  ///
  /// In ms, this message translates to:
  /// **'Terjemahan Bahasa Melayu'**
  String get hadisTranslation;

  /// No description provided for @hadisArabicText.
  ///
  /// In ms, this message translates to:
  /// **'Teks Arab'**
  String get hadisArabicText;

  /// No description provided for @hadisArabicHidden.
  ///
  /// In ms, this message translates to:
  /// **'Teks Arab disembunyikan dalam pratonton ini. Tetapan TV di Konfigurasi, Hadis.'**
  String get hadisArabicHidden;

  /// No description provided for @hadisDetails.
  ///
  /// In ms, this message translates to:
  /// **'Butiran'**
  String get hadisDetails;

  /// No description provided for @hadisGrade.
  ///
  /// In ms, this message translates to:
  /// **'Darjat'**
  String get hadisGrade;

  /// No description provided for @hadisAttribution.
  ///
  /// In ms, this message translates to:
  /// **'Atribusi'**
  String get hadisAttribution;

  /// No description provided for @hadisCategories.
  ///
  /// In ms, this message translates to:
  /// **'Kategori'**
  String get hadisCategories;

  /// No description provided for @hadisSourceLine.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: HadeethEnc.com (Ensiklopedia Hadis Terjemahan), ID {id}'**
  String hadisSourceLine(String id);

  /// No description provided for @hadisPreviewOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton di TV'**
  String get hadisPreviewOnTv;

  /// No description provided for @hadisLongNote.
  ///
  /// In ms, this message translates to:
  /// **'({n} aksara). Di TV hadis ini dipecah kepada beberapa bahagian yang bertukar sendiri.'**
  String hadisLongNote(int n);

  /// No description provided for @hadisAddKiosk.
  ///
  /// In ms, this message translates to:
  /// **'Tambah ke kiosk'**
  String get hadisAddKiosk;

  /// No description provided for @hadisAlreadyKiosk.
  ///
  /// In ms, this message translates to:
  /// **'Sudah di kiosk'**
  String get hadisAlreadyKiosk;

  /// No description provided for @hadisAddNeedsInternet.
  ///
  /// In ms, this message translates to:
  /// **'Tambah perlukan internet melalui MAXCOM.'**
  String get hadisAddNeedsInternet;

  /// No description provided for @hadisAdded.
  ///
  /// In ms, this message translates to:
  /// **'Hadis ditambah ke kiosk'**
  String get hadisAdded;

  /// No description provided for @hadisAddGradeBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Darjat hadis ini tidak dibenarkan di TV'**
  String get hadisAddGradeBlocked;

  /// No description provided for @hadisAddTooLong.
  ///
  /// In ms, this message translates to:
  /// **'Teks terlalu panjang untuk MAXCOM'**
  String get hadisAddTooLong;

  /// No description provided for @hadisAddLimit.
  ///
  /// In ms, this message translates to:
  /// **'Senarai penuh ({max} hadis). Buang hadis lain dahulu.'**
  String hadisAddLimit(int max);

  /// No description provided for @hadisAddUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat mencapai HadeethEnc sekarang. Cuba lagi.'**
  String get hadisAddUnavailable;

  /// No description provided for @hadisSettingsIntro.
  ///
  /// In ms, this message translates to:
  /// **'Kad hadis di TV: dari mana hadis diambil, berapa banyak sehari dan apa yang dipaparkan.'**
  String get hadisSettingsIntro;

  /// No description provided for @hadisSourceTitle.
  ///
  /// In ms, this message translates to:
  /// **'Sumber hadis'**
  String get hadisSourceTitle;

  /// No description provided for @hadisSourceOwnDesc.
  ///
  /// In ms, this message translates to:
  /// **'{n} hadis ditaip atau diimport ({on} hidup).'**
  String hadisSourceOwnDesc(int n, int on);

  /// No description provided for @hadisSourceProviderDesc.
  ///
  /// In ms, this message translates to:
  /// **'{n} hadis dipilih dari HadeethEnc.com, disimpan di MAXCOM ({on} hidup).'**
  String hadisSourceProviderDesc(int n, int on);

  /// No description provided for @hadisSourceBoth.
  ///
  /// In ms, this message translates to:
  /// **'Kedua-dua'**
  String get hadisSourceBoth;

  /// No description provided for @hadisSourceBothDesc.
  ///
  /// In ms, this message translates to:
  /// **'Senarai sendiri dan HadeethEnc, ikut susunan di senarai Hadis.'**
  String get hadisSourceBothDesc;

  /// No description provided for @hadisMixTitle.
  ///
  /// In ms, this message translates to:
  /// **'Susunan'**
  String get hadisMixTitle;

  /// No description provided for @hadisMixList.
  ///
  /// In ms, this message translates to:
  /// **'Ikut senarai'**
  String get hadisMixList;

  /// No description provided for @hadisMixAlternate.
  ///
  /// In ms, this message translates to:
  /// **'Berselang-seli'**
  String get hadisMixAlternate;

  /// No description provided for @hadisMixRandom.
  ///
  /// In ms, this message translates to:
  /// **'Rawak'**
  String get hadisMixRandom;

  /// No description provided for @hadisMixListHelp.
  ///
  /// In ms, this message translates to:
  /// **'Ikut susunan yang anda tetapkan di senarai Hadis.'**
  String get hadisMixListHelp;

  /// No description provided for @hadisMixAlternateHelp.
  ///
  /// In ms, this message translates to:
  /// **'Satu dari senarai sendiri, kemudian satu dari HadeethEnc, dan seterusnya.'**
  String get hadisMixAlternateHelp;

  /// No description provided for @hadisMixRandomHelp.
  ///
  /// In ms, this message translates to:
  /// **'Susunan rawak setiap hari.'**
  String get hadisMixRandomHelp;

  /// No description provided for @hadisTurnTitle.
  ///
  /// In ms, this message translates to:
  /// **'Giliran'**
  String get hadisTurnTitle;

  /// No description provided for @hadisChangeTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tukar hadis'**
  String get hadisChangeTitle;

  /// No description provided for @hadisChangeDay.
  ///
  /// In ms, this message translates to:
  /// **'Satu set sehari'**
  String get hadisChangeDay;

  /// No description provided for @hadisChangeCard.
  ///
  /// In ms, this message translates to:
  /// **'Setiap paparan'**
  String get hadisChangeCard;

  /// No description provided for @hadisChangeDayHelp.
  ///
  /// In ms, this message translates to:
  /// **'Hadis yang sama sepanjang hari; set baharu esok.'**
  String get hadisChangeDayHelp;

  /// No description provided for @hadisChangeCardHelp.
  ///
  /// In ms, this message translates to:
  /// **'Hadis seterusnya setiap kali kad hadis muncul.'**
  String get hadisChangeCardHelp;

  /// No description provided for @hadisPerDay.
  ///
  /// In ms, this message translates to:
  /// **'Bilangan hadis sehari'**
  String get hadisPerDay;

  /// No description provided for @hadisPerDayHelp.
  ///
  /// In ms, this message translates to:
  /// **'Bergilir dalam kitaran kandungan'**
  String get hadisPerDayHelp;

  /// No description provided for @hadisPerDayNotUsed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak terpakai untuk Setiap paparan'**
  String get hadisPerDayNotUsed;

  /// No description provided for @hadisDuration.
  ///
  /// In ms, this message translates to:
  /// **'Masa paparan kad'**
  String get hadisDuration;

  /// No description provided for @hadisDurationHelp.
  ///
  /// In ms, this message translates to:
  /// **'Setiap kali kad hadis muncul'**
  String get hadisDurationHelp;

  /// No description provided for @hadisSeconds.
  ///
  /// In ms, this message translates to:
  /// **'{n} saat'**
  String hadisSeconds(int n);

  /// No description provided for @hadisTodayTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hari ini di TV'**
  String get hadisTodayTitle;

  /// No description provided for @hadisTodayItem.
  ///
  /// In ms, this message translates to:
  /// **'Hadis {n}'**
  String hadisTodayItem(int n);

  /// No description provided for @hadisTodayEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hadis hidup untuk sumber ini. Kad hadis dilangkau di TV.'**
  String get hadisTodayEmpty;

  /// No description provided for @hadisTodayMore.
  ///
  /// In ms, this message translates to:
  /// **'dan {n} lagi'**
  String hadisTodayMore(int n);

  /// No description provided for @hadisDisplayTitle.
  ///
  /// In ms, this message translates to:
  /// **'Paparan di TV'**
  String get hadisDisplayTitle;

  /// No description provided for @hadisFieldArabic.
  ///
  /// In ms, this message translates to:
  /// **'Teks Arab'**
  String get hadisFieldArabic;

  /// No description provided for @hadisFieldArabicHelp.
  ///
  /// In ms, this message translates to:
  /// **'Teks asal hadis, kanan ke kiri'**
  String get hadisFieldArabicHelp;

  /// No description provided for @hadisFieldMalay.
  ///
  /// In ms, this message translates to:
  /// **'Terjemahan Bahasa Melayu'**
  String get hadisFieldMalay;

  /// No description provided for @hadisFieldMalayHelp.
  ///
  /// In ms, this message translates to:
  /// **'Teks utama kad'**
  String get hadisFieldMalayHelp;

  /// No description provided for @hadisFieldAttribution.
  ///
  /// In ms, this message translates to:
  /// **'Atribusi'**
  String get hadisFieldAttribution;

  /// No description provided for @hadisFieldAttributionHelp.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Muttafaq alaih, Riwayat Muslim'**
  String get hadisFieldAttributionHelp;

  /// No description provided for @hadisFieldGrade.
  ///
  /// In ms, this message translates to:
  /// **'Darjat'**
  String get hadisFieldGrade;

  /// No description provided for @hadisFieldGradeHelp.
  ///
  /// In ms, this message translates to:
  /// **'Cip Sahih atau Hasan'**
  String get hadisFieldGradeHelp;

  /// No description provided for @hadisFieldCredit.
  ///
  /// In ms, this message translates to:
  /// **'Kredit sumber'**
  String get hadisFieldCredit;

  /// No description provided for @hadisFieldCreditHelp.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: HadeethEnc.com di kaki kad'**
  String get hadisFieldCreditHelp;

  /// No description provided for @hadisRequired.
  ///
  /// In ms, this message translates to:
  /// **'Wajib'**
  String get hadisRequired;

  /// No description provided for @hadisFontTitle.
  ///
  /// In ms, this message translates to:
  /// **'Saiz tulisan'**
  String get hadisFontTitle;

  /// No description provided for @hadisFontAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto'**
  String get hadisFontAuto;

  /// No description provided for @hadisFontAutoLong.
  ///
  /// In ms, this message translates to:
  /// **'Auto ikut panjang'**
  String get hadisFontAutoLong;

  /// No description provided for @hadisFontSmall.
  ///
  /// In ms, this message translates to:
  /// **'Kecil'**
  String get hadisFontSmall;

  /// No description provided for @hadisFontMedium.
  ///
  /// In ms, this message translates to:
  /// **'Sederhana'**
  String get hadisFontMedium;

  /// No description provided for @hadisFontLarge.
  ///
  /// In ms, this message translates to:
  /// **'Besar'**
  String get hadisFontLarge;

  /// No description provided for @hadisFontHelp.
  ///
  /// In ms, this message translates to:
  /// **'Teks panjang dikecilkan supaya muat'**
  String get hadisFontHelp;

  /// No description provided for @hadisPreviewTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton'**
  String get hadisPreviewTitle;

  /// No description provided for @hadisPreviewHelp.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton guna hadis pertama hari ini dan tetapan di atas.'**
  String get hadisPreviewHelp;

  /// No description provided for @hadisPreviewSample.
  ///
  /// In ms, this message translates to:
  /// **'Sesungguhnya setiap amalan itu bergantung kepada niat, dan setiap orang hanya mendapat apa yang diniatkannya.'**
  String get hadisPreviewSample;

  /// No description provided for @hadisPreviewSampleSource.
  ///
  /// In ms, this message translates to:
  /// **'Riwayat al-Bukhari dan Muslim'**
  String get hadisPreviewSampleSource;

  /// No description provided for @hadisGradesTitle.
  ///
  /// In ms, this message translates to:
  /// **'Darjat yang dibenarkan di TV'**
  String get hadisGradesTitle;

  /// No description provided for @hadisGradesNote.
  ///
  /// In ms, this message translates to:
  /// **'Darjat dari HadeethEnc ditulis dalam bahasa Arab; MAXCOM menukarnya kepada label BM.'**
  String get hadisGradesNote;

  /// No description provided for @hadisLocked.
  ///
  /// In ms, this message translates to:
  /// **'Dikunci mati'**
  String get hadisLocked;

  /// No description provided for @hadisSettingsSaved.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan hadis disimpan ke MAXCOM. TV dikemas kini dalam beberapa saat.'**
  String get hadisSettingsSaved;

  /// No description provided for @hadisTvTag.
  ///
  /// In ms, this message translates to:
  /// **'HADIS'**
  String get hadisTvTag;

  /// No description provided for @hadisTvPart.
  ///
  /// In ms, this message translates to:
  /// **'Bahagian {i} daripada {n}'**
  String hadisTvPart(int i, int n);

  /// No description provided for @hadisTvCredit.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: HadeethEnc.com'**
  String get hadisTvCredit;

  /// No description provided for @hadisTvCountdown.
  ///
  /// In ms, this message translates to:
  /// **'Asar dalam'**
  String get hadisTvCountdown;

  /// No description provided for @hadisTvPrayerImsak.
  ///
  /// In ms, this message translates to:
  /// **'Imsak'**
  String get hadisTvPrayerImsak;

  /// No description provided for @hadisTvPrayerSubuh.
  ///
  /// In ms, this message translates to:
  /// **'Subuh'**
  String get hadisTvPrayerSubuh;

  /// No description provided for @hadisTvPrayerSyuruk.
  ///
  /// In ms, this message translates to:
  /// **'Syuruk'**
  String get hadisTvPrayerSyuruk;

  /// No description provided for @hadisTvPrayerZohor.
  ///
  /// In ms, this message translates to:
  /// **'Zohor'**
  String get hadisTvPrayerZohor;

  /// No description provided for @hadisTvPrayerAsar.
  ///
  /// In ms, this message translates to:
  /// **'Asar'**
  String get hadisTvPrayerAsar;

  /// No description provided for @hadisTvPrayerMaghrib.
  ///
  /// In ms, this message translates to:
  /// **'Maghrib'**
  String get hadisTvPrayerMaghrib;

  /// No description provided for @hadisTvPrayerIsyak.
  ///
  /// In ms, this message translates to:
  /// **'Isyak'**
  String get hadisTvPrayerIsyak;

  /// No description provided for @locTitle.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi surau'**
  String get locTitle;

  /// No description provided for @locIntroMy.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi menentukan waktu solat kiraan dan zon JAKIM yang dicadangkan. Tiada peta: cari alamat atau taip koordinat.'**
  String get locIntroMy;

  /// No description provided for @locIntro.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi menentukan waktu solat kiraan. Tiada peta: cari alamat atau taip koordinat.'**
  String get locIntro;

  /// No description provided for @locPickerSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari'**
  String get locPickerSearch;

  /// No description provided for @locPickerNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada yang sepadan.'**
  String get locPickerNone;

  /// No description provided for @locCountry.
  ///
  /// In ms, this message translates to:
  /// **'Negara'**
  String get locCountry;

  /// No description provided for @locCountrySearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari negara'**
  String get locCountrySearch;

  /// No description provided for @locCountryOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Sumber rasmi: JAKIM e-Solat'**
  String get locCountryOfficial;

  /// No description provided for @locCountryNoOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Tiada sumber rasmi dalam MAXCOM; kiraan atau fail'**
  String get locCountryNoOfficial;

  /// No description provided for @locZonesCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} zon waktu'**
  String locZonesCount(int n);

  /// No description provided for @locTimezone.
  ///
  /// In ms, this message translates to:
  /// **'Zon waktu'**
  String get locTimezone;

  /// No description provided for @locTimezoneSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari zon waktu'**
  String get locTimezoneSearch;

  /// No description provided for @locTimezoneOwn.
  ///
  /// In ms, this message translates to:
  /// **'Negara ini'**
  String get locTimezoneOwn;

  /// No description provided for @locTimezoneOther.
  ///
  /// In ms, this message translates to:
  /// **'Lain-lain'**
  String get locTimezoneOther;

  /// No description provided for @locTimezoneFromCountry.
  ///
  /// In ms, this message translates to:
  /// **'Ditetapkan dari negara'**
  String get locTimezoneFromCountry;

  /// No description provided for @locZoneRow.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM: {zone}'**
  String locZoneRow(String zone);

  /// No description provided for @locZoneNone.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM belum dipilih'**
  String get locZoneNone;

  /// No description provided for @locChange.
  ///
  /// In ms, this message translates to:
  /// **'Tukar'**
  String get locChange;

  /// No description provided for @locHowTitle.
  ///
  /// In ms, this message translates to:
  /// **'Cara menetapkan lokasi'**
  String get locHowTitle;

  /// No description provided for @locModeSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari alamat'**
  String get locModeSearch;

  /// No description provided for @locModeCoordinates.
  ///
  /// In ms, this message translates to:
  /// **'Taip koordinat'**
  String get locModeCoordinates;

  /// No description provided for @locSearchLabel.
  ///
  /// In ms, this message translates to:
  /// **'Alamat atau bandar'**
  String get locSearchLabel;

  /// No description provided for @locSearchHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Taman Sri Gombak'**
  String get locSearchHint;

  /// No description provided for @locSearchGo.
  ///
  /// In ms, this message translates to:
  /// **'Cari'**
  String get locSearchGo;

  /// No description provided for @locSearchHelp.
  ///
  /// In ms, this message translates to:
  /// **'Carian dihantar sekali bila Cari ditekan. Perlukan internet.'**
  String get locSearchHelp;

  /// No description provided for @locResultsTitle.
  ///
  /// In ms, this message translates to:
  /// **'{n} hasil untuk \"{q}\"'**
  String locResultsTitle(int n, String q);

  /// No description provided for @locNoResults.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hasil. Cuba nama bandar atau taip koordinat.'**
  String get locNoResults;

  /// No description provided for @locAttribution.
  ///
  /// In ms, this message translates to:
  /// **'(c) OpenStreetMap contributors'**
  String get locAttribution;

  /// No description provided for @locOfflineHint.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tiada internet; taip koordinat'**
  String get locOfflineHint;

  /// No description provided for @locCoordinatesHelp.
  ///
  /// In ms, this message translates to:
  /// **'Untuk MAXCOM tanpa internet. Salin koordinat dari aplikasi peta di telefon (tekan lama pada lokasi surau).'**
  String get locCoordinatesHelp;

  /// No description provided for @locConfirmed.
  ///
  /// In ms, this message translates to:
  /// **'Disahkan'**
  String get locConfirmed;

  /// No description provided for @locCoordinates.
  ///
  /// In ms, this message translates to:
  /// **'Koordinat'**
  String get locCoordinates;

  /// No description provided for @locCity.
  ///
  /// In ms, this message translates to:
  /// **'Nama bandar untuk paparan'**
  String get locCity;

  /// No description provided for @locCityHelp.
  ///
  /// In ms, this message translates to:
  /// **'Ditunjuk pada kaki skrin TV bila waktu dikira.'**
  String get locCityHelp;

  /// No description provided for @locLatitude.
  ///
  /// In ms, this message translates to:
  /// **'Latitud'**
  String get locLatitude;

  /// No description provided for @locLatitudeHelp.
  ///
  /// In ms, this message translates to:
  /// **'Utara positif, selatan negatif'**
  String get locLatitudeHelp;

  /// No description provided for @locLatitudeError.
  ///
  /// In ms, this message translates to:
  /// **'Latitud mesti antara -90 dan 90'**
  String get locLatitudeError;

  /// No description provided for @locLongitude.
  ///
  /// In ms, this message translates to:
  /// **'Longitud'**
  String get locLongitude;

  /// No description provided for @locLongitudeHelp.
  ///
  /// In ms, this message translates to:
  /// **'Timur positif, barat negatif'**
  String get locLongitudeHelp;

  /// No description provided for @locLongitudeError.
  ///
  /// In ms, this message translates to:
  /// **'Longitud mesti antara -180 dan 180'**
  String get locLongitudeError;

  /// No description provided for @locSuggestTitle.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM dicadangkan: {code}'**
  String locSuggestTitle(String code);

  /// No description provided for @locSuggestUse.
  ///
  /// In ms, this message translates to:
  /// **'Guna {code}'**
  String locSuggestUse(String code);

  /// No description provided for @locSuggestOther.
  ///
  /// In ms, this message translates to:
  /// **'Pilih zon lain'**
  String get locSuggestOther;

  /// No description provided for @locZoneUsed.
  ///
  /// In ms, this message translates to:
  /// **'Zon {code} digunakan'**
  String locZoneUsed(String code);

  /// No description provided for @locNoOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Tiada sumber rasmi untuk {country} dalam MAXCOM. Waktu solat datang dari Kiraan setempat dan fail import.'**
  String locNoOfficial(String country);

  /// No description provided for @locChangeWarning.
  ///
  /// In ms, this message translates to:
  /// **'Menukar lokasi mengira semula waktu kiraan untuk semua hari. Data rasmi dan fail import tidak berubah.'**
  String get locChangeWarning;

  /// No description provided for @locNeedCoordinates.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi perlukan koordinat kerana waktu solat dikira'**
  String get locNeedCoordinates;

  /// No description provided for @locSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan lokasi'**
  String get locSave;

  /// No description provided for @locSaved.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi disimpan. Waktu kiraan dikira semula di MAXCOM.'**
  String get locSaved;

  /// No description provided for @locNoChange.
  ///
  /// In ms, this message translates to:
  /// **'Tiada perubahan untuk disimpan'**
  String get locNoChange;

  /// No description provided for @zonTitle.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM'**
  String get zonTitle;

  /// No description provided for @zonField.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM'**
  String get zonField;

  /// No description provided for @zonSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari kod, negeri atau daerah'**
  String get zonSearch;

  /// No description provided for @zonHasData.
  ///
  /// In ms, this message translates to:
  /// **'Data ada: {years}'**
  String zonHasData(String years);

  /// No description provided for @zonNoData.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data: akan dimuat turun'**
  String get zonNoData;

  /// No description provided for @zonUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Zon ini tiada dalam senarai'**
  String get zonUnknown;

  /// No description provided for @zonSuggestedGroup.
  ///
  /// In ms, this message translates to:
  /// **'Dicadangkan dari lokasi'**
  String get zonSuggestedGroup;

  /// No description provided for @zonSuggested.
  ///
  /// In ms, this message translates to:
  /// **'Dicadangkan dari lokasi: {code}'**
  String zonSuggested(String code);

  /// No description provided for @zonUse.
  ///
  /// In ms, this message translates to:
  /// **'Guna'**
  String get zonUse;

  /// No description provided for @zonSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan zon'**
  String get zonSave;

  /// No description provided for @zonSaved.
  ///
  /// In ms, this message translates to:
  /// **'Zon {code} disimpan'**
  String zonSaved(String code);

  /// No description provided for @zonWillFetch.
  ///
  /// In ms, this message translates to:
  /// **'Data {code} akan dimuat turun selepas disimpan, jika MAXCOM ini memuat turun sendiri.'**
  String zonWillFetch(String code);

  /// No description provided for @zonMalaysiaOnly.
  ///
  /// In ms, this message translates to:
  /// **'Zon JAKIM hanya untuk surau di Malaysia.'**
  String get zonMalaysiaOnly;

  /// No description provided for @zonPlaceUnnamed.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi surau'**
  String get zonPlaceUnnamed;

  /// No description provided for @zonNoCoordinates.
  ///
  /// In ms, this message translates to:
  /// **'Koordinat belum ditetapkan'**
  String get zonNoCoordinates;

  /// No description provided for @zonListTitle.
  ///
  /// In ms, this message translates to:
  /// **'Senarai zon JAKIM'**
  String get zonListTitle;

  /// No description provided for @zonListCount.
  ///
  /// In ms, this message translates to:
  /// **'{n} zon dari e-Solat. Salinan dalam MAXCOM digunakan bila luar talian.'**
  String zonListCount(int n);

  /// No description provided for @zonListMeta.
  ///
  /// In ms, this message translates to:
  /// **'{n} zon dari e-Solat, dikemas kini {when}. Salinan dalam MAXCOM digunakan bila luar talian.'**
  String zonListMeta(int n, String when);

  /// No description provided for @zonRefresh.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini senarai zon'**
  String get zonRefresh;

  /// No description provided for @zonRefreshed.
  ///
  /// In ms, this message translates to:
  /// **'Senarai zon dikemas kini: {n} zon'**
  String zonRefreshed(int n);

  /// No description provided for @srcTitle.
  ///
  /// In ms, this message translates to:
  /// **'Sumber waktu solat'**
  String get srcTitle;

  /// No description provided for @srcOrderTitle.
  ///
  /// In ms, this message translates to:
  /// **'Susunan sumber'**
  String get srcOrderTitle;

  /// No description provided for @srcMoveUp.
  ///
  /// In ms, this message translates to:
  /// **'Naik'**
  String get srcMoveUp;

  /// No description provided for @srcMoveDown.
  ///
  /// In ms, this message translates to:
  /// **'Turun'**
  String get srcMoveDown;

  /// No description provided for @srcOrderHelpMy.
  ///
  /// In ms, this message translates to:
  /// **'Sumber pertama yang ada data untuk sesuatu hari digunakan. Di Malaysia, biasanya JAKIM didahulukan.'**
  String get srcOrderHelpMy;

  /// No description provided for @srcOrderHelp.
  ///
  /// In ms, this message translates to:
  /// **'Sumber pertama yang ada data untuk sesuatu hari digunakan. Sumber rasmi tidak dipaparkan kerana tiada untuk negara ini.'**
  String get srcOrderHelp;

  /// No description provided for @srcOfficialNotFirst.
  ///
  /// In ms, this message translates to:
  /// **'Data rasmi JAKIM tidak lagi diutamakan'**
  String get srcOfficialNotFirst;

  /// No description provided for @srcOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Sumber rasmi'**
  String get srcOfficial;

  /// No description provided for @srcOfficialDetail.
  ///
  /// In ms, this message translates to:
  /// **'JAKIM e-Solat, zon {zone}'**
  String srcOfficialDetail(String zone);

  /// No description provided for @srcOfficialNone.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada data dimuat turun.'**
  String get srcOfficialNone;

  /// No description provided for @srcOfficialStored.
  ///
  /// In ms, this message translates to:
  /// **'{year} tersimpan.'**
  String srcOfficialStored(String year);

  /// No description provided for @srcOfficialFetched.
  ///
  /// In ms, this message translates to:
  /// **'{year} tersimpan (dimuat turun {when}).'**
  String srcOfficialFetched(String year, String when);

  /// No description provided for @srcCalc.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan setempat'**
  String get srcCalc;

  /// No description provided for @srcCalcShort.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan'**
  String get srcCalcShort;

  /// No description provided for @srcCalcNote.
  ///
  /// In ms, this message translates to:
  /// **'Sentiasa tersedia, dikira di MAXCOM tanpa internet.'**
  String get srcCalcNote;

  /// No description provided for @srcFile.
  ///
  /// In ms, this message translates to:
  /// **'Fail import'**
  String get srcFile;

  /// No description provided for @srcFileDetail.
  ///
  /// In ms, this message translates to:
  /// **'Jadual waktu surau sendiri'**
  String get srcFileDetail;

  /// No description provided for @srcFileDays.
  ///
  /// In ms, this message translates to:
  /// **'{n} hari ke hadapan dari fail.'**
  String srcFileDays(int n);

  /// No description provided for @srcFileNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada import waktu solat.'**
  String get srcFileNone;

  /// No description provided for @srcMethod.
  ///
  /// In ms, this message translates to:
  /// **'Kaedah'**
  String get srcMethod;

  /// No description provided for @srcMethodAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto ikut negara'**
  String get srcMethodAuto;

  /// No description provided for @srcMethodAutoNamed.
  ///
  /// In ms, this message translates to:
  /// **'Auto ({method})'**
  String srcMethodAutoNamed(String method);

  /// No description provided for @srcMadhab.
  ///
  /// In ms, this message translates to:
  /// **'Mazhab untuk Asar'**
  String get srcMadhab;

  /// No description provided for @srcMadhabAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto'**
  String get srcMadhabAuto;

  /// No description provided for @srcMadhabShafi.
  ///
  /// In ms, this message translates to:
  /// **'Syafie'**
  String get srcMadhabShafi;

  /// No description provided for @srcMadhabHanafi.
  ///
  /// In ms, this message translates to:
  /// **'Hanafi'**
  String get srcMadhabHanafi;

  /// No description provided for @srcHigh.
  ///
  /// In ms, this message translates to:
  /// **'Peraturan latitud tinggi'**
  String get srcHigh;

  /// No description provided for @srcHighAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto'**
  String get srcHighAuto;

  /// No description provided for @srcHighMiddle.
  ///
  /// In ms, this message translates to:
  /// **'Tengah malam'**
  String get srcHighMiddle;

  /// No description provided for @srcHighSeventh.
  ///
  /// In ms, this message translates to:
  /// **'Satu pertujuh malam'**
  String get srcHighSeventh;

  /// No description provided for @srcHighTwilight.
  ///
  /// In ms, this message translates to:
  /// **'Sudut senja'**
  String get srcHighTwilight;

  /// No description provided for @srcHighNoEffect.
  ///
  /// In ms, this message translates to:
  /// **'Tiada kesan di bawah latitud 48 darjah'**
  String get srcHighNoEffect;

  /// No description provided for @srcAdjustTitle.
  ///
  /// In ms, this message translates to:
  /// **'Laras minit'**
  String get srcAdjustTitle;

  /// No description provided for @srcAdjustClear.
  ///
  /// In ms, this message translates to:
  /// **'Kosongkan laras'**
  String get srcAdjustClear;

  /// No description provided for @srcImsakMinutes.
  ///
  /// In ms, this message translates to:
  /// **'Imsak, minit sebelum Subuh'**
  String get srcImsakMinutes;

  /// No description provided for @srcMinutes.
  ///
  /// In ms, this message translates to:
  /// **'{n} minit'**
  String srcMinutes(int n);

  /// No description provided for @srcLess.
  ///
  /// In ms, this message translates to:
  /// **'Kurang'**
  String get srcLess;

  /// No description provided for @srcMore.
  ///
  /// In ms, this message translates to:
  /// **'Tambah'**
  String get srcMore;

  /// No description provided for @srcPreviewTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton hari ini, {date}'**
  String srcPreviewTitle(String date);

  /// No description provided for @srcPreviewNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada waktu untuk hari ini. Tetapkan lokasi surau dahulu.'**
  String get srcPreviewNone;

  /// No description provided for @srcPreviewPrayer.
  ///
  /// In ms, this message translates to:
  /// **'Waktu'**
  String get srcPreviewPrayer;

  /// No description provided for @srcPreviewDiff.
  ///
  /// In ms, this message translates to:
  /// **'Beza'**
  String get srcPreviewDiff;

  /// No description provided for @srcPreviewNote.
  ///
  /// In ms, this message translates to:
  /// **'Beza = sumber pertama tolak kiraan, dalam minit, mengikut tetapan yang telah disimpan.'**
  String get srcPreviewNote;

  /// No description provided for @srcCrossTitle.
  ///
  /// In ms, this message translates to:
  /// **'Semak silang'**
  String get srcCrossTitle;

  /// No description provided for @srcCrossToggle.
  ///
  /// In ms, this message translates to:
  /// **'Tanda hari yang berbeza lebih 2 minit'**
  String get srcCrossToggle;

  /// No description provided for @srcCrossHelp.
  ///
  /// In ms, this message translates to:
  /// **'Bandingkan kiraan dengan sumber pertama setiap hari.'**
  String get srcCrossHelp;

  /// No description provided for @srcCrossNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada hari untuk dibandingkan bulan ini.'**
  String get srcCrossNone;

  /// No description provided for @srcCrossFlagged.
  ///
  /// In ms, this message translates to:
  /// **'hari ditanda dalam {month}'**
  String srcCrossFlagged(String month);

  /// No description provided for @srcCrossLargest.
  ///
  /// In ms, this message translates to:
  /// **'Beza terbesar setiap waktu (minit)'**
  String get srcCrossLargest;

  /// No description provided for @srcCrossOk.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan sepadan dalam 2 minit untuk semua hari.'**
  String get srcCrossOk;

  /// No description provided for @srcUseSuggestion.
  ///
  /// In ms, this message translates to:
  /// **'Guna cadangan laras'**
  String get srcUseSuggestion;

  /// No description provided for @srcSuggestionNote.
  ///
  /// In ms, this message translates to:
  /// **'Cadangan ditambah kepada laras yang tersimpan. Belum disimpan sehingga Simpan ditekan.'**
  String get srcSuggestionNote;

  /// No description provided for @srcSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get srcSave;

  /// No description provided for @srcSaved.
  ///
  /// In ms, this message translates to:
  /// **'Sumber waktu solat disimpan.'**
  String get srcSaved;

  /// No description provided for @pdLoadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Data setiap hari tidak dapat dibaca sekarang.'**
  String get pdLoadFailed;

  /// No description provided for @pdSourceOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: JAKIM e-Solat'**
  String get pdSourceOfficial;

  /// No description provided for @pdSourceOfficialOn.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: JAKIM e-Solat, dimuat turun {date}'**
  String pdSourceOfficialOn(String date);

  /// No description provided for @pdSourceFile.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: Fail import'**
  String get pdSourceFile;

  /// No description provided for @pdSourceCalc.
  ///
  /// In ms, this message translates to:
  /// **'Sumber: Kiraan setempat'**
  String get pdSourceCalc;

  /// No description provided for @pdDaysTitle.
  ///
  /// In ms, this message translates to:
  /// **'Waktu setiap hari'**
  String get pdDaysTitle;

  /// No description provided for @pdViewMonth.
  ///
  /// In ms, this message translates to:
  /// **'Bulan'**
  String get pdViewMonth;

  /// No description provided for @pdViewYear.
  ///
  /// In ms, this message translates to:
  /// **'Tahun'**
  String get pdViewYear;

  /// No description provided for @pdFlagged.
  ///
  /// In ms, this message translates to:
  /// **'Semak silang: {n} hari ditanda bulan ini.'**
  String pdFlagged(int n);

  /// No description provided for @pdAdjustLink.
  ///
  /// In ms, this message translates to:
  /// **'Laras kiraan'**
  String get pdAdjustLink;

  /// No description provided for @pdPrevMonth.
  ///
  /// In ms, this message translates to:
  /// **'Bulan sebelum'**
  String get pdPrevMonth;

  /// No description provided for @pdNextMonth.
  ///
  /// In ms, this message translates to:
  /// **'Bulan seterusnya'**
  String get pdNextMonth;

  /// No description provided for @pdMonthEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data untuk bulan ini.'**
  String get pdMonthEmpty;

  /// No description provided for @pdTapHint.
  ///
  /// In ms, this message translates to:
  /// **'Ketik satu hari untuk lihat sumber dan buat pembetulan.'**
  String get pdTapHint;

  /// No description provided for @pdLinkImport.
  ///
  /// In ms, this message translates to:
  /// **'Import fail waktu solat'**
  String get pdLinkImport;

  /// No description provided for @pdLinkRecords.
  ///
  /// In ms, this message translates to:
  /// **'Rekod import'**
  String get pdLinkRecords;

  /// No description provided for @pdGridDay.
  ///
  /// In ms, this message translates to:
  /// **'Hari'**
  String get pdGridDay;

  /// No description provided for @pdLegendOfficial.
  ///
  /// In ms, this message translates to:
  /// **'Rasmi (JAKIM)'**
  String get pdLegendOfficial;

  /// No description provided for @pdLegendCalc.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan setempat'**
  String get pdLegendCalc;

  /// No description provided for @pdLegendFile.
  ///
  /// In ms, this message translates to:
  /// **'Import fail'**
  String get pdLegendFile;

  /// No description provided for @pdLegendCorrection.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan manual'**
  String get pdLegendCorrection;

  /// No description provided for @pdLegendFlag.
  ///
  /// In ms, this message translates to:
  /// **'Beza lebih 2 minit dengan kiraan'**
  String get pdLegendFlag;

  /// No description provided for @pdEmergency.
  ///
  /// In ms, this message translates to:
  /// **'Kiraan sementara'**
  String get pdEmergency;

  /// No description provided for @pdUsed.
  ///
  /// In ms, this message translates to:
  /// **'Dipakai'**
  String get pdUsed;

  /// No description provided for @pdImsakDerived.
  ///
  /// In ms, this message translates to:
  /// **'Imsak dikira daripada Subuh kerana tiada dalam fail.'**
  String get pdImsakDerived;

  /// No description provided for @pdOverrideKhutbah.
  ///
  /// In ms, this message translates to:
  /// **'Khutbah Jumaat'**
  String get pdOverrideKhutbah;

  /// No description provided for @pdOverrideIqamah.
  ///
  /// In ms, this message translates to:
  /// **'Iqamah {prayer}'**
  String pdOverrideIqamah(String prayer);

  /// No description provided for @pdCorrectionTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan untuk satu waktu'**
  String get pdCorrectionTitle;

  /// No description provided for @pdCorrectionTime.
  ///
  /// In ms, this message translates to:
  /// **'Waktu (24 jam)'**
  String get pdCorrectionTime;

  /// No description provided for @pdCorrectionReason.
  ///
  /// In ms, this message translates to:
  /// **'Sebab pembetulan'**
  String get pdCorrectionReason;

  /// No description provided for @pdCorrectionReasonHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: notis pindaan JAKIM'**
  String get pdCorrectionReasonHint;

  /// No description provided for @pdCorrectionSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan pembetulan'**
  String get pdCorrectionSave;

  /// No description provided for @pdCorrectionRemove.
  ///
  /// In ms, this message translates to:
  /// **'Buang pembetulan'**
  String get pdCorrectionRemove;

  /// No description provided for @pdOfficialChanged.
  ///
  /// In ms, this message translates to:
  /// **'Nilai rasmi berubah sejak pembetulan ini dibuat. Pembetulan anda masih digunakan.'**
  String get pdOfficialChanged;

  /// No description provided for @pdCorrectionIgnored.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan untuk waktu ini tidak digunakan kerana ia menjadikan susunan waktu hari ini tidak betul. Semak pembetulan ini atau buangnya.'**
  String get pdCorrectionIgnored;

  /// No description provided for @impFileUnused.
  ///
  /// In ms, this message translates to:
  /// **'Jadual ini tidak akan digunakan selagi Kiraan setempat berada di atas Fail dalam Sumber waktu solat.'**
  String get impFileUnused;

  /// No description provided for @pdTimeInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Waktu mesti dalam format 24 jam, contoh 13:05'**
  String get pdTimeInvalid;

  /// No description provided for @pdReasonNeeded.
  ///
  /// In ms, this message translates to:
  /// **'Sebab perlu sekurang-kurangnya 3 aksara'**
  String get pdReasonNeeded;

  /// No description provided for @impTitle.
  ///
  /// In ms, this message translates to:
  /// **'Import waktu solat'**
  String get impTitle;

  /// No description provided for @impTargetLabel.
  ///
  /// In ms, this message translates to:
  /// **'SASARAN IMPORT'**
  String get impTargetLabel;

  /// No description provided for @impTargetZone.
  ///
  /// In ms, this message translates to:
  /// **'zon {zone}'**
  String impTargetZone(String zone);

  /// No description provided for @impStepPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail'**
  String get impStepPick;

  /// No description provided for @impStepCheck.
  ///
  /// In ms, this message translates to:
  /// **'Semakan'**
  String get impStepCheck;

  /// No description provided for @impStepConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Sahkan'**
  String get impStepConfirm;

  /// No description provided for @impTemplateTitle.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun templat'**
  String get impTemplateTitle;

  /// No description provided for @impTemplateHelp.
  ///
  /// In ms, this message translates to:
  /// **'Diisi dengan nama surau dan setiap tarikh tahun itu. Waktu dalam format 24 jam.'**
  String get impTemplateHelp;

  /// No description provided for @impTemplateCsv.
  ///
  /// In ms, this message translates to:
  /// **'CSV'**
  String get impTemplateCsv;

  /// No description provided for @impTemplateExcel.
  ///
  /// In ms, this message translates to:
  /// **'Excel'**
  String get impTemplateExcel;

  /// No description provided for @impTemplateCopied.
  ///
  /// In ms, this message translates to:
  /// **'Templat CSV disalin. Tampal ke dalam fail baharu.'**
  String get impTemplateCopied;

  /// No description provided for @impTemplateExcelNone.
  ///
  /// In ms, this message translates to:
  /// **'Templat Excel belum boleh dimuat turun di peranti ini. Guna templat CSV.'**
  String get impTemplateExcelNone;

  /// No description provided for @impColumnsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Lajur templat'**
  String get impColumnsTitle;

  /// No description provided for @impColumnsList.
  ///
  /// In ms, this message translates to:
  /// **'date, imsak, subuh, syuruk, dhuha, zohor, asar, maghrib, isyak, note. Masjid sahaja: jumaat_khutbah, iqamah_subuh, iqamah_zohor, iqamah_asar, iqamah_maghrib, iqamah_isyak.'**
  String get impColumnsList;

  /// No description provided for @impPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail'**
  String get impPick;

  /// No description provided for @impPickOther.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail lain'**
  String get impPickOther;

  /// No description provided for @impPickHelp.
  ///
  /// In ms, this message translates to:
  /// **'CSV had 1 MB atau Excel (.xlsx) had 2 MB. Juga fail tahunan e-Solat JAKIM.'**
  String get impPickHelp;

  /// No description provided for @impTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Fail terlalu besar. Had CSV 1 MB, Excel 2 MB.'**
  String get impTooBig;

  /// No description provided for @impWrongType.
  ///
  /// In ms, this message translates to:
  /// **'Hanya fail CSV atau Excel (.xlsx) diterima.'**
  String get impWrongType;

  /// No description provided for @impUnreadable.
  ///
  /// In ms, this message translates to:
  /// **'Fail tidak dapat dibaca.'**
  String get impUnreadable;

  /// No description provided for @impSheet.
  ///
  /// In ms, this message translates to:
  /// **'Helaian'**
  String get impSheet;

  /// No description provided for @impEsolatDetected.
  ///
  /// In ms, this message translates to:
  /// **'Fail e-Solat: disimpan sebagai Sumber rasmi zon {zone}'**
  String impEsolatDetected(String zone);

  /// No description provided for @impErrors.
  ///
  /// In ms, this message translates to:
  /// **'{n} ralat. Tiada apa-apa disimpan.'**
  String impErrors(int n);

  /// No description provided for @impErrorsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Ralat'**
  String get impErrorsTitle;

  /// No description provided for @impRow.
  ///
  /// In ms, this message translates to:
  /// **'Baris {n}'**
  String impRow(int n);

  /// No description provided for @impClean.
  ///
  /// In ms, this message translates to:
  /// **'Tiada ralat. {n} hari, {from} hingga {to}. Belum disimpan.'**
  String impClean(int n, String from, String to);

  /// No description provided for @impDetectedColumns.
  ///
  /// In ms, this message translates to:
  /// **'Lajur dikenali'**
  String get impDetectedColumns;

  /// No description provided for @impPerMonth.
  ///
  /// In ms, this message translates to:
  /// **'Bilangan hari setiap bulan'**
  String get impPerMonth;

  /// No description provided for @impFirstWeek.
  ///
  /// In ms, this message translates to:
  /// **'Minggu pertama'**
  String get impFirstWeek;

  /// No description provided for @impLastWeek.
  ///
  /// In ms, this message translates to:
  /// **'Minggu terakhir'**
  String get impLastWeek;

  /// No description provided for @impOverlapTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hari bertindih'**
  String get impOverlapTitle;

  /// No description provided for @impOverlapCounts.
  ///
  /// In ms, this message translates to:
  /// **'Sudah ada: {official} hari rasmi, {file} hari dari fail, {calc} hari dikira.'**
  String impOverlapCounts(int official, int file, int calc);

  /// No description provided for @impOverlapReplace.
  ///
  /// In ms, this message translates to:
  /// **'Ganti'**
  String get impOverlapReplace;

  /// No description provided for @impOverlapReplaceNote.
  ///
  /// In ms, this message translates to:
  /// **'Fail baharu ganti hari yang sudah ada dari fail lama.'**
  String get impOverlapReplaceNote;

  /// No description provided for @impOverlapKeep.
  ///
  /// In ms, this message translates to:
  /// **'Simpan yang sedia ada'**
  String get impOverlapKeep;

  /// No description provided for @impOverlapKeepNote.
  ///
  /// In ms, this message translates to:
  /// **'Hari dari fail lama kekal; hanya tarikh baharu ditambah.'**
  String get impOverlapKeepNote;

  /// No description provided for @impOverlapFill.
  ///
  /// In ms, this message translates to:
  /// **'Isi hari kosong sahaja'**
  String get impOverlapFill;

  /// No description provided for @impOverlapFillNote.
  ///
  /// In ms, this message translates to:
  /// **'Hanya hari tanpa data rasmi atau fail.'**
  String get impOverlapFillNote;

  /// No description provided for @impWouldWrite.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan: {total} hari. Ditambah {inserted}, diganti {replaced}, dilangkau {skipped}.'**
  String impWouldWrite(int total, int inserted, int replaced, int skipped);

  /// No description provided for @impSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get impSave;

  /// No description provided for @impConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Simpan {n} hari ke {target}?'**
  String impConfirmTitle(int n, String target);

  /// No description provided for @impConfirmBody.
  ///
  /// In ms, this message translates to:
  /// **'Ditambah {inserted} hari, diganti {replaced} hari. Satu rekod import dicipta dan boleh dibatalkan kemudian.'**
  String impConfirmBody(int inserted, int replaced);

  /// No description provided for @impConfirmOfficialTitle.
  ///
  /// In ms, this message translates to:
  /// **'Simpan sebagai Sumber rasmi zon {zone}?'**
  String impConfirmOfficialTitle(String zone);

  /// No description provided for @impConfirmOfficialBody.
  ///
  /// In ms, this message translates to:
  /// **'Hari yang sudah ada untuk zon ini akan diganti.'**
  String get impConfirmOfficialBody;

  /// No description provided for @impDone.
  ///
  /// In ms, this message translates to:
  /// **'Import disimpan'**
  String get impDone;

  /// No description provided for @impDoneDetail.
  ///
  /// In ms, this message translates to:
  /// **'Ditambah {inserted}, diganti {replaced}, dilangkau {skipped}'**
  String impDoneDetail(int inserted, int replaced, int skipped);

  /// No description provided for @impOfficialDone.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan sebagai Sumber rasmi zon {zone}'**
  String impOfficialDone(String zone);

  /// No description provided for @impGoRecords.
  ///
  /// In ms, this message translates to:
  /// **'Lihat Rekod import'**
  String get impGoRecords;

  /// No description provided for @impMysoTitle.
  ///
  /// In ms, this message translates to:
  /// **'Import data paparan lama'**
  String get impMysoTitle;

  /// No description provided for @impMysoIntro.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik fail zip eksport dari sistem paparan lama surau ini. Kandungan dan tetapan pemasa digabung; waktu solat tidak termasuk.'**
  String get impMysoIntro;

  /// No description provided for @impMysoPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail zip'**
  String get impMysoPick;

  /// No description provided for @impMysoPickHelp.
  ///
  /// In ms, this message translates to:
  /// **'Dibuat dengan skrip eksport MAXCOM. Had 64 MB.'**
  String get impMysoPickHelp;

  /// No description provided for @impMysoTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Fail terlalu besar. Had ialah 64 MB.'**
  String get impMysoTooBig;

  /// No description provided for @impMysoWorking.
  ///
  /// In ms, this message translates to:
  /// **'Sedang memuat naik dan menyemak'**
  String get impMysoWorking;

  /// No description provided for @impMysoMismatchTitle.
  ///
  /// In ms, this message translates to:
  /// **'Nama surau berbeza'**
  String get impMysoMismatchTitle;

  /// No description provided for @impMysoMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Fail ini daripada \"{file}\"; import ke \"{target}\"?'**
  String impMysoMismatch(String file, String target);

  /// No description provided for @impMysoMismatchYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya, import ke surau ini'**
  String get impMysoMismatchYes;

  /// No description provided for @impMysoNameInFile.
  ///
  /// In ms, this message translates to:
  /// **'Nama dalam fail: {name}'**
  String impMysoNameInFile(String name);

  /// No description provided for @impMysoTarget.
  ///
  /// In ms, this message translates to:
  /// **'Sasaran: {name}'**
  String impMysoTarget(String name);

  /// No description provided for @impMysoPlanTitle.
  ///
  /// In ms, this message translates to:
  /// **'Larian percubaan'**
  String get impMysoPlanTitle;

  /// No description provided for @impMysoKind.
  ///
  /// In ms, this message translates to:
  /// **'Jenis'**
  String get impMysoKind;

  /// No description provided for @impMysoCreated.
  ///
  /// In ms, this message translates to:
  /// **'Baharu'**
  String get impMysoCreated;

  /// No description provided for @impMysoUpdated.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini'**
  String get impMysoUpdated;

  /// No description provided for @impMysoSame.
  ///
  /// In ms, this message translates to:
  /// **'Sama'**
  String get impMysoSame;

  /// No description provided for @impMysoSkipped.
  ///
  /// In ms, this message translates to:
  /// **'Langkau'**
  String get impMysoSkipped;

  /// No description provided for @impMysoTimers.
  ///
  /// In ms, this message translates to:
  /// **'Guna tetapan pemasa dari sistem lama'**
  String get impMysoTimers;

  /// No description provided for @impMysoImport.
  ///
  /// In ms, this message translates to:
  /// **'Import'**
  String get impMysoImport;

  /// No description provided for @impMysoDiscard.
  ///
  /// In ms, this message translates to:
  /// **'Buang'**
  String get impMysoDiscard;

  /// No description provided for @impMysoDone.
  ///
  /// In ms, this message translates to:
  /// **'Import data paparan lama selesai'**
  String get impMysoDone;

  /// No description provided for @rekTitle.
  ///
  /// In ms, this message translates to:
  /// **'Rekod import'**
  String get rekTitle;

  /// No description provided for @rekIntro.
  ///
  /// In ms, this message translates to:
  /// **'Setiap import untuk surau ini sahaja. Muat turun JAKIM tidak disenaraikan di sini; lihat Data waktu solat.'**
  String get rekIntro;

  /// No description provided for @rekNone.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada import waktu solat.'**
  String get rekNone;

  /// No description provided for @rekStateActive.
  ///
  /// In ms, this message translates to:
  /// **'Aktif'**
  String get rekStateActive;

  /// No description provided for @rekStateUndone.
  ///
  /// In ms, this message translates to:
  /// **'Dibatalkan {date}'**
  String rekStateUndone(String date);

  /// No description provided for @rekSha.
  ///
  /// In ms, this message translates to:
  /// **'sha256'**
  String get rekSha;

  /// No description provided for @rekRows.
  ///
  /// In ms, this message translates to:
  /// **'Baris'**
  String get rekRows;

  /// No description provided for @rekRange.
  ///
  /// In ms, this message translates to:
  /// **'Julat'**
  String get rekRange;

  /// No description provided for @rekRangeValue.
  ///
  /// In ms, this message translates to:
  /// **'{from} hingga {to}'**
  String rekRangeValue(String from, String to);

  /// No description provided for @rekOverlap.
  ///
  /// In ms, this message translates to:
  /// **'Pertindihan'**
  String get rekOverlap;

  /// No description provided for @rekWho.
  ///
  /// In ms, this message translates to:
  /// **'Oleh'**
  String get rekWho;

  /// No description provided for @rekWhen.
  ///
  /// In ms, this message translates to:
  /// **'Bila'**
  String get rekWhen;

  /// No description provided for @rekUndo.
  ///
  /// In ms, this message translates to:
  /// **'Batalkan import'**
  String get rekUndo;

  /// No description provided for @rekUndoTitle.
  ///
  /// In ms, this message translates to:
  /// **'Batalkan import?'**
  String get rekUndoTitle;

  /// No description provided for @rekUndoBody.
  ///
  /// In ms, this message translates to:
  /// **'{inserted} hari dibuang, {replaced} hari dipulihkan kepada data sebelum import ini.'**
  String rekUndoBody(int inserted, int replaced);

  /// No description provided for @rekUndone.
  ///
  /// In ms, this message translates to:
  /// **'Import dibatalkan. {n} hari dipulihkan.'**
  String rekUndone(int n);

  /// No description provided for @rekBlockedTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh dibatalkan lagi'**
  String get rekBlockedTitle;

  /// No description provided for @rekBlockedOk.
  ///
  /// In ms, this message translates to:
  /// **'Faham'**
  String get rekBlockedOk;

  /// No description provided for @finrClose.
  ///
  /// In ms, this message translates to:
  /// **'Tutup'**
  String get finrClose;

  /// No description provided for @finrReportTitle.
  ///
  /// In ms, this message translates to:
  /// **'Laporan bulanan'**
  String get finrReportTitle;

  /// No description provided for @finrMonthThis.
  ///
  /// In ms, this message translates to:
  /// **'Bulan ini'**
  String get finrMonthThis;

  /// No description provided for @finrMonthLast.
  ///
  /// In ms, this message translates to:
  /// **'Bulan lepas'**
  String get finrMonthLast;

  /// No description provided for @finrMonthPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih bulan...'**
  String get finrMonthPick;

  /// No description provided for @finrNoMonths.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada bulan dengan catatan'**
  String get finrNoMonths;

  /// No description provided for @finrStatusReady.
  ///
  /// In ms, this message translates to:
  /// **'Draf sedia untuk mesyuarat AJK'**
  String get finrStatusReady;

  /// No description provided for @finrStatusReadySub.
  ///
  /// In ms, this message translates to:
  /// **'Semua catatan bulan ini sudah diselaraskan.'**
  String get finrStatusReadySub;

  /// No description provided for @finrStatusReadyPending.
  ///
  /// In ms, this message translates to:
  /// **'Ada catatan di peranti ini yang belum diselaraskan.'**
  String get finrStatusReadyPending;

  /// No description provided for @finrStatusOpenMonth.
  ///
  /// In ms, this message translates to:
  /// **'Bulan belum tamat'**
  String get finrStatusOpenMonth;

  /// No description provided for @finrStatusOpenMonthSub.
  ///
  /// In ms, this message translates to:
  /// **'Laporan ini draf setakat {date}.'**
  String finrStatusOpenMonthSub(String date);

  /// No description provided for @finrStatusClosed.
  ///
  /// In ms, this message translates to:
  /// **'Muktamad'**
  String get finrStatusClosed;

  /// No description provided for @finrStatusClosedSub.
  ///
  /// In ms, this message translates to:
  /// **'Ditutup pada {date}. Angka dibekukan.'**
  String finrStatusClosedSub(String date);

  /// No description provided for @finrPillDraft.
  ///
  /// In ms, this message translates to:
  /// **'Draf'**
  String get finrPillDraft;

  /// No description provided for @finrPillFinal.
  ///
  /// In ms, this message translates to:
  /// **'Muktamad'**
  String get finrPillFinal;

  /// No description provided for @finrPendingNote.
  ///
  /// In ms, this message translates to:
  /// **'{n} catatan di peranti ini belum diselaraskan. Skrin ini menunjukkannya, tetapi PDF hanya mengandungi catatan yang sudah sampai ke MAXCOM.'**
  String finrPendingNote(int n);

  /// No description provided for @finrFullPage.
  ///
  /// In ms, this message translates to:
  /// **'Halaman A4 penuh'**
  String get finrFullPage;

  /// No description provided for @finrDownloadPdf.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun PDF'**
  String get finrDownloadPdf;

  /// No description provided for @finrDownloaded.
  ///
  /// In ms, this message translates to:
  /// **'PDF disimpan dalam Muat turun.'**
  String get finrDownloaded;

  /// No description provided for @finrShare.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi'**
  String get finrShare;

  /// No description provided for @finrPrint.
  ///
  /// In ms, this message translates to:
  /// **'Cetak'**
  String get finrPrint;

  /// No description provided for @finrShareNoteFailed.
  ///
  /// In ms, this message translates to:
  /// **'Perkongsian tidak dapat direkodkan dalam sejarah audit.'**
  String get finrShareNoteFailed;

  /// No description provided for @finrLiveOnlyAction.
  ///
  /// In ms, this message translates to:
  /// **'muat turun atau kongsi laporan PDF'**
  String get finrLiveOnlyAction;

  /// No description provided for @finrCloseMonth.
  ///
  /// In ms, this message translates to:
  /// **'Tutup bulan (Muktamad)'**
  String get finrCloseMonth;

  /// No description provided for @finrCloseTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tutup {month}?'**
  String finrCloseTitle(String month);

  /// No description provided for @finrCloseBody.
  ///
  /// In ms, this message translates to:
  /// **'Selepas Muktamad, laporan dibekukan dan catatan bertarikh dalam bulan itu tidak boleh dimasukkan lagi. Pentadbir boleh membukanya semula, dan itu direkodkan dalam sejarah audit.'**
  String get finrCloseBody;

  /// No description provided for @finrCloseOrder.
  ///
  /// In ms, this message translates to:
  /// **'Tutup {month} dahulu.'**
  String finrCloseOrder(String month);

  /// No description provided for @finrClosedDone.
  ///
  /// In ms, this message translates to:
  /// **'Bulan ditutup. Laporan dibekukan.'**
  String get finrClosedDone;

  /// No description provided for @finrReopenMonth.
  ///
  /// In ms, this message translates to:
  /// **'Buka semula bulan'**
  String get finrReopenMonth;

  /// No description provided for @finrReopenTitle.
  ///
  /// In ms, this message translates to:
  /// **'Buka semula {month}?'**
  String finrReopenTitle(String month);

  /// No description provided for @finrReopenBody.
  ///
  /// In ms, this message translates to:
  /// **'Laporan yang dibekukan dibuang dan catatan baharu boleh dimasukkan semula. Tindakan ini direkodkan dalam sejarah audit.'**
  String get finrReopenBody;

  /// No description provided for @finrReopenDone.
  ///
  /// In ms, this message translates to:
  /// **'Bulan dibuka semula.'**
  String get finrReopenDone;

  /// No description provided for @finrShareTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi laporan'**
  String get finrShareTitle;

  /// No description provided for @finrShareWarning.
  ///
  /// In ms, this message translates to:
  /// **'Laporan ini mengandungi data kewangan surau dan nama penderma. Kongsi hanya kepada AJK. Perkongsian direkodkan dalam sejarah audit.'**
  String get finrShareWarning;

  /// No description provided for @finrShareGo.
  ///
  /// In ms, this message translates to:
  /// **'Pilih aplikasi'**
  String get finrShareGo;

  /// No description provided for @finrAuditTitle.
  ///
  /// In ms, this message translates to:
  /// **'Sejarah audit kewangan'**
  String get finrAuditTitle;

  /// No description provided for @finrAuditIntro.
  ///
  /// In ms, this message translates to:
  /// **'Setiap tindakan kewangan: siapa, peranti mana, bila dimasukkan dan bila diselaraskan. Tidak boleh diubah.'**
  String get finrAuditIntro;

  /// No description provided for @finrAuditEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada tindakan kewangan direkodkan.'**
  String get finrAuditEmpty;

  /// No description provided for @finrAuditStale.
  ///
  /// In ms, this message translates to:
  /// **'Dipaparkan dari salinan terakhir yang dibaca.'**
  String get finrAuditStale;

  /// No description provided for @finrFilterAll.
  ///
  /// In ms, this message translates to:
  /// **'Semua'**
  String get finrFilterAll;

  /// No description provided for @finrFilterIn.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan'**
  String get finrFilterIn;

  /// No description provided for @finrFilterOut.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran'**
  String get finrFilterOut;

  /// No description provided for @finrFilterCor.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan'**
  String get finrFilterCor;

  /// No description provided for @finrFilterSet.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan'**
  String get finrFilterSet;

  /// No description provided for @finrFilterReport.
  ///
  /// In ms, this message translates to:
  /// **'Laporan'**
  String get finrFilterReport;

  /// No description provided for @finrFilterRefused.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak'**
  String get finrFilterRefused;

  /// No description provided for @finrAuditIn.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan {ref}, {fund}'**
  String finrAuditIn(String ref, String fund);

  /// No description provided for @finrAuditOut.
  ///
  /// In ms, this message translates to:
  /// **'Bayaran {ref}, {fund}'**
  String finrAuditOut(String ref, String fund);

  /// No description provided for @finrAuditCor.
  ///
  /// In ms, this message translates to:
  /// **'Pembetulan {ref}, {fund}'**
  String finrAuditCor(String ref, String fund);

  /// No description provided for @finrAuditOpening.
  ///
  /// In ms, this message translates to:
  /// **'Baki pembukaan, {fund}'**
  String finrAuditOpening(String fund);

  /// No description provided for @finrAuditFund.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan tabung: {name}'**
  String finrAuditFund(String name);

  /// No description provided for @finrAuditPerihal.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan perihal: {name}'**
  String finrAuditPerihal(String name);

  /// No description provided for @finrAuditMonthClosed.
  ///
  /// In ms, this message translates to:
  /// **'{month} dimuktamadkan'**
  String finrAuditMonthClosed(String month);

  /// No description provided for @finrAuditMonthOpened.
  ///
  /// In ms, this message translates to:
  /// **'{month} dibuka semula'**
  String finrAuditMonthOpened(String month);

  /// No description provided for @finrAuditReportDownloaded.
  ///
  /// In ms, this message translates to:
  /// **'Laporan {month} dimuat turun (PDF)'**
  String finrAuditReportDownloaded(String month);

  /// No description provided for @finrAuditReportShared.
  ///
  /// In ms, this message translates to:
  /// **'Laporan {month} dikongsi'**
  String finrAuditReportShared(String month);

  /// No description provided for @finrAuditRefused.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: {reason}'**
  String finrAuditRefused(String reason);

  /// No description provided for @finrRefusedRevoked.
  ///
  /// In ms, this message translates to:
  /// **'Peranti dibatalkan'**
  String get finrRefusedRevoked;

  /// No description provided for @finrRefusedMonthClosed.
  ///
  /// In ms, this message translates to:
  /// **'Bulan itu sudah Muktamad'**
  String get finrRefusedMonthClosed;

  /// No description provided for @finrRefusedFundArchived.
  ///
  /// In ms, this message translates to:
  /// **'Tabung itu sudah diarkibkan'**
  String get finrRefusedFundArchived;

  /// No description provided for @finrRefusedOther.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak oleh MAXCOM'**
  String get finrRefusedOther;

  /// No description provided for @finrColAction.
  ///
  /// In ms, this message translates to:
  /// **'Tindakan'**
  String get finrColAction;

  /// No description provided for @finrColWho.
  ///
  /// In ms, this message translates to:
  /// **'Siapa'**
  String get finrColWho;

  /// No description provided for @finrColDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti'**
  String get finrColDevice;

  /// No description provided for @finrColSignature.
  ///
  /// In ms, this message translates to:
  /// **'Tandatangan peranti'**
  String get finrColSignature;

  /// No description provided for @finrColEntered.
  ///
  /// In ms, this message translates to:
  /// **'Dimasukkan'**
  String get finrColEntered;

  /// No description provided for @finrColReceived.
  ///
  /// In ms, this message translates to:
  /// **'Diterima di MAXCOM'**
  String get finrColReceived;

  /// No description provided for @finrColCloud.
  ///
  /// In ms, this message translates to:
  /// **'Sampai ke awan'**
  String get finrColCloud;

  /// No description provided for @finrSigOk.
  ///
  /// In ms, this message translates to:
  /// **'Sah'**
  String get finrSigOk;

  /// No description provided for @finrNotYet.
  ///
  /// In ms, this message translates to:
  /// **'Belum diketahui'**
  String get finrNotYet;

  /// No description provided for @finrNoDevice.
  ///
  /// In ms, this message translates to:
  /// **'Tidak diketahui'**
  String get finrNoDevice;

  /// No description provided for @finrDetailReason.
  ///
  /// In ms, this message translates to:
  /// **'Sebab: {reason}'**
  String finrDetailReason(String reason);

  /// No description provided for @finrFundsTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan tabung'**
  String get finrFundsTitle;

  /// No description provided for @finrFundsIntro.
  ///
  /// In ms, this message translates to:
  /// **'Hanya Pentadbir. Tabung tidak boleh dipadam; tabung yang tidak digunakan lagi diarkibkan.'**
  String get finrFundsIntro;

  /// No description provided for @finrFundsSection.
  ///
  /// In ms, this message translates to:
  /// **'Tabung'**
  String get finrFundsSection;

  /// No description provided for @finrBalance.
  ///
  /// In ms, this message translates to:
  /// **'Baki {amount}'**
  String finrBalance(String amount);

  /// No description provided for @finrTarget.
  ///
  /// In ms, this message translates to:
  /// **'sasaran {amount}'**
  String finrTarget(String amount);

  /// No description provided for @finrOnTv.
  ///
  /// In ms, this message translates to:
  /// **'Skrin TV'**
  String get finrOnTv;

  /// No description provided for @finrRename.
  ///
  /// In ms, this message translates to:
  /// **'Namakan semula'**
  String get finrRename;

  /// No description provided for @finrArchive.
  ///
  /// In ms, this message translates to:
  /// **'Arkibkan'**
  String get finrArchive;

  /// No description provided for @finrArchiveNeedsZero.
  ///
  /// In ms, this message translates to:
  /// **'Baki mesti RM 0.00'**
  String get finrArchiveNeedsZero;

  /// No description provided for @finrArchiveTitle.
  ///
  /// In ms, this message translates to:
  /// **'Arkibkan {name}?'**
  String finrArchiveTitle(String name);

  /// No description provided for @finrArchiveBody.
  ///
  /// In ms, this message translates to:
  /// **'Tabung ini disembunyikan daripada pilihan baharu. Sejarah dan laporan lama kekal, dan tabung boleh dipulihkan.'**
  String get finrArchiveBody;

  /// No description provided for @finrArchivedOn.
  ///
  /// In ms, this message translates to:
  /// **'Diarkibkan {date}, baki RM 0.00'**
  String finrArchivedOn(String date);

  /// No description provided for @finrRestore.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan'**
  String get finrRestore;

  /// No description provided for @finrAddFund.
  ///
  /// In ms, this message translates to:
  /// **'Tambah tabung'**
  String get finrAddFund;

  /// No description provided for @finrAddFundHelp.
  ///
  /// In ms, this message translates to:
  /// **'Tabung baharu bermula dengan baki RM 0.00.'**
  String get finrAddFundHelp;

  /// No description provided for @finrRenameFund.
  ///
  /// In ms, this message translates to:
  /// **'Namakan semula tabung'**
  String get finrRenameFund;

  /// No description provided for @finrRenameFundHelp.
  ///
  /// In ms, this message translates to:
  /// **'Nama baharu dipakai mulai hari ini. Sejarah dan laporan lama kekal.'**
  String get finrRenameFundHelp;

  /// No description provided for @finrFundName.
  ///
  /// In ms, this message translates to:
  /// **'Nama tabung'**
  String get finrFundName;

  /// No description provided for @finrFundNameInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Nama mesti 1 hingga 60 aksara'**
  String get finrFundNameInvalid;

  /// No description provided for @finrFundNameTaken.
  ///
  /// In ms, this message translates to:
  /// **'Nama tabung itu sudah digunakan'**
  String get finrFundNameTaken;

  /// No description provided for @finrFundPublic.
  ///
  /// In ms, this message translates to:
  /// **'Papar di skrin TV'**
  String get finrFundPublic;

  /// No description provided for @finrFundTarget.
  ///
  /// In ms, this message translates to:
  /// **'Sasaran (pilihan)'**
  String get finrFundTarget;

  /// No description provided for @finrAmountInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Jumlah tidak sah. Contoh: 1,356.80'**
  String get finrAmountInvalid;

  /// No description provided for @finrCardSection.
  ///
  /// In ms, this message translates to:
  /// **'Kad tabung di skrin TV'**
  String get finrCardSection;

  /// No description provided for @finrCardFigure.
  ///
  /// In ms, this message translates to:
  /// **'Angka dipaparkan'**
  String get finrCardFigure;

  /// No description provided for @finrFigBalance.
  ///
  /// In ms, this message translates to:
  /// **'Baki semasa'**
  String get finrFigBalance;

  /// No description provided for @finrFigMonth.
  ///
  /// In ms, this message translates to:
  /// **'Kutipan bulan ini'**
  String get finrFigMonth;

  /// No description provided for @finrFigLast.
  ///
  /// In ms, this message translates to:
  /// **'Catatan terakhir'**
  String get finrFigLast;

  /// No description provided for @finrCardHighlight.
  ///
  /// In ms, this message translates to:
  /// **'Sorotan catatan baharu: {seconds} saat'**
  String finrCardHighlight(int seconds);

  /// No description provided for @finrCardShowTarget.
  ///
  /// In ms, this message translates to:
  /// **'Tunjuk bar sasaran'**
  String get finrCardShowTarget;

  /// No description provided for @finrCardQr.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR DuitNow'**
  String get finrCardQr;

  /// No description provided for @finrPerihalSection.
  ///
  /// In ms, this message translates to:
  /// **'Perihal'**
  String get finrPerihalSection;

  /// No description provided for @finrPerihalIn.
  ///
  /// In ms, this message translates to:
  /// **'Perihal kutipan'**
  String get finrPerihalIn;

  /// No description provided for @finrPerihalOut.
  ///
  /// In ms, this message translates to:
  /// **'Perihal bayaran'**
  String get finrPerihalOut;

  /// No description provided for @finrPerihalSystemNote.
  ///
  /// In ms, this message translates to:
  /// **'Perihal bertanda kunci ialah milik sistem dan tidak boleh diubah.'**
  String get finrPerihalSystemNote;

  /// No description provided for @finrAddPerihal.
  ///
  /// In ms, this message translates to:
  /// **'Tambah perihal'**
  String get finrAddPerihal;

  /// No description provided for @finrRenamePerihal.
  ///
  /// In ms, this message translates to:
  /// **'Ubah perihal'**
  String get finrRenamePerihal;

  /// No description provided for @finrPerihalLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama perihal'**
  String get finrPerihalLabel;

  /// No description provided for @finrPerihalNameTaken.
  ///
  /// In ms, this message translates to:
  /// **'Nama perihal itu sudah digunakan'**
  String get finrPerihalNameTaken;

  /// No description provided for @finrModuleSection.
  ///
  /// In ms, this message translates to:
  /// **'Modul'**
  String get finrModuleSection;

  /// No description provided for @finrModuleTitle.
  ///
  /// In ms, this message translates to:
  /// **'Kewangan'**
  String get finrModuleTitle;

  /// No description provided for @finrModuleHelp.
  ///
  /// In ms, this message translates to:
  /// **'Mematikan menyembunyikan menu Kewangan. Data tidak dipadam.'**
  String get finrModuleHelp;

  /// No description provided for @finrModuleOffTitle.
  ///
  /// In ms, this message translates to:
  /// **'Matikan Kewangan?'**
  String get finrModuleOffTitle;

  /// No description provided for @finrModuleOffBody.
  ///
  /// In ms, this message translates to:
  /// **'Menu Kewangan disembunyikan untuk semua peranan. Data kewangan lama disimpan, tidak dipadam.'**
  String get finrModuleOffBody;

  /// No description provided for @finrOpeningTitle.
  ///
  /// In ms, this message translates to:
  /// **'Baki pembukaan'**
  String get finrOpeningTitle;

  /// No description provided for @finrOpeningNone.
  ///
  /// In ms, this message translates to:
  /// **'Belum dimasukkan'**
  String get finrOpeningNone;

  /// No description provided for @finrOpeningDone.
  ///
  /// In ms, this message translates to:
  /// **'Dimasukkan {date}, {n} tabung'**
  String finrOpeningDone(String date, int n);

  /// No description provided for @finrSetupTitle.
  ///
  /// In ms, this message translates to:
  /// **'Baki pembukaan'**
  String get finrSetupTitle;

  /// No description provided for @finrSetupIntro.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan baki setiap tabung pada {date}. RM 0.00 dibenarkan. Baki ini menjadi titik mula buku kewangan.'**
  String finrSetupIntro(String date);

  /// No description provided for @finrSetupNoFunds.
  ///
  /// In ms, this message translates to:
  /// **'Belum ada tabung. Tambah tabung dahulu di Tetapan tabung.'**
  String get finrSetupNoFunds;

  /// No description provided for @finrSetupSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan baki pembukaan'**
  String get finrSetupSave;

  /// No description provided for @finrSetupHint.
  ///
  /// In ms, this message translates to:
  /// **'Selepas disimpan, baki pembukaan hanya boleh diubah dengan pembetulan.'**
  String get finrSetupHint;

  /// No description provided for @finrSetupDoneTitle.
  ///
  /// In ms, this message translates to:
  /// **'Baki pembukaan sudah dimasukkan'**
  String get finrSetupDoneTitle;

  /// No description provided for @finrSetupDoneHelp.
  ///
  /// In ms, this message translates to:
  /// **'Untuk mengubah satu baki, gunakan pembetulan pada catatan baki pembukaan itu.'**
  String get finrSetupDoneHelp;

  /// No description provided for @finrOpenFinance.
  ///
  /// In ms, this message translates to:
  /// **'Buka Kewangan'**
  String get finrOpenFinance;

  /// No description provided for @offlineSessionBanner.
  ///
  /// In ms, this message translates to:
  /// **'Luar talian: menggunakan data tersimpan. Perubahan akan diselaraskan secara automatik.'**
  String get offlineSessionBanner;

  /// No description provided for @unlockCloudWaking.
  ///
  /// In ms, this message translates to:
  /// **'Menghidupkan awan MAXCOM...'**
  String get unlockCloudWaking;

  /// No description provided for @unlockAutoRetrying.
  ///
  /// In ms, this message translates to:
  /// **'Mencuba lagi secara automatik.'**
  String get unlockAutoRetrying;

  /// No description provided for @offlinePinWrong.
  ///
  /// In ms, this message translates to:
  /// **'PIN salah. {left} cubaan lagi.'**
  String offlinePinWrong(int left);

  /// No description provided for @themeGalleryTitle.
  ///
  /// In ms, this message translates to:
  /// **'Templat paparan'**
  String get themeGalleryTitle;

  /// No description provided for @themeInUse.
  ///
  /// In ms, this message translates to:
  /// **'Sedang digunakan'**
  String get themeInUse;

  /// No description provided for @themeActive.
  ///
  /// In ms, this message translates to:
  /// **'Aktif'**
  String get themeActive;

  /// No description provided for @themeBuiltIn.
  ///
  /// In ms, this message translates to:
  /// **'Bawaan MAXCOM'**
  String get themeBuiltIn;

  /// No description provided for @themeNewBadge.
  ///
  /// In ms, this message translates to:
  /// **'BAHARU'**
  String get themeNewBadge;

  /// No description provided for @themeGroupArab.
  ///
  /// In ms, this message translates to:
  /// **'Arab'**
  String get themeGroupArab;

  /// No description provided for @themeScreenArabAyat.
  ///
  /// In ms, this message translates to:
  /// **'Ayat Arab'**
  String get themeScreenArabAyat;

  /// No description provided for @themeScreenArabZikir.
  ///
  /// In ms, this message translates to:
  /// **'Zikir Arab'**
  String get themeScreenArabZikir;

  /// No description provided for @themeScreenArabHadis.
  ///
  /// In ms, this message translates to:
  /// **'Hadis Arab'**
  String get themeScreenArabHadis;

  /// No description provided for @themeArabLooksOff.
  ///
  /// In ms, this message translates to:
  /// **'Tema ini memaparkan ayat, hadis dan zikir dalam rupa biasa. Skrin Arab digunakan oleh tema Arabic Art dan tema yang menyertakannya.'**
  String get themeArabLooksOff;

  /// No description provided for @themeArabSection.
  ///
  /// In ms, this message translates to:
  /// **'Tulisan Arab'**
  String get themeArabSection;

  /// No description provided for @themeArFont.
  ///
  /// In ms, this message translates to:
  /// **'Fon Arab'**
  String get themeArFont;

  /// No description provided for @themeArFontHafs.
  ///
  /// In ms, this message translates to:
  /// **'Uthmani Hafs'**
  String get themeArFontHafs;

  /// No description provided for @themeArFontAmiriQuran.
  ///
  /// In ms, this message translates to:
  /// **'Amiri Quran'**
  String get themeArFontAmiriQuran;

  /// No description provided for @themeArFontAmiri.
  ///
  /// In ms, this message translates to:
  /// **'Amiri'**
  String get themeArFontAmiri;

  /// No description provided for @themeArFontSample.
  ///
  /// In ms, this message translates to:
  /// **'ٱلْحَمْدُ لِلَّهِ'**
  String get themeArFontSample;

  /// No description provided for @themeArSize.
  ///
  /// In ms, this message translates to:
  /// **'Saiz Arab'**
  String get themeArSize;

  /// No description provided for @themeArSizeSmall.
  ///
  /// In ms, this message translates to:
  /// **'Kecil'**
  String get themeArSizeSmall;

  /// No description provided for @themeArSizeBig.
  ///
  /// In ms, this message translates to:
  /// **'Besar'**
  String get themeArSizeBig;

  /// No description provided for @themeHarakat.
  ///
  /// In ms, this message translates to:
  /// **'Warna baris'**
  String get themeHarakat;

  /// No description provided for @themeHarakatFollow.
  ///
  /// In ms, this message translates to:
  /// **'Ikut warna teks'**
  String get themeHarakatFollow;

  /// No description provided for @themeHarakatOwn.
  ///
  /// In ms, this message translates to:
  /// **'Warna sendiri'**
  String get themeHarakatOwn;

  /// No description provided for @themeHarakatNote.
  ///
  /// In ms, this message translates to:
  /// **'Warna baris memerlukan fon Amiri Quran atau Amiri. Uthmani Hafs dipapar dalam satu warna.'**
  String get themeHarakatNote;

  /// No description provided for @themeArLine.
  ///
  /// In ms, this message translates to:
  /// **'Jarak baris'**
  String get themeArLine;

  /// No description provided for @themeArLineTight.
  ///
  /// In ms, this message translates to:
  /// **'Rapat'**
  String get themeArLineTight;

  /// No description provided for @themeArLineWide.
  ///
  /// In ms, this message translates to:
  /// **'Luas'**
  String get themeArLineWide;

  /// No description provided for @themeTarjamah.
  ///
  /// In ms, this message translates to:
  /// **'Terjemahan'**
  String get themeTarjamah;

  /// No description provided for @themeTarjamahBelow.
  ///
  /// In ms, this message translates to:
  /// **'Bawah'**
  String get themeTarjamahBelow;

  /// No description provided for @themeTarjamahBeside.
  ///
  /// In ms, this message translates to:
  /// **'Sisi'**
  String get themeTarjamahBeside;

  /// No description provided for @themeTarjamahNote.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan menentukan sama ada terjemahan dipapar. Di sini hanya kedudukannya.'**
  String get themeTarjamahNote;

  /// No description provided for @themeAll.
  ///
  /// In ms, this message translates to:
  /// **'Semua tema ({n})'**
  String themeAll(int n);

  /// No description provided for @themeCustomise.
  ///
  /// In ms, this message translates to:
  /// **'Ubah suai'**
  String get themeCustomise;

  /// No description provided for @themeUse.
  ///
  /// In ms, this message translates to:
  /// **'Guna tema ini'**
  String get themeUse;

  /// No description provided for @themeChangedScreens.
  ///
  /// In ms, this message translates to:
  /// **'{n} skrin diubah suai.'**
  String themeChangedScreens(int n);

  /// No description provided for @themeNeedsUpdate.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini MAXCOM di surau untuk mengubah suai tema.'**
  String get themeNeedsUpdate;

  /// No description provided for @themeGalleryHint.
  ///
  /// In ms, this message translates to:
  /// **'Tekan tema untuk lihat dan pilih.'**
  String get themeGalleryHint;

  /// No description provided for @themeChosen.
  ///
  /// In ms, this message translates to:
  /// **'Tema ditukar'**
  String get themeChosen;

  /// No description provided for @themeScreenBiasa.
  ///
  /// In ms, this message translates to:
  /// **'Biasa'**
  String get themeScreenBiasa;

  /// No description provided for @themeScreenAzan.
  ///
  /// In ms, this message translates to:
  /// **'Azan'**
  String get themeScreenAzan;

  /// No description provided for @themeScreenMasukWaktu.
  ///
  /// In ms, this message translates to:
  /// **'Masuk waktu'**
  String get themeScreenMasukWaktu;

  /// No description provided for @themeScreenIqamah.
  ///
  /// In ms, this message translates to:
  /// **'Iqamah'**
  String get themeScreenIqamah;

  /// No description provided for @themeScreenSolat.
  ///
  /// In ms, this message translates to:
  /// **'Solat'**
  String get themeScreenSolat;

  /// No description provided for @themeScreenJumaat.
  ///
  /// In ms, this message translates to:
  /// **'Jumaat'**
  String get themeScreenJumaat;

  /// No description provided for @themeScreenLive.
  ///
  /// In ms, this message translates to:
  /// **'Live'**
  String get themeScreenLive;

  /// No description provided for @themeScreenPoster.
  ///
  /// In ms, this message translates to:
  /// **'Poster'**
  String get themeScreenPoster;

  /// No description provided for @themeScreenKuliah.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah'**
  String get themeScreenKuliah;

  /// No description provided for @themeScreenProgram.
  ///
  /// In ms, this message translates to:
  /// **'Program'**
  String get themeScreenProgram;

  /// No description provided for @themeScreenHadis.
  ///
  /// In ms, this message translates to:
  /// **'Hadis'**
  String get themeScreenHadis;

  /// No description provided for @themeScreenZikir.
  ///
  /// In ms, this message translates to:
  /// **'Zikir'**
  String get themeScreenZikir;

  /// No description provided for @themeScreenPengumuman.
  ///
  /// In ms, this message translates to:
  /// **'Pengumuman'**
  String get themeScreenPengumuman;

  /// No description provided for @themeScreenTakwim.
  ///
  /// In ms, this message translates to:
  /// **'Takwim'**
  String get themeScreenTakwim;

  /// No description provided for @themeScreenTabung.
  ///
  /// In ms, this message translates to:
  /// **'Tabung'**
  String get themeScreenTabung;

  /// No description provided for @themeScreenAyat.
  ///
  /// In ms, this message translates to:
  /// **'Ayat'**
  String get themeScreenAyat;

  /// No description provided for @themeGroupPrayer.
  ///
  /// In ms, this message translates to:
  /// **'Waktu solat'**
  String get themeGroupPrayer;

  /// No description provided for @themeGroupContent.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan'**
  String get themeGroupContent;

  /// No description provided for @themeBg.
  ///
  /// In ms, this message translates to:
  /// **'Latar belakang'**
  String get themeBg;

  /// No description provided for @themeFollowTheme.
  ///
  /// In ms, this message translates to:
  /// **'Ikut tema'**
  String get themeFollowTheme;

  /// No description provided for @themeOwnPicture.
  ///
  /// In ms, this message translates to:
  /// **'Gambar sendiri'**
  String get themeOwnPicture;

  /// No description provided for @themeChange.
  ///
  /// In ms, this message translates to:
  /// **'Tukar'**
  String get themeChange;

  /// No description provided for @themeFit.
  ///
  /// In ms, this message translates to:
  /// **'Paparan gambar'**
  String get themeFit;

  /// No description provided for @themeFitFull.
  ///
  /// In ms, this message translates to:
  /// **'Penuh'**
  String get themeFitFull;

  /// No description provided for @themeFitStretch.
  ///
  /// In ms, this message translates to:
  /// **'Regang'**
  String get themeFitStretch;

  /// No description provided for @themeFitMedium.
  ///
  /// In ms, this message translates to:
  /// **'Sederhana'**
  String get themeFitMedium;

  /// No description provided for @themeFitSmall.
  ///
  /// In ms, this message translates to:
  /// **'Kecil'**
  String get themeFitSmall;

  /// No description provided for @themePos.
  ///
  /// In ms, this message translates to:
  /// **'Kedudukan gambar'**
  String get themePos;

  /// No description provided for @themeLeft.
  ///
  /// In ms, this message translates to:
  /// **'Kiri'**
  String get themeLeft;

  /// No description provided for @themeCentre.
  ///
  /// In ms, this message translates to:
  /// **'Tengah'**
  String get themeCentre;

  /// No description provided for @themeRight.
  ///
  /// In ms, this message translates to:
  /// **'Kanan'**
  String get themeRight;

  /// No description provided for @themeShade.
  ///
  /// In ms, this message translates to:
  /// **'Kegelapan lapisan'**
  String get themeShade;

  /// No description provided for @themeShadeNote.
  ///
  /// In ms, this message translates to:
  /// **'Teks kekal jelas: warna teks auto diukur dari gambar.'**
  String get themeShadeNote;

  /// No description provided for @themeAccent.
  ///
  /// In ms, this message translates to:
  /// **'Warna utama'**
  String get themeAccent;

  /// No description provided for @themeAccentTheme.
  ///
  /// In ms, this message translates to:
  /// **'(tema)'**
  String get themeAccentTheme;

  /// No description provided for @themeAccentOther.
  ///
  /// In ms, this message translates to:
  /// **'Warna lain'**
  String get themeAccentOther;

  /// No description provided for @themeText.
  ///
  /// In ms, this message translates to:
  /// **'Warna teks'**
  String get themeText;

  /// No description provided for @themeTextAuto.
  ///
  /// In ms, this message translates to:
  /// **'Auto'**
  String get themeTextAuto;

  /// No description provided for @themeTextPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih warna'**
  String get themeTextPick;

  /// No description provided for @themeFont.
  ///
  /// In ms, this message translates to:
  /// **'Fon'**
  String get themeFont;

  /// No description provided for @themeSize.
  ///
  /// In ms, this message translates to:
  /// **'Saiz teks'**
  String get themeSize;

  /// No description provided for @themeSizeNote.
  ///
  /// In ms, this message translates to:
  /// **'Skala di atas saiz asas; saiz asas hadis dan ayat dipilih di Konfigurasi. S ialah saiz sekarang, tiada saiz lebih kecil supaya jelas dari 3 meter.'**
  String get themeSizeNote;

  /// No description provided for @themeBgNote.
  ///
  /// In ms, this message translates to:
  /// **'Ikut tema: gambar latar di Konfigurasi digunakan (atau gambar tema yang dimuat naik).'**
  String get themeBgNote;

  /// No description provided for @themeAlign.
  ///
  /// In ms, this message translates to:
  /// **'Susunan kandungan'**
  String get themeAlign;

  /// No description provided for @themeGoldOutline.
  ///
  /// In ms, this message translates to:
  /// **'Garis emas pada tajuk'**
  String get themeGoldOutline;

  /// No description provided for @themeGoldOn.
  ///
  /// In ms, this message translates to:
  /// **'Hidup'**
  String get themeGoldOn;

  /// No description provided for @themeGoldOff.
  ///
  /// In ms, this message translates to:
  /// **'Mati'**
  String get themeGoldOff;

  /// No description provided for @themeChangedBadge.
  ///
  /// In ms, this message translates to:
  /// **'Diubah'**
  String get themeChangedBadge;

  /// No description provided for @themeReset.
  ///
  /// In ms, this message translates to:
  /// **'Set semula'**
  String get themeReset;

  /// No description provided for @themeApplyAll.
  ///
  /// In ms, this message translates to:
  /// **'Guna untuk semua skrin'**
  String get themeApplyAll;

  /// No description provided for @themeEditTitle.
  ///
  /// In ms, this message translates to:
  /// **'Ubah suai: {title}'**
  String themeEditTitle(String title);

  /// No description provided for @themeEditScreen.
  ///
  /// In ms, this message translates to:
  /// **'Skrin {name}'**
  String themeEditScreen(String name);

  /// No description provided for @themeLivePreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton langsung'**
  String get themeLivePreview;

  /// No description provided for @themeApplyAllConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Guna rupa skrin ini untuk semua skrin tema {title}?'**
  String themeApplyAllConfirm(String title);

  /// No description provided for @themeApplyAllReplaces.
  ///
  /// In ms, this message translates to:
  /// **'Guna rupa skrin ini untuk semua skrin tema {title}? Pilihan sendiri bagi {n} skrin lain akan dipadam dan diganti dengan nilai skrin ini.'**
  String themeApplyAllReplaces(String title, int n);

  /// No description provided for @themeResetScreen.
  ///
  /// In ms, this message translates to:
  /// **'Set semula skrin ini'**
  String get themeResetScreen;

  /// No description provided for @themeResetScreenConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Kembali kepada rupa tema bagi skrin {screen}?'**
  String themeResetScreenConfirm(String screen);

  /// No description provided for @themeResetAll.
  ///
  /// In ms, this message translates to:
  /// **'Set semula semua skrin'**
  String get themeResetAll;

  /// No description provided for @themeFreshFailed.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat memuatkan nilai terkini. Tiada yang disimpan. Cuba lagi.'**
  String get themeFreshFailed;

  /// No description provided for @themeResetConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Kembali kepada rupa asal tema {title}?'**
  String themeResetConfirm(String title);

  /// No description provided for @themeDiscardTitle.
  ///
  /// In ms, this message translates to:
  /// **'Buang perubahan yang belum disimpan?'**
  String get themeDiscardTitle;

  /// No description provided for @themeDiscard.
  ///
  /// In ms, this message translates to:
  /// **'Buang'**
  String get themeDiscard;

  /// No description provided for @themeKeepEditing.
  ///
  /// In ms, this message translates to:
  /// **'Terus sunting'**
  String get themeKeepEditing;

  /// No description provided for @themeSaved.
  ///
  /// In ms, this message translates to:
  /// **'Gaya tema disimpan'**
  String get themeSaved;

  /// No description provided for @themePickPicture.
  ///
  /// In ms, this message translates to:
  /// **'Pilih gambar'**
  String get themePickPicture;

  /// No description provided for @themeCustomColour.
  ///
  /// In ms, this message translates to:
  /// **'Warna sendiri (#rrggbb)'**
  String get themeCustomColour;

  /// No description provided for @themeUploadTitle.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik tema'**
  String get themeUploadTitle;

  /// No description provided for @themeUploadStep.
  ///
  /// In ms, this message translates to:
  /// **'Langkah {n} daripada 3'**
  String themeUploadStep(int n);

  /// No description provided for @themeUploadPickTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail tema'**
  String get themeUploadPickTitle;

  /// No description provided for @themeUploadPickHint.
  ///
  /// In ms, this message translates to:
  /// **'Fail .maxtheme, paling besar 15 MB.'**
  String get themeUploadPickHint;

  /// No description provided for @themeUploadPickButton.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail'**
  String get themeUploadPickButton;

  /// No description provided for @themeUploadChecksNote.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau akan menyemak fail ini: saiz, kandungan, gaya CSS dan versi. Tiada apa dipasang sebelum anda tekan Pasang.'**
  String get themeUploadChecksNote;

  /// No description provided for @themeUploadCancel.
  ///
  /// In ms, this message translates to:
  /// **'Batal'**
  String get themeUploadCancel;

  /// No description provided for @themeUploadCheck.
  ///
  /// In ms, this message translates to:
  /// **'Semak fail'**
  String get themeUploadCheck;

  /// No description provided for @themeUploadChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menyemak fail...'**
  String get themeUploadChecking;

  /// No description provided for @themeUploadValid.
  ///
  /// In ms, this message translates to:
  /// **'Tema sah dan sedia dipasang'**
  String get themeUploadValid;

  /// No description provided for @themeUploadNoProblems.
  ///
  /// In ms, this message translates to:
  /// **'Tiada masalah ditemui.'**
  String get themeUploadNoProblems;

  /// No description provided for @themeUploadPreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton: {screen}'**
  String themeUploadPreview(String screen);

  /// No description provided for @themeUploadName.
  ///
  /// In ms, this message translates to:
  /// **'Nama'**
  String get themeUploadName;

  /// No description provided for @themeUploadVersion.
  ///
  /// In ms, this message translates to:
  /// **'Versi'**
  String get themeUploadVersion;

  /// No description provided for @themeUploadVersionNew.
  ///
  /// In ms, this message translates to:
  /// **'{n} (tema baharu)'**
  String themeUploadVersionNew(int n);

  /// No description provided for @themeUploadVersionUpdate.
  ///
  /// In ms, this message translates to:
  /// **'{n} (kemas kini daripada versi {m})'**
  String themeUploadVersionUpdate(int n, int m);

  /// No description provided for @themeUploadBase.
  ///
  /// In ms, this message translates to:
  /// **'Berasaskan'**
  String get themeUploadBase;

  /// No description provided for @themeUploadContract.
  ///
  /// In ms, this message translates to:
  /// **'Kontrak'**
  String get themeUploadContract;

  /// No description provided for @themeUploadContent.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan'**
  String get themeUploadContent;

  /// No description provided for @themeUploadContentValue.
  ///
  /// In ms, this message translates to:
  /// **'{n} fail, {size}'**
  String themeUploadContentValue(int n, String size);

  /// No description provided for @themeUploadOwnScreens.
  ///
  /// In ms, this message translates to:
  /// **'Skrin bergaya sendiri'**
  String get themeUploadOwnScreens;

  /// No description provided for @themeUploadInstall.
  ///
  /// In ms, this message translates to:
  /// **'Pasang'**
  String get themeUploadInstall;

  /// No description provided for @themeUploadInstallAnyway.
  ///
  /// In ms, this message translates to:
  /// **'Pasang juga'**
  String get themeUploadInstallAnyway;

  /// No description provided for @themeUploadWarnTitle.
  ///
  /// In ms, this message translates to:
  /// **'Boleh dipasang, dengan {n} amaran'**
  String themeUploadWarnTitle(int n);

  /// No description provided for @themeUploadClose.
  ///
  /// In ms, this message translates to:
  /// **'Tutup'**
  String get themeUploadClose;

  /// No description provided for @themeUploadInstalled.
  ///
  /// In ms, this message translates to:
  /// **'{title} dipasang'**
  String themeUploadInstalled(String title);

  /// No description provided for @themeUploadInstalledNote.
  ///
  /// In ms, this message translates to:
  /// **'Tema kini ada dalam galeri. TV masih memakai {current} sehingga anda memilih tema ini.'**
  String themeUploadInstalledNote(String current);

  /// No description provided for @themeUploadSavedNote.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan di MAXCOM surau dan diselaraskan ke awan.'**
  String get themeUploadSavedNote;

  /// No description provided for @themeUploadBack.
  ///
  /// In ms, this message translates to:
  /// **'Kembali ke galeri'**
  String get themeUploadBack;

  /// No description provided for @themeUploadUseNow.
  ///
  /// In ms, this message translates to:
  /// **'Guna sekarang'**
  String get themeUploadUseNow;

  /// No description provided for @themeUploadTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Fail melebihi 15 MB.'**
  String get themeUploadTooBig;

  /// No description provided for @themeUploadWrongType.
  ///
  /// In ms, this message translates to:
  /// **'Pilih fail yang berakhir dengan .maxtheme.'**
  String get themeUploadWrongType;

  /// No description provided for @themeUploadUnreadable.
  ///
  /// In ms, this message translates to:
  /// **'Fail tidak dapat dibaca.'**
  String get themeUploadUnreadable;

  /// No description provided for @themeUploadExpired.
  ///
  /// In ms, this message translates to:
  /// **'Semakan sudah tamat tempoh. Semak fail sekali lagi.'**
  String get themeUploadExpired;

  /// No description provided for @themeUploadedBadge.
  ///
  /// In ms, this message translates to:
  /// **'Dimuat naik, versi {n}'**
  String themeUploadedBadge(int n);

  /// No description provided for @themeInvalidBadge.
  ///
  /// In ms, this message translates to:
  /// **'Tema tidak sah'**
  String get themeInvalidBadge;

  /// No description provided for @themeInvalidNote.
  ///
  /// In ms, this message translates to:
  /// **'TV memakai tema asas kerana tema ini menyembunyikan jam, waktu solat atau logo. Betulkan fail tema dan muat naik versi baharu.'**
  String get themeInvalidNote;

  /// No description provided for @themeNotReady.
  ///
  /// In ms, this message translates to:
  /// **'Belum boleh digunakan'**
  String get themeNotReady;

  /// No description provided for @themeNotReadyNote.
  ///
  /// In ms, this message translates to:
  /// **'Tema ini belum boleh digunakan: ada MAXCOM di surau yang perlu dikemas kini dahulu.'**
  String get themeNotReadyNote;

  /// No description provided for @themeCannotConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat mengesahkan semua MAXCOM surau sekarang. Cuba lagi apabila talian awan pulih.'**
  String get themeCannotConfirm;

  /// No description provided for @themeDownloadTitle.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun tema'**
  String get themeDownloadTitle;

  /// No description provided for @themeDownloadLine.
  ///
  /// In ms, this message translates to:
  /// **'Satu fail untuk disunting di luar MAXCOM atau dikongsi dengan surau lain.'**
  String get themeDownloadLine;

  /// No description provided for @themeFileName.
  ///
  /// In ms, this message translates to:
  /// **'Nama fail'**
  String get themeFileName;

  /// No description provided for @themeBake.
  ///
  /// In ms, this message translates to:
  /// **'Sertakan ubah suai saya'**
  String get themeBake;

  /// No description provided for @themeBakeNote.
  ///
  /// In ms, this message translates to:
  /// **'Fail akan menghasilkan rupa yang sama seperti TV surau sekarang ({n} skrin diubah, {m} gambar latar).'**
  String themeBakeNote(int n, int m);

  /// No description provided for @themeDownloadButton.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun'**
  String get themeDownloadButton;

  /// No description provided for @themeShare.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi'**
  String get themeShare;

  /// No description provided for @themeNameBad.
  ///
  /// In ms, this message translates to:
  /// **'Nama tidak sah. Guna huruf kecil, nombor dan sempang (paling panjang 32 aksara).'**
  String get themeNameBad;

  /// No description provided for @themeDownloaded.
  ///
  /// In ms, this message translates to:
  /// **'Fail tema disimpan'**
  String get themeDownloaded;

  /// No description provided for @themeDownloadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Fail tema tidak dapat disediakan.'**
  String get themeDownloadFailed;

  /// No description provided for @themeDelete.
  ///
  /// In ms, this message translates to:
  /// **'Padam tema'**
  String get themeDelete;

  /// No description provided for @themeDeleteConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Padam tema {title}? Ubah suai anda untuk tema ini disimpan.'**
  String themeDeleteConfirm(String title);

  /// No description provided for @themeDeleteInUse.
  ///
  /// In ms, this message translates to:
  /// **'Tema ini sedang digunakan. Pilih tema lain dahulu.'**
  String get themeDeleteInUse;

  /// No description provided for @themeDeleteBuiltIn.
  ///
  /// In ms, this message translates to:
  /// **'Tema bawaan MAXCOM tidak boleh dipadam.'**
  String get themeDeleteBuiltIn;

  /// No description provided for @themeDeleted.
  ///
  /// In ms, this message translates to:
  /// **'Tema dipadam'**
  String get themeDeleted;

  /// No description provided for @valRequired.
  ///
  /// In ms, this message translates to:
  /// **'Wajib diisi'**
  String get valRequired;

  /// No description provided for @valTooLong.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu panjang (paling banyak {max} aksara)'**
  String valTooLong(int max);

  /// No description provided for @valNoSpaces.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh ada ruang atau aksara kawalan'**
  String get valNoSpaces;

  /// No description provided for @valWebAddress.
  ///
  /// In ms, this message translates to:
  /// **'Mesti alamat web yang sah'**
  String get valWebAddress;

  /// No description provided for @valStartHttps.
  ///
  /// In ms, this message translates to:
  /// **'Mesti bermula dengan https://'**
  String get valStartHttps;

  /// No description provided for @valNoUserInfo.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh ada nama pengguna atau kata laluan'**
  String get valNoUserInfo;

  /// No description provided for @valNoFragment.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh ada bahagian #'**
  String get valNoFragment;

  /// No description provided for @valPublicAddress.
  ///
  /// In ms, this message translates to:
  /// **'Mesti alamat internet awam (bukan setempat atau peribadi)'**
  String get valPublicAddress;

  /// No description provided for @valRectShape.
  ///
  /// In ms, this message translates to:
  /// **'Mesti objek {shape}'**
  String valRectShape(String shape);

  /// No description provided for @valUnknownField.
  ///
  /// In ms, this message translates to:
  /// **'Medan tidak dikenali'**
  String get valUnknownField;

  /// No description provided for @valRectNumbers.
  ///
  /// In ms, this message translates to:
  /// **'x, y, w dan h mesti nombor'**
  String get valRectNumbers;

  /// No description provided for @valCropInside.
  ///
  /// In ms, this message translates to:
  /// **'Petak potongan mesti berada dalam gambar'**
  String get valCropInside;

  /// No description provided for @valImageIdBad.
  ///
  /// In ms, this message translates to:
  /// **'Id gambar tidak sah'**
  String get valImageIdBad;

  /// No description provided for @valSquareLogoOnly.
  ///
  /// In ms, this message translates to:
  /// **'Petak segi empat hanya untuk logo'**
  String get valSquareLogoOnly;

  /// No description provided for @valBgChoice.
  ///
  /// In ms, this message translates to:
  /// **'Latar mesti keep, remove atau card'**
  String get valBgChoice;

  /// No description provided for @valRotateChoice.
  ///
  /// In ms, this message translates to:
  /// **'Putaran mesti 0, 90, 180 atau 270'**
  String get valRotateChoice;

  /// No description provided for @valBool.
  ///
  /// In ms, this message translates to:
  /// **'Mesti hidup atau mati'**
  String get valBool;

  /// No description provided for @valOneOf.
  ///
  /// In ms, this message translates to:
  /// **'Mesti salah satu daripada: {list}'**
  String valOneOf(String list);

  /// No description provided for @valWholeNumber.
  ///
  /// In ms, this message translates to:
  /// **'Mesti nombor bulat {min} hingga {max}'**
  String valWholeNumber(int min, int max);

  /// No description provided for @valMustText.
  ///
  /// In ms, this message translates to:
  /// **'Mesti teks'**
  String get valMustText;

  /// No description provided for @valMustWhat.
  ///
  /// In ms, this message translates to:
  /// **'Mesti {what}'**
  String valMustWhat(String what);

  /// No description provided for @valWhatPlain.
  ///
  /// In ms, this message translates to:
  /// **'teks biasa'**
  String get valWhatPlain;

  /// No description provided for @valWhatPlainNoHtml.
  ///
  /// In ms, this message translates to:
  /// **'teks biasa tanpa aksara HTML'**
  String get valWhatPlainNoHtml;

  /// No description provided for @valWhatPhone.
  ///
  /// In ms, this message translates to:
  /// **'nombor telefon seperti 012-345 6789'**
  String get valWhatPhone;

  /// No description provided for @valWhatEmail.
  ///
  /// In ms, this message translates to:
  /// **'alamat e-mel seperti nama@contoh.my'**
  String get valWhatEmail;

  /// No description provided for @valWhatHttps.
  ///
  /// In ms, this message translates to:
  /// **'alamat https://'**
  String get valWhatHttps;

  /// No description provided for @valWhatValid.
  ///
  /// In ms, this message translates to:
  /// **'sah'**
  String get valWhatValid;

  /// No description provided for @valDecimal.
  ///
  /// In ms, this message translates to:
  /// **'Mesti nombor {min} hingga {max} dengan paling banyak 4 titik perpuluhan, atau kosong'**
  String valDecimal(int min, int max);

  /// No description provided for @valColourHex.
  ///
  /// In ms, this message translates to:
  /// **'Tulis # diikuti 6 aksara, contoh #F6E7B8'**
  String get valColourHex;

  /// No description provided for @valAudioFile.
  ///
  /// In ms, this message translates to:
  /// **'Mesti fail audio yang sah'**
  String get valAudioFile;

  /// No description provided for @valTimeValid.
  ///
  /// In ms, this message translates to:
  /// **'Mesti masa yang sah'**
  String get valTimeValid;

  /// No description provided for @valTextOrEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Mesti teks atau kosong'**
  String get valTextOrEmpty;

  /// No description provided for @valTextList.
  ///
  /// In ms, this message translates to:
  /// **'Mesti senarai teks'**
  String get valTextList;

  /// No description provided for @valItemMax.
  ///
  /// In ms, this message translates to:
  /// **'Item mesti paling banyak {max} aksara'**
  String valItemMax(int max);

  /// No description provided for @valSourceOrder.
  ///
  /// In ms, this message translates to:
  /// **'Mesti senaraikan official, calc dan file sekali sahaja'**
  String get valSourceOrder;

  /// No description provided for @valMaxImages.
  ///
  /// In ms, this message translates to:
  /// **'Paling banyak {max} gambar'**
  String valMaxImages(int max);

  /// No description provided for @valImageNames.
  ///
  /// In ms, this message translates to:
  /// **'Gambar mesti nama sedia ada (a-z, 0-9, -) atau /uploads/<nama fail>'**
  String get valImageNames;

  /// No description provided for @valUnsupported.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan ini tidak disokong'**
  String get valUnsupported;

  /// No description provided for @valMustObject.
  ///
  /// In ms, this message translates to:
  /// **'Mesti objek'**
  String get valMustObject;

  /// No description provided for @valUnknownSetting.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan tidak dikenali'**
  String get valUnknownSetting;

  /// No description provided for @valSurahAyat.
  ///
  /// In ms, this message translates to:
  /// **'{name} ada {ayat} ayat'**
  String valSurahAyat(String name, int ayat);

  /// No description provided for @valAyatOrder.
  ///
  /// In ms, this message translates to:
  /// **'Ayat mula mesti sebelum atau sama dengan ayat akhir'**
  String get valAyatOrder;

  /// No description provided for @valAyatMax.
  ///
  /// In ms, this message translates to:
  /// **'Paling banyak 3 ayat sekali paparan'**
  String get valAyatMax;

  /// No description provided for @valUnknownFeature.
  ///
  /// In ms, this message translates to:
  /// **'Ciri tidak dikenali'**
  String get valUnknownFeature;

  /// No description provided for @valSettingsObject.
  ///
  /// In ms, this message translates to:
  /// **'Tetapan mesti objek'**
  String get valSettingsObject;

  /// No description provided for @valAlwaysOn.
  ///
  /// In ms, this message translates to:
  /// **'{name} sentiasa hidup dan tidak boleh dimatikan'**
  String valAlwaysOn(String name);

  /// No description provided for @valFromBeforeTo.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh mula mesti sebelum tarikh tamat'**
  String get valFromBeforeTo;

  /// No description provided for @valDate.
  ///
  /// In ms, this message translates to:
  /// **'Mesti tarikh yang sah'**
  String get valDate;

  /// No description provided for @valTimeHm.
  ///
  /// In ms, this message translates to:
  /// **'Mesti masa yang sah (JJ:MM)'**
  String get valTimeHm;

  /// No description provided for @valDateTime.
  ///
  /// In ms, this message translates to:
  /// **'Mesti tarikh dan masa yang sah'**
  String get valDateTime;

  /// No description provided for @valPickDays.
  ///
  /// In ms, this message translates to:
  /// **'Pilih sekurang-kurangnya satu hari'**
  String get valPickDays;

  /// No description provided for @valPickTz.
  ///
  /// In ms, this message translates to:
  /// **'Pilih zon waktu daripada senarai'**
  String get valPickTz;

  /// No description provided for @valUnknownKind.
  ///
  /// In ms, this message translates to:
  /// **'Jenis kandungan tidak dikenali'**
  String get valUnknownKind;

  /// No description provided for @valItemObject.
  ///
  /// In ms, this message translates to:
  /// **'Item mesti objek'**
  String get valItemObject;

  /// No description provided for @valImageBad.
  ///
  /// In ms, this message translates to:
  /// **'Gambar tidak sah'**
  String get valImageBad;

  /// No description provided for @valFitBad.
  ///
  /// In ms, this message translates to:
  /// **'Paparan gambar tidak sah'**
  String get valFitBad;

  /// No description provided for @valChoiceBad.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan tidak sah'**
  String get valChoiceBad;

  /// No description provided for @valColourLike.
  ///
  /// In ms, this message translates to:
  /// **'Warna mesti seperti #12AB34'**
  String get valColourLike;

  /// No description provided for @valFontBad.
  ///
  /// In ms, this message translates to:
  /// **'Fon tidak sah'**
  String get valFontBad;

  /// No description provided for @valSizeChoice.
  ///
  /// In ms, this message translates to:
  /// **'Saiz mesti S, M, L atau XL'**
  String get valSizeChoice;

  /// No description provided for @valValueUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Nilai tidak dikenali'**
  String get valValueUnknown;

  /// No description provided for @kindHintSeries.
  ///
  /// In ms, this message translates to:
  /// **'Kod siri untuk kuliah bersambung (pilihan)'**
  String get kindHintSeries;

  /// No description provided for @kindHintPhone.
  ///
  /// In ms, this message translates to:
  /// **'Untuk AJK sahaja, tidak dipaparkan di TV'**
  String get kindHintPhone;

  /// No description provided for @kindDescPengumuman.
  ///
  /// In ms, this message translates to:
  /// **'Makluman kepada jemaah untuk tempoh tertentu.'**
  String get kindDescPengumuman;

  /// No description provided for @kindDescHadis.
  ///
  /// In ms, this message translates to:
  /// **'Hadis pilihan untuk kad hadis di TV.'**
  String get kindDescHadis;

  /// No description provided for @errorRequestFailed.
  ///
  /// In ms, this message translates to:
  /// **'Permintaan gagal'**
  String get errorRequestFailed;

  /// No description provided for @errorFeatureNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Ciri tidak dijumpai'**
  String get errorFeatureNotFound;

  /// No description provided for @tvLangNeedsUpdate.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini MAX Kiosk Server untuk pilihan ini'**
  String get tvLangNeedsUpdate;

  /// No description provided for @prayerErrNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dijumpai'**
  String get prayerErrNotFound;

  /// No description provided for @prayerErrRateLimited.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak carian. Cuba lagi sebentar lagi'**
  String get prayerErrRateLimited;

  /// No description provided for @prayerErrOffline.
  ///
  /// In ms, this message translates to:
  /// **'Carian lokasi perlukan sambungan internet pada MAXCOM'**
  String get prayerErrOffline;

  /// No description provided for @prayerErrUpstream.
  ///
  /// In ms, this message translates to:
  /// **'Sumber waktu solat tidak menjawab. Cuba lagi nanti'**
  String get prayerErrUpstream;

  /// No description provided for @prayerErrZonesUpstream.
  ///
  /// In ms, this message translates to:
  /// **'Senarai zon tidak dapat dimuat turun sekarang. Cuba lagi nanti'**
  String get prayerErrZonesUpstream;

  /// No description provided for @prayerErrConflict.
  ///
  /// In ms, this message translates to:
  /// **'Tindakan ini tidak boleh dibuat lagi'**
  String get prayerErrConflict;

  /// No description provided for @prayerErrTooLarge.
  ///
  /// In ms, this message translates to:
  /// **'Fail terlalu besar. Pilih fail yang lebih kecil'**
  String get prayerErrTooLarge;

  /// No description provided for @prayerErrBadType.
  ///
  /// In ms, this message translates to:
  /// **'Jenis fail tidak disokong'**
  String get prayerErrBadType;

  /// No description provided for @prayerErrUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Perkhidmatan tidak tersedia buat masa ini'**
  String get prayerErrUnavailable;

  /// No description provided for @prayerErrInvalidData.
  ///
  /// In ms, this message translates to:
  /// **'Data tidak sah'**
  String get prayerErrInvalidData;

  /// No description provided for @liveSignInFailed.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube tidak berjaya. Cuba lagi.'**
  String get liveSignInFailed;

  /// No description provided for @liveStartFailed.
  ///
  /// In ms, this message translates to:
  /// **'Siaran tidak dapat dimulakan'**
  String get liveStartFailed;

  /// No description provided for @liveOtherDevice.
  ///
  /// In ms, this message translates to:
  /// **'peranti lain'**
  String get liveOtherDevice;

  /// No description provided for @liveRateText.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.'**
  String get liveRateText;

  /// No description provided for @liveWarnYoutubeNotSignedIn.
  ///
  /// In ms, this message translates to:
  /// **'YouTube belum dilog masuk di MAXCOM. Siaran ke skrin surau berjalan.'**
  String get liveWarnYoutubeNotSignedIn;

  /// No description provided for @liveWarnYoutubeOff.
  ///
  /// In ms, this message translates to:
  /// **'YouTube dimatikan oleh pentadbir'**
  String get liveWarnYoutubeOff;

  /// No description provided for @liveWarnYoutubeQuota.
  ///
  /// In ms, this message translates to:
  /// **'Kuota YouTube hari ini telah habis.'**
  String get liveWarnYoutubeQuota;

  /// No description provided for @liveWarnYoutubeReauth.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube perlu diperbaharui.'**
  String get liveWarnYoutubeReauth;

  /// No description provided for @liveWarnYoutubeForbidden.
  ///
  /// In ms, this message translates to:
  /// **'YouTube menolak permintaan.'**
  String get liveWarnYoutubeForbidden;

  /// No description provided for @liveWarnCloudUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'YouTube: awan tidak dapat dihubungi'**
  String get liveWarnCloudUnreachable;

  /// No description provided for @liveCamUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'{name}, tidak dapat dihubungi'**
  String liveCamUnreachable(String name);

  /// No description provided for @liveCamReady.
  ///
  /// In ms, this message translates to:
  /// **'{name}, sedia'**
  String liveCamReady(String name);

  /// No description provided for @liveExtBoxPullNote.
  ///
  /// In ms, this message translates to:
  /// **'Di iPad, MAXCOM yang menarik gambar dan audio dari {camera} dan menghantar pratonton ke iPad ini. Siaran yang digabungkan di MAXCOM sampai ke skrin surau dan YouTube 1 hingga 2 saat lewat.'**
  String liveExtBoxPullNote(String camera);

  /// No description provided for @liveExtControllerOnly.
  ///
  /// In ms, this message translates to:
  /// **'Audio kamera sahaja. iPad ini mengawal siaran dan memaparkan pratonton; ia tidak menghantar bunyi.'**
  String get liveExtControllerOnly;

  /// No description provided for @liveExtScreenLock.
  ///
  /// In ms, this message translates to:
  /// **'Letak iPad dekat penceramah dan kekalkan skrin terbuka. Mengunci skrin akan menghentikan mikrofon.'**
  String get liveExtScreenLock;

  /// No description provided for @liveExtRecordingFallback.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman tidak dibuat apabila iPad mengawal Kamera luaran. Salinan siaran ada di YouTube.'**
  String get liveExtRecordingFallback;

  /// No description provided for @liveExtSourceName.
  ///
  /// In ms, this message translates to:
  /// **'Mikrofon iPad'**
  String get liveExtSourceName;

  /// No description provided for @liveExtMicLostCamera.
  ///
  /// In ms, this message translates to:
  /// **'{source} terputus. Siaran diteruskan dengan audio kamera.'**
  String liveExtMicLostCamera(String source);

  /// No description provided for @liveExtMicLostSilent.
  ///
  /// In ms, this message translates to:
  /// **'{source} terputus. Siaran diteruskan tanpa bunyi.'**
  String liveExtMicLostSilent(String source);

  /// No description provided for @liveExtMicLostHint.
  ///
  /// In ms, this message translates to:
  /// **'Mikrofon disambung semula secara automatik dan diselaraskan sebelum dicampur semula. Kekalkan skrin iPad terbuka.'**
  String get liveExtMicLostHint;

  /// No description provided for @liveExtMicRefused.
  ///
  /// In ms, this message translates to:
  /// **'Mikrofon iPad tidak dapat dibuka. Siaran diteruskan dengan audio kamera.'**
  String get liveExtMicRefused;

  /// No description provided for @liveExtChipRealign.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan semula bila kembali'**
  String get liveExtChipRealign;

  /// No description provided for @liveExtChipOnStart.
  ///
  /// In ms, this message translates to:
  /// **'Diselaraskan bila siaran bermula'**
  String get liveExtChipOnStart;

  /// No description provided for @liveExtChipAligned.
  ///
  /// In ms, this message translates to:
  /// **'Selaras'**
  String get liveExtChipAligned;

  /// No description provided for @liveExtChipNotAligned.
  ///
  /// In ms, this message translates to:
  /// **'Belum selaras'**
  String get liveExtChipNotAligned;

  /// No description provided for @liveExtChipManual.
  ///
  /// In ms, this message translates to:
  /// **'Imbangan masa audio'**
  String get liveExtChipManual;

  /// No description provided for @liveExtChipAligning.
  ///
  /// In ms, this message translates to:
  /// **'Sedang diselaraskan'**
  String get liveExtChipAligning;

  /// No description provided for @liveExtAlignFailedCamera.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan automatik belum berjaya, jadi {source} belum dicampur supaya suara tidak kedengaran berganda. Pastikan ada suara di dalam surau dan kamera boleh mendengarnya.'**
  String liveExtAlignFailedCamera(String source);

  /// No description provided for @liveExtAlignFailedSilent.
  ///
  /// In ms, this message translates to:
  /// **'Penyelarasan automatik belum berjaya. Bunyi mungkin tidak selari dengan gambar.'**
  String get liveExtAlignFailedSilent;

  /// No description provided for @liveExtUseMicOnly.
  ///
  /// In ms, this message translates to:
  /// **'Guna {source} sahaja'**
  String liveExtUseMicOnly(String source);

  /// No description provided for @liveExtCameraNoAudioMic.
  ///
  /// In ms, this message translates to:
  /// **'Kamera ini tiada audio. {source} digunakan bersendirian. Tetapkan \'Imbangan masa audio\' dengan \'Uji tepukan\'.'**
  String liveExtCameraNoAudioMic(String source);

  /// No description provided for @liveExtCameraNoAudioAlone.
  ///
  /// In ms, this message translates to:
  /// **'Kamera ini tiada audio. Tekan \'Tambah audio\' untuk memilih mikrofon, atau siaran tiada bunyi.'**
  String get liveExtCameraNoAudioAlone;

  /// No description provided for @liveExtAllMuted.
  ///
  /// In ms, this message translates to:
  /// **'Semua sumber audio disenyapkan. Siaran tiada bunyi.'**
  String get liveExtAllMuted;

  /// No description provided for @liveExtPreviewRetry.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton terputus. Menyambung semula...'**
  String get liveExtPreviewRetry;

  /// No description provided for @liveOnlyEnrol.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti baharu'**
  String get liveOnlyEnrol;

  /// No description provided for @liveOnlyRevoke.
  ///
  /// In ms, this message translates to:
  /// **'Padam peranti'**
  String get liveOnlyRevoke;

  /// No description provided for @liveOnlyRevokeWhy.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir mesti nampak peranti berjaya dipadam'**
  String get liveOnlyRevokeWhy;

  /// No description provided for @liveOnlyAddUser.
  ///
  /// In ms, this message translates to:
  /// **'Tambah pengguna'**
  String get liveOnlyAddUser;

  /// No description provided for @liveOnlyResetPin.
  ///
  /// In ms, this message translates to:
  /// **'Tetapkan semula PIN'**
  String get liveOnlyResetPin;

  /// No description provided for @liveOnlyAppLock.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi'**
  String get liveOnlyAppLock;

  /// No description provided for @liveOnlyPairDisplay.
  ///
  /// In ms, this message translates to:
  /// **'Luluskan pasangan paparan'**
  String get liveOnlyPairDisplay;

  /// No description provided for @liveOnlyYoutubeSign.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk dan log keluar YouTube'**
  String get liveOnlyYoutubeSign;

  /// No description provided for @liveOnlyLive.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung'**
  String get liveOnlyLive;

  /// No description provided for @liveOnlyPrayerOps.
  ///
  /// In ms, this message translates to:
  /// **'Import, pembetulan dan carian waktu solat'**
  String get liveOnlyPrayerOps;

  /// No description provided for @liveOnlyPrayerData.
  ///
  /// In ms, this message translates to:
  /// **'Data waktu solat'**
  String get liveOnlyPrayerData;

  /// No description provided for @liveOnlyIslamic.
  ///
  /// In ms, this message translates to:
  /// **'Kandungan Islam'**
  String get liveOnlyIslamic;

  /// No description provided for @liveOnlyAnalyse.
  ///
  /// In ms, this message translates to:
  /// **'Analisis gambar'**
  String get liveOnlyAnalyse;

  /// No description provided for @liveOnlyUploadRecording.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik rakaman ke YouTube'**
  String get liveOnlyUploadRecording;

  /// No description provided for @liveOnlySyncNow.
  ///
  /// In ms, this message translates to:
  /// **'Selaraskan sekarang'**
  String get liveOnlySyncNow;

  /// No description provided for @liveOnlyChangePin.
  ///
  /// In ms, this message translates to:
  /// **'Tukar PIN'**
  String get liveOnlyChangePin;

  /// No description provided for @liveOnlyReportPdf.
  ///
  /// In ms, this message translates to:
  /// **'Muat turun PDF laporan'**
  String get liveOnlyReportPdf;

  /// No description provided for @liveOnlyCountPhoto.
  ///
  /// In ms, this message translates to:
  /// **'Lihat foto helaian kiraan'**
  String get liveOnlyCountPhoto;

  /// No description provided for @liveOnlyReportShared.
  ///
  /// In ms, this message translates to:
  /// **'Rekod perkongsian laporan'**
  String get liveOnlyReportShared;

  /// No description provided for @liveOnlyFinanceAudit.
  ///
  /// In ms, this message translates to:
  /// **'Sejarah audit kewangan'**
  String get liveOnlyFinanceAudit;

  /// No description provided for @hadisGradeNoteSahih.
  ///
  /// In ms, this message translates to:
  /// **'Darjat tertinggi'**
  String get hadisGradeNoteSahih;

  /// No description provided for @hadisGradeNoteHasan.
  ///
  /// In ms, this message translates to:
  /// **'Diterima sebagai hujah'**
  String get hadisGradeNoteHasan;

  /// No description provided for @hadisGradeNoteHasanLi.
  ///
  /// In ms, this message translates to:
  /// **'Hasan kerana sokongan riwayat lain'**
  String get hadisGradeNoteHasanLi;

  /// No description provided for @hadisGradeNoteDhaif.
  ///
  /// In ms, this message translates to:
  /// **'Lemah; tidak dipaparkan'**
  String get hadisGradeNoteDhaif;

  /// No description provided for @hadisGradeNoteMaudhu.
  ///
  /// In ms, this message translates to:
  /// **'Tidak sekali-kali dipaparkan'**
  String get hadisGradeNoteMaudhu;

  /// No description provided for @valWhatThemeName.
  ///
  /// In ms, this message translates to:
  /// **'nama tema (a-z, 0-9, sempang, paling banyak 32 aksara)'**
  String get valWhatThemeName;

  /// No description provided for @valWhatReciter.
  ///
  /// In ms, this message translates to:
  /// **'nama folder qari'**
  String get valWhatReciter;

  /// No description provided for @valWhatCountry.
  ///
  /// In ms, this message translates to:
  /// **'kod negara dua huruf seperti MY'**
  String get valWhatCountry;

  /// No description provided for @valWhatTimezone.
  ///
  /// In ms, this message translates to:
  /// **'zon waktu seperti Asia/Kuala_Lumpur'**
  String get valWhatTimezone;

  /// No description provided for @valWhatZone.
  ///
  /// In ms, this message translates to:
  /// **'kod zon seperti SGR01'**
  String get valWhatZone;

  /// No description provided for @valWhatImageOrEmpty.
  ///
  /// In ms, this message translates to:
  /// **'id gambar atau kosong'**
  String get valWhatImageOrEmpty;

  /// No description provided for @valWhatFundOrEmpty.
  ///
  /// In ms, this message translates to:
  /// **'id tabung atau kosong'**
  String get valWhatFundOrEmpty;

  /// No description provided for @valWhatDateOrEmpty.
  ///
  /// In ms, this message translates to:
  /// **'tarikh YYYY-MM-DD atau kosong'**
  String get valWhatDateOrEmpty;

  /// No description provided for @kindDescPenceramah.
  ///
  /// In ms, this message translates to:
  /// **'Ustaz dan ustazah yang menyampaikan kuliah.'**
  String get kindDescPenceramah;

  /// No description provided for @kindDescKitab.
  ///
  /// In ms, this message translates to:
  /// **'Kitab yang dibaca dalam kuliah.'**
  String get kindDescKitab;

  /// No description provided for @kindDescKuliah.
  ///
  /// In ms, this message translates to:
  /// **'Jadual kuliah yang dipaparkan di TV.'**
  String get kindDescKuliah;

  /// No description provided for @kindDescTicker.
  ///
  /// In ms, this message translates to:
  /// **'Ayat pendek yang bergerak di bawah skrin.'**
  String get kindDescTicker;

  /// No description provided for @kindDescPoster.
  ///
  /// In ms, this message translates to:
  /// **'Gambar penuh skrin yang bergilir di TV.'**
  String get kindDescPoster;

  /// No description provided for @kindDescProgramKhas.
  ///
  /// In ms, this message translates to:
  /// **'Majlis dan program yang akan datang.'**
  String get kindDescProgramKhas;

  /// No description provided for @kindDescTakwim.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh penting dalam kalendar surau.'**
  String get kindDescTakwim;

  /// No description provided for @kindDescWorldTime.
  ///
  /// In ms, this message translates to:
  /// **'Jam bandar lain yang dipaparkan di TV.'**
  String get kindDescWorldTime;

  /// No description provided for @kindDescPetugas.
  ///
  /// In ms, this message translates to:
  /// **'Imam, bilal dan AJK yang bertugas.'**
  String get kindDescPetugas;

  /// No description provided for @kindDescTugasan.
  ///
  /// In ms, this message translates to:
  /// **'Siapa bertugas pada hari mana.'**
  String get kindDescTugasan;

  /// No description provided for @kindDescZikir.
  ///
  /// In ms, this message translates to:
  /// **'Zikir selepas solat, dalam susunan bacaan.'**
  String get kindDescZikir;

  /// No description provided for @kindDescTilawahSlot.
  ///
  /// In ms, this message translates to:
  /// **'Bacaan Al-Quran yang dimainkan sebelum waktu solat.'**
  String get kindDescTilawahSlot;

  /// No description provided for @hadisGradeNoteSahihLi.
  ///
  /// In ms, this message translates to:
  /// **'Sahih kerana sokongan riwayat lain'**
  String get hadisGradeNoteSahihLi;

  /// No description provided for @trustRootMissing.
  ///
  /// In ms, this message translates to:
  /// **'Sijil akar tiada. Daftar semula'**
  String get trustRootMissing;

  /// No description provided for @trustRootInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Sijil akar tidak sah'**
  String get trustRootInvalid;

  /// No description provided for @trustRootMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Sijil akar tidak sepadan'**
  String get trustRootMismatch;

  /// No description provided for @trustCloudFailed.
  ///
  /// In ms, this message translates to:
  /// **'Sambungan selamat ke awan MAXCOM gagal.'**
  String get trustCloudFailed;

  /// No description provided for @trustBadQr.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR pendaftaran tidak sah'**
  String get trustBadQr;

  /// No description provided for @trustRootFetch.
  ///
  /// In ms, this message translates to:
  /// **'Sijil akar tidak dapat diambil dari MAXCOM'**
  String get trustRootFetch;

  /// No description provided for @trustNoHttps.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini belum ada sijil HTTPS'**
  String get trustNoHttps;

  /// No description provided for @imageNotReadable.
  ///
  /// In ms, this message translates to:
  /// **'Fail ini bukan gambar yang boleh dibaca. Pilih fail JPEG, PNG atau WebP.'**
  String get imageNotReadable;

  /// No description provided for @errcWrongPin.
  ///
  /// In ms, this message translates to:
  /// **'PIN salah'**
  String get errcWrongPin;

  /// No description provided for @errcLocked.
  ///
  /// In ms, this message translates to:
  /// **'PIN dikunci. Cuba lagi dalam {minutes} minit.'**
  String errcLocked(int minutes);

  /// No description provided for @errcUnlockFailed.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci tidak berjaya. Cuba lagi.'**
  String get errcUnlockFailed;

  /// No description provided for @errcPinPolicy.
  ///
  /// In ms, this message translates to:
  /// **'PIN mestilah 6 digit dan tidak mudah diteka'**
  String get errcPinPolicy;

  /// No description provided for @errcPinExists.
  ///
  /// In ms, this message translates to:
  /// **'PIN sudah ditetapkan untuk pengguna ini'**
  String get errcPinExists;

  /// No description provided for @errcPinRequired.
  ///
  /// In ms, this message translates to:
  /// **'PIN diperlukan'**
  String get errcPinRequired;

  /// No description provided for @errcPinMissing.
  ///
  /// In ms, this message translates to:
  /// **'PIN belum ditetapkan'**
  String get errcPinMissing;

  /// No description provided for @errcAppLockOff.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi tidak dihidupkan'**
  String get errcAppLockOff;

  /// No description provided for @errcSuspended.
  ///
  /// In ms, this message translates to:
  /// **'Surau ini digantung buat sementara'**
  String get errcSuspended;

  /// No description provided for @errcBadEnrolCode.
  ///
  /// In ms, this message translates to:
  /// **'Kod pendaftaran tidak sah atau sudah digunakan'**
  String get errcBadEnrolCode;

  /// No description provided for @errcOpsAppRequired.
  ///
  /// In ms, this message translates to:
  /// **'Gunakan aplikasi MAXCOM Ops untuk akaun ini'**
  String get errcOpsAppRequired;

  /// No description provided for @errcOpsCliOnly.
  ///
  /// In ms, this message translates to:
  /// **'Pendaftaran ini dibuat melalui awan MAXCOM sahaja'**
  String get errcOpsCliOnly;

  /// No description provided for @errcNotOpsUser.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna ini tiada peranan MAXCOM Ops'**
  String get errcNotOpsUser;

  /// No description provided for @errcOpsDeviceLimit.
  ///
  /// In ms, this message translates to:
  /// **'Had pendaftaran MAXCOM Ops bagi pengguna ini telah dicapai'**
  String get errcOpsDeviceLimit;

  /// No description provided for @errcNotOpsDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini bukan untuk MAXCOM Ops'**
  String get errcNotOpsDevice;

  /// No description provided for @errcBadRequest.
  ///
  /// In ms, this message translates to:
  /// **'Permintaan tidak sah'**
  String get errcBadRequest;

  /// No description provided for @errcBadName.
  ///
  /// In ms, this message translates to:
  /// **'Nama tidak sah'**
  String get errcBadName;

  /// No description provided for @errcBadRoles.
  ///
  /// In ms, this message translates to:
  /// **'Peranan tidak sah'**
  String get errcBadRoles;

  /// No description provided for @errcBadTtl.
  ///
  /// In ms, this message translates to:
  /// **'Tempoh kod tidak sah'**
  String get errcBadTtl;

  /// No description provided for @errcBadDevice.
  ///
  /// In ms, this message translates to:
  /// **'Peranti tidak sah'**
  String get errcBadDevice;

  /// No description provided for @errcBadChoice.
  ///
  /// In ms, this message translates to:
  /// **'Pilihan tidak sah'**
  String get errcBadChoice;

  /// No description provided for @errcUserNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna tidak dijumpai'**
  String get errcUserNotFound;

  /// No description provided for @errcDeviceNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Peranti tidak dijumpai'**
  String get errcDeviceNotFound;

  /// No description provided for @errcNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dijumpai'**
  String get errcNotFound;

  /// No description provided for @errcPairGone.
  ///
  /// In ms, this message translates to:
  /// **'Pasangan skrin ini sudah tamat atau telah digunakan'**
  String get errcPairGone;

  /// No description provided for @errcBadPairCode.
  ///
  /// In ms, this message translates to:
  /// **'Kod pasangan tidak betul'**
  String get errcBadPairCode;

  /// No description provided for @errcKuliahNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Kuliah tidak ditemui'**
  String get errcKuliahNotFound;

  /// No description provided for @errcUploadNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik tidak ditemui'**
  String get errcUploadNotFound;

  /// No description provided for @errcLastAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Mesti ada sekurang-kurangnya seorang Pentadbir yang aktif'**
  String get errcLastAdmin;

  /// No description provided for @errcLastSuperadmin.
  ///
  /// In ms, this message translates to:
  /// **'Mesti ada sekurang-kurangnya seorang Pentadbir MAXCOM yang aktif'**
  String get errcLastSuperadmin;

  /// No description provided for @errcLastAdminDevice.
  ///
  /// In ms, this message translates to:
  /// **'Daftarkan peranti Pentadbir lain dahulu'**
  String get errcLastAdminDevice;

  /// No description provided for @errcRefMismatch.
  ///
  /// In ms, this message translates to:
  /// **'ID pengguna tidak sepadan. Buka semula halaman pengguna dan cuba lagi'**
  String get errcRefMismatch;

  /// No description provided for @errcOwnAccount.
  ///
  /// In ms, this message translates to:
  /// **'Anda tidak boleh memadam akaun sendiri'**
  String get errcOwnAccount;

  /// No description provided for @errcPhoneRequired.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon diperlukan'**
  String get errcPhoneRequired;

  /// No description provided for @errcBadPhone.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon tidak sah'**
  String get errcBadPhone;

  /// No description provided for @errcPhoneTaken.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon ini sudah digunakan oleh pengguna lain'**
  String get errcPhoneTaken;

  /// No description provided for @errcSuperadminCliOnly.
  ///
  /// In ms, this message translates to:
  /// **'Peranan ini hanya boleh diurus melalui CLI MAXCOM'**
  String get errcSuperadminCliOnly;

  /// No description provided for @errcSuperadminCloudOnly.
  ///
  /// In ms, this message translates to:
  /// **'Urus Pentadbir MAXCOM melalui awan MAXCOM'**
  String get errcSuperadminCloudOnly;

  /// No description provided for @errcSuperadminExists.
  ///
  /// In ms, this message translates to:
  /// **'Pentadbir MAXCOM sudah wujud'**
  String get errcSuperadminExists;

  /// No description provided for @errcBoxOnly.
  ///
  /// In ms, this message translates to:
  /// **'Kod peranti mesti dibuat di surau. Gunakan telefon Pentadbir Surau pada Wi-Fi surau.'**
  String get errcBoxOnly;

  /// No description provided for @errcNotEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Surau ini masih ada data dan tidak boleh dipadam'**
  String get errcNotEmpty;

  /// No description provided for @errcModuleOff.
  ///
  /// In ms, this message translates to:
  /// **'Modul ini tidak dihidupkan'**
  String get errcModuleOff;

  /// No description provided for @errcLiveBusy.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung sedang berjalan. Cuba selepas siaran tamat.'**
  String get errcLiveBusy;

  /// No description provided for @errcBadAddress.
  ///
  /// In ms, this message translates to:
  /// **'Alamat kamera tidak sah'**
  String get errcBadAddress;

  /// No description provided for @errcUnknownVideo.
  ///
  /// In ms, this message translates to:
  /// **'Video itu bukan salah satu siaran surau ini'**
  String get errcUnknownVideo;

  /// No description provided for @ra4StopNotYet.
  ///
  /// In ms, this message translates to:
  /// **'Siaran belum berhenti. Cuba lagi.'**
  String get ra4StopNotYet;

  /// No description provided for @ra4StopRetry.
  ///
  /// In ms, this message translates to:
  /// **'Cuba lagi'**
  String get ra4StopRetry;

  /// No description provided for @ra4EndedByBox.
  ///
  /// In ms, this message translates to:
  /// **'Siaran ditamatkan oleh MAXCOM.'**
  String get ra4EndedByBox;

  /// No description provided for @ra4StillLive.
  ///
  /// In ms, this message translates to:
  /// **'Siaran masih berjalan. Buka Siaran langsung untuk menghentikannya.'**
  String get ra4StillLive;

  /// No description provided for @ra4CameraName.
  ///
  /// In ms, this message translates to:
  /// **'Kamera luaran'**
  String get ra4CameraName;

  /// No description provided for @ra4CameraStoppedByIpad.
  ///
  /// In ms, this message translates to:
  /// **'Kamera dihentikan oleh iPad. Buka semula skrin ini.'**
  String get ra4CameraStoppedByIpad;

  /// No description provided for @ra4CamNotRtsp.
  ///
  /// In ms, this message translates to:
  /// **'Alamat mesti bermula dengan rtsp://'**
  String get ra4CamNotRtsp;

  /// No description provided for @ra4CamNotIpv4.
  ///
  /// In ms, this message translates to:
  /// **'Guna alamat IPv4 kamera di rangkaian surau (contoh 10.168.1.20), bukan nama.'**
  String get ra4CamNotIpv4;

  /// No description provided for @ra4CamNotPrivate.
  ///
  /// In ms, this message translates to:
  /// **'Alamat mesti dalam rangkaian persendirian (10.x.x.x, 172.16 hingga 172.31 atau 10.168.x.x).'**
  String get ra4CamNotPrivate;

  /// No description provided for @ra4CamIsBox.
  ///
  /// In ms, this message translates to:
  /// **'Alamat ini ialah MAXCOM sendiri. Masukkan alamat kamera.'**
  String get ra4CamIsBox;

  /// No description provided for @ra4CamBadPort.
  ///
  /// In ms, this message translates to:
  /// **'Port mesti nombor dari 1 hingga 65535.'**
  String get ra4CamBadPort;

  /// No description provided for @ra4CamBadLogin.
  ///
  /// In ms, this message translates to:
  /// **'Nama pengguna atau kata laluan dalam alamat ada aksara yang mesti dikodkan (tulis @ sebagai %40).'**
  String get ra4CamBadLogin;

  /// No description provided for @ra4CamBadPath.
  ///
  /// In ms, this message translates to:
  /// **'Laluan alamat ada aksara yang tidak dibenarkan (ruang, tanda petik atau #).'**
  String get ra4CamBadPath;

  /// No description provided for @ra4CamTooLong.
  ///
  /// In ms, this message translates to:
  /// **'Alamat terlalu panjang (paling banyak 400 aksara).'**
  String get ra4CamTooLong;

  /// No description provided for @errcUnusable.
  ///
  /// In ms, this message translates to:
  /// **'Input audio ini tidak boleh digunakan'**
  String get errcUnusable;

  /// No description provided for @errcCameraError.
  ///
  /// In ms, this message translates to:
  /// **'Kamera tidak dapat diproses'**
  String get errcCameraError;

  /// No description provided for @errcCameraNotConfigured.
  ///
  /// In ms, this message translates to:
  /// **'Kamera belum ditetapkan'**
  String get errcCameraNotConfigured;

  /// No description provided for @errcUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Perkhidmatan tidak tersedia sekarang. Cuba lagi nanti.'**
  String get errcUnavailable;

  /// No description provided for @errcBadClaim.
  ///
  /// In ms, this message translates to:
  /// **'Pendaftaran MAXCOM tidak sah'**
  String get errcBadClaim;

  /// No description provided for @errcWorkerUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat menyemak pendaftaran sekarang. Cuba lagi.'**
  String get errcWorkerUnreachable;

  /// No description provided for @errcClaimPending.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu kelulusan MAXCOM'**
  String get errcClaimPending;

  /// No description provided for @errcBoxRevoked.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini telah dibatalkan oleh awan'**
  String get errcBoxRevoked;

  /// No description provided for @errcYoutubeQuota.
  ///
  /// In ms, this message translates to:
  /// **'Had harian YouTube telah dicapai. Cuba lagi esok.'**
  String get errcYoutubeQuota;

  /// No description provided for @errcYoutubeReauthorise.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube perlu dibuat semula'**
  String get errcYoutubeReauthorise;

  /// No description provided for @errcYoutubeNotConfigured.
  ///
  /// In ms, this message translates to:
  /// **'YouTube belum disediakan'**
  String get errcYoutubeNotConfigured;

  /// No description provided for @errcYoutubeForbidden.
  ///
  /// In ms, this message translates to:
  /// **'YouTube menolak tindakan ini'**
  String get errcYoutubeForbidden;

  /// No description provided for @errcYoutubeNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Video YouTube tidak ditemui'**
  String get errcYoutubeNotFound;

  /// No description provided for @errcYoutubeNetwork.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dapat menghubungi YouTube. Cuba lagi.'**
  String get errcYoutubeNetwork;

  /// No description provided for @errcYoutubeAtBox.
  ///
  /// In ms, this message translates to:
  /// **'Log masuk YouTube kini dibuat pada MAXCOM di surau. Kemas kini aplikasi dan cuba di Wi-Fi surau.'**
  String get errcYoutubeAtBox;

  /// No description provided for @errcCatchupOff.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik rakaman ke YouTube tidak dihidupkan'**
  String get errcCatchupOff;

  /// No description provided for @errcVideoMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Video tidak sepadan dengan muat naik ini'**
  String get errcVideoMismatch;

  /// No description provided for @errcUploadExpired.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik ini sudah tamat tempoh'**
  String get errcUploadExpired;

  /// No description provided for @errcTooManyUploads.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak muat naik sedang berjalan'**
  String get errcTooManyUploads;

  /// No description provided for @errcUnknownLiveVideo.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung itu tidak dikenali'**
  String get errcUnknownLiveVideo;

  /// No description provided for @errcThemeGone.
  ///
  /// In ms, this message translates to:
  /// **'Semakan sudah tamat tempoh. Semak fail sekali lagi.'**
  String get errcThemeGone;

  /// No description provided for @errcThemeInUse.
  ///
  /// In ms, this message translates to:
  /// **'Tema ini sedang digunakan. Pilih tema lain dahulu.'**
  String get errcThemeInUse;

  /// No description provided for @errcThemeBuiltIn.
  ///
  /// In ms, this message translates to:
  /// **'Tema bawaan MAXCOM tidak boleh dipadam'**
  String get errcThemeBuiltIn;

  /// No description provided for @errcContentInUse.
  ///
  /// In ms, this message translates to:
  /// **'Masih digunakan oleh {count} kuliah akan datang'**
  String errcContentInUse(int count);

  /// No description provided for @errcAssetMissing.
  ///
  /// In ms, this message translates to:
  /// **'Gambar itu tidak lagi ada'**
  String get errcAssetMissing;

  /// No description provided for @errcHadisFull.
  ///
  /// In ms, this message translates to:
  /// **'Had hadis sudah dicapai'**
  String get errcHadisFull;

  /// No description provided for @errcEntryExists.
  ///
  /// In ms, this message translates to:
  /// **'Rekod ini sudah wujud'**
  String get errcEntryExists;

  /// No description provided for @errcUncertain.
  ///
  /// In ms, this message translates to:
  /// **'Semak sama ada tindakan itu sudah berlaku'**
  String get errcUncertain;

  /// No description provided for @liveOnlyThemeCheck.
  ///
  /// In ms, this message translates to:
  /// **'Semak fail tema'**
  String get liveOnlyThemeCheck;

  /// No description provided for @liveOnlyThemeInstall.
  ///
  /// In ms, this message translates to:
  /// **'Pasang tema'**
  String get liveOnlyThemeInstall;

  /// No description provided for @liveOnlyThemeDelete.
  ///
  /// In ms, this message translates to:
  /// **'Padam tema'**
  String get liveOnlyThemeDelete;

  /// No description provided for @liveOnlyRecoveryCode.
  ///
  /// In ms, this message translates to:
  /// **'Buat kod pemulihan'**
  String get liveOnlyRecoveryCode;

  /// No description provided for @liveOnlyLeave.
  ///
  /// In ms, this message translates to:
  /// **'Keluar dari surau'**
  String get liveOnlyLeave;

  /// No description provided for @liveOnlyLogout.
  ///
  /// In ms, this message translates to:
  /// **'Log keluar'**
  String get liveOnlyLogout;

  /// No description provided for @errcSurauNotFound.
  ///
  /// In ms, this message translates to:
  /// **'Surau tidak dijumpai'**
  String get errcSurauNotFound;

  /// No description provided for @errcSurauRequired.
  ///
  /// In ms, this message translates to:
  /// **'Surau belum dipilih'**
  String get errcSurauRequired;

  /// No description provided for @errcNotRegistered.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini belum mendaftar atau pendaftarannya sudah tamat'**
  String get errcNotRegistered;

  /// No description provided for @errcCodeMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Kod tuntutan tidak sepadan dengan pendaftaran ini'**
  String get errcCodeMismatch;

  /// No description provided for @errcNoWorker.
  ///
  /// In ms, this message translates to:
  /// **'Perkhidmatan MAXCOM belum ditetapkan pada awan ini'**
  String get errcNoWorker;

  /// No description provided for @errcWorker.
  ///
  /// In ms, this message translates to:
  /// **'Perkhidmatan MAXCOM tidak dapat dihubungi atau menolak permintaan'**
  String get errcWorker;

  /// No description provided for @errcNotLinked.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini sudah dibatalkan'**
  String get errcNotLinked;

  /// No description provided for @errcBadBoxName.
  ///
  /// In ms, this message translates to:
  /// **'Nama MAXCOM mestilah 1 hingga 60 aksara'**
  String get errcBadBoxName;

  /// No description provided for @errcNotSupport.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna ini bukan pengguna Sokongan MAXCOM'**
  String get errcNotSupport;

  /// No description provided for @errcEsolatUnreachable.
  ///
  /// In ms, this message translates to:
  /// **'e-Solat tidak dapat dihubungi sekarang. Cuba lagi.'**
  String get errcEsolatUnreachable;

  /// No description provided for @errcAlreadyLinked.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM ini sudah dipautkan atau diluluskan. Guna Batalkan, bukan Tolak.'**
  String get errcAlreadyLinked;

  /// No description provided for @errcEsolatNoRecord.
  ///
  /// In ms, this message translates to:
  /// **'e-Solat belum menerbitkan waktu solat {year} untuk zon {zone}. Cuba lagi nanti atau import fail CSV.'**
  String errcEsolatNoRecord(int year, String zone);

  /// No description provided for @errcCsvYearMismatch.
  ///
  /// In ms, this message translates to:
  /// **'Fail ini bukan untuk tahun {year} ({from} hingga {to})'**
  String errcCsvYearMismatch(int year, String from, String to);

  /// No description provided for @errcNoOfficialSource.
  ///
  /// In ms, this message translates to:
  /// **'Negara ini tiada sumber rasmi. Gunakan fail atau kiraan.'**
  String get errcNoOfficialSource;

  /// No description provided for @errcUndoBlocked.
  ///
  /// In ms, this message translates to:
  /// **'Import ini tidak boleh dibatalkan kerana hari {date} telah diganti atau dibetulkan pada {by}'**
  String errcUndoBlocked(String date, String by);

  /// No description provided for @ra2Month1.
  ///
  /// In ms, this message translates to:
  /// **'Januari'**
  String get ra2Month1;

  /// No description provided for @ra2Month2.
  ///
  /// In ms, this message translates to:
  /// **'Februari'**
  String get ra2Month2;

  /// No description provided for @ra2Month3.
  ///
  /// In ms, this message translates to:
  /// **'Mac'**
  String get ra2Month3;

  /// No description provided for @ra2Month4.
  ///
  /// In ms, this message translates to:
  /// **'April'**
  String get ra2Month4;

  /// No description provided for @ra2Month5.
  ///
  /// In ms, this message translates to:
  /// **'Mei'**
  String get ra2Month5;

  /// No description provided for @ra2Month6.
  ///
  /// In ms, this message translates to:
  /// **'Jun'**
  String get ra2Month6;

  /// No description provided for @ra2Month7.
  ///
  /// In ms, this message translates to:
  /// **'Julai'**
  String get ra2Month7;

  /// No description provided for @ra2Month8.
  ///
  /// In ms, this message translates to:
  /// **'Ogos'**
  String get ra2Month8;

  /// No description provided for @ra2Month9.
  ///
  /// In ms, this message translates to:
  /// **'September'**
  String get ra2Month9;

  /// No description provided for @ra2Month10.
  ///
  /// In ms, this message translates to:
  /// **'Oktober'**
  String get ra2Month10;

  /// No description provided for @ra2Month11.
  ///
  /// In ms, this message translates to:
  /// **'November'**
  String get ra2Month11;

  /// No description provided for @ra2Month12.
  ///
  /// In ms, this message translates to:
  /// **'Disember'**
  String get ra2Month12;

  /// No description provided for @ra2MonthShort1.
  ///
  /// In ms, this message translates to:
  /// **'Jan'**
  String get ra2MonthShort1;

  /// No description provided for @ra2MonthShort2.
  ///
  /// In ms, this message translates to:
  /// **'Feb'**
  String get ra2MonthShort2;

  /// No description provided for @ra2MonthShort3.
  ///
  /// In ms, this message translates to:
  /// **'Mac'**
  String get ra2MonthShort3;

  /// No description provided for @ra2MonthShort4.
  ///
  /// In ms, this message translates to:
  /// **'Apr'**
  String get ra2MonthShort4;

  /// No description provided for @ra2MonthShort5.
  ///
  /// In ms, this message translates to:
  /// **'Mei'**
  String get ra2MonthShort5;

  /// No description provided for @ra2MonthShort6.
  ///
  /// In ms, this message translates to:
  /// **'Jun'**
  String get ra2MonthShort6;

  /// No description provided for @ra2MonthShort7.
  ///
  /// In ms, this message translates to:
  /// **'Jul'**
  String get ra2MonthShort7;

  /// No description provided for @ra2MonthShort8.
  ///
  /// In ms, this message translates to:
  /// **'Ogos'**
  String get ra2MonthShort8;

  /// No description provided for @ra2MonthShort9.
  ///
  /// In ms, this message translates to:
  /// **'Sep'**
  String get ra2MonthShort9;

  /// No description provided for @ra2MonthShort10.
  ///
  /// In ms, this message translates to:
  /// **'Okt'**
  String get ra2MonthShort10;

  /// No description provided for @ra2MonthShort11.
  ///
  /// In ms, this message translates to:
  /// **'Nov'**
  String get ra2MonthShort11;

  /// No description provided for @ra2MonthShort12.
  ///
  /// In ms, this message translates to:
  /// **'Dis'**
  String get ra2MonthShort12;

  /// No description provided for @ra2Weekday1.
  ///
  /// In ms, this message translates to:
  /// **'Isnin'**
  String get ra2Weekday1;

  /// No description provided for @ra2Weekday2.
  ///
  /// In ms, this message translates to:
  /// **'Selasa'**
  String get ra2Weekday2;

  /// No description provided for @ra2Weekday3.
  ///
  /// In ms, this message translates to:
  /// **'Rabu'**
  String get ra2Weekday3;

  /// No description provided for @ra2Weekday4.
  ///
  /// In ms, this message translates to:
  /// **'Khamis'**
  String get ra2Weekday4;

  /// No description provided for @ra2Weekday5.
  ///
  /// In ms, this message translates to:
  /// **'Jumaat'**
  String get ra2Weekday5;

  /// No description provided for @ra2Weekday6.
  ///
  /// In ms, this message translates to:
  /// **'Sabtu'**
  String get ra2Weekday6;

  /// No description provided for @ra2Weekday7.
  ///
  /// In ms, this message translates to:
  /// **'Ahad'**
  String get ra2Weekday7;

  /// No description provided for @ra2WeekdayShort1.
  ///
  /// In ms, this message translates to:
  /// **'Isn'**
  String get ra2WeekdayShort1;

  /// No description provided for @ra2WeekdayShort2.
  ///
  /// In ms, this message translates to:
  /// **'Sel'**
  String get ra2WeekdayShort2;

  /// No description provided for @ra2WeekdayShort3.
  ///
  /// In ms, this message translates to:
  /// **'Rab'**
  String get ra2WeekdayShort3;

  /// No description provided for @ra2WeekdayShort4.
  ///
  /// In ms, this message translates to:
  /// **'Kha'**
  String get ra2WeekdayShort4;

  /// No description provided for @ra2WeekdayShort5.
  ///
  /// In ms, this message translates to:
  /// **'Jum'**
  String get ra2WeekdayShort5;

  /// No description provided for @ra2WeekdayShort6.
  ///
  /// In ms, this message translates to:
  /// **'Sab'**
  String get ra2WeekdayShort6;

  /// No description provided for @ra2WeekdayShort7.
  ///
  /// In ms, this message translates to:
  /// **'Ahd'**
  String get ra2WeekdayShort7;

  /// No description provided for @ra2PrayerImsak.
  ///
  /// In ms, this message translates to:
  /// **'Imsak'**
  String get ra2PrayerImsak;

  /// No description provided for @ra2PrayerSubuh.
  ///
  /// In ms, this message translates to:
  /// **'Subuh'**
  String get ra2PrayerSubuh;

  /// No description provided for @ra2PrayerSyuruk.
  ///
  /// In ms, this message translates to:
  /// **'Syuruk'**
  String get ra2PrayerSyuruk;

  /// No description provided for @ra2PrayerZohor.
  ///
  /// In ms, this message translates to:
  /// **'Zohor'**
  String get ra2PrayerZohor;

  /// No description provided for @ra2PrayerAsar.
  ///
  /// In ms, this message translates to:
  /// **'Asar'**
  String get ra2PrayerAsar;

  /// No description provided for @ra2PrayerMaghrib.
  ///
  /// In ms, this message translates to:
  /// **'Maghrib'**
  String get ra2PrayerMaghrib;

  /// No description provided for @ra2PrayerIsyak.
  ///
  /// In ms, this message translates to:
  /// **'Isyak'**
  String get ra2PrayerIsyak;

  /// No description provided for @ra2PrayerDhuha.
  ///
  /// In ms, this message translates to:
  /// **'Dhuha'**
  String get ra2PrayerDhuha;

  /// No description provided for @ra2MethodMwl.
  ///
  /// In ms, this message translates to:
  /// **'Liga Dunia Islam'**
  String get ra2MethodMwl;

  /// No description provided for @ra2MethodEgyptian.
  ///
  /// In ms, this message translates to:
  /// **'Mesir'**
  String get ra2MethodEgyptian;

  /// No description provided for @ra2MethodKarachi.
  ///
  /// In ms, this message translates to:
  /// **'Karachi'**
  String get ra2MethodKarachi;

  /// No description provided for @ra2MethodUmmAlQura.
  ///
  /// In ms, this message translates to:
  /// **'Umm al-Qura'**
  String get ra2MethodUmmAlQura;

  /// No description provided for @ra2MethodDubai.
  ///
  /// In ms, this message translates to:
  /// **'Dubai'**
  String get ra2MethodDubai;

  /// No description provided for @ra2MethodQatar.
  ///
  /// In ms, this message translates to:
  /// **'Qatar'**
  String get ra2MethodQatar;

  /// No description provided for @ra2MethodKuwait.
  ///
  /// In ms, this message translates to:
  /// **'Kuwait'**
  String get ra2MethodKuwait;

  /// No description provided for @ra2MethodMoonsighting.
  ///
  /// In ms, this message translates to:
  /// **'Jawatankuasa Moonsighting'**
  String get ra2MethodMoonsighting;

  /// No description provided for @ra2MethodSingapore.
  ///
  /// In ms, this message translates to:
  /// **'Singapura'**
  String get ra2MethodSingapore;

  /// No description provided for @ra2MethodTehran.
  ///
  /// In ms, this message translates to:
  /// **'Tehran'**
  String get ra2MethodTehran;

  /// No description provided for @ra2MethodTurkey.
  ///
  /// In ms, this message translates to:
  /// **'Turki (Diyanet)'**
  String get ra2MethodTurkey;

  /// No description provided for @ra2MethodNorthAmerica.
  ///
  /// In ms, this message translates to:
  /// **'Amerika Utara (ISNA)'**
  String get ra2MethodNorthAmerica;

  /// No description provided for @ra2MethodJakim.
  ///
  /// In ms, this message translates to:
  /// **'JAKIM 18/18'**
  String get ra2MethodJakim;

  /// No description provided for @ra2MethodKemenag.
  ///
  /// In ms, this message translates to:
  /// **'Kemenag Indonesia 20/18'**
  String get ra2MethodKemenag;

  /// No description provided for @ra2MethodUoif.
  ///
  /// In ms, this message translates to:
  /// **'UOIF Perancis 12/12'**
  String get ra2MethodUoif;

  /// No description provided for @ra2MethodMorocco.
  ///
  /// In ms, this message translates to:
  /// **'Maghribi 19/17'**
  String get ra2MethodMorocco;

  /// No description provided for @ra2MethodAlgeria.
  ///
  /// In ms, this message translates to:
  /// **'Algeria 18/17'**
  String get ra2MethodAlgeria;

  /// No description provided for @ra2MethodRussia.
  ///
  /// In ms, this message translates to:
  /// **'Rusia 16/15'**
  String get ra2MethodRussia;

  /// No description provided for @ra2WarnNoDataToday.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data waktu solat untuk hari ini'**
  String get ra2WarnNoDataToday;

  /// No description provided for @ra2WarnNotLocated.
  ///
  /// In ms, this message translates to:
  /// **'Lokasi surau belum ditetapkan; waktu solat tidak dapat dikira'**
  String get ra2WarnNotLocated;

  /// No description provided for @ra2WarnEmergencyToday.
  ///
  /// In ms, this message translates to:
  /// **'Hari ini guna kiraan sementara'**
  String get ra2WarnEmergencyToday;

  /// No description provided for @ra2WarnZoneNoDataFetch.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data untuk zon ini; MAXCOM akan memuat turun'**
  String get ra2WarnZoneNoDataFetch;

  /// No description provided for @ra2WarnZoneNoDataManual.
  ///
  /// In ms, this message translates to:
  /// **'Tiada data untuk zon ini; muat naik data atau hidupkan muat turun automatik'**
  String get ra2WarnZoneNoDataManual;

  /// No description provided for @ra2FieldDate.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh'**
  String get ra2FieldDate;

  /// No description provided for @ra2RowMissingColumn.
  ///
  /// In ms, this message translates to:
  /// **'Lajur {field} tiada'**
  String ra2RowMissingColumn(String field);

  /// No description provided for @ra2RowMasjidOnly.
  ///
  /// In ms, this message translates to:
  /// **'Lajur {field} untuk masjid sahaja'**
  String ra2RowMasjidOnly(String field);

  /// No description provided for @ra2RowEmpty.
  ///
  /// In ms, this message translates to:
  /// **'{field} kosong'**
  String ra2RowEmpty(String field);

  /// No description provided for @ra2RowInvalid.
  ///
  /// In ms, this message translates to:
  /// **'{field} tidak sah'**
  String ra2RowInvalid(String field);

  /// No description provided for @ra2RowOutOfRange.
  ///
  /// In ms, this message translates to:
  /// **'{field} di luar had'**
  String ra2RowOutOfRange(String field);

  /// No description provided for @ra2RowDuplicate.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh berulang'**
  String get ra2RowDuplicate;

  /// No description provided for @ra2RowBeforeMidnight.
  ///
  /// In ms, this message translates to:
  /// **'Imsak terbitan jatuh sebelum tengah malam'**
  String get ra2RowBeforeMidnight;

  /// No description provided for @ra2RowOrder.
  ///
  /// In ms, this message translates to:
  /// **'Waktu tidak mengikut turutan'**
  String get ra2RowOrder;

  /// No description provided for @ra2RowNoRows.
  ///
  /// In ms, this message translates to:
  /// **'Tiada baris waktu solat dalam fail'**
  String get ra2RowNoRows;

  /// No description provided for @ra2RowTooMany.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak baris dalam fail'**
  String get ra2RowTooMany;

  /// No description provided for @ra2RowGap.
  ///
  /// In ms, this message translates to:
  /// **'Ada tarikh yang tiada sebelum baris ini'**
  String get ra2RowGap;

  /// No description provided for @ra2CsvRecorded.
  ///
  /// In ms, this message translates to:
  /// **'Dicatat dalam Rekod import; boleh dibatalkan di sana.'**
  String get ra2CsvRecorded;

  /// No description provided for @ra2NoOfficialCard.
  ///
  /// In ms, this message translates to:
  /// **'Negara ini tiada sumber rasmi. Muat naik fail atau guna kiraan.'**
  String get ra2NoOfficialCard;

  /// No description provided for @valRange.
  ///
  /// In ms, this message translates to:
  /// **'{min} hingga {max}'**
  String valRange(int min, int max);

  /// No description provided for @contentRefDeleted.
  ///
  /// In ms, this message translates to:
  /// **'{what} dipadam'**
  String contentRefDeleted(String what);

  /// No description provided for @contentInUseDates.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh: {dates}'**
  String contentInUseDates(String dates);

  /// No description provided for @errcAlreadyVoided.
  ///
  /// In ms, this message translates to:
  /// **'Catatan ini sudah dibatalkan'**
  String get errcAlreadyVoided;

  /// No description provided for @errcOpeningExists.
  ///
  /// In ms, this message translates to:
  /// **'Baki awal tabung ini sudah ada'**
  String get errcOpeningExists;

  /// No description provided for @errcOpeningFundFixed.
  ///
  /// In ms, this message translates to:
  /// **'Baki awal tidak boleh dipindahkan ke tabung lain'**
  String get errcOpeningFundFixed;

  /// No description provided for @ra3MonthNames.
  ///
  /// In ms, this message translates to:
  /// **'Januari|Februari|Mac|April|Mei|Jun|Julai|Ogos|September|Oktober|November|Disember'**
  String get ra3MonthNames;

  /// No description provided for @ra3LateEntries.
  ///
  /// In ms, this message translates to:
  /// **'{n} rekod masuk selepas bulan ini ditutup'**
  String ra3LateEntries(int n);

  /// No description provided for @ra3AskAdminClose.
  ///
  /// In ms, this message translates to:
  /// **'Minta Pentadbir menutup bulan ini'**
  String get ra3AskAdminClose;

  /// No description provided for @ra3ClosedMonthToday.
  ///
  /// In ms, this message translates to:
  /// **'Bulan kuliah ini sudah ditutup. Bayaran dicatat pada tarikh hari ini.'**
  String get ra3ClosedMonthToday;

  /// No description provided for @ra3DateClosedNote.
  ///
  /// In ms, this message translates to:
  /// **'Bulan yang sudah ditutup tidak boleh dipilih.'**
  String get ra3DateClosedNote;

  /// No description provided for @ra3LateEntriesShow.
  ///
  /// In ms, this message translates to:
  /// **'Lihat rekod'**
  String get ra3LateEntriesShow;

  /// No description provided for @ra5CodeUnknown.
  ///
  /// In ms, this message translates to:
  /// **'Kod tidak dikenali'**
  String get ra5CodeUnknown;

  /// No description provided for @ra5CodeUnknownBody.
  ///
  /// In ms, this message translates to:
  /// **'Semak kod yang ditaip, atau minta Pentadbir menjana kod baharu.'**
  String get ra5CodeUnknownBody;

  /// No description provided for @ra5CodeInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Ini bukan kod pendaftaran MAXCOM. Imbas semula kod QR atau tampal seluruh teksnya.'**
  String get ra5CodeInvalid;

  /// No description provided for @ra5UnlockTooMany.
  ///
  /// In ms, this message translates to:
  /// **'Terlalu banyak percubaan. Cuba lagi dalam {minutes} minit'**
  String ra5UnlockTooMany(int minutes);

  /// No description provided for @ra5OfflineClosed.
  ///
  /// In ms, this message translates to:
  /// **'Kunci luar talian ditutup. Sambung ke MAXCOM untuk membuka.'**
  String get ra5OfflineClosed;

  /// No description provided for @ra5RoleSupport.
  ///
  /// In ms, this message translates to:
  /// **'Sokongan MAXCOM'**
  String get ra5RoleSupport;

  /// No description provided for @ra5ListSeparator.
  ///
  /// In ms, this message translates to:
  /// **', '**
  String get ra5ListSeparator;

  /// No description provided for @ra5SealCheckFailed.
  ///
  /// In ms, this message translates to:
  /// **'PIN tidak dapat disemak sekarang. Sambung ke MAXCOM dan cuba lagi.'**
  String get ra5SealCheckFailed;

  /// No description provided for @ra5LeaveHint.
  ///
  /// In ms, this message translates to:
  /// **'Keluar dari surau ialah satu-satunya cara memadam peranti ini. Pentadbir terakhir mesti mendaftar peranti Pentadbir lain dahulu.'**
  String get ra5LeaveHint;

  /// No description provided for @ra6SyncErrorChip.
  ///
  /// In ms, this message translates to:
  /// **'Ralat penyelarasan'**
  String get ra6SyncErrorChip;

  /// No description provided for @ra6SyncErrorShort.
  ///
  /// In ms, this message translates to:
  /// **'Ralat'**
  String get ra6SyncErrorShort;

  /// No description provided for @ra6RefusedMonthClosed.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: bulan sudah ditutup'**
  String get ra6RefusedMonthClosed;

  /// No description provided for @ra6RefusedFundArchived.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: tabung telah diarkibkan'**
  String get ra6RefusedFundArchived;

  /// No description provided for @ra6RefusedAlreadyVoided.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: catatan sudah dibatalkan'**
  String get ra6RefusedAlreadyVoided;

  /// No description provided for @ra6RefusedOpeningExists.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: baki permulaan sudah ada'**
  String get ra6RefusedOpeningExists;

  /// No description provided for @ra6RefusedBlobMissing.
  ///
  /// In ms, this message translates to:
  /// **'Gambar tidak lagi ada pada peranti ini'**
  String get ra6RefusedBlobMissing;

  /// No description provided for @ra6RefusedUserInactive.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: pengguna tidak aktif'**
  String get ra6RefusedUserInactive;

  /// No description provided for @ra6RefusedLastAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak: mesti ada sekurang-kurangnya seorang Pentadbir'**
  String get ra6RefusedLastAdmin;

  /// No description provided for @ra6Rejected.
  ///
  /// In ms, this message translates to:
  /// **'Ditolak'**
  String get ra6Rejected;

  /// No description provided for @ra6CopyDetails.
  ///
  /// In ms, this message translates to:
  /// **'Salin butiran'**
  String get ra6CopyDetails;

  /// No description provided for @ra6DetailsCopied.
  ///
  /// In ms, this message translates to:
  /// **'Butiran disalin'**
  String get ra6DetailsCopied;

  /// No description provided for @ra6ConflictPartial.
  ///
  /// In ms, this message translates to:
  /// **'Sebahagian tetapan tidak disimpan kerana ada perubahan yang lebih baharu: {names}'**
  String ra6ConflictPartial(String names);

  /// No description provided for @ra6ConflictEntityFinance.
  ///
  /// In ms, this message translates to:
  /// **'Catatan kewangan'**
  String get ra6ConflictEntityFinance;

  /// No description provided for @ra6SettingsSavedQueued.
  ///
  /// In ms, this message translates to:
  /// **'Disimpan di peranti ini, menunggu penyelarasan'**
  String get ra6SettingsSavedQueued;

  /// No description provided for @ra6AppLockNeedsBox.
  ///
  /// In ms, this message translates to:
  /// **'Perlukan sambungan ke MAXCOM'**
  String get ra6AppLockNeedsBox;

  /// No description provided for @ra6RangeTo.
  ///
  /// In ms, this message translates to:
  /// **'{min} hingga {max}'**
  String ra6RangeTo(String min, String max);

  /// No description provided for @ra6FeatureNeeds.
  ///
  /// In ms, this message translates to:
  /// **'Perlu {name} dihidupkan dahulu'**
  String ra6FeatureNeeds(String name);

  /// No description provided for @ra6TplLabel.
  ///
  /// In ms, this message translates to:
  /// **'Label kuliah'**
  String get ra6TplLabel;

  /// No description provided for @ra6TplSpeaker.
  ///
  /// In ms, this message translates to:
  /// **'Penceramah'**
  String get ra6TplSpeaker;

  /// No description provided for @ra6TplTopic.
  ///
  /// In ms, this message translates to:
  /// **'Topik'**
  String get ra6TplTopic;

  /// No description provided for @ra6TplBook.
  ///
  /// In ms, this message translates to:
  /// **'Kitab'**
  String get ra6TplBook;

  /// No description provided for @ra6TplSurau.
  ///
  /// In ms, this message translates to:
  /// **'Nama surau'**
  String get ra6TplSurau;

  /// No description provided for @ra6TplDate.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh'**
  String get ra6TplDate;

  /// No description provided for @ra6TplTime.
  ///
  /// In ms, this message translates to:
  /// **'Masa'**
  String get ra6TplTime;

  /// No description provided for @ra6LiveBadge.
  ///
  /// In ms, this message translates to:
  /// **'LANGSUNG'**
  String get ra6LiveBadge;

  /// No description provided for @ra6LinkCloudError.
  ///
  /// In ms, this message translates to:
  /// **'Awan MAXCOM: ralat penyelarasan'**
  String get ra6LinkCloudError;

  /// No description provided for @ra6LinkBoxError.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau: ralat'**
  String get ra6LinkBoxError;

  /// No description provided for @liveNoticeShare.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi pautan'**
  String get liveNoticeShare;

  /// No description provided for @liveNoticeTitle.
  ///
  /// In ms, this message translates to:
  /// **'Makluman siaran langsung'**
  String get liveNoticeTitle;

  /// No description provided for @liveNoticeEditHint.
  ///
  /// In ms, this message translates to:
  /// **'Semak dan ubah teks sebelum dikongsi.'**
  String get liveNoticeEditHint;

  /// No description provided for @liveNoticeToOne.
  ///
  /// In ms, this message translates to:
  /// **'Hantar kepada seorang'**
  String get liveNoticeToOne;

  /// No description provided for @liveNoticeReset.
  ///
  /// In ms, this message translates to:
  /// **'Kembalikan teks asal'**
  String get liveNoticeReset;

  /// No description provided for @liveNoticePickTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hantar kepada siapa?'**
  String get liveNoticePickTitle;

  /// No description provided for @liveNoticePickSearch.
  ///
  /// In ms, this message translates to:
  /// **'Cari nama'**
  String get liveNoticePickSearch;

  /// No description provided for @liveNoticePickEmpty.
  ///
  /// In ms, this message translates to:
  /// **'Tiada pengguna dijumpai.'**
  String get liveNoticePickEmpty;

  /// No description provided for @liveNoticeStarted.
  ///
  /// In ms, this message translates to:
  /// **'Siaran sedang berlangsung.'**
  String get liveNoticeStarted;

  /// No description provided for @liveNoticeShareGo.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi'**
  String get liveNoticeShareGo;

  /// No description provided for @liveNoticeCardBadge.
  ///
  /// In ms, this message translates to:
  /// **'SIARAN LANGSUNG'**
  String get liveNoticeCardBadge;

  /// No description provided for @liveNoticePictureFailed.
  ///
  /// In ms, this message translates to:
  /// **'Gambar tidak dapat disediakan. Teks sahaja dikongsi.'**
  String get liveNoticePictureFailed;

  /// No description provided for @liveNoticeCopiedCaption.
  ///
  /// In ms, this message translates to:
  /// **'Teks disalin, tampal sebagai kapsyen jika teks tidak muncul'**
  String get liveNoticeCopiedCaption;

  /// No description provided for @liveNoticeQrHint.
  ///
  /// In ms, this message translates to:
  /// **'Imbas dengan kamera telefon. WhatsApp akan dibuka dengan mesej ini.'**
  String get liveNoticeQrHint;

  /// No description provided for @liveNoticeEditDone.
  ///
  /// In ms, this message translates to:
  /// **'Siap'**
  String get liveNoticeEditDone;

  /// No description provided for @liveNoticeEditText.
  ///
  /// In ms, this message translates to:
  /// **'Ubah teks'**
  String get liveNoticeEditText;

  /// No description provided for @liveNoticeNoPicture.
  ///
  /// In ms, this message translates to:
  /// **'Tanpa gambar'**
  String get liveNoticeNoPicture;

  /// No description provided for @liveNoticeMore.
  ///
  /// In ms, this message translates to:
  /// **'Lagi'**
  String get liveNoticeMore;

  /// No description provided for @liveNoticeToSelf.
  ///
  /// In ms, this message translates to:
  /// **'Hantar kepada diri sendiri'**
  String get liveNoticeToSelf;

  /// No description provided for @liveNoticeCopy.
  ///
  /// In ms, this message translates to:
  /// **'Salin teks'**
  String get liveNoticeCopy;

  /// No description provided for @liveNoticeFromPhone.
  ///
  /// In ms, this message translates to:
  /// **'Hantar dari telefon'**
  String get liveNoticeFromPhone;

  /// No description provided for @liveNoticeWhatsApp.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi ke WhatsApp'**
  String get liveNoticeWhatsApp;

  /// No description provided for @liveNoticeCopied.
  ///
  /// In ms, this message translates to:
  /// **'Teks disalin. Tampalkan di WhatsApp.'**
  String get liveNoticeCopied;

  /// No description provided for @liveNoticeShareFailed.
  ///
  /// In ms, this message translates to:
  /// **'Teks tidak dapat dikongsi.'**
  String get liveNoticeShareFailed;

  /// No description provided for @liveNoticeEditedBy.
  ///
  /// In ms, this message translates to:
  /// **'Diubah oleh {name}, {time}'**
  String liveNoticeEditedBy(String name, String time);

  /// No description provided for @liveNoticeChangedMeanwhile.
  ///
  /// In ms, this message translates to:
  /// **'Teks telah diubah oleh orang lain. Teks terkini ditunjukkan, semak sebelum dikongsi.'**
  String get liveNoticeChangedMeanwhile;

  /// No description provided for @waOpensTo.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp dibuka terus ke {number}'**
  String waOpensTo(String number);

  /// No description provided for @liveNoticeOpenGo.
  ///
  /// In ms, this message translates to:
  /// **'Buka WhatsApp'**
  String get liveNoticeOpenGo;

  /// No description provided for @liveNoticeWhatsAppFailed.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp tidak dapat dibuka.'**
  String get liveNoticeWhatsAppFailed;

  /// No description provided for @peopleNeedsUpdate.
  ///
  /// In ms, this message translates to:
  /// **'Kemas kini MAX Kiosk Server untuk fungsi ini'**
  String get peopleNeedsUpdate;

  /// No description provided for @peopleFlagsBoxOnly.
  ///
  /// In ms, this message translates to:
  /// **'Status aktif ditunjukkan apabila anda di Wi-Fi surau.'**
  String get peopleFlagsBoxOnly;

  /// No description provided for @peopleNeedsAction.
  ///
  /// In ms, this message translates to:
  /// **'Perlu tindakan'**
  String get peopleNeedsAction;

  /// No description provided for @peopleNoAdminPhone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada Pentadbir mempunyai telefon yang aktif. Daftarkan telefon Pentadbir.'**
  String get peopleNoAdminPhone;

  /// No description provided for @peopleActiveToday.
  ///
  /// In ms, this message translates to:
  /// **'aktif hari ini'**
  String get peopleActiveToday;

  /// No description provided for @peopleActiveYesterday.
  ///
  /// In ms, this message translates to:
  /// **'aktif semalam'**
  String get peopleActiveYesterday;

  /// No description provided for @peopleActiveDaysAgo.
  ///
  /// In ms, this message translates to:
  /// **'aktif {n} hari lalu'**
  String peopleActiveDaysAgo(int n);

  /// No description provided for @peopleUnusedDays.
  ///
  /// In ms, this message translates to:
  /// **'tidak digunakan {n} hari'**
  String peopleUnusedDays(int n);

  /// No description provided for @peopleInactiveBadge.
  ///
  /// In ms, this message translates to:
  /// **'Tidak aktif'**
  String get peopleInactiveBadge;

  /// No description provided for @usersAllActive.
  ///
  /// In ms, this message translates to:
  /// **'Semua pengguna aktif ({n})'**
  String usersAllActive(int n);

  /// No description provided for @usersDeviceCount.
  ///
  /// In ms, this message translates to:
  /// **'{n, plural, =0{Belum ada peranti} other{{n} peranti}}'**
  String usersDeviceCount(int n);

  /// No description provided for @usersNoDeviceYet.
  ///
  /// In ms, this message translates to:
  /// **'Ditambah {n} hari lalu, belum daftar telefon'**
  String usersNoDeviceYet(int n);

  /// No description provided for @usersQrButton.
  ///
  /// In ms, this message translates to:
  /// **'Kod QR'**
  String get usersQrButton;

  /// No description provided for @usersUnlock.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci'**
  String get usersUnlock;

  /// No description provided for @usersUnlocked.
  ///
  /// In ms, this message translates to:
  /// **'PIN {name} dibuka. PIN tidak berubah.'**
  String usersUnlocked(String name);

  /// No description provided for @usersLockedUntil.
  ///
  /// In ms, this message translates to:
  /// **'PIN dikunci sehingga {time}. Kunci tamat sendiri, atau buka sekarang.'**
  String usersLockedUntil(String time);

  /// No description provided for @usersSuggestDeactivate.
  ///
  /// In ms, this message translates to:
  /// **'{name} tidak menggunakan aplikasi lebih 90 hari. Nyahaktifkan?'**
  String usersSuggestDeactivate(String name);

  /// No description provided for @usersDeactivatedFold.
  ///
  /// In ms, this message translates to:
  /// **'Dinyahaktifkan ({n})'**
  String usersDeactivatedFold(int n);

  /// No description provided for @usersDeactivatedHint.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh buka kunci. Nama kekal dalam rekod lama.'**
  String get usersDeactivatedHint;

  /// No description provided for @usersDeactivatedOn.
  ///
  /// In ms, this message translates to:
  /// **'Dinyahaktifkan {date}'**
  String usersDeactivatedOn(String date);

  /// No description provided for @usersAutoDeleteIn.
  ///
  /// In ms, this message translates to:
  /// **'{n, plural, =0{Dipadam automatik hari ini} =1{Dipadam automatik dalam 1 hari} other{Dipadam automatik dalam {n} hari}}'**
  String usersAutoDeleteIn(int n);

  /// No description provided for @usersActivate.
  ///
  /// In ms, this message translates to:
  /// **'Aktifkan semula'**
  String get usersActivate;

  /// No description provided for @usersActivated.
  ///
  /// In ms, this message translates to:
  /// **'{name} diaktifkan semula. Daftar telefon dengan kod QR baharu.'**
  String usersActivated(String name);

  /// No description provided for @usersRecoveryFold.
  ///
  /// In ms, this message translates to:
  /// **'Kod pemulihan'**
  String get usersRecoveryFold;

  /// No description provided for @usersRecoveryHint.
  ///
  /// In ms, this message translates to:
  /// **'Untuk masuk semula jika semua telefon Pentadbir hilang'**
  String get usersRecoveryHint;

  /// No description provided for @usersRolesFold.
  ///
  /// In ms, this message translates to:
  /// **'Apa setiap peranan boleh buat'**
  String get usersRolesFold;

  /// No description provided for @usersHintDismiss.
  ///
  /// In ms, this message translates to:
  /// **'Tutup'**
  String get usersHintDismiss;

  /// No description provided for @userRename.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama'**
  String get userRename;

  /// No description provided for @userRenameTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama'**
  String get userRenameTitle;

  /// No description provided for @userRenameBody.
  ///
  /// In ms, this message translates to:
  /// **'Nama baharu dipakai mulai sekarang di aplikasi dan senarai.'**
  String get userRenameBody;

  /// No description provided for @userRenameHistory.
  ///
  /// In ms, this message translates to:
  /// **'Rekod lama tidak berubah. Log perubahan dan kewangan terus menunjukkan nama yang dipakai pada masa itu.'**
  String get userRenameHistory;

  /// No description provided for @userRenameSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan nama'**
  String get userRenameSave;

  /// No description provided for @userRenamed.
  ///
  /// In ms, this message translates to:
  /// **'Nama ditukar kepada {name}.'**
  String userRenamed(String name);

  /// No description provided for @userNameTaken.
  ///
  /// In ms, this message translates to:
  /// **'Sudah ada pengguna bernama {name}. Simpan juga?'**
  String userNameTaken(String name);

  /// No description provided for @nameInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Nama mesti 1 hingga 80 aksara'**
  String get nameInvalid;

  /// No description provided for @userDevicesOf.
  ///
  /// In ms, this message translates to:
  /// **'Peranti {name} ({n})'**
  String userDevicesOf(String name, int n);

  /// No description provided for @userAddedBy.
  ///
  /// In ms, this message translates to:
  /// **'Ditambah {date} oleh {name}'**
  String userAddedBy(String date, String name);

  /// No description provided for @deviceEdit.
  ///
  /// In ms, this message translates to:
  /// **'Ubah'**
  String get deviceEdit;

  /// No description provided for @deviceNameLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nama peranti'**
  String get deviceNameLabel;

  /// No description provided for @deviceNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: Telefon Ustaz Ahmad, iPad meja bendahari'**
  String get deviceNameHint;

  /// No description provided for @deviceRenameHistory.
  ///
  /// In ms, this message translates to:
  /// **'Log perubahan lama kekal dengan nama lama peranti ini.'**
  String get deviceRenameHistory;

  /// No description provided for @deviceRenamed.
  ///
  /// In ms, this message translates to:
  /// **'Nama peranti disimpan.'**
  String get deviceRenamed;

  /// No description provided for @deviceOwnedBy.
  ///
  /// In ms, this message translates to:
  /// **'Milik {name}. {platform}, didaftarkan {date}'**
  String deviceOwnedBy(String name, String platform, String date);

  /// No description provided for @deviceRemoveThis.
  ///
  /// In ms, this message translates to:
  /// **'Padam peranti ini'**
  String get deviceRemoveThis;

  /// No description provided for @deviceRemoveHint.
  ///
  /// In ms, this message translates to:
  /// **'Peranti ini tidak lagi boleh membuka aplikasi. Untuk guna semula, daftar dengan kod QR baharu.'**
  String get deviceRemoveHint;

  /// No description provided for @devicesUnusedCard.
  ///
  /// In ms, this message translates to:
  /// **'{n} peranti tidak digunakan lebih 60 hari'**
  String devicesUnusedCard(int n);

  /// No description provided for @devicesUnusedHint.
  ///
  /// In ms, this message translates to:
  /// **'Rekod lama kekal. Pemiliknya boleh mendaftar semula dengan kod QR baharu.'**
  String get devicesUnusedHint;

  /// No description provided for @devicesRemoveAll.
  ///
  /// In ms, this message translates to:
  /// **'Padam semua'**
  String get devicesRemoveAll;

  /// No description provided for @devicesRemoveAllConfirm.
  ///
  /// In ms, this message translates to:
  /// **'Padam {n} peranti yang tidak digunakan?'**
  String devicesRemoveAllConfirm(int n);

  /// No description provided for @devicesRemovedSome.
  ///
  /// In ms, this message translates to:
  /// **'{n} dipadam, {m} dilangkau'**
  String devicesRemovedSome(int n, int m);

  /// No description provided for @devicesSkipOwn.
  ///
  /// In ms, this message translates to:
  /// **'peranti ini sendiri'**
  String get devicesSkipOwn;

  /// No description provided for @devicesSkipInUse.
  ///
  /// In ms, this message translates to:
  /// **'baru digunakan'**
  String get devicesSkipInUse;

  /// No description provided for @devicesSkipLastAdmin.
  ///
  /// In ms, this message translates to:
  /// **'telefon Pentadbir terakhir'**
  String get devicesSkipLastAdmin;

  /// No description provided for @devicesLastAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Daftar peranti Pentadbir lain dahulu'**
  String get devicesLastAdmin;

  /// No description provided for @devicesOpenCodes.
  ///
  /// In ms, this message translates to:
  /// **'Kod belum digunakan ({n})'**
  String devicesOpenCodes(int n);

  /// No description provided for @devicesCodeExpiresIn.
  ///
  /// In ms, this message translates to:
  /// **'{device}, tamat dalam {n} minit'**
  String devicesCodeExpiresIn(String device, int n);

  /// No description provided for @devicesEndCode.
  ///
  /// In ms, this message translates to:
  /// **'Tamatkan kod'**
  String get devicesEndCode;

  /// No description provided for @devicesCodeEnded.
  ///
  /// In ms, this message translates to:
  /// **'Kod ditamatkan.'**
  String get devicesCodeEnded;

  /// No description provided for @devicesRemovedNote.
  ///
  /// In ms, this message translates to:
  /// **'Peranti yang dipadam hilang dari senarai serta-merta. Catatannya kekal dalam Log perubahan.'**
  String get devicesRemovedNote;

  /// No description provided for @tvBoxTitle.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM di surau'**
  String get tvBoxTitle;

  /// No description provided for @tvExtraScreens.
  ///
  /// In ms, this message translates to:
  /// **'Skrin tambahan ({n})'**
  String tvExtraScreens(int n);

  /// No description provided for @tvPairedSeen.
  ///
  /// In ms, this message translates to:
  /// **'Dipadankan {date}, dilihat {ago}'**
  String tvPairedSeen(String date, String ago);

  /// No description provided for @tvNotSeenDays.
  ///
  /// In ms, this message translates to:
  /// **'Tidak dilihat {n} hari'**
  String tvNotSeenDays(int n);

  /// No description provided for @tvPairNew.
  ///
  /// In ms, this message translates to:
  /// **'Padankan skrin baharu'**
  String get tvPairNew;

  /// No description provided for @tvNoneWaiting.
  ///
  /// In ms, this message translates to:
  /// **'Tiada skrin sedang menunggu.'**
  String get tvNoneWaiting;

  /// No description provided for @tvOn.
  ///
  /// In ms, this message translates to:
  /// **'Hidup'**
  String get tvOn;

  /// No description provided for @devicesSkipTv.
  ///
  /// In ms, this message translates to:
  /// **'skrin TV'**
  String get devicesSkipTv;

  /// No description provided for @devicesSkipGone.
  ///
  /// In ms, this message translates to:
  /// **'sudah tiada'**
  String get devicesSkipGone;

  /// No description provided for @tvPaired.
  ///
  /// In ms, this message translates to:
  /// **'Dipadankan {date}'**
  String tvPaired(String date);

  /// No description provided for @tvSeenNow.
  ///
  /// In ms, this message translates to:
  /// **'baru tadi'**
  String get tvSeenNow;

  /// No description provided for @tvSeenMinutes.
  ///
  /// In ms, this message translates to:
  /// **'{n} minit lalu'**
  String tvSeenMinutes(int n);

  /// No description provided for @tvSeenHours.
  ///
  /// In ms, this message translates to:
  /// **'{n} jam lalu'**
  String tvSeenHours(int n);

  /// No description provided for @tvSeenDays.
  ///
  /// In ms, this message translates to:
  /// **'{n} hari lalu'**
  String tvSeenDays(int n);

  /// No description provided for @addStep.
  ///
  /// In ms, this message translates to:
  /// **'Langkah {n} daripada 3'**
  String addStep(int n);

  /// No description provided for @addWhatRole.
  ///
  /// In ms, this message translates to:
  /// **'Apa yang dia akan buat?'**
  String get addWhatRole;

  /// No description provided for @addNameHint.
  ///
  /// In ms, this message translates to:
  /// **'Nama yang AJK lain kenal. Boleh ditukar kemudian.'**
  String get addNameHint;

  /// No description provided for @addRoleAjk.
  ///
  /// In ms, this message translates to:
  /// **'Melihat sahaja: waktu solat, kandungan, kewangan'**
  String get addRoleAjk;

  /// No description provided for @addRoleBendahari.
  ///
  /// In ms, this message translates to:
  /// **'Merekod derma dan perbelanjaan'**
  String get addRoleBendahari;

  /// No description provided for @addRoleMedia.
  ///
  /// In ms, this message translates to:
  /// **'Pengumuman dan poster di skrin TV'**
  String get addRoleMedia;

  /// No description provided for @addRoleLive.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung dan rakaman'**
  String get addRoleLive;

  /// No description provided for @addRoleAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Semua, termasuk pengguna dan peranti'**
  String get addRoleAdmin;

  /// No description provided for @addDeviceSummary.
  ///
  /// In ms, this message translates to:
  /// **'{device}, kod sah {n} minit'**
  String addDeviceSummary(String device, int n);

  /// No description provided for @addChangeDevice.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama peranti atau tempoh'**
  String get addChangeDevice;

  /// No description provided for @addDefaultDevice.
  ///
  /// In ms, this message translates to:
  /// **'Telefon {name}'**
  String addDefaultDevice(String name);

  /// No description provided for @addSaveAndQr.
  ///
  /// In ms, this message translates to:
  /// **'Simpan dan buat kod QR'**
  String get addSaveAndQr;

  /// No description provided for @addSavedNoQr.
  ///
  /// In ms, this message translates to:
  /// **'{name} disimpan. Buat kod QR apabila anda di Wi-Fi surau.'**
  String addSavedNoQr(String name);

  /// No description provided for @addScanTitle.
  ///
  /// In ms, this message translates to:
  /// **'{name} imbas kod ini dengan aplikasi MAXCOM'**
  String addScanTitle(String name);

  /// No description provided for @addShare.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi'**
  String get addShare;

  /// No description provided for @addShareConfirmTitle.
  ///
  /// In ms, this message translates to:
  /// **'Hantar kepada {name} sahaja'**
  String addShareConfirmTitle(String name);

  /// No description provided for @addShareConfirmBody.
  ///
  /// In ms, this message translates to:
  /// **'Bukan ke kumpulan. Sesiapa yang memegang kod ini di Wi-Fi surau boleh masuk sebagai {name} sehingga kod digunakan.'**
  String addShareConfirmBody(String name);

  /// No description provided for @addShareText.
  ///
  /// In ms, this message translates to:
  /// **'Jemputan MAXCOM untuk {name} di {surau}. Sah {n} minit dan sekali guna. Di Wi-Fi surau, buka aplikasi MAXCOM, pilih \"Masukkan kod secara manual\" dan tampal teks di bawah. Jangan kongsi dengan orang lain.'**
  String addShareText(String name, String surau, int n);

  /// No description provided for @addShareAdminInPerson.
  ///
  /// In ms, this message translates to:
  /// **'Kod untuk Pentadbir mesti diimbas di depan anda semasa kunci aplikasi dimatikan.'**
  String get addShareAdminInPerson;

  /// No description provided for @addShareUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Kongsi tidak tersedia pada MAXCOM ini. Tunjukkan kod QR.'**
  String get addShareUnavailable;

  /// No description provided for @addLockOffHint.
  ///
  /// In ms, this message translates to:
  /// **'Kunci aplikasi dimatikan. Hidupkan di Konfigurasi untuk keselamatan lebih.'**
  String get addLockOffHint;

  /// No description provided for @addWaiting.
  ///
  /// In ms, this message translates to:
  /// **'Menunggu {name} mendaftar'**
  String addWaiting(String name);

  /// No description provided for @addEndCode.
  ///
  /// In ms, this message translates to:
  /// **'Tamatkan kod ini'**
  String get addEndCode;

  /// No description provided for @addDoneTitle.
  ///
  /// In ms, this message translates to:
  /// **'{name} sudah masuk'**
  String addDoneTitle(String name);

  /// No description provided for @addDoneBody.
  ///
  /// In ms, this message translates to:
  /// **'Dia boleh guna aplikasi sebagai {roles} mulai sekarang.'**
  String addDoneBody(String roles);

  /// No description provided for @addDoneDevice.
  ///
  /// In ms, this message translates to:
  /// **'{platform}, didaftarkan {time}'**
  String addDoneDevice(String platform, String time);

  /// No description provided for @addNotTheirs.
  ///
  /// In ms, this message translates to:
  /// **'Bukan telefon {name}? Padam peranti ini'**
  String addNotTheirs(String name);

  /// No description provided for @addReuseWarning.
  ///
  /// In ms, this message translates to:
  /// **'Kod ini cuba digunakan lagi {n} kali selepas itu.'**
  String addReuseWarning(int n);

  /// No description provided for @addAnother.
  ///
  /// In ms, this message translates to:
  /// **'Tambah pengguna lain'**
  String get addAnother;

  /// No description provided for @addBackToList.
  ///
  /// In ms, this message translates to:
  /// **'Kembali ke senarai'**
  String get addBackToList;

  /// No description provided for @thisDeviceRename.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama peranti ini'**
  String get thisDeviceRename;

  /// No description provided for @liveOnlyRename.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama peranti'**
  String get liveOnlyRename;

  /// No description provided for @liveOnlyUnlock.
  ///
  /// In ms, this message translates to:
  /// **'Buka kunci PIN'**
  String get liveOnlyUnlock;

  /// No description provided for @liveOnlyCodes.
  ///
  /// In ms, this message translates to:
  /// **'Urus kod pendaftaran'**
  String get liveOnlyCodes;

  /// No description provided for @liveOnlyActivity.
  ///
  /// In ms, this message translates to:
  /// **'Lihat status aktif'**
  String get liveOnlyActivity;

  /// No description provided for @liveOnlyDeleteUser.
  ///
  /// In ms, this message translates to:
  /// **'Padam pengguna'**
  String get liveOnlyDeleteUser;

  /// No description provided for @liveOnlyRestoreUser.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan pengguna'**
  String get liveOnlyRestoreUser;

  /// No description provided for @liveOnlyPhone.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nombor telefon'**
  String get liveOnlyPhone;

  /// No description provided for @idLabel.
  ///
  /// In ms, this message translates to:
  /// **'ID'**
  String get idLabel;

  /// No description provided for @idPending.
  ///
  /// In ms, this message translates to:
  /// **'ID belum ada'**
  String get idPending;

  /// No description provided for @searchNameOrId.
  ///
  /// In ms, this message translates to:
  /// **'Cari nama atau ID'**
  String get searchNameOrId;

  /// No description provided for @userDelete.
  ///
  /// In ms, this message translates to:
  /// **'Padam pengguna'**
  String get userDelete;

  /// No description provided for @userDeleteTitle.
  ///
  /// In ms, this message translates to:
  /// **'Padam {name}?'**
  String userDeleteTitle(String name);

  /// No description provided for @userDeleteBody.
  ///
  /// In ms, this message translates to:
  /// **'{name} ({ref}) tidak lagi boleh masuk dan hilang dari semua senarai. Semua perantinya dibatalkan dan nombor telefonnya dipadam. Log perubahan dan rekod kewangan kekal dengan nama dan ID ini.'**
  String userDeleteBody(String name, String ref);

  /// No description provided for @userDeleted.
  ///
  /// In ms, this message translates to:
  /// **'{name} dipadam.'**
  String userDeleted(String name);

  /// No description provided for @userDeleteSelf.
  ///
  /// In ms, this message translates to:
  /// **'Anda tidak boleh memadam akaun sendiri'**
  String get userDeleteSelf;

  /// No description provided for @userDeleteLastAdmin.
  ///
  /// In ms, this message translates to:
  /// **'Mesti ada sekurang-kurangnya seorang Pentadbir aktif'**
  String get userDeleteLastAdmin;

  /// No description provided for @userRestore.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan'**
  String get userRestore;

  /// No description provided for @userRestored.
  ///
  /// In ms, this message translates to:
  /// **'{name} dipulihkan sebagai dinyahaktifkan. Aktifkan semula dan daftar telefon dengan kod QR baharu.'**
  String userRestored(String name);

  /// No description provided for @auditUserDeleted.
  ///
  /// In ms, this message translates to:
  /// **'Pengguna dipadam'**
  String get auditUserDeleted;

  /// No description provided for @auditDeviceDeleted.
  ///
  /// In ms, this message translates to:
  /// **'Peranti dipadam'**
  String get auditDeviceDeleted;

  /// No description provided for @auditPhoneChanged.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon ditukar'**
  String get auditPhoneChanged;

  /// No description provided for @autoCleanNote.
  ///
  /// In ms, this message translates to:
  /// **'Peranti yang tidak digunakan 180 hari dan pengguna yang dinyahaktifkan 365 hari dipadam secara automatik. Sejarah kekal.'**
  String get autoCleanNote;

  /// No description provided for @autoCleanSoon.
  ///
  /// In ms, this message translates to:
  /// **'Dipadam automatik dalam {n} hari'**
  String autoCleanSoon(int n);

  /// No description provided for @phoneLabel.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon'**
  String get phoneLabel;

  /// No description provided for @phoneLabelOptional.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon untuk WhatsApp (pilihan)'**
  String get phoneLabelOptional;

  /// No description provided for @phoneNone.
  ///
  /// In ms, this message translates to:
  /// **'Tiada nombor telefon'**
  String get phoneNone;

  /// No description provided for @phoneCleared.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon dibuang.'**
  String get phoneCleared;

  /// No description provided for @phoneHint.
  ///
  /// In ms, this message translates to:
  /// **'Contoh: 012-000 0000'**
  String get phoneHint;

  /// No description provided for @phoneInvalid.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon tidak sah. Untuk nombor luar negara, mulakan dengan + dan kod negara.'**
  String get phoneInvalid;

  /// No description provided for @phoneTaken.
  ///
  /// In ms, this message translates to:
  /// **'Nombor ini sudah digunakan oleh pengguna lain ({ref}).'**
  String phoneTaken(String ref);

  /// No description provided for @phoneFill.
  ///
  /// In ms, this message translates to:
  /// **'Isi nombor'**
  String get phoneFill;

  /// No description provided for @phoneDuplicate.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon sama dengan pengguna lain'**
  String get phoneDuplicate;

  /// No description provided for @phoneSaved.
  ///
  /// In ms, this message translates to:
  /// **'Nombor telefon disimpan.'**
  String get phoneSaved;

  /// No description provided for @phoneEdit.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nombor'**
  String get phoneEdit;

  /// No description provided for @phonePrivate.
  ///
  /// In ms, this message translates to:
  /// **'Hanya Pentadbir dan orang itu sendiri boleh melihat nombor ini.'**
  String get phonePrivate;

  /// No description provided for @waTo.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp kepada {name}'**
  String waTo(String name);

  /// No description provided for @waUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp tidak dapat dibuka. Guna Kongsi.'**
  String get waUnavailable;

  /// No description provided for @waUnavailablePage.
  ///
  /// In ms, this message translates to:
  /// **'WhatsApp tidak tersedia pada telefon ini.'**
  String get waUnavailablePage;

  /// No description provided for @shareContinue.
  ///
  /// In ms, this message translates to:
  /// **'Teruskan'**
  String get shareContinue;

  /// No description provided for @userRestoreTitle.
  ///
  /// In ms, this message translates to:
  /// **'Pulihkan {name}?'**
  String userRestoreTitle(String name);

  /// No description provided for @userRestoreBody.
  ///
  /// In ms, this message translates to:
  /// **'{name} ({ref}) kembali ke senarai sebagai dinyahaktifkan, tanpa peranti. Aktifkan semula dan daftar telefon dengan kod QR baharu.'**
  String userRestoreBody(String name, String ref);

  /// No description provided for @phoneSave.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get phoneSave;

  /// No description provided for @userDeleteHint.
  ///
  /// In ms, this message translates to:
  /// **'Orang ini hilang dari senarai dan tidak lagi boleh masuk. Sejarah kekal. Boleh dipulihkan dari Log perubahan.'**
  String get userDeleteHint;

  /// No description provided for @a6Other.
  ///
  /// In ms, this message translates to:
  /// **'Lain-lain'**
  String get a6Other;

  /// No description provided for @needsBoth.
  ///
  /// In ms, this message translates to:
  /// **'{first} dan {second}'**
  String needsBoth(String first, String second);

  /// No description provided for @errVideoTooBig.
  ///
  /// In ms, this message translates to:
  /// **'Video terlalu besar. Paling besar 300 MB dan 720p; kecilkan atau pangkas dalam Galeri telefon dahulu.'**
  String get errVideoTooBig;

  /// No description provided for @errVideoTooLong.
  ///
  /// In ms, this message translates to:
  /// **'Video terlalu panjang. Paling lama 10 minit; pangkas dalam Galeri telefon dahulu.'**
  String get errVideoTooLong;

  /// No description provided for @errVideoNotH264.
  ///
  /// In ms, this message translates to:
  /// **'Video mesti MP4 dengan H.264. Pilih video lain atau tukar formatnya dahulu.'**
  String get errVideoNotH264;

  /// No description provided for @errVideoNoSpace.
  ///
  /// In ms, this message translates to:
  /// **'Ruang storan MAXCOM tidak mencukupi. Padam video lama dahulu.'**
  String get errVideoNoSpace;

  /// No description provided for @errVideoUploadFailed.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik video gagal. Pastikan telefon masih di Wi-Fi surau, kemudian cuba lagi.'**
  String get errVideoUploadFailed;

  /// No description provided for @kindDescVideo.
  ///
  /// In ms, this message translates to:
  /// **'Video yang dimuat naik atau dari YouTube, dimainkan penuh skrin di TV.'**
  String get kindDescVideo;

  /// No description provided for @videoSourceLabel.
  ///
  /// In ms, this message translates to:
  /// **'Sumber video'**
  String get videoSourceLabel;

  /// No description provided for @videoSourceUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik'**
  String get videoSourceUpload;

  /// No description provided for @videoSourceYoutube.
  ///
  /// In ms, this message translates to:
  /// **'YouTube'**
  String get videoSourceYoutube;

  /// No description provided for @videoSourceRakaman.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman'**
  String get videoSourceRakaman;

  /// No description provided for @videoAfterPrayerLabel.
  ///
  /// In ms, this message translates to:
  /// **'Main selepas zikir solat'**
  String get videoAfterPrayerLabel;

  /// No description provided for @videoAfterPrayerNone.
  ///
  /// In ms, this message translates to:
  /// **'Tidak'**
  String get videoAfterPrayerNone;

  /// No description provided for @videoAfterPrayerZohor.
  ///
  /// In ms, this message translates to:
  /// **'Zohor (Jumaat pada hari Jumaat)'**
  String get videoAfterPrayerZohor;

  /// No description provided for @videoAfterPrayerHint.
  ///
  /// In ms, this message translates to:
  /// **'Jika dipilih, video ini keluar daripada putaran biasa. TV memainkannya sekali sehari, selepas skrin zikir solat itu, mengikut hari dan tarikh yang dipilih.'**
  String get videoAfterPrayerHint;

  /// No description provided for @videoPick.
  ///
  /// In ms, this message translates to:
  /// **'Pilih video daripada telefon'**
  String get videoPick;

  /// No description provided for @videoPickAgain.
  ///
  /// In ms, this message translates to:
  /// **'Pilih video lain'**
  String get videoPickAgain;

  /// No description provided for @videoChecking.
  ///
  /// In ms, this message translates to:
  /// **'Menyemak video...'**
  String get videoChecking;

  /// No description provided for @videoCompressing.
  ///
  /// In ms, this message translates to:
  /// **'Mengecilkan video ke 720p... {percent}%'**
  String videoCompressing(int percent);

  /// No description provided for @videoUploading.
  ///
  /// In ms, this message translates to:
  /// **'Memuat naik ke MAXCOM... {percent}%'**
  String videoUploading(int percent);

  /// No description provided for @videoUploadedOk.
  ///
  /// In ms, this message translates to:
  /// **'Sudah dimuat naik ke MAXCOM'**
  String get videoUploadedOk;

  /// No description provided for @videoPickedLine.
  ///
  /// In ms, this message translates to:
  /// **'{name} ({size})'**
  String videoPickedLine(String name, String size);

  /// No description provided for @videoCloudNote.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik video hanya di Wi-Fi surau. Sambung telefon ke Wi-Fi surau, atau tambah video YouTube (boleh dari mana-mana).'**
  String get videoCloudNote;

  /// No description provided for @videoStorageLeft.
  ///
  /// In ms, this message translates to:
  /// **'Ruang storan MAXCOM: {size} lagi'**
  String videoStorageLeft(String size);

  /// No description provided for @videoLimitsNote.
  ///
  /// In ms, this message translates to:
  /// **'Paling besar 300 MB, paling lama 10 minit, 720p. Pangkas dalam Galeri telefon dahulu jika perlu.'**
  String get videoLimitsNote;

  /// No description provided for @videoCannotCompress.
  ///
  /// In ms, this message translates to:
  /// **'Telefon ini tidak boleh mengecilkan video. Pilih video MP4 (H.264) yang sudah dalam had.'**
  String get videoCannotCompress;

  /// No description provided for @videoYoutubeLink.
  ///
  /// In ms, this message translates to:
  /// **'Pautan YouTube'**
  String get videoYoutubeLink;

  /// No description provided for @videoYoutubeHint.
  ///
  /// In ms, this message translates to:
  /// **'Tampal pautan atau ID video'**
  String get videoYoutubeHint;

  /// No description provided for @videoYoutubeBad.
  ///
  /// In ms, this message translates to:
  /// **'Ini bukan pautan video YouTube.'**
  String get videoYoutubeBad;

  /// No description provided for @videoYoutubeLive.
  ///
  /// In ms, this message translates to:
  /// **'Ini siaran langsung. Untuk memaparkan siaran langsung di TV, gunakan Siaran langsung. Selepas siaran tamat, rakamannya boleh dipilih di sini.'**
  String get videoYoutubeLive;

  /// No description provided for @videoYoutubeNote.
  ///
  /// In ms, this message translates to:
  /// **'Video saluran lain mungkin ada iklan atau dibuang oleh pemiliknya. Memerlukan internet di surau; tanpa internet video dilangkau.'**
  String get videoYoutubeNote;

  /// No description provided for @videoRakamanNote.
  ///
  /// In ms, this message translates to:
  /// **'Petikan daripada rakaman kuliah surau di YouTube. Tetapkan bila ia bermula dan berhenti.'**
  String get videoRakamanNote;

  /// No description provided for @videoClipStart.
  ///
  /// In ms, this message translates to:
  /// **'Mula (mm:ss)'**
  String get videoClipStart;

  /// No description provided for @videoClipEnd.
  ///
  /// In ms, this message translates to:
  /// **'Tamat (mm:ss)'**
  String get videoClipEnd;

  /// No description provided for @videoClipOrder.
  ///
  /// In ms, this message translates to:
  /// **'Tamat mesti selepas mula.'**
  String get videoClipOrder;

  /// No description provided for @videoClipLong.
  ///
  /// In ms, this message translates to:
  /// **'Petikan paling lama 10 minit.'**
  String get videoClipLong;

  /// No description provided for @videoNeedsFile.
  ///
  /// In ms, this message translates to:
  /// **'Pilih video dan tunggu ia selesai dimuat naik.'**
  String get videoNeedsFile;

  /// No description provided for @videoWaitUpload.
  ///
  /// In ms, this message translates to:
  /// **'Tunggu muat naik selesai sebelum Simpan.'**
  String get videoWaitUpload;

  /// No description provided for @videoEstimate.
  ///
  /// In ms, this message translates to:
  /// **'Anggaran tempoh (minit)'**
  String get videoEstimate;

  /// No description provided for @videoEstimateHint.
  ///
  /// In ms, this message translates to:
  /// **'YouTube tidak memberi tempoh video. Beri anggaran (1 hingga 10 minit); skrin terus bertukar sebaik video tamat.'**
  String get videoEstimateHint;

  /// No description provided for @videoEstimateBad.
  ///
  /// In ms, this message translates to:
  /// **'Masukkan nombor 1 hingga 10.'**
  String get videoEstimateBad;

  /// No description provided for @videoCloudReadOnly.
  ///
  /// In ms, this message translates to:
  /// **'Butiran video yang dimuat naik hanya boleh diubah di Wi-Fi surau.'**
  String get videoCloudReadOnly;

  /// No description provided for @videoPreview.
  ///
  /// In ms, this message translates to:
  /// **'Pratonton'**
  String get videoPreview;

  /// No description provided for @videoPreviewHint.
  ///
  /// In ms, this message translates to:
  /// **'Di TV: video memenuhi skrin, nama surau dan jam di atasnya. Tiada teks lain.'**
  String get videoPreviewHint;

  /// No description provided for @videoRowUpload.
  ///
  /// In ms, this message translates to:
  /// **'Muat naik, {length}'**
  String videoRowUpload(String length);

  /// No description provided for @videoRowYoutube.
  ///
  /// In ms, this message translates to:
  /// **'YouTube'**
  String get videoRowYoutube;

  /// No description provided for @videoRowRakaman.
  ///
  /// In ms, this message translates to:
  /// **'Petikan rakaman {start} hingga {end}'**
  String videoRowRakaman(String start, String end);

  /// No description provided for @videoSoundOn.
  ///
  /// In ms, this message translates to:
  /// **'Berbunyi'**
  String get videoSoundOn;

  /// No description provided for @videoExpiredSuggest.
  ///
  /// In ms, this message translates to:
  /// **'Tarikh tamat sudah lalu. Padam untuk menjimatkan ruang?'**
  String get videoExpiredSuggest;

  /// No description provided for @videoFileLost.
  ///
  /// In ms, this message translates to:
  /// **'Fail tiada pada MAXCOM ini; dilangkau di TV.'**
  String get videoFileLost;

  /// No description provided for @videoFetching.
  ///
  /// In ms, this message translates to:
  /// **'Mengambil tajuk daripada YouTube...'**
  String get videoFetching;

  /// No description provided for @errcNoMicDevice.
  ///
  /// In ms, this message translates to:
  /// **'Tiada Mic-in dikesan pada MAXCOM.'**
  String get errcNoMicDevice;

  /// No description provided for @errcMicAccessDenied.
  ///
  /// In ms, this message translates to:
  /// **'Windows tidak membenarkan MAXCOM menggunakan Mic-in. Jalankan Semak MAXCOM.'**
  String get errcMicAccessDenied;

  /// No description provided for @errcMicListFailed.
  ///
  /// In ms, this message translates to:
  /// **'Senarai Mic-in tidak dapat dibaca. Cuba semula sebentar lagi.'**
  String get errcMicListFailed;

  /// No description provided for @errcMicNoTool.
  ///
  /// In ms, this message translates to:
  /// **'Alat bunyi MAXCOM tiada, jadi Mic-in tidak boleh digunakan.'**
  String get errcMicNoTool;

  /// No description provided for @errcPlayLiveRunning.
  ///
  /// In ms, this message translates to:
  /// **'Siaran langsung sedang berjalan di skrin TV.'**
  String get errcPlayLiveRunning;

  /// No description provided for @errcPlayPrayerPhase.
  ///
  /// In ms, this message translates to:
  /// **'Tidak boleh dimainkan semasa waktu solat.'**
  String get errcPlayPrayerPhase;

  /// No description provided for @videoPlayNow.
  ///
  /// In ms, this message translates to:
  /// **'Main sekarang'**
  String get videoPlayNow;

  /// No description provided for @videoPlayNowDone.
  ///
  /// In ms, this message translates to:
  /// **'Video dimainkan di skrin TV sekarang.'**
  String get videoPlayNowDone;

  /// No description provided for @dashBoxName.
  ///
  /// In ms, this message translates to:
  /// **'Nama MAXCOM'**
  String get dashBoxName;

  /// No description provided for @boxNameRenameTitle.
  ///
  /// In ms, this message translates to:
  /// **'Tukar nama MAXCOM'**
  String get boxNameRenameTitle;

  /// No description provided for @boxNameFollowsHint.
  ///
  /// In ms, this message translates to:
  /// **'Nama ini mengikut nama surau melainkan anda menukarnya sendiri.'**
  String get boxNameFollowsHint;

  /// No description provided for @phoneWhatsAppHint.
  ///
  /// In ms, this message translates to:
  /// **'Digunakan untuk menghantar notis dan pautan melalui WhatsApp. Boleh dikosongkan.'**
  String get phoneWhatsAppHint;

  /// No description provided for @recKeepTitle.
  ///
  /// In ms, this message translates to:
  /// **'Simpan rakaman di peranti?'**
  String get recKeepTitle;

  /// No description provided for @recKeepBody.
  ///
  /// In ms, this message translates to:
  /// **'YouTube sudah mempunyai salinan penuh siaran ini. Anda boleh menyimpan rakaman di peranti ini atau memadamnya untuk menjimatkan ruang.'**
  String get recKeepBody;

  /// No description provided for @recKeepKeep.
  ///
  /// In ms, this message translates to:
  /// **'Simpan'**
  String get recKeepKeep;

  /// No description provided for @recKeepDelete.
  ///
  /// In ms, this message translates to:
  /// **'Padam'**
  String get recKeepDelete;

  /// No description provided for @liveRecJoinedNote.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman digabungkan menjadi satu fail.'**
  String get liveRecJoinedNote;

  /// No description provided for @liveRecJoinFailedNote.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman tidak dapat digabungkan. Setiap bahagian disimpan seperti asalnya.'**
  String get liveRecJoinFailedNote;

  /// No description provided for @liveRecAskLaterNote.
  ///
  /// In ms, this message translates to:
  /// **'Apabila YouTube mengesahkan siaran penuh, anda akan ditanya sama ada mahu menyimpan rakaman di peranti ini.'**
  String get liveRecAskLaterNote;

  /// No description provided for @liveRecKeptUnconfirmedNote.
  ///
  /// In ms, this message translates to:
  /// **'Salinan YouTube belum disahkan, jadi rakaman disimpan di peranti ini.'**
  String get liveRecKeptUnconfirmedNote;

  /// No description provided for @liveRecSavedAsk.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman sudah disimpan dalam Fail/Downloads?'**
  String get liveRecSavedAsk;

  /// No description provided for @liveRecSavedYes.
  ///
  /// In ms, this message translates to:
  /// **'Ya'**
  String get liveRecSavedYes;

  /// No description provided for @liveRecSavedNo.
  ///
  /// In ms, this message translates to:
  /// **'Belum'**
  String get liveRecSavedNo;

  /// No description provided for @liveRecSavedNotYetNote.
  ///
  /// In ms, this message translates to:
  /// **'Tiada apa yang dipadam. Rakaman kekal di peranti ini dan di MAXCOM; salinan di MAXCOM luput sendiri selepas 7 hari. Tekan Simpan rakaman sekali lagi bila-bila masa.'**
  String get liveRecSavedNotYetNote;

  /// No description provided for @liveRecSaveTooBigNote.
  ///
  /// In ms, this message translates to:
  /// **'Fail ini terlalu besar untuk pelayar ini. Tiada apa yang dipadam; setiap bahagian boleh disimpan satu per satu.'**
  String get liveRecSaveTooBigNote;

  /// No description provided for @liveRecJoinNeedsWifiNote.
  ///
  /// In ms, this message translates to:
  /// **'MAXCOM tidak dapat dicapai. Sambung ke Wi-Fi surau, kemudian cuba lagi. Setiap bahagian disimpan seperti asalnya.'**
  String get liveRecJoinNeedsWifiNote;

  /// No description provided for @liveRecJoinedUntrackedNote.
  ///
  /// In ms, this message translates to:
  /// **'Rakaman sudah digabungkan, tetapi namanya belum dapat dicatat. Fail itu ada di Movies/MAXCOM.'**
  String get liveRecJoinedUntrackedNote;

  /// No description provided for @errcMicDeviceUnavailable.
  ///
  /// In ms, this message translates to:
  /// **'Mic-in tidak dapat dibuka. Pastikan mikrofon dipasang dan tidak digunakan oleh program lain.'**
  String get errcMicDeviceUnavailable;

  /// No description provided for @errcMicSilent.
  ///
  /// In ms, this message translates to:
  /// **'Mic-in tidak menghantar bunyi. Pastikan mikrofon dipasang dan tidak senyap (mute).'**
  String get errcMicSilent;

  /// No description provided for @liveRecBadPieceNote.
  ///
  /// In ms, this message translates to:
  /// **'Fail rakaman tidak sah dan tidak diterima oleh MAXCOM. Setiap bahagian disimpan seperti asalnya.'**
  String get liveRecBadPieceNote;
}

class _SDelegate extends LocalizationsDelegate<S> {
  const _SDelegate();

  @override
  Future<S> load(Locale locale) {
    return SynchronousFuture<S>(lookupS(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['ar', 'en', 'ms'].contains(locale.languageCode);

  @override
  bool shouldReload(_SDelegate old) => false;
}

S lookupS(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'ar':
      return SAr();
    case 'en':
      return SEn();
    case 'ms':
      return SMs();
  }

  throw FlutterError(
    'S.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
