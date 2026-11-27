// The Kamera luaran form (plan 4.2, 4.3; mockups 07 to 16): name, the RTSP
// address (the login may sit inside it or in the two optional boxes below),
// the password that is only ever shown as dots once saved, what the camera
// has for audio, "Uji sambungan" with one message per failure reason, and
// "Pengangkutan" folded inside "Lanjutan".
//
// Two stores share one `Simpan`: the feature settings (`name`, `transport`,
// the feature switch) go through the settings page as always; the address
// and login are a sealed record on the box (`/api/live/camera`) saved by
// [CameraSourceController.save], which the page calls first. The password
// typed here lives only in a text controller until that save answers; the
// box answers the address masked and `hasPassword`, so after a save the form
// holds dots and no password text anywhere.
//
// Shown only to holders of `live:settings` (the page checks). "Cari kamera di
// rangkaian" (ONVIF, task O1) opens a list of what the box found (name + IP);
// tapping one asks for the camera login and the box fills the address in.
// [cameraDiscoveryFill] is the list-only switch: off, a tap only puts the
// camera's address in the form and the rest is typed by hand.

import 'dart:async' show Timer, unawaited;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show LengthLimitingTextInputFormatter;

import '../../app/app_lang.dart' show AppLang;
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/s_lookup.dart' show sFor;
import '../common/error_text.dart' show errorText;
import '../live/camera_url.dart';
import '../labels.dart';
import '../labels_cam.dart';
import '../settings_form.dart' show ChoiceField;
import '../../screens/widgets/pieces.dart' show confirmDialog;
import '../shell/box_gateway.dart';
import '../shell/live_camera_gateway.dart';

/// "Cari kamera di rangkaian" (ONVIF, task O1): the entry point is drawn.
const bool cameraDiscoveryReady = true;

/// The auto-fill step of discovery (login sheet, `GetStreamUri` on the box). Off is list-only mode: choosing a camera
/// from the list only fills `rtsp://<ip>:554/` and the person completes the address.
const bool cameraDiscoveryFill = true;

/// The dots the box puts where the camera password was (core `CAMERA_PASSWORD_MASK`).
const String cameraPasswordMask = '••••••';

/// The address with the password replaced by dots, as core `maskCameraUrl`: never throws, never returns the password.
/// An `@` after the first `/`, `?` or `#` belongs to the path, not the login.
String maskCameraUrl(String url) {
  final s = url.indexOf('://');
  final head = s == -1 ? '' : url.substring(0, s + 3);
  final rest = s == -1 ? url : url.substring(s + 3);
  final cut = rest.indexOf(RegExp(r'[/?#]'));
  final authority = cut == -1 ? rest : rest.substring(0, cut);
  final tail = cut == -1 ? '' : rest.substring(cut);
  final at = authority.lastIndexOf('@');
  var out = url;
  if (at != -1) {
    final info = authority.substring(0, at);
    final colon = info.indexOf(':');
    if (colon != -1) {
      out = '$head${info.substring(0, colon)}:$cameraPasswordMask${authority.substring(at)}$tail';
    }
  }
  return _maskQuery(out);
}

const _querySecretKeys = <String>{'pass', 'pwd', 'password', 'passwd'};

/// Each non-empty value of a password parameter of the query becomes the dots (as core `maskCameraQuery`).
String _maskQuery(String url) {
  final h = url.indexOf('#');
  final hash = h == -1 ? '' : url.substring(h);
  final noHash = h == -1 ? url : url.substring(0, h);
  final q = noHash.indexOf('?');
  if (q == -1) return url;
  var changed = false;
  final pairs = noHash.substring(q + 1).split('&').map((p) {
    final eq = p.indexOf('=');
    if (eq == -1) return p;
    var key = p.substring(0, eq);
    try {
      key = Uri.decodeComponent(key);
    } on Object {
      // a key that does not decode is compared as it is
    }
    if (_querySecretKeys.contains(key.toLowerCase()) && eq < p.length - 1) {
      changed = true;
      return '${p.substring(0, eq)}=$cameraPasswordMask';
    }
    return p;
  }).join('&');
  return changed ? '${noHash.substring(0, q)}?$pairs$hash' : url;
}

/// Where the address points: host, port and path (login and scheme left out), lower-cased host. Two addresses with
/// the same value reach the same stream, so a saved password may stay; a different one needs the password again.
String cameraTarget(String url) {
  final s = url.indexOf('://');
  final rest = s == -1 ? url : url.substring(s + 3);
  final cut = rest.indexOf(RegExp(r'[/?#]'));
  final authority = cut == -1 ? rest : rest.substring(0, cut);
  final tail = cut == -1 ? '' : rest.substring(cut);
  final at = authority.lastIndexOf('@');
  final hostPort = (at == -1 ? authority : authority.substring(at + 1)).toLowerCase();
  return '$hostPort$tail';
}

/// The login part of an address holds a password that is typed in full (not the dots).
bool _hasInlinePassword(String url) {
  final s = url.indexOf('://');
  final rest = s == -1 ? url : url.substring(s + 3);
  final cut = rest.indexOf(RegExp(r'[/?#]'));
  final authority = cut == -1 ? rest : rest.substring(0, cut);
  final at = authority.lastIndexOf('@');
  if (at == -1) return false;
  final info = authority.substring(0, at);
  final colon = info.indexOf(':');
  return colon != -1 && info.substring(colon + 1) != cameraPasswordMask;
}

/// The address without the dots where the password was, so that the password goes in its own field.
String _withoutMask(String url) => url.replaceFirst(':$cameraPasswordMask@', '@');

/// The state of "Uji sambungan".
enum CameraTestPhase { idle, running, done, failed }

/// The state and the calls of the camera record behind the form.
class CameraSourceController extends ChangeNotifier {
  CameraSourceController(this._gateway, {bool Function()? viaCloud}) : _viaCloud = viaCloud ?? (() => false) {
    url.addListener(_changed);
    username.addListener(_changed);
    password.addListener(_changed);
  }

  final BoxGateway? Function() _gateway;

  /// The session came from the cloud: the address and login are sealed to the box's key and sent through it
  /// (the box applies them on its next check); the test and the ONVIF search need the surau's own network.
  final bool Function() _viaCloud;

  /// Read by the card: the form is the cloud's (a change waits for the box, no test, no ONVIF search).
  bool get viaCloud => _viaCloud();

  /// While a change sent through the cloud waits for the box, the cloud is asked again now and then.
  Timer? _pendingTimer;
  static const Duration _pendingEvery = Duration(seconds: 15);

  /// The box does not know the camera routes (HTTP 404: the cloud, or an old box): the same words as the cloud card,
  /// never the raw `not found: GET ...` text.
  static bool _isNotFound(BoxError e) => e.status == 404;

