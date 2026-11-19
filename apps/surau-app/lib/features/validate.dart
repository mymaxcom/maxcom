// The Dart twin of core's `validateFeatureSettings`
// (`packages/core/src/features/settings.ts`). The same rules, picked by the
// top-level setting name, typed from the registry defaults; the generated
// `test/fixtures/settings-cases.json` (answers computed by core itself)
// proves both say yes and no on the same patches. Messages are Bahasa
// Malaysia by default and follow the app language when the caller passes
// `s`; every error carries core's key path.

import '../l10n/generated/s.dart';
import '../l10n/s_lookup.dart';
import 'labels.dart' show appLangOfS, featureLabel;
import 'registry.g.dart';
import 'surah_names.dart' show surahName;

/// The most verses the Kad Ayat card shows at once (core's `AYAT_MAX_AT_ONCE`).
const int maxAyatAtOnce = 3;

/// What a setting's value must satisfy, by the setting's top-level name.
class SettingRule {
  const SettingRule.int(this.min, this.max)
    : type = SettingRuleType.int,
      vals = const [],
      re = null,
      what = null;
  const SettingRule.enumOf(this.vals)
    : type = SettingRuleType.enumOf,
      min = 0,
      max = 0,
      re = null,
      what = null;
  /// A whole number from a short list (written as text in [vals]: `'0'`, `'1'`).
  const SettingRule.intOf(this.vals)
    : type = SettingRuleType.intOf,
      min = 0,
      max = 0,
      re = null,
      what = null;
  const SettingRule.regex(this.re, this.what)
    : type = SettingRuleType.regex,
      min = 0,
      max = 0,
      vals = const [];
  const SettingRule.text(this.min, this.max, {this.re, this.what})
    : type = SettingRuleType.text,
      vals = const [];
  const SettingRule.sourceUrl()
    : type = SettingRuleType.sourceUrl,
      min = 0,
      max = 0,
      vals = const [],
      re = null,
      what = null;

  /// A number with at most 4 decimals, or null (latitude, longitude): [min]..[max].
  const SettingRule.decimal(this.min, this.max)
    : type = SettingRuleType.decimal,
      vals = const [],
      re = null,
      what = null;

  final SettingRuleType type;
  final int min;
  final int max;
  final List<String> vals;
  final RegExp? re;

  /// Key of the phrase that completes "Must be ..." (see [_whatText]).
  final String? what;
}

enum SettingRuleType { int, intOf, enumOf, regex, text, sourceUrl, decimal }

const SettingRule _min120 = SettingRule.int(0, 120);
const SettingRule _sec600 = SettingRule.int(0, 600);

final RegExp _phoneRe = RegExp(r'^\+?[0-9][0-9 -]{6,18}$');
final RegExp _emailRe = RegExp(r'^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$');
final RegExp _reciterRe = RegExp(r'^[A-Za-z0-9_]{3,64}$');
final RegExp _zoneRe = RegExp(r'^[A-Z]{3}\d{2}$');
final RegExp _themeNameRe = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$');
final RegExp _qrAssetRe = RegExp(r'^$|^[0-9a-f]{64}$');
final RegExp _fundIdRe = RegExp(r'^$|^[A-Za-z0-9_-]{1,100}$');
final RegExp _dateOrEmptyRe = RegExp(r'^$|^\d{4}-\d{2}-\d{2}$');
final RegExp _countryRe = RegExp(r'^[A-Z]{2}$');
final RegExp _timeZoneRe = RegExp(r'^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$|^UTC$');
final RegExp _cloudUrlRe = RegExp(r'^https://[^\s<>\x00-\x1f\x7f]+$');
final RegExp _shortNameRe = RegExp(r'^[^\x00-\x1f\x7f<>&"]+$');
final RegExp _sourceNameRe = RegExp(r'^[^<>\x00-\x1f\x7f]+$');

/// Settings whose children are `{name, url}` pairs (`dataSources`): their
/// leaves are ruled by `ds.<leaf>`, not by the parent name (core's
/// `SOURCE_KEYS` and `leafRuleName`).
const Set<String> _sourceKeys = {
  'esolat',
  'esolatZones',
  'nominatim',
  'quranText',
  'quranAudio',
  'hadeethenc',
};

String _leafRuleName(String top, String k) =>
    _sourceKeys.contains(top) ? 'ds.$k' : top;

