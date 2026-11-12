// The state behind `Senarai hadis`: every hadis saved on MAXCOM in one list
// (own list and HadeethEnc), the filter, `Susun` mode and the actions of a
// row: show or hide on the TV, move up or down, `Buang`. A change is shown
// at once and sent; when the box refuses or cannot be reached the list goes
// back to what it was and the error reaches the caller. What HadeethEnc
// served is never edited: a switch sends the item back with only `shown`
// different.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../box/box_client.dart';
import '../features/shell/box_gateway.dart' show LiveOnly, OfflineWriteRefused;
import 'hadis_api.dart';
import 'hadis_providers.dart';
import 'hadis_rules.dart';

enum HadisFilter { all, own, hadeethenc }

/// A HadeethEnc grade the TV may not show was switched on.
class HadisGradeBlocked implements Exception {
  const HadisGradeBlocked();

  @override
  String toString() => 'HadisGradeBlocked';
}

extension HadisOnTv on HadisItem {
  /// A HadeethEnc hadis the TV will not show whatever its switch says: the
  /// grade is one the TV never shows, or the box took it off for a new grade.
  bool get tvBlocked => isProvider && (gradeBlocked || !gradeSavable(grade));

  /// Shown on the TV, as the TV decides it (before the settings' grade picks).
  bool get onTv => shown && !tvBlocked;
}

/// What a row's tags are made of; the screen writes the words.
enum HadisTagKind {
  own,
  hadeethenc,
  grade,
  attribution,
  longText,
  textUpdated,
  hidden,
  gradeBlocked,
  unstatedSource,
  pending,
}

class HadisTag {
  const HadisTag(this.kind, [this.value]);

  final HadisTagKind kind;

  /// Grade label or short attribution, for those two kinds.
  final String? value;

  @override
  bool operator ==(Object other) =>
      other is HadisTag && other.kind == kind && other.value == value;

  @override
  int get hashCode => Object.hash(kind, value);

  @override
  String toString() => 'HadisTag($kind, $value)';
}

/// Moving a hadis needed the whole list renumbered, which only the box can do.
class ReorderNeedsConnection implements Exception {
  const ReorderNeedsConnection();

  @override
  String toString() => 'ReorderNeedsConnection';
}

class HadisListState {
  const HadisListState({
    this.items = const [],
    this.filter = HadisFilter.all,
    this.sortMode = false,
    this.updates = const {},
    this.loading = false,
    this.loaded = false,
    this.error,
  });

  /// Sorted: `order` first (items without one after), then oldest edit first.
  final List<HadisItem> items;
  final HadisFilter filter;
  final bool sortMode;

  /// Ids of saved hadis whose text HadeethEnc has changed.
  final Set<String> updates;
  final bool loading;
  final bool loaded;
  final Object? error;

  List<HadisItem> get visible => switch (filter) {
    HadisFilter.all => items,
    HadisFilter.own => [
      for (final i in items)
        if (!i.isProvider) i,
    ],
    HadisFilter.hadeethenc => [
      for (final i in items)
        if (i.isProvider) i,
    ],
  };

  /// Saved on MAXCOM.
  int get saved => items.length;

  /// Switched on for the TV.
  int get shown => items.where((i) => i.onTv).length;

  /// Of those saved, from HadeethEnc.
  int get fromProvider => items.where((i) => i.isProvider).length;

  bool get nearLimit => saved >= nearFullAt;

  HadisListState copyWith({
    List<HadisItem>? items,
    HadisFilter? filter,
    bool? sortMode,
    Set<String>? updates,
    bool? loading,
    bool? loaded,
    Object? error,
    bool clearError = false,
  }) => HadisListState(
    items: items ?? this.items,
    filter: filter ?? this.filter,
    sortMode: sortMode ?? this.sortMode,
    updates: updates ?? this.updates,
    loading: loading ?? this.loading,
    loaded: loaded ?? this.loaded,
    error: clearError ? null : (error ?? this.error),
  );
}

