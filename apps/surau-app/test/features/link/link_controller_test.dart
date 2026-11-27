// The link controller (lib/features/link/link_controller.dart) over a fake of the box's link routes: the phase of every
// step, the stale revision, the PIN that is asked again, the case X switch, the version stop, a box that follows
// another, the LAN-only refusal and the new box that is linked by one admin.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/features/link/link_api.dart';
import 'package:surau_app/features/link/link_controller.dart';
import 'package:surau_app/features/link/link_models.dart';

import 'link_fixtures.dart';

Future<ProviderContainer> open(WidgetTester tester, FakeLinkApi api, {bool lock = false}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        linkApiProvider.overrideWithValue(api),
        appLockProvider.overrideWithValue(lock),
      ],
      child: Consumer(
        builder: (context, ref, _) {
          ref.watch(linkControllerProvider);
          return const SizedBox();
        },
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  final c = ProviderScope.containerOf(tester.element(find.byType(Consumer)));
  c.read(linkControllerProvider.notifier).startPolling();
  return c;
}

LinkState stateOf(ProviderContainer c) => c.read(linkControllerProvider);
LinkController ctl(ProviderContainer c) => c.read(linkControllerProvider.notifier);

/// One poll tick of the controller.
Future<void> tick(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pump();
}

Future<void> close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
}

Map<String, Object?> questions({
  int rev = 1,
  String keep = 'scan',
  String master = 'scan',
  bool ownAgreed = false,
  bool peerAgreed = false,
  bool tick = false,
  Map<String, String> fixed = const {},
  Map<String, Object?>? show,
  Map<String, Object?>? scan,
  String role = 'show',
  bool caseX = true,
}) => statusJson(
  caseX: caseX,
  session: linkSession(
    role: role,
    step: 'questions',
    show: show,
    scan: scan,
    answers: answersJson(rev: rev, keep: keep, master: master, financeTick: tick),
    ownAgreed: ownAgreed,
    peerAgreed: peerAgreed,
    fixed: fixed,
  ),
);