/// Core's `ruleFor(name)`; null when the name has no extra constraint.
SettingRule? ruleFor(String name) {
  if (name == 'segmentMinutes') return const SettingRule.int(5, 60);
  // Explicit cases first: both names also match the generic minutes rule below.
  if (name == 'adjustMinutes') return const SettingRule.int(-30, 30);
  if (name == 'imsakMinutes') return const SettingRule.int(5, 20);
  if (name == 'minutes' ||
      name.startsWith('minutes') ||
      name.endsWith('Minutes')) {
    return _min120;
  }
  if (name == 'screenSeconds' ||
      name == 'endWarningSeconds' ||
      name == 'durationSeconds') {
    return _sec600;
  }
  // Every amount setting is whole sen, up to RM 1 billion.
  if (name.length > 3 && name.endsWith('Sen')) {
    return const SettingRule.int(0, 100000000000);
  }
  switch (name) {
    case 'volume':
      return const SettingRule.int(0, 100);
    case 'adjustDays':
      return const SettingRule.int(-2, 2);
    case 'hijriMonth':
      return const SettingRule.int(1, 12);
    case 'switchAt':
      return const SettingRule.enumOf(['maghrib', 'midnight']);
    case 'timeFormat':
      return const SettingRule.enumOf(['12h', '24h']);
    case 'lang':
      return const SettingRule.enumOf(['auto', 'ms', 'en', 'ar']);
    case 'mode':
      return const SettingRule.enumOf(['landscape', 'portrait']);
    case 'templateId':
      return SettingRule.regex(_themeNameRe, 'themeName');
    case 'rotate':
      return const SettingRule.enumOf(['daily', 'hourly', 'off']);
    case 'order':
      return const SettingRule.int(0, 99);
    case 'daysAhead':
      return const SettingRule.int(1, 60);
    case 'maxItems':
      return const SettingRule.int(1, 20);
    case 'count':
      return const SettingRule.int(1, 10);
    case 'ayatFrom':
      return const SettingRule.int(1, 286);
    case 'ayatTo':
      return const SettingRule.int(1, 286);
    case 'surah':
      return const SettingRule.int(1, 114);
    case 'cacheMaxMb':
      return const SettingRule.int(50, 2000);
    case 'pick':
      return const SettingRule.enumOf(['daily', 'random', 'manual']);
    case 'source':
      return const SettingRule.enumOf(['own', 'hadeethenc', 'both']);
    case 'mix':
      return const SettingRule.enumOf(['list', 'alternate', 'random']);
    case 'changeEvery':
      return const SettingRule.enumOf(['day', 'card']);
    case 'perDay':
      return const SettingRule.int(1, 10);
    case 'fontSize':
      return const SettingRule.enumOf(['auto', 's', 'm', 'l']);
    case 'fit':
      return const SettingRule.enumOf(['cover', 'contain']);
    case 'privacy':
      return const SettingRule.enumOf(['public', 'unlisted', 'private']);
    case 'relayFrom':
      return const SettingRule.enumOf(['box', 'phone']);
    case 'transport':
      return const SettingRule.enumOf(['auto', 'tcp', 'udp']);
    case 'avOffsetMs':
      // Core's AV_OFFSET_CHOICES: 0 to 2000 ms in steps of 50.
      return SettingRule.intOf([for (var i = 0; i <= 2000; i += 50) '$i']);
    case 'noVideoSeconds':
      return const SettingRule.int(5, 60);
    case 'cloudWakeSeconds':
      return const SettingRule.int(10, 60);
    case 'syncHistoryDays':
      return const SettingRule.intOf(['180', '365']);
    case 'message':
      return const SettingRule.text(0, 100);
    case 'relayVideo':
      return const SettingRule.enumOf(['copy', 'reencode']);
    case 'maxBitrateKbps':
      return const SettingRule.int(500, 6000);
    case 'titleTemplate':
      return const SettingRule.text(1, 100);
    case 'descriptionTemplate':
      return const SettingRule.text(0, 500);
    case 'speed':
      return const SettingRule.enumOf(['slow', 'normal', 'fast']);
    case 'shape':
      return const SettingRule.enumOf(['round', 'square']);
    case 'textSize':
      return const SettingRule.enumOf(['s', 'm', 'l']);
    case 'ds.name':
      return SettingRule.text(1, 60, re: _sourceNameRe, what: 'plain');
    case 'ds.url':
      return const SettingRule.sourceUrl();
    case 'name':
      return const SettingRule.text(1, 80);
    case 'shortName':
      return SettingRule.text(0, 12, re: _shortNameRe, what: 'plainNoHtml');
    case 'kind':
      return const SettingRule.enumOf(['surau', 'masjid']);
    case 'shortAddress':
      return const SettingRule.text(0, 120);
    case 'helpName':
      return const SettingRule.text(0, 60);
    case 'helpPhone':
      return SettingRule.text(
        0,
        30,
        re: _phoneRe,
        what: 'phone',
      );
    case 'helpEmail':
      return SettingRule.text(
        0,
        120,
        re: _emailRe,
        what: 'email',
      );
    case 'reciter':
      return SettingRule.regex(_reciterRe, 'reciter');
    case 'dirtyCheckSeconds':
      return const SettingRule.int(60, 900);
    case 'keepDays':
      return const SettingRule.intOf(['0', '1', '3', '7', '30']);
    case 'replaceGappyLive':
      return const SettingRule.enumOf(['ask', 'never', 'always']);
    case 'cloudUrl':
      return SettingRule.text(0, 200, re: _cloudUrlRe, what: 'https');
    case 'latitude':
      return const SettingRule.decimal(-90, 90);
    case 'longitude':
      return const SettingRule.decimal(-180, 180);
    case 'country':
      return SettingRule.regex(_countryRe, 'country');
    case 'timezone':
      return SettingRule.regex(_timeZoneRe, 'timezone');
    case 'city':
      return const SettingRule.text(0, 80);
    case 'method':
      return const SettingRule.enumOf(['auto', 'mwl', 'egyptian', 'karachi', 'ummAlQura', 'dubai', 'qatar', 'kuwait', 'moonsighting', 'singapore', 'tehran', 'turkey', 'northAmerica', 'jakim', 'kemenag', 'uoif', 'morocco', 'algeria', 'russia']);
    case 'madhab':
      return const SettingRule.enumOf(['auto', 'shafi', 'hanafi']);
    case 'highLatitude':
      return const SettingRule.enumOf(['auto', 'middleOfNight', 'seventhOfNight', 'twilightAngle']);
    case 'zone':
      return SettingRule.regex(_zoneRe, 'zone');
    case 'figure':
      return const SettingRule.enumOf(['balance', 'month', 'lastEntry']);
    case 'highlightSeconds':
      return const SettingRule.int(0, 120);
    case 'qrAssetId':
      return SettingRule.regex(_qrAssetRe, 'imageOrEmpty');
    case 'manualTitle':
    case 'row1Label':
    case 'row2Label':
    case 'row3Label':
      return const SettingRule.text(0, 40);
    case 'penceramahFundId':
      return SettingRule.regex(_fundIdRe, 'fundOrEmpty');
    case 'startedOn':
      return SettingRule.regex(_dateOrEmptyRe, 'dateOrEmpty');
    default:
      return null;
  }
}

