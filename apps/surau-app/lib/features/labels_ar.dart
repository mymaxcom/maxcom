// Arabic (Modern Standard Arabic) names and help for the settings: the same
// keys as the BM maps in labels_ms.dart. Product names stay Latin (MAXCOM,
// YouTube, DuitNow, e-Solat). Digits stay 0-9. No dashes or arrows in the text.

/// Headings of the settings list, by registry group.
const Map<String, String> groupLabelsAr = {
  'solat': 'الصلاة',
  'skrin': 'الشاشة',
  'kandungan': 'المحتوى',
  'quran': 'القرآن الكريم',
  'audio': 'الصوت',
  'live': 'البث المباشر',
  'kewangan': 'المالية',
  'jemaah': 'المصلّون',
  'awan': 'السحابة',
  'keselamatan': 'الأمان',
};

/// A sentence under a feature's switch on its settings page, by feature key.
const Map<String, String> featureHelpAr = {
  'finance':
      'تُحفظ بيانات المالية ولا تُحذف عند إيقافها. فعّلها من جديد لعرض القيود والتقارير.',
  'appLock':
      'عند إيقافه (الافتراضي)، يُفتح MAXCOM مباشرة بقفل الجهاز المسجَّل: يمكن '
      'لأي شخص يحمل ذلك الجهاز الدخول. فعّله إذا كانت هناك أجهزة مشتركة، أو إذا '
      'فُتح MAXCOM في المتصفح على iPad أو حاسوب مشترك. عند تفعيله، يُطلب من كل '
      'مستخدم تعيين رمز PIN عند الفتح التالي؛ ويمكن استخدام بصمة الإصبع على Android.',
};

