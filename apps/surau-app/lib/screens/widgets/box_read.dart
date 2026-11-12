// One provider for every list the people screens read from the box:
// `GET <path>` through the gateway (fresh, or the last cached body with
// the offline banner showing), refetched when the health poll reports a
// new data version or after one of this app's own writes. [BoxReadView]
// draws the three states the same way on every page, and
// [writeErrorText] turns a failed write into the words the person sees.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../features/shell/box_gateway.dart';
import '../../features/shell/read_cache.dart';
import '../../l10n/generated/s.dart';
import '../../sync/sync_engine.dart' show AssetTooLarge;

typedef JsonRead = Read<Map<String, dynamic>>?;

class BoxJsonNotifier extends AsyncNotifier<JsonRead> {
  BoxJsonNotifier(this.path);

  final String path;

  @override
  Future<JsonRead> build() async {
    ref.watch(dataVersionProvider);
    final gateway = ref.watch(gatewayProvider);
    if (gateway == null) return null;
    return gateway.get(path);
  }

  /// After a write, or `Cuba lagi`: the last value stays readable while
  /// the box answers.
  Future<void> refresh() async {
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    state = await AsyncValue.guard(() => gateway.get(path));
  }
}

/// `GET path` for any path; screens derive their typed value from it.
final boxJsonProvider =
    AsyncNotifierProvider.family<BoxJsonNotifier, JsonRead, String>(
      BoxJsonNotifier.new,
    );

/// The three states of a box read: a thin bar while the first answer is
/// awaited, a calm failure with `Cuba lagi` when nothing is cached, and
/// [builder] with the body (fresh or stale) otherwise.
class BoxReadView extends ConsumerWidget {
  const BoxReadView({
    super.key,
    required this.path,
    required this.builder,
  });

  final String path;
  final Widget Function(BuildContext context, Map<String, dynamic> body) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final read = ref.watch(boxJsonProvider(path));
    final value = read.value;
    if (value != null) return builder(context, value.value);
    if (read.isLoading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 24),
        child: LinearProgressIndicator(minHeight: 2),
      );
    }
    final error = read.error;
    final String message;
    if (error is BoxError) {
      message = error.status == 403 ? s.errorForbidden : error.message;
    } else if (error is BoxUnreachable) {
      message = s.errorBoxUnreachable;
    } else {
      message = s.loadFailed;
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(
        children: [
          const Icon(Icons.cloud_off_rounded, size: 36, color: SurauColors.outline),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center, style: text.bodyLarge),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => ref.read(boxJsonProvider(path).notifier).refresh(),
            icon: const Icon(Icons.refresh_rounded),
            label: Text(s.actionRetry),
          ),
        ],
      ),
    );
  }
}

/// What a failed write means in the person's words. The box's own BM
/// message is kept wherever it has one; 403 and 429 get the app's.
String writeErrorText(S s, Object error) {
  if (error is OfflineWriteRefused) return OfflineWriteRefused.message;
  if (error is LiveOnly) return s.liveOnlyNeedsConnection;
  if (error is AssetTooLarge) return s.assetTooLarge;
  if (error is SessionExpired) return s.errorSessionExpired;
  if (error is BoxError) {
    if (error.status == 403) return s.errorForbidden;
    if (error.status == 429) return s.errorTooMany;
    return error.message;
  }
  if (error is BoxUnreachable) return s.errorBoxUnreachable;
  return s.errorUnknown;
}
