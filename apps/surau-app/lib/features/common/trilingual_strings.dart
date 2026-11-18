// Fixed three-language texts for screens nobody can interact with (the
// start and waiting screens): the person's language may not be known yet,
// so BM is shown with small English and Arabic lines under it. They are
// literals on purpose, not ARB keys: they must not follow the app language.

abstract final class TrilingualStrings {
  static const loadingMs = 'Memuatkan MAXCOM';
  static const loadingEn = 'Loading MAXCOM';
  static const loadingAr = 'جارٍ تحميل MAXCOM';

  static const connectingMs = 'Menyambung ke kotak';
  static const connectingEn = 'Connecting to the box';
  static const connectingAr = 'جارٍ الاتصال بالصندوق';

  static const badBuildMs = 'Binaan tidak sah. Pasang semula aplikasi yang betul.';
  static const badBuildEn = 'Invalid build. Reinstall the correct app.';
  static const badBuildAr = 'نسخة غير صالحة. أعد تثبيت التطبيق الصحيح.';

  static const List<String> all = [
    loadingMs,
    loadingEn,
    loadingAr,
    connectingMs,
    connectingEn,
    connectingAr,
    badBuildMs,
    badBuildEn,
    badBuildAr,
  ];
}