const int maxText = 500;
const int maxImages = 20;
final RegExp _imageRe = RegExp(
  r'^(?:[0-9a-f]{64}|[a-z0-9-]{1,40}|/uploads/[A-Za-z0-9._-]{1,100})$',
);

bool _validImage(Object? x) =>
    x is String && _imageRe.hasMatch(x) && !x.contains('..');

// Internet source addresses (core's `net.ts`): https only, no user name
// or password, no fragment, at most 300 characters, and a public host (a
// DNS name with a dot, or an IP literal that is not private, loopback,
// link-local, mapped to one of those, or multicast). The box checks the
// same rules again and guards the fetch itself; this copy only lets the
// form refuse a bad address before it is sent. Known limit: core parses
// with the WHATWG URL parser, which normalises odd IPv4 spellings
// (`0x7f.1`); Dart's `Uri` does not, so such a host reaches the box and
// is refused there.

const int _maxSourceUrl = 300;
final RegExp _badUrlChars = RegExp(r'[\s\x00-\x1f\x7f]');
final RegExp _dottedQuad = RegExp(
  r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$',
);
final RegExp _dnsNameRe = RegExp(
  r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$',
);
const List<String> _blockedSuffixes = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.home.arpa',
];

List<int>? _parseV4(String s) {
  final m = _dottedQuad.firstMatch(s);
  if (m == null) return null;
  final o = [for (var i = 1; i <= 4; i++) int.parse(m.group(i)!)];
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/// Eight 16-bit groups of an IPv6 literal (no brackets, no zone), or null.
List<int>? _parseV6(String input) {
  var s = input.toLowerCase();
  if (s.contains('%') || !RegExp(r'^[0-9a-f:.]+$').hasMatch(s)) return null;
  final tail = RegExp(r'(\d{1,3}(?:\.\d{1,3}){3})$').firstMatch(s);
  if (tail != null) {
    final v4 = _parseV4(tail.group(1)!);
    if (v4 == null) return null;
    final hi = (v4[0] << 8) | v4[1];
    final lo = (v4[2] << 8) | v4[3];
    s =
        '${s.substring(0, s.length - tail.group(1)!.length)}'
        '${hi.toRadixString(16)}:${lo.toRadixString(16)}';
  }
  final halves = s.split('::');
  if (halves.length > 2) return null;
  List<int>? toGroups(String part) {
    if (part == '') return [];
    final out = <int>[];
    for (final g in part.split(':')) {
      if (!RegExp(r'^[0-9a-f]{1,4}$').hasMatch(g)) return null;
      out.add(int.parse(g, radix: 16));
    }
    return out;
  }

  final head = toGroups(halves[0]);
  if (head == null) return null;
  if (halves.length == 1) return head.length == 8 ? head : null;
  final rest = toGroups(halves[1]);
  if (rest == null || head.length + rest.length > 7) return null;
  return [...head, ...List.filled(8 - head.length - rest.length, 0), ...rest];
}

bool _privateV4(List<int> o) {
  final a = o[0];
  final b = o[1];
  return a == 0 ||
      a == 10 ||
      a == 127 ||
      (a == 100 && b >= 64 && b <= 127) ||
      (a == 169 && b == 254) ||
      (a == 172 && b >= 16 && b <= 31) ||
      (a == 192 && b == 168) ||
      (a == 192 && b == 0 && o[2] == 0) ||
      (a == 198 && (b == 18 || b == 19)) ||
      a >= 224;
}

/// Core's `isBlockedIp`: private, loopback, link-local, mapped, or malformed.
bool isBlockedIp(String ip) {
  final raw = ip.startsWith('[') && ip.endsWith(']')
      ? ip.substring(1, ip.length - 1)
      : ip;
  final v4 = _parseV4(raw);
  if (v4 != null) return _privateV4(v4);
  final g = _parseV6(raw);
  if (g == null) return true;
  final g0 = g[0];
  final embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  bool zeros(int n) => g.take(n).every((x) => x == 0);
  if (zeros(8) || (zeros(7) && g[7] == 1)) return true; // :: and ::1
  if (zeros(5) && g[5] == 0xffff) return _privateV4(embedded); // ::ffff:a.b.c.d
  if (zeros(6)) return true; // ::a.b.c.d
  if (g0 == 0x64 && g[1] == 0xff9b && g.sublist(2, 6).every((x) => x == 0)) {
    return _privateV4(embedded); // NAT64
  }
  if (g0 == 0x2002) {
    return _privateV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]); // 6to4
  }
  if ((g0 & 0xfe00) == 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) == 0xfe80) return true; // fe80::/10
  if ((g0 & 0xffc0) == 0xfec0) return true; // fec0::/10
  if ((g0 & 0xff00) == 0xff00) return true; // multicast
  return false;
}

