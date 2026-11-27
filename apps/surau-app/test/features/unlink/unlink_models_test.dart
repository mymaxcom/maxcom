// The unlink models (lib/features/unlink/unlink_models.dart): a session at each stage, both sides, a master that is
// not asked, a follower that was a new box, a backup that was dropped, the join pointer and a strict read that fails
// on anything of the wrong shape.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/unlink/unlink_models.dart';

import 'unlink_fixtures.dart';

void main() {
  group('stages', () {
    test('answers: both sides, the master asked', () {
      final st = statusOf(unlinkStatusJson(session: sessionJson(master: sideJson(eligible: null, choice: 'back', needsTyped: true), follower: followerCarry())));
      final s = st.session!;
      expect(s.stage, UnlinkStage.answers);
      expect(s.followerName, 'Ruang Muslimat');
      expect(s.master.asked, isTrue);
      expect(s.master.choice, UnlinkChoice.back);
      expect(s.master.needsTyped, isTrue);
      expect(s.follower.choice, UnlinkChoice.carryOn);
      expect(s.follower.eligible, UnlinkEligible.before);
      expect(s.follower.numbers.financeEntriesLeft, 42);
      expect(s.follower.numbers.videosNotFit.single.title, 'Kuliah Maghrib');
      expect(s.follower.youtube, UnlinkYoutube.none);
      expect(s.mine, [UnlinkSide.follower, UnlinkSide.master]);
    });

    test('answers: the master is not asked, so it is not one of this phone sides', () {
      final s = statusOf(unlinkStatusJson(session: sessionJson())).session!;
      expect(s.master.asked, isFalse);
      expect(s.mine, [UnlinkSide.follower]);
      expect(s.allAgreed, isFalse);
    });

    test('allAgreed ignores a master that is not asked', () {
      final s = statusOf(unlinkStatusJson(session: sessionJson(follower: followerBack(agreed: true)))).session!;
      expect(s.allAgreed, isTrue);
    });

    test('working: the progress with and without a percent', () {
      var s = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'carry-on', 'stepNo': 2, 'steps': 3, 'percent': 40}))).session!;
      expect(s.stage, UnlinkStage.working);
      expect(s.progress!.step, UnlinkStep.carryOn);
      expect(s.progress!.percent, 40);
      s = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': null}))).session!;
      expect(s.progress!.step, UnlinkStep.copy);
      expect(s.progress!.percent, isNull);
    });

    test('join: the pointer is the 2C move pointer', () {
      final s = statusOf(unlinkStatusJson(session: sessionJson(stage: 'join', join: joinJson()))).session!;
      expect(s.stage, UnlinkStage.join);
      final p = s.join!.pointer;
      expect(s.join!.name, 'Ruang Muslimat');
      expect(p.masterBoxId, 'b2b2b2b2b2b2b2b2');
      expect(p.addresses, ['https://10.168.50.12:8443']);
      expect(p.ticket, 'ABCD-EFGH-2345');
      expect(p.linkId, 'u1');
    });

    test('join: a phone that did not answer for the follower gets no pointer', () {
      final s = statusOf(unlinkStatusJson(session: sessionJson(stage: 'join'))).session!;
      expect(s.join, isNull);
    });

    test('done and no session', () {
      expect(statusOf(unlinkStatusJson(session: sessionJson(stage: 'done'))).session!.stage, UnlinkStage.done);
      final st = statusOf(unlinkStatusJson(last: lastJson(outcome: 'expired'), kept: [keptJson()]));
      expect(st.session, isNull);
      expect(st.last!.outcome, 'expired');
      expect(st.last!.done, isFalse);
      expect(st.kept.single.otherChoice, UnlinkChoice.carryOn);
    });
  });

  group('the options of a side', () {
    test('a follower that was a new box: no backup, the empty option', () {
      final v = UnlinkSideView.fromJson(sideJson(eligible: 'before', back: false, empty: true));
      expect(v.available(UnlinkChoice.back), isFalse);
      expect(v.available(UnlinkChoice.carryOn), isTrue);
      expect(v.available(UnlinkChoice.empty), isTrue);
      expect(v.back.backupAt, isNull);
    });

    test('a backup that was dropped: carry on only', () {
      final v = UnlinkSideView.fromJson(sideJson(back: false));
      expect([for (final c in UnlinkChoice.values) v.available(c)], [false, true, false]);
    });

    test('a backup: its date and size', () {
      final v = UnlinkSideView.fromJson(sideJson());
      expect(v.back.available, isTrue);
      expect(v.back.backupAt, DateTime.utc(2026, 11, 20, 1, 41));
      expect(v.back.backupBytes, 52428800);
    });

    test('eligible any is read', () {
      expect(UnlinkSideView.fromJson(sideJson(eligible: 'any')).eligible, UnlinkEligible.any);
    });

    test('the finance tick is read from each side', () {
      expect(UnlinkSideView.fromJson(sideJson()).financeTick, isFalse);
      expect(UnlinkSideView.fromJson(sideJson(financeTick: true)).financeTick, isTrue);
      expect(() => UnlinkSideView.fromJson({...sideJson(), 'financeTick': 'yes'}), throwsFormatException);
      expect(() => UnlinkSideView.fromJson({...sideJson()}..remove('financeTick')), throwsFormatException);
    });

    test('the videos that do not fit are read with title and size', () {
      final v = UnlinkSideView.fromJson(followerCarry(videos: [
        {'title': 'Kuliah Maghrib', 'bytes': 734003200},
        {'title': 'Majlis Maulid', 'bytes': 1500000000},
      ]));
      expect(v.numbers.videosNotFit.map((e) => e.title), ['Kuliah Maghrib', 'Majlis Maulid']);
      expect(v.numbers.videosNotFit.last.bytes, 1500000000);
    });

    test('the copy step carries its percent, clamped to 0 to 100', () {
      final s = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': 41})));
      expect(s.session!.progress!.step, UnlinkStep.copy);
      expect(s.session!.progress!.percent, 41);
      final over = statusOf(unlinkStatusJson(session: sessionJson(stage: 'working', progress: {'step': 'copy', 'stepNo': 1, 'steps': 3, 'percent': 140})));
      expect(over.session!.progress!.percent, 100);
    });

    test('a kept row names the main box', () {
      final st = statusOf(unlinkStatusJson(kept: [keptJson(side: 'master', chosen: 'carry-on')]));
      expect(st.kept.single.masterName, 'Dewan Utama');
      expect(() => statusOf(unlinkStatusJson(kept: [{...keptJson()}..remove('masterName')])), throwsFormatException);
    });
  });

  group('strict', () {
    test('a stage this app does not know fails the whole read', () {
      expect(() => statusOf(unlinkStatusJson(session: sessionJson(stage: 'later'))), throwsFormatException);
    });

    test('a field of the wrong type fails', () {
      expect(() => statusOf(unlinkStatusJson(session: {...sessionJson(), 'rev': 'one'})), throwsFormatException);
      expect(() => statusOf(unlinkStatusJson(session: {...sessionJson(), 'master': null})), throwsFormatException);
      expect(() => statusOf(unlinkStatusJson(session: sessionJson(follower: {...sideJson(), 'agreed': 'yes'}))), throwsFormatException);
      expect(() => statusOf(unlinkStatusJson(session: sessionJson(follower: {...sideJson(), 'youtube': 'maybe'}))), throwsFormatException);
    });

    test('a join with a bad ticket, address or hash fails', () {
      for (final bad in [
        {...joinJson(), 'ticket': 'not a ticket'},
        {...joinJson(), 'addresses': <String>[]},
        {...joinJson(), 'addresses': ['http://10.168.50.12']},
        {...joinJson(), 'caSha256': 'zz'},
        {...joinJson(), 'boxId': 'short'},
      ]) {
        expect(() => statusOf(unlinkStatusJson(session: sessionJson(stage: 'join', join: bad))), throwsFormatException, reason: '$bad');
      }
    });

    test('a result and a kept row with a word that is not in the contract fail', () {
      expect(() => statusOf(unlinkStatusJson(last: lastJson(outcome: 'lost'))), throwsFormatException);
      expect(() => statusOf(unlinkStatusJson(kept: [keptJson(chosen: 'empty')])), throwsFormatException);
      expect(() => statusOf(unlinkStatusJson(kept: [keptJson(side: 'both')])), throwsFormatException);
    });
  });
}
