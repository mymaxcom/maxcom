// "Main sekarang": shows one Video item on the TV at once (box feature `videoPlayNow`,
// `POST /api/content/video/<id>/play-now`). The box refuses in prayer phases (409 `prayer_phase`)
// and while a live is on the TV (409 `live_running`); the refusal is shown in plain words.
//
// There is no cloud relay for content actions: the button is offered only when the app talks to the
// box on the surau Wi-Fi, and only for a box that lists `videoPlayNow`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../features/common/error_text.dart';
import '../l10n/generated/s.dart';
import 'editors/content_form.dart' show contentPath;

const String videoPlayNowFeature = 'videoPlayNow';

/// True when the button is offered: the box lists the feature (an unknown or older box does not), and the
/// session is the box's own, not the cloud's.
final playNowAvailableProvider = Provider<bool>((ref) {
  if (ref.watch(isCloudGatewayProvider)) return false;
  final h = ref.watch(healthProvider).value?.value;
  return h != null && h.supports(videoPlayNowFeature);
});

class PlayNowButton extends ConsumerStatefulWidget {
  const PlayNowButton({super.key, required this.itemId, this.compact = false});

  final String itemId;

  /// An icon button for a list row; the editor shows the full button.
  final bool compact;

  @override
  ConsumerState<PlayNowButton> createState() => _PlayNowButtonState();
}

class _PlayNowButtonState extends ConsumerState<PlayNowButton> {
  bool _busy = false;

  Future<void> _go() async {
    final s = S.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null || _busy) return;
    setState(() => _busy = true);
    String say;
    try {
      await gateway.post('${contentPath('video')}/${widget.itemId}/play-now', const <String, dynamic>{});
      say = s.videoPlayNowDone;
    } catch (e) {
      say = errorText(s, e);
    }
    if (mounted) setState(() => _busy = false);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(say)));
  }

  @override
  Widget build(BuildContext context) {
    if (!ref.watch(playNowAvailableProvider)) return const SizedBox.shrink();
    final s = S.of(context);
    if (widget.compact) {
      return IconButton(
        key: ValueKey('play-now-${widget.itemId}'),
        tooltip: s.videoPlayNow,
        icon: const Icon(Icons.play_circle_outline_rounded),
        onPressed: _busy ? null : _go,
      );
    }
    // the gap above belongs to the button: a box without the feature leaves the editor exactly as it was
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: OutlinedButton.icon(
        key: const ValueKey('video-play-now'),
        onPressed: _busy ? null : _go,
        icon: const Icon(Icons.play_circle_outline_rounded),
        label: Text(s.videoPlayNow),
      ),
    );
  }
}