  /// The app language the messages this controller keeps (errors, test results) are in;
  /// the card sets it on every build.
  AppLang lang = AppLang.ms;

  final TextEditingController url = TextEditingController();
  final TextEditingController username = TextEditingController();
  final TextEditingController password = TextEditingController();

  /// The password field: focused when the box restored the camera and waits for its password.
  final FocusNode passwordFocus = FocusNode(debugLabel: 'camera-password');

  /// The box restored the camera from the cloud backup (which never holds the password) and waits for it here.
  bool get passwordNeeded => record.passwordNeeded && !record.hasPassword;

  LiveCameraRecord record = LiveCameraRecord.none;
  bool loading = true;
  String? loadError;

  /// "Tukar kata laluan" was pressed: the box shows for the new one.
  bool changingPassword = false;
  bool showPassword = false;

  String? urlError;
  String? loginError;
  String? passwordError;
  String? saveError;

  CameraTestPhase testPhase = CameraTestPhase.idle;
  CameraTestOutcome? testOutcome;
  String? testMessage;
  bool _disposed = false;

  void _changed() {
    urlError = null;
    loginError = null;
    passwordError = null;
    saveError = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// The password box is open: a first password, or a replacement.
  bool get passwordBoxOpen => !record.hasPassword || changingPassword || addressMoved;

  /// A saved camera whose host, port or path was changed here: the box will not carry the saved password to a new
  /// address, so the dots go and the password is asked for again. A password typed inside the address counts as given.
  bool get addressMoved {
    if (!record.hasPassword || record.url.isEmpty) return false;
    final full = _filledFull;
    if (full != null && url.text.trim() == _filledMasked) return false;
    final typed = url.text.trim();
    if (_hasInlinePassword(typed)) return false;
    return cameraTarget(typed) != cameraTarget(record.url);
  }

  /// The full address a "fill" brought, held in memory only; the field shows [_filledMasked]. Never in a widget.
  String? _filledFull;
  String? _filledMasked;

  /// What goes to the box: the full address of a fill while the field still shows its masked form, else what is typed.
  String get _urlForBox {
    final full = _filledFull;
    if (full != null && url.text.trim() == _filledMasked) return full;
    return url.text.trim();
  }

  /// Something here is not on the box yet.
  bool get dirty =>
      (_filledFull != null && url.text.trim() == _filledMasked) ||
      url.text.trim() != record.url ||
      username.text.trim() != (record.username ?? '') ||
      password.text.isNotEmpty;

  /// The same rules as the box (a Dart twin of core's `cameraUrlError`), minus the box's own addresses, which only the
  /// box knows: its `is_box` refusal lands under the field.
  bool get valid => url.text.trim().isEmpty || cameraAddressReason(url.text.trim()) == null;

  /// What is wrong with the address as typed, in the person's words, while they type; null when nothing is.
  /// The first letters of `rtsp://` are not an error yet.
  String? get urlLiveError {
    final t = url.text.trim();
    if (t.isEmpty || _rtspPrefix.startsWith(t)) return null;
    return cameraReasonText(sFor(lang), cameraAddressReason(t));
  }

  static const String _rtspPrefix = 'rtsp://';

  bool get hasAddress => url.text.trim().isNotEmpty;

  /// The camera has an audio track as far as the last test knows; null when unknown.
  bool? get hasAudio => record.lastTest?.hasAudio;

  /// The last test's codec names, e.g. `MPEG-4 Audio`.
  List<String> get codecs => record.lastTest?.codecs ?? const [];

  Future<void> load() async {
    final g = _gateway();
    if (g == null) return;
    loading = true;
    loadError = null;
    _notify();
    try {
      _apply(await g.liveCamera());
    } on BoxUnreachable {
      loadError = cameraTestBoxAway(lang);
    } on SessionExpired {
      loadError = cameraLoadFailed(lang);
    } on BoxError catch (e) {
      loadError = _isNotFound(e) ? cameraAtSurauOnly(lang) : e.message;
    }
    loading = false;
    _notify();
  }

  void _apply(LiveCameraRecord r) {
    if (_disposed) return;
    record = r;
    _watchPending();
    _filledFull = null;
    _filledMasked = null;
    // The listeners must not read these writes as typing.
    url.removeListener(_changed);
    username.removeListener(_changed);
    password.removeListener(_changed);
    url.text = r.url;
    username.text = r.username ?? '';
    password.clear();
    url.addListener(_changed);
    username.addListener(_changed);
    password.addListener(_changed);
    changingPassword = false;
    showPassword = false;
    urlError = null;
    loginError = null;
    saveError = null;
    if (passwordNeeded) {
      // after the form is drawn with the open password box
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_disposed && passwordNeeded && passwordFocus.canRequestFocus && passwordFocus.context != null) passwordFocus.requestFocus();
      });
    }
  }

  /// Cloud only: asks again every few seconds while a change waits for the box, so the form settles by itself.
  void _watchPending() {
    _pendingTimer?.cancel();
    _pendingTimer = null;
    if (!record.pending || !_viaCloud()) return;
    _pendingTimer = Timer.periodic(_pendingEvery, (_) => unawaited(_refreshPending()));
  }

  bool _refreshing = false;

  Future<void> _refreshPending() async {
    final g = _gateway();
    if (_disposed || g == null || _refreshing || !record.pending) return;
    _refreshing = true;
    try {
      final fresh = await g.liveCamera();
      if (_disposed) return;
      if (!fresh.pending) {
        // settled: the box applied it (the address it holds is shown) or refused it (`failure` says why)
        if (dirty) {
          // the person is typing again: their text stays, only the state changes
          record = fresh;
          _watchPending();
        } else {
          _apply(fresh);
        }
        _notify();
      }
    } on Object {
      // the next round tries again
    } finally {
      _refreshing = false;
    }
  }

  void startChangingPassword() {
    changingPassword = true;
    _notify();
  }

  void cancelChangingPassword() {
    password.clear();
    changingPassword = false;
    showPassword = false;
    _notify();
  }

  void toggleShowPassword() {
    showPassword = !showPassword;
    _notify();
  }

  /// Saves the record when something changed. True when there is nothing to save or the box accepted it.
  Future<bool> save() async {
    if (!dirty) return true;
    if (!valid) {
      urlError = urlLiveError ?? cameraReasonText(sFor(lang), cameraAddressReason(url.text.trim())) ?? sFor(lang).errcBadAddress;
      _notify();
      return false;
    }
    if (addressMoved && password.text.isEmpty) {
      passwordError = cameraPassAgain(lang);
      _notify();
      return false;
    }
    final g = _gateway();
    if (g == null) return false;
    if (_viaCloud()) return _saveViaCloud(g);
    try {
      final saved = await g.saveLiveCamera(
        url: addressMoved ? _withoutMask(_urlForBox) : _urlForBox,
        username: username.text.trim(),
        password: password.text.isNotEmpty ? password.text : null,
      );
      _apply(saved);
      _notify();
      return true;
    } on BoxUnreachable {
      saveError = cameraTestBoxAway(lang);
    } on OfflineWriteRefused {
      saveError = OfflineWriteRefused.message;
    } on SessionExpired {
      return false;
    } on BoxError catch (e) {
      if (_isNotFound(e)) {
        saveError = cameraAtSurauOnly(lang);
      } else if (e.code == 'password_again') {
        passwordError = cameraPassAgain(lang);
        changingPassword = true;
      } else if (e.code == 'bad_address') {
        urlError = errorText(sFor(lang), e);
      } else if (e.code == 'bad_login') {
        loginError = errorText(sFor(lang), e);
      } else {
        saveError = errorText(sFor(lang), e);
      }
    }
    _notify();
    return false;
  }

  /// The login typed inside the address (`rtsp://user:pass@host`), or null.
  static String? _inlineUser(String url) {
    final m = RegExp(r'^rtsp://([^:@/?#]*)(?::[^@/?#]*)?@').firstMatch(url);
    final u = m?.group(1);
    return u == null || u.isEmpty ? null : u;
  }

  /// Cloud: seals the address and login to the box's key and sends them; the box applies them on its next check.
  /// What the form shows meanwhile is the masked address that was sent, with the "sent to the box" note.
  Future<bool> _saveViaCloud(BoxGateway g) async {
    var relay = record.relay;
    if (relay == null) {
      saveError = cameraCloudNoBox(lang);
      _notify();
      return false;
    }
    final sentUrl = addressMoved ? _withoutMask(_urlForBox) : _urlForBox;
    final sentUser = username.text.trim();
    final sentPassword = password.text.isNotEmpty ? password.text : null;
    final keptPassword = record.hasPassword && !addressMoved && sentPassword == null;
    try {
      LiveCameraRecord? out;
      for (var attempt = 0; attempt < 2 && out == null; attempt++) {
        try {
          out = await g.saveLiveCameraViaCloud(relay: relay!, url: sentUrl, username: sentUser, password: sentPassword);
        } on BoxError catch (e) {
          // another change got in first: read the number again and seal again, once
          if (e.code != 'stale' || attempt == 1) rethrow;
          final fresh = await g.liveCamera();
          relay = fresh.relay;
          if (relay == null) throw const BoxError(409, 'no_box', code: 'no_box');
        }
      }
      final inline = _inlineUser(sentUrl);
      final user = inline ?? (sentUser.isNotEmpty ? sentUser : null);
      final inlinePassword = _hasInlinePassword(sentUrl);
      _apply(
        LiveCameraRecord(
          configured: true,
          url: maskCameraUrl(sentUrl),
          username: user,
          hasPassword: sentPassword != null || inlinePassword || keptPassword,
          lastTest: null,
          pending: true,
          relay: out!.relay ?? relay,
        ),
      );
      _notify();
      return true;
    } on BoxUnreachable {
      saveError = cameraTestBoxAway(lang);
    } on OfflineWriteRefused {
      saveError = OfflineWriteRefused.message;
    } on SessionExpired {
      return false;
    } on BoxError catch (e) {
      if (e.code == 'no_box') {
        saveError = cameraCloudNoBox(lang);
      } else if (_isNotFound(e)) {
        saveError = cameraAtSurauOnly(lang);
      } else if (e.code == 'stale') {
        saveError = cameraCloudRefused(lang, 'error');
      } else {
        saveError = errorText(sFor(lang), e);
      }
    }
    _notify();
    return false;
  }

  /// "Uji sambungan": saves what is typed first (the box tests the saved address), then asks the box.
  Future<void> runTest(String transport) async {
    if (testPhase == CameraTestPhase.running) return;
    final g = _gateway();
    if (g == null) return;
    // the test needs the box next to the camera; the card does not offer it over the cloud
    if (_viaCloud()) return;
    if (!hasAddress) {
      urlError = cameraTestNeedUrl(lang);
      _notify();
      return;
    }
    testPhase = CameraTestPhase.running;
    testOutcome = null;
    testMessage = null;
    _notify();
    if (!await save()) {
      testPhase = CameraTestPhase.idle;
      _notify();
      return;
    }
    try {
      final out = await g.testLiveCamera(transport: transport);
      testOutcome = out;
      testPhase = CameraTestPhase.done;
      const kept = {'ok', 'unreachable', 'login', 'path', 'codec'};
      if (kept.contains(out.code)) record = record.withTest(out);
    } on BoxUnreachable {
      testPhase = CameraTestPhase.failed;
      testMessage = cameraTestBoxAway(lang);
    } on SessionExpired {
      testPhase = CameraTestPhase.idle;
    } on BoxError catch (e) {
      // 409 live_busy, 429 too_many: the app's words for the code.
      testPhase = CameraTestPhase.failed;
      testMessage = _isNotFound(e) ? cameraAtSurauOnly(lang) : errorText(sFor(lang), e);
    }
    _notify();
  }

  // ---- camera control (Lane X)

  /// A change of the control opt-in is on its way to the box.
  bool controlBusy = false;

  /// The box's words when the opt-in could not be changed.
  String? controlError;

  /// "Benarkan kawalan kamera": switches the opt-in of the saved camera on the box. What is typed in the form is kept.
  Future<void> setControl(bool on) => _putControl((g) => g.setLiveCameraControl(enabled: on));

  /// The profile fields under the switch: the whole profile is sent at each change (the box checks every field).
  Future<void> setProfile(LiveCameraProfile p) => _putControl((g) => g.setLiveCameraControl(profile: p));

  /// "Terapkan semasa siaran bermula".
  Future<void> setApplyOnLive(bool on) => _putControl((g) => g.setLiveCameraControl(applyOnLive: on));

  Future<void> _putControl(Future<LiveCameraRecord> Function(BoxGateway g) call) async {
    if (controlBusy) return;
    final g = _gateway();
    if (g == null || _viaCloud() || !record.configured) return;
    controlBusy = true;
    controlError = null;
    _notify();
    try {
      final out = await call(g);
      record = record.withControl(out.control);
    } on BoxUnreachable {
      controlError = cameraTestBoxAway(lang);
    } on SessionExpired {
      // the session ends the page
    } on BoxError catch (e) {
      controlError = _isNotFound(e) ? cameraAtSurauOnly(lang) : errorText(sFor(lang), e);
    }
    controlBusy = false;
    _notify();
  }

  // ---- discovery (O1)

  bool discovering = false;
  List<DiscoveredCamera>? found;
  String? discoverError;
  bool filling = false;
  String? fillError;

  /// "Cari kamera di rangkaian": the box probes the network. [found] is empty when nothing answered.
  Future<void> discover() async {
    if (discovering) return;
    final g = _gateway();
    if (g == null) return;
    discovering = true;
    discoverError = null;
    found = null;
    _notify();
    try {
      found = await g.discoverLiveCameras();
    } on BoxUnreachable {
      discoverError = cameraTestBoxAway(lang);
    } on SessionExpired {
      discoverError = cameraLoadFailed(lang);
    } on BoxError catch (e) {
      discoverError = _isNotFound(e) ? cameraAtSurauOnly(lang) : e.message;
    }
    discovering = false;
    _notify();
  }

  /// Asks the box for the address of [camera] with the typed login and puts it in the form (not saved: `Simpan` does
  /// that). The login then lives only inside the address text, which the box masks once it is saved. Null on success,
  /// else the words to show.
  Future<String?> fillFrom(DiscoveredCamera camera, String user, String pass) async {
    if (filling) return null;
    final g = _gateway();
    if (g == null) return cameraTestBoxAway(lang);
    filling = true;
    fillError = null;
    _notify();
    try {
      final address = await g.fillDiscoveredCamera(ip: camera.ip, username: user, password: pass);
      if (address.isEmpty) {
        fillError = cameraTestOther(lang);
      } else {
        username.clear();
        password.clear();
        changingPassword = false;
        // the field shows the masked address; the full one stays here for `Simpan`
        _filledFull = address;
        _filledMasked = maskCameraUrl(address);
        url.text = _filledMasked!;
      }
    } on BoxUnreachable {
      fillError = cameraTestBoxAway(lang);
    } on SessionExpired {
      fillError = cameraLoadFailed(lang);
    } on BoxError catch (e) {
      fillError = _isNotFound(e) ? cameraAtSurauOnly(lang) : (e.code == 'username_missing' ? cameraUserMissing(lang) : e.message);
    }
    filling = false;
    _notify();
    return fillError;
  }

  /// List-only mode: just the camera's address, to be completed by hand.
  void fillAddressOnly(DiscoveredCamera camera) {
    username.clear();
    password.clear();
    _filledFull = null;
    _filledMasked = null;
    url.text = 'rtsp://${camera.ip}:554/';
    _notify();
  }

  /// "Padam tetapan kamera": the box and the cloud forget the record.
  Future<bool> deleteRecord() async {
    final g = _gateway();
    if (g == null) return false;
    try {
      await g.clearLiveCamera();
      if (_viaCloud()) {
        // the box removes it on its next check; until then the form says so
        final fresh = await g.liveCamera();
        _apply(LiveCameraRecord(configured: false, url: '', username: null, hasPassword: false, lastTest: null, pending: fresh.pending, relay: fresh.relay));
        testPhase = CameraTestPhase.idle;
        testOutcome = null;
        _notify();
        return true;
      }
    } on BoxUnreachable {
      saveError = cameraTestBoxAway(lang);
      _notify();
      return false;
    } on SessionExpired {
      return false;
    } on BoxError catch (e) {
      saveError = _isNotFound(e) ? cameraAtSurauOnly(lang) : e.message;
      _notify();
      return false;
    }
    _apply(LiveCameraRecord.none);
    testPhase = CameraTestPhase.idle;
    testOutcome = null;
    _notify();
    return true;
  }

  @override
  void dispose() {
    _disposed = true;
    _pendingTimer?.cancel();
    url.dispose();
    username.dispose();
    password.dispose();
    passwordFocus.dispose();
    super.dispose();
  }
}

