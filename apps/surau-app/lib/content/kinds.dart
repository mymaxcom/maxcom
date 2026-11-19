// The 14 content kinds as the editors see them: one `ContentKindSpec` per
// kind (BM labels, icon, the fields in the order the form shows them) and
// the Dart twin of core's `validateContent`
// (`packages/core/src/content/schema.ts`). The generated
// `test/fixtures/content-cases.json` (answers computed by core itself)
// proves both say yes and no on the same items. Messages are Bahasa
// Malaysia for the form; every error carries the field key.

import 'dart:math';

import 'package:flutter/material.dart';

import '../app/app_lang.dart' show AppLang;
import '../features/labels.dart'
    show contentChoiceLabel, contentFieldHint, contentFieldLabel, contentKindLabel, dayLabel, dayPartWord, monthWord, weekdayWord;
import '../features/labels_content.dart' show dayLabelsMs, monthWordsMs, slotLabelsMs, weekdayWordsMs;
import '../features/validate.dart' show SettingError, ValidationResult, imageRefError;
import '../l10n/generated/s.dart';
import '../l10n/s_lookup.dart';
import 'video_rules.dart' show videoCrossErrors;

export '../features/labels_content.dart' show dayLabelsMs;

/// sha256 of core content/schema.ts + content/types.ts (CRLF as LF) this
/// port was written against; kinds_test fails when core moved on.
const String contentSourceHash =
    '1e51c9e566ee1e47240b90745b0d8a727608cf45e5042795b49040b281d19391';

enum FieldType {
  text,
  multiline,
  date,
  time,
  dateTime,
  int,
  enumOf,
  ref,
  days,
  asset,
  bool,
  priority,
  status,
  timezone,
}

enum AssetKind { image, audio }

const int maxContentText = 2000;
const int maxTickerText = 300;

/// The seven day keys, as core's DAY_KEYS.
const List<String> dayKeys = [
  'ahad',
  'isnin',
  'selasa',
  'rabu',
  'khamis',
  'jumaat',
  'sabtu',
];

const Map<String, String> _statusLabels = {'aktif': 'Aktif', 'batal': 'Dibatalkan'};

const Map<String, String> _roleLabels = {
  'imam': 'Imam',
  'bilal': 'Bilal',
  'khatib': 'Khatib',
  'ajk': 'AJK bertugas',
};

const Map<String, String> _priorityLabels = {'1': 'Biasa', '2': 'Penting', '3': 'Segera'};

/// One field of a content kind: what the form draws and what the
/// validator checks.
class FieldSpec {
  const FieldSpec({
    required this.key,
    required this.type,
    required this.labelMs,
    this.required = true,
    this.choices = const [],
    this.choiceLabels = const {},
    this.refKind,
    this.allowDaily = false,
    this.min = 0,
    this.max = 0,
    this.maxLength = maxContentText,
    this.assetKind = AssetKind.image,
    this.hintMs,
    this.hidden = false,
    this.omitWhen,
  });

  final String key;
  final FieldType type;
  final String labelMs;
  final bool required;

  /// `enumOf`, `status`: the accepted values in display order.
  final List<String> choices;
  final Map<String, String> choiceLabels;

  /// `ref`: the kind whose items are offered.
  final String? refKind;

  /// `days`: whether `daily` is accepted beside `umum` and the seven days.
  final bool allowDaily;

  /// `int`, `priority`: inclusive bounds.
  final int min;
  final int max;

  /// `text`, `multiline`: the core maximum after trimming.
  final int maxLength;
  final AssetKind assetKind;
  final String? hintMs;

  /// Validated and sent back as it was, but not drawn in the form (a stored
  /// field nothing uses any more, such as a kuliah's `seriesId`).
  final bool hidden;

  /// A value that is not sent at all (the box reads an absent field as this value). A poster's `stretch` is sent only
  /// when it is `false`, so a box older than 2026.11.13 (which refuses the field) still saves the poster.
  final Object? omitWhen;

  String choiceLabelMs(String value) => choiceLabels[value] ?? value;
}
class ContentKindSpec {
  const ContentKindSpec({
    required this.key,
    required this.labelMs,
    required this.labelMsPlural,
    required this.icon,
    required this.fields,
    this.carried = const [],
  });

  final String key;

  /// One item ("Kuliah", "Penceramah").
  final String labelMs;