const Map<String, String> settingLabelsAr = {
  // liveCamera
  'transport': 'طريقة النقل',
  'avOffsetMs': 'إزاحة توقيت الصوت',
  'deviceMic': 'ميكروفون الجهاز',
  'boxInput': 'مدخل الميكروفون في الصندوق',
  // days and prayers
  'ahad': 'الأحد',
  'isnin': 'الاثنين',
  'selasa': 'الثلاثاء',
  'rabu': 'الأربعاء',
  'khamis': 'الخميس',
  'jumaat': 'الجمعة',
  'sabtu': 'السبت',
  'subuh': 'الفجر',
  'zohor': 'الظهر',
  'asar': 'العصر',
  'maghrib': 'المغرب',
  'isyak': 'العشاء',
  'imsak': 'الإمساك',
  'syuruk': 'الشروق',
  // solat
  'showImsak': 'عرض وقت الإمساك',
  'showSyuruk': 'عرض وقت الشروق',
  'timeFormat': 'صيغة الوقت',
  'showSeconds': 'عرض الثواني',
  'zone': 'منطقة مواقيت الصلاة',
  'country': 'الدولة',
  'timezone': 'المنطقة الزمنية',
  'latitude': 'خط العرض',
  'longitude': 'خط الطول',
  'city': 'المدينة',
  'method': 'طريقة الحساب',
  'madhab': 'مذهب صلاة العصر',
  'highLatitude': 'قاعدة خطوط العرض العالية',
  'adjustMinutes': 'تعديل الدقائق',
  'imsakMinutes': 'الإمساك قبل الفجر (دقائق)',
  'sourceOrder': 'ترتيب المصادر',
  'crossCheck': 'المطابقة مع الحساب',
  'minutesBefore': 'دقائق قبل الوقت',
  'fullScreen': 'الشاشة الكاملة',
  'beep': 'صوت التنبيه',
  'screenSeconds': 'مدة الشاشة (ثوانٍ)',
  'minutes': 'الدقائق',
  'endWarningSeconds': 'التنبيه الأخير (ثوانٍ)',
  'message': 'الرسالة على الشاشة',
  'khutbahMinutes': 'مدة الخطبة (دقائق)',
  'iqamahMinutes': 'مدة الإقامة (دقائق)',
  'solatMinutes': 'مدة الصلاة (دقائق)',
  'hijriMonth': 'الشهر الهجري',
  'gapMinutes': 'الفاصل بين الركعات (دقائق)',
  'minutesAfterSyuruk': 'دقائق بعد الشروق',
  'durationMinutes': 'المدة (دقائق)',
  'audioFile': 'الملف الصوتي',
  // skrin
  'name': 'اسم المصلى',
  'shortName': 'الاسم المختصر (أيقونة الشاشة الرئيسية)',
  'kind': 'النوع',
  'shortAddress': 'العنوان المختصر',
  'helpName': 'اسم جهة المساعدة',
  'helpPhone': 'هاتف جهة المساعدة',
  'helpEmail': 'بريد جهة المساعدة',
  'logo': 'شعار المصلى أو المسجد',
  'showName': 'عرض اسم المصلى أيضًا',
  'adjustDays': 'تعديل أيام التاريخ الهجري',
  'switchAt': 'تغيير التاريخ الهجري عند',
  'images': 'صور الخلفية',
  'rotate': 'تغيير الصورة',
  'override': 'لون النص',
  'lang': 'لغة شاشة التلفاز',
  'mode': 'الاتجاه',
  'templateId': 'القالب',
  'styles': 'أنماط القالب',
  'packs': 'القوالب المرفوعة',
  // kandungan
  'durationSeconds': 'مدة العرض (ثوانٍ)',
  'order': 'الترتيب',
  'daysAhead': 'الأيام القادمة',
  'shape': 'الشكل',
  'maxItems': 'الحد الأقصى للعناصر',
  'speed': 'السرعة',
  'hideAfterMinutes': 'الإخفاء بعد (دقائق)',
  'count': 'العدد',
  'pick': 'طريقة الاختيار',
  // hadis
  'source': 'مصدر الأحاديث',
  'mix': 'الترتيب',
  'changeEvery': 'تغيير الأحاديث',
  'perDay': 'عدد الأحاديث في اليوم',
  'showArabic': 'النص العربي',
  'showMalay': 'الترجمة إلى الملايو',
  'showAttribution': 'العزو',
  'showGrade': 'الدرجة',
  'fontSize': 'حجم الخط',
  'allowedGrades': 'الدرجات المسموح بها على التلفاز',
  'sahih': 'صحيح',
  'hasan': 'حسن',
  'sahih_lighairihi': 'صحيح لغيره',
  'hasan_lighairihi': 'حسن لغيره',
  // al-quran
  'surah': 'السورة',
  'ayatFrom': 'من الآية',
  'ayatTo': 'إلى الآية',
  'showTranslation': 'عرض الترجمة',
  'textSize': 'حجم النص',
  'minutesAfterSolat': 'دقائق بعد الصلاة',
  'reciter': 'القارئ',
  'cacheMaxMb': 'مساحة التخزين (MB)',
  // finance and donation card
  'penceramahFundId': 'الصندوق الافتراضي لمدفوعات المحاضر',
  'bigAmountSen': 'تأكيد المبالغ التي تتجاوز (سين)',
  'startedOn': 'بدء الاستخدام في',
  'figure': 'الرقم المعروض',
  'highlightSeconds': 'إبراز الصندوق بعد القيد (ثوانٍ)',
  'showTarget': 'عرض شريط الهدف',
  'qrAssetId': 'رمز QR لـ DuitNow',
  'featured': 'إبراز الصندوق الأول',
  'manualTitle': 'عنوان البطاقة',
  'row1Label': 'السطر 1',
  'row1Sen': 'مبلغ السطر 1 (سين)',
  'row2Label': 'السطر 2',
  'row2Sen': 'مبلغ السطر 2 (سين)',
  'row3Label': 'السطر 3',
  'row3Sen': 'مبلغ السطر 3 (سين)',
  'autoFetch': 'التنزيل التلقائي من e-Solat',
  // live
  'audio': 'الصوت على الشاشة',
  'showStrip': 'شريط الدرس أثناء البث',
  'fit': 'تعبئة الشاشة',
  'privacy': 'ظهور البث في YouTube',
  'relayFrom': 'البث إلى YouTube من',
  'relayVideo': 'الفيديو إلى YouTube',
  'titleTemplate': 'قالب العنوان',
  'descriptionTemplate': 'قالب الوصف',
  'maxBitrateKbps': 'الحد الأقصى لمعدل البت (kbps)',
  'segmentMinutes': 'مدة كل ملف تسجيل (دقائق)',
  'keepOnDevice': 'حفظ التسجيل على الجهاز',
  // audio
  'volume': 'مستوى الصوت',
  // internet data sources
  'esolat': 'مواقيت الصلاة (e-Solat)',
  'esolatZones': 'قائمة المناطق (e-Solat)',
  'nominatim': 'البحث عن المواقع (Nominatim)',
  'quranText': 'نص القرآن الكريم',
  'quranAudio': 'صوت التلاوة',
  'hadeethenc': 'الأحاديث (HadeethEnc)',
  'url': 'العنوان (https)',
  // cloud
  'dirtyCheckSeconds': 'فاصل فحص تغييرات السحابة (ثوانٍ)',
  'cloudUrl': 'عنوان السحابة',
  'wifiOnly': 'Wi-Fi فقط',
  'joinSegments': 'دمج ملفات التسجيل قبل الرفع',
  'replaceGappyLive': 'البث المباشر المنقطع',
  'keepDays': 'الاحتفاظ بعد تأكيد YouTube',
  // system (Lanjutan)
  'noVideoSeconds': 'تنبيه غياب الفيديو (ثوانٍ)',
  'cloudWakeSeconds': 'انتظار استيقاظ السحابة (ثوانٍ)',
  'syncHistoryDays': 'حفظ سجل المزامنة (أيام)',
  'suspendedAt': 'أُوقف في',
};

