// What the sync screens ask of the engine (Plan 6 Task 9), behind one seam
// the widget tests replace with a fake: sync now, the conflicts kept on this
// device, discard one, or send the person's own version again.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../sync/sync_engine.dart';
import '../../sync/sync_providers.dart';

abstract class SyncActions {
  /// One push and pull now; never throws (the view carries the outcome).
  Future<SyncView> syncNow();

  /// Refused or superseded edits, newest first.
  Future<List<Map<String, dynamic>>> conflicts();

  /// Forgets one conflict (`Buang`).
  Future<void> discard(String opId);

  /// `Guna versi saya semula`: the person's payload as a new op, edited now,
  /// so it wins unless someone edits again; the conflict is then removed.
  Future<void> reapply(Map<String, dynamic> conflict);
}

class EngineSyncActions implements SyncActions {
  EngineSyncActions(this.engine);

  final SyncEngine engine;

  @override
  Future<SyncView> syncNow() => engine.sync();

  @override
  Future<List<Map<String, dynamic>>> conflicts() => engine.conflicts();

  @override
  Future<void> discard(String opId) => engine.dismissConflict(opId);

  @override
  Future<void> reapply(Map<String, dynamic> conflict) async {
    await engine.enqueue(
      kind: conflict['kind'] as String,
      entity: conflict['entity'] as String,
      entityId: conflict['entityId'] as String,
      payload: conflict['mine'],
    );
    await engine.dismissConflict(conflict['opId'] as String);
  }
}

/// Null while there is no engine (not unlocked, or no local store): the
/// chip and the sync rows then stay hidden.
final syncActionsProvider = Provider<SyncActions?>((ref) {
  final engine = ref.watch(syncEngineProvider);
  return engine == null ? null : EngineSyncActions(engine);
});

/// The conflicts list, read again whenever the engine's count changes.
final syncConflictsProvider = FutureProvider<List<Map<String, dynamic>>>((
  ref,
) async {
  final actions = ref.watch(syncActionsProvider);
  ref.watch(syncViewProvider.select((v) => v.value?.conflicts));
  if (actions == null) return const [];
  return actions.conflicts();
});

/// Whether a conflict can be sent again: only an edit that lost to a later
/// one (a refusal would be refused again; a picture's bytes are not kept).
bool canReapply(Map<String, dynamic> conflict) =>
    conflict['reason'] == 'superseded' && conflict['kind'] != 'asset.put';
