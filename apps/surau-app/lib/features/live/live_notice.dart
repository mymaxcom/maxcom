// The live stream notice (peranti-pengguna plan, Task L1): the sentence a
// person shares with the AJK and the jemaah when a YouTube live starts, built
// from the chosen kuliah in the language of the phone that runs the live
// (BM, English or Arabic), and the public watch link in exactly one form,
// `https://www.youtube.com/live/<videoId>`.
//
// This file is pure: no widgets, no network. It is a three-language data
// file (the sentences are the operator's binding wording), so the BM-literal
// guard lists it beside trilingual_strings.dart.
//
// Never in the text: a stream key, an RTMP or ingest address, a studio link,
// a LAN address, the cloud's address, or the `youtu.be` short form. A field
// typed by a person (speaker, kitab, topic, label, surau name) is flattened
// to one line and has anything that looks like an address removed, so it can
// neither add a second link nor start a line of its own.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_lang.dart';
import '../../app/providers.dart';
import '../people/phone.dart' show isE164;
import '../people/ref.dart' show refOf;

/// A YouTube video id: 11 characters of letters, digits, `_` and `-`.
final RegExp _videoIdRe = RegExp(r'^[A-Za-z0-9_-]{11}$');

/// Whether [id] can be put in a watch link.
bool isLiveVideoId(String? id) => id != null && _videoIdRe.hasMatch(id);

/// `https://www.youtube.com/live/<videoId>`: the only link the notice
/// carries. Callers check [isLiveVideoId] first.
String liveWatchLink(String videoId) => 'https://www.youtube.com/live/$videoId';

const Set<String> _youtubeHosts = {'youtube.com', 'www.youtube.com', 'm.youtube.com'};

/// The video id of a public YouTube watch address (`watch?v=<id>`, `/live/<id>`
/// or `youtu.be/<id>`) over https, else null: a link on any other host, a
/// plain `http` link, an address with a port or a login, and an id that is
/// not 11 characters all give null (the screen then shows no button).
String? liveNoticeVideoId(String? watchUrl) {
  if (watchUrl == null) return null;
  final u = Uri.tryParse(watchUrl.trim());
  if (u == null || u.scheme != 'https' || u.hasPort || u.userInfo.isNotEmpty) return null;
  String? id;
  if (u.host == 'youtu.be') {
    if (u.pathSegments.length == 1) id = u.pathSegments.first;
  } else if (_youtubeHosts.contains(u.host)) {
    if (u.path == '/watch') {
      id = u.queryParameters['v'];
    } else if (u.pathSegments.length == 2 && u.pathSegments.first == 'live') {
      id = u.pathSegments[1];
    }
  }
  return isLiveVideoId(id) ? id : null;
}

/// What the notice is built from. Every field but [videoId] may be empty.
class LiveNoticeInput {
  const LiveNoticeInput({
    required this.videoId,
    this.slot,
    this.label,
    this.start,
    this.speaker,
    this.kitab,
    this.topic,
    this.surau,
  });

  /// 11 characters, `[A-Za-z0-9_-]`.
  final String videoId;

  /// `subuh`, `zohor`, `asar`, `maghrib`, `isyak`; anything else is "other".
  final String? slot;

  /// The kuliah's own name, used when the slot has no standard name.
  final String? label;

  /// The kuliah's start, local time of the phone's zone.
  final DateTime? start;

  /// The penceramah as stored ("Ustaz Ahmad"): titles are never added here.
  final String? speaker;
  final String? kitab;
  final String? topic;

  /// The surau's name, for the sentence used when no kuliah is chosen.
  final String? surau;
}

/// One field of a notice: control and direction-override characters become
/// spaces, the WhatsApp format marks (`*` bold, `_` italic, `~` strike, the
/// backtick for mono) are removed so a name cannot open a format run, runs of
/// whitespace become one space, any word that is a link is dropped (`://`, a
/// word starting `www.`, or a dot followed by letters and a slash such as
/// `bit.ly/x`), at most 160 characters. Null when nothing is left.
String? _clean(String? v) {
  if (v == null) return null;
  final flat = v.replaceAll(RegExp(r'[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069*_~`]'), ' ');
  var t = flat.split(RegExp(r'\s+')).where((w) => w.isNotEmpty && !_isLink(w)).join(' ');
  if (t.runes.length > 160) t = String.fromCharCodes(t.runes.take(160)).trimRight();
  return t.isEmpty ? null : t;
}

final RegExp _schemeLessLink = RegExp(r'(^www\.)|(\.[A-Za-z]{2,}/)', caseSensitive: false);

/// A word WhatsApp would turn into a link: with a scheme, `www.`, or `name.tld/path`.
bool _isLink(String w) => w.contains('://') || _schemeLessLink.hasMatch(w);

const Set<String> _knownSlots = {'subuh', 'zohor', 'asar', 'maghrib', 'isyak'};

/// [t] in WhatsApp bold.
String _b(String t) => '*$t*';

