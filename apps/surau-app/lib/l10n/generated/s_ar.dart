// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 's.dart';

// ignore_for_file: type=lint

/// The translations for Arabic (`ar`).
class SAr extends S {
  SAr([String locale = 'ar']) : super(locale);

  @override
  String get appTitle => 'المصلى';

  @override
  String get actionSave => 'حفظ التغييرات';

  @override
  String get actionCancel => 'إلغاء';

  @override
  String get actionBack => 'رجوع';

  @override
  String get actionRetry => 'إعادة المحاولة';

  @override
  String get actionDelete => 'حذف';

  @override
  String get actionClose => 'إغلاق';

  @override
  String get actionContinue => 'متابعة';

  @override
  String get actionAdd => 'إضافة';

  @override
  String get actionEdit => 'تعديل';

  @override
  String get actionUpload => 'رفع';

  @override
  String get actionDownload => 'تنزيل';

  @override
  String get actionLogout => 'تسجيل الخروج';

  @override
  String get actionEnrolAgain => 'التسجيل من جديد';

  @override
  String get savedToast => 'تم حفظ التغييرات';

  @override
  String get navDashboard => 'لوحة التحكم';

  @override
  String get navSettings => 'الإعدادات';

  @override
  String get navContent => 'المحتوى';

  @override
  String get navPreview => 'معاينة';

  @override
  String get navIslamic => 'المحتوى الإسلامي';

  @override
  String get navPrayerData => 'مواقيت الصلاة';

  @override
  String get navUsers => 'المستخدمون';

  @override
  String get navDevices => 'الأجهزة';

  @override
  String get navPairing => 'اقتران الكشك';

  @override
  String get navAudit => 'سجل التغييرات';

  @override
  String get navFinance => 'المالية';

  @override
  String get navLive => 'البث المباشر';

  @override
  String get navJemaah => 'المصلّون';

  @override
  String get navThisDevice => 'هذا الجهاز';

  @override
  String get navMore => 'المزيد';

  @override
  String get dashboardTitle => 'لوحة التحكم';

  @override
  String get settingsTitle => 'الإعدادات';

  @override
  String get enrolTitle => 'تسجيل هذا الجهاز';

  @override
  String get unlockTitle => 'فتح القفل';

  @override
  String get previewRibbon => 'معاينة';

  @override
  String get enrolScanHint => 'امسح رمز QR الذي يعرضه المسؤول';

  @override
  String get enrolManualHint => 'أو الصق رمز التسجيل هنا';

  @override
  String get enrolPinHaveOne => 'لدي رمز PIN بالفعل';

  @override
  String get enrolPinCreate => 'إنشاء رمز PIN جديد';

  @override
  String get pinLabel => 'PIN';

  @override
  String get pinHint => 'أدخل رمز PIN';

  @override
  String get pinConfirmHint => 'أدخل رمز PIN مرة أخرى';

  @override
  String get pinMismatch => 'رمزا PIN غير متطابقين';

  @override
  String get biometricUse => 'استخدام بصمة الإصبع';

  @override
  String get unlockButton => 'فتح القفل';

  @override
  String get errorForbidden => 'لا تملك صلاحية هذا الإجراء';

  @override
  String get errorBoxUnreachable => 'تعذّر الاتصال بـ MAXCOM';

  @override
  String get errorDeviceRevoked => 'تم إلغاء هذا الجهاز';

  @override
  String get errorCaMismatch => 'الشهادة الجذرية غير متطابقة';

  @override
  String get errorDeviceKeyMissing => 'مفتاح الجهاز مفقود';

  @override
  String get errorSessionExpired => 'انتهت الجلسة. افتح القفل من جديد.';

  @override
  String get errorUnknown => 'حدث خطأ ما. أعد المحاولة.';

  @override
  String get offlineBanner => 'تعذّر الاتصال بـ MAXCOM. تُعرض آخر البيانات.';

  @override
  String get offlineWriteRefused =>
      'تعذّر الاتصال بـ MAXCOM. أعد المحاولة في المصلى.';

  @override
  String get loading => 'جارٍ التحميل';

  @override
  String get emptyList => 'لا توجد سجلات بعد';

  @override
  String get readOnlyHint => 'للعرض فقط';

  @override
  String get featureOn => 'مفعّل';

  @override
  String get featureOff => 'متوقف';

  @override
  String get featureLocked => 'مفعّل دائمًا';

  @override
  String get deviceLockAlwaysOn => 'قفل هذا الجهاز';

  @override
  String get roleSuperadmin => 'مسؤول MAXCOM';

  @override
  String get roleSuperadminHint =>
      'كل ما يستطيعه المسؤول، إضافة إلى إعدادات نظام MAXCOM (متقدم). تتم الإدارة عبر سحابة MAXCOM فقط';

  @override
  String get superadminBadgeTooltip => 'أنت مسؤول MAXCOM';

  @override
  String get roleAdmin => 'المسؤول';

  @override
  String get roleTreasurer => 'أمين الصندوق';

  @override
  String get roleMedia => 'الإعلام';

  @override
  String get roleAjk => 'أعضاء اللجنة';

  @override
  String get enrolScanButton => 'مسح رمز QR';

  @override
  String get enrolManualButton => 'إدخال الرمز يدويًا';

  @override
  String get enrolPasteLabel => 'رمز التسجيل';

  @override
  String get enrolPasteHint => 'surau1:...';

  @override
  String get enrolCodeShow => 'إظهار الرمز';

  @override
  String get enrolCodeHide => 'إخفاء الرمز';

  @override
  String get enrolCameraUnavailable =>
      'الكاميرا غير متاحة هنا. الصق رمز التسجيل الذي أعطاك إياه المسؤول.';

  @override
  String get enrolCameraStarting => 'جارٍ تشغيل الكاميرا';

  @override
  String get enrolBoxLabel => 'عنوان MAXCOM';

  @override
  String get enrolUserLabel => 'المستخدم';

  @override
  String get enrolCaLabel => 'بصمة الشهادة';

  @override
  String get enrolCaCompare =>
      'قارنها بالنسخة المطبوعة لدى المسؤول قبل المتابعة.';

  @override
  String get enrolCaNone => 'لا توجد شهادة (اتصال تجريبي محلي)';

  @override
  String get enrolDeviceNameLabel => 'اسم الجهاز';

  @override
  String get enrolDeviceNameHint => 'مثال: هاتف علي';

  @override
  String get enrolDeviceNameRequired => 'أدخل اسم الجهاز';

  @override
  String get enrolPinChoiceTitle => 'رمز PIN الخاص بك';

  @override
  String get enrolPinHaveOneHint => 'رمز PIN نفسه المستخدم في أجهزتك الأخرى';

  @override
  String get enrolPinCreateHint => '6 أرقام. ليست أرقامًا متطابقة ولا متتابعة.';

  @override
  String get enrolPinNewHint => 'رمز PIN جديد';

  @override
  String get enrolPinAgainLabel => 'مرة أخرى';

  @override
  String get enrolSubmit => 'تسجيل الجهاز';

  @override
  String get enrolWorking => 'جارٍ التسجيل';

  @override
  String get enrolDone => 'تم تسجيل الجهاز';

  @override
  String get enrolExpired =>
      'انتهت صلاحية رمز التسجيل. اطلب رمزًا جديدًا من المسؤول.';

  @override
  String get enrolPinExists =>
      'لديك رمز PIN بالفعل. اختر \"لدي رمز PIN بالفعل\".';

  @override
  String get enrolPinKnownSet =>
      'استخدم رمز PIN نفسه المستخدم في أجهزتك الأخرى';

  @override
  String get enrolPinKnownNew => 'أنشئ رمز PIN من 6 أرقام لحسابك';

  @override
  String get enrolAlreadyEnrolled =>
      'هذا الجهاز مسجّل بالفعل. للتسجيل من جديد، اختر \"التسجيل من جديد\" في شاشة فتح القفل.';

  @override
  String get enrolPinPending =>
      'لم يُحدَّد رمز PIN بعد. سيُطلب منك تحديد رمز جديد عند فتح القفل.';

  @override
  String get enrolAnother => 'مسح رمز آخر';

  @override
  String get pinTooWeak =>
      'رمز PIN سهل جدًا. اختر 6 أرقام غير متطابقة وغير متتابعة.';

  @override
  String get pinNewTitle => 'حدّد رمز PIN جديدًا';

  @override
  String get pinNewHint =>
      'أعاد المسؤول تعيين رمز PIN الخاص بك. اختر 6 أرقام جديدة.';

  @override
  String get pinConfirmTitle => 'أدخل رمز PIN مرة أخرى';

  @override
  String get pinDeleteDigit => 'حذف رقم';

  @override
  String get unlockHint => 'أدخل رمز PIN للمتابعة';

  @override
  String get unlockChecking => 'جارٍ التحقق';

  @override
  String get unlockRevokedHint =>
      'لم يعد هذا الجهاز مصرّحًا له. سجّله من جديد برمز جديد من المسؤول.';

  @override
  String get unlockNoKeyHint =>
      'مفتاح هذا الجهاز مفقود. سجّله من جديد برمز جديد من المسؤول.';

  @override
  String get biometricFailed => 'لم يتم التعرف على البصمة. أدخل رمز PIN.';

  @override
  String get biometricLocked => 'بصمة الإصبع مقفلة مؤقتًا. استخدم رمز PIN.';

  @override
  String get unlockNotVerified =>
      'تعذّر على MAXCOM التحقق من هذا الجهاز. أعد المحاولة.';

  @override
  String get biometricChecking => 'بانتظار البصمة';

  @override
  String get productName => 'MAXCOM';

  @override
  String greeting(String name) {
    return 'السلام عليكم، $name';
  }

  @override
  String rolesJoin(String head, String last) {
    return '$head و$last';
  }

  @override
  String invitedByUntil(String admin, String when) {
    return 'دعاك $admin. الدعوة صالحة حتى $when.';
  }

  @override
  String validUntil(String when) {
    return 'الدعوة صالحة حتى $when.';
  }

  @override
  String get enrolStepScan => 'مسح الرمز';

  @override
  String get enrolStepReview => 'مراجعة';

  @override
  String get enrolStepPin => 'تحديد PIN';

  @override
  String get enrolReviewHint => 'راجع اسمك وهذا المصلى قبل المتابعة.';

  @override
  String get enrolDoneHint =>
      'في المرة القادمة، افتح هذا التطبيق وأدخل رمز PIN.';

  @override
  String get helpTitle => 'هل تحتاج إلى مساعدة؟';

  @override
  String helpContact(String name) {
    return 'تواصل مع $name';
  }

  @override
  String get helpContactAnyone => 'تواصل مع مسؤول المصلى';

  @override
  String get helpNoContact => 'اطلب المساعدة من مسؤول المصلى.';

  @override
  String get helpCall => 'اتصال';

  @override
  String get helpWhatsApp => 'WhatsApp';

  @override
  String get helpEmail => 'البريد الإلكتروني';

  @override
  String get techDetailsTitle => 'تفاصيل تقنية';

  @override
  String get unlockForgotPin => 'نسيت رمز PIN؟';

  @override
  String get unlockForgotPinBody =>
      'يستطيع المسؤول إعادة تعيين رمز PIN الخاص بك. بعد ذلك افتح هذا التطبيق وحدّد رمز PIN جديدًا.';

  @override
  String get unlockNotYou => 'لست أنت؟ سجّل هذا الجهاز من جديد';

  @override
  String get unlockNotYouTitle => 'تسجيل هذا الجهاز من جديد؟';

  @override
  String get unlockNotYouBody =>
      'تحتاج إلى رمز QR جديد من المسؤول. سيُستبدل التسجيل الحالي في هذا الجهاز.';

  @override
  String get unlockLockedTitle => 'رمز PIN مقفل مؤقتًا';

  @override
  String unlockLockedUntil(String when) {
    return 'أعد المحاولة في $when';
  }

  @override
  String errorUnreachableNamed(String name) {
    return 'تعذّر الاتصال بـ $name';
  }

  @override
  String get errorUnreachableHint =>
      'تأكد من أنك على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get navPeople => 'المستخدمون والأجهزة';

  @override
  String offlineBannerAt(String when) {
    return 'تعذّر الاتصال بـ MAXCOM. تُعرض آخر البيانات ($when).';
  }

  @override
  String get offlineNoData =>
      'تعذّر الاتصال بـ MAXCOM. لا توجد بيانات لعرضها بعد.';

  @override
  String get statusTitle => 'حالة MAXCOM';

  @override
  String statusReachedAt(String when) {
    return 'تم الاتصال $when';
  }

  @override
  String get statusChecking => 'جارٍ الاتصال بـ MAXCOM';

  @override
  String get statusUnreachable => 'تعذّر الاتصال';

  @override
  String get statusPrayerData => 'بيانات مواقيت الصلاة';

  @override
  String get statusLockedUsers => 'المستخدمون المقفلون';

  @override
  String get statusDataVersion => 'إصدار البيانات';

  @override
  String daysLeft(int n) {
    return 'بقي $n يوم';
  }

  @override
  String get statusPrayerDataWarning =>
      'ارفع بيانات مواقيت الصلاة للسنة الجديدة قبل انتهائها.';

  @override
  String get statusUnknown => 'غير معروف بعد';

  @override
  String techCheckLine(String contact) {
    return 'يحتاج MAXCOM إلى فحص تقني. تواصل مع $contact.';
  }

  @override
  String get techCheckContactAnyone => 'مسؤول المصلى';

  @override
  String get techCheckDaysLeft => 'تنتهي شهادة MAXCOM خلال';

  @override
  String get techCheckLastRenew => 'آخر تجديد تلقائي';

  @override
  String techCheckRenewFailed(String when) {
    return 'فشل $when';
  }

  @override
  String get techCheckRenewNever => 'لم ينجح قط';

  @override
  String get techCheckExplain =>
      'يتم التجديد تلقائيًا كل يوم. إذا استمر فشله، فيجب فحص MAXCOM قبل التاريخ أعلاه.';

  @override
  String get previewShortcut => 'معاينة الشاشة';

  @override
  String get previewShortcutHint =>
      'شاهد ما يُعرض الآن على شاشة التلفاز في المصلى.';

  @override
  String get dashAttention => 'يحتاج إلى انتباه';

  @override
  String dashPrayerDaysLeft(int n) {
    return 'تنتهي بيانات مواقيت الصلاة بعد $n يوم';
  }

  @override
  String get dashPrayerNone => 'لا توجد بيانات لمواقيت الصلاة';

  @override
  String dashLockedUsers(int n) {
    return 'المستخدمون المقفلون: $n';
  }

  @override
  String get dashLockedHint => 'افتح القفل من صفحة المستخدمون والأجهزة.';

  @override
  String get dashOnTv => 'على شاشة التلفاز الآن';

  @override
  String get dashSeeTv => 'عرض شاشة التلفاز';

  @override
  String get dashSystem => 'تفاصيل النظام';

  @override
  String get dashAppVersion => 'إصدار التطبيق';

  @override
  String get comingBody => 'هذا القسم قيد الإنشاء وسيتوفر في تحديث قادم.';

  @override
  String comingPlanned(String plan) {
    return 'مخطط له: $plan';
  }

  @override
  String get backHome => 'العودة إلى لوحة التحكم';

  @override
  String get comingSettings =>
      'فعّل أو أوقف كل ميزة في MAXCOM واضبط إعداداتها: وقت الإقامة والخلفية والمحتوى والصوت وغيرها.';

  @override
  String get comingContent =>
      'أدر الدروس والمحاضرين والإعلانات والملصقات والتقويم وسائر المحتوى المعروض على التلفاز.';

  @override
  String get comingPreview => 'شاهد عرض تلفاز المصلى مباشرة من هذا الجهاز.';

  @override
  String get comingIslamic =>
      'راجع وحدّث المحتوى الإسلامي المحفوظ في MAXCOM: الآيات والأحاديث والأذكار والتلاوة.';

  @override
  String get comingPrayerData =>
      'استورد بيانات مواقيت الصلاة من JAKIM لمنطقة هذا المصلى.';

  @override
  String get comingUsers =>
      'أضف أعضاء اللجنة وحدّد أدوارهم وأعد تعيين رمز PIN وأدر الأجهزة واقتران الكشك.';

  @override
  String get comingDevices => 'اعرض الأجهزة المسجّلة وألغِ الجهاز المفقود.';

  @override
  String get comingPairing => 'وافق على تلفاز جديد يطلب الاقتران مع MAXCOM.';

  @override
  String get comingAudit => 'اعرف من غيّر ماذا ومتى.';

  @override
  String get comingFinance =>
      'سجّل صناديق التبرعات والتبرعات ونفقات المصلى، مع بطاقة صندوق التبرعات على التلفاز.';

  @override
  String get finTotalAll => 'إجمالي صناديق التبرعات';

  @override
  String finAsOf(String date, int n) {
    return 'حتى $date، $n صناديق تبرعات';
  }

  @override
  String get finMonthIn => 'الوارد هذا الشهر';

  @override
  String get finMonthOut => 'الصادر هذا الشهر';

  @override
  String get finActionKutipan => 'التحصيل';

  @override
  String get finActionBayaran => 'المدفوعات';

  @override
  String get finActionPembetulan => 'التصحيح';

  @override
  String get finActionLaporan => 'التقرير';

  @override
  String get finActionLaporanBulanan => 'التقرير الشهري';

  @override
  String get finActionTetapan => 'إعدادات صندوق التبرعات';

  @override
  String get finFundsTitle => 'صناديق التبرعات';

  @override
  String get finOnTv => 'على شاشة التلفاز';

  @override
  String get finSyncTitle => 'المزامنة';

  @override
  String finPendingTv(int n) {
    return '$n قيود لم تصل إلى شاشة التلفاز';
  }

  @override
  String get finPendingHelp =>
      'محفوظة في هذا الجهاز. تُعرض على شاشة التلفاز بعد وصولها إلى MAXCOM في المصلى.';

  @override
  String get finAllOnTv => 'وصلت كل القيود. تم تحديث شاشة التلفاز.';

  @override
  String get finRecent => 'أحدث القيود';

  @override
  String get finNoEntries => 'لا توجد قيود بعد.';

  @override
  String get finViewOnly =>
      'للعرض فقط. يُدخل أمين الصندوق التحصيل والمدفوعات والتصحيحات.';

  @override
  String get finSuperBanner =>
      'أنت تشاهد المالية بصفتك مسؤول MAXCOM بصلاحية كاملة. يُسجَّل كل عرض وإجراء في سجل تدقيق هذا المصلى.';

  @override
  String get finCorrectionsTitle => 'كل التصحيحات';

  @override
  String finCorrectionLine(String ref, String orig, String fund) {
    return '$ref لـ $orig، $fund';
  }

  @override
  String get finTagCorrected => 'مصحَّح';

  @override
  String get finTagPending => 'قيد الانتظار';

  @override
  String finCorrectionOf(String ref) {
    return 'تصحيح للقيد $ref';
  }

  @override
  String get finUnavailable => 'تعذّر فتح المالية الآن. أعد المحاولة بعد قليل.';

  @override
  String get finKutipanTitle => 'تحصيل جديد';

  @override
  String get finKutipanIntro =>
      'أدخل التحصيل بعد فتح صندوق التبرعات وعدّ ما فيه. يعمل دون إنترنت؛ يُحفظ في الجهاز ويُزامَن لاحقًا.';

  @override
  String get finDate => 'التاريخ';

  @override
  String get finToday => 'اليوم';

  @override
  String get finLastFriday => 'الجمعة الماضية';

  @override
  String get finPrevMonthWarn =>
      'هذا التاريخ في الشهر الماضي. تأكد من أن تقرير ذلك الشهر لم يُعتمد بعد.';

  @override
  String get finDateFuture => 'لا يمكن أن يكون التاريخ بعد اليوم.';

  @override
  String get finFund => 'صندوق التبرعات';

  @override
  String get finNoFunds =>
      'لا توجد صناديق تبرعات بعد. على المسؤول تحديد صندوق التبرعات أولًا.';

  @override
  String get finPerihal => 'البيان';

  @override
  String get finNoPerihal => 'لا يوجد بيان بعد. على المسؤول تحديده أولًا.';

  @override
  String get finMethod => 'طريقة الاستلام';

  @override
  String get finMethodTunai => 'نقدًا';

  @override
  String get finMethodBank => 'تحويل مصرفي';

  @override
  String get finMethodDuitnow => 'DuitNow';

  @override
  String get finMethodCek => 'شيك';

  @override
  String get finAmount => 'المبلغ';

  @override
  String get finAmountInvalid => 'المبلغ غير صالح. مثال: 1,356.80';

  @override
  String get finAmountZero => 'يجب أن يكون المبلغ أكثر من RM 0.00';

  @override
  String get finDenomOpen => 'العدّ حسب الفئات النقدية (اختياري)';

  @override
  String get finDenomClose => 'إخفاء الفئات النقدية';

  @override
  String get finDenomCoins => 'العملات المعدنية (RM)';

  @override
  String get finDenomSum => 'مجموع الفئات';

  @override
  String finDenomMismatch(String sum, String amount) {
    return 'مجموع الفئات النقدية $sum، ولا يساوي المبلغ $amount.';
  }

  @override
  String get finCounters => 'تم العدّ بواسطة (شخصان)';

  @override
  String finCountersCount(int n) {
    return 'تم اختيار $n من 2';
  }

  @override
  String get finCounterYou => 'أنت';

  @override
  String get finCounterOther => 'اسم آخر...';

  @override
  String get finCounterOtherLabel => 'اسم الشخص الذي عدّ';

  @override
  String get finCounterAdd => 'إضافة';

  @override
  String get finReference => 'رقم المرجع';

  @override
  String get finReferenceHelp =>
      'لا حاجة إلى شاهد للمبالغ التي تدخل مباشرة إلى الحساب المصرفي للمصلى.';

  @override
  String get finReferenceShort => 'رقم المرجع 3 أحرف على الأقل.';

  @override
  String get finPhotoCount => 'صورة ورقة العدّ';

  @override
  String get finPhotoReceipt => 'إيصال أو فاتورة';

  @override
  String get finPhotoVoucher => 'إقرار استلام أو سند صرف';

  @override
  String get finOptional => 'اختياري';

  @override
  String get finPhotoPick => 'التقاط صورة أو اختيار صورة';

  @override
  String get finPhotoRemove => 'إزالة الصورة';

  @override
  String finPhotoReady(int kb) {
    return 'الصورة جاهزة، $kb KB';
  }

  @override
  String get finPhotoNotImage => 'هذا الملف ليس صورة يمكن قراءتها.';

  @override
  String get finPhotoTooBig => 'الصورة ما زالت كبيرة جدًا بعد التصغير.';

  @override
  String get finNote => 'ملاحظة';

  @override
  String get finLockedInfo =>
      'بعد الحفظ لا يمكن حذف هذا القيد أو تعديله. تُصحَّح الأخطاء بتصحيح مع بيان السبب.';

  @override
  String get finReview => 'مراجعة وحفظ';

  @override
  String get finConfirmTitle => 'حفظ هذا التحصيل؟';

  @override
  String get finConfirmPayTitle => 'حفظ هذه الدفعة؟';

  @override
  String get finConfirmHelp => 'راجع مرة أخرى. بعد الحفظ لا يمكن تعديل القيد.';

  @override
  String get finBigTitle => 'مبلغ كبير';

  @override
  String finBigWarn(String limit) {
    return 'هذا المبلغ أكثر من $limit. راجعه مرة أخرى للتأكد من عدم وجود خطأ في الكتابة.';
  }

  @override
  String get finConfirmSave => 'حفظ';

  @override
  String get finCountedBy => 'تم العدّ بواسطة';

  @override
  String get finPhoto => 'صورة';

  @override
  String get finPhotoOne => 'صورة واحدة';

  @override
  String get finNone => 'لا شيء';

  @override
  String get finSavedTitle => 'تم الحفظ في هذا الجهاز';

  @override
  String finSavedRef(String ref) {
    return 'رقم المرجع $ref';
  }

  @override
  String get finSavedWaiting =>
      'بانتظار المزامنة. سيُرسَل تلقائيًا عندما يمكن الاتصال بـ MAXCOM في المصلى أو في السحابة.';

  @override
  String get finNotOnTv => 'لم يصل إلى شاشة التلفاز بعد';

  @override
  String get finAnotherKutipan => 'تحصيل آخر';

  @override
  String get finAnotherBayaran => 'دفعة أخرى';

  @override
  String get finToHome => 'إلى المالية';

  @override
  String get finSaveFailed => 'تعذّر حفظ القيد. راجع المعلومات من جديد.';

  @override
  String get finBayaranTitle => 'دفعة جديدة';

  @override
  String get finPayPenceramah => 'المحاضر';

  @override
  String get finPayOther => 'نفقات أخرى';

  @override
  String get finKuliahLabel => 'الدرس من التقويم';

  @override
  String get finKuliahPick => 'اختر الدرس';

  @override
  String get finKuliahNone => 'لا توجد دروس للدفع.';

  @override
  String get finKuliahPaid => 'مدفوع';

  @override
  String get finKuliahDue => 'غير مدفوع';

  @override
  String get finKuliahTonight => 'هذه الليلة';

  @override
  String get finKuliahFuture => 'قادم';

  @override
  String get finKuliahCancelled => 'ملغى';

  @override
  String get finKuliahCancelledWarn =>
      'هذا الدرس ملغى. تأكد من أن هذه الدفعة مطلوبة فعلًا.';

  @override
  String get finKuliahTonightInfo => 'لم يُعقد هذا الدرس بعد (هذه الليلة).';

  @override
  String get finKuliahAlreadyPaid =>
      'هذا الدرس مدفوع بالفعل. تحتاج الدفعة الثانية إلى سبب واضح في الملاحظة.';

  @override
  String get finPenceramahName => 'المحاضر';

  @override
  String get finNoPenceramahPerihal =>
      'بيان المحاضر غير موجود بعد. تواصل مع المسؤول.';

  @override
  String finSuggestFee(String amount) {
    return 'مقترح من آخر دفعة لهذا المحاضر: $amount';
  }

  @override
  String get finPaidFrom => 'مدفوع من';

  @override
  String finBalanceAfter(String fund, String balance, String after) {
    return 'رصيد $fund: $balance. بعد هذه الدفعة: $after';
  }

  @override
  String get finOverdraw =>
      'هذه الدفعة تتجاوز رصيد صندوق التبرعات. يمكنك حفظها مع ذلك.';

  @override
  String get finPayee => 'مدفوع إلى';

  @override
  String get finPayeeRequired => 'أدخل اسم المستلم.';

  @override
  String get finPayMethod => 'طريقة الدفع';

  @override
  String get finCorTitle => 'التصحيح';

  @override
  String get finCorIntro =>
      'اختر القيد المراد تصحيحه. لا يُعدَّل القيد الأصلي ولا يُحذف؛ يُضاف التصحيح كقيد جديد.';

  @override
  String get finCorSearch => 'ابحث بالرقم أو صندوق التبرعات أو البيان';

  @override
  String get finCorLocked => 'القيد الأصلي، مقفل';

  @override
  String get finCorKind => 'نوع التصحيح';

  @override
  String get finCorKindAmount => 'تعديل المبلغ';

  @override
  String get finCorKindVoid => 'إلغاء القيد';

  @override
  String get finCorKindFund => 'تغيير صندوق التبرعات';

  @override
  String get finCorRightAmount => 'المبلغ الصحيح';

  @override
  String get finCorDelta => 'التعديل';

  @override
  String finCorVoidInfo(String ref, String delta) {
    return 'سيُحتسب القيد $ref صفرًا بالتصحيح $delta. يبقى القيد الأصلي ظاهرًا في السجل والتقارير.';
  }

  @override
  String get finCorRightFund => 'صندوق التبرعات الصحيح';

  @override
  String get finCorReason => 'سبب التصحيح';

  @override
  String get finCorRequired => 'مطلوب';

  @override
  String get finCorReasonHint =>
      'مثال: أظهر العدّ مجددًا من عضوين في اللجنة أن ...';

  @override
  String finCorReasonCount(int n) {
    return '$n / 15 حرفًا على الأقل';
  }

  @override
  String finCorReasonOk(int n) {
    return '$n حرفًا';
  }

  @override
  String get finPresetRecount => 'إعادة العدّ';

  @override
  String get finPresetRecountText => 'إعادة العدّ: ';

  @override
  String get finPresetTypo => 'خطأ في الكتابة';

  @override
  String get finPresetTypoText => 'خطأ في كتابة المبلغ: ';

  @override
  String get finPresetWrongFund => 'صندوق تبرعات خاطئ';

  @override
  String get finPresetWrongFundText => 'صندوق تبرعات خاطئ: ';

  @override
  String get finCorNote =>
      'التصحيح قيد جديد. لا يمكن حذفه، ويستطيع جميع المسؤولين رؤيته مع سببه.';

  @override
  String get finCorSave => 'حفظ التصحيح';

  @override
  String get finCorFillReason => 'اكتب السبب لتتمكن من الحفظ.';

  @override
  String finCorSaved(String ref) {
    return 'تم حفظ التصحيح في هذا الجهاز ($ref).';
  }

  @override
  String get finCorNoEntries => 'لا توجد قيود للتصحيح.';

  @override
  String finCorCurrent(String amount) {
    return 'القيمة الحالية $amount';
  }

  @override
  String get finCorSameFund => 'اختر صندوق تبرعات مختلفًا.';

  @override
  String get finHistTitle => 'سجل القيد';

  @override
  String finHistOriginal(String what) {
    return 'الأصل: $what';
  }

  @override
  String finHistCorrection(String ref) {
    return 'التصحيح $ref';
  }

  @override
  String finHistCurrent(String amount) {
    return 'القيمة الحالية $amount';
  }

  @override
  String finHistAfter(int n, String amount) {
    return 'القيمة الحالية بعد $n تصحيحات. الأصل $amount.';
  }

  @override
  String get finHistBy => 'بواسطة';

  @override
  String get finHistDevice => 'الجهاز';

  @override
  String get finHistEntered => 'تاريخ الإدخال';

  @override
  String get finHistPhoto => 'صورة ورقة العدّ';

  @override
  String get finHistPhotoNote => 'تُعرض عبر MAXCOM في المصلى';

  @override
  String get finHistFixAgain => 'تصحيح مرة أخرى';

  @override
  String get finHistLocked =>
      'لا حذف ولا تعديل في مكانه. هذا السجل نفسه في الهاتف وفي MAXCOM بالمصلى وفي السحابة.';

  @override
  String get finUnknownUser => 'مستخدم غير معروف';

  @override
  String get finKindIn => 'التحصيل';

  @override
  String get finKindOut => 'المدفوعات';

  @override
  String get finKindAdjust => 'التصحيح';

  @override
  String get finKindOpening => 'الرصيد الافتتاحي';

  @override
  String finFundChanged(String fund) {
    return 'تم تغيير صندوق التبرعات إلى $fund';
  }

  @override
  String get finVoided => 'ملغى';

  @override
  String finKuliahOn(String title, String date) {
    return '$title، $date';
  }

  @override
  String get comingLive => 'بثّ الدرس مباشرة على تلفاز المصلى وYouTube.';

  @override
  String get comingJemaah =>
      'صفحة المصلّين وخلاصة التقويم لمشاركتها مع أهل الحي.';

  @override
  String get comingThisDevice =>
      'اسم هذا الجهاز وبصمة الإصبع لفتح القفل وشهادة MAXCOM.';

  @override
  String get accountSheetHint => 'هذا الجهاز مسجّل باسمك.';

  @override
  String get loadFailed => 'تعذّر التحميل. أعد المحاولة.';

  @override
  String get errorTooMany =>
      'محاولات كثيرة جدًا. انتظر قليلًا ثم أعد المحاولة.';

  @override
  String get peopleTabUsers => 'المستخدمون';

  @override
  String get peopleTabDevices => 'الأجهزة';

  @override
  String get peopleTabPairing => 'شاشة التلفاز';

  @override
  String get usersAdd => 'إضافة مستخدم';

  @override
  String get usersEmpty => 'لا يوجد مستخدمون بعد.';

  @override
  String get usersInactive => 'غير نشط';

  @override
  String get usersLocked => 'رمز PIN مقفل';

  @override
  String get usersPinPending => 'لم يُحدَّد رمز PIN';

  @override
  String get userNameLabel => 'الاسم';

  @override
  String get userNameHint => 'مثال: أمينة بنت يوسف';

  @override
  String get userNameRequired => 'أدخل اسم المستخدم';

  @override
  String get userRolesTitle => 'الأدوار';

  @override
  String get userRolesHint => 'يمكن أن يحمل الشخص الواحد أكثر من دور.';

  @override
  String get userRoleRequired => 'اختر دورًا واحدًا على الأقل.';

  @override
  String get roleAdminHint =>
      'جميع الإعدادات والمستخدمين والأجهزة وسجل التغييرات';

  @override
  String get roleTreasurerHint => 'المالية وصناديق تبرعات المصلى';

  @override
  String get roleMediaHint => 'المحتوى والملصقات';

  @override
  String get roleLive => 'البث المباشر';

  @override
  String get roleLiveHint =>
      'يفتح قائمة البث المباشر وإعداداتها: الكاميرا الخارجية ومصدر الصوت والشاشة وYouTube والتسجيل';

  @override
  String get usersMediaNoLiveHint =>
      'لم يعد دور الإعلام قادرًا على البث المباشر. امنح دور البث المباشر للمستخدمين الذين يحتاجونه.';

  @override
  String get roleAjkHint => 'عرض الإعدادات والمحتوى فقط، والمالية (للعرض فقط)';

  @override
  String userCreated(String name) {
    return 'تمت إضافة $name. الخطوة التالية: تسجيل جهازه.';
  }

  @override
  String get userRolesSave => 'حفظ الأدوار';

  @override
  String get userRolesSaved => 'تم حفظ الأدوار';

  @override
  String get userEnrolDevice => 'تسجيل جهاز';

  @override
  String userEnrolDeviceHint(String name) {
    return 'أنشئ رمز QR لهاتف $name أو iPad الخاص به.';
  }

  @override
  String get userResetPin => 'إعادة تعيين PIN';

  @override
  String userResetPinHint(String name) {
    return 'سيحدّد $name رمز PIN جديدًا عند فتح القفل في المرة القادمة.';
  }

  @override
  String userResetPinTitle(String name) {
    return 'إعادة تعيين PIN الخاص بـ $name؟';
  }

  @override
  String get userResetPinLost => 'هل فُقد هذا الهاتف؟';

  @override
  String get userResetPinLostHint =>
      'حدّد الجهاز المفقود. يُلغى هذا الجهاز فورًا ولا يستطيع تحديد رمز PIN جديد.';

  @override
  String userResetPinNoDevices(String name) {
    return 'ليس لدى $name أجهزة بعد.';
  }

  @override
  String userResetPinDone(String name) {
    return 'تمت إعادة تعيين PIN الخاص بـ $name.';
  }

  @override
  String userResetPinDoneRevoked(String name, int n) {
    return 'تمت إعادة تعيين PIN الخاص بـ $name. تم إلغاء $n أجهزة.';
  }

  @override
  String get userDeactivate => 'إيقاف التفعيل';

  @override
  String userDeactivateHint(String name) {
    return 'تُلغى جميع أجهزة $name ورموزه. يبقى الاسم في السجل والسجلات المالية.';
  }

  @override
  String userDeactivateTitle(String name) {
    return 'إيقاف تفعيل $name؟';
  }

  @override
  String userDeactivated(String name) {
    return 'تم إيقاف تفعيل $name.';
  }

  @override
  String get userNotFound => 'لم يتم العثور على المستخدم.';

  @override
  String get enrolBoxOnly =>
      'يجب أن ينشئ MAXCOM في المصلى رمز الجهاز. استخدم هاتف مسؤول المصلى على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get enrolQrTitle => 'تسجيل جهاز';

  @override
  String enrolQrFor(String name) {
    return 'جهاز $name';
  }

  @override
  String enrolQrNameHint(String name) {
    return 'مثال: هاتف $name';
  }

  @override
  String get enrolQrGenerate => 'إنشاء رمز QR';

  @override
  String enrolQrScanHint(String name) {
    return 'اطلب من $name فتح تطبيق MAXCOM على جهازه ومسح هذا الرمز.';
  }

  @override
  String get enrolQrCodeLabel => 'رمز التحقق';

  @override
  String enrolQrExpiresIn(String time) {
    return 'ينتهي خلال $time';
  }

  @override
  String get enrolQrExpired => 'انتهت صلاحية الرمز. أنشئ رمزًا جديدًا.';

  @override
  String get enrolQrNew => 'إنشاء رمز جديد';

  @override
  String get enrolQrCopy => 'نسخ الرمز';

  @override
  String get enrolQrCopied => 'تم نسخ الرمز';

  @override
  String get enrolQrCaHint =>
      'اطلب منهم مقارنة بصمة هذه الشهادة بالبصمة الظاهرة على شاشتهم.';

  @override
  String get devicesEmpty => 'لا توجد أجهزة مسجّلة بعد.';

  @override
  String get devicesPair => 'إقران شاشة التلفاز';

  @override
  String get devicesRevoke => 'حذف';

  @override
  String devicesRevokeTitle(String name) {
    return 'هل تريد حذف $name؟';
  }

  @override
  String get devicesRevokeBody =>
      'لن يستطيع هذا الجهاز فتح القفل بعد الآن. لاستخدامه من جديد، سجّله برمز QR جديد.';

  @override
  String get devicesRevoked => 'محذوف';

  @override
  String devicesRevokedToast(String name) {
    return 'تم حذف $name.';
  }

  @override
  String get devicesKioskGroup => 'شاشة التلفاز';

  @override
  String get platformAndroid => 'Android';

  @override
  String get platformIosWeb => 'iPad (Safari)';

  @override
  String get platformWeb => 'متصفح الويب';

  @override
  String get platformKiosk => 'شاشة التلفاز';

  @override
  String get pairingTitle => 'إقران شاشة التلفاز';

  @override
  String get pairingIntro =>
      'عند التشغيل لأول مرة، يعرض التلفاز رمزًا من 6 أرقام. أدخل ذلك الرمز هنا للموافقة على الشاشة.';

  @override
  String get pairingPendingTitle => 'شاشات بانتظار الموافقة';

  @override
  String get pairingPendingNone => 'لا توجد شاشة بانتظار الموافقة.';

  @override
  String pairingPendingRow(String ip, String age) {
    return 'من $ip، قبل $age';
  }

  @override
  String get pairingUnknownIp => 'عنوان غير معروف';

  @override
  String get pairingCodeLabel => 'الرمز على التلفاز';

  @override
  String get pairingCodeRequired => 'أدخل الأرقام الستة الظاهرة على التلفاز.';

  @override
  String get pairingNameLabel => 'اسم الشاشة (اختياري)';

  @override
  String get pairingNameHint => 'مثال: الشاشة الرئيسية';

  @override
  String get pairingApprove => 'موافقة';

  @override
  String pairingDone(String name) {
    return 'تم إقران الشاشة: $name';
  }

  @override
  String pairingDoneDetail(String ip, String age) {
    return 'طلب من $ip، عمر الرمز $age.';
  }

  @override
  String get pairingStrangerHint =>
      'تأكد من أن العنوان هو تلفاز مصلاك وليس جهازًا غريبًا.';

  @override
  String ageSeconds(int n) {
    return '$n ثانية';
  }

  @override
  String ageMinutes(int n) {
    return '$n دقيقة';
  }

  @override
  String get auditEmpty => 'لا توجد تغييرات مسجّلة بعد.';

  @override
  String get auditFilterAll => 'الكل';

  @override
  String get auditLoadMore => 'عرض المزيد';

