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
/// spaces, runs of whitespace become one space, any word that contains `://`
/// is dropped, at most 160 characters. Null when nothing is left.
String? _clean(String? v) {
  if (v == null) return null;
  final flat = v.replaceAll(RegExp(r'[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]'), ' ');
  var t = flat.split(RegExp(r'\s+')).where((w) => w.isNotEmpty && !w.contains('://')).join(' ');
  if (t.runes.length > 160) t = String.fromCharCodes(t.runes.take(160)).trimRight();
  return t.isEmpty ? null : t;
}

enum _Part { none, morning, noon, evening, night, tomorrow }

const Set<String> _knownSlots = {'subuh', 'zohor', 'asar', 'maghrib', 'isyak'};

/// When the kuliah is, in words. A Maghrib or Isyak kuliah of today is always
/// the night (Maghrib can start before 19:00); every other slot of today goes
/// by its start hour; tomorrow is tomorrow; any other day, or no time, is none.
_Part _when(String? slot, DateTime? start, DateTime now) {
  if (start == null) return _Part.none;
  final days = DateTime.utc(start.year, start.month, start.day)
      .difference(DateTime.utc(now.year, now.month, now.day))
      .inDays;
  if (days == 1) return _Part.tomorrow;
  if (days != 0) return _Part.none;
  if (slot == 'maghrib' || slot == 'isyak') return _Part.night;
  final h = start.hour;
  if (h < 12) return _Part.morning;
  if (h < 15) return _Part.noon;
  if (h < 19) return _Part.evening;
  return _Part.night;
}

/// A title that already begins with the word for "book": the sentence then
/// does not add it a second time. Compared after trimming, without case.
final RegExp _kitabWord = RegExp(r'^(kitab|book|\u0643\u062A\u0627\u0628)(\s|$)', caseSensitive: false);

bool _startsWithKitab(String title) => _kitabWord.hasMatch(title.trim());

/// The notice for [i] in [lang], or null when `i.videoId` is not a valid id
/// (the caller then offers no button). [now] is the phone's local time.
String? liveNoticeText(LiveNoticeInput i, AppLang lang, DateTime now) {
  if (!isLiveVideoId(i.videoId)) return null;
  final slotKey = (i.slot ?? '').trim().toLowerCase();
  final slot = _knownSlots.contains(slotKey) ? slotKey : (slotKey.isEmpty ? null : 'other');
  final label = _clean(i.label);
  final speaker = _clean(i.speaker);
  final kitab = _clean(i.kitab);
  final topic = _clean(i.topic);
  final surau = _clean(i.surau);
  final noKuliah =
      slot == null && label == null && i.start == null && speaker == null && kitab == null && topic == null;
  final part = _when(slot, i.start, now);
  final line = switch (lang) {
    AppLang.ms => _ms(noKuliah, slot, label, part, speaker, kitab, topic, surau),
    AppLang.en => _en(noKuliah, slot, label, part, speaker, kitab, topic, surau),
    AppLang.ar => _ar(noKuliah, slot, label, part, speaker, kitab, topic, surau),
  };
  final greeting = lang == AppLang.ar
      ? 'السلام عليكم ورحمة الله.'
      : "Assalamu'alaikum warahmatullah.";
  return '$greeting\n$line\n${liveWatchLink(i.videoId)}';
}

String _ms(bool noKuliah, String? slot, String? label, _Part part, String? speaker, String? kitab, String? topic, String? surau) {
  if (noKuliah) {
    return surau == null
        ? 'Ikuti siaran langsung dalam talian menerusi pautan berikut:'
        : 'Ikuti siaran langsung dari $surau dalam talian menerusi pautan berikut:';
  }
  final name = switch (slot) {
    'subuh' => 'Kuliah Subuh',
    'zohor' => 'Kuliah Zohor',
    'asar' => 'Kuliah Asar',
    'maghrib' => 'Kuliah Maghrib',
    'isyak' => 'Kuliah Isyak',
    _ => label ?? 'kuliah',
  };
  final time = switch (part) {
    _Part.morning => 'pagi ini',
    _Part.noon => 'tengah hari ini',
    _Part.evening => 'petang ini',
    _Part.night => 'malam ini',
    _Part.tomorrow => 'esok',
    _Part.none => null,
  };
  final b = StringBuffer('Ikuti $name');
  if (time != null) b.write(' $time');
  if (speaker != null) b.write(' disampaikan oleh $speaker');
  if (kitab != null) {
    b.write(_startsWithKitab(kitab) ? ' membicarakan $kitab' : ' membicarakan kitab $kitab');
  } else if (topic != null) {
    b.write(' membicarakan tajuk $topic');
  }
  b.write(' secara langsung dalam talian menerusi pautan berikut:');
  return b.toString();
}

String _en(bool noKuliah, String? slot, String? label, _Part part, String? speaker, String? kitab, String? topic, String? surau) {
  if (noKuliah) {
    return surau == null
        ? 'Join the live stream at the link below:'
        : 'Join the live stream from $surau at the link below:';
  }
  final name = switch (slot) {
    'subuh' => 'the Subuh talk',
    'zohor' => 'the Zohor talk',
    'asar' => 'the Asar talk',
    'maghrib' => 'the Maghrib talk',
    'isyak' => 'the Isyak talk',
    _ => label ?? 'the talk',
  };
  final time = switch (part) {
    _Part.morning => 'this morning',
    _Part.noon || _Part.evening => 'this afternoon',
    _Part.night => 'tonight',
    _Part.tomorrow => 'tomorrow',
    _Part.none => null,
  };
  final b = StringBuffer('Join $name');
  if (time != null) b.write(' $time');
  if (speaker != null) b.write(', delivered by $speaker');
  if (kitab != null) {
    b.write(_startsWithKitab(kitab) ? ', on $kitab' : ', on the book $kitab');
  } else if (topic != null) {
    b.write(', on the topic $topic');
  }
  b.write(', live online at the link below:');
  return b.toString();
}

String _ar(bool noKuliah, String? slot, String? label, _Part part, String? speaker, String? kitab, String? topic, String? surau) {
  if (noKuliah) {
    return surau == null
        ? 'تابعوا البث المباشر عبر الرابط التالي:'
        : 'تابعوا البث المباشر من $surau عبر الرابط التالي:';
  }
  final name = switch (slot) {
    'subuh' => 'درس الفجر',
    'zohor' => 'درس الظهر',
    'asar' => 'درس العصر',
    'maghrib' => 'درس المغرب',
    'isyak' => 'درس العشاء',
    _ => label ?? 'الدرس',
  };
  final time = switch (part) {
    _Part.morning => 'هذا الصباح',
    _Part.noon || _Part.evening => 'بعد ظهر اليوم',
    _Part.night => 'الليلة',
    _Part.tomorrow => 'غدا',
    _Part.none => null,
  };
  final b = StringBuffer('تابعوا $name');
  if (time != null) b.write(' $time');
  if (speaker != null) b.write(' يلقيه $speaker');
  if (kitab != null) {
    b.write(
      _startsWithKitab(kitab)
          ? ' في شرح $kitab'
          : ' في شرح كتاب $kitab',
    );
  } else if (topic != null) {
    b.write(' في موضوع $topic');
  }
  b.write(' في بث مباشر عبر الرابط التالي:');
  return b.toString();
}

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
