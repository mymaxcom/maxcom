// Pembetulan: pick an entry, the locked original, three kinds, a reason of
// at least 15 characters, and the entry history. A correction of a corrected
// entry posts against the ORIGINAL id. Goldens: finance_correction,
// finance_history.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/finance/finance_models.dart';
import 'package:surau_app/store/local_store.dart' show Collections;

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import 'finance_a_harness.dart';

const _save = Key('fin-cor-save');
const _reason = Key('fin-cor-reason');

void main() {
  late FinA f;

  setUp(() async {
    f = await FinA.create();
  });
  tearDown(() => f.dispose());

  testWidgets('the list offers originals; picking one locks it on the form', (
    tester,
  ) async {
    await f.seedCorrection();
    final h = await pumpFinance(tester, f, route: '/finance/pembetulan');
    expect(find.byKey(const Key('fin-pick-e1')), findsOneWidget);
    expect(find.byKey(const Key('fin-pick-c1')), findsNothing, reason: 'not a correction');
    expect(find.text('Dibetulkan'), findsOneWidget);
    // Search narrows by number.
    await typeAt(tester, find.byKey(const Key('fin-cor-search')), 'B-0071');
    expect(find.byKey(const Key('fin-pick-e1')), findsNothing);
    expect(find.byKey(const Key('fin-pick-e2')), findsOneWidget);
    await typeAt(tester, find.byKey(const Key('fin-cor-search')), '');
    await tapAt(tester, find.byKey(const Key('fin-pick-e1')));
    expect(find.text('Catatan asal, dikunci'), findsOneWidget);
    // The original shows its counters by name, and the value now.
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('Encik Kamal bin Hassan'), findsOneWidget);
    expect(find.text('Nilai semasa RM 1,266.30'), findsOneWidget);
    expect(h.location, '/finance/pembetulan');
    await tester.drag(find.byType(ListView).first, const Offset(0, 4000));
    await settle(tester);
    await expectGoldens(tester, h.app, 'finance_correction');
  });

  testWidgets('14 characters keep Simpan pembetulan off, 15 turn it on', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e1');
    await typeAt(tester, find.byKey(const Key('fin-cor-amount')), '1266.30');
    await typeAt(tester, find.byKey(_reason), '12345678901234');
    expect(find.text('14 / sekurang-kurangnya 15 aksara'), findsOneWidget);
    expect(await buttonEnabled(tester, find.byKey(_save)), isFalse);
    expect(find.text('Isi sebab untuk menyimpan.'), findsOneWidget);
    await typeAt(tester, find.byKey(_reason), '123456789012345');
    expect(find.text('15 aksara'), findsOneWidget);
    expect(await buttonEnabled(tester, find.byKey(_save)), isTrue);
    // Spaces do not count.
    await typeAt(tester, find.byKey(_reason), '   1234567890123   ');
    expect(await buttonEnabled(tester, find.byKey(_save)), isFalse);
  });

  testWidgets('a preset chip prefills the reason', (tester) async {
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e1');
    await tapAt(tester, find.byKey(const Key('fin-preset-Kiraan semula')));
    expect(
      tester.widget<TextField>(find.byKey(_reason)).controller!.text,
      'Kiraan semula: ',
    );
    await tapAt(tester, find.byKey(const Key('fin-preset-Salah tabung')));
    expect(
      tester.widget<TextField>(find.byKey(_reason)).controller!.text,
      'Salah tabung: ',
    );
  });

  testWidgets('an amount correction shows the adjustment and posts', (
    tester,
  ) async {
    final h = await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e1');
    await typeAt(tester, find.byKey(const Key('fin-cor-amount')), '1266.30');
    expect(find.text('-RM 18.00'), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-preset-Kiraan semula')));
    await typeAt(
      tester,
      find.byKey(_reason),
      'Kiraan semula oleh 2 AJK: syiling bernilai RM18.00 dikira dua kali.',
    );
    await tapAt(tester, find.byKey(_save));
    expect(find.text('Disimpan di peranti ini'), findsOneWidget);
    final ops = await f.ops();
    expect(ops, hasLength(1));
    expect(ops.single.kind, 'finance.append');
    final p = ops.single.payload as Map;
    expect(p['kind'], 'adjust');
    expect(p['correctsId'], 'e1');
    expect(p['correctionKind'], 'amount');
    expect(p['amountSen'], 126630);
    expect(p['fundId'], 'f1');
    expect(p['reason'], startsWith('Kiraan semula oleh 2 AJK'));
    expect(p.containsKey('toFundId'), isFalse);
    // The original is still there, now with a correction on it.
    final d = await f.repo.entry('e1');
    expect(d!.corrections, hasLength(1));
    expect(d.effective.effAmountSen, 126630);
    h.router.go('/finance');
    await settle(tester);
    expect(find.text('Dibetulkan'), findsOneWidget);
  });

  testWidgets('[F6] a cancelled entry offers no correction', (tester) async {
    await f.entry({
      'id': 'v1',
      'kind': 'adjust',
      'entryDate': '2026-11-03',
      'fundId': 'f1',
      'amountSen': 0,
      'correctsId': 'e2',
      'correctionKind': 'void',
      'reason': 'Kuliah dibatalkan, bayaran tidak jadi.',
      'refNo': 'P-0009',
      'editedAt': '2026-11-03T13:00:00.000Z',
    });
    await pumpFinance(tester, f, route: '/finance/pembetulan');
    expect(find.byKey(const Key('fin-pick-e2')), findsOneWidget);
    expect(find.byKey(const Key('fin-pick-voided-e2')), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-pick-e2')));
    expect(find.byKey(const Key('fin-cor-original')), findsNothing);
  });

  testWidgets('[F6] a link to a cancelled entry opens no correction form', (tester) async {
    await f.entry({
      'id': 'v1',
      'kind': 'adjust',
      'entryDate': '2026-11-03',
      'fundId': 'f1',
      'amountSen': 0,
      'correctsId': 'e2',
      'correctionKind': 'void',
      'reason': 'Kuliah dibatalkan, bayaran tidak jadi.',
      'refNo': 'P-0009',
      'editedAt': '2026-11-03T13:00:00.000Z',
    });
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e2');
    expect(find.byKey(const Key('fin-cor-original')), findsNothing);
    expect(find.byKey(const Key('fin-cor-save')), findsNothing);
    expect(find.byKey(const Key('fin-cor-refused')), findsOneWidget);
  });

  testWidgets('[F3] the reason refuses < and > and a control character', (tester) async {
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e1');
    await typeAt(tester, find.byKey(_reason), 'Salah <b>tabung</b> \u0007 betul');
    expect(
      tester.widget<TextField>(find.byKey(_reason)).controller!.text,
      'Salah btabung/b  betul',
    );
  });

  testWidgets('cancelling an entry counts it as zero', (tester) async {
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e2');
    await tapAt(tester, find.byKey(const Key('fin-chip-void')));
    expect(find.byKey(const Key('fin-cor-void-info')), findsOneWidget);
    expect(find.textContaining('B-0071 akan dikira sifar'), findsOneWidget);
    expect(find.textContaining('+RM 150.00'), findsOneWidget);
    await typeAt(tester, find.byKey(_reason), 'Kuliah dibatalkan, bayaran tidak jadi.');
    await tapAt(tester, find.byKey(_save));
    final p = (await f.ops()).single.payload as Map;
    expect(p['correctionKind'], 'void');
    expect(p['amountSen'], 0);
    expect(p['correctsId'], 'e2');
    final d = await f.repo.entry('e2');
    expect(d!.effective.voided, isTrue);
  });

  testWidgets('a change of tabung needs another tabung and posts toFundId', (
    tester,
  ) async {
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=e1');
    await tapAt(tester, find.byKey(const Key('fin-chip-fund')));
    // The entry's own tabung is not offered.
    expect(find.byKey(const Key('fin-chip-f1')), findsNothing);
    await typeAt(tester, find.byKey(_reason), 'Salah tabung: sepatutnya Tabung Am.');
    expect(await buttonEnabled(tester, find.byKey(_save)), isFalse);
    await tapAt(tester, find.byKey(const Key('fin-chip-f2')));
    expect(await buttonEnabled(tester, find.byKey(_save)), isTrue);
    await tapAt(tester, find.byKey(_save));
    final p = (await f.ops()).single.payload as Map;
    expect(p['correctionKind'], 'fund');
    expect(p['toFundId'], 'f2');
    expect(p['amountSen'], 0);
    final d = await f.repo.entry('e1');
    expect(d!.effective.effFundId, 'f2');
  });

  testWidgets('correcting a corrected entry posts against the original id', (
    tester,
  ) async {
    await f.seedCorrection();
    // The page is opened with the correction's own id.
    await pumpFinance(tester, f, route: '/finance/pembetulan?entry=c1');
    expect(find.textContaining('K-0118'), findsWidgets);
    expect(find.text('Nilai semasa RM 1,266.30'), findsOneWidget);
    await typeAt(tester, find.byKey(const Key('fin-cor-amount')), '1280.00');
    await typeAt(tester, find.byKey(_reason), 'Kiraan ketiga: RM13.70 ditemui dalam beg.');
    await tapAt(tester, find.byKey(_save));
    final p = (await f.ops()).single.payload as Map;
    expect(p['correctsId'], 'e1', reason: 'never the correction c1');
    expect(p['amountSen'], 128000);
    final d = await f.repo.entry('e1');
    expect(d!.corrections, hasLength(2));
    expect(d.effective.effAmountSen, 128000);
  });

  testWidgets('the history shows the original, each correction and the value now', (
    tester,
  ) async {
    await f.seedCorrection();
    final h = await pumpFinance(tester, f, route: '/finance/entry/e1');
    expect(find.text('RM 1,266.30'), findsWidgets);
    expect(find.text('Asal: Kutipan solat Jumaat'), findsOneWidget);
    expect(find.text('Pembetulan P-0008'), findsOneWidget);
    expect(find.textContaining('syiling RM18.00 dikira dua kali'), findsOneWidget);
    expect(find.text('Nilai semasa selepas 1 pembetulan. Asal RM 1,284.30.'), findsOneWidget);
    expect(find.text('Nilai semasa RM 1,266.30'), findsOneWidget);
    // Who keyed it in, on which device, and who counted.
    expect(find.text('Aminah binti Yusof'), findsWidgets);
    expect(find.text('Telefon Aminah (Android)'), findsOneWidget);
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('Encik Kamal bin Hassan'), findsOneWidget);
    // The treasurer sees the photo row.
    expect(find.byKey(const Key('fin-history-photo')), findsOneWidget);
    expect(find.byKey(const Key('fin-history-correct')), findsOneWidget);
    await expectGoldens(tester, h.app, 'finance_history');
  });

  testWidgets('AJK see the counters but never the photo, and cannot correct', (
    tester,
  ) async {
    await f.seedCorrection();
    await pumpFinance(tester, f, roles: const ['ajk'], route: '/finance/entry/e1');
    expect(find.text('Encik Hafiz'), findsOneWidget);
    expect(find.text('Encik Kamal bin Hassan'), findsOneWidget);
    expect(find.byKey(const Key('fin-history-photo')), findsNothing);
    expect(find.byKey(const Key('fin-history-correct')), findsNothing);
  });

  testWidgets('[PP-A8b] an entry with names shows the names and IDs of the time after a rename; a deleted counter still shows', (
    tester,
  ) async {
    await f.entry({
      'id': 'e9',
      'kind': 'in',
      'entryDate': '2026-11-02',
      'fundId': 'f1',
      'perihalId': 'in-j',
      'amountSen': 5000,
      'method': 'tunai',
      'createdBy': 'u3',
      'deviceId': 'd1',
      'counters': [
        {'userId': 'u3'},
        {'userId': 'u9'},
      ],
      'refNo': 'K-0120',
      'names': {
        'createdBy': 'Ustaz Ahmad',
        'device': 'Telefon lama Ustaz Ahmad',
        'counters': {'u3': 'Ustaz Ahmad', 'u9': 'Haji Osman'},
        'createdByRef': 'U-0003',
        'deviceRef': 'D-0004',
        'counterRefs': {'u3': 'U-0003', 'u9': 'U-0009'},
      },
    });
    // Renamed since; u9 was deleted and is gone from the local copy.
    await f.store.putDoc(Collections.users, 'u3', {
      'id': 'u3',
      'name': 'Ustaz Ahmad bin Ali',
      'active': true,
      'roles': ['ajk'],
    });
    await pumpFinance(tester, f, route: '/finance/entry/e9');
    expect(find.text('Ustaz Ahmad bin Ali'), findsNothing);
    expect(find.textContaining('Ustaz Ahmad'), findsNWidgets(3), reason: 'creator, counter and the device of the time');
    expect(find.text('U-0003'), findsNWidgets(2));
    expect(find.textContaining('Haji Osman'), findsOneWidget);
    expect(find.text('U-0009'), findsOneWidget);
    expect(find.textContaining('Telefon lama Ustaz Ahmad'), findsOneWidget);
    expect(find.text('D-0004'), findsOneWidget);
    expect(find.textContaining('tidak dikenali'), findsNothing);
  });

  testWidgets('[PP-A8b] an entry without names (older box) shows today\'s name, with the ID from the local copy', (
    tester,
  ) async {
    await f.store.putDoc(Collections.users, 'u3', {
      'id': 'u3',
      'name': 'Encik Hafiz',
      'active': true,
      'roles': ['ajk'],
      'no': 3,
      'noSrc': 'b',
    });
    await pumpFinance(tester, f, route: '/finance/entry/e1');
    expect(find.textContaining('Encik Hafiz'), findsOneWidget);
    expect(find.text('U-0003'), findsOneWidget);
  });

  test('[PP-A8b] names survive the local round trip and are never part of a signed finance.append payload', () {
    final e = FinanceEntry.fromJson({
      'id': 'e9',
      'kind': 'in',
      'entryDate': '2026-11-02',
      'fundId': 'f1',
      'createdBy': 'u3',
      'names': {
        'createdBy': 'Ustaz Ahmad',
        'counters': {'u3': 'Ustaz Ahmad'},
        'createdByRef': 'U-0003',
      },
    });
    final back = FinanceEntry.fromJson(e.toJson());
    expect(back.names?.createdBy, 'Ustaz Ahmad');
    expect(back.names?.createdByRef, 'U-0003');
    expect(back.names?.counters, {'u3': 'Ustaz Ahmad'});
    expect(financeEntryInputKeys.contains('names'), isFalse);
    expect(FinanceEntry.fromJson({'id': 'x', 'names': 'bad'}).names, isNull);
  });

  testWidgets('the history opens from the home list as a sheet', (tester) async {
    await pumpFinance(tester, f);
    await tapAt(tester, find.byKey(const Key('fin-entry-e1')));
    expect(find.text('Sejarah catatan'), findsNothing, reason: 'a sheet, no page title');
    expect(find.text('Asal: Kutipan solat Jumaat'), findsOneWidget);
    await tapAt(tester, find.byKey(const Key('fin-history-correct')));
    expect(find.text('Catatan asal, dikunci'), findsOneWidget);
  });
}
