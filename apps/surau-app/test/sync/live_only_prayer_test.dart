// Plan 13 Task 10: the prayer imports, undo, corrections, zone refresh,
// place search are live-only, under one label.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/sync/live_only.dart';

String? labelOf(String m, String p) {
  for (final e in liveOnlyList) {
    if (e.matches(m, p)) return e.label;
  }
  return null;
}

void main() {
  const label = 'Import, pembetulan dan carian waktu solat';

  test('the new operations match with the plan label', () {
    for (final (m, p) in [
      ('POST', '/api/prayer/import/file'),
      ('POST', '/api/prayer/imports/12/undo'),
      ('PUT', '/api/prayer/corrections/2026-11-10/subuh'),
      ('DELETE', '/api/prayer/corrections/2026-11-10/subuh'),
      ('POST', '/api/prayer/zones/refresh'),
      ('POST', '/api/location/search'),
    ]) {
      expect(isLiveOnly(m, p), isTrue, reason: '$m $p');
      expect(labelOf(m, p), label, reason: '$m $p');
    }
  });

  test('a query string does not hide the path', () {
    expect(isLiveOnly('POST', '/api/location/search?x=1'), isTrue);
  });

  test('other methods and neighbours keep their old answer', () {
    expect(labelOf('GET', '/api/prayer/status'), 'Data waktu solat');
    expect(isLiveOnly('GET', '/api/location/search'), isFalse);
    expect(isLiveOnly('GET', '/api/import/other'), isFalse);
    expect(labelOf('POST', '/api/prayer/import'), 'Data waktu solat');
  });
}
