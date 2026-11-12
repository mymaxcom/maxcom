// The state behind `Cari hadis`: whether the box reaches HadeethEnc, the
// category tree (BM names), paged category lists, the debounced search over
// the box's local catalog, the detail of one hadis, adding it to the kiosk,
// and the download of the HadeethEnc list. The phone never asks HadeethEnc
// anything: every read here is a question to the box.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../box/box_client.dart';
import 'hadis_api.dart';
import 'hadis_list_controller.dart';
import 'hadis_providers.dart';

/// A search starts from this many characters (the box refuses fewer).
const int minSearchChars = 2;

class HadisSearchState {
  const HadisSearchState({
    this.status = HadisStatus.unknown,
    this.statusLoaded = false,
    this.categories = const [],
    this.categoriesLoaded = false,
    this.categoriesError,
    this.query = '',
    this.results = const [],
    this.searching = false,
    this.searchError,
    this.categoryId,
    this.categoryItems = const [],
    this.categoryTotal = 0,
    this.categoryPage = 0,
    this.categoryLoading = false,
    this.categoryError,
    this.detail,
    this.detailLoading = false,
    this.detailError,
    this.job,
    this.jobError,
  });

  final HadisStatus status;
  final bool statusLoaded;
  final List<HeCategory> categories;
  final bool categoriesLoaded;
  final Object? categoriesError;
  final String query;
  final List<HeSummary> results;
  final bool searching;
  final Object? searchError;
  final String? categoryId;
  final List<HeSummary> categoryItems;
  final int categoryTotal;
  final int categoryPage;
  final bool categoryLoading;
  final Object? categoryError;
  final HeDetail? detail;
  final bool detailLoading;
  final Object? detailError;
  final HadisJob? job;
  final Object? jobError;

  /// Adding needs the box online; until the first answer it is allowed.
  bool get canAdd => !statusLoaded || status.online;

  bool get categoryHasMore => categoryItems.length < categoryTotal;

  HadisSearchState copyWith({
    HadisStatus? status,
    bool? statusLoaded,
    List<HeCategory>? categories,
    bool? categoriesLoaded,
    Object? categoriesError,
    bool clearCategoriesError = false,
    String? query,
    List<HeSummary>? results,
    bool? searching,
    Object? searchError,
    bool clearSearchError = false,
    String? categoryId,
    bool clearCategory = false,
    List<HeSummary>? categoryItems,
    int? categoryTotal,
    int? categoryPage,
    bool? categoryLoading,
    Object? categoryError,
    bool clearCategoryError = false,
    HeDetail? detail,
    bool clearDetail = false,
    bool? detailLoading,
    Object? detailError,
    bool clearDetailError = false,
    HadisJob? job,
    bool clearJob = false,
    Object? jobError,
    bool clearJobError = false,
  }) => HadisSearchState(
    status: status ?? this.status,
    statusLoaded: statusLoaded ?? this.statusLoaded,
    categories: categories ?? this.categories,
    categoriesLoaded: categoriesLoaded ?? this.categoriesLoaded,
    categoriesError: clearCategoriesError
        ? null
        : (categoriesError ?? this.categoriesError),
    query: query ?? this.query,
    results: results ?? this.results,
    searching: searching ?? this.searching,
    searchError: clearSearchError ? null : (searchError ?? this.searchError),
    categoryId: clearCategory ? null : (categoryId ?? this.categoryId),
    categoryItems: categoryItems ?? this.categoryItems,
    categoryTotal: categoryTotal ?? this.categoryTotal,
    categoryPage: categoryPage ?? this.categoryPage,
    categoryLoading: categoryLoading ?? this.categoryLoading,
    categoryError: clearCategoryError
        ? null
        : (categoryError ?? this.categoryError),
    detail: clearDetail ? null : (detail ?? this.detail),
    detailLoading: detailLoading ?? this.detailLoading,
    detailError: clearDetailError ? null : (detailError ?? this.detailError),
    job: clearJob ? null : (job ?? this.job),
    jobError: clearJobError ? null : (jobError ?? this.jobError),
  );
}

class HadisSearchController extends Notifier<HadisSearchState> {
  Timer? _statusTimer;
  Timer? _debounce;

  /// Bumped by every search; an answer to an older one is dropped.
  int _searchSeq = 0;

