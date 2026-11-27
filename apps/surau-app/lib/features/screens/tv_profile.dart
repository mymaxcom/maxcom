// What one TV chooses for itself (setting feature `tvProfiles`, map field `tvs`; the Dart twin of
// packages/core/src/features/tvProfiles.ts). A field that is null follows the surau's own value. The box stores one
// TV's entry as a whole, so a save sends the whole entry of that one TV and nothing else.

/// The content kinds a TV may hide, in the order of the box's list.
const List<String> tvHideKinds = [
  'kuliah', 'pengumuman', 'ticker', 'poster', 'video', 'programKhas', 'takwim', 'hadis', 'worldTime', 'tugasan', 'zikir', 'tabung',
];

/// The language choices of a TV (`auto` is the device's language).
const List<String> tvLangs = ['auto', 'ms', 'en', 'ar'];

/// The TV id of the main box's own TV.
const String selfTvId = 'self';

class TvProfile {
  const TvProfile({
    this.name,
    this.templateId,
    this.orientation,
    this.lang,
    this.show,
    this.audio,
    this.volume,
    this.fit,
    this.showStrip,
    this.hideKinds = const [],
    this.beeps,
    this.azan,
    this.tilawah,
  });

  /// Reads one TV's entry; anything of the wrong type is left out (it then follows the surau).
  factory TvProfile.fromJson(Object? j) {
    if (j is! Map) return const TvProfile();
    final live = j['live'] is Map ? j['live'] as Map<Object?, Object?> : const <Object?, Object?>{};
    final sounds = j['sounds'] is Map ? j['sounds'] as Map<Object?, Object?> : const <Object?, Object?>{};
    bool? b(Object? v) => v is bool ? v : null;
    final kinds = j['hideKinds'];
    final vol = live['volume'];
    return TvProfile(
      name: j['name'] is String && (j['name'] as String).trim().isNotEmpty ? (j['name'] as String).trim() : null,
      templateId: j['templateId'] is String && (j['templateId'] as String).isNotEmpty ? j['templateId'] as String : null,
      orientation: j['orientation'] == 'landscape' || j['orientation'] == 'portrait' ? j['orientation'] as String : null,
      lang: tvLangs.contains(j['lang']) ? j['lang'] as String : null,
      show: b(live['show']),
      audio: b(live['audio']),
      volume: vol is num && vol >= 0 && vol <= 100 ? vol.toInt() : null,
      fit: live['fit'] == 'cover' || live['fit'] == 'contain' ? live['fit'] as String : null,
      showStrip: b(live['showStrip']),
      hideKinds: kinds is List
          ? [
              for (final k in kinds)
                if (k is String && tvHideKinds.contains(k)) k,
            ]
          : const [],
      beeps: b(sounds['beeps']),
      azan: b(sounds['azan']),
      tilawah: b(sounds['tilawah']),
    );
  }

  final String? name;
  final String? templateId;
  final String? orientation;
  final String? lang;
  final bool? show;
  final bool? audio;
  final int? volume;
  final String? fit;
  final bool? showStrip;
  final List<String> hideKinds;
  final bool? beeps;
  final bool? azan;
  final bool? tilawah;

  /// This TV's entry as the box stores it: only what is set.
  Map<String, dynamic> toJson() {
    final live = <String, dynamic>{
      'show': ?show,
      'audio': ?audio,
      'volume': ?volume,
      'fit': ?fit,
      'showStrip': ?showStrip,
    };
    final sounds = <String, dynamic>{'beeps': ?beeps, 'azan': ?azan, 'tilawah': ?tilawah};
    return {
      'name': ?name,
      'templateId': ?templateId,
      'orientation': ?orientation,
      'lang': ?lang,
      if (live.isNotEmpty) 'live': live,
      if (hideKinds.isNotEmpty) 'hideKinds': hideKinds,
      if (sounds.isNotEmpty) 'sounds': sounds,
    };
  }

  TvProfile copyWith({
    Object? name = _keep,
    Object? templateId = _keep,
    Object? lang = _keep,
    Object? show = _keep,
    Object? audio = _keep,
    Object? volume = _keep,
    List<String>? hideKinds,
    Object? beeps = _keep,
    Object? azan = _keep,
    Object? tilawah = _keep,
  }) => TvProfile(
    name: identical(name, _keep) ? this.name : name as String?,
    templateId: identical(templateId, _keep) ? this.templateId : templateId as String?,
    orientation: orientation,
    lang: identical(lang, _keep) ? this.lang : lang as String?,
    show: identical(show, _keep) ? this.show : show as bool?,
    audio: identical(audio, _keep) ? this.audio : audio as bool?,
    volume: identical(volume, _keep) ? this.volume : volume as int?,
    fit: fit,
    showStrip: showStrip,
    hideKinds: hideKinds ?? this.hideKinds,
    beeps: identical(beeps, _keep) ? this.beeps : beeps as bool?,
    azan: identical(azan, _keep) ? this.azan : azan as bool?,
    tilawah: identical(tilawah, _keep) ? this.tilawah : tilawah as bool?,
  );

  @override
  bool operator ==(Object other) => other is TvProfile && _same(toJson(), other.toJson());

  @override
  int get hashCode => Object.hashAll([name, templateId, lang, show, audio, volume, beeps, azan, tilawah, hideKinds.length]);
}

const Object _keep = Object();

bool _same(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !_same(a[k], b[k])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_same(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// The entry of [tvId] in the settings answer (`tvProfiles.tvs.<tvId>`); empty when the TV has none.
TvProfile tvProfileOf(Map<String, dynamic>? settings, String tvId) {
  final tp = settings?['tvProfiles'];
  final tvs = tp is Map ? tp['tvs'] : null;
  return tvs is Map ? TvProfile.fromJson(tvs[tvId]) : const TvProfile();
}

/// The one-entry patch of `PUT /api/settings/tvProfiles` for [tvId].
Map<String, dynamic> tvProfilePatch(String tvId, TvProfile p) => {
  'tvs': {tvId: p.toJson()},
};
