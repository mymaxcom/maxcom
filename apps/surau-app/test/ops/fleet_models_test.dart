// Plan 14 Task 14: the fleet models read the server's shapes and sort as the mockup says.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/ops/fleet/fleet_models.dart';

import '../features/fakes.dart';
import 'fleet_support.dart';

void main() {
  final now = fixedNow();
  final all = parseSuraus({'suraus': fleetFixture()});

  FleetSurau byId(String id) => all.firstWhere((s) => s.id == id);

  test('the state of each surau', () {
    expect(byId('al-hidayah').stateAt(now), SurauState.ok);
    expect(byId('dwaqaf').stateAt(now), SurauState.offline);
    expect(byId('masjid-contoh').stateAt(now), SurauState.suspended);
    expect(byId('taman-contoh').stateAt(now), SurauState.waiting);
  });

  test('a linked surau whose boxes are all revoked, or never seen, is offline', () {
    final revoked = FleetSurau.fromJson(
      surau('x1', 'X', boxes: [box('aaaaaaaaaaaaaaaa', seen: const Duration(minutes: 1), revoked: true)]),
    );
    expect(revoked.stateAt(now), SurauState.offline);
    final unseen = FleetSurau.fromJson(surau('x2', 'X', boxes: [box('bbbbbbbbbbbbbbbb')]));
    expect(unseen.stateAt(now), SurauState.offline);
  });

  test('waiting and offline come first, then suspended, then ok, by name inside a group', () {
    final order = sortFleet(all, now).map((s) => s.id).toList();
    expect(order, ['dwaqaf', 'taman-contoh', 'masjid-contoh', 'al-hidayah', 'bukit-contoh']);
  });

  test('a body missing every field never throws', () {
    final s = FleetSurau.fromJson(const <String, dynamic>{});
    expect(s.boxes, isEmpty);
    expect(s.stateAt(now), SurauState.waiting);
    expect(parseSuraus(const {}), isEmpty);
    expect(parsePending(const {}), isEmpty);
    expect(OpsContext.fromJson(const {}).mayAct, isFalse);
  });

  test('the ops context needs ops and scope all', () {
    expect(OpsContext.fromJson(meOps()).mayAct, isTrue);
    expect(OpsContext.fromJson(meOps(scope: 'surau')).mayAct, isFalse);
    expect(OpsContext.fromJson(meOps(ops: false)).mayAct, isFalse);
    expect(OpsContext.fromJson(meOps(surauId: 'a-b', surauName: 'Surau A')).surauName, 'Surau A');
  });

  test('sizes read in the largest whole unit and ids in groups of four', () {
    expect(bytesLabel(0), '0 B');
    expect(bytesLabel(420 * 1024 * 1024), '420 MB');
    expect(bytesLabel(2 * 1024 * 1024 * 1024), '2 GB');
    expect(bytesLabel(1750 * 1024 * 1024), '1.71 GB');
    expect(groupId('9f02b7aa1c4e0d11'), '9f02-b7aa-1c4e-0d11');
  });

  test('the storage ratio is zero without a limit', () {
    expect(FleetSurau.fromJson(surau('x', 'X', limit: 0)).storageRatio, 0);
    expect(byId('masjid-contoh').storageRatio, greaterThan(storageDangerAt));
    expect(byId('dwaqaf').storageRatio, greaterThan(storageWarnAt));
  });
}
