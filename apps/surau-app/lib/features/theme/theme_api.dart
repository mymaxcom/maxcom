// What the theme file screens ask of the box: check a .maxtheme, install it,
// delete an uploaded theme, download a theme as a file, and which contract
// each box of the surau supports. One small class over the gateway so the
// screens are tested without a network.

import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../prayer/file_pick.dart';
import '../shell/box_gateway.dart';

/// The content type of a theme file (the same string the box and the share channel use).
const String packMime = 'application/vnd.maxcom.theme+zip';

/// The largest theme file (the box refuses a bigger one).
const int packMaxBytes = 15 * 1024 * 1024;

/// One thing wrong (or worth a warning) with a theme file, in both languages.
class ThemeIssue {
  const ThemeIssue({required this.code, this.file, this.line, required this.messageMs, required this.messageEn});

  factory ThemeIssue.fromJson(Map<String, dynamic> j) => ThemeIssue(
    code: j['code'] is String ? j['code'] as String : '',
    file: j['file'] is String ? j['file'] as String : null,
    line: (j['line'] as num?)?.toInt(),
    messageMs: j['messageMs'] is String ? j['messageMs'] as String : '',
    messageEn: j['messageEn'] is String ? j['messageEn'] as String : '',
  );

  final String code;
  final String? file;
  final int? line;
  final String messageMs;
  final String messageEn;

  String text(bool ms) => ms ? messageMs : messageEn;
}

/// The box's report on a theme file (`POST /api/themes/check`).
class PackReport {
  const PackReport({
    required this.ok,
    this.name,
    this.title,
    this.base,
    this.version,
    this.contract,
    this.installedVersion,
    this.fileCount = 0,
    this.bytes = 0,
    this.screens = const [],
    this.fonts = const [],
    this.images = const {},
    this.defaults = const {},
    this.isUpdate = false,
    this.errors = const [],
    this.warnings = const [],
  });

  factory PackReport.fromJson(Map<String, dynamic> j) {
    List<ThemeIssue> issues(Object? v) => [
      for (final e in (v is List ? v : const []))
        if (e is Map<String, dynamic>) ThemeIssue.fromJson(e),
    ];
    List<String> strings(Object? v) => [
      for (final e in (v is List ? v : const []))
        if (e is String) e,
    ];
    return PackReport(
      ok: j['ok'] == true,
      name: j['name'] is String ? j['name'] as String : null,
      title: j['title'] is String ? j['title'] as String : null,
      base: j['base'] is String ? j['base'] as String : null,
      version: (j['version'] as num?)?.toInt(),
      contract: (j['contract'] as num?)?.toInt(),
      installedVersion: (j['installedVersion'] as num?)?.toInt(),
      fileCount: (j['fileCount'] as num?)?.toInt() ?? 0,
      bytes: (j['bytes'] as num?)?.toInt() ?? 0,
      screens: strings(j['screens']),
      fonts: strings(j['fonts']),
      images: j['images'] is Map ? (j['images'] as Map).map((k, v) => MapEntry('$k', '$v')) : const {},
      defaults: j['defaults'] is Map<String, dynamic> ? j['defaults'] as Map<String, dynamic> : const {},
      isUpdate: j['isUpdate'] == true,
      errors: issues(j['errors']),
      warnings: issues(j['warnings']),
    );
  }

  final bool ok;
  final String? name;
  final String? title;
  final String? base;
  final int? version;
  final int? contract;
  final int? installedVersion;
  final int fileCount;
  final int bytes;
  final List<String> screens;
  final List<String> fonts;
  final Map<String, String> images;
  final Map<String, dynamic> defaults;
  final bool isUpdate;
  final List<ThemeIssue> errors;
  final List<ThemeIssue> warnings;

  /// What the kiosk preview needs to wear the file before it is installed.
  Map<String, Object?> get previewPack => {'base': base, 'version': version, 'images': images, 'defaults': defaults};
}

/// One box of the surau and the theme contract it reported.
class SupportBox {
  const SupportBox({required this.boxId, required this.name, required this.contract, required this.builtIn});

  final String boxId;
  final String name;
  final int? contract;
  final List<String> builtIn;
}

/// `GET /api/themes/support`: which contract each box supports.
class ThemeSupportFull {
  const ThemeSupportFull({required this.contract, required this.builtIn, required this.boxes, required this.complete});

