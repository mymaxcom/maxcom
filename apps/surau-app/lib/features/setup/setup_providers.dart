import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/setup_client.dart';
import 'setup_flow.dart';

/// The setup, recovery and probe flows, built from the app's platform pieces (the same key store, trust and
/// box store the enrol flow uses).
final setupFlowProvider = Provider<SetupFlow>((ref) {
  final deps = ref.watch(appDepsProvider);
  return SetupFlow(
    clientFor: deps.clientFor,
    key: deps.key,
    trust: deps.trust,
    store: deps.boxStore,
    surauInfoStore: deps.surauInfoStore,
    platform: deps.platform,
    now: deps.now,
  );
});

/// `GET /api/box/info` of the enrolled box (name, id, key fingerprint). Null while it has not answered, when the box is
/// away, and when the app talks to the cloud (which has no box screen): a failure here never shows an error or retries,
/// the pages simply leave the line out.
final boxInfoProvider = FutureProvider<BoxInfo?>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  try {
    final read = await gateway.get('/api/box/info');
    final m = read.value;
    return m['boxId'] is String ? BoxInfo.fromJson(m) : null;
  } on Object {
    return null;
  }
});

/// The signed-in Pentadbir's own enrolment codes of the last 24 hours (`GET /api/enrol/recent`); empty on any failure.
final enrolRecentProvider = FutureProvider<List<EnrolCodeStatus>>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return const [];
  try {
    return await SetupClient(gateway.client).enrolRecent(gateway);
  } on Object {
    return const [];
  }
});

/// Whether the box has a recovery code (`GET /api/recovery/status`); null on any failure or for a person who may not
/// ask. Only `Pengguna` reads it, and only for a holder of `users:manage`.
final recoveryCodeSetProvider = FutureProvider<bool?>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  try {
    return await SetupClient(gateway.client).recoveryCodeSet(gateway);
  } on Object {
    return null;
  }
});