  /// Bumped when a category is opened or closed; a page that was asked for
  /// under an earlier value is dropped when it arrives.
  int _categorySeq = 0;

  @override
  HadisSearchState build() {
    ref.onDispose(() {
      _statusTimer?.cancel();
      _debounce?.cancel();
    });
    return const HadisSearchState();
  }

  HadisRepository? get _repo => ref.read(hadisRepositoryProvider);

  // ---- online state ----

  Future<void> loadStatus() async {
    final repo = _repo;
    if (repo == null) return;
    final status = await repo.status();
    if (!ref.mounted) return;
    state = state.copyWith(
      status: status,
      statusLoaded: true,
      job: status.job ?? state.job,
    );
  }

  /// Reads the online state now and again every 30 seconds until
  /// [stopWatchingStatus] (the screen is open).
  void watchStatus() {
    _statusTimer?.cancel();
    unawaited(loadStatus());
    _statusTimer = Timer.periodic(
      ref.read(hadisTimingProvider).statusPoll,
      (_) => unawaited(loadStatus()),
    );
  }

  void stopWatchingStatus() {
    _statusTimer?.cancel();
    _statusTimer = null;
  }

  // ---- categories ----

  Future<void> loadCategories() async {
    final repo = _repo;
    if (repo == null) return;
    try {
      final cats = await repo.categories();
      if (!ref.mounted) return;
      state = state.copyWith(
        categories: cats,
        categoriesLoaded: true,
        clearCategoriesError: true,
      );
    } on SessionExpired {
      rethrow;
    } on Object catch (e) {
      if (ref.mounted) state = state.copyWith(categoriesError: e);
    }
  }

  /// Children of [parent] (the roots for null), in the box's order.
  List<HeCategory> childrenOf(String? parent) => [
    for (final c in state.categories)
      if (c.parentId == parent) c,
  ];

  HeCategory? categoryOf(String id) {
    for (final c in state.categories) {
      if (c.id == id) return c;
    }
    return null;
  }

  /// The categories from a root down to [id], for the crumbs.
  List<HeCategory> pathOf(String id) {
    final path = <HeCategory>[];
    String? at = id;
    var guard = 0;
    while (at != null && guard++ < 10) {
      final c = categoryOf(at);
      if (c == null) break;
      path.insert(0, c);
      at = c.parentId;
    }
    return path;
  }

  /// Lists the hadis of a category (first page).
  Future<void> openCategory(String id) async {
    _categorySeq++;
    state = state.copyWith(
      categoryId: id,
      categoryItems: const [],
      categoryTotal: 0,
      categoryPage: 0,
      categoryLoading: false,
      clearCategoryError: true,
    );
    await _loadCategoryPage(id, 1);
  }

  Future<void> loadMoreCategory() async {
    final id = state.categoryId;
    if (id == null || state.categoryLoading || !state.categoryHasMore) return;
    await _loadCategoryPage(id, state.categoryPage + 1);
  }

  Future<void> _loadCategoryPage(String id, int page) async {
    final repo = _repo;
    if (repo == null) return;
    final seq = _categorySeq;
    state = state.copyWith(categoryLoading: true);
    try {
      final r = await repo.itemsIn(id, page: page);
      if (!ref.mounted || seq != _categorySeq || state.categoryId != id) return;
      state = state.copyWith(
        categoryItems: page == 1 ? r.items : [...state.categoryItems, ...r.items],
        categoryTotal: r.total,
        categoryPage: page,
        categoryLoading: false,
      );
    } on SessionExpired {
      rethrow;
    } on Object catch (e) {
      if (ref.mounted && seq == _categorySeq) {
        state = state.copyWith(categoryLoading: false, categoryError: e);
      }
    }
  }

  void closeCategory() {
    _categorySeq++;
    state = state.copyWith(
      clearCategory: true,
      categoryItems: const [],
      categoryTotal: 0,
      categoryPage: 0,
      categoryLoading: false,
      clearCategoryError: true,
    );
  }

  // ---- search ----