/// Inside a data source the leaf `name` is the source's name, not the surau's.
const Map<String, String> sourceLeafLabelsAr = {
  'name': 'اسم المصدر',
  'url': 'العنوان (https)',
};

/// Arabic names of the choices of an enum setting, by setting name then value.
const Map<String, Map<String, String>> choiceLabelsAr = {
  'transport': {'auto': 'تلقائي', 'tcp': 'TCP', 'udp': 'UDP'},
  'timeFormat': {'12h': '12 ساعة', '24h': '24 ساعة'},
  'switchAt': {'maghrib': 'وقت المغرب', 'midnight': 'منتصف الليل'},
  'lang': {'auto': 'حسب الموقع', 'ms': 'الملايو', 'en': 'الإنجليزية'},
  'mode': {'landscape': 'أفقي', 'portrait': 'عمودي'},
  // The theme names are one English name in every language (spec 6.10.2).
  'templateId': {
    'default': 'Default',
    'colourful': 'Colourful',
    'creative': 'Creative',
    'oldschool': 'Old School',
    'minimal': 'Minimal',
    'arabic': 'Arabic Art',
  },
  'rotate': {
    'daily': 'كل يوم',
    'hourly': 'كل ساعة',
    'off': 'بلا تغيير',
  },
  'pick': {
    'daily': 'كل يوم',
    'random': 'عشوائي',
    'manual': 'اختيار يدوي',
  },
  'source': {
    'own': 'قائمتي الخاصة',
    'hadeethenc': 'HadeethEnc',
    'both': 'كلاهما',
  },
  'mix': {
    'list': 'حسب القائمة',
    'alternate': 'بالتناوب',
    'random': 'عشوائي',
  },
  'changeEvery': {'day': 'مجموعة في اليوم', 'card': 'عند كل عرض'},
  'fontSize': {
    'auto': 'تلقائي حسب الطول',
    's': 'صغير',
    'm': 'متوسط',
    'l': 'كبير',
  },
  'speed': {'slow': 'بطيء', 'normal': 'عادي', 'fast': 'سريع'},
  'shape': {'round': 'دائري', 'square': 'مربع'},
  'textSize': {'s': 'صغير', 'm': 'متوسط', 'l': 'كبير'},
  'kind': {'surau': 'مصلى', 'masjid': 'مسجد'},
  'method': {
    'auto': 'تلقائي (حسب الدولة)',
    'mwl': 'رابطة العالم الإسلامي',
    'egyptian': 'مصر',
    'karachi': 'كراتشي',
    'ummAlQura': 'أم القرى',
    'dubai': 'دبي',
    'qatar': 'قطر',
    'kuwait': 'الكويت',
    'moonsighting': 'لجنة رؤية الهلال',
    'singapore': 'سنغافورة',
    'tehran': 'طهران',
    'turkey': 'تركيا (ديانت)',
    'northAmerica': 'أمريكا الشمالية (ISNA)',
    'jakim': 'JAKIM 18/18',
    'kemenag': 'وزارة الشؤون الدينية الإندونيسية 20/18',
    'uoif': 'اتحاد المنظمات الإسلامية في فرنسا 12/12',
    'morocco': 'المغرب 19/17',
    'algeria': 'الجزائر 18/17',
    'russia': 'روسيا 16/15',
  },
  'madhab': {'auto': 'تلقائي (حسب الدولة)', 'shafi': 'الشافعي', 'hanafi': 'الحنفي'},
  'highLatitude': {
    'auto': 'تلقائي',
    'middleOfNight': 'منتصف الليل',
    'seventhOfNight': 'سُبع الليل',
    'twilightAngle': 'زاوية الشفق',
  },
  'fit': {'cover': 'تعبئة الشاشة', 'contain': 'احتواء دون قص'},
  'figure': {'balance': 'الرصيد', 'month': 'هذا الشهر', 'lastEntry': 'آخر قيد'},
  'privacy': {
    'public': 'عام',
    'unlisted': 'غير مدرج',
    'private': 'خاص',
  },
  'relayFrom': {'box': 'MAXCOM (الافتراضي)', 'phone': 'الهاتف مباشرة'},
  'relayVideo': {'copy': 'نسخ مباشر', 'reencode': 'إعادة ترميز'},
  'cacheMaxMb': {
    '100': '100 ميغابايت',
    '300': '300 ميغابايت (الافتراضي)',
    '500': '500 ميغابايت',
    '1000': '1 غيغابايت',
  },
  'syncHistoryDays': {'180': '180 يومًا (الافتراضي)', '365': '365 يومًا'},
  'dirtyCheckSeconds': {
    '60': 'دقيقة واحدة',
    '120': 'دقيقتان (الافتراضي)',
    '300': '5 دقائق',
    '600': '10 دقائق',
    '900': '15 دقيقة',
  },
  'keepDays': {
    '0': 'الحذف فورًا',
    '1': 'يوم واحد',
    '3': '3 أيام',
    '7': '7 أيام',
    '30': '30 يومًا',
  },
  'replaceGappyLive': {
    'ask': 'السؤال أولًا',
    'never': 'عدم الاستبدال',
    'always': 'الاستبدال دائمًا',
  },
};

