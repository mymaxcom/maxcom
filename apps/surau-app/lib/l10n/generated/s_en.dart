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
  String get navSettings => 'Configuration';

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
  String get settingsTitle => 'Configuration';

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
  String get dashAttention => 'Needs attention';

  @override
  String dashPrayerDaysLeft(int n) {
    return 'Prayer time data runs out in $n days';
  }

  @override
  String get dashPrayerNone => 'No prayer time data';

  @override
  String dashLockedUsers(int n) {
    return 'Users locked out: $n';
  }

  @override
  String get dashLockedHint => 'Unlock them in Users & devices.';

  @override
  String get dashOnTv => 'On the TV screen now';

  @override
  String get dashSeeTv => 'See the TV screen';

  @override
  String get dashSystem => 'System details';

  @override
  String get dashAppVersion => 'App version';

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
  String get roleMediaHint => 'Content and posters';

  @override
  String get roleLive => 'Live Broadcast';

  @override
  String get roleLiveHint =>
      'Opens the Live menu and its settings: external camera, audio sources, screen, YouTube and recording';

  @override
  String get usersMediaNoLiveHint =>
      'The Media role can no longer broadcast live. Give the Live Broadcast role to the users who need it.';

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
    return 'All devices and codes of $name are deleted. The name stays in the log and finance records.';
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
  String get enrolBoxOnly =>
      'Device codes must be made by the surau box. Use the Surau Admin phone on the surau Wi-Fi.';

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
  String get enrolQrCodeLabel => 'Check code';

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
  String get devicesRevoke => 'Delete';

  @override
  String devicesRevokeTitle(String name) {
    return 'Delete $name?';
  }

  @override
  String get devicesRevokeBody =>
      'This device will no longer unlock. To use it again, enrol it with a new QR code.';

  @override
  String get devicesRevoked => 'Deleted';

  @override
  String devicesRevokedToast(String name) {
    return '$name deleted.';
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
  String get auditEntitySettings => 'Configuration';

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
  String get settingsShortNameHint => 'e.g. SDM';

  @override
  String get settingsShortNameHelper => 'Leave empty to use the surau name.';

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
  String get settingsBackgroundUploaded =>
      'Background image saved, will upload';

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
  String contentSurah(int n, String name) {
    return 'Surah $n · $name';
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
  String get imageUploading => 'Saving image';

  @override
  String get imageQueued => 'Uploading…';

  @override
  String get imageLost => 'Upload failed';

  @override
  String get imageChooseAgain => 'Choose the picture again';

  @override
  String get imageUploaded => 'Image uploaded';

  @override
  String get imageSaved => 'Image saved, will upload';

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
  String get errcVideoBusy =>
      'Another video is being uploaded to MAXCOM. Try again shortly.';

  @override
  String get errcCameraStale => 'The camera settings changed. Try again.';

  @override
  String get errcCameraPasswordAgain => 'Type the camera password again.';

  @override
  String get liveSignInByAdmin => 'An administrator is signing in to YouTube.';

  @override
  String liveSignedInAs(String channel) {
    return 'Connected to $channel';
  }

  @override
  String get liveSignOut => 'Sign out of YouTube';

  @override
  String get liveYoutubeConnected => 'YouTube connected';

  @override
  String liveYoutubeConnectedSnack(String channel) {
    return 'YouTube connected: $channel';
  }

  @override
  String get liveYoutubeAtSurauOnly =>
      'Sign in to YouTube or change the channel on the surau Wi-Fi only.';

  @override
  String get liveYoutubeNotConnected => 'YouTube is not connected';

  @override
  String liveDestOn(String channel) {
    return 'YouTube: Yes, $channel';
  }

  @override
  String get liveDestOff => 'YouTube: No';

  @override
  String get liveDestSkip =>
      'YouTube is not selected: the broadcast goes to the surau screen only.';

  @override
  String get liveDestNone => 'YouTube is not connected yet';

  @override
  String liveYoutubeUnknown(String channel) {
    return 'YouTube: cannot be checked right now (last seen: $channel)';
  }

  @override
  String get liveYoutubeUnknownNoLast => 'YouTube: cannot be checked right now';

  @override
  String get liveYoutubeAskTitle => 'YouTube cannot be used';

  @override
  String liveYoutubeAskBody(String reason) {
    return 'YouTube cannot be used right now: $reason. Start the broadcast to the surau screen only?';
  }

  @override
  String get liveYoutubeWhyNoInternet => 'there is no internet';

  @override
  String get liveYoutubeWhyRevoked => 'it needs to be connected again';

  @override
  String get liveYoutubeWhyNeedsSignIn => 'it is not signed in';

  @override
  String get liveYoutubeWhyAskAdmin =>
      'it is not signed in, ask an administrator to sign in';

  @override
  String get liveYoutubeWhyUnknownNoLast =>
      'the account cannot be checked right now';

  @override
  String liveYoutubeWhyUnknown(String channel) {
    return 'the account cannot be checked right now (last seen: $channel)';
  }

  @override
  String get tvLangArNeedsUpdate => 'Update MAXCOM to use Arabic';

  @override
  String get tvLangArAskTitle => 'Change the TV screen language to Arabic?';

  @override
  String get tvLangArAskBody =>
      'The Arabic Art theme suits a TV screen in Arabic best. You can change it back under TV screen language.';

  @override
  String get tvLangArAskYes => 'Yes';

  @override
  String get tvLangArAskNo => 'No';

  @override
  String get liveYoutubeAskYes => 'Yes';

  @override
  String get liveYoutubeChoiceFailed =>
      'The YouTube choice could not be saved. Try again.';

  @override
  String get liveYoutubeRevoked => 'YouTube needs to be connected again';

  @override
  String get liveDestOnPlain => 'YouTube: Yes';

  @override
  String get liveDestLink => 'Connect';

  @override
  String get liveDestLive2 => 'To the surau screen and YouTube';

  @override
  String get liveDestLive1 => 'To the surau screen only';

  @override
  String get liveDestRec => 'Recording: Yes';

  @override
  String get liveDestRecOff => 'Recording: No';

  @override
  String get liveSignInOpenGoogle => 'Open the Google page';

  @override
  String liveSignInWaitingMin(int minutes) {
    return 'Waiting for approval… (expires in $minutes min)';
  }

  @override
  String get liveSignInDenied => 'Sign-in was cancelled';

  @override
  String get liveSignInExpired => 'The code has expired. Try again.';

  @override
  String get liveSignInRevoked =>
      'YouTube access was withdrawn or has expired. Please sign in again.';

  @override
  String get liveSignOutChange => 'Change channel / Sign out';

  @override
  String get liveSignOutConfirmTitle => 'Change channel or sign out?';

  @override
  String get liveSignOutConfirmBody =>
      'The next live will not reach YouTube until someone signs in again.';

  @override
  String get liveSignOutConfirmAction => 'Sign out';

  @override
  String liveSettingsSummaryConnected(String channel, String camera) {
    return 'YouTube connected: $channel. External camera $camera';
  }

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
      'Anyone holding this device can open MAXCOM. An administrator can turn the lock on in Configuration.';

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
  String get linkCloudConnected => 'MAXCOM cloud: connected';

  @override
  String get linkCloudConnecting => 'MAXCOM cloud: connecting';

  @override
  String get linkCloudSyncing => 'MAXCOM cloud: sending changes';

  @override
  String get linkCloudDisconnected => 'MAXCOM cloud: not connected';

  @override
  String get linkBoxConnected => 'MAXCOM at the surau: connected';

  @override
  String get linkBoxConnecting => 'MAXCOM at the surau: connecting';

  @override
  String get linkBoxSyncing => 'MAXCOM at the surau: sending changes';

  @override
  String get linkBoxDisconnected => 'MAXCOM at the surau: cannot be reached';

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
  String get conflictEntitySettings => 'Configuration';

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
      'You are outside the surau network. A QR code can only be made on the surau Wi-Fi.';

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
  String get uploadErrorNoBox =>
      'The upload starts by itself when the phone is on the surau Wi-Fi.';

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
  String get settingsReencodeUnsupported =>
      'Re-encode is not supported on this box. Use Copy as is.';

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
    return '$name has $n verses. At most 3 verses at once.';
  }

  @override
  String get settingsAyatCountLabel => 'Number of verses';

  @override
  String settingsAyatSurahEnds(int n) {
    return 'This surah ends at verse $n.';
  }

  @override
  String settingsAyatTv(String name, int n, int a, int b) {
    return 'Shown on the TV: Surah $name ($n): verses $a to $b';
  }

  @override
  String settingsAyatTvOne(String name, int n, int a) {
    return 'Shown on the TV: Surah $name ($n): verse $a';
  }

  @override
  String settingsAyatTypeHint(int n) {
    return 'Type the verse number (1 to $n)';
  }

  @override
  String settingsAyatTypeError(int n) {
    return 'Enter a number between 1 and $n';
  }

  @override
  String get settingsAyatOldRange => 'The old range was shortened to 3 verses.';

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
  String settingsWhyGroup(String name) {
    return 'Group: $name';
  }

  @override
  String settingsWhyField(String name) {
    return 'Field: $name';
  }

  @override
  String settingsWhyChoice(String name) {
    return 'Choice: $name';
  }

  @override
  String settingsWhyKeyword(String name) {
    return 'Keyword: $name';
  }

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
  String get settingsOrderVideoLength => 'As long as the video';

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
      'Make sure the surau name is right. You can change it in Configuration later.';

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
      'The main screen at the surau. It is always there and cannot be deleted.';

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
      'This order is the order on the TV when the source is Both. The source and turnover are in Configuration, Hadith. The switch hides a hadith from the TV but keeps it saved; Remove deletes it from the MAXCOM list.';

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
      'The Arabic text is hidden in this preview. TV options are in Configuration, Hadith.';

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

  @override
  String get themeGalleryTitle => 'Display template';

  @override
  String get themeInUse => 'In use';

  @override
  String get themeActive => 'Active';

  @override
  String get themeBuiltIn => 'Built in';

  @override
  String get themeNewBadge => 'NEW';

  @override
  String get themeGroupArab => 'Arabic';

  @override
  String get themeScreenArabAyat => 'Arabic verse';

  @override
  String get themeScreenArabZikir => 'Arabic zikir';

  @override
  String get themeScreenArabHadis => 'Arabic hadith';

  @override
  String get themeArabLooksOff =>
      'This theme shows verses, hadith and zikir in the normal look. Arabic screens are used by Arabic Art and by themes that include them.';

  @override
  String get themeArabSection => 'Arabic text';

  @override
  String get themeArFont => 'Arabic font';

  @override
  String get themeArFontHafs => 'Uthmani Hafs';

  @override
  String get themeArFontAmiriQuran => 'Amiri Quran';

  @override
  String get themeArFontAmiri => 'Amiri';

  @override
  String get themeArFontSample => 'ٱلْحَمْدُ لِلَّهِ';

  @override
  String get themeArSize => 'Arabic size';

  @override
  String get themeArSizeSmall => 'Small';

  @override
  String get themeArSizeBig => 'Large';

  @override
  String get themeHarakat => 'Mark colour';

  @override
  String get themeHarakatFollow => 'Same as text';

  @override
  String get themeHarakatOwn => 'Own colour';

  @override
  String get themeHarakatNote =>
      'The mark colour needs the Amiri Quran or Amiri font. Uthmani Hafs is shown in one colour.';

  @override
  String get themeArLine => 'Line spacing';

  @override
  String get themeArLineTight => 'Tight';

  @override
  String get themeArLineWide => 'Wide';

  @override
  String get themeTarjamah => 'Translation';

  @override
  String get themeTarjamahBelow => 'Below';

  @override
  String get themeTarjamahBeside => 'Beside';

  @override
  String get themeTarjamahNote =>
      'Tetapan decides whether a translation shows. Here you only choose where it sits.';

  @override
  String themeAll(int n) {
    return 'All themes ($n)';
  }

  @override
  String get themeCustomise => 'Customise';

  @override
  String get themeUse => 'Use this theme';

  @override
  String themeChangedScreens(int n) {
    return '$n screens customised.';
  }

  @override
  String get themeNeedsUpdate =>
      'Update MAXCOM at the surau to customise themes.';

  @override
  String get themeGalleryHint => 'Tap a theme to view and choose it.';

  @override
  String get themeChosen => 'Theme changed';

  @override
  String get themeScreenBiasa => 'Normal';

  @override
  String get themeScreenAzan => 'Azan';

  @override
  String get themeScreenMasukWaktu => 'Prayer time';

  @override
  String get themeScreenIqamah => 'Iqamah';

  @override
  String get themeScreenSolat => 'Prayer';

  @override
  String get themeScreenJumaat => 'Friday';

  @override
  String get themeScreenLive => 'Live';

  @override
  String get themeScreenPoster => 'Poster';

  @override
  String get themeScreenKuliah => 'Lecture';

  @override
  String get themeScreenProgram => 'Programme';

  @override
  String get themeScreenHadis => 'Hadith';

  @override
  String get themeScreenZikir => 'Zikir';

  @override
  String get themeScreenPengumuman => 'Announcement';

  @override
  String get themeScreenTakwim => 'Calendar';

  @override
  String get themeScreenTabung => 'Fund';

  @override
  String get themeScreenAyat => 'Verse';

  @override
  String get themeGroupPrayer => 'Prayer times';

  @override
  String get themeGroupContent => 'Content';

  @override
  String get themeBg => 'Background';

  @override
  String get themeFollowTheme => 'Follow the theme';

  @override
  String get themeOwnPicture => 'Own picture';

  @override
  String get themeChange => 'Change';

  @override
  String get themeFit => 'Picture display';

  @override
  String get themeFitFull => 'Full';

  @override
  String get themeFitStretch => 'Stretch';

  @override
  String get themeFitMedium => 'Medium';

  @override
  String get themeFitSmall => 'Small';

  @override
  String get themePos => 'Picture position';

  @override
  String get themeLeft => 'Left';

  @override
  String get themeCentre => 'Centre';

  @override
  String get themeRight => 'Right';

  @override
  String get themeShade => 'Layer darkness';

  @override
  String get themeShadeNote =>
      'Text stays clear: the text colour is measured from the picture.';

  @override
  String get themeAccent => 'Main colour';

  @override
  String get themeAccentTheme => '(theme)';

  @override
  String get themeAccentOther => 'Other colour';

  @override
  String get themeText => 'Text colour';

  @override
  String get themeTextAuto => 'Auto';

  @override
  String get themeTextPick => 'Pick a colour';

  @override
  String get themeFont => 'Font';

  @override
  String get themeSize => 'Text size';

  @override
  String get themeSizeNote =>
      'A scale on top of the base size; the base size of hadith and verses is chosen in Configuration. S is today\'s size, there is no smaller size, so it stays clear from 3 metres.';

  @override
  String get themeBgNote =>
      'Follow the theme: the background pictures from Configuration are used (or the picture of an uploaded theme).';

  @override
  String get themeAlign => 'Content alignment';

  @override
  String get themeGoldOutline => 'Gold outline on headings';

  @override
  String get themeGoldOn => 'On';

  @override
  String get themeGoldOff => 'Off';

  @override
  String get themeChangedBadge => 'Changed';

  @override
  String get themeReset => 'Reset';

  @override
  String get themeApplyAll => 'Use for all screens';

  @override
  String themeEditTitle(String title) {
    return 'Customise: $title';
  }

  @override
  String themeEditScreen(String name) {
    return '$name screen';
  }

  @override
  String get themeLivePreview => 'Live preview';

  @override
  String themeApplyAllConfirm(String title) {
    return 'Use the look of this screen for every screen of the $title theme?';
  }

  @override
  String themeApplyAllReplaces(String title, int n) {
    return 'Use the look of this screen for every screen of the $title theme? The own choices of $n other screens will be deleted and replaced by the values of this screen.';
  }

  @override
  String get themeResetScreen => 'Reset this screen';

  @override
  String themeResetScreenConfirm(String screen) {
    return 'Go back to the theme\'s look for the $screen screen?';
  }

  @override
  String get themeResetAll => 'Reset all screens';

  @override
  String get themeFreshFailed =>
      'Could not load the latest values. Nothing was saved. Try again.';

  @override
  String themeResetConfirm(String title) {
    return 'Go back to the original look of the $title theme?';
  }

  @override
  String get themeDiscardTitle => 'Discard the changes that are not saved?';

  @override
  String get themeDiscard => 'Discard';

  @override
  String get themeKeepEditing => 'Keep editing';

  @override
  String get themeSaved => 'Theme style saved';

  @override
  String get themePickPicture => 'Choose a picture';

  @override
  String get themeCustomColour => 'Own colour (#rrggbb)';

  @override
  String get themeUploadTitle => 'Upload theme';

  @override
  String themeUploadStep(int n) {
    return 'Step $n of 3';
  }

  @override
  String get themeUploadPickTitle => 'Choose the theme file';

  @override
  String get themeUploadPickHint => 'A .maxtheme file, 15 MB at most.';

  @override
  String get themeUploadPickButton => 'Choose file';

  @override
  String get themeUploadChecksNote =>
      'MAXCOM at the surau will check this file: size, contents, CSS styles and version. Nothing is installed until you press Install.';

  @override
  String get themeUploadCancel => 'Cancel';

  @override
  String get themeUploadCheck => 'Check file';

  @override
  String get themeUploadChecking => 'Checking the file...';

  @override
  String get themeUploadValid => 'The theme is valid and ready to install';

  @override
  String get themeUploadNoProblems => 'No problems found.';

  @override
  String themeUploadPreview(String screen) {
    return 'Preview: $screen';
  }

  @override
  String get themeUploadName => 'Name';

  @override
  String get themeUploadVersion => 'Version';

  @override
  String themeUploadVersionNew(int n) {
    return '$n (new theme)';
  }

  @override
  String themeUploadVersionUpdate(int n, int m) {
    return '$n (update from version $m)';
  }

  @override
  String get themeUploadBase => 'Based on';

  @override
  String get themeUploadContract => 'Contract';

  @override
  String get themeUploadContent => 'Contents';

  @override
  String themeUploadContentValue(int n, String size) {
    return '$n files, $size';
  }

  @override
  String get themeUploadOwnScreens => 'Screens with their own styles';

  @override
  String get themeUploadInstall => 'Install';

  @override
  String get themeUploadInstallAnyway => 'Install anyway';

  @override
  String themeUploadWarnTitle(int n) {
    return 'Can be installed, with $n warnings';
  }

  @override
  String get themeUploadClose => 'Close';

  @override
  String themeUploadInstalled(String title) {
    return '$title installed';
  }

  @override
  String themeUploadInstalledNote(String current) {
    return 'The theme is now in the gallery. The TV still wears $current until you choose this theme.';
  }

  @override
  String get themeUploadSavedNote =>
      'Kept on the surau MAXCOM and synced to the cloud.';

  @override
  String get themeUploadBack => 'Back to the gallery';

  @override
  String get themeUploadUseNow => 'Use now';

  @override
  String get themeUploadTooBig => 'The file is larger than 15 MB.';

  @override
  String get themeUploadWrongType => 'Choose a file that ends with .maxtheme.';

  @override
  String get themeUploadUnreadable => 'The file cannot be read.';

  @override
  String get themeUploadExpired =>
      'The check has expired. Check the file again.';

  @override
  String themeUploadedBadge(int n) {
    return 'Uploaded, version $n';
  }

  @override
  String get themeInvalidBadge => 'Theme not valid';

  @override
  String get themeInvalidNote =>
      'The TV wears the base theme because this theme hides the clock, the prayer times or the logo. Fix the theme file and upload a new version.';

  @override
  String get themeNotReady => 'Not usable yet';

  @override
  String get themeNotReadyNote =>
      'This theme cannot be used yet: a MAXCOM at the surau needs to be updated first.';

  @override
  String get themeCannotConfirm =>
      'Cannot confirm all the surau MAXCOMs right now. Try again when the cloud connection is back.';

  @override
  String get themeDownloadTitle => 'Download theme';

  @override
  String get themeDownloadLine =>
      'One file to edit outside MAXCOM or share with another surau.';

  @override
  String get themeFileName => 'File name';

  @override
  String get themeBake => 'Include my changes';

  @override
  String themeBakeNote(int n, int m) {
    return 'The file will look the same as the surau TV now ($n screens changed, $m background pictures).';
  }

  @override
  String get themeDownloadButton => 'Download';

  @override
  String get themeShare => 'Share';

  @override
  String get themeNameBad =>
      'The name is not valid. Use lowercase letters, digits and hyphens (32 characters at most).';

  @override
  String get themeDownloaded => 'Theme file saved';

  @override
  String get themeDownloadFailed => 'The theme file could not be prepared.';

  @override
  String get themeDelete => 'Delete theme';

  @override
  String themeDeleteConfirm(String title) {
    return 'Delete the theme $title? Your changes for this theme are kept.';
  }

  @override
  String get themeDeleteInUse =>
      'This theme is in use. Choose another theme first.';

  @override
  String get themeDeleteBuiltIn => 'A built-in MAXCOM theme cannot be deleted.';

  @override
  String get themeDeleted => 'Theme deleted';

  @override
  String get valRequired => 'Required';

  @override
  String valTooLong(int max) {
    return 'Too long (at most $max characters)';
  }

  @override
  String get valNoSpaces => 'Must not contain spaces or control characters';

  @override
  String get valWebAddress => 'Must be a valid web address';

  @override
  String get valStartHttps => 'Must start with https://';

  @override
  String get valNoUserInfo => 'Must not contain a user name or password';

  @override
  String get valNoFragment => 'Must not contain a # part';

  @override
  String get valPublicAddress =>
      'Must be a public internet address (not local or private)';

  @override
  String valRectShape(String shape) {
    return 'Must be an object $shape';
  }

  @override
  String get valUnknownField => 'Unknown field';

  @override
  String get valRectNumbers => 'x, y, w and h must be numbers';

  @override
  String get valCropInside => 'The crop box must lie inside the picture';

  @override
  String get valImageIdBad => 'Invalid picture id';

  @override
  String get valSquareLogoOnly => 'The square box is for the logo only';

  @override
  String get valBgChoice => 'The background must be keep, remove or card';

  @override
  String get valRotateChoice => 'Rotation must be 0, 90, 180 or 270';

  @override
  String get valBool => 'Must be on or off';

  @override
  String valOneOf(String list) {
    return 'Must be one of: $list';
  }

  @override
  String valWholeNumber(int min, int max) {
    return 'Must be a whole number from $min to $max';
  }

  @override
  String get valMustText => 'Must be text';

  @override
  String valMustWhat(String what) {
    return 'Must be $what';
  }

  @override
  String get valWhatPlain => 'plain text';

  @override
  String get valWhatPlainNoHtml => 'plain text without HTML characters';

  @override
  String get valWhatPhone => 'a phone number like 012-345 6789';

  @override
  String get valWhatEmail => 'an email address like name@example.my';

  @override
  String get valWhatHttps => 'an https:// address';

  @override
  String get valWhatValid => 'valid';

  @override
  String valDecimal(int min, int max) {
    return 'Must be a number from $min to $max with at most 4 decimal places, or empty';
  }

  @override
  String get valColourHex =>
      'Write # followed by 6 characters, for example #F6E7B8';

  @override
  String get valAudioFile => 'Must be a valid audio file';

  @override
  String get valTimeValid => 'Must be a valid time';

  @override
  String get valTextOrEmpty => 'Must be text or empty';

  @override
  String get valTextList => 'Must be a list of text';

  @override
  String valItemMax(int max) {
    return 'An item may have at most $max characters';
  }

  @override
  String get valSourceOrder => 'Must list official, calc and file exactly once';

  @override
  String valMaxImages(int max) {
    return 'At most $max pictures';
  }

  @override
  String get valImageNames =>
      'Pictures must be an existing name (a-z, 0-9, -) or /uploads/<file name>';

  @override
  String get valUnsupported => 'This setting is not supported';

  @override
  String get valMustObject => 'Must be an object';

  @override
  String get valUnknownSetting => 'Unknown setting';

  @override
  String valSurahAyat(String name, int ayat) {
    return '$name has $ayat verses';
  }

  @override
  String get valAyatOrder =>
      'The start verse must come before or equal the last verse';

  @override
  String get valAyatMax => 'At most 3 verses per display';

  @override
  String get valUnknownFeature => 'Unknown feature';

  @override
  String get valSettingsObject => 'Settings must be an object';

  @override
  String valAlwaysOn(String name) {
    return '$name is always on and cannot be switched off';
  }

  @override
  String get valFromBeforeTo => 'The start date must be before the end date';

  @override
  String get valDate => 'Must be a valid date';

  @override
  String get valTimeHm => 'Must be a valid time (HH:MM)';

  @override
  String get valDateTime => 'Must be a valid date and time';

  @override
  String get valPickDays => 'Choose at least one day';

  @override
  String get valPickTz => 'Choose a time zone from the list';

  @override
  String get valUnknownKind => 'Unknown content kind';

  @override
  String get valItemObject => 'The item must be an object';

  @override
  String get valImageBad => 'Invalid picture';

  @override
  String get valFitBad => 'Invalid picture display';

  @override
  String get valChoiceBad => 'Invalid choice';

  @override
  String get valColourLike => 'The colour must look like #12AB34';

  @override
  String get valFontBad => 'Invalid font';

  @override
  String get valSizeChoice => 'The size must be S, M, L or XL';

  @override
  String get valValueUnknown => 'Unknown value';

  @override
  String get kindHintSeries => 'Series code for a lecture series (optional)';

  @override
  String get kindHintPhone => 'For committee members only, not shown on the TV';

  @override
  String get kindDescPengumuman =>
      'Notices to the congregation for a set period.';

  @override
  String get kindDescHadis => 'Chosen hadith for the hadith card on the TV.';

  @override
  String get errorRequestFailed => 'The request failed';

  @override
  String get errorFeatureNotFound => 'Feature not found';

  @override
  String get tvLangNeedsUpdate => 'Update MAX Kiosk Server to use this choice';

  @override
  String get prayerErrNotFound => 'Not found';

  @override
  String get prayerErrRateLimited => 'Too many searches. Try again in a moment';

  @override
  String get prayerErrOffline =>
      'Searching for a place needs MAXCOM to be online';

  @override
  String get prayerErrUpstream =>
      'The prayer time source is not answering. Try again later';

  @override
  String get prayerErrZonesUpstream =>
      'The zone list cannot be downloaded now. Try again later';

  @override
  String get prayerErrConflict => 'This action can no longer be done';

  @override
  String get prayerErrTooLarge =>
      'The file is too large. Choose a smaller file';

  @override
  String get prayerErrBadType => 'This file type is not supported';

  @override
  String get prayerErrUnavailable => 'The service is not available right now';

  @override
  String get prayerErrInvalidData => 'Invalid data';

  @override
  String get liveSignInFailed => 'YouTube sign-in did not work. Try again.';

  @override
  String get liveStartFailed => 'The broadcast could not be started';

  @override
  String get liveOtherDevice => 'another device';

  @override
  String get liveRateText =>
      'Too many attempts to start a broadcast. Try again in a moment.';

  @override
  String get liveWarnYoutubeNotSignedIn =>
      'YouTube is not signed in on the box. The broadcast to the surau screen is running.';

  @override
  String get liveWarnYoutubeOff =>
      'YouTube was switched off by the administrator';

  @override
  String get liveWarnYoutubeQuota => 'Today\'s YouTube quota is used up.';

  @override
  String get liveWarnYoutubeReauth => 'YouTube sign-in needs to be renewed.';

  @override
  String get liveWarnYoutubeForbidden => 'YouTube refused the request.';

  @override
  String get liveWarnCloudUnreachable => 'YouTube: the cloud cannot be reached';

  @override
  String liveCamUnreachable(String name) {
    return '$name, cannot be reached';
  }

  @override
  String liveCamReady(String name) {
    return '$name, ready';
  }

  @override
  String liveExtBoxPullNote(String camera) {
    return 'On the iPad, the MAXCOM box pulls the picture and audio from $camera and sends a preview to this iPad. The broadcast combined at the box reaches the surau screen and YouTube 1 to 2 seconds late.';
  }

  @override
  String get liveExtControllerOnly =>
      'Camera audio only. This iPad controls the broadcast and shows the preview; it sends no sound.';

  @override
  String get liveExtScreenLock =>
      'Put the iPad near the speaker and keep the screen on. Locking the screen stops the microphone.';

  @override
  String get liveExtRecordingFallback =>
      'No recording is made when the iPad controls the external camera. A copy of the broadcast is on YouTube.';

  @override
  String get liveExtSourceName => 'iPad microphone';

  @override
  String liveExtMicLostCamera(String source) {
    return '$source was cut off. The broadcast continues with the camera audio.';
  }

  @override
  String liveExtMicLostSilent(String source) {
    return '$source was cut off. The broadcast continues without sound.';
  }

  @override
  String get liveExtMicLostHint =>
      'The microphone reconnects automatically and is aligned before it is mixed in again. Keep the iPad screen on.';

  @override
  String get liveExtMicRefused =>
      'The iPad microphone could not be opened. The broadcast continues with the camera audio.';

  @override
  String get liveExtChipRealign => 'Aligned again when back';

  @override
  String get liveExtChipOnStart => 'Aligned when the broadcast starts';

  @override
  String get liveExtChipAligned => 'Aligned';

  @override
  String get liveExtChipNotAligned => 'Not aligned yet';

  @override
  String get liveExtChipManual => 'Audio time offset';

  @override
  String get liveExtChipAligning => 'Aligning';

  @override
  String liveExtAlignFailedCamera(String source) {
    return 'Automatic alignment has not worked yet, so $source is not mixed in, to keep voices from sounding doubled. Make sure there is sound in the surau and the camera can hear it.';
  }

  @override
  String get liveExtAlignFailedSilent =>
      'Automatic alignment has not worked yet. The sound may not match the picture.';

  @override
  String liveExtUseMicOnly(String source) {
    return 'Use $source only';
  }

  @override
  String liveExtCameraNoAudioMic(String source) {
    return 'This camera has no audio. $source is used alone. Set \'Audio time offset\' with \'Clap test\'.';
  }

  @override
  String get liveExtCameraNoAudioAlone =>
      'This camera has no audio. Press \'Add audio\' to choose a microphone, or the broadcast has no sound.';

  @override
  String get liveExtAllMuted =>
      'All audio sources are muted. The broadcast has no sound.';

  @override
  String get liveExtPreviewRetry => 'The preview was cut off. Reconnecting...';

  @override
  String get liveOnlyEnrol => 'Register a new device';

  @override
  String get liveOnlyRevoke => 'Delete a device';

  @override
  String get liveOnlyRevokeWhy =>
      'The administrator must see the device deleted';

  @override
  String get liveOnlyAddUser => 'Add a user';

  @override
  String get liveOnlyResetPin => 'Reset the PIN';

  @override
  String get liveOnlyAppLock => 'App lock';

  @override
  String get liveOnlyPairDisplay => 'Approve a display pairing';

  @override
  String get liveOnlyYoutubeSign => 'YouTube sign-in and sign-out';

  @override
  String get liveOnlyLive => 'Live broadcast';

  @override
  String get liveOnlyPrayerOps =>
      'Importing, correcting and searching prayer times';

  @override
  String get liveOnlyPrayerData => 'Prayer time data';

  @override
  String get liveOnlyIslamic => 'Islamic content';

  @override
  String get liveOnlyAnalyse => 'Picture analysis';

  @override
  String get liveOnlyUploadRecording => 'Upload a recording to YouTube';

  @override
  String get liveOnlySyncNow => 'Sync now';

  @override
  String get liveOnlyChangePin => 'Change the PIN';

  @override
  String get liveOnlyReportPdf => 'Download the report PDF';

  @override
  String get liveOnlyCountPhoto => 'View the count sheet photo';

  @override
  String get liveOnlyReportShared => 'Record the report sharing';

  @override
  String get liveOnlyFinanceAudit => 'Finance audit history';

  @override
  String get hadisGradeNoteSahih => 'The highest grade';

  @override
  String get hadisGradeNoteHasan => 'Accepted as evidence';

  @override
  String get hadisGradeNoteHasanLi =>
      'Hasan through the support of other narrations';

  @override
  String get hadisGradeNoteDhaif => 'Weak; not shown';

  @override
  String get hadisGradeNoteMaudhu => 'Never shown';

  @override
  String get valWhatThemeName =>
      'a theme name (a-z, 0-9, hyphen, at most 32 characters)';

  @override
  String get valWhatReciter => 'a reciter folder name';

  @override
  String get valWhatCountry => 'a two-letter country code like MY';

  @override
  String get valWhatTimezone => 'a time zone like Asia/Kuala_Lumpur';

  @override
  String get valWhatZone => 'a zone code like SGR01';

  @override
  String get valWhatImageOrEmpty => 'a picture id or empty';

  @override
  String get valWhatFundOrEmpty => 'a fund id or empty';

  @override
  String get valWhatDateOrEmpty => 'a date YYYY-MM-DD or empty';

  @override
  String get kindDescPenceramah => 'Ustaz and ustazah who give the lectures.';

  @override
  String get kindDescKitab => 'Books read in the lectures.';

  @override
  String get kindDescKuliah => 'The lecture schedule shown on the TV.';

  @override
  String get kindDescTicker =>
      'Short lines scrolling at the bottom of the screen.';

  @override
  String get kindDescPoster => 'Full-screen pictures rotating on the TV.';

  @override
  String get kindDescProgramKhas => 'Upcoming events and programmes.';

  @override
  String get kindDescTakwim => 'Important dates in the surau calendar.';

  @override
  String get kindDescWorldTime => 'Clocks of other cities shown on the TV.';

  @override
  String get kindDescPetugas => 'Imam, bilal and committee members on duty.';

  @override
  String get kindDescTugasan => 'Who is on duty on which day.';

  @override
  String get kindDescZikir => 'Zikir after prayer, in reading order.';

  @override
  String get kindDescTilawahSlot =>
      'Quran recitation played before prayer time.';

  @override
  String get hadisGradeNoteSahihLi =>
      'Sahih through the support of other narrations';

  @override
  String get trustRootMissing => 'The root certificate is missing. Enrol again';

  @override
  String get trustRootInvalid => 'The root certificate is not valid';

  @override
  String get trustRootMismatch => 'The root certificate does not match';

  @override
  String get trustCloudFailed =>
      'The secure connection to the MAXCOM cloud failed.';

  @override
  String get trustBadQr => 'The enrolment QR code is not valid';

  @override
  String get trustRootFetch =>
      'The root certificate could not be fetched from the box';

  @override
  String get trustNoHttps => 'This MAXCOM has no HTTPS certificate yet';

  @override
  String get imageNotReadable =>
      'This file is not a picture that can be read. Choose a JPEG, PNG or WebP file.';

  @override
  String get errcWrongPin => 'Wrong PIN';

  @override
  String errcLocked(int minutes) {
    return 'PIN locked. Try again in $minutes minutes.';
  }

  @override
  String get errcUnlockFailed => 'Unlock did not succeed. Try again.';

  @override
  String get errcPinPolicy => 'The PIN must be 6 digits and not easy to guess';

  @override
  String get errcPinExists => 'A PIN is already set for this user';

  @override
  String get errcPinRequired => 'A PIN is required';

  @override
  String get errcPinMissing => 'No PIN has been set yet';

  @override
  String get errcAppLockOff => 'The app lock is not on';

  @override
  String get errcSuspended => 'This surau is suspended for now';

  @override
  String get errcBadEnrolCode =>
      'The enrolment code is not valid or has already been used';

  @override
  String get errcOpsAppRequired => 'Use the MAXCOM Ops app for this account';

  @override
  String get errcOpsCliOnly =>
      'This registration is done through the MAXCOM cloud only';

  @override
  String get errcNotOpsUser => 'This user has no MAXCOM Ops role';

  @override
  String get errcOpsDeviceLimit =>
      'This user has reached the MAXCOM Ops registration limit';

  @override
  String get errcNotOpsDevice => 'This device is not for MAXCOM Ops';

  @override
  String get errcBadRequest => 'The request is not valid';

  @override
  String get errcBadName => 'The name is not valid';

  @override
  String get errcBadRoles => 'The roles are not valid';

  @override
  String get errcBadTtl => 'The code validity period is not valid';

  @override
  String get errcBadDevice => 'The device is not valid';

  @override
  String get errcBadChoice => 'The choice is not valid';

  @override
  String get errcUserNotFound => 'User not found';

  @override
  String get errcDeviceNotFound => 'Device not found';

  @override
  String get errcNotFound => 'Not found';

  @override
  String get errcPairGone =>
      'This screen pairing has ended or has already been used';

  @override
  String get errcBadPairCode => 'The pairing code is not correct';

  @override
  String get errcKuliahNotFound => 'Lecture not found';

  @override
  String get errcUploadNotFound => 'Upload not found';

  @override
  String get errcLastAdmin => 'There must be at least one active administrator';

  @override
  String get errcLastSuperadmin =>
      'There must be at least one active MAXCOM administrator';

  @override
  String get errcLastAdminDevice =>
      'Register another administrator\'s device first';

  @override
  String get errcRefMismatch =>
      'The user ID does not match. Open the user page again and retry';

  @override
  String get errcOwnAccount => 'You cannot delete your own account';

  @override
  String get errcPhoneRequired => 'A phone number is required';

  @override
  String get errcBadPhone => 'The phone number is not valid';

  @override
  String get errcPhoneTaken =>
      'This phone number is already used by another user';

  @override
  String get errcSuperadminCliOnly =>
      'This role can only be managed through the MAXCOM CLI';

  @override
  String get errcSuperadminCloudOnly =>
      'Manage MAXCOM administrators through the MAXCOM cloud';

  @override
  String get errcSuperadminExists => 'A MAXCOM administrator already exists';

  @override
  String get errcBoxOnly =>
      'A device code must be made at the surau. Use the Surau Administrator\'s phone on the surau Wi-Fi.';

  @override
  String get errcNotEmpty => 'This surau still has data and cannot be deleted';

  @override
  String get errcModuleOff => 'This module is not turned on';

  @override
  String get errcLiveBusy =>
      'A live broadcast is running. Try again when it ends.';

  @override
  String get errcBadAddress => 'The camera address is not valid';

  @override
  String get errcUnknownVideo =>
      'That video is not one of this surau\'s broadcasts';

  @override
  String get ra4StopNotYet => 'The broadcast has not stopped yet. Try again.';

  @override
  String get ra4StopRetry => 'Try again';

  @override
  String get ra4EndedByBox => 'The broadcast was ended by the box.';

  @override
  String get ra4StillLive =>
      'The broadcast is still running. Open Live to stop it.';

  @override
  String get ra4CameraName => 'External camera';

  @override
  String get ra4CameraStoppedByIpad =>
      'The camera was stopped by the iPad. Open this screen again.';

  @override
  String get ra4CamNotRtsp => 'The address must start with rtsp://';

  @override
  String get ra4CamNotIpv4 =>
      'Use the camera\'s IPv4 address on the surau network (like 10.168.1.20), not a name.';

  @override
  String get ra4CamNotPrivate =>
      'The address must be on a private network (10.x.x.x, 172.16 to 172.31 or 10.168.x.x).';

  @override
  String get ra4CamIsBox =>
      'This is the MAXCOM box\'s own address. Enter the camera\'s address.';

  @override
  String get ra4CamBadPort => 'The port must be a number from 1 to 65535.';

  @override
  String get ra4CamBadLogin =>
      'The login in the address holds a character that must be percent-encoded (write @ as %40).';

  @override
  String get ra4CamBadPath =>
      'The address path holds a character that is not allowed (a space, a quote or #).';

  @override
  String get ra4CamTooLong =>
      'The address is too long (at most 400 characters).';

  @override
  String get errcUnusable => 'This audio input cannot be used';

  @override
  String get errcCameraError => 'The camera could not be processed';

  @override
  String get errcCameraNotConfigured => 'No camera has been set up yet';

  @override
  String get errcUnavailable =>
      'The service is not available right now. Try again later.';

  @override
  String get errcBadClaim => 'The MAXCOM registration is not valid';

  @override
  String get errcWorkerUnreachable =>
      'MAXCOM cannot check the registration right now. Try again.';

  @override
  String get errcClaimPending => 'Pending MAXCOM approval';

  @override
  String get errcBoxRevoked => 'This MAXCOM has been revoked by the cloud';

  @override
  String get errcYoutubeQuota =>
      'The daily YouTube limit has been reached. Try again tomorrow.';

  @override
  String get errcYoutubeReauthorise => 'The YouTube sign-in must be done again';

  @override
  String get errcYoutubeNotConfigured => 'YouTube has not been set up';

  @override
  String get errcYoutubeForbidden => 'YouTube refused this action';

  @override
  String get errcYoutubeNotFound => 'The YouTube video was not found';

  @override
  String get errcYoutubeNetwork => 'Cannot reach YouTube. Try again.';

  @override
  String get errcYoutubeAtBox =>
      'YouTube sign-in is now made on the MAXCOM at the surau. Update the app and try on the surau Wi-Fi.';

  @override
  String get errcCatchupOff =>
      'Uploading recordings to YouTube is not turned on';

  @override
  String get errcVideoMismatch => 'The video does not match this upload';

  @override
  String get errcUploadExpired => 'This upload has expired';

  @override
  String get errcTooManyUploads => 'Too many uploads are running';

  @override
  String get errcUnknownLiveVideo => 'That live broadcast is not known';

  @override
  String get errcThemeGone => 'The check has expired. Check the file again.';

  @override
  String get errcThemeInUse =>
      'This theme is in use. Choose another theme first.';

  @override
  String get errcThemeBuiltIn => 'A built-in MAXCOM theme cannot be deleted';

  @override
  String errcContentInUse(int count) {
    return 'Still used by $count upcoming lectures';
  }

  @override
  String get errcAssetMissing => 'That picture is no longer there';

  @override
  String get errcHadisFull => 'The hadith limit has been reached';

  @override
  String get errcEntryExists => 'This record already exists';

  @override
  String get errcUncertain =>
      'Check whether that action has already taken place';

  @override
  String get liveOnlyThemeCheck => 'Check a theme file';

  @override
  String get liveOnlyThemeInstall => 'Install a theme';

  @override
  String get liveOnlyThemeDelete => 'Delete a theme';

  @override
  String get liveOnlyRecoveryCode => 'Make a recovery code';

  @override
  String get liveOnlyLeave => 'Leave the surau';

  @override
  String get liveOnlyLogout => 'Sign out';

  @override
  String get errcSurauNotFound => 'Surau not found';

  @override
  String get errcSurauRequired => 'No surau selected';

  @override
  String get errcNotRegistered =>
      'This MAXCOM has not registered, or its registration has expired';

  @override
  String get errcCodeMismatch =>
      'The claim code does not match this registration';

  @override
  String get errcNoWorker =>
      'The MAXCOM service is not set up on this cloud yet';

  @override
  String get errcWorker =>
      'The MAXCOM service cannot be reached or refused the request';

  @override
  String get errcNotLinked => 'This MAXCOM has already been revoked';

  @override
  String get errcBadBoxName => 'The MAXCOM name must be 1 to 60 characters';

  @override
  String get errcNotSupport => 'This user is not a MAXCOM Support user';

  @override
  String get errcEsolatUnreachable =>
      'e-Solat cannot be reached right now. Try again.';

  @override
  String get errcAlreadyLinked =>
      'This MAXCOM is already linked or approved. Use Revoke, not Reject.';

  @override
  String errcEsolatNoRecord(int year, String zone) {
    return 'e-Solat has not published the $year prayer times for zone $zone yet. Try again later or import a CSV file.';
  }

  @override
  String errcCsvYearMismatch(int year, String from, String to) {
    return 'This file is not for the year $year ($from to $to)';
  }

  @override
  String get errcNoOfficialSource =>
      'This country has no official source. Use a file or calculation.';

  @override
  String errcUndoBlocked(String date, String by) {
    return 'This import cannot be undone because the day $date was replaced or corrected on $by';
  }

  @override
  String get ra2Month1 => 'January';

  @override
  String get ra2Month2 => 'February';

  @override
  String get ra2Month3 => 'March';

  @override
  String get ra2Month4 => 'April';

  @override
  String get ra2Month5 => 'May';

  @override
  String get ra2Month6 => 'June';

  @override
  String get ra2Month7 => 'July';

  @override
  String get ra2Month8 => 'August';

  @override
  String get ra2Month9 => 'September';

  @override
  String get ra2Month10 => 'October';

  @override
  String get ra2Month11 => 'November';

  @override
  String get ra2Month12 => 'December';

  @override
  String get ra2MonthShort1 => 'Jan';

  @override
  String get ra2MonthShort2 => 'Feb';

  @override
  String get ra2MonthShort3 => 'Mar';

  @override
  String get ra2MonthShort4 => 'Apr';

  @override
  String get ra2MonthShort5 => 'May';

  @override
  String get ra2MonthShort6 => 'Jun';

  @override
  String get ra2MonthShort7 => 'Jul';

  @override
  String get ra2MonthShort8 => 'Aug';

  @override
  String get ra2MonthShort9 => 'Sep';

  @override
  String get ra2MonthShort10 => 'Oct';

  @override
  String get ra2MonthShort11 => 'Nov';

  @override
  String get ra2MonthShort12 => 'Dec';

  @override
  String get ra2Weekday1 => 'Monday';

  @override
  String get ra2Weekday2 => 'Tuesday';

  @override
  String get ra2Weekday3 => 'Wednesday';

  @override
  String get ra2Weekday4 => 'Thursday';

  @override
  String get ra2Weekday5 => 'Friday';

  @override
  String get ra2Weekday6 => 'Saturday';

  @override
  String get ra2Weekday7 => 'Sunday';

  @override
  String get ra2WeekdayShort1 => 'Mon';

  @override
  String get ra2WeekdayShort2 => 'Tue';

  @override
  String get ra2WeekdayShort3 => 'Wed';

  @override
  String get ra2WeekdayShort4 => 'Thu';

  @override
  String get ra2WeekdayShort5 => 'Fri';

  @override
  String get ra2WeekdayShort6 => 'Sat';

  @override
  String get ra2WeekdayShort7 => 'Sun';

  @override
  String get ra2PrayerImsak => 'Imsak';

  @override
  String get ra2PrayerSubuh => 'Fajr';

  @override
  String get ra2PrayerSyuruk => 'Sunrise';

  @override
  String get ra2PrayerZohor => 'Dhuhr';

  @override
  String get ra2PrayerAsar => 'Asr';

  @override
  String get ra2PrayerMaghrib => 'Maghrib';

  @override
  String get ra2PrayerIsyak => 'Isha';

  @override
  String get ra2PrayerDhuha => 'Duha';

  @override
  String get ra2MethodMwl => 'Muslim World League';

  @override
  String get ra2MethodEgyptian => 'Egypt';

  @override
  String get ra2MethodKarachi => 'Karachi';

  @override
  String get ra2MethodUmmAlQura => 'Umm al-Qura';

  @override
  String get ra2MethodDubai => 'Dubai';

  @override
  String get ra2MethodQatar => 'Qatar';

  @override
  String get ra2MethodKuwait => 'Kuwait';

  @override
  String get ra2MethodMoonsighting => 'Moonsighting Committee';

  @override
  String get ra2MethodSingapore => 'Singapore';

  @override
  String get ra2MethodTehran => 'Tehran';

  @override
  String get ra2MethodTurkey => 'Turkey (Diyanet)';

  @override
  String get ra2MethodNorthAmerica => 'North America (ISNA)';

  @override
  String get ra2MethodJakim => 'JAKIM 18/18';

  @override
  String get ra2MethodKemenag => 'Kemenag Indonesia 20/18';

  @override
  String get ra2MethodUoif => 'UOIF France 12/12';

  @override
  String get ra2MethodMorocco => 'Morocco 19/17';

  @override
  String get ra2MethodAlgeria => 'Algeria 18/17';

  @override
  String get ra2MethodRussia => 'Russia 16/15';

  @override
  String get ra2WarnNoDataToday => 'There is no prayer time data for today';

  @override
  String get ra2WarnNotLocated =>
      'The surau location is not set; prayer times cannot be calculated';

  @override
  String get ra2WarnEmergencyToday => 'Today uses a temporary calculation';

  @override
  String get ra2WarnZoneNoDataFetch =>
      'There is no data for this zone; MAXCOM will download it';

  @override
  String get ra2WarnZoneNoDataManual =>
      'There is no data for this zone; upload data or turn on automatic download';

  @override
  String get ra2FieldDate => 'Date';

  @override
  String ra2RowMissingColumn(String field) {
    return 'Column $field is missing';
  }

  @override
  String ra2RowMasjidOnly(String field) {
    return 'Column $field is for mosques only';
  }

  @override
  String ra2RowEmpty(String field) {
    return '$field is empty';
  }

  @override
  String ra2RowInvalid(String field) {
    return '$field is not valid';
  }

  @override
  String ra2RowOutOfRange(String field) {
    return '$field is out of range';
  }

  @override
  String get ra2RowDuplicate => 'Repeated date';

  @override
  String get ra2RowBeforeMidnight => 'The derived Imsak falls before midnight';

  @override
  String get ra2RowOrder => 'The times are not in order';

  @override
  String get ra2RowNoRows => 'The file has no prayer time rows';

  @override
  String get ra2RowTooMany => 'The file has too many rows';

  @override
  String get ra2RowGap => 'A date is missing before this row';

  @override
  String get ra2CsvRecorded =>
      'Recorded in Import records; it can be undone there.';

  @override
  String get ra2NoOfficialCard =>
      'This country has no official source. Upload a file or use calculation.';

  @override
  String valRange(int min, int max) {
    return '$min to $max';
  }

  @override
  String contentRefDeleted(String what) {
    return '$what deleted';
  }

  @override
  String contentInUseDates(String dates) {
    return 'Dates: $dates';
  }

  @override
  String get errcAlreadyVoided => 'This entry has already been cancelled';

  @override
  String get errcOpeningExists => 'This tabung already has an opening balance';

  @override
  String get errcOpeningFundFixed =>
      'An opening balance cannot be moved to another tabung';

  @override
  String get ra3MonthNames =>
      'January|February|March|April|May|June|July|August|September|October|November|December';

  @override
  String ra3LateEntries(int n) {
    return '$n entries arrived after this month was closed';
  }

  @override
  String get ra3AskAdminClose => 'Ask an administrator to close this month';

  @override
  String get ra3ClosedMonthToday =>
      'The month of this lecture is closed. The payment is dated today.';

  @override
  String get ra3DateClosedNote => 'A closed month cannot be chosen.';

  @override
  String get ra3LateEntriesShow => 'View entries';

  @override
  String get ra5CodeUnknown => 'The code is not recognised';

  @override
  String get ra5CodeUnknownBody =>
      'Check the code you typed, or ask the Pentadbir for a new one.';

  @override
  String get ra5CodeInvalid =>
      'This is not a MAXCOM enrolment code. Scan the QR again or paste the whole text.';

  @override
  String ra5UnlockTooMany(int minutes) {
    return 'Too many attempts. Try again in $minutes minutes';
  }

  @override
  String get ra5OfflineClosed =>
      'Offline unlock is closed. Connect to MAXCOM to unlock.';

  @override
  String get ra5RoleSupport => 'MAXCOM Support';

  @override
  String get ra5ListSeparator => ', ';

  @override
  String get ra5SealCheckFailed =>
      'The PIN cannot be checked right now. Connect to MAXCOM and try again.';

  @override
  String get ra5LeaveHint =>
      'Leaving the surau is the only way to remove this device. The last Pentadbir must first enrol another Pentadbir device.';

  @override
  String get ra6SyncErrorChip => 'Sync error';

  @override
  String get ra6SyncErrorShort => 'Error';

  @override
  String get ra6RefusedMonthClosed => 'Refused: the month is already closed';

  @override
  String get ra6RefusedFundArchived => 'Refused: the fund is archived';

  @override
  String get ra6RefusedAlreadyVoided => 'Refused: the entry is already voided';

  @override
  String get ra6RefusedOpeningExists =>
      'Refused: an opening balance already exists';

  @override
  String get ra6RefusedBlobMissing => 'The picture is no longer on this device';

  @override
  String get ra6RefusedUserInactive => 'Refused: the user is not active';

  @override
  String get ra6RefusedLastAdmin =>
      'Refused: there must be at least one Pentadbir';

  @override
  String get ra6Rejected => 'Rejected';

  @override
  String get ra6CopyDetails => 'Copy details';

  @override
  String get ra6DetailsCopied => 'Details copied';

  @override
  String ra6ConflictPartial(String names) {
    return 'Some settings were not saved because a newer change exists: $names';
  }

  @override
  String get ra6ConflictEntityFinance => 'Finance entry';

  @override
  String get ra6SettingsSavedQueued => 'Saved on this device, waiting to sync';

  @override
  String get ra6AppLockNeedsBox => 'Needs a connection to MAXCOM';

  @override
  String ra6RangeTo(String min, String max) {
    return '$min to $max';
  }

  @override
  String ra6FeatureNeeds(String name) {
    return 'Turn on $name first';
  }

  @override
  String get ra6TplLabel => 'Lecture label';

  @override
  String get ra6TplSpeaker => 'Speaker';

  @override
  String get ra6TplTopic => 'Topic';

  @override
  String get ra6TplBook => 'Book';

  @override
  String get ra6TplSurau => 'Surau name';

  @override
  String get ra6TplDate => 'Date';

  @override
  String get ra6TplTime => 'Time';

  @override
  String get ra6LiveBadge => 'LIVE';

  @override
  String get ra6LinkCloudError => 'MAXCOM cloud: sync error';

  @override
  String get ra6LinkBoxError => 'MAXCOM at the surau: error';

  @override
  String get liveNoticeShare => 'Share the link';

  @override
  String get liveNoticeTitle => 'Live stream notice';

  @override
  String get liveNoticeEditHint => 'Check and edit the text before sharing.';

  @override
  String get liveNoticeToOne => 'Send to one person';

  @override
  String get liveNoticeReset => 'Restore original text';

  @override
  String get liveNoticePickTitle => 'Send to whom?';

  @override
  String get liveNoticePickSearch => 'Search by name';

  @override
  String get liveNoticePickEmpty => 'No user found.';

  @override
  String get liveNoticeStarted => 'The live is running.';

  @override
  String get liveNoticeShareGo => 'Share';

  @override
  String get liveNoticeCardBadge => 'LIVE NOW';

  @override
  String get liveNoticePictureFailed =>
      'The picture could not be made. Only the text was shared.';

  @override
  String get liveNoticeCopiedCaption =>
      'Text copied, paste it as the caption if the text does not appear';

  @override
  String get liveNoticeQrHint =>
      'Scan with a phone camera. WhatsApp will open with this message.';

  @override
  String get liveNoticeEditDone => 'Done';

  @override
  String get liveNoticeEditText => 'Edit text';

  @override
  String get liveNoticeNoPicture => 'No picture';

  @override
  String get liveNoticeMore => 'More';

  @override
  String get liveNoticeToSelf => 'Send to myself';

  @override
  String get liveNoticeCopy => 'Copy text';

  @override
  String get liveNoticeFromPhone => 'Send from a phone';

  @override
  String get liveNoticeWhatsApp => 'Share to WhatsApp';

  @override
  String get liveNoticeCopied => 'Text copied. Paste it in WhatsApp.';

  @override
  String get liveNoticeShareFailed => 'The text could not be shared.';

  @override
  String liveNoticeEditedBy(String name, String time) {
    return 'Edited by $name, $time';
  }

  @override
  String get liveNoticeChangedMeanwhile =>
      'The text was changed by someone else. The latest text is shown; check it before sharing.';

  @override
  String waOpensTo(String number) {
    return 'WhatsApp opens straight to $number';
  }

  @override
  String get liveNoticeOpenGo => 'Open WhatsApp';

  @override
  String get liveNoticeWhatsAppFailed => 'WhatsApp could not be opened.';

  @override
  String get peopleNeedsUpdate =>
      'Update MAX Kiosk Server to use this function';

  @override
  String get peopleFlagsBoxOnly =>
      'Active status shows when you are on the surau Wi-Fi.';

  @override
  String get peopleNeedsAction => 'Needs action';

  @override
  String get peopleNoAdminPhone =>
      'No Administrator has an active phone. Enrol an Administrator phone.';

  @override
  String get peopleActiveToday => 'active today';

  @override
  String get peopleActiveYesterday => 'active yesterday';

  @override
  String peopleActiveDaysAgo(int n) {
    return 'active $n days ago';
  }

  @override
  String peopleUnusedDays(int n) {
    return 'unused for $n days';
  }

  @override
  String get peopleInactiveBadge => 'Inactive';

  @override
  String usersAllActive(int n) {
    return 'All users active ($n)';
  }

  @override
  String usersDeviceCount(int n) {
    String _temp0 = intl.Intl.pluralLogic(
      n,
      locale: localeName,
      other: '$n devices',
      one: '1 device',
      zero: 'No devices yet',
    );
    return '$_temp0';
  }

  @override
  String usersNoDeviceYet(int n) {
    return 'Added $n days ago, no phone enrolled yet';
  }

  @override
  String get usersQrButton => 'QR code';

  @override
  String get usersUnlock => 'Unlock';

  @override
  String usersUnlocked(String name) {
    return 'The PIN of $name is unlocked. The PIN is unchanged.';
  }

  @override
  String usersLockedUntil(String time) {
    return 'PIN locked until $time. The lock ends by itself, or unlock it now.';
  }

  @override
  String usersSuggestDeactivate(String name) {
    return '$name has not used the app for over 90 days. Deactivate?';
  }

  @override
  String usersDeactivatedFold(int n) {
    return 'Deactivated ($n)';
  }

  @override
  String get usersDeactivatedHint =>
      'Cannot unlock. The name stays in old records.';

  @override
  String usersDeactivatedOn(String date) {
    return 'Deactivated $date';
  }

  @override
  String usersAutoDeleteIn(int n) {
    String _temp0 = intl.Intl.pluralLogic(
      n,
      locale: localeName,
      other: 'Deleted automatically in $n days',
      one: 'Deleted automatically in 1 day',
      zero: 'Deleted automatically today',
    );
    return '$_temp0';
  }

  @override
  String get usersActivate => 'Reactivate';

  @override
  String usersActivated(String name) {
    return '$name is active again. Enrol a phone with a new QR code.';
  }

  @override
  String get usersRecoveryFold => 'Recovery code';

  @override
  String get usersRecoveryHint => 'To get back in if every admin phone is lost';

  @override
  String get usersRolesFold => 'What each role can do';

  @override
  String get usersHintDismiss => 'Close';

  @override
  String get userRename => 'Rename';

  @override
  String get userRenameTitle => 'Rename';

  @override
  String get userRenameBody =>
      'The new name is used from now on in the app and lists.';

  @override
  String get userRenameHistory =>
      'Old records do not change. The change log and finance keep showing the name used at the time.';

  @override
  String get userRenameSave => 'Save name';

  @override
  String userRenamed(String name) {
    return 'Name changed to $name.';
  }

  @override
  String userNameTaken(String name) {
    return 'A user named $name already exists. Save anyway?';
  }

  @override
  String get nameInvalid => 'The name must be 1 to 80 characters';

  @override
  String userDevicesOf(String name, int n) {
    return 'Devices of $name ($n)';
  }

  @override
  String userAddedBy(String date, String name) {
    return 'Added $date by $name';
  }

  @override
  String get deviceEdit => 'Edit';

  @override
  String get deviceNameLabel => 'Device name';

  @override
  String get deviceNameHint =>
      'Example: Phone of Ustaz Ahmad, treasurer desk iPad';

  @override
  String get deviceRenameHistory =>
      'Old change log lines keep the old name of this device.';

  @override
  String get deviceRenamed => 'Device name saved.';

  @override
  String deviceOwnedBy(String name, String platform, String date) {
    return 'Belongs to $name. $platform, enrolled $date';
  }

  @override
  String get deviceRemoveThis => 'Delete this device';

  @override
  String get deviceRemoveHint =>
      'This device can no longer open the app. To use it again, enrol it with a new QR code.';

  @override
  String devicesUnusedCard(int n) {
    return '$n devices unused for over 60 days';
  }

  @override
  String get devicesUnusedHint =>
      'Old records stay. The owner can enrol again with a new QR code.';

  @override
  String get devicesRemoveAll => 'Delete all';

  @override
  String devicesRemoveAllConfirm(int n) {
    return 'Delete $n unused devices?';
  }

  @override
  String devicesRemovedSome(int n, int m) {
    return '$n deleted, $m skipped';
  }

  @override
  String get devicesSkipOwn => 'this device itself';

  @override
  String get devicesSkipInUse => 'used recently';

  @override
  String get devicesSkipLastAdmin => 'the last admin phone';

  @override
  String get devicesLastAdmin => 'Enrol another admin device first';

  @override
  String devicesOpenCodes(int n) {
    return 'Unused codes ($n)';
  }

  @override
  String devicesCodeExpiresIn(String device, int n) {
    return '$device, expires in $n minutes';
  }

  @override
  String get devicesEndCode => 'End the code';

  @override
  String get devicesCodeEnded => 'Code ended.';

  @override
  String get devicesRemovedNote =>
      'A deleted device leaves the list at once. Its entries stay in the Change log.';

  @override
  String get tvBoxTitle => 'MAXCOM at the surau';

  @override
  String tvExtraScreens(int n) {
    return 'Extra screens ($n)';
  }

  @override
  String tvPairedSeen(String date, String ago) {
    return 'Paired $date, seen $ago';
  }

  @override
  String tvNotSeenDays(int n) {
    return 'Not seen for $n days';
  }

  @override
  String get tvPairNew => 'Pair a new screen';

  @override
  String get tvNoneWaiting => 'No screen is waiting.';

  @override
  String get tvOn => 'On';

  @override
  String get devicesSkipTv => 'a TV screen';

  @override
  String get devicesSkipGone => 'already gone';

  @override
  String tvPaired(String date) {
    return 'Paired $date';
  }

  @override
  String get tvSeenNow => 'just now';

  @override
  String tvSeenMinutes(int n) {
    return '$n minutes ago';
  }

  @override
  String tvSeenHours(int n) {
    return '$n hours ago';
  }

  @override
  String tvSeenDays(int n) {
    return '$n days ago';
  }

  @override
  String addStep(int n) {
    return 'Step $n of 3';
  }

  @override
  String get addWhatRole => 'What will they do?';

  @override
  String get addNameHint =>
      'A name the other committee members know. It can be changed later.';

  @override
  String get addRoleAjk => 'View only: prayer times, content, finance';

  @override
  String get addRoleBendahari => 'Records donations and expenses';

  @override
  String get addRoleMedia => 'Announcements and posters on the TV screen';

  @override
  String get addRoleLive => 'Live broadcasts and recordings';

  @override
  String get addRoleAdmin => 'Everything, including users and devices';

  @override
  String addDeviceSummary(String device, int n) {
    return '$device, code valid for $n minutes';
  }

  @override
  String get addChangeDevice => 'Change the device name or the duration';

  @override
  String addDefaultDevice(String name) {
    return 'Phone of $name';
  }

  @override
  String get addSaveAndQr => 'Save and make a QR code';

  @override
  String addSavedNoQr(String name) {
    return '$name saved. Make the QR code when you are on the surau Wi-Fi.';
  }

  @override
  String addScanTitle(String name) {
    return '$name scans this code with the MAXCOM app';
  }

  @override
  String get addShare => 'Share';

  @override
  String addShareConfirmTitle(String name) {
    return 'Send to $name only';
  }

  @override
  String addShareConfirmBody(String name) {
    return 'Not to a group. Anyone who holds this code on the surau Wi-Fi can sign in as $name until the code is used.';
  }

  @override
  String addShareText(String name, String surau, int n) {
    return 'MAXCOM invitation for $name at $surau. Valid for $n minutes and single use. On the surau Wi-Fi, open the MAXCOM app, choose \"Enter the code manually\" and paste the text below. Do not share it with anyone else.';
  }

  @override
  String get addShareAdminInPerson =>
      'A code for an admin must be scanned in front of you while the app lock is off.';

  @override
  String get addShareUnavailable =>
      'Sharing is not available on this MAXCOM. Show the QR code.';

  @override
  String get addLockOffHint =>
      'The app lock is off. Turn it on in Configuration for more security.';

  @override
  String addWaiting(String name) {
    return 'Waiting for $name to enrol';
  }

  @override
  String get addEndCode => 'End this code';

  @override
  String addDoneTitle(String name) {
    return '$name is in';
  }

  @override
  String addDoneBody(String roles) {
    return 'They can use the app as $roles from now on.';
  }

  @override
  String addDoneDevice(String platform, String time) {
    return '$platform, enrolled $time';
  }

  @override
  String addNotTheirs(String name) {
    return 'Not the phone of $name? Delete this device';
  }

  @override
  String addReuseWarning(int n) {
    return 'This code was tried again $n times after that.';
  }

  @override
  String get addAnother => 'Add another user';

  @override
  String get addBackToList => 'Back to the list';

  @override
  String get thisDeviceRename => 'Rename this device';

  @override
  String get liveOnlyRename => 'Rename a device';

  @override
  String get liveOnlyUnlock => 'Unlock a PIN';

  @override
  String get liveOnlyCodes => 'Manage enrolment codes';

  @override
  String get liveOnlyActivity => 'See active status';

  @override
  String get liveOnlyDeleteUser => 'Delete a user';

  @override
  String get liveOnlyRestoreUser => 'Restore a user';

  @override
  String get liveOnlyPhone => 'Change a phone number';

  @override
  String get idLabel => 'ID';

  @override
  String get idPending => 'No ID yet';

  @override
  String get searchNameOrId => 'Search name or ID';

  @override
  String get userDelete => 'Delete user';

  @override
  String userDeleteTitle(String name) {
    return 'Delete $name?';
  }

  @override
  String userDeleteBody(String name, String ref) {
    return '$name ($ref) can no longer sign in and disappears from every list. All of their devices are deleted. The change log and finance records keep this name and ID.';
  }

  @override
  String userDeleted(String name) {
    return '$name deleted.';
  }

  @override
  String get userDeleteSelf => 'You cannot delete your own account';

  @override
  String get userDeleteLastAdmin => 'There must be at least one active admin';

  @override
  String get userRestore => 'Restore';

  @override
  String userRestored(String name) {
    return '$name restored as deactivated. Reactivate and enrol a phone with a new QR code.';
  }

  @override
  String get auditUserDeleted => 'User deleted';

  @override
  String get auditDeviceDeleted => 'Device deleted';

  @override
  String get auditPhoneChanged => 'Phone number changed';

  @override
  String get autoCleanNote =>
      'Devices unused for 180 days and users deactivated for 365 days are deleted automatically. History stays.';

  @override
  String autoCleanSoon(int n) {
    return 'Deleted automatically in $n days';
  }

  @override
  String get phoneLabel => 'Phone number';

  @override
  String get phoneHint => 'Example: 012-000 0000';

  @override
  String get phoneRequired => 'A phone number is required';

  @override
  String get phoneInvalid =>
      'The phone number is not valid. For a number outside Malaysia, start with + and the country code.';

  @override
  String phoneTaken(String ref) {
    return 'This number is already used by another user ($ref).';
  }

  @override
  String get phoneNeeded => 'Phone number needed';

  @override
  String get phoneFill => 'Fill in the number';

  @override
  String get phoneDuplicate => 'Same phone number as another user';

  @override
  String get phoneSaved => 'Phone number saved.';

  @override
  String get phoneEdit => 'Change number';

  @override
  String get phonePrivate =>
      'Only an admin and the person themselves can see this number.';

  @override
  String waTo(String name) {
    return 'WhatsApp to $name';
  }

  @override
  String get waUnavailable => 'WhatsApp could not be opened. Use Share.';

  @override
  String get waUnavailablePage => 'WhatsApp is not available on this phone.';

  @override
  String get shareContinue => 'Continue';

  @override
  String userRestoreTitle(String name) {
    return 'Restore $name?';
  }

  @override
  String userRestoreBody(String name, String ref) {
    return '$name ($ref) comes back to the list as deactivated, with no devices. Reactivate and enrol a phone with a new QR code.';
  }

  @override
  String get phoneSave => 'Save';

  @override
  String get userDeleteHint =>
      'This person leaves the list and can no longer sign in. History stays. They can be restored from the Change log.';

  @override
  String get a6Other => 'Other';

  @override
  String needsBoth(String first, String second) {
    return '$first and $second';
  }

  @override
  String get errVideoTooBig =>
      'The video is too big. At most 300 MB and 720p; shrink or trim it in the phone\'s Gallery first.';

  @override
  String get errVideoTooLong =>
      'The video is too long. At most 10 minutes; trim it in the phone\'s Gallery first.';

  @override
  String get errVideoNotH264 =>
      'The video must be an MP4 with H.264. Pick another video or change its format first.';

  @override
  String get errVideoNoSpace =>
      'The box does not have enough storage. Delete an old video first.';

  @override
  String get errVideoUploadFailed =>
      'The video upload failed. Make sure the phone is still on the surau Wi-Fi, then try again.';

  @override
  String get kindDescVideo =>
      'Videos you upload or take from YouTube, played full screen on the TV.';

  @override
  String get videoSourceLabel => 'Video source';

  @override
  String get videoSourceUpload => 'Upload';

  @override
  String get videoSourceYoutube => 'YouTube';

  @override
  String get videoSourceRakaman => 'Recording';

  @override
  String get videoPick => 'Choose a video from the phone';

  @override
  String get videoPickAgain => 'Choose another video';

  @override
  String get videoChecking => 'Checking the video...';

  @override
  String videoCompressing(int percent) {
    return 'Shrinking the video to 720p... $percent%';
  }

  @override
  String videoUploading(int percent) {
    return 'Uploading to the box... $percent%';
  }

  @override
  String get videoUploadedOk => 'Uploaded to the box';

  @override
  String videoPickedLine(String name, String size) {
    return '$name ($size)';
  }

  @override
  String get videoCloudNote =>
      'Videos can only be uploaded on the surau Wi-Fi. Connect the phone to the surau Wi-Fi, or add a YouTube video (possible from anywhere).';

  @override
  String videoStorageLeft(String size) {
    return 'Box storage: $size left';
  }

  @override
  String get videoLimitsNote =>
      'At most 300 MB, 10 minutes and 720p. Trim it in the phone\'s Gallery first if needed.';

  @override
  String get videoCannotCompress =>
      'This phone cannot shrink videos. Choose an MP4 (H.264) video that is already within the limits.';

  @override
  String get videoYoutubeLink => 'YouTube link';

  @override
  String get videoYoutubeHint => 'Paste the link or the video ID';

  @override
  String get videoYoutubeBad => 'This is not a YouTube video link.';

  @override
  String get videoYoutubeLive =>
      'This is a live broadcast. To show a live on the TV, use Live. After it ends, its recording can be chosen here.';

  @override
  String get videoYoutubeNote =>
      'Videos from other channels may show ads or be removed by their owner. Needs internet at the surau; without it the video is skipped.';

  @override
  String get videoRakamanNote =>
      'A clip of the surau\'s lecture recording on YouTube. Set when it starts and stops.';

  @override
  String get videoClipStart => 'Start (mm:ss)';

  @override
  String get videoClipEnd => 'End (mm:ss)';

  @override
  String get videoClipOrder => 'The end must be after the start.';

  @override
  String get videoClipLong => 'A clip can be 10 minutes at most.';

  @override
  String get videoNeedsFile =>
      'Choose a video and wait for it to finish uploading.';

  @override
  String get videoWaitUpload => 'Wait for the upload to finish before saving.';

  @override
  String get videoEstimate => 'Estimated length (minutes)';

  @override
  String get videoEstimateHint =>
      'YouTube does not tell us the length. Give a rough length (1 to 10 minutes); the screen moves on as soon as the video ends.';

  @override
  String get videoEstimateBad => 'Enter a number from 1 to 10.';

  @override
  String get videoCloudReadOnly =>
      'The details of an uploaded video can only be changed on the surau Wi-Fi.';

  @override
  String get videoPreview => 'Preview';

  @override
  String get videoPreviewHint =>
      'On the TV: the video fills the screen with the surau name and the clock over it. No other text.';

  @override
  String videoRowUpload(String length) {
    return 'Upload, $length';
  }

  @override
  String get videoRowYoutube => 'YouTube';

  @override
  String videoRowRakaman(String start, String end) {
    return 'Recording clip $start to $end';
  }

  @override
  String get videoSoundOn => 'With sound';

  @override
  String get videoExpiredSuggest =>
      'The end date has passed. Delete it to save space?';

  @override
  String get videoFileLost =>
      'The file is not on this box; it is skipped on the TV.';

  @override
  String get videoFetching => 'Getting the title from YouTube...';
}
