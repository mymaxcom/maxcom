// The external camera form and the live screen's words (plan 4.2 to 4.7, task C2)
// in the three languages of the app: each function takes the app language and
// answers BM, English or Arabic from one line, so a language can never be left
// out. BM is word for word what the box-side wording tests expect. Product names
// stay Latin (MAXCOM, YouTube, iPad, RTSP, ONVIF, H.264). Digits stay 0-9. No
// dashes or arrows (labels_test checks this file's text).

import '../app/app_lang.dart';

String _t(AppLang l, String ms, String en, String ar) => switch (l) {
      AppLang.ms => ms,
      AppLang.en => en,
      AppLang.ar => ar,
    };

// ---- Kamera luaran: the form (plan 4.2, 4.3, mockups 07 to 16) ----

String cameraUseTitle(AppLang l) => _t(l, 'Tawarkan kamera luaran', 'Offer the external camera', 'عرض الكاميرا الخارجية كخيار');
String cameraUseOn(AppLang l) => _t(
      l,
      'Dipaparkan sebagai pilihan sebelum siaran',
      'Shown as a choice before the broadcast',
      'تظهر كخيار قبل البث',
    );
String cameraUseOff(AppLang l) => _t(
      l,
      'Tidak dipaparkan sebagai pilihan siaran',
      'Not shown as a broadcast choice',
      'لا تظهر كخيار للبث',
    );
String cameraOffNoteNew(AppLang l) => _t(
      l,
      'Hidupkan untuk menyiarkan kuliah dari kamera IP atau CCTV di surau. Masukkan alamat RTSP, atau guna Cari kamera di rangkaian (ONVIF).',
      'Switch on to stream a kuliah from an IP camera or CCTV at the surau. Enter the RTSP address, or use Find cameras on the network (ONVIF).',
      'فعّلها لبث درس من كاميرا IP أو CCTV في المصلى. أدخل عنوان RTSP، أو استخدم «البحث عن كاميرات في الشبكة» (ONVIF).',
    );
String cameraOffNoteKept(AppLang l, String name) => _t(
      l,
      'Tetapan $name masih disimpan. Ia tidak muncul sebagai pilihan semasa siaran sehingga dihidupkan semula.',
      'The settings of $name are still kept. It does not appear as a choice during a broadcast until it is turned on again.',
      'إعدادات $name ما زالت محفوظة. لا تظهر كخيار أثناء البث حتى تُفعَّل من جديد.',
    );
String cameraDelete(AppLang l) => _t(l, 'Padam tetapan kamera', 'Delete camera settings', 'حذف إعدادات الكاميرا');
String cameraDeleteTitle(AppLang l) => _t(l, 'Padam tetapan kamera?', 'Delete camera settings?', 'حذف إعدادات الكاميرا؟');
String cameraDeleteBody(AppLang l) => _t(
      l,
      'Alamat dan kata laluan kamera dipadam dari MAXCOM, dan alamatnya dari sandaran awan. Anda perlu memasukkannya semula untuk menggunakan kamera ini.',
      'The camera address and password are deleted from MAXCOM, and the address from the cloud backup. You must enter them again to use this camera.',
      'يُحذف عنوان الكاميرا وكلمة مرورها من MAXCOM، ويُحذف العنوان من النسخة الاحتياطية في السحابة. عليك إدخالهما من جديد لاستخدام هذه الكاميرا.',
    );
String cameraDeleteConfirm(AppLang l) => _t(l, 'Padam', 'Delete', 'حذف');
String cameraNameLabel(AppLang l) => _t(l, 'Nama kamera', 'Camera name', 'اسم الكاميرا');
String cameraNameHint(AppLang l) => _t(l, 'Contoh: Kamera Mimbar', 'Example: Pulpit camera', 'مثال: كاميرا المنبر');
String cameraNameHelp(AppLang l) => _t(
      l,
      'Nama ini dipaparkan sebagai pilihan sebelum siaran.',
      'This name is shown as a choice before the broadcast.',
      'يظهر هذا الاسم كخيار قبل البث.',
    );
String cameraKindLabel(AppLang l) => _t(l, 'Jenis sambungan', 'Connection type', 'نوع الاتصال');
String cameraKindSoon(AppLang l) => _t(l, 'Akan datang', 'Coming soon', 'قريبًا');
String cameraKindHelp(AppLang l) => _t(
      l,
      'Kamera IP atau CCTV yang menghantar RTSP pada Wi-Fi atau rangkaian surau.',
      'An IP camera or CCTV that sends RTSP on the surau Wi-Fi or network.',
      'كاميرا IP أو CCTV ترسل RTSP عبر شبكة Wi-Fi أو شبكة المصلى.',
    );
String cameraUrlLabel(AppLang l) => _t(l, 'Alamat RTSP', 'RTSP address', 'عنوان RTSP');
String cameraUrlHint(AppLang l) => 'rtsp://10.168.1.50:554/stream1';
String cameraUrlHelp(AppLang l) => _t(
      l,
      'Dari manual atau aplikasi kamera. Jika alamat sudah mengandungi nama pengguna dan kata laluan, ia disimpan seperti dimasukkan dan medan di bawah boleh dibiarkan kosong.',
      'From the camera manual or app. If the address already contains the user name and password, it is saved as entered and the fields below can be left empty.',
      'من دليل الكاميرا أو تطبيقها. إذا كان العنوان يحتوي على اسم المستخدم وكلمة المرور فيُحفظ كما أُدخل ويمكن ترك الحقلين أدناه فارغين.',
    );
String cameraUrlScheme(AppLang l) => _t(
      l,
      'Alamat mesti bermula dengan rtsp://',
      'The address must start with rtsp://',
      'يجب أن يبدأ العنوان بـ rtsp://',
    );
String cameraDiscover(AppLang l) => _t(l, 'Cari kamera di rangkaian', 'Find cameras on the network', 'البحث عن كاميرات في الشبكة');
String cameraDiscoverTitle(AppLang l) =>
    _t(l, 'Kamera di rangkaian surau', 'Cameras on the surau network', 'كاميرات في شبكة المصلى');
String cameraDiscoverSearching(AppLang l) => _t(
      l,
      'Mencari kamera di rangkaian surau',
      'Searching for cameras on the surau network',
      'جارٍ البحث عن كاميرات في شبكة المصلى',
    );
String cameraDiscoverHelp(AppLang l) => _t(
      l,
      'Ketik satu kamera untuk mengisi alamatnya.',
      'Tap a camera to fill in its address.',
      'اضغط على كاميرا لملء عنوانها.',
    );
String cameraDiscoverNone(AppLang l) => _t(l, 'Tiada kamera ditemui', 'No camera found', 'لم يُعثر على كاميرا');
String cameraDiscoverNoneHelp(AppLang l) => _t(
      l,
      'Tiada kamera dijumpai pada rangkaian surau. Pastikan kamera hidup dan ONVIF dihidupkan, atau tampal alamat RTSP.',
      'No camera was found on the surau network. Make sure the camera is on and ONVIF is enabled, or paste the RTSP address.',
      'لم يُعثر على كاميرا في شبكة المصلى. تأكد من تشغيل الكاميرا وتفعيل ONVIF، أو الصق عنوان RTSP.',
    );
String cameraDiscoverAgain(AppLang l) => _t(l, 'Cari lagi', 'Search again', 'بحث من جديد');
String cameraDiscoverClose(AppLang l) => _t(l, 'Tutup', 'Close', 'إغلاق');
String cameraDiscoverNoName(AppLang l) => _t(l, 'Kamera', 'Camera', 'كاميرا');
String cameraLoginTitle(AppLang l) => _t(l, 'Log masuk kamera', 'Camera sign-in', 'تسجيل الدخول إلى الكاميرا');
String cameraLoginHelp(AppLang l) => _t(
      l,
      'Masukkan nama pengguna dan kata laluan kamera ini, jika ada. MAXCOM menggunakannya untuk mendapatkan alamat RTSP.',
      'Enter the user name and password of this camera, if it has any. The MAXCOM box uses them to get the RTSP address.',
      'أدخل اسم المستخدم وكلمة مرور هذه الكاميرا إن وُجدا. يستخدمهما صندوق MAXCOM للحصول على عنوان RTSP.',
    );
String cameraLoginFill(AppLang l) => _t(l, 'Isi alamat', 'Fill in the address', 'ملء العنوان');
String cameraLoginBack(AppLang l) => _t(l, 'Kembali', 'Back', 'رجوع');
String cameraLoginFilling(AppLang l) => _t(
      l,
      'MAXCOM sedang bertanya kepada kamera',
      'The MAXCOM box is asking the camera',
      'صندوق MAXCOM يسأل الكاميرا',
    );
String cameraDiscoverFilled(AppLang l) => _t(
      l,
      'Alamat diisi. Tekan Simpan untuk menyimpannya.',
      'The address is filled in. Press Save to keep it.',
      'تم ملء العنوان. اضغط حفظ للاحتفاظ به.',
    );
