// Poster: its title first (a new poster is "Poster <n+1>" after the n the
// box lists, as core's defaultPosterTitle), the picture (resized on the
// device, uploaded first), the days it shows, optional dates, its place in
// the rotation, and `Pratonton di TV`: the real kiosk page in preview mode
// showing exactly this poster, saved or still a draft, marked PRATONTON;
// nothing changes on the TV.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/preview_screen.dart';
import '../image_ref.dart' show ImageRef;
import '../kinds.dart';
import '../preview_message.dart';
import 'content_form.dart';

class PosterEditor extends StatelessWidget {
  const PosterEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  /// [liveCount] is how many posters the box lists now.
  static Map<String, dynamic> defaults(int nextOrder, int liveCount) => {
    'title': defaultPosterTitle(liveCount),
    'days': ['umum'],
    'order': nextOrder,
  };

  /// Mirror of core's `defaultPosterTitle`: `Poster` followed by the live
  /// count plus one.
  static String defaultPosterTitle(int liveCount) => 'Poster ${liveCount + 1}';

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('poster')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
    // The kiosk preview shows the uploaded picture itself; the box renders
    // the adjusted one when the poster is saved.
    extra: (context, values) => PosterPreviewButton(
      poster: PreviewPoster.tryFrom(ImageRef.assetIdOf(values['assetId']), values['title']),
    ),
  );
}

/// `Pratonton di TV`: enabled once the poster has a picture on the box
/// (a draft's upload counts), opens [PosterPreviewDialog].
class PosterPreviewButton extends StatelessWidget {
  const PosterPreviewButton({super.key, required this.poster});

  /// Null while the form has no (valid) asset id yet.
  final PreviewPoster? poster;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final p = poster;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OutlinedButton.icon(
          key: const ValueKey('poster-preview'),
          onPressed: p == null ? null : () => showPosterPreview(context, p),
          icon: const Icon(Icons.tv_outlined),
          label: Text(s.posterPreviewButton),
        ),
        if (p == null) ...[
          const SizedBox(height: 6),
          Text(s.posterPreviewNeedsImage, style: text.bodySmall),
        ],
      ],
    );
  }
}

Future<void> showPosterPreview(BuildContext context, PreviewPoster poster) {
  return showDialog<void>(
    context: context,
    useSafeArea: true,
    builder: (context) => PosterPreviewDialog(poster: poster),
  );
}

/// The kiosk page in a TV-shaped frame showing one poster, on the app's
/// paper with the PRATONTON note, and `Tutup`.
class PosterPreviewDialog extends ConsumerWidget {
  const PosterPreviewDialog({super.key, required this.poster});

  final PreviewPoster poster;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final box = ref.watch(enrolledBoxProvider);
    final session = ref.watch(sessionProvider);
    final builder = ref.watch(previewBuilderProvider);
    final width = MediaQuery.sizeOf(context).width;
    return Dialog(
      insetPadding: EdgeInsets.symmetric(horizontal: width < 500 ? 12 : 24, vertical: 24),
      clipBehavior: Clip.antiAlias,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 960),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      poster.title.isEmpty ? s.posterPreviewTitle : poster.title,
                      key: const ValueKey('poster-preview-title'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleLarge,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: SurauColors.goldSoft,
                      borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                    ),
                    child: Text(
                      s.previewRibbon,
                      style: text.labelMedium!.copyWith(color: SurauColors.ink, letterSpacing: 1.5),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(s.posterPreviewHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
              const SizedBox(height: 14),
              Container(
                decoration: BoxDecoration(
                  color: SurauColors.glass,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
                  border: Border.all(color: SurauColors.goldHairline),
                ),
                clipBehavior: Clip.antiAlias,
                child: AspectRatio(
                  aspectRatio: 16 / 9,
                  child: box == null || session == null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              s.previewNoSession,
                              textAlign: TextAlign.center,
                              style: text.bodyLarge!.copyWith(color: Colors.white),
                            ),
                          ),
                        )
                      : builder(
                          context,
                          PreviewRequest(
                            box: box.box,
                            token: session.token,
                            now: null,
                            generation: 0,
                            poster: poster,
                            onSslError: (_, _) {},
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: Text(s.actionClose),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
