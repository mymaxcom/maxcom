// Strings for the box's own screens (setup, recovery, stopped, pairing, network check).
//
// These screens speak three languages, chosen on the display itself: Bahasa Melayu (default), English and
// Arabic. The main kiosk program keeps the surau's setting (`Lang` in i18n.ts: ms, en or ar).
// All three live in STRINGS (i18n.ts) beside the rest of the kiosk.
//
// The Arabic is formal Modern Standard Arabic and follows the terms on mymaxcom.my (المصلى, المسؤول,
// امسح, رمز QR, رمز الاسترداد, السحابة). Product names stay Latin. It still wants a native speaker's check.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { STRINGS, t } from './i18n.ts';

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

/** The Arabic strings: since the TV language can be Arabic too (W14), they live in the kiosk's STRINGS (i18n.ts). */
export const AR: Record<string, string> = STRINGS.ar;

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

// ---- Linking boxes (the TV's side of "Pautkan MAXCOM Kiosk Box lain") -----------------------------------------------------
//
// The link screens and the follower marks speak the same three languages as the box screens. Their strings live here,
// in one table per language, so the key-parity test (test/linkScreen.test.tsx) can see a key missing in any of them.
// The Arabic is plain Modern Standard Arabic and still wants a native reader's check: none of it is final.
//
// The product box is called "MAXCOM Kiosk Box" in every language (never "kotak" in Bahasa Melayu). BOX is the one place
// the term is spelled; the strings below are built from it. Main and follower follow the admin app (box_term.dart).

const BOX = 'MAXCOM Kiosk Box';