String cameraDiscoverListOnly(AppLang l) => _t(
      l,
      'Alamat kamera diisi. Lengkapkan laluan strim dan log masuk, kemudian tekan Simpan.',
      'The camera address is filled in. Complete the stream path and sign-in, then press Save.',
      'تم ملء عنوان الكاميرا. أكمل مسار البث وتسجيل الدخول، ثم اضغط حفظ.',
    );
String cameraUserLabel(AppLang l) => _t(l, 'Nama pengguna', 'User name', 'اسم المستخدم');
String cameraOptional(AppLang l) => _t(l, 'pilihan', 'optional', 'اختياري');
String cameraLoginHint(AppLang l) => _t(
      l,
      'Kosongkan jika ada dalam alamat',
      'Leave empty if it is in the address',
      'اتركه فارغًا إن كان في العنوان',
    );
String cameraPassLabel(AppLang l) => _t(l, 'Kata laluan', 'Password', 'كلمة المرور');
String cameraPassAgain(AppLang l) => _t(
      l,
      'Masukkan kata laluan semula untuk alamat baharu',
      'Enter the password again for the new address',
      'أدخل كلمة المرور من جديد للعنوان الجديد',
    );
String cameraUserMissing(AppLang l) => _t(
      l,
      'Masukkan nama pengguna bersama kata laluan.',
      'Enter the user name together with the password.',
      'أدخل اسم المستخدم مع كلمة المرور.',
    );
String externalMixFailedMessage(AppLang l) => _t(
      l,
      'Pencampur audio MAXCOM gagal. Siaran mungkin tiada gambar atau bunyi; cuba hentikan dan mulakan semula.',
      'The box audio mixer failed. The broadcast may have no picture or sound; try stopping and starting again.',
      'تعذّر تشغيل مازج الصوت في الصندوق. قد يكون البث بلا صورة أو صوت؛ جرّب الإيقاف ثم البدء من جديد.',
    );
String cameraPassChange(AppLang l) => _t(l, 'Tukar kata laluan', 'Change password', 'تغيير كلمة المرور');
String cameraPassCancel(AppLang l) => _t(l, 'Batal tukar', 'Cancel change', 'إلغاء التغيير');
String cameraPassShow(AppLang l) => _t(l, 'Tunjuk kata laluan', 'Show password', 'إظهار كلمة المرور');
String cameraPassHide(AppLang l) => _t(l, 'Sembunyi kata laluan', 'Hide password', 'إخفاء كلمة المرور');
String cameraPassKept(AppLang l) => _t(l, 'Kata laluan disimpan', 'Password saved', 'كلمة المرور محفوظة');
String cameraPassHelpKept(AppLang l) => _t(
      l,
      'Disimpan bersulit di MAXCOM sahaja, tidak di awan. Tidak dipaparkan semula.',
      'Saved encrypted on the MAXCOM box only, never in the cloud. It is not shown again.',
      'تُحفظ مشفّرة في صندوق MAXCOM فقط، ولا تُحفظ في السحابة. ولا تُعرض مرة أخرى.',
    );
String cameraPassHelpNew(AppLang l) => _t(
      l,
      'Disimpan bersulit di MAXCOM sahaja, tidak di awan.',
      'Saved encrypted on the MAXCOM box only, never in the cloud.',
      'تُحفظ مشفّرة في صندوق MAXCOM فقط، ولا تُحفظ في السحابة.',
    );
String cameraPassNeeded(AppLang l) => _t(
      l,
      'Kata laluan kamera perlu ditaip semula',
      'The camera password must be typed again',
      'يجب كتابة كلمة مرور الكاميرا من جديد',
    );
String cameraPassNeededHelp(AppLang l) => _t(
      l,
      'Alamat dan nama pengguna dipulihkan dari sandaran awan. Kata laluan tidak pernah disimpan di awan.',
      'The address and user name were restored from the cloud backup. The password is never kept in the cloud.',
      'استُعيد العنوان واسم المستخدم من النسخة الاحتياطية في السحابة. لا تُحفظ كلمة المرور في السحابة أبدًا.',
    );
String cameraPassHelpChanging(AppLang l) => _t(
      l,
      'Kata laluan lama diganti bila anda tekan Simpan.',
      'The old password is replaced when you press Save.',
      'تُستبدل كلمة المرور القديمة عند الضغط على حفظ.',
    );
String cameraAudioLabel(AppLang l) => _t(l, 'Audio pada kamera', 'Camera audio', 'صوت الكاميرا');
String cameraAudioUnknown(AppLang l) => _t(
      l,
      'Belum diketahui. Dikesan semasa Uji sambungan.',
      'Not known yet. Detected during Test connection.',
      'غير معروف بعد. يُكتشف أثناء اختبار الاتصال.',
    );
String cameraAudioHas(AppLang l, String codec) => codec.isEmpty
    ? _t(l, 'Ada', 'Yes', 'نعم')
    : _t(l, 'Ada, $codec', 'Yes, $codec', 'نعم، $codec');
String cameraAudioNone(AppLang l) => _t(l, 'Kamera ini tiada audio', 'This camera has no audio', 'هذه الكاميرا بلا صوت');
String cameraAudioHelp(AppLang l) => _t(
      l,
      'Audio kamera digunakan bersama gambarnya. Sumber lain boleh ditambah dan dicampur sebelum setiap siaran.',
      'The camera audio is used together with its picture. Other sources can be added and mixed before each broadcast.',
      'يُستخدم صوت الكاميرا مع صورتها. يمكن إضافة مصادر أخرى ودمجها قبل كل بث.',
    );
String cameraTest(AppLang l) => _t(l, 'Uji sambungan', 'Test connection', 'اختبار الاتصال');
String cameraTestHelp(AppLang l) => _t(
      l,
      'Alamat yang belum disimpan disimpan dahulu. MAXCOM kemudian cuba menyambung ke kamera dan memeriksa gambar dan audionya.',
      'An address that is not saved yet is saved first. The MAXCOM box then tries to connect to the camera and checks its picture and audio.',
      'يُحفظ العنوان غير المحفوظ أولًا. ثم يحاول صندوق MAXCOM الاتصال بالكاميرا ويفحص صورتها وصوتها.',
    );
String cameraTestRunning(AppLang l) => _t(
      l,
      'MAXCOM sedang menyambung ke kamera',
      'The MAXCOM box is connecting to the camera',
      'صندوق MAXCOM يتصل بالكاميرا',
    );
String cameraTestRunningDetail(AppLang l, String host) => _t(
      l,
      'Menghubungi $host. Ini mengambil masa hingga 15 saat.',
      'Contacting $host. This takes up to 15 seconds.',
      'جارٍ الاتصال بـ $host. يستغرق هذا حتى 15 ثانية.',
    );
String cameraTestOk(AppLang l) => _t(
      l,
      'Berjaya. MAXCOM menerima gambar dari kamera.',
      'It worked. The box receives the picture from the camera.',
      'نجح الاختبار. يستقبل الصندوق الصورة من الكاميرا.',
    );
String cameraTestUnreachable(AppLang l) => _t(
      l,
      'Gagal: kamera tidak dapat dihubungi',
      'Failed: the camera cannot be reached',
      'فشل الاختبار: تعذّر الوصول إلى الكاميرا',
    );
String cameraTestUnreachableDetail(AppLang l, String host) => _t(
      l,
      'MAXCOM tidak mendapat jawapan dari $host. Semak alamat, pastikan kamera dihidupkan dan berada pada Wi-Fi atau rangkaian surau yang sama.',
      'The box got no answer from $host. Check the address and make sure the camera is on and on the same Wi-Fi or surau network.',
      'لم يتلقَّ الصندوق ردًّا من $host. تحقق من العنوان وتأكد من تشغيل الكاميرا واتصالها بشبكة Wi-Fi أو شبكة المصلى نفسها.',
    );
String cameraTestLogin(AppLang l) => _t(
      l,
      'Gagal: nama pengguna atau kata laluan salah',
      'Failed: wrong user name or password',
      'فشل الاختبار: اسم المستخدم أو كلمة المرور غير صحيحين',
    );
String cameraTestLoginDetail(AppLang l) => _t(
      l,
      'Kamera menolak log masuk. Semak nama pengguna dan kata laluan di sini atau di dalam alamat RTSP. Sesetengah kamera mengunci akaun selepas beberapa cubaan salah.',
      'The camera refused the sign-in. Check the user name and password here or inside the RTSP address. Some cameras lock the account after a few wrong attempts.',
      'رفضت الكاميرا تسجيل الدخول. تحقق من اسم المستخدم وكلمة المرور هنا أو داخل عنوان RTSP. بعض الكاميرات تقفل الحساب بعد عدة محاولات خاطئة.',
    );
String cameraTestPath(AppLang l) => _t(
      l,
      'Gagal: alamat strim tidak dijumpai',
      'Failed: the stream address was not found',
      'فشل الاختبار: لم يُعثر على عنوان البث',
    );