/// The notice for [i] in [lang], or null when `i.videoId` is not a valid id
/// (the caller then offers no button). [now] is kept for callers; the text
/// no longer carries a time word. Shape (BM): the greeting; then
/// `Ikuti *slot* di *surau* bersama *penceramah*.`; then `Tajuk: *tajuk*`;
/// then the link. A missing part is left out with its joining word, never an
/// empty `**`.
String? liveNoticeText(LiveNoticeInput i, AppLang lang, DateTime now) {
  if (!isLiveVideoId(i.videoId)) return null;
  final slotKey = (i.slot ?? '').trim().toLowerCase();
  final slot = _knownSlots.contains(slotKey) ? slotKey : (slotKey.isEmpty ? null : 'other');
  final label = _clean(i.label);
  final speaker = _clean(i.speaker);
  final title = _clean(i.topic) ?? _clean(i.kitab);
  final surau = _clean(i.surau);
  final noKuliah = slot == null && label == null && i.start == null && speaker == null && title == null;
  final w = _words[lang]!;
  final name = noKuliah
      ? null
      : switch (slot) {
          'subuh' => w.slots[0],
          'zohor' => w.slots[1],
          'asar' => w.slots[2],
          'maghrib' => w.slots[3],
          'isyak' => w.slots[4],
          _ => label ?? w.kuliah,
        };
  final b = StringBuffer(name == null ? w.live : '${w.follow} ${_b(name)}');
  if (surau != null) b.write(' ${w.at} ${_b(surau)}');
  if (speaker != null) b.write(' ${w.withWord} ${_b(speaker)}');
  b.write('.');
  final lines = <String>[
    lang == AppLang.ar ? 'السلام عليكم ورحمة الله.' : "Assalamu'alaikum warahmatullah.",
    b.toString(),
    if (title != null) '${w.title}: ${_b(title)}',
    liveWatchLink(i.videoId),
  ];
  return lines.join('\n');
}

/// The standard name of [slot] (`subuh` .. `isyak`) in [lang] ("Kuliah Maghrib"), or null for any other slot.
String? liveSlotName(String? slot, AppLang lang) {
  final i = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'].indexOf((slot ?? '').trim().toLowerCase());
  return i < 0 ? null : _words[lang]!.slots[i];
}

class _Words {
  const _Words({
    required this.follow,
    required this.live,
    required this.at,
    required this.withWord,
    required this.title,
    required this.kuliah,
    required this.slots,
  });
  final String follow;
  final String live;
  final String at;
  final String withWord;
  final String title;
  final String kuliah;
  final List<String> slots;
}

const Map<AppLang, _Words> _words = {
  AppLang.ms: _Words(
    follow: 'Ikuti',
    live: 'Ikuti siaran langsung',
    at: 'di',
    withWord: 'bersama',
    title: 'Tajuk',
    kuliah: 'Kuliah',
    slots: ['Kuliah Subuh', 'Kuliah Zohor', 'Kuliah Asar', 'Kuliah Maghrib', 'Kuliah Isyak'],
  ),
  AppLang.en: _Words(
    follow: 'Join',
    live: 'Join the live stream',
    at: 'at',
    withWord: 'with',
    title: 'Title',
    kuliah: 'Talk',
    slots: ['Subuh Talk', 'Zohor Talk', 'Asar Talk', 'Maghrib Talk', 'Isyak Talk'],
  ),
  AppLang.ar: _Words(
    follow: 'تابعوا',
    live: 'تابعوا البث المباشر',
    at: 'في',
    withWord: 'مع',
    title: 'الموضوع',
    kuliah: 'الدرس',
    slots: ['درس الفجر', 'درس الظهر', 'درس العصر', 'درس المغرب', 'درس العشاء'],
  ),
};

/// [text] with the watch link of [videoId] on its own last line when it no
/// longer contains it (the person deleted it while editing).
String ensureLiveLink(String text, String videoId) {
  final link = liveWatchLink(videoId);
  if (text.contains(link)) return text;
  final t = text.trimRight();
  return t.isEmpty ? link : '$t\n$link';
}

// ---- "Hantar kepada seorang": one person's WhatsApp ----

/// One person the notice can be sent to. [phone] is E.164 (`+60120000003`)
/// and is never shown; the list shows [name] and [ref] (the person's ID).
class LiveNoticeRecipient {
  const LiveNoticeRecipient({required this.id, required this.name, required this.ref, this.phone});

  final String id;
  final String name;
  final String? ref;
  final String? phone;
}

/// The surau's active, not deleted users that have a phone number, read from
/// `GET /api/users` (the Pentadbir's answer carries `phone` and `ref` once
/// the box has the phone-number task). Nobody without a number is listed, so
/// an older box gives an empty list and the screen hides the button. Tests
/// override this provider with a fake.
final liveNoticeRecipientsProvider = FutureProvider<List<LiveNoticeRecipient>>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return const [];
  try {
    final body = await gateway.getFresh('/api/users');
    final out = <LiveNoticeRecipient>[];
    for (final u in (body['users'] as List? ?? const [])) {
      if (u is! Map || u['id'] is! String || u['name'] is! String) continue;
      if (u['active'] != true || u['deleted'] == true) continue;
      final phone = u['phone'];
      if (phone is! String || !isE164(phone)) continue;
      out.add(
        LiveNoticeRecipient(
          id: u['id'] as String,
          name: u['name'] as String,
          ref: refOf(
            ref: u['ref'] is String ? u['ref'] as String : null,
            kind: 'user',
            no: u['no'] is num ? (u['no'] as num).toInt() : null,
            noSrc: u['noSrc'] is String ? u['noSrc'] as String : null,
          ),
          phone: phone,
        ),
      );
    }
    return out;
  } catch (_) {
    return const [];
  }
});