  @override
  String get auditBefore => 'قبل';

  @override
  String get auditAfter => 'بعد';

  @override
  String get auditNoDetail => 'لا توجد تفاصيل';

  @override
  String get auditEmptyValue => 'فارغ';

  @override
  String get auditKeyEnabled => 'مفعّل';

  @override
  String get auditKeyName => 'الاسم';

  @override
  String get auditKeyRoles => 'الأدوار';

  @override
  String get auditKeyActive => 'نشط';

  @override
  String get auditKeyPinRequired => 'يجب تحديد رمز PIN';

  @override
  String get auditKeyPlatform => 'نوع الجهاز';

  @override
  String get auditKeyRevoked => 'ملغى';

  @override
  String get auditKeyUser => 'المستخدم';

  @override
  String get auditKeyId => 'المعرّف';

  @override
  String get auditEntityUsers => 'المستخدمون';

  @override
  String get auditEntityDevices => 'الأجهزة';

  @override
  String get auditEntitySettings => 'الإعدادات';

  @override
  String get auditEntityContent => 'المحتوى';

  @override
  String get auditEntityPrayer => 'مواقيت الصلاة';

  @override
  String get auditEntityIslamic => 'المحتوى الإسلامي';

  @override
  String get auditEntityAssets => 'الملفات';

  @override
  String get auditEntityPrayerDays => 'بيانات مواقيت الصلاة';

  @override
  String get auditKeyCount => 'عدد الأيام';

  @override
  String get auditKeyFrom => 'من';

  @override
  String get auditKeyTo => 'إلى';

  @override
  String get auditKeySummary => 'ملخص';

  @override
  String get auditKeyDetail => 'التفاصيل';

  @override
  String get auditActionIslamicFetch => 'تنزيل';

  @override
  String get auditSystem => 'النظام';

  @override
  String get thisDevicePlatform => 'النوع';

  @override
  String get thisDeviceUser => 'مسجّل باسم';

  @override
  String get thisDeviceChangePin => 'تغيير PIN';

  @override
  String get thisDeviceChangePinHint => 'يُستخدم رمز PIN نفسه في جميع أجهزتك.';

  @override
  String get pinCurrentLabel => 'رمز PIN الحالي';

  @override
  String get pinChanged => 'تم تغيير PIN';

  @override
  String get thisDeviceBiometricHint =>
      'افتح القفل ببصمة الإصبع دون كتابة PIN.';

  @override
  String get thisDeviceBiometricOnTitle => 'أدخل رمز PIN الخاص بك';

  @override
  String get thisDeviceBiometricOnBody =>
      'يُحفظ رمز PIN بأمان في هذا الجهاز ولا يُفتح إلا ببصمة إصبعك.';

  @override
  String get thisDeviceBiometricOn => 'تم تفعيل بصمة الإصبع';

  @override
  String get thisDeviceBiometricOff => 'تم إيقاف بصمة الإصبع';

  @override
  String get thisDeviceLogoutHint => 'قفل هذا التطبيق. يبقى تسجيل الجهاز.';

  @override
  String get thisDeviceForget => 'نسيان هذا الجهاز';

  @override
  String get thisDeviceForgetHint =>
      'احذف المفتاح والتسجيل من هذا الجهاز. تحتاج إلى رمز QR جديد لاستخدامه من جديد.';

  @override
  String get thisDeviceForgetTitle => 'نسيان هذا الجهاز؟';

  @override
  String get thisDeviceForgetConfirm => 'نسيان';

  @override
  String get settingsListHint => 'فعّل أو أوقف كل ميزة واضبط إعداداتها.';

  @override
  String get settingsReadOnlyHint =>
      'يمكنك رؤية الإعدادات لكن لا يمكنك تغييرها.';

  @override
  String get settingsLockedHint =>
      'هذه ميزة أساسية مفعّلة دائمًا ولا يمكن إيقافها.';

  @override
  String get settingsFeatureOffHint =>
      'هذه الميزة متوقفة. تُحفظ إعداداتها وتُستخدم من جديد عند تفعيلها.';

  @override
  String get settingsNoSettings =>
      'لا توجد إعدادات أخرى لهذه الميزة. فعّلها أو أوقفها فقط.';

  @override
  String get settingsSave => 'حفظ';

  @override
  String get settingsSaved => 'تم حفظ الإعدادات';

  @override
  String get settingsChangedElsewhere =>
      'تم تغيير هذه الإعدادات في جهاز آخر. سيؤدي الحفظ إلى استبدالها.';

  @override
  String get settingsReset => 'إعادة التعيين إلى الافتراضي';

  @override
  String settingsResetTitle(String feature) {
    return 'إعادة تعيين $feature؟';
  }

  @override
  String get settingsResetBody =>
      'تعود جميع إعدادات هذه الميزة إلى القيم الأصلية في MAXCOM.';

  @override
  String get settingsResetDone => 'تمت استعادة الإعدادات الأصلية';

  @override
  String get settingsCopyToAllDays => 'نسخ إلى كل الأيام';

  @override
  String settingsCopiedToAllDays(String day) {
    return 'تم نسخ قيمة $day إلى كل الأيام';
  }

  @override
  String get settingsOptionalHint => 'اتركه فارغًا للإعداد الأصلي.';

  @override
  String get settingsShortNameHint => 'مثال: SDM';

  @override
  String get settingsShortNameHelper => 'اتركه فارغًا لاستخدام اسم المصلى.';

  @override
  String get settingsDecrease => 'أقل';

  @override
  String get settingsIncrease => 'أكثر';

  @override
  String get settingsNotFound => 'لم يتم العثور على الميزة.';

  @override
  String settingsSwitchedOn(String feature) {
    return 'تم تفعيل $feature';
  }

  @override
  String settingsSwitchedOff(String feature) {
    return 'تم إيقاف $feature';
  }

  @override
  String get settingsBackgroundsBuiltIn => 'الصور الجاهزة';

  @override
  String get settingsBackgroundsUploaded => 'الصور المرفوعة';

  @override
  String get settingsBackgroundsHint =>
      'تتناوب الصور المحددة على التلفاز حسب إعداد تبديل الصورة.';

  @override
  String get settingsBackgroundsEmpty =>
      'لم تُحدَّد صور. يستخدم التلفاز أول صورة جاهزة.';

  @override
  String get settingsBackgroundsNone => 'لم تُرفع صور بعد.';

  @override
  String get settingsBackgroundsOffline =>
      'تعذّرت قراءة قائمة الصور المرفوعة الآن. ما زال يمكن اختيار الصور الجاهزة.';

  @override
  String get settingsBackgroundsOrder =>
      'الرقم على الصورة هو ترتيب دورانها على التلفاز. اضغط الصور بالترتيب الذي تريده.';

  @override
  String get settingsBackgroundsUpload => 'رفع صورة خلفية';

  @override
  String get settingsBackgroundUploaded => 'تم حفظ صورة الخلفية، وسيتم رفعها';

  @override
  String settingsBackgroundTile(int n) {
    return 'الصورة المرفوعة $n';
  }

  @override
  String settingsBackgroundRemove(String name) {
    return 'إزالة $name';
  }

  @override
  String settingsBuiltInImage(int n) {
    return 'الصورة $n';
  }

  @override
  String get contentKindsHint => 'اختر نوع المحتوى لعرضه أو تعديله.';

  @override
  String contentAdd(String kind) {
    return 'إضافة $kind';
  }

  @override
  String contentEmpty(String kind) {
    return 'لا يوجد $kind بعد.';
  }

  @override
  String get contentSearchHint => 'بحث';

  @override
  String get contentZikirSettings => 'إعدادات عرض الأذكار';

  @override
  String get contentZikirSettingsHint =>
      'متى تبدأ الأذكار، ومدة كل ذكر، والساعة وشكل الشاشة';

  @override
  String get contentNoMatch => 'لا توجد نتائج مطابقة.';

  @override
  String contentCount(int n) {
    return '$n سجلات';
  }

  @override
  String contentNew(String kind) {
    return '$kind جديد';
  }

  @override
  String contentEdit(String kind) {
    return 'تعديل $kind';
  }

  @override
  String contentSaved(String kind) {
    return 'تم حفظ $kind.';
  }

  @override
  String contentDeleteTitle(String kind) {
    return 'حذف هذا العنصر ($kind)؟';
  }

  @override
  String get contentDeleteBody => 'يُزال فورًا من التلفاز ولا يمكن استرجاعه.';

  @override
  String contentDeleted(String kind) {
    return 'تم حذف $kind.';
  }

  @override
  String get contentNotFound => 'لم يتم العثور على السجل.';

  @override
  String get contentCancelledBadge => 'ملغى';

  @override
  String get contentCancelledHint =>
      'الدرس الملغى يُعلَّم بكلمة ملغى على التلفاز ولا يُحذف.';

  @override
  String contentRefMissing(String what) {
    return 'لم يتم العثور على $what';
  }

  @override
  String contentRefUnknown(String what) {
    return '$what غير معروف';
  }

  @override
  String contentPickRef(String what) {
    return 'اختر $what';
  }

  @override
  String contentNoRefItems(String what) {
    return 'لا يوجد $what بعد. أضفه أولًا في قسم $what.';
  }

  @override
  String get contentDateHint => 'مثال: 2026-11-05';

  @override
  String get contentTimeHint => 'مثال: 19:15';

  @override
  String get contentDateTimeHint => 'مثال: 2026-11-20T20:30';

  @override
  String get contentPickDate => 'اختر التاريخ';

  @override
  String get contentPickTime => 'اختر الوقت';

  @override
  String get contentDaysHint => 'اختر الأيام التي يُعرض فيها.';

  @override
  String get contentEveryDay => 'كل يوم';

  @override
  String get contentOptional => 'اختياري';

  @override
  String get contentNone => 'لا شيء';

  @override
  String get contentUntil => 'حتى';

  @override
  String contentShownFromTo(String from, String to) {
    return '$from حتى $to';
  }

  @override
  String contentSurah(int n, String name) {
    return 'سورة $n · $name';
  }

  @override
  String contentMinutesBefore(int n, String slot) {
    return 'قبل $slot بـ $n دقيقة';
  }

  @override
  String get contentOff => 'متوقف';

  @override
  String contentOrder(int n) {
    return 'الترتيب $n';
  }

  @override
  String contentRepeat(int n) {
    return '$n مرات';
  }

  @override
  String contentCharsLeft(int n) {
    return 'متبقٍ $n حرفًا';
  }

  @override
  String get contentPhoneHint =>
      'هذا الرقم لأعضاء اللجنة فقط ولا يُعرض على التلفاز.';

  @override
  String get contentAssetHint => 'تُصغَّر الصورة تلقائيًا قبل رفعها.';

  @override
  String get imagePick => 'اختيار صورة';

  @override
  String get imageChange => 'تغيير الصورة';

  @override
  String get imageRemove => 'إزالة الصورة';

  @override
  String get imagePreparing => 'جارٍ تجهيز الصورة';

  @override
  String get imageUploading => 'جارٍ حفظ الصورة';

  @override
  String get imageQueued => 'جارٍ الرفع…';

  @override
  String get imageLost => 'فشل الرفع';

  @override
  String get imageChooseAgain => 'اختيار الصورة من جديد';

  @override
  String get imageUploaded => 'تم رفع الصورة';

  @override
  String get imageSaved => 'تم حفظ الصورة، وسيتم رفعها';

  @override
  String get imagePickFailed => 'تعذّرت قراءة الصورة. جرّب صورة أخرى.';

  @override
  String get imageFailed => 'تعذّر رفع الصورة.';

  @override
  String get imageNone => 'لا توجد صورة';

  @override
  String imageSize(int w, int h) {
    return '$w × $h بكسل';
  }

  @override
  String get imageAdjust => 'ضبط الصورة';

  @override
  String get imageAdjustLogo => 'ضبط الشعار';

  @override
  String get imageAdjusted => 'تم ضبط الصورة';

  @override
  String get imageAdjustHint =>
      'اسحب للتحريك، واقرص أو مرّر عجلة الماوس للتكبير. لوحة المفاتيح: الأسهم للتحريك، + و- للتكبير، R للتدوير.';

  @override
  String get imageFrameHint => 'اسحب حافة الإطار لتغيير المنطقة المعروضة.';

  @override
  String get imageZoomIn => 'تكبير';

  @override
  String get imageZoomOut => 'تصغير';

  @override
  String get imageRotate => 'تدوير 90 درجة';

  @override
  String get imageReset => 'إعادة التعيين';

  @override
  String imageStep(int n, int total) {
    return 'الخطوة $n من $total';
  }

  @override
  String get imageStepCrop => 'القص والخلفية';

  @override
  String get imageStepSquare => 'أيقونة مربعة';

  @override
  String get imageStepNext => 'التالي';

  @override
  String get imageStepBack => 'رجوع';

  @override
  String get imageBgTitle => 'الخلفية';

  @override
  String get imageBgRemove => 'إزالة الخلفية البيضاء';

  @override
  String get imageBgRemoveColour => 'إزالة لون الخلفية';

  @override
  String get imageBgCard => 'وضعها على بطاقة فاتحة';

  @override
  String get imageBgKeep => 'إبقاء';

  @override
  String get imageBgNotPlain =>
      'خلفية هذه الصورة غير متجانسة. قد لا تكون إزالتها نظيفة.';

  @override
  String get imageBgTransparent => 'خلفية هذه الصورة شفافة بالفعل.';

  @override
  String get imageBefore => 'قبل';

  @override
  String get imageAfter => 'بعد';

  @override
  String get imageSquareHint =>
      'يصبح هذا الجزء أيقونة التطبيق وأيقونة المتصفح.';

  @override
  String get imageAppIcon => 'أيقونة التطبيق';

  @override
  String get imageFavicon => 'أيقونة المتصفح';

  @override
  String get logoHeaderPreview => 'الشكل على شاشة التلفاز وفي التطبيق';

  @override
  String get previewPhaseBiasa => 'عادي';

  @override
  String get previewPhaseAzan => 'الأذان';

  @override
  String get previewPhaseIqamah => 'الإقامة';

  @override
  String get previewPhaseSolat => 'الصلاة';

  @override
  String get previewPhaseJumaat => 'الجمعة';

  @override
  String get previewPhaseNoData => 'لا توجد بيانات';

  @override
  String get previewIntro =>
      'العرض الفعلي لشاشة تلفاز المصلى. اختر حالة لرؤية شكلها؛ هذا العرض للقراءة فقط ولا يغيّر شيئًا في MAXCOM.';

  @override
  String get previewPhaseNeedsData =>
      'أزرار الحالة تحتاج إلى بيانات مواقيت الصلاة من MAXCOM.';

  @override
  String get previewLive => 'الوقت الفعلي';

  @override
  String previewClockFrom(String when) {
    return 'تبدأ ساعة الشاشة من $when';
  }

  @override
  String get previewReload => 'إعادة التحميل';

  @override
  String get previewNoSession => 'افتح القفل من جديد لرؤية المعاينة.';

  @override
  String get previewTlsFailed => 'تعذّر الاتصال الآمن بالمعاينة. أعد المحاولة.';

  @override
  String get previewLoadFailed =>
      'تعذّر عرض المعاينة. تحقق من اتصال الشبكة ثم أعد المحاولة.';

  @override
  String get previewTlsExpected => 'الشهادة المتوقعة (SHA-256)';

  @override
  String get previewTlsPresented => 'الشهادة المعروضة (SHA-256)';

  @override
  String get posterPreviewButton => 'معاينة على التلفاز';

  @override
  String get posterPreviewTitle => 'معاينة الملصق';

  @override
  String get posterPreviewHint =>
      'هكذا يبدو هذا الملصق على تلفاز المصلى. لا يتغير شيء على التلفاز الفعلي.';

  @override
  String get posterPreviewNeedsImage => 'اختر صورة الملصق أولًا.';

  @override
  String get logoHint =>
      'PNG أو JPEG. شعار عريض أو مربع؛ يمكن إزالة الخلفية البيضاء بعد الاختيار.';

  @override
  String get logoNotImage => 'يجب أن يكون الشعار صورة PNG أو JPEG.';

  @override
  String get logoMissing =>
      'لم يتم العثور على صورة الشعار في MAXCOM. اخترها من جديد.';

  @override
  String get settingsPrayerDataHint => 'نزّل من e-Solat أو ارفع ملف CSV';

  @override
  String get settingsIslamicRow => 'القرآن الكريم وصوت التلاوة';

  @override
  String get settingsIslamicHint =>
      'نص القرآن الكريم وصوت التلاوة لشاشة التلفاز';

  @override
  String get islamicIntro =>
      'محتوى محفوظ في MAXCOM ليتمكن التلفاز من عرضه دون إنترنت.';

  @override
  String get islamicQuranTitle => 'نص القرآن الكريم';

  @override
  String get islamicQuranPresent => 'نص القرآن الكريم متوفر';

  @override
  String get islamicQuranAbsent => 'لم يُنزَّل نص القرآن الكريم بعد';

  @override
  String islamicQuranDetail(int ayat, String version) {
    return '$ayat آية، الإصدار $version';
  }

  @override
  String get islamicQuranHint =>
      'يُعرض في بطاقة الآية وقارئ القرآن على شاشة التلفاز.';

  @override
  String get islamicAudioTitle => 'التلاوة (صوت)';

  @override
  String islamicReciter(String reciter) {
    return 'القارئ: $reciter';
  }

  @override
  String islamicSurahsStored(int n) {
    return '$n سور محفوظة';
  }

  @override
  String get islamicNoSurahs => 'لا توجد سور محفوظة بعد';

  @override
  String islamicCacheUsage(int used, int max) {
    return 'المستخدم $used MB من $max MB';
  }

  @override
  String get islamicSurahPick => 'اختر سورة';

  @override
  String get islamicSurahSearch => 'ابحث باسم السورة أو رقمها';

  @override
  String get islamicSurahStored => 'محفوظة';

  @override
  String get islamicBusy => 'جارٍ التنزيل';

  @override
  String get islamicJobQuran => 'جارٍ تنزيل نص القرآن الكريم';

  @override
  String islamicJobSurah(String surah) {
    return 'جارٍ تنزيل سورة $surah';
  }

  @override
  String get islamicJobDone => 'اكتمل';

  @override
  String get islamicJobDoneQuran => 'تم حفظ نص القرآن الكريم في MAXCOM.';

  @override
  String islamicJobDoneSurah(String surah) {
    return 'تم حفظ سورة $surah في MAXCOM.';
  }

  @override
  String get islamicJobFailed => 'فشل التنزيل';

  @override
  String get islamicReadOnly => 'يستطيع المسؤول وحده تنزيل المحتوى.';

  @override
  String get prayerDataDaysAhead => 'يومًا قادمًا من بيانات مواقيت الصلاة';

  @override
  String get prayerDataDaysUnknown => 'غير معروف بعد';

  @override
  String prayerDataZone(String zone) {
    return 'المنطقة $zone';
  }

  @override
  String get prayerDataZoneUnknown => 'منطقة مواقيت الصلاة غير معروفة بعد.';

  @override
  String get prayerDataLow =>
      'البيانات على وشك النفاد. نزّل بيانات السنة التالية الآن.';

  @override
  String prayerDataNoYear(int year) {
    return 'لا توجد بيانات مواقيت الصلاة لسنة $year بعد.';
  }

  @override
  String get prayerDataYearChoose => 'اختر السنة';

  @override
  String prayerDataReplaceNote(int year) {
    return 'ستُستبدل البيانات الموجودة لسنة $year.';
  }

  @override
  String get prayerDataReplaceTitle => 'استبدال البيانات الموجودة؟';

  @override
  String get prayerDataReplaceAction => 'استبدال';

  @override
  String get prayerDataPickFile => 'اختر ملف CSV';

  @override
  String get prayerDataFileTooBig => 'الملف كبير جدًا. الحد الأقصى 1 MB.';

  @override
  String get prayerDataFileUnreadable => 'تعذّرت قراءة الملف.';

  @override
  String get statusPrayerDataNone =>
      'لا توجد بيانات مواقيت الصلاة بعد. نزّلها أو ارفعها الآن.';

  @override
  String get prayerDataUpdateTitle => 'تحديث البيانات';

  @override
  String prayerDataYearLine(int year) {
    return 'بيانات سنة $year';
  }

  @override
  String fetchFromSource(String source) {
    return 'التنزيل من $source إلى MAXCOM';
  }

  @override
  String refetchFromSource(String source) {
    return 'التنزيل من $source مرة أخرى';
  }

  @override
  String get prayerDataFetchHint =>
      'ينزّل MAXCOM مباشرة من e-Solat التابع لـ JAKIM. يحتاج إلى إنترنت في المصلى.';

  @override
  String get prayerDataUploadCsv => 'رفع ملف CSV';

  @override
  String get prayerDataUploadHint =>
      'ملف CSV السنوي من موقع e-Solat لهذه المنطقة.';

  @override
  String get prayerDataPasteTitle => 'لصق محتوى CSV';

  @override
  String get prayerDataPasteHint =>
      'افتح ملف CSV من e-Solat وانسخ كل محتواه والصقه هنا.';

  @override
  String get prayerDataPasteLabel => 'محتوى CSV';

  @override
  String get prayerDataPasteEmpty => 'الصق محتوى CSV أولًا.';

  @override
  String get prayerDataWorkingFetch => 'جارٍ التنزيل من e-Solat';

  @override
  String get prayerDataWorkingUpload => 'جارٍ الرفع';

  @override
  String get prayerDataResultTitle => 'تم تحديث بيانات مواقيت الصلاة';

  @override
  String prayerDataResult(int n, int m) {
    return 'أُضيف $n، واستُبدل $m';
  }

  @override
  String get liveTitle => 'البث المباشر';

  @override
  String get liveStart => 'بدء البث';

  @override
  String get liveStop => 'إيقاف';

  @override
  String get liveStopConfirm => 'إيقاف البث؟';

  @override
  String get liveStopConfirmBody =>
      'ستتوقف شاشة المصلى وYouTube عن استقبال هذا البث.';

  @override
  String get liveStopConfirmAction => 'إيقاف';

  @override
  String get liveStarting => 'جارٍ بدء البث';

  @override
  String get liveStopping => 'جارٍ إيقاف البث';

  @override
  String get livePreparing => 'جارٍ تجهيز الكاميرا';

  @override
  String get liveKiosk => 'شاشة المصلى';

  @override
  String get liveKioskHint => 'عبر شبكة Wi-Fi الخاصة بالمصلى';

  @override
  String get liveYoutube => 'YouTube';

  @override
  String get liveYoutubeHint => 'قناة YouTube الخاصة بالمصلى';

  @override
  String get liveRecording => 'التسجيل';

  @override
  String get liveRecordingOn => 'جارٍ التسجيل';

  @override
  String get liveRecordingOff => 'متوقف';

  @override
  String get liveRecordingWithLive => 'يبدأ مع البث';

  @override
  String liveRecordingParts(int n, String size) {
    return '$n أجزاء، $size';
  }

  @override
  String get liveReady => 'جاهز';

  @override
  String get liveNotUsed => 'غير مستخدم';

  @override
  String get liveConnecting => 'جارٍ الاتصال';

  @override
  String get liveOn => 'يبث الآن';

  @override
  String liveRetry(int n) {
    return 'أعد المحاولة بعد $n ث';
  }

  @override
  String get liveDown => 'انقطع';

  @override
  String get liveDuration => 'المدة';

  @override
  String get liveBitrate => 'معدل البت';

  @override
  String get liveFps => 'إطارات في الثانية';

  @override
  String get liveKuliahToday => 'اليوم';

  @override
  String get liveKuliahUpcoming => 'قادم';

  @override
  String get liveKuliahPick => 'اختر الدرس';

  @override
  String get liveKuliahChange => 'تغيير';

  @override
  String get liveNoKuliah => 'لا توجد دروس اليوم';

  @override
  String get liveNoKuliahOption => 'بدون درس';

  @override
  String get liveNoKuliahHint => 'بث بلا عنوان درس';

  @override
  String get liveFlip => 'تبديل الكاميرا';

  @override
  String get liveMinimise => 'تصغير الإعدادات';

  @override
  String get liveExpand => 'إظهار الإعدادات';

  @override
  String get liveMute => 'كتم الميكروفون';

  @override
  String get liveUnmute => 'تشغيل الميكروفون';

  @override
  String get liveMuted => 'الميكروفون مكتوم';

  @override
  String get liveWarnBattery => 'البطارية منخفضة';

  @override
  String get liveWarnHot => 'الهاتف ساخن';

  @override
  String get liveWarnScreen => 'أبقِ الشاشة مفتوحة. قفل الشاشة يوقف الكاميرا.';

  @override
  String get liveWarnStorage => 'التخزين شبه ممتلئ';

  @override
  String get liveWarnNoInternet => 'لا يوجد إنترنت: تم إيقاف YouTube';

  @override
  String get liveYoutubeNeedsSignIn => 'سجّل الدخول إلى YouTube أولًا';

  @override
  String get liveYoutubeAskAdmin => 'اطلب من المسؤول تسجيل الدخول إلى YouTube';

  @override
  String get liveEnded => 'انتهى البث';

  @override
  String liveYoutubeShort(int got, int total) {
    return 'استقبل YouTube $got دقيقة من أصل $total دقيقة';
  }

  @override
  String get liveSaveRecording => 'حفظ التسجيل';

  @override
  String get liveRecordingSaved => 'تم حفظ التسجيل في Movies/MAXCOM';

  @override
  String get liveWatch => 'المشاهدة على YouTube';

  @override
  String get liveYoutubeAccount => 'حساب YouTube الخاص بالمصلى';

  @override
  String get liveSignInHint =>
      'اربط قناة YouTube الخاصة بالمصلى مع MAXCOM مرة واحدة فقط. بعد ذلك يمكن بث كل درس إلى YouTube.';

  @override
  String get liveSignIn => 'تسجيل الدخول إلى YouTube';

  @override
  String get liveSignInCode =>
      'افتح google.com/device في هاتفك وأدخل هذا الرمز';

  @override
  String get liveSignInOpen => 'فتح google.com/device';

  @override
  String get liveSignInWaiting => 'بانتظار تسجيل دخولك';

  @override
  String get errcVideoBusy =>
      'يجري رفع فيديو آخر إلى MAXCOM. حاول مرة أخرى بعد قليل.';

  @override
  String get errcCameraStale => 'تغيّرت إعدادات الكاميرا. حاول مرة أخرى.';

  @override
  String get errcCameraPasswordAgain => 'اكتب كلمة مرور الكاميرا مرة أخرى.';

  @override
  String get liveSignInByAdmin =>
      'يقوم أحد المسؤولين بتسجيل الدخول إلى YouTube حاليًا.';

  @override
  String liveSignedInAs(String channel) {
    return 'متصل بالقناة $channel';
  }

  @override
  String get liveSignOut => 'تسجيل الخروج من YouTube';

  @override
  String get liveYoutubeConnected => 'تم ربط YouTube';

  @override
  String liveYoutubeConnectedSnack(String channel) {
    return 'تم ربط YouTube: $channel';
  }

  @override
  String get liveYoutubeAtSurauOnly =>
      'تسجيل الدخول إلى YouTube أو تغيير القناة متاح فقط عبر شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get liveYoutubeNotConnected => 'لم يتم ربط YouTube';

  @override
  String liveDestOn(String channel) {
    return '⁨YouTube⁩: نعم، $channel';
  }

  @override
  String get liveDestOff => '⁨YouTube⁩: لا';

  @override
  String get liveDestSkip => 'لم يتم اختيار YouTube: يُبث إلى شاشة المصلى فقط.';

  @override
  String get liveDestNone => 'لم يتم ربط YouTube بعد';

  @override
  String liveYoutubeUnknown(String channel) {
    return '⁨YouTube⁩: تعذر التحقق الآن (آخر قناة: $channel)';
  }

  @override
  String get liveYoutubeUnknownNoLast => '⁨YouTube⁩: تعذر التحقق الآن';

  @override
  String get liveYoutubeAskTitle => 'لا يمكن استخدام ⁨YouTube⁩';

  @override
  String liveYoutubeAskBody(String reason) {
    return 'لا يمكن استخدام ⁨YouTube⁩ الآن: $reason. هل تبدأ البث إلى شاشة المصلى فقط؟';
  }

  @override
  String get liveYoutubeWhyNoInternet => 'لا يوجد اتصال بالإنترنت';

  @override
  String get liveYoutubeWhyRevoked => 'يجب ربطه من جديد';

  @override
  String get liveYoutubeWhyNeedsSignIn => 'لم يُسجَّل الدخول إليه';

  @override
  String get liveYoutubeWhyAskAdmin =>
      'لم يُسجَّل الدخول إليه، اطلب من المسؤول تسجيل الدخول';

  @override
  String get liveYoutubeWhyUnknownNoLast => 'تعذر التحقق من الحساب الآن';

  @override
  String liveYoutubeWhyUnknown(String channel) {
    return 'تعذر التحقق من الحساب الآن (آخر قناة: $channel)';
  }

  @override
  String get tvLangArNeedsUpdate => 'حدّث MAXCOM لاستخدام العربية';

  @override
  String get tvLangArAskTitle => 'هل تريد تغيير لغة شاشة التلفاز إلى العربية؟';

  @override
  String get tvLangArAskBody =>
      'قالب Arabic Art هو الأنسب لشاشة تلفاز باللغة العربية. يمكنك إعادتها من لغة شاشة التلفاز.';

  @override
  String get tvLangArAskYes => 'نعم';

  @override
  String get tvLangArAskNo => 'لا';

  @override
  String get liveYoutubeAskYes => 'نعم';

  @override
  String get liveYoutubeChoiceFailed =>
      'تعذر حفظ اختيار YouTube. حاول مرة أخرى.';

  @override
  String get liveYoutubeRevoked => 'يجب ربط YouTube من جديد';

  @override
  String get liveDestOnPlain => '⁨YouTube⁩: نعم';

  @override
  String get liveDestLink => 'ربط';

  @override
  String get liveDestLive2 => 'إلى شاشة المصلى وYouTube';

  @override
  String get liveDestLive1 => 'إلى شاشة المصلى فقط';

  @override
  String get liveDestRec => 'التسجيل: نعم';

  @override
  String get liveDestRecOff => 'التسجيل: لا';

  @override
  String get liveDestShortKiosk => 'الشاشة';

  @override
  String get liveDestShortYoutube => 'YouTube';

  @override
  String get liveDestShortRecording => 'تسجيل';

  @override
  String get liveDestSheetTitle => 'وجهات البث';

  @override
  String get liveDestTapHint => 'اضغط للتفاصيل.';

  @override
  String get liveSignInOpenGoogle => 'افتح صفحة Google';

  @override
  String liveSignInWaitingMin(int minutes) {
    return 'في انتظار التأكيد… (تنتهي خلال $minutes د)';
  }

  @override
  String get liveSignInDenied => 'تم إلغاء تسجيل الدخول';

  @override
  String get liveSignInExpired => 'انتهت صلاحية الرمز. حاول مرة أخرى.';

  @override
  String get liveSignInRevoked =>
      'تم سحب صلاحية الوصول إلى YouTube أو انتهت. يرجى تسجيل الدخول مرة أخرى.';

  @override
  String get liveSignOutChange => 'تغيير القناة / تسجيل الخروج';

  @override
  String get liveSignOutConfirmTitle => 'تغيير القناة أو تسجيل الخروج؟';

  @override
  String get liveSignOutConfirmBody =>
      'لن يصل البث المباشر القادم إلى YouTube حتى يسجّل أحدهم الدخول مرة أخرى.';

  @override
  String get liveSignOutConfirmAction => 'تسجيل الخروج';

  @override
  String liveSettingsSummaryConnected(String channel, String camera) {
    return 'تم ربط YouTube: $channel. الكاميرا الخارجية $camera';
  }

  @override
  String get liveRecordingsPending => 'تسجيلات لم تُحفظ بعد';

  @override
  String liveRecordingsPendingBody(int n) {
    return '$n أجزاء من بث سابق ما زالت في هذا الجهاز.';
  }

  @override
  String get liveBoxUnreachable =>
      'تعذّر الاتصال بـ MAXCOM. لا يمكن بدء البث إلى شاشة المصلى.';

  @override
  String get liveMediaPortsBlocked =>
      'منافذ الوسائط محظورة بواسطة جدار حماية حاسوب MAXCOM. لا يصل الفيديو إلى الكشك ولا إلى YouTube. شغّل التثبيت بصفة مسؤول.';

  @override
  String get liveNoVideo =>
      'لم يصل الفيديو إلى MAXCOM بعد. تأكد من أن Wi-Fi الهاتف وحاسوب MAXCOM على الشبكة نفسها.';

  @override
  String liveBusy(String device) {
    return 'البث جارٍ من $device';
  }

  @override
  String get appLockTitle => 'قفل التطبيق';

  @override
  String get appLockOffLine => 'قفل التطبيق متوقف';

  @override
  String get appLockOffHint =>
      'يستطيع أي شخص يحمل هذا الجهاز فتح MAXCOM. يمكن للمسؤول تفعيل القفل من الإعدادات.';

  @override
  String get appLockEnrolHint =>
      'أوقف المسؤول قفل التطبيق. يفتح هذا الجهاز MAXCOM بلا رمز PIN.';

  @override
  String get appLockOnTitle => 'تفعيل قفل التطبيق؟';

  @override
  String get appLockOnBody => 'سيُطلب من كل مستخدم تحديد رمز PIN.';

  @override
  String get appLockOnConfirm => 'تفعيل';

  @override
  String get appLockStatusOn => 'مفعّل';

  @override
  String get appLockStatusOff => 'متوقف';

  @override
  String get enrolDoneHintNoLock =>
      'في المرة القادمة، افتح هذا التطبيق وسيفتح مباشرة بلا رمز PIN.';

  @override
  String get unlockAuto => 'جارٍ فتح القفل';

  @override
  String get unlockAutoUnreachable => 'تعذّر الاتصال بـ MAXCOM';

  @override
  String get unlockPinMissing => 'رمز PIN مطلوب';

  @override
  String get unlockPinRequiredByAdmin =>
      'فعّل المسؤول قفل التطبيق. اختر 6 أرقام جديدة.';

  @override
  String get auditKeyAppLock => 'قفل التطبيق';

  @override
  String get syncSynced => 'تمت المزامنة';

  @override
  String syncSyncedAt(String time) {
    return 'تمت المزامنة $time';
  }

  @override
  String syncPending(int n) {
    return '$n تغييرات بالانتظار';
  }

  @override
  String syncPendingShort(int n) {
    return '$n بالانتظار';
  }

  @override
  String get syncWakingShort => 'جارٍ الاتصال...';

  @override
  String get syncOffline => 'دون اتصال، ستتم المزامنة لاحقًا';

  @override
  String get syncOfflineShort => 'دون اتصال';

  @override
  String get syncWaking => 'جارٍ الاتصال بالسحابة...';

  @override
  String get syncRunning => 'جارٍ المزامنة';

  @override
  String get syncViaCloud => 'عبر السحابة';

  @override
  String get syncViaBox => 'عبر MAXCOM في المصلى';

  @override
  String syncConflicts(int n) {
    return 'التعارضات: $n';
  }

  @override
  String get linkCloudConnected => 'سحابة MAXCOM: متصلة';

  @override
  String get linkCloudConnecting => 'سحابة MAXCOM: جارٍ الاتصال';

  @override
  String get linkCloudSyncing => 'سحابة MAXCOM: ترسل التغييرات';

  @override
  String get linkCloudDisconnected => 'سحابة MAXCOM: غير متصلة';

  @override
  String get linkBoxConnected => 'MAXCOM في المصلى: متصل';

  @override
  String get linkBoxConnecting => 'MAXCOM في المصلى: جارٍ الاتصال';

  @override
  String get linkBoxSyncing => 'MAXCOM في المصلى: يرسل التغييرات';

  @override
  String get linkBoxDisconnected => 'MAXCOM في المصلى: تعذّر الاتصال';

  @override
  String get syncNow => 'زامن الآن';

  @override
  String get syncSheetTitle => 'المزامنة';

  @override
  String get syncConnection => 'الاتصال';

  @override
  String get syncNoConnection => 'لا يوجد اتصال';

  @override
  String get syncLastSync => 'آخر مزامنة';

  @override
  String get syncNever => 'لم تتم قط';

  @override
  String get syncWaitingLabel => 'تغييرات بالانتظار';

  @override
  String get syncErrorLabel => 'خطأ';

  @override
  String get syncErrUnreachable => 'تعذّر الاتصال بـ MAXCOM وبالسحابة';

  @override
  String get syncCloudUnreachable => 'تعذّر الاتصال بالسحابة';

  @override
  String get syncErrNeedsUnlock => 'افتح القفل من جديد للمزامنة';

  @override
  String get syncErrFailed => 'لم تنجح المزامنة. ستتم إعادة المحاولة.';

  @override
  String get syncDeviceRevoked => 'تم إلغاء هذا الجهاز';

  @override
  String get syncDeviceRevokedHint =>
      'ألغى المسؤول هذا الجهاز. حُذفت النسخة المحلية. سجّله من جديد برمز QR جديد من المسؤول.';

  @override
  String get syncSeeConflicts => 'عرض التعارضات';

  @override
  String get syncOfflineHelp =>
      'تُحفظ تغييراتك في هذا الجهاز وتُرسَل عند توفر الاتصال.';

  @override
  String get conflictsTitle => 'التعارضات';

  @override
  String get conflictsIntro =>
      'التغييرات أدناه لم تُطبَّق. استخدم نسختك من جديد، أو احذفها.';

  @override
  String conflictMine(String time) {
    return 'تغييرك في $time';
  }

  @override
  String conflictWinner(String name, String time) {
    return 'الفائز: $name في $time';
  }

  @override
  String get conflictSomeoneElse => 'مستخدم آخر';

  @override
  String get conflictRefusedForbidden => 'مرفوض: لا توجد صلاحية';

  @override
  String get conflictRefusedLiveOnly => 'مرفوض: يتطلب اتصالًا';

  @override
  String get conflictRefusedTooLarge => 'مرفوض: الملف كبير جدًا';

  @override
  String get conflictRefusedInvalid => 'مرفوض: بيانات غير صالحة';

  @override
  String get conflictRefusedOther => 'رفضه الخادم';

  @override
  String get conflictReapply => 'استخدم نسختي من جديد';

  @override
  String get conflictDiscard => 'حذف';

  @override
  String get conflictReapplied => 'أُعيد إرسال نسختك';

  @override
  String get conflictDeleted => 'لقد حذفت هذا العنصر';

  @override
  String get conflictEntitySettings => 'الإعدادات';

  @override
  String get conflictEntityUser => 'المستخدم';

  @override
  String get conflictEntityAsset => 'الصورة';

  @override
  String get conflictEntityDevice => 'الجهاز';

  @override
  String get conflictsEmpty => 'لا توجد تعارضات';

  @override
  String get conflictsEmptyHint => 'تم قبول جميع تغييراتك.';

  @override
  String get liveOnlyTitle => 'يتطلب اتصالًا';

  @override
  String liveOnlyBody(String action) {
    return 'يحتاج هذا الإجراء إلى اتصال بـ MAXCOM في المصلى أو بالسحابة: $action. أعد المحاولة عند توفر الشبكة.';
  }

  @override
  String get liveOnlyNeedsConnection => 'يتطلب اتصالًا بـ MAXCOM أو بالسحابة';

  @override
  String get liveOnlyOk => 'فهمت';

  @override
  String get assetTooLarge => 'الصورة كبيرة جدًا. اختر صورة أصغر.';

  @override
  String get syncSettingsTitle => 'مزامنة السحابة';

