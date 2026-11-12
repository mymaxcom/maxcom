// Who the surau is and who to call for help: the two things a person needs
// on the enrolment and unlock screens before anything technical. Served by
// the box at `GET /api/surau/info` (public, no token) and carried in the
// enrolment payload; the last good copy is kept locally so the unlock
// screen shows the surau's name and helper even when the box is away.

import '../../box/box_client.dart';

/// The surau's contact person. Every field is optional; [isEmpty] when none
/// is given, in which case the help card only says to ask the admin.
class HelpContact {
  const HelpContact({this.name, this.phone, this.email});

  factory HelpContact.fromJson(Map<String, dynamic> j) => HelpContact(
    name: _text(j['name'], 60),
    phone: _text(j['phone'], 24),
    email: _text(j['email'], 120),
  );

  final String? name;
  final String? phone;
  final String? email;

  bool get isEmpty => name == null && phone == null && email == null;

  /// At least one way to reach the person (phone or email).
  bool get reachable => phone != null || email != null;

  Map<String, dynamic> toJson() => {
    'name': ?name,
    'phone': ?phone,
    'email': ?email,
  };
}

/// The only logo address the app will fetch: the box's own public route,
/// relative to the box origin, with its version tag (`/surau-logo?v=...`).
final RegExp _logoPathRe = RegExp(r'^/surau-logo(?:\?v=[0-9a-f]{1,64})?$');

/// [v] when it is exactly the box's public logo path, else null.
String? surauLogoPath(Object? v) => v is String && _logoPathRe.hasMatch(v) ? v : null;

/// `GET /api/surau/info`, as the box answers it. [kind] is `surau` or
/// `masjid`; [name] already carries the word ("Surau D'Waqaf").
class SurauInfo {
  const SurauInfo({
    required this.name,
    this.kind = 'surau',
    this.shortAddress,
    this.help,
    this.logo,
    this.showName = true,
  });

  /// Lenient: a missing or empty name yields null (the caller shows the
  /// product name instead); unknown kinds fall back to `surau`; a logo
  /// that is not the box's own `/surau-logo` path is dropped; `showName`
  /// is on unless the box says exactly `false`.
  static SurauInfo? fromJson(Map<String, dynamic> j) {
    final name = _text(j['name'], 80);
    if (name == null) return null;
    final kind = j['kind'];
    final help = j['help'];
    final contact = help is Map<String, dynamic>
        ? HelpContact.fromJson(help)
        : null;
    return SurauInfo(
      name: name,
      kind: kind == 'masjid' ? 'masjid' : 'surau',
      shortAddress: _text(j['shortAddress'], 120),
      help: contact == null || contact.isEmpty ? null : contact,
      logo: surauLogoPath(j['logo']),
      showName: j['showName'] != false,
    );
  }

  final String name;
  final String kind;
  final String? shortAddress;
  final HelpContact? help;

  /// The logo's public path on the box (`/surau-logo?v=<tag>`), or null
  /// when the surau has none. The tag changes with the picture, so a
  /// cached copy is never shown for a new logo.
  final String? logo;

  /// Show the name as text beside the logo; false when the logo already
  /// carries the name (a wordmark). Without a logo the name always shows.
  final bool showName;

  /// Whether the headers write the name out, given whether a logo is on
  /// screen: the name is dropped only when the logo stands in for it.
  bool nameShown({required bool hasLogo}) => showName || !hasLogo;

  Map<String, dynamic> toJson() => {
    'name': name,
    'kind': kind,
    'shortAddress': ?shortAddress,
    'help': ?help?.toJson(),
    'logo': ?logo,
    if (!showName) 'showName': false,
  };
}

/// A trimmed non-empty string no longer than [max], else null.
String? _text(Object? v, int max) {
  if (v is! String) return null;
  final t = v.trim();
  if (t.isEmpty) return null;
  return t.length > max ? t.substring(0, max) : t;
}

/// Where the last good copy lives between launches. The session store
/// (shared_preferences) implements this; tests use [MemorySurauInfoStore].
abstract class SurauInfoStore {
  Future<SurauInfo?> load();
  Future<void> save(SurauInfo info);
}

class MemorySurauInfoStore implements SurauInfoStore {
  MemorySurauInfoStore([this._info]);

  SurauInfo? _info;

  @override
  Future<SurauInfo?> load() async => _info;

  @override
  Future<void> save(SurauInfo info) async => _info = info;
}

/// Reads the surau's details: [cached] answers at once from the store,
/// [refresh] asks the box and keeps a good answer; when the box is away or
/// answers badly the cached copy is returned instead, never an error.
class SurauInfoLoader {
  SurauInfoLoader({required this.client, required this.store, this.fallback})
    : _servedBy = client;

  final BoxClient client;
  final SurauInfoStore store;

  /// Asked when [client] (the box) does not answer: the MAXCOM cloud,
  /// which serves the same public route. Null: no second try.
  final Future<BoxClient?> Function()? fallback;

  BoxClient _servedBy;

  /// The client whose answer [refresh] last returned (the logo is fetched
  /// from the same place).
  BoxClient get servedBy => _servedBy;

  static const String path = '/api/surau/info';

  Future<SurauInfo?> cached() => store.load();

  Future<SurauInfo?> refresh() async {
    final fresh = await _ask(client) ?? await _askFallback();
    return fresh ?? await store.load();
  }

  Future<SurauInfo?> _askFallback() async {
    final f = fallback;
    if (f == null) return null;
    try {
      final c = await f();
      return c == null ? null : await _ask(c);
    } on Object {
      return null;
    }
  }

  Future<SurauInfo?> _ask(BoxClient c) async {
    try {
      final info = SurauInfo.fromJson(await c.getJson(path));
      if (info == null) return null;
      await store.save(info);
      _servedBy = c;
      return info;
    } on Exception {
      return null;
    }
  }
}
