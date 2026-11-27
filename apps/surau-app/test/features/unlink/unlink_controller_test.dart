// The unlink controller (lib/features/unlink/unlink_controller.dart) over a fake of the box's unlink routes: the phase
// of every stage, the sides this phone answers for, the requests of each action, the refusals that come back as codes,
// the stale revision notice and the PIN that is dropped when the app lock is off.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/unlink/unlink_controller.dart';
import 'package:surau_app/features/unlink/unlink_models.dart';

import 'unlink_fixtures.dart';

Future<ProviderContainer> open(WidgetTester tester, FakeUnlinkApi api, {bool lock = false}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [unlinkApiProvider.overrideWithValue(api), appLockProvider.overrideWithValue(lock)],
      child: Consumer(
        builder: (context, ref, _) {
          ref.watch(unlinkControllerProvider);
          return const SizedBox();
        },
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  final c = ProviderScope.containerOf(tester.element(find.byType(Consumer)));
  c.read(unlinkControllerProvider.notifier).startPolling();
  return c;
}

UnlinkState stateOf(ProviderContainer c) => c.read(unlinkControllerProvider);
UnlinkController ctl(ProviderContainer c) => c.read(unlinkControllerProvider.notifier);
UnlinkPhase phaseOf(ProviderContainer c, {bool canStart = false}) => unlinkPhaseOf(stateOf(c), canStart: canStart);

Future<void> tick(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pump();
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

void main() {
  group('the phase follows the box', () {
    testWidgets('no session: start from a follower row, the kept rows alone otherwise', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson());
      final c = await open(tester, api);
      expect(phaseOf(c, canStart: true), UnlinkPhase.start);
      expect(phaseOf(c), UnlinkPhase.idle);
      await close(tester);
    });

    testWidgets('answers: the sheet; once this phone agreed, waiting', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(follower: followerBack())));
      final c = await open(tester, api);
      expect(phaseOf(c), UnlinkPhase.answers);
      expect(unlinkSideToAnswer(stateOf(c).status!.session!, null), UnlinkSide.follower);
      api.set(unlinkStatusJson(session: sessionJson(follower: followerBack(agreed: true), master: sideJson(eligible: null, mayAnswer: false))));
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.waiting);
      await close(tester);
    });

    testWidgets('a phone that answers for neither side waits', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(follower: sideJson(mayAnswer: false))));
      final c = await open(tester, api);
      expect(phaseOf(c), UnlinkPhase.waiting);
      expect(stateOf(c).status!.session!.mine, isEmpty);
      await close(tester);
    });

    testWidgets('one phone for both sides: the follower first, then the master, then waiting', (tester) async {
      final both = sessionJson(master: sideJson(eligible: null), follower: followerBack(agreed: true));
      final api = FakeUnlinkApi(unlinkStatusJson(session: both));
      final c = await open(tester, api);
      // the follower agreed, the master (also this phone's) has not
      expect(unlinkSideToAnswer(stateOf(c).status!.session!, null), UnlinkSide.master);
      expect(phaseOf(c), UnlinkPhase.answers);
      // "Ubah jawapan" brings the follower's sheet back
      ctl(c).edit(UnlinkSide.follower);
      expect(unlinkSideToAnswer(stateOf(c).status!.session!, stateOf(c).editing), UnlinkSide.follower);
      await close(tester);
    });

    testWidgets('working draws the progress, join the move, a join with no pointer waits, done the result', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': null})));
      final c = await open(tester, api);
      expect(phaseOf(c), UnlinkPhase.progress);
      api.set(unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson())));
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.join);
      api.set(unlinkStatusJson(session: sessionJson(stage: 'join')));
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.joinWait);
      api.set(unlinkStatusJson(last: lastJson(), kept: [keptJson()]));
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.result);
      ctl(c).dismissResult();
      expect(phaseOf(c, canStart: true), UnlinkPhase.start);
      expect(phaseOf(c), UnlinkPhase.idle);
      await close(tester);
    });

    testWidgets('a dismissed result stays dismissed on the next poll; a new one is drawn', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(last: lastJson(outcome: 'cancelled')));
      final c = await open(tester, api);
      expect(phaseOf(c), UnlinkPhase.result);
      ctl(c).dismissResult();
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.idle);
      api.set(unlinkStatusJson(last: lastJson(outcome: 'done', id: 'u2')));
      await tick(tester);
      expect(phaseOf(c), UnlinkPhase.result);
      await close(tester);
    });
  });

  group('the kept line of the screens list', () {
    Future<List<UnlinkKept>> keptFor(Set<String> roles, FakeUnlinkApi api) async {
      final c = ProviderContainer(overrides: [unlinkApiProvider.overrideWithValue(api), rolesProvider.overrideWithValue(roles)]);
      addTearDown(c.dispose);
      return c.read(unlinkKeptProvider.future);
    }

    test('the kept rows for a person who may manage devices', () async {
      final api = FakeUnlinkApi(unlinkStatusJson(kept: [keptJson()]));
      final rows = await keptFor({'admin'}, api);
      expect(rows.single.masterName, 'Dewan Utama');
    });

    test('nothing, and no request, for a person who may not manage devices', () async {
      final api = FakeUnlinkApi(unlinkStatusJson(kept: [keptJson()]));
      expect(await keptFor({'treasurer'}, api), isEmpty);
      expect(api.calls, isEmpty);
    });

    test('a box that does not answer gives nothing instead of an error', () async {
      final api = FakeUnlinkApi(unlinkStatusJson(kept: [keptJson()]))..unreachable = true;
      expect(await keptFor({'admin'}, api), isEmpty);
    });
  });

  group('the requests', () {
    testWidgets('start sends the device id; the PIN only with the app lock on', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson());
      var c = await open(tester, api);
      api.afterWrite = unlinkStatusJson(session: sessionJson());
      expect(await ctl(c).start('dev-b2', '123456'), isNull);
      expect(api.bodies.last, {'deviceId': 'dev-b2', 'pin': null}, reason: 'the app lock is off: the PIN is dropped');
      expect(phaseOf(c), UnlinkPhase.answers);
      await close(tester);

      final locked = FakeUnlinkApi(unlinkStatusJson());
      c = await open(tester, locked, lock: true);
      await ctl(c).start('dev-b2', '123456');
      expect(locked.bodies.last, {'deviceId': 'dev-b2', 'pin': '123456'});
      await close(tester);
    });

    testWidgets('a choice, the people switch and the finance tick each make an answer with the rest of the state', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(master: sideJson(eligible: null, choice: 'carry-on', numbers: numbersJson(peopleFromFollower: 5)), follower: followerCarry())));
      final c = await open(tester, api);
      await ctl(c).choose(UnlinkSide.follower, UnlinkChoice.back);
      expect(api.bodies.last, {'side': 'follower', 'choice': 'back', 'removePeople': null, 'financeTick': null});
      await ctl(c).setFinanceTick(true);
      expect(api.bodies.last, {'side': 'follower', 'choice': 'carry-on', 'removePeople': null, 'financeTick': true});
      // The box now says it holds the tick: the app reads it from the side, not from a copy of its own.
      api.afterWrite = unlinkStatusJson(session: sessionJson(master: sideJson(eligible: null, choice: 'carry-on', numbers: numbersJson(peopleFromFollower: 5)), follower: followerCarry(financeTick: true)));
      await ctl(c).setFinanceTick(true);
      expect(stateOf(c).status!.session!.follower.financeTick, isTrue);
      await ctl(c).choose(UnlinkSide.follower, UnlinkChoice.carryOn);
      expect(api.bodies.last['financeTick'], isTrue, reason: 'a later answer sends the tick the box holds');
      await ctl(c).setRemovePeople(true);
      expect(api.bodies.last, {'side': 'master', 'choice': 'carry-on', 'removePeople': true, 'financeTick': null});
      await ctl(c).choose(UnlinkSide.master, UnlinkChoice.back);
      expect(api.bodies.last['removePeople'], isNull, reason: 'removePeople is for carry-on only');
      await close(tester);
    });

    testWidgets('agree answers the new status: it is used without another status call', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(rev: 4, follower: followerBack(needsTyped: false))));
      final c = await open(tester, api);
      api.afterWrite = unlinkStatusJson(session: sessionJson(rev: 4, follower: followerBack(agreed: true, needsTyped: false), master: sideJson(eligible: null, mayAnswer: false)));
      final before = api.calls.where((x) => x == 'status').length;
      expect(await ctl(c).agree(UnlinkSide.follower), isNull);
      expect(stateOf(c).status!.session!.follower.agreed, isTrue);
      expect(api.calls.where((x) => x == 'status').length, before, reason: 'no extra GET after the agree');
      await close(tester);
    });

    testWidgets('agree sends the revision on show, confirm only after the typed word, the PIN only with the lock on', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(rev: 4, follower: followerBack())));
      var c = await open(tester, api);
      expect(await ctl(c).agree(UnlinkSide.follower, confirm: true, pin: '123456'), isNull);
      expect(api.bodies.last, {'side': 'follower', 'rev': 4, 'confirm': true, 'pin': null});
      await close(tester);

      final locked = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(rev: 4, follower: followerBack())));
      c = await open(tester, locked, lock: true);
      await ctl(c).agree(UnlinkSide.follower, pin: '123456');
      expect(locked.bodies.last, {'side': 'follower', 'rev': 4, 'confirm': false, 'pin': '123456'});
      await close(tester);
    });

    testWidgets('cancel, switch and drop go to their routes', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(), kept: [keptJson()]));
      final c = await open(tester, api);
      await ctl(c).cancel();
      await ctl(c).switchChoice(UnlinkSide.follower, null);
      await ctl(c).dropKept(UnlinkSide.follower, null);
      expect(api.calls.where((x) => x != 'status'), ['cancel', 'switch', 'drop']);
      expect(api.bodies.last, {'side': 'follower', 'pin': null});
      await close(tester);
    });
  });

  group('refusals and trouble', () {
    testWidgets('a coded refusal comes back as its code and stays on the state', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson());
      final c = await open(tester, api);
      for (final code in ['live_on', 'linking', 'unlink_open', 'not_linked', 'wrong_pin', 'locked']) {
        api.failNext['start'] = refusal(code);
        expect(await ctl(c).start('dev-b2', null), code);
        expect(stateOf(c).error, code);
        ctl(c).clearError();
      }
      await close(tester);
    });

    testWidgets('same_phone, option_unavailable, finance_tick and confirm_required are shown, not swallowed', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(follower: followerCarry())));
      final c = await open(tester, api);
      for (final code in ['same_phone', 'option_unavailable']) {
        api.failNext['answer'] = refusal(code);
        expect(await ctl(c).choose(UnlinkSide.follower, UnlinkChoice.back), code);
      }
      for (final code in ['finance_tick', 'confirm_required', 'pin_required']) {
        api.failNext['agree'] = refusal(code);
        expect(await ctl(c).agree(UnlinkSide.follower), code);
      }
      await close(tester);
    });

    testWidgets('stale_revision and stale_session raise the notice and read the box again', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(rev: 1, follower: followerBack())));
      final c = await open(tester, api);
      api.set(unlinkStatusJson(session: sessionJson(rev: 2, follower: followerBack())));
      api.failNext['agree'] = refusal('stale_revision', 409, {'rev': 2});
      expect(await ctl(c).agree(UnlinkSide.follower), isNull);
      await tester.pump();
      expect(stateOf(c).staleNotice, isTrue);
      expect(stateOf(c).status!.session!.rev, 2);
      // agreeing to the new revision answers the notice
      api.set(unlinkStatusJson(session: sessionJson(rev: 2, follower: followerBack(agreed: true))));
      await tick(tester);
      expect(stateOf(c).staleNotice, isFalse);
      await close(tester);
    });

    testWidgets('another admin\'s change between two polls raises the notice; this phone\'s own does not', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson(session: sessionJson(rev: 1, follower: followerBack())));
      final c = await open(tester, api);
      api.set(unlinkStatusJson(session: sessionJson(rev: 2, follower: followerBack())));
      await tick(tester);
      expect(stateOf(c).staleNotice, isTrue);
      ctl(c).acknowledgeStale();
      api.afterWrite = unlinkStatusJson(session: sessionJson(rev: 3, follower: followerCarry()));
      await ctl(c).choose(UnlinkSide.follower, UnlinkChoice.carryOn);
      expect(stateOf(c).staleNotice, isFalse);
      await close(tester);
    });

    testWidgets('a box that cannot be reached, and an answer that cannot be read', (tester) async {
      final api = FakeUnlinkApi(unlinkStatusJson());
      final c = await open(tester, api);
      api.unreachable = true;
      await tick(tester);
      expect(stateOf(c).unreachable, isTrue);
      expect(await ctl(c).start('dev-b2', null), 'unreachable');
      api.unreachable = false;
      api.set({'session': {'id': 'x'}, 'last': null, 'kept': <Object?>[]});
      await tick(tester);
      expect(stateOf(c).unreadable, isTrue);
      expect(stateOf(c).unreachable, isFalse);
      await close(tester);
    });
  });
}
