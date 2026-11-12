// The 14 content kinds as the editors see them: one `ContentKindSpec` per
// kind (BM labels, icon, the fields in the order the form shows them) and
// the Dart twin of core's `validateContent`
// (`packages/core/src/content/schema.ts`). The generated
// `test/fixtures/content-cases.json` (answers computed by core itself)
// proves both say yes and no on the same items. Messages are Bahasa
// Malaysia for the form; every error carries the field key.

import 'dart:math';

import 'package:flutter/material.dart';

import '../features/validate.dart' show SettingError, ValidationResult, imageRefError;

/// sha256 of core content/schema.ts + content/types.ts (CRLF as LF) this
/// port was written against; kinds_test fails when core moved on.
const String contentSourceHash =
    '8043917b5c23a0ec9db65b94e788de0aa1a2c74b39e5e66a228ec9230e8f9d03';

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

const Map<String, String> dayLabelsMs = {
  'umum': 'Setiap hari',
  'daily': 'Setiap hari',
  'ahad': 'Ahad',
  'isnin': 'Isnin',
  'selasa': 'Selasa',
  'rabu': 'Rabu',
  'khamis': 'Khamis',
  'jumaat': 'Jumaat',
  'sabtu': 'Sabtu',
};

const Map<String, String> _slotLabels = {
  'subuh': 'Subuh',
  'zohor': 'Zohor',
  'asar': 'Asar',
  'maghrib': 'Maghrib',
  'isyak': 'Isyak',
  'lain': 'Lain-lain',
};

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

  String choiceLabelMs(String value) => choiceLabels[value] ?? value;
}

class ContentKindSpec {
  const ContentKindSpec({
    required this.key,
    required this.labelMs,
    required this.labelMsPlural,
    required this.icon,
    required this.fields,
    this.descriptionMs = '',
    this.carried = const [],
  });

  final String key;

  /// One item ("Kuliah", "Penceramah").
  final String labelMs;

  /// The list title ("Kuliah", "Penceramah", "Pengumuman").
  final String labelMsPlural;
  final IconData icon;
  final List<FieldSpec> fields;
  final String descriptionMs;

  /// Keys set elsewhere than the editor (a hadis's `shown` and `order`, set in
  /// the list): an edit sends them back as they were, untouched.
  final List<String> carried;

  FieldSpec field(String key) => fields.firstWhere((f) => f.key == key);

  FieldSpec? fieldOrNull(String key) => fields.where((f) => f.key == key).firstOrNull;
}