void main() {
  group('the phase follows the box', () {
    testWidgets('nothing running: the entry; a session at each step draws that step', (tester) async {
      final api = FakeLinkApi(statusJson());
      final c = await open(tester, api);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.entry);
      expect(api.calls.first, 'status');

      for (final (step, phase) in [
        ('qr', LinkPhase.waiting),
        ('calling', LinkPhase.calling),
        ('code', LinkPhase.code),
        ('agreed', LinkPhase.progress),
        ('working', LinkPhase.progress),
      ]) {
        api.set(statusJson(session: linkSession(step: step)));
        await tick(tester);
        expect(linkPhaseOf(stateOf(c)), phase, reason: step);
      }
      api.set(questions());
      await tick(tester);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.questions);

      // progress with no session (the box between two steps)
      api.set(statusJson(progress: {'linkId': 'x' * 32, 'step': 'people', 'stepNo': 2, 'steps': 4, 'percent': 40}));
      await tick(tester);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.progress);
      expect(stateOf(c).status!.progress!.stepNo, 2);
      await close(tester);
    });

    testWidgets('a result is drawn once; dismissing it returns to the entry; a cancelled one carries the outcome', (tester) async {
      final api = FakeLinkApi(statusJson(last: {'id': 'r1', 'outcome': 'cancelled_by_peer', 'finishedAt': '2026-11-21T09:40:00.000Z', 'role': 'show'}));
      final c = await open(tester, api);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.done);
      expect(stateOf(c).status!.last!.linked, isFalse);
      ctl(c).dismissResult();
      expect(linkPhaseOf(stateOf(c)), LinkPhase.entry);
      api.set(statusJson(last: {'id': 'r2', 'outcome': 'linked', 'finishedAt': '2026-11-21T09:45:00.000Z', 'role': 'show'}));
      await tick(tester);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.done);
      expect(stateOf(c).status!.last!.linked, isTrue);
      await close(tester);
    });

    testWidgets('the checks: not on the surau Wi-Fi, a live broadcast, a follower', (tester) async {
      expect(linkBlockOf(statusOf(statusJson(lan: false))), LinkBlock.notLan);
      expect(linkBlockOf(statusOf(statusJson(live: true))), LinkBlock.live);
      expect(linkBlockOf(statusOf(statusJson(mode: 'follower'))), LinkBlock.follower);
      expect(linkBlockOf(statusOf(statusJson())), isNull);
      // the Wi-Fi comes before the broadcast
      expect(linkBlockOf(statusOf(statusJson(lan: false, live: true))), LinkBlock.notLan);
    });

    testWidgets('a follower box ends the flow and the polling stops', (tester) async {
      final api = FakeLinkApi(statusJson(mode: 'follower'));
      final c = await open(tester, api);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.follower);
      final before = api.calls.where((x) => x == 'status').length;
      await tick(tester);
      await tick(tester);
      expect(api.calls.where((x) => x == 'status').length, before, reason: 'no more polls');
      await close(tester);
    });

    testWidgets('the box away shows the notice and keeps the last screen', (tester) async {
      final api = FakeLinkApi(statusJson(session: linkSession(step: 'qr')));
      final c = await open(tester, api);
      api.unreachable = true;
      await tick(tester);
      expect(stateOf(c).unreachable, isTrue);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.waiting);
      api.unreachable = false;
      await tick(tester);
      expect(stateOf(c).unreachable, isFalse);
      await close(tester);
    });
  });

  group('LAN only', () {
    testWidgets('a refused "show" keeps the entry and names the code', (tester) async {
      final api = FakeLinkApi(statusJson());
      final c = await open(tester, api);
      api.failNext['show'] = const LinkRefusal(403, 'lan_only');
      final code = await ctl(c).showCode(null);
      expect(code, 'lan_only');
      expect(linkPhaseOf(stateOf(c)), LinkPhase.entry);
      await close(tester);
    });

    testWidgets('with the app lock on the PIN goes to the request; with it off none is sent', (tester) async {
      final locked = FakeLinkApi(statusJson());
      var c = await open(tester, locked, lock: true);
      await ctl(c).showCode('482913');
      expect(locked.bodies.last['pin'], '482913');
      await close(tester);

      final open0 = FakeLinkApi(statusJson());
      c = await open(tester, open0);
      await ctl(c).showCode('482913');
      expect(open0.bodies.last['pin'], isNull, reason: 'the box needs none when the lock is off');
      await close(tester);
    });
  });

  group('scan and the version stop', () {
    testWidgets('a valid QR waits for "Teruskan"; a QR of another type or a changed one is refused', (tester) async {
      final api = FakeLinkApi(statusJson());
      final c = await open(tester, api);
      ctl(c).beginScan();
      expect(linkPhaseOf(stateOf(c)), LinkPhase.scanning);
      ctl(c).onScanned(await signedLinkQr(type: 'setup'));
      expect(stateOf(c).scanned, isNull);
      expect(stateOf(c).error, 'bad_qr');
      ctl(c).onScanned(await signedLinkQr(tamper: true));
      expect(stateOf(c).scanned, isNull);
      final good = await signedLinkQr();
      ctl(c).onScanned(good);
      expect(stateOf(c).scanned!.name, 'MAXCOM Dewan Utama');
      expect(stateOf(c).error, isNull);
      expect(api.calls.contains('scan'), isFalse, reason: 'nothing leaves the phone before Teruskan');

      await ctl(c).confirmScan(null);
      expect(api.calls.last, 'scan');
      expect(api.bodies.last['qr'], good, reason: 'the raw text goes to the box');
      await close(tester);
    });

    testWidgets('version, protocol and db_level end the attempt on the stop screen with the box that is behind', (tester) async {
      for (final code in ['version', 'protocol', 'db_level']) {
        final api = FakeLinkApi(statusJson());
        final c = await open(tester, api);
        ctl(c).beginScan();
        ctl(c).onScanned(await signedLinkQr());
        api.failNext['scan'] = LinkRefusal(409, code, {'behind': 'show', 'code': code});
        await ctl(c).confirmScan(null);
        expect(linkPhaseOf(stateOf(c)), LinkPhase.stop, reason: code);
        expect(stateOf(c).stop!.code, code);
        expect(stateOf(c).stop!.behind, LinkSide.show);
        expect(stateOf(c).stop!.peerName, 'MAXCOM Dewan Utama');
        ctl(c).dismissStop();
        expect(linkPhaseOf(stateOf(c)), LinkPhase.entry);
        await close(tester);
      }
    });

    testWidgets('another refusal of the scan stays on the confirmation with its code', (tester) async {
      final api = FakeLinkApi(statusJson());
      final c = await open(tester, api);
      ctl(c).beginScan();
      ctl(c).onScanned(await signedLinkQr());
      api.failNext['scan'] = const LinkRefusal(409, 'code_used');
      final code = await ctl(c).confirmScan(null);
      expect(code, 'code_used');
      expect(stateOf(c).scanned, isNotNull);
      await close(tester);
    });
  });

  group('the matching code', () {
    testWidgets('the box that showed the QR approves; "Tolak" ends the session without an error line', (tester) async {
      final api = FakeLinkApi(statusJson(session: linkSession(step: 'code')));
      final c = await open(tester, api);
      final s = stateOf(c).status!.session!;
      expect(s.approvesCode, isTrue);
      expect(s.code, '482193');
      api.failNext['approve'] = const LinkRefusal(409, 'rejected');
      api.set(statusJson(last: {'id': 'r9', 'outcome': 'rejected', 'finishedAt': '2026-11-21T09:40:00.000Z', 'role': 'show'}));
      await ctl(c).approve(false);
      expect(stateOf(c).error, isNull);
      expect(linkPhaseOf(stateOf(c)), LinkPhase.done);
      await close(tester);
    });

    testWidgets('the scanning box only shows the code', (tester) async {
      final api = FakeLinkApi(statusJson(session: linkSession(role: 'scan', step: 'code')));
      final c = await open(tester, api);
      expect(stateOf(c).status!.session!.approvesCode, isFalse);
      await close(tester);
    });

    testWidgets('a new box that showed the QR: the scanning admin approves with "Kod sama"', (tester) async {
      final api = FakeLinkApi(statusJson(session: linkSession(role: 'scan', step: 'code', show: ruangMuslimat(setUp: false), scan: dewanUtama())));
      final c = await open(tester, api);
      final s = stateOf(c).status!.session!;
      expect(s.showIsNew, isTrue);
      expect(s.approvesCode, isTrue);
      expect(s.oneNewBox, isTrue);
      await close(tester);
    });
  });

  group('the questions', () {
    testWidgets('an answer is one PUT with the whole choice; my own write is not "another admin"', (tester) async {
      final api = FakeLinkApi(questions());
      final c = await open(tester, api);
      api.afterWrite = questions(rev: 2, keep: 'show', master: 'show');
      await ctl(c).chooseKeep(LinkSide.show);
      expect(api.bodies.last, {'keep': 'show', 'master': 'show', 'roles': <String, String>{}, 'same': <String>[], 'phones': 'direct', 'financeTick': false});
      expect(stateOf(c).staleNotice, isFalse);
      expect(stateOf(c).status!.session!.answers!.rev, 2);
      await tick(tester);
      expect(stateOf(c).staleNotice, isFalse, reason: 'the poll shows the revision this admin wrote');
      await close(tester);
    });

    testWidgets('another admin changes the answers: the notice, until this admin agrees again', (tester) async {
      final api = FakeLinkApi(questions());
      final c = await open(tester, api);
      expect(stateOf(c).staleNotice, isFalse);
      api.set(questions(rev: 2, keep: 'show', master: 'show'));
      await tick(tester);
      expect(stateOf(c).staleNotice, isTrue);
      api.set(questions(rev: 2, keep: 'show', master: 'show', ownAgreed: true));
      await tick(tester);
      expect(stateOf(c).staleNotice, isFalse);
      await close(tester);
    });

    testWidgets('409 stale_revision on a write shows the notice and reads the box again', (tester) async {
      final api = FakeLinkApi(questions());
      final c = await open(tester, api);
      api.failNext['answers'] = const LinkRefusal(409, 'stale_revision', {'rev': 3});
      api.set(questions(rev: 3, keep: 'show', master: 'show'));
      await ctl(c).chooseKeep(LinkSide.show);
      await tester.pump();
      expect(stateOf(c).staleNotice, isTrue);
      expect(stateOf(c).error, isNull, reason: 'the notice is the message');
      expect(stateOf(c).status!.session!.answers!.rev, 3);
      await close(tester);
    });

    testWidgets('case X off: the master follows the kept data; case X on: it stays where it was set', (tester) async {
      var api = FakeLinkApi(questions(caseX: false));
      var c = await open(tester, api);
      await ctl(c).chooseKeep(LinkSide.show);
      expect(api.bodies.last['keep'], 'show');
      expect(api.bodies.last['master'], 'show');
      await close(tester);

      // case X on, the master was set apart on purpose: the kept data moves, the master does not
      api = FakeLinkApi(questions(keep: 'scan', master: 'show'));
      c = await open(tester, api);
      await ctl(c).chooseKeep(LinkSide.show);
      expect(api.bodies.last['keep'], 'show');
      expect(api.bodies.last['master'], 'show', reason: 'the master was already show');
      api = FakeLinkApi(questions(keep: 'scan', master: 'scan'));
      await close(tester);
      c = await open(tester, api);
      await ctl(c).chooseMaster(LinkSide.show);
      expect(api.bodies.last, containsPair('keep', 'scan'));
      expect(api.bodies.last, containsPair('master', 'show'));
      await close(tester);
    });

    testWidgets('the finance tick is an answer of its own', (tester) async {
      final api = FakeLinkApi(questions());
      final c = await open(tester, api);
      await ctl(c).setFinanceTick(true);
      expect(api.bodies.last['financeTick'], isTrue);
      await close(tester);
    });

    testWidgets('"Setuju" for the revision on the screen; a box that wants the PIN again asks for it', (tester) async {
      final api = FakeLinkApi(questions(rev: 4));
      final c = await open(tester, api, lock: true);
      api.failNext['agree'] = const LinkRefusal(401, 'pin_required');
      final needPin = await ctl(c).agree();
      expect(needPin, isTrue);
      expect(api.bodies.last, {'rev': 4});
      expect(stateOf(c).error, isNull);
      await ctl(c).agreeWithPin('482913');
      expect(api.calls.sublist(api.calls.length - 2), ['pin', 'agree']);
      expect(api.bodies[api.bodies.length - 2], {'pin': '482913'});
      expect(api.bodies.last, {'rev': 4});
      await close(tester);
    });

    testWidgets('with the app lock off the proof is renewed without asking', (tester) async {
      final api = FakeLinkApi(questions(rev: 2));
      final c = await open(tester, api);
      api.failNext['agree'] = const LinkRefusal(401, 'pin_required');
      final needPin = await ctl(c).agree();
      expect(needPin, isFalse);
      expect(api.calls.sublist(api.calls.length - 3), ['agree', 'pin', 'agree']);
      expect(api.bodies[api.bodies.length - 2], {'pin': null});
      await close(tester);
    });

    testWidgets('a wrong PIN comes back as its code for the sheet', (tester) async {
      final api = FakeLinkApi(questions());
      final c = await open(tester, api, lock: true);
      api.failNext['pin'] = const LinkRefusal(401, 'wrong_pin');
      final code = await ctl(c).agreeWithPin('111222');
      expect(code, 'wrong_pin');
      await close(tester);
    });

    testWidgets('a new box (one party): one question is fixed and the new box is not a choice', (tester) async {
      final api = FakeLinkApi(
        questions(show: dewanUtama(finance: 0), scan: ruangMuslimat(setUp: false), fixed: {'keep': 'show'}, keep: 'show', master: 'show'),
      );
      final c = await open(tester, api);
      final s = stateOf(c).status!.session!;
      expect(s.oneNewBox, isTrue);
      expect(s.fixedKeep, LinkSide.show);
      expect(s.answers!.replaced.isEmpty, isFalse, reason: 'the fixture keeps the numbers of the other box');
      await close(tester);
    });
  });

  group('advice', () {
    LinkFace face(Map<String, Object?> j) => LinkFace.fromJson(j);
    test('a Windows PC before an Android box, a cable before Wi-Fi, then the larger free storage', () {
      final pc = face(dewanUtama());
      final t95 = face(ruangMuslimat());
      expect(adviseMaster(pc, t95), LinkSide.show);
      expect(adviseMaster(t95, pc), LinkSide.scan);
      final wired = face(faceJson('A', facts: factsJson(wired: true)));
      final wifi = face(faceJson('B', facts: factsJson(wired: false)));
      expect(adviseMaster(wifi, wired), LinkSide.scan);
      final big = face(faceJson('A', facts: factsJson(wired: true, freeBytes: 9000000000)));
      final small = face(faceJson('B', facts: factsJson(wired: true, freeBytes: 1000000000)));
      expect(adviseMaster(big, small), LinkSide.show);
      expect(adviseMaster(small, big), LinkSide.scan);
      // a tie goes to the box that showed the code
      expect(adviseMaster(big, big), LinkSide.show);
      // a box that is set up before one that was never set up
      expect(adviseMaster(face(ruangMuslimat(setUp: false)), pc), LinkSide.scan);
    });
  });
}