  factory ThemeSupportFull.fromJson(Map<String, dynamic> j) => ThemeSupportFull(
    contract: (j['contract'] as num?)?.toInt() ?? 0,
    builtIn: [
      for (final b in (j['builtIn'] is List ? j['builtIn'] as List : const []))
        if (b is String) b,
    ],
    boxes: [
      for (final b in (j['boxes'] is List ? j['boxes'] as List : const []))
        if (b is Map)
          SupportBox(
            boxId: '${b['boxId']}',
            name: b['name'] is String ? b['name'] as String : '',
            contract: (b['contract'] as num?)?.toInt(),
            builtIn: [
              for (final x in (b['builtIn'] is List ? b['builtIn'] as List : const []))
                if (x is String) x,
            ],
          ),
    ],
    complete: j['complete'] == true,
  );

  final int contract;
  final List<String> builtIn;
  final List<SupportBox> boxes;
  final bool complete;
}

/// True only when the list is complete and every box has [contract] (and lists [builtIn] when given). The same
/// truth table as `themeOfferable` in packages/core.
bool themeOfferable(ThemeSupportFull s, {required int contract, String? builtIn}) {
  if (!s.complete) return false;
  return s.boxes.every((b) => b.contract != null && b.contract! >= contract && (builtIn == null || b.builtIn.contains(builtIn)));
}

class ThemeApi {
  ThemeApi(this.gateway);

  final BoxGateway gateway;

  /// Sends the file to the box to be checked. A refused file is still an answer (`report.ok` false).
  Future<({PackReport report, String? stagedId})> check(Uint8List bytes) async {
    final r = await gateway.postRaw('/api/themes/check', bytes, packMime);
    final rep = r['report'];
    return (
      report: PackReport.fromJson(rep is Map<String, dynamic> ? rep : const {}),
      stagedId: r['stagedId'] is String ? r['stagedId'] as String : null,
    );
  }

  Future<({String name, int version, String title})> install(String stagedId) async {
    final r = await gateway.post('/api/themes/install', {'stagedId': stagedId});
    return (name: '${r['name']}', version: (r['version'] as num?)?.toInt() ?? 0, title: '${r['title']}');
  }

  Future<void> remove(String name) => gateway.delete('/api/themes/$name');

  /// The theme as a .maxtheme: [bake] puts the surau's menu values in; [as] names a built-in's copy.
  Future<Uint8List> download(String name, {required bool bake, String? as}) {
    final q = ['bake=${bake ? 1 : 0}', if (as != null) 'as=${Uri.encodeQueryComponent(as)}'].join('&');
    return gateway.getBytes('/api/themes/$name/pack?$q');
  }

  Future<ThemeSupportFull> support() async => ThemeSupportFull.fromJson(await gateway.getFresh('/api/themes/support'));
}

/// Null until the app is unlocked.
final themeApiProvider = Provider<ThemeApi?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  return gateway == null ? null : ThemeApi(gateway);
});

/// Which boxes support which contract; null when it cannot be read now.
final themeSupportFullProvider = FutureProvider<ThemeSupportFull?>((ref) async {
  final api = ref.watch(themeApiProvider);
  if (api == null) return null;
  try {
    return await api.support();
  } on Object {
    return null;
  }
});

/// What the person picked in the file picker.
class ThemeFileResult {
  const ThemeFileResult.file(String this.name, Uint8List this.bytes) : tooBig = false, wrongType = false, unreadable = false;
  const ThemeFileResult.tooBig() : name = null, bytes = null, tooBig = true, wrongType = false, unreadable = false;
  const ThemeFileResult.wrongType() : name = null, bytes = null, tooBig = false, wrongType = true, unreadable = false;
  const ThemeFileResult.unreadable() : name = null, bytes = null, tooBig = false, wrongType = false, unreadable = true;

  final String? name;
  final Uint8List? bytes;
  final bool tooBig;
  final bool wrongType;
  final bool unreadable;
}

/// Null when the person backs out.
typedef ThemeFilePicker = Future<ThemeFileResult?> Function();

bool get themeFilePickSupported => filePickSupported;

/// The real pick: Android's document picker or the browser's file input; the name must end with `.maxtheme`.
Future<ThemeFileResult?> pickThemeFile() async {
  final PickedFile? f;
  try {
    f = await pickFile(extensions: const ['maxtheme'], maxBytes: packMaxBytes, mustEndWith: '.maxtheme');
  } on Object {
    return const ThemeFileResult.unreadable();
  }
  if (f == null) return null;
  if (f.wrongType || !f.name.toLowerCase().endsWith('.maxtheme')) return const ThemeFileResult.wrongType();
  if (f.tooBig || f.bytes.length > packMaxBytes) return const ThemeFileResult.tooBig();
  if (f.bytes.isEmpty) return const ThemeFileResult.unreadable();
  return ThemeFileResult.file(f.name, f.bytes);
}

/// Tests replace the pick.
final themeFilePickerProvider = Provider<ThemeFilePicker>((ref) => pickThemeFile);
