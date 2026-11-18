// The Dart twin of core's validateEntryShape: nothing is queued that the box
// will refuse after "saved" (release 2026.11.12, F1 F3 F5 F9).

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/finance/entry_check.dart';

Map<String, dynamic> payment([Map<String, dynamic> over = const {}]) => {
  'kind': 'out',
  'entryDate': '2026-11-04',
  'fundId': 'f1',
  'perihalId': 'out-u',
  'amountSen': 15000,
  'method': 'tunai',
  'payee': 'Tenaga Contoh',
  ...over,
};

Map<String, dynamic> collection([Map<String, dynamic> over = const {}]) => {
  'kind': 'in',
  'entryDate': '2026-11-04',
  'fundId': 'f1',
  'perihalId': 'in-j',
  'amountSen': 15000,
  'method': 'tunai',
  'counters': [
    {'userId': 'u3'},
    {'userId': 'u4'},
  ],
  ...over,
};

List<String> check(Map<String, dynamic> v, {String? windowKl, String? startedOn}) =>
    validateEntryPayload(
      v,
      todayKl: '2026-11-04',
      windowKl: windowKl,
      startedOn: startedOn,
    );

void main() {
  test('[F1] a cash payment without counters is accepted', () {
    expect(check(payment()), isEmpty);
  });

  test('[F1] a cash collection without counters is refused, with two it passes', () {
    expect(check(collection({'counters': null})..remove('counters')), isNotEmpty);
    expect(check(collection()), isEmpty);
  });

  test('[F1] a cash payment may name two different counters, never one or two equal', () {
    final two = [
      {'userId': 'u3'},
      {'name': 'Encik Contoh'},
    ];
    expect(check(payment({'counters': two})), isEmpty);
    expect(
      check(payment({'counters': [{'userId': 'u3'}]})),
      isNotEmpty,
    );
    expect(
      check(payment({'counters': [{'userId': 'u3'}, {'userId': 'u3'}]})),
      isNotEmpty,
    );
  });

  test('[F1] a bank payment carries a reference and no counters', () {
    expect(
      check(payment({'method': 'bank', 'reference': 'FPX 7790514'})),
      isEmpty,
    );
    expect(check(payment({'method': 'bank'})), isNotEmpty);
    expect(
      check(payment({'method': 'bank', 'reference': 'FPX 7790514', 'counters': [{'userId': 'u3'}, {'userId': 'u4'}]})),
      isNotEmpty,
    );
  });

  test('[F3] a note with a line break or a <, > or control character is refused', () {
    expect(check(payment({'note': 'baik'})), isEmpty);
    expect(check(payment({'note': 'baris 1\nbaris 2'})), isNotEmpty);
    expect(check(payment({'note': 'a<b'})), isNotEmpty);
    expect(check(payment({'note': 'a>b'})), isNotEmpty);
    expect(check(payment({'note': 'a\u0007b'})), isNotEmpty);
  });

  test('[F9] payee 80, reference 60 and note 200 are the longest accepted', () {
    expect(check(payment({'payee': 'a' * 80})), isEmpty);
    expect(check(payment({'payee': 'a' * 81})), isNotEmpty);
    expect(
      check(payment({'method': 'bank', 'reference': 'r' * 60})),
      isEmpty,
    );
    expect(
      check(payment({'method': 'bank', 'reference': 'r' * 61})),
      isNotEmpty,
    );
    expect(check(payment({'note': 'n' * 200})), isEmpty);
    expect(check(payment({'note': 'n' * 201})), isNotEmpty);
  });

  test('[F5] the date window is judged from the edit day, never the future', () {
    // today 4 Nov: 30 Sep is before the previous month (1 Oct) ...
    expect(check(payment({'entryDate': '2026-09-30'})), isNotEmpty);
    // ... but judged from an edit on 30 Oct it is inside.
    expect(
      check(payment({'entryDate': '2026-09-30'}), windowKl: '2026-10-30'),
      isEmpty,
    );
    expect(check(payment({'entryDate': '2026-11-05'})), isNotEmpty);
  });

  test('[F5] an opening balance dated on the start day is always inside', () {
    final opening = {
      'kind': 'opening',
      'entryDate': '2026-07-01',
      'fundId': 'f1',
      'amountSen': 0,
    };
    expect(check(opening), isNotEmpty);
    expect(check(opening, startedOn: '2026-07-01'), isEmpty);
  });

  test('[F6] a correction needs a reason of 15 characters or more', () {
    final c = {
      'kind': 'adjust',
      'entryDate': '2026-11-04',
      'fundId': 'f1',
      'amountSen': 0,
      'correctsId': 'e1',
      'correctionKind': 'void',
      'reason': 'Kiraan semula salah dua kali.',
    };
    expect(check(c), isEmpty);
    expect(check({...c, 'reason': 'pendek'}), isNotEmpty);
  });
}
