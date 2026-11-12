import 'dart:async';
// `Cari hadis` over a fake box: online state and its polling, the category
// tree, paged category lists, the debounced search, the detail, adding with
// its refusals, and the download job.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/hadis/hadis_api.dart';
import 'package:surau_app/hadis/hadis_list_controller.dart';
import 'package:surau_app/hadis/hadis_search_controller.dart';

import 'hadis_rig.dart';

Map<String, dynamic> cat(String id, String? parent, String ms, int count) => {
  'id': id,
  'parentId': parent,
  'titleMs': ms,
  'titleEn': 'EN $id',
  'count': count,
};

Map<String, dynamic> summary(String id, {bool allowed = true, bool saved = false, String grade = 'sahih'}) => {
  'id': id,
  'title': 'Tajuk $id',
  'grade': grade,
  'gradeAr': 'صحيح',
  'attribution': {'short': 'Muttafaq alaih', 'long': 'Riwayat al-Bukhari dan Muslim'},
  'attributionAr': 'رواه البخاري ومسلم',
  'length': 'short',
  'chars': 100,
  'allowed': allowed,
  'saved': saved,
};

Future<void> pause([int ms = 80]) => Future<void>.delayed(Duration(milliseconds: ms));

void main() {
  late HadisRig rig;

  HadisSearchController ctl() => rig.container.read(hadisSearchProvider.notifier);
  HadisSearchState st() => rig.container.read(hadisSearchProvider);

  setUp(() => rig = HadisRig());
  tearDown(() => rig.dispose());

  group('online state', () {
    test('status carries online, the catalog size, saved and updates', () async {
      rig.catalog = {'entries': 232, 'categories': 133, 'fetchedAt': 'x', 'job': null};
      rig.items = [ownItem('a')];
      await ctl().loadStatus();
      expect(st().status.online, isTrue);
      expect(st().status.entries, 232);
      expect(st().status.saved, 1);
      expect(st().statusLoaded, isTrue);
      expect(st().canAdd, isTrue);
    });

    test('offline disables add', () async {
      rig.online = false;
      await ctl().loadStatus();
      expect(st().status.online, isFalse);
      expect(st().canAdd, isFalse);
      final r = await ctl().add('66512');
      expect(r.failure, AddFailure.sourceUnavailable);
      expect(rig.requests('POST', '/api/hadis/add'), isEmpty);
    });

    test('a box that does not answer is offline too', () async {
      rig.unreachable = true;
      await ctl().loadStatus();
      expect(st().status.online, isFalse);
      expect(st().statusLoaded, isTrue);
    });

    test('is read again every poll while the screen watches, and stops after', () async {
      ctl().watchStatus();
      await pause(30);
      final first = rig.statusCalls;
      expect(first, greaterThanOrEqualTo(1));
      await pause(130);
      expect(rig.statusCalls, greaterThan(first));
      ctl().stopWatchingStatus();
      await pause(20);
      final stopped = rig.statusCalls;
      await pause(120);
      expect(rig.statusCalls, stopped);
    });
  });

  group('categories', () {
    setUp(() {
      rig.categories = [
        cat('1', null, 'Al-Quran dan Ulum Al-Quran', 9),
        cat('2', null, 'Hadis dan Ilmu Hadis', 4),
        cat('8', '1', 'Penurunan Al-Quran', 1),
        cat('17', '8', 'Pengumpulan Al-Quran', 1),
      ];
    });

    test('children, path and lookup', () async {
      await ctl().loadCategories();
      expect(st().categoriesLoaded, isTrue);
      expect(ctl().childrenOf(null).map((c) => c.id), ['1', '2']);
      expect(ctl().childrenOf('1').map((c) => c.id), ['8']);
      expect(ctl().pathOf('17').map((c) => c.titleMs), [
        'Al-Quran dan Ulum Al-Quran',
        'Penurunan Al-Quran',
        'Pengumpulan Al-Quran',
      ]);
      expect(ctl().categoryOf('2')?.titleEn, 'EN 2');
      expect(ctl().pathOf('nope'), isEmpty);
    });

    test('a category lists its hadis page by page', () async {
      rig.categoryItems['17'] = [for (var i = 0; i < 45; i++) summary('${66000 + i}')];
      await ctl().loadCategories();
      await ctl().openCategory('17');
      expect(st().categoryItems, hasLength(30));
      expect(st().categoryTotal, 45);
      expect(st().categoryHasMore, isTrue);
      await ctl().loadMoreCategory();
      expect(st().categoryItems, hasLength(45));
      expect(st().categoryHasMore, isFalse);
      await ctl().loadMoreCategory();
      expect(rig.requests('GET', '/api/hadis/categories/17/items'), hasLength(2));
      ctl().closeCategory();
      expect(st().categoryId, isNull);
      expect(st().categoryItems, isEmpty);
    });

    test('opening a category while an older one is still loading drops the older answer and does not stick on loading', () async {
      rig.categoryItems['17'] = [for (var i = 0; i < 40; i++) summary('${66000 + i}')];
      rig.categoryItems['18'] = [for (var i = 0; i < 5; i++) summary('${67000 + i}')];
      await ctl().loadCategories();
      final gate = Completer<void>();
      rig.categoryGate = gate;
      final first = ctl().openCategory('17');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(st().categoryLoading, isTrue);
      // the person goes on to another category, whose answer comes at once
      rig.categoryGate = null;
      await ctl().openCategory('18');
      expect(st().categoryItems.map((i) => i.id), ['67000', '67001', '67002', '67003', '67004']);
      expect(st().categoryLoading, isFalse);
      // now the first answer arrives: it must change nothing
      gate.complete();
      await first;
      expect(st().categoryId, '18');
      expect(st().categoryItems, hasLength(5));
      expect(st().categoryTotal, 5);
      expect(st().categoryLoading, isFalse);
    });

    test('a next page still coming for an earlier opening of the same category is dropped after it is opened again', () async {
      rig.categoryItems['17'] = [for (var i = 0; i < 70; i++) summary('${66000 + i}')];
      await ctl().loadCategories();
      await ctl().openCategory('17');
      expect(st().categoryItems, hasLength(30));
      final gate = Completer<void>();
      rig.categoryGate = gate;
      final stale = ctl().loadMoreCategory();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(st().categoryLoading, isTrue);
      // closed and opened again while page 2 is on its way
      ctl().closeCategory();
      rig.categoryGate = null;
      await ctl().openCategory('17');
      expect(st().categoryItems, hasLength(30));
      expect(st().categoryLoading, isFalse);
      gate.complete();
      await stale;
      expect(st().categoryItems, hasLength(30));
      expect(st().categoryPage, 1);
      expect(st().categoryLoading, isFalse);
      // success path: the page after the reopened one loads normally
      await ctl().loadMoreCategory();
      expect(st().categoryItems, hasLength(60));
      expect(st().categoryPage, 2);
    });

    test('an unreachable box with nothing cached is an error, not a crash', () async {
      rig.unreachable = true;
      await ctl().loadCategories();
      expect(st().categoriesError, isNotNull);
      expect(st().categoriesLoaded, isFalse);
    });
  });

  group('search', () {
    test('under two characters asks nothing; after the pause it asks once', () async {
      rig.searchResults = [summary('66513')];
      ctl().search('a');
      await pause();
      expect(rig.requests('GET', '/api/hadis/search'), isEmpty);
      expect(st().results, isEmpty);
      ctl().search('am');
      ctl().search('ama');
      ctl().search('amalan');
      await pause();
      final asked = rig.requests('GET', '/api/hadis/search');
      expect(asked, hasLength(1));
      expect(asked.single.url.queryParameters['q'], 'amalan');
      expect(st().results.map((r) => r.id), ['66513']);
      expect(st().searching, isFalse);
      expect(st().query, 'amalan');
    });

    test('a short query clears the results and cancels the pending ask', () async {
      rig.searchResults = [summary('66513')];
      ctl().search('amalan');
      ctl().search('a');
      await pause();
      expect(rig.requests('GET', '/api/hadis/search'), isEmpty);
      expect(st().results, isEmpty);
    });

    test('the query is encoded, never put in the path', () async {
      await ctl().searchNow('solat & puasa');
      final r = rig.requests('GET', '/api/hadis/search').single;
      expect(r.url.queryParameters['q'], 'solat & puasa');
      expect(r.url.path, '/api/hadis/search');
    });

    test('a failure is kept in searchError and ends the busy state', () async {
      rig.unreachable = true;
      await ctl().searchNow('amalan');
      expect(st().searchError, isNotNull);
      expect(st().searching, isFalse);
    });

    test('the summary keeps what the box said about grade and length', () async {
      rig.searchResults = [summary('1', allowed: false, grade: 'dhaif')];
      await ctl().searchNow('lemah');
      final r = st().results.single;
      expect(r.allowed, isFalse);
      expect(r.grade, 'dhaif');
      expect(r.attributionShort, 'Muttafaq alaih');
      expect(r.isLong, isFalse);
    });
  });

  group('detail and add', () {
    setUp(() {
      rig.detail = {
        'id': '66512',
        'title': 'Islam itu dibina',
        'textMs': 'Teks.',
        'introMs': 'Daripada A:',
        'textAr': 'نص',
        'attributionAr': 'رواه البخاري ومسلم',
        'gradeAr': 'صحيح',
        'categories': ['59', '79'],
        'grade': 'sahih',
        'attribution': {'short': 'Muttafaq alaih', 'long': 'Riwayat al-Bukhari dan Muslim'},
        'length': 'short',
        'allowed': true,
        'saved': false,
        'savedItemId': null,
      };
    });

    test('opens the detail with its categories', () async {
      await ctl().openDetail('66512');
      final d = st().detail!;
      expect(d.title, 'Islam itu dibina');
      expect(d.categories, ['59', '79']);
      expect(d.attributionLong, 'Riwayat al-Bukhari dan Muslim');
      expect(d.saved, isFalse);
      ctl().closeDetail();
      expect(st().detail, isNull);
    });

    test('adding sends only the provider and the id, marks the detail saved and reloads the list', () async {
      rig.addStatus = 201;
      rig.addBody = {'item': providerItem('66512', order: 1000)};
      await ctl().openDetail('66512');
      rig.items = [providerItem('66512', order: 1000)];
      final r = await ctl().add('66512');
      expect(r.ok, isTrue);
      expect(r.item?.id, 'hadeethenc-66512');
      final sent = jsonDecode(rig.requests('POST', '/api/hadis/add').single.body) as Map<String, dynamic>;
      expect(sent, {'provider': 'hadeethenc', 'id': '66512'});
      expect(st().detail?.saved, isTrue);
      expect(st().detail?.savedItemId, 'hadeethenc-66512');
      await pause(30);
      expect(rig.container.read(hadisListProvider).items.map((i) => i.id), ['hadeethenc-66512']);
      expect(rig.container.read(hadisSavedIdsProvider), {'66512'});
    });

    for (final c in <(int, String, AddFailure)>[
      (400, 'grade_blocked', AddFailure.gradeBlocked),
      (400, 'too_long', AddFailure.tooLong),
      (400, 'field_too_long', AddFailure.tooLong),
      (409, 'limit_reached', AddFailure.limitReached),
      (503, 'source_unavailable', AddFailure.sourceUnavailable),
      (502, 'source_bad_response', AddFailure.sourceUnavailable),
      (403, 'x', AddFailure.forbidden),
      (400, 'invalid', AddFailure.other),
    ]) {
      test('${c.$1} ${c.$2} is ${c.$3.name}', () async {
        rig.addStatus = c.$1;
        rig.addBody = {'errors': ['Alasan dari MAXCOM'], 'code': c.$2};
        final r = await ctl().add('66512');
        expect(r.ok, isFalse);
        expect(r.failure, c.$3);
        expect(r.message, 'Alasan dari MAXCOM');
      });
    }

    test('an unreachable box is a source problem, not a crash', () async {
      rig.unreachable = true;
      final r = await ctl().add('66512');
      expect(r.failure, AddFailure.sourceUnavailable);
    });
  });

  group('download of the HadeethEnc list', () {
    test('polls the job until done, then reads the status and categories again', () async {
      rig.jobAnswers = [
        {'id': 'j1', 'state': 'running', 'progress': 0.1, 'done': 1, 'total': 10},
        {'id': 'j1', 'state': 'running', 'progress': 0.6, 'done': 6, 'total': 10},
        {'id': 'j1', 'state': 'done', 'progress': 1.0, 'done': 10, 'total': 10},
      ];
      rig.categories = [cat('1', null, 'Al-Quran', 1)];
      await ctl().refresh();
      expect(rig.requests('POST', '/api/hadis/refresh'), hasLength(1));
      expect(rig.requests('GET', '/api/hadis/jobs/j1'), hasLength(3));
      expect(st().job?.state, 'done');
      expect(st().job?.progress, 1.0);
      expect(rig.statusCalls, 1);
      expect(st().categories, hasLength(1));
    });

    test('a failed job keeps its reason', () async {
      rig.jobAnswers = [
        {'id': 'j1', 'state': 'failed', 'progress': 0.2, 'error': 'source_unavailable'},
      ];
      await ctl().refresh();
      expect(st().job?.failed, isTrue);
      expect(st().job?.error, 'source_unavailable');
    });

    test('one already running (409) is followed through the status, not an error', () async {
      rig.refreshStatus = 409;
      await ctl().refresh();
      expect(rig.requests('GET', '/api/hadis/jobs/j1'), isEmpty);
      expect(rig.statusCalls, 1);
    });
  });
}