/// `H264` and friends as people write them.
String cameraCodecLabel(String track) => switch (track) {
  'H264' => 'H.264',
  'H265' => 'H.265',
  'MPEG-4 Audio' => 'AAC',
  'G711' => 'G.711',
  _ => track,
};

const TextStyle _smallHint = TextStyle(fontSize: 14);

bool _isAudioTrack(String t) => t == 'MPEG-4 Audio' || t == 'G711' || t.toLowerCase().contains('audio') || t == 'Opus';

String _hostOf(String url) => RegExp(r'^rtsp://(?:[^@/]*@)?([^:/?#]+)').firstMatch(url)?.group(1) ?? '';

/// Name, address, login, audio line, test and the folded Lanjutan: the form of mockups 07 to 16.
class CameraSourceCard extends StatefulWidget {
  const CameraSourceCard({
    super.key,
    required this.controller,
    required this.enabled,
    required this.name,
    required this.transport,
    required this.onChanged,
    this.brightness = 'auto',
    this.readOnly = false,
    this.nameError,
    this.discoveryReady = cameraDiscoveryReady,
    this.discoveryFill = cameraDiscoveryFill,
    this.onDiscover,
  });

  final CameraSourceController controller;

  /// The feature switch (`liveCamera.enabled`).
  final bool enabled;
  final String name;
  final String transport;