/// Core's `isBlockedHost`: true when a URL host must not be contacted.
bool isBlockedHost(String hostname) {
  var h = hostname.toLowerCase();
  if (h.endsWith('.')) h = h.substring(0, h.length - 1);
  if (h == '') return true;
  if (h.startsWith('[') || h.contains(':')) return isBlockedIp(h);
  if (RegExp(r'^[0-9.]+$').hasMatch(h)) return isBlockedIp(h);
  if (!h.contains('.')) return true;
  if (h == 'localhost' || _blockedSuffixes.any(h.endsWith)) return true;
  return !_dnsNameRe.hasMatch(h);
}

/// Core's `sourceUrlError` in BM: null when [value] is an acceptable
/// public https address.
String _whatText(S s, String? key) => switch (key) {
  'plain' => s.valWhatPlain,
  'plainNoHtml' => s.valWhatPlainNoHtml,
  'phone' => s.valWhatPhone,
  'email' => s.valWhatEmail,
  'https' => s.valWhatHttps,
  'themeName' => s.valWhatThemeName,
  'reciter' => s.valWhatReciter,
  'country' => s.valWhatCountry,
  'timezone' => s.valWhatTimezone,
  'zone' => s.valWhatZone,
  'imageOrEmpty' => s.valWhatImageOrEmpty,
  'fundOrEmpty' => s.valWhatFundOrEmpty,
  'dateOrEmpty' => s.valWhatDateOrEmpty,
  _ => s.valWhatValid,
};

