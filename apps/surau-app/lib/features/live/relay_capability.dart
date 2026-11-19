// Whether the box can re-encode the YouTube picture (`relayReencode` of
// `GET /api/live/status`). The Android box's ffmpeg has no H.264 encoder, so
// "Kod semula" cannot run there. Null while unknown: an older box that does
// not say, no gateway yet, or an answer that failed; every choice then stays
// on, as before.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';

final relayReencodeProvider = FutureProvider.autoDispose<bool?>((ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  try {
    final raw = await gateway.getFresh('/api/live/status');
    final v = raw['relayReencode'];
    return v is bool ? v : null;
  } catch (_) {
    return null;
  }
});