  /// `liveCamera.brightness` (B7): `auto`, `normal`, `bright` or `brighter`.
  final String brightness;

  /// Called with `name`, `transport` or `brightness` and the new value, like the settings form's.
  final void Function(String key, Object? value) onChanged;
  final bool readOnly;
  final String? nameError;

  /// The discovery entry point; off, it is not drawn.
  final bool discoveryReady;

  /// Auto-fill after choosing a camera; off is list-only mode.
  final bool discoveryFill;

  /// Replaces the built-in list sheet (tests and callers that run their own).
  final VoidCallback? onDiscover;

  @override
  State<CameraSourceCard> createState() => _CameraSourceCardState();
}

class _CameraSourceCardState extends State<CameraSourceCard> {
  bool _lanjutan = false;
  late final TextEditingController _name = TextEditingController(text: widget.name);

  @override
  void didUpdateWidget(covariant CameraSourceCard old) {
    super.didUpdateWidget(old);
    if (_name.text != widget.name) _name.text = widget.name;
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _discover() async {
    final c = widget.controller;
    unawaited(c.discover());
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _DiscoverySheet(controller: c, fill: widget.discoveryFill),
    );
  }

  Future<void> _delete() async {
    final lang = appLangOf(context);
    final c = widget.controller;
    final ok = await confirmDialog(
      context,
      title: cameraDeleteTitle(lang),
      body: cameraDeleteBody(lang),
      confirm: cameraDeleteConfirm(lang),
    );
    if (!ok || !mounted) return;
    await c.deleteRecord();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final c = widget.controller;
            c.lang = appLangOf(context);
            if (!widget.enabled) return _off(context, c);
            if (c.loading) {
              return const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: LinearProgressIndicator(minHeight: 2),
              );
            }
            if (c.loadError != null) return _loadFailed(context, c);
            return _form(context, c);
          },
        ),
        _brightness(context),
      ],
    );
  }

  /// Lane X: the opt-in for network control of the camera. Off by default; the live screen shows its control row only
  /// while it is on. Drawn on a box connection only (the cloud does not relay it).
  Widget _controlSwitch(BuildContext context, CameraSourceController c, bool ro) {
    final s = sFor(appLangOf(context));
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SwitchListTile(
            key: const ValueKey('camera-control-switch'),
            contentPadding: EdgeInsets.zero,
            title: Text(s.liveCamCtlAllow, style: text.titleSmall),
            subtitle: Text(s.liveCamCtlAllowNote, style: _smallHint.copyWith(color: SurauColors.muted)),
            value: c.record.control.enabled,
            onChanged: ro || c.controlBusy ? null : (v) => c.setControl(v),
          ),
          if (c.record.control.enabled) _profileFields(context, c, ro),
          if (c.controlError != null)
            Text(c.controlError!, key: const ValueKey('camera-control-error'), style: text.bodySmall!.copyWith(color: SurauColors.danger)),
        ],
      ),
    );
  }

  /// The one-tap profile ("Terapkan tetapan kamera"): Kedudukan, Fokus, Jejak automatik, Kecerahan, and whether the box
  /// sends it when a live starts. Each change is saved on the box at once.
  Widget _profileFields(BuildContext context, CameraSourceController c, bool ro) {
    final s = sFor(appLangOf(context));
    final text = Theme.of(context).textTheme;
    final p = c.record.control.profile;
    final off = ro || c.controlBusy;
    Widget seg<T>(String key, T value, Map<T, String> labels, void Function(T) pick) => SizedBox(
      width: double.infinity,
      child: SegmentedButton<T>(
        key: ValueKey(key),
        showSelectedIcon: false,
        segments: [for (final e in labels.entries) ButtonSegment<T>(value: e.key, label: FittedBox(fit: BoxFit.scaleDown, child: Text(e.value, maxLines: 1)))],
        selected: {value},
        onSelectionChanged: off ? null : (v) => pick(v.first),
      ),
    );
    Widget title(String t) => Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 6),
      child: Text(t, style: text.titleSmall),
    );
    final ev = p.exposureEv;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      key: const ValueKey('camera-profile'),
      children: [
        title(s.liveCamCtlPosition),
        seg<int>('camera-profile-preset', p.preset, {1: '1', 2: '2', 3: '3'}, (v) => c.setProfile(p.copyWith(preset: v))),
        title(s.liveCamCtlFocus),
        seg<String>(
          'camera-profile-focus',
          p.focus,
          {'continuous': s.liveCamCtlFocusContinuous, 'single': s.liveCamCtlFocusSingle, 'manual': s.liveCamCtlFocusManual},
          (v) => c.setProfile(p.copyWith(focus: v)),
        ),
        title(s.liveCamCtlTracking),
        seg<String>(
          'camera-profile-tracking',
          p.tracking,
          {'off': s.liveCamCtlTrackingOff, 'human': s.liveCamCtlTrackingHuman},
          (v) => c.setProfile(p.copyWith(tracking: v)),
        ),
        title(s.liveCamCtlBrightness),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            IconButton.outlined(
              key: const ValueKey('camera-profile-darker'),
              tooltip: s.liveCamCtlBrightnessDown,
              onPressed: off || ev <= -3 ? null : () => c.setProfile(p.copyWith(exposureEv: ev - 0.5)),
              icon: const Icon(Icons.remove_rounded),
            ),
            SizedBox(
              width: 72,
              child: Text(
                '${ev > 0 ? '+' : ''}${ev.toStringAsFixed(1)}',
                key: const ValueKey('camera-profile-ev'),
                textAlign: TextAlign.center,
                style: text.titleMedium,
              ),
            ),
            IconButton.outlined(
              key: const ValueKey('camera-profile-brighter'),
              tooltip: s.liveCamCtlBrightnessUp,
              onPressed: off || ev >= 3 ? null : () => c.setProfile(p.copyWith(exposureEv: ev + 0.5)),
              icon: const Icon(Icons.add_rounded),
            ),
          ],
        ),
        SwitchListTile(
          key: const ValueKey('camera-profile-on-live'),
          contentPadding: EdgeInsets.zero,
          title: Text(s.liveCamCtlApplyOnLive, style: text.titleSmall),
          value: c.record.control.applyOnLive,
          onChanged: off ? null : (v) => c.setApplyOnLive(v),
        ),
      ],
    );
  }

  // Mockup 09: switched off, the record kept.
  Widget _off(BuildContext context, CameraSourceController c) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final kept = !c.loading && c.record.configured;
    final name = widget.name.trim().isEmpty ? cameraUseTitle(lang) : widget.name.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Card(
          key: const ValueKey('camera-off-note'),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
            child: Text(
              kept ? cameraOffNoteKept(lang, name) : cameraOffNoteNew(lang),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        ),
        if (kept && !widget.readOnly)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Center(
              child: TextButton.icon(
                key: const ValueKey('camera-delete'),
                onPressed: _delete,
                icon: const Icon(Icons.delete_outline_rounded),
                label: Text(cameraDelete(lang)),
                style: TextButton.styleFrom(foregroundColor: SurauColors.danger, minimumSize: const Size(48, 48)),
              ),
            ),
          ),
        if (c.saveError != null) Padding(padding: const EdgeInsets.only(top: 12), child: _Line(c.saveError!, bad: true)),
      ],
    );
  }

  Widget _loadFailed(BuildContext context, CameraSourceController c) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(c.loadError!, key: const ValueKey('camera-load-error'), style: text.bodyLarge),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const ValueKey('camera-load-retry'),
              onPressed: c.load,
              icon: const Icon(Icons.refresh_rounded),
              label: Text(cameraRetry(lang)),
            ),
          ],
        ),
      ),
    );
  }

  /// B7: the picture brightness of every live (the phone's own camera and the external one), shown whether or not an
  /// external camera is set up.
  Widget _brightness(BuildContext context) {
    final lang = appLangOf(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Card(
        key: const ValueKey('camera-brightness-card'),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: ChoiceField(
            path: 'brightness',
            name: 'brightness',
            label: settingLabel('brightness', lang),
            value: widget.brightness,
            choices: const ['auto', 'normal', 'bright', 'brighter'],
            help: cameraBrightnessHelp(lang),
            readOnly: widget.readOnly,
            onChanged: (v) => widget.onChanged('brightness', v),
          ),
        ),
      ),
    );
  }

  Widget _section(List<Widget> children) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
  );

  Widget _form(BuildContext context, CameraSourceController c) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final ro = widget.readOnly;
    TextStyle help() => text.bodySmall!.copyWith(color: SurauColors.muted);
    final transportLabel = choiceLabel('transport', widget.transport, appLangOf(context));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Card(
          key: const ValueKey('camera-card'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _section([
                Text(cameraNameLabel(lang), style: text.titleSmall),
                const SizedBox(height: 8),
                TextField(
                  key: const ValueKey('camera-name'),
                  controller: _name,
                  enabled: !ro,
                  maxLength: 60,
                  onChanged: (v) => widget.onChanged('name', v),
                  decoration: InputDecoration(
                    hintText: cameraNameHint(lang),
                    counterText: '',
                    errorText: widget.nameError,
                  ),
                ),
                const SizedBox(height: 6),
                Text(cameraNameHelp(lang), style: help()),
              ]),
              const Divider(),
              _section([
                Text(cameraKindLabel(lang), style: text.titleSmall),
                const SizedBox(height: 8),
                const _KindRow(),
                const SizedBox(height: 6),
                Text(cameraKindHelp(lang), style: help()),
              ]),
              const Divider(),
              _section([
                Text(cameraUrlLabel(lang), style: text.titleSmall),
                const SizedBox(height: 8),
                TextField(
                  key: const ValueKey('camera-url'),
                  controller: c.url,
                  enabled: !ro,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  enableSuggestions: false,
                  textCapitalization: TextCapitalization.none,
                  style: const TextStyle(fontSize: 14.5),
                  inputFormatters: [LengthLimitingTextInputFormatter(cameraUrlMax)],
                  decoration: InputDecoration(hintText: cameraUrlHint(lang), errorText: c.urlError ?? c.urlLiveError, errorMaxLines: 3),
                ),
                const SizedBox(height: 6),
                Text(cameraUrlHelp(lang), style: help()),
                if (c.viaCloud) ...[
                  const SizedBox(height: 10),
                  Text(cameraDiscoverSurauOnly(lang), key: const ValueKey('camera-discover-surau-only'), style: help()),
                ] else if (widget.discoveryReady && !ro) ...[
                  const SizedBox(height: 10),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: OutlinedButton.icon(
                      key: const ValueKey('camera-discover'),
                      onPressed: widget.onDiscover ?? _discover,
                      icon: const Icon(Icons.search_rounded),
                      label: Text(cameraDiscover(lang)),
                    ),
                  ),
                ],
              ]),
              const Divider(),
              _section([
                _OptionalLabel(cameraUserLabel(lang), text),
                const SizedBox(height: 8),
                TextField(
                  key: const ValueKey('camera-username'),
                  controller: c.username,
                  enabled: !ro,
                  autocorrect: false,
                  enableSuggestions: false,
                  autofillHints: const [],
                  decoration: InputDecoration(hintText: cameraLoginHint(lang), hintStyle: _smallHint, errorText: c.loginError, errorMaxLines: 3),
                ),
              ]),
              const Divider(),
              _section([_OptionalLabel(cameraPassLabel(lang), text), const SizedBox(height: 8), _passwordPart(context, c, ro)]),
              const Divider(),
              _section([
                Text(cameraAudioLabel(lang), style: text.titleSmall),
                const SizedBox(height: 8),
                _AudioLine(controller: c),
                const SizedBox(height: 6),
                Text(cameraAudioHelp(lang), style: help()),
              ]),
              const Divider(),
              _section(
                c.viaCloud
                    ? [Text(cameraTestSurauOnly(lang), key: const ValueKey('camera-test-surau-only'), style: help())]
                    : [
                        OutlinedButton.icon(
                          key: const ValueKey('camera-test'),
                          onPressed: ro || c.testPhase == CameraTestPhase.running ? null : () => c.runTest(widget.transport),
                          icon: const Icon(Icons.refresh_rounded),
                          label: Text(cameraTest(lang)),
                          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                        ),
                        const SizedBox(height: 10),
                        _TestResult(controller: c, help: help()),
                      ],
              ),
              if (!c.viaCloud && c.record.configured) ...[
                const Divider(),
                _controlSwitch(context, c, ro),
              ],
              const Divider(),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    InkWell(
                      key: const ValueKey('camera-lanjutan'),
                      onTap: () => setState(() => _lanjutan = !_lanjutan),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 52),
                        child: Row(
                          children: [
                            Text(cameraLanjutan(lang), style: text.titleSmall),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                cameraLanjutanSummary(lang, transportLabel),
                                style: help(),
                                textAlign: TextAlign.end,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Icon(_lanjutan ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: SurauColors.muted),
                          ],
                        ),
                      ),
                    ),
                    if (_lanjutan)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: ChoiceField(
                          path: 'transport',
                          name: 'transport',
                          label: settingLabel('transport', appLangOf(context)),
                          value: widget.transport,
                          choices: const ['auto', 'tcp', 'udp'],
                          help: cameraTransportHelp(lang),
                          readOnly: ro,
                          onChanged: (v) => widget.onChanged('transport', v),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (c.record.pending)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _Line(cameraCloudPending(lang), bad: false, key: const ValueKey('camera-pending')),
          )
        else if (c.record.failure != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _Line(cameraCloudRefused(lang, c.record.failure), bad: true, key: const ValueKey('camera-cloud-refused')),
          ),
        if (c.saveError != null) Padding(padding: const EdgeInsets.only(top: 12), child: _Line(c.saveError!, bad: true)),
        const SizedBox(height: 16),
        _Line(cameraNetworkNotice(lang), bad: false),
        const SizedBox(height: 16),
      ],
    );
  }

  Widget _passwordPart(BuildContext context, CameraSourceController c, bool ro) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final helpStyle = text.bodySmall!.copyWith(color: SurauColors.muted);
    if (!c.passwordBoxOpen) {
      // Saved: dots and a way to replace it. The password itself is never here.
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Container(
                  key: const ValueKey('camera-password-dots'),
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  decoration: BoxDecoration(
                    color: SurauColors.paperDeep,
                    borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                  ),
                  child: Semantics(
                    label: cameraPassKept(lang),
                    child: ExcludeSemantics(child: Text('•' * 8, style: text.titleMedium)),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              OutlinedButton(
                key: const ValueKey('camera-password-change'),
                onPressed: ro ? null : c.startChangingPassword,
                child: Text(cameraPassChange(lang)),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(cameraPassHelpKept(lang), style: helpStyle),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (c.passwordNeeded && !c.changingPassword) ...[
          _Line(cameraPassNeeded(lang), bad: true, key: const ValueKey('camera-password-needed')),
          const SizedBox(height: 8),
        ],
        TextField(
          key: const ValueKey('camera-password'),
          controller: c.password,
          focusNode: c.passwordFocus,
          autofocus: c.passwordNeeded && !ro,
          enabled: !ro,
          obscureText: !c.showPassword,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [],
          decoration: InputDecoration(
            hintText: cameraLoginHint(lang),
            hintStyle: _smallHint,
            errorText: c.passwordError,
            suffixIcon: IconButton(
              key: const ValueKey('camera-password-toggle'),
              tooltip: c.showPassword ? cameraPassHide(lang) : cameraPassShow(lang),
              onPressed: c.toggleShowPassword,
              icon: Icon(c.showPassword ? Icons.visibility_off_rounded : Icons.visibility_rounded),
            ),
          ),
        ),
        const SizedBox(height: 6),
        if (c.changingPassword) ...[
          Text(cameraPassHelpChanging(lang), style: helpStyle),
          TextButton(
            key: const ValueKey('camera-password-cancel'),
            onPressed: c.cancelChangingPassword,
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            child: Text(cameraPassCancel(lang)),
          ),
        ] else if (c.passwordNeeded)
          Text(cameraPassNeededHelp(lang), style: helpStyle)
        else
          Text(cameraPassHelpNew(lang), style: helpStyle),
      ],
    );
  }
}