String? sourceUrlError(String value, [S? lang]) {
  final s = lang ?? sBm;
  if (value.length > _maxSourceUrl) {
    return s.valTooLong(_maxSourceUrl);
  }
  if (_badUrlChars.hasMatch(value)) {
    return s.valNoSpaces;
  }
  final Uri u;
  try {
    u = Uri.parse(value);
  } on FormatException {
    return s.valWebAddress;
  }
  if (u.scheme != 'https' || !u.hasAuthority) {
    return s.valStartHttps;
  }
  if (u.userInfo.isNotEmpty) {
    return s.valNoUserInfo;
  }
  if (u.hasFragment || value.contains('#')) return s.valNoFragment;
  if (isBlockedHost(u.host)) {
    return s.valPublicAddress;
  }
  return null;
}

/// One refused value: core's key path (`minutes.jumaat.subuh`) and the text
/// to show beside the field.
class SettingError {
  const SettingError(this.path, this.message);

  final String path;
  final String message;

  @override
  String toString() => '$path: $message';
}

class ValidationResult {
  const ValidationResult(this.errors);

  static const ValidationResult valid = ValidationResult([]);

  final List<SettingError> errors;

  bool get ok => errors.isEmpty;

  /// The first error's message, or null when valid.
  String? get firstMessage => errors.isEmpty ? null : errors.first.message;
}

final Map<String, FeatureDef> _byKey = {for (final f in features) f.key: f};

/// The registry entry for [key], or null.
FeatureDef? featureByKey(String key) => _byKey[key];

bool _isPlain(Object? v) => v is Map;

bool _isInteger(Object? v) =>
    v is int || (v is double && v.isFinite && v == v.truncateToDouble());

/// Smallest crop side (1% of the picture), as core's MIN_CROP_SPAN.
const double minCropSpan = 0.01;
final RegExp _assetIdRe = RegExp(r'^[0-9a-f]{64}$');

/// Core's HEX_RE, the colour a setting may hold.
final RegExp hexColourRe = RegExp(r'^#[0-9A-Fa-f]{6}$');

// Core's `isoInstantMs` (sync/merge.ts): the shape, then a real date.
final RegExp _isoInstantRe = RegExp(
  r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$',
);

bool _isIsoInstant(String v) =>
    v.length <= 40 && _isoInstantRe.hasMatch(v) && DateTime.tryParse(v) != null;

bool _finite(Object? n) => n is num && n.isFinite;

String? _rectError(Object? v, S s) {
  if (v is! Map) return s.valRectShape('{ x, y, w, h }');
  for (final k in v.keys) {
    if (k != 'x' && k != 'y' && k != 'w' && k != 'h') {
      return s.valUnknownField;
    }
  }
  if (!_finite(v['x']) ||
      !_finite(v['y']) ||
      !_finite(v['w']) ||
      !_finite(v['h'])) {
    return s.valRectNumbers;
  }
  final x = (v['x'] as num).toDouble();
  final y = (v['y'] as num).toDouble();
  final w = (v['w'] as num).toDouble();
  final h = (v['h'] as num).toDouble();
  if (x < 0 ||
      y < 0 ||
      w < minCropSpan ||
      h < minCropSpan ||
      x + w > 1 + 1e-9 ||
      y + h > 1 + 1e-9) {
    return s.valCropInside;
  }
  return null;
}

