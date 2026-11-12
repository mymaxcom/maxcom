// What the TV will do with a hadis, worked out on the phone for the preview
// and for `Hari ini di TV`: the size tier, the parts of a long text, today's
// pool. The same answers as `packages/core/src/content/hadisDisplay.ts` (the
// box and the TV use that one); `test/hadis/hadis_tv_rules_test.dart` runs the
// vectors core records. Integer sums stay inside 32 bits on purpose: the web
// build has no 64-bit integers and must draw the same random order.

import 'hadis_api.dart';
import 'hadis_list_controller.dart' show sortedHadis;
import 'hadis_rules.dart';

const double _lineRem = 88;
const double _blockRem = 13.4;
const double _arEm = 0.45;
const double _msEm = 0.47;
const double _arLineHeight = 1.75;
const double _msLineHeight = 1.3;

/// Type sizes of a tier in TV units (a hundredth of the screen width) and
/// the lines each may take. The kiosk's CSS uses the same numbers in rem.
class HadisTierSizes {
  const HadisTierSizes(this.key, this.arSize, this.arLines, this.msSize, this.msLines);

  final String key;
  final double arSize;
  final int arLines;
  final double msSize;
  final int msLines;
}

const List<HadisTierSizes> _tiers = [
  HadisTierSizes('l', 2.5, 1, 1.8, 2),
  HadisTierSizes('m', 2.05, 2, 1.5, 3),
  HadisTierSizes('s', 1.75, 2, 1.3, 4),
];

/// The sizes of tier 'l', 'm' or 's'.
HadisTierSizes hadisTierSizes(String key) =>
    _tiers.firstWhere((t) => t.key == key, orElse: () => _tiers[1]);

final RegExp _letter = RegExp(r'\p{L}', unicode: true);

int _letters(String s) {
  var n = 0;
  for (final r in s.runes) {
    if (_letter.hasMatch(String.fromCharCode(r))) n++;
  }
  return n;
}

/// The largest tier from [from] down whose estimated lines fit the card,
/// null when even the smallest does not.
String? hadisTier(String textMs, String? textAr, {String from = 'l'}) {
  final start = _tiers.indexWhere((t) => t.key == from);
  for (final t in _tiers.skip(start < 0 ? 0 : start)) {
    final arLines = textAr != null && textAr.isNotEmpty
        ? ((_letters(textAr) * _arEm * t.arSize) / _lineRem).ceil()
        : 0;
    final msLines = ((textMs.length * _msEm * t.msSize) / _lineRem).ceil();
    if (arLines > t.arLines || msLines > t.msLines) continue;
    final height =
        arLines * t.arSize * _arLineHeight +
        (arLines > 0 ? 0.6 : 0) +
        msLines * t.msSize * _msLineHeight;
    if (height <= _blockRem) return t.key;
  }
  return null;
}

/// The opening `Daripada ... bersabda:` split off when the text starts with
/// it; the whole text is the body otherwise.
({String body, String? intro}) hadisDisplayText(String textMs, String? intro) {
  final i = intro?.trim();
  if (i != null && i.isNotEmpty && textMs.startsWith(i)) {
    final body = textMs.substring(i.length).trim();
    if (body.isNotEmpty) return (body: body, intro: i);
  }
  return (body: textMs, intro: null);
}

/// How the TV shows one hadis: one card, or its Malay body in parts.
class HadisPlan {
  const HadisPlan.single(this.tier, {required this.showAr}) : parts = const [];
  const HadisPlan.inParts(this.parts) : tier = 'm', showAr = false;

  final String tier;

  /// The parts, empty for one card.
  final List<String> parts;
  final bool showAr;

  bool get isParts => parts.isNotEmpty;

  /// A part has one more line than tier 'm' gives a single card
  /// (`.card--hadis.is-parts` in the kiosk's CSS).
  int get msLines => isParts ? 4 : hadisTierSizes(tier).msLines;
}

/// Mirrors core's `hadisPlan`; [settings] are the `hadis` feature values.
HadisPlan hadisPlan({
  required String textMs,
  String? textAr,
  String? intro,
  required Map<String, dynamic> settings,
}) {
  final showArabic = settings['showArabic'] != false;
  final ar = showArabic && textAr != null && textAr.isNotEmpty ? textAr : null;
  final fontSize = settings['fontSize'];
  final from = fontSize == 's' || fontSize == 'm' || fontSize == 'l'
      ? fontSize as String
      : 'l';
  final tier = hadisTier(textMs, ar, from: from);
  if (tier != null) return HadisPlan.single(tier, showAr: ar != null);
  final parts = hadisParts(hadisDisplayText(textMs, intro).body);
  return HadisPlan.inParts(parts.isNotEmpty ? parts : [textMs]);
}

