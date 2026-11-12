// Lagi > Peranti ini > Semakan rangkaian: the phone's side of the network check.
// Whether the box answers right now, whether the cloud is linked and reachable,
// and when the phone last synced.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../box/setup_client.dart';
import '../../l10n/generated/s.dart';
import '../../sync/sync_engine.dart' show SyncState;
import '../../sync/sync_providers.dart' show syncViewProvider;
import '../common/time_words.dart';

Future<void> showNetworkCheck(BuildContext context) => showModalBottomSheet<void>(
  context: context,
  useSafeArea: true,
  builder: (_) => const NetworkCheckSheet(),
);

class NetworkCheckSheet extends ConsumerStatefulWidget {
  const NetworkCheckSheet({super.key});

  @override
  ConsumerState<NetworkCheckSheet> createState() => _NetworkCheckSheetState();
}

class _NetworkCheckSheetState extends ConsumerState<NetworkCheckSheet> {
  bool? _boxUp;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    bool up;
    try {
      final client = await ref.read(enrolledClientProvider.future);
      if (client == null) {
        up = false;
      } else {
        await SetupClient(client).boxInfo();
        up = true;
      }
    } on Object {
      up = false;
    }
    if (mounted) setState(() => _boxUp = up);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final deps = ref.watch(appDepsProvider);
    final box = ref.watch(enrolledBoxProvider);
    final sync = ref.watch(syncViewProvider).value;
    final last = sync?.lastSync;
    final cloudLinked = box?.cloud != null;
    final cloudUp = cloudLinked && sync != null && sync.state != SyncState.offline && sync.lastError == null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.netCheckTitle, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          _Row(
            key: const ValueKey('net-box'),
            ok: _boxUp,
            text: _boxUp == null ? s.netCheckTitle : (_boxUp! ? s.netBoxReachable : s.netBoxDown),
          ),
          _Row(
            key: const ValueKey('net-cloud'),
            ok: cloudLinked ? cloudUp : null,
            text: !cloudLinked ? s.netCloudNone : (cloudUp ? s.netCloudReachable : s.netCloudDown),
          ),
          _Row(
            key: const ValueKey('net-last'),
            ok: last != null,
            text: last == null
                ? s.netNeverSynced
                : s.netLastSync(whenWords(deps.toLocal(last), today: deps.toLocal(deps.now()))),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () {
                setState(() => _boxUp = null);
                _check();
              },
              child: Text(s.errRetry),
            ),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({super.key, required this.ok, required this.text});

  /// True green tick, false red cross, null grey (unknown / not applicable).
  final bool? ok;
  final String text;

  @override
  Widget build(BuildContext context) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: Icon(
      ok == null ? Icons.remove_circle_outline_rounded : (ok! ? Icons.check_circle_outline_rounded : Icons.cancel_outlined),
      color: ok == null ? SurauColors.muted : (ok! ? SurauColors.teal : SurauColors.danger),
    ),
    title: Text(text),
  );
}