String cameraTestPathDetail(AppLang l) => _t(
      l,
      'Kamera menjawab tetapi tiada strim di alamat ini. Semak laluan dalam manual kamera, contohnya /stream1 atau /live/ch0.',
      'The camera answered but there is no stream at this address. Check the path in the camera manual, for example /stream1 or /live/ch0.',
      'ردّت الكاميرا لكن لا يوجد بث على هذا العنوان. تحقق من المسار في دليل الكاميرا، مثل /stream1 أو /live/ch0.',
    );
String cameraTestCodec(AppLang l) => _t(
      l,
      'Gagal: codec tidak disokong, guna H.264',
      'Failed: the codec is not supported, use H.264',
      'فشل الاختبار: الترميز غير مدعوم، استخدم H.264',
    );
String cameraTestCodecDetail(AppLang l) => _t(
      l,
      'Kamera menghantar format video yang tidak dapat dibaca. Tukar pengekodan strim utama kepada H.264 dalam tetapan kamera, kemudian uji semula.',
      'The camera sends a video format that cannot be read. Change the main stream encoding to H.264 in the camera settings, then test again.',
      'ترسل الكاميرا صيغة فيديو لا يمكن قراءتها. غيّر ترميز البث الرئيسي إلى H.264 في إعدادات الكاميرا، ثم اختبر من جديد.',
    );
String cameraTestNeedUrl(AppLang l) => _t(
      l,
      'Masukkan alamat kamera dahulu.',
      'Enter the camera address first.',
      'أدخل عنوان الكاميرا أولًا.',
    );
String cameraTestOther(AppLang l) => _t(l, 'Ujian tidak dapat dijalankan', 'The test could not be run', 'تعذّر إجراء الاختبار');
String cameraTestBoxAway(AppLang l) => _t(
      l,
      'MAXCOM tidak dapat dihubungi. Cuba lagi di surau.',
      'MAXCOM cannot be reached. Try again at the surau.',
      'تعذّر الوصول إلى MAXCOM. حاول مرة أخرى في المصلى.',
    );
String cameraChipNoAudio(AppLang l) => _t(l, 'Tiada audio', 'No audio', 'بلا صوت');
String cameraChipAudio(AppLang l, String codec) => _t(l, 'Audio $codec', 'Audio $codec', 'صوت $codec');
String cameraChipTransport(AppLang l, String t) => _t(l, 'Pengangkutan $t', 'Transport $t', 'النقل $t');
String cameraLanjutan(AppLang l) => _t(l, 'Lanjutan', 'Advanced', 'متقدم');
String cameraLanjutanSummary(AppLang l, String transportLabel) =>
    _t(l, 'Pengangkutan: $transportLabel', 'Transport: $transportLabel', 'النقل: $transportLabel');
String cameraTransportHelp(AppLang l) => _t(
      l,
      'Automatik cuba TCP dahulu, kemudian UDP jika gambar tidak sampai. Pilih TCP atau UDP hanya jika Automatik tidak berjaya.',
      'Automatic tries TCP first, then UDP if the picture does not arrive. Choose TCP or UDP only if Automatic does not work.',
      'يجرّب الوضع التلقائي TCP أولًا ثم UDP إذا لم تصل الصورة. اختر TCP أو UDP فقط إذا لم ينجح الوضع التلقائي.',
    );
String cameraBrightnessHelp(AppLang l) => _t(
      l,
      'Automatik menerangkan gambar hanya apabila hari gelap, seperti waktu senja. Pilih Cerah atau Lebih cerah jika gambar sentiasa terlalu gelap.',
      'Automatic brightens the picture only when it is dark, such as at dusk. Choose Bright or Brighter if the picture is always too dark.',
      'يُضيء الوضع التلقائي الصورة فقط عند الظلام، مثل وقت الغروب. اختر ساطع أو أكثر سطوعًا إذا كانت الصورة داكنة دائمًا.',
    );
String cameraNetworkNotice(AppLang l) => _t(
      l,
      'Telefon atau MAXCOM yang menarik video mesti berada pada Wi-Fi surau yang sama dengan kamera. Internet tidak diperlukan untuk siaran ke skrin surau.',
      'The phone or box that pulls the video must be on the same surau Wi-Fi as the camera. The internet is not needed to broadcast to the surau screen.',
      'يجب أن يكون الهاتف أو الصندوق الذي يسحب الفيديو على شبكة Wi-Fi المصلى نفسها التي تتصل بها الكاميرا. لا حاجة إلى الإنترنت للبث إلى شاشة المصلى.',
    );
/// The camera routes live only on the box (the sealed login is there): over the cloud, or on a 404, this is shown.
String cameraAtSurauOnly(AppLang l) => _t(
      l,
      'Tetapan kamera hanya boleh dibuat di surau. Sambung telefon ke Wi-Fi surau, kemudian buka halaman ini semula. Di sini anda boleh masukkan alamat RTSP kamera atau guna ${cameraDiscover(l)} (ONVIF).',
      "Camera settings can only be made at the surau. Connect the phone to the surau Wi-Fi, then open this page again. There you can enter the camera's RTSP address or use ${cameraDiscover(l)} (ONVIF).",
      'يمكن ضبط إعدادات الكاميرا في المصلى فقط. صِل الهاتف بشبكة Wi-Fi الخاصة بالمصلى، ثم افتح هذه الصفحة مرة أخرى. هناك يمكنك إدخال عنوان RTSP للكاميرا أو استخدام «${cameraDiscover(l)}» (ONVIF).',
    );
/// Over the cloud: the change was sealed and sent, the box has not applied it yet.
String cameraCloudPending(AppLang l) => _t(
      l,
      'Dihantar ke MAXCOM. Akan digunakan selepas MAXCOM menerima (biasanya dalam 2 minit).',
      'Sent to the box. It will be used once the box receives it (usually within 2 minutes).',
      'أُرسلت إلى الصندوق. سيُستخدم بعد أن يستلمها الصندوق (عادةً خلال دقيقتين).',
    );
/// Over the cloud: the ONVIF search scans the surau network, so it is offered there only.
String cameraDiscoverSurauOnly(AppLang l) => _t(
      l,
      'Cari kamera (ONVIF) hanya di Wi-Fi surau.',
      'Finding cameras (ONVIF) works only on the surau Wi-Fi.',
      'البحث عن الكاميرات (ONVIF) متاح فقط على شبكة Wi-Fi الخاصة بالمصلى.',
    );
/// Over the cloud: the test needs the box next to the camera.
String cameraTestSurauOnly(AppLang l) => _t(
      l,
      'Uji kamera hanya di Wi-Fi surau.',
      'The camera test works only on the surau Wi-Fi.',
      'اختبار الكاميرا متاح فقط على شبكة Wi-Fi الخاصة بالمصلى.',
    );
/// Over the cloud with no box linked to it: there is nobody to send the setting to.
String cameraCloudNoBox(AppLang l) => _t(
      l,
      'MAXCOM belum disambung ke awan, jadi kamera hanya boleh ditetapkan di Wi-Fi surau.',
      'The box is not linked to the cloud, so the camera can only be set on the surau Wi-Fi.',
      'الصندوق غير متصل بالسحابة، لذا يمكن ضبط الكاميرا على شبكة Wi-Fi الخاصة بالمصلى فقط.',
    );
/// The box looked at a change sent through the cloud and did not use it: a fixed code in, the person's words out.
String cameraCloudRefused(AppLang l, String? code) => switch (code) {
      'bad_address' => _t(
          l,
          'MAXCOM tidak menerima alamat itu. Gunakan alamat rtsp:// dengan alamat IPv4 persendirian di rangkaian surau.',
          'The box did not accept that address. Use an rtsp:// address with a private IPv4 address on the surau network.',
          'لم يقبل الصندوق هذا العنوان. استخدم عنوان rtsp:// بعنوان IPv4 خاص في شبكة المصلى.',
        ),
      'bad_login' => _t(
          l,
          'MAXCOM tidak menerima nama pengguna atau kata laluan itu. Semak aksara yang digunakan.',
          'The box did not accept that username or password. Check the characters used.',
          'لم يقبل الصندوق اسم المستخدم أو كلمة المرور. تحقق من الأحرف المستخدمة.',
        ),
      'password_again' => cameraPassAgain(l),
      _ => _t(
          l,
          'MAXCOM tidak dapat menggunakan tetapan itu. Cuba hantar semula.',
          'The box could not use that setting. Try sending it again.',
          'تعذر على الصندوق استخدام هذا الإعداد. حاول إرساله مرة أخرى.',
        ),
    };
String cameraLoadFailed(AppLang l) => _t(
      l,
      'Tetapan kamera tidak dapat dimuatkan.',
      'The camera settings could not be loaded.',
      'تعذّر تحميل إعدادات الكاميرا.',
    );
