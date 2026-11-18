// [A5] One map from the box's reason codes to the app's own text, in ms, en
// and ar. Also the guard that every code the box sends today is either
// mapped or deliberately left to the server's sentence.

import 'dart:io';
import 'dart:ui' show Locale;

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/features/common/error_text.dart';
import 'package:surau_app/features/people/people_api.dart' show BadPhone, PeopleNeedsUpdate;
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/screens/widgets/box_read.dart';
import 'package:surau_app/sync/sync_engine.dart' show AssetTooLarge;

final _locales = <String, S>{
  'ms': lookupS(const Locale('ms')),
  'en': lookupS(const Locale('en')),
  'ar': lookupS(const Locale('ar')),
};

/// Box codes whose answer carries the specific sentence for THIS refusal
/// (validation messages); the app shows that sentence. Anything the box sends
/// that is not here and not in [kErrorCodeTexts] fails the guard below.
const _serverSentenceCodes = <String>{
  'invalid', // content validators: one sentence per field
  'bad_asset', // asset checks: one sentence per cause
  'bad_body', // shape of a body: wording differs per route
  // Prayer warnings travel as `warningCodes` entries and are drawn by the
  // prayer screens (RA2), not as a request's refusal.
  'import_row_invalid', // one bad row of a file: the prayer screens word it from field and reason (RA2)
  'emergency_today',
  'zone_no_data',
};