  @override
  String get syncSettingsEnabled => 'تفعيل مزامنة السحابة';

  @override
  String get syncSettingsUrl => 'عنوان السحابة';

  @override
  String get syncSettingsUrlHint => 'مثال: https://api.surau.my';

  @override
  String get syncSettingsUrlHttps => 'يجب أن يبدأ عنوان السحابة بـ https://';

  @override
  String get syncSettingsStatus => 'الحالة';

  @override
  String get syncSettingsLinked => 'مرتبط بالسحابة';

  @override
  String get syncYes => 'نعم';

  @override
  String get syncNo => 'لا';

  @override
  String get syncSettingsLastPush => 'آخر إرسال';

  @override
  String get syncSettingsLastPull => 'آخر استقبال';

  @override
  String get syncSettingsNone => 'لا شيء';

  @override
  String get syncSettingsStatusUnavailable =>
      'تعذّرت قراءة حالة المزامنة الآن.';

  @override
  String get syncSettingsHelp =>
      'يرسل MAXCOM في المصلى التغييرات إلى السحابة عند توفر الإنترنت، ويفحص التغييرات القادمة من السحابة كل دقيقتين. تصل التغييرات من المنزل إلى شاشة المصلى خلال دقائق.';

  @override
  String get syncSettingsLinkNote => 'ينشئ مسؤول النظام الربط في MAXCOM.';

  @override
  String get syncSettingsRunDone => 'اكتملت المزامنة';

  @override
  String get devicesEnrolNew => 'تسجيل جهاز جديد';

  @override
  String get devicesEnrolPick => 'لمن هذا الجهاز؟';

  @override
  String get devicesEnrolViaCloud =>
      'أنت خارج شبكة المصلى. لا يمكن إنشاء رمز QR إلا على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get navUpload => 'الرفع إلى YouTube';

  @override
  String get uploadTitle => 'الرفع إلى YouTube';

  @override
  String get uploadIntro =>
      'تُرسَل تسجيلات الدروس من هذا الجهاز مباشرة إلى قناة YouTube الخاصة بالمصلى، وتُستأنف تلقائيًا عند الانقطاع.';

  @override
  String uploadQuotaLine(int n, int limit) {
    return '$n من $limit عمليات رفع اليوم';
  }

  @override
  String uploadPart(int i, int n, int pct) {
    return 'الجزء $i من $n: $pct%';
  }

  @override
  String uploadPartName(int i, int n) {
    return 'الجزء $i من $n';
  }

  @override
  String uploadWhole(int pct) {
    return 'التسجيل الكامل: $pct%';
  }

  @override
  String get uploadWholeName => 'التسجيل الكامل';

  @override
  String get uploadWaitWifi => 'بانتظار Wi-Fi';

  @override
  String get uploadWaitNetwork => 'بانتظار الشبكة';

  @override
  String uploadQuota(String time) {
    return 'تم بلوغ حد الرفع إلى YouTube لهذا اليوم. أعد المحاولة بعد $time';
  }

  @override
  String uploadQuotaShort(String time) {
    return 'حد الحصة: أعد المحاولة بعد $time';
  }

  @override
  String get uploadQueued => 'في قائمة الانتظار';

  @override
  String get uploadJoining => 'جارٍ دمج التسجيل';

  @override
  String get uploadBeginning => 'جارٍ تجهيز الرفع';

  @override
  String get uploadPaused => 'متوقف مؤقتًا';

  @override
  String get uploadFailed => 'توقف الرفع';

  @override
  String get uploadDone => 'اكتمل';

  @override
  String get uploadWatch => 'المشاهدة على YouTube';

  @override
  String get uploadPause => 'إيقاف مؤقت';

  @override
  String get uploadResume => 'استئناف';

  @override
  String get uploadRetry => 'إعادة المحاولة';

  @override
  String get uploadAllowMobile => 'استخدام بيانات الجوال';

  @override
  String uploadFileSize(int mb) {
    return 'حجم هذا الملف $mb MB';
  }

  @override
  String get uploadRemove => 'إزالة من القائمة';

  @override
  String uploadDeleteOn(String date) {
    return 'سيُحذف من الجهاز في $date';
  }

  @override
  String get uploadDeleted => 'تم حذفه من الجهاز';

  @override
  String liveCleanupAfterDays(int days) {
    return 'سيُحذف التسجيل بعد $days يومًا لأن YouTube استقبل البث كاملًا';
  }

  @override
  String get liveCleanupNow =>
      'سيُحذف التسجيل فور أن يؤكد YouTube استلام البث كاملًا';

  @override
  String get uploadRemoveConfirm => 'يبقى التسجيل في الجهاز. إزالة هذه المهمة؟';

  @override
  String get uploadRemoveAction => 'إزالة';

  @override
  String get uploadKeepOpenWeb =>
      'أبقِ MAXCOM مفتوحًا أثناء الرفع (قيد في Safari).';

  @override
  String get uploadBackgroundAndroid => 'يستمر الرفع في الخلفية.';

  @override
  String get uploadReplaceLive => 'استبدال البث المنقطع';

  @override
  String get uploadKeepBoth => 'الاحتفاظ بالاثنين';

  @override
  String get uploadReplaceNote => 'سيصبح البث الأصلي خاصًا بعد اكتمال الرفع';

  @override
  String get uploadReplaceAsk => 'كان بث YouTube السابق ناقصًا';

  @override
  String get uploadReplaceAskBody =>
      'سيُرفع التسجيل الكامل كفيديو جديد. يمكن بعد ذلك جعل البث المنقطع خاصًا، أو الاحتفاظ بالاثنين معًا.';

  @override
  String get uploadFromSummary => 'رفع التسجيل الكامل إلى YouTube';

  @override
  String get uploadFromSummaryHint =>
      'لم يستقبل YouTube هذا البث كاملًا. يمكن الآن إرسال التسجيل الموجود في هذا الجهاز.';

  @override
  String get uploadJoinFailed => 'تُرفع ملفات التسجيل واحدًا تلو الآخر';

  @override
  String get uploadNoKuliah => 'بث بلا درس';

  @override
  String get uploadEmpty => 'لا توجد عمليات رفع';

  @override
  String get uploadEmptyHint =>
      'إذا انقطع البث إلى YouTube أو لم يتوفر إنترنت، يمكن إرسال تسجيل الدرس من هنا بعد انتهاء البث.';

  @override
  String get liveCloudUnreachable => '⁨YouTube⁩: تعذّر الاتصال بالسحابة';

  @override
  String get uploadErrorNoCloud =>
      'تعذّر الاتصال بالسحابة. يبدأ الرفع تلقائيًا عند توفر الاتصال بالسحابة.';

  @override
  String get uploadErrorNoBox =>
      'يبدأ الرفع تلقائيًا عندما يكون الهاتف على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get uploadErrorUnlock => 'افتح MAXCOM وافتح قفله لمتابعة الرفع.';

  @override
  String get uploadErrorReauth =>
      'يجب على المسؤول تجديد تسجيل دخول YouTube الخاص بالمصلى.';

  @override
  String get uploadErrorOther => 'توقف الرفع. اضغط إعادة المحاولة للمتابعة.';

  @override
  String get uploadKeepBothNote =>
      'يبقى البث الأصلي على YouTube مع الفيديو الجديد';

  @override
  String get uploadSending => 'جارٍ الرفع';

  @override
  String settingsCharMeter(int n, int max) {
    return '$n / $max حرفًا';
  }

  @override
  String get settingsTitleTooLong => 'طويل جدًا لـ YouTube، وسيُقتطع';

  @override
  String get settingsTapToAdd => 'اضغط للإضافة:';

  @override
  String get settingsTemplatePreview => 'معاينة، درس هذه الليلة';

  @override
  String settingsUnknownPlaceholder(String list) {
    return 'علامة غير معروفة: $list';
  }

  @override
  String get settingsPresetHelp => 'اختر واحدًا أو اكتب بنفسك.';

  @override
  String get settingsTestConnection => 'تجربة الاتصال';

  @override
  String get settingsTestChecking => 'جارٍ الفحص...';

  @override
  String settingsTestOk(int ms) {
    return 'نجح: $ms ms';
  }

  @override
  String get settingsTestBlocked => 'هذا العنوان غير مسموح به';

  @override
  String get settingsTestTimeout => 'لا توجد استجابة خلال 5 ثوانٍ';

  @override
  String get settingsTestBadUrl => 'العنوان غير صالح';

  @override
  String settingsTestStatus(int status) {
    return 'فشل، الحالة $status';
  }

  @override
  String get settingsTestError => 'تعذّر الفحص الآن';

  @override
  String get settingsLanjutan => 'متقدم';

  @override
  String get settingsLanjutanDimmed => 'غير مستخدم عند اختيار الهاتف مباشرة';

  @override
  String get settingsReencodeUnsupported =>
      'إعادة الترميز غير مدعومة على هذا الصندوق. استخدم النسخ المباشر.';

  @override
  String get settingsComingSoon => 'متوفر في إصدار قادم';

  @override
  String get settingsHexLabel => 'رمز اللون (hex)';

  @override
  String get settingsHexHelp => 'مثال: #F6E7B8';

  @override
  String get settingsColourAutoHelp =>
      'تلقائي: يختار MAXCOM الأبيض أو الداكن حسب سطوع كل صورة خلفية.';

  @override
  String get settingsColourFixedHelp =>
      'يُطبَّق هذا اللون على جميع صور الخلفية.';

  @override
  String get settingsColourPreview => 'معاينة فوق صورة الخلفية';

  @override
  String get swatchAuto => 'تلقائي';

  @override
  String get swatchWhite => 'أبيض';

  @override
  String get swatchCream => 'كريمي';

  @override
  String get swatchGold => 'ذهبي';

  @override
  String get swatchGreen => 'أخضر';

  @override
  String get swatchBlack => 'أسود';

  @override
  String get swatchOther => 'آخر';

  @override
  String get settingsAudioNone => 'لا يوجد ملف';

  @override
  String get settingsAudioNoneHint => 'لا يُشغَّل الأذان الأول';

  @override
  String settingsAudioItem(int n) {
    return 'الملف الصوتي $n';
  }

  @override
  String get settingsAudioUpload => 'رفع ملف صوتي';

  @override
  String get settingsAudioUploading => 'جارٍ الرفع...';

  @override
  String get settingsAudioUploaded => 'تم رفع الملف الصوتي';

  @override
  String get settingsAudioWebOnly => 'ارفع ملف MP3 عبر MAXCOM في المتصفح.';

  @override
  String get settingsAudioUnavailable =>
      'تعذّرت قراءة قائمة الملفات الصوتية الآن.';

  @override
  String get settingsAudioNotMp3 =>
      'يجب أن يكون الملف MP3 وبحجم لا يتجاوز 20 MB.';

  @override
  String get settingsSurahSearch => 'ابحث عن سورة';

  @override
  String settingsAyatCount(int n) {
    return '$n آية';
  }

  @override
  String settingsAyatHelp(String name, int n) {
    return 'في $name $n آية. بحد أقصى 3 آيات في العرض الواحد.';
  }

  @override
  String get settingsAyatCountLabel => 'عدد الآيات';

  @override
  String settingsAyatSurahEnds(int n) {
    return 'تنتهي هذه السورة عند الآية $n.';
  }

  @override
  String settingsAyatTv(String name, int n, int a, int b) {
    return 'يُعرض على التلفاز: سورة $name ($n): الآيات $a إلى $b';
  }

  @override
  String settingsAyatTvOne(String name, int n, int a) {
    return 'يُعرض على التلفاز: سورة $name ($n): الآية $a';
  }

  @override
  String settingsAyatTypeHint(int n) {
    return 'اكتب رقم الآية (من 1 إلى $n)';
  }

  @override
  String settingsAyatTypeError(int n) {
    return 'أدخل رقمًا بين 1 و$n';
  }

  @override
  String get settingsAyatOldRange => 'تم تقصير النطاق القديم إلى 3 آيات.';

  @override
  String settingsHijriMonthN(int n) {
    return 'الشهر $n';
  }

  @override
  String get settingsReciterFolder => 'اسم مجلد EveryAyah';

  @override
  String get settingsReciterFolderHelp =>
      'مثال: Muhammad_Ayyoub_128kbps. تحقق منه بزر تجربة الاتصال قبل الحفظ.';

  @override
  String get settingsPickerNoMatch => 'لا توجد نتائج مطابقة';

  @override
  String get settingsSearchHint => 'ابحث عن إعداد، مثال: الأذان';

  @override
  String settingsWhyGroup(String name) {
    return 'المجموعة: $name';
  }

  @override
  String settingsWhyField(String name) {
    return 'الحقل: $name';
  }

  @override
  String settingsWhyChoice(String name) {
    return 'الخيار: $name';
  }

  @override
  String settingsWhyKeyword(String name) {
    return 'كلمة مفتاحية: $name';
  }

  @override
  String settingsSearchFound(int n) {
    return '$n إعدادات مطابقة. تُفتح المجموعات المطابقة تلقائيًا.';
  }

  @override
  String settingsGroupCount(int n, int on) {
    return '$n ميزات، $on مفعّلة';
  }

  @override
  String settingsGroupMatches(int n) {
    return '$n نتائج مطابقة';
  }

  @override
  String get settingsLanjutanSubtitle =>
      'إعدادات نظام MAXCOM، مخفية عن مسؤول المصلى';

  @override
  String get settingsNoResults => 'لا توجد نتائج';

  @override
  String settingsNoResultsBody(String q) {
    return 'لا توجد إعدادات تطابق \"$q\". جرّب كلمة أخرى، مثال: الأذان أو الإقامة أو اللون أو YouTube.';
  }

  @override
  String get settingsClearSearch => 'مسح البحث';

  @override
  String get settingsSavedShort => 'تم الحفظ';

  @override
  String get settingsOrderRow => 'ترتيب البطاقات على شاشة التلفاز';

  @override
  String settingsOrderRowHint(int n) {
    return 'اسحب لتغيير دور $n بطاقات.';
  }

  @override
  String get settingsOrderIntro =>
      'اسحب البطاقات لتغيير دورها على شاشة التلفاز. تُتجاوز البطاقات المتوقفة.';

  @override
  String settingsOrderSeconds(int n) {
    return '$n ثانية';
  }

  @override
  String get settingsOrderOff => 'متوقفة';

  @override
  String get settingsOrderVideoLength => 'بطول الفيديو';

  @override
  String get settingsOrderUp => 'أعلى';

  @override
  String get settingsOrderDown => 'أسفل';

  @override
  String get settingsOrderSaved => 'تم حفظ الترتيب';

  @override
  String get settingsOrderRestore => 'استعادة الترتيب الأصلي';

  @override
  String get settingsOrderRestored => 'تمت استعادة الترتيب الأصلي';

  @override
  String get settingsDeviceLockSection => 'هذا الجهاز';

  @override
  String get settingsDeviceLockTitle => 'قفل هذا الجهاز';

  @override
  String get settingsDeviceLockBody =>
      'لا يمكن إيقافه. يستطيع حساب مسؤول MAXCOM تغيير إعدادات النظام، لذلك يلزم دائمًا رمز PIN أو بصمة الإصبع عند فتح MAXCOM في هذا الجهاز. لا يتأثر المستخدمون الآخرون.';

  @override
  String get syncSettingsUrlFixed => 'يُحدَّد عند ربط MAXCOM بالسحابة';

  @override
  String get enrolTtlLabel => 'مدة صلاحية الرمز';

  @override
  String get enrolTtlHelp =>
      'الافتراضي 10 دقائق. اختر مدة أطول إذا لم يكن الجهاز بيدك بعد، مثل إرساله إلى عضو لجنة لم يصل بعد.';

  @override
  String enrolTtlMinutes(int n) {
    return '$n دقيقة';
  }

  @override
  String get startNotJoined => 'لم ينضم هذا الهاتف إلى أي مصلى بعد';

  @override
  String get startSetupHint =>
      'إذا كان MAXCOM هذا جديدًا، فامسح رمز QR الخاص بالإعداد على شاشة التلفاز.';

  @override
  String get startJoinHint => 'إذا تمت دعوتك، فامسح رمز QR الذي يعرضه المسؤول.';

  @override
  String get scanButton => 'مسح رمز QR';

  @override
  String get scanUnknown => 'رمز QR غير معروف';

  @override
  String get setupFoundTitle => 'تم العثور على MAXCOM';

  @override
  String get setupFoundHint =>
      'لم يُعدّ MAXCOM هذا بعد. يصبح أول هاتف يعدّه مسؤول المصلى.';

  @override
  String get setupNotSetUp => 'لم يُعدّ بعد';

  @override
  String get setupSurauName => 'اسم المصلى';

  @override
  String get setupYourName => 'اسمك';

  @override
  String get setupYourNameHint => 'مثال: الحاج علي';

  @override
  String get setupPhoneName => 'اسم هذا الهاتف';

  @override
  String get setupBoxName => 'اسم MAXCOM هذا';

  @override
  String get setupBoxNameHint => 'مثال: MAXCOM القاعة الرئيسية';

  @override
  String get setupFieldRequired => 'هذا الحقل مطلوب';

  @override
  String get setupConfirmTitle => 'راجع قبل الإعداد';

  @override
  String get setupConfirmHint =>
      'تأكد من صحة اسم المصلى. يمكنك تغييره لاحقًا في الإعدادات.';

  @override
  String get setupFingerprintHint =>
      'يجب أن تطابق البصمة الموجودة تحت رمز QR على شاشة التلفاز';

  @override
  String get setupFingerprintLabel => 'البصمة';

  @override
  String get setupIdLabel => 'معرّف MAXCOM';

  @override
  String get setupOnlyFirst =>
      'أول هاتف فقط يستطيع إعداد MAXCOM هذا. ينضم الآخرون برمز من المسؤول.';

  @override
  String get setupSubmit => 'إعداد MAXCOM';

  @override
  String get setupAlreadyDone => 'تم إعداد المصلى بالفعل';

  @override
  String get setupMismatch =>
      'البصمة غير متطابقة. تأكد من أنك تمسح شاشة MAXCOM الصحيحة';

  @override
  String get setupCodeInvalid =>
      'انتهت صلاحية رمز QR أو استُخدم بالفعل. امسح الرمز الجديد على شاشة التلفاز.';

  @override
  String get setupExpired =>
      'انتهت صلاحية رمز QR. امسح الرمز الجديد على شاشة التلفاز.';

  @override
  String setupRetryAfter(int minutes) {
    return 'محاولات كثيرة جدًا. أعد المحاولة بعد $minutes دقيقة.';
  }

  @override
  String get recoveryCodeTitle => 'رمز الاسترداد الخاص بك';

  @override
  String get recoveryCodeOnce => 'يُعرض هذا الرمز مرة واحدة فقط';

  @override
  String get recoveryCodePaper => 'اكتب هذا الرمز على ورقة واحفظه في مكان آمن.';

  @override
  String get recoveryCodeWhy =>
      'إذا فقد جميع المسؤولين هواتفهم، فيتيح هذا الرمز تعيين مسؤول جديد.';

  @override
  String get recoveryCodeNoShare =>
      'لا ترسله عبر WhatsApp ولا تلتقط صورة للشاشة.';

  @override
  String get recoveryCodeNoShotWeb =>
      'لا تستطيع هذه الشاشة منع التقاط الصور. لا تصوّرها.';

  @override
  String get recoveryCodeWritten => 'كتبت هذا الرمز على ورقة';

  @override
  String setupDoneTitle(String surau) {
    return '$surau جاهز';
  }

  @override
  String get setupDoneHint => 'الخطوات التالية';

  @override
  String get setupNextEnrol => 'تسجيل هاتف عضو لجنة آخر';

  @override
  String get setupNextPair => 'إقران شاشة تلفاز إضافية';

  @override
  String get setupNextLink => 'الربط بسحابة MAXCOM';

  @override
  String get setupToDashboard => 'إلى لوحة التحكم';

  @override
  String get probeOk => 'نجح الاتصال بـ MAXCOM';

  @override
  String get recoveryFoundTitle => 'MAXCOM في وضع الاسترداد';

  @override
  String get recoveryFoundHint =>
      'ليس لدى MAXCOM هذا مسؤول يستطيع الدخول. أدخل رمز الاسترداد المكتوب على الورقة.';

  @override
  String get recoveryLinkedHint =>
      'MAXCOM هذا مرتبط بالسحابة. يستطيع مسؤول MAXCOM أيضًا الموافقة على مسؤول جديد من السحابة (قريبًا).';

  @override
  String get recoveryCodeField => 'رمز الاسترداد';

  @override
  String get recoveryCodeFieldHint => '16 حرفًا، مثال ABCD-EFGH-JKLM-NPQR';

  @override
  String get recoveryCodeShort => 'رمز الاسترداد مكوّن من 16 حرفًا';

  @override
  String get recoveryBadCode =>
      'رمز الاسترداد خاطئ. يجب مسح رمز QR على التلفاز من جديد';

  @override
  String get recoveryNotInRecovery => 'لدى MAXCOM هذا مسؤول نشط بالفعل';

  @override
  String get recoverySubmit => 'الاسترداد بصفة مسؤول';

  @override
  String get recoveryDoneTitle => 'أنت مسؤول المصلى';

  @override
  String joinTitle(String surau) {
    return 'الانضمام إلى $surau؟';
  }

  @override
  String joinGreeting(String name) {
    return 'السلام عليكم، $name';
  }

  @override
  String joinInvitedBy(String name) {
    return 'دعاك $name';
  }

  @override
  String joinValidUntil(String time) {
    return 'الدعوة صالحة حتى $time';
  }

  @override
  String get joinBoxFingerprintHint =>
      'قارنها بالبصمة على شاشة المسؤول الذي أعطاك الرمز';

  @override
  String get joinYes => 'نعم، الانضمام إلى هذا المصلى';

  @override
  String get joinNo => 'ليس مصلاي';

  @override
  String get errCodeExpired => 'انتهت صلاحية الرمز';

  @override
  String errCodeExpiredBody(String time) {
    return 'انتهت صلاحية هذا الرمز في $time. اطلب رمزًا جديدًا من المسؤول.';
  }

  @override
  String get errScanAnother => 'مسح رمز آخر';

  @override
  String get errCodeUsed => 'استُخدم الرمز بالفعل';

  @override
  String get errCodeUsedBody =>
      'استُخدم هذا الرمز بالفعل. إذا لم تكن أنت من استخدمه، فأبلغ المسؤول.';

  @override
  String get errOtherSurau => 'انضم هذا الهاتف بالفعل إلى مصلى آخر';

  @override
  String errOtherSurauBody(String surau) {
    return 'هذا الهاتف مسجّل بالفعل لدى $surau. اخرج منه أولًا.';
  }

  @override
  String errLeaveFirst(String surau) {
    return 'الخروج من $surau';
  }

  @override
  String get errCodeMayExpire =>
      'قد تنتهي صلاحية الرمز الجديد أثناء خروجك. اطلب رمزًا جديدًا عند الحاجة.';

  @override
  String get errUnreachableTitle => 'تعذّر الاتصال بـ MAXCOM';

  @override
  String get errUnreachableBody =>
      'لا يصل الهاتف إلى MAXCOM هذا. جرّب الخطوات التالية.';

  @override
  String get errTryFirst1 =>
      'تأكد من أن الهاتف على شبكة Wi-Fi الرئيسية للمصلى، لا شبكة الضيوف.';

  @override
  String get errTryFirst2 => 'تأكد من أن شاشة تلفاز MAXCOM مضاءة وتعرض الرمز.';

  @override
  String get errTryFirst3 => 'أوقف بيانات الجوال قليلًا ثم أعد المحاولة.';

  @override
  String get errRelaySoon => 'التسجيل عبر سحابة MAXCOM: قريبًا';

  @override
  String get errNoCloud =>
      'هذا المصلى غير مرتبط بسحابة MAXCOM بعد، لذلك لا يمكن التسجيل إلا عبر Wi-Fi المصلى.';

  @override
  String get errRetry => 'إعادة المحاولة';

  @override
  String get errMismatch =>
      'البصمة غير متطابقة. تأكد من أنك تمسح شاشة MAXCOM الصحيحة';

  @override
  String devicesBoxRow(String id) {
    return 'MAXCOM · $id';
  }

  @override
  String get devicesBoxRowHint =>
      'الشاشة الرئيسية في المصلى. موجودة دائما ولا يمكن حذفها.';

  @override
  String get devicesAwayBanner =>
      'أنت خارج شبكة المصلى. تصل التغييرات إلى MAXCOM عند المزامنة التالية.';

  @override
  String get devicesNeedLan => 'يتطلب شبكة المصلى';

  @override
  String get devicesNeedLanBody =>
      'يجب إقران شاشة التلفاز على شبكة Wi-Fi الخاصة بالمصلى. اتصل بـ Wi-Fi المصلى أولًا.';

  @override
  String devicesPairedMirrors(String screen, String box) {
    return 'تم إقران الشاشة $screen. وهي تعكس الآن $box.';
  }

  @override
  String get leaveTitle => 'الخروج من المصلى';

  @override
  String leaveBody(String surau) {
    return 'سيُزال هذا الهاتف من $surau. يُحذف المفتاح والبيانات من هذا الهاتف. تحتاج إلى رمز QR جديد للانضمام من جديد.';
  }

  @override
  String leaveUnsynced(int n) {
    return '$n تغييرات لم تتم مزامنتها';
  }

  @override
  String get leaveSyncFirst => 'زامن الآن';

  @override
  String get leaveConfirm => 'خروج';

  @override
  String get leaveLastAdminTitle => 'هذا الهاتف هو جهاز المسؤول الوحيد';

  @override
  String get leaveLastAdminBody =>
      'سجّل جهاز مسؤول آخر أولًا، حتى لا يبقى المصلى بلا مسؤول.';

  @override
  String get leaveEnrolOther => 'تسجيل جهاز مسؤول آخر';

  @override
  String get leaveOfflineBody =>
      'تعذّر الاتصال بـ MAXCOM. يبقى هذا الجهاز نشطًا في MAXCOM حتى يلغيه المسؤول.';

  @override
  String get leaveForgetOnly => 'نسيان هذا الجهاز فقط';

  @override
  String get leftTitle => 'لقد خرجت';

  @override
  String leftBody(String surau) {
    return 'لم يعد هذا الهاتف منضمًا إلى $surau.';
  }

  @override
  String get leftJoinOther => 'الانضمام إلى مصلى آخر';

  @override
  String get scanEntry => 'مسح رمز QR';

  @override
  String get scanEntryHint => 'لرمز الإعداد أو الاسترداد أو التسجيل';

  @override
  String get netCheckEntry => 'فحص الشبكة';

  @override
  String get netCheckTitle => 'فحص الشبكة';

  @override
  String get netBoxReachable => 'يمكن الاتصال بـ MAXCOM';

  @override
  String get netBoxDown => 'تعذّر الاتصال بـ MAXCOM';

  @override
  String get netCloudReachable => 'يمكن الاتصال بسحابة MAXCOM';

  @override
  String get netCloudDown => 'تعذّر الاتصال بسحابة MAXCOM';

  @override
  String get netCloudNone => 'غير مرتبط بالسحابة';

  @override
  String netLastSync(String when) {
    return 'تمت المزامنة $when';
  }

  @override
  String get netNeverSynced => 'لم تتم المزامنة قط';

  @override
  String get rotateRecoveryTitle => 'رمز استرداد جديد';

  @override
  String get rotateRecoveryBody =>
      'ينتهي الرمز القديم فورًا. يُعرض الرمز الجديد مرة واحدة فقط.';

  @override
  String get rotateRecoveryConfirm => 'إنشاء رمز جديد';

  @override
  String codeUsedAt(String time) {
    return 'استُخدم $time';
  }

  @override
  String codeReuseAttempts(int n) {
    return 'حاول استخدامه $n مرات';
  }

  @override
  String enrolQrFingerprint(String fp) {
    return 'بصمة MAXCOM: $fp';
  }

  @override
  String get setupNotConfirmed =>
      'لم يصل رد MAXCOM. ربما اكتمل الإعداد. اضغط إعادة المحاولة لإرسال الطلب نفسه.';

  @override
  String get recoveryNotConfirmed =>
      'لم يصل رد MAXCOM. ربما اكتمل الاسترداد. اضغط إعادة المحاولة لإرسال الطلب نفسه.';

  @override
  String get usersNoRecoveryWarning =>
      'ليس لدى MAXCOM هذا رمز استرداد بعد. إذا فُقدت جميع هواتف المسؤولين، فلا توجد طريقة للدخول من جديد. اضغط رمز استرداد جديد واحفظ الرمز في مكان آمن.';

  @override
  String get fingerprintCompare =>
      'تأكد من أن هذا الرمز يطابق الرمز على شاشة التلفاز';

  @override
  String get fingerprintSame => 'متطابق، متابعة';

  @override
  String get fingerprintDifferent => 'غير متطابق، إلغاء';

  @override
  String get scanOnlyTvQr =>
      'امسح رمز QR الموجود على شاشة تلفاز MAXCOM فقط. لا تمسح رمز QR من ورقة أو صورة أو رسالة.';

  @override
  String get probeAskTitle => 'إرسال اختبار اتصال؟';

  @override
  String probeAskBody(String host) {
    return 'سيتصل هذا الهاتف بـ $host. تابع فقط إذا كان هذا العنوان هو MAXCOM الخاص بك.';
  }

  @override
  String get probeAskConfirm => 'نعم، أرسل الاختبار';

  @override
  String get recoveryBoxLocked => 'تم تعليق MAXCOM هذا';

  @override
  String get recoveryBoxLockedBody =>
      'لا يمكن إجراء الاسترداد الآن. يرجى التواصل مع مُركِّب MAXCOM.';

  @override
  String get hadisReorderNeedsConnection =>
      'إعادة الترتيب تتطلب اتصالًا بـ MAXCOM';

  @override
  String get hadisTitle => 'الأحاديث';

  @override
  String get hadisListIntro =>
      'الأحاديث المعروضة في بطاقة الحديث على التلفاز. جميعها محفوظة في MAXCOM، فيواصل التلفاز عرضها حتى دون إنترنت.';

  @override
  String get hadisNetOnlineTitle => 'MAXCOM متصل بالإنترنت.';

  @override
  String get hadisNetOnlineBody => 'يتم البحث في HadeethEnc عبر MAXCOM.';

  @override
  String get hadisNetOfflineTitle => 'لا يوجد إنترنت في MAXCOM.';

  @override
  String get hadisNetOfflineBody =>
      'تبقى الأحاديث المحفوظة معروضة على التلفاز.';

  @override
  String get hadisStatSaved => 'محفوظة في MAXCOM';

  @override
  String get hadisStatShown => 'مفعّلة على التلفاز';

  @override
  String get hadisStatProvider => 'من HadeethEnc';

  @override
  String get hadisFind => 'البحث عن حديث';

  @override
  String get hadisAddOwn => 'إضافة بنفسك';

  @override
  String get hadisFindNeedsInternet =>
      'البحث عن حديث يتطلب إنترنت عبر MAXCOM. لا تزال الإضافة بنفسك ممكنة.';

  @override
  String get hadisOrderTitle => 'الترتيب على التلفاز';

  @override
  String get hadisOrderHintSwitch =>
      'المفتاح: إظهار أو إخفاء. سلة المهملات: إزالة';

  @override
  String get hadisOrderHintSort => 'الأسهم: ترتيب. سلة المهملات: إزالة';

  @override
  String get hadisFilterAll => 'الكل';

  @override
  String get hadisFilterOwn => 'القائمة الخاصة';

  @override
  String get hadisFilterProvider => 'HadeethEnc';

  @override
  String get hadisSort => 'ترتيب';

  @override
  String get hadisSortDone => 'تم';

  @override
  String get hadisNoneFiltered => 'لا توجد أحاديث في هذا التصفية.';

  @override
  String get hadisNoneSaved =>
      'لا توجد أحاديث محفوظة بعد. اضغط البحث عن حديث أو إضافة بنفسك.';

  @override
  String get hadisListHelp =>
      'هذا الترتيب هو ترتيب الدوران على التلفاز عندما يكون المصدر كليهما. إعدادات المصدر والدوران في الإعدادات، الأحاديث. المفتاح يُخفي الحديث عن التلفاز ويبقى محفوظًا؛ الإزالة تحذفه من قائمة MAXCOM.';

  @override
  String hadisNearFull(int n, int max) {
    return 'قارب الامتلاء ($n/$max)';
  }

  @override
  String get hadisTagLong => 'طويل للتلفاز';

  @override
  String get hadisTagShort => 'قصير';

  @override
  String get hadisTagMedium => 'متوسط';

  @override
  String get hadisTagUpdated => 'تم تحديث النص';

  @override
  String get hadisTagHidden => 'متوقف';

  @override
  String get hadisTagGradeBlocked => 'مخفي: الدرجة الجديدة غير مسموح بها';

  @override
  String get hadisTagUnstated => 'المصدر غير مذكور';

  @override
  String get hadisTagPending => 'بانتظار الاتصال';

  @override
  String get hadisGradeBlocked => 'الدرجة غير مسموح بها';

  @override
  String get hadisGradeUnknown => 'الدرجة غير معروفة';

  @override
  String get hadisShowOnTv => 'العرض على التلفاز';

  @override
  String get hadisRemoveTip => 'إزالة من القائمة';

  @override
  String get hadisMoveUp => 'أعلى';

  @override
  String get hadisMoveDown => 'أسفل';

  @override
  String get hadisRemoveTitle => 'إزالة هذا الحديث؟';

  @override
  String get hadisRemoveOwnBold => 'دائمة، ولا يمكن التراجع عنها.';

  @override
  String get hadisRemoveOwnBody =>
      'هذا الحديث من القائمة الخاصة سيُحذف من MAXCOM ولا توجد نسخة أخرى منه. لإخفائه عن التلفاز فقط، استخدم المفتاح.';

  @override
  String get hadisRemoveProviderBody =>
      'سيُحذف هذا الحديث من قائمة MAXCOM ولن يُعرض على التلفاز بعد الآن. يمكن إضافته من جديد من البحث عن حديث عندما يتوفر إنترنت في MAXCOM. لإخفائه فقط، استخدم المفتاح.';

  @override
  String get hadisRemoveOwnConfirm => 'إزالة دائمة';

  @override
  String get hadisRemoveConfirm => 'إزالة';

  @override
  String get hadisRemoved => 'تمت إزالة الحديث من القائمة';

  @override
  String get hadisUpdateTitle => 'تم تحديث النص في HadeethEnc';

  @override
  String hadisUpdateBody(String id) {
    return 'حدّث HadeethEnc الحديث $id بعد حفظه في MAXCOM.';
  }

  @override
  String get hadisUpdateBody2 =>
      'ما زال التلفاز يعرض النص المحفوظ. راجع النص الجديد قبل استبداله.';

  @override
  String get hadisUpdateNewText => 'النص الجديد';

  @override
  String get hadisUpdateKeep => 'إبقاء النص القديم';

  @override
  String get hadisUpdateUse => 'استخدام النص الجديد';

  @override
  String get hadisUpdateDone =>
      'تم استخدام النص الجديد. يتحدث التلفاز خلال ثوانٍ.';

  @override
  String get hadisUpdateGradeBlocked =>
      'تم استخدام النص الجديد، لكن درجته الجديدة غير مسموح بها. تم إخفاء هذا الحديث عن التلفاز.';

  @override
  String get hadisUpdateNote =>
      'حدّث HadeethEnc نص هذا الحديث. ما زال التلفاز يعرض النص المحفوظ.';

  @override
  String get hadisUpdateReview => 'مراجعة';

  @override
  String get hadisSearchHint => 'ابحث عن حديث، مثال: الصلاة';

  @override
  String get hadisSearchGo => 'بحث';

  @override
  String get hadisTabCategories => 'التصنيفات';

  @override
  String get hadisTabResults => 'نتائج البحث';

  @override
  String get hadisPickToRead => 'اختر حديثًا من القائمة لعرض تفاصيله.';

  @override
  String get hadisOfflineTitle => 'البحث يتطلب إنترنت';

  @override
  String get hadisOfflineBody =>
      'لا يوجد اتصال بالإنترنت في MAXCOM الآن. يُبحث عن الأحاديث في HadeethEnc عبر MAXCOM، لا مباشرة من الهاتف.';

  @override
  String hadisOfflineSaved(int n) {
    return '$n أحاديث محفوظة في MAXCOM';
  }

  @override
  String get hadisOfflineSavedTail => 'وتستمر في العرض على التلفاز.';

  @override
  String get hadisManageSaved => 'إدارة الأحاديث المحفوظة';

  @override
  String get hadisStillOffline =>
      'ما زال MAXCOM بلا إنترنت. تحقق من الكابل أو Wi-Fi.';

  @override
  String get hadisCatalogEmptyTitle => 'لم تُنزَّل قائمة أحاديث HadeethEnc بعد';

  @override
  String get hadisCatalogEmptyBody =>
      'نزّل هذه القائمة إلى MAXCOM ليمكن البحث عن الأحاديث واختيارها.';

  @override
  String get hadisCatalogEmptyAsk => 'اطلب من المسؤول تنزيل هذه القائمة.';

  @override
  String get hadisDownloadNow => 'نزّل الآن';

  @override
  String hadisDownloading(int done, int total) {
    return 'جارٍ تنزيل $done من $total';
  }

  @override
  String get hadisDownloadStarting => 'جارٍ بدء التنزيل';

  @override
  String get hadisDownloadFailed => 'توقف التنزيل. اضغط مرة أخرى للمتابعة.';

  @override
  String get hadisAllCategories => 'كل التصنيفات';

  @override
  String hadisCatOriginalName(String name) {
    return 'الاسم الأصلي من API: $name';
  }

  @override
  String hadisSubcategories(int n) {
    return '$n تصنيفات فرعية';
  }

  @override
  String hadisCount(int n) {
    return '$n أحاديث';
  }

  @override
  String get hadisInCategory => 'الأحاديث في هذا التصنيف';

  @override
  String get hadisNoItems => 'لا توجد أحاديث.';

  @override
  String get hadisLoadMore => 'عرض المزيد';

  @override
  String get hadisCredit =>
      'المصدر: HadeethEnc.com، موسوعة الأحاديث المترجمة. اللغة الملايوية.';

  @override
  String hadisResultsCount(int n, String q) {
    return '$n نتائج لـ \"$q\"';
  }

  @override
  String get hadisTypeKeyword => 'اكتب كلمة مفتاحية';

  @override
  String get hadisResultsScope => 'العناوين والنص الملايوي';

  @override
  String get hadisNoResults =>
      'لا توجد أحاديث مطابقة. جرّب كلمة أخرى أو افتح تصنيفًا.';

  @override
  String get hadisSearchExample => 'مثال: الصلاة، الدعاء، الصدقة.';

  @override
  String get hadisDetailTitle => 'تفاصيل الحديث';

  @override
  String hadisDetailKicker(String id) {
    return 'حديث $id  HADEETHENC';
  }

  @override
  String get hadisTranslation => 'الترجمة الملايوية';

  @override
  String get hadisArabicText => 'النص العربي';

  @override
  String get hadisArabicHidden =>
      'النص العربي مخفي في هذه المعاينة. إعدادات التلفاز في الإعدادات، الأحاديث.';

  @override
  String get hadisDetails => 'التفاصيل';

  @override
  String get hadisGrade => 'الدرجة';

  @override
  String get hadisAttribution => 'العزو';

  @override
  String get hadisCategories => 'التصنيفات';

  @override
  String hadisSourceLine(String id) {
    return 'المصدر: HadeethEnc.com (موسوعة الأحاديث المترجمة)، المعرّف $id';
  }

