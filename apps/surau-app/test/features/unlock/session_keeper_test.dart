// The reconnector: tries while offline (15 s backing off to 2 min), honours
// a waking cloud's Retry-After (capped at 90 s), switches a cloud session to
// the box when it answers, ends on a refusal with the server's words, and
// recovers a 401 silently before giving up.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/locator.dart';
import 'package:surau_app/features/unlock/session_keeper.dart';
import 'package:surau_app/features/unlock/unlock_flow.dart';

const _user = SessionUser(id: 'u1', name: 'Ustaz Ali', roles: ['admin']);
final _offline = SessionDto.offline(_user);
final _box = Uri.parse('https://127.0.0.1:8443');
final _cloud = Uri.parse('https://api.mymaxcom.my');

SessionDto _at(String via) => SessionDto(
  token: 'tok-$via',
  expiresAt: 'x',
  user: _user,
).issuedBy(via == 'cloud' ? _cloud : _box, via);

class _Clock {
  final List<(Duration, void Function())> timers = [];

  Timer schedule(Duration d, void Function() f) {
    timers.add((d, f));
    return _FakeTimer(() => timers.removeWhere((t) => t.$2 == f));
  }

  Duration get next => timers.last.$1;

  Future<void> fire() async {
    final t = timers.removeLast();
    t.$2();
    await pumpEventQueue();
  }
}

class _FakeTimer implements Timer {
  _FakeTimer(this._cancel);

  final void Function() _cancel;
  bool _active = true;

  @override
  void cancel() {
    _active = false;
    _cancel();
  }

  @override
  bool get isActive => _active;

  @override
  int get tick => 0;
}

void main() {
  late _Clock clock;
  late List<bool> asked;
  late List<Object> answers;
  late List<SessionDto> connected;
  late List<String?> refused;
  late int unavailable;
  late SessionKeeper keeper;

  setUp(() {
    clock = _Clock();
    asked = [];
    answers = [];
    connected = [];
    refused = [];
    unavailable = 0;
    keeper = SessionKeeper(
      attempt: ({required boxOnly}) async {
        asked.add(boxOnly);
        final a = answers.removeAt(0);
        if (a is SessionDto) return a;
        throw a;
      },
      onConnected: (s) {
        connected.add(s);
        keeper.follow(s);
      },
      onRefused: refused.add,
      onUnavailable: () async => unavailable++,
      schedule: clock.schedule,
    );
  });

  test('offline: tries after 15 s, backs off to 2 min, then connects', () async {
    keeper.follow(_offline);
    expect(clock.next, const Duration(seconds: 15));
    answers.addAll([
      const BoxUnreachable(),
      const BoxUnreachable(),
      const BoxUnreachable(),
      const BoxUnreachable(),
    ]);
    final waits = <Duration>[];
    for (var i = 0; i < 4; i++) {
      await clock.fire();
      waits.add(clock.next);
    }
    expect(waits, [
      const Duration(seconds: 30),
      const Duration(minutes: 1),
      const Duration(minutes: 2),
      const Duration(minutes: 2),
    ]);
    expect(asked, everyElement(isFalse), reason: 'box then cloud');
    answers.add(_at('box'));
    await clock.fire();
    expect(connected.single.via, 'box');
    expect(clock.timers, isEmpty, reason: 'a live box session needs no loop');
  });

  test('a waking cloud is asked again after its Retry-After, at most 90 s',
      () async {
    keeper.follow(_offline);
    answers.add(const CloudWaking(retryAfterSec: 35));
    await clock.fire();
    expect(clock.next, const Duration(seconds: 35));
    answers.add(const CloudWaking(retryAfterSec: 600));
    await clock.fire();
    expect(clock.next, const Duration(seconds: 90));
    answers.add(_at('cloud'));
    await clock.fire();
    expect(connected.single.via, 'cloud');
  });

  test('a refusal ends the session with the server words', () async {
    keeper.follow(_offline);
    answers.add(const UnlockRevoked('Peranti telah dibatalkan'));
    await clock.fire();
    expect(refused, ['Peranti telah dibatalkan']);
    expect(connected, isEmpty);
  });

  test('a cloud session probes the box alone and switches when it answers',
      () async {
    keeper.follow(_at('cloud'));
    answers.addAll([const BoxUnreachable(), _at('box')]);
    await clock.fire();
    expect(asked, [true]);
    await clock.fire();
    expect(asked, [true, true]);
    expect(connected.single.via, 'box');
  });

  test('kick tries at once; pause stops until resume', () async {
    keeper.follow(_offline);
    keeper.pause();
    expect(clock.timers, isEmpty);
    keeper.kick();
    expect(asked, isEmpty);
    answers.add(_at('box'));
    keeper.resume();
    await pumpEventQueue();
    expect(connected.single.via, 'box');
  });

  test('resume without a pause does not try (the shell calls it on open)',
      () async {
    keeper.follow(_offline);
    keeper.resume();
    await pumpEventQueue();
    expect(asked, isEmpty);
    expect(clock.next, const Duration(seconds: 15));
  });

  test('an unlock in flight from the unlock screen is adopted', () async {
    keeper.follow(_offline);
    final c = Completer<SessionDto>();
    keeper.adopt(c.future);
    c.complete(_at('cloud'));
    await pumpEventQueue();
    expect(connected.single.via, 'cloud');
    expect(asked, isEmpty);
  });

  group('401 on a live session', () {
    test('recovers silently', () async {
      keeper.follow(_at('cloud'));
      answers.add(_at('box'));
      await keeper.expired();
      expect(connected.single.via, 'box');
      expect(refused, isEmpty);
    });

    test('a refusal is shown', () async {
      keeper.follow(_at('box'));
      answers.add(const UnlockWrongPin('PIN salah'));
      await keeper.expired();
      expect(refused, ['PIN salah']);
    });

    test('PIN mode with no PIN in memory: back to the unlock screen, no '
        'request, no notice', () async {
      keeper.follow(_at('box'));
      answers.add(const NeedsPin());
      await keeper.expired();
      expect(refused, [null]);
    });

    test('no base: handed to onUnavailable (offline or unlock)', () async {
      keeper.follow(_at('box'));
      answers.add(const BoxUnreachable());
      await keeper.expired();
      expect(unavailable, 1);
    });

    test('offline it only means a base answered: try now', () async {
      keeper.follow(_offline);
      answers.add(_at('box'));
      await keeper.expired();
      await pumpEventQueue();
      expect(connected.single.via, 'box');
    });
  });
}
