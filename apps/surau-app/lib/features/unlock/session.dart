import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../box/wire.dart';

/// The live session: set by the unlock screen, cleared on 401 or sign out
/// (Task 6 guards routes on it). Not persisted: a restart unlocks again.
class SessionNotifier extends Notifier<SessionDto?> {
  @override
  SessionDto? build() => null;

  void set(SessionDto session) => state = session;

  void clear() => state = null;
}

final sessionProvider =
    NotifierProvider<SessionNotifier, SessionDto?>(SessionNotifier.new);