/// `order` ascending, items without one last, then oldest edit, then id.
List<HadisItem> sortedHadis(Iterable<HadisItem> items) {
  final out = [...items];
  out.sort((a, b) {
    final ao = a.order;
    final bo = b.order;
    if (ao != null && bo != null && ao != bo) return ao.compareTo(bo);
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    final u = a.updatedAt.compareTo(b.updatedAt);
    return u != 0 ? u : a.id.compareTo(b.id);
  });
  return out;
}

class HadisListController extends Notifier<HadisListState> {
  @override
  HadisListState build() => const HadisListState();

  HadisRepository? get _repo => ref.read(hadisRepositoryProvider);

  /// Reads the list (and which texts changed). A failure keeps what is
  /// shown and sets [HadisListState.error].
  Future<void> load() async {
    final repo = _repo;
    if (repo == null) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final items = sortedHadis(await repo.items());
      var updates = <String>{};
      try {
        updates = {for (final u in await repo.updates()) u.itemId};
      } on Object {
        // the check of changed texts is a convenience; the list is what matters
      }
      if (!ref.mounted) return;
      state = state.copyWith(
        items: items,
        updates: updates,
        loading: false,
        loaded: true,
      );
    } on SessionExpired {
      rethrow;
    } on Object catch (e) {
      if (!ref.mounted) return;
      state = state.copyWith(loading: false, error: e);
    }
  }

  void setFilter(HadisFilter filter) =>
      state = state.copyWith(filter: filter);

  /// `Susun` shows the whole list: the arrows move a row among all of them.
  void setSortMode(bool on) => state = state.copyWith(
    sortMode: on,
    filter: on ? HadisFilter.all : state.filter,
  );

  HadisItem? _find(String id) {
    for (final i in state.items) {
      if (i.id == id) return i;
    }
    return null;
  }

  List<HadisItem> _replace(HadisItem old, HadisItem next) => [
    for (final i in state.items) i.id == old.id ? next : i,
  ];

  /// Shows or hides the hadis on the TV. Sends only `shown` for a HadeethEnc
  /// hadis (the whole item for an own one); queued when the box is away,
  /// undone on a failure. A hadis whose grade the TV never shows cannot be
  /// switched on ([HadisGradeBlocked]).
  Future<void> toggleShown(String id) async {
    final repo = _repo;
    final item = _find(id);
    if (repo == null || item == null) return;
    final next = !item.onTv;
    if (next && item.tvBlocked) throw const HadisGradeBlocked();
    final body = item.toPut(shown: next);
    final changed = HadisItem({...item.raw, 'shown': next});
    final before = state.items;
    state = state.copyWith(items: _replace(item, changed));
    try {
      await repo.put(id, body);
    } on Object {
      if (ref.mounted) state = state.copyWith(items: before);
      rethrow;
    }
  }

  /// Moves a hadis one place ([dir] -1 up, +1 down). The new `order` is the
  /// midpoint of its new neighbours; with no room between them, or an item
  /// that never had an order, the box renumbers the whole list (online only).
  Future<void> move(String id, int dir) async {
    final repo = _repo;
    final items = state.items;
    final i = items.indexWhere((x) => x.id == id);
    final j = i + dir;
    if (repo == null || i < 0 || j < 0 || j >= items.length || dir.abs() != 1) {
      return;
    }
    final moved = [...items]..removeAt(i);
    moved.insert(j, items[i]);
    final lo = j > 0 ? moved[j - 1] : null;
    final hi = j < moved.length - 1 ? moved[j + 1] : null;
    final newOrder = _between(lo?.order, hi?.order, lo != null, hi != null);
    if (newOrder == null) {
      await _renumber(repo, moved);
      return;
    }
    final item = items[i];
    final changed = HadisItem({...item.raw, 'order': newOrder});
    final before = state.items;
    state = state.copyWith(
      items: [
        for (var k = 0; k < moved.length; k++)
          k == j ? changed : moved[k],
      ],
    );
    try {
      await repo.put(id, item.toPut(order: newOrder));
    } on Object {
      if (ref.mounted) state = state.copyWith(items: before);
      rethrow;
    }
  }

  /// An order strictly between [lo] and [hi] (either may be a missing
  /// neighbour), or null when there is no room or a neighbour has no order.
  static int? _between(int? lo, int? hi, bool hasLo, bool hasHi) {
    if ((hasLo && lo == null) || (hasHi && hi == null)) return null;
    if (!hasLo && !hasHi) return 1000;
    if (!hasHi) {
      final v = lo! + 1000;
      return v <= 1000000 ? v : null;
    }
    if (!hasLo) {
      if (hi! - 1000 >= 0) return hi - 1000;
      return hi >= 2 ? hi ~/ 2 : null;
    }
    final gap = hi! - lo!;
    return gap >= 2 ? lo + gap ~/ 2 : null;
  }

  Future<void> _renumber(HadisRepository repo, List<HadisItem> moved) async {
    final before = state.items;
    state = state.copyWith(items: moved);
    try {
      await repo.order([for (final x in moved) x.id]);
    } on SessionExpired {
      if (ref.mounted) state = state.copyWith(items: before);
      rethrow;
    } on BoxUnreachable {
      if (ref.mounted) state = state.copyWith(items: before);
      throw const ReorderNeedsConnection();
    } on LiveOnly {
      if (ref.mounted) state = state.copyWith(items: before);
      throw const ReorderNeedsConnection();
    } on OfflineWriteRefused {
      if (ref.mounted) state = state.copyWith(items: before);
      throw const ReorderNeedsConnection();
    } on Object {
      if (ref.mounted) state = state.copyWith(items: before);
      rethrow;
    }
    await load();
  }

  /// `Buang`: deletes from the MAXCOM list (a HadeethEnc hadis can be added
  /// again; an own-list delete is for good).
  Future<void> remove(String id) async {
    final repo = _repo;
    final item = _find(id);
    if (repo == null || item == null) return;
    final before = state.items;
    state = state.copyWith(items: [
      for (final i in state.items)
        if (i.id != id) i,
    ]);
    try {
      await repo.delete(id);
    } on Object {
      if (ref.mounted) state = state.copyWith(items: before);
      rethrow;
    }
  }

  /// `Guna teks baharu`. True when the new grade is not one the TV may show
  /// (the box hid the hadis).
  Future<bool> acceptUpdate(String id) async {
    final repo = _repo;
    if (repo == null) return false;
    final blocked = await repo.acceptUpdate(id);
    await load();
    return blocked;
  }

  /// The tags of a row, in the order the screen shows them.
  List<HadisTag> tagsFor(HadisItem item) {
    final tags = <HadisTag>[];
    if (item.isProvider) {
      tags.add(const HadisTag(HadisTagKind.hadeethenc));
      final g = item.grade;
      if (g != null) tags.add(HadisTag(HadisTagKind.grade, gradeLabel(g)));
      final a = attributionOf(
        (item.ext?['attributionAr'] as String?) ?? '',
      );
      final short = a?.short ?? item.source;
      if (short.isNotEmpty) tags.add(HadisTag(HadisTagKind.attribution, short));
    } else {
      tags.add(const HadisTag(HadisTagKind.own));
      if (item.source == unstatedSource) {
        tags.add(const HadisTag(HadisTagKind.unstatedSource));
      }
    }
    if (hadisLength(item.textMs) == 'long') {
      tags.add(const HadisTag(HadisTagKind.longText));
    }
    if (state.updates.contains(item.id)) {
      tags.add(const HadisTag(HadisTagKind.textUpdated));
    }
    if (item.gradeBlocked) {
      tags.add(const HadisTag(HadisTagKind.gradeBlocked));
    } else if (!item.shown) {
      tags.add(const HadisTag(HadisTagKind.hidden));
    }
    if (item.pending) tags.add(const HadisTag(HadisTagKind.pending));
    return tags;
  }
}

final hadisListProvider =
    NotifierProvider<HadisListController, HadisListState>(
      HadisListController.new,
    );

/// Provider ids (`66512`) of the HadeethEnc hadis saved on MAXCOM, so
/// `Sudah di kiosk` stays live in the search screens.
final hadisSavedIdsProvider = Provider<Set<String>>((ref) {
  final items = ref.watch(hadisListProvider.select((s) => s.items));
  return {
    for (final i in items)
      if (i.providerId != null) i.providerId!,
  };
});