  /// The list title ("Kuliah", "Penceramah", "Pengumuman").
  final String labelMsPlural;
  final IconData icon;
  final List<FieldSpec> fields;

  /// The line under the title in the content list, in the app language.
  String description(S s) => switch (key) {
    'penceramah' => s.kindDescPenceramah,
    'kitab' => s.kindDescKitab,
    'kuliah' => s.kindDescKuliah,
    'pengumuman' => s.kindDescPengumuman,
    'ticker' => s.kindDescTicker,
    'poster' => s.kindDescPoster,
    'video' => s.kindDescVideo,
    'programKhas' => s.kindDescProgramKhas,
    'takwim' => s.kindDescTakwim,
    'hadis' => s.kindDescHadis,
    'worldTime' => s.kindDescWorldTime,
    'petugas' => s.kindDescPetugas,
    'tugasan' => s.kindDescTugasan,
    'zikir' => s.kindDescZikir,
    'tilawahSlot' => s.kindDescTilawahSlot,
    _ => '',
  };

  /// Keys set elsewhere than the editor (a hadis's `shown` and `order`, set in
  /// the list): an edit sends them back as they were, untouched.
  final List<String> carried;

  FieldSpec field(String key) => fields.firstWhere((f) => f.key == key);

  FieldSpec? fieldOrNull(String key) => fields.where((f) => f.key == key).firstOrNull;

  /// One item of this kind in the app language (BM is [labelMs] word for word).
  String label(AppLang lang) => contentKindLabel(key, lang, ms: labelMs);

  /// The list title in the app language.
  String labelPlural(AppLang lang) => contentKindLabel(key, lang, ms: labelMsPlural, plural: true);

  /// Name of one of this kind's fields in the app language.
  String fieldLabel(FieldSpec f, AppLang lang) => contentFieldLabel(key, f.key, lang, ms: f.labelMs);

  /// The example under one of this kind's fields; null when it has none.
  String? fieldHint(FieldSpec f, AppLang lang) => contentFieldHint(key, f.key, lang, ms: f.hintMs);

  /// Name of one choice of one of this kind's enum fields.
  String choiceLabel(FieldSpec f, String value, AppLang lang) =>
      contentChoiceLabel(key, f.key, value, lang, ms: f.choiceLabelMs(value));
}