/// The sheet of "Cari kamera di rangkaian": the list (name + IP), the empty state with advice, then the login of the
/// chosen camera. It closes itself once the address is filled in.
class _DiscoverySheet extends StatefulWidget {
  const _DiscoverySheet({required this.controller, required this.fill});

  final CameraSourceController controller;
  final bool fill;

  @override
  State<_DiscoverySheet> createState() => _DiscoverySheetState();
}

class _DiscoverySheetState extends State<_DiscoverySheet> {
  DiscoveredCamera? _picked;
  final TextEditingController _user = TextEditingController();
  final TextEditingController _pass = TextEditingController();
  bool _show = false;

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  void _pick(DiscoveredCamera cam) {
    if (!widget.fill) {
      widget.controller.fillAddressOnly(cam);
      Navigator.of(context).pop();
      return;
    }
    widget.controller.fillError = null;
    setState(() => _picked = cam);
  }

  Future<void> _submit() async {
    final cam = _picked;
    if (cam == null) return;
    final err = await widget.controller.fillFrom(cam, _user.text.trim(), _pass.text);
    // The password box is emptied whatever the answer: the login is not kept here.
    _pass.clear();
    if (err == null && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.of(context).viewInsets.bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 16 + pad),
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) => SingleChildScrollView(
            child: _picked == null ? _list(context) : _login(context, _picked!),
          ),
        ),
      ),
    );
  }

  Widget _list(BuildContext context) {
    final lang = appLangOf(context);
    final c = widget.controller;
    final text = Theme.of(context).textTheme;
    final help = text.bodySmall!.copyWith(color: SurauColors.muted);
    final list = c.found;
    return Column(
      key: const ValueKey('camera-discover-sheet'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(cameraDiscoverTitle(lang), style: text.titleMedium),
        const SizedBox(height: 12),
        if (c.discovering) ...[
          const LinearProgressIndicator(minHeight: 2),
          const SizedBox(height: 10),
          Text(cameraDiscoverSearching(lang), key: const ValueKey('camera-discover-searching'), style: help),
        ] else if (c.discoverError != null)
          _Line(c.discoverError!, bad: true)
        else if (list != null && list.isEmpty) ...[
          Text(cameraDiscoverNone(lang), key: const ValueKey('camera-discover-empty'), style: text.titleSmall),
          const SizedBox(height: 6),
          Text(cameraDiscoverNoneHelp(lang), style: help),
        ] else if (list != null) ...[
          Text(cameraDiscoverHelp(lang), style: help),
          const SizedBox(height: 8),
          for (final cam in list)
            ListTile(
              key: ValueKey('camera-discover-item-${cam.ip}'),
              contentPadding: EdgeInsets.zero,
              minVerticalPadding: 8,
              leading: const Icon(Icons.videocam_outlined),
              title: Text(cam.name.isEmpty ? cameraDiscoverNoName(lang) : cam.name),
              subtitle: Text(cam.ip),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _pick(cam),
            ),
        ],
        const SizedBox(height: 12),
        Row(
          children: [
            OutlinedButton(
              key: const ValueKey('camera-discover-again'),
              onPressed: c.discovering ? null : c.discover,
              child: Text(cameraDiscoverAgain(lang)),
            ),
            const Spacer(),
            TextButton(
              key: const ValueKey('camera-discover-close'),
              onPressed: () => Navigator.of(context).pop(),
              child: Text(cameraDiscoverClose(lang)),
            ),
          ],
        ),
      ],
    );
  }

  Widget _login(BuildContext context, DiscoveredCamera cam) {
    final lang = appLangOf(context);
    final c = widget.controller;
    final text = Theme.of(context).textTheme;
    final help = text.bodySmall!.copyWith(color: SurauColors.muted);
    return Column(
      key: const ValueKey('camera-login-sheet'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(cameraLoginTitle(lang), style: text.titleMedium),
        const SizedBox(height: 4),
        Text('${cam.name.isEmpty ? cameraDiscoverNoName(lang) : cam.name} · ${cam.ip}', style: help),
        const SizedBox(height: 12),
        Text(cameraLoginHelp(lang), style: help),
        const SizedBox(height: 12),
        Text(cameraUserLabel(lang), style: text.titleSmall),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('camera-login-user'),
          controller: _user,
          enabled: !c.filling,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [],
        ),
        const SizedBox(height: 12),
        Text(cameraPassLabel(lang), style: text.titleSmall),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('camera-login-pass'),
          controller: _pass,
          enabled: !c.filling,
          obscureText: !_show,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [],
          decoration: InputDecoration(
            suffixIcon: IconButton(
              key: const ValueKey('camera-login-toggle'),
              tooltip: _show ? cameraPassHide(lang) : cameraPassShow(lang),
              onPressed: () => setState(() => _show = !_show),
              icon: Icon(_show ? Icons.visibility_off_rounded : Icons.visibility_rounded),
            ),
          ),
        ),
        if (c.fillError != null) ...[
          const SizedBox(height: 12),
          Container(key: const ValueKey('camera-login-error'), child: _Line(c.fillError!, bad: true)),
        ],
        if (c.filling) ...[
          const SizedBox(height: 12),
          const LinearProgressIndicator(minHeight: 2),
          const SizedBox(height: 6),
          Text(cameraLoginFilling(lang), style: help),
        ],
        const SizedBox(height: 16),
        Row(
          children: [
            TextButton(
              key: const ValueKey('camera-login-back'),
              onPressed: c.filling ? null : () => setState(() => _picked = null),
              child: Text(cameraLoginBack(lang)),
            ),
            const Spacer(),
            FilledButton(
              key: const ValueKey('camera-login-fill'),
              onPressed: c.filling ? null : _submit,
              child: Text(cameraLoginFill(lang)),
            ),
          ],
        ),
      ],
    );
  }
}

