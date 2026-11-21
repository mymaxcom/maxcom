// The joining of a live's recording pieces into one file (2026.11.14): the Android joiner (MediaMuxer on the phone),
// the browser's save of the joined file, and what the Live screen remembers between the end of the live and the
// person's tap on "Simpan rakaman" (web).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../upload/recording_join.dart';
import '../live/live_controller.dart' show recordingsStoreProvider;
import '../live/recording_transfer.dart';
import '../live/save_bytes.dart';

final androidRecordingJoinerProvider = Provider<AndroidRecordingJoiner>((_) => AndroidRecordingJoiner());

final saveBytesProvider = Provider<SaveBytes>((_) => saveBytesToDevice);

/// Web: the join of the live just ended, ready to be saved by one tap; null when none.
class WebJoined {
  const WebJoined({required this.liveId, required this.sessionId, required this.fileName});
  final String liveId;
  final String sessionId;
  final String fileName;
}

final webJoinedProvider = NotifierProvider<WebJoinedNotifier, WebJoined?>(WebJoinedNotifier.new);

class WebJoinedNotifier extends Notifier<WebJoined?> {
  @override
  WebJoined? build() => null;

  void set(WebJoined? v) => state = v;
}

final webRecordingJoinProvider = Provider<WebRecordingJoin?>((ref) {
  final store = ref.watch(recordingsStoreProvider);
  final gateway = ref.watch(gatewayProvider);
  if (store == null || gateway == null) return null;
  // Away from the surau the gateway talks to the cloud, which has no recording route: nothing is sent (`box_away`).
  final RecordingTransfer? transfer = ref.watch(isCloudGatewayProvider)
      ? const AwayRecordingTransfer()
      : openRecordingTransfer(box: gateway.client.box, token: gateway.token);
  return WebRecordingJoin(store: store, gateway: gateway, saveBytes: ref.watch(saveBytesProvider), transfer: transfer);
});
