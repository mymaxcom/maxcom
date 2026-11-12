// The surau's logo wherever the surau's name leads: the dashboard header,
// the rail, the unlock door and the enrolment review. The picture comes
// from the box's public `/surau-logo` through the pinned client (never a
// plain network image: the box's root CA is not in the system store), is
// kept for the run, and is simply absent when the surau has none or the
// box is away, so every layout is exactly the old one without it. It is
// sized by height with its own shape (the kiosk's rule): a square mark is
// a square tile, a wide wordmark is wide, never stretched. When the surau
// says the logo already carries the name (`showName` off) the headers
// draw the logo alone. A logo of dark ink on transparency (a black wordmark
// after "Buang latar putih") would vanish on the dark headers, so it sits on
// the box's light plate colour (see logo_ink.dart); every other logo is
// drawn bare.

import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../content/adjusted_picture.dart' show plateColour;
import '../../content/image_bg.dart' show pictureSize;
import 'logo_ink.dart';

/// The padding of the light card, as a share of the logo's height.
const double _cardPadding = 0.1;

/// Fetches [path] (the box's `/surau-logo?v=...`) through [client]; null
/// on any failure. Shared by the providers and the doors, which have a
/// client but no gateway.
Future<Uint8List?> fetchSurauLogo(BoxClient client, String? path) async {
  if (path == null) return null;
  try {
    final bytes = await client.getBytes(path);
    return bytes.isEmpty ? null : bytes;
  } on Object {
    return null;
  }
}

/// The logo bytes for the enrolled box, keyed by the logo path so a new
/// logo (new `?v=` tag) is fetched at once; null without a logo, a client
/// or a reachable box.
final surauLogoProvider = FutureProvider<Uint8List?>((ref) async {
  final path = ref.watch(surauInfoProvider.select((i) => i?.logo));
  if (path == null) return null;
  final client = ref.watch(enrolledClientProvider).value;
  if (client == null) return null;
  return fetchSurauLogo(client, path);
});

/// Whether the enrolled surau wants its name written beside the logo.
final surauShowNameProvider = Provider<bool>(
  (ref) => ref.watch(surauInfoProvider.select((i) => i?.showName ?? true)),
);

/// The widest a logo gets for its height (a wordmark about 5 : 1).
const double logoMaxAspect = 5;

/// The logo at [height], as wide as its own shape says (a compact mark
/// gets a square tile, a wordmark up to [maxWidth]), or nothing at all.
class LogoImage extends StatelessWidget {
  const LogoImage({super.key, required this.bytes, this.height = 44, this.maxWidth, this.radius = 10});

  final Uint8List? bytes;
  final double height;
  final double? maxWidth;
  final double radius;

  /// The width [bytes] take at [height]: at least a square, at most
  /// [maxWidth] (or [logoMaxAspect] times the height).
  static double widthFor(Uint8List bytes, double height, {double? maxWidth}) {
    final size = pictureSize(bytes);
    final aspect = size == null ? 1.0 : size.width / size.height;
    final cap = maxWidth ?? height * logoMaxAspect;
    return (height * aspect).clamp(height, cap > height ? cap : height);
  }

  @override
  Widget build(BuildContext context) {
    final b = bytes;
    if (b == null) return const SizedBox.shrink();
    final card = logoWantsLightCardCached(b);
    var width = widthFor(b, height, maxWidth: maxWidth);
    if (card) {
      // The card hugs the logo (10 % of the height of padding on every
      // side) but never grows past the width the logo would have had.
      final size = pictureSize(b);
      final aspect = size == null ? 1.0 : size.width / size.height;
      final pad = height * _cardPadding;
      width = math.min(width, math.max(height, (height - 2 * pad) * aspect + 2 * pad));
    }
    final picture = Image.memory(
      b,
      fit: BoxFit.contain,
      gaplessPlayback: true,
      filterQuality: FilterQuality.medium,
      errorBuilder: (_, _, _) => const SizedBox.shrink(),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        key: const ValueKey('surau-logo'),
        width: width,
        height: height,
        child: card
            ? ColoredBox(
                color: plateColour,
                child: Padding(padding: EdgeInsets.all(height * _cardPadding), child: picture),
              )
            : picture,
      ),
    );
  }
}

/// The enrolled surau's logo from [surauLogoProvider], sized for a header.
class SurauLogo extends ConsumerWidget {
  const SurauLogo({super.key, this.height = 44, this.maxWidth, this.radius = 10});

  final double height;
  final double? maxWidth;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(surauLogoProvider).value;
    if (bytes == null) return const SizedBox.shrink();
    return LogoImage(bytes: bytes, height: height, maxWidth: maxWidth, radius: radius);
  }
}

/// A row of the logo and the surau's name in gold, as the headers draw it;
/// without [logo] it is the plain name, exactly as before; with [showName]
/// off and a logo, the logo alone.
class SurauNameRow extends StatelessWidget {
  const SurauNameRow({
    super.key,
    required this.name,
    required this.logo,
    this.style,
    this.showName = true,
    this.centered = false,
    this.maxLines = 2,
  });

  final String name;
  final Widget? logo;
  final TextStyle? style;
  final bool showName;
  final bool centered;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final nameText = Text(
      name,
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      textAlign: centered ? TextAlign.center : TextAlign.start,
      style: style ?? text.titleMedium!.copyWith(color: SurauColors.gold, letterSpacing: 0.2),
    );
    final l = logo;
    if (l == null) return nameText;
    if (!showName) {
      return Row(
        mainAxisSize: centered ? MainAxisSize.min : MainAxisSize.max,
        mainAxisAlignment: centered ? MainAxisAlignment.center : MainAxisAlignment.start,
        children: [Flexible(child: l)],
      );
    }
    return Row(
      mainAxisSize: centered ? MainAxisSize.min : MainAxisSize.max,
      mainAxisAlignment: centered ? MainAxisAlignment.center : MainAxisAlignment.start,
      children: [
        l,
        const SizedBox(width: 12),
        Flexible(child: nameText),
      ],
    );
  }
}
