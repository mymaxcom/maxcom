// The hadis screens through the real router and providers over a fake box:
// Senarai hadis (switch, bin dialogs, Susun, offline, role gates), Cari hadis
// (categories, search, greyed grades, offline, empty catalog), Butiran (add,
// long note, text update review), Tetapan > Hadis (what is disabled when, the
// save), the TV preview against the rules, and the own-list editor carrying
// `shown` and `order` through. Goldens: hadis_list, hadis_search_categories,
// hadis_search_results, hadis_search_offline, hadis_detail, hadis_settings at
// every size; the dialogs at phone size. The state is the mockup's: 9 items
// (5 HadeethEnc, 5 own less one), 66518 flagged as changed.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/hadis/hadis_list_controller.dart';
import 'package:surau_app/hadis/hadis_search_controller.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/main.dart';
import 'package:surau_app/screens/hadis/widgets/hadis_tv_preview.dart';

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

final Map<String, dynamic> _samples =
    jsonDecode(File('test/fixtures/hadis-samples-ms.json').readAsStringSync()) as Map<String, dynamic>;
final Map<String, String> _catBm = {
  for (final c in jsonDecode(File('../../packages/core/src/content/hadisCategoriesMs.json').readAsStringSync()) as List<dynamic>)
    (c as Map<String, dynamic>)['id'] as String: c['ms'] as String,
};

Map<String, dynamic> _sample(String id) => (_samples['samples'] as List<dynamic>)
    .cast<Map<String, dynamic>>()
    .firstWhere((x) => x['id'] == id);

const _muslim = 'رواه مسلم';
const _t = '2026-11-07T01:00:00.000Z';

Map<String, Object?> _provider(String id, int order, {bool shown = true}) {
  final x = _sample(id);
  final ar = x['attribution'] as String;
  return {
    'id': 'hadeethenc-$id',
    'updatedAt': _t,
    'updatedBy': 'user:u1',
    'textMs': x['hadeeth'],
    'textAr': x['hadeeth_ar'],
    'title': x['title'],
    'source': ar == _muslim ? 'Riwayat Muslim' : 'Muttafaq alaih',
    'grade': 'sahih',
    'shown': shown,
    'order': order,
    'ext': {
      'provider': 'hadeethenc',
      'id': id,
      'attributionAr': ar,
      'gradeAr': x['grade'],
      'categories': x['categories'],
      'fetchedAt': _t,
      'digest': 'a' * 64,
    },
  };
}

Map<String, Object?> _own(String id, int order, String ms, String ar, String source, {bool shown = true}) => {
  'id': id,
  'updatedAt': _t,
  'updatedBy': 'user:u1',
  'textMs': ms,
  'textAr': ar,
  'source': source,
  'shown': shown,
  'order': order,
};