void main() {
  group('[L8] live codes of release 2026.11.12', () {
    test('[L8] each camera address reason has its own text in ms, en and ar', () {
      const reasons = <String, String>{
        'not_rtsp': 'rtsp://',
        'not_ipv4': 'IPv4',
        'not_private': '192.168',
        'is_box': 'MAXCOM',
        'bad_port': '65535',
        'bad_login_chars': '%40',
        'bad_path': '#',
        'too_long': '400',
      };
      final seen = <String>{};
      for (final e in _locales.entries) {
        for (final r in reasons.entries) {
          final err = BoxError(400, 'Alamat kamera tidak sah', code: 'bad_address', detail: {'reason': r.key});
          final text = errorText(e.value, err);
          expect(text, isNot('Alamat kamera tidak sah'), reason: '${e.key} ${r.key}');
          expect(text, contains(r.value), reason: '${e.key} ${r.key}');
          seen.add('${e.key}:$text');
        }
      }
      expect(seen.length, 24, reason: 'every reason reads differently');
      // No reason (an older box) and a reason this app does not know: the plain refusal.
      for (final s in _locales.values) {
        expect(errorText(s, const BoxError(400, 'x', code: 'bad_address')), s.errcBadAddress);
        expect(
          errorText(s, const BoxError(400, 'x', code: 'bad_address', detail: {'reason': 'zzz'})),
          s.errcBadAddress,
        );
      }
    });

    test('[L8] unknown_video and a refused cloud sign-out have their own texts', () {
      for (final s in _locales.values) {
        expect(errorText(s, const BoxError(409, 'x', code: 'unknown_video')), s.errcUnknownVideo);
        expect(errorText(s, const BoxError(409, 'x', code: 'live_busy')), s.errcLiveBusy);
        expect(
          errorText(s, const BoxError(502, 'x', code: 'cloud_unreachable')),
          s.liveWarnCloudUnreachable,
        );
      }
    });
  });

  group('[A5] errorText', () {
    test('[A5] a known code maps to its text in ms, en and ar, with its parameters', () {
      for (final e in _locales.entries) {
        final s = e.value;
        final err = BoxError(
          409,
          'Penceramah masih digunakan',
          code: 'content_in_use',
          detail: const {'kind': 'penceramah', 'count': 3},
        );
        expect(errorText(s, err), s.errcContentInUse(3), reason: e.key);
        expect(errorText(s, err), contains('3'), reason: e.key);
        expect(errorText(s, err), isNot('Penceramah masih digunakan'), reason: e.key);
      }
      // The three languages say different things.
      final texts = {
        for (final s in _locales.values)
          errorText(s, const BoxError(401, 'PIN salah', code: 'wrong_pin')),
      };
      expect(texts.length, 3);
    });

    test('[A5] a lockout fills the minutes from Retry-After', () {
      final s = _locales['en']!;
      const err = BoxError(423, 'PIN dikunci', code: 'locked', retryAfterSec: 900);
      expect(errorText(s, err), s.errcLocked(15));
      // 61 seconds is two whole minutes, never "0" or "1".
      expect(
        errorText(s, const BoxError(423, 'x', code: 'locked', retryAfterSec: 61)),
        s.errcLocked(2),
      );
    });

    test('[A5] an unknown code shows the server sentence', () {
      for (final s in _locales.values) {
        expect(
          errorText(s, const BoxError(409, 'Ayat dari pelayan', code: 'brand_new_code')),
          'Ayat dari pelayan',
        );
        expect(errorText(s, const BoxError(400, 'Ayat tanpa kod')), 'Ayat tanpa kod');
      }
    });

    test('[A5] the generic marker shows errorRequestFailed', () {
      for (final s in _locales.values) {
        expect(
          errorText(s, const BoxError(500, BoxError.genericMessage)),
          s.errorRequestFailed,
        );
      }
    });

    test('[A5] the app\'s own exceptions read as writeErrorText did', () {
      final s = _locales['en']!;
      expect(errorText(s, const OfflineWriteRefused()), s.offlineWriteRefused);
      expect(errorText(s, const LiveOnly('/api/x')), s.liveOnlyNeedsConnection);
      expect(errorText(s, const AssetTooLarge()), s.assetTooLarge);
      expect(errorText(s, const SessionExpired('x')), s.errorSessionExpired);
      expect(errorText(s, const BoxError(403, 'x')), s.errorForbidden);
      expect(errorText(s, const BoxError(429, 'x')), s.errorTooMany);
      expect(errorText(s, const BoxUnreachable()), s.errorBoxUnreachable);
      expect(errorText(s, StateError('x')), s.errorUnknown);
      expect(errorText(s, const Uncertain('/api/users')), s.errcUncertain);
    });

    test('[A5] writeErrorText delegates to errorText', () {
      for (final s in _locales.values) {
        const err = BoxError(409, 'x', code: 'content_in_use', detail: {'count': 2});
        expect(writeErrorText(s, err), errorText(s, err));
        expect(writeErrorText(s, const Uncertain('/p')), errorText(s, const Uncertain('/p')));
      }
    });

    test('[A5] a wrong PIN answered 401 on a signed-in request is a PIN answer, not an ended session', () {
      final s = _locales['en']!;
      expect(
        errorText(s, const SessionExpired('PIN salah', code: 'wrong_pin')),
        s.errcWrongPin,
      );
      expect(
        errorText(s, const SessionExpired('Sesi tamat', code: 'no_session')),
        s.errorSessionExpired,
      );
    });

    test('[A5] every mapped code renders a non-empty text in all three languages', () {
      expect(kErrorCodeTexts, isNotEmpty);
      for (final c in kErrorCodeTexts.entries) {
        for (final l in _locales.entries) {
          final text = c.value(l.value, const {'count': 2, 'minutes': 5});
          expect(text.trim(), isNotEmpty, reason: '${c.key}/${l.key}');
        }
      }
    });

    test('[A5] every code the box sends today is mapped or deliberately left to its own sentence', () {
      final root = Directory('../box-server/src');
      expect(root.existsSync(), isTrue, reason: 'the box source is beside the app');
      final sent = <String>{};
      final re = <RegExp>[
        RegExp(r"code: '([a-z][a-z_0-9]*)'"),
        RegExp(r"new AuthError\(\s*\d+,\s*'([a-z][a-z_0-9]*)'"),
        RegExp(r"fail\([^;]*?'([a-z][a-z_0-9]*)', (?:401|423),"),
      ];
      for (final f in root.listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.ts')) continue;
        final src = f.readAsStringSync();
        for (final r in re) {
          for (final m in r.allMatches(src)) {
            sent.add(m.group(1)!);
          }
        }
      }
      expect(sent.length, greaterThan(40), reason: 'the scan found the box codes');
      final missing = sent
          .where((c) => !kErrorCodeTexts.containsKey(c) && !_serverSentenceCodes.contains(c))
          .toList()
        ..sort();
      expect(missing, isEmpty, reason: 'box codes with no app text: $missing');
    });
  });

  group('[PP-A1] people errors', () {
    test('[PP-A1] an older box, a bad number and a taken number read in every language', () {
      final ms = _locales['ms']!;
      expect(errorText(ms, const PeopleNeedsUpdate()), 'Kemas kini MAX Kiosk Server untuk fungsi ini');
      expect(errorText(_locales['en']!, const PeopleNeedsUpdate()), 'Update MAX Kiosk Server to use this function');
      expect(errorText(_locales['ar']!, const PeopleNeedsUpdate()), isNotEmpty);
      expect(errorText(ms, const BadPhone()), startsWith('Nombor telefon tidak sah.'));
      const taken = BoxError(409, 'x', code: 'phone_taken', detail: {'ref': 'U-0004'});
      expect(errorText(ms, taken), 'Nombor ini sudah digunakan oleh pengguna lain (U-0004).');
      expect(errorText(ms, const BoxError(409, 'x', code: 'phone_taken')), 'Nombor telefon ini sudah digunakan oleh pengguna lain');
    });

    test('[PP-A1] the codes of the people routes have their own words', () {
      for (final code in ['ref_mismatch', 'own_account', 'phone_required', 'bad_phone', 'phone_taken', 'last_admin_device']) {
        expect(kErrorCodeTexts.containsKey(code), isTrue, reason: code);
        for (final s in _locales.values) {
          expect(errorText(s, BoxError(400, 'ayat pelayan', code: code)), isNot('ayat pelayan'), reason: code);
        }
      }
    });
  });

  group('[A5] BoxError.detail', () {
    test('detail defaults to an empty map', () {
      expect(const BoxError(400, 'x').detail, isEmpty);
    });
  });
}
