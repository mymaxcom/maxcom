// Plain-language labels for every setting name in the feature registry
// (the key of a leaf in a feature's defaults, nested names included), and
// the group headings. Bahasa Malaysia first; the English map is for the
// `language` feature later. No dashes or arrows in the text.

/// Headings of the settings list, by registry group.
const Map<String, String> groupLabelsMs = {
  'solat': 'Solat',
  'skrin': 'Skrin',
  'kandungan': 'Kandungan',
  'quran': 'Al-Quran',
  'audio': 'Audio',
  'live': 'Siaran langsung',
  'kewangan': 'Kewangan',
  'jemaah': 'Jemaah',
  'awan': 'Awan',
  'keselamatan': 'Keselamatan',
  'lanjutan': 'Lanjutan',
};

/// Group order in the list.
const List<String> groupOrder = [
  'solat',
  'skrin',
  'kandungan',
  'quran',
  'audio',
  'live',
  'kewangan',
  'jemaah',
  'awan',
  'keselamatan',
  'lanjutan',
];

/// A sentence under a feature's switch on its settings page, by feature
/// key (BM). Only features that need more than their name have one.
const Map<String, String> featureHelpMs = {
  'finance':
      'Data kewangan disimpan dan tidak dipadam bila dimatikan. Hidupkan semula untuk melihat catatan dan laporan.',
  'appLock':
      'Bila dimatikan (lalai), MAXCOM dibuka terus dengan kunci peranti yang '
      'didaftarkan: sesiapa yang memegang peranti itu boleh masuk. Hidupkan '
      'jika ada peranti yang dikongsi, atau MAXCOM dibuka dalam pelayar di '
      'iPad atau komputer yang dikongsi. Bila dihidupkan, setiap pengguna '
      'diminta tetapkan PIN pada bukaan seterusnya; cap jari boleh digunakan '
      'di Android.',
};

