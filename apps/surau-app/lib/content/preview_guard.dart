// The app's own notice for a preview that cannot be shown (timeout, host
// unreachable), with a retry, instead of the browser's raw error page. The
// guard wraps the real host in every place that shows the kiosk page: the
// Pratonton screen, the poster editor's `Pratonton di TV`, Ubah suai and the
// theme gallery. A failure never changes the size of the frame, so the
// controls around it stay where they are and usable.

import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../l10n/generated/s.dart';

typedef GuardedBuilder = Widget Function(BuildContext context, VoidCallback onLoadError, int attempt);

class PreviewGuard extends StatefulWidget {
  const PreviewGuard({super.key, required this.resetKey, required this.builder});

  /// What the preview is about (the address and the reload count): a new
  /// value clears an earlier failure and tries again.
  final Object resetKey;

  /// Builds the host; [attempt] changes on every retry so the host reloads.
  final GuardedBuilder builder;

  @override
  State<PreviewGuard> createState() => _PreviewGuardState();
}

class _PreviewGuardState extends State<PreviewGuard> {
  bool _failed = false;
  int _attempt = 0;

  void _onLoadError() {
    if (mounted && !_failed) setState(() => _failed = true);
  }

  void _retry() => setState(() {
    _failed = false;
    _attempt++;
  });

  @override
  void didUpdateWidget(PreviewGuard old) {
    super.didUpdateWidget(old);
    if (old.resetKey != widget.resetKey) {
      _failed = false;
      _attempt++;
    }
  }

  @override
  Widget build(BuildContext context) =>
      _failed ? PreviewFailedNotice(onRetry: _retry) : widget.builder(context, _onLoadError, _attempt);
}

/// On glass: the preview could not be shown; one calm line and a retry.
class PreviewFailedNotice extends StatelessWidget {
  const PreviewFailedNotice({super.key, required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    return ColoredBox(
      color: SurauColors.glass,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.cloud_off_rounded, color: SurauColors.gold, size: 28),
                const SizedBox(height: 8),
                Text(
                  t.previewLoadFailed,
                  key: const ValueKey('preview-load-failed'),
                  textAlign: TextAlign.center,
                  style: text.titleSmall!.copyWith(color: Colors.white),
                ),
                const SizedBox(height: 10),
                FilledButton.icon(
                  key: const ValueKey('preview-load-retry'),
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh_rounded),
                  label: Text(t.actionRetry),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
