// Plan 14 Task 15: revoke a box (typed confirmation) and restore a revoked one, from the surau's page. The same
// functions as the cloud CLI sit behind the routes, so the refusals are the same. Pentadbir MAXCOM only. Ops build only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart' show BoxError;
import '../../screens/widgets/pieces.dart' show confirmDialog, toast;
import 'fleet_models.dart';
import 'fleet_providers.dart';
import 'fleet_texts.dart';
import 'fleet_widgets.dart';
import 'typed_confirm_sheet.dart';

String revokePath(String boxId) => '/api/fleet/boxes/$boxId/revoke';
String unrevokePath(String boxId) => '/api/fleet/boxes/$boxId/unrevoke';

String deleteSurauPath(String surauId) => '/api/fleet/suraus/$surauId';

String rejectPath(String boxId) => '/api/fleet/pending/$boxId/reject';

String _boxLabel(FleetBox box) => box.name.isEmpty ? groupId(box.boxId) : box.name;

/// Ask for the word, then revoke. Returns true when the cloud revoked it.
Future<bool> revokeBox(BuildContext context, WidgetRef ref, FleetBox box) async {
  final t = FleetT.of(context);
  final ok = await showTypedConfirm(
    context,
    title: t.revokeTitle(_boxLabel(box)),
    body: t.revokeBody,
    word: t.revokeWord,
    confirm: t.revokeSubmit,
  );
  if (!ok || !context.mounted) return false;
  return _send(context, ref, revokePath(box.boxId), t.revoked);
}

/// Ask for the word TOLAK, then reject a waiting box (its Worker registration only). True when the cloud did it.
Future<bool> rejectPendingBox(BuildContext context, WidgetRef ref, PendingBox box) async {
  final t = FleetT.of(context);
  final ok = await showTypedConfirm(
    context,
    title: t.rejectTitle(box.name.isEmpty ? box.idGroups : box.name),
    body: t.rejectBody,
    word: t.rejectWord,
    confirm: t.rejectSubmit,
  );
  if (!ok || !context.mounted) return false;
  return _send(context, ref, rejectPath(box.boxId), t.rejected);
}

/// Ask for the surau name, then delete an empty surau. True when the cloud deleted it. A 409 `not_empty` (something
/// arrived meanwhile) or a 404 says so and reads the list again; if the surau was the acting one, the choice is cleared.
Future<bool> deleteEmptySurau(BuildContext context, WidgetRef ref, FleetSurau surau) async {
  final t = FleetT.of(context);
  final ok = await showTypedConfirm(
    context,
    title: t.deleteSurauTitle(surau.name),
    body: t.deleteSurauBody,
    word: surau.name,
    confirm: t.deleteSurau,
  );
  if (!ok || !context.mounted) return false;
  final gateway = ref.read(gatewayProvider);
  if (gateway == null) return false;
  try {
    await gateway.delete(deleteSurauPath(surau.id));
  } on Object catch (e) {
    if (e is BoxError && e.status >= 400 && e.status < 500) ref.invalidate(fleetSurausProvider);
    if (context.mounted) {
      toast(context, e is BoxError && e.status == 409 && e.code == 'not_empty' ? t.deleteSurauNotEmpty : fleetFailure(context, e));
    }
    return false;
  }
  if (ref.read(actingSurauProvider)?.id == surau.id) ref.read(actingSurauProvider.notifier).clear();
  ref.invalidate(fleetSurausProvider);
  if (context.mounted) toast(context, t.deleteSurauDone);
  return true;
}

/// Ask once, then let the box link again (once, to its own surau). Returns true when the cloud allowed it.
Future<bool> unrevokeBox(BuildContext context, WidgetRef ref, FleetBox box) async {
  final t = FleetT.of(context);
  final ok = await confirmDialog(
    context,
    title: t.unrevokeTitle(_boxLabel(box)),
    body: t.unrevokeBody,
    confirm: t.unrevokeBox,
  );
  if (!ok || !context.mounted) return false;
  return _send(context, ref, unrevokePath(box.boxId), t.restored);
}

Future<bool> _send(BuildContext context, WidgetRef ref, String path, String done) async {
  final gateway = ref.read(gatewayProvider);
  if (gateway == null) return false;
  try {
    await gateway.post(path, const <String, Object>{});
  } on Object catch (e) {
    // A refusal means the card on screen is out of date (already approved, rejected, gone): read the lists again.
    if (e is BoxError && e.status >= 400 && e.status < 500) {
      ref.invalidate(fleetSurausProvider);
      ref.invalidate(pendingBoxesProvider);
    }
    if (context.mounted) toast(context, fleetFailure(context, e));
    return false;
  }
  ref.invalidate(fleetSurausProvider);
  ref.invalidate(pendingBoxesProvider);
  if (context.mounted) toast(context, done);
  return true;
}