export const LINK_STRINGS: Record<BoxLang, Record<string, string>> = {
  ms: {
    linkQrTitle: `Pautkan ${BOX} ini`,
    linkQrLead: 'Imbas kod ini dengan aplikasi pentadbir Box yang satu lagi.',
    linkQrIn: 'Kod baharu dalam {mmss}',
    linkQrRenewing: 'Kod baharu sedang disediakan',
    setupNewSurau: 'Persediaan surau baharu',
    setupExisting: 'Pautkan ke surau sedia ada',
    setupHasMaxcom:
      `Surau sudah ada MAXCOM? Pautkan TV ini dari aplikasi: Pengguna & peranti, TV dan Box, Pautkan ${BOX} lain.`,
    linkCodeTitle: 'Bandingkan kod ini',
    linkCodeFrom: `${BOX} yang satu lagi: {name}`,
    linkCodeHint:
      'Bandingkan dengan kod di telefon pentadbir Box yang satu lagi. Jika sama, tekan Setuju di telefon anda.',
    linkWaitTitle: 'Pentadbir sedang memilih di telefon.',
    linkWaitHint: 'Sila tunggu. Jangan tutup kuasa.',
    linkProgressTitle: `Memautkan ${BOX}`,
    linkStepOf: 'Langkah {n} daripada {total}',
    linkStep_backup: 'Menyimpan salinan sandaran',
    linkStep_people: 'Menggabungkan pengguna',
    linkStep_commit: 'Mengesahkan pautan',
    linkStep_finish: 'Menyiapkan paparan',
    linkProgressHint: 'Jangan tutup kuasa.',
    linkDoneTitle: 'Pautan siap',
    linkDoneBody: `${BOX} ini sudah dipautkan.`,
    linkEndedTitle: 'Pautan dibatalkan',
    linkWhy_failed: 'Pautan tidak dapat disiapkan. Cuba lagi.',
    linkWhy_cancelled: 'Pentadbir membatalkan pautan.',
    linkWhy_cancelled_by_peer: `${BOX} yang satu lagi membatalkan pautan.`,
    linkWhy_rejected: 'Pentadbir tidak bersetuju dengan kod itu.',
    linkWhy_rejected_by_peer: `Pentadbir ${BOX} yang satu lagi tidak bersetuju.`,
    linkWhy_expired: 'Kod sudah tamat tempoh. Minta kod baharu.',
    linkWhy_approve_timeout: 'Kelulusan tidak diterima dalam masa yang ditetapkan.',
    linkWhy_restart: `${BOX} dimulakan semula semasa memautkan. Cuba lagi.`,
    linkWhy_peer_unreachable: `${BOX} yang satu lagi tidak dapat dihubungi.`,
    linkWhy_case_x_unavailable: 'Gabungan data ini belum disokong.',
    linkWhy_generic: 'Pautan tidak dapat diteruskan.',
    linkMasterAway: `${BOX} utama tidak dapat dihubungi`,
    linkMasterLost: 'Tidak dapat menghubungi MAXCOM utama sejak {time}',
    linkNeedsUpdate: 'Perlu kemas kini',
    linkConnecting: 'Menyambung ke {name}',
    linkConnectingSub: 'TV ini sedang mengambil kandungan. Biasanya kurang seminit.',
    linkMasterWord: `${BOX} utama`,
    linkStep_move: 'Memindahkan data, {pct}',
    unlinkTitle: 'Memutuskan pautan',
    unlinkStep_copy: 'Menyalin data sekarang',
    unlinkStep_back: 'Kembali ke data sebelum dipautkan',
    unlinkStep_carry_on: 'Meneruskan dengan data sekarang',
    unlinkStep_empty: `Mengosongkan Box ini`,
    unlinkDoneTitle: 'Pautan diputuskan',
    unlinkDoneBody: 'Pautan diputuskan. Pentadbir Box ini: imbas kod untuk menyambung.',
    liveTooManyViewers: 'Terlalu banyak TV sedang menonton siaran langsung. TV ini akan cuba lagi sebentar lagi.',
  },
  en: {
    linkQrTitle: `Link this ${BOX}`,
    linkQrLead: "Scan this code with the other Box's admin app.",
    linkQrIn: 'New code in {mmss}',
    linkQrRenewing: 'A new code is being prepared',
    setupNewSurau: 'Set up a new surau',
    setupExisting: 'Link to an existing surau',
    setupHasMaxcom:
      `Does the surau already have MAXCOM? Link this TV from the app: Users & devices, TVs and Boxes, Link another ${BOX}.`,
    linkCodeTitle: 'Compare this code',
    linkCodeFrom: `The other ${BOX}: {name}`,
    linkCodeHint:
      "Compare it with the code on the other Box admin's phone. If they match, tap Agree on your phone.",
    linkWaitTitle: 'The admin is choosing on the phone.',
    linkWaitHint: 'Please wait. Do not switch off the power.',
    linkProgressTitle: `Linking the ${BOX}es`,
    linkStepOf: 'Step {n} of {total}',
    linkStep_backup: 'Saving a backup copy',
    linkStep_people: 'Merging the users',
    linkStep_commit: 'Confirming the link',
    linkStep_finish: 'Getting the screen ready',
    linkProgressHint: 'Do not switch off the power.',
    linkDoneTitle: 'Link complete',
    linkDoneBody: `This ${BOX} is now linked.`,
    linkEndedTitle: 'Link cancelled',
    linkWhy_failed: 'The link could not be completed. Try again.',
    linkWhy_cancelled: 'An admin cancelled the link.',
    linkWhy_cancelled_by_peer: `The other ${BOX} cancelled the link.`,
    linkWhy_rejected: 'The admin did not accept the code.',
    linkWhy_rejected_by_peer: `The other ${BOX}'s admin did not agree.`,
    linkWhy_expired: 'The code has expired. Ask for a new one.',
    linkWhy_approve_timeout: 'No approval arrived in time.',
    linkWhy_restart: `The ${BOX} restarted while linking. Try again.`,
    linkWhy_peer_unreachable: `The other ${BOX} cannot be reached.`,
    linkWhy_case_x_unavailable: 'This combination of data is not supported yet.',
    linkWhy_generic: 'The link could not continue.',
    linkMasterAway: `The main ${BOX} cannot be reached`,
    linkMasterLost: 'Cannot reach the main MAXCOM since {time}',
    linkNeedsUpdate: 'Update needed',
    linkConnecting: 'Connecting to {name}',
    linkConnectingSub: 'This TV is fetching its content. It usually takes under a minute.',
    linkMasterWord: `the main ${BOX}`,
    linkStep_move: 'Moving data, {pct}',
    unlinkTitle: 'Cutting the link',
    unlinkStep_copy: 'Copying the current data',
    unlinkStep_back: 'Going back to the data from before the link',
    unlinkStep_carry_on: 'Carrying on with the current data',
    unlinkStep_empty: 'Emptying this Box',
    unlinkDoneTitle: 'Link cut',
    unlinkDoneBody: 'The link is cut. Admin of this Box: scan the code to connect.',
    liveTooManyViewers: 'Too many TVs are watching the live broadcast. This TV will try again shortly.',
  },
  ar: {
    linkQrTitle: `ربط هذا ${BOX}`,
    linkQrLead: 'امسح هذا الرمز بتطبيق مسؤول Box الآخر.',
    linkQrIn: 'رمز جديد خلال {mmss}',
    linkQrRenewing: 'جارٍ تجهيز رمز جديد',
    setupNewSurau: 'إعداد مصلى جديد',
    setupExisting: 'الربط بمصلى قائم',
    setupHasMaxcom:
      `هل لدى المصلى MAXCOM بالفعل؟ اربط هذا التلفاز من التطبيق: المستخدمون والأجهزة، التلفاز وBox، ربط ${BOX} آخر.`,
    linkCodeTitle: 'قارن هذا الرمز',
    linkCodeFrom: `${BOX} الآخر: {name}`,
    linkCodeHint: 'قارنه بالرمز الظاهر على هاتف مسؤول Box الآخر. إن تطابقا فاضغط موافق على هاتفك.',
    linkWaitTitle: 'المسؤول يختار الآن على الهاتف.',
    linkWaitHint: 'يرجى الانتظار وعدم فصل الكهرباء.',
    linkProgressTitle: `جارٍ ربط ${BOX}`,
    linkStepOf: 'الخطوة {n} من {total}',
    linkStep_backup: 'حفظ نسخة احتياطية',
    linkStep_people: 'دمج المستخدمين',
    linkStep_commit: 'تأكيد الربط',
    linkStep_finish: 'تجهيز الشاشة',
    linkProgressHint: 'لا تفصل الكهرباء.',
    linkDoneTitle: 'اكتمل الربط',
    linkDoneBody: `تم ربط هذا ${BOX}.`,
    linkEndedTitle: 'أُلغي الربط',
    linkWhy_failed: 'تعذر إكمال الربط. حاول مرة أخرى.',
    linkWhy_cancelled: 'ألغى المسؤول الربط.',
    linkWhy_cancelled_by_peer: `ألغى ${BOX} الآخر الربط.`,
    linkWhy_rejected: 'لم يقبل المسؤول الرمز.',
    linkWhy_rejected_by_peer: `لم يوافق مسؤول ${BOX} الآخر.`,
    linkWhy_expired: 'انتهت صلاحية الرمز. اطلب رمزا جديدا.',
    linkWhy_approve_timeout: 'لم تصل الموافقة في الوقت المحدد.',
    linkWhy_restart: `أعيد تشغيل ${BOX} أثناء الربط. حاول مرة أخرى.`,
    linkWhy_peer_unreachable: `تعذر الوصول إلى ${BOX} الآخر.`,
    linkWhy_case_x_unavailable: 'هذا الجمع بين البيانات غير مدعوم بعد.',
    linkWhy_generic: 'تعذر متابعة الربط.',
    linkMasterAway: `تعذر الوصول إلى ${BOX} الرئيسي`,
    linkMasterLost: 'تعذر الاتصال بـ MAXCOM الرئيسي منذ {time}',
    linkNeedsUpdate: 'يلزم التحديث',
    linkConnecting: 'جارٍ الاتصال بـ {name}',
    linkConnectingSub: 'يجلب هذا التلفاز المحتوى. يستغرق ذلك عادة أقل من دقيقة.',
    linkMasterWord: `${BOX} الرئيسي`,
    linkStep_move: 'جارٍ نقل البيانات، {pct}',
    unlinkTitle: 'جارٍ فصل الربط',
    unlinkStep_copy: 'نسخ البيانات الحالية',
    unlinkStep_back: 'العودة إلى البيانات السابقة للربط',
    unlinkStep_carry_on: 'المتابعة بالبيانات الحالية',
    unlinkStep_empty: 'إفراغ هذا Box',
    unlinkDoneTitle: 'فُصل الربط',
    unlinkDoneBody: 'فُصل الربط. مسؤول هذا Box: امسح الرمز للاتصال.',
    liveTooManyViewers: 'عدد كبير من أجهزة التلفاز يشاهد البث المباشر. سيحاول هذا التلفاز مرة أخرى بعد قليل.',
  },
};

/** Link-screen text. An unknown key comes back as the key; `{name}` style values are filled in. */
export function tl(key: string, lang: BoxLang, vars?: Record<string, string | number>): string {
  const s = LINK_STRINGS[lang]?.[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Like `tl`, but in Arabic every filled-in value is isolated (`<bdi>`), so a Latin name or a time keeps its own order. */
export function tlx(key: string, lang: BoxLang, vars: Record<string, string | number>): ComponentChildren {
  const s = LINK_STRINGS[lang]?.[key];
  if (s === undefined) return key;
  if (lang !== 'ar') return tl(key, lang, vars);
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