const Map<String, String> settingLabelsMs = {
  // days and prayers (WeekTable and minutesBefore cells)
  'ahad': 'Ahad',
  'isnin': 'Isnin',
  'selasa': 'Selasa',
  'rabu': 'Rabu',
  'khamis': 'Khamis',
  'jumaat': 'Jumaat',
  'sabtu': 'Sabtu',
  'subuh': 'Subuh',
  'zohor': 'Zohor',
  'asar': 'Asar',
  'maghrib': 'Maghrib',
  'isyak': 'Isyak',
  'imsak': 'Imsak',
  'syuruk': 'Syuruk',
  // solat
  'showImsak': 'Papar waktu Imsak',
  'showSyuruk': 'Papar waktu Syuruk',
  'timeFormat': 'Format waktu',
  'showSeconds': 'Papar saat',
  'zone': 'Zon waktu solat',
  'country': 'Negara',
  'timezone': 'Zon waktu',
  'latitude': 'Latitud',
  'longitude': 'Longitud',
  'city': 'Bandar',
  'method': 'Kaedah kiraan',
  'madhab': 'Mazhab Asar',
  'highLatitude': 'Peraturan latitud tinggi',
  'adjustMinutes': 'Laras minit',
  'imsakMinutes': 'Imsak sebelum Subuh (minit)',
  'sourceOrder': 'Susunan sumber',
  'crossCheck': 'Semak silang dengan kiraan',
  'minutesBefore': 'Minit sebelum waktu',
  'fullScreen': 'Skrin penuh',
  'beep': 'Bunyi amaran',
  'screenSeconds': 'Tempoh skrin (saat)',
  'minutes': 'Minit',
  'endWarningSeconds': 'Amaran akhir (saat)',
  'message': 'Mesej di skrin',
  'khutbahMinutes': 'Tempoh khutbah (minit)',
  'iqamahMinutes': 'Tempoh iqamah (minit)',
  'solatMinutes': 'Tempoh solat (minit)',
  'hijriMonth': 'Bulan Hijrah',
  'gapMinutes': 'Jarak antara rakaat (minit)',
  'minutesAfterSyuruk': 'Minit selepas syuruk',
  'durationMinutes': 'Tempoh (minit)',
  'audioFile': 'Fail audio',
  // skrin
  'name': 'Nama surau',
  'kind': 'Jenis',
  'shortAddress': 'Alamat ringkas',
  'helpName': 'Nama untuk bantuan',
  'helpPhone': 'Telefon untuk bantuan',
  'helpEmail': 'E-mel untuk bantuan',
  'logo': 'Logo surau/masjid',
  'showName': 'Paparkan nama surau juga',
  'adjustDays': 'Laras hari Hijrah',
  'switchAt': 'Tukar tarikh Hijrah pada',
  'images': 'Gambar latar',
  'rotate': 'Tukar gambar',
  'override': 'Warna teks',
  'lang': 'Bahasa',
  'mode': 'Orientasi',
  'templateId': 'Templat',
  // kandungan
  'durationSeconds': 'Tempoh paparan (saat)',
  'order': 'Susunan',
  'daysAhead': 'Hari ke hadapan',
  'shape': 'Bentuk',
  'maxItems': 'Bilangan maksimum',
  'speed': 'Kelajuan',
  'hideAfterMinutes': 'Sembunyi selepas (minit)',
  'count': 'Bilangan',
  'pick': 'Cara memilih',
  // hadis
  'source': 'Sumber hadis',
  'mix': 'Susunan',
  'changeEvery': 'Tukar hadis',
  'perDay': 'Bilangan hadis sehari',
  'showArabic': 'Teks Arab',
  'showMalay': 'Terjemahan Bahasa Melayu',
  'showAttribution': 'Atribusi',
  'showGrade': 'Darjat',
  'fontSize': 'Saiz tulisan',
  'allowedGrades': 'Darjat yang dibenarkan di TV',
  'sahih': 'Sahih',
  'hasan': 'Hasan',
  'sahih_lighairihi': 'Sahih li ghairihi',
  'hasan_lighairihi': 'Hasan li ghairihi',
  // al-quran
  'surah': 'Surah',
  'ayatFrom': 'Ayat dari',
  'ayatTo': 'Ayat hingga',
  'showTranslation': 'Papar terjemahan',
  'textSize': 'Saiz teks',
  'minutesAfterSolat': 'Minit selepas solat',
  'reciter': 'Qari',
  'cacheMaxMb': 'Ruang simpanan (MB)',
  // kewangan dan kad tabung
  'penceramahFundId': 'Tabung lalai bayaran penceramah',
  'bigAmountSen': 'Sahkan jumlah melebihi (sen)',
  'startedOn': 'Mula digunakan pada',
  'figure': 'Angka dipaparkan',
  'highlightSeconds': 'Serlahkan tabung selepas catatan (saat)',
  'showTarget': 'Tunjuk bar sasaran',
  'qrAssetId': 'Kod QR DuitNow',
  'manualTitle': 'Tajuk kad',
  'row1Label': 'Baris 1',
  'row1Sen': 'Baris 1 jumlah (sen)',
  'row2Label': 'Baris 2',
  'row2Sen': 'Baris 2 jumlah (sen)',
  'row3Label': 'Baris 3',
  'row3Sen': 'Baris 3 jumlah (sen)',
  'autoFetch': 'Muat turun automatik dari e-Solat',
  // siaran langsung
  'audio': 'Audio di skrin',
  'showStrip': 'Jalur kuliah semasa siaran',
  'fit': 'Isi skrin',
  'privacy': 'Keterlihatan YouTube',
  'relayFrom': 'Siarkan ke YouTube dari',
  'relayVideo': 'Video ke YouTube',
  'titleTemplate': 'Templat tajuk',
  'descriptionTemplate': 'Templat keterangan',
  'maxBitrateKbps': 'Kadar bit maksimum (kbps)',
  'segmentMinutes': 'Panjang setiap fail rakaman (minit)',
  'keepOnDevice': 'Simpan rakaman di peranti',
  // audio
  'volume': 'Kuat bunyi',
  // sumber data internet (dataSources): one {name, url} per source
  'esolat': 'Waktu solat (e-Solat)',
  'esolatZones': 'Senarai zon (e-Solat)',
  'nominatim': 'Carian lokasi (Nominatim)',
  'quranText': 'Teks Al-Quran',
  'quranAudio': 'Audio tilawah',
  'hadeethenc': 'Hadis (HadeethEnc)',
  'url': 'Alamat (https)',
  // awan
  'dirtyCheckSeconds': 'Selang semak perubahan awan (saat)',
  'cloudUrl': 'Alamat awan',
  'wifiOnly': 'Wi-Fi sahaja',
  'joinSegments': 'Gabungkan fail rakaman sebelum muat naik',
  'replaceGappyLive': 'Siaran langsung yang terputus',
  'keepDays': 'Simpan selepas disahkan di YouTube',
  // sistem (Lanjutan)
  'noVideoSeconds': 'Amaran tiada video (saat)',
  'cloudWakeSeconds': 'Tunggu awan bangun (saat)',
  'syncHistoryDays': 'Simpan sejarah penyelarasan (hari)',
  'suspendedAt': 'Digantung pada',
};

