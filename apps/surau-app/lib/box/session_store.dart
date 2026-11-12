// What the app keeps between launches, in shared_preferences under
// `surau.box.*`: the enrolled box, the last good surau details, and the
// surau's root CA (a public certificate). Nothing secret: the device key
// lives in its own store and the session token is never persisted.

import 'dart:convert';
import 'dart:typed_data';

import 'package:shared_preferences/shared_preferences.dart';

import '../features/common/surau_info.dart';
import '../features/enrol/enrol_flow.dart';
import 'trust.dart';

const String _prefix = 'surau.box.';
const String _enrolledKey = '${_prefix}enrolled';
const String _infoKey = '${_prefix}surau';
const String _caPrefix = '${_prefix}ca.';

class SessionStore implements EnrolledBoxStore, CaDerSource {
  SessionStore(this._prefs);

  final SharedPreferences _prefs;

  static Future<SessionStore> open() async =>
      SessionStore(await SharedPreferences.getInstance());

  @override
  Future<EnrolledBox?> load() async {
    final raw = _prefs.getString(_enrolledKey);
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw);
      if (j is Map<String, dynamic>) return EnrolledBox.fromJson(j);
    } on Object {
      // fall through: corrupt or from another version
    }
    await _prefs.remove(_enrolledKey);
    return null;
  }

  @override
  Future<void> save(EnrolledBox box) =>
      _prefs.setString(_enrolledKey, jsonEncode(box.toJson()));

  @override
  Future<void> clear() => forget();

  /// Forget the box: the enrolment record, the surau details and the
  /// pinned CA. The device key is cleared by its own store.
  Future<void> forget() async {
    for (final k in _prefs.getKeys().toList()) {
      if (k.startsWith(_prefix)) await _prefs.remove(k);
    }
  }

  /// Keeps a checked root CA under its own sha256. Refuses bytes that do
  /// not hash to [sha256].
  Future<void> saveCaDer(String sha256, Uint8List der) async {
    final want = sha256.toLowerCase();
    if (sha256Hex(der) != want) {
      throw ArgumentError.value(sha256, 'sha256', 'does not match the bytes');
    }
    await _prefs.setString('$_caPrefix$want', base64.encode(der));
  }

  /// The kept root CA for [sha256], or null when absent or when the stored
  /// bytes no longer hash to it.
  @override
  Future<Uint8List?> loadCaDer(String sha256) async {
    final want = sha256.toLowerCase();
    final raw = _prefs.getString('$_caPrefix$want');
    if (raw == null) return null;
    try {
      final der = base64.decode(raw);
      return sha256Hex(der) == want ? der : null;
    } on FormatException {
      return null;
    }
  }
}

/// The last good `GET /api/surau/info`, for the unlock screen when the box
/// is away.
class SurauInfoPrefsStore implements SurauInfoStore {
  SurauInfoPrefsStore(this._prefs);

  final SharedPreferences _prefs;

  @override
  Future<SurauInfo?> load() async {
    final raw = _prefs.getString(_infoKey);
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw);
      if (j is Map<String, dynamic>) return SurauInfo.fromJson(j);
    } on Object {
      // fall through
    }
    return null;
  }

  @override
  Future<void> save(SurauInfo info) =>
      _prefs.setString(_infoKey, jsonEncode(info.toJson()));
}