  /// Types a query: nothing is asked for under two characters; otherwise the
  /// box is asked once the person stops typing for 300 ms.
  void search(String q) {
    _debounce?.cancel();
    final text = q.trim();
    state = state.copyWith(query: text, clearSearchError: true);
    if (text.length < minSearchChars) {
      _searchSeq++;
      state = state.copyWith(results: const [], searching: false);
      return;
    }
    state = state.copyWith(searching: true);
    _debounce = Timer(
      ref.read(hadisTimingProvider).searchDebounce,
      () => unawaited(searchNow(text)),
    );
  }

  /// Asks now (the `Cari` button).
  Future<void> searchNow(String q) async {
    _debounce?.cancel();
    final repo = _repo;
    final text = q.trim();
    if (repo == null || text.length < minSearchChars) return;
    final seq = ++_searchSeq;
    state = state.copyWith(query: text, searching: true, clearSearchError: true);
    try {
      final found = await repo.search(text);
      if (!ref.mounted || seq != _searchSeq) return;
      state = state.copyWith(results: found, searching: false);
    } on SessionExpired {
      rethrow;
    } on Object catch (e) {
      if (ref.mounted && seq == _searchSeq) {
        state = state.copyWith(searching: false, searchError: e);
      }
    }
  }

  // ---- detail and add ----

  Future<void> openDetail(String id) async {
    final repo = _repo;
    if (repo == null) return;
    state = state.copyWith(
      clearDetail: true,
      detailLoading: true,
      clearDetailError: true,
    );
    try {
      final d = await repo.detail(id);
      if (!ref.mounted) return;
      state = state.copyWith(detail: d, detailLoading: false);
    } on SessionExpired {
      rethrow;
    } on Object catch (e) {
      if (ref.mounted) state = state.copyWith(detailLoading: false, detailError: e);
    }
  }

  void closeDetail() =>
      state = state.copyWith(clearDetail: true, clearDetailError: true);

  /// Saves the hadis on MAXCOM (`Tambah ke kiosk`). Nothing is sent while
  /// the box says it has no internet. On success the saved list is read
  /// again, so `Sudah di kiosk` shows at once.
  Future<AddResult> add(String id) async {
    final repo = _repo;
    if (repo == null) return const AddResult.failed(AddFailure.other, null);
    if (!state.canAdd) {
      return const AddResult.failed(AddFailure.sourceUnavailable, null);
    }
    final r = await repo.add(id);
    if (r.ok && ref.mounted) {
      final d = state.detail;
      if (d != null && d.id == id) {
        state = state.copyWith(
          detail: HeDetail(
            id: d.id,
            title: d.title,
            textMs: d.textMs,
            introMs: d.introMs,
            textAr: d.textAr,
            attributionAr: d.attributionAr,
            gradeAr: d.gradeAr,
            categories: d.categories,
            grade: d.grade,
            attributionShort: d.attributionShort,
            attributionLong: d.attributionLong,
            length: d.length,
            allowed: d.allowed,
            saved: true,
            savedItemId: r.item?.id,
          ),
        );
      }
      unawaited(ref.read(hadisListProvider.notifier).load());
    }
    return r;
  }

  // ---- the download of the HadeethEnc list ----

  /// `Muat turun sekarang`: starts the box's crawl and reads the job until
  /// it ends, then the online state and the categories again. The job is in
  /// [HadisSearchState.job]; a refusal (403, 409) is thrown.
  Future<void> refresh() async {
    final repo = _repo;
    if (repo == null) return;
    state = state.copyWith(clearJobError: true);
    final String id;
    try {
      id = await repo.refresh();
    } on BoxError catch (e) {
      // 409: one is already running; follow it through the status
      if (e.status == 409) {
        await loadStatus();
        return;
      }
      rethrow;
    }
    final poll = ref.read(hadisTimingProvider).jobPoll;
    for (var i = 0; i < 100000 && ref.mounted; i++) {
      try {
        final job = await repo.job(id);
        if (!ref.mounted) return;
        state = state.copyWith(job: job);
        if (!job.running) break;
      } on SessionExpired {
        rethrow;
      } on Object catch (e) {
        if (ref.mounted) state = state.copyWith(jobError: e);
        break;
      }
      await Future<void>.delayed(poll);
    }
    if (!ref.mounted) return;
    await loadStatus();
    await loadCategories();
  }
}

final hadisSearchProvider =
    NotifierProvider<HadisSearchController, HadisSearchState>(
      HadisSearchController.new,
    );