/// Inside a data source (`esolat`, `quranText`, `quranAudio`) the leaf
/// `name` is the source's name, not the surau's: these win over
/// [settingLabelsMs] there.
const Map<String, String> sourceLeafLabelsMs = {
  'name': 'Nama sumber',
  'url': 'Alamat (https)',
};

const Map<String, String> sourceLeafLabelsEn = {
  'name': 'Source name',
  'url': 'Address (https)',
};

/// Label for a leaf of a data source.
String sourceLeafLabelMs(String name) =>
    sourceLeafLabelsMs[name] ?? settingLabelMs(name);

/// English labels for the same names (used when the `language` feature is
/// English).
const Map<String, String> settingLabelsEn = {
  'ahad': 'Sunday',
  'isnin': 'Monday',
  'selasa': 'Tuesday',
  'rabu': 'Wednesday',
  'khamis': 'Thursday',
  'jumaat': 'Friday',
  'sabtu': 'Saturday',
  'subuh': 'Subuh',
  'zohor': 'Zohor',
  'asar': 'Asar',
  'maghrib': 'Maghrib',
  'isyak': 'Isyak',
  'imsak': 'Imsak',
  'syuruk': 'Sunrise',
  'showImsak': 'Show Imsak time',
  'showSyuruk': 'Show Syuruk time',
  'timeFormat': 'Time format',
  'showSeconds': 'Show seconds',
  'zone': 'Prayer time zone',
  'country': 'Country',
  'timezone': 'Time zone',
  'latitude': 'Latitude',
  'longitude': 'Longitude',
  'city': 'City',
  'method': 'Calculation method',
  'madhab': 'Asr madhab',
  'highLatitude': 'High latitude rule',
  'adjustMinutes': 'Adjust minutes',
  'imsakMinutes': 'Imsak before Subuh (minutes)',
  'sourceOrder': 'Source order',
  'crossCheck': 'Cross-check with the calculation',
  'minutesBefore': 'Minutes before',
  'fullScreen': 'Full screen',
  'beep': 'Warning beep',
  'screenSeconds': 'Screen time (seconds)',
  'minutes': 'Minutes',
  'endWarningSeconds': 'Final warning (seconds)',
  'message': 'Message on screen',
  'khutbahMinutes': 'Khutbah length (minutes)',
  'iqamahMinutes': 'Iqamah length (minutes)',
  'solatMinutes': 'Prayer length (minutes)',
  'hijriMonth': 'Hijri month',
  'gapMinutes': 'Gap between rakaat (minutes)',
  'minutesAfterSyuruk': 'Minutes after syuruk',
  'durationMinutes': 'Length (minutes)',
  'audioFile': 'Audio file',
  'name': 'Surau name',
  'kind': 'Kind',
  'shortAddress': 'Short address',
  'helpName': 'Help contact name',
  'helpPhone': 'Help contact phone',
  'helpEmail': 'Help contact email',
  'logo': 'Surau or masjid logo',
  'showName': 'Also show the surau name',
  'adjustDays': 'Hijri day adjustment',
  'switchAt': 'Change Hijri date at',
  'images': 'Background images',
  'rotate': 'Change image',
  'override': 'Text colour',
  'lang': 'Language',
  'mode': 'Orientation',
  'templateId': 'Template',
  'durationSeconds': 'Display time (seconds)',
  'order': 'Order',
  'daysAhead': 'Days ahead',
  'shape': 'Shape',
  'maxItems': 'Maximum items',
  'speed': 'Speed',
  'hideAfterMinutes': 'Hide after (minutes)',
  'count': 'Count',
  'pick': 'How to choose',
  'source': 'Hadith source',
  'mix': 'Order',
  'changeEvery': 'Change hadith',
  'perDay': 'Hadith per day',
  'showArabic': 'Arabic text',
  'showMalay': 'Malay translation',
  'showAttribution': 'Attribution',
  'showGrade': 'Grade',
  'fontSize': 'Text size',
  'allowedGrades': 'Grades allowed on the TV',
  'sahih': 'Sahih',
  'hasan': 'Hasan',
  'sahih_lighairihi': 'Sahih li ghairihi',
  'hasan_lighairihi': 'Hasan li ghairihi',
  'surah': 'Surah',
  'ayatFrom': 'Verse from',
  'ayatTo': 'Verse to',
  'showTranslation': 'Show translation',
  'textSize': 'Text size',
  'minutesAfterSolat': 'Minutes after prayer',
  'reciter': 'Reciter',
  'cacheMaxMb': 'Storage (MB)',
  // finance and donation card
  'penceramahFundId': 'Default tabung for speaker payments',
  'bigAmountSen': 'Confirm amounts above (sen)',
  'startedOn': 'In use since',
  'figure': 'Figure shown',
  'highlightSeconds': 'Highlight a tabung after an entry (seconds)',
  'showTarget': 'Show target bar',
  'qrAssetId': 'DuitNow QR code',
  'manualTitle': 'Card title',
  'row1Label': 'Row 1',
  'row1Sen': 'Row 1 amount (sen)',
  'row2Label': 'Row 2',
  'row2Sen': 'Row 2 amount (sen)',
  'row3Label': 'Row 3',
  'row3Sen': 'Row 3 amount (sen)',
  'autoFetch': 'Automatic download from e-Solat',
  'audio': 'Sound on the screen',
  'showStrip': 'Lecture strip during the live',
  'fit': 'Fill the screen',
  'privacy': 'YouTube visibility',
  'relayFrom': 'Stream to YouTube from',
  'relayVideo': 'Video to YouTube',
  'titleTemplate': 'Title template',
  'descriptionTemplate': 'Description template',
  'maxBitrateKbps': 'Maximum bitrate (kbps)',
  'segmentMinutes': 'Length of each recording file (minutes)',
  'keepOnDevice': 'Keep the recording on the device',
  'volume': 'Volume',
  'esolat': 'Prayer times (e-Solat)',
  'esolatZones': 'Zone list (e-Solat)',
  'nominatim': 'Location search (Nominatim)',
  'quranText': 'Quran text',
  'quranAudio': 'Recitation audio',
  'hadeethenc': 'Hadith (HadeethEnc)',
  'url': 'Address (https)',
  'dirtyCheckSeconds': 'Cloud change check interval (seconds)',
  'cloudUrl': 'Cloud address',
  'wifiOnly': 'Wi-Fi only',
  'joinSegments': 'Join recording files before upload',
  'replaceGappyLive': 'Live broadcast with gaps',
  'keepDays': 'Keep after YouTube has verified it',
  'noVideoSeconds': 'No-video warning (seconds)',
  'cloudWakeSeconds': 'Wait for the cloud to wake (seconds)',
  'syncHistoryDays': 'Keep sync history (days)',
  'suspendedAt': 'Suspended at',
};