String cameraRetry(AppLang l) => _t(l, 'Cuba lagi', 'Try again', 'أعد المحاولة');
String cameraNoPermission(AppLang l) => _t(
      l,
      'Tiada kebenaran untuk tindakan ini',
      'You do not have permission for this action',
      'لا تملك صلاحية لهذا الإجراء',
    );

// ---- Siaran langsung: before the live (plan 4.4) and health messages (4.7), for the live screen ----

String liveSourceVideoTitle(AppLang l) => _t(l, 'Sumber video', 'Video source', 'مصدر الفيديو');
String liveSourcePhoneCamera(AppLang l) => _t(l, 'Kamera telefon', 'Phone camera', 'كاميرا الهاتف');
String liveSourceIpadCamera(AppLang l) => _t(l, 'Kamera iPad', 'iPad camera', 'كاميرا iPad');
String liveSourceExternalCamera(AppLang l) => _t(l, 'Kamera luaran', 'External camera', 'الكاميرا الخارجية');
String liveCameraUnreachableNote(AppLang l) => _t(
      l,
      'Kamera tidak dapat dihubungi. Siaran akan bermula tanpa gambar kamera sehingga ia disambung.',
      'The camera cannot be reached. The broadcast will start without the camera picture until it is connected.',
      'تعذّر الوصول إلى الكاميرا. سيبدأ البث بلا صورة الكاميرا حتى يتم توصيلها.',
    );
String liveCameraDisabledNote(AppLang l) => _t(
      l,
      'Kamera luaran dimatikan di Tetapan.',
      'The external camera is turned off in Settings.',
      'الكاميرا الخارجية متوقفة في الإعدادات.',
    );
String liveAudioTitle(AppLang l) => _t(l, 'Audio', 'Audio', 'الصوت');
String liveAudioCameraRow(AppLang l) => _t(l, 'Audio kamera luaran', 'External camera audio', 'صوت الكاميرا الخارجية');
String liveAudioPhoneMicRow(AppLang l) => _t(l, 'Mikrofon telefon ini', 'This phone microphone', 'ميكروفون هذا الهاتف');
String liveAudioIpadMicRow(AppLang l) => _t(l, 'Mikrofon iPad ini', 'This iPad microphone', 'ميكروفون هذا الـ iPad');
String liveAudioPhoneMicShort(AppLang l) => _t(l, 'Mikrofon telefon', 'Phone microphone', 'ميكروفون الهاتف');
String liveAudioIpadMicShort(AppLang l) => _t(l, 'Mikrofon iPad', 'iPad microphone', 'ميكروفون iPad');
String liveAudioBoxInputRow(AppLang l) => _t(l, 'Mic-in pada MAXCOM', 'Mic-in on the box', 'مدخل الميكروفون في الصندوق');
String liveAudioAdd(AppLang l) => _t(l, 'Tambah audio', 'Add audio', 'إضافة صوت');
String liveAudioRemove(AppLang l) => _t(l, 'Buang', 'Remove', 'إزالة');
String liveAudioVolume(AppLang l) => _t(l, 'Kelantangan', 'Volume', 'مستوى الصوت');
String liveAudioBoxInputMissing(AppLang l) => _t(
      l,
      'Tiada input audio pada MAXCOM ini',
      'This box has no audio input',
      'لا يوجد مدخل صوت في هذا الصندوق',
    );
String liveAudioCameraNone(AppLang l) => _t(l, 'Kamera ini tiada audio', 'This camera has no audio', 'هذه الكاميرا بلا صوت');
String liveAudioAligning(AppLang l) => _t(l, 'Sedang diselaraskan', 'Aligning', 'جارٍ ضبط التوقيت');
String liveAudioAligned(AppLang l) => _t(l, 'Selaras', 'Aligned', 'متوافق');
String liveAudioAlignedLong(AppLang l) => _t(
      l,
      'Audio diselaraskan secara automatik.',
      'The audio is aligned automatically.',
      'يُضبط توقيت الصوت تلقائيًا.',
    );
String liveAudioOffsetTitle(AppLang l) => _t(l, 'Imbangan masa audio', 'Audio time offset', 'إزاحة توقيت الصوت');
String liveAudioClapTest(AppLang l) => _t(l, 'Uji tepukan', 'Clap test', 'اختبار التصفيق');
String liveAudioPhoneNearSpeaker(AppLang l) => _t(
      l,
      'Letak telefon dekat penceramah dan kekalkan skrin terbuka.',
      'Put the phone near the speaker and keep the screen on.',
      'ضع الهاتف قرب المحاضر وأبقِ الشاشة مفتوحة.',
    );
String liveAudioIpadNearSpeaker(AppLang l) => _t(
      l,
      'Letak iPad dekat penceramah dan kekalkan skrin terbuka. Mengunci skrin akan menghentikan mikrofon.',
      'Put the iPad near the speaker and keep the screen on. Locking the screen stops the microphone.',
      'ضع الـ iPad قرب المحاضر وأبقِ الشاشة مفتوحة. قفل الشاشة يوقف الميكروفون.',
    );
String liveAudioCameraVolumeHint(AppLang l) => _t(
      l,
      'Mikrofon kamera biasanya jauh dan bising. Rendahkan kelantangannya jika suara kurang jelas.',
      'The camera microphone is usually far away and noisy. Lower its volume if voices are not clear.',
      'ميكروفون الكاميرا يكون عادةً بعيدًا ومزعجًا. اخفض مستوى صوته إذا لم تكن الأصوات واضحة.',
    );
String liveAudioAllMuted(AppLang l) => _t(
      l,
      'Semua sumber audio disenyapkan. Siaran tiada bunyi.',
      'All audio sources are muted. The broadcast has no sound.',
      'كُتمت جميع مصادر الصوت. لا يوجد صوت في البث.',
    );
String liveAudioBoxInputInPhoneLive(AppLang l) => _t(
      l,
      'Rakaman di telefon tidak mengandungi bunyi Mic-in pada MAXCOM.',
      'The recording on the phone does not contain the Mic-in sound of the box.',
      'لا يحتوي التسجيل على الهاتف على صوت مدخل الميكروفون في الصندوق.',
    );
String liveAudioNoCameraNoneAdded(AppLang l) => _t(
      l,
      'Kamera ini tiada audio. Tekan Tambah audio untuk memilih mikrofon, atau siaran tiada bunyi.',
      'This camera has no audio. Press Add audio to choose a microphone, or the broadcast has no sound.',
      'هذه الكاميرا بلا صوت. اضغط «إضافة صوت» لاختيار ميكروفون، وإلا فلن يكون للبث صوت.',
    );

/// `source` in the messages below: Mikrofon telefon, Mikrofon iPad or Mic-in pada MAXCOM, in the same language.
String liveAudioAligningMsg(AppLang l, String source) => _t(
      l,
      'Sedang menyelaraskan $source dengan audio kamera...',
      'Aligning $source with the camera audio...',
      'جارٍ ضبط توقيت $source مع صوت الكاميرا...',
    );
String liveAudioAlignFailedAudible(AppLang l, String source) => _t(
      l,
      'Penyelarasan automatik belum berjaya, jadi $source belum dicampur supaya suara tidak kedengaran berganda. Pastikan ada suara di dalam surau dan kamera boleh mendengarnya.',
      'Automatic alignment has not worked yet, so $source is not mixed in, to keep voices from sounding doubled. Make sure there is sound in the surau and the camera can hear it.',
      'لم ينجح الضبط التلقائي بعد، لذلك لم يُدمج $source حتى لا يُسمع الصوت مزدوجًا. تأكد من وجود صوت داخل المصلى وأن الكاميرا تسمعه.',
    );
String liveAudioUseSourceOnly(AppLang l, String source) =>
    _t(l, 'Guna $source sahaja', 'Use $source only', 'استخدم $source فقط');
String liveAudioAlignFailedMuted(AppLang l) => _t(
      l,
      'Penyelarasan automatik belum berjaya. Bunyi mungkin tidak selari dengan gambar.',
      'Automatic alignment has not worked yet. The sound may not match the picture.',
      'لم ينجح الضبط التلقائي بعد. قد لا يتوافق الصوت مع الصورة.',
    );
String liveAudioCameraNoAudioAdded(AppLang l, String source) => _t(
      l,
      'Kamera ini tiada audio. $source digunakan bersendirian. Tetapkan Imbangan masa audio dengan Uji tepukan.',
      'This camera has no audio. $source is used alone. Set Audio time offset with Clap test.',
      'هذه الكاميرا بلا صوت. يُستخدم $source وحده. اضبط «إزاحة توقيت الصوت» باختبار التصفيق.',
    );
String liveAudioSourceLostAudible(AppLang l, String source) => _t(
      l,
      '$source terputus. Siaran diteruskan dengan audio kamera.',
      '$source was cut off. The broadcast continues with the camera audio.',
      'انقطع $source. يستمر البث بصوت الكاميرا.',
    );