  @override
  String get hadisPreviewOnTv => 'معاينة على التلفاز';

  @override
  String hadisLongNote(int n) {
    return '($n حرفًا). يُقسَّم هذا الحديث على التلفاز إلى عدة أجزاء تتبدل تلقائيًا.';
  }

  @override
  String get hadisAddKiosk => 'إضافة إلى الكشك';

  @override
  String get hadisAlreadyKiosk => 'موجود في الكشك';

  @override
  String get hadisAddNeedsInternet => 'الإضافة تتطلب إنترنت عبر MAXCOM.';

  @override
  String get hadisAdded => 'تمت إضافة الحديث إلى الكشك';

  @override
  String get hadisAddGradeBlocked =>
      'درجة هذا الحديث غير مسموح بها على التلفاز';

  @override
  String get hadisAddTooLong => 'النص طويل جدًا لـ MAXCOM';

  @override
  String hadisAddLimit(int max) {
    return 'القائمة ممتلئة ($max حديثًا). أزل حديثًا آخر أولًا.';
  }

  @override
  String get hadisAddUnavailable =>
      'تعذّر على MAXCOM الوصول إلى HadeethEnc الآن. أعد المحاولة.';

  @override
  String get hadisSettingsIntro =>
      'بطاقة الحديث على التلفاز: من أين تؤخذ الأحاديث، وكم حديثًا في اليوم، وماذا يُعرض.';

  @override
  String get hadisSourceTitle => 'مصدر الأحاديث';

  @override
  String hadisSourceOwnDesc(int n, int on) {
    return '$n حديثًا كُتبت أو استُوردت ($on مفعّلة).';
  }

  @override
  String hadisSourceProviderDesc(int n, int on) {
    return '$n حديثًا اختيرت من HadeethEnc.com ومحفوظة في MAXCOM ($on مفعّلة).';
  }

  @override
  String get hadisSourceBoth => 'كلاهما';

  @override
  String get hadisSourceBothDesc =>
      'القائمة الخاصة وHadeethEnc، حسب الترتيب في قائمة الأحاديث.';

  @override
  String get hadisMixTitle => 'الترتيب';

  @override
  String get hadisMixList => 'حسب القائمة';

  @override
  String get hadisMixAlternate => 'بالتناوب';

  @override
  String get hadisMixRandom => 'عشوائي';

  @override
  String get hadisMixListHelp => 'حسب الترتيب الذي حددته في قائمة الأحاديث.';

  @override
  String get hadisMixAlternateHelp =>
      'حديث من القائمة الخاصة، ثم حديث من HadeethEnc، وهكذا.';

  @override
  String get hadisMixRandomHelp => 'ترتيب عشوائي كل يوم.';

  @override
  String get hadisTurnTitle => 'الدور';

  @override
  String get hadisChangeTitle => 'تغيير الحديث';

  @override
  String get hadisChangeDay => 'مجموعة واحدة في اليوم';

  @override
  String get hadisChangeCard => 'في كل عرض';

  @override
  String get hadisChangeDayHelp =>
      'الأحاديث نفسها طوال اليوم؛ ومجموعة جديدة غدًا.';

  @override
  String get hadisChangeCardHelp =>
      'الحديث التالي في كل مرة تظهر فيها بطاقة الحديث.';

  @override
  String get hadisPerDay => 'عدد الأحاديث في اليوم';

  @override
  String get hadisPerDayHelp => 'تتناوب ضمن دورة المحتوى';

  @override
  String get hadisPerDayNotUsed => 'لا ينطبق على في كل عرض';

  @override
  String get hadisDuration => 'مدة عرض البطاقة';

  @override
  String get hadisDurationHelp => 'في كل مرة تظهر فيها بطاقة الحديث';

  @override
  String hadisSeconds(int n) {
    return '$n ثانية';
  }

  @override
  String get hadisTodayTitle => 'اليوم على التلفاز';

  @override
  String hadisTodayItem(int n) {
    return 'الحديث $n';
  }

  @override
  String get hadisTodayEmpty =>
      'لا توجد أحاديث مفعّلة لهذا المصدر. تُتجاوز بطاقة الحديث على التلفاز.';

  @override
  String hadisTodayMore(int n) {
    return 'و$n أخرى';
  }

  @override
  String get hadisDisplayTitle => 'العرض على التلفاز';

  @override
  String get hadisFieldArabic => 'النص العربي';

  @override
  String get hadisFieldArabicHelp => 'النص الأصلي للحديث، من اليمين إلى اليسار';

  @override
  String get hadisFieldMalay => 'الترجمة الملايوية';

  @override
  String get hadisFieldMalayHelp => 'النص الرئيسي للبطاقة';

  @override
  String get hadisFieldAttribution => 'العزو';

  @override
  String get hadisFieldAttributionHelp => 'مثال: متفق عليه، رواه مسلم';

  @override
  String get hadisFieldGrade => 'الدرجة';

  @override
  String get hadisFieldGradeHelp => 'مثل صحيح أو حسن';

  @override
  String get hadisFieldCredit => 'نسبة المصدر';

  @override
  String get hadisFieldCreditHelp => 'المصدر: HadeethEnc.com في أسفل البطاقة';

  @override
  String get hadisRequired => 'مطلوب';

  @override
  String get hadisFontTitle => 'حجم الخط';

  @override
  String get hadisFontAuto => 'تلقائي';

  @override
  String get hadisFontAutoLong => 'تلقائي حسب الطول';

  @override
  String get hadisFontSmall => 'صغير';

  @override
  String get hadisFontMedium => 'متوسط';

  @override
  String get hadisFontLarge => 'كبير';

  @override
  String get hadisFontHelp => 'يُصغَّر النص الطويل ليناسب البطاقة';

  @override
  String get hadisPreviewTitle => 'معاينة';

  @override
  String get hadisPreviewHelp =>
      'تستخدم المعاينة أول حديث اليوم والإعدادات أعلاه.';

  @override
  String get hadisPreviewSample =>
      'إنما الأعمال بالنيات، وإنما لكل امرئ ما نوى.';

  @override
  String get hadisPreviewSampleSource => 'رواه البخاري ومسلم';

  @override
  String get hadisGradesTitle => 'الدرجات المسموح بها على التلفاز';

  @override
  String get hadisGradesNote =>
      'تُكتب درجات HadeethEnc بالعربية؛ ويحوّلها MAXCOM إلى تسمية ملايوية.';

  @override
  String get hadisLocked => 'مقفل نهائيًا';

  @override
  String get hadisSettingsSaved =>
      'تم حفظ إعدادات الأحاديث في MAXCOM. يتحدث التلفاز خلال ثوانٍ.';

  @override
  String get hadisTvTag => 'حديث';

  @override
  String hadisTvPart(int i, int n) {
    return 'الجزء $i من $n';
  }

  @override
  String get hadisTvCredit => 'المصدر: HadeethEnc.com';

  @override
  String get hadisTvCountdown => 'العصر بعد';

  @override
  String get hadisTvPrayerImsak => 'الإمساك';

  @override
  String get hadisTvPrayerSubuh => 'الفجر';

  @override
  String get hadisTvPrayerSyuruk => 'الشروق';

  @override
  String get hadisTvPrayerZohor => 'الظهر';

  @override
  String get hadisTvPrayerAsar => 'العصر';

  @override
  String get hadisTvPrayerMaghrib => 'المغرب';

  @override
  String get hadisTvPrayerIsyak => 'العشاء';

  @override
  String get locTitle => 'موقع المصلى';

  @override
  String get locIntroMy =>
      'يحدد الموقع مواقيت الصلاة المحسوبة ومنطقة JAKIM المقترحة. لا توجد خريطة: ابحث عن عنوان أو اكتب الإحداثيات.';

  @override
  String get locIntro =>
      'يحدد الموقع مواقيت الصلاة المحسوبة. لا توجد خريطة: ابحث عن عنوان أو اكتب الإحداثيات.';

  @override
  String get locPickerSearch => 'بحث';

  @override
  String get locPickerNone => 'لا يوجد ما يطابق.';

  @override
  String get locCountry => 'الدولة';

  @override
  String get locCountrySearch => 'ابحث عن دولة';

  @override
  String get locCountryOfficial => 'المصدر الرسمي: JAKIM e-Solat';

  @override
  String get locCountryNoOfficial => 'لا يوجد مصدر رسمي في MAXCOM؛ حساب أو ملف';

  @override
  String locZonesCount(int n) {
    return '$n مناطق زمنية';
  }

  @override
  String get locTimezone => 'المنطقة الزمنية';

  @override
  String get locTimezoneSearch => 'ابحث عن منطقة زمنية';

  @override
  String get locTimezoneOwn => 'هذه الدولة';

  @override
  String get locTimezoneOther => 'أخرى';

  @override
  String get locTimezoneFromCountry => 'محددة من الدولة';

  @override
  String locZoneRow(String zone) {
    return 'منطقة JAKIM: $zone';
  }

  @override
  String get locZoneNone => 'لم تُختر منطقة JAKIM بعد';

  @override
  String get locChange => 'تغيير';

  @override
  String get locHowTitle => 'طريقة تحديد الموقع';

  @override
  String get locModeSearch => 'البحث عن عنوان';

  @override
  String get locModeCoordinates => 'كتابة الإحداثيات';

  @override
  String get locSearchLabel => 'العنوان أو المدينة';

  @override
  String get locSearchHint => 'مثال: Taman Sri Gombak';

  @override
  String get locSearchGo => 'بحث';

  @override
  String get locSearchHelp =>
      'يُرسَل البحث مرة واحدة عند الضغط على بحث. يتطلب إنترنت.';

  @override
  String locResultsTitle(int n, String q) {
    return '$n نتائج لـ \"$q\"';
  }

  @override
  String get locNoResults =>
      'لا توجد نتائج. جرّب اسم المدينة أو اكتب الإحداثيات.';

  @override
  String get locAttribution => '(c) OpenStreetMap contributors';

  @override
  String get locOfflineHint => 'لا يوجد إنترنت في MAXCOM؛ اكتب الإحداثيات';

  @override
  String get locCoordinatesHelp =>
      'لـ MAXCOM بدون إنترنت. انسخ الإحداثيات من تطبيق الخرائط في الهاتف (اضغط مطولًا على موقع المصلى).';

  @override
  String get locConfirmed => 'تم التأكيد';

  @override
  String get locCoordinates => 'الإحداثيات';

  @override
  String get locCity => 'اسم المدينة للعرض';

  @override
  String get locCityHelp => 'يظهر في أسفل شاشة التلفاز عند حساب المواقيت.';

  @override
  String get locLatitude => 'خط العرض';

  @override
  String get locLatitudeHelp => 'الشمال موجب والجنوب سالب';

  @override
  String get locLatitudeError => 'يجب أن يكون خط العرض بين -90 و90';

  @override
  String get locLongitude => 'خط الطول';

  @override
  String get locLongitudeHelp => 'الشرق موجب والغرب سالب';

  @override
  String get locLongitudeError => 'يجب أن يكون خط الطول بين -180 و180';

  @override
  String locSuggestTitle(String code) {
    return 'منطقة JAKIM المقترحة: $code';
  }

  @override
  String locSuggestUse(String code) {
    return 'استخدام $code';
  }

  @override
  String get locSuggestOther => 'اختيار منطقة أخرى';

  @override
  String locZoneUsed(String code) {
    return 'تم استخدام المنطقة $code';
  }

  @override
  String locNoOfficial(String country) {
    return 'لا يوجد مصدر رسمي لـ $country في MAXCOM. تأتي مواقيت الصلاة من الحساب المحلي وملف الاستيراد.';
  }

  @override
  String get locChangeWarning =>
      'تغيير الموقع يعيد حساب المواقيت المحسوبة لجميع الأيام. لا تتغير البيانات الرسمية وملف الاستيراد.';

  @override
  String get locNeedCoordinates =>
      'يحتاج الموقع إلى إحداثيات لأن مواقيت الصلاة تُحسب';

  @override
  String get locSave => 'حفظ الموقع';

  @override
  String get locSaved => 'تم حفظ الموقع. تُعاد حسابات المواقيت في MAXCOM.';

  @override
  String get locNoChange => 'لا توجد تغييرات للحفظ';

  @override
  String get zonTitle => 'منطقة JAKIM';

  @override
  String get zonField => 'منطقة JAKIM';

  @override
  String get zonSearch => 'ابحث بالرمز أو الولاية أو المنطقة';

  @override
  String zonHasData(String years) {
    return 'البيانات متوفرة: $years';
  }

  @override
  String get zonNoData => 'لا توجد بيانات: ستُنزَّل';

  @override
  String get zonUnknown => 'هذه المنطقة غير موجودة في القائمة';

  @override
  String get zonSuggestedGroup => 'مقترحة من الموقع';

  @override
  String zonSuggested(String code) {
    return 'مقترحة من الموقع: $code';
  }

  @override
  String get zonUse => 'استخدام';

  @override
  String get zonSave => 'حفظ المنطقة';

  @override
  String zonSaved(String code) {
    return 'تم حفظ المنطقة $code';
  }

  @override
  String zonWillFetch(String code) {
    return 'ستُنزَّل بيانات $code بعد الحفظ، إذا كان MAXCOM هذا ينزّل بنفسه.';
  }

  @override
  String get zonMalaysiaOnly => 'مناطق JAKIM للمصليات في ماليزيا فقط.';

  @override
  String get zonPlaceUnnamed => 'موقع المصلى';

  @override
  String get zonNoCoordinates => 'لم تُحدَّد الإحداثيات بعد';

  @override
  String get zonListTitle => 'قائمة مناطق JAKIM';

  @override
  String zonListCount(int n) {
    return '$n مناطق من e-Solat. تُستخدم النسخة الموجودة في MAXCOM عند عدم الاتصال.';
  }

  @override
  String zonListMeta(int n, String when) {
    return '$n مناطق من e-Solat، حُدّثت $when. تُستخدم النسخة الموجودة في MAXCOM عند عدم الاتصال.';
  }

  @override
  String get zonRefresh => 'تحديث قائمة المناطق';

  @override
  String zonRefreshed(int n) {
    return 'تم تحديث قائمة المناطق: $n مناطق';
  }

  @override
  String get srcTitle => 'مصادر مواقيت الصلاة';

  @override
  String get srcOrderTitle => 'ترتيب المصادر';

  @override
  String get srcMoveUp => 'أعلى';

  @override
  String get srcMoveDown => 'أسفل';

  @override
  String get srcOrderHelpMy =>
      'يُستخدم أول مصدر لديه بيانات ليوم معين. في ماليزيا، تُقدَّم JAKIM عادةً.';

  @override
  String get srcOrderHelp =>
      'يُستخدم أول مصدر لديه بيانات ليوم معين. لا يُعرض المصدر الرسمي لعدم وجوده لهذه الدولة.';

  @override
  String get srcOfficialNotFirst => 'لم تعد بيانات JAKIM الرسمية مقدَّمة';

  @override
  String get srcOfficial => 'المصدر الرسمي';

  @override
  String srcOfficialDetail(String zone) {
    return 'JAKIM e-Solat، المنطقة $zone';
  }

  @override
  String get srcOfficialNone => 'لم تُنزَّل بيانات بعد.';

  @override
  String srcOfficialStored(String year) {
    return '$year محفوظة.';
  }

  @override
  String srcOfficialFetched(String year, String when) {
    return '$year محفوظة (نُزّلت $when).';
  }

  @override
  String get srcCalc => 'الحساب المحلي';

  @override
  String get srcCalcShort => 'الحساب';

  @override
  String get srcCalcNote => 'متوفر دائمًا، يُحسب في MAXCOM دون إنترنت.';

  @override
  String get srcFile => 'ملف الاستيراد';

  @override
  String get srcFileDetail => 'جدول مواقيت المصلى الخاص';

  @override
  String srcFileDays(int n) {
    return '$n يومًا قادمًا من الملف.';
  }

  @override
  String get srcFileNone => 'لا يوجد استيراد لمواقيت الصلاة.';

  @override
  String get srcMethod => 'الطريقة';

  @override
  String get srcMethodAuto => 'تلقائي حسب الدولة';

  @override
  String srcMethodAutoNamed(String method) {
    return 'تلقائي ($method)';
  }

  @override
  String get srcMadhab => 'المذهب لصلاة العصر';

  @override
  String get srcMadhabAuto => 'تلقائي';

  @override
  String get srcMadhabShafi => 'الشافعي';

  @override
  String get srcMadhabHanafi => 'الحنفي';

  @override
  String get srcHigh => 'قاعدة خطوط العرض العالية';

  @override
  String get srcHighAuto => 'تلقائي';

  @override
  String get srcHighMiddle => 'منتصف الليل';

  @override
  String get srcHighSeventh => 'سُبع الليل';

  @override
  String get srcHighTwilight => 'زاوية الشفق';

  @override
  String get srcHighNoEffect => 'لا أثر دون خط عرض 48 درجة';

  @override
  String get srcAdjustTitle => 'ضبط الدقائق';

  @override
  String get srcAdjustClear => 'مسح الضبط';

  @override
  String get srcImsakMinutes => 'الإمساك، دقائق قبل الفجر';

  @override
  String srcMinutes(int n) {
    return '$n دقيقة';
  }

  @override
  String get srcLess => 'أقل';

  @override
  String get srcMore => 'أكثر';

  @override
  String srcPreviewTitle(String date) {
    return 'معاينة اليوم، $date';
  }

  @override
  String get srcPreviewNone =>
      'لا توجد مواقيت لهذا اليوم. حدّد موقع المصلى أولًا.';

  @override
  String get srcPreviewPrayer => 'الصلاة';

  @override
  String get srcPreviewDiff => 'الفرق';

  @override
  String get srcPreviewNote =>
      'الفرق = أول مصدر ناقص الحساب، بالدقائق، حسب الإعدادات المحفوظة.';

  @override
  String get srcCrossTitle => 'التحقق المتقاطع';

  @override
  String get srcCrossToggle => 'تعليم الأيام التي يزيد فرقها على دقيقتين';

  @override
  String get srcCrossHelp => 'قارن الحساب بأول مصدر كل يوم.';

  @override
  String get srcCrossNone => 'لا توجد أيام للمقارنة هذا الشهر.';

  @override
  String srcCrossFlagged(String month) {
    return 'أيام معلَّمة في $month';
  }

  @override
  String get srcCrossLargest => 'أكبر فرق لكل صلاة (دقائق)';

  @override
  String get srcCrossOk => 'الحساب مطابق خلال دقيقتين لجميع الأيام.';

  @override
  String get srcUseSuggestion => 'استخدام الضبط المقترح';

  @override
  String get srcSuggestionNote =>
      'يُضاف المقترح إلى الضبط المحفوظ. لا يُحفظ حتى تضغط حفظ.';

  @override
  String get srcSave => 'حفظ';

  @override
  String get srcSaved => 'تم حفظ مصادر مواقيت الصلاة.';

  @override
  String get pdLoadFailed => 'تعذّرت قراءة بيانات كل يوم الآن.';

  @override
  String get pdSourceOfficial => 'المصدر: JAKIM e-Solat';

  @override
  String pdSourceOfficialOn(String date) {
    return 'المصدر: JAKIM e-Solat، نُزّل في $date';
  }

  @override
  String get pdSourceFile => 'المصدر: ملف الاستيراد';

  @override
  String get pdSourceCalc => 'المصدر: الحساب المحلي';

  @override
  String get pdDaysTitle => 'المواقيت لكل يوم';

  @override
  String get pdViewMonth => 'الشهر';

  @override
  String get pdViewYear => 'السنة';

  @override
  String pdFlagged(int n) {
    return 'التحقق المتقاطع: $n أيام معلَّمة هذا الشهر.';
  }

  @override
  String get pdAdjustLink => 'ضبط الحساب';

  @override
  String get pdPrevMonth => 'الشهر السابق';

  @override
  String get pdNextMonth => 'الشهر التالي';

  @override
  String get pdMonthEmpty => 'لا توجد بيانات لهذا الشهر.';

  @override
  String get pdTapHint => 'اضغط يومًا لرؤية المصدر وإجراء تصحيح.';

  @override
  String get pdLinkImport => 'استيراد ملف مواقيت الصلاة';

  @override
  String get pdLinkRecords => 'سجلات الاستيراد';

  @override
  String get pdGridDay => 'اليوم';

  @override
  String get pdLegendOfficial => 'رسمي (JAKIM)';

  @override
  String get pdLegendCalc => 'الحساب المحلي';

  @override
  String get pdLegendFile => 'استيراد ملف';

  @override
  String get pdLegendCorrection => 'تصحيح يدوي';

  @override
  String get pdLegendFlag => 'فرق أكثر من دقيقتين عن الحساب';

  @override
  String get pdEmergency => 'حساب مؤقت';

  @override
  String get pdUsed => 'المستخدم';

  @override
  String get pdImsakDerived => 'حُسب الإمساك من الفجر لعدم وجوده في الملف.';

  @override
  String get pdOverrideKhutbah => 'خطبة الجمعة';

  @override
  String pdOverrideIqamah(String prayer) {
    return 'إقامة $prayer';
  }

  @override
  String get pdCorrectionTitle => 'تصحيح لصلاة واحدة';

  @override
  String get pdCorrectionTime => 'الوقت (24 ساعة)';

  @override
  String get pdCorrectionReason => 'سبب التصحيح';

  @override
  String get pdCorrectionReasonHint => 'مثال: إشعار تعديل من JAKIM';

  @override
  String get pdCorrectionSave => 'حفظ التصحيح';

  @override
  String get pdCorrectionRemove => 'إزالة التصحيح';

  @override
  String get pdOfficialChanged =>
      'تغيّرت القيمة الرسمية منذ إجراء هذا التصحيح. ما زال تصحيحك مستخدمًا.';

  @override
  String get pdCorrectionIgnored =>
      'لا يُستخدم التصحيح لهذه الصلاة لأنه يجعل ترتيب مواقيت اليوم غير صحيح. راجع هذا التصحيح أو أزله.';

  @override
  String get impFileUnused =>
      'لن يُستخدم هذا الجدول ما دام الحساب المحلي فوق الملف في مصادر مواقيت الصلاة.';

  @override
  String get pdTimeInvalid => 'يجب أن يكون الوقت بنظام 24 ساعة، مثال 13:05';

  @override
  String get pdReasonNeeded => 'يجب أن يكون السبب 3 أحرف على الأقل';

  @override
  String get impTitle => 'استيراد مواقيت الصلاة';

  @override
  String get impTargetLabel => 'هدف الاستيراد';

  @override
  String impTargetZone(String zone) {
    return 'المنطقة $zone';
  }

  @override
  String get impStepPick => 'اختيار ملف';

  @override
  String get impStepCheck => 'الفحص';

  @override
  String get impStepConfirm => 'التأكيد';

  @override
  String get impTemplateTitle => 'تنزيل القالب';

  @override
  String get impTemplateHelp =>
      'مملوء باسم المصلى وكل تاريخ في تلك السنة. الأوقات بنظام 24 ساعة.';

  @override
  String get impTemplateCsv => 'CSV';

  @override
  String get impTemplateExcel => 'Excel';

  @override
  String get impTemplateCopied => 'تم نسخ قالب CSV. الصقه في ملف جديد.';

  @override
  String get impTemplateExcelNone =>
      'لا يمكن تنزيل قالب Excel في هذا الجهاز بعد. استخدم قالب CSV.';

  @override
  String get impColumnsTitle => 'أعمدة القالب';

  @override
  String get impColumnsList =>
      'date, imsak, subuh, syuruk, dhuha, zohor, asar, maghrib, isyak, note. للمساجد فقط: jumaat_khutbah, iqamah_subuh, iqamah_zohor, iqamah_asar, iqamah_maghrib, iqamah_isyak.';

  @override
  String get impPick => 'اختيار ملف';

  @override
  String get impPickOther => 'اختيار ملف آخر';

  @override
  String get impPickHelp =>
      'CSV بحد أقصى 1 MB أو Excel (.xlsx) بحد أقصى 2 MB. وكذلك ملف e-Solat السنوي من JAKIM.';

  @override
  String get impTooBig => 'الملف كبير جدًا. الحد 1 MB لـ CSV و2 MB لـ Excel.';

  @override
  String get impWrongType => 'يُقبل ملف CSV أو Excel (.xlsx) فقط.';

  @override
  String get impUnreadable => 'تعذّرت قراءة الملف.';

  @override
  String get impSheet => 'الورقة';

  @override
  String impEsolatDetected(String zone) {
    return 'ملف e-Solat: يُحفظ كمصدر رسمي للمنطقة $zone';
  }

  @override
  String impErrors(int n) {
    return '$n أخطاء. لم يُحفظ أي شيء.';
  }

  @override
  String get impErrorsTitle => 'الأخطاء';

  @override
  String impRow(int n) {
    return 'الصف $n';
  }

  @override
  String impClean(int n, String from, String to) {
    return 'لا توجد أخطاء. $n يومًا، من $from إلى $to. لم يُحفظ بعد.';
  }

  @override
  String get impDetectedColumns => 'الأعمدة المعروفة';

  @override
  String get impPerMonth => 'عدد الأيام في كل شهر';

  @override
  String get impFirstWeek => 'الأسبوع الأول';

  @override
  String get impLastWeek => 'الأسبوع الأخير';

  @override
  String get impOverlapTitle => 'أيام متداخلة';

  @override
  String impOverlapCounts(int official, int file, int calc) {
    return 'موجود بالفعل: $official يومًا رسميًا، $file يومًا من ملف، $calc يومًا محسوبًا.';
  }

  @override
  String get impOverlapReplace => 'استبدال';

  @override
  String get impOverlapReplaceNote =>
      'يستبدل الملف الجديد الأيام الموجودة من الملف القديم.';

  @override
  String get impOverlapKeep => 'إبقاء الموجود';

  @override
  String get impOverlapKeepNote =>
      'تبقى أيام الملف القديم؛ وتُضاف التواريخ الجديدة فقط.';

  @override
  String get impOverlapFill => 'ملء الأيام الفارغة فقط';

  @override
  String get impOverlapFillNote =>
      'الأيام التي لا توجد لها بيانات رسمية أو ملف فقط.';

  @override
  String impWouldWrite(int total, int inserted, int replaced, int skipped) {
    return 'سيُحفظ: $total يومًا. أُضيف $inserted، واستُبدل $replaced، وتُجوّز $skipped.';
  }

  @override
  String get impSave => 'حفظ';

  @override
  String impConfirmTitle(int n, String target) {
    return 'حفظ $n يومًا في $target؟';
  }

  @override
  String impConfirmBody(int inserted, int replaced) {
    return 'أُضيف $inserted يومًا واستُبدل $replaced يومًا. يُنشأ سجل استيراد واحد ويمكن التراجع عنه لاحقًا.';
  }

  @override
  String impConfirmOfficialTitle(String zone) {
    return 'الحفظ كمصدر رسمي للمنطقة $zone؟';
  }

  @override
  String get impConfirmOfficialBody => 'ستُستبدل الأيام الموجودة لهذه المنطقة.';

  @override
  String get impDone => 'تم حفظ الاستيراد';

  @override
  String impDoneDetail(int inserted, int replaced, int skipped) {
    return 'أُضيف $inserted، واستُبدل $replaced، وتُجوّز $skipped';
  }

  @override
  String impOfficialDone(String zone) {
    return 'تم الحفظ كمصدر رسمي للمنطقة $zone';
  }

  @override
  String get impGoRecords => 'عرض سجلات الاستيراد';

  @override
  String get rekTitle => 'سجلات الاستيراد';

  @override
  String get rekIntro =>
      'كل استيراد لهذا المصلى فقط. لا تُدرج هنا تنزيلات JAKIM؛ انظر بيانات مواقيت الصلاة.';

  @override
  String get rekNone => 'لا توجد عمليات استيراد لمواقيت الصلاة بعد.';

  @override
  String get rekStateActive => 'نشط';

  @override
  String rekStateUndone(String date) {
    return 'أُلغي $date';
  }

  @override
  String get rekSha => 'sha256';

  @override
  String get rekRows => 'الصفوف';

  @override
  String get rekRange => 'النطاق';

  @override
  String rekRangeValue(String from, String to) {
    return 'من $from إلى $to';
  }

  @override
  String get rekOverlap => 'التداخل';

  @override
  String get rekWho => 'بواسطة';

  @override
  String get rekWhen => 'متى';

  @override
  String get rekUndo => 'التراجع عن الاستيراد';

  @override
  String get rekUndoTitle => 'التراجع عن الاستيراد؟';

  @override
  String rekUndoBody(int inserted, int replaced) {
    return 'حُذف $inserted يومًا، واستُعيد $replaced يومًا إلى البيانات السابقة لهذا الاستيراد.';
  }

  @override
  String rekUndone(int n) {
    return 'تم التراجع عن الاستيراد. استُعيد $n يومًا.';
  }

  @override
  String get rekBlockedTitle => 'لا يمكن التراجع بعد الآن';

  @override
  String get rekBlockedOk => 'فهمت';

  @override
  String get finrClose => 'إغلاق';

  @override
  String get finrReportTitle => 'التقرير الشهري';

  @override
  String get finrMonthThis => 'هذا الشهر';

  @override
  String get finrMonthLast => 'الشهر الماضي';

  @override
  String get finrMonthPick => 'اختر الشهر...';

  @override
  String get finrNoMonths => 'لا توجد أشهر فيها قيود بعد';

  @override
  String get finrStatusReady => 'مسودة جاهزة لاجتماع اللجنة';

  @override
  String get finrStatusReadySub => 'تمت مزامنة جميع قيود هذا الشهر.';

  @override
  String get finrStatusReadyPending =>
      'توجد قيود في هذا الجهاز لم تتم مزامنتها.';

  @override
  String get finrStatusOpenMonth => 'لم ينته الشهر بعد';

  @override
  String finrStatusOpenMonthSub(String date) {
    return 'هذا التقرير مسودة حتى $date.';
  }

  @override
  String get finrStatusClosed => 'نهائي';

  @override
  String finrStatusClosedSub(String date) {
    return 'أُغلق في $date. الأرقام مجمَّدة.';
  }

  @override
  String get finrPillDraft => 'مسودة';

  @override
  String get finrPillFinal => 'نهائي';

  @override
  String finrPendingNote(int n) {
    return '$n قيود في هذا الجهاز لم تتم مزامنتها. تعرضها هذه الشاشة، لكن ملف PDF يحتوي فقط على القيود التي وصلت إلى MAXCOM.';
  }

  @override
  String get finrFullPage => 'صفحة A4 كاملة';

  @override
  String get finrDownloadPdf => 'تنزيل PDF';

  @override
  String get finrDownloaded => 'تم حفظ PDF في التنزيلات.';

  @override
  String get finrShare => 'مشاركة';

  @override
  String get finrPrint => 'طباعة';

  @override
  String get finrShareNoteFailed => 'تعذّر تسجيل المشاركة في سجل التدقيق.';

  @override
  String get finrLiveOnlyAction => 'تنزيل تقرير PDF أو مشاركته';

  @override
  String get finrCloseMonth => 'إغلاق الشهر (نهائي)';

  @override
  String finrCloseTitle(String month) {
    return 'إغلاق $month؟';
  }

  @override
  String get finrCloseBody =>
      'بعد اعتماده نهائيًا يُجمَّد التقرير ولا يمكن إدخال قيود بتواريخ في ذلك الشهر. يستطيع المسؤول إعادة فتحه، ويُسجَّل ذلك في سجل التدقيق.';

  @override
  String finrCloseOrder(String month) {
    return 'أغلق $month أولًا.';
  }

  @override
  String get finrClosedDone => 'تم إغلاق الشهر. جُمِّد التقرير.';

  @override
  String get finrReopenMonth => 'إعادة فتح الشهر';

  @override
  String finrReopenTitle(String month) {
    return 'إعادة فتح $month؟';
  }

  @override
  String get finrReopenBody =>
      'يُحذف التقرير المجمَّد ويمكن إدخال قيود جديدة من جديد. يُسجَّل هذا الإجراء في سجل التدقيق.';

  @override
  String get finrReopenDone => 'تمت إعادة فتح الشهر.';

  @override
  String get finrShareTitle => 'مشاركة التقرير';

  @override
  String get finrShareWarning =>
      'يحتوي هذا التقرير على بيانات مالية للمصلى وأسماء المتبرعين. شاركه مع أعضاء اللجنة فقط. تُسجَّل المشاركة في سجل التدقيق.';

  @override
  String get finrShareGo => 'اختيار تطبيق';

  @override
  String get finrAuditTitle => 'سجل التدقيق المالي';

  @override
  String get finrAuditIntro =>
      'كل إجراء مالي: من فعله، وفي أي جهاز، ومتى أُدخل ومتى تمت مزامنته. لا يمكن تغييره.';

  @override
  String get finrAuditEmpty => 'لا توجد إجراءات مالية مسجّلة بعد.';

  @override
  String get finrAuditStale => 'معروض من آخر نسخة تمت قراءتها.';

  @override
  String get finrFilterAll => 'الكل';

  @override
  String get finrFilterIn => 'التحصيل';

  @override
  String get finrFilterOut => 'المدفوعات';

  @override
  String get finrFilterCor => 'التصحيح';

  @override
  String get finrFilterSet => 'الإعدادات';

  @override
  String get finrFilterReport => 'التقرير';

  @override
  String get finrFilterRefused => 'المرفوضة';

  @override
  String finrAuditIn(String ref, String fund) {
    return 'تحصيل $ref، $fund';
  }

  @override
  String finrAuditOut(String ref, String fund) {
    return 'دفعة $ref، $fund';
  }

  @override
  String finrAuditCor(String ref, String fund) {
    return 'تصحيح $ref، $fund';
  }

  @override
  String finrAuditOpening(String fund) {
    return 'الرصيد الافتتاحي، $fund';
  }

  @override
  String finrAuditFund(String name) {
    return 'إعداد صندوق التبرعات: $name';
  }

  @override
  String finrAuditPerihal(String name) {
    return 'إعداد البيان: $name';
  }

  @override
  String finrAuditMonthClosed(String month) {
    return 'تم اعتماد $month نهائيًا';
  }

  @override
  String finrAuditMonthOpened(String month) {
    return 'أُعيد فتح $month';
  }

  @override
  String finrAuditReportDownloaded(String month) {
    return 'نُزِّل تقرير $month (PDF)';
  }

  @override
  String finrAuditReportShared(String month) {
    return 'شورك تقرير $month';
  }

  @override
  String finrAuditRefused(String reason) {
    return 'مرفوض: $reason';
  }

  @override
  String get finrRefusedRevoked => 'الجهاز ملغى';

  @override
  String get finrRefusedMonthClosed => 'ذلك الشهر معتمد نهائيًا';

  @override
  String get finrRefusedFundArchived => 'صندوق التبرعات هذا مؤرشف';

  @override
  String get finrRefusedOther => 'رفضه MAXCOM';

  @override
  String get finrColAction => 'الإجراء';

  @override
  String get finrColWho => 'من';

  @override
  String get finrColDevice => 'الجهاز';

  @override
  String get finrColSignature => 'توقيع الجهاز';

  @override
  String get finrColEntered => 'أُدخل';

  @override
  String get finrColReceived => 'استُلم في MAXCOM';

  @override
  String get finrColCloud => 'وصل إلى السحابة';

  @override
  String get finrSigOk => 'صالح';

  @override
  String get finrNotYet => 'غير معروف بعد';

  @override
  String get finrNoDevice => 'غير معروف';

  @override
  String finrDetailReason(String reason) {
    return 'السبب: $reason';
  }

  @override
  String get finrFundsTitle => 'إعدادات صناديق التبرعات';

  @override
  String get finrFundsIntro =>
      'للمسؤول فقط. لا تُحذف صناديق التبرعات؛ تُؤرشف التي لم تعد مستخدمة.';

  @override
  String get finrFundsSection => 'صناديق التبرعات';

  @override
  String finrBalance(String amount) {
    return 'الرصيد $amount';
  }

  @override
  String finrTarget(String amount) {
    return 'الهدف $amount';
  }

  @override
  String get finrOnTv => 'شاشة التلفاز';

  @override
  String get finrRename => 'إعادة التسمية';

  @override
  String get finrArchive => 'أرشفة';

  @override
  String get finrArchiveNeedsZero => 'يجب أن يكون الرصيد RM 0.00';

  @override
  String finrArchiveTitle(String name) {
    return 'أرشفة $name؟';
  }

  @override
  String get finrArchiveBody =>
      'يُخفى صندوق التبرعات هذا عن الاختيارات الجديدة. يبقى السجل والتقارير القديمة، ويمكن استعادة الصندوق.';

  @override
  String finrArchivedOn(String date) {
    return 'أُرشف $date، الرصيد RM 0.00';
  }

  @override
  String get finrRestore => 'استعادة';

  @override
  String get finrAddFund => 'إضافة صندوق تبرعات';

  @override
  String get finrAddFundHelp => 'يبدأ صندوق التبرعات الجديد برصيد RM 0.00.';

  @override
  String get finrRenameFund => 'إعادة تسمية صندوق التبرعات';

  @override
  String get finrRenameFundHelp =>
      'يُطبَّق الاسم الجديد من اليوم. يبقى السجل والتقارير القديمة.';

  @override
  String get finrFundName => 'اسم صندوق التبرعات';

  @override
  String get finrFundNameInvalid => 'يجب أن يكون الاسم من 1 إلى 60 حرفًا';

  @override
  String get finrFundNameTaken => 'اسم صندوق التبرعات هذا مستخدم بالفعل';

  @override
  String get finrFundPublic => 'العرض على شاشة التلفاز';

  @override
  String get finrFundTarget => 'الهدف (اختياري)';

  @override
  String get finrAmountInvalid => 'المبلغ غير صالح. مثال: 1,356.80';

  @override
  String get finrCardSection => 'بطاقة صندوق التبرعات على شاشة التلفاز';

  @override
  String get finrCardFigure => 'الرقم المعروض';

  @override
  String get finrFigBalance => 'الرصيد الحالي';

  @override
  String get finrFigMonth => 'تحصيل هذا الشهر';

  @override
  String get finrFigLast => 'آخر قيد';

  @override
  String finrCardHighlight(int seconds) {
    return 'إبراز القيد الجديد: $seconds ثانية';
  }

  @override
  String get finrCardShowTarget => 'إظهار شريط الهدف';

  @override
  String get finrCardQr => 'رمز QR لـ DuitNow';

  @override
  String get finrPerihalSection => 'البيانات';

  @override
  String get finrPerihalIn => 'بيان التحصيل';

  @override
  String get finrPerihalOut => 'بيان المدفوعات';

  @override
  String get finrPerihalSystemNote =>
      'البيانات المعلَّمة بالقفل تخص النظام ولا يمكن تغييرها.';

  @override
  String get finrAddPerihal => 'إضافة بيان';

  @override
  String get finrRenamePerihal => 'تغيير البيان';

  @override
  String get finrPerihalLabel => 'اسم البيان';

  @override
  String get finrPerihalNameTaken => 'اسم البيان هذا مستخدم بالفعل';

  @override
  String get finrModuleSection => 'الوحدة';

  @override
  String get finrModuleTitle => 'المالية';

  @override
  String get finrModuleHelp => 'إيقافها يخفي قائمة المالية. لا تُحذف البيانات.';

  @override
  String get finrModuleOffTitle => 'إيقاف المالية؟';

  @override
  String get finrModuleOffBody =>
      'تُخفى قائمة المالية عن جميع الأدوار. تُحفظ البيانات المالية القديمة ولا تُحذف.';

  @override
  String get finrOpeningTitle => 'الرصيد الافتتاحي';

  @override
  String get finrOpeningNone => 'لم يُدخل بعد';