const List<ContentKindSpec> contentKinds = [
  ContentKindSpec(
    key: 'penceramah',
    labelMs: 'Penceramah',
    labelMsPlural: 'Penceramah',
    icon: Icons.record_voice_over_rounded,
    fields: [
      FieldSpec(key: 'name', type: FieldType.text, labelMs: 'Nama', hintMs: 'Contoh: Ustaz Ahmad Fauzi'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Gelaran', required: false, hintMs: 'Contoh: Ustaz, Dr.'),
      FieldSpec(key: 'phone', type: FieldType.text, labelMs: 'Telefon', required: false),
      FieldSpec(key: 'photoAssetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'kitab',
    labelMs: 'Kitab',
    labelMsPlural: 'Kitab',
    icon: Icons.menu_book_rounded,
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk kitab', hintMs: 'Contoh: Riyadhus Salihin'),
      FieldSpec(key: 'author', type: FieldType.text, labelMs: 'Pengarang', required: false),
      FieldSpec(key: 'coverAssetId', type: FieldType.asset, labelMs: 'Kulit kitab', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'kuliah',
    labelMs: 'Kuliah',
    labelMsPlural: 'Kuliah',
    icon: Icons.school_rounded,
    fields: [
      FieldSpec(key: 'date', type: FieldType.date, labelMs: 'Tarikh'),
      FieldSpec(key: 'slot', type: FieldType.enumOf, labelMs: 'Selepas solat', choices: ['subuh', 'zohor', 'asar', 'maghrib', 'isyak', 'lain'], choiceLabels: slotLabelsMs),
      FieldSpec(key: 'time', type: FieldType.time, labelMs: 'Masa'),
      FieldSpec(key: 'label', type: FieldType.text, labelMs: 'Nama kuliah', hintMs: 'Contoh: Kuliah Maghrib'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'penceramahId', type: FieldType.ref, labelMs: 'Penceramah', refKind: 'penceramah'),
      FieldSpec(key: 'kitabId', type: FieldType.ref, labelMs: 'Kitab', required: false, refKind: 'kitab'),
      FieldSpec(key: 'topic', type: FieldType.text, labelMs: 'Tajuk', required: false),
      FieldSpec(key: 'status', type: FieldType.status, labelMs: 'Status', choices: ['aktif', 'batal'], choiceLabels: _statusLabels),
      FieldSpec(key: 'seriesId', type: FieldType.text, labelMs: 'Siri', required: false, hidden: true),
    ],
  ),
  ContentKindSpec(
    key: 'pengumuman',
    labelMs: 'Pengumuman',
    labelMsPlural: 'Pengumuman',
    icon: Icons.campaign_rounded,
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk'),
      FieldSpec(key: 'body', type: FieldType.multiline, labelMs: 'Isi pengumuman'),
      FieldSpec(key: 'from', type: FieldType.date, labelMs: 'Tarikh mula'),
      FieldSpec(key: 'to', type: FieldType.date, labelMs: 'Tarikh tamat'),
      FieldSpec(key: 'priority', type: FieldType.priority, labelMs: 'Keutamaan', min: 1, max: 3, choices: ['1', '2', '3'], choiceLabels: _priorityLabels),
      FieldSpec(key: 'pictureAssetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'ticker',
    labelMs: 'Teks bergerak',
    labelMsPlural: 'Teks bergerak',
    icon: Icons.text_rotation_none_rounded,
    fields: [
      FieldSpec(key: 'text', type: FieldType.multiline, labelMs: 'Teks', maxLength: maxTickerText),
      FieldSpec(key: 'from', type: FieldType.date, labelMs: 'Tarikh mula'),
      FieldSpec(key: 'to', type: FieldType.date, labelMs: 'Tarikh tamat'),
    ],
  ),
  ContentKindSpec(
    key: 'poster',
    labelMs: 'Poster',
    labelMsPlural: 'Poster',
    icon: Icons.image_rounded,
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk poster', maxLength: 80),
      FieldSpec(key: 'assetId', type: FieldType.asset, labelMs: 'Gambar poster'),
      FieldSpec(
        key: 'stretch',
        type: FieldType.bool,
        labelMs: 'Regangkan gambar',
        required: false,
        hintMs: 'Ya: gambar memenuhi ruang, bentuk mungkin berubah. Tidak: gambar penuh, bentuk asal.', // lang-ok: BM source of the hint lookup
        omitWhen: true,
      ),
      FieldSpec(key: 'days', type: FieldType.days, labelMs: 'Hari dipaparkan'),
      FieldSpec(key: 'from', type: FieldType.date, labelMs: 'Tarikh mula', required: false),
      FieldSpec(key: 'to', type: FieldType.date, labelMs: 'Tarikh tamat', required: false),
      FieldSpec(key: 'order', type: FieldType.int, labelMs: 'Susunan', min: 0, max: 1000000),
    ],
  ),
  ContentKindSpec(
    key: 'video',
    labelMs: 'Video',
    labelMsPlural: 'Video',
    icon: Icons.smart_display_rounded,
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk video', maxLength: 80),
      FieldSpec(
        key: 'source',
        type: FieldType.enumOf,
        labelMs: 'Sumber',
        choices: ['upload', 'youtube', 'rakaman'],
        choiceLabels: {'upload': 'Muat naik', 'youtube': 'YouTube', 'rakaman': 'Rakaman'},
      ),
      FieldSpec(key: 'assetId', type: FieldType.text, labelMs: 'Fail video', required: false, maxLength: 64, hidden: true),
      FieldSpec(key: 'youtubeId', type: FieldType.text, labelMs: 'Video YouTube', required: false, maxLength: 11, hidden: true),
      FieldSpec(key: 'durationSec', type: FieldType.int, labelMs: 'Tempoh', required: false, min: 1, max: 86400, hidden: true),
      FieldSpec(key: 'startSec', type: FieldType.int, labelMs: 'Mula', required: false, min: 0, max: 86400, hidden: true),
      FieldSpec(key: 'endSec', type: FieldType.int, labelMs: 'Tamat', required: false, min: 1, max: 86400, hidden: true),
      FieldSpec(
        key: 'sound',
        type: FieldType.bool,
        labelMs: 'Bunyi',
        required: false,
        hintMs: 'Tidak: video senyap. Tidak pernah berbunyi semasa azan, iqamah, solat, siaran langsung atau tilawah.', // lang-ok: BM source of the hint lookup
      ),
      FieldSpec(key: 'days', type: FieldType.days, labelMs: 'Hari dipaparkan'),
      FieldSpec(key: 'from', type: FieldType.date, labelMs: 'Tarikh mula', required: false),
      FieldSpec(key: 'to', type: FieldType.date, labelMs: 'Tarikh tamat', required: false),
      FieldSpec(key: 'order', type: FieldType.int, labelMs: 'Susunan', min: 0, max: 1000000),
    ],
  ),
  ContentKindSpec(
    key: 'programKhas',
    labelMs: 'Program khas',
    labelMsPlural: 'Program khas',
    icon: Icons.event_available_rounded,
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Nama program'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'at', type: FieldType.dateTime, labelMs: 'Tarikh dan masa program'),
      FieldSpec(key: 'showFrom', type: FieldType.date, labelMs: 'Papar dari'),
      FieldSpec(key: 'showTo', type: FieldType.date, labelMs: 'Papar hingga'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'assetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
      FieldSpec(key: 'note', type: FieldType.multiline, labelMs: 'Catatan', required: false),
      FieldSpec(key: 'status', type: FieldType.status, labelMs: 'Status', choices: ['aktif', 'batal'], choiceLabels: _statusLabels),
    ],
  ),
  ContentKindSpec(
    key: 'takwim',
    labelMs: 'Takwim',
    labelMsPlural: 'Takwim',
    icon: Icons.calendar_month_rounded,
    fields: [
      FieldSpec(key: 'date', type: FieldType.date, labelMs: 'Tarikh'),
      FieldSpec(key: 'hijriLabel', type: FieldType.text, labelMs: 'Tarikh Hijrah', required: false, hintMs: 'Contoh: 12 Rabiulawal 1448'),
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Nama hari'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'assetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'hadis',
    labelMs: 'Hadis',
    labelMsPlural: 'Hadis',
    icon: Icons.format_quote_rounded,
    carried: ['shown', 'order'],
    fields: [
      FieldSpec(key: 'textMs', type: FieldType.multiline, labelMs: 'Terjemahan'),
      FieldSpec(key: 'textAr', type: FieldType.multiline, labelMs: 'Teks Arab', required: false),
      FieldSpec(key: 'source', type: FieldType.text, labelMs: 'Sumber', hintMs: 'Contoh: Riwayat al-Bukhari'),
    ],
  ),
  ContentKindSpec(
    key: 'worldTime',
    labelMs: 'Waktu dunia',
    labelMsPlural: 'Waktu dunia',
    icon: Icons.public_rounded,
    fields: [
      FieldSpec(key: 'city', type: FieldType.text, labelMs: 'Bandar', hintMs: 'Contoh: Makkah'),
      FieldSpec(key: 'tz', type: FieldType.timezone, labelMs: 'Zon waktu'),
      FieldSpec(key: 'order', type: FieldType.int, labelMs: 'Susunan', min: 0, max: 1000000),
    ],
  ),
  ContentKindSpec(
    key: 'petugas',
    labelMs: 'Petugas',
    labelMsPlural: 'Petugas',
    icon: Icons.badge_rounded,
    fields: [
      FieldSpec(key: 'name', type: FieldType.text, labelMs: 'Nama'), // lang-ok: BM source of the label lookup
      FieldSpec(key: 'photoAssetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'tugasan',
    labelMs: 'Tugasan',
    labelMsPlural: 'Tugasan',
    icon: Icons.assignment_ind_rounded,
    fields: [
      FieldSpec(key: 'date', type: FieldType.date, labelMs: 'Tarikh'),
      FieldSpec(key: 'role', type: FieldType.enumOf, labelMs: 'Tugas', choices: ['imam', 'bilal', 'khatib', 'ajk'], choiceLabels: _roleLabels),
      FieldSpec(key: 'petugasId', type: FieldType.ref, labelMs: 'Petugas', refKind: 'petugas'),
      FieldSpec(key: 'note', type: FieldType.text, labelMs: 'Catatan', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'zikir',
    labelMs: 'Zikir',
    labelMsPlural: 'Zikir',
    icon: Icons.self_improvement_rounded,
    fields: [
      FieldSpec(key: 'order', type: FieldType.int, labelMs: 'Susunan', min: 0, max: 1000000),
      FieldSpec(key: 'textAr', type: FieldType.multiline, labelMs: 'Teks Arab'),
      FieldSpec(key: 'textMs', type: FieldType.multiline, labelMs: 'Terjemahan'),
      FieldSpec(key: 'repeat', type: FieldType.int, labelMs: 'Bilangan ulangan', required: false, min: 1, max: 10000),
    ],
  ),
  ContentKindSpec(
    key: 'tilawahSlot',
    labelMs: 'Slot tilawah',
    labelMsPlural: 'Tilawah',
    icon: Icons.headphones_rounded,
    fields: [
      FieldSpec(key: 'days', type: FieldType.days, labelMs: 'Hari', allowDaily: true),
      FieldSpec(key: 'before', type: FieldType.enumOf, labelMs: 'Sebelum solat', choices: ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'], choiceLabels: slotLabelsMs),
      FieldSpec(key: 'minutesBefore', type: FieldType.int, labelMs: 'Minit sebelum waktu', min: 1, max: 120),
      FieldSpec(key: 'surah', type: FieldType.int, labelMs: 'Surah', min: 1, max: 114),
      FieldSpec(key: 'enabled', type: FieldType.bool, labelMs: 'Dimainkan'),
    ],
  ),
];

final Map<String, ContentKindSpec> _byKey = {for (final k in contentKinds) k.key: k};

ContentKindSpec? contentKindByKey(String key) => _byKey[key];

/// Time zones the world-time editor offers (city, IANA zone). Core accepts
/// any zone Node's Intl knows; the app only ever sends one of these.
const List<(String, String)> timezoneChoices = [
  ('Kuala Lumpur', 'Asia/Kuala_Lumpur'),
  ('Makkah, Madinah, Riyadh', 'Asia/Riyadh'),
  ('Jakarta', 'Asia/Jakarta'),
  ('Singapura', 'Asia/Singapore'),
  ('Bangkok', 'Asia/Bangkok'),
  ('Dubai', 'Asia/Dubai'),
  ('Doha', 'Asia/Qatar'),
  ('Amman', 'Asia/Amman'),
  ('Baitulmaqdis', 'Asia/Jerusalem'),
  ('Kaherah', 'Africa/Cairo'),
  ('Istanbul', 'Europe/Istanbul'),
  ('Karachi', 'Asia/Karachi'),
  ('Dhaka', 'Asia/Dhaka'),
  ('New Delhi', 'Asia/Kolkata'),
  ('Tokyo', 'Asia/Tokyo'),
  ('Seoul', 'Asia/Seoul'),
  ('Beijing', 'Asia/Shanghai'),
  ('Hong Kong', 'Asia/Hong_Kong'),
  ('Manila', 'Asia/Manila'),
  ('Sydney', 'Australia/Sydney'),
  ('Perth', 'Australia/Perth'),
  ('Auckland', 'Pacific/Auckland'),
  ('London', 'Europe/London'),
  ('Paris', 'Europe/Paris'),
  ('Berlin', 'Europe/Berlin'),
  ('Moscow', 'Europe/Moscow'),
  ('New York', 'America/New_York'),
  ('Chicago', 'America/Chicago'),
  ('Los Angeles', 'America/Los_Angeles'),
  ('Toronto', 'America/Toronto'),
  ('Sao Paulo', 'America/Sao_Paulo'),
  ('Johannesburg', 'Africa/Johannesburg'),
  ('Lagos', 'Africa/Lagos'),
  ('Nairobi', 'Africa/Nairobi'),
  ('UTC', 'UTC'),
];

// ---- validation (core's schema.ts, rule for rule) ----

final RegExp _dateRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _timeRe = RegExp(r'^\d{2}:\d{2}$');
final RegExp _dateTimeRe = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$');
/// The first part of every IANA zone name Intl knows ("asia" of "Asia/Brunei",
/// any case); "UTC" has none.
const Set<String> _tzRegions = {
  'utc', 'africa', 'america', 'antarctica', 'arctic', 'asia', 'atlantic', 'australia', 'europe', 'indian',
  'pacific', 'etc', 'us', 'canada', 'brazil', 'chile', 'mexico',
};

final RegExp _tzRe = RegExp(r'^(?:[A-Za-z][A-Za-z_]*(?:/[A-Za-z0-9_+\-]+){1,2}|UTC)$');

bool _isInteger(Object? v) =>
    v is int || (v is double && v.isFinite && v == v.truncateToDouble());

bool _validDate(String v) {
  if (!_dateRe.hasMatch(v)) return false;
  final p = v.split('-').map(int.parse).toList();
  final t = DateTime.utc(p[0], p[1], p[2]);
  return t.year == p[0] && t.month == p[1] && t.day == p[2];
}

bool _validTime(String v) {
  if (!_timeRe.hasMatch(v)) return false;
  final p = v.split(':').map(int.parse).toList();
  return p[0] <= 23 && p[1] <= 59;
}

bool _validDateTime(String v) {
  if (!_dateTimeRe.hasMatch(v)) return false;
  final parts = v.split('T');
  final d = parts[0].split('-').map(int.parse).toList();
  final t = parts[1].split(':').map(int.parse).toList();
  final x = DateTime.utc(d[0], d[1], d[2], t[0], t[1]);
  return x.year == d[0] &&
      x.month == d[1] &&
      x.day == d[2] &&
      x.hour == t[0] &&
      x.minute == t[1];
}

/// Core checkText: direction overrides and isolates (U+202A-202E, U+2066-2069)
/// are removed, then the text is trimmed. Arabic and U+200E/U+200F stay.
final RegExp _bidiControls = RegExp('[\u202A-\u202E\u2066-\u2069]');
String _txt(String v) => v.replaceAll(_bidiControls, '').trim();

/// Core's `validateContent(kind, item)`: accepts exactly the items core
/// accepts. `id`, `updatedAt` and `updatedBy` are allowed and ignored; an
/// optional field may be absent but not null; text is judged trimmed.
ValidationResult validateContent(String kind, Object? item, {S? s}) {
  final S l = s ?? sBm;
  final spec = _byKey[kind];
  if (spec == null) return ValidationResult([SettingError(kind, l.valUnknownKind)]);
  if (item is! Map) return ValidationResult([SettingError('', l.valItemObject)]);
  final errors = <SettingError>[];
  final present = <String>{};
  String? from;
  String? to;
  var fromKey = 'from';
  var toKey = 'to';

  for (final f in spec.fields) {
    final has = item.containsKey(f.key);
    final v = item[f.key];
    if (!has && !f.required) continue;
    present.add(f.key);
    String? err;
    switch (f.type) {
      case FieldType.text:
      case FieldType.multiline:
        if (v is! String) {
          err = f.required && (v == null) ? l.valRequired : l.valMustText;
        } else if (_txt(v).length > f.maxLength) {
          err = l.valTooLong(f.maxLength);
        } else if (f.required && _txt(v).isEmpty) {
          err = l.valRequired;
        }
      case FieldType.ref:
        if (v is! String) {
          err = v == null ? l.valRequired : l.valMustText;
        } else if (_txt(v).length > maxContentText) {
          err = l.valTooLong(maxContentText);
        } else if (f.required && _txt(v).isEmpty) {
          err = l.valRequired;
        }
      case FieldType.date:
        if (v is! String || !_validDate(v)) {
          err = v == null && f.required ? l.valRequired : l.valDate;
        } else {
          if (f.key == 'from' || f.key == 'showFrom') {
            from = v;
            fromKey = f.key;
          }
          if (f.key == 'to' || f.key == 'showTo') {
            to = v;
            toKey = f.key;
          }
        }
      case FieldType.time:
        if (v is! String || !_validTime(v)) err = v == null ? l.valRequired : l.valTimeHm;
      case FieldType.dateTime:
        if (v is! String || !_validDateTime(v)) err = v == null ? l.valRequired : l.valDateTime;
      case FieldType.int:
      case FieldType.priority:
        if (!_isInteger(v) || (v as num) < f.min || v > f.max) {
          err = v == null && f.required ? l.valRequired : l.valWholeNumber(f.min, f.max);
        }
      case FieldType.enumOf:
      case FieldType.status:
        if (v is! String || !f.choices.contains(v)) {
          err = v == null ? l.valRequired : l.valOneOf(f.choices.join(', '));
        }
      case FieldType.days:
        final allowed = {'umum', ...dayKeys, if (f.allowDaily) 'daily'};
        if (v is! List || v.isEmpty || !v.every((x) => x is String && allowed.contains(x))) {
          err = l.valPickDays;
        }
      case FieldType.asset:
        // A plain asset id or an adjusted image object (core image.ts); no logo-only square here.
        if (imageRefError(v, s: l) != null) err = l.imagePick;
      case FieldType.bool:
        if (v is! bool) err = l.valBool;
      case FieldType.timezone:
        if (v is! String) {
          err = v == null ? l.valRequired : l.valMustText;
        } else if (_txt(v).length > maxContentText) {
          err = l.valTooLong(maxContentText);
        } else {
          final tz = _txt(v);
          if (tz.isEmpty) errors.add(SettingError(f.key, l.valRequired));
          // Core accepts any zone Node's Intl knows (an imported Brunei, Tehran
          // or Kuwait clock is stored as such); the app checks the shape and
          // the region, and the box has the last word on the exact name.
          if (!_tzRe.hasMatch(tz) || !_tzRegions.contains(tz.split('/').first.toLowerCase())) err = l.valPickTz;
        }
    }
    if (err != null) errors.add(SettingError(f.key, err));
  }

  if (from != null && to != null && from.compareTo(to) > 0) {
    errors.add(SettingError(fromKey, l.valFromBeforeTo));
    errors.add(SettingError(toKey, l.valFromBeforeTo));
  }

  if (kind == 'video') errors.addAll(videoCrossErrors(item, l));

  for (final k in item.keys) {
    if (k == 'id' || k == 'updatedAt' || k == 'updatedBy') continue;
    if (k is! String || spec.fieldOrNull(k) == null) {
      errors.add(SettingError('$k', l.valUnknownField));
    }
  }
  return errors.isEmpty ? ValidationResult.valid : ValidationResult(errors);
}

/// The item the editor sends: text trimmed, empty optional fields dropped
/// (core refuses `null`), everything else as typed.
Map<String, dynamic> cleanItem(ContentKindSpec spec, Map<String, dynamic> raw) {
  final out = <String, dynamic>{};
  for (final f in spec.fields) {
    var v = raw[f.key];
    if (v is String) v = v.trim();
    final empty = v == null || (v is String && v.isEmpty);
    if (empty && !f.required) continue;
    if (f.omitWhen != null && v == f.omitWhen) continue;
    if (!raw.containsKey(f.key) && v == null) continue;
    out[f.key] = v;
  }
  return out;
}

/// `2026-11-06` as `Khamis, 6 Nov 2026`; the input itself when it is not a
/// valid date. With [weekday] false: `6 Nov 2026`.
/// In English and Arabic the weekday and month words come from labels.dart
/// (`Thursday, 6 Nov 2026`); a list is joined with the language's comma.
String dateWords(String iso, AppLang lang, {bool weekday = true}) {
  if (!_validDate(iso)) return iso;
  final p = iso.split('-').map(int.parse).toList();
  final d = DateTime.utc(p[0], p[1], p[2]);
  final body = '${d.day} ${monthWord(d.month, lang, ms: monthWordsMs[d.month - 1])} ${d.year}';
  final day = weekdayWord(d.weekday, lang, ms: weekdayWordsMs[d.weekday - 1]);
  return weekday ? '$day${_comma(lang)}$body' : body;
}

String _comma(AppLang lang) => lang == AppLang.ar ? '، ' : ', ';

/// `2026-11-20T20:30` as `Jumaat, 20 Nov 2026, 8:30 malam`.
String dateTimeWords(String iso, AppLang lang) {
  if (!_validDateTime(iso)) return iso;
  final parts = iso.split('T');
  return '${dateWords(parts[0], lang)}${_comma(lang)}${timeWords(parts[1], lang)}';
}

/// `19:15` as `7:15 malam` (BM: pagi, tengah hari, petang, malam; English `7:15 pm`).
String timeWords(String hhmm, AppLang lang) {
  if (!_validTime(hhmm)) return hhmm;
  final p = hhmm.split(':').map(int.parse).toList();
  final h = p[0];
  final mm = p[1].toString().padLeft(2, '0');
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:$mm ${dayPartWord(h, lang)}';
}

/// The days chips in words: `Setiap hari`, or `Jumaat, Sabtu`.
String daysWords(List<dynamic> days, AppLang lang) {
  if (days.contains('umum') || days.contains('daily')) return dayLabel('umum', lang, ms: dayLabelsMs['umum']!);
  return [
    for (final d in dayKeys)
      if (days.contains(d)) dayLabel(d, lang, ms: dayLabelsMs[d]!),
  ].join(_comma(lang));
}

final Random _random = Random.secure();

/// A fresh lower-case UUID v4, as core's `newId()`.
String newId() {
  final b = List<int>.generate(16, (_) => _random.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
      '${h.substring(16, 20)}-${h.substring(20)}';
}