String liveAudioSourceLostMuted(AppLang l, String source) => _t(
      l,
      '$source terputus. Siaran diteruskan tanpa bunyi.',
      '$source was cut off. The broadcast continues without sound.',
      'انقطع $source. يستمر البث بدون صوت.',
    );

/// Two or more source names in one sentence: `A dan B`.
String liveAudioJoin(AppLang l, List<String> names) => names.join(_t(l, ' dan ', ' and ', ' و'));

// ---- Siaran langsung: the screen's rows, chips, sections and sheets (task C2) ----

String liveSourceSwitchFailed(AppLang l) => _t(
      l,
      'Sumber video tidak dapat ditukar. Sumber sebelumnya masih digunakan.',
      'The video source could not be changed. The previous source is still in use.',
      'تعذّر تغيير مصدر الفيديو. ما زال المصدر السابق قيد الاستخدام.',
    );
String liveCameraSourceFailed(AppLang l) => _t(
      l,
      'Alamat kamera luaran tidak dapat diambil dari MAXCOM. Kamera telefon digunakan.',
      'The external camera address could not be fetched from the box. The phone camera is used.',
      'تعذّر جلب عنوان الكاميرا الخارجية من الصندوق. تُستخدم كاميرا الهاتف.',
    );
String liveAudioStatusReceived(AppLang l) => _t(l, 'Diterima', 'Received', 'مستلَم');
String liveMicNewToast(AppLang l, String name) => _t(
      l,
      'Mikrofon baharu: $name. Digunakan untuk siaran.',
      'New microphone: $name. Used for the live.',
      'ميكروفون جديد: $name. يُستخدم في البث.',
    );
String liveMicUnplugged(AppLang l, String name) => _t(
      l,
      'Mikrofon $name dicabut. Kembali ke mikrofon peranti.',
      'Microphone $name was unplugged. Back to the device microphone.',
      'تم فصل الميكروفون $name. العودة إلى ميكروفون الجهاز.',
    );
/// The system gave no product name: the microphone is named by its kind, in the app language (F12).
String liveMicBuiltinName(AppLang l) => _t(l, 'Mikrofon peranti', 'Device microphone', 'ميكروفون الجهاز');
String liveMicExternalName(AppLang l) => _t(l, 'Mikrofon luaran', 'External microphone', 'ميكروفون خارجي');
String liveMicUnavailable(AppLang l, String name) => _t(
      l,
      'Mikrofon $name tidak dapat digunakan; siaran menggunakan mikrofon peranti.',
      'The microphone $name cannot be used; the live uses the device microphone.',
      'تعذّر استخدام الميكروفون $name؛ يستخدم البث ميكروفون الجهاز.',
    );
String liveMicTrrsHint(AppLang l) => _t(
      l,
      'Fon kepala dikesan tanpa mikrofon. Gunakan mikrofon 4-kutub (TRRS) atau penyesuai TRRS.',
      'Headphones are detected without a microphone. Use a 4-pole (TRRS) microphone or a TRRS adapter.',
      'تم اكتشاف سماعات بدون ميكروفون. استخدم ميكروفونًا رباعي الأقطاب (TRRS) أو محوّل TRRS.',
    );
String liveMicUndo(AppLang l) => _t(l, 'Batal', 'Undo', 'تراجع');

// ---- Phone inputs as rows, the loudness lift, Bluetooth (2026.11.15, lane P1) ----

/// The per-source switch that raises quiet speech to a comfortable level.
String liveAudioLift(AppLang l) => _t(l, 'Naikkan suara perlahan', 'Lift quiet sound', 'رفع الصوت الخافت');
String liveAudioInputUse(AppLang l) => _t(l, 'Guna sumber ini', 'Use this source', 'استخدام هذا المصدر');
String liveAudioStatusOff(AppLang l) => _t(l, 'Tidak digunakan', 'Not used', 'غير مستخدم');
String liveAudioInputGone(AppLang l) => _t(l, 'Tidak disambungkan', 'Not connected', 'غير متصل');
String liveAudioOnePhoneInput(AppLang l) => _t(
      l,
      'Satu mikrofon sahaja pada satu masa pada peranti ini. Menghidupkan yang ini mematikan mikrofon lain pada peranti.',
      'One microphone at a time on this device. Turning this one on turns the other microphone on the device off.',
      'ميكروفون واحد فقط في كل مرة على هذا الجهاز. تشغيل هذا الميكروفون يوقف الميكروفون الآخر على الجهاز.',
    );
String liveAudioBluetoothQuality(AppLang l) => _t(
      l,
      'Bunyi Bluetooth bermutu telefon.',
      'Bluetooth sound is telephone quality.',
      'جودة صوت البلوتوث مثل جودة المكالمات الهاتفية.',
    );
String liveAudioBluetoothDenied(AppLang l) => _t(
      l,
      'Kebenaran Bluetooth diperlukan untuk mikrofon ini. Benarkan di tetapan telefon. Siaran diteruskan dengan mikrofon sedia ada.',
      'Bluetooth permission is needed for this microphone. Allow it in the phone settings. The live goes on with the current microphone.',
      'يلزم إذن البلوتوث لهذا الميكروفون. اسمح به من إعدادات الهاتف. يستمر البث بالميكروفون الحالي.',
    );
String liveMicBluetoothName(AppLang l) => _t(l, 'Mikrofon Bluetooth', 'Bluetooth microphone', 'ميكروفون بلوتوث');
String liveAudioMuteSource(AppLang l) => _t(l, 'Senyapkan sumber ini', 'Mute this source', 'كتم هذا المصدر');
String liveAudioUnmuteSource(AppLang l) => _t(l, 'Hidupkan bunyi sumber ini', 'Unmute this source', 'تشغيل صوت هذا المصدر');
String liveAudioStatusReady(AppLang l) => _t(l, 'Sedia', 'Ready', 'جاهز');
String liveCameraUnreachableShort(AppLang l) =>
    _t(l, 'Kamera tidak dapat dihubungi', 'The camera cannot be reached', 'تعذّر الوصول إلى الكاميرا');
String liveAudioStatusCameraLost(AppLang l) =>
    _t(l, 'Terputus bersama gambar', 'Cut off together with the picture', 'انقطع مع الصورة');
String liveAudioStatusCameraBack(AppLang l) => _t(
      l,
      'Kembali. Dicampur semula bila selaras',
      'Back. Mixed in again once aligned',
      'عاد. يُدمج من جديد عند التوافق',
    );
String liveAudioStatusMuted(AppLang l) => _t(l, 'Disenyapkan', 'Muted', 'مكتوم');
String liveAudioStatusMixed(AppLang l) => _t(l, 'Dicampur', 'Mixed in', 'مدمج');
String liveAudioStatusReadyMixed(AppLang l) => _t(l, 'Sedia, dicampur', 'Ready, mixed in', 'جاهز، مدمج');
String liveAudioStatusBoxSignal(AppLang l) =>
    _t(l, 'Isyarat dikesan pada MAXCOM', 'Signal detected on the box', 'رُصدت إشارة في الصندوق');
String liveAudioAlignWhenLive(AppLang l) =>
    _t(l, 'Diselaraskan bila siaran bermula', 'Aligned when the broadcast starts', 'يُضبط التوقيت عند بدء البث');
String liveAudioOffsetChip(AppLang l, int ms) => _t(l, 'Imbangan +$ms ms', 'Offset +$ms ms', 'إزاحة +$ms ms');
String liveAudioStatusAlone(AppLang l) => _t(l, 'Digunakan bersendirian', 'Used alone', 'يُستخدم وحده');
String liveAudioStatusMicLost(AppLang l) =>
    _t(l, 'Terputus. Menyambung semula', 'Cut off. Reconnecting', 'انقطع. جارٍ إعادة الاتصال');
String liveAudioAlignAfterReturn(AppLang l) =>
    _t(l, 'Diselaraskan semula bila kembali', 'Aligned again when back', 'يُضبط التوقيت عند العودة');
String liveAudioAlignWhenCamera(AppLang l) => _t(
      l,
      'Diselaraskan bila kamera disambung',
      'Aligned when the camera is connected',
      'يُضبط التوقيت عند توصيل الكاميرا',
    );
String liveAudioStatusWithLastPicture(AppLang l) => _t(
      l,
      'Diteruskan bersama gambar terakhir',
      'Continues with the last picture',
      'يستمر مع آخر صورة',
    );
String liveAudioStatusAtLastDelay(AppLang l) =>
    _t(l, 'Diteruskan pada lengah terakhir', 'Continues at the last delay', 'يستمر عند آخر تأخير');
String liveAudioNotAligned(AppLang l) => _t(l, 'Belum selaras', 'Not aligned yet', 'غير متوافق بعد');
String liveAudioStatusNotMixed(AppLang l) => _t(l, 'Belum dicampur', 'Not mixed in yet', 'لم يُدمج بعد');
String liveAudioStatusMixedMaybeOff(AppLang l) => _t(
      l,
      'Dicampur, mungkin tidak selari',
      'Mixed in, may be out of step',
      'مدمج، وقد لا يتوافق مع الصورة',
    );