  @override
  String finrOpeningDone(String date, int n) {
    return 'أُدخل $date، $n صناديق تبرعات';
  }

  @override
  String get finrSetupTitle => 'الرصيد الافتتاحي';

  @override
  String finrSetupIntro(String date) {
    return 'أدخل رصيد كل صندوق تبرعات في $date. يُسمح بـ RM 0.00. يصبح هذا الرصيد نقطة بداية السجل المالي.';
  }

  @override
  String get finrSetupNoFunds =>
      'لا توجد صناديق تبرعات بعد. أضف صندوق تبرعات أولًا في إعدادات صناديق التبرعات.';

  @override
  String get finrSetupSave => 'حفظ الرصيد الافتتاحي';

  @override
  String get finrSetupHint =>
      'بعد الحفظ لا يمكن تغيير الرصيد الافتتاحي إلا بتصحيح.';

  @override
  String get finrSetupDoneTitle => 'تم إدخال الرصيد الافتتاحي';

  @override
  String get finrSetupDoneHelp =>
      'لتغيير رصيد واحد، استخدم التصحيح على قيد الرصيد الافتتاحي.';

  @override
  String get finrOpenFinance => 'فتح المالية';

  @override
  String get offlineSessionBanner =>
      'دون اتصال: تُستخدم البيانات المحفوظة. ستتم مزامنة التغييرات تلقائيًا.';

  @override
  String get unlockCloudWaking => 'جارٍ تشغيل سحابة MAXCOM...';

  @override
  String get unlockAutoRetrying => 'تُعاد المحاولة تلقائيًا.';

  @override
  String offlinePinWrong(int left) {
    return 'رمز PIN خاطئ. بقيت $left محاولات.';
  }

  @override
  String get themeGalleryTitle => 'قوالب العرض';

  @override
  String get themeInUse => 'قيد الاستخدام';

  @override
  String get themeActive => 'نشط';

  @override
  String get themeBuiltIn => 'مدمج في MAXCOM';

  @override
  String get themeNewBadge => 'جديد';

  @override
  String get themeGroupArab => 'العربية';

  @override
  String get themeScreenArabAyat => 'آية عربية';

  @override
  String get themeScreenArabZikir => 'ذكر عربي';

  @override
  String get themeScreenArabHadis => 'حديث عربي';

  @override
  String get themeArabLooksOff =>
      'يعرض هذا القالب الآيات والأحاديث والأذكار بالشكل العادي. تُستخدم الشاشات العربية في قالب Arabic Art والقوالب التي تتضمنها.';

  @override
  String get themeArabSection => 'الكتابة العربية';

  @override
  String get themeArFont => 'الخط العربي';

  @override
  String get themeArFontHafs => 'Uthmani Hafs';

  @override
  String get themeArFontAmiriQuran => 'Amiri Quran';

  @override
  String get themeArFontAmiri => 'Amiri';

  @override
  String get themeArFontSample => 'ٱلْحَمْدُ لِلَّهِ';

  @override
  String get themeArSize => 'الحجم العربي';

  @override
  String get themeArSizeSmall => 'صغير';

  @override
  String get themeArSizeBig => 'كبير';

  @override
  String get themeHarakat => 'لون التشكيل';

  @override
  String get themeHarakatFollow => 'حسب لون النص';

  @override
  String get themeHarakatOwn => 'لون خاص';

  @override
  String get themeHarakatNote =>
      'لون التشكيل يتطلب خط Amiri Quran أو Amiri. يُعرض Uthmani Hafs بلون واحد.';

  @override
  String get themeArLine => 'تباعد الأسطر';

  @override
  String get themeArLineTight => 'متقارب';

  @override
  String get themeArLineWide => 'واسع';

  @override
  String get themeTarjamah => 'الترجمة';

  @override
  String get themeTarjamahBelow => 'أسفل';

  @override
  String get themeTarjamahBeside => 'بجانب';

  @override
  String get themeTarjamahNote =>
      'تحدد الإعدادات ما إذا كانت الترجمة تُعرض. هنا موضعها فقط.';

  @override
  String themeAll(int n) {
    return 'كل القوالب ($n)';
  }

  @override
  String get themeCustomise => 'تخصيص';

  @override
  String get themeUse => 'استخدام هذا القالب';

  @override
  String themeChangedScreens(int n) {
    return 'تم تخصيص $n شاشات.';
  }

  @override
  String get themeNeedsUpdate => 'حدّث MAXCOM في المصلى لتخصيص القوالب.';

  @override
  String get themeGalleryHint => 'اضغط قالبًا لمعاينته واختياره.';

  @override
  String get themeChosen => 'تم تغيير القالب';

  @override
  String get themeScreenBiasa => 'عادي';

  @override
  String get themeScreenAzan => 'الأذان';

  @override
  String get themeScreenMasukWaktu => 'دخول الوقت';

  @override
  String get themeScreenIqamah => 'الإقامة';

  @override
  String get themeScreenSolat => 'الصلاة';

  @override
  String get themeScreenJumaat => 'الجمعة';

  @override
  String get themeScreenLive => 'البث المباشر';

  @override
  String get themeScreenPoster => 'الملصق';

  @override
  String get themeScreenKuliah => 'الدرس';

  @override
  String get themeScreenProgram => 'البرنامج';

  @override
  String get themeScreenHadis => 'الحديث';

  @override
  String get themeScreenZikir => 'الذكر';

  @override
  String get themeScreenPengumuman => 'الإعلانات';

  @override
  String get themeScreenTakwim => 'التقويم';

  @override
  String get themeScreenTabung => 'صندوق التبرعات';

  @override
  String get themeScreenAyat => 'الآية';

  @override
  String get themeGroupPrayer => 'مواقيت الصلاة';

  @override
  String get themeGroupContent => 'المحتوى';

  @override
  String get themeBg => 'الخلفية';

  @override
  String get themeFollowTheme => 'حسب القالب';

  @override
  String get themeOwnPicture => 'صورة خاصة';

  @override
  String get themeChange => 'تغيير';

  @override
  String get themeFit => 'عرض الصورة';

  @override
  String get themeFitFull => 'كامل';

  @override
  String get themeFitStretch => 'تمديد';

  @override
  String get themeFitMedium => 'متوسط';

  @override
  String get themeFitSmall => 'صغير';

  @override
  String get themePos => 'موضع الصورة';

  @override
  String get themeLeft => 'يسار';

  @override
  String get themeCentre => 'وسط';

  @override
  String get themeRight => 'يمين';

  @override
  String get themeShade => 'عتمة الطبقة';

  @override
  String get themeShadeNote =>
      'يبقى النص واضحًا: يُقاس لون النص تلقائيًا من الصورة.';

  @override
  String get themeAccent => 'اللون الرئيسي';

  @override
  String get themeAccentTheme => '(القالب)';

  @override
  String get themeAccentOther => 'لون آخر';

  @override
  String get themeText => 'لون النص';

  @override
  String get themeTextAuto => 'تلقائي';

  @override
  String get themeTextPick => 'اختر لونًا';

  @override
  String get themeFont => 'الخط';

  @override
  String get themeSize => 'حجم النص';

  @override
  String get themeSizeNote =>
      'مقياس فوق الحجم الأساسي؛ يُختار الحجم الأساسي للحديث والآية في الإعدادات. S هو الحجم الحالي، ولا يوجد حجم أصغر ليكون واضحًا من مسافة 3 أمتار.';

  @override
  String get themeBgNote =>
      'حسب القالب: تُستخدم صورة الخلفية في الإعدادات (أو صورة القالب المرفوعة).';

  @override
  String get themeAlign => 'ترتيب المحتوى';

  @override
  String get themeGoldOutline => 'حدّ ذهبي على العنوان';

  @override
  String get themeGoldOn => 'مفعّل';

  @override
  String get themeGoldOff => 'متوقف';

  @override
  String get themeChangedBadge => 'معدَّل';

  @override
  String get themeReset => 'إعادة التعيين';

  @override
  String get themeApplyAll => 'تطبيق على جميع الشاشات';

  @override
  String themeEditTitle(String title) {
    return 'تخصيص: $title';
  }

  @override
  String themeEditScreen(String name) {
    return 'شاشة $name';
  }

  @override
  String get themeLivePreview => 'معاينة مباشرة';

  @override
  String themeApplyAllConfirm(String title) {
    return 'تطبيق شكل هذه الشاشة على جميع شاشات القالب $title؟';
  }

  @override
  String themeApplyAllReplaces(String title, int n) {
    return 'تطبيق شكل هذه الشاشة على جميع شاشات القالب $title؟ ستُحذف اختيارات $n شاشات أخرى وتُستبدل بقيم هذه الشاشة.';
  }

  @override
  String get themeResetScreen => 'إعادة تعيين هذه الشاشة';

  @override
  String themeResetScreenConfirm(String screen) {
    return 'العودة إلى شكل القالب لشاشة $screen؟';
  }

  @override
  String get themeResetAll => 'إعادة تعيين جميع الشاشات';

  @override
  String get themeFreshFailed =>
      'تعذّر تحميل أحدث القيم. لم يُحفظ شيء. أعد المحاولة.';

  @override
  String themeResetConfirm(String title) {
    return 'العودة إلى الشكل الأصلي للقالب $title؟';
  }

  @override
  String get themeDiscardTitle => 'تجاهل التغييرات غير المحفوظة؟';

  @override
  String get themeDiscard => 'تجاهل';

  @override
  String get themeKeepEditing => 'متابعة التعديل';

  @override
  String get themeSaved => 'تم حفظ نمط القالب';

  @override
  String get themePickPicture => 'اختيار صورة';

  @override
  String get themeCustomColour => 'لون خاص (#rrggbb)';

  @override
  String get themeUploadTitle => 'رفع قالب';

  @override
  String themeUploadStep(int n) {
    return 'الخطوة $n من 3';
  }

  @override
  String get themeUploadPickTitle => 'اختر ملف القالب';

  @override
  String get themeUploadPickHint => 'ملف .maxtheme، بحد أقصى 15 MB.';

  @override
  String get themeUploadPickButton => 'اختيار ملف';

  @override
  String get themeUploadChecksNote =>
      'سيفحص MAXCOM في المصلى هذا الملف: الحجم والمحتوى ونمط CSS والإصدار. لا يُثبَّت شيء قبل أن تضغط تثبيت.';

  @override
  String get themeUploadCancel => 'إلغاء';

  @override
  String get themeUploadCheck => 'فحص الملف';

  @override
  String get themeUploadChecking => 'جارٍ فحص الملف...';

  @override
  String get themeUploadValid => 'القالب صالح وجاهز للتثبيت';

  @override
  String get themeUploadNoProblems => 'لم تُكتشف مشكلات.';

  @override
  String themeUploadPreview(String screen) {
    return 'معاينة: $screen';
  }

  @override
  String get themeUploadName => 'الاسم';

  @override
  String get themeUploadVersion => 'الإصدار';

  @override
  String themeUploadVersionNew(int n) {
    return '$n (قالب جديد)';
  }

  @override
  String themeUploadVersionUpdate(int n, int m) {
    return '$n (تحديث من الإصدار $m)';
  }

  @override
  String get themeUploadBase => 'مبني على';

  @override
  String get themeUploadContract => 'العقد';

  @override
  String get themeUploadContent => 'المحتوى';

  @override
  String themeUploadContentValue(int n, String size) {
    return '$n ملفات، $size';
  }

  @override
  String get themeUploadOwnScreens => 'شاشات بنمط خاص';

  @override
  String get themeUploadInstall => 'تثبيت';

  @override
  String get themeUploadInstallAnyway => 'التثبيت رغم ذلك';

  @override
  String themeUploadWarnTitle(int n) {
    return 'يمكن تثبيته، مع $n تحذيرات';
  }

  @override
  String get themeUploadClose => 'إغلاق';

  @override
  String themeUploadInstalled(String title) {
    return 'تم تثبيت $title';
  }

  @override
  String themeUploadInstalledNote(String current) {
    return 'أصبح القالب الآن في المعرض. ما زال التلفاز يستخدم $current حتى تختار هذا القالب.';
  }

  @override
  String get themeUploadSavedNote =>
      'محفوظ في MAXCOM المصلى ومزامَن مع السحابة.';

  @override
  String get themeUploadBack => 'العودة إلى المعرض';

  @override
  String get themeUploadUseNow => 'استخدام الآن';

  @override
  String get themeUploadTooBig => 'الملف أكبر من 15 MB.';

  @override
  String get themeUploadWrongType => 'اختر ملفًا ينتهي بـ .maxtheme.';

  @override
  String get themeUploadUnreadable => 'تعذّرت قراءة الملف.';

  @override
  String get themeUploadExpired => 'انتهت صلاحية الفحص. افحص الملف مرة أخرى.';

  @override
  String themeUploadedBadge(int n) {
    return 'مرفوع، الإصدار $n';
  }

  @override
  String get themeInvalidBadge => 'قالب غير صالح';

  @override
  String get themeInvalidNote =>
      'يستخدم التلفاز القالب الأساسي لأن هذا القالب يخفي الساعة أو مواقيت الصلاة أو الشعار. صحّح ملف القالب وارفع إصدارًا جديدًا.';

  @override
  String get themeNotReady => 'لا يمكن استخدامه بعد';

  @override
  String get themeNotReadyNote =>
      'لا يمكن استخدام هذا القالب بعد: يوجد MAXCOM في المصلى يجب تحديثه أولًا.';

  @override
  String get themeCannotConfirm =>
      'تعذّر التحقق من جميع أجهزة MAXCOM في المصلى الآن. أعد المحاولة عند عودة اتصال السحابة.';

  @override
  String get themeDownloadTitle => 'تنزيل القالب';

  @override
  String get themeDownloadLine =>
      'ملف واحد للتعديل خارج MAXCOM أو للمشاركة مع مصليات أخرى.';

  @override
  String get themeFileName => 'اسم الملف';

  @override
  String get themeBake => 'تضمين تخصيصاتي';

  @override
  String themeBakeNote(int n, int m) {
    return 'سينتج الملف الشكل نفسه الظاهر الآن على تلفاز المصلى ($n شاشات معدّلة، $m صور خلفية).';
  }

  @override
  String get themeDownloadButton => 'تنزيل';

  @override
  String get themeShare => 'مشاركة';

  @override
  String get themeNameBad =>
      'الاسم غير صالح. استخدم أحرفًا صغيرة وأرقامًا وشرطة (بحد أقصى 32 حرفًا).';

  @override
  String get themeDownloaded => 'تم حفظ ملف القالب';

  @override
  String get themeDownloadFailed => 'تعذّر تجهيز ملف القالب.';

  @override
  String get themeDelete => 'حذف القالب';

  @override
  String themeDeleteConfirm(String title) {
    return 'حذف القالب $title؟ تُحفظ تخصيصاتك لهذا القالب.';
  }

  @override
  String get themeDeleteInUse =>
      'هذا القالب قيد الاستخدام. اختر قالبًا آخر أولًا.';

  @override
  String get themeDeleteBuiltIn => 'لا يمكن حذف قوالب MAXCOM المدمجة.';

  @override
  String get themeDeleted => 'تم حذف القالب';

  @override
  String get valRequired => 'مطلوب';

  @override
  String valTooLong(int max) {
    return 'طويل جدًا (الحد الأقصى $max حرفًا)';
  }

  @override
  String get valNoSpaces => 'يجب ألا يحتوي على مسافات أو رموز تحكم';

  @override
  String get valWebAddress => 'يجب أن يكون عنوان ويب صالحًا';

  @override
  String get valStartHttps => 'يجب أن يبدأ بـ https://';

  @override
  String get valNoUserInfo => 'يجب ألا يحتوي على اسم مستخدم أو كلمة مرور';

  @override
  String get valNoFragment => 'يجب ألا يحتوي على جزء #';

  @override
  String get valPublicAddress =>
      'يجب أن يكون عنوان إنترنت عامًا (وليس محليًا أو خاصًا)';

  @override
  String valRectShape(String shape) {
    return 'يجب أن يكون كائنًا $shape';
  }

  @override
  String get valUnknownField => 'حقل غير معروف';

  @override
  String get valRectNumbers => 'يجب أن تكون x و y و w و h أرقامًا';

  @override
  String get valCropInside => 'يجب أن يقع إطار القص داخل الصورة';

  @override
  String get valImageIdBad => 'معرّف الصورة غير صالح';

  @override
  String get valSquareLogoOnly => 'الإطار المربع للشعار فقط';

  @override
  String get valBgChoice => 'يجب أن تكون الخلفية keep أو remove أو card';

  @override
  String get valRotateChoice => 'يجب أن يكون الدوران 0 أو 90 أو 180 أو 270';

  @override
  String get valBool => 'يجب أن يكون مفعّلًا أو معطّلًا';

  @override
  String valOneOf(String list) {
    return 'يجب أن يكون واحدًا من: $list';
  }

  @override
  String valWholeNumber(int min, int max) {
    return 'يجب أن يكون عددًا صحيحًا من $min إلى $max';
  }

  @override
  String get valMustText => 'يجب أن يكون نصًا';

  @override
  String valMustWhat(String what) {
    return 'يجب أن يكون $what';
  }

  @override
  String get valWhatPlain => 'نصًا عاديًا';

  @override
  String get valWhatPlainNoHtml => 'نصًا عاديًا بدون رموز HTML';

  @override
  String get valWhatPhone => 'رقم هاتف مثل 012-345 6789';

  @override
  String get valWhatEmail => 'عنوان بريد إلكتروني مثل name@example.my';

  @override
  String get valWhatHttps => 'عنوان https://';

  @override
  String get valWhatValid => 'صالحًا';

  @override
  String valDecimal(int min, int max) {
    return 'يجب أن يكون رقمًا من $min إلى $max بحد أقصى 4 منازل عشرية، أو فارغًا';
  }

  @override
  String get valColourHex => 'اكتب # متبوعًا بـ 6 رموز، مثال #F6E7B8';

  @override
  String get valAudioFile => 'يجب أن يكون ملفًا صوتيًا صالحًا';

  @override
  String get valTimeValid => 'يجب أن يكون وقتًا صالحًا';

  @override
  String get valTextOrEmpty => 'يجب أن يكون نصًا أو فارغًا';

  @override
  String get valTextList => 'يجب أن يكون قائمة نصوص';

  @override
  String valItemMax(int max) {
    return 'يجب ألا يزيد العنصر عن $max حرفًا';
  }

  @override
  String get valSourceOrder => 'يجب ذكر official وcalc وfile مرة واحدة فقط';

  @override
  String valMaxImages(int max) {
    return 'الحد الأقصى $max صور';
  }

  @override
  String get valImageNames =>
      'يجب أن تكون الصور اسمًا موجودًا (a-z و 0-9 و -) أو /uploads/<اسم الملف>';

  @override
  String get valUnsupported => 'هذا الإعداد غير مدعوم';

  @override
  String get valMustObject => 'يجب أن يكون كائنًا';

  @override
  String get valUnknownSetting => 'إعداد غير معروف';

  @override
  String valSurahAyat(String name, int ayat) {
    return '$name فيها $ayat آية';
  }

  @override
  String get valAyatOrder =>
      'يجب أن تكون آية البداية قبل آية النهاية أو مساوية لها';

  @override
  String get valAyatMax => 'الحد الأقصى 3 آيات في كل عرض';

  @override
  String get valUnknownFeature => 'ميزة غير معروفة';

  @override
  String get valSettingsObject => 'يجب أن تكون الإعدادات كائنًا';

  @override
  String valAlwaysOn(String name) {
    return '$name مفعّلة دائمًا ولا يمكن إيقافها';
  }

  @override
  String get valFromBeforeTo => 'يجب أن يكون تاريخ البدء قبل تاريخ الانتهاء';

  @override
  String get valDate => 'يجب أن يكون تاريخًا صالحًا';

  @override
  String get valTimeHm => 'يجب أن يكون وقتًا صالحًا (HH:MM)';

  @override
  String get valDateTime => 'يجب أن يكون تاريخًا ووقتًا صالحين';

  @override
  String get valPickDays => 'اختر يومًا واحدًا على الأقل';

  @override
  String get valPickTz => 'اختر المنطقة الزمنية من القائمة';

  @override
  String get valUnknownKind => 'نوع محتوى غير معروف';

  @override
  String get valItemObject => 'يجب أن يكون العنصر كائنًا';

  @override
  String get valImageBad => 'صورة غير صالحة';

  @override
  String get valFitBad => 'عرض الصورة غير صالح';

  @override
  String get valChoiceBad => 'خيار غير صالح';

  @override
  String get valColourLike => 'يجب أن يكون اللون مثل #12AB34';

  @override
  String get valFontBad => 'خط غير صالح';

  @override
  String get valSizeChoice => 'يجب أن يكون الحجم S أو M أو L أو XL';

  @override
  String get valValueUnknown => 'قيمة غير معروفة';

  @override
  String get kindHintSeries => 'رمز السلسلة للدروس المتتابعة (اختياري)';

  @override
  String get kindHintPhone => 'لأعضاء اللجنة فقط، ولا يظهر على التلفاز';

  @override
  String get kindDescPengumuman => 'إعلانات للمصلّين لفترة محددة.';

  @override
  String get kindDescHadis => 'أحاديث مختارة لبطاقة الحديث على التلفاز.';

  @override
  String get errorRequestFailed => 'فشل الطلب';

  @override
  String get errorFeatureNotFound => 'الميزة غير موجودة';

  @override
  String get tvLangNeedsUpdate => 'حدّث MAX Kiosk Server لاستخدام هذا الخيار';

  @override
  String get prayerErrNotFound => 'غير موجود';

  @override
  String get prayerErrRateLimited =>
      'عمليات بحث كثيرة جدًا. أعد المحاولة بعد قليل';

  @override
  String get prayerErrOffline =>
      'يحتاج البحث عن الموقع إلى اتصال MAXCOM بالإنترنت';

  @override
  String get prayerErrUpstream =>
      'مصدر مواقيت الصلاة لا يستجيب. أعد المحاولة لاحقًا';

  @override
  String get prayerErrZonesUpstream =>
      'تعذّر تنزيل قائمة المناطق الآن. أعد المحاولة لاحقًا';

  @override
  String get prayerErrConflict => 'لم يعد بالإمكان تنفيذ هذا الإجراء';

  @override
  String get prayerErrTooLarge => 'الملف كبير جدًا. اختر ملفًا أصغر';

  @override
  String get prayerErrBadType => 'نوع الملف غير مدعوم';

  @override
  String get prayerErrUnavailable => 'الخدمة غير متاحة حاليًا';

  @override
  String get prayerErrInvalidData => 'بيانات غير صالحة';

  @override
  String get liveSignInFailed =>
      'لم ينجح تسجيل الدخول إلى YouTube. أعد المحاولة.';

  @override
  String get liveStartFailed => 'تعذّر بدء البث';

  @override
  String get liveOtherDevice => 'جهاز آخر';

  @override
  String get liveRateText =>
      'محاولات كثيرة جدًا لبدء البث. أعد المحاولة بعد قليل.';

  @override
  String get liveWarnYoutubeNotSignedIn =>
      'لم يتم تسجيل الدخول إلى YouTube في الصندوق. البث إلى شاشة المصلى يعمل.';

  @override
  String get liveWarnYoutubeOff => 'أوقف المسؤول YouTube';

  @override
  String get liveWarnYoutubeQuota => 'انتهت حصة YouTube لهذا اليوم.';

  @override
  String get liveWarnYoutubeReauth => 'يجب تجديد تسجيل الدخول إلى YouTube.';

  @override
  String get liveWarnYoutubeForbidden => 'رفض YouTube الطلب.';

  @override
  String get liveWarnCloudUnreachable => '⁨YouTube⁩: تعذّر الاتصال بالسحابة';

  @override
  String liveCamUnreachable(String name) {
    return '$name، غير متاحة';
  }

  @override
  String liveCamReady(String name) {
    return '$name، جاهزة';
  }

  @override
  String liveExtBoxPullNote(String camera) {
    return 'على iPad، يسحب صندوق MAXCOM الصورة والصوت من $camera ويرسل معاينة إلى هذا الجهاز. يصل البث المدمج في الصندوق إلى شاشة المصلى وYouTube متأخرًا ثانية إلى ثانيتين.';
  }

  @override
  String get liveExtControllerOnly =>
      'صوت الكاميرا فقط. يتحكم هذا الجهاز في البث ويعرض المعاينة؛ ولا يرسل أي صوت.';

  @override
  String get liveExtScreenLock =>
      'ضع الجهاز قرب المحاضر وأبقِ الشاشة مفتوحة. قفل الشاشة يوقف الميكروفون.';

  @override
  String get liveExtRecordingFallback =>
      'لا يُنشأ تسجيل عندما يتحكم iPad في الكاميرا الخارجية. نسخة من البث موجودة على YouTube.';

  @override
  String get liveExtSourceName => 'ميكروفون iPad';

  @override
  String liveExtMicLostCamera(String source) {
    return 'انقطع $source. يستمر البث بصوت الكاميرا.';
  }

  @override
  String liveExtMicLostSilent(String source) {
    return 'انقطع $source. يستمر البث بدون صوت.';
  }

  @override
  String get liveExtMicLostHint =>
      'يعاد توصيل الميكروفون تلقائيًا ويُضبط توقيته قبل دمجه من جديد. أبقِ شاشة iPad مفتوحة.';

  @override
  String get liveExtMicRefused =>
      'تعذّر فتح ميكروفون iPad. يستمر البث بصوت الكاميرا.';

  @override
  String get liveExtChipRealign => 'يُضبط التوقيت عند العودة';

  @override
  String get liveExtChipOnStart => 'يُضبط التوقيت عند بدء البث';

  @override
  String get liveExtChipAligned => 'متوافق';

  @override
  String get liveExtChipNotAligned => 'غير متوافق بعد';

  @override
  String get liveExtChipManual => 'إزاحة توقيت الصوت';

  @override
  String get liveExtChipAligning => 'جارٍ ضبط التوقيت';

  @override
  String liveExtAlignFailedCamera(String source) {
    return 'لم ينجح الضبط التلقائي بعد، لذلك لم يُدمج $source حتى لا يُسمع الصوت مزدوجًا. تأكد من وجود صوت داخل المصلى وأن الكاميرا تسمعه.';
  }

  @override
  String get liveExtAlignFailedSilent =>
      'لم ينجح الضبط التلقائي بعد. قد لا يتوافق الصوت مع الصورة.';

  @override
  String liveExtUseMicOnly(String source) {
    return 'استخدم $source فقط';
  }

  @override
  String liveExtCameraNoAudioMic(String source) {
    return 'هذه الكاميرا بلا صوت. يُستخدم $source وحده. اضبط «إزاحة توقيت الصوت» باختبار التصفيق.';
  }

  @override
  String get liveExtCameraNoAudioAlone =>
      'هذه الكاميرا بلا صوت. اضغط «إضافة صوت» لاختيار ميكروفون، وإلا فلن يكون للبث صوت.';

  @override
  String get liveExtAllMuted => 'كتم جميع مصادر الصوت. لا يوجد صوت في البث.';

  @override
  String get liveExtPreviewRetry => 'انقطعت المعاينة. جارٍ إعادة الاتصال...';

  @override
  String get liveOnlyEnrol => 'تسجيل جهاز جديد';

  @override
  String get liveOnlyRevoke => 'حذف جهاز';

  @override
  String get liveOnlyRevokeWhy => 'يجب أن يرى المسؤول أن الجهاز حُذف';

  @override
  String get liveOnlyAddUser => 'إضافة مستخدم';

  @override
  String get liveOnlyResetPin => 'إعادة تعيين PIN';

  @override
  String get liveOnlyAppLock => 'قفل التطبيق';

  @override
  String get liveOnlyPairDisplay => 'الموافقة على اقتران شاشة';

  @override
  String get liveOnlyYoutubeSign => 'تسجيل الدخول والخروج من YouTube';

  @override
  String get liveOnlyLive => 'البث المباشر';

  @override
  String get liveOnlyPrayerOps => 'استيراد مواقيت الصلاة وتصحيحها والبحث عنها';

  @override
  String get liveOnlyPrayerData => 'بيانات مواقيت الصلاة';

  @override
  String get liveOnlyIslamic => 'المحتوى الإسلامي';

  @override
  String get liveOnlyAnalyse => 'تحليل الصورة';

  @override
  String get liveOnlyUploadRecording => 'رفع تسجيل إلى YouTube';

  @override
  String get liveOnlySyncNow => 'المزامنة الآن';

  @override
  String get liveOnlyChangePin => 'تغيير PIN';

  @override
  String get liveOnlyReportPdf => 'تنزيل ملف PDF للتقرير';

  @override
  String get liveOnlyCountPhoto => 'عرض صورة ورقة العدّ';

  @override
  String get liveOnlyReportShared => 'تسجيل مشاركة التقرير';

  @override
  String get liveOnlyFinanceAudit => 'سجل تدقيق المالية';

  @override
  String get hadisGradeNoteSahih => 'أعلى درجة';

  @override
  String get hadisGradeNoteHasan => 'مقبول للاحتجاج به';

  @override
  String get hadisGradeNoteHasanLi => 'حسن بسبب تقوية روايات أخرى';

  @override
  String get hadisGradeNoteDhaif => 'ضعيف؛ لا يُعرض';

  @override
  String get hadisGradeNoteMaudhu => 'لا يُعرض أبدًا';

  @override
  String get valWhatThemeName =>
      'اسم قالب (a-z و 0-9 وشرطة، بحد أقصى 32 حرفًا)';

  @override
  String get valWhatReciter => 'اسم مجلد القارئ';

  @override
  String get valWhatCountry => 'رمز دولة من حرفين مثل MY';

  @override
  String get valWhatTimezone => 'منطقة زمنية مثل Asia/Kuala_Lumpur';

  @override
  String get valWhatZone => 'رمز منطقة مثل SGR01';

  @override
  String get valWhatImageOrEmpty => 'معرّف صورة أو فارغًا';

  @override
  String get valWhatFundOrEmpty => 'معرّف صندوق أو فارغًا';

  @override
  String get valWhatDateOrEmpty => 'تاريخًا بصيغة YYYY-MM-DD أو فارغًا';

  @override
  String get kindDescPenceramah => 'الأساتذة والأستاذات الذين يلقون الدروس.';

  @override
  String get kindDescKitab => 'الكتب التي تُقرأ في الدروس.';

  @override
  String get kindDescKuliah => 'جدول الدروس المعروض على التلفاز.';

  @override
  String get kindDescTicker => 'عبارات قصيرة تتحرك أسفل الشاشة.';

  @override
  String get kindDescPoster => 'صور بملء الشاشة تتناوب على التلفاز.';

  @override
  String get kindDescProgramKhas => 'فعاليات وبرامج قادمة.';

  @override
  String get kindDescTakwim => 'تواريخ مهمة في تقويم المصلى.';

  @override
  String get kindDescWorldTime => 'ساعات مدن أخرى تُعرض على التلفاز.';

  @override
  String get kindDescPetugas => 'الإمام والمؤذن وأعضاء اللجنة المناوبون.';

  @override
  String get kindDescTugasan => 'من المناوب في أي يوم.';

  @override
  String get kindDescZikir => 'أذكار بعد الصلاة بترتيب القراءة.';

  @override
  String get kindDescTilawahSlot => 'تلاوة قرآنية تُشغَّل قبل وقت الصلاة.';

  @override
  String get hadisGradeNoteSahihLi => 'صحيح بسبب تقوية روايات أخرى';

  @override
  String get trustRootMissing => 'شهادة الجذر مفقودة. سجّل من جديد';

  @override
  String get trustRootInvalid => 'شهادة الجذر غير صالحة';

  @override
  String get trustRootMismatch => 'شهادة الجذر غير مطابقة';

  @override
  String get trustCloudFailed => 'فشل الاتصال الآمن بسحابة MAXCOM.';

  @override
  String get trustBadQr => 'رمز QR للتسجيل غير صالح';

  @override
  String get trustRootFetch => 'تعذّر جلب شهادة الجذر من الصندوق';

  @override
  String get trustNoHttps => 'لا توجد شهادة HTTPS لهذا MAXCOM بعد';

  @override
  String get imageNotReadable =>
      'هذا الملف ليس صورة يمكن قراءتها. اختر ملف JPEG أو PNG أو WebP.';

  @override
  String get errcWrongPin => 'رمز PIN غير صحيح';

  @override
  String errcLocked(int minutes) {
    return 'تم قفل PIN. أعد المحاولة بعد $minutes دقيقة.';
  }

  @override
  String get errcUnlockFailed => 'لم ينجح فتح القفل. أعد المحاولة.';

  @override
  String get errcPinPolicy =>
      'يجب أن يتكون PIN من 6 أرقام وألا يكون سهل التخمين';

  @override
  String get errcPinExists => 'تم تعيين PIN لهذا المستخدم مسبقًا';

  @override
  String get errcPinRequired => 'رمز PIN مطلوب';

  @override
  String get errcPinMissing => 'لم يتم تعيين PIN بعد';

  @override
  String get errcAppLockOff => 'قفل التطبيق غير مفعّل';

  @override
  String get errcSuspended => 'هذا المصلى موقوف مؤقتًا';

  @override
  String get errcBadEnrolCode => 'رمز التسجيل غير صالح أو تم استخدامه';

  @override
  String get errcOpsAppRequired => 'استخدم تطبيق MAXCOM Ops لهذا الحساب';

  @override
  String get errcOpsCliOnly => 'يتم هذا التسجيل عبر سحابة MAXCOM فقط';

  @override
  String get errcNotOpsUser => 'ليس لهذا المستخدم دور في MAXCOM Ops';

  @override
  String get errcOpsDeviceLimit => 'بلغ هذا المستخدم حد التسجيل في MAXCOM Ops';

  @override
  String get errcNotOpsDevice => 'هذا الجهاز ليس لـ MAXCOM Ops';

  @override
  String get errcBadRequest => 'الطلب غير صالح';

  @override
  String get errcBadName => 'الاسم غير صالح';

  @override
  String get errcBadRoles => 'الأدوار غير صالحة';

  @override
  String get errcBadTtl => 'مدة صلاحية الرمز غير صالحة';

  @override
  String get errcBadDevice => 'الجهاز غير صالح';

  @override
  String get errcBadChoice => 'الاختيار غير صالح';

  @override
  String get errcUserNotFound => 'المستخدم غير موجود';

  @override
  String get errcDeviceNotFound => 'الجهاز غير موجود';

  @override
  String get errcNotFound => 'غير موجود';

  @override
  String get errcPairGone => 'انتهى اقتران هذه الشاشة أو تم استخدامه';

  @override
  String get errcBadPairCode => 'رمز الاقتران غير صحيح';

  @override
  String get errcKuliahNotFound => 'الدرس غير موجود';

  @override
  String get errcUploadNotFound => 'الرفع غير موجود';

  @override
  String get errcLastAdmin => 'يجب أن يبقى مسؤول واحد نشط على الأقل';

  @override
  String get errcLastSuperadmin =>
      'يجب أن يبقى مسؤول MAXCOM واحد نشط على الأقل';

  @override
  String get errcLastAdminDevice => 'سجّل جهاز مسؤول آخر أولًا';

  @override
  String get errcRefMismatch =>
      'معرّف المستخدم غير مطابق. افتح صفحة المستخدم مرة أخرى وأعد المحاولة';

  @override
  String get errcOwnAccount => 'لا يمكنك حذف حسابك الخاص';

  @override
  String get errcPhoneRequired => 'رقم الهاتف مطلوب';

  @override
  String get errcBadPhone => 'رقم الهاتف غير صالح';

  @override
  String get errcPhoneTaken => 'رقم الهاتف هذا مستخدم بالفعل من قبل مستخدم آخر';

  @override
  String get errcSuperadminCliOnly =>
      'يمكن إدارة هذا الدور عبر CLI الخاص بـ MAXCOM فقط';

  @override
  String get errcSuperadminCloudOnly => 'أدر مسؤولي MAXCOM عبر سحابة MAXCOM';

  @override
  String get errcSuperadminExists => 'يوجد مسؤول MAXCOM بالفعل';

  @override
  String get errcBoxOnly =>
      'يجب إنشاء رمز الجهاز في المصلى. استخدم هاتف مسؤول المصلى على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get errcNotEmpty => 'لا تزال في هذا المصلى بيانات ولا يمكن حذفه';

  @override
  String get errcModuleOff => 'هذه الوحدة غير مفعّلة';

  @override
  String get errcLiveBusy =>
      'هناك بث مباشر قيد التشغيل. أعد المحاولة بعد انتهائه.';

  @override
  String get errcBadAddress => 'عنوان الكاميرا غير صالح';

  @override
  String get errcUnknownVideo => 'هذا الفيديو ليس من بثوث هذا المصلى';

  @override
  String get ra4StopNotYet => 'لم يتوقف البث بعد. أعد المحاولة.';

  @override
  String get ra4StopRetry => 'أعد المحاولة';

  @override
  String get ra4EndedByBox => 'أنهى الصندوق البث.';

  @override
  String get ra4StillLive => 'البث ما زال مستمرًا. افتح البث المباشر لإيقافه.';

  @override
  String get ra4CameraName => 'كاميرا خارجية';

  @override
  String get ra4CameraStoppedByIpad =>
      'أوقف iPad الكاميرا. افتح هذه الشاشة مرة أخرى.';

  @override
  String get ra4CamNotRtsp => 'يجب أن يبدأ العنوان بـ rtsp://';

  @override
  String get ra4CamNotIpv4 =>
      'استخدم عنوان IPv4 للكاميرا في شبكة المصلى (مثل 10.168.1.20) وليس اسمًا.';

  @override
  String get ra4CamNotPrivate =>
      'يجب أن يكون العنوان ضمن شبكة خاصة (10.x.x.x أو 172.16 إلى 172.31 أو 10.168.x.x).';

  @override
  String get ra4CamIsBox => 'هذا عنوان صندوق MAXCOM نفسه. أدخل عنوان الكاميرا.';

  @override
  String get ra4CamBadPort => 'يجب أن يكون المنفذ رقمًا من 1 إلى 65535.';

  @override
  String get ra4CamBadLogin =>
      'يحتوي اسم المستخدم أو كلمة المرور في العنوان على حرف يجب ترميزه (اكتب @ هكذا %40).';

  @override
  String get ra4CamBadPath =>
      'يحتوي مسار العنوان على حرف غير مسموح به (مسافة أو علامة اقتباس أو #).';

  @override
  String get ra4CamTooLong => 'العنوان طويل جدًا (400 حرف على الأكثر).';

  @override
  String get errcUnusable => 'لا يمكن استخدام مدخل الصوت هذا';

  @override
  String get errcCameraError => 'تعذّرت معالجة الكاميرا';

  @override
  String get errcCameraNotConfigured => 'لم يتم إعداد كاميرا بعد';

  @override
  String get errcUnavailable => 'الخدمة غير متاحة الآن. أعد المحاولة لاحقًا.';

  @override
  String get errcBadClaim => 'تسجيل MAXCOM غير صالح';

  @override
  String get errcWorkerUnreachable =>
      'لا يستطيع MAXCOM التحقق من التسجيل الآن. أعد المحاولة.';

  @override
  String get errcClaimPending => 'بانتظار موافقة MAXCOM';

  @override
  String get errcBoxRevoked => 'تم إلغاء MAXCOM هذا من السحابة';

  @override
  String get errcYoutubeQuota =>
      'تم بلوغ الحد اليومي لـ YouTube. أعد المحاولة غدًا.';

  @override
  String get errcYoutubeReauthorise => 'يجب تسجيل الدخول إلى YouTube من جديد';

  @override
  String get errcYoutubeNotConfigured => 'لم يتم إعداد YouTube';