/// Label for a setting name; falls back to the name itself so a new core
/// setting never renders blank (labels_test catches the gap first).
String settingLabelMs(String name) => settingLabelsMs[name] ?? name;

/// BM names of the choices of an enum setting, by setting name then value.
const Map<String, Map<String, String>> choiceLabelsMs = {
  'timeFormat': {'12h': '12 jam', '24h': '24 jam'},
  'switchAt': {'maghrib': 'Waktu Maghrib', 'midnight': 'Tengah malam'},
  'lang': {'ms': 'Bahasa Melayu', 'en': 'English'},
  'mode': {'landscape': 'Mendatar', 'portrait': 'Menegak'},
  'templateId': {
    'default': 'Satu Warna (Lalai)',
    'colourful': 'Berwarna-warni',
    'creative': 'Kreatif',
    'oldschool': 'Klasik Lama',
    'minimal': 'Minimalis Cerah',
  },
  'rotate': {
    'daily': 'Setiap hari',
    'hourly': 'Setiap jam',
    'off': 'Tidak bertukar',
  },
  'pick': {
    'daily': 'Setiap hari',
    'random': 'Rawak',
    'manual': 'Pilih sendiri',
  },
  'source': {
    'own': 'Senarai sendiri',
    'hadeethenc': 'HadeethEnc',
    'both': 'Kedua-dua',
  },
  'mix': {
    'list': 'Ikut senarai',
    'alternate': 'Berselang-seli',
    'random': 'Rawak',
  },
  'changeEvery': {'day': 'Satu set sehari', 'card': 'Setiap paparan'},
  'fontSize': {
    'auto': 'Auto ikut panjang',
    's': 'Kecil',
    'm': 'Sederhana',
    'l': 'Besar',
  },
  'speed': {'slow': 'Perlahan', 'normal': 'Biasa', 'fast': 'Pantas'},
  'shape': {'round': 'Bulat', 'square': 'Segi empat'},
  'textSize': {'s': 'Kecil', 'm': 'Sederhana', 'l': 'Besar'},
  'kind': {'surau': 'Surau', 'masjid': 'Masjid'},
  'method': {
    'auto': 'Auto (ikut negara)',
    'mwl': 'Liga Dunia Islam',
    'egyptian': 'Mesir',
    'karachi': 'Karachi',
    'ummAlQura': 'Umm al-Qura',
    'dubai': 'Dubai',
    'qatar': 'Qatar',
    'kuwait': 'Kuwait',
    'moonsighting': 'Jawatankuasa Moonsighting',
    'singapore': 'Singapura',
    'tehran': 'Tehran',
    'turkey': 'Turki (Diyanet)',
    'northAmerica': 'Amerika Utara (ISNA)',
    'jakim': 'JAKIM 18/18',
    'kemenag': 'Kemenag Indonesia 20/18',
    'uoif': 'UOIF Perancis 12/12',
    'morocco': 'Maghribi 19/17',
    'algeria': 'Algeria 18/17',
    'russia': 'Rusia 16/15',
  },
  'madhab': {'auto': 'Auto (ikut negara)', 'shafi': 'Syafie', 'hanafi': 'Hanafi'},
  'highLatitude': {
    'auto': 'Auto',
    'middleOfNight': 'Pertengahan malam',
    'seventhOfNight': 'Satu pertujuh malam',
    'twilightAngle': 'Sudut senja',
  },
  'fit': {'cover': 'Penuhkan skrin', 'contain': 'Muat tanpa potong'},
  'figure': {'balance': 'Baki', 'month': 'Bulan ini', 'lastEntry': 'Catatan terakhir'},
  'privacy': {
    'public': 'Awam',
    'unlisted': 'Tidak disenaraikan',
    'private': 'Peribadi',
  },
  'relayFrom': {'box': 'MAXCOM (lalai)', 'phone': 'Telefon terus'},
  'relayVideo': {'copy': 'Salin terus', 'reencode': 'Kod semula'},
  'cacheMaxMb': {'100': '100 MB', '300': '300 MB (lalai)', '500': '500 MB', '1000': '1 GB'},
  'syncHistoryDays': {'180': '180 hari (lalai)', '365': '365 hari'},
  'dirtyCheckSeconds': {
    '60': '1 minit',
    '120': '2 minit (lalai)',
    '300': '5 minit',
    '600': '10 minit',
    '900': '15 minit',
  },
  'keepDays': {
    '0': 'Padam serta merta',
    '1': '1 hari',
    '3': '3 hari',
    '7': '7 hari',
    '30': '30 hari',
  },
  'replaceGappyLive': {
    'ask': 'Tanya dahulu',
    'never': 'Jangan ganti',
    'always': 'Sentiasa ganti',
  },
};