const List<ContentKindSpec> contentKinds = [
  ContentKindSpec(
    key: 'penceramah',
    labelMs: 'Penceramah',
    labelMsPlural: 'Penceramah',
    icon: Icons.record_voice_over_rounded,
    descriptionMs: 'Ustaz dan ustazah yang menyampaikan kuliah.',
    fields: [
      FieldSpec(key: 'name', type: FieldType.text, labelMs: 'Nama', hintMs: 'Contoh: Ustaz Ahmad Fauzi'),
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Gelaran', required: false, hintMs: 'Contoh: Ustaz, Dr.'),
      FieldSpec(key: 'phone', type: FieldType.text, labelMs: 'Telefon', required: false, hintMs: 'Untuk AJK sahaja, tidak dipaparkan di TV'),
      FieldSpec(key: 'photoAssetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'kitab',
    labelMs: 'Kitab',
    labelMsPlural: 'Kitab',
    icon: Icons.menu_book_rounded,
    descriptionMs: 'Kitab yang dibaca dalam kuliah.',
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
    descriptionMs: 'Jadual kuliah yang dipaparkan di TV.',
    fields: [
      FieldSpec(key: 'date', type: FieldType.date, labelMs: 'Tarikh'),
      FieldSpec(key: 'slot', type: FieldType.enumOf, labelMs: 'Selepas solat', choices: ['subuh', 'zohor', 'asar', 'maghrib', 'isyak', 'lain'], choiceLabels: _slotLabels),
      FieldSpec(key: 'time', type: FieldType.time, labelMs: 'Masa'),
      FieldSpec(key: 'label', type: FieldType.text, labelMs: 'Nama kuliah', hintMs: 'Contoh: Kuliah Maghrib'),
      FieldSpec(key: 'penceramahId', type: FieldType.ref, labelMs: 'Penceramah', refKind: 'penceramah'),
      FieldSpec(key: 'kitabId', type: FieldType.ref, labelMs: 'Kitab', required: false, refKind: 'kitab'),
      FieldSpec(key: 'topic', type: FieldType.text, labelMs: 'Tajuk', required: false),
      FieldSpec(key: 'status', type: FieldType.status, labelMs: 'Status', choices: ['aktif', 'batal'], choiceLabels: _statusLabels),
      FieldSpec(key: 'seriesId', type: FieldType.text, labelMs: 'Siri', required: false, hintMs: 'Kod siri untuk kuliah bersambung (pilihan)'),
    ],
  ),
  ContentKindSpec(
    key: 'pengumuman',
    labelMs: 'Pengumuman',
    labelMsPlural: 'Pengumuman',
    icon: Icons.campaign_rounded,
    descriptionMs: 'Makluman kepada jemaah untuk tempoh tertentu.',
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk'),
      FieldSpec(key: 'body', type: FieldType.multiline, labelMs: 'Isi pengumuman'),
      FieldSpec(key: 'from', type: FieldType.date, labelMs: 'Tarikh mula'),
      FieldSpec(key: 'to', type: FieldType.date, labelMs: 'Tarikh tamat'),
      FieldSpec(key: 'priority', type: FieldType.priority, labelMs: 'Keutamaan', min: 1, max: 3, choices: ['1', '2', '3'], choiceLabels: _priorityLabels),
    ],
  ),
  ContentKindSpec(
    key: 'ticker',
    labelMs: 'Teks bergerak',
    labelMsPlural: 'Teks bergerak',
    icon: Icons.text_rotation_none_rounded,
    descriptionMs: 'Ayat pendek yang bergerak di bawah skrin.',
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
    descriptionMs: 'Gambar penuh skrin yang bergilir di TV.',
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Tajuk poster', maxLength: 80),
      FieldSpec(key: 'assetId', type: FieldType.asset, labelMs: 'Gambar poster'),
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
    descriptionMs: 'Majlis dan program yang akan datang.',
    fields: [
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Nama program'),
      FieldSpec(key: 'at', type: FieldType.dateTime, labelMs: 'Tarikh dan masa program'),
      FieldSpec(key: 'showFrom', type: FieldType.date, labelMs: 'Papar dari'),
      FieldSpec(key: 'showTo', type: FieldType.date, labelMs: 'Papar hingga'),
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
    descriptionMs: 'Tarikh penting dalam kalendar surau.',
    fields: [
      FieldSpec(key: 'date', type: FieldType.date, labelMs: 'Tarikh'),
      FieldSpec(key: 'hijriLabel', type: FieldType.text, labelMs: 'Tarikh Hijrah', required: false, hintMs: 'Contoh: 12 Rabiulawal 1448'),
      FieldSpec(key: 'title', type: FieldType.text, labelMs: 'Nama hari'),
      FieldSpec(key: 'assetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'hadis',
    labelMs: 'Hadis',
    labelMsPlural: 'Hadis',
    icon: Icons.format_quote_rounded,
    descriptionMs: 'Hadis pilihan untuk kad hadis di TV.',
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
    descriptionMs: 'Jam bandar lain yang dipaparkan di TV.',
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
    descriptionMs: 'Imam, bilal dan AJK yang bertugas.',
    fields: [
      FieldSpec(key: 'name', type: FieldType.text, labelMs: 'Nama'),
      FieldSpec(key: 'photoAssetId', type: FieldType.asset, labelMs: 'Gambar', required: false),
    ],
  ),
  ContentKindSpec(
    key: 'tugasan',
    labelMs: 'Tugasan',
    labelMsPlural: 'Tugasan',
    icon: Icons.assignment_ind_rounded,
    descriptionMs: 'Siapa bertugas pada hari mana.',
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
    descriptionMs: 'Zikir selepas solat, dalam susunan bacaan.',
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
    descriptionMs: 'Bacaan Al-Quran yang dimainkan sebelum waktu solat.',
    fields: [
      FieldSpec(key: 'days', type: FieldType.days, labelMs: 'Hari', allowDaily: true),
      FieldSpec(key: 'before', type: FieldType.enumOf, labelMs: 'Sebelum solat', choices: ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'], choiceLabels: _slotLabels),
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

final Set<String> _knownZonesLower = {
  for (final z in timezoneChoices) z.$2.toLowerCase(),
};

// ---- validation (core's schema.ts, rule for rule) ----

final RegExp _dateRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _timeRe = RegExp(r'^\d{2}:\d{2}$');
final RegExp _dateTimeRe = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$');
final RegExp _tzRe = RegExp(r'^(?:[A-Za-z][A-Za-z_]*(?:/[A-Za-z0-9_+\-]+){1,2}|UTC)$');

const String msgRequired = 'Wajib diisi';
const String msgFromAfterTo = 'Tarikh mula mesti sebelum tarikh tamat';
const String msgDate = 'Mesti tarikh yang sah';
const String msgTime = 'Mesti masa yang sah (JJ:MM)';
const String msgDateTime = 'Mesti tarikh dan masa yang sah';
const String msgText = 'Mesti teks';
const String msgAsset = 'Pilih gambar';
const String msgDays = 'Pilih sekurang-kurangnya satu hari';
const String msgTz = 'Pilih zon waktu daripada senarai';
const String msgBool = 'Mesti hidup atau mati';
const String msgUnknown = 'Medan tidak dikenali';

String msgTooLong(int max) => 'Terlalu panjang (paling banyak $max aksara)';
String msgInt(int min, int max) => 'Mesti nombor bulat $min hingga $max';
String msgChoice(List<String> vals) => 'Mesti salah satu daripada: ${vals.join(', ')}';

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

/// Core's `validateContent(kind, item)`: accepts exactly the items core
/// accepts. `id`, `updatedAt` and `updatedBy` are allowed and ignored; an
/// optional field may be absent but not null; text is judged trimmed.
ValidationResult validateContent(String kind, Object? item) {
  final spec = _byKey[kind];
  if (spec == null) return ValidationResult([SettingError(kind, 'Jenis kandungan tidak dikenali')]);
  if (item is! Map) return const ValidationResult([SettingError('', 'Item mesti objek')]);
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
          err = f.required && (v == null) ? msgRequired : msgText;
        } else if (v.trim().length > f.maxLength) {
          err = msgTooLong(f.maxLength);
        } else if (f.required && v.trim().isEmpty) {
          err = msgRequired;
        }
      case FieldType.ref:
        if (v is! String) {
          err = v == null ? msgRequired : msgText;
        } else if (v.trim().length > maxContentText) {
          err = msgTooLong(maxContentText);
        } else if (f.required && v.trim().isEmpty) {
          err = msgRequired;
        }
      case FieldType.date:
        if (v is! String || !_validDate(v)) {
          err = v == null && f.required ? msgRequired : msgDate;
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
        if (v is! String || !_validTime(v)) err = v == null ? msgRequired : msgTime;
      case FieldType.dateTime:
        if (v is! String || !_validDateTime(v)) err = v == null ? msgRequired : msgDateTime;
      case FieldType.int:
      case FieldType.priority:
        if (!_isInteger(v) || (v as num) < f.min || v > f.max) {
          err = v == null && f.required ? msgRequired : msgInt(f.min, f.max);
        }
      case FieldType.enumOf:
      case FieldType.status:
        if (v is! String || !f.choices.contains(v)) {
          err = v == null ? msgRequired : msgChoice(f.choices);
        }
      case FieldType.days:
        final allowed = {'umum', ...dayKeys, if (f.allowDaily) 'daily'};
        if (v is! List || v.isEmpty || !v.every((x) => x is String && allowed.contains(x))) {
          err = msgDays;
        }
      case FieldType.asset:
        // A plain asset id or an adjusted image object (core image.ts); no logo-only square here.
        if (imageRefError(v) != null) err = msgAsset;
      case FieldType.bool:
        if (v is! bool) err = msgBool;
      case FieldType.timezone:
        if (v is! String) {
          err = v == null ? msgRequired : msgText;
        } else if (v.trim().length > maxContentText) {
          err = msgTooLong(maxContentText);
        } else {
          final tz = v.trim();
          if (tz.isEmpty) errors.add(SettingError(f.key, msgRequired));
          // Node's Intl matches zone names case-insensitively.
          if (!_tzRe.hasMatch(tz) || !_knownZonesLower.contains(tz.toLowerCase())) {
            err = msgTz;
          }
        }
    }
    if (err != null) errors.add(SettingError(f.key, err));
  }

  if (from != null && to != null && from.compareTo(to) > 0) {
    errors.add(SettingError(fromKey, msgFromAfterTo));
    errors.add(SettingError(toKey, msgFromAfterTo));
  }

  for (final k in item.keys) {
    if (k == 'id' || k == 'updatedAt' || k == 'updatedBy') continue;
    if (k is! String || spec.fieldOrNull(k) == null) {
      errors.add(SettingError('$k', msgUnknown));
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
    if (!raw.containsKey(f.key) && v == null) continue;
    out[f.key] = v;
  }
  return out;
}

const List<String> _monthsMs = [
  'Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogos', 'Sep', 'Okt', 'Nov', 'Dis',
];
const List<String> _weekdaysMs = [
  'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu', 'Ahad',
];

/// `2026-11-06` as `Khamis, 6 Nov 2026`; the input itself when it is not a
/// valid date. With [weekday] false: `6 Nov 2026`.
String dateWordsMs(String iso, {bool weekday = true}) {
  if (!_validDate(iso)) return iso;
  final p = iso.split('-').map(int.parse).toList();
  final d = DateTime.utc(p[0], p[1], p[2]);
  final body = '${d.day} ${_monthsMs[d.month - 1]} ${d.year}';
  return weekday ? '${_weekdaysMs[d.weekday - 1]}, $body' : body;
}

/// `2026-11-20T20:30` as `Jumaat, 20 Nov 2026, 8:30 malam`.
String dateTimeWordsMs(String iso) {
  if (!_validDateTime(iso)) return iso;
  final parts = iso.split('T');
  return '${dateWordsMs(parts[0])}, ${timeWordsMs(parts[1])}';
}

/// `19:15` as `7:15 malam` (pagi, tengah hari, petang, malam).
String timeWordsMs(String hhmm) {
  if (!_validTime(hhmm)) return hhmm;
  final p = hhmm.split(':').map(int.parse).toList();
  final h = p[0];
  final mm = p[1].toString().padLeft(2, '0');
  final h12 = h % 12 == 0 ? 12 : h % 12;
  final word = h < 12
      ? 'pagi'
      : h < 15
      ? 'tengah hari'
      : h < 19
      ? 'petang'
      : 'malam';
  return '$h12:$mm $word';
}

/// The days chips in words: `Setiap hari`, or `Jumaat, Sabtu`.
String daysWordsMs(List<dynamic> days) {
  if (days.contains('umum') || days.contains('daily')) return dayLabelsMs['umum']!;
  return [
    for (final d in dayKeys)
      if (days.contains(d)) dayLabelsMs[d]!,
  ].join(', ');
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