/// A field name with "pilihan" beside it.
class _OptionalLabel extends StatelessWidget {
  const _OptionalLabel(this.label, this.text);

  final String label;
  final TextTheme text;

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(
      children: [
        TextSpan(text: label, style: text.titleSmall),
        const TextSpan(text: '  '),
        TextSpan(text: cameraOptional(appLangOf(context)), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
      ],
    ),
  );
}

/// RTSP chosen; SRT, NDI and RTMP shown greyed "Akan datang" (display only, nothing stored).
class _KindRow extends StatelessWidget {
  const _KindRow();

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    Widget cell(String name, {required bool on}) => Expanded(
      child: Container(
        key: ValueKey('camera-kind-${name.toLowerCase()}'),
        height: 56,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? SurauColors.tealSoft : SurauColors.paper,
          border: Border.all(color: SurauColors.line),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              name,
              style: text.labelLarge!.copyWith(color: on ? SurauColors.glass : SurauColors.outline),
            ),
            if (!on)
              Text(
                cameraKindSoon(lang),
                style: text.labelSmall!.copyWith(color: SurauColors.outline, fontSize: 10),
                maxLines: 1,
                overflow: TextOverflow.clip,
              ),
          ],
        ),
      ),
    );
    return Semantics(
      container: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        child: Row(children: [cell('RTSP', on: true), cell('SRT', on: false), cell('NDI', on: false), cell('RTMP', on: false)]),
      ),
    );
  }
}