String liveAudioStatusHeldOut(AppLang l) => _t(
      l,
      'Belum dicampur sehingga selaras',
      'Not mixed in until aligned',
      'لا يُدمج حتى يتوافق',
    );
String liveAudioStatusMixedPictureSoon(AppLang l) => _t(
      l,
      'Dicampur. Gambar diselaraskan sebentar lagi',
      'Mixed in. The picture is aligned shortly',
      'مدمج. تُضبط الصورة بعد قليل',
    );
String liveAudioAllMutedBody(AppLang l) => _t(
      l,
      'Naikkan kelantangan sekurang-kurangnya satu sumber jika siaran perlu bunyi.',
      'Raise the volume of at least one source if the broadcast needs sound.',
      'ارفع مستوى صوت مصدر واحد على الأقل إذا كان البث يحتاج إلى صوت.',
    );
String liveAudioAligningHeldOut(AppLang l, String source) => _t(
      l,
      'Sedang menyelaraskan $source dengan audio kamera. Ia belum dicampur supaya suara tidak kedengaran berganda. Biasanya selesai dalam masa kurang 1 minit bila ada suara di dalam surau.',
      'Aligning $source with the camera audio. It is not mixed in yet, to keep voices from sounding doubled. This usually takes less than 1 minute when there is sound in the surau.',
      'جارٍ ضبط توقيت $source مع صوت الكاميرا. لم يُدمج بعد حتى لا يُسمع الصوت مزدوجًا. يستغرق ذلك عادةً أقل من دقيقة عند وجود صوت داخل المصلى.',
    );
String liveAudioAligningMixed(AppLang l, String source) => _t(
      l,
      'Audio kamera pada 0%, jadi $source sudah dicampur. Gambar dan bunyi diselaraskan sebaik penyelarasan selesai.',
      'The camera audio is at 0%, so $source is already mixed in. The picture and sound are aligned as soon as the alignment finishes.',
      'صوت الكاميرا عند 0%، لذلك دُمج $source بالفعل. تُضبط الصورة والصوت فور انتهاء الضبط.',
    );
String liveBoxLateNote(AppLang l) => _t(
      l,
      'Mic-in pada MAXCOM dicampur di MAXCOM, jadi siaran sampai ke skrin surau dan YouTube 1 hingga 2 saat lewat.',
      'The Mic-in on the box is mixed on the MAXCOM box, so the broadcast reaches the surau screen and YouTube 1 to 2 seconds late.',
      'يُدمج مدخل الميكروفون في صندوق MAXCOM، لذلك يصل البث إلى شاشة المصلى وYouTube متأخرًا من ثانية إلى ثانيتين.',
    );
String liveBoxPullNote(AppLang l, String cameraName) => _t(
      l,
      'Di iPad, MAXCOM yang menarik gambar dan audio dari $cameraName dan menghantar pratonton ke iPad ini. Siaran yang digabungkan di MAXCOM sampai ke skrin surau dan YouTube 1 hingga 2 saat lewat.',
      'On the iPad, the MAXCOM box pulls the picture and audio from $cameraName and sends a preview to this iPad. The broadcast combined at the box reaches the surau screen and YouTube 1 to 2 seconds late.',
      'على iPad، يسحب صندوق MAXCOM الصورة والصوت من $cameraName ويرسل معاينة إلى هذا الجهاز. يصل البث المدمج في الصندوق إلى شاشة المصلى وYouTube متأخرًا من ثانية إلى ثانيتين.',
    );
String livePhonePullNote(AppLang l, String cameraName, {required bool mic}) => _t(
      l,
      'Telefon ini menarik gambar dan audio dari $cameraName dan menghantar siaran ke MAXCOM. ${mic ? liveAudioPhoneNearSpeaker(l) : 'Kekalkan skrin terbuka.'}',
      'This phone pulls the picture and audio from $cameraName and sends the broadcast to the MAXCOM box. ${mic ? liveAudioPhoneNearSpeaker(l) : 'Keep the screen on.'}',
      'يسحب هذا الهاتف الصورة والصوت من $cameraName ويرسل البث إلى صندوق MAXCOM. ${mic ? liveAudioPhoneNearSpeaker(l) : 'أبقِ الشاشة مفتوحة.'}',
    );
String liveAudioSummaryMuted(AppLang l) =>
    _t(l, 'Semua sumber disenyapkan', 'All sources are muted', 'كُتمت جميع المصادر');
String liveAudioSummaryCamera(AppLang l) => _t(l, 'Audio kamera', 'Camera audio', 'صوت الكاميرا');
String liveAudioSummaryNoCameraAudio(AppLang l) =>
    _t(l, ', kamera tiada audio', ', the camera has no audio', '، الكاميرا بلا صوت');
String liveAudioSummaryAligned(AppLang l) => _t(l, ', selaras', ', aligned', '، متوافق');
String liveAudioSummaryNotAligned(AppLang l) => _t(l, ', belum selaras', ', not aligned yet', '، غير متوافق بعد');
String liveAudioSummarySearching(AppLang l) =>
    _t(l, ', sedang diselaraskan', ', aligning', '، جارٍ ضبط التوقيت');
String liveAudioSummaryNone(AppLang l) => _t(l, 'Tiada bunyi', 'No sound', 'بلا صوت');
String liveAudioMute(AppLang l) => _t(l, 'Senyapkan mikrofon', 'Mute microphone', 'كتم الميكروفون');
String liveAudioUnmute(AppLang l) => _t(l, 'Hidupkan mikrofon', 'Unmute microphone', 'تشغيل الميكروفون');
String liveAudioAddHelpCamera(AppLang l) => _t(
      l,
      'Sumber yang ditambah dicampur bersama audio kamera dan diselaraskan dengannya secara automatik. Setiap sumber ada kelantangannya sendiri.',
      'Added sources are mixed with the camera audio and aligned with it automatically. Each source has its own volume.',
      'تُدمج المصادر المضافة مع صوت الكاميرا ويُضبط توقيتها معه تلقائيًا. لكل مصدر مستوى صوت خاص به.',
    );
String liveAudioAddHelpPhone(AppLang l) => _t(
      l,
      'Sumber yang ditambah dicampur bersama mikrofon telefon ini.',
      'Added sources are mixed with this phone microphone.',
      'تُدمج المصادر المضافة مع ميكروفون هذا الهاتف.',
    );
String liveAudioAddBoxHint(AppLang l) => _t(
      l,
      'Input audio pada MAXCOM. Siaran sampai 1 hingga 2 saat lewat.',
      'The audio input on the MAXCOM box. The broadcast arrives 1 to 2 seconds late.',
      'مدخل الصوت في صندوق MAXCOM. يصل البث متأخرًا من ثانية إلى ثانيتين.',
    );
String liveAudioAdded(AppLang l) => _t(l, 'Sudah ditambah', 'Already added', 'أُضيف بالفعل');
String liveAudioAddButton(AppLang l) => _t(l, 'Tambah', 'Add', 'إضافة');
String liveAudioClose(AppLang l) => _t(l, 'Tutup', 'Close', 'إغلاق');
String liveAudioMicHint(AppLang l, bool ipad) => _t(
      l,
      '${ipad ? 'Mikrofon iPad' : 'Mikrofon telefon'} atau mikrofon luaran yang dipasang padanya.',
      '${ipad ? 'The iPad microphone' : 'The phone microphone'} or an external microphone plugged into it.',
      '${ipad ? 'ميكروفون iPad' : 'ميكروفون الهاتف'} أو ميكروفون خارجي موصول به.',
    );
String liveAudioOffsetHelp(AppLang l) => _t(
      l,
      'Lewatkan bunyi supaya selari dengan gambar kamera',
      'Delay the sound so it matches the camera picture',
      'أخّر الصوت ليتوافق مع صورة الكاميرا',
    );
String liveAudioOffsetValue(AppLang l, int ms) => '+$ms ms';
String liveAudioClapSave(AppLang l) => _t(l, 'Simpan', 'Save', 'حفظ');
String liveAudioClapRecord(AppLang l) => _t(l, 'Rakam 5 saat', 'Record 5 seconds', 'تسجيل 5 ثوانٍ');
String liveAudioClapRecording(AppLang l) =>
    _t(l, 'Merakam gambar dan bunyi...', 'Recording picture and sound...', 'جارٍ تسجيل الصورة والصوت...');
String liveAudioClapIntro(AppLang l) => _t(
      l,
      'Tepuk tangan di hadapan kamera. Gambar dan bunyi dirakam 5 saat, kemudian dimainkan berulang. Laraskan imbangan sehingga tepukan kelihatan dan kedengaran serentak.',
      'Clap your hands in front of the camera. Picture and sound are recorded for 5 seconds, then played in a loop. Adjust the offset until the clap is seen and heard at the same time.',
      'صفّق بيديك أمام الكاميرا. تُسجَّل الصورة والصوت لمدة 5 ثوانٍ ثم تُعاد في حلقة. اضبط الإزاحة حتى يُرى التصفيق ويُسمع في الوقت نفسه.',
    );
