// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 's.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class SEn extends S {
  SEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Surau';

  @override
  String get actionSave => 'Save changes';

  @override
  String get actionCancel => 'Cancel';

  @override
  String get actionBack => 'Back';

  @override
  String get actionRetry => 'Try again';

  @override
  String get actionDelete => 'Delete';

  @override
  String get actionClose => 'Close';

  @override
  String get actionContinue => 'Continue';

  @override
  String get actionAdd => 'Add';

  @override
  String get actionEdit => 'Edit';

  @override
  String get actionUpload => 'Upload';

  @override
  String get actionDownload => 'Download';

  @override
  String get actionLogout => 'Sign out';

  @override
  String get actionEnrolAgain => 'Enrol again';

  @override
  String get savedToast => 'Changes saved';

  @override
  String get navDashboard => 'Dashboard';

  @override
  String get navSettings => 'Settings';

  @override
  String get navContent => 'Content';

  @override
  String get navPreview => 'Preview';

  @override
  String get navIslamic => 'Islamic content';

  @override
  String get navPrayerData => 'Prayer times';

  @override
  String get navUsers => 'Users';

  @override
  String get navDevices => 'Devices';

  @override
  String get navPairing => 'Kiosk pairing';

  @override
  String get navAudit => 'Change log';

  @override
  String get navFinance => 'Finance';

  @override
  String get navLive => 'Live broadcast';

  @override
  String get navJemaah => 'Congregation';

  @override
  String get navThisDevice => 'This device';

  @override
  String get navMore => 'More';

  @override
  String get dashboardTitle => 'Dashboard';

  @override
  String get settingsTitle => 'Settings';

  @override
  String get enrolTitle => 'Enrol this device';

  @override
  String get unlockTitle => 'Unlock';

  @override
  String get previewRibbon => 'PREVIEW';

  @override
  String get enrolScanHint => 'Scan the QR code shown by the admin';

  @override
  String get enrolManualHint => 'Or paste the enrolment code here';

  @override
  String get enrolPinHaveOne => 'I already have a PIN';

  @override
  String get enrolPinCreate => 'Create a new PIN';

  @override
  String get pinLabel => 'PIN';

  @override
  String get pinHint => 'Enter your PIN';

  @override
  String get pinConfirmHint => 'Enter the PIN again';

  @override
  String get pinMismatch => 'The PINs do not match';

  @override
  String get biometricUse => 'Use fingerprint';

  @override
  String get unlockButton => 'Unlock';

  @override
  String get errorForbidden => 'You do not have permission for this action';

  @override
  String get errorBoxUnreachable => 'Cannot reach MAXCOM';

  @override
  String get errorDeviceRevoked => 'This device has been revoked';

  @override
  String get errorCaMismatch => 'The root certificate does not match';

  @override
  String get errorDeviceKeyMissing => 'The device key is missing';

  @override
  String get errorSessionExpired => 'Your session has ended. Unlock again.';

  @override
  String get errorUnknown => 'Something went wrong. Try again.';

  @override
  String get offlineBanner => 'Cannot reach MAXCOM. Showing the last data.';

  @override
  String get offlineWriteRefused =>
      'Cannot reach MAXCOM. Try again at the surau.';

  @override
  String get loading => 'Loading';

  @override
  String get emptyList => 'Nothing here yet';

  @override
  String get readOnlyHint => 'View only';

  @override
  String get featureOn => 'On';

  @override
  String get featureOff => 'Off';

  @override
  String get featureLocked => 'Always on';

  @override
  String get deviceLockAlwaysOn => 'Lock on this device';

  @override
  String get roleSuperadmin => 'MAXCOM Administrator';

  @override
  String get roleSuperadminHint =>
      'Everything an Admin can do, plus the MAXCOM system settings (Advanced). Managed through the MAXCOM cloud only';

  @override
  String get superadminBadgeTooltip => 'You are a MAXCOM Administrator';

  @override
  String get roleAdmin => 'Admin';

  @override
  String get roleTreasurer => 'Treasurer';

  @override
  String get roleMedia => 'Media';

  @override
  String get roleAjk => 'Committee member';

  @override
  String get enrolScanButton => 'Scan the QR code';

  @override
  String get enrolManualButton => 'Enter the code manually';

  @override
  String get enrolPasteLabel => 'Enrolment code';

  @override
  String get enrolPasteHint => 'surau1:...';

  @override
  String get enrolCodeShow => 'Show the code';

  @override
  String get enrolCodeHide => 'Hide the code';

  @override
  String get enrolCameraUnavailable =>
      'The camera is not available here. Paste the enrolment code the admin gave you.';

  @override
  String get enrolCameraStarting => 'Opening the camera';

  @override
  String get enrolBoxLabel => 'MAXCOM address';

  @override
  String get enrolUserLabel => 'User';

  @override
  String get enrolCaLabel => 'Certificate fingerprint';

  @override
  String get enrolCaCompare =>
      'Compare it with the admin\'s printout before continuing.';

  @override
  String get enrolCaNone => 'No certificate (local test connection)';

  @override
  String get enrolDeviceNameLabel => 'Device name';

  @override
  String get enrolDeviceNameHint => 'Example: Ali\'s phone';

  @override
  String get enrolDeviceNameRequired => 'Enter a device name';

  @override
  String get enrolPinChoiceTitle => 'Your PIN';

  @override
  String get enrolPinHaveOneHint => 'The same PIN as on your other devices';

  @override
  String get enrolPinCreateHint =>
      '6 digits. Not all the same digit and not a run.';

  @override
  String get enrolPinNewHint => 'New PIN';

  @override
  String get enrolPinAgainLabel => 'Once more';

  @override
  String get enrolSubmit => 'Enrol device';

  @override
  String get enrolWorking => 'Enrolling';

  @override
  String get enrolDone => 'Device enrolled';

  @override
  String get enrolExpired =>
      'The enrolment code has expired. Ask the admin for a new one.';

  @override
  String get enrolPinExists =>
      'You already have a PIN. Choose \"I already have a PIN\".';

  @override
  String get enrolPinKnownSet => 'Use the same PIN as on your other device';

  @override
  String get enrolPinKnownNew => 'Create a 6-digit PIN for your account';

  @override
  String get enrolAlreadyEnrolled =>
      'This device is already enrolled. To enrol again, choose \"Enrol again\" on the unlock screen.';

  @override
  String get enrolPinPending =>
      'No PIN is set yet. You will be asked to set a new PIN when you unlock.';

  @override
  String get enrolAnother => 'Scan another code';

  @override
  String get pinTooWeak =>
      'This PIN is too easy. Choose 6 digits that are not all the same and not a run.';

  @override
  String get pinNewTitle => 'Set a new PIN';

  @override
  String get pinNewHint => 'The admin has reset your PIN. Choose 6 new digits.';

  @override
  String get pinConfirmTitle => 'Enter the PIN again';

  @override
  String get pinDeleteDigit => 'Delete digit';

  @override
  String get unlockHint => 'Enter your PIN to continue';

  @override
  String get unlockChecking => 'Checking';

  @override
  String get unlockRevokedHint =>
      'This device is no longer allowed. Enrol again with a new code from the admin.';

  @override
  String get unlockNoKeyHint =>
      'This device\'s key is missing. Enrol again with a new code from the admin.';

  @override
  String get biometricFailed => 'Fingerprint not recognised. Enter your PIN.';

  @override
  String get biometricLocked => 'Fingerprint is locked for now. Use your PIN.';

  @override
  String get unlockNotVerified =>
      'MAXCOM could not verify this device. Try again.';

  @override
  String get biometricChecking => 'Waiting for your fingerprint';

  @override
  String get productName => 'MAXCOM';

  @override
  String greeting(String name) {
    return 'Assalamualaikum, $name';
  }

  @override
  String rolesJoin(String head, String last) {
    return '$head and $last';
  }

  @override
  String invitedByUntil(String admin, String when) {
    return 'Invited by $admin. The invitation is valid until $when.';
  }

  @override
  String validUntil(String when) {
    return 'The invitation is valid until $when.';
  }

  @override
  String get enrolStepScan => 'Scan code';

  @override
  String get enrolStepReview => 'Check';

  @override
  String get enrolStepPin => 'Set PIN';

  @override
  String get enrolReviewHint =>
      'Check your name and this surau before continuing.';

  @override
  String get enrolDoneHint => 'Next time, open this app and enter your PIN.';

  @override
  String get helpTitle => 'Need help?';

  @override
  String helpContact(String name) {
    return 'Contact $name';
  }

  @override
  String get helpContactAnyone => 'Contact the surau admin';

  @override
  String get helpNoContact => 'Ask your surau admin for help.';

  @override
  String get helpCall => 'Call';

  @override
  String get helpWhatsApp => 'WhatsApp';

  @override
  String get helpEmail => 'Email';

  @override
  String get techDetailsTitle => 'Technical details';

  @override
  String get unlockForgotPin => 'Forgot your PIN?';

  @override
  String get unlockForgotPinBody =>
      'The admin can reset your PIN. After that, open this app and set a new PIN.';

  @override
  String get unlockNotYou => 'Not you? Enrol this device again';

  @override
  String get unlockNotYouTitle => 'Enrol this device again?';

  @override
  String get unlockNotYouBody =>
      'You need a new QR code from the admin. The current enrolment on this device will be replaced.';

  @override
  String get unlockLockedTitle => 'PIN locked for now';

  @override
  String unlockLockedUntil(String when) {
    return 'Try again at $when';
  }

  @override
  String errorUnreachableNamed(String name) {
    return 'Cannot reach $name';
  }

  @override
  String get errorUnreachableHint => 'Make sure you are on the surau WiFi.';

  @override
  String get navPeople => 'Users & devices';

  @override
  String offlineBannerAt(String when) {
    return 'Cannot reach MAXCOM. Showing the last data ($when).';
  }

  @override
  String get offlineNoData => 'Cannot reach MAXCOM. No data to show yet.';

  @override
  String get statusTitle => 'MAXCOM status';

  @override
  String statusReachedAt(String when) {
    return 'Reached $when';
  }

  @override
  String get statusChecking => 'Reaching MAXCOM';

  @override
  String get statusUnreachable => 'Cannot be reached';

  @override
  String get statusPrayerData => 'Prayer time data';

  @override
  String get statusLockedUsers => 'Locked users';

  @override
  String get statusDataVersion => 'Data version';

  @override
  String daysLeft(int n) {
    return '$n days left';
  }

  @override
  String get statusPrayerDataWarning =>
      'Upload next year\'s prayer time data before it runs out.';

  @override
  String get statusUnknown => 'Not known yet';

  @override
  String techCheckLine(String contact) {
    return 'MAXCOM needs a technical check. Contact $contact.';
  }

  @override
  String get techCheckContactAnyone => 'the surau admin';

  @override
  String get techCheckDaysLeft => 'MAXCOM certificate expires in';

  @override
  String get techCheckLastRenew => 'Last automatic renewal';

  @override
  String techCheckRenewFailed(String when) {
    return 'Failed $when';
  }

  @override
  String get techCheckRenewNever => 'Never succeeded';

  @override
  String get techCheckExplain =>
      'Renewal runs by itself every day. If it keeps failing, MAXCOM needs to be checked before the date above.';

  @override
  String get previewShortcut => 'Preview the screen';

  @override
  String get previewShortcutHint =>
      'See what the surau TV is showing right now.';

  @override
  String get comingBody =>
      'This section is being built and will arrive in a coming update.';

  @override
  String comingPlanned(String plan) {
    return 'Scheduled: $plan';
  }

  @override
  String get backHome => 'Back to the dashboard';

  @override
  String get comingSettings =>
      'Switch every MAXCOM feature on or off and adjust its settings: iqamah times, backgrounds, content, audio and more.';

  @override
  String get comingContent =>
      'Manage kuliah, speakers, announcements, posters, the calendar and other content shown on the TV.';

  @override
  String get comingPreview => 'See the surau TV live from this device.';

  @override
  String get comingIslamic =>
      'Check and refresh the Islamic content kept on MAXCOM: verses, hadith, zikir and tilawah.';

  @override
  String get comingPrayerData =>
      'Import JAKIM prayer time data for this surau\'s zone.';

  @override
  String get comingUsers =>
      'Add committee members, set their roles, reset PINs and manage devices and kiosk pairing.';

  @override
  String get comingDevices => 'See enrolled devices and revoke a lost one.';

  @override
  String get comingPairing => 'Approve a new TV asking to pair with MAXCOM.';

  @override
  String get comingAudit => 'See who changed what, and when.';

  @override
  String get comingFinance =>
      'Record the surau\'s funds, donations and spending, with the fund card on the TV.';

  @override
  String get finTotalAll => 'Total of all funds';

  @override
  String finAsOf(String date, int n) {
    return 'As of $date, $n funds';
  }

  @override
  String get finMonthIn => 'In this month';

  @override
  String get finMonthOut => 'Out this month';

  @override
  String get finActionKutipan => 'Collection';

  @override
  String get finActionBayaran => 'Payment';

  @override
  String get finActionPembetulan => 'Correction';

  @override
  String get finActionLaporan => 'Report';

  @override
  String get finActionLaporanBulanan => 'Monthly report';

  @override
  String get finActionTetapan => 'Fund settings';

  @override
  String get finFundsTitle => 'Funds';

  @override
  String get finOnTv => 'On the TV screen';

  @override
  String get finSyncTitle => 'Sync';

  @override
  String finPendingTv(int n) {
    return '$n entries not on the TV screen yet';
  }

  @override
  String get finPendingHelp =>
      'Saved on this device. Shown on the TV screen once it reaches MAXCOM at the surau.';

  @override
  String get finAllOnTv =>
      'Every entry has arrived. The TV screen is up to date.';

  @override
  String get finRecent => 'Latest entries';

  @override
  String get finNoEntries => 'No entries yet.';

  @override
  String get finViewOnly =>
      'View only. Collections, payments and corrections are entered by the Treasurer.';

  @override
  String get finSuperBanner =>
      'You are viewing Finance as the MAXCOM administrator, full access. Every view and action is recorded in this surau audit history.';

  @override
  String get finCorrectionsTitle => 'All corrections';

  @override
  String finCorrectionLine(String ref, String orig, String fund) {
    return '$ref for $orig, $fund';
  }

  @override
  String get finTagCorrected => 'Corrected';

  @override
  String get finTagPending => 'Waiting';

  @override
  String finCorrectionOf(String ref) {
    return 'Correction for $ref';
  }

  @override
  String get finUnavailable =>
      'Finance cannot be opened yet. Try again in a moment.';

  @override
  String get finKutipanTitle => 'New collection';

  @override
  String get finKutipanIntro =>
      'Enter the collection after the box is opened and counted. Works without internet; saved on the device and synced later.';

  @override
  String get finDate => 'Date';

  @override
  String get finToday => 'Today';

  @override
  String get finLastFriday => 'Last Friday';

  @override
  String get finPrevMonthWarn =>
      'This date is in the previous month. Make sure that month report has not been closed.';

  @override
  String get finDateFuture => 'The date cannot be later than today.';

  @override
  String get finFund => 'Fund';

  @override
  String get finNoFunds =>
      'There is no fund yet. The administrator must set up the funds first.';

  @override
  String get finPerihal => 'Purpose';

  @override
  String get finNoPerihal =>
      'There is no purpose yet. The administrator must set it up first.';

  @override
  String get finMethod => 'How received';

  @override
  String get finMethodTunai => 'Cash';

  @override
  String get finMethodBank => 'Bank transfer';

  @override
  String get finMethodDuitnow => 'DuitNow';

  @override
  String get finMethodCek => 'Cheque';

  @override
  String get finAmount => 'Amount';

  @override
  String get finAmountInvalid => 'Invalid amount. Example: 1,356.80';

  @override
  String get finAmountZero => 'The amount must be more than RM 0.00';

  @override
  String get finDenomOpen => 'Count by notes and coins (optional)';

  @override
  String get finDenomClose => 'Hide notes and coins';

  @override
  String get finDenomCoins => 'Coins (RM)';

  @override
  String get finDenomSum => 'Total of notes and coins';

  @override
  String finDenomMismatch(String sum, String amount) {
    return 'The notes and coins add up to $sum, which differs from the amount $amount.';
  }

  @override
  String get finCounters => 'Counted by (2 people)';

  @override
  String finCountersCount(int n) {
    return '$n of 2 chosen';
  }

  @override
  String get finCounterYou => 'you';

  @override
  String get finCounterOther => 'Another name...';

  @override
  String get finCounterOtherLabel => 'Name of the person who counted';

  @override
  String get finCounterAdd => 'Add';

  @override
  String get finReference => 'Reference number';

  @override
  String get finReferenceHelp =>
      'Counters are not needed for money paid straight into the surau bank account.';

  @override
  String get finReferenceShort =>
      'The reference number needs at least 3 characters.';

  @override
  String get finPhotoCount => 'Photo of the count sheet';

  @override
  String get finPhotoReceipt => 'Receipt or invoice';

  @override
  String get finPhotoVoucher => 'Acknowledgement or voucher';

  @override
  String get finOptional => 'Optional';

  @override
  String get finPhotoPick => 'Take a photo or choose a picture';

  @override
  String get finPhotoRemove => 'Remove photo';

  @override
  String finPhotoReady(int kb) {
    return 'Photo ready, $kb KB';
  }

  @override
  String get finPhotoNotImage => 'That file is not a picture that can be read.';

  @override
  String get finPhotoTooBig => 'The photo is still too large after shrinking.';

  @override
  String get finNote => 'Note';

  @override
  String get finLockedInfo =>
      'Once saved, this entry cannot be deleted or changed. A mistake is fixed with a correction that gives a reason.';

  @override
  String get finReview => 'Review and save';

  @override
  String get finConfirmTitle => 'Save this collection?';

  @override
  String get finConfirmPayTitle => 'Save this payment?';

  @override
  String get finConfirmHelp =>
      'Check once more. Once saved, the entry cannot be changed.';

  @override
  String get finBigTitle => 'Large amount';

  @override
  String finBigWarn(String limit) {
    return 'This amount is more than $limit. Check once more that there is no typing mistake.';
  }

  @override
  String get finConfirmSave => 'Save';

  @override
  String get finCountedBy => 'Counted by';

  @override
  String get finPhoto => 'Photo';

  @override
  String get finPhotoOne => '1 photo';

  @override
  String get finNone => 'None';

  @override
  String get finSavedTitle => 'Saved on this device';

  @override
  String finSavedRef(String ref) {
    return 'Reference number $ref';
  }

  @override
  String get finSavedWaiting =>
      'Waiting to sync. It is sent by itself when MAXCOM at the surau or the cloud can be reached.';

  @override
  String get finNotOnTv => 'Not on the TV screen yet';

  @override
  String get finAnotherKutipan => 'Another collection';

  @override
  String get finAnotherBayaran => 'Another payment';

  @override
  String get finToHome => 'Back to Finance';

  @override
  String get finSaveFailed =>
      'The entry could not be saved. Check the details again.';

  @override
  String get finBayaranTitle => 'New payment';

  @override
  String get finPayPenceramah => 'Speaker';

  @override
  String get finPayOther => 'Other spending';

  @override
  String get finKuliahLabel => 'Lecture from the calendar';

  @override
  String get finKuliahPick => 'Choose a lecture';

  @override
  String get finKuliahNone => 'There is no lecture to pay for.';

  @override
  String get finKuliahPaid => 'Paid';

  @override
  String get finKuliahDue => 'Not paid yet';

  @override
  String get finKuliahTonight => 'Tonight';

  @override
  String get finKuliahFuture => 'Upcoming';

  @override
  String get finKuliahCancelled => 'Cancelled';

  @override
  String get finKuliahCancelledWarn =>
      'This lecture was cancelled. Make sure this payment is really needed.';

  @override
  String get finKuliahTonightInfo =>
      'This lecture has not happened yet (tonight).';

  @override
  String get finKuliahAlreadyPaid =>
      'This lecture is already paid. A second payment needs a clear reason in the note.';

  @override
  String get finPenceramahName => 'Speaker';

  @override
  String get finNoPenceramahPerihal =>
      'The Speaker purpose does not exist yet. Contact the administrator.';

  @override
  String finSuggestFee(String amount) {
    return 'Suggested from the last payment to this speaker: $amount';
  }

  @override
  String get finPaidFrom => 'Paid from';

  @override
  String finBalanceAfter(String fund, String balance, String after) {
    return 'Balance of $fund: $balance. After this payment: $after';
  }

  @override
  String get finOverdraw =>
      'This payment is more than the fund balance. You can still save it.';

  @override
  String get finPayee => 'Paid to';

  @override
  String get finPayeeRequired => 'Enter who the payment is made to.';

  @override
  String get finPayMethod => 'How paid';

  @override
  String get finCorTitle => 'Correction';

  @override
  String get finCorIntro =>
      'Choose the entry to correct. The original entry is not changed or deleted; the correction is added as a new entry.';

  @override
  String get finCorSearch => 'Search number, fund or purpose';

  @override
  String get finCorLocked => 'Original entry, locked';

  @override
  String get finCorKind => 'Kind of correction';

  @override
  String get finCorKindAmount => 'Adjust amount';

  @override
  String get finCorKindVoid => 'Cancel entry';

  @override
  String get finCorKindFund => 'Change fund';

  @override
  String get finCorRightAmount => 'Correct amount';

  @override
  String get finCorDelta => 'Adjustment';

  @override
  String finCorVoidInfo(String ref, String delta) {
    return 'Entry $ref will count as zero with a correction of $delta. The original entry stays visible in the history and the report.';
  }

  @override
  String get finCorRightFund => 'Correct fund';

  @override
  String get finCorReason => 'Reason for the correction';

  @override
  String get finCorRequired => 'Required';

  @override
  String get finCorReasonHint =>
      'Example: a recount by 2 committee members found ...';

  @override
  String finCorReasonCount(int n) {
    return '$n / at least 15 characters';
  }

  @override
  String finCorReasonOk(int n) {
    return '$n characters';
  }

  @override
  String get finPresetRecount => 'Recount';

  @override
  String get finPresetRecountText => 'Recount: ';

  @override
  String get finPresetTypo => 'Typing mistake';

  @override
  String get finPresetTypoText => 'Typing mistake in the amount: ';

  @override
  String get finPresetWrongFund => 'Wrong fund';

  @override
  String get finPresetWrongFundText => 'Wrong fund: ';

  @override
  String get finCorNote =>
      'A correction is a new entry. It cannot be deleted, and every administrator can see it with its reason.';

  @override
  String get finCorSave => 'Save correction';

  @override
  String get finCorFillReason => 'Enter a reason to save.';

  @override
  String finCorSaved(String ref) {
    return 'Correction saved on this device ($ref).';
  }

  @override
  String get finCorNoEntries => 'There is no entry to correct.';

  @override
  String finCorCurrent(String amount) {
    return 'Current value $amount';
  }

  @override
  String get finCorSameFund => 'Choose a different fund.';

  @override
  String get finHistTitle => 'Entry history';

  @override
  String finHistOriginal(String what) {
    return 'Original: $what';
  }

  @override
  String finHistCorrection(String ref) {
    return 'Correction $ref';
  }

  @override
  String finHistCurrent(String amount) {
    return 'Current value $amount';
  }

  @override
  String finHistAfter(int n, String amount) {
    return 'Current value after $n corrections. Original $amount.';
  }

  @override
  String get finHistBy => 'By';

  @override
  String get finHistDevice => 'Device';

  @override
  String get finHistEntered => 'Entered';

  @override
  String get finHistPhoto => 'Photo of the count sheet';

  @override
  String get finHistPhotoNote => 'Seen through MAXCOM at the surau';

  @override
  String get finHistFixAgain => 'Correct again';

  @override
  String get finHistLocked =>
      'No deleting and no editing in place. This history is the same on the phone, MAXCOM at the surau and the cloud.';

  @override
  String get finUnknownUser => 'Unknown user';

  @override
  String get finKindIn => 'Collection';

  @override
  String get finKindOut => 'Payment';

  @override
  String get finKindAdjust => 'Correction';

  @override
  String get finKindOpening => 'Opening balance';

  @override
  String finFundChanged(String fund) {
    return 'Fund changed to $fund';
  }

  @override
  String get finVoided => 'Cancelled';

  @override
  String finKuliahOn(String title, String date) {
    return '$title, $date';
  }

  @override
  String get comingLive => 'Stream a kuliah live to the surau TV and YouTube.';

  @override
  String get comingJemaah =>
      'The congregation page and calendar feed to share with the community.';

  @override
  String get comingThisDevice =>
      'This device\'s name, fingerprint unlock and the MAXCOM certificate.';

  @override
  String get accountSheetHint => 'This device is enrolled in your name.';

  @override
  String get loadFailed => 'Could not load. Try again.';

  @override
  String get errorTooMany => 'Too many attempts. Wait a moment and try again.';

  @override
  String get peopleTabUsers => 'Users';

  @override
  String get peopleTabDevices => 'Devices';

  @override
  String get peopleTabPairing => 'TV screens';

  @override
  String get usersAdd => 'Add a user';

  @override
  String get usersEmpty => 'No users yet.';

  @override
  String get usersInactive => 'Inactive';

  @override
  String get usersLocked => 'PIN locked';

  @override
  String get usersPinPending => 'No PIN yet';

  @override
  String get userNameLabel => 'Name';

  @override
  String get userNameHint => 'Example: Aminah binti Yusof';

  @override
  String get userNameRequired => 'Enter the user\'s name';

  @override
  String get userRolesTitle => 'Roles';

  @override
  String get userRolesHint => 'One person can hold more than one role.';

  @override
  String get userRoleRequired => 'Choose at least one role.';

  @override
  String get roleAdminHint =>
      'Everything: settings, users, devices and the change log';

  @override
  String get roleTreasurerHint => 'Finance and the surau funds';

  @override
  String get roleMediaHint => 'Content, posters and live broadcasts';

  @override
  String get roleAjkHint =>
      'View settings and content only, and Finance (view only)';

  @override
  String userCreated(String name) {
    return '$name added. Next, enrol their device.';
  }

  @override
  String get userRolesSave => 'Save roles';

  @override
  String get userRolesSaved => 'Roles saved';

  @override
  String get userEnrolDevice => 'Enrol a device';

  @override
  String userEnrolDeviceHint(String name) {
    return 'Make a QR code for $name\'s phone or iPad.';
  }

  @override
  String get userResetPin => 'Reset PIN';

  @override
  String userResetPinHint(String name) {
    return '$name will set a new PIN at the next unlock.';
  }

  @override
  String userResetPinTitle(String name) {
    return 'Reset $name\'s PIN?';
  }

  @override
  String get userResetPinLost => 'Is this phone lost?';

  @override
  String get userResetPinLostHint =>
      'Tick any lost device. It is revoked at the same time and cannot set the new PIN.';

  @override
  String userResetPinNoDevices(String name) {
    return '$name has no devices yet.';
  }

  @override
  String userResetPinDone(String name) {
    return '$name\'s PIN has been reset.';
  }

  @override
  String userResetPinDoneRevoked(String name, int n) {
    return '$name\'s PIN has been reset. $n devices revoked.';
  }

  @override
  String get userDeactivate => 'Deactivate';

  @override
  String userDeactivateHint(String name) {
    return '$name will no longer be able to unlock this app.';
  }

  @override
  String userDeactivateTitle(String name) {
    return 'Deactivate $name?';
  }

  @override
  String userDeactivated(String name) {
    return '$name deactivated.';
  }

  @override
  String get userNotFound => 'User not found.';

  @override
  String get enrolQrTitle => 'Enrol a device';

  @override
  String enrolQrFor(String name) {
    return 'A device for $name';
  }

  @override
  String enrolQrNameHint(String name) {
    return 'Example: $name\'s phone';
  }

  @override
  String get enrolQrGenerate => 'Make the QR code';

  @override
  String enrolQrScanHint(String name) {
    return 'Ask $name to open the MAXCOM app on their device and scan this code.';
  }

  @override
  String get enrolQrCodeLabel => 'Or type this code';

  @override
  String enrolQrExpiresIn(String time) {
    return 'Expires in $time';
  }

  @override
  String get enrolQrExpired => 'The code has expired. Make a new one.';

  @override
  String get enrolQrNew => 'Make a new code';

  @override
  String get enrolQrCopy => 'Copy the code';

  @override
  String get enrolQrCopied => 'Code copied';

  @override
  String get enrolQrCaHint =>
      'Ask them to compare this certificate fingerprint with the one on their screen.';

  @override
  String get devicesEmpty => 'No devices enrolled yet.';

  @override
  String get devicesPair => 'Pair a TV screen';

  @override
  String get devicesRevoke => 'Revoke';

  @override
  String devicesRevokeTitle(String name) {
    return 'Revoke $name?';
  }

  @override
  String get devicesRevokeBody =>
      'This device will no longer unlock. To use it again, enrol it with a new QR code.';

  @override
  String get devicesRevoked => 'Revoked';

  @override
  String devicesRevokedToast(String name) {
    return '$name revoked.';
  }

  @override
  String get devicesKioskGroup => 'TV screens';

  @override
  String get platformAndroid => 'Android';

  @override
  String get platformIosWeb => 'iPad (Safari)';

  @override
  String get platformWeb => 'Web browser';

  @override
  String get platformKiosk => 'TV screen';

  @override
  String get pairingTitle => 'Pair a TV screen';

  @override
  String get pairingIntro =>
      'When it first starts, the TV shows a 6-digit code. Enter that code here to approve that screen.';

  @override
  String get pairingPendingTitle => 'Screens waiting';

  @override
  String get pairingPendingNone => 'No screen is waiting for approval.';

  @override
  String pairingPendingRow(String ip, String age) {
    return 'From $ip, $age ago';
  }

  @override
  String get pairingUnknownIp => 'unknown address';

  @override
  String get pairingCodeLabel => 'Code on the TV';

  @override
  String get pairingCodeRequired => 'Enter the 6 digits shown on the TV.';

  @override
  String get pairingNameLabel => 'Screen name (optional)';

  @override
  String get pairingNameHint => 'Example: Main screen';

  @override
  String get pairingApprove => 'Approve';

  @override
  String pairingDone(String name) {
    return 'Screen paired: $name';
  }

  @override
  String pairingDoneDetail(String ip, String age) {
    return 'Request from $ip, code $age old.';
  }

  @override
  String get pairingStrangerHint =>
      'Make sure that address is your surau TV, not a stranger\'s device.';

  @override
  String ageSeconds(int n) {
    return '$n seconds';
  }

  @override
  String ageMinutes(int n) {
    return '$n minutes';
  }

  @override
  String get auditEmpty => 'No changes recorded yet.';

  @override
  String get auditFilterAll => 'All';

  @override
  String get auditLoadMore => 'Load more';

  @override
  String get auditBefore => 'Before';

  @override
  String get auditAfter => 'After';

  @override
  String get auditNoDetail => 'No details';

  @override
  String get auditEmptyValue => 'empty';

  @override
  String get auditKeyEnabled => 'Switched on';

  @override
  String get auditKeyName => 'Name';

  @override
  String get auditKeyRoles => 'Roles';

  @override
  String get auditKeyActive => 'Active';

  @override
  String get auditKeyPinRequired => 'PIN must be set';

  @override
  String get auditKeyPlatform => 'Device kind';

  @override
  String get auditKeyRevoked => 'Revoked';

  @override
  String get auditKeyUser => 'User';

  @override
  String get auditKeyId => 'ID';

  @override
  String get auditEntityUsers => 'Users';

  @override
  String get auditEntityDevices => 'Devices';

  @override
  String get auditEntitySettings => 'Settings';

  @override
  String get auditEntityContent => 'Content';

  @override
  String get auditEntityPrayer => 'Prayer times';

  @override
  String get auditEntityIslamic => 'Islamic content';

  @override
  String get auditEntityAssets => 'Files';

  @override
  String get auditEntityPrayerDays => 'Prayer time data';

  @override
  String get auditKeyCount => 'Number of days';

  @override
  String get auditKeyFrom => 'From';

  @override
  String get auditKeyTo => 'To';

  @override
  String get auditKeySummary => 'Summary';

  @override
  String get auditKeyDetail => 'Details';

  @override
  String get auditActionIslamicFetch => 'Download';

  @override
  String get auditSystem => 'System';

  @override
  String get thisDevicePlatform => 'Type';

  @override
  String get thisDeviceUser => 'Enrolled in the name of';

  @override
  String get thisDeviceChangePin => 'Change PIN';

  @override
  String get thisDeviceChangePinHint =>
      'The same PIN is used on all your devices.';

  @override
  String get pinCurrentLabel => 'Current PIN';

  @override
  String get pinChanged => 'PIN changed';

  @override
  String get thisDeviceBiometricHint =>
      'Unlock with your fingerprint instead of typing the PIN.';

  @override
  String get thisDeviceBiometricOnTitle => 'Enter your PIN';

  @override
  String get thisDeviceBiometricOnBody =>
      'The PIN is kept securely on this device and opened only with your fingerprint.';

  @override
  String get thisDeviceBiometricOn => 'Fingerprint on';

  @override
  String get thisDeviceBiometricOff => 'Fingerprint off';

  @override
  String get thisDeviceLogoutHint =>
      'Lock this app. The device enrolment stays.';

  @override
  String get thisDeviceForget => 'Forget this device';

  @override
  String get thisDeviceForgetHint =>
      'Delete the key and enrolment on this device. You will need a new QR code to use it again.';

  @override
  String get thisDeviceForgetTitle => 'Forget this device?';

  @override
  String get thisDeviceForgetConfirm => 'Forget';

  @override
  String get settingsListHint =>
      'Switch each feature on or off and adjust its settings.';

  @override
  String get settingsReadOnlyHint =>
      'You can view the settings but not change them.';

  @override
  String get settingsLockedHint =>
      'This core feature is always on and cannot be switched off.';

  @override
  String get settingsFeatureOffHint =>
      'This feature is off. Its settings are kept and used again when it is switched on.';

  @override
  String get settingsNoSettings =>
      'This feature has no other settings. Switch it on or off only.';

  @override
  String get settingsSave => 'Save';

  @override
  String get settingsSaved => 'Settings saved';

  @override
  String get settingsChangedElsewhere =>
      'These settings were changed on another device. Saving will replace them.';

  @override
  String get settingsReset => 'Reset to defaults';

  @override
  String settingsResetTitle(String feature) {
    return 'Reset $feature?';
  }

  @override
  String get settingsResetBody =>
      'Every setting of this feature returns to the MAXCOM default.';

  @override
  String get settingsResetDone => 'Defaults restored';

  @override
  String get settingsCopyToAllDays => 'Copy to every day';

  @override
  String settingsCopiedToAllDays(String day) {
    return '$day values copied to every day';
  }

  @override
  String get settingsOptionalHint => 'Leave empty for the default.';

  @override
  String get settingsDecrease => 'Less';

  @override
  String get settingsIncrease => 'More';

  @override
  String get settingsNotFound => 'Feature not found.';

  @override
  String settingsSwitchedOn(String feature) {
    return '$feature switched on';
  }

  @override
  String settingsSwitchedOff(String feature) {
    return '$feature switched off';
  }

  @override
  String get settingsBackgroundsBuiltIn => 'Built-in images';

  @override
  String get settingsBackgroundsUploaded => 'Uploaded images';

  @override
  String get settingsBackgroundsHint =>
      'Ticked images rotate on the TV according to the Change image setting.';

  @override
  String get settingsBackgroundsEmpty =>
      'No image chosen. The TV uses the first built-in image.';

  @override
  String get settingsBackgroundsNone => 'No images uploaded yet.';

  @override
  String get settingsBackgroundsOffline =>
      'The list of uploaded images cannot be read now. The built-in images can still be chosen.';

  @override
  String get settingsBackgroundsOrder =>
      'The number on a picture is its turn on the TV. Tap the pictures in the order you want.';

  @override
  String get settingsBackgroundsUpload => 'Upload a background image';

  @override
  String get settingsBackgroundUploaded => 'Background image uploaded';

  @override
  String settingsBackgroundTile(int n) {
    return 'Uploaded image $n';
  }

  @override
  String settingsBackgroundRemove(String name) {
    return 'Remove $name';
  }

  @override
  String settingsBuiltInImage(int n) {
    return 'Image $n';
  }

  @override
  String get contentKindsHint => 'Choose a kind of content to view or edit.';

  @override
  String contentAdd(String kind) {
    return 'Add $kind';
  }

  @override
  String contentEmpty(String kind) {
    return 'No $kind yet.';
  }

  @override
  String get contentSearchHint => 'Search';

  @override
  String get contentNoMatch => 'No match.';

  @override
  String contentCount(int n) {
    return '$n records';
  }

  @override
  String contentNew(String kind) {
    return 'New $kind';
  }

  @override
  String contentEdit(String kind) {
    return 'Edit $kind';
  }

  @override
  String contentSaved(String kind) {
    return '$kind saved.';
  }

  @override
  String contentDeleteTitle(String kind) {
    return 'Delete this $kind?';
  }

  @override
  String get contentDeleteBody =>
      'It leaves the TV at once and cannot be brought back.';

  @override
  String contentDeleted(String kind) {
    return '$kind deleted.';
  }

  @override
  String get contentNotFound => 'Record not found.';

  @override
  String get contentCancelledBadge => 'Cancelled';

  @override
  String get contentCancelledHint =>
      'A cancelled kuliah is marked Cancelled on the TV and is not deleted.';

  @override
  String contentRefMissing(String what) {
    return '$what not found';
  }

  @override
  String contentRefUnknown(String what) {
    return 'Unknown $what';
  }

  @override
  String contentPickRef(String what) {
    return 'Choose $what';
  }

  @override
  String contentNoRefItems(String what) {
    return 'No $what yet. Add one under $what first.';
  }

  @override
  String get contentDateHint => 'Example: 2026-11-05';

  @override
  String get contentTimeHint => 'Example: 19:15';

  @override
  String get contentDateTimeHint => 'Example: 2026-11-20T20:30';

  @override
  String get contentPickDate => 'Pick a date';

  @override
  String get contentPickTime => 'Pick a time';

  @override
  String get contentDaysHint => 'Choose the days it is shown.';

  @override
  String get contentEveryDay => 'Every day';

  @override
  String get contentOptional => 'Optional';

  @override
  String get contentNone => 'None';

  @override
  String get contentUntil => 'until';

  @override
  String contentShownFromTo(String from, String to) {
    return '$from to $to';
  }

  @override
  String contentSurah(int n) {
    return 'Surah $n';
  }

  @override
  String contentMinutesBefore(int n, String slot) {
    return '$n minutes before $slot';
  }

  @override
  String get contentOff => 'Off';

  @override
  String contentOrder(int n) {
    return 'Order $n';
  }

  @override
  String contentRepeat(int n) {
    return '$n times';
  }

  @override
  String contentCharsLeft(int n) {
    return '$n characters left';
  }

  @override
  String get contentPhoneHint =>
      'This number is for the committee only and is not shown on the TV.';

  @override
  String get contentAssetHint =>
      'The image is shrunk automatically before upload.';

  @override
  String get imagePick => 'Choose image';

  @override
  String get imageChange => 'Change image';

  @override
  String get imageRemove => 'Remove image';

  @override
  String get imagePreparing => 'Preparing image';

  @override
  String get imageUploading => 'Uploading image';

  @override
  String get imageUploaded => 'Image uploaded';

  @override
  String get imagePickFailed =>
      'The image could not be read. Try another image.';

  @override
  String get imageFailed => 'The image could not be uploaded.';

  @override
  String get imageNone => 'No image';

  @override
  String imageSize(int w, int h) {
    return '$w x $h pixels';
  }

  @override
  String get imageAdjust => 'Adjust picture';

  @override
  String get imageAdjustLogo => 'Adjust logo';

  @override
  String get imageAdjusted => 'Picture adjusted';

  @override
  String get imageAdjustHint =>
      'Drag to move, pinch or scroll the mouse wheel to zoom. Keyboard: arrows move, plus and minus zoom, R rotates.';

  @override
  String get imageFrameHint => 'Drag the frame edges to change the area shown.';

  @override
  String get imageZoomIn => 'Zoom in';

  @override
  String get imageZoomOut => 'Zoom out';

  @override
  String get imageRotate => 'Rotate 90 degrees';

  @override
  String get imageReset => 'Reset';

  @override
  String imageStep(int n, int total) {
    return 'Step $n of $total';
  }

  @override
  String get imageStepCrop => 'Crop and background';

  @override
  String get imageStepSquare => 'Square icon';

  @override
  String get imageStepNext => 'Next';

  @override
  String get imageStepBack => 'Back';

  @override
  String get imageBgTitle => 'Background';

  @override
  String get imageBgRemove => 'Remove white background';

  @override
  String get imageBgRemoveColour => 'Remove background colour';

  @override
  String get imageBgCard => 'Put on a light card';

  @override
  String get imageBgKeep => 'Keep';

  @override
  String get imageBgNotPlain =>
      'This picture\'s background is not uniform. Removing it may look untidy.';

  @override
  String get imageBgTransparent =>
      'This picture\'s background is already transparent.';

  @override
  String get imageBefore => 'Before';

  @override
  String get imageAfter => 'After';

  @override
  String get imageSquareHint =>
      'This part becomes the app icon and the browser icon.';

  @override
  String get imageAppIcon => 'App icon';

  @override
  String get imageFavicon => 'Browser icon';

  @override
  String get logoHeaderPreview =>
      'How it looks on the TV screen and in the app';

  @override
  String get previewPhaseBiasa => 'Normal';

  @override
  String get previewPhaseAzan => 'Azan';

  @override
  String get previewPhaseIqamah => 'Iqamah';

  @override
  String get previewPhaseSolat => 'Prayer';

  @override
  String get previewPhaseJumaat => 'Friday';

  @override
  String get previewPhaseNoData => 'No data';

  @override
  String get previewIntro =>
      'The surau TV screen as it really is. Choose a state to see how it looks; this preview is read only and changes nothing on MAXCOM.';

  @override
  String get previewPhaseNeedsData =>
      'The state buttons need prayer data from MAXCOM.';

  @override
  String get previewLive => 'Live time';

  @override
  String previewClockFrom(String when) {
    return 'Screen clock starts $when';
  }

  @override
  String get previewReload => 'Reload';

  @override
  String get previewNoSession => 'Unlock again to see the preview.';

  @override
  String get previewTlsFailed =>
      'The preview could not connect safely. Try again.';

  @override
  String get previewTlsExpected => 'Expected certificate (SHA-256)';

  @override
  String get previewTlsPresented => 'Presented certificate (SHA-256)';

  @override
  String get posterPreviewButton => 'Preview on TV';

  @override
  String get posterPreviewTitle => 'Poster preview';

  @override
  String get posterPreviewHint =>
      'This is how the poster looks on the surau TV. Nothing changes on the real TV.';

  @override
  String get posterPreviewNeedsImage => 'Choose the poster picture first.';

  @override
  String get logoHint =>
      'PNG or JPEG. A wide or square logo; a white background can be removed after choosing it.';

  @override
  String get logoNotImage => 'The logo must be a PNG or JPEG picture.';

  @override
  String get logoMissing =>
      'The logo picture was not found on MAXCOM. Choose it again.';

  @override
  String get settingsPrayerDataHint => 'Download from e-Solat or upload a CSV';

  @override
  String get settingsIslamicRow => 'Quran & tilawah audio';

  @override
  String get settingsIslamicHint =>
      'Quran text and tilawah audio for the TV screen';

  @override
  String get islamicIntro =>
      'Content stored on MAXCOM so the TV screen can show it without internet.';

  @override
  String get islamicQuranTitle => 'Quran text';

  @override
  String get islamicQuranPresent => 'Quran text is ready';

  @override
  String get islamicQuranAbsent => 'Quran text not downloaded yet';

  @override
  String islamicQuranDetail(int ayat, String version) {
    return '$ayat verses, version $version';
  }

  @override
  String get islamicQuranHint =>
      'Shown on the verse card and the Quran reader on the TV screen.';

  @override
  String get islamicAudioTitle => 'Recitation (audio)';

  @override
  String islamicReciter(String reciter) {
    return 'Reciter: $reciter';
  }

  @override
  String islamicSurahsStored(int n) {
    return '$n surah stored';
  }

  @override
  String get islamicNoSurahs => 'No surah stored yet';

  @override
  String islamicCacheUsage(int used, int max) {
    return '$used MB of $max MB used';
  }

  @override
  String get islamicSurahPick => 'Choose a surah';

  @override
  String get islamicSurahSearch => 'Search by surah name or number';

  @override
  String get islamicSurahStored => 'Stored';

  @override
  String get islamicBusy => 'Already downloading';

  @override
  String get islamicJobQuran => 'Downloading Quran text';

  @override
  String islamicJobSurah(String surah) {
    return 'Downloading surah $surah';
  }

  @override
  String get islamicJobDone => 'Done';

  @override
  String get islamicJobDoneQuran => 'The Quran text is now stored on MAXCOM.';

  @override
  String islamicJobDoneSurah(String surah) {
    return 'Surah $surah is now stored on MAXCOM.';
  }

  @override
  String get islamicJobFailed => 'Download failed';

  @override
  String get islamicReadOnly => 'Only an admin can download content.';

  @override
  String get prayerDataDaysAhead => 'days of prayer data ahead';

  @override
  String get prayerDataDaysUnknown => 'Not known yet';

  @override
  String prayerDataZone(String zone) {
    return 'Zone $zone';
  }

  @override
  String get prayerDataZoneUnknown => 'The prayer time zone is not known yet.';

  @override
  String get prayerDataLow =>
      'Data is running low. Download the next year now.';

  @override
  String prayerDataNoYear(int year) {
    return 'There is no prayer time data for $year yet.';
  }

  @override
  String get prayerDataYearChoose => 'Choose the year';

  @override
  String prayerDataReplaceNote(int year) {
    return 'Existing data for $year will be replaced.';
  }

  @override
  String get prayerDataReplaceTitle => 'Replace existing data?';

  @override
  String get prayerDataReplaceAction => 'Replace';

  @override
  String get prayerDataPickFile => 'Choose a CSV file';

  @override
  String get prayerDataFileTooBig =>
      'The file is too large. The limit is 1 MB.';

  @override
  String get prayerDataFileUnreadable => 'The file could not be read.';

  @override
  String get statusPrayerDataNone =>
      'There is no prayer time data yet. Download or upload it now.';

  @override
  String get prayerDataUpdateTitle => 'Update data';

  @override
  String prayerDataYearLine(int year) {
    return 'Data for $year';
  }

  @override
  String fetchFromSource(String source) {
    return 'Download from $source into MAXCOM';
  }

  @override
  String refetchFromSource(String source) {
    return 'Download again from $source';
  }

  @override
  String get prayerDataFetchHint =>
      'MAXCOM downloads straight from JAKIM e-Solat. Needs internet at the surau.';

  @override
  String get prayerDataUploadCsv => 'Upload CSV';

  @override
  String get prayerDataUploadHint =>
      'The yearly CSV file from the e-Solat site for this zone.';

  @override
  String get prayerDataPasteTitle => 'Paste CSV contents';

  @override
  String get prayerDataPasteHint =>
      'Open the e-Solat CSV file, copy all of it and paste it here.';

  @override
  String get prayerDataPasteLabel => 'CSV contents';

  @override
  String get prayerDataPasteEmpty => 'Paste the CSV contents first.';

  @override
  String get prayerDataWorkingFetch => 'Downloading from e-Solat';

  @override
  String get prayerDataWorkingUpload => 'Uploading';

  @override
  String get prayerDataResultTitle => 'Prayer data updated';

  @override
  String prayerDataResult(int n, int m) {
    return 'Added $n, replaced $m';
  }

  @override
  String get liveTitle => 'Live broadcast';

  @override
  String get liveStart => 'Go live';

  @override
  String get liveStop => 'Stop';

  @override
  String get liveStopConfirm => 'Stop the broadcast?';

  @override
  String get liveStopConfirmBody =>
      'The surau screen and YouTube stop receiving this broadcast.';

  @override
  String get liveStopConfirmAction => 'Stop';

  @override
  String get liveStarting => 'Starting the broadcast';

  @override
  String get liveStopping => 'Stopping the broadcast';

  @override
  String get livePreparing => 'Getting the camera ready';

  @override
  String get liveKiosk => 'Surau screen';

  @override
  String get liveKioskHint => 'Over the surau Wi-Fi';

  @override
  String get liveYoutube => 'YouTube';

  @override
  String get liveYoutubeHint => 'The surau\'s YouTube channel';

  @override
  String get liveRecording => 'Recording';

  @override
  String get liveRecordingOn => 'Recording';

  @override
  String get liveRecordingOff => 'Switched off';

  @override
  String get liveRecordingWithLive => 'Starts with the broadcast';

  @override
  String liveRecordingParts(int n, String size) {
    return '$n parts, $size';
  }

  @override
  String get liveReady => 'Ready';

  @override
  String get liveNotUsed => 'Not used';

  @override
  String get liveConnecting => 'Connecting';

  @override
  String get liveOn => 'On air';

  @override
  String liveRetry(int n) {
    return 'Retrying in $n s';
  }

  @override
  String get liveDown => 'Disconnected';

  @override
  String get liveDuration => 'Duration';

  @override
  String get liveBitrate => 'Bitrate';

  @override
  String get liveFps => 'Frames per second';

  @override
  String get liveKuliahToday => 'Today';

  @override
  String get liveKuliahUpcoming => 'Upcoming';

  @override
  String get liveKuliahPick => 'Choose a kuliah';

  @override
  String get liveKuliahChange => 'Change';

  @override
  String get liveNoKuliah => 'No kuliah today';

  @override
  String get liveNoKuliahOption => 'No kuliah';

  @override
  String get liveNoKuliahHint => 'A broadcast without a kuliah title';

  @override
  String get liveFlip => 'Switch camera';

  @override
  String get liveMinimise => 'Hide settings';

  @override
  String get liveExpand => 'Show settings';

  @override
  String get liveMute => 'Mute the microphone';

  @override
  String get liveUnmute => 'Unmute the microphone';

  @override
  String get liveMuted => 'Microphone muted';

  @override
  String get liveWarnBattery => 'Battery low';

  @override
  String get liveWarnHot => 'Phone is hot';

  @override
  String get liveWarnScreen =>
      'Keep the screen on. Locking the screen stops the camera.';

  @override
  String get liveWarnStorage => 'Storage almost full';

  @override
  String get liveWarnNoInternet => 'No internet: YouTube is off';

  @override
  String get liveYoutubeNeedsSignIn => 'Sign in to YouTube first';

  @override
  String get liveYoutubeAskAdmin =>
      'Ask an administrator to sign in to YouTube';

  @override
  String get liveEnded => 'Broadcast ended';

  @override
  String liveYoutubeShort(int got, int total) {
    return 'YouTube received $got of $total minutes';
  }

  @override
  String get liveSaveRecording => 'Save the recording';

  @override
  String get liveRecordingSaved => 'Recording saved in Movies/MAXCOM';

  @override
  String get liveWatch => 'Watch on YouTube';

  @override
  String get liveYoutubeAccount => 'The surau\'s YouTube account';

  @override
  String get liveSignInHint =>
      'Connect the surau\'s YouTube channel to MAXCOM once. After that every kuliah can go to YouTube.';

  @override
  String get liveSignIn => 'Sign in to YouTube';

  @override
  String get liveSignInCode =>
      'Open google.com/device on your phone and enter this code';

  @override
  String get liveSignInOpen => 'Open google.com/device';

  @override
  String get liveSignInWaiting => 'Waiting for you to sign in';

  @override
  String liveSignedInAs(String channel) {
    return 'Connected to $channel';
  }

  @override
  String get liveSignOut => 'Sign out of YouTube';

  @override
  String get liveRecordingsPending => 'Recordings not saved yet';

  @override
  String liveRecordingsPendingBody(int n) {
    return '$n parts from the last broadcast are still on this device.';
  }

  @override
  String get liveBoxUnreachable =>
      'MAXCOM cannot be reached. The broadcast to the surau screen cannot start.';

  @override
  String get liveMediaPortsBlocked =>
      'The media ports are blocked by the MAXCOM computer\'s firewall. Video does not reach the kiosk or YouTube. Run the installation as administrator.';

  @override
  String get liveNoVideo =>
      'No video has reached MAXCOM yet. Check that the phone and the MAXCOM computer are on the same Wi-Fi network.';

  @override
  String liveBusy(String device) {
    return 'A broadcast is running from $device';
  }

  @override
  String get appLockTitle => 'App lock';

  @override
  String get appLockOffLine => 'App lock is off';

  @override
  String get appLockOffHint =>
      'Anyone holding this device can open MAXCOM. An administrator can turn the lock on in Settings.';

  @override
  String get appLockEnrolHint =>
      'The app lock is turned off by the administrator. This device opens MAXCOM without a PIN.';

  @override
  String get appLockOnTitle => 'Turn on the app lock?';

  @override
  String get appLockOnBody => 'Every user will be asked to set a PIN.';

  @override
  String get appLockOnConfirm => 'Turn on';

  @override
  String get appLockStatusOn => 'On';

  @override
  String get appLockStatusOff => 'Off';

  @override
  String get enrolDoneHintNoLock =>
      'Next time, open this app and it opens straight away, without a PIN.';

  @override
  String get unlockAuto => 'Unlocking';

  @override
  String get unlockAutoUnreachable => 'Cannot reach MAXCOM';

  @override
  String get unlockPinMissing => 'PIN required';

  @override
  String get unlockPinRequiredByAdmin =>
      'The administrator turned on the app lock. Choose 6 new digits.';

  @override
  String get auditKeyAppLock => 'App lock';

  @override
  String get syncSynced => 'Synced';

  @override
  String syncSyncedAt(String time) {
    return 'Synced $time';
  }

  @override
  String syncPending(int n) {
    return '$n changes waiting';
  }

  @override
  String syncPendingShort(int n) {
    return '$n waiting';
  }

  @override
  String get syncWakingShort => 'Connecting...';

  @override
  String get syncOffline => 'Offline, will sync later';

  @override
  String get syncOfflineShort => 'Offline';

  @override
  String get syncWaking => 'Connecting to the cloud...';

  @override
  String get syncRunning => 'Syncing';

  @override
  String get syncViaCloud => 'Through the cloud';

  @override
  String get syncViaBox => 'Through MAXCOM at the surau';

  @override
  String syncConflicts(int n) {
    return 'Conflicts: $n';
  }

  @override
  String get syncNow => 'Sync now';

  @override
  String get syncSheetTitle => 'Sync';

  @override
  String get syncConnection => 'Connection';

  @override
  String get syncNoConnection => 'No connection';

  @override
  String get syncLastSync => 'Last synced';

  @override
  String get syncNever => 'Never';

  @override
  String get syncWaitingLabel => 'Changes waiting';

  @override
  String get syncErrorLabel => 'Error';

  @override
  String get syncErrUnreachable =>
      'Neither MAXCOM nor the cloud can be reached';

  @override
  String get syncCloudUnreachable => 'The cloud cannot be reached';

  @override
  String get syncErrNeedsUnlock => 'Unlock again to sync';

  @override
  String get syncErrFailed => 'Sync did not succeed. It will try again.';

  @override
  String get syncDeviceRevoked => 'This device has been revoked';

  @override
  String get syncDeviceRevokedHint =>
      'An administrator revoked this device. The local copy was erased. Enrol again with a new QR code from the administrator.';

  @override
  String get syncSeeConflicts => 'See conflicts';

  @override
  String get syncOfflineHelp =>
      'Your changes are kept on this device and sent when there is a connection.';

  @override
  String get conflictsTitle => 'Conflicts';

  @override
  String get conflictsIntro =>
      'The changes below were not used. Use your version again, or discard it.';

  @override
  String conflictMine(String time) {
    return 'Your change at $time';
  }

  @override
  String conflictWinner(String name, String time) {
    return 'Kept: $name at $time';
  }

  @override
  String get conflictSomeoneElse => 'Another user';

  @override
  String get conflictRefusedForbidden => 'Refused: no permission';

  @override
  String get conflictRefusedLiveOnly => 'Refused: needs a connection';

  @override
  String get conflictRefusedTooLarge => 'Refused: file too large';

  @override
  String get conflictRefusedInvalid => 'Refused: invalid data';

  @override
  String get conflictRefusedOther => 'Refused by the server';

  @override
  String get conflictReapply => 'Use my version again';

  @override
  String get conflictDiscard => 'Discard';

  @override
  String get conflictReapplied => 'Your version was sent again';

  @override
  String get conflictDeleted => 'You deleted this item';

  @override
  String get conflictEntitySettings => 'Settings';

  @override
  String get conflictEntityUser => 'User';

  @override
  String get conflictEntityAsset => 'Picture';

  @override
  String get conflictEntityDevice => 'Device';

  @override
  String get conflictsEmpty => 'No conflicts';

  @override
  String get conflictsEmptyHint => 'All your changes were accepted.';

  @override
  String get liveOnlyTitle => 'Needs a connection';

  @override
  String liveOnlyBody(String action) {
    return 'This action needs a connection to MAXCOM at the surau or the cloud: $action. Try again when there is a network.';
  }

  @override
  String get liveOnlyNeedsConnection =>
      'Needs a connection to MAXCOM or the cloud';

  @override
  String get liveOnlyOk => 'Understood';

  @override
  String get assetTooLarge =>
      'The picture is too large. Choose a smaller picture.';

  @override
  String get syncSettingsTitle => 'Cloud sync';

  @override
  String get syncSettingsEnabled => 'Turn on cloud sync';

  @override
  String get syncSettingsUrl => 'Cloud address';

  @override
  String get syncSettingsUrlHint => 'Example: https://api.surau.my';

  @override
  String get syncSettingsUrlHttps =>
      'The cloud address must start with https://';

  @override
  String get syncSettingsStatus => 'Status';

  @override
  String get syncSettingsLinked => 'Linked to the cloud';

  @override
  String get syncYes => 'Yes';

  @override
  String get syncNo => 'No';

  @override
  String get syncSettingsLastPush => 'Last sent';

  @override
  String get syncSettingsLastPull => 'Last received';

  @override
  String get syncSettingsNone => 'None';

  @override
  String get syncSettingsStatusUnavailable =>
      'The sync status cannot be read now.';

  @override
  String get syncSettingsHelp =>
      'MAXCOM at the surau sends changes to the cloud when there is internet, and checks the cloud for changes every two minutes. Changes made from home reach the surau screen within a few minutes.';

  @override
  String get syncSettingsLinkNote =>
      'The link is made by the system administrator on MAXCOM.';

  @override
  String get syncSettingsRunDone => 'Sync finished';

  @override
  String get devicesEnrolNew => 'Enrol a new device';

  @override
  String get devicesEnrolPick => 'Who is this device for?';

  @override
  String get devicesEnrolViaCloud =>
      'You are connected through the cloud. The QR code is made by the cloud and can be scanned from home.';

  @override
  String get navUpload => 'YouTube upload';

  @override
  String get uploadTitle => 'YouTube upload';

  @override
  String get uploadIntro =>
      'Kuliah recordings from this device go straight to the surau\'s YouTube channel, and resume by themselves after a break.';

  @override
  String uploadQuotaLine(int n, int limit) {
    return '$n of $limit uploads today';
  }

  @override
  String uploadPart(int i, int n, int pct) {
    return 'Part $i of $n: $pct%';
  }

  @override
  String uploadPartName(int i, int n) {
    return 'Part $i of $n';
  }

  @override
  String uploadWhole(int pct) {
    return 'Full recording: $pct%';
  }

  @override
  String get uploadWholeName => 'Full recording';

  @override
  String get uploadWaitWifi => 'Waiting for Wi-Fi';

  @override
  String get uploadWaitNetwork => 'Waiting for a network';

  @override
  String uploadQuota(String time) {
    return 'Today\'s YouTube upload limit has been reached. Try again after $time';
  }

  @override
  String uploadQuotaShort(String time) {
    return 'Quota limit: try again after $time';
  }

  @override
  String get uploadQueued => 'Queued';

  @override
  String get uploadJoining => 'Joining the recording';

  @override
  String get uploadBeginning => 'Preparing the upload';

  @override
  String get uploadPaused => 'Paused';

  @override
  String get uploadFailed => 'Upload stopped';

  @override
  String get uploadDone => 'Done';

  @override
  String get uploadWatch => 'Watch on YouTube';

  @override
  String get uploadPause => 'Pause';

  @override
  String get uploadResume => 'Resume';

  @override
  String get uploadRetry => 'Try again';

  @override
  String get uploadAllowMobile => 'Use mobile data';

  @override
  String uploadFileSize(int mb) {
    return 'This file is $mb MB';
  }

  @override
  String get uploadRemove => 'Remove from the list';

  @override
  String uploadDeleteOn(String date) {
    return 'Will be deleted from this device on $date';
  }

  @override
  String get uploadDeleted => 'Deleted from this device';

  @override
  String liveCleanupAfterDays(int days) {
    String _temp0 = intl.Intl.pluralLogic(
      days,
      locale: localeName,
      other:
          'The recording will be deleted after $days days because YouTube has received the whole broadcast',
      one: 'The recording will be deleted after 1 day because YouTube has received the whole broadcast',
    );
    return '$_temp0';
  }

  @override
  String get liveCleanupNow =>
      'The recording will be deleted as soon as YouTube confirms the whole broadcast';

  @override
  String get uploadRemoveConfirm =>
      'The recording stays on the device. Remove this task?';

  @override
  String get uploadRemoveAction => 'Remove';

  @override
  String get uploadKeepOpenWeb =>
      'Keep MAXCOM open while uploading (Safari limit).';

  @override
  String get uploadBackgroundAndroid => 'The upload runs in the background.';

  @override
  String get uploadReplaceLive => 'Replace the broken broadcast';

  @override
  String get uploadKeepBoth => 'Keep both';

  @override
  String get uploadReplaceNote =>
      'The original broadcast will be made private once the upload finishes';

  @override
  String get uploadReplaceAsk => 'The YouTube broadcast was not complete';

  @override
  String get uploadReplaceAskBody =>
      'The full recording is uploaded as a new video. The broken broadcast can be made private afterwards, or kept as well.';

  @override
  String get uploadFromSummary => 'Upload the full recording to YouTube';

  @override
  String get uploadFromSummaryHint =>
      'YouTube did not receive all of this broadcast. The recording on this device can be sent now.';

  @override
  String get uploadJoinFailed => 'The recording files were uploaded one by one';

  @override
  String get uploadNoKuliah => 'Broadcast without a kuliah';

  @override
  String get uploadEmpty => 'No uploads';

  @override
  String get uploadEmptyHint =>
      'If the YouTube broadcast broke off or there was no internet, the kuliah recording can be sent from here after the broadcast ends.';

  @override
  String get liveCloudUnreachable => 'YouTube: the cloud cannot be reached';

  @override
  String get uploadErrorNoCloud =>
      'The cloud cannot be reached. The upload starts by itself once it can.';

  @override
  String get uploadErrorUnlock =>
      'Open MAXCOM and unlock it to continue the upload.';

  @override
  String get uploadErrorReauth =>
      'The surau\'s YouTube sign-in must be renewed by an Administrator.';

  @override
  String get uploadErrorOther =>
      'The upload stopped. Tap Try again to continue.';

  @override
  String get uploadKeepBothNote =>
      'The original broadcast stays on YouTube next to the new video';

  @override
  String get uploadSending => 'Uploading';

  @override
  String settingsCharMeter(int n, int max) {
    return '$n / $max characters';
  }

  @override
  String get settingsTitleTooLong => 'too long for YouTube, it will be cut';

  @override
  String get settingsTapToAdd => 'Tap to add:';

  @override
  String get settingsTemplatePreview => 'Preview, tonight\'s lecture';

  @override
  String settingsUnknownPlaceholder(String list) {
    return 'Unknown placeholder: $list';
  }

  @override
  String get settingsPresetHelp => 'Choose one or write your own.';

  @override
  String get settingsTestConnection => 'Test connection';

  @override
  String get settingsTestChecking => 'Checking...';

  @override
  String settingsTestOk(int ms) {
    return 'Success: $ms ms';
  }

  @override
  String get settingsTestBlocked => 'This address is not allowed';

  @override
  String get settingsTestTimeout => 'No answer within 5 seconds';

  @override
  String get settingsTestBadUrl => 'The address is not valid';

  @override
  String settingsTestStatus(int status) {
    return 'Failed, status $status';
  }

  @override
  String get settingsTestError => 'Cannot check right now';

  @override
  String get settingsLanjutan => 'Advanced';

  @override
  String get settingsLanjutanDimmed => 'Not used when Phone direct is chosen';

  @override
  String get settingsComingSoon => 'Available in a future release';

  @override
  String get settingsHexLabel => 'Colour code (hex)';

  @override
  String get settingsHexHelp => 'Example: #F6E7B8';

  @override
  String get settingsColourAutoHelp =>
      'Auto: MAXCOM picks white or dark by the brightness of each background.';

  @override
  String get settingsColourFixedHelp =>
      'This colour is used on every background.';

  @override
  String get settingsColourPreview => 'Preview over a background';

  @override
  String get swatchAuto => 'Auto';

  @override
  String get swatchWhite => 'White';

  @override
  String get swatchCream => 'Cream';

  @override
  String get swatchGold => 'Gold';

  @override
  String get swatchGreen => 'Green';

  @override
  String get swatchBlack => 'Black';

  @override
  String get swatchOther => 'Other';

  @override
  String get settingsAudioNone => 'No file';

  @override
  String get settingsAudioNoneHint => 'The first azan is not played';

  @override
  String settingsAudioItem(int n) {
    return 'Audio file $n';
  }

  @override
  String get settingsAudioUpload => 'Upload audio';

  @override
  String get settingsAudioUploading => 'Uploading...';

  @override
  String get settingsAudioUploaded => 'Audio uploaded';

  @override
  String get settingsAudioWebOnly =>
      'Upload MP3 files through MAXCOM in a browser.';

  @override
  String get settingsAudioUnavailable =>
      'The audio list cannot be read right now.';

  @override
  String get settingsAudioNotMp3 => 'The file must be an MP3, at most 20 MB.';

  @override
  String get settingsSurahSearch => 'Search surah';

  @override
  String settingsAyatCount(int n) {
    return '$n verses';
  }

  @override
  String settingsAyatHelp(String name, int n) {
    return '$name has $n verses: choose from 1 to $n. At most 5 verses at once.';
  }

  @override
  String settingsHijriMonthN(int n) {
    return 'Month $n';
  }

  @override
  String get settingsReciterFolder => 'EveryAyah folder name';

  @override
  String get settingsReciterFolderHelp =>
      'For example Muhammad_Ayyoub_128kbps. Check it with Test connection before saving.';

  @override
  String get settingsPickerNoMatch => 'No match';

  @override
  String get settingsSearchHint => 'Search settings, for example: azan';

  @override
  String settingsSearchFound(int n) {
    return '$n settings match. Matching groups open by themselves.';
  }

  @override
  String settingsGroupCount(int n, int on) {
    return '$n features, $on on';
  }

  @override
  String settingsGroupMatches(int n) {
    return '$n matches';
  }

  @override
  String get settingsLanjutanSubtitle =>
      'MAXCOM system settings, hidden from the Surau Administrator';

  @override
  String get settingsNoResults => 'No results';

  @override
  String settingsNoResultsBody(String q) {
    return 'No setting matches \"$q\". Try another word, for example azan, iqamah, colour or YouTube.';
  }

  @override
  String get settingsClearSearch => 'Clear search';

  @override
  String get settingsSavedShort => 'Saved';

  @override
  String get settingsOrderRow => 'Order of cards on the TV screen';

  @override
  String settingsOrderRowHint(int n) {
    return 'Drag to change the turn of $n cards.';
  }

  @override
  String get settingsOrderIntro =>
      'Drag a card to change its turn on the TV screen. Cards that are off are skipped.';

  @override
  String settingsOrderSeconds(int n) {
    return '$n seconds';
  }

  @override
  String get settingsOrderOff => 'off';

  @override
  String get settingsOrderUp => 'Move up';

  @override
  String get settingsOrderDown => 'Move down';

  @override
  String get settingsOrderSaved => 'Order saved';

  @override
  String get settingsOrderRestore => 'Restore the original order';

  @override
  String get settingsOrderRestored => 'Original order restored';

  @override
  String get settingsDeviceLockSection => 'This device';

  @override
  String get settingsDeviceLockTitle => 'Lock on this device';

  @override
  String get settingsDeviceLockBody =>
      'It cannot be switched off. A MAXCOM Administrator account can change system settings, so a PIN or fingerprint is always needed when MAXCOM opens on this device. Other users are not affected.';

  @override
  String get syncSettingsUrlFixed => 'Set when MAXCOM is linked to the cloud';

  @override
  String get enrolTtlLabel => 'Code valid for';

  @override
  String get enrolTtlHelp =>
      '10 minutes is the default. Choose longer if the device is not at hand yet, for example when sending it to a committee member who has not arrived.';

  @override
  String enrolTtlMinutes(int n) {
    return '$n minutes';
  }

  @override
  String get startNotJoined => 'This phone has not joined any surau yet';

  @override
  String get startSetupHint =>
      'If this MAXCOM is new, scan the setup QR on the TV screen.';

  @override
  String get startJoinHint =>
      'If you were invited, scan the QR that the Pentadbir shows you.';

  @override
  String get scanButton => 'Scan QR code';

  @override
  String get scanUnknown => 'QR code not recognised';

  @override
  String get setupFoundTitle => 'MAXCOM found';

  @override
  String get setupFoundHint =>
      'This MAXCOM is not set up yet. The first phone to set it up becomes the Pentadbir of the surau.';

  @override
  String get setupNotSetUp => 'Not set up yet';

  @override
  String get setupSurauName => 'Surau name';

  @override
  String get setupYourName => 'Your name';

  @override
  String get setupYourNameHint => 'Example: Haji Ali';

  @override
  String get setupPhoneName => 'Name of this phone';

  @override
  String get setupBoxName => 'Name of this MAXCOM';

  @override
  String get setupBoxNameHint => 'Example: MAXCOM Dewan Utama';

  @override
  String get setupFieldRequired => 'This field is required';

  @override
  String get setupConfirmTitle => 'Check before setting up';

  @override
  String get setupConfirmHint =>
      'Make sure the surau name is right. You can change it in Tetapan later.';

  @override
  String get setupFingerprintHint =>
      'Must match the fingerprint under the QR on the TV screen';

  @override
  String get setupFingerprintLabel => 'Fingerprint';

  @override
  String get setupIdLabel => 'MAXCOM ID';

  @override
  String get setupOnlyFirst =>
      'Only the first phone can set this MAXCOM up. Others join with a code from the Pentadbir.';

  @override
  String get setupSubmit => 'Set up MAXCOM';

  @override
  String get setupAlreadyDone => 'This surau is already set up';

  @override
  String get setupMismatch =>
      'The fingerprint does not match. Make sure you scanned the right MAXCOM screen';

  @override
  String get setupCodeInvalid =>
      'The QR has expired or was already used. Scan the new one on the TV screen.';

  @override
  String get setupExpired =>
      'The QR has expired. Scan the new one on the TV screen.';

  @override
  String setupRetryAfter(int minutes) {
    return 'Too many attempts. Try again in $minutes minutes.';
  }

  @override
  String get recoveryCodeTitle => 'Your recovery code';

  @override
  String get recoveryCodeOnce => 'This code is shown only once';

  @override
  String get recoveryCodePaper =>
      'Write this code on paper and keep it somewhere safe.';

  @override
  String get recoveryCodeWhy =>
      'If every Pentadbir loses their phone, this code lets a new Pentadbir be set.';

  @override
  String get recoveryCodeNoShare =>
      'Do not send it on WhatsApp and do not take a screenshot.';

  @override
  String get recoveryCodeNoShotWeb =>
      'This screen cannot block screenshots. Do not photograph it.';

  @override
  String get recoveryCodeWritten => 'I have written this code on paper';

  @override
  String setupDoneTitle(String surau) {
    return '$surau is ready';
  }

  @override
  String get setupDoneHint => 'Next steps';

  @override
  String get setupNextEnrol => 'Enrol another AJK phone';

  @override
  String get setupNextPair => 'Pair another TV screen';

  @override
  String get setupNextLink => 'Link to the MAXCOM cloud';

  @override
  String get setupToDashboard => 'Go to the dashboard';

  @override
  String get probeOk => 'Connection to MAXCOM works';

  @override
  String get recoveryFoundTitle => 'MAXCOM is in recovery mode';

  @override
  String get recoveryFoundHint =>
      'This MAXCOM has no Pentadbir who can sign in. Enter the recovery code written on paper.';

  @override
  String get recoveryLinkedHint =>
      'This MAXCOM is linked to the cloud. The Pentadbir MAXCOM will also be able to approve a new Pentadbir from the cloud (coming).';

  @override
  String get recoveryCodeField => 'Recovery code';

  @override
  String get recoveryCodeFieldHint =>
      '16 characters, for example ABCD-EFGH-JKLM-NPQR';

  @override
  String get recoveryCodeShort => 'The recovery code has 16 characters';

  @override
  String get recoveryBadCode =>
      'The recovery code is wrong. The QR on the TV must be scanned again';

  @override
  String get recoveryNotInRecovery =>
      'This MAXCOM already has an active Pentadbir';

  @override
  String get recoverySubmit => 'Recover as Pentadbir';

  @override
  String get recoveryDoneTitle => 'You are the Pentadbir of the surau';

  @override
  String joinTitle(String surau) {
    return 'Join $surau?';
  }

  @override
  String joinGreeting(String name) {
    return 'Assalamualaikum, $name';
  }

  @override
  String joinInvitedBy(String name) {
    return 'Invited by $name';
  }

  @override
  String joinValidUntil(String time) {
    return 'Invitation valid until $time';
  }

  @override
  String get joinBoxFingerprintHint =>
      'Compare with the fingerprint on the screen of the Pentadbir who gave you the code';

  @override
  String get joinYes => 'Yes, join this surau';

  @override
  String get joinNo => 'This is not my surau';

  @override
  String get errCodeExpired => 'The code has expired';

  @override
  String errCodeExpiredBody(String time) {
    return 'This code expired at $time. Ask the Pentadbir for a new one.';
  }

  @override
  String get errScanAnother => 'Scan another code';

  @override
  String get errCodeUsed => 'The code was already used';

  @override
  String get errCodeUsedBody =>
      'This code was already used. If it was not you, tell the Pentadbir.';

  @override
  String get errOtherSurau => 'This phone has already joined another surau';

  @override
  String errOtherSurauBody(String surau) {
    return 'This phone is already enrolled with $surau. Leave it first.';
  }

  @override
  String errLeaveFirst(String surau) {
    return 'Leave $surau';
  }

  @override
  String get errCodeMayExpire =>
      'The new code may expire while you leave. Ask for a new code if needed.';

  @override
  String get errUnreachableTitle => 'Cannot reach MAXCOM';

  @override
  String get errUnreachableBody =>
      'The phone cannot reach this MAXCOM. Try these steps.';

  @override
  String get errTryFirst1 =>
      'Make sure the phone is on the main surau Wi-Fi, not the guest Wi-Fi.';

  @override
  String get errTryFirst2 =>
      'Make sure the MAXCOM TV screen is on and showing the code.';

  @override
  String get errTryFirst3 =>
      'Turn mobile data off for a moment, then try again.';

  @override
  String get errRelaySoon => 'Joining through the MAXCOM cloud: coming soon';

  @override
  String get errNoCloud =>
      'This surau is not linked to the MAXCOM cloud, so joining works only on the surau Wi-Fi.';

  @override
  String get errRetry => 'Try again';

  @override
  String get errMismatch =>
      'The fingerprint does not match. Make sure you scanned the right MAXCOM screen';

  @override
  String devicesBoxRow(String id) {
    return 'MAXCOM · $id';
  }

  @override
  String get devicesBoxRowHint =>
      'The server and screen at the surau. It cannot be cancelled.';

  @override
  String get devicesAwayBanner =>
      'You are away from the surau network. Changes reach MAXCOM at the next sync.';

  @override
  String get devicesNeedLan => 'Needs the surau network';

  @override
  String get devicesNeedLanBody =>
      'Pairing a TV screen must be done on the surau Wi-Fi. Connect to it first.';

  @override
  String devicesPairedMirrors(String screen, String box) {
    return 'Screen $screen is paired. It now mirrors $box.';
  }

  @override
  String get leaveTitle => 'Leave the surau';

  @override
  String leaveBody(String surau) {
    return 'This phone will be removed from $surau. The key and data on this phone are deleted. You need a new QR code to join again.';
  }

  @override
  String leaveUnsynced(int n) {
    return '$n changes not synced yet';
  }

  @override
  String get leaveSyncFirst => 'Sync now';

  @override
  String get leaveConfirm => 'Leave';

  @override
  String get leaveLastAdminTitle => 'This phone is the only Pentadbir device';

  @override
  String get leaveLastAdminBody =>
      'Enrol another Pentadbir device first, so the surau is not left without a Pentadbir.';

  @override
  String get leaveEnrolOther => 'Enrol another Pentadbir device';

  @override
  String get leaveOfflineBody =>
      'MAXCOM cannot be reached. This device stays active on MAXCOM until a Pentadbir cancels it.';

  @override
  String get leaveForgetOnly => 'Only forget this device';

  @override
  String get leftTitle => 'You have left';

  @override
  String leftBody(String surau) {
    return 'This phone no longer belongs to $surau.';
  }

  @override
  String get leftJoinOther => 'Join another surau';

  @override
  String get scanEntry => 'Scan QR code';

  @override
  String get scanEntryHint => 'For a setup, recovery or enrolment code';

  @override
  String get netCheckEntry => 'Network check';

  @override
  String get netCheckTitle => 'Network check';

  @override
  String get netBoxReachable => 'MAXCOM can be reached';

  @override
  String get netBoxDown => 'MAXCOM cannot be reached';

  @override
  String get netCloudReachable => 'The MAXCOM cloud can be reached';

  @override
  String get netCloudDown => 'The MAXCOM cloud cannot be reached';

  @override
  String get netCloudNone => 'Not linked to the cloud';

  @override
  String netLastSync(String when) {
    return 'Synced $when';
  }

  @override
  String get netNeverSynced => 'Never synced';

  @override
  String get rotateRecoveryTitle => 'New recovery code';

  @override
  String get rotateRecoveryBody =>
      'The old code stops working at once. The new code is shown only once.';

  @override
  String get rotateRecoveryConfirm => 'Make a new code';

  @override
  String codeUsedAt(String time) {
    return 'Used at $time';
  }

  @override
  String codeReuseAttempts(int n) {
    return 'Tried to use $n times';
  }

  @override
  String enrolQrFingerprint(String fp) {
    return 'MAXCOM fingerprint: $fp';
  }

  @override
  String get setupNotConfirmed =>
      'The reply from MAXCOM did not arrive. The setup may already be done. Tap Try again to send the same request.';

  @override
  String get recoveryNotConfirmed =>
      'The reply from MAXCOM did not arrive. The recovery may already be done. Tap Try again to send the same request.';

  @override
  String get usersNoRecoveryWarning =>
      'This MAXCOM has no recovery code yet. If every Pentadbir phone is lost there is no way back in. Tap New recovery code and keep the code somewhere safe.';

  @override
  String get fingerprintCompare =>
      'Make sure this code matches the code on the TV screen';

  @override
  String get fingerprintSame => 'Same, continue';

  @override
  String get fingerprintDifferent => 'Not the same, cancel';

  @override
  String get scanOnlyTvQr =>
      'Scan only the QR on the MAXCOM TV screen. Do not scan a QR from paper, a picture or a message.';

  @override
  String get probeAskTitle => 'Send a connection test?';

  @override
  String probeAskBody(String host) {
    return 'This phone will contact $host. Continue only if this address is your MAXCOM.';
  }

  @override
  String get probeAskConfirm => 'Yes, send the test';

  @override
  String get recoveryBoxLocked => 'This MAXCOM has been suspended';

  @override
  String get recoveryBoxLockedBody =>
      'Recovery cannot be done now. Please contact your MAXCOM installer.';

  @override
  String get hadisReorderNeedsConnection =>
      'Reordering needs a connection to MAXCOM';

  @override
  String get hadisTitle => 'Hadith';

  @override
  String get hadisListIntro =>
      'The hadith shown on the TV\'s hadith card. All are saved on MAXCOM, so the TV keeps showing them even with no internet.';

  @override
  String get hadisNetOnlineTitle => 'MAXCOM is online.';

  @override
  String get hadisNetOnlineBody => 'HadeethEnc is searched through MAXCOM.';

  @override
  String get hadisNetOfflineTitle => 'MAXCOM has no internet.';

  @override
  String get hadisNetOfflineBody =>
      'The saved hadith are still shown on the TV.';

  @override
  String get hadisStatSaved => 'saved on MAXCOM';

  @override
  String get hadisStatShown => 'on the TV';

  @override
  String get hadisStatProvider => 'from HadeethEnc';

  @override
  String get hadisFind => 'Find hadith';

  @override
  String get hadisAddOwn => 'Add your own';

  @override
  String get hadisFindNeedsInternet =>
      'Finding hadith needs internet through MAXCOM. Adding your own still works.';

  @override
  String get hadisOrderTitle => 'Order on the TV';

  @override
  String get hadisOrderHintSwitch => 'Switch: show or hide. Bin: remove';

  @override
  String get hadisOrderHintSort => 'Arrows: reorder. Bin: remove';

  @override
  String get hadisFilterAll => 'All';

  @override
  String get hadisFilterOwn => 'Own list';

  @override
  String get hadisFilterProvider => 'HadeethEnc';

  @override
  String get hadisSort => 'Sort';

  @override
  String get hadisSortDone => 'Done';

  @override
  String get hadisNoneFiltered => 'No hadith in this filter.';

  @override
  String get hadisNoneSaved =>
      'No hadith saved yet. Press Find hadith or Add your own.';

  @override
  String get hadisListHelp =>
      'This order is the order on the TV when the source is Both. The source and turnover are in Settings, Hadith. The switch hides a hadith from the TV but keeps it saved; Remove deletes it from the MAXCOM list.';

  @override
  String hadisNearFull(int n, int max) {
    return 'Almost full ($n/$max)';
  }

  @override
  String get hadisTagLong => 'Long for TV';

  @override
  String get hadisTagShort => 'Short';

  @override
  String get hadisTagMedium => 'Medium';

  @override
  String get hadisTagUpdated => 'Text updated';

  @override
  String get hadisTagHidden => 'Off';

  @override
  String get hadisTagGradeBlocked => 'Hidden: the new grade is not allowed';

  @override
  String get hadisTagUnstated => 'Source not stated';

  @override
  String get hadisTagPending => 'Waiting for connection';

  @override
  String get hadisGradeBlocked => 'Grade not allowed';

  @override
  String get hadisGradeUnknown => 'Unknown grade';

  @override
  String get hadisShowOnTv => 'Show on the TV';

  @override
  String get hadisRemoveTip => 'Remove from the list';

  @override
  String get hadisMoveUp => 'Up';

  @override
  String get hadisMoveDown => 'Down';

  @override
  String get hadisRemoveTitle => 'Remove this hadith?';

  @override
  String get hadisRemoveOwnBold => 'Permanent, cannot be undone.';

  @override
  String get hadisRemoveOwnBody =>
      'This own-list hadith is deleted from MAXCOM and there is no other copy. To hide it from the TV only, use the switch.';

  @override
  String get hadisRemoveProviderBody =>
      'This hadith is deleted from the MAXCOM list and no longer shown on the TV. It can be added again from Find hadith when MAXCOM has internet. To hide it only, use the switch.';

  @override
  String get hadisRemoveOwnConfirm => 'Remove for good';

  @override
  String get hadisRemoveConfirm => 'Remove';

  @override
  String get hadisRemoved => 'Hadith removed from the list';

  @override
  String get hadisUpdateTitle => 'Text updated at HadeethEnc';

  @override
  String hadisUpdateBody(String id) {
    return 'HadeethEnc changed hadith $id after it was saved on MAXCOM.';
  }

  @override
  String get hadisUpdateBody2 =>
      'The TV still shows the saved text. Check the new text before replacing it.';

  @override
  String get hadisUpdateNewText => 'New text';

  @override
  String get hadisUpdateKeep => 'Keep the old text';

  @override
  String get hadisUpdateUse => 'Use the new text';

  @override
  String get hadisUpdateDone =>
      'New text in use. The TV updates in a few seconds.';

  @override
  String get hadisUpdateGradeBlocked =>
      'New text in use, but its new grade is not allowed. This hadith is now hidden from the TV.';

  @override
  String get hadisUpdateNote =>
      'HadeethEnc changed the text of this hadith. The TV still shows the saved text.';

  @override
  String get hadisUpdateReview => 'Review';

  @override
  String get hadisSearchHint => 'Find hadith, for example: prayer';

  @override
  String get hadisSearchGo => 'Search';

  @override
  String get hadisTabCategories => 'Categories';

  @override
  String get hadisTabResults => 'Results';

  @override
  String get hadisPickToRead =>
      'Choose a hadith from the list to see its details.';

  @override
  String get hadisOfflineTitle => 'Searching needs internet';

  @override
  String get hadisOfflineBody =>
      'MAXCOM has no internet connection now. Hadith are searched at HadeethEnc through MAXCOM, not from the phone.';

  @override
  String hadisOfflineSaved(int n) {
    return '$n hadith saved on MAXCOM';
  }

  @override
  String get hadisOfflineSavedTail => 'and still shown on the TV.';

  @override
  String get hadisManageSaved => 'Manage saved hadith';

  @override
  String get hadisStillOffline =>
      'Still no internet at MAXCOM. Check the cable or Wi-Fi.';

  @override
  String get hadisCatalogEmptyTitle =>
      'The HadeethEnc list has not been downloaded';

  @override
  String get hadisCatalogEmptyBody =>
      'Download this list to MAXCOM so hadith can be searched and chosen.';

  @override
  String get hadisCatalogEmptyAsk =>
      'Ask the Administrator to download this list.';

  @override
  String get hadisDownloadNow => 'Download now';

  @override
  String hadisDownloading(int done, int total) {
    return 'Downloading $done of $total';
  }

  @override
  String get hadisDownloadStarting => 'Starting the download';

  @override
  String get hadisDownloadFailed =>
      'The download stopped. Press again to continue.';

  @override
  String get hadisAllCategories => 'All categories';

  @override
  String hadisCatOriginalName(String name) {
    return 'Original API name: $name';
  }

  @override
  String hadisSubcategories(int n) {
    return '$n subcategories';
  }

  @override
  String hadisCount(int n) {
    return '$n hadith';
  }

  @override
  String get hadisInCategory => 'Hadith in this category';

  @override
  String get hadisNoItems => 'No hadith.';

  @override
  String get hadisLoadMore => 'Load more';

  @override
  String get hadisCredit =>
      'Source: HadeethEnc.com, Encyclopedia of Translated Hadith. Malay.';

  @override
  String hadisResultsCount(int n, String q) {
    return '$n results for \"$q\"';
  }

  @override
  String get hadisTypeKeyword => 'Type a keyword';

  @override
  String get hadisResultsScope => 'Title and Malay text';

  @override
  String get hadisNoResults =>
      'No matching hadith. Try another word or open a category.';

  @override
  String get hadisSearchExample =>
      'For example: prayer, supplication, charity.';

  @override
  String get hadisDetailTitle => 'Hadith details';

  @override
  String hadisDetailKicker(String id) {
    return 'HADITH $id  HADEETHENC';
  }

  @override
  String get hadisTranslation => 'Malay translation';

  @override
  String get hadisArabicText => 'Arabic text';

  @override
  String get hadisArabicHidden =>
      'The Arabic text is hidden in this preview. TV options are in Settings, Hadith.';

  @override
  String get hadisDetails => 'Details';

  @override
  String get hadisGrade => 'Grade';

  @override
  String get hadisAttribution => 'Attribution';

  @override
  String get hadisCategories => 'Categories';

  @override
  String hadisSourceLine(String id) {
    return 'Source: HadeethEnc.com (Encyclopedia of Translated Hadith), ID $id';
  }

  @override
  String get hadisPreviewOnTv => 'Preview on the TV';

  @override
  String hadisLongNote(int n) {
    return '($n characters). On the TV this hadith is split into parts that change by themselves.';
  }

  @override
  String get hadisAddKiosk => 'Add to the kiosk';

  @override
  String get hadisAlreadyKiosk => 'Already on the kiosk';

  @override
  String get hadisAddNeedsInternet => 'Adding needs internet through MAXCOM.';

  @override
  String get hadisAdded => 'Hadith added to the kiosk';

  @override
  String get hadisAddGradeBlocked =>
      'The grade of this hadith is not allowed on the TV';

  @override
  String get hadisAddTooLong => 'The text is too long for MAXCOM';

  @override
  String hadisAddLimit(int max) {
    return 'The list is full ($max hadith). Remove another hadith first.';
  }

  @override
  String get hadisAddUnavailable =>
      'MAXCOM cannot reach HadeethEnc now. Try again.';

  @override
  String get hadisSettingsIntro =>
      'The hadith card on the TV: where hadith come from, how many a day and what is shown.';

  @override
  String get hadisSourceTitle => 'Hadith source';

  @override
  String hadisSourceOwnDesc(int n, int on) {
    return '$n hadith typed or imported ($on on).';
  }

  @override
  String hadisSourceProviderDesc(int n, int on) {
    return '$n hadith chosen from HadeethEnc.com, saved on MAXCOM ($on on).';
  }

  @override
  String get hadisSourceBoth => 'Both';

  @override
  String get hadisSourceBothDesc =>
      'Own list and HadeethEnc, in the order of the Hadith list.';

  @override
  String get hadisMixTitle => 'Order';

  @override
  String get hadisMixList => 'List order';

  @override
  String get hadisMixAlternate => 'Alternate';

  @override
  String get hadisMixRandom => 'Random';

  @override
  String get hadisMixListHelp => 'The order you set in the Hadith list.';

  @override
  String get hadisMixAlternateHelp =>
      'One from the own list, then one from HadeethEnc, and so on.';

  @override
  String get hadisMixRandomHelp => 'A random order each day.';

  @override
  String get hadisTurnTitle => 'Turnover';

  @override
  String get hadisChangeTitle => 'Change hadith';

  @override
  String get hadisChangeDay => 'One set a day';

  @override
  String get hadisChangeCard => 'Every appearance';

  @override
  String get hadisChangeDayHelp =>
      'The same hadith all day; a new set tomorrow.';

  @override
  String get hadisChangeCardHelp =>
      'The next hadith each time the hadith card appears.';

  @override
  String get hadisPerDay => 'Hadith per day';

  @override
  String get hadisPerDayHelp => 'Take turns in the content cycle';

  @override
  String get hadisPerDayNotUsed => 'Not used for Every appearance';

  @override
  String get hadisDuration => 'Card time';

  @override
  String get hadisDurationHelp => 'Each time the hadith card appears';

  @override
  String hadisSeconds(int n) {
    return '$n s';
  }

  @override
  String get hadisTodayTitle => 'On the TV today';

  @override
  String hadisTodayItem(int n) {
    return 'Hadith $n';
  }

  @override
  String get hadisTodayEmpty =>
      'No hadith is on for this source. The hadith card is skipped on the TV.';

  @override
  String hadisTodayMore(int n) {
    return 'and $n more';
  }

  @override
  String get hadisDisplayTitle => 'Shown on the TV';

  @override
  String get hadisFieldArabic => 'Arabic text';

  @override
  String get hadisFieldArabicHelp => 'Original text, right to left';

  @override
  String get hadisFieldMalay => 'Malay translation';

  @override
  String get hadisFieldMalayHelp => 'The main text of the card';

  @override
  String get hadisFieldAttribution => 'Attribution';

  @override
  String get hadisFieldAttributionHelp =>
      'For example: Muttafaq alaih, Riwayat Muslim';

  @override
  String get hadisFieldGrade => 'Grade';

  @override
  String get hadisFieldGradeHelp => 'Sahih or Hasan chip';

  @override
  String get hadisFieldCredit => 'Source credit';

  @override
  String get hadisFieldCreditHelp =>
      'Source: HadeethEnc.com at the foot of the card';

  @override
  String get hadisRequired => 'Required';

  @override
  String get hadisFontTitle => 'Text size';

  @override
  String get hadisFontAuto => 'Auto';

  @override
  String get hadisFontAutoLong => 'Auto by length';

  @override
  String get hadisFontSmall => 'Small';

  @override
  String get hadisFontMedium => 'Medium';

  @override
  String get hadisFontLarge => 'Large';

  @override
  String get hadisFontHelp => 'Long text is made smaller so that it fits';

  @override
  String get hadisPreviewTitle => 'Preview';

  @override
  String get hadisPreviewHelp =>
      'The preview uses today\'s first hadith and the options above.';

  @override
  String get hadisPreviewSample =>
      'Actions are but by intentions, and every person shall have only that which he intended.';

  @override
  String get hadisPreviewSampleSource => 'Narrated by al-Bukhari and Muslim';

  @override
  String get hadisGradesTitle => 'Grades allowed on the TV';

  @override
  String get hadisGradesNote =>
      'HadeethEnc writes grades in Arabic; MAXCOM turns them into Malay labels.';

  @override
  String get hadisLocked => 'Locked off';

  @override
  String get hadisSettingsSaved =>
      'Hadith settings saved to MAXCOM. The TV updates in a few seconds.';

  @override
  String get hadisTvTag => 'HADITH';

  @override
  String hadisTvPart(int i, int n) {
    return 'Part $i of $n';
  }

  @override
  String get hadisTvCredit => 'Source: HadeethEnc.com';

  @override
  String get hadisTvCountdown => 'Asar in';

  @override
  String get hadisTvPrayerImsak => 'Imsak';

  @override
  String get hadisTvPrayerSubuh => 'Subuh';

  @override
  String get hadisTvPrayerSyuruk => 'Syuruk';

  @override
  String get hadisTvPrayerZohor => 'Zohor';

  @override
  String get hadisTvPrayerAsar => 'Asar';

  @override
  String get hadisTvPrayerMaghrib => 'Maghrib';

  @override
  String get hadisTvPrayerIsyak => 'Isyak';

  @override
  String get locTitle => 'Surau location';

  @override
  String get locIntroMy =>
      'The location sets the calculated prayer times and the suggested JAKIM zone. No map: search an address or type coordinates.';

  @override
  String get locIntro =>
      'The location sets the calculated prayer times. No map: search an address or type coordinates.';

  @override
  String get locPickerSearch => 'Search';

  @override
  String get locPickerNone => 'Nothing matches.';

  @override
  String get locCountry => 'Country';

  @override
  String get locCountrySearch => 'Search countries';

  @override
  String get locCountryOfficial => 'Official source: JAKIM e-Solat';

  @override
  String get locCountryNoOfficial =>
      'No official source in MAXCOM; calculation or file';

  @override
  String locZonesCount(int n) {
    return '$n time zones';
  }

  @override
  String get locTimezone => 'Time zone';

  @override
  String get locTimezoneSearch => 'Search time zones';

  @override
  String get locTimezoneOwn => 'This country';

  @override
  String get locTimezoneOther => 'Others';

  @override
  String get locTimezoneFromCountry => 'Set from the country';

  @override
  String locZoneRow(String zone) {
    return 'JAKIM zone: $zone';
  }

  @override
  String get locZoneNone => 'No JAKIM zone chosen';

  @override
  String get locChange => 'Change';

  @override
  String get locHowTitle => 'How to set the location';

  @override
  String get locModeSearch => 'Search address';

  @override
  String get locModeCoordinates => 'Type coordinates';

  @override
  String get locSearchLabel => 'Address or town';

  @override
  String get locSearchHint => 'For example: Taman Sri Gombak';

  @override
  String get locSearchGo => 'Search';

  @override
  String get locSearchHelp =>
      'The search is sent once when Search is pressed. Needs internet.';

  @override
  String locResultsTitle(int n, String q) {
    return '$n results for \"$q\"';
  }

  @override
  String get locNoResults => 'No results. Try a town name or type coordinates.';

  @override
  String get locAttribution => '(c) OpenStreetMap contributors';

  @override
  String get locOfflineHint => 'MAXCOM has no internet; type the coordinates';

  @override
  String get locCoordinatesHelp =>
      'For a MAXCOM without internet. Copy the coordinates from a map app on your phone (long press on the surau).';

  @override
  String get locConfirmed => 'Confirmed';

  @override
  String get locCoordinates => 'Coordinates';

  @override
  String get locCity => 'Town name to display';

  @override
  String get locCityHelp =>
      'Shown at the foot of the TV screen when times are calculated.';

  @override
  String get locLatitude => 'Latitude';

  @override
  String get locLatitudeHelp => 'North positive, south negative';

  @override
  String get locLatitudeError => 'Latitude must be between -90 and 90';

  @override
  String get locLongitude => 'Longitude';

  @override
  String get locLongitudeHelp => 'East positive, west negative';

  @override
  String get locLongitudeError => 'Longitude must be between -180 and 180';

  @override
  String locSuggestTitle(String code) {
    return 'Suggested JAKIM zone: $code';
  }

  @override
  String locSuggestUse(String code) {
    return 'Use $code';
  }

  @override
  String get locSuggestOther => 'Choose another zone';

  @override
  String locZoneUsed(String code) {
    return 'Zone $code in use';
  }

  @override
  String locNoOfficial(String country) {
    return 'No official source for $country in MAXCOM. Prayer times come from the local calculation and imported files.';
  }

  @override
  String get locChangeWarning =>
      'Changing the location recalculates the calculated times for all days. Official data and imported files do not change.';

  @override
  String get locNeedCoordinates =>
      'The location needs coordinates because prayer times are calculated';

  @override
  String get locSave => 'Save location';

  @override
  String get locSaved => 'Location saved. MAXCOM recalculates the times.';

  @override
  String get locNoChange => 'Nothing to save';

  @override
  String get zonTitle => 'JAKIM zone';

  @override
  String get zonField => 'JAKIM zone';

  @override
  String get zonSearch => 'Search code, state or district';

  @override
  String zonHasData(String years) {
    return 'Data held: $years';
  }

  @override
  String get zonNoData => 'No data: will be downloaded';

  @override
  String get zonUnknown => 'This zone is not in the list';

  @override
  String get zonSuggestedGroup => 'Suggested from the location';

  @override
  String zonSuggested(String code) {
    return 'Suggested from the location: $code';
  }

  @override
  String get zonUse => 'Use';

  @override
  String get zonSave => 'Save zone';

  @override
  String zonSaved(String code) {
    return 'Zone $code saved';
  }

  @override
  String zonWillFetch(String code) {
    return 'The data for $code will be downloaded after saving, if this MAXCOM downloads by itself.';
  }

  @override
  String get zonMalaysiaOnly => 'JAKIM zones are for a surau in Malaysia only.';

  @override
  String get zonPlaceUnnamed => 'Surau location';

  @override
  String get zonNoCoordinates => 'Coordinates not set';

  @override
  String get zonListTitle => 'JAKIM zone list';

  @override
  String zonListCount(int n) {
    return '$n zones from e-Solat. The copy in MAXCOM is used when offline.';
  }

  @override
  String zonListMeta(int n, String when) {
    return '$n zones from e-Solat, updated $when. The copy in MAXCOM is used when offline.';
  }

  @override
  String get zonRefresh => 'Update the zone list';

  @override
  String zonRefreshed(int n) {
    return 'Zone list updated: $n zones';
  }

  @override
  String get srcTitle => 'Prayer time sources';

  @override
  String get srcOrderTitle => 'Order of sources';

  @override
  String get srcMoveUp => 'Up';

  @override
  String get srcMoveDown => 'Down';

  @override
  String get srcOrderHelpMy =>
      'The first source with data for a day is used. In Malaysia JAKIM normally comes first.';

  @override
  String get srcOrderHelp =>
      'The first source with data for a day is used. The official source is not shown because this country has none.';

  @override
  String get srcOfficialNotFirst =>
      'JAKIM official data is no longer preferred';

  @override
  String get srcOfficial => 'Official source';

  @override
  String srcOfficialDetail(String zone) {
    return 'JAKIM e-Solat, zone $zone';
  }

  @override
  String get srcOfficialNone => 'No data downloaded yet.';

  @override
  String srcOfficialStored(String year) {
    return '$year stored.';
  }

  @override
  String srcOfficialFetched(String year, String when) {
    return '$year stored (downloaded $when).';
  }

  @override
  String get srcCalc => 'Local calculation';

  @override
  String get srcCalcShort => 'Calculation';

  @override
  String get srcCalcNote =>
      'Always available, calculated on MAXCOM with no internet.';

  @override
  String get srcFile => 'Imported file';

  @override
  String get srcFileDetail => 'The surau\'s own timetable';

  @override
  String srcFileDays(int n) {
    return '$n days ahead from a file.';
  }

  @override
  String get srcFileNone => 'No prayer time import.';

  @override
  String get srcMethod => 'Method';

  @override
  String get srcMethodAuto => 'Auto by country';

  @override
  String srcMethodAutoNamed(String method) {
    return 'Auto ($method)';
  }

  @override
  String get srcMadhab => 'Madhab for Asr';

  @override
  String get srcMadhabAuto => 'Auto';

  @override
  String get srcMadhabShafi => 'Shafi';

  @override
  String get srcMadhabHanafi => 'Hanafi';

  @override
  String get srcHigh => 'High latitude rule';

  @override
  String get srcHighAuto => 'Auto';

  @override
  String get srcHighMiddle => 'Middle of the night';

  @override
  String get srcHighSeventh => 'Seventh of the night';

  @override
  String get srcHighTwilight => 'Twilight angle';

  @override
  String get srcHighNoEffect => 'No effect below latitude 48 degrees';

  @override
  String get srcAdjustTitle => 'Minute adjustments';

  @override
  String get srcAdjustClear => 'Clear adjustments';

  @override
  String get srcImsakMinutes => 'Imsak, minutes before Subuh';

  @override
  String srcMinutes(int n) {
    return '$n minutes';
  }

  @override
  String get srcLess => 'Less';

  @override
  String get srcMore => 'More';

  @override
  String srcPreviewTitle(String date) {
    return 'Today, $date';
  }

  @override
  String get srcPreviewNone =>
      'No times for today. Set the surau location first.';

  @override
  String get srcPreviewPrayer => 'Prayer';

  @override
  String get srcPreviewDiff => 'Diff';

  @override
  String get srcPreviewNote =>
      'Diff = the first source minus the calculation, in minutes, with the saved settings.';

  @override
  String get srcCrossTitle => 'Cross-check';

  @override
  String get srcCrossToggle => 'Flag days that differ by more than 2 minutes';

  @override
  String get srcCrossHelp =>
      'Compare the calculation with the first source every day.';

  @override
  String get srcCrossNone => 'No days to compare this month.';

  @override
  String srcCrossFlagged(String month) {
    return 'days flagged in $month';
  }

  @override
  String get srcCrossLargest => 'Largest difference per prayer (minutes)';

  @override
  String get srcCrossOk =>
      'The calculation agrees within 2 minutes on every day.';

  @override
  String get srcUseSuggestion => 'Use the suggested adjustment';

  @override
  String get srcSuggestionNote =>
      'The suggestion is added to the saved adjustment. Not saved until Save is pressed.';

  @override
  String get srcSave => 'Save';

  @override
  String get srcSaved => 'Prayer time sources saved.';

  @override
  String get pdLoadFailed => 'The daily data cannot be read right now.';

  @override
  String get pdSourceOfficial => 'Source: JAKIM e-Solat';

  @override
  String pdSourceOfficialOn(String date) {
    return 'Source: JAKIM e-Solat, downloaded $date';
  }

  @override
  String get pdSourceFile => 'Source: Imported file';

  @override
  String get pdSourceCalc => 'Source: Local calculation';

  @override
  String get pdDaysTitle => 'Times for each day';

  @override
  String get pdViewMonth => 'Month';

  @override
  String get pdViewYear => 'Year';

  @override
  String pdFlagged(int n) {
    return 'Cross-check: $n days flagged this month.';
  }

  @override
  String get pdAdjustLink => 'Adjust the calculation';

  @override
  String get pdPrevMonth => 'Previous month';

  @override
  String get pdNextMonth => 'Next month';

  @override
  String get pdMonthEmpty => 'No data for this month.';

  @override
  String get pdTapHint => 'Tap a day to see its source and make a correction.';

  @override
  String get pdLinkImport => 'Import a prayer time file';

  @override
  String get pdLinkRecords => 'Import records';

  @override
  String get pdGridDay => 'Day';

  @override
  String get pdLegendOfficial => 'Official (JAKIM)';

  @override
  String get pdLegendCalc => 'Local calculation';

  @override
  String get pdLegendFile => 'Imported file';

  @override
  String get pdLegendCorrection => 'Manual correction';

  @override
  String get pdLegendFlag => 'Over 2 minutes from the calculation';

  @override
  String get pdEmergency => 'Temporary calculation';

  @override
  String get pdUsed => 'In use';

  @override
  String get pdImsakDerived =>
      'Imsak derived from Subuh because the file has none.';

  @override
  String get pdOverrideKhutbah => 'Friday khutbah';

  @override
  String pdOverrideIqamah(String prayer) {
    return 'Iqamah $prayer';
  }

  @override
  String get pdCorrectionTitle => 'Correct one prayer';

  @override
  String get pdCorrectionTime => 'Time (24 hours)';

  @override
  String get pdCorrectionReason => 'Reason for the correction';

  @override
  String get pdCorrectionReasonHint => 'For example: JAKIM amendment notice';

  @override
  String get pdCorrectionSave => 'Save correction';

  @override
  String get pdCorrectionRemove => 'Remove correction';

  @override
  String get pdOfficialChanged =>
      'The official value changed since this correction was made. Your correction is still in use.';

  @override
  String get pdCorrectionIgnored =>
      'The correction for this prayer is not being used because it would put the day\'s times out of order. Check this correction or remove it.';

  @override
  String get impFileUnused =>
      'This timetable will not be used while Local calculation is above File in Prayer time sources.';

  @override
  String get pdTimeInvalid => 'The time must be 24-hour, for example 13:05';

  @override
  String get pdReasonNeeded => 'The reason needs at least 3 characters';

  @override
  String get impTitle => 'Import prayer times';

  @override
  String get impTargetLabel => 'IMPORT TARGET';

  @override
  String impTargetZone(String zone) {
    return 'zone $zone';
  }

  @override
  String get impStepPick => 'Pick file';

  @override
  String get impStepCheck => 'Check';

  @override
  String get impStepConfirm => 'Confirm';

  @override
  String get impTemplateTitle => 'Download a template';

  @override
  String get impTemplateHelp =>
      'Filled with the surau name and every date of the year. Times in 24-hour format.';

  @override
  String get impTemplateCsv => 'CSV';

  @override
  String get impTemplateExcel => 'Excel';

  @override
  String get impTemplateCopied =>
      'CSV template copied. Paste it into a new file.';

  @override
  String get impTemplateExcelNone =>
      'The Excel template cannot be downloaded on this device yet. Use the CSV template.';

  @override
  String get impColumnsTitle => 'Template columns';

  @override
  String get impColumnsList =>
      'date, imsak, subuh, syuruk, dhuha, zohor, asar, maghrib, isyak, note. Masjid only: jumaat_khutbah, iqamah_subuh, iqamah_zohor, iqamah_asar, iqamah_maghrib, iqamah_isyak.';

  @override
  String get impPick => 'Pick a file';

  @override
  String get impPickOther => 'Pick another file';

  @override
  String get impPickHelp =>
      'CSV up to 1 MB or Excel (.xlsx) up to 2 MB. Also the e-Solat JAKIM yearly file.';

  @override
  String get impTooBig => 'File too large. Limits: CSV 1 MB, Excel 2 MB.';

  @override
  String get impWrongType => 'Only CSV or Excel (.xlsx) files are accepted.';

  @override
  String get impUnreadable => 'The file cannot be read.';

  @override
  String get impSheet => 'Sheet';

  @override
  String impEsolatDetected(String zone) {
    return 'e-Solat file: saved as the Official source for zone $zone';
  }

  @override
  String impErrors(int n) {
    return '$n errors. Nothing was saved.';
  }

  @override
  String get impErrorsTitle => 'Errors';

  @override
  String impRow(int n) {
    return 'Row $n';
  }

  @override
  String impClean(int n, String from, String to) {
    return 'No errors. $n days, $from to $to. Not saved yet.';
  }

  @override
  String get impDetectedColumns => 'Columns recognised';

  @override
  String get impPerMonth => 'Days per month';

  @override
  String get impFirstWeek => 'First week';

  @override
  String get impLastWeek => 'Last week';

  @override
  String get impOverlapTitle => 'Overlapping days';

  @override
  String impOverlapCounts(int official, int file, int calc) {
    return 'Already held: $official official days, $file days from a file, $calc calculated days.';
  }

  @override
  String get impOverlapReplace => 'Replace';

  @override
  String get impOverlapReplaceNote =>
      'The new file replaces days held from an old file.';

  @override
  String get impOverlapKeep => 'Keep existing';

  @override
  String get impOverlapKeepNote =>
      'Days from an old file stay; only new dates are added.';

  @override
  String get impOverlapFill => 'Fill empty days only';

  @override
  String get impOverlapFillNote => 'Only days with no official or file data.';

  @override
  String impWouldWrite(int total, int inserted, int replaced, int skipped) {
    return 'To save: $total days. Added $inserted, replaced $replaced, skipped $skipped.';
  }

  @override
  String get impSave => 'Save';

  @override
  String impConfirmTitle(int n, String target) {
    return 'Save $n days to $target?';
  }

  @override
  String impConfirmBody(int inserted, int replaced) {
    return '$inserted days added, $replaced days replaced. An import record is created and can be undone later.';
  }

  @override
  String impConfirmOfficialTitle(String zone) {
    return 'Save as the Official source for zone $zone?';
  }

  @override
  String get impConfirmOfficialBody =>
      'Days already held for this zone will be replaced.';

  @override
  String get impDone => 'Import saved';

  @override
  String impDoneDetail(int inserted, int replaced, int skipped) {
    return 'Added $inserted, replaced $replaced, skipped $skipped';
  }

  @override
  String impOfficialDone(String zone) {
    return 'Saved as the Official source for zone $zone';
  }

  @override
  String get impGoRecords => 'See import records';

  @override
  String get impMysoTitle => 'Import previous display data';

  @override
  String get impMysoIntro =>
      'Upload this surau\'s export zip from its previous display system. Content and timer settings are merged; prayer times are not included.';

  @override
  String get impMysoPick => 'Pick the zip file';

  @override
  String get impMysoPickHelp =>
      'Made with the MAXCOM export script. Limit 64 MB.';

  @override
  String get impMysoTooBig => 'File too large. The limit is 64 MB.';

  @override
  String get impMysoWorking => 'Uploading and checking';

  @override
  String get impMysoMismatchTitle => 'Different surau name';

  @override
  String impMysoMismatch(String file, String target) {
    return 'This file is from \"$file\"; import into \"$target\"?';
  }

  @override
  String get impMysoMismatchYes => 'Yes, import into this surau';

  @override
  String impMysoNameInFile(String name) {
    return 'Name in the file: $name';
  }

  @override
  String impMysoTarget(String name) {
    return 'Target: $name';
  }

  @override
  String get impMysoPlanTitle => 'Trial run';

  @override
  String get impMysoKind => 'Kind';

  @override
  String get impMysoCreated => 'New';

  @override
  String get impMysoUpdated => 'Updated';

  @override
  String get impMysoSame => 'Same';

  @override
  String get impMysoSkipped => 'Skipped';

  @override
  String get impMysoTimers => 'Use the timer settings from the previous system';

  @override
  String get impMysoImport => 'Import';

  @override
  String get impMysoDiscard => 'Discard';

  @override
  String get impMysoDone => 'Previous display data import finished';

  @override
  String get rekTitle => 'Import records';

  @override
  String get rekIntro =>
      'Every import for this surau only. JAKIM downloads are not listed here; see the prayer data page.';

  @override
  String get rekNone => 'No prayer time imports yet.';

  @override
  String get rekStateActive => 'Active';

  @override
  String rekStateUndone(String date) {
    return 'Undone $date';
  }

  @override
  String get rekSha => 'sha256';

  @override
  String get rekRows => 'Rows';

  @override
  String get rekRange => 'Range';

  @override
  String rekRangeValue(String from, String to) {
    return '$from to $to';
  }

  @override
  String get rekOverlap => 'Overlap';

  @override
  String get rekWho => 'By';

  @override
  String get rekWhen => 'When';

  @override
  String get rekUndo => 'Undo import';

  @override
  String get rekUndoTitle => 'Undo this import?';

  @override
  String rekUndoBody(int inserted, int replaced) {
    return '$inserted days removed, $replaced days restored to the data before this import.';
  }

  @override
  String rekUndone(int n) {
    return 'Import undone. $n days restored.';
  }

  @override
  String get rekBlockedTitle => 'Can no longer be undone';

  @override
  String get rekBlockedOk => 'Got it';

  @override
  String get finrClose => 'Close';

  @override
  String get finrReportTitle => 'Monthly report';

  @override
  String get finrMonthThis => 'This month';

  @override
  String get finrMonthLast => 'Last month';

  @override
  String get finrMonthPick => 'Pick a month...';

  @override
  String get finrNoMonths => 'No month with entries yet';

  @override
  String get finrStatusReady => 'Draft ready for the committee meeting';

  @override
  String get finrStatusReadySub => 'Every entry this month has been synced.';

  @override
  String get finrStatusReadyPending =>
      'Some entries on this device have not synced yet.';

  @override
  String get finrStatusOpenMonth => 'The month is not over';

  @override
  String finrStatusOpenMonthSub(String date) {
    return 'This report is a draft up to $date.';
  }

  @override
  String get finrStatusClosed => 'Final';

  @override
  String finrStatusClosedSub(String date) {
    return 'Closed on $date. The figures are frozen.';
  }

  @override
  String get finrPillDraft => 'Draft';

  @override
  String get finrPillFinal => 'Final';

  @override
  String finrPendingNote(int n) {
    return '$n entries on this device have not synced yet. This screen shows them, but the PDF only holds entries that have reached MAXCOM.';
  }

  @override
  String get finrFullPage => 'Full A4 page';

  @override
  String get finrDownloadPdf => 'Download PDF';

  @override
  String get finrDownloaded => 'PDF saved in Downloads.';

  @override
  String get finrShare => 'Share';

  @override
  String get finrPrint => 'Print';

  @override
  String get finrShareNoteFailed =>
      'The share could not be recorded in the audit history.';

  @override
  String get finrLiveOnlyAction => 'download or share the PDF report';

  @override
  String get finrCloseMonth => 'Close the month (Final)';

  @override
  String finrCloseTitle(String month) {
    return 'Close $month?';
  }

  @override
  String get finrCloseBody =>
      'Once final, the report is frozen and entries dated in that month can no longer be added. An administrator can reopen it, and that is recorded in the audit history.';

  @override
  String finrCloseOrder(String month) {
    return 'Close $month first.';
  }

  @override
  String get finrClosedDone => 'The month is closed. The report is frozen.';

  @override
  String get finrReopenMonth => 'Reopen the month';

  @override
  String finrReopenTitle(String month) {
    return 'Reopen $month?';
  }

  @override
  String get finrReopenBody =>
      'The frozen report is discarded and new entries can be added again. This is recorded in the audit history.';

  @override
  String get finrReopenDone => 'The month is open again.';

  @override
  String get finrShareTitle => 'Share report';

  @override
  String get finrShareWarning =>
      'This report holds the surau\'s financial data and donors\' names. Share it only with the committee. Sharing is recorded in the audit history.';

  @override
  String get finrShareGo => 'Choose an app';

  @override
  String get finrAuditTitle => 'Finance audit history';

  @override
  String get finrAuditIntro =>
      'Every finance action: who, which device, when it was entered and when it synced. It cannot be changed.';

  @override
  String get finrAuditEmpty => 'No finance action has been recorded yet.';

  @override
  String get finrAuditStale => 'Shown from the last copy that was read.';

  @override
  String get finrFilterAll => 'All';

  @override
  String get finrFilterIn => 'Collections';

  @override
  String get finrFilterOut => 'Payments';

  @override
  String get finrFilterCor => 'Corrections';

  @override
  String get finrFilterSet => 'Settings';

  @override
  String get finrFilterReport => 'Reports';

  @override
  String get finrFilterRefused => 'Refused';

  @override
  String finrAuditIn(String ref, String fund) {
    return 'Collection $ref, $fund';
  }

  @override
  String finrAuditOut(String ref, String fund) {
    return 'Payment $ref, $fund';
  }

  @override
  String finrAuditCor(String ref, String fund) {
    return 'Correction $ref, $fund';
  }

  @override
  String finrAuditOpening(String fund) {
    return 'Opening balance, $fund';
  }

  @override
  String finrAuditFund(String name) {
    return 'Fund setting: $name';
  }

  @override
  String finrAuditPerihal(String name) {
    return 'Category setting: $name';
  }

  @override
  String finrAuditMonthClosed(String month) {
    return '$month closed as final';
  }

  @override
  String finrAuditMonthOpened(String month) {
    return '$month reopened';
  }

  @override
  String finrAuditReportDownloaded(String month) {
    return '$month report downloaded (PDF)';
  }

  @override
  String finrAuditReportShared(String month) {
    return '$month report shared';
  }

  @override
  String finrAuditRefused(String reason) {
    return 'Refused: $reason';
  }

  @override
  String get finrRefusedRevoked => 'Device revoked';

  @override
  String get finrRefusedMonthClosed => 'That month is already final';

  @override
  String get finrRefusedFundArchived => 'That fund is archived';

  @override
  String get finrRefusedOther => 'Refused by MAXCOM';

  @override
  String get finrColAction => 'Action';

  @override
  String get finrColWho => 'Who';

  @override
  String get finrColDevice => 'Device';

  @override
  String get finrColSignature => 'Device signature';

  @override
  String get finrColEntered => 'Entered';

  @override
  String get finrColReceived => 'Received at MAXCOM';

  @override
  String get finrColCloud => 'Reached the cloud';

  @override
  String get finrSigOk => 'Valid';

  @override
  String get finrNotYet => 'Not known yet';

  @override
  String get finrNoDevice => 'Unknown';

  @override
  String finrDetailReason(String reason) {
    return 'Reason: $reason';
  }

  @override
  String get finrFundsTitle => 'Fund settings';

  @override
  String get finrFundsIntro =>
      'Administrators only. A fund cannot be deleted; a fund no longer in use is archived.';

  @override
  String get finrFundsSection => 'Funds';

  @override
  String finrBalance(String amount) {
    return 'Balance $amount';
  }

  @override
  String finrTarget(String amount) {
    return 'target $amount';
  }

  @override
  String get finrOnTv => 'TV screen';

  @override
  String get finrRename => 'Rename';

  @override
  String get finrArchive => 'Archive';

  @override
  String get finrArchiveNeedsZero => 'Balance must be RM 0.00';

  @override
  String finrArchiveTitle(String name) {
    return 'Archive $name?';
  }

  @override
  String get finrArchiveBody =>
      'This fund is hidden from new choices. Old history and reports stay, and the fund can be restored.';

  @override
  String finrArchivedOn(String date) {
    return 'Archived $date, balance RM 0.00';
  }

  @override
  String get finrRestore => 'Restore';

  @override
  String get finrAddFund => 'Add a fund';

  @override
  String get finrAddFundHelp => 'A new fund starts with a balance of RM 0.00.';

  @override
  String get finrRenameFund => 'Rename the fund';

  @override
  String get finrRenameFundHelp =>
      'The new name applies from today. Old history and reports stay.';

  @override
  String get finrFundName => 'Fund name';

  @override
  String get finrFundNameInvalid => 'The name must be 1 to 60 characters';

  @override
  String get finrFundNameTaken => 'That fund name is already in use';

  @override
  String get finrFundPublic => 'Show on the TV screen';

  @override
  String get finrFundTarget => 'Target (optional)';

  @override
  String get finrAmountInvalid => 'Not a valid amount. Example: 1,356.80';

  @override
  String get finrCardSection => 'Fund card on the TV screen';

  @override
  String get finrCardFigure => 'Figure shown';

  @override
  String get finrFigBalance => 'Current balance';

  @override
  String get finrFigMonth => 'Collected this month';

  @override
  String get finrFigLast => 'Latest entry';

  @override
  String finrCardHighlight(int seconds) {
    return 'Highlight a new entry: $seconds seconds';
  }

  @override
  String get finrCardShowTarget => 'Show the target bar';

  @override
  String get finrCardQr => 'DuitNow QR code';

  @override
  String get finrPerihalSection => 'Categories';

  @override
  String get finrPerihalIn => 'Collection categories';

  @override
  String get finrPerihalOut => 'Payment categories';

  @override
  String get finrPerihalSystemNote =>
      'A category with a lock belongs to the system and cannot be changed.';

  @override
  String get finrAddPerihal => 'Add a category';

  @override
  String get finrRenamePerihal => 'Change the category';

  @override
  String get finrPerihalLabel => 'Category name';

  @override
  String get finrPerihalNameTaken => 'That category name is already in use';

  @override
  String get finrModuleSection => 'Module';

  @override
  String get finrModuleTitle => 'Finance';

  @override
  String get finrModuleHelp =>
      'Turning it off hides the Finance menu. Data is not deleted.';

  @override
  String get finrModuleOffTitle => 'Turn Finance off?';

  @override
  String get finrModuleOffBody =>
      'The Finance menu is hidden for every role. Old finance data is kept, not deleted.';

  @override
  String get finrOpeningTitle => 'Opening balances';

  @override
  String get finrOpeningNone => 'Not entered yet';

  @override
  String finrOpeningDone(String date, int n) {
    return 'Entered $date, $n funds';
  }

  @override
  String get finrSetupTitle => 'Opening balances';

  @override
  String finrSetupIntro(String date) {
    return 'Enter each fund\'s balance on $date. RM 0.00 is allowed. These balances are the starting point of the books.';
  }

  @override
  String get finrSetupNoFunds =>
      'There are no funds yet. Add a fund first in Fund settings.';

  @override
  String get finrSetupSave => 'Save opening balances';

  @override
  String get finrSetupHint =>
      'Once saved, an opening balance can only be changed with a correction.';

  @override
  String get finrSetupDoneTitle => 'Opening balances are entered';

  @override
  String get finrSetupDoneHelp =>
      'To change one balance, use a correction on that opening balance entry.';

  @override
  String get finrOpenFinance => 'Open Finance';

  @override
  String get offlineSessionBanner =>
      'Offline: using saved data. Changes will sync automatically.';

  @override
  String get unlockCloudWaking => 'Starting the MAXCOM cloud...';

  @override
  String get unlockAutoRetrying => 'Trying again automatically.';

  @override
  String offlinePinWrong(int left) {
    return 'Wrong PIN. $left tries left.';
  }
}