/// "Ada, AAC", "Kamera ini tiada audio" or "Belum diketahui..." from the last test.
class _AudioLine extends StatelessWidget {
  const _AudioLine({required this.controller});

  final CameraSourceController controller;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final text = Theme.of(context).textTheme;
    final has = controller.hasAudio;
    final String label;
    final Color colour;
    if (has == null) {
      label = cameraAudioUnknown(lang);
      colour = SurauColors.muted;
    } else if (has) {
      final audio = controller.codecs.where(_isAudioTrack).map(cameraCodecLabel).join(', ');
      label = cameraAudioHas(lang, audio);
      colour = SurauColors.teal;
    } else {
      label = cameraAudioNone(lang);
      colour = SurauColors.muted;
    }
    return Row(
      key: const ValueKey('camera-audio-line'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsetsDirectional.only(top: 6, end: 8),
          child: Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: has == true ? SurauColors.teal : null,
              border: has == true ? null : Border.all(color: SurauColors.outline, width: 1.5),
              shape: BoxShape.circle,
            ),
          ),
        ),
        Expanded(child: Text(label, style: text.titleMedium!.copyWith(color: colour, fontSize: 15.5))),
      ],
    );
  }
}

/// The idle help, the running line, the success box with chips, or one failure message.
class _TestResult extends StatelessWidget {
  const _TestResult({required this.controller, required this.help});