String liveAudioClapFailed(AppLang l) => _t(
      l,
      'Rakaman ujian gagal. Cuba lagi.',
      'The test recording failed. Try again.',
      'فشل تسجيل الاختبار. أعد المحاولة.',
    );
String liveAudioClapIpadIntro(AppLang l) => _t(
      l,
      'Tepuk tangan di hadapan kamera dan dengar melalui fon kepala. Laraskan imbangan sehingga tepukan kelihatan dan kedengaran serentak.',
      'Clap your hands in front of the camera and listen through headphones. Adjust the offset until the clap is seen and heard at the same time.',
      'صفّق بيديك أمام الكاميرا واستمع عبر سماعات الرأس. اضبط الإزاحة حتى يُرى التصفيق ويُسمع في الوقت نفسه.',
    );
String liveSectionOutputs(AppLang l) => _t(l, 'Ke mana siaran pergi', 'Where the broadcast goes', 'وجهات البث');
/// The summary of the fold "Ke mana siaran pergi": the destinations that are chosen, joined with ", " and the first
/// letter capital ("Skrin surau, YouTube, rakaman di telefon ini"). [recording] is true only when a recording is
/// available AND chosen; an unavailable recording is told apart by [liveSectionOutputsNoRecording].
String liveSectionOutputsSummary(
  AppLang l, {
  required bool screen,
  required bool youtube,
  required bool recording,
  required bool ipad,
}) {
  final parts = <String>[
    if (screen) _t(l, 'Skrin surau', 'Surau screen', 'شاشة المصلى'),
    if (youtube) 'YouTube',
    if (recording)
      ipad
          ? _t(l, 'rakaman di iPad ini', 'recording on this iPad', 'التسجيل على هذا الـ iPad')
          : _t(l, 'rakaman di telefon ini', 'recording on this phone', 'التسجيل على هذا الهاتف'),
  ];
  if (parts.isEmpty) return _t(l, 'Tiada destinasi dipilih', 'No destination chosen', 'لم تُختر أي وجهة');
  final joined = parts.join(l == AppLang.ar ? '، ' : ', ');
  return l == AppLang.ar ? joined : joined[0].toUpperCase() + joined.substring(1);
}

/// The second line of that summary when this device cannot record (the MAXCOM Kiosk Box takes the video).
String liveSectionOutputsNoRecording(AppLang l) => _t(
      l,
      'Rakaman: Tidak tersedia, video diambil oleh MAXCOM Kiosk Box',
      'Recording: Not available, the video is taken by the MAXCOM Kiosk Box',
      'التسجيل: غير متاح، يأخذ MAXCOM Kiosk Box الفيديو',
    );
String liveSectionSettings(AppLang l) => _t(l, 'Tetapan siaran', 'Live settings', 'إعدادات البث');
/// Konfigurasi's one pointer row (and its search hit): the four live features moved to the Siaran langsung page.
String liveSettingsMovedRow(AppLang l) => _t(
      l,
      'Tetapan siaran kini di menu Siaran langsung',
      'Live settings are now in the Live broadcast menu',
      'إعدادات البث أصبحت الآن في قائمة البث المباشر',
    );
String liveSettingsMovedHint(AppLang l) => _t(
      l,
      'Kamera luaran, siaran di skrin, YouTube dan rakaman',
      'External camera, live on the screen, YouTube and recording',
      'الكاميرا الخارجية، البث على الشاشة، YouTube، التسجيل',
    );
/// Words that find the pointer row besides the feature names and hints.
const List<String> liveSettingsMovedWords = [
  'kamera', 'camera', 'rtsp', 'onvif', 'youtube', 'rakaman', 'recording', 'siaran', 'live', 'cctv', 'ip cam',
  'البث', 'كاميرا', 'الكاميرا', 'تسجيل', 'يوتيوب',
];
String liveSectionSettingsSummary(AppLang l, bool cameraOn) => _t(
      l,
      'Kamera luaran ${cameraOn ? 'ditawarkan' : 'tidak ditawarkan'}, skrin, YouTube, rakaman',
      'External camera ${cameraOn ? 'offered' : 'not offered'}, screen, YouTube, recording',
      'الكاميرا الخارجية ${cameraOn ? 'معروضة كخيار' : 'غير معروضة'}، الشاشة، YouTube، التسجيل',
    );
String liveSettingsCameraRow(AppLang l) => _t(l, 'Kamera luaran', 'External camera', 'الكاميرا الخارجية');
String liveSettingsKioskRow(AppLang l) => _t(l, 'Siaran langsung di skrin', 'Live on the screen', 'البث المباشر على الشاشة');
String liveSettingsKioskHint(AppLang l) =>
    _t(l, 'Audio, kuat bunyi, isi skrin', 'Audio, volume, screen fill', 'الصوت، مستوى الصوت، ملء الشاشة');
String liveSettingsYoutubeRow(AppLang l) => _t(l, 'Siaran langsung YouTube', 'YouTube live', 'بث YouTube المباشر');
String liveSettingsYoutubeHint(AppLang l) =>
    _t(l, 'Keterlihatan, tajuk dan keterangan', 'Visibility, title and description', 'الظهور والعنوان والوصف');
String liveSettingsRecordingRow(AppLang l) => _t(l, 'Rakaman', 'Recording', 'التسجيل');
String liveSettingsRecordingHint(AppLang l) =>
    _t(l, 'Panjang fail dan simpanan', 'File length and storage', 'طول الملف والتخزين');
String liveSettingsCameraOn(AppLang l) => _t(l, 'Ditawarkan sebagai pilihan', 'Offered as a choice', 'معروضة كخيار');
/// The short forms, for a summary line that also says other things.
String liveSettingsCameraShort(AppLang l, bool on) => on
    ? _t(l, 'ditawarkan', 'offered', 'معروضة')
    : _t(l, 'tidak ditawarkan', 'not offered', 'غير معروضة');
String liveSettingsCameraOff(AppLang l) => _t(l, 'Tidak ditawarkan', 'Not offered', 'غير معروضة');
String liveSourcesRemembered(AppLang l) => _t(
      l,
      'Sumber video dan campuran audio terakhir diingat untuk siaran seterusnya.',
      'The last video source and audio mix are remembered for the next broadcast.',
      'يُحتفظ بآخر مصدر فيديو ومزيج صوت للبث التالي.',
    );
String liveSourcePhoneCameraHint(AppLang l) => _t(
      l,
      'Kamera belakang telefon ini, dengan mikrofonnya',
      'The back camera of this phone, with its microphone',
      'الكاميرا الخلفية لهذا الهاتف مع ميكروفونه',
    );
String liveSourceIpadCameraHint(AppLang l) => _t(
      l,
      'Kamera belakang iPad ini, dengan mikrofonnya',
      'The back camera of this iPad, with its microphone',
      'الكاميرا الخلفية لهذا الـ iPad مع ميكروفونه',
    );
String liveSourceExternalHint(AppLang l) =>
    _t(l, 'Gambar dan audio kamera bersama', 'The camera picture and audio together', 'صورة الكاميرا وصوتها معًا');
String liveSourceExternalOffTitle(AppLang l) =>
    _t(l, 'Kamera luaran dimatikan', 'The external camera is off', 'الكاميرا الخارجية متوقفة');
String liveSourceExternalOffBody(AppLang l, String name) => _t(
      l,
      '$name tidak dipaparkan kerana suisnya dimatikan di Tetapan siaran. Tetapannya masih disimpan.',
      '$name is not shown because its switch is off in Broadcast settings. Its settings are still kept.',
      'لا يظهر $name لأن مفتاحه متوقف في إعدادات البث. وإعداداته ما زالت محفوظة.',
    );
String liveSourceOpenCamera(AppLang l) => _t(l, 'Buka Kamera luaran', 'Open External camera', 'فتح الكاميرا الخارجية');
String liveSourceCameraUnreachableNote(AppLang l, String name) => _t(
      l,
      '$name tidak dapat dihubungi sekarang. Siaran akan bermula tanpa gambar kamera sehingga ia disambung; skrin surau dan YouTube memaparkan Siaran akan bersambung sebentar lagi.',
      '$name cannot be reached now. The broadcast will start without the camera picture until it is connected; the surau screen and YouTube show The broadcast will resume shortly.',
      'تعذّر الوصول إلى $name الآن. سيبدأ البث بلا صورة الكاميرا حتى يتم توصيلها؛ وتعرض شاشة المصلى وYouTube عبارة «سيستأنف البث بعد قليل».',
    );