/// Core's `validateImageRef` (packages/core/src/image.ts): an image field is
/// the plain asset id, or an object `{asset, crop?, bg?, rotate?, square?}`.
/// [allowSquare] is true for the logo only. Null when valid, else the BM text.
String? imageRefError(Object? v, {bool allowSquare = false, S? s}) {
  final S l = s ?? sBm;
  if (v is String) return _assetIdRe.hasMatch(v) ? null : l.valImageIdBad;
  if (v is! Map) return l.imagePick;
  const known = {'asset', 'crop', 'bg', 'rotate', 'square'};
  for (final k in v.keys) {
    if (k == 'square' && !allowSquare) {
      return l.valSquareLogoOnly;
    }
    if (!known.contains(k)) return l.valUnknownField;
  }
  final asset = v['asset'];
  if (asset is! String || !_assetIdRe.hasMatch(asset)) {
    return l.valImageIdBad;
  }
  if (v.containsKey('crop')) {
    final e = _rectError(v['crop'], l);
    if (e != null) return e;
  }
  if (allowSquare && v.containsKey('square')) {
    final e = _rectError(v['square'], l);
    if (e != null) return e;
  }
  if (v.containsKey('bg') &&
      !const ['keep', 'remove', 'card'].contains(v['bg'])) {
    return l.valBgChoice;
  }
  if (v.containsKey('rotate')) {
    final r = v['rotate'];
    if (r is! num || !const [0, 90, 180, 270].contains(r)) {
      return l.valRotateChoice;
    }
  }
  return null;
}

String? _leafError(String path, String name, Object? v, Object? d, S s) {
  // The logo holds an image: empty (none), a plain asset id or an adjusted image.
  if (name == 'logo') {
    return v == '' ? null : imageRefError(v, allowSquare: true, s: s);
  }
  final rule = ruleFor(name);
  if (d is bool) return v is bool ? null : s.valBool;
  if (d is num) {
    if (rule != null && rule.type == SettingRuleType.intOf) {
      return _isInteger(v) && rule.vals.contains('${(v as num).toInt()}')
          ? null
          : s.valOneOf(rule.vals.join(', '));
    }
    final min = rule != null && rule.type == SettingRuleType.int ? rule.min : 0;
    final max = rule != null && rule.type == SettingRuleType.int
        ? rule.max
        : 1000000;
    return _isInteger(v) && (v as num) >= min && v <= max
        ? null
        : s.valWholeNumber(min, max);
  }
  if (d is String) {
    if (v is! String) return s.valMustText;
    if (v.length > maxText) {
      return s.valTooLong(maxText);
    }
    if (rule != null &&
        rule.type == SettingRuleType.enumOf &&
        !rule.vals.contains(v)) {
      return s.valOneOf(rule.vals.join(', '));
    }
    if (rule != null &&
        rule.type == SettingRuleType.regex &&
        !rule.re!.hasMatch(v)) {
      return s.valMustWhat(_whatText(s, rule.what));
    }
    if (rule != null && rule.type == SettingRuleType.sourceUrl) {
      return sourceUrlError(v, s);
    }
    if (rule != null && rule.type == SettingRuleType.text) {
      if (v.trim().length < rule.min) return s.valRequired;
      if (v.length > rule.max) {
        return s.valTooLong(rule.max);
      }
      if (rule.re != null && v != '' && !rule.re!.hasMatch(v)) {
        return s.valMustWhat(_whatText(s, rule.what));
      }
    }
    return null;
  }
  if (d == null) {
    if (rule != null && rule.type == SettingRuleType.decimal) {
      if (v == null) return null;
      final ok = v is num &&
          v.isFinite &&
          v >= rule.min &&
          v <= rule.max &&
          double.parse(v.toStringAsFixed(4)) == v;
      return ok ? null : s.valDecimal(rule.min, rule.max);
    }
    if (name == 'override') {
      return v == null || (v is String && hexColourRe.hasMatch(v))
          ? null
          : s.valColourHex;
    }
    if (name == 'audioFile') {
      return v == null || (v is String && _assetIdRe.hasMatch(v))
          ? null
          : s.valAudioFile;
    }
    if (name == 'suspendedAt') {
      return v == null || (v is String && _isIsoInstant(v))
          ? null
          : s.valTimeValid;
    }
    if (v is String && v.length > maxText) {
      return s.valTooLong(maxText);
    }
    return v == null || v is String ? null : s.valTextOrEmpty;
  }
  if (d is List) {
    if (v is! List || !v.every((x) => x is String)) return s.valTextList;
    if (v.any((x) => (x as String).length > maxText)) {
      return s.valItemMax(maxText);
    }
    if (name == 'sourceOrder') {
      const want = ['official', 'calc', 'file'];
      if (v.length != 3 || !want.every((x) => v.contains(x))) {
        return s.valSourceOrder;
      }
    }
    if (name == 'images') {
      if (v.length > maxImages) return s.valMaxImages(maxImages);
      if (!v.every(_validImage)) {
        return s.valImageNames;
      }
    }
    return null;
  }
  return s.valUnsupported;
}

