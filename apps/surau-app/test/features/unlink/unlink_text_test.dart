// Every refusal code of the unlink contract is worded in the three languages (a sentence of its own, never the generic
// one), a code this app does not know gets the generic sentence, and the session outcomes and steps are worded too.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/unlink/unlink_models.dart';
import 'package:surau_app/features/unlink/unlink_text.dart';
import 'package:surau_app/l10n/s_lookup.dart';

/// Every code of the contract's tables: the new ones (first twelve) and the ones it reuses.
const contractCodes = <String>[
  'unlink_open',
  'not_linked',
  'not_allowed_to_answer',
  'same_phone',
  'option_unavailable',
  'stale_session',
  'kept_window_over',
  'no_kept_data',
  'not_local',
  'wrong_code',
  'no_backup',
  'has_backup',
  'lan_only',
  'pin_required',
  'wrong_pin',
  'locked',
  'live_on',
  'linking',
  'stale_revision',
  'finance_tick',
  'confirm_required',
];

void main() {
  for (final lang in AppLang.values) {
    group(lang.name, () {
      final s = sFor(lang);
      test('every contract code has its own sentence', () {
        final generic = unlinkCodeText(s, 'something_new');
        expect(generic, s.linkCodeUnknown);
        for (final code in contractCodes) {
          final text = unlinkCodeText(s, code);
          expect(text, isNotEmpty, reason: code);
          expect(text, isNot(generic), reason: '$code must not fall to the generic sentence');
          expect(text.contains('_'), isFalse, reason: '$code: a code is never shown as it is');
        }
      });

      test('the session outcomes of a result are worded', () {
        for (final o in ['cancelled', 'failed', 'expired']) {
          expect(unlinkCodeText(s, o), isNot(s.linkCodeUnknown), reason: o);
        }
      });

      test('every step of the work has a name of its own', () {
        expect({for (final step in UnlinkStep.values) unlinkStepName(s, step)}.length, UnlinkStep.values.length);
      });

      test('every YouTube state has a sentence of its own', () {
        expect({for (final y in UnlinkYoutube.values) unlinkYoutubeText(s, y)}.length, UnlinkYoutube.values.length);
      });
    });
  }

  test('the words differ between languages (a code is not left in BM)', () {
    for (final code in contractCodes) {
      final ms = unlinkCodeText(sFor(AppLang.ms), code);
      expect(unlinkCodeText(sFor(AppLang.en), code), isNot(ms), reason: code);
      expect(unlinkCodeText(sFor(AppLang.ar), code), isNot(ms), reason: code);
    }
  });
}