/// The line under each Lanjutan deep link in the list, by feature key.
const Map<String, String> lanjutanRowHintMs = {
  'liveYoutube': 'Cara video disalurkan dan kadar bit maksimum.',
  'tilawah': 'Had ruang cakera MAXCOM untuk audio tilawah.',
};

/// A sentence under a setting, by setting name (BM).
const Map<String, String> settingHelpMs = {
  'relayVideo':
      'Salin terus guna CPU MAXCOM paling sedikit. Kod semula untuk telefon '
      'yang hantar kadar bit terlalu tinggi.',
  'maxBitrateKbps': 'Ikut kelajuan muat naik internet surau.',
  'cacheMaxMb': 'Audio lama dipadam bila had dicapai. Satu juzuk lebih kurang 40 MB.',
  'segmentMinutes': 'Fail pendek lebih selamat jika telefon terputus.',
  'noVideoSeconds':
      'Berapa lama tiada gambar dari telefon sebelum amaran muncul di aplikasi.',
  'cloudWakeSeconds':
      'Berapa lama MAXCOM menunggu awan bangun sebelum siaran YouTube '
      'diteruskan tanpa awan.',
  'syncHistoryDays':
      'Peranti yang tidak diselaraskan lebih lama dari ini perlu dimuat semula sepenuhnya.',
  'dirtyCheckSeconds':
      'Lebih kerap, perubahan dari rumah sampai lebih cepat, tetapi awan lebih kerap dibangunkan.',
};

/// A sentence under each choice, for the settings drawn as cards.
const Map<String, Map<String, String>> choiceHelpMs = {
  'relayFrom': {
    'box': 'Telefon hantar gambar ke MAXCOM di surau; MAXCOM yang siarkan ke YouTube.',
    'phone':
        'Telefon siarkan sendiri ke YouTube, untuk MAXCOM yang lemah atau '
        'internet surau yang perlahan.',
  },
};

/// Label for one choice of an enum setting; the raw value when unknown.
String choiceLabelMs(String name, String value) =>
    choiceLabelsMs[name]?[value] ?? value;
