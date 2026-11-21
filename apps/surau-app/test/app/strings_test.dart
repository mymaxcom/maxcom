// Guards the user-facing strings (Plan 4 Global Constraints):
// BM is the template; every key exists in both files; no dash, arrow or
// approximation symbols; Malaysian wording, not Indonesian.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Map<String, String> _readArb(String path) {
  final file = File(path);
  if (!file.existsSync()) throw StateError('$path must exist');
  final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  return {
    for (final entry in json.entries)
      if (!entry.key.startsWith('@')) entry.key: entry.value as String,
  };
}

/// Characters and sequences no user-facing string may contain.
const _forbiddenSequences = <String, String>{
  '—': 'em dash',
  '–': 'en dash',
  '≈': 'approximation sign',
  '→': 'right arrow',
  '←': 'left arrow',
  '↑': 'up arrow',
  '↓': 'down arrow',
  '->': 'ASCII arrow',
  '=>': 'ASCII arrow',
};

/// Indonesian words that must not appear (Malaysian equivalents in brackets).
const _indonesianDenyList = <String>[
  'bisa', // boleh
  'unduh', // muat turun
  'unggah', // muat naik
  'butuh', // perlukan
  'mengunduh',
  'mengunggah',
  'membutuhkan',
];

void main() {
  final ms = _readArb('lib/l10n/app_ms.arb');
  final en = _readArb('lib/l10n/app_en.arb');
  final ar = _readArb('lib/l10n/app_ar.arb');

  test('BM template has strings', () {
    expect(ms, isNotEmpty);
  });

  test('every BM key exists in English, and the reverse', () {
    final missingInEn = ms.keys.where((k) => !en.containsKey(k)).toList();
    final missingInMs = en.keys.where((k) => !ms.containsKey(k)).toList();
    expect(missingInEn, isEmpty, reason: 'keys missing from app_en.arb');
    expect(missingInMs, isEmpty, reason: 'keys missing from app_ms.arb');
  });

  test('every BM key exists in Arabic, and the reverse', () {
    final missingInAr = ms.keys.where((k) => !ar.containsKey(k)).toList();
    final missingInMs = ar.keys.where((k) => !ms.containsKey(k)).toList();
    expect(missingInAr, isEmpty, reason: 'keys missing from app_ar.arb');
    expect(missingInMs, isEmpty, reason: 'keys not in app_ms.arb');
  });

  test('ms, en and ar use the same placeholders in every string', () {
    final re = RegExp(r'\{(\w+)\}');
    List<String> names(String v) =>
        (re.allMatches(v).map((m) => m.group(1)!).toList()..sort());
    final offenders = <String>[];
    for (final k in ms.keys) {
      final base = names(ms[k]!);
      if (en[k] != null && names(en[k]!).join(',') != base.join(',')) offenders.add('en/$k');
      if (ar[k] != null && names(ar[k]!).join(',') != base.join(',')) offenders.add('ar/$k');
    }
    expect(offenders, isEmpty);
  });

  test('Arabic strings keep digits 0-9 (no Arabic-Indic digits)', () {
    final re = RegExp('[${String.fromCharCode(0x660)}-${String.fromCharCode(0x669)}${String.fromCharCode(0x6F0)}-${String.fromCharCode(0x6F9)}]');
    final offenders = ar.entries.where((e) => re.hasMatch(e.value)).map((e) => e.key).toList();
    expect(offenders, isEmpty);
  });

  test('the template locale is ms', () {
    final json = jsonDecode(
      File('lib/l10n/app_ms.arb').readAsStringSync(),
    ) as Map<String, dynamic>;
    expect(json['@@locale'], 'ms');
  });

  for (final entry in {'ms': ms, 'en': en, 'ar': ar}.entries) {
    test('no forbidden symbols in app_${entry.key}.arb', () {
      final offenders = <String>[];
      for (final s in entry.value.entries) {
        for (final f in _forbiddenSequences.entries) {
          if (s.value.contains(f.key)) {
            offenders.add('${s.key}: ${f.value}');
          }
        }
      }
      expect(offenders, isEmpty);
    });

    test('no empty values in app_${entry.key}.arb', () {
      final empty = entry.value.entries
          .where((e) => e.value.trim().isEmpty)
          .map((e) => e.key)
          .toList();
      expect(empty, isEmpty);
    });
  }

  test('BM strings use Malaysian words, not Indonesian', () {
    final offenders = <String>[];
    for (final s in ms.entries) {
      for (final word in _indonesianDenyList) {
        final re = RegExp('\\b$word\\b', caseSensitive: false);
        if (re.hasMatch(s.value)) offenders.add('${s.key}: $word');
      }
    }
    expect(offenders, isEmpty);
  });

  test('the strings the plan names are present in BM', () {
    expect(ms['settingsTitle'], 'Konfigurasi');
    expect(ms['errorForbidden'], 'Tiada kebenaran untuk tindakan ini');
    expect(ms['errorBoxUnreachable'], 'Tidak dapat menghubungi MAXCOM');
    expect(ms['hadisReorderNeedsConnection'], 'Susun semula perlukan sambungan ke MAXCOM');
    expect(en['hadisReorderNeedsConnection'], isNotEmpty);
  });

  test('MyHadith appears nowhere in the app text (dropped 2026-11-09)', () {
    final re = RegExp('myhadith', caseSensitive: false);
    for (final entry in {'ms': ms, 'en': en}.entries) {
      final offenders = entry.value.entries.where((e) => re.hasMatch(e.value)).map((e) => e.key).toList();
      expect(offenders, isEmpty, reason: entry.key);
    }
  });

  // Operator rule 2026-11-04: the box is "MAXCOM" (exact spelling) or
  // the surau's own name, never "Kotak". No exception: the box row on the
  // Skrin TV tab is "MAXCOM di surau" (`tvBoxTitle`, controller decision
  // 2026-11-18).
  for (final entry in {'ms': ms, 'en': en}.entries) {
    test('no "Kotak" in app_${entry.key}.arb', () {
      final re = RegExp(r'\bkotak\b', caseSensitive: false);
      final offenders = entry.value.entries
          .where((e) => re.hasMatch(e.value))
          .map((e) => e.key)
          .toList();
      expect(offenders, isEmpty);
    });
  }

  // Plan 14 (R33): one word for the box. Never "Peranti MAXCOM" nor "aplikasi Surau".
  for (final entry in {'ms': ms, 'en': en}.entries) {
    test('no "Peranti MAXCOM" and no "aplikasi Surau" in app_${entry.key}.arb', () {
      final re = RegExp(r'peranti maxcom|aplikasi surau', caseSensitive: false);
      final offenders = entry.value.entries.where((e) => re.hasMatch(e.value)).map((e) => e.key).toList();
      expect(offenders, isEmpty);
    });
  }

  // [PP-A1] The text of the Peranti and Pengguna relook (plan 2026-11-18, Task A1).
  const ppKeys = <String>[
    // the M0 amendment
    'shareContinue', 'waOpensTo', 'userRestoreTitle', 'userRestoreBody', 'phoneSave', 'userDeleteHint', 'needsBoth',
    'liveNoticePickTitle', 'liveNoticePickSearch', 'liveNoticeReset',
    // the rest, one or two of every family
    'peopleNeedsUpdate', 'peopleFlagsBoxOnly', 'peopleNeedsAction', 'peopleActiveToday', 'peopleActiveYesterday',
    'peopleActiveDaysAgo', 'peopleUnusedDays', 'peopleInactiveBadge', 'usersAllActive', 'usersDeviceCount',
    'usersNoDeviceYet', 'usersQrButton', 'usersUnlock', 'usersUnlocked', 'usersLockedUntil', 'usersSuggestDeactivate',
    'usersDeactivatedFold', 'usersDeactivatedHint', 'usersActivate', 'usersActivated', 'usersRecoveryFold',
    'usersRecoveryHint', 'usersRolesFold', 'usersHintDismiss', 'userRename', 'userRenameTitle', 'userRenameBody',
    'userRenameHistory', 'userRenameSave', 'userRenamed', 'userNameTaken', 'nameInvalid', 'userDevicesOf',
    'userDeactivateHint', 'userAddedBy', 'deviceEdit', 'deviceNameLabel', 'deviceNameHint', 'deviceRenameHistory',
    'deviceRenamed', 'deviceOwnedBy', 'deviceRemoveThis', 'deviceRemoveHint', 'devicesUnusedCard', 'devicesUnusedHint',
    'devicesRemoveAll', 'devicesRemoveAllConfirm', 'devicesRemovedSome', 'devicesSkipOwn', 'devicesSkipInUse',
    'devicesSkipLastAdmin', 'devicesLastAdmin', 'devicesOpenCodes', 'devicesCodeExpiresIn', 'devicesEndCode',
    'devicesCodeEnded', 'devicesRemovedNote', 'tvBoxTitle', 'tvExtraScreens', 'tvPairedSeen', 'tvNotSeenDays',
    'tvPairNew', 'tvNoneWaiting', 'tvOn', 'addStep', 'addWhatRole', 'addNameHint', 'addRoleAjk', 'addRoleBendahari',
    'addRoleMedia', 'addRoleLive', 'addRoleAdmin', 'addDeviceSummary', 'addChangeDevice', 'addDefaultDevice',
    'addSaveAndQr', 'addSavedNoQr', 'addScanTitle', 'addShare', 'addShareConfirmTitle', 'addShareConfirmBody',
    'addShareText', 'addShareAdminInPerson', 'addShareUnavailable', 'addLockOffHint', 'addWaiting', 'addEndCode',
    'addDoneTitle', 'addDoneBody', 'addDoneDevice', 'addNotTheirs', 'addReuseWarning', 'addAnother', 'addBackToList',
    'thisDeviceRename', 'liveOnlyRename', 'liveOnlyUnlock', 'liveOnlyCodes', 'liveOnlyActivity', 'liveOnlyDeleteUser',
    'liveOnlyRestoreUser', 'liveOnlyPhone', 'idLabel', 'idPending', 'searchNameOrId', 'userDelete', 'userDeleteTitle',
    'userDeleteBody', 'userDeleted', 'userDeleteSelf', 'userDeleteLastAdmin', 'userRestore', 'userRestored',
    'auditUserDeleted', 'auditDeviceDeleted', 'auditPhoneChanged', 'autoCleanNote', 'autoCleanSoon', 'phoneLabel',
    'phoneHint', 'phoneLabelOptional', 'phoneNone', 'phoneCleared', 'phoneInvalid', 'phoneTaken', 'phoneFill', 'phoneDuplicate',
    'phoneSaved', 'phoneEdit', 'phonePrivate', 'waTo', 'waUnavailable',
  ];

  test('[PP-A1] every key of the relook (the M0 keys included) is in ms, en and ar', () {
    for (final k in ppKeys) {
      expect(ms.containsKey(k), isTrue, reason: 'ms/$k');
      expect(en.containsKey(k), isTrue, reason: 'en/$k');
      expect(ar.containsKey(k), isTrue, reason: 'ar/$k');
    }
    expect(ms['liveNoticeReset'], 'Kembalikan teks asal');
    expect(ms.containsKey('liveNoticeOpensTo'), isFalse, reason: 'swapped for waOpensTo');
  });

  test('[PP-A1] the changed values: Padam, not Batalkan', () {
    expect(ms['devicesRevoke'], 'Padam');
    expect(ms['devicesRevokeTitle'], 'Padam {name}?');
    expect(ms['devicesRevoked'], 'Dipadam');
    expect(ms['devicesRevokedToast'], '{name} dipadam.');
    expect(ms['devicesBoxRowHint'], 'Skrin utama di surau. Sentiasa ada, tidak boleh dipadam.');
    expect(ms['devicesEnrolViaCloud'], 'Anda di luar rangkaian surau. Kod QR hanya boleh dibuat di Wi-Fi surau.');
    expect(ms['enrolQrCodeLabel'], 'Kod semakan');
    expect(ms['enrolQrCopy'], 'Salin kod');
    expect(ms['userDeactivateHint'], 'Semua peranti dan kod {name} dibatalkan. Nama kekal dalam log dan rekod kewangan.');
  });

  test('[PP-A1] no phone number outside the fake range in the people text', () {
    final number = RegExp(r'\+?\d[\d \-]{7,}\d');
    for (final entry in {'ms': ms, 'en': en, 'ar': ar}.entries) {
      for (final k in ppKeys) {
        final v = entry.value[k]!;
        for (final m in number.allMatches(v)) {
          expect(m.group(0)!.replaceAll(RegExp(r'[^0-9]'), ''), startsWith('01200000'), reason: '${entry.key}/$k');
        }
      }
    }
  });

  test('MAXCOM is spelled exactly wherever it appears', () {
    final loose = RegExp(r'surau\s?tv\s?box', caseSensitive: false);
    for (final entry in {'ms': ms, 'en': en}.entries) {
      for (final s in entry.value.entries) {
        for (final m in loose.allMatches(s.value)) {
          expect(m.group(0), 'MAXCOM', reason: '${entry.key}/${s.key}');
        }
      }
    }
  });
}