/// A sentence under a setting, by setting name.
const Map<String, String> settingHelpAr = {
  'keepOnDevice':
      'عند التفعيل (الافتراضي)، تُحفظ النسخة الموجودة على الجهاز للأيام المحددة '
      'في تنظيف التسجيلات، ثم تُحذف. وعند الإيقاف تُحذف فور تأكيد YouTube لها.',
  'relayVideo':
      'للبث من المتصفح فقط؛ أما البث من تطبيق Android فلا يمر عبر MAXCOM. النسخ '
      'المباشر يستهلك أقل قدر من معالج MAXCOM. وإعادة الترميز للهواتف التي ترسل '
      'معدل بت مرتفعًا جدًا.',
  'maxBitrateKbps': 'حسب سرعة الرفع في إنترنت المصلى.',
  'cacheMaxMb':
      'يتوقف تنزيل الصوت عند بلوغ الحد؛ ولا يُحذف الصوت القديم. الجزء الواحد '
      'نحو 40 MB.',
  'fontSize': 'الحجم الأساسي للنص. وحجم النص في التخصيص يضيف مقياسًا فوقه.',
  'textSize': 'الحجم الأساسي للنص. وحجم النص في التخصيص يضيف مقياسًا فوقه.',
  'segmentMinutes': 'الملفات القصيرة أكثر أمانًا إذا انقطع اتصال الهاتف.',
  'noVideoSeconds':
      'المدة التي تمر دون صورة من الهاتف قبل ظهور التنبيه في التطبيق.',
  'cloudWakeSeconds':
      'المدة التي ينتظرها MAXCOM لاستيقاظ السحابة قبل أن يتابع بث YouTube '
      'بدونها.',
  'syncHistoryDays':
      'الجهاز الذي لم يتزامن لمدة أطول من هذه يجب أن يعيد تحميل كل شيء.',
  'dirtyCheckSeconds':
      'كلما كان الفحص أكثر تكرارًا وصلت التغييرات من المنزل أسرع، لكن تُوقَظ '
      'السحابة أكثر.',
  'lang':
      'لغة شاشة التلفاز، وليست لغة التطبيق على الهاتف. حسب الموقع: الملايو في '
      'ماليزيا والإنجليزية في الدول الأخرى.',
};

/// A sentence under each choice, for the settings drawn as cards.
const Map<String, Map<String, String>> choiceHelpAr = {
  'relayFrom': {
    'box': 'يرسل الهاتف الصورة إلى MAXCOM في المصلى، ويقوم MAXCOM بالبث إلى YouTube.',
    'phone':
        'يبث الهاتف إلى YouTube بنفسه، عند ضعف MAXCOM أو بطء إنترنت المصلى.',
  },
};

/// Arabic names of the roles, by role key (the same words as the app catalogue).
const Map<String, String> roleLabelsAr = {
  'superadmin': 'مسؤول MAXCOM',
  'admin': 'المسؤول',
  'treasurer': 'أمين الصندوق',
  'media': 'الإعلام',
  'live': 'البث المباشر',
  'ajk': 'أعضاء اللجنة',
};