  @override
  String get errcYoutubeForbidden => 'رفض YouTube هذا الإجراء';

  @override
  String get errcYoutubeNotFound => 'لم يتم العثور على فيديو YouTube';

  @override
  String get errcYoutubeNetwork => 'تعذّر الاتصال بـ YouTube. أعد المحاولة.';

  @override
  String get errcYoutubeAtBox =>
      'يتم تسجيل الدخول إلى YouTube الآن على MAXCOM في المصلى. حدّث التطبيق وحاول عبر شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get errcCatchupOff => 'رفع التسجيلات إلى YouTube غير مفعّل';

  @override
  String get errcVideoMismatch => 'الفيديو لا يطابق هذا الرفع';

  @override
  String get errcUploadExpired => 'انتهت صلاحية هذا الرفع';

  @override
  String get errcTooManyUploads => 'عمليات رفع كثيرة قيد التشغيل';

  @override
  String get errcUnknownLiveVideo => 'هذا البث المباشر غير معروف';

  @override
  String get errcThemeGone => 'انتهت صلاحية الفحص. افحص الملف مرة أخرى.';

  @override
  String get errcThemeInUse => 'هذه السمة قيد الاستخدام. اختر سمة أخرى أولًا.';

  @override
  String get errcThemeBuiltIn => 'لا يمكن حذف سمة MAXCOM المضمّنة';

  @override
  String errcContentInUse(int count) {
    return 'لا يزال مستخدمًا في $count من الدروس القادمة';
  }

  @override
  String get errcAssetMissing => 'هذه الصورة لم تعد موجودة';

  @override
  String get errcHadisFull => 'تم بلوغ حد الأحاديث';

  @override
  String get errcEntryExists => 'هذا السجل موجود بالفعل';

  @override
  String get errcUncertain => 'تحقق مما إذا كان ذلك الإجراء قد تم بالفعل';

  @override
  String get liveOnlyThemeCheck => 'فحص ملف سمة';

  @override
  String get liveOnlyThemeInstall => 'تثبيت سمة';

  @override
  String get liveOnlyThemeDelete => 'حذف سمة';

  @override
  String get liveOnlyRecoveryCode => 'إنشاء رمز استرداد';

  @override
  String get liveOnlyLeave => 'مغادرة المصلى';

  @override
  String get liveOnlyLogout => 'تسجيل الخروج';

  @override
  String get errcSurauNotFound => 'المصلى غير موجود';

  @override
  String get errcSurauRequired => 'لم يُختر مصلى';

  @override
  String get errcNotRegistered =>
      'لم يتم تسجيل MAXCOM هذا أو انتهت صلاحية تسجيله';

  @override
  String get errcCodeMismatch => 'رمز المطالبة لا يطابق هذا التسجيل';

  @override
  String get errcNoWorker => 'خدمة MAXCOM غير مُعدّة على هذه السحابة بعد';

  @override
  String get errcWorker => 'تعذّر الوصول إلى خدمة MAXCOM أو رفضت الطلب';

  @override
  String get errcNotLinked => 'تم إلغاء MAXCOM هذا بالفعل';

  @override
  String get errcBadBoxName => 'يجب أن يتراوح اسم MAXCOM بين 1 و60 حرفًا';

  @override
  String get errcNotSupport => 'هذا المستخدم ليس مستخدم دعم MAXCOM';

  @override
  String get errcEsolatUnreachable =>
      'تعذّر الوصول إلى e-Solat الآن. أعد المحاولة.';

  @override
  String get errcAlreadyLinked =>
      'تم ربط MAXCOM هذا أو الموافقة عليه بالفعل. استخدم الإلغاء وليس الرفض.';

  @override
  String errcEsolatNoRecord(int year, String zone) {
    return 'لم تنشر e-Solat مواقيت الصلاة لعام $year للمنطقة $zone بعد. أعد المحاولة لاحقًا أو استورد ملف CSV.';
  }

  @override
  String errcCsvYearMismatch(int year, String from, String to) {
    return 'هذا الملف ليس لعام $year (من $from إلى $to)';
  }

  @override
  String get errcNoOfficialSource =>
      'لا يوجد مصدر رسمي لهذا البلد. استخدم ملفًا أو الحساب.';

  @override
  String errcUndoBlocked(String date, String by) {
    return 'لا يمكن التراجع عن هذا الاستيراد لأن اليوم $date تم استبداله أو تصحيحه في $by';
  }

  @override
  String get ra2Month1 => 'يناير';

  @override
  String get ra2Month2 => 'فبراير';

  @override
  String get ra2Month3 => 'مارس';

  @override
  String get ra2Month4 => 'أبريل';

  @override
  String get ra2Month5 => 'مايو';

  @override
  String get ra2Month6 => 'يونيو';

  @override
  String get ra2Month7 => 'يوليو';

  @override
  String get ra2Month8 => 'أغسطس';

  @override
  String get ra2Month9 => 'سبتمبر';

  @override
  String get ra2Month10 => 'أكتوبر';

  @override
  String get ra2Month11 => 'نوفمبر';

  @override
  String get ra2Month12 => 'ديسمبر';

  @override
  String get ra2MonthShort1 => 'يناير';

  @override
  String get ra2MonthShort2 => 'فبراير';

  @override
  String get ra2MonthShort3 => 'مارس';

  @override
  String get ra2MonthShort4 => 'أبريل';

  @override
  String get ra2MonthShort5 => 'مايو';

  @override
  String get ra2MonthShort6 => 'يونيو';

  @override
  String get ra2MonthShort7 => 'يوليو';

  @override
  String get ra2MonthShort8 => 'أغسطس';

  @override
  String get ra2MonthShort9 => 'سبتمبر';

  @override
  String get ra2MonthShort10 => 'أكتوبر';

  @override
  String get ra2MonthShort11 => 'نوفمبر';

  @override
  String get ra2MonthShort12 => 'ديسمبر';

  @override
  String get ra2Weekday1 => 'الاثنين';

  @override
  String get ra2Weekday2 => 'الثلاثاء';

  @override
  String get ra2Weekday3 => 'الأربعاء';

  @override
  String get ra2Weekday4 => 'الخميس';

  @override
  String get ra2Weekday5 => 'الجمعة';

  @override
  String get ra2Weekday6 => 'السبت';

  @override
  String get ra2Weekday7 => 'الأحد';

  @override
  String get ra2WeekdayShort1 => 'اثن';

  @override
  String get ra2WeekdayShort2 => 'ثلا';

  @override
  String get ra2WeekdayShort3 => 'أرب';

  @override
  String get ra2WeekdayShort4 => 'خمي';

  @override
  String get ra2WeekdayShort5 => 'جمع';

  @override
  String get ra2WeekdayShort6 => 'سبت';

  @override
  String get ra2WeekdayShort7 => 'أحد';

  @override
  String get ra2PrayerImsak => 'الإمساك';

  @override
  String get ra2PrayerSubuh => 'الفجر';

  @override
  String get ra2PrayerSyuruk => 'الشروق';

  @override
  String get ra2PrayerZohor => 'الظهر';

  @override
  String get ra2PrayerAsar => 'العصر';

  @override
  String get ra2PrayerMaghrib => 'المغرب';

  @override
  String get ra2PrayerIsyak => 'العشاء';

  @override
  String get ra2PrayerDhuha => 'الضحى';

  @override
  String get ra2MethodMwl => 'رابطة العالم الإسلامي';

  @override
  String get ra2MethodEgyptian => 'مصر';

  @override
  String get ra2MethodKarachi => 'كراتشي';

  @override
  String get ra2MethodUmmAlQura => 'أم القرى';

  @override
  String get ra2MethodDubai => 'دبي';

  @override
  String get ra2MethodQatar => 'قطر';

  @override
  String get ra2MethodKuwait => 'الكويت';

  @override
  String get ra2MethodMoonsighting => 'لجنة رؤية الهلال';

  @override
  String get ra2MethodSingapore => 'سنغافورة';

  @override
  String get ra2MethodTehran => 'طهران';

  @override
  String get ra2MethodTurkey => 'تركيا (ديانت)';

  @override
  String get ra2MethodNorthAmerica => 'أمريكا الشمالية (ISNA)';

  @override
  String get ra2MethodJakim => 'JAKIM 18/18';

  @override
  String get ra2MethodKemenag => 'وزارة الشؤون الدينية الإندونيسية 20/18';

  @override
  String get ra2MethodUoif => 'UOIF فرنسا 12/12';

  @override
  String get ra2MethodMorocco => 'المغرب 19/17';

  @override
  String get ra2MethodAlgeria => 'الجزائر 18/17';

  @override
  String get ra2MethodRussia => 'روسيا 16/15';

  @override
  String get ra2WarnNoDataToday => 'لا توجد بيانات مواقيت الصلاة لليوم';

  @override
  String get ra2WarnNotLocated =>
      'لم يتم تحديد موقع المصلى؛ لا يمكن حساب مواقيت الصلاة';

  @override
  String get ra2WarnEmergencyToday => 'يستخدم اليوم حسابًا مؤقتًا';

  @override
  String get ra2WarnZoneNoDataFetch =>
      'لا توجد بيانات لهذه المنطقة؛ سينزلها MAXCOM';

  @override
  String get ra2WarnZoneNoDataManual =>
      'لا توجد بيانات لهذه المنطقة؛ ارفع البيانات أو فعّل التنزيل التلقائي';

  @override
  String get ra2FieldDate => 'التاريخ';

  @override
  String ra2RowMissingColumn(String field) {
    return 'العمود $field غير موجود';
  }

  @override
  String ra2RowMasjidOnly(String field) {
    return 'العمود $field للمساجد فقط';
  }

  @override
  String ra2RowEmpty(String field) {
    return '$field فارغ';
  }

  @override
  String ra2RowInvalid(String field) {
    return '$field غير صالح';
  }

  @override
  String ra2RowOutOfRange(String field) {
    return '$field خارج الحد المسموح';
  }

  @override
  String get ra2RowDuplicate => 'تاريخ مكرر';

  @override
  String get ra2RowBeforeMidnight => 'يقع الإمساك المشتق قبل منتصف الليل';

  @override
  String get ra2RowOrder => 'الأوقات ليست مرتبة';

  @override
  String get ra2RowNoRows => 'لا توجد في الملف أي صفوف لمواقيت الصلاة';

  @override
  String get ra2RowTooMany => 'الملف يحتوي على صفوف كثيرة جدًا';

  @override
  String get ra2RowGap => 'يوجد تاريخ ناقص قبل هذا الصف';

  @override
  String get ra2CsvRecorded =>
      'تم تسجيله في سجل الاستيراد؛ يمكن التراجع عنه من هناك.';

  @override
  String get ra2NoOfficialCard =>
      'لا يوجد مصدر رسمي لهذا البلد. ارفع ملفًا أو استخدم الحساب.';

  @override
  String valRange(int min, int max) {
    return '$min إلى $max';
  }

  @override
  String contentRefDeleted(String what) {
    return '$what محذوف';
  }

  @override
  String contentInUseDates(String dates) {
    return 'التواريخ: $dates';
  }

  @override
  String get errcAlreadyVoided => 'تم إلغاء هذا القيد بالفعل';

  @override
  String get errcOpeningExists => 'لهذا الصندوق رصيد افتتاحي بالفعل';

  @override
  String get errcOpeningFundFixed =>
      'لا يمكن نقل الرصيد الافتتاحي إلى صندوق آخر';

  @override
  String get ra3MonthNames =>
      'يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر';

  @override
  String ra3LateEntries(int n) {
    return 'وصلت $n قيود بعد إغلاق هذا الشهر';
  }

  @override
  String get ra3AskAdminClose => 'اطلب من المسؤول إغلاق هذا الشهر';

  @override
  String get ra3ClosedMonthToday =>
      'شهر هذه المحاضرة مغلق. سيُسجَّل الدفع بتاريخ اليوم.';

  @override
  String get ra3DateClosedNote => 'لا يمكن اختيار شهر مغلق.';

  @override
  String get ra3LateEntriesShow => 'عرض القيود';

  @override
  String get ra5CodeUnknown => 'الرمز غير معروف';

  @override
  String get ra5CodeUnknownBody =>
      'تحقق من الرمز الذي كتبته، أو اطلب من المسؤول رمزًا جديدًا.';

  @override
  String get ra5CodeInvalid =>
      'هذا ليس رمز تسجيل MAXCOM. امسح رمز QR مرة أخرى أو الصق النص كاملًا.';

  @override
  String ra5UnlockTooMany(int minutes) {
    return 'محاولات كثيرة جدًا. حاول مرة أخرى بعد $minutes دقيقة';
  }

  @override
  String get ra5OfflineClosed =>
      'تم إغلاق الفتح دون اتصال. اتصل بـ MAXCOM للفتح.';

  @override
  String get ra5RoleSupport => 'دعم MAXCOM';

  @override
  String get ra5ListSeparator => '، ';

  @override
  String get ra5SealCheckFailed =>
      'لا يمكن التحقق من الرمز الآن. اتصل بـ MAXCOM وحاول مرة أخرى.';

  @override
  String get ra5LeaveHint =>
      'مغادرة المصلى هي الطريقة الوحيدة لحذف هذا الجهاز. يجب على آخر مسؤول تسجيل جهاز مسؤول آخر أولًا.';

  @override
  String get ra6SyncErrorChip => 'خطأ في المزامنة';

  @override
  String get ra6SyncErrorShort => 'خطأ';

  @override
  String get ra6RefusedMonthClosed => 'مرفوض: الشهر مغلق بالفعل';

  @override
  String get ra6RefusedFundArchived => 'مرفوض: الصندوق مؤرشف';

  @override
  String get ra6RefusedAlreadyVoided => 'مرفوض: القيد ملغى بالفعل';

  @override
  String get ra6RefusedOpeningExists => 'مرفوض: الرصيد الافتتاحي موجود بالفعل';

  @override
  String get ra6RefusedBlobMissing => 'الصورة لم تعد موجودة على هذا الجهاز';

  @override
  String get ra6RefusedUserInactive => 'مرفوض: المستخدم غير نشط';

  @override
  String get ra6RefusedLastAdmin => 'مرفوض: يجب أن يبقى مسؤول واحد على الأقل';

  @override
  String get ra6Rejected => 'مرفوض';

  @override
  String get ra6CopyDetails => 'نسخ التفاصيل';

  @override
  String get ra6DetailsCopied => 'تم نسخ التفاصيل';

  @override
  String ra6ConflictPartial(String names) {
    return 'لم تُحفظ بعض الإعدادات لوجود تغيير أحدث: $names';
  }

  @override
  String get ra6ConflictEntityFinance => 'قيد مالي';

  @override
  String get ra6SettingsSavedQueued =>
      'تم الحفظ على هذا الجهاز، بانتظار المزامنة';

  @override
  String get ra6AppLockNeedsBox => 'يتطلب الاتصال بـ MAXCOM';

  @override
  String ra6RangeTo(String min, String max) {
    return 'من $min إلى $max';
  }

  @override
  String ra6FeatureNeeds(String name) {
    return 'فعّل $name أولاً';
  }

  @override
  String get ra6TplLabel => 'عنوان الدرس';

  @override
  String get ra6TplSpeaker => 'المحاضر';

  @override
  String get ra6TplTopic => 'الموضوع';

  @override
  String get ra6TplBook => 'الكتاب';

  @override
  String get ra6TplSurau => 'اسم المصلى';

  @override
  String get ra6TplDate => 'التاريخ';

  @override
  String get ra6TplTime => 'الوقت';

  @override
  String get ra6LiveBadge => 'مباشر';

  @override
  String get ra6LinkCloudError => 'سحابة MAXCOM: خطأ في المزامنة';

  @override
  String get ra6LinkBoxError => 'MAXCOM في المصلى: خطأ';

  @override
  String get liveNoticeShare => 'مشاركة الرابط';

  @override
  String get liveNoticeTitle => 'إشعار البث المباشر';

  @override
  String get liveNoticeEditHint => 'راجع النص وعدّله قبل المشاركة.';

  @override
  String get liveNoticeToOne => 'إرسال إلى شخص واحد';

  @override
  String get liveNoticeReset => 'استعادة النص الأصلي';

  @override
  String get liveNoticePickTitle => 'إلى من تريد الإرسال؟';

  @override
  String get liveNoticePickSearch => 'ابحث بالاسم';

  @override
  String get liveNoticePickEmpty => 'لم يُعثر على مستخدم.';

  @override
  String get liveNoticeStarted => 'البث جارٍ.';

  @override
  String get liveNoticeShareGo => 'مشاركة';

  @override
  String get liveNoticeCardBadge => 'بث مباشر';

  @override
  String get liveNoticePictureFailed =>
      'تعذر إعداد الصورة. تمت مشاركة النص فقط.';

  @override
  String get liveNoticeCopiedCaption =>
      'تم نسخ النص، الصقه كتعليق إذا لم يظهر النص';

  @override
  String get liveNoticeQrHint =>
      'امسح الرمز بكاميرا الهاتف. سيفتح واتساب بهذه الرسالة.';

  @override
  String get liveNoticeEditDone => 'تم';

  @override
  String get liveNoticeEditText => 'تعديل النص';

  @override
  String get liveNoticeNoPicture => 'بدون صورة';

  @override
  String get liveNoticeMore => 'المزيد';

  @override
  String get liveNoticeToSelf => 'إرسال إلى نفسي';

  @override
  String get liveNoticeCopy => 'نسخ النص';

  @override
  String get liveNoticeFromPhone => 'إرسال من الهاتف';

  @override
  String get liveNoticeWhatsApp => 'مشاركة إلى واتساب';

  @override
  String get liveNoticeCopied => 'تم نسخ النص. الصقه في واتساب.';

  @override
  String get liveNoticeShareFailed => 'تعذرت مشاركة النص.';

  @override
  String liveNoticeEditedBy(String name, String time) {
    return 'عدّله $name، $time';
  }

  @override
  String get liveNoticeChangedMeanwhile =>
      'عدّل شخص آخر النص. يظهر أحدث نص، راجعه قبل المشاركة.';

  @override
  String waOpensTo(String number) {
    return 'يفتح WhatsApp مباشرة على $number';
  }

  @override
  String get liveNoticeOpenGo => 'فتح واتساب';

  @override
  String get liveNoticeWhatsAppFailed => 'تعذر فتح واتساب.';

  @override
  String get peopleNeedsUpdate => 'حدّث MAX Kiosk Server لاستخدام هذه الوظيفة';

  @override
  String get peopleFlagsBoxOnly =>
      'تظهر حالة النشاط عندما تكون على شبكة Wi-Fi الخاصة بالمصلى.';

  @override
  String get peopleNeedsAction => 'يحتاج إلى إجراء';

  @override
  String get peopleNoAdminPhone =>
      'لا يوجد مسؤول لديه هاتف نشط. سجّل هاتف مسؤول.';

  @override
  String get peopleActiveToday => 'نشط اليوم';

  @override
  String get peopleActiveYesterday => 'نشط أمس';

  @override
  String peopleActiveDaysAgo(int n) {
    return 'نشط منذ $n يوم';
  }

  @override
  String peopleUnusedDays(int n) {
    return 'غير مستخدم منذ $n يوم';
  }

  @override
  String get peopleInactiveBadge => 'غير نشط';

  @override
  String usersAllActive(int n) {
    return 'جميع المستخدمين نشطون ($n)';
  }

  @override
  String usersDeviceCount(int n) {
    String _temp0 = intl.Intl.pluralLogic(
      n,
      locale: localeName,
      other: '$n جهاز',
      two: 'جهازان',
      one: 'جهاز واحد',
      zero: 'لا توجد أجهزة بعد',
    );
    return '$_temp0';
  }

  @override
  String usersNoDeviceYet(int n) {
    return 'أُضيف منذ $n يوم ولم يُسجَّل هاتف بعد';
  }

  @override
  String get usersQrButton => 'رمز QR';

  @override
  String get usersUnlock => 'فتح القفل';

  @override
  String usersUnlocked(String name) {
    return 'تم فتح قفل PIN الخاص بـ $name. لم يتغير PIN.';
  }

  @override
  String usersLockedUntil(String time) {
    return 'PIN مقفل حتى $time. ينتهي القفل تلقائيا، أو افتحه الآن.';
  }

  @override
  String usersSuggestDeactivate(String name) {
    return 'لم يستخدم $name التطبيق منذ أكثر من 90 يوما. هل تريد إيقاف تفعيله؟';
  }

  @override
  String usersDeactivatedFold(int n) {
    return 'موقوفون ($n)';
  }

  @override
  String get usersDeactivatedHint =>
      'لا يمكنهم فتح القفل. يبقى الاسم في السجلات القديمة.';

  @override
  String usersDeactivatedOn(String date) {
    return 'أُوقف تفعيله في $date';
  }

  @override
  String usersAutoDeleteIn(int n) {
    String _temp0 = intl.Intl.pluralLogic(
      n,
      locale: localeName,
      other: 'يُحذف تلقائيا خلال $n يوم',
      two: 'يُحذف تلقائيا خلال يومين',
      one: 'يُحذف تلقائيا خلال يوم واحد',
      zero: 'يُحذف تلقائيا اليوم',
    );
    return '$_temp0';
  }

  @override
  String get usersActivate => 'إعادة التفعيل';

  @override
  String usersActivated(String name) {
    return 'تمت إعادة تفعيل $name. سجّل هاتفا برمز QR جديد.';
  }

  @override
  String get usersRecoveryFold => 'رمز الاسترداد';

  @override
  String get usersRecoveryHint =>
      'للدخول من جديد إذا فُقدت جميع هواتف المسؤولين';

  @override
  String get usersRolesFold => 'ما يمكن لكل دور فعله';

  @override
  String get usersHintDismiss => 'إغلاق';

  @override
  String get userRename => 'تغيير الاسم';

  @override
  String get userRenameTitle => 'تغيير الاسم';

  @override
  String get userRenameBody =>
      'يُستخدم الاسم الجديد من الآن في التطبيق والقوائم.';

  @override
  String get userRenameHistory =>
      'لا تتغير السجلات القديمة. يستمر سجل التغييرات والمالية في عرض الاسم المستخدم في ذلك الوقت.';

  @override
  String get userRenameSave => 'حفظ الاسم';

  @override
  String userRenamed(String name) {
    return 'تم تغيير الاسم إلى $name.';
  }

  @override
  String userNameTaken(String name) {
    return 'يوجد مستخدم باسم $name بالفعل. هل تريد الحفظ على أي حال؟';
  }

  @override
  String get nameInvalid => 'يجب أن يتكون الاسم من 1 إلى 80 حرفا';

  @override
  String userDevicesOf(String name, int n) {
    return 'أجهزة $name ($n)';
  }

  @override
  String userAddedBy(String date, String name) {
    return 'أضافه $name في $date';
  }

  @override
  String get deviceEdit => 'تعديل';

  @override
  String get deviceNameLabel => 'اسم الجهاز';

  @override
  String get deviceNameHint =>
      'مثال: هاتف الأستاذ أحمد، آيباد مكتب أمين الصندوق';

  @override
  String get deviceRenameHistory =>
      'تبقى سطور سجل التغييرات القديمة بالاسم القديم لهذا الجهاز.';

  @override
  String get deviceRenamed => 'تم حفظ اسم الجهاز.';

  @override
  String deviceOwnedBy(String name, String platform, String date) {
    return 'يملكه $name. $platform، سُجّل في $date';
  }

  @override
  String get deviceRemoveThis => 'حذف هذا الجهاز';

  @override
  String get deviceRemoveHint =>
      'لن يتمكن هذا الجهاز من فتح التطبيق بعد الآن. لاستخدامه من جديد، سجّله برمز QR جديد.';

  @override
  String devicesUnusedCard(int n) {
    return '$n جهاز غير مستخدم منذ أكثر من 60 يوما';
  }

  @override
  String get devicesUnusedHint =>
      'تبقى السجلات القديمة. يمكن لصاحبه التسجيل من جديد برمز QR جديد.';

  @override
  String get devicesRemoveAll => 'حذف الكل';

  @override
  String devicesRemoveAllConfirm(int n) {
    return 'هل تريد حذف $n جهازا غير مستخدم؟';
  }

  @override
  String devicesRemovedSome(int n, int m) {
    return 'تم حذف $n وتخطي $m';
  }

  @override
  String get devicesSkipOwn => 'هذا الجهاز نفسه';

  @override
  String get devicesSkipInUse => 'استُخدم مؤخرا';

  @override
  String get devicesSkipLastAdmin => 'هاتف المسؤول الأخير';

  @override
  String get devicesLastAdmin => 'سجّل جهاز مسؤول آخر أولا';

  @override
  String devicesOpenCodes(int n) {
    return 'رموز غير مستخدمة ($n)';
  }

  @override
  String devicesCodeExpiresIn(String device, int n) {
    return '$device، تنتهي خلال $n دقيقة';
  }

  @override
  String get devicesEndCode => 'إنهاء الرمز';

  @override
  String get devicesCodeEnded => 'تم إنهاء الرمز.';

  @override
  String get devicesRemovedNote =>
      'يختفي الجهاز المحذوف من القائمة فورا. تبقى سجلاته في سجل التغييرات.';

  @override
  String get tvBoxTitle => 'MAXCOM في المصلى';

  @override
  String tvExtraScreens(int n) {
    return 'شاشات إضافية ($n)';
  }

  @override
  String tvPairedSeen(String date, String ago) {
    return 'تم الإقران $date، شوهدت $ago';
  }

  @override
  String tvNotSeenDays(int n) {
    return 'لم تُشاهد منذ $n يوم';
  }

  @override
  String get tvPairNew => 'إقران شاشة جديدة';

  @override
  String get tvNoneWaiting => 'لا توجد شاشة في الانتظار.';

  @override
  String get tvOn => 'تعمل';

  @override
  String get devicesSkipTv => 'شاشة تلفاز';

  @override
  String get devicesSkipGone => 'لم يعد موجودا';

  @override
  String tvPaired(String date) {
    return 'تم الإقران $date';
  }

  @override
  String get tvSeenNow => 'قبل قليل';

  @override
  String tvSeenMinutes(int n) {
    return 'منذ $n دقيقة';
  }

  @override
  String tvSeenHours(int n) {
    return 'منذ $n ساعة';
  }

  @override
  String tvSeenDays(int n) {
    return 'منذ $n يوم';
  }

  @override
  String addStep(int n) {
    return 'الخطوة $n من 3';
  }

  @override
  String get addWhatRole => 'ماذا سيفعل؟';

  @override
  String get addNameHint => 'اسم يعرفه باقي أعضاء اللجنة. يمكن تغييره لاحقا.';

  @override
  String get addRoleAjk => 'للاطلاع فقط: أوقات الصلاة والمحتوى والمالية';

  @override
  String get addRoleBendahari => 'تسجيل التبرعات والمصروفات';

  @override
  String get addRoleMedia => 'الإعلانات والملصقات على شاشة التلفاز';

  @override
  String get addRoleLive => 'البث المباشر والتسجيلات';

  @override
  String get addRoleAdmin => 'كل شيء، بما في ذلك المستخدمون والأجهزة';

  @override
  String addDeviceSummary(String device, int n) {
    return '$device، الرمز صالح لمدة $n دقيقة';
  }

  @override
  String get addChangeDevice => 'تغيير اسم الجهاز أو المدة';

  @override
  String addDefaultDevice(String name) {
    return 'هاتف $name';
  }

  @override
  String get addSaveAndQr => 'حفظ وإنشاء رمز QR';

  @override
  String addSavedNoQr(String name) {
    return 'تم حفظ $name. أنشئ رمز QR عندما تكون على شبكة Wi-Fi الخاصة بالمصلى.';
  }

  @override
  String addScanTitle(String name) {
    return 'يمسح $name هذا الرمز بتطبيق MAXCOM';
  }

  @override
  String get addShare => 'مشاركة';

  @override
  String addShareConfirmTitle(String name) {
    return 'الإرسال إلى $name فقط';
  }

  @override
  String addShareConfirmBody(String name) {
    return 'ليس إلى مجموعة. يمكن لأي شخص يحمل هذا الرمز على شبكة Wi-Fi الخاصة بالمصلى الدخول باسم $name إلى أن يُستخدم الرمز.';
  }

  @override
  String addShareText(String name, String surau, int n) {
    return 'دعوة MAXCOM إلى $name في $surau. صالحة لمدة $n دقيقة ولمرة واحدة. على شبكة Wi-Fi الخاصة بالمصلى، افتح تطبيق MAXCOM واختر \"إدخال الرمز يدويًا\" والصق النص أدناه. لا تشاركه مع أي شخص آخر.';
  }

  @override
  String get addShareAdminInPerson =>
      'يجب مسح رمز المسؤول أمامك أثناء إيقاف قفل التطبيق.';

  @override
  String get addShareUnavailable =>
      'المشاركة غير متاحة على MAXCOM هذا. اعرض رمز QR.';

  @override
  String get addLockOffHint =>
      'قفل التطبيق متوقف. شغّله من الإعدادات لمزيد من الأمان.';

  @override
  String addWaiting(String name) {
    return 'في انتظار تسجيل $name';
  }

  @override
  String get addEndCode => 'إنهاء هذا الرمز';

  @override
  String addDoneTitle(String name) {
    return '$name دخل بالفعل';
  }

  @override
  String addDoneBody(String roles) {
    return 'يمكنه استخدام التطبيق بصفة $roles من الآن.';
  }

  @override
  String addDoneDevice(String platform, String time) {
    return '$platform، سُجّل $time';
  }

  @override
  String addNotTheirs(String name) {
    return 'ليس هاتف $name؟ احذف هذا الجهاز';
  }

  @override
  String addReuseWarning(int n) {
    return 'حاول شخص استخدام هذا الرمز مرة أخرى $n مرات بعد ذلك.';
  }

  @override
  String get addAnother => 'إضافة مستخدم آخر';

  @override
  String get addBackToList => 'العودة إلى القائمة';

  @override
  String get thisDeviceRename => 'تغيير اسم هذا الجهاز';

  @override
  String get liveOnlyRename => 'تغيير اسم جهاز';

  @override
  String get liveOnlyUnlock => 'فتح قفل PIN';

  @override
  String get liveOnlyCodes => 'إدارة رموز التسجيل';

  @override
  String get liveOnlyActivity => 'عرض حالة النشاط';

  @override
  String get liveOnlyDeleteUser => 'حذف مستخدم';

  @override
  String get liveOnlyRestoreUser => 'استعادة مستخدم';

  @override
  String get liveOnlyPhone => 'تغيير رقم هاتف';

  @override
  String get idLabel => 'ID';

  @override
  String get idPending => 'لا يوجد ID بعد';

  @override
  String get searchNameOrId => 'ابحث بالاسم أو ID';

  @override
  String get userDelete => 'حذف المستخدم';

  @override
  String userDeleteTitle(String name) {
    return 'هل تريد حذف $name؟';
  }

  @override
  String userDeleteBody(String name, String ref) {
    return 'لن يتمكن $name ($ref) من الدخول بعد الآن ويختفي من جميع القوائم. تُلغى جميع أجهزته ويُحذف رقم هاتفه. يحتفظ سجل التغييرات والسجلات المالية بهذا الاسم وبـ ID.';
  }

  @override
  String userDeleted(String name) {
    return 'تم حذف $name.';
  }

  @override
  String get userDeleteSelf => 'لا يمكنك حذف حسابك';

  @override
  String get userDeleteLastAdmin => 'يجب أن يبقى مسؤول نشط واحد على الأقل';

  @override
  String get userRestore => 'استعادة';

  @override
  String userRestored(String name) {
    return 'تمت استعادة $name موقوفا. أعد التفعيل وسجّل هاتفا برمز QR جديد.';
  }

  @override
  String get auditUserDeleted => 'تم حذف المستخدم';

  @override
  String get auditDeviceDeleted => 'تم حذف الجهاز';

  @override
  String get auditPhoneChanged => 'تم تغيير رقم الهاتف';

  @override
  String get autoCleanNote =>
      'تُحذف تلقائيا الأجهزة غير المستخدمة منذ 180 يوما والمستخدمون الموقوفون منذ 365 يوما. يبقى السجل التاريخي.';

  @override
  String autoCleanSoon(int n) {
    return 'يُحذف تلقائيا خلال $n يوم';
  }

  @override
  String get phoneLabel => 'رقم الهاتف';

  @override
  String get phoneLabelOptional => 'رقم الهاتف للواتساب (اختياري)';

  @override
  String get phoneNone => 'لا يوجد رقم هاتف';

  @override
  String get phoneCleared => 'تمت إزالة رقم الهاتف.';

  @override
  String get phoneHint => 'مثال: 012-000 0000';

  @override
  String get phoneInvalid =>
      'رقم الهاتف غير صالح. للأرقام خارج ماليزيا ابدأ بـ + ثم رمز الدولة.';

  @override
  String phoneTaken(String ref) {
    return 'هذا الرقم مستخدم بالفعل من قبل مستخدم آخر ($ref).';
  }

  @override
  String get phoneFill => 'أدخل الرقم';

  @override
  String get phoneDuplicate => 'رقم الهاتف نفسه لمستخدم آخر';

  @override
  String get phoneSaved => 'تم حفظ رقم الهاتف.';

  @override
  String get phoneEdit => 'تغيير الرقم';

  @override
  String get phonePrivate => 'يمكن للمسؤول وللشخص نفسه فقط رؤية هذا الرقم.';

  @override
  String waTo(String name) {
    return 'WhatsApp إلى $name';
  }

  @override
  String get waUnavailable => 'تعذر فتح WhatsApp. استخدم المشاركة.';

  @override
  String get waUnavailablePage => 'WhatsApp غير متوفر على هذا الهاتف.';

  @override
  String get shareContinue => 'متابعة';

  @override
  String userRestoreTitle(String name) {
    return 'هل تريد استعادة $name؟';
  }

  @override
  String userRestoreBody(String name, String ref) {
    return 'يعود $name ($ref) إلى القائمة موقوفا وبدون أجهزة. أعد التفعيل وسجّل هاتفا برمز QR جديد.';
  }

  @override
  String get phoneSave => 'حفظ';

  @override
  String get userDeleteHint =>
      'يختفي هذا الشخص من القائمة ولا يمكنه الدخول بعد الآن. يبقى السجل التاريخي. يمكن استعادته من سجل التغييرات.';

  @override
  String get a6Other => 'أخرى';

  @override
  String needsBoth(String first, String second) {
    return '$first و$second';
  }

  @override
  String get errVideoTooBig =>
      'الفيديو كبير جدًا. الحد الأقصى 300 ميغابايت و720p؛ قلّصه أو اقتطعه في معرض الهاتف أولًا.';

  @override
  String get errVideoTooLong =>
      'الفيديو طويل جدًا. الحد الأقصى 10 دقائق؛ اقتطعه في معرض الهاتف أولًا.';

  @override
  String get errVideoNotH264 =>
      'يجب أن يكون الفيديو بصيغة MP4 وترميز H.264. اختر فيديو آخر أو غيّر صيغته أولًا.';

  @override
  String get errVideoNoSpace =>
      'مساحة التخزين في الصندوق غير كافية. احذف فيديو قديمًا أولًا.';

  @override
  String get errVideoUploadFailed =>
      'فشل رفع الفيديو. تأكد أن الهاتف ما زال على واي فاي المصلى، ثم حاول مجددًا.';

  @override
  String get kindDescVideo =>
      'مقاطع فيديو ترفعها أو تأخذها من يوتيوب وتُعرض بملء الشاشة على التلفاز.';

  @override
  String get videoSourceLabel => 'مصدر الفيديو';

  @override
  String get videoSourceUpload => 'رفع';

  @override
  String get videoSourceYoutube => 'يوتيوب';

  @override
  String get videoSourceRakaman => 'تسجيل';

  @override
  String get videoAfterPrayerLabel => 'التشغيل بعد ذكر الصلاة';

  @override
  String get videoAfterPrayerNone => 'لا';

  @override
  String get videoAfterPrayerZohor => 'الظهر (الجمعة في يوم الجمعة)';

  @override
  String get videoAfterPrayerHint =>
      'عند الاختيار يخرج هذا الفيديو من التناوب المعتاد. يعرضه التلفاز مرة واحدة يوميا بعد شاشة أذكار تلك الصلاة، في الأيام والتواريخ المختارة.';

  @override
  String get videoPick => 'اختر فيديو من الهاتف';

  @override
  String get videoPickAgain => 'اختر فيديو آخر';

  @override
  String get videoChecking => 'جارٍ فحص الفيديو...';

  @override
  String videoCompressing(int percent) {
    return 'جارٍ تصغير الفيديو إلى 720p... $percent%';
  }

  @override
  String videoUploading(int percent) {
    return 'جارٍ الرفع إلى الصندوق... $percent%';
  }

  @override
  String get videoUploadedOk => 'تم الرفع إلى الصندوق';

  @override
  String videoPickedLine(String name, String size) {
    return '$name ($size)';
  }

  @override
  String get videoCloudNote =>
      'لا يمكن رفع الفيديو إلا عبر واي فاي المصلى. صِل الهاتف بواي فاي المصلى، أو أضف فيديو يوتيوب (ممكن من أي مكان).';

  @override
  String videoStorageLeft(String size) {
    return 'مساحة تخزين الصندوق: متبقٍ $size';
  }

  @override
  String get videoLimitsNote =>
      'الحد الأقصى 300 ميغابايت و10 دقائق و720p. اقتطعه في معرض الهاتف أولًا عند الحاجة.';

  @override
  String get videoCannotCompress =>
      'لا يستطيع هذا الهاتف تصغير الفيديو. اختر فيديو MP4 (H.264) ضمن الحدود.';

  @override
  String get videoYoutubeLink => 'رابط يوتيوب';

  @override
  String get videoYoutubeHint => 'الصق الرابط أو معرّف الفيديو';

  @override
  String get videoYoutubeBad => 'هذا ليس رابط فيديو يوتيوب.';

  @override
  String get videoYoutubeLive =>
      'هذا بث مباشر. لعرض البث المباشر على التلفاز استخدم البث المباشر. وبعد انتهائه يمكن اختيار تسجيله هنا.';

  @override
  String get videoYoutubeNote =>
      'قد تعرض فيديوهات القنوات الأخرى إعلانات أو يحذفها صاحبها. تحتاج إنترنت في المصلى؛ وبدونه يُتخطى الفيديو.';

  @override
  String get videoRakamanNote =>
      'مقطع من تسجيل درس المصلى على يوتيوب. حدّد متى يبدأ ويتوقف.';

  @override
  String get videoClipStart => 'البداية (mm:ss)';

  @override
  String get videoClipEnd => 'النهاية (mm:ss)';

  @override
  String get videoClipOrder => 'يجب أن تكون النهاية بعد البداية.';

  @override
  String get videoClipLong => 'أطول مقطع 10 دقائق.';

  @override
  String get videoNeedsFile => 'اختر فيديو وانتظر حتى يكتمل رفعه.';

  @override
  String get videoWaitUpload => 'انتظر اكتمال الرفع قبل الحفظ.';

  @override
  String get videoEstimate => 'المدة التقريبية (بالدقائق)';

  @override
  String get videoEstimateHint =>
      'لا يخبرنا يوتيوب بمدة الفيديو. أدخل مدة تقريبية (من 1 إلى 10 دقائق)؛ تنتقل الشاشة فور انتهاء الفيديو.';

  @override
  String get videoEstimateBad => 'أدخل رقمًا من 1 إلى 10.';

  @override
  String get videoCloudReadOnly =>
      'لا يمكن تعديل تفاصيل الفيديو المرفوع إلا عبر واي فاي المصلى.';