// ---- today's pool ----

/// `Math.imul`: the low 32 bits of a product, with no 64-bit step.
int _imul(int a, int b) {
  final al = a & 0xffff;
  final ah = (a >>> 16) & 0xffff;
  final bl = b & 0xffff;
  final bh = (b >>> 16) & 0xffff;
  return (al * bl + (((ah * bl + al * bh) & 0xffff) * 65536)) & 0xffffffff;
}

int _hash32(String s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h = (h ^ s.codeUnitAt(i)) & 0xffffffff;
    h = _imul(h, 16777619);
  }
  return h & 0xffffffff;
}

double Function() _mulberry32(int seed) {
  var a = seed & 0xffffffff;
  return () {
    a = (a + 0x6d2b79f5) & 0xffffffff;
    var t = a;
    t = _imul(t ^ (t >>> 15), t | 1);
    t = (t ^ ((t + _imul(t ^ (t >>> 7), t | 61)) & 0xffffffff)) & 0xffffffff;
    return ((t ^ (t >>> 14)) & 0xffffffff) / 4294967296;
  };
}

int _dayNumber(String date) {
  final p = date.split('-').map(int.parse).toList();
  return (DateTime.utc(p[0], p[1], p[2]).millisecondsSinceEpoch / 86400000)
      .floor();
}

bool _gradeAllowed(String? grade, Map<dynamic, dynamic> allowed) =>
    gradeSavable(grade) && allowed[grade] == true;

/// Most hadis one snapshot ships for `changeEvery: 'card'` (core's
/// `HADIS_CARD_POOL_MAX`); a longer list moves through in windows this size.
const int hadisCardPoolMax = 50;

/// Today's hadis in show order; mirrors core's `hadisPool`. [today] is the
/// surau's `YYYY-MM-DD`.
List<HadisItem> hadisPool(
  Iterable<HadisItem> items,
  Map<String, dynamic> settings,
  String today,
) {
  final source = settings['source'] ?? 'both';
  final mix = settings['mix'] ?? 'list';
  final allowed = settings['allowedGrades'] is Map
      ? settings['allowedGrades'] as Map<dynamic, dynamic>
      : const <dynamic, dynamic>{};
  final listed = sortedHadis(
    items.where((h) {
      if (!h.shown) return false;
      if (h.ext?['provider'] == 'hadeethenc') {
        return source != 'own' &&
            h.ext?['blocked'] != true &&
            _gradeAllowed(h.grade, allowed);
      }
      return source != 'hadeethenc';
    }),
  );

  var ordered = listed;
  if (mix == 'alternate' && source == 'both') {
    final own = [for (final h in listed) if (!h.isProvider) h];
    final prov = [for (final h in listed) if (h.isProvider) h];
    if (own.isNotEmpty && prov.isNotEmpty) {
      ordered = [
        for (var i = 0; i < (own.length > prov.length ? own.length : prov.length); i++) ...[
          if (i < own.length) own[i],
          if (i < prov.length) prov[i],
        ],
      ];
    }
  } else if (mix == 'random') {
    ordered = [...listed];
    final rnd = _mulberry32(_hash32(today));
    for (var i = ordered.length - 1; i > 0; i--) {
      final j = (rnd() * (i + 1)).floor();
      final x = ordered[i];
      ordered[i] = ordered[j];
      ordered[j] = x;
    }
  }

  final n = ordered.length;
  final perDay = settings['perDay'];
  final per = settings['changeEvery'] == 'card'
      ? hadisCardPoolMax
      : (perDay is num ? perDay.floor() : 3).clamp(1, 10);
  if (n <= per) return ordered;
  final start = (_dayNumber(today) * per) % n;
  return [for (var i = 0; i < per; i++) ordered[(start + i) % n]];
}

/// Today's date at the surau (Asia/Kuala_Lumpur, UTC+8) as core's `klDateOf`.
String klDateOf(DateTime now) {
  final d = now.toUtc().add(const Duration(hours: 8));
  return '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';
}