String liveSourceCameraReady(AppLang l) => _t(l, 'Sedia', 'Ready', 'جاهزة');
String liveSourceCameraUnreachable(AppLang l) => _t(l, 'Tidak dapat dihubungi', 'Cannot be reached', 'تعذّر الوصول');
String liveSourceCameraUntested(AppLang l) => _t(l, 'Belum diuji', 'Not tested yet', 'لم تُختبر بعد');
String liveMixedLevel(AppLang l) => _t(l, 'Campuran', 'Mix', 'المزيج');
String liveNoSound(AppLang l) => _t(l, 'Tiada bunyi', 'No sound', 'بلا صوت');
String liveFromCamera(AppLang l, String name) => _t(l, 'Langsung dari $name', 'Live from $name', 'مباشر من $name');
String liveFromBoxCamera(AppLang l, String name) =>
    _t(l, 'Langsung dari MAXCOM: $name', 'Live from the box: $name', 'مباشر من الصندوق: $name');
String liveCameraWaiting(AppLang l, String name) =>
    _t(l, 'Menunggu gambar dari $name', 'Waiting for the picture from $name', 'بانتظار الصورة من $name');
String liveCameraLostTitle(AppLang l) => _t(
      l,
      'Gambar dari kamera terputus seketika',
      'The camera picture was cut off for a moment',
      'انقطعت صورة الكاميرا لحظة',
    );
String liveCameraLostMinutes(AppLang l) => _t(
      l,
      'Siaran dihentikan kerana kamera terputus lebih 10 minit.',
      'The broadcast was stopped because the camera was cut off for more than 10 minutes.',
      'أُوقف البث لأن الكاميرا انقطعت أكثر من 10 دقائق.',
    );
String liveSwitchToPhone(AppLang l) => _t(l, 'Tukar ke kamera telefon', 'Switch to the phone camera', 'التبديل إلى كاميرا الهاتف');
String liveSwitchToPhoneHint(AppLang l) => _t(
      l,
      'Bunyi bertukar kepada Mikrofon telefon ini sahaja. Siaran YouTube tidak terhenti.',
      'The sound switches to this phone microphone only. The YouTube broadcast does not stop.',
      'يتحول الصوت إلى ميكروفون هذا الهاتف فقط. ولا يتوقف بث YouTube.',
    );
String liveSwitchToIpad(AppLang l) => _t(l, 'Tukar ke kamera iPad', 'Switch to the iPad camera', 'التبديل إلى كاميرا iPad');
String liveSwitchToExternal(AppLang l) =>
    _t(l, 'Tukar ke kamera luaran', 'Switch to the external camera', 'التبديل إلى الكاميرا الخارجية');
String liveEmergencyStop(AppLang l) => _t(l, 'Henti kecemasan', 'Emergency stop', 'إيقاف طارئ');
String liveEmergencyTitle(AppLang l, String starter) =>
    _t(l, 'Hentikan siaran $starter?', 'Stop the broadcast of $starter?', 'إيقاف بث $starter؟');
String liveEmergencyBody(AppLang l, String starter) => _t(
      l,
      'Siaran ini dimulakan oleh $starter. Skrin surau dan YouTube akan berhenti menerima siaran. Penghentian ini dicatat dalam log perubahan.',
      'This broadcast was started by $starter. The surau screen and YouTube will stop receiving the broadcast. This stop is recorded in the change log.',
      'بدأ هذا البث $starter. ستتوقف شاشة المصلى وYouTube عن استقبال البث. يُسجَّل هذا الإيقاف في سجل التغييرات.',
    );
String liveOtherDeviceTitle(AppLang l, String starter) => _t(
      l,
      'Siaran sedang berjalan dari $starter',
      'A broadcast is running from $starter',
      'يجري بث من $starter',
    );
String liveOtherDeviceBody(AppLang l) => _t(
      l,
      'Hanya peranti itu boleh mengubah kelantangan atau menghentikan siaran.',
      'Only that device can change the volume or stop the broadcast.',
      'يستطيع ذلك الجهاز فقط تغيير مستوى الصوت أو إيقاف البث.',
    );
String liveOnlyStarterStops(AppLang l, String starter) => _t(
      l,
      'Hanya $starter boleh menghentikan siaran ini.',
      'Only $starter can stop this broadcast.',
      'يستطيع $starter فقط إيقاف هذا البث.',
    );
String liveIpadAudioOnly(AppLang l) => _t(
      l,
      'Audio kamera sahaja. iPad ini mengawal siaran dan memaparkan pratonton; ia tidak menghantar bunyi.',
      'Camera audio only. This iPad controls the broadcast and shows the preview; it sends no sound.',
      'صوت الكاميرا فقط. يتحكم هذا الجهاز في البث ويعرض المعاينة؛ ولا يرسل أي صوت.',
    );
String liveMixCardTitle(AppLang l) => _t(l, 'Bunyi siaran', 'Broadcast sound', 'صوت البث');
String liveAudioUseOnlyNote(AppLang l) => _t(
      l,
      'Kelantangan audio kamera ditetapkan ke 0%. Penyelarasan diteruskan di latar.',
      'The camera audio volume is set to 0%. Alignment continues in the background.',
      'مستوى صوت الكاميرا مضبوط على 0%. يستمر ضبط التوقيت في الخلفية.',
    );
String liveCameraLostSeconds(AppLang l, String name, int minutes) => _t(
      l,
      '$name tidak dapat dihubungi selama $minutes minit',
      '$name has been unreachable for $minutes minutes',
      'تعذّر الوصول إلى $name منذ $minutes دقيقة',
    );
String liveCameraReconnectBody(AppLang l, {required bool mic, required String source}) => _t(
      l,
      'Skrin surau dan YouTube memaparkan gambar terakhir${mic ? ' dengan bunyi $source' : ''}. Audio kamera terputus bersama gambarnya. Telefon ini sedang menyambung semula; tiada tindakan diperlukan.',
      'The surau screen and YouTube show the last picture${mic ? ' with the sound of $source' : ''}. The camera audio is cut off together with its picture. This phone is reconnecting; no action is needed.',
      'تعرض شاشة المصلى وYouTube آخر صورة${mic ? ' مع صوت $source' : ''}. انقطع صوت الكاميرا مع صورتها. يعيد هذا الهاتف الاتصال؛ ولا حاجة إلى أي إجراء.',
    );
String liveCameraLostBody(AppLang l, {required bool mic, required String source, required int minutesLeft}) => _t(
      l,
      'Penonton melihat gambar terakhir dan Siaran akan bersambung sebentar lagi. ${mic ? 'Bunyi $source diteruskan.' : 'Siaran tiada bunyi sehingga kamera kembali.'} Siaran berhenti sendiri dalam $minutesLeft minit jika kamera tidak kembali. Semak kuasa dan Wi-Fi kamera, atau tukar ke kamera telefon.',
      'Viewers see the last picture and The broadcast will resume shortly. ${mic ? 'The sound of $source continues.' : 'The broadcast has no sound until the camera is back.'} The broadcast stops by itself in $minutesLeft minutes if the camera does not come back. Check the camera power and Wi-Fi, or switch to the phone camera.',
      'يرى المشاهدون آخر صورة وعبارة «سيستأنف البث بعد قليل». ${mic ? 'يستمر صوت $source.' : 'لا يوجد صوت في البث حتى تعود الكاميرا.'} يتوقف البث من تلقاء نفسه خلال $minutesLeft دقيقة إذا لم تعد الكاميرا. تحقق من كهرباء الكاميرا وشبكة Wi-Fi، أو بدّل إلى كاميرا الهاتف.',
    );
String liveCameraBackTitle(AppLang l, String name) =>
    _t(l, 'Gambar dari $name kembali', 'The picture from $name is back', 'عادت الصورة من $name');
String liveCameraBackBody(AppLang l, String source) => _t(
      l,
      'Audio kamera dicampur semula sebaik ia selaras dengan $source, supaya suara tidak kedengaran berganda.',
      'The camera audio is mixed in again as soon as it is aligned with $source, to keep voices from sounding doubled.',
      'يُدمج صوت الكاميرا من جديد فور توافقه مع $source، حتى لا يُسمع الصوت مزدوجًا.',
    );

// ---- the sources card during a live (were hardcoded BM in the screen, G7) ----

String liveCamLinkLost(AppLang l) => _t(l, 'Terputus', 'Lost', 'منقطعة');
String liveCamLinkReconnecting(AppLang l) => _t(l, 'Menyambung semula', 'Reconnecting', 'جارٍ إعادة الاتصال');
String liveCamLinkBack(AppLang l) => _t(l, 'Kembali', 'Back', 'عادت');
String liveCamLinkReceived(AppLang l) => _t(l, 'Diterima', 'Received', 'مستلمة');
String liveCamPulledByBox(AppLang l) => _t(l, 'Ditarik oleh MAXCOM', 'Pulled by MAXCOM', 'يسحبها MAXCOM');
String liveCamLastPicture(AppLang l) => _t(l, 'Gambar terakhir', 'Last picture', 'آخر صورة');
