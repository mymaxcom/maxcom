// The providers the hadis controllers stand on: the repository over the
// signed-in gateway and the delays (a test overrides them to run fast).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import 'hadis_api.dart';

/// Null until enrolled and unlocked, like the gateway.
final hadisRepositoryProvider = Provider<HadisRepository?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  return gateway == null ? null : HadisRepository(gateway);
});

/// How long the screens wait: after the last key before a search, between
/// two reads of the box's online state, between two reads of a download job.
class HadisTiming {
  const HadisTiming({
    this.searchDebounce = const Duration(milliseconds: 300),
    this.statusPoll = const Duration(seconds: 30),
    this.jobPoll = const Duration(seconds: 1),
  });

  final Duration searchDebounce;
  final Duration statusPoll;
  final Duration jobPoll;
}

final hadisTimingProvider = Provider<HadisTiming>((ref) => const HadisTiming());