void _checkObject(
  String path,
  String name,
  Object? v,
  Map<Object?, Object?> d,
  List<SettingError> errors,
  S s,
) {
  if (v is! Map) {
    errors.add(SettingError(path, s.valMustObject));
    return;
  }
  for (final k in v.keys) {
    final sub = '$path.$k';
    if (!d.containsKey(k)) {
      errors.add(SettingError(sub, s.valUnknownSetting));
      continue;
    }
    final dv = d[k];
    if (_isPlain(dv)) {
      _checkObject(sub, name, v[k], dv as Map<Object?, Object?>, errors, s);
    } else {
      final e = _leafError(sub, _leafRuleName(name, '$k'), v[k], dv, s);
      if (e != null) errors.add(SettingError(sub, e));
    }
  }
}

/// Core's `FEATURE_RULES`: rules that read several fields at once, run on the
/// patch merged over the stored or default values. Paths name the field the
/// red line belongs under.
void _crossFieldRules(
  String key,
  Map<Object?, Object?> merged,
  List<SettingError> errors,
  S s,
) {
  if (key != 'ayatCard') return;
  // Surah and verses matter only when the surau picks the verses itself (core: `m.pick !== 'manual'`).
  if (merged['pick'] != 'manual') return;
  final surah = merged['surah'];
  final from = merged['ayatFrom'];
  final to = merged['ayatTo'];
  if (surah is! num || from is! num || to is! num) return;
  if (!_isInteger(surah) || surah < 1 || surah > surahs.length) return;
  final row = surahs[surah.toInt() - 1];
  final name = surahName(s, surah.toInt());
  final ayat = row[2] as int;
  if (to > ayat) {
    errors.add(SettingError('ayatTo', s.valSurahAyat(name, ayat)));
    return;
  }
  if (from > ayat) {
    errors.add(SettingError('ayatFrom', s.valSurahAyat(name, ayat)));
    return;
  }
  if (from > to) {
    errors.add(SettingError('ayatFrom', s.valAyatOrder));
    return;
  }
  if (to - from > maxAyatAtOnce - 1) {
    errors.add(SettingError('ayatTo', s.valAyatMax));
  }
}

/// Core's `validateFeatureSettings(key, patch, current)`: accepts exactly the
/// patches core accepts. [patch] holds only the keys being changed; the
/// cross-field rules run only when [current] (the stored values) is given.
ValidationResult validateFeatureSettings(
  String key,
  Object? patch, {
  Map<Object?, Object?>? current,
  S? s,
}) {
  final S l = s ?? sBm;
  final f = _byKey[key];
  if (f == null) {
    return ValidationResult([SettingError(key, l.valUnknownFeature)]);
  }
  if (patch is! Map) {
    return ValidationResult([SettingError('', l.valSettingsObject)]);
  }
  final errors = <SettingError>[];
  for (final k in patch.keys) {
    if (k == 'enabled') {
      final v = patch['enabled'];
      if (v is! bool) {
        errors.add(SettingError('enabled', l.valBool));
      } else if (f.locked && !v) {
        errors.add(
          SettingError(
            'enabled',
            l.valAlwaysOn(featureLabel(f, appLangOfS(l))),
          ),
        );
      }
      continue;
    }
    if (k is! String || !f.defaults.containsKey(k)) {
      errors.add(SettingError('$k', l.valUnknownSetting));
      continue;
    }
    final dv = f.defaults[k];
    if (_isPlain(dv)) {
      _checkObject(k, k, patch[k], dv as Map<Object?, Object?>, errors, l);
    } else {
      final e = _leafError(k, k, patch[k], dv, l);
      if (e != null) errors.add(SettingError(k, e));
    }
  }
  // The cross-field rule is reported only when the patch touches a field it reads (core: `RULE_FIELDS`), so an
  // old stored range that breaks it does not block a save that leaves the verses alone.
  final touchesRule = key == 'ayatCard' &&
      (patch.containsKey('surah') ||
          patch.containsKey('ayatFrom') ||
          patch.containsKey('ayatTo'));
  if (current != null && errors.isEmpty && touchesRule) {
    _crossFieldRules(key, {...f.defaults, ...current, ...patch}, errors, l);
  }
  return errors.isEmpty ? ValidationResult.valid : ValidationResult(errors);
}