  @override
  String get videoPreview => 'معاينة';

  @override
  String get videoPreviewHint =>
      'على التلفاز: يملأ الفيديو الشاشة ويظهر اسم المصلى والساعة فوقه. بلا نص آخر.';

  @override
  String videoRowUpload(String length) {
    return 'رفع، $length';
  }

  @override
  String get videoRowYoutube => 'يوتيوب';

  @override
  String videoRowRakaman(String start, String end) {
    return 'مقطع تسجيل من $start إلى $end';
  }

  @override
  String get videoSoundOn => 'بصوت';

  @override
  String get videoExpiredSuggest =>
      'انتهى تاريخ العرض. هل تحذفه لتوفير المساحة؟';

  @override
  String get videoFileLost =>
      'الملف غير موجود على هذا الصندوق؛ يُتخطى على التلفاز.';

  @override
  String get videoFetching => 'جارٍ جلب العنوان من يوتيوب...';

  @override
  String get errcNoMicDevice => 'لم يُعثر على مدخل ميكروفون في جهاز MAXCOM.';

  @override
  String get errcMicAccessDenied =>
      'لا يسمح Windows لـ MAXCOM باستخدام مدخل الميكروفون. شغّل فحص MAXCOM.';

  @override
  String get errcMicListFailed =>
      'تعذّرت قراءة قائمة مداخل الميكروفون. حاول مرة أخرى بعد قليل.';

  @override
  String get errcMicNoTool =>
      'أداة الصوت في MAXCOM غير موجودة على هذا الجهاز، لذلك لا يمكن استخدام مدخل الميكروفون.';

  @override
  String get errcPlayLiveRunning => 'بث مباشر يعمل الآن على شاشة التلفاز.';

  @override
  String get errcPlayPrayerPhase => 'لا يمكن تشغيله أثناء وقت الصلاة.';

  @override
  String get videoPlayNow => 'تشغيل الآن';

  @override
  String get videoPlayNowDone => 'الفيديو يعمل الآن على شاشة التلفاز.';

  @override
  String get dashBoxName => 'اسم MAXCOM';

  @override
  String get boxNameRenameTitle => 'تغيير اسم MAXCOM';

  @override
  String get boxNameFollowsHint =>
      'يتبع هذا الاسم اسم المصلى ما لم تغيّره بنفسك.';

  @override
  String get phoneWhatsAppHint =>
      'يُستخدم لإرسال الإشعارات والروابط عبر واتساب. يمكن تركه فارغًا.';

  @override
  String get recKeepTitle => 'هل تريد حفظ التسجيل على هذا الجهاز؟';

  @override
  String get recKeepBody =>
      'لدى يوتيوب نسخة كاملة من هذا البث. يمكنك الاحتفاظ بالتسجيل على هذا الجهاز أو حذفه لتوفير المساحة.';

  @override
  String get recKeepKeep => 'احتفاظ';

  @override
  String get recKeepDelete => 'حذف';

  @override
  String get liveRecJoinedNote => 'تم دمج التسجيل في ملف واحد.';

  @override
  String get liveRecJoinFailedNote =>
      'تعذّر دمج التسجيل. يُحتفظ بكل جزء كما هو.';

  @override
  String get liveRecAskLaterNote =>
      'عندما يؤكد يوتيوب البث كاملًا، سيُطرح عليك سؤال عن الاحتفاظ بالتسجيل على هذا الجهاز.';

  @override
  String get liveRecKeptUnconfirmedNote =>
      'لم تتأكد نسخة يوتيوب بعد، لذلك يُحتفظ بالتسجيل على هذا الجهاز.';

  @override
  String get liveRecSavedAsk => 'هل تم حفظ التسجيل في الملفات/التنزيلات؟';

  @override
  String get liveRecSavedYes => 'نعم';

  @override
  String get liveRecSavedNo => 'ليس بعد';

  @override
  String get liveRecSavedNotYetNote =>
      'لم يُحذف شيء. يبقى التسجيل على هذا الجهاز وفي الصندوق؛ وتنتهي صلاحية النسخة في الصندوق تلقائيًا بعد 7 أيام. اضغط حفظ التسجيل مرة أخرى في أي وقت.';

  @override
  String get liveRecSaveTooBigNote =>
      'هذا الملف أكبر من أن يتحمله هذا المتصفح. لم يُحذف شيء؛ يمكن حفظ كل جزء على حدة.';

  @override
  String get liveRecJoinNeedsWifiNote =>
      'تعذّر الوصول إلى الصندوق. اتصل بشبكة Wi-Fi الخاصة بالمصلى ثم حاول مرة أخرى. يُحتفظ بكل جزء كما هو.';

  @override
  String get liveRecJoinedUntrackedNote =>
      'تم دمج التسجيل، لكن تعذّر تدوين اسمه. الملف موجود في Movies/MAXCOM.';

  @override
  String get errcMicDeviceUnavailable =>
      'تعذّر فتح مدخل الميكروفون. تأكد من توصيل الميكروفون وأنه غير مستخدم من برنامج آخر.';

  @override
  String get errcMicSilent =>
      'مدخل الميكروفون لا يرسل أي صوت. تأكد من توصيل الميكروفون وأنه غير مكتوم.';

  @override
  String get liveRecBadPieceNote =>
      'ملف التسجيل غير صالح ولم يقبله الصندوق. يُحتفظ بكل جزء كما هو.';

  @override
  String get linkTitle => 'ربط MAXCOM Kiosk Box';

  @override
  String get linkEntryIntro =>
      'اربط وحدتي MAXCOM Kiosk Box جرى إعدادهما بالفعل. تصبح إحداهما Box الرئيسي وتتبعها الأخرى.';

  @override
  String get linkCheckLan =>
      'لا يمكن ربط MAXCOM Kiosk Box إلا على شبكة الواي فاي في المصلى.';

  @override
  String get linkCheckLive => 'أوقف البث المباشر أولًا، ثم حاول مرة أخرى.';

  @override
  String get linkCheckFollower =>
      'هذا MAXCOM Kiosk Box التابع. أجرِ الربط من Box الرئيسي.';

  @override
  String get linkChoiceShow => 'عرض رمز على هذا التلفاز';

  @override
  String get linkChoiceShowSub => 'يمسح مسؤول Box الآخر الرمز بتطبيقه.';

  @override
  String get linkChoiceScan => 'مسح رمز Box آخر';

  @override
  String get linkChoiceScanSub =>
      'امسح الرمز المعروض على تلفاز Box آخر أو Box جديد.';

  @override
  String get linkPinTitle => 'أكّد برقمك السري';

  @override
  String get linkPinLabel => 'رقمك السري';

  @override
  String linkPinBodyShow(String name) {
    return 'سيعرض $name رمز الربط على التلفاز لمدة 5 دقائق.';
  }

  @override
  String linkPinBodyScan(String name) {
    return 'الرقم السري مطلوب لربط MAXCOM Kiosk Box الخاص بك مع $name.';
  }

  @override
  String get linkPinBodyAgree =>
      'الرقم السري مطلوب مرة أخرى لأنه أُدخل منذ وقت.';

  @override
  String get linkShowCode => 'إظهار الرمز';

  @override
  String linkWaitTitle(String name) {
    return 'رمز الربط على تلفاز $name';
  }

  @override
  String get linkWaitBody =>
      'اطلب من مسؤول Box الآخر مسح الرمز بتطبيق MAXCOM المتصل بـ Box الخاص به.';

  @override
  String linkWaitExpires(String time) {
    return 'ينتهي الرمز خلال $time';
  }

  @override
  String get linkWaitFact1 => 'للاستخدام مرة واحدة، صالح 5 دقائق';

  @override
  String get linkWaitFact2 =>
      'موقّع من هذا MAXCOM Kiosk Box. صورة الرمز لا تنفع بعد انتهائه.';

  @override
  String get linkWaitFact3 => 'لا تُنسخ أي بيانات حتى توافق';

  @override
  String get linkWaitClose => 'إغلاق الرمز الآن';

  @override
  String get linkCalling => 'جارٍ فحص كلا Box';

  @override
  String get linkCallingBody => 'لم تُرسل أي بيانات بعد.';

  @override
  String get linkScanHint =>
      'وجّه الكاميرا إلى رمز الربط على تلفاز Box الآخر. يجب أن يكون هذا الهاتف وكلا Box على شبكة الواي فاي نفسها في المصلى.';

  @override
  String get linkScanPasteLabel => 'الصق رمز الربط';

  @override
  String linkConfirmTitle(String name) {
    return 'الربط مع $name؟';
  }

  @override
  String get linkFingerprint => 'بصمة مفتاح ذلك MAXCOM Kiosk Box';

  @override
  String get linkConfirmBody =>
      'تأكد أن هذه البصمة هي ما تتوقعه. لا تُرسل أي بيانات قبل موافقة المسؤولين.';

  @override
  String get linkRescan => 'مسح مرة أخرى';

  @override
  String get linkStopTitle => 'توقف الربط';

  @override
  String linkStopVersion(String name, String release) {
    return 'يعمل MAXCOM Kiosk Box $name بالإصدار $release. حدّث ذلك Box ثم حاول مرة أخرى.';
  }

  @override
  String linkStopOlder(String name) {
    return 'يعمل MAXCOM Kiosk Box $name بإصدار أقدم. حدّث ذلك Box ثم حاول مرة أخرى.';
  }

  @override
  String get linkStopOlderUnnamed =>
      'أحد Box يعمل بإصدار أقدم. حدّث ذلك Box ثم حاول مرة أخرى.';

  @override
  String get linkStopNothingChanged => 'لم يتغير شيء في كلا Box.';

  @override
  String linkCodeApproveTitle(String name) {
    return 'يريد Box $name الربط';
  }

  @override
  String linkCodeApproveFacts(int users, int content) {
    return '$users مستخدمين، $content عناصر محتوى';
  }

  @override
  String linkCodeApproveBody(String name) {
    return 'قارن هذا الرمز بالرمز على هاتف مسؤول $name. يجب أن يتطابقا.';
  }

  @override
  String get linkCodeNewBoxBody =>
      'قارن هذا الرمز بالرمز على تلفاز MAXCOM Kiosk Box الجديد. يجب أن يتطابقا.';

  @override
  String get linkApprove => 'موافق';

  @override
  String get linkReject => 'رفض';

  @override
  String get linkSameCode => 'الرمز متطابق';

  @override
  String get linkCodeNoData =>
      'لم تُنسخ أي بيانات بعد. بعد الموافقة تجيب عن سؤالين.';

  @override
  String get linkCodeShowTitle => 'أرِ هذا الرمز لمسؤول Box الآخر';

  @override
  String linkWaitingApproval(String name) {
    return 'في انتظار موافقة مسؤول $name';
  }

  @override
  String get linkCodeMismatchTitle => 'الرمز غير متطابق؟';

  @override
  String get linkCodeMismatch => 'اضغط إلغاء. ربما يحاول Box آخر الربط.';

  @override
  String get linkBoxThis => 'هذا Box';

  @override
  String linkBoxThisNamed(String name) {
    return '$name (هذا Box)';
  }

  @override
  String get linkQIntroTitle => 'تم الاتصال، لم يتغير أي شيء';

  @override
  String linkQIntro(String a, String b) {
    return '$a و$b يعرف كل منهما الآخر الآن. أجب عن الأسئلة أدناه. يرى المسؤول الآخر الإجابات نفسها ويضغط موافق، وهذا يبدأ الربط.';
  }

  @override
  String get linkQ1Title => 'بيانات أي MAXCOM Kiosk Box تبقى؟';

  @override
  String get linkQ1Hint => 'تُستبدل بيانات Box الآخر.';

  @override
  String get linkQ2Title => 'أي MAXCOM Kiosk Box يصبح الرئيسي؟';

  @override
  String get linkQ2Hint =>
      'يحتفظ Box الرئيسي بالبيانات ويتصل بالسحابة ويوتيوب ويرسل نسخة إلى Box التابع خلال ثوانٍ. تُدار الهواتف والآيباد عبر Box الرئيسي فقط.';

  @override
  String get linkQ3Title => 'هواتف مستخدمي Box الآخر';

  @override
  String linkQ3Hint(String name) {
    return 'أشخاص $name الذين لديهم هاتف، سواء استُبدلت بياناتهم أو نُقلت إلى Box الرئيسي.';
  }

  @override
  String get linkQ3Direct => 'الاتصال مباشرة بـ Box الرئيسي';

  @override
  String get linkQ3DirectHint =>
      'كل من لديه هاتف، بمن فيهم المسؤولون، يتصل بـ Box الرئيسي بنفسه دون رمز انضمام. وافق المسؤولان كلاهما برمز PIN.';

  @override
  String get linkQ3Code => 'طلب رمز انضمام للمسؤولين';

  @override
  String get linkQ3CodeHint =>
      'يتصل الآخرون بأنفسهم. يحتاج المسؤولون إلى رمز انضمام من مسؤول في Box الرئيسي.';

  @override
  String get linkFactContent => 'المحتوى';

  @override
  String linkFactContentValue(int content, int posters, int videos) {
    return '$content عناصر، $posters ملصقات، $videos فيديو';
  }

  @override
  String get linkFactFinance => 'السجلات المالية';

  @override
  String get linkFactPeople => 'المستخدمون';

  @override
  String get linkFactLastEdit => 'آخر تعديل';

  @override
  String get linkNoEdit => 'لا تعديلات';

  @override
  String get linkFactDevice => 'الجهاز';

  @override
  String get linkFactStorage => 'المساحة الفارغة';

  @override
  String get linkFactYoutube => 'يوتيوب';

  @override
  String get linkFactCloud => 'سحابة MAXCOM';

  @override
  String get linkYes => 'نعم';

  @override
  String get linkNo => 'لا';

  @override
  String get linkDeviceWindows => 'حاسوب Windows';

  @override
  String get linkDeviceAndroid => 'Box أندرويد';

  @override
  String get linkDeviceOther => 'MAXCOM Kiosk Box';

  @override
  String get linkConnCable => 'سلكي';

  @override
  String get linkConnWifi => 'Wi-Fi';

  @override
  String get linkRecommended => 'موصى به';

  @override
  String linkAdvice(String name, String hardware) {
    return 'الموصى به: $name ($hardware)';
  }

  @override
  String get linkFixedNew => 'MAXCOM Kiosk Box الجديد لا يحتوي على بيانات';

  @override
  String linkFixedFollowers(String name) {
    return 'لدى $name Box تابع بالفعل، لذلك يبقى MAXCOM Kiosk Box الرئيسي وتبقى بياناته.';
  }

  @override
  String get linkCaseXOff =>
      'في هذا الإصدار يجب أن يكون MAXCOM Kiosk Box الرئيسي هو الذي تبقى بياناته.';

  @override
  String get linkCrossTitle => 'البيانات وBox الرئيسي مختلفان';

  @override
  String linkCrossBody(String kept, String master, String other) {
    return 'تُنسخ بيانات $kept مرة واحدة إلى $master ثم يصبح $master MAXCOM Kiosk Box الرئيسي. ويصبح $other Box التابع.';
  }

  @override
  String get linkReplacedTitle => 'ما سيُستبدل';

  @override
  String linkReplacedLine(
    String name,
    int content,
    int posters,
    int videos,
    int finance,
    String kept,
  ) {
    return 'ستُستبدل بيانات $name: $content عناصر، $posters ملصقات، $videos فيديو، $finance سجلات مالية. وتبقى بيانات $kept.';
  }

  @override
  String linkReplacedNone(String kept) {
    return 'لا شيء يُستبدل. تبقى كل بيانات $kept.';
  }

  @override
  String linkBackupLine(String time) {
    return 'يُؤخذ نسخ احتياطي لكلا MAXCOM Kiosk Box أولًا: $time. يمكن فك الربط في أي وقت، ويمكن لكل Box العودة إلى هذه النسخة.';
  }

  @override
  String linkFinanceTick(String name) {
    return 'أفهم أن السجلات المالية لـ $name لن تُدمج. وقد صدّرت التقرير عند الحاجة.';
  }

  @override
  String linkFinanceCount(int n, String name) {
    return 'تبقى $n سجلات مالية لـ $name في النسخة الاحتياطية.';
  }

  @override
  String get linkFinanceFirst => 'ضع علامة على تأكيد السجلات المالية أولًا.';

  @override
  String get linkMore => 'تفاصيل أخرى';

  @override
  String linkMorePeople(int a, String nameA, int b, String nameB) {
    return 'يُدمج مستخدمو كلا Box: $a في $nameA و$b في $nameB.';
  }

  @override
  String linkMoreYoutubeKept(String name) {
    return 'يوتيوب: يبقى تسجيل الدخول في $name.';
  }

  @override
  String get linkMoreYoutubeAgain =>
      'يوتيوب: تحتاج إلى تسجيل الدخول مرة أخرى بعد الربط.';

  @override
  String get linkMoreCloud => 'السحابة: يحدّث Box الرئيسي النسخة السحابية.';

  @override
  String get linkMoreCamera =>
      'كاميرا المصلى: تتبع إعدادات الكاميرا البيانات التي تبقى.';

  @override
  String get linkMoreBrowser =>
      'تحتاج شاشات المتصفح إلى اقتران جديد بعد الربط.';

  @override
  String linkAgreeButton(String kept, String master) {
    return 'موافق: إبقاء بيانات $kept ويصبح $master Box الرئيسي';
  }

  @override
  String linkWaitingFor(String name) {
    return 'في انتظار $name';
  }

  @override
  String linkNameAgreed(String name) {
    return '$name: موافق';
  }

  @override
  String linkNameNotYet(String name) {
    return '$name: لم يوافق بعد';
  }

  @override
  String get linkAnswersChangeable =>
      'يمكنك تغيير الإجابات حتى يوافق المسؤولان.';

  @override
  String get linkStaleNotice =>
      'غيّر المسؤول الآخر الاختيارات. راجعها ووافق مرة أخرى.';

  @override
  String get linkProgressTitle => 'الربط قيد التنفيذ';

  @override
  String get linkProgressStarting => 'يبدأ الربط';

  @override
  String linkProgressStep(int n, int total, String name) {
    return 'الخطوة $n من $total: $name';
  }

  @override
  String linkProgressStepPercent(int n, int total, String name, int percent) {
    return 'الخطوة $n من $total: $name، $percent%';
  }

  @override
  String get linkProgressNote =>
      'لا تُطفئ أيًّا من Box. تُرفض التعديلات حتى يكتمل الربط.';

  @override
  String get linkStepBackup => 'نسخ البيانات احتياطيًا';

  @override
  String get linkStepPeople => 'دمج المستخدمين';

  @override
  String get linkStepCommit => 'إتمام الربط';

  @override
  String get linkStepFinish => 'إنهاء الربط';

  @override
  String get linkStepWorking => 'ربط MAXCOM Kiosk Box';

  @override
  String get linkDoneTitle => 'اكتمل الربط';

  @override
  String get linkDoneBody =>
      'كلا MAXCOM Kiosk Box مرتبطان الآن. تُدار الإعدادات والمحتوى من Box الرئيسي.';

  @override
  String linkDoneMaster(String master, String other) {
    return 'أصبح $master MAXCOM Kiosk Box الرئيسي ويتبعه $other.';
  }

  @override
  String get linkDoneBackup =>
      'حُفظت النسختان الاحتياطيتان لكلا Box. يمكن فك الربط في أي وقت.';

  @override
  String get linkDoneNext =>
      'مستخدمو Box التابع: انضموا إلى Box الرئيسي برمز الانضمام ثم عيّنوا رقمًا سريًا جديدًا.';

  @override
  String get linkDoneList => 'عرض شاشات التلفاز وMAXCOM Kiosk Box';

  @override
  String get linkDoneClose => 'تم';

  @override
  String get linkFailedTitle => 'أُلغي الربط';

  @override
  String linkFollowerTitle(String name) {
    return 'يُدار مصلاك الآن من MAXCOM Kiosk Box الرئيسي $name.';
  }

  @override
  String get linkFollowerTitleNoName =>
      'يُدار مصلاك الآن من MAXCOM Kiosk Box الرئيسي.';

  @override
  String get linkCodePinRequired => 'أدخل رقمك السري للمتابعة.';

  @override
  String get linkCodeWrongPin => 'الرقم السري غير صحيح. حاول مرة أخرى.';

  @override
  String get linkCodeLocked => 'الرقم السري مقفل مؤقتًا. حاول لاحقًا.';

  @override
  String get linkCodeWrongStep => 'تغيرت هذه الخطوة. تم تحديث الشاشة.';

  @override
  String get linkCodeWrongSide => 'هذا الزر لمسؤول Box الآخر.';

  @override
  String get linkCodeSessionOpen =>
      'هناك ربط جارٍ على هذا MAXCOM Kiosk Box. ألغِه أو انتظر حتى ينتهي.';

  @override
  String get linkCodeNoHttps =>
      'ليس لدى هذا MAXCOM Kiosk Box اتصال آمن (HTTPS) بعد، لذلك لا يمكن ربطه.';

  @override
  String get linkCodeLinkLocked =>
      'محاولات ربط فاشلة كثيرة. حاول مرة أخرى بعد ساعة.';

  @override
  String get linkCodeBadQr => 'هذا ليس رمز ربط صالحًا لـ MAXCOM Kiosk Box.';

  @override
  String get linkCodeSameBox =>
      'هذا Box الخاص بك. امسح الرمز على تلفاز Box الآخر.';

  @override
  String get linkCodeCodeUsed => 'استُخدم هذا الرمز من قبل. اطلب رمزًا جديدًا.';

  @override
  String get linkCodeCodeExpired => 'انتهى هذا الرمز. اطلب رمزًا جديدًا.';

  @override
  String get linkCodePeerUnreachable =>
      'تعذّر الوصول إلى MAXCOM Kiosk Box الآخر. تأكد أن كلا Box على شبكة الواي فاي نفسها في المصلى.';

  @override
  String get linkCodePeerRefused =>
      'لم يقبل Box الآخر الطلب. راجع وحاول مرة أخرى.';

  @override
  String get linkCodeBadHello =>
      'MAXCOM Kiosk Box الذي أجاب ليس Box الموجود في الرمز. لم يستمر الربط.';

  @override
  String get linkCodeVersion =>
      'يجب أن يعمل كلا MAXCOM Kiosk Box بالإصدار نفسه. حدّث Box الأقدم ثم حاول مرة أخرى.';

  @override
  String get linkCodeBothHaveFollowers =>
      'لدى كلا MAXCOM Kiosk Box أجهزة تابعة بالفعل. لا يمكن ربط Box الرئيسي إلا بـ Box ليس لديه أجهزة تابعة.';

  @override
  String get linkCodeBothNew =>
      'لم يُعدّ أي من MAXCOM Kiosk Box. جهّز Box واحدًا أولًا.';

  @override
  String get linkCodeFixedAnswer => 'لا يمكن تغيير هذه الإجابة لهذين Box.';

  @override
  String get linkCodeKeepNewBox =>
      'MAXCOM Kiosk Box الجديد ليس لديه بيانات لإبقائها.';

  @override
  String get linkCodeFinanceTick =>
      'ضع علامة على أنك تفهم أن السجلات المالية لا تُدمج.';

  @override
  String get linkCodeRejected => 'رُفض الربط.';

  @override
  String get linkCodeLinking => 'الربط قيد التنفيذ. حاول بعد قليل.';

  @override
  String get linkCodeNotFound => 'لم يُعثر على ذلك MAXCOM Kiosk Box.';

  @override
  String get linkCodeBadMessage => 'الإجابة غير صالحة. حاول مرة أخرى.';

  @override
  String get linkCodeUnknown => 'تعذّر متابعة الربط. حاول مرة أخرى.';

  @override
  String get linkOutcomeFailed =>
      'تعذّر إتمام الربط. افحص كلا Box ثم حاول مرة أخرى.';

  @override
  String get linkOutcomeCancelled => 'ألغيت الربط. لم يتغير شيء.';

  @override
  String get linkOutcomeCancelledByPeer =>
      'ألغى مسؤول Box الآخر الربط. لم يتغير شيء.';

  @override
  String get linkOutcomeRejectedByPeer =>
      'رفض مسؤول Box الآخر الربط. لم يتغير شيء.';

  @override
  String get linkOutcomeExpired =>
      'انتهى الوقت قبل اكتمال الربط. لم يتغير شيء.';

  @override
  String get linkOutcomeApproveTimeout =>
      'لم تتم الموافقة على الرمز خلال دقيقتين. لم يتغير شيء.';

  @override
  String get linkOutcomeRestart =>
      'أُعيد تشغيل Box أثناء الربط. لم يتغير شيء؛ ابدأ الربط من جديد.';

  @override
  String get tvsTitle => 'شاشات التلفاز وMAXCOM Kiosk Box';

  @override
  String get tvsIntro =>
      'MAXCOM Kiosk Box رئيسي واحد للمصلى كله. تُضبط الإعدادات والمحتوى مرة واحدة وتتبعها كل الشاشات خلال ثوانٍ.';

  @override
  String tvsCount(int a, int b) {
    return '$a من $b شاشات متصلة';
  }

  @override
  String get tvsSectionBoxes => 'MAXCOM Kiosk Box';

  @override
  String get tvsSectionBrowsers => 'شاشات المتصفح';

  @override
  String get tvsMainBox => 'Box الرئيسي';

  @override
  String get tvsFollowerBox => 'Box التابع';

  @override
  String get tvsBrowserScreen => 'شاشة متصفح';

  @override
  String tvsRoleLine(String role, String version) {
    return '$role، الإصدار $version';
  }

  @override
  String get tvsConnected => 'متصل';

  @override
  String tvsAwaySince(String when) {
    return 'لا اتصال منذ $when';
  }

  @override
  String get tvsNeverSeen => 'لم يتصل بعد';

  @override
  String tvsNotSeenSince(String date) {
    return 'لم يُشاهد منذ $date';
  }

  @override
  String get tvsRemoveStaleBody =>
      'الإزالة: يُفرَّغ هذا MAXCOM Kiosk Box بما في ذلك نسخته الاحتياطية. إذا أُعيد تشغيل هذا Box وكان لا يزال يتبع، فإنه يُفرِّغ نفسه.';

  @override
  String tvsLinkedOn(String date) {
    return 'رُبط في $date';
  }

  @override
  String get tvsRemoved => 'أُزيل';

  @override
  String tvsRemovedOn(String date) {
    return 'أُزيل في $date';
  }

  @override
  String get tvsOpenSettings => 'إعدادات هذه الشاشة';

  @override
  String get tvsRemove => 'إزالة';

  @override
  String tvsRemoveTitle(String name) {
    return 'إزالة $name؟';
  }

  @override
  String get tvsRemoveBody =>
      'الإزالة: يُفرَّغ هذا MAXCOM Kiosk Box بما في ذلك نسخته الاحتياطية.';

  @override
  String tvsRemovedToast(String name) {
    return 'أُزيل $name.';
  }

  @override
  String get tvsLinkOther => 'ربط MAXCOM Kiosk Box آخر';

  @override
  String get tvsOlderBox =>
      'هذا MAXCOM Kiosk Box لا يدعم الربط بعد. حدّثه أولًا.';

  @override
  String get tvsEmpty => 'لا توجد شاشات للعرض.';

  @override
  String get tvEdTitle => 'إعدادات هذه الشاشة';

  @override
  String tvEdFor(String name) {
    return 'لـ $name فقط. تتبع الشاشات الأخرى إعدادات المصلى.';
  }

  @override
  String get tvEdName => 'اسم الشاشة';

  @override
  String get tvEdFollows => 'يتبع المصلى';

  @override
  String get tvEdChanged => 'تغيّر';

  @override
  String get tvEdReset => 'إعادة ضبط';

  @override
  String get tvEdLiveSection => 'البث المباشر';

  @override
  String get tvEdShow => 'عرض البث على هذه الشاشة';

  @override
  String get tvEdShowYes => 'عرض';

  @override
  String get tvEdShowNo => 'لا يُعرض';

  @override
  String get tvEdShowOn => 'تُعرض كاميرا الدرس';

  @override
  String get tvEdShowOff => 'تبقى الشاشة على العرض المعتاد';

  @override
  String get tvEdSound => 'صوت البث';

  @override
  String get tvEdSoundYes => 'بصوت';

  @override
  String get tvEdSoundNo => 'بدون صوت';

  @override
  String get tvEdSoundOn => 'الصوت من هذه الشاشة';

  @override
  String get tvEdSoundOff => 'صورة فقط (لتفادي الصدى)';

  @override
  String get tvEdVolume => 'مستوى صوت البث';

  @override
  String get tvEdDisplay => 'العرض';

  @override
  String get tvEdTemplate => 'القالب';

  @override
  String get tvEdTemplatePickTitle => 'القالب لهذه الشاشة';

  @override
  String get tvEdTemplatePickHint =>
      'اختر قالبًا لهذه الشاشة فقط أو اتبع المصلى.';

  @override
  String get tvEdLang => 'لغة الشاشة';

  @override
  String get tvEdLangAuto => 'تلقائي';

  @override
  String get tvEdLangMs => 'Bahasa Melayu';

  @override
  String get tvEdLangEn => 'English';

  @override
  String get tvEdLangAr => 'العربية';

  @override
  String get tvEdContent => 'المحتوى';

  @override
  String get tvEdHide => 'الأنواع المخفية على هذه الشاشة';

  @override
  String get tvEdHideNone => 'لا شيء؛ تُعرض كل الأنواع';

  @override
  String get tvEdHideHint =>
      'اضغط للإخفاء على هذه الشاشة. يبقى المحتوى ظاهرًا على الشاشات الأخرى. لا يمكن إخفاء أوقات الصلاة والأذان والإقامة.';

  @override
  String get tvEdSounds => 'أصوات الشاشة';

  @override
  String get tvEdBeeps => 'تنبيهات أوقات الصلاة';

  @override
  String get tvEdBeepsSub => 'قبل الأذان والإقامة';

  @override
  String get tvEdAzan => 'الأذان';

  @override
  String get tvEdAzanSub => 'يُشغَّل على هذه الشاشة';

  @override
  String get tvEdAzanOffSub => 'لا يُشغَّل (شاشة قريبة تشغّله)';

  @override
  String get tvEdTilawah => 'التلاوة';

  @override
  String get tvEdTilawahSub => 'قبل الفجر ويوم الجمعة';

  @override
  String get tvEdOn => 'تشغيل';

  @override
  String get tvEdOff => 'إيقاف';

  @override
  String get tvEdSaved => 'حُفظت إعدادات الشاشة.';

  @override
  String get tvKindKuliah => 'المحاضرات';

  @override
  String get tvKindPengumuman => 'الإعلانات';

  @override
  String get tvKindTicker => 'النص المتحرك';

  @override
  String get tvKindPoster => 'الملصقات';

  @override
  String get tvKindVideo => 'الفيديو';

  @override
  String get tvKindProgramKhas => 'البرامج الخاصة';

  @override
  String get tvKindTakwim => 'التقويم';

  @override
  String get tvKindHadis => 'الأحاديث';

  @override
  String get tvKindWorldTime => 'أوقات العالم';

  @override
  String get tvKindTugasan => 'المهام';

  @override
  String get tvKindZikir => 'الأذكار';

  @override
  String get tvKindTabung => 'صندوق المصلى';

  @override
  String backupLine(String time, String size) {
    return 'نسخة احتياطية قبل الربط: $time، $size';
  }

  @override
  String get backupDrop => 'حذف النسخة الاحتياطية';

  @override
  String get backupDropTitle => 'حذف النسخة الاحتياطية؟';

  @override
  String backupDropBody(String date) {
    return 'بعد ذلك لا يمكن لهذا Box العودة إلى بيانات $date.';
  }

  @override
  String get backupWordDrop => 'حذف';

  @override
  String backupConfirmLabel(String word) {
    return 'اكتب $word للتأكيد';
  }

  @override
  String backupKeptLine(String date) {
    return 'يمكن تغيير هذا الاختيار حتى $date';
  }

  @override
  String get backupKeptDrop => 'حذف البيانات القديمة';

  @override
  String get backupKeptDropTitle => 'حذف البيانات القديمة؟';

  @override
  String backupKeptDropBody(String size) {
    return 'تُحذف البيانات القديمة ($size) ولا يمكن استرجاعها.';
  }

  @override
  String get backupRestore => 'العودة إلى البيانات قبل الربط';

  @override
  String get backupRestoreTitle => 'العودة إلى البيانات قبل الربط؟';

  @override
  String backupRestoreBody(String date) {
    return 'تعود البيانات إلى حالة $date. يُعاد تشغيل هذا Box. تبقى هواتف المسؤولين تعمل، وتنضم الهواتف الأخرى إليه من جديد برمز QR من المسؤول.';
  }

  @override
  String get backupWordRestore => 'استعادة';

  @override
  String get backupDroppedToast => 'حُذفت النسخة الاحتياطية.';

  @override
  String get backupKeptDroppedToast => 'حُذفت البيانات القديمة.';

  @override
  String get backupRestoredToast =>
      'يُعاد تشغيل هذا Box. يجب أن ينضم كل هاتف إليه من جديد.';

  @override
  String get linkCodeHasFollowers =>
      'لا يزال لدى هذا Box أجهزة تابعة. أزلها أولًا.';

  @override
  String get linkCodeKeptExists =>
      'ما زالت البيانات القديمة محفوظة. احذفها أولًا.';

  @override
  String get linkCodeOtherVolume =>
      'النسخة الاحتياطية على وحدة تخزين أخرى ولا يمكن استعادتها هنا.';

  @override
  String get linkCodeConfirmRequired => 'اكتب كلمة التأكيد أولًا.';

  @override
  String get linkCodeNoBackup => 'لا توجد نسخة احتياطية بعد الآن.';

  @override
  String linkCodeKeptData(String date) {
    return 'البيانات القديمة محفوظة حتى $date. احذف البيانات القديمة لتربط الآن.';
  }

  @override
  String get linkCodeKeptDataNoDate =>
      'البيانات القديمة ما زالت محفوظة. احذف البيانات القديمة لتربط الآن.';

  @override
  String get liveViewersTitle => 'الشاشات التي تعرض البث';

  @override
  String get liveViewerPlaying => 'تعرض';

  @override
  String get liveViewerConnecting => 'تتصل';

  @override
  String get liveViewerOff => 'لا تعرض البث';

  @override
  String get peopleTabScreens => 'التلفاز وBox';

  @override
  String get linkPeopleTitle => 'المستخدمون بعد الربط';

