// [K13] The "needs a connection" dialog names every action that cannot wait
// in the queue: the list must cover themes, the recovery code, leaving and
// signing out.

import 'dart:ui' show Locale;

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/sync/live_only.dart';

void main() {
  test('[K13] theme check, install and delete, the recovery code, leave and logout are live-only', () {
    expect(isLiveOnly('POST', '/api/themes/check'), isTrue);
    expect(isLiveOnly('POST', '/api/themes/install'), isTrue);
    expect(isLiveOnly('DELETE', '/api/themes/tema-contoh'), isTrue);
    expect(isLiveOnly('POST', '/api/recovery/code'), isTrue);
    expect(isLiveOnly('POST', '/api/auth/leave'), isTrue);
    expect(isLiveOnly('POST', '/api/auth/logout'), isTrue);
  });

  test('[K13] each of them has a label in every language', () {
    for (final lang in ['ms', 'en', 'ar']) {
      final s = lookupS(Locale(lang));
      for (final (m, p) in [
        ('POST', '/api/themes/check'),
        ('POST', '/api/themes/install'),
        ('DELETE', '/api/themes/tema-contoh'),
        ('POST', '/api/recovery/code'),
        ('POST', '/api/auth/leave'),
        ('POST', '/api/auth/logout'),
      ]) {
        final e = liveOnlyList.firstWhere((x) => x.matches(m, p));
        expect(e.label(s).trim(), isNotEmpty, reason: '$lang $m $p');
      }
    }
  });

  test('[K13] reads of themes and the PIN-free paths stay ordinary', () {
    expect(isLiveOnly('GET', '/api/themes'), isFalse);
    expect(isLiveOnly('GET', '/api/themes/support'), isFalse);
    expect(isLiveOnly('GET', '/api/health'), isFalse);
  });
}
