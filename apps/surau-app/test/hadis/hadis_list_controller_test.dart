// The list behind `Senarai hadis` over a fake box: sorting, filter and counts,
// the show/hide switch (the item goes back with only `shown` different),
// moving by midpoint and the renumber fallback, `Buang`, tags.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/hadis/hadis_api.dart';
import 'package:surau_app/hadis/hadis_list_controller.dart';

import 'hadis_rig.dart';

void main() {
  late HadisRig rig;

  HadisListController ctl() => rig.container.read(hadisListProvider.notifier);
  HadisListState st() => rig.container.read(hadisListProvider);

  setUp(() => rig = HadisRig());
  tearDown(() => rig.dispose());

  group('load and sort', () {
    test('order first, items without one after, oldest edit first', () async {
      rig.items = [
        ownItem('late', updatedAt: '2026-11-03T00:00:00.000Z'),
        ownItem('early', updatedAt: '2026-11-02T00:00:00.000Z'),
        providerItem('2', order: 2000),
        ownItem('first', order: 1000),
      ];
      await ctl().load();
      expect(st().items.map((i) => i.id), [
        'first',
        'hadeethenc-2',
        'early',
        'late',
      ]);
      expect(st().loaded, isTrue);
      expect(st().loading, isFalse);
    });

    test('filter and counts', () async {
      rig.items = [
        ownItem('a', order: 1000),
        ownItem('b', order: 2000, shown: false),
        providerItem('1', order: 3000),
        providerItem('2', order: 4000, shown: false),
        providerItem('3', order: 5000),
      ];
      await ctl().load();
      expect(st().saved, 5);
      expect(st().shown, 3);
      expect(st().fromProvider, 3);
      expect(st().nearLimit, isFalse);
      expect(st().visible, hasLength(5));
      ctl().setFilter(HadisFilter.own);
      expect(st().visible.map((i) => i.id), ['a', 'b']);
      ctl().setFilter(HadisFilter.hadeethenc);
      expect(st().visible.map((i) => i.id), [
        'hadeethenc-1',
        'hadeethenc-2',
        'hadeethenc-3',
      ]);
      ctl().setSortMode(true);
      expect(st().filter, HadisFilter.all);
      expect(st().sortMode, isTrue);
    });

    test('450 or more saved is near the limit', () async {
      rig.items = [for (var i = 0; i < 450; i++) ownItem('o$i', order: i * 1000)];
      await ctl().load();
      expect(st().nearLimit, isTrue);
    });

    test('a box that does not answer, with nothing cached, is an error and an empty list', () async {
      rig.unreachable = true;
      await ctl().load();
      expect(st().items, isEmpty);
      expect(st().error, isA<BoxUnreachable>());
      expect(st().loading, isFalse);
      expect(st().loaded, isFalse);
    });

    test('a box that stops answering shows the last list it gave', () async {
      rig.items = [ownItem('a', order: 1000)];
      await ctl().load();
      rig.unreachable = true;
      await ctl().load();
      expect(st().items, hasLength(1));
      expect(st().loading, isFalse);
    });

    test('items the box says changed at HadeethEnc are flagged', () async {
      rig.items = [providerItem('1', order: 1000), ownItem('a', order: 2000)];
      rig.updates = [
        {
          'itemId': 'hadeethenc-1',
          'providerId': '1',
          'foundAt': 'x',
          'changed': ['textMs'],
          'preview': {'textMs': 'Baharu'},
        },
      ];
      await ctl().load();
      expect(st().updates, {'hadeethenc-1'});
      final tags = ctl().tagsFor(st().items.first);
      expect(tags.map((t) => t.kind), contains(HadisTagKind.textUpdated));
    });
  });

  group('toggleShown', () {
    test('a HadeethEnc hadis sends only shown: what HadeethEnc served is never in the body', () async {
      rig.items = [providerItem('1', order: 1000), ownItem('a', order: 2000)];
      await ctl().load();
      final before = Map<String, dynamic>.from(rig.items.first);
      await ctl().toggleShown('hadeethenc-1');
      final put = rig.requests('PUT', '/api/content/hadis/hadeethenc-1').single;
      final sent = jsonDecode(put.body) as Map<String, dynamic>;
      expect(sent, {'shown': false});
      expect(st().items.first.shown, isFalse);
      // the box kept its own text under the switch
      expect(rig.items.first['textMs'], before['textMs']);
      expect(rig.items.first['shown'], isFalse);
      // and back on
      await ctl().toggleShown('hadeethenc-1');
      expect(st().items.first.shown, isTrue);
      expect(jsonDecode(rig.requests('PUT', '/api/content/hadis/hadeethenc-1').last.body), {'shown': true});
      expect(rig.requests('PUT', '/api/content/hadis/hadeethenc-1'), hasLength(2));
    });

    test('an own hadis still goes back whole with only shown flipped', () async {
      rig.items = [ownItem('a', order: 2000, text: 'Sendiri')];
      await ctl().load();
      await ctl().toggleShown('a');
      final sent = jsonDecode(rig.requests('PUT', '/api/content/hadis/a').single.body) as Map<String, dynamic>;
      expect(sent, {'textMs': 'Sendiri', 'source': 'Riwayat Muslim', 'order': 2000, 'shown': false});
    });

    test('a hadis with a grade the TV never shows cannot be switched on; nothing is sent', () async {
      final dhaif = {...providerItem('1', order: 1000, shown: false), 'grade': 'dhaif'};
      rig.items = [dhaif, providerItem('2', order: 2000)];
      await ctl().load();
      await expectLater(ctl().toggleShown('hadeethenc-1'), throwsA(isA<HadisGradeBlocked>()));
      expect(rig.requests('PUT', '/api/content/hadis/hadeethenc-1'), isEmpty);
      expect(st().items.first.shown, isFalse);
      // another one is still free to switch
      await ctl().toggleShown('hadeethenc-2');
      expect(rig.requests('PUT', '/api/content/hadis/hadeethenc-2'), hasLength(1));
    });

    test('a hadis the box took off the TV for its new grade cannot be switched on either', () async {
      final raw = providerItem('1', order: 1000, shown: true);
      raw['ext'] = {...(raw['ext'] as Map<String, dynamic>), 'blocked': true};
      rig.items = [raw];
      await ctl().load();
      expect(st().items.single.onTv, isFalse);
      await expectLater(ctl().toggleShown('hadeethenc-1'), throwsA(isA<HadisGradeBlocked>()));
      expect(rig.requests('PUT', '/api/content/hadis/hadeethenc-1'), isEmpty);
    });

    test('the count of shown hadis is what the TV shows, not what the switches say', () async {
      final blocked = providerItem('3', order: 3000, shown: true);
      blocked['ext'] = {...(blocked['ext'] as Map<String, dynamic>), 'blocked': true};
      rig.items = [
        providerItem('1', order: 1000),
        {...providerItem('2', order: 2000, shown: true), 'grade': 'dhaif'},
        blocked,
        ownItem('a', order: 4000),
        ownItem('b', order: 5000, shown: false),
      ];
      await ctl().load();
      expect(st().saved, 5);
      expect(st().shown, 2);
    });

    test('a bookkeeping flag from the local copy is not sent', () async {
      rig.items = [
        {...ownItem('a', order: 1000), 'pending': true, 'rev': 'x', '_deleted': false},
      ];
      await ctl().load();
      await ctl().toggleShown('a');
      final sent = jsonDecode(rig.requests('PUT', '/api/content/hadis/a').single.body)
          as Map<String, dynamic>;
      expect(sent.keys.toSet(), {'textMs', 'source', 'order', 'shown'});
    });

    test('a refusal puts the switch back and the error reaches the caller', () async {
      rig.items = [ownItem('a', order: 1000, shown: true)];
      await ctl().load();
      rig.unreachable = true;
      await expectLater(ctl().toggleShown('a'), throwsA(isA<Object>()));
      expect(st().items.single.shown, isTrue);
    });
  });

  group('move', () {
    test('a HadeethEnc hadis moved sends only its new order', () async {
      rig.items = [
        providerItem('1', order: 1000),
        ownItem('b', order: 2000),
        providerItem('3', order: 3000),
      ];
      await ctl().load();
      await ctl().move('hadeethenc-3', -1);
      final sent = jsonDecode(rig.requests('PUT', '/api/content/hadis/hadeethenc-3').single.body) as Map<String, dynamic>;
      expect(sent, {'order': 1500});
    });

    test('the new order is the midpoint of the new neighbours', () async {
      rig.items = [
        ownItem('a', order: 1000),
        ownItem('b', order: 2000),
        ownItem('c', order: 3000),
      ];
      await ctl().load();
      await ctl().move('c', -1);
      expect(st().items.map((i) => i.id), ['a', 'c', 'b']);
      final sent = jsonDecode(rig.requests('PUT', '/api/content/hadis/c').single.body)
          as Map<String, dynamic>;
      expect(sent['order'], 1500);
      expect(rig.requests('PUT', '/api/hadis/order'), isEmpty);
    });

    test('moving to the top or the bottom takes a step of 1000 beyond the edge', () async {
      rig.items = [ownItem('a', order: 1000), ownItem('b', order: 2000)];
      await ctl().load();
      await ctl().move('b', -1);
      expect(st().items.map((i) => i.id), ['b', 'a']);
      expect(
        (jsonDecode(rig.requests('PUT', '/api/content/hadis/b').single.body)
            as Map<String, dynamic>)['order'],
        0,
      );
      await ctl().move('b', 1);
      expect(
        (jsonDecode(rig.requests('PUT', '/api/content/hadis/b').last.body)
            as Map<String, dynamic>)['order'],
        2000,
      );
    });

    test('no room between the neighbours renumbers through /api/hadis/order', () async {
      rig.items = [
        ownItem('a', order: 1000),
        ownItem('b', order: 1001),
        ownItem('c', order: 2000),
      ];
      await ctl().load();
      await ctl().move('c', -1);
      final sent = jsonDecode(rig.requests('PUT', '/api/hadis/order').single.body)
          as Map<String, dynamic>;
      expect(sent['ids'], ['a', 'c', 'b']);
      expect(st().items.map((i) => i.id), ['a', 'c', 'b']);
      expect(st().items.map((i) => i.order), [1000, 2000, 3000]);
    });

    test('a neighbour that never had an order renumbers the list', () async {
      rig.items = [
        ownItem('a', order: 1000),
        ownItem('b', updatedAt: '2026-11-02T00:00:00.000Z'),
        ownItem('c', updatedAt: '2026-11-03T00:00:00.000Z'),
      ];
      await ctl().load();
      await ctl().move('c', -1);
      expect(rig.requests('PUT', '/api/hadis/order'), hasLength(1));
      expect(st().items.map((i) => i.id), ['a', 'c', 'b']);
    });

    test('renumbering with the box away says so and leaves the list as it was', () async {
      rig.items = [ownItem('a', order: 1000), ownItem('b', order: 1001), ownItem('c', order: 1002)];
      await ctl().load();
      rig.unreachable = true;
      await expectLater(ctl().move('c', -1), throwsA(isA<ReorderNeedsConnection>()));
      expect(st().items.map((i) => i.id), ['a', 'b', 'c']);
    });

    test('the first row cannot go up and the last cannot go down', () async {
      rig.items = [ownItem('a', order: 1000), ownItem('b', order: 2000)];
      await ctl().load();
      await ctl().move('a', -1);
      await ctl().move('b', 1);
      expect(rig.box.seen.where((r) => r.method == 'PUT'), isEmpty);
    });
  });

  group('remove', () {
    test('deletes from the MAXCOM list', () async {
      rig.items = [providerItem('1', order: 1000), ownItem('a', order: 2000)];
      await ctl().load();
      await ctl().remove('hadeethenc-1');
      expect(rig.requests('DELETE', '/api/content/hadis/hadeethenc-1'), hasLength(1));
      expect(st().items.map((i) => i.id), ['a']);
    });

    test('a failed delete brings the row back', () async {
      rig.items = [ownItem('a', order: 1000)];
      await ctl().load();
      rig.unreachable = true;
      await expectLater(ctl().remove('a'), throwsA(isA<Object>()));
      expect(st().items.map((i) => i.id), ['a']);
    });
  });

  group('tags', () {
    test('a HadeethEnc row: source, grade, short attribution, long text, hidden', () async {
      rig.items = [providerItem('1', order: 1000, shown: false, text: 'x' * 600)];
      await ctl().load();
      expect(ctl().tagsFor(st().items.single), const [
        HadisTag(HadisTagKind.hadeethenc),
        HadisTag(HadisTagKind.grade, 'Sahih'),
        HadisTag(HadisTagKind.attribution, 'Muttafaq alaih'),
        HadisTag(HadisTagKind.longText),
        HadisTag(HadisTagKind.hidden),
      ]);
    });

    test('a row the box took off the TV for its new grade says why, not just "off"', () async {
      final raw = providerItem('1', order: 1000, shown: true);
      raw['ext'] = {...(raw['ext'] as Map<String, dynamic>), 'blocked': true};
      rig.items = [raw];
      await ctl().load();
      final item = st().items.single;
      expect(item.shown, isTrue);
      expect(item.gradeBlocked, isTrue);
      final kinds = ctl().tagsFor(item).map((t) => t.kind);
      expect(kinds, contains(HadisTagKind.gradeBlocked));
      expect(kinds, isNot(contains(HadisTagKind.hidden)));
    });

    test('a row that is simply switched off still says Mati (success path)', () async {
      rig.items = [providerItem('1', order: 1000, shown: false)];
      await ctl().load();
      final kinds = ctl().tagsFor(st().items.single).map((t) => t.kind);
      expect(kinds, contains(HadisTagKind.hidden));
      expect(kinds, isNot(contains(HadisTagKind.gradeBlocked)));
    });

    test('an own row with no stated source says so; a queued edit is marked', () async {
      rig.items = [
        {...ownItem('a', order: 1000, source: 'Tidak dinyatakan'), 'pending': true},
      ];
      await ctl().load();
      expect(ctl().tagsFor(st().items.single), const [
        HadisTag(HadisTagKind.own),
        HadisTag(HadisTagKind.unstatedSource),
        HadisTag(HadisTagKind.pending),
      ]);
    });
  });

  group('item', () {
    test('toPut for a HadeethEnc hadis holds only shown / order; for an own one the whole item', () {
      final raw = providerItem('1', order: 1000, shown: true);
      expect(HadisItem(raw).toPut(shown: false), {'shown': false});
      expect(HadisItem(raw).toPut(order: 7), {'order': 7});
      expect(HadisItem(raw).toPut(), isEmpty);
      expect(HadisItem(raw).providerId, '1');
      final own = HadisItem(ownItem('a', order: 5, text: 'T')).toPut(shown: true);
      expect(own, {'textMs': 'T', 'source': 'Riwayat Muslim', 'order': 5, 'shown': true});
      expect(HadisItem(ownItem('a')).isProvider, isFalse);
      expect(HadisItem(ownItem('a')).shown, isTrue);
    });
  });
}