  final CameraSourceController controller;
  final TextStyle help;

  @override
  Widget build(BuildContext context) {
    final lang = appLangOf(context);
    final c = controller;
    final text = Theme.of(context).textTheme;
    final host = _hostOf(c.url.text.trim());
    switch (c.testPhase) {
      case CameraTestPhase.idle:
        return Text(cameraTestHelp(lang), style: help);
      case CameraTestPhase.running:
        return _Result(
          keyName: 'camera-test-running',
          background: SurauColors.paperDeep,
          icon: const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 3)),
          heading: cameraTestRunning(lang),
          detail: cameraTestRunningDetail(lang, host),
        );
      case CameraTestPhase.failed:
        return _Result(
          keyName: 'camera-test-failed',
          background: SurauColors.dangerSoft,
          icon: const Icon(Icons.error_rounded, color: SurauColors.danger, size: 22),
          heading: cameraTestOther(lang),
          detail: c.testMessage ?? '',
        );
      case CameraTestPhase.done:
        final out = c.testOutcome!;
        if (out.ok) {
          final video = out.codecs.where((t) => !_isAudioTrack(t)).map(cameraCodecLabel).toList();
          final audio = out.codecs.where(_isAudioTrack).map(cameraCodecLabel).toList();
          final chips = <String>[
            ...video,
            if (out.hasAudio == true) cameraChipAudio(lang, audio.isEmpty ? '' : audio.join(', ')).trim(),
            if (out.hasAudio == false) cameraChipNoAudio(lang),
            if (out.transport != null) cameraChipTransport(lang, out.transport!.toUpperCase()),
          ];
          return _Result(
            keyName: 'camera-test-ok',
            background: SurauColors.tealSoft,
            icon: const Icon(Icons.check_circle_rounded, color: SurauColors.teal, size: 22),
            heading: cameraTestOk(lang),
            chips: chips,
          );
        }
        final (heading, detail) = switch (out.code) {
          'unreachable' => (cameraTestUnreachable(lang), cameraTestUnreachableDetail(lang, host)),
          'login' => (cameraTestLogin(lang), cameraTestLoginDetail(lang)),
          'path' => (cameraTestPath(lang), cameraTestPathDetail(lang)),
          'codec' => (cameraTestCodec(lang), cameraTestCodecDetail(lang)),
          'bad_address' => (cameraTestOther(lang), cameraReasonText(sFor(lang), out.reason) ?? sFor(lang).errcBadAddress),
          // busy, not_configured, unavailable: the box's own fixed wording
          _ => (cameraTestOther(lang), out.message ?? ''),
        };
        return _Result(
          keyName: 'camera-test-${out.code}',
          background: SurauColors.dangerSoft,
          icon: const Icon(Icons.error_rounded, color: SurauColors.danger, size: 22),
          heading: heading,
          detail: detail,
          detailStyle: text.bodyMedium,
        );
    }
  }
}

class _Result extends StatelessWidget {
  const _Result({
    required this.keyName,
    required this.background,
    required this.icon,
    required this.heading,
    this.detail,
    this.detailStyle,
    this.chips = const [],
  });

  final String keyName;
  final Color background;
  final Widget icon;
  final String heading;
  final String? detail;
  final TextStyle? detailStyle;
  final List<String> chips;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      key: ValueKey(keyName),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(SurauTheme.radiusControl)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: const EdgeInsets.only(top: 2), child: icon),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(heading, style: text.titleSmall),
                if (detail != null && detail!.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(detail!, style: detailStyle ?? text.bodyMedium),
                ],
                if (chips.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final chip in chips)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                          decoration: BoxDecoration(
                            color: SurauColors.card,
                            borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                          ),
                          child: Text(chip, style: text.labelMedium),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A line under the card: the network notice (info) or a refusal (bad).
class _Line extends StatelessWidget {
  const _Line(this.message, {super.key, required this.bad});

  final String message;
  final bool bad;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: bad ? SurauColors.dangerSoft : SurauColors.tealSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(bad ? Icons.error_outline_rounded : Icons.info_outline_rounded, size: 20, color: bad ? SurauColors.danger : SurauColors.teal),
          const SizedBox(width: 10),
          Expanded(child: Text(message, style: text.bodyMedium!.copyWith(color: bad ? SurauColors.dangerInk : SurauColors.glass))),
        ],
      ),
    );
  }
}
