// Strings for the box's own screens (setup, recovery, stopped, pairing, network check).
//
// These screens speak three languages, chosen on the display itself: Bahasa Melayu (default), English and
// Arabic. The main kiosk program does not: it keeps the surau's setting (`Lang` in i18n.ts, ms or en).
// Malay and English live in STRINGS (i18n.ts) beside the rest of the kiosk; Arabic lives here.
//
// The Arabic is formal Modern Standard Arabic and follows the terms on mymaxcom.my (المصلى, المسؤول,
// امسح, رمز QR, رمز الاسترداد, السحابة). Product names stay Latin. It still wants a native speaker's check.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { t } from './i18n.ts';

export type BoxLang = 'ms' | 'en' | 'ar';
export const BOX_LANGS: readonly BoxLang[] = ['ms', 'en', 'ar'];

export function isBoxLang(x: unknown): x is BoxLang {
  return x === 'ms' || x === 'en' || x === 'ar';
}

/** Text direction of a box-screen language. */
export function dirOf(lang: BoxLang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/** What each choice is called on the switch, in its own language (as on mymaxcom.my). */
export const LANG_NAMES: Record<BoxLang, string> = { ms: 'BM', en: 'EN', ar: 'عربي' };

export const AR: Record<string, string> = {
  surauName: 'المصلى',
  boxLangLabel: 'اللغة',
  // Setup
  setupSub: 'الإعداد الأول',
  setupTitle: 'إعداد جهاز MAXCOM هذا',
  setupLead: 'امسح الرمز بتطبيق MAX Admin Client لتصبح المسؤول الأول.',
  setupLead2: 'لا حاجة إلى الإنترنت، لكن يجب أن يكون الهاتف وجهاز MAXCOM هذا على الشبكة نفسها.',
  setupStep1: 'تأكد من اتصال الهاتف بشبكة Wi-Fi الرئيسية للمصلى (لا شبكة الضيوف).',
  setupStep2: 'افتح تطبيق MAX Admin Client واختر مسح رمز QR.',
  setupStep3: 'امسح الرمز المجاور، ثم أدخل اسم المصلى واسمك.',
  setupCodeOnce: 'رمز الإعداد، للاستخدام مرة واحدة',
  setupNewCodeIn: 'رمز جديد بعد {mmss}',
  setupFingerprint: 'البصمة',
  setupAddress: 'العنوان',
  setupBoxName: 'الاسم',
  setupBoxId: 'المعرّف',
  setupNoHttps: 'لا توجد شهادة HTTPS على جهاز MAXCOM هذا بعد: على المُركِّب إكمال التركيب',
  setupNeedsCamera: 'يتطلب الإعداد هاتفًا أو جهاز iPad مزوّدًا بكاميرا',
  setupNetCheck: 'فحص الشبكة',
  setupNetHint: 'اضغط OK',
  setupApp: 'تطبيق MAX Admin Client: {url}',
  setupHttpsOn: 'HTTPS مفعّل',
  // Recovery
  recoveryTitleNoAdmin: 'يحتاج هذا المصلى إلى مسؤول جديد',
  recoveryTitleDamaged: 'يجب استعادة بيانات المصلى',
  recoveryWhyNoAdmin: 'لم يعد هناك مسؤول نشط في {surau}.',
  recoveryWhyDamaged: 'قاعدة البيانات في جهاز MAXCOM هذا تالفة ولا يمكن قراءتها.',
  recoveryHowLinked: 'جهاز MAXCOM هذا مرتبط بسحابة MAXCOM',
  recoveryHowUnlinked: 'جهاز MAXCOM هذا غير مرتبط بالسحابة',
  recoveryLinked1: 'يمسح المسؤول الجديد هذا الرمز بتطبيق MAX Admin Client.',
  recoveryLinked2: 'أدخل رمز الاسترداد في الهاتف، أو اطلب من مسؤول MAXCOM الموافقة على المسؤول الجديد.',
  recoveryLinked3: 'تعود الشاشة إلى وضعها المعتاد بعد الانتهاء.',
  recoveryUnlinked1: 'امسح هذا الرمز بتطبيق MAX Admin Client.',
  recoveryUnlinked2: 'أدخل رمز الاسترداد المكتوب على الورق عند الإعداد.',
  recoveryUnlinked3: 'يصبح ذلك الهاتف المسؤول الجديد لهذا المصلى.',
  recoveryNoCode: 'لا يوجد رمز استرداد؟ يجب إعادة تثبيت جهاز MAXCOM هذا واستعادة البيانات من النسخة الاحتياطية المحلية.',
  recoveryNoCodeMade: 'لم يُنشأ رمز استرداد لجهاز MAXCOM هذا.',
  recoveryNoCodeContact: 'يُرجى التواصل مع مُركِّب MAXCOM.',
  recoveryDamagedLinked1: 'تواصل مع مسؤول MAXCOM.',
  recoveryDamagedLinked2: 'يستعيد مسؤول MAXCOM البيانات من النسخة الاحتياطية السحابية.',
  recoveryDamagedLinked3: 'تعود الشاشة إلى وضعها المعتاد بعد استعادة البيانات.',
  recoveryDamagedUnlinked1: 'تواصل مع مُركِّب MAXCOM.',
  recoveryDamagedUnlinked2: 'جهّز ذاكرة USB التي تحمل النسخة الاحتياطية إن وُجدت.',
  recoveryDamagedUnlinked3: 'تعود الشاشة إلى وضعها المعتاد بعد استعادة البيانات.',
  recoveryPill: 'وضع الاسترداد',
  recoveryNoPrayer: 'تعذّرت قراءة مواقيت الصلاة',
  recoveryCodeOnce: 'رمز الاسترداد، للاستخدام مرة واحدة',
  // Stopped
  lockedTitle: 'تم إيقاف الخدمة',
  lockedBody: 'تواصل مع مسؤول MAXCOM.',
  lockedId: 'المعرّف: {id}',
  // Network check
  netTitle: 'فحص الشبكة',
  netEthernet: 'Ethernet',
  netWifi: 'Wi-Fi',
  netConnected: 'متصل، {address}',
  netNotUsed: 'غير مستخدم',
  netInternet: 'الإنترنت',
  netInternetNotNeeded: 'غير مطلوب للإعداد',
  netServer: 'خادم MAXCOM',
  netServerOn: 'يعمل على {url}',
  netServerOff: 'HTTPS غير مفعّل',
  netPhone: 'الهاتف',
  netPhoneSeen: 'وصل هاتف إلى جهاز MAXCOM هذا الساعة {time}',
  netPhoneNone: 'لم يصل أي هاتف خلال آخر 10 دقائق',
  netCloud: 'سحابة MAXCOM',
  netLinked: 'مرتبط، آخر مزامنة {time}',
  netLinkedNever: 'مرتبط، لم تتم المزامنة بعد',
  netLinkedShort: 'مرتبط',
  netUnlinked: 'غير مرتبط',
  netOk: 'يستطيع الهاتف الوصول إلى جهاز MAXCOM هذا',
  netOkHint: 'أعد مسح رمز التسجيل في تطبيق MAX Admin Client.',
  netIsolation: 'السبب المحتمل: شبكة Wi-Fi للضيوف أو عزل الأجهزة',
  netIsolation1: 'تأكد من أن الهاتف وجهاز MAXCOM هذا على شبكة Wi-Fi نفسها (لا شبكة الضيوف).',
  netIsolation2: 'أوقف خيار "client isolation" أو "AP isolation" في موجّه Wi-Fi الخاص بالمصلى.',
  netUnlinkedHint: 'جهاز MAXCOM هذا غير مرتبط بالسحابة، فلا سبيل للاتصال به إلا عبر الشبكة نفسها.',
  netProbeTitle: 'اختبر الاتصال من الهاتف',
  netProbeHint: 'امسح الرمز بتطبيق MAX Admin Client. إذا وصل الهاتف، يتحول سطر الهاتف إلى الأخضر.',
  netBack: 'رجوع',
  netRetry: 'أعد الفحص',
  netLoading: 'جارٍ الفحص…',
  netUnavailable: 'فحص الشبكة غير متاح على هذه الشاشة',
  // Pairing
  pairTitle: 'اربط شاشة التلفاز هذه',
  pairInstruction: 'افتح تطبيق MAX Admin Client، واختر {path}، ثم أدخل هذا الرمز',
  pairExpiresIn: 'ينتهي الرمز بعد {mmss}',
  pairRenewing: 'جارٍ طلب رمز جديد…',
  pairUnreachable: 'تعذّر الاتصال بجهاز MAXCOM',
  pairRetrying: 'تتم إعادة المحاولة تلقائيًا',
  pairDone: 'تم ربط الشاشة',
  pairConnectedTo: 'متصل بـ {name}',
};

/**
 * The app's menu path for the Arabic pairing line. The app itself speaks Malay and English, so the path names
 * the English menu words the person will see; it is set left to right so the arrows read in the app's order.
 */
// No-break spaces: like the Malay and English lines, the path never splits across two lines on the TV.
export const PAIR_MENU_PATH = 'More > Users & devices > TV screens';

/** Box-screen text. Arabic from AR, Malay and English from the kiosk's STRINGS. A missing key comes back as the key. */
export function tb(key: string, lang: BoxLang, vars?: Record<string, string | number>): string {
  if (lang !== 'ar') return t(key, lang, vars);
  const s = AR[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Codes and addresses: always left to right. Names and times take their direction from their own letters. */
const LTR_VARS = new Set(['url', 'id', 'address', 'mmss', 'path']);

/**
 * Like `tb`, but in Arabic every filled-in value is isolated (`<bdi>`), so an address, a code or a Latin name keeps
 * its own order inside the right-to-left sentence. Malay and English come back as the plain string.
 */
export function tbx(key: string, lang: BoxLang, vars: Record<string, string | number>): ComponentChildren {
  if (lang !== 'ar') return t(key, lang, vars);
  const s = AR[key];
  if (s === undefined) return key;
  const out: ComponentChildren[] = [];
  let last = 0;
  s.replace(/\{(\w+)\}/g, (m, name: string, at: number) => {
    if (at > last) out.push(s.slice(last, at));
    out.push(name in vars ? h('bdi', LTR_VARS.has(name) ? { dir: 'ltr' } : {}, String(vars[name])) : m);
    last = at + m.length;
    return m;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** The surau's name for a box screen: its own name when set, else the generic word in the screen's language. */
export function surauNameBox(settings: { surauInfo?: { name?: unknown } } | null | undefined, lang: BoxLang): string {
  try {
    const n = settings?.surauInfo?.name;
    if (typeof n === 'string' && n.trim() !== '') return n.trim();
  } catch {
    /* fall through */
  }
  return tb('surauName', lang);
}
