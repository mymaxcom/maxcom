// A TV-shaped frame with the kiosk page in it, asked to wear one theme on one
// catalog screen with the given (possibly unsaved) values. Used by the
// Templat paparan gallery and the Ubah suai editor.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/router.dart' show previewBuilderProvider;
import '../../app/theme.dart';
import '../../content/preview_host.dart';
import '../../content/preview_target.dart';
import '../../features/theme/theme_style.dart';
import '../../l10n/generated/s.dart';
import '../preview_screen.dart';

class ThemePreviewFrame extends ConsumerWidget {
  const ThemePreviewFrame({
    super.key,
    required this.theme,
    required this.screen,
    required this.entry,
    this.staged,
    this.pack,
    this.now,
    this.utcOffsetMinutes = defaultUtcOffsetMinutes,
  });

  final String theme;
  final String screen;
  final ThemeStyleEntry entry;

  /// A theme file the box has checked but not installed yet (its staged id), with what the file says.
  final String? staged;
  final Map<String, Object?>? pack;

  /// The clock to pin the page at; null follows the real time.
  final DateTime? now;
  final int utcOffsetMinutes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final target = ref.watch(previewTargetProvider);
    final session = ref.watch(sessionProvider);
    final deps = ref.watch(appDepsProvider);
    final builder = ref.watch(previewBuilderProvider);
    return Container(
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: target == null || session == null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    s.previewNoSession,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: Colors.white),
                  ),
                ),
              )
            : builder(
                context,
                PreviewRequest(
                  box: target.origin,
                  token: session.token,
                  now: now,
                  utcOffsetMinutes: utcOffsetMinutes,
                  generation: 0,
                  theme: PreviewThemeRequest(theme: theme, screen: screen, entry: entry, staged: staged, pack: pack),
                  pinnedLeaf: deps.boxLeaf == null ? null : () => deps.boxLeaf!(target.leafBox),
                  onSslError: (_, _) {},
                ),
              ),
      ),
    );
  }
}
