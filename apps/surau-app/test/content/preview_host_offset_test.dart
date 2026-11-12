// Plan 13 gap 4: the preview host writes `?now=` in the surau's own offset.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/content/preview_host.dart';

void main() {
  final box = Uri.parse('https://10.168.0.154:8443');
  final instant = DateTime.utc(2026, 11, 3, 7, 52);

  test('a surau at +03:00 gets its own offset in ?now= (same instant)', () {
    final u = PreviewHost(box, 'tok', now: instant, utcOffsetMinutes: 180).url;
    expect(u.queryParameters['now'], '2026-11-03T10:52:00+03:00');
    expect(DateTime.parse(u.queryParameters['now']!).toUtc(), instant);
  });

  test('negative and half-hour offsets are written in full', () {
    expect(PreviewHost(box, 'tok', now: instant, utcOffsetMinutes: -300).url.queryParameters['now'], '2026-11-03T02:52:00-05:00');
    expect(PreviewHost(box, 'tok', now: instant, utcOffsetMinutes: 330).url.queryParameters['now'], '2026-11-03T13:22:00+05:30');
  });

  test('UTC+8 stays as before, by default and when given', () {
    expect(PreviewHost(box, 'tok', now: instant).url.queryParameters['now'], '2026-11-03T15:52:00+08:00');
    expect(PreviewHost(box, 'tok', now: instant, utcOffsetMinutes: 480).url.queryParameters['now'], '2026-11-03T15:52:00+08:00');
  });

  test('no pinned clock: no now and no proof', () {
    final u = PreviewHost(box, 'tok', utcOffsetMinutes: 180).url;
    expect(u.queryParameters, {'preview': '1'});
  });
}