  @override
  String linkPeopleAdded(int count, String box) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'عدد الأشخاص المضافين من $box: $count',
      one: 'أُضيف شخص واحد من $box',
    );
    return '$_temp0';
  }

  @override
  String linkPeopleAddedNone(String box) {
    return 'لا يوجد أشخاص جدد من $box للإضافة.';
  }

  @override
  String get linkPeopleSameTitle => 'الشخص نفسه (رقم الهاتف نفسه)';

  @override
  String get linkPeopleSameHint =>
      'هم في كلا Box ويُذكرون مرة واحدة فقط. تبقى أدوارهم في Box المحتفظ به.';

  @override
  String get linkPeopleRolesTitle => 'أدوار مختلفة';

  @override
  String linkPeopleRoleHead(String name, String phone4) {
    return '$name، الهاتف المنتهي بـ $phone4';
  }

  @override
  String linkPeopleRoleStays(String roles) {
    return 'يبقى: $roles';
  }

  @override
  String linkPeopleRoleOther(String box, String roles) {
    return 'في $box: $roles';
  }

  @override
  String linkPeopleRoleAddLabel(String box) {
    return 'إضافة دور واحد من $box:';
  }

  @override
  String get linkPeopleRoleChangeNote =>
      'هذا الاختيار يُنشئ مراجعة جديدة. تُلغى موافقة المسؤولَين ويجب إعطاؤها من جديد.';

  @override
  String get linkPeopleNoRole => 'بلا دور';

  @override
  String get linkPeopleNamesTitle => 'الاسم نفسه';

  @override
  String linkPeopleNameAsk(String name, String box, String keptName) {
    return 'لـ $name في $box الاسم نفسه الذي لـ $keptName، لكن رقم الهاتف لا يطابق.';
  }

  @override
  String get linkPeopleSameYes => 'الشخص نفسه';

  @override
  String get linkPeopleSameNo => 'شخص مختلف';

  @override
  String get linkPeopleAdminsTitle => 'المسؤولون بعد الربط';

  @override
  String get linkPeopleAdminsNone => 'لا يوجد مسؤولون';

  @override
  String linkPeopleTickets(int n) {
    String _temp0 = intl.Intl.pluralLogic(
      n,
      locale: localeName,
      other: 'سيُطلب من $n هاتفًا الاتصال بـ Box الرئيسي',
      two: 'سيُطلب من هاتفين الاتصال بـ Box الرئيسي',
      one: 'سيُطلب من هاتف واحد الاتصال بـ Box الرئيسي',
      zero: 'لن يُطلب من أي هاتف الاتصال بـ Box الرئيسي',
    );
    return '$_temp0';
  }

  @override
  String get linkCodePeopleAnswer =>
      'لم تعد اختيارات المستخدمين تناسب القوائم. راجع قسم المستخدمين أعلاه.';

  @override
  String moveAskTitle(String master) {
    return 'يُدار مصلاك الآن من MAXCOM Kiosk Box الرئيسي $master. هل تتصل الآن؟';
  }

  @override
  String get moveAskBody =>
      'نقرة واحدة، ثم حدّد رمز PIN جديدًا. لا تحتاج إلى رمز انضمام.';

  @override
  String get moveConnect => 'اتصل الآن';

  @override
  String get moveLater => 'لاحقًا';

  @override
  String get moveChecking => 'جارٍ فحص Box الخاص بك';

  @override
  String movePinBody(String master) {
    return 'حدّد رمز PIN جديدًا لـ $master. لا يُنقل رمز PIN القديم.';
  }

  @override
  String moveWorking(String master) {
    return 'جارٍ الاتصال بـ $master';
  }

  @override
  String moveDone(String master) {
    return 'أنت الآن متصل بـ $master.';
  }

  @override
  String get moveDoneButton => 'متابعة';

  @override
  String get moveNeedCodeTitle => 'مطلوب رمز انضمام';

  @override
  String moveNeedCode(String master) {
    return 'اطلب رمز انضمام من مسؤول $master.';
  }

  @override
  String get moveNeedCodeNoName => 'اطلب رمز انضمام من المسؤول.';

  @override
  String get moveAway =>
      'افتح التطبيق على شبكة Wi-Fi المصلى مرة واحدة للاتصال بـ Box الرئيسي';

  @override
  String get moveTooMany => 'محاولات كثيرة. حاول مرة أخرى بعد قليل.';

  @override
  String get moveWrongBox =>
      'الـ Box الذي ردّ ليس Box الرئيسي المذكور. لم يتغيّر شيء.';

  @override
  String get moveBadPointer =>
      'تعذّرت قراءة ردّ Box القديم. حاول مرة أخرى أو اطلب رمز انضمام من المسؤول.';

  @override
  String get moveRetry => 'حاول مرة أخرى';

  @override
  String get moveJoinScan => 'مسح رمز الانضمام';

  @override
  String get moveJoinPaste => 'لصق الرمز';

  @override
  String get moveJoinHint =>
      'ينشئ مسؤول الصندوق الرئيسي رمز الانضمام في المستخدمون والأجهزة. امسح رمز QR هذا أو الصق نصه.';

  @override
  String get moveJoinCodeLabel => 'رمز الانضمام';

  @override
  String get moveBannerTitle => 'الاتصال بالصندوق الرئيسي';

  @override
  String get moveBannerBody =>
      'يُدار مصلّاك الآن من الصندوق الرئيسي. اتصل لمواصلة استخدام التطبيق.';

  @override
  String get openByNameTitle => 'افتح عبر اسم MAXCOM';

  @override
  String openByNameBody(String origin) {
    return 'قد يتغيّر عنوان IP الخاص بـ MAXCOM. إذا سُجّل هذا الـ iPad أو الحاسوب عبر عنوان IP، فسيلزم تسجيله مجددًا عند تغيّر العنوان. افتح $origin وامسح هذا الرمز مرة أخرى هناك.';
  }

  @override
  String openByNameButton(String host) {
    return 'افتح $host';
  }

  @override
  String get openByNameKeepIp => 'المتابعة بعنوان IP';

  @override
  String openByNameDeviceBody(String origin) {
    return 'سُجّل هذا الجهاز عبر عنوان IP. إذا تغيّر عنوان MAXCOM فلن يمكن استخدام هذا التسجيل بعد الآن. للإبقاء عليه، افتح $origin وسجّل هذا الجهاز هناك.';
  }

  @override
  String get liveDestUnconfirmed => 'لم يتم التأكد من MAXCOM بعد';

  @override
  String get liveDestSaving => 'جارٍ حفظ الاختيار';

  @override
  String get liveDestPerBoxNote =>
      'يُحفظ هذا الاختيار لهذا MAXCOM Kiosk Box فقط. يستخدم كل MAXCOM Kiosk Box قناته الخاصة على YouTube.';

  @override
  String get liveDestRecUnavailable => 'التسجيل: غير متاح';

  @override
  String get liveMineTitle => 'بثك ما زال جاريًا';

  @override
  String get liveMineResume => 'استئناف';

  @override
  String get liveMineStillSending => 'ما زال البث يُرسل من هذا الهاتف';

  @override
  String get liveStoppedCameraLost =>
      'أُوقف البث بسبب انقطاع الكاميرا الخارجية';

  @override
  String get liveStoppedByBox => 'أُوقف البث من قِبل MAXCOM';

  @override
  String get liveStoppedByAdmin => 'أُوقف البث من قِبل المسؤول';

  @override
  String get liveVideoPathLabel => 'يُؤخذ الفيديو بواسطة';

  @override
  String get liveVideoPathDevice => 'هذا الهاتف';

  @override
  String get liveVideoPathBox => 'MAXCOM Kiosk Box';

  @override
  String get liveVideoPathBoxNote =>
      'الهاتف يتحكم في البث فقط. التسجيل على الهاتف غير متاح.';

  @override
  String get liveCamCtlTitle => 'التحكم بالكاميرا';

  @override
  String get liveCamCtlBrightness => 'السطوع';

  @override
  String get liveCamCtlBrightnessDown => 'تقليل السطوع';

  @override
  String get liveCamCtlBrightnessUp => 'زيادة السطوع';

  @override
  String get liveCamCtlPosition => 'الموضع';

  @override
  String get liveCamCtlHome => 'الأصلي';

  @override
  String get liveCamCtlTracking => 'التتبع التلقائي';

  @override
  String get liveCamCtlSent => 'تم إرسال الأمر إلى الكاميرا';

  @override
  String get liveCamCtlConfirmed => 'استجابت الكاميرا';

  @override
  String get liveCamCtlFailed => 'لم يصل الأمر إلى الكاميرا';

  @override
  String get liveCamCtlAllow => 'السماح بالتحكم بالكاميرا';

  @override
  String get liveCamCtlAllowNote =>
      'فقط للكاميرات التي تدعم التحكم عبر الشبكة.';

  @override
  String get liveCamCtlApply => 'تطبيق إعدادات الكاميرا';

  @override
  String get liveCamCtlFocus => 'التركيز';

  @override
  String get liveCamCtlFocusContinuous => 'مستمر';

  @override
  String get liveCamCtlFocusSingle => 'مرة واحدة';

  @override
  String get liveCamCtlFocusManual => 'يدوي';

  @override
  String get liveCamCtlTrackingOff => 'إيقاف';

  @override
  String get liveCamCtlTrackingHuman => 'شخص';

  @override
  String get liveCamCtlApplyOnLive => 'التطبيق عند بدء البث';

  @override
  String get liveCamCtlProfileTitle => 'إعدادات الكاميرا';

  @override
  String get liveCameraHeavyWarn =>
      'بث الكاميرا أكبر مما يناسب YouTube. اخفضه في الكاميرا إلى 720p، من 3 إلى 4 Mbps.';

  @override
  String get liveRecNoBoxPullStart =>
      'التسجيل غير معروض لأن الفيديو يُؤخذ بواسطة MAXCOM Kiosk Box. هذا الهاتف لا يستقبل صورة الكاميرا، فلا يوجد ما يُسجَّل على الهاتف. للتسجيل، اختر «يُؤخذ الفيديو بواسطة: هذا الهاتف».';

  @override
  String get liveRecNoBoxPullSummary =>
      'لم يُسجَّل هذا البث على الهاتف لأن الفيديو أُخذ بواسطة MAXCOM Kiosk Box وليس بواسطة هذا الهاتف. إذا تم اختيار YouTube فهناك نسخة من البث على YouTube.';

  @override
  String liveCameraInUseBy(String device, String since) {
    return 'الكاميرا مستخدمة حاليًا من قِبل $device منذ $since.';
  }

  @override
  String liveCameraInUseByBox(String since) {
    return 'الكاميرا مستخدمة حاليًا من قِبل MAXCOM Kiosk Box منذ $since.';
  }

  @override
  String get liveCameraJoinNote =>
      'يعرض هذا الهاتف الصورة نفسها عبر MAXCOM ولا يتصل بالكاميرا مباشرة.';

  @override
  String get errcCameraInUse =>
      'الكاميرا مستخدمة من قِبل جهاز آخر. تُشارَك الصورة عبر MAXCOM.';

  @override
  String get liveWarnWeakPhoneWifi =>
      'إشارة Wi-Fi في الهاتف ضعيفة. قد تتقطع الصورة.';

  @override
  String get errcResumeMismatch =>
      'البث الجاري لا يطابق هذه الاختيارات. أوقف ذلك البث أولًا، ثم ابدأ من جديد.';

  @override
  String get errcYoutubeLiveNotEnabled =>
      'البث المباشر غير مفعّل بعد في قناة YouTube هذه.';

  @override
  String get errcBoxClockWrong =>
      'ساعة MAXCOM غير صحيحة. صحّح الساعة وحاول مرة أخرى.';

  @override
  String get errcYoutubeBusyOtherBox =>
      'YouTube مستخدم حاليًا من قِبل MAXCOM Kiosk Box آخر.';

  @override
  String get errcTooManyViewers =>
      'تم بلوغ الحد الأقصى لشاشات عرض البث المباشر';

  @override
  String get errcYoutubeBroadcastOpen =>
      'لم يُغلق بث YouTube بعد. حاول مرة أخرى بعد بضع دقائق.';

  @override
  String get errcAlreadyUploading => 'تسجيل هذا البث يُرفع حاليًا من جهاز آخر.';

  @override
  String get liveNotifStop => 'إيقاف البث';

  @override
  String get syncBoxFailed => 'تعذّرت المزامنة مع MAXCOM';

  @override
  String get settingsChangedElsewhereNow =>
      'تم تغيير هذه الإعدادات للتو في جهاز آخر';

  @override
  String get settingsReload => 'إعادة التحميل';

  @override
  String get settingsMaybeStale => 'قد لا تكون محدّثة';

  @override
  String get cameraResetBody =>
      'ستُعاد الخيارات المتقدمة إلى الوضع الافتراضي. تبقى الكاميرا مفعّلة.';

  @override
  String get cameraFoundByPort => 'أجهزة تستجيب على منفذ الكاميرا';

  @override
  String get uploadReasonNoBox => 'تعذّر الاتصال بـ MAXCOM';

  @override
  String get uploadAwaitingConfirm => 'بانتظار التأكيد';

  @override
  String get uploadErrorEmptyFile => 'ملف التسجيل فارغ';

  @override
  String get uploadEarlierEntry => 'رفع تسجيل سابق';

  @override
  String liveGapReplaceAsk(int minutes) {
    String _temp0 = intl.Intl.pluralLogic(
      minutes,
      locale: localeName,
      other:
          'انقطع البث الأخير لمدة $minutes دقيقة. هل تريد استبداله بالتسجيل الكامل؟',
      two: 'انقطع البث الأخير لمدة دقيقتين. هل تريد استبداله بالتسجيل الكامل؟',
      one: 'انقطع البث الأخير لمدة دقيقة واحدة. هل تريد استبداله بالتسجيل الكامل؟',
    );
    return '$_temp0';
  }

  @override
  String get liveGapReplaceYes => 'استبدال';

  @override
  String get liveGapReplaceNo => 'لا';

  @override
  String get liveYoutubeSignOutOtherBoxes =>
      'يجب إعادة ربط وحدات MAXCOM Kiosk Box الأخرى التي تستخدم حساب YouTube هذا.';

  @override
  String get errcYoutubeClientRefused =>
      'رفضت Google ملف عميل YouTube. تواصل مع مسؤول MAXCOM.';

  @override
  String get errcUploadAbandoned => 'أُلغي هذا الرفع';

  @override
  String get liveStoppedUnattended =>
      'أُوقف البث لأن اتصال الهاتف بـ MAXCOM انقطع لأكثر من 10 دقائق';

  @override
  String get liveWarnCameraH265 =>
      'الكاميرا ترسل فيديو H.265 ولا يمكن بثه عبر MAXCOM. غيّر الكاميرا إلى H.264.';

  @override
  String get unlinkTitle => 'فصل الربط';

  @override
  String unlinkSheetTitle(String name) {
    return 'فصل الربط: $name';
  }

  @override
  String get unlinkSheetLineFollower =>
      'سيعمل هذا Box بمفرده من جديد. اختر البيانات التي سيستخدمها بعد ذلك.';

  @override
  String unlinkSheetLineMaster(String name) {
    return 'سيعمل $name بمفرده. اختر البيانات التي سيستخدمها هذا Box بعد ذلك.';
  }

  @override
  String unlinkEligibleAny(String name) {
    return 'لا يوجد مسؤول سابق نشط لـ $name. ستُعيَّن مسؤولًا عن $name.';
  }

  @override
  String unlinkPhoneNote(String name) {
    return 'بعد ذلك يغادر هذا الهاتف Box الرئيسي وينضم إلى $name. ستعيّن هناك رقمًا سريًا جديدًا.';
  }

  @override
  String unlinkAnsweredBy(String name) {
    return 'أجاب: $name';
  }

  @override
  String unlinkChoiceBack(String date) {
    return 'العودة إلى البيانات قبل الربط (نسخة احتياطية في $date)';
  }

  @override
  String get unlinkChoiceBackNoDate => 'العودة إلى البيانات قبل الربط';

  @override
  String get unlinkChoiceBackNote =>
      'يعود هذا Box كما كان في ذلك التاريخ. التغييرات بعد ذلك لن تكون على هذا Box.';

  @override
  String get unlinkChoiceCarry => 'المتابعة بالبيانات الحالية بشكل منفصل';

  @override
  String get unlinkChoiceCarryNoteFollower =>
      'يحتفظ هذا Box بالمحتوى والإعدادات الحالية ويصبح مصلى مستقلًا.';

  @override
  String get unlinkChoiceCarryNoteMaster =>
      'يحتفظ هذا Box بالبيانات الحالية. لا يتغير شيء على هذا Box.';

  @override
  String get unlinkChoiceEmpty => 'إفراغ هذا Box (العودة إلى شاشة الإعداد)';

  @override
  String get unlinkChoiceEmptyNote =>
      'يُفرَّغ هذا Box ويبدأ من جديد في شاشة الإعداد.';

  @override
  String unlinkNumChanges(int n, String date) {
    return '$n تغييرًا منذ $date لن تكون على هذا Box بعد ذلك.';
  }

  @override
  String get unlinkNumNoChanges => 'لا تغييرات منذ إنشاء النسخة الاحتياطية.';

  @override
  String get unlinkNumKept7 => 'تُحفظ البيانات الحالية 7 أيام أخرى ثم تُحذف.';

  @override
  String unlinkNumPeopleLead(String date) {
    return 'تعود قائمة المستخدمين كما كانت في $date.';
  }

  @override
  String unlinkNumPeopleBack(int n, String names) {
    return '$n أشخاص حُذفوا بعد ذلك سيعودون: $names.';
  }

  @override
  String unlinkNumPeopleAbsent(int n, String names) {
    return '$n أشخاص أُضيفوا بعد ذلك لن يكونوا موجودين: $names.';
  }

  @override
  String unlinkNumFinance(int n) {
    return 'تبقى $n قيود مالية في Box الرئيسي. يبدأ هذا Box بدفتر فارغ.';
  }

  @override
  String get unlinkTickLabel => 'أفهم أن السجلات المالية تبقى في Box الرئيسي.';

  @override
  String unlinkNumVideos(int n) {
    return '$n مقاطع فيديو لا تتسع ولن تُنسخ:';
  }

  @override
  String unlinkVideoLine(String title, String size) {
    return '$title ($size)';
  }

  @override
  String unlinkRemovePeople(String name, int n) {
    return 'حذف المستخدمين الذين جاؤوا من $name ($n أشخاص)';
  }

  @override
  String get unlinkYoutubeKept =>
      'YouTube: يحتفظ هذا Box بتسجيل الدخول الذي يستخدمه.';

  @override
  String get unlinkYoutubeReturns =>
      'YouTube: يعود تسجيل الدخول الموجود في النسخة الاحتياطية إلى هذا Box.';

  @override
  String get unlinkYoutubeSignIn =>
      'YouTube: سجّل الدخول مرة أخرى على هذا Box.';

  @override
  String get unlinkYoutubeNone =>
      'YouTube: لا يوجد تسجيل دخول. سجّل الدخول بنفسك على هذا Box (يستغرق نحو دقيقة).';

  @override
  String get unlinkAgree => 'موافق';

  @override
  String get unlinkChangeAnswer => 'تغيير إجابتي';

  @override
  String get unlinkConfirmTitle => 'أكّد هذا الاختيار';

  @override
  String get unlinkConfirmBody =>
      'يترك هذا الاختيار تغييرات خلفه. تُحفظ البيانات المتروكة 7 أيام ثم تُحذف.';

  @override
  String get unlinkAgreePinBody => 'أدخل رقمك السري للموافقة.';

  @override
  String get unlinkWord => 'فصل';

  @override
  String get unlinkSideFollower => 'Box التابع';

  @override
  String get unlinkSideMaster => 'Box الرئيسي';

  @override
  String get unlinkStartBody =>
      'يسأل كل MAXCOM Kiosk Box مسؤوله عمّا سيحدث لبياناته. لا يتغير شيء حتى يوافق الاثنان.';

  @override
  String unlinkStartPhoneNote(String name) {
    return 'المسؤول الذي يجيب عن $name يغادر Box الرئيسي بهاتفه وينضم إلى $name.';
  }

  @override
  String get unlinkStartTimeNote =>
      'إذا لم يجب أحد خلال 20 دقيقة فلا يتغير شيء ويبقى الربط.';

  @override
  String get unlinkStartButton => 'ابدأ';

  @override
  String get unlinkStartPinBody => 'أدخل رقمك السري للبدء.';

  @override
  String get unlinkWaitingTitle => 'بانتظار المسؤول الآخر';

  @override
  String get unlinkWaitingBody =>
      'حُفظت إجابتك. يُفصل الربط بعد موافقة المسؤول الآخر. لا يتغير شيء قبل ذلك.';

  @override
  String get unlinkWaitingOther =>
      'يجيب مسؤول آخر على هاتفه. لا يتغير شيء حتى يوافق الجميع.';

  @override
  String get unlinkProgressTitle => 'جارٍ فصل الربط';

  @override
  String get unlinkProgressStarting => 'العمل يبدأ';

  @override
  String get unlinkProgressNote =>
      'لا تُطفئ أيًّا من MAXCOM Kiosk Box حتى ينتهي العمل.';

  @override
  String get unlinkStepCopy => 'نسخ البيانات إلى Box التابع';

  @override
  String get unlinkStepBack => 'استعادة البيانات قبل الربط';

  @override
  String get unlinkStepCarryOn => 'حفظ البيانات الحالية';

  @override
  String get unlinkStepEmpty => 'إفراغ Box';

  @override
  String get unlinkStepJoin => 'بانتظار انضمام الهاتف إلى Box التابع';

  @override
  String unlinkJoinTitle(String name) {
    return 'الاتصال بـ $name';
  }

  @override
  String unlinkJoinBody(String name) {
    return 'هذا الهاتف يتبع الآن $name. عيّن رقمًا سريًا جديدًا للانضمام إليه. يكتمل فصل الربط بعد ذلك.';
  }

  @override
  String unlinkJoinWaitTitle(String name) {
    return 'بانتظار هاتف مسؤول $name';
  }

  @override
  String get unlinkJoinWaitBody =>
      'يكتمل فصل الربط بعد أن ينضم المسؤول إلى ذلك Box بهاتفه ويعيّن رقمًا سريًا. يواصل ذلك Box العمل بمفرده في هذه الأثناء.';

  @override
  String get unlinkDoneTitle => 'فُصل الربط';

  @override
  String unlinkDoneBody(String name) {
    return '$name يعمل الآن بمفرده.';
  }

  @override
  String get unlinkFailedTitle => 'لم يُفصل الربط';

  @override
  String get unlinkKeptSection => 'البيانات القديمة بعد فصل الربط';

  @override
  String get unlinkKeptNone => 'لا توجد بيانات قديمة محفوظة.';

  @override
  String unlinkKeptMasterRow(String name) {
    return 'Box الرئيسي، بعد مغادرة $name';
  }

  @override
  String unlinkKeptFollowerRow(String name) {
    return '$name';
  }

  @override
  String get unlinkKeptChosenBack => 'الاختيار: العودة إلى البيانات قبل الربط';

  @override
  String get unlinkKeptChosenCarry => 'الاختيار: المتابعة بالبيانات الحالية';

  @override
  String get unlinkSwitch => 'تغيير الاختيار';

  @override
  String get unlinkSwitchTitle => 'تغيير الاختيار؟';

  @override
  String unlinkSwitchBodyToBack(String date) {
    return 'يعود هذا Box إلى البيانات قبل الربط. تُحفظ البيانات الحالية حتى $date.';
  }

  @override
  String unlinkSwitchBodyToCarry(String date) {
    return 'يتابع هذا Box بالبيانات الحالية. تُحفظ النسخة الاحتياطية حتى $date.';
  }

  @override
  String get unlinkSwitchedToast => 'تم تغيير الاختيار. هذا Box يعمل الآن.';

  @override
  String get unlinkDropBody => 'تُحذف البيانات القديمة ولا يمكن استعادتها.';

  @override
  String get unlinkCodeOpen => 'هناك عملية فصل ربط قيد التنفيذ.';

  @override
  String get unlinkCodeNotLinked => 'هذا Box لم يعد مرتبطًا.';

  @override
  String get unlinkCodeNotAllowed =>
      'لا يمكنك الإجابة عن هذا Box. يجيب مسؤول آخر.';

  @override
  String get unlinkCodeSamePhone => 'لا يمكن لهاتف واحد أن يجيب عن كلا Box.';

  @override
  String get unlinkCodeOptionUnavailable => 'هذا الاختيار غير متاح لهذا Box.';

  @override
  String get unlinkCodeStaleSession =>
      'تغيّر فصل الربط هذا أو انتهى. حُدّثت الشاشة.';

  @override
  String get unlinkCodeKeptOver => 'انتهى وقت تغيير الاختيار.';

  @override
  String get unlinkCodeNoKept => 'لا توجد بيانات قديمة محفوظة.';

  @override
  String get unlinkCodeNotLocal =>
      'لا يمكن تنفيذ هذا إلا على شاشة الصيانة في ذلك Box نفسه.';

  @override
  String get unlinkCodeWrongCode => 'رمز الاستعادة غير صحيح.';

  @override
  String get unlinkCodeHasBackup =>
      'لدى هذا Box نسخة احتياطية. استخدم العودة إلى البيانات قبل الربط.';

  @override
  String unlinkKeptMasterNamed(String master, String follower) {
    return '$master، بعد مغادرة $follower';
  }

  @override
  String unlinkKeptListLine(String date) {
    return 'البيانات القديمة محفوظة حتى $date';
  }

  @override
  String get unlinkVideosNotFitTitle =>
      'هذه المقاطع لا تتسع في ذلك Box ولن تُنسخ:';

  @override
  String get unlinkJoinStay => 'ابقَ هنا';

  @override
  String unlinkJoinStayNote(String master, String follower) {
    return 'إذا بقيت هنا، يُسجَّل خروج هذا الهاتف من $master بعد انضمام $follower. اختر اتصل الآن لمواصلة إدارة $follower بهذا الهاتف.';
  }

  @override
  String get linkRecoveryTitle => 'احفظ هذا الرمز';

  @override
  String get errcSurauAsleep =>
      'يجري تحديث نسخة هذا المصلى في السحابة من MAXCOM Kiosk Box. حاول مرة أخرى بعد قليل.';

  @override
  String get liveYoutubeLaterButton => 'البث على YouTube';

  @override
  String get liveYoutubeLaterHint =>
      'هذا البث يذهب إلى شاشة المصلى فقط. يمكنك إضافة YouTube الآن.';

  @override
  String get liveYoutubeLaterStarting => 'جارٍ تشغيل YouTube';

  @override
  String get liveYoutubeLaterNotSignedIn =>
      'لم يُربط YouTube بهذا الـ MAXCOM. اربط حساب YouTube من الإعدادات أولًا.';

  @override
  String get liveYoutubeLaterNotOwner =>
      'فقط الجهاز الذي بدأ هذا البث أو المسؤول يمكنه إضافة YouTube إليه.';

  @override
  String get liveYoutubeLaterBusy =>
      'جارٍ تشغيل YouTube بالفعل. حاول مرة أخرى بعد قليل.';

  @override
  String get liveRecNoSpaceNote =>
      'لا توجد مساحة كافية على MAXCOM لدمج التسجيل. احفظ التسجيلات القديمة أو احذفها أولًا. يُحتفظ بكل جزء كما هو.';

  @override
  String get uploadErrorClaimLost =>
      'أُوقف الرفع لأن جهازًا آخر تولّى هذا البث. لا حاجة لأي إجراء.';

  @override
  String get liveYoutubeLaterSheetTitle => 'البث على YouTube';

  @override
  String get liveYoutubeLaterTitleLabel => 'العنوان على YouTube';

  @override
  String get liveYoutubeLaterPrivacyLabel => 'الظهور';

  @override
  String get liveYoutubePrivacyPrivate => 'خاص';

  @override
  String get liveYoutubePrivacyUnlisted => 'غير مدرج';

  @override
  String get liveYoutubePrivacyPublic => 'عام';

  @override
  String get liveYoutubeLaterConfirm => 'ابدأ البث الآن';

  @override
  String get liveYoutubeLaterConfirmNote =>
      'سيبدأ البث بالظهور على YouTube بهذا العنوان وهذا الظهور.';

  @override
  String get liveYoutubeLaterUpdateBox => 'حدّث MAXCOM لاستخدام هذه الميزة.';

  @override
  String get liveYoutubeLaterNoSession =>
      'انتهى هذا البث بالفعل. ابدأ بثًا جديدًا.';

  @override
  String get liveYoutubeLaterBadRequest =>
      'العنوان أو الظهور غير صالح. تحقق وحاول مرة أخرى.';

  @override
  String get liveYoutubeLaterYoutubeOff =>
      'تم إيقاف YouTube في إعدادات هذا الـ MAXCOM.';

  @override
  String get liveYoutubeLaterToolsMissing =>
      'أدوات بث YouTube غير مثبتة على هذا الـ MAXCOM بعد.';

  @override
  String get liveYoutubeLaterNoInternet =>
      'لا يوجد اتصال بالإنترنت على MAXCOM. حاول مرة أخرى بعد قليل.';

  @override
  String get liveYoutubeLaterPrivacyNotAllowed =>
      'هذا الظهور أكثر انفتاحًا مما تسمح به إعدادات المصلى. اختر خيارًا أكثر تقييدًا.';

  @override
  String unlinkJoinWebBody(String name) {
    return 'أنت تستخدم متصفح الويب. افتح تطبيق الويب الخاص بـ $name للانضمام إليه. هناك تختار اسم الجهاز ورقمًا سريًا جديدًا.';
  }

  @override
  String unlinkJoinWebOpen(String name) {
    return 'افتح تطبيق $name';
  }

  @override
  String get unlinkJoinWebTrust =>
      'قد يطلب المتصفح منك الوثوق بذلك الـ MAXCOM مرة واحدة. اقبل ثم تابع.';

  @override
  String get unlinkJoinWebFailed =>
      'تعذر على المتصفح فتح ذلك التطبيق. حاول مرة أخرى.';

  @override
  String unlinkJoinUnreachable(String name) {
    return 'لا يستطيع هذا الهاتف الوصول إلى $name. تحقق من اتصال الشبكة وحاول مرة أخرى.';
  }

  @override
  String get unlinkNumBackRecovery =>
      'تبقى هواتف المسؤولين تعمل. تنضم الهواتف الأخرى من جديد برمز QR من أحد المسؤولين. لا حاجة إلى رمز الاسترداد إلا إذا لم يبق أي هاتف مسؤول.';

  @override
  String get unlockUseRecoveryCode => 'استخدم رمز الاسترداد';

  @override
  String get unlockRecoveryHint =>
      'لا يوجد مسؤول يستطيع الدخول إلى هذا الـ MAXCOM. امسح رمز QR للاسترداد على شاشة تلفاز MAXCOM، ثم أدخل رمز الاسترداد المكتوب على الورق.';

  @override
  String get linkKeptOtherBox =>
      'تلك البيانات القديمة محفوظة على الـ MAXCOM الآخر. احذف البيانات القديمة هناك بهاتف مسؤوله لتربط الآن.';

  @override
  String get liveCtlNoVideo =>
      'لا يُعرض الفيديو على هذا الجهاز. شاهده على التلفاز أو على YouTube.';

  @override
  String get liveCtlCloseApp => 'أغلق تطبيق الكاميرا (OBSBOT) أثناء البث.';

  @override
  String get liveCtlCloseAppWhy =>
      'قارئان للكاميرا يخفضان الصورة إلى 4 إلى 6 إطارات في الثانية.';

  @override
  String get liveCtlLevels => 'مستويات الصوت';

  @override
  String liveCtlStartedBy(String name, String device, String time) {
    return 'بدأه $name من $device، $time';
  }

  @override
  String liveCtlStartedByNoDevice(String name, String time) {
    return 'بدأه $name، $time';
  }

  @override
  String get liveCtlTvsSub => 'شاشات المصلى عبر واي فاي المصلى';

  @override
  String get liveCtlTvsWaiting => 'تُعرض بطاقة الانتظار';

  @override
  String get liveCtlTvsOff => 'شاشات المصلى متوقفة لهذا البث';

  @override
  String get liveCtlYtWaiting => 'بانتظار الصورة';

  @override
  String get liveCtlYtNo => 'لا';

  @override
  String liveCtlCamOk(String mbps) {
    return 'متصلة، $mbps Mbps';
  }

  @override
  String get liveCtlCamConnected => 'متصلة';

  @override
  String liveCtlCamSlow(String mbps) {
    return 'متصلة، الصورة بطيئة ($mbps Mbps)';
  }

  @override
  String get liveCtlCamGone => 'مقطوعة';

  @override
  String liveCtlSubOnAir(int vol) {
    return 'على الهواء، $vol%';
  }

  @override
  String liveCtlSubOff(int vol) {
    return '$vol%، ليس على الهواء';
  }

  @override
  String get liveCtlSubBenched => 'متوقف مؤقتًا، تُعاد المحاولة';

  @override
  String get liveCtlSubWaitingCam => 'بانتظار الكاميرا';

  @override
  String get liveCtlSubMeanwhile => 'مستخدم مؤقتًا';

  @override
  String get liveCtlRecHere => 'التسجيل على هذا iPad';

  @override
  String get liveCtlWatchYoutube => 'شاهد على YouTube';

  @override
  String get liveQuietTitle => 'البث مستمر ولا يوجد جهاز يتحكم به';

  @override
  String liveQuietBody(int minutes) {
    return 'لم يظهر الجهاز الذي بدأ البث منذ $minutes دقيقة. يستمر البث إلى التلفاز وYouTube.';
  }

  @override
  String get liveQuietStop => 'إيقاف البث';

  @override
  String get liveKioskRestored =>
      'تعذّر البث على YouTube. أُعيد تشغيل شاشة المصلى حتى يبقى البث على الهواء.';

  @override
  String get liveCamSlowTitle => 'صورة الكاميرا بطيئة';

  @override
  String get liveMicBenchedTitle =>
      'تم إيقاف ميكروفون الصندوق مؤقتًا ويُستخدم صوت الكاميرا';

  @override
  String get liveMicBenchedBody =>
      'البث ليس صامتًا. تُعاد محاولة ميكروفون الصندوق تلقائيًا خلال دقيقة.';

  @override
  String get liveCamGoneTitle => 'الكاميرا مقطوعة والبث مستمر';

  @override
  String get liveCamGoneBody =>
      'تعرض الشاشات بطاقة الانتظار. تعود الصورة والصوت تلقائيًا عند اتصال الكاميرا. لا يتوقف البث تلقائيًا؛ اضغط إيقاف عند انتهاء الدرس.';

  @override
  String get liveStopOtherTitle => 'إيقاف البث';

  @override
  String liveStopOtherBody(String name, String device) {
    return 'بدأ هذا البث $name من $device. هل تريد إيقافه؟';
  }

  @override
  String liveStopOtherBodyNoDevice(String name) {
    return 'بدأ هذا البث $name. هل تريد إيقافه؟';
  }

  @override
  String liveStopOtherLog(String name) {
    return 'يُسجَّل اسمك واسم $name في سجل التغييرات.';
  }

  @override
  String get liveLeaveBoxPulled =>
      'يستمر MAXCOM في البث. افتح التطبيق مرة أخرى للتحكم به أو إيقافه.';

  @override
  String get liveAudioBoxMicMain => 'ميكروفون الصندوق (الأساسي)';

  @override
  String get liveAudioBoxMicMainHint =>
      'مدخل الميكروفون في MAXCOM. صوت المحاضر، دائمًا ضمن المزيج.';

  @override
  String get liveAudioCamBoxHint => 'ارفعه فقط إذا أردت صوت القاعة';

  @override
  String get liveAudioCamNotOnAir => 'ليس على الهواء';

  @override
  String get liveAudioBoxMicOnAir => 'على الهواء';

  @override
  String get liveSyncTitle => 'مزامنة الصوت والصورة';

  @override
  String get liveSyncAuto => 'مزامنة تلقائية';

  @override
  String get liveSyncAutoBody =>
      'يُؤخَّر صوت ميكروفون الصندوق ليتوافق مع صورة الكاميرا. يُقاس تلقائيًا من صوت الكاميرا.';

  @override
  String get liveSyncBusy => 'جارٍ المزامنة (الصوت يبقى على الهواء)';

  @override
  String liveSyncBusyBody(int ms) {
    return 'يبقى ميكروفون الصندوق على الهواء بتأخير البث السابق (+$ms ms) أثناء قياس MAXCOM.';
  }

  @override
  String get liveSyncManual => 'ضبط يدوي';

  @override
  String get liveSyncManualBody =>
      'أخِّر الصوت ليتوافق مع صورة الكاميرا. راقب شفتي المحاضر على التلفاز أثناء الضبط.';

  @override
  String get liveSyncRange => 'من 0 إلى 2000 ms بخطوات 50 ms.';

  @override
  String get liveSyncBack => 'العودة إلى التلقائي';

  @override
  String get liveSyncLess => 'أقل بمقدار 50 ms';

  @override
  String get liveSyncMore => 'أكثر بمقدار 50 ms';

  @override
  String get liveDestPickOne => 'اختر وجهة واحدة على الأقل';

  @override
  String get liveDestLastOne => 'لا يمكن إيقاف آخر وجهة أثناء البث';

  @override
  String get liveDestKioskOldBox => 'حدّث MAXCOM Kiosk Box لهذا الخيار';

  @override
  String get liveDestKioskOffSub => 'متوقفة لهذا البث';

  @override
  String get liveDestKioskLabelOff => 'شاشات المصلى: لا';

  @override
  String get liveDestRecSwitchNotNow =>
      'لا يمكن تغييره أثناء البث على هذا الجهاز';

  @override
  String get liveCtlTvsTitle => 'التلفازات التي تعرض';

  @override
  String get liveCtlDuration => 'مدة البث';

  @override
  String get liveMicLostBoxTitle => 'لم يُكتشف ميكروفون MAXCOM';

  @override
  String get liveMicLostBoxBody =>
      'قد يكون البث صامتًا. تحقق من توصيل الميكروفون بجهاز MAXCOM.';

  @override
  String get liveMicLostDeviceTitle => 'لم يُكتشف ميكروفون الجهاز';

  @override
  String get liveMicLostDeviceBody =>
      'قد يكون البث صامتًا. تحقق من الميكروفون في الجهاز الذي يرسل البث.';

  @override
  String get liveRecordingStopped => 'توقف، ويُحفظ الملف حتى الآن';

  @override
  String get liveRetrying => 'تتم إعادة المحاولة';

  @override
  String get liveDestYoutubeLive => 'يمكن تشغيله أثناء البث ولا يمكن إيقافه';

  @override
  String get liveSyncRangeSaved =>
      'من 0 إلى 2000 ms بخطوات 50 ms. يُحفظ للبثوث القادمة على MAXCOM هذا.';

  @override
  String get liveDestLiveYt => 'إلى YouTube فقط';

  @override
  String get liveDestLiveRec => 'تسجيل فقط، لا بث إلى شاشة المصلى أو YouTube';

  @override
  String get liveCtlSubMicLost => 'غير مكتشف';

  @override
  String get liveTvShowTitle => 'عرض البث المباشر';

  @override
  String get liveTvShowHint =>
      'أوقفه للصندوق البطيء أثناء البث. يبقى تلفاز ذلك الصندوق على عرضه المعتاد.';

  @override
  String get liveTvShowServer => 'خادم البث';

  @override
  String get liveTvShowOff => 'العرض المعتاد أثناء البث';

  @override
  String get liveTvShowAllOff => 'لن يعرض أي تلفاز البث.';

  @override
  String liveTvShowSwitch(String name) {
    return 'عرض البث المباشر، $name';
  }

  @override
  String liveTvShowCpuNow(int n) {
    return 'المعالج $n%';
  }

  @override
  String liveTvShowCpuLast(int n) {
    return 'المعالج $n% أثناء البث السابق';
  }

  @override
  String liveCtlTvsShowing(int n, String names) {
    return 'التلفازات التي تعرض البث: $n ($names)';
  }

  @override
  String liveCtlTvNormal(String name) {
    return '$name: العرض المعتاد';
  }

  @override
  String get liveViewerShowing => 'يعرض البث';

  @override
  String get liveViewerNormal => 'العرض المعتاد';

  @override
  String get liveViewersHint => 'غيّر ذلك في إعدادات البث، عرض البث المباشر.';

  @override
  String liveBusyTitle(String name, int n) {
    return '$name مشغول جدًا (المعالج $n%)';
  }

  @override
  String get liveBusyBody =>
      'قد تتقطع الصورة على التلفازات وYouTube. يعرض تلفاز آخر البث، لذا يمكن لتلفاز هذا الصندوق العودة إلى عرضه المعتاد. يمكن تشغيله من جديد في إعدادات البث.';

  @override
  String get liveBusyAction => 'إيقاف عرض البث على هذا الصندوق';

  @override
  String get liveBusyLater => 'ليس الآن';

  @override
  String get liveMicSilentTitle => 'لا صوت من ميكروفون MAXCOM';

  @override
  String liveMicSilentBody(int n) {
    return 'البث على الهواء بلا صوت المحاضر منذ $n دقيقة.';
  }

  @override
  String get liveMicSilentTip1 =>
      'افحص كابل الميكروفون في مدخل الميكروفون في MAXCOM.';

  @override
  String get liveMicSilentTip2 => 'استخدم بطاقة صوت USB لها مدخل ميكروفون.';

  @override
  String get liveMicSilentTip3 => 'أو ارفع صوت الكاميرا الخارجية.';

  @override
  String get liveMicSilentUseCamera => 'استخدام صوت الكاميرا';

  @override
  String liveMicSilentRow(String time) {
    return 'على الهواء، لا صوت منذ $time';
  }

  @override
  String get liveMicSilentCamTitle => 'يُستخدم صوت الكاميرا';

  @override
  String get liveMicSilentCamBody =>
      'يحتوي البث الآن على صوت من الكاميرا الخارجية. إذا عاد ميكروفون MAXCOM للصوت فسيُسمع من جديد.';

  @override
  String get liveMicTestHint =>
      'تحدث إلى الميكروفون أثناء الاختبار لمدة 5 ثوانٍ. اختر مدخلًا فيه صوت.';

  @override
  String get liveMicTestBusy => 'جارٍ الاختبار...';

  @override
  String get liveMicTestSound => 'تم الاختبار: يوجد صوت';

  @override
  String get liveMicTestSilent => 'تم الاختبار: صامت';

  @override
  String get liveMicTestFailed => 'تعذر الاختبار';

  @override
  String get liveMicTestNone => 'لم يُختبر بعد';

  @override
  String get liveMicTestAgain => 'أعد الاختبار (5 ثوانٍ)';

  @override
  String liveMicTestAt(String time) {
    return 'تم الاختبار في $time.';
  }

  @override
  String get liveMicTestSilentTitle => 'المدخل المختار صامت';

  @override
  String get liveMicTestSilentBody =>
      'سيذهب البث إلى الهواء بلا صوت المحاضر. اختر مدخلًا آخر أو افحص الكابل ثم أعد الاختبار.';

  @override
  String get liveYoutubeLaterWhySignIn =>
      'لم يتم ربط YouTube بجهاز MAXCOM بعد.';

  @override
  String get liveYoutubeLaterWhyUnreachable => 'تعذر الوصول إلى MAXCOM.';

  @override
  String get liveYoutubeLaterWhyStarter =>
      'الجهاز الذي بدأ البث وحده يستطيع إضافة YouTube.';

  @override
  String get liveTvShowFailed => 'تعذر حفظ الاختيار. أعد المحاولة.';

  @override
  String get liveCtlSubNoSound => 'لا صوت';

  @override
  String get liveAudioSwitchConfirm =>
      'تغيير الصوت؟ سيتوقف البث لحظة (من ثانيتين إلى 3 ثوانٍ).';

  @override
  String get liveAudioSwitchDo => 'تغيير';

  @override
  String get liveAudioSwitchCancel => 'إلغاء';

  @override
  String get liveWarnMicDropsTitle => 'صوت ميكروفون MAXCOM متقطع';

  @override
  String get liveWarnMicDropsBody =>
      'افحص كابل الميكروفون أو اختر صوت الكاميرا.';

  @override
  String get liveWarnBehindTitle => 'الرفع إلى YouTube بطيء';

  @override
  String liveWarnBehindBody(int seconds) {
    return 'البث متأخر $seconds ثانية. يستمر البث.';
  }

  @override
  String get liveWarnQualityTitle => 'تم خفض جودة الصورة (480p)';

  @override
  String get liveWarnQualityBody =>
      'الإنترنت بطيء. تعود الجودة تلقائيًا عند تحسن الاتصال.';

  @override
  String liveRelayReconnects(int count) {
    return 'أُعيد الاتصال بـ YouTube $count مرات';
  }
}