List<Map<String, Object?>> mockupItems() => [
  _provider('66512', 1000),
  _own('s1', 2000, 'Sesungguhnya setiap amalan itu bergantung kepada niat, dan setiap orang hanya mendapat apa yang diniatkannya.', 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى', 'Riwayat al-Bukhari dan Muslim'),
  _provider('66514', 3000),
  _own('s2', 4000, 'Sesiapa yang beriman kepada Allah dan hari akhirat, hendaklah dia berkata baik atau diam.', 'مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الْآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ', 'Riwayat al-Bukhari dan Muslim'),
  _provider('66518', 5000),
  _own('s3', 6000, 'Tidak beriman seseorang daripada kamu sehingga dia mengasihi saudaranya sebagaimana dia mengasihi dirinya sendiri.', 'لَا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لِأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ', 'Riwayat al-Bukhari dan Muslim'),
  _provider('66517', 7000, shown: false),
  _own('s4', 8000, 'Sebaik-baik kamu ialah orang yang mempelajari Al-Quran dan mengajarkannya.', 'خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ', 'Riwayat al-Bukhari'),
  _own('s5', 9000, 'Senyumanmu di hadapan saudaramu adalah sedekah.', 'تَبَسُّمُكَ فِي وَجْهِ أَخِيكَ لَكَ صَدَقَةٌ', 'Riwayat at-Tirmidzi', shown: false),
];

Map<String, Object?> _summary(String id, {bool saved = false, bool allowed = true, String? grade = 'sahih'}) {
  final x = _sample(id);
  final ar = x['attribution'] as String;
  final chars = (x['hadeeth'] as String).length;
  return {
    'id': id,
    'title': x['title'],
    'grade': grade,
    'gradeAr': x['grade'],
    'attribution': ar == _muslim
        ? {'short': 'Riwayat Muslim', 'long': null}
        : {'short': 'Muttafaq alaih', 'long': 'Riwayat al-Bukhari dan Muslim'},
    'attributionAr': ar,
    'length': chars <= 220 ? 'short' : (chars <= 520 ? 'medium' : 'long'),
    'chars': chars,
    'allowed': allowed,
    'saved': saved,
  };
}

Map<String, Object?> _detail(String id, {bool saved = false}) {
  final x = _sample(id);
  final s = _summary(id, saved: saved);
  return {
    ...s,
    'textMs': x['hadeeth'],
    'introMs': null,
    'textAr': x['hadeeth_ar'],
    'categories': x['categories'],
    'savedItemId': saved ? 'hadeethenc-$id' : null,
  };
}

/// Answers `/api/hadis/*` on [h]; every field is mutable through the
/// returned map keys below.
class HadisBox {
  HadisBox(this.h) {
    h.content['hadis'] = items;
    final cats = [
      for (final c in (_samples['categories'] as List<dynamic>).cast<Map<String, dynamic>>())
        {
          'id': c['id'],
          'parentId': c['parent_id'],
          'titleMs': _catBm[c['id']] ?? c['title'],
          'titleEn': c['title'],
          'count': int.parse(c['hadeeths_count'] as String),
        },
    ];
    h.handlers['GET /api/hadis/status'] = (_) async => jsonResponse(200, {
      'online': online,
      'catalog': {'entries': entries, 'categories': 133, 'fetchedAt': _t, 'job': null},
      'saved': items.length,
      'max': 500,
      'updates': updates.length,
    });
    h.handlers['GET /api/hadis/categories'] = (_) async => jsonResponse(200, {'categories': cats});
    h.handlers['GET /api/hadis/categories/88/items'] = (_) async => jsonResponse(200, {
      'items': [_summary('66512', saved: true)],
      'total': 1,
    });
    h.handlers['GET /api/hadis/categories/100/items'] = (_) async => jsonResponse(200, {
      'items': [_summary('66514', saved: true)],
      'total': 1,
    });
    h.handlers['GET /api/hadis/search'] = (r) async {
      searches.add(r.url.queryParameters['q'] ?? '');
      return jsonResponse(200, {'items': results});
    };
    for (final id in const ['66512', '66513', '66514', '66517', '66518']) {
      h.handlers['GET /api/hadis/hadeethenc/$id'] = (_) async => jsonResponse(200, {
        'hadith': _detail(id, saved: items.any((x) => x['id'] == 'hadeethenc-$id')),
      });
    }
    h.handlers['GET /api/hadis/updates'] = (_) async => jsonResponse(200, {'updates': updates});
    h.handlers['POST /api/hadis/add'] = (r) async {
      added.add((jsonDecode(r.body) as Map<String, dynamic>)['id'] as String);
      final item = _provider(added.last, 20000);
      items.add(item);
      return jsonResponse(201, {'item': item});
    };
    h.handlers['POST /api/hadis/hadeethenc-66518/accept-update'] = (_) async {
      accepted++;
      updates.clear();
      return jsonResponse(200, {'item': <String, dynamic>{}, 'gradeBlocked': false});
    };
    h.handlers['POST /api/hadis/refresh'] = (_) async => jsonResponse(202, {'jobId': 'j1'});
    h.handlers['GET /api/hadis/jobs/j1'] = (_) async => jsonResponse(200, {
      'id': 'j1', 'state': 'done', 'progress': 1.0, 'done': 5, 'total': 5,
    });
  }

  final ShellHarness h;
  final List<Map<String, Object?>> items = mockupItems();
  bool online = true;
  int entries = 232;
  int accepted = 0;
  final List<String> added = [];
  final List<String> searches = [];
  List<Map<String, Object?>> results = [_summary('66513'), _summary('66514', saved: true)];
  final List<Map<String, Object?>> updates = [
    {
      'itemId': 'hadeethenc-66518',
      'providerId': '66518',
      'foundAt': _t,
      'changed': ['textMs'],
      'preview': {'textMs': 'Teks baharu dari HadeethEnc.'},
    },
  ];

  List<http.Request> requests(String method, String path) => [
    for (final r in h.box.seen)
      if (r.method == method && r.url.path == path) r,
  ];
}

Future<(ShellHarness, HadisBox)> open(
  WidgetTester tester,
  String path, {
  List<String> roles = const ['admin'],
  GoldenSize size = GoldenSize.phone,
  void Function(HadisBox box)? setup,
}) async {
  final h = ShellHarness(roles: roles);
  final box = HadisBox(h);
  setup?.call(box);
  h.unlock();
  await pumpAtSize(tester, h.app, size);
  h.router.go(path);
  await settle(tester);
  return (h, box);
}

Finder byK(String key) => find.byKey(ValueKey(key));

Future<void> matchesAtEverySize(WidgetTester tester, ShellHarness h, String name) async {
  for (final size in GoldenSize.values) {
    await pumpAtSize(tester, h.app, size);
    await settle(tester);
    await expectLater(find.byWidget(h.app), matchesGoldenFile('${name}_${size.name}.png'));
  }
}

const _list = '/content/hadis';
const _cari = '/content/hadis/cari';

void main() {
  group('Senarai hadis', () {
    testWidgets('shows the saved list as drawn', (tester) async {
      final (h, _) = await open(tester, _list);
      expect(find.text('disimpan di MAXCOM'), findsOneWidget);
      expect(find.text('Teks dikemas kini'), findsOneWidget);
      expect(find.text('Mati'), findsNWidgets(2));
      await matchesAtEverySize(tester, h, 'hadis_list');
    });

    testWidgets('the bin on an own item asks in red and Buang kekal deletes it', (tester) async {
      final (h, box) = await open(tester, _list);
      await reveal(tester, byK('hadis-bin-s1'));
      await tester.tap(byK('hadis-bin-s1'));
      await settle(tester);
      expect(find.text('Buang hadis ini?'), findsOneWidget);
      expect(find.textContaining('Kekal, tidak boleh dibatalkan.'), findsOneWidget);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('hadis_remove_own_phone.png'));
      await tester.tap(find.text('Buang kekal'));
      await settle(tester);
      expect(box.requests('DELETE', '/api/content/hadis/s1'), hasLength(1));
      expect(find.byKey(const ValueKey('hadis-row-s1')), findsNothing);
    });

    testWidgets('the bin on a HadeethEnc item is teal, says it can come back, Batal keeps it', (tester) async {
      final (h, box) = await open(tester, _list);
      await reveal(tester, byK('hadis-bin-hadeethenc-66512'));
      await tester.tap(byK('hadis-bin-hadeethenc-66512'));
      await settle(tester);
      expect(find.textContaining('boleh ditambah semula dari Cari hadis'), findsOneWidget);
      expect(find.text('Buang kekal'), findsNothing);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('hadis_remove_provider_phone.png'));
      await tester.tap(find.text('Batal'));
      await settle(tester);
      expect(box.requests('DELETE', '/api/content/hadis/hadeethenc-66512'), isEmpty);
      await reveal(tester, byK('hadis-bin-hadeethenc-66512'));
      await tester.tap(byK('hadis-bin-hadeethenc-66512'));
      await settle(tester);
      await tester.tap(byK('hadis-remove-confirm'));
      await settle(tester);
      expect(box.requests('DELETE', '/api/content/hadis/hadeethenc-66512'), hasLength(1));
    });

    testWidgets('the switch of a HadeethEnc hadis sends only shown', (tester) async {
      final (_, box) = await open(tester, _list);
      final sw = byK('hadis-switch-hadeethenc-66512');
      await reveal(tester, sw);
      await tester.tap(sw);
      await settle(tester);
      final puts = box.requests('PUT', '/api/content/hadis/hadeethenc-66512');
      expect(puts, hasLength(1));
      final body = jsonDecode(puts.single.body) as Map<String, dynamic>;
      expect(body, {'shown': false});
    });

    testWidgets('Susun swaps switches for arrows, an arrow writes a midpoint, Siap returns', (tester) async {
      final (_, box) = await open(tester, _list);
      await tester.tap(find.text('Susun'));
      await settle(tester);
      expect(find.byType(Switch), findsNothing);
      expect(find.text('Siap'), findsOneWidget);
      expect(tester.widget<IconButton>(byK('hadis-up-hadeethenc-66512')).onPressed, isNull);
      await reveal(tester, byK('hadis-down-hadeethenc-66512'));
      await tester.tap(byK('hadis-down-hadeethenc-66512'));
      await settle(tester);
      final body = jsonDecode(box.requests('PUT', '/api/content/hadis/hadeethenc-66512').single.body) as Map<String, dynamic>;
      expect(body['order'], 2500);
      await tester.tap(find.text('Siap'));
      await settle(tester);
      expect(find.byType(Switch), findsWidgets);
      expect(find.text('Susun'), findsOneWidget);
    });

    testWidgets('a move with no room left needs the box; the message is the arb one', (tester) async {
      final (h, box) = await open(tester, _list);
      box.items[0]['order'] = 1000;
      box.items[1]['order'] = 1001;
      box.items[2]['order'] = 1002;
      await tester.pump();
      await tester.tap(find.text('Susun'));
      await settle(tester);
      // the list on screen was loaded earlier: force a fresh read
      h.handlers['PUT /api/hadis/order'] = (_) async => throw http.ClientException('away');
      final notifier = h.container.read(hadisListProvider.notifier);
      await notifier.load();
      await settle(tester);
      await reveal(tester, byK('hadis-down-hadeethenc-66512'));
      await tester.tap(byK('hadis-down-hadeethenc-66512'));
      await settle(tester);
      expect(find.text('Susun semula perlukan sambungan ke MAXCOM'), findsOneWidget);
    });

    testWidgets('offline: Cari hadis is disabled, the help line shows, Tambah sendiri stays', (tester) async {
      final (h, _) = await open(tester, _list, setup: (b) => b.online = false);
      expect(tester.widget<FilledButton>(byK('hadis-cari')).onPressed, isNull);
      expect(find.textContaining('Cari hadis perlukan internet'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(byK('hadis-tambah')).onPressed, isNotNull);
      expect(find.text('MAXCOM tiada internet.', findRichText: true), findsNothing);
      await reveal(tester, byK('hadis-switch-hadeethenc-66512'));
      expect(h.location, _list);
    });

    testWidgets('an AJK (read-only) sees the list with no switch, no bin, no Cari hadis', (tester) async {
      await open(tester, _list, roles: const ['ajk']);
      expect(find.byType(Switch), findsNothing);
      expect(byK('hadis-bin-s1'), findsNothing);
      expect(byK('hadis-cari'), findsNothing);
      expect(byK('hadis-tambah'), findsNothing);
      expect(find.text('Susun'), findsNothing);
      expect(find.textContaining('hidup di TV'), findsOneWidget);
    });

    testWidgets('Hampir penuh shows from 450 saved', (tester) async {
      await open(tester, _list, setup: (b) {
        b.items.addAll([
          for (var i = 0; i < 441; i++)
            _own('x$i', 10000 + i, 'Hadis ke-$i.', '', 'Riwayat Muslim'),
        ]);
      });
      expect(find.text('Hampir penuh (450/500)'), findsOneWidget);
    });

    testWidgets('a provider row opens its detail; an own row opens the editor', (tester) async {
      final (h, _) = await open(tester, _list);
      await tester.tap(find.textContaining('Islam itu dibina').first);
      await settle(tester);
      expect(h.location, '/content/hadis/cari/66512');
      h.router.go(_list);
      await settle(tester);
      await reveal(tester, find.textContaining('Tidak beriman').first);
      await tester.tap(find.textContaining('Tidak beriman').first);
      await settle(tester);
      expect(h.location, '/content/hadis/s3');
    });

    testWidgets('Tambah sendiri goes to the own-list editor', (tester) async {
      final (h, _) = await open(tester, _list);
      await tester.tap(byK('hadis-tambah'));
      await settle(tester);
      expect(h.location, '/content/hadis/new');
    });
  });

  group('the own-list editor keeps what the list set', () {
    testWidgets('editing a hidden own hadis sends shown and order back', (tester) async {
      final (h, box) = await open(tester, '/content/hadis/s5');
      await tester.enterText(byK('field-source'), 'Riwayat al-Tirmizi');
      await tester.pump();
      await tester.tap(byK('content-save'));
      await settle(tester);
      final body = jsonDecode(box.requests('PUT', '/api/content/hadis/s5').single.body) as Map<String, dynamic>;
      expect(body['source'], 'Riwayat al-Tirmizi');
      expect(body['textMs'], startsWith('Senyumanmu'));
      expect(body['shown'], false);
      expect(body['order'], 9000);
      expect(h.location, _list);
      expect(find.textContaining('Riwayat al-Tirmizi'), findsOneWidget);
    });

    testWidgets('a hadis without those keys does not gain them', (tester) async {
      final (_, box) = await open(tester, '/content/hadis/s9', setup: (b) {
        b.items.add({
          'id': 's9',
          'updatedAt': _t,
          'updatedBy': 'user:u1',
          'textMs': 'Hadis lama.',
          'source': 'Tidak dinyatakan',
        });
      });
      await tester.enterText(byK('field-source'), 'Riwayat Muslim');
      await tester.pump();
      await tester.tap(byK('content-save'));
      await settle(tester);
      final body = jsonDecode(box.requests('PUT', '/api/content/hadis/s9').single.body) as Map<String, dynamic>;
      expect(body.containsKey('shown'), isFalse);
      expect(body.containsKey('order'), isFalse);
    });

    testWidgets('a new own hadis sends only its three fields', (tester) async {
      final (h, _) = await open(tester, '/content/hadis/new');
      await tester.enterText(byK('field-textMs'), 'Hadis baharu.');
      await tester.enterText(byK('field-source'), 'Riwayat Muslim');
      await tester.pump();
      await tester.tap(byK('content-save'));
      await settle(tester);
      final put = h.box.seen.lastWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/hadis/'));
      final body = jsonDecode(put.body) as Map<String, dynamic>;
      expect(body.keys.toSet(), {'textMs', 'source'});
    });

    testWidgets('a provider hadis opened by address is read-only', (tester) async {
      await open(tester, '/content/hadis/hadeethenc-66512');
      expect(byK('content-save'), findsNothing);
    });
  });

  group('Cari hadis', () {
    testWidgets('the seven roots, then a category with crumbs, BM name and API name', (tester) async {
      final (h, _) = await open(tester, _cari);
      expect(find.text('Al-Quran dan Ulum Al-Quran'), findsOneWidget);
      expect(find.text('Semua kategori'), findsOneWidget);
      await matchesAtEverySize(tester, h, 'hadis_search_categories');
    });

    testWidgets('opening a leaf lists its hadis; a row opens the detail on a phone', (tester) async {
      final (h, box) = await open(tester, '/content/hadis/cari');
      final search = h.container.read(hadisSearchProvider.notifier);
      await search.openCategory('88');
      await settle(tester);
      expect(find.textContaining('Islam itu dibina'), findsOneWidget);
      expect(find.text('Sudah di kiosk'), findsOneWidget);
      expect(byK('hadis-cat-header'), findsOneWidget);
      expect(find.textContaining('Nama asal dari API'), findsOneWidget);
      await tester.tap(find.textContaining('Islam itu dibina'));
      await settle(tester);
      expect(h.location, '/content/hadis/cari/66512');
      expect(box.requests('GET', '/api/hadis/hadeethenc/66512'), hasLength(1));
    });

    testWidgets('a suggestion searches once; results are tagged; a golden with the detail open on iPad', (tester) async {
      final (h, box) = await open(tester, _cari);
      await tester.tap(byK('hadis-tab-results'));
      await settle(tester);
      await tester.tap(byK('hadis-suggest-amalan'));
      await settle(tester);
      expect(box.searches, ['amalan']);
      expect(find.textContaining('2 hasil'), findsOneWidget);
      expect(find.text('Panjang untuk TV'), findsOneWidget);
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await settle(tester);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('hadis_search_results_phone.png'));
      for (final size in const [GoldenSize.ipadMiniPortrait, GoldenSize.ipadMiniLandscape]) {
        await pumpAtSize(tester, h.app, size);
        await settle(tester);
        if (size == GoldenSize.ipadMiniLandscape) {
          // two columns: the hadis opens beside the list
          await tester.tap(byK('hadis-result-66513'));
          await settle(tester);
          expect(byK('hadis-add'), findsOneWidget);
          expect(h.location, _cari);
        }
        await expectLater(find.byWidget(h.app), matchesGoldenFile('hadis_search_results_${size.name}.png'));
      }
    });

    testWidgets('a typed search under two letters asks nothing', (tester) async {
      final (_, box) = await open(tester, _cari);
      await tester.enterText(byK('hadis-search'), 'a');
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);
      expect(box.searches, isEmpty);
      await tester.enterText(byK('hadis-search'), 'amalan');
      await tester.pump(const Duration(seconds: 1));
      await settle(tester);
      expect(box.searches, ['amalan']);
    });

    testWidgets('a blocked or unknown grade is greyed and cannot be opened', (tester) async {
      final (h, _) = await open(tester, _cari, setup: (b) {
        b.results = [
          {..._summary('66512'), 'id': '9', 'grade': 'dhaif', 'allowed': false},
          {..._summary('66513'), 'id': '8', 'grade': null, 'allowed': false},
        ];
      });
      await tester.tap(byK('hadis-suggest-amalan').hitTestable().evaluate().isEmpty ? byK('hadis-tab-results') : byK('hadis-suggest-amalan'));
      await settle(tester);
      if (byK('hadis-suggest-amalan').evaluate().isNotEmpty) {
        await tester.tap(byK('hadis-suggest-amalan'));
        await settle(tester);
      }
      expect(find.text('Darjat tidak dibenarkan'), findsOneWidget);
      expect(find.text('Darjat tidak dikenali'), findsOneWidget);
      await tester.tap(byK('hadis-result-blocked-9'));
      await settle(tester);
      expect(h.location, _cari);
    });

    testWidgets('offline: the Carian perlukan internet card with its two ways out', (tester) async {
      final (h, _) = await open(tester, _cari, setup: (b) => b.online = false);
      expect(byK('hadis-offline-card'), findsOneWidget);
      expect(find.text('Carian perlukan internet'), findsOneWidget);
      await matchesAtEverySize(tester, h, 'hadis_search_offline');
      await tester.tap(byK('hadis-offline-retry'));
      await settle(tester);
      expect(find.textContaining('Masih tiada internet'), findsOneWidget);
      await tester.tap(byK('hadis-manage-saved'));
      await settle(tester);
      expect(h.location, _list);
    });

    testWidgets('an empty catalog offers the download only with islamic:fetch', (tester) async {
      final (_, box) = await open(tester, _cari, setup: (b) => b.entries = 0);
      expect(find.text('Senarai hadis HadeethEnc belum dimuat turun'), findsOneWidget);
      await tester.tap(byK('hadis-download'));
      await settle(tester);
      expect(box.requests('POST', '/api/hadis/refresh'), hasLength(1));
      expect(box.requests('GET', '/api/hadis/jobs/j1'), isNotEmpty);
    });

    testWidgets('an AJK with content access only gets no download button', (tester) async {
      await open(tester, _cari, roles: const ['media'], setup: (b) => b.entries = 0);
      expect(byK('hadis-download'), findsNothing);
      expect(find.textContaining('Minta Pentadbir'), findsOneWidget);
    });
  });

  group('Butiran hadis', () {
    const detail = '/content/hadis/cari/66513';

    testWidgets('shows text, Arabic, grade, attribution, categories, long note, preview', (tester) async {
      final (h, _) = await open(tester, detail);
      expect(find.textContaining('HADIS 66513'), findsOneWidget);
      expect(find.text('Terjemahan Bahasa Melayu'), findsOneWidget);
      await reveal(tester, byK('hadis-long-note'));
      expect(find.textContaining('aksara'), findsOneWidget);
      expect(byK('hadis-detail-preview'), findsOneWidget);
      await matchesAtEverySize(tester, h, 'hadis_detail');
    });

    testWidgets('Tambah ke kiosk adds, then shows Sudah di kiosk', (tester) async {
      final (_, box) = await open(tester, detail);
      await tester.tap(byK('hadis-add'));
      await settle(tester);
      expect(box.added, ['66513']);
      expect(byK('hadis-saved'), findsOneWidget);
      expect(find.text('Hadis ditambah ke kiosk'), findsOneWidget);
    });

    testWidgets('a refusal says why in BM and adds nothing', (tester) async {
      final (h, _) = await open(tester, detail);
      h.handlers['POST /api/hadis/add'] = (_) async => jsonResponse(400, {
        'errors': ['too_long'],
        'code': 'too_long',
      });
      await tester.tap(byK('hadis-add'));
      await settle(tester);
      expect(find.text('Teks terlalu panjang untuk MAXCOM'), findsOneWidget);
      expect(byK('hadis-saved'), findsNothing);
    });

    testWidgets('offline: the add button is disabled with the line under it', (tester) async {
      await open(tester, detail, setup: (b) => b.online = false);
      expect(tester.widget<FilledButton>(byK('hadis-add')).onPressed, isNull);
      expect(find.text('Tambah perlukan internet melalui MAXCOM.'), findsOneWidget);
    });

    testWidgets('saved: Buang asks, removes, and the add button comes back', (tester) async {
      final (_, box) = await open(tester, '/content/hadis/cari/66512');
      expect(byK('hadis-saved'), findsOneWidget);
      await tester.tap(byK('hadis-detail-remove'));
      await settle(tester);
      await tester.tap(byK('hadis-remove-confirm'));
      await settle(tester);
      expect(box.requests('DELETE', '/api/content/hadis/hadeethenc-66512'), hasLength(1));
      expect(byK('hadis-add'), findsOneWidget);
    });

    testWidgets('the Arabic switch hides the Arabic card', (tester) async {
      await open(tester, '/content/hadis/cari/66512');
      await reveal(tester, byK('hadis-show-arabic'));
      await tester.tap(byK('hadis-show-arabic'));
      await settle(tester);
      expect(find.textContaining('Teks Arab disembunyikan'), findsOneWidget);
    });

    testWidgets('a changed text: Semak shows the new text, Guna teks baharu accepts it', (tester) async {
      final (h, box) = await open(tester, '/content/hadis/cari/66518');
      await reveal(tester, byK('hadis-review-update'));
      await tester.tap(byK('hadis-review-update'));
      await settle(tester);
      expect(find.text('Teks dikemas kini di HadeethEnc'), findsOneWidget);
      expect(find.text('Teks baharu dari HadeethEnc.'), findsOneWidget);
      await expectLater(find.byWidget(h.app), matchesGoldenFile('hadis_update_dialog_phone.png'));
      await tester.tap(find.text('Kekal teks lama'));
      await settle(tester);
      expect(box.accepted, 0);
      await reveal(tester, byK('hadis-review-update'));
      await tester.tap(byK('hadis-review-update'));
      await settle(tester);
      await tester.tap(byK('hadis-update-use'));
      await settle(tester);
      expect(box.accepted, 1);
      expect(find.textContaining('Teks baharu digunakan'), findsOneWidget);
      expect(byK('hadis-update-note'), findsNothing);
    });
  });

  group('Tetapan > Hadis', () {
    const settings = '/settings/hadis';

    testWidgets('as drawn; no MyHadith anywhere', (tester) async {
      final (h, _) = await open(tester, settings);
      expect(find.textContaining('MyHadith'), findsNothing);
      expect(find.textContaining('JAKIM'), findsNothing);
      expect(find.text('Senarai sendiri'), findsWidgets);
      await matchesAtEverySize(tester, h, 'hadis_settings');
    });

    testWidgets('no source file of the app names MyHadith', (tester) async {
      final offenders = <String>[];
      for (final f in Directory('lib/screens/hadis').listSync(recursive: true).whereType<File>()) {
        if (f.readAsStringSync().toLowerCase().contains('myhadith')) offenders.add(f.path);
      }
      expect(offenders, isEmpty);
    });

    testWidgets('Berselang-seli is disabled unless the source is Kedua-dua', (tester) async {
      final (h, _) = await open(tester, settings);
      await reveal(tester, byK('hadis-mix-alternate'));
      await tester.tap(byK('hadis-mix-alternate'));
      await settle(tester);
      expect(find.textContaining('Satu dari senarai sendiri'), findsOneWidget);
      await reveal(tester, byK('hadis-src-own'));
      await tester.tap(byK('hadis-src-own'));
      await settle(tester);
      expect(find.textContaining('Satu dari senarai sendiri'), findsNothing);
      await reveal(tester, byK('hadis-mix-random'));
      await tester.tap(byK('hadis-mix-alternate'));
      await settle(tester);
      expect(h.settings['hadis'], isNot(contains('mix')));
    });

    testWidgets('Bilangan hadis sehari is greyed under Setiap paparan', (tester) async {
      await open(tester, settings);
      await reveal(tester, byK('hadis-per-plus'));
      await tester.tap(byK('hadis-per-plus'));
      await settle(tester);
      expect(find.text('4'), findsOneWidget);
      await reveal(tester, byK('hadis-change-card'));
      await tester.tap(byK('hadis-change-card'));
      await settle(tester);
      expect(find.textContaining('Tidak terpakai'), findsOneWidget);
      await reveal(tester, byK('hadis-per-plus'));
      await tester.tap(byK('hadis-per-plus'));
      await settle(tester);
      expect(find.text('4'), findsOneWidget);
      expect(tester.widget<Opacity>(find.ancestor(of: byK('hadis-per-plus'), matching: find.byType(Opacity)).first).opacity, 0.45);
    });

    testWidgets('the card time steps by five inside 5 to 120', (tester) async {
      await open(tester, settings);
      await reveal(tester, byK('hadis-dur-plus'));
      await tester.tap(byK('hadis-dur-plus'));
      await settle(tester);
      expect(find.text('25 saat'), findsOneWidget);
    });

    testWidgets('Kredit sumber is locked on; Dhaif and Palsu are locked off', (tester) async {
      await open(tester, settings);
      await reveal(tester, byK('hadis-field-credit'));
      final credit = tester.widget<Switch>(byK('hadis-field-credit'));
      expect(credit.value, isTrue);
      expect(credit.onChanged, isNull);
      await reveal(tester, byK('hadis-grade-dhaif'));
      final dhaif = tester.widget<Switch>(byK('hadis-grade-dhaif'));
      expect(dhaif.value, isFalse);
      expect(dhaif.onChanged, isNull);
    });

    testWidgets('Simpan sends only what changed; a nested grade keeps its map', (tester) async {
      final (h, box) = await open(tester, settings);
      await reveal(tester, byK('hadis-grade-sahih_lighairihi'));
      await tester.tap(byK('hadis-grade-sahih_lighairihi'));
      await settle(tester);
      await tester.tap(byK('feature-save'));
      await settle(tester);
      final put = box.requests('PUT', '/api/settings/hadis').single;
      expect(jsonDecode(put.body), {
        'allowedGrades': {'sahih_lighairihi': true},
      });
      expect(find.text('Tetapan hadis disimpan ke MAXCOM. TV dikemas kini dalam beberapa saat.'), findsOneWidget);
      expect((h.settings['hadis'] as Map)['allowedGrades'], containsPair('sahih_lighairihi', true));
    });

    testWidgets('Hari ini di TV follows the form: own only drops the HadeethEnc rows; empty says so', (tester) async {
      await open(tester, settings);
      await reveal(tester, byK('hadis-src-hadeethenc'));
      await tester.tap(byK('hadis-src-hadeethenc'));
      await settle(tester);
      await reveal(tester, byK('hadis-today'));
      final today = find.descendant(of: byK('hadis-today'), matching: find.text('Senarai sendiri'));
      expect(today, findsNothing);
      await reveal(tester, byK('hadis-field-showArabic'));
      for (final key in const ['sahih', 'hasan']) {
        await reveal(tester, byK('hadis-grade-$key'));
        await tester.tap(byK('hadis-grade-$key'));
        await settle(tester);
      }
      await reveal(tester, byK('hadis-today'));
      expect(find.text('Tiada hadis hidup untuk sumber ini. Kad hadis dilangkau di TV.'), findsOneWidget);
    });

    testWidgets('a person without settings:write sees it read-only with no Simpan', (tester) async {
      await open(tester, settings, roles: const ['ajk']);
      expect(byK('feature-save'), findsNothing);
      await reveal(tester, byK('hadis-field-showArabic'));
      expect(tester.widget<Switch>(byK('hadis-field-showArabic')).onChanged, isNull);
    });
  });

  group('TV preview mirrors the rules', () {
    late ShellHarness rig;
    setUp(() => rig = ShellHarness(roles: const ['admin']));

    Future<void> pumpPreview(WidgetTester tester, HadisPreviewData data, Map<String, dynamic> settings) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: rig.container,
          child: MaterialApp(
            theme: SurauTheme.light(),
            locale: defaultLocale,
            localizationsDelegates: S.localizationsDelegates,
            supportedLocales: S.supportedLocales,
            home: Scaffold(
              body: SizedBox(width: 800, child: HadisTvPreview(data: data, settings: settings)),
            ),
          ),
        ),
      );
      await settle(tester);
    }

    final long = HadisPreviewData(
      textMs: _sample('66513')['hadeeth'] as String,
      textAr: _sample('66513')['hadeeth_ar'] as String,
      gradeText: 'Sahih',
      attribution: 'Muttafaq alaih',
      attributionLong: 'Riwayat al-Bukhari dan Muslim',
      credit: true,
    );

    testWidgets('a long hadis shows part 1 with four lines, no Arabic', (tester) async {
      await pumpPreview(tester, long, const {});
      expect(byK('hadis-tv-ar'), findsNothing);
      expect(find.textContaining('Bahagian 1 daripada'), findsOneWidget);
      final ms = tester.widget<Text>(byK('hadis-tv-ms'));
      expect(ms.maxLines, 4);
      expect(ms.style!.fontSize, closeTo(1.5 * 8, 0.01));
      expect(find.textContaining('Muttafaq alaih (al-Bukhari dan Muslim)'), findsOneWidget);
      expect(find.text('Sumber: HadeethEnc.com'), findsOneWidget);
    });

    testWidgets('a short hadis is one card with the Arabic; fields switch off', (tester) async {
      const short = HadisPreviewData(
        textMs: 'Senyumanmu di hadapan saudaramu adalah sedekah.',
        textAr: 'تبسمك في وجه أخيك لك صدقة',
        gradeText: 'Sahih',
        attribution: 'Riwayat Muslim',
      );
      await pumpPreview(tester, short, const {});
      expect(find.textContaining('Bahagian'), findsNothing);
      expect(byK('hadis-tv-ar'), findsOneWidget);
      expect(find.text('Sahih'), findsOneWidget);
      expect(find.text('Sumber: HadeethEnc.com'), findsNothing);
      await pumpPreview(tester, short, const {'showArabic': false, 'showGrade': false, 'showAttribution': false});
      expect(byK('hadis-tv-ar'), findsNothing);
      expect(find.text('Sahih'), findsNothing);
      expect(find.text('Riwayat Muslim'), findsNothing);
    });

    testWidgets('Malay hides only when the Arabic stands in for it', (tester) async {
      const data = HadisPreviewData(textMs: 'Teks pendek.', textAr: 'نص');
      await pumpPreview(tester, data, const {'showMalay': false});
      expect(byK('hadis-tv-ms'), findsNothing);
      await pumpPreview(tester, const HadisPreviewData(textMs: 'Teks pendek.'), const {'showMalay': false});
      expect(byK('hadis-tv-ms'), findsOneWidget);
    });
  });
}
