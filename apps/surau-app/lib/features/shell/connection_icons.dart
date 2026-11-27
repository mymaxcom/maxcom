// The MAXCOM cloud and the MAXCOM box at the surau, as two icons at the end
// of every page's top bar (operator round 1, screen 16): always the cloud
// first, then the box. Each has four states told apart by shape, not by
// colour alone: connected (a tick), connecting (a dashed outline and three
// dots), syncing (turning arrows) and disconnected (a red X on top, the
// glyph faded). A tap opens what the app already had: the sync sheet for
// the cloud; for the box, the same check again as the offline banner's
// `Cuba lagi`, with its answer in one line.
//
// The cloud is hidden while no sync engine runs (not unlocked, no local
// store), as the sync chip it replaces was, so a page never claims a state
// nobody keeps; a session issued by the cloud always shows it.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../box/wire.dart' show SessionDto;
import '../../l10n/generated/s.dart';
import '../../sync/sync_engine.dart';
import '../../sync/sync_providers.dart';
import '../common/time_words.dart';
import '../sync/sync_actions.dart';
import '../sync/sync_status_chip.dart' show showSyncSheet;
import '../labels.dart' show appLangOfS;
import '../unlock/session_keeper.dart';
import 'box_gateway.dart' show BoxReach;

enum LinkState { connected, connecting, syncing, disconnected, error }

enum LinkKind { cloud, box }

/// The badge drawn on a glyph; one per state, so the shape alone tells them
/// apart.
enum LinkBadge { tick, dots, arrows, cross, warn }

LinkBadge _badgeOf(LinkState s) => switch (s) {
  LinkState.connected => LinkBadge.tick,
  LinkState.connecting => LinkBadge.dots,
  LinkState.syncing => LinkBadge.arrows,
  LinkState.disconnected => LinkBadge.cross,
  LinkState.error => LinkBadge.warn,
};

/// Codes of a sync run that did not reach the other side (the network, not
/// the answer). Any other `lastError` on an offline run is an answer the
/// server gave and the engine could not use (K7).
bool isNetworkSyncError(String? code) =>
    code == null || code == 'unreachable' || code == 'cloud_unreachable';

/// The last sync run found the box and then failed with it: a failure of the
/// box exchange, which says nothing about the cloud (B13).
bool boxSyncFailed(SyncView v) => v.state == SyncState.offline && v.lastError != null && v.failedVia == 'box';

/// The cloud as the sync engine sees it, most urgent first.
LinkState cloudStateOf(SyncView v) {
  if (v.state == SyncState.waking) return LinkState.connecting;
  // A sync that failed against the BOX is the box icon's to show: the cloud
  // was not asked, so its icon is never turned red by it.
  if (boxSyncFailed(v)) return v.lastSync == null ? LinkState.connecting : LinkState.connected;
  if (v.state == SyncState.offline && !isNetworkSyncError(v.lastError)) {
    return LinkState.error;
  }
  if (v.state == SyncState.offline ||
      v.lastError == 'unreachable' ||
      v.lastError == 'cloud_unreachable') {
    return LinkState.disconnected;
  }
  if (v.state == SyncState.syncing || v.pendingOut > 0) return LinkState.syncing;
  if (v.lastSync == null) return LinkState.connecting;
  return LinkState.connected;
}

/// Whether the base the gateway talks to answered lately.
LinkState reachStateOf(BoxReach reach) {
  if (reach.down) return LinkState.disconnected;
  if (reach.lastContact == null) return LinkState.connecting;
  return LinkState.connected;
}

/// Whether the cloud icon is shown at all.
bool cloudLinkShown(WidgetRef ref) =>
    ref.watch(syncActionsProvider) != null || ref.watch(isCloudGatewayProvider);

/// The cloud's state: the sync engine's, and down with the gateway when the
/// session came from the cloud.
LinkState cloudLinkState(WidgetRef ref) {
  final viaCloud = ref.watch(isCloudGatewayProvider);
  final reach = ref.watch(connectivityProvider);
  if (ref.watch(syncActionsProvider) == null) return reachStateOf(reach);
  if (viaCloud && reach.down) return LinkState.disconnected;
  return cloudStateOf(ref.watch(syncViewProvider).value ?? SyncView.empty);
}

/// The box's state: what this phone reaches directly. A session from the
/// cloud, or the offline session, means the box did not answer.
LinkState boxLinkState(WidgetRef ref) {
  final session = ref.watch(sessionProvider);
  if (session?.offline == true || session?.via == SessionDto.viaCloud) {
    return LinkState.disconnected;
  }
  final reach = reachStateOf(ref.watch(connectivityProvider));
  // the box answers, but the last sync with it failed: shown here, on the box icon
  if (reach == LinkState.connected &&
      ref.watch(syncActionsProvider) != null &&
      boxSyncFailed(ref.watch(syncViewProvider).value ?? SyncView.empty)) {
    return LinkState.error;
  }
  return reach;
}

String linkWords(S s, LinkKind kind, LinkState state) => switch ((kind, state)) {
  (LinkKind.cloud, LinkState.connected) => s.linkCloudConnected,
  (LinkKind.cloud, LinkState.connecting) => s.linkCloudConnecting,
  (LinkKind.cloud, LinkState.syncing) => s.linkCloudSyncing,
  (LinkKind.cloud, LinkState.disconnected) => s.linkCloudDisconnected,
  (LinkKind.cloud, LinkState.error) => s.ra6LinkCloudError,
  (LinkKind.box, LinkState.error) => s.ra6LinkBoxError,
  (LinkKind.box, LinkState.connected) => s.linkBoxConnected,
  (LinkKind.box, LinkState.connecting) => s.linkBoxConnecting,
  (LinkKind.box, LinkState.syncing) => s.linkBoxSyncing,
  (LinkKind.box, LinkState.disconnected) => s.linkBoxDisconnected,
};

/// The two icons from the providers, with their taps.
class ConnectionIcons extends ConsumerWidget {
  const ConnectionIcons({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final showCloud = cloudLinkShown(ref);
    final hasEngine = ref.watch(syncActionsProvider) != null;
    final conflicts = hasEngine
        ? ref.watch(syncViewProvider.select((v) => v.value?.conflicts ?? 0))
        : 0;
    return ConnectionIconsView(
      cloud: showCloud ? cloudLinkState(ref) : null,
      box: boxLinkState(ref),
      conflicts: conflicts,
      onCloud: hasEngine ? () => showSyncSheet(context) : () => checkBoxAgain(context, ref),
      onBox: () => checkBoxAgain(context, ref),
    );
  }
}

/// The offline banner's `Cuba lagi` (the box asked again, the offline
/// session reconnecting), then the answer in one line.
Future<void> checkBoxAgain(BuildContext context, WidgetRef ref) async {
  final offline = ref.read(sessionProvider)?.offline == true;
  if (offline) ref.read(sessionKeeperProvider).kick();
  await ref.read(healthProvider.notifier).refresh();
  if (!context.mounted) return;
  final s = S.of(context);
  final deps = ref.read(appDepsProvider);
  final reach = ref.read(connectivityProvider);
  final String line;
  if (offline) {
    line = s.offlineSessionBanner;
  } else if (reach.down) {
    final last = reach.lastContact;
    line = last == null
        ? s.offlineBanner
        : s.offlineBannerAt(whenWords(deps.toLocal(last), today: deps.toLocal(deps.now()), lang: appLangOfS(s)));
  } else if (reach.lastContact != null) {
    line = s.statusReachedAt(
      whenWords(deps.toLocal(reach.lastContact!), today: deps.toLocal(deps.now()), lang: appLangOfS(s)),
    );
  } else {
    line = s.statusChecking;
  }
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(line), duration: const Duration(seconds: 4)));
}

/// The two icons for given states (the goldens and the dashboard header
/// use it directly). A null [cloud] hides the cloud.
class ConnectionIconsView extends StatelessWidget {
  const ConnectionIconsView({
    super.key,
    required this.cloud,
    required this.box,
    this.conflicts = 0,
    this.onCloud,
    this.onBox,
    this.onDark = true,
  });

  final LinkState? cloud;
  final LinkState box;
  final int conflicts;
  final VoidCallback? onCloud;
  final VoidCallback? onBox;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (cloud != null)
          LinkButton(
            key: const ValueKey('link-cloud'),
            kind: LinkKind.cloud,
            state: cloud!,
            label: [
              linkWords(s, LinkKind.cloud, cloud!),
              if (conflicts > 0) s.syncConflicts(conflicts),
            ].join('. '),
            conflicts: conflicts,
            onTap: onCloud,
            onDark: onDark,
          ),
        if (cloud != null) const SizedBox(width: 4),
        LinkButton(
          key: const ValueKey('link-box'),
          kind: LinkKind.box,
          state: box,
          label: linkWords(s, LinkKind.box, box),
          onTap: onBox,
          onDark: onDark,
        ),
      ],
    );
  }
}

/// One icon in a 40 dp tap target.
class LinkButton extends StatelessWidget {
  const LinkButton({
    super.key,
    required this.kind,
    required this.state,
    required this.label,
    this.conflicts = 0,
    this.onTap,
    this.onDark = true,
  });

  static const double size = 40;

  final LinkKind kind;
  final LinkState state;
  final String label;
  final int conflicts;
  final VoidCallback? onTap;
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final off = state == LinkState.disconnected;
    final Color background = onDark
        ? (off ? const Color(0x29E5484D) : Colors.white.withValues(alpha: 0.08))
        : (off ? SurauColors.dangerSoft : SurauColors.paperDeep);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Material(
        color: background,
        borderRadius: BorderRadius.circular(12),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            width: size,
            height: size,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Center(child: LinkGlyph(kind: kind, state: state, onDark: onDark)),
                if (conflicts > 0)
                  PositionedDirectional(
                    top: 1,
                    start: 1,
                    child: Container(
                      key: const ValueKey('link-conflicts'),
                      constraints: const BoxConstraints(minWidth: 16),
                      height: 16,
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      alignment: Alignment.center,
                      decoration: const BoxDecoration(
                        color: Color(0xFFE5484D),
                        borderRadius: BorderRadius.all(Radius.circular(8)),
                      ),
                      child: Text(
                        '$conflicts',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10.5,
                          height: 1,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The glyph (24 dp) with its badge, without a tap; also used inside pages
/// where the box or the cloud is the subject of a message.
class LinkGlyph extends StatelessWidget {
  const LinkGlyph({
    super.key,
    required this.kind,
    required this.state,
    this.size = 24,
    this.onDark = true,
  });

  final LinkKind kind;
  final LinkState state;
  final double size;
  final bool onDark;

  bool get dashed => state == LinkState.connecting;
  LinkBadge get badgeShape => _badgeOf(state);

  @override
  Widget build(BuildContext context) {
    final off = state == LinkState.disconnected;
    final ink = onDark ? Colors.white : SurauColors.teal;
    final glyphColour = off
        ? (onDark ? ink.withValues(alpha: 0.62) : const Color(0xFF5D6F6B))
        : dashed
        ? ink.withValues(alpha: 0.85)
        : ink;
    final fill = switch (state) {
      LinkState.connected || LinkState.syncing =>
        onDark ? Colors.white.withValues(alpha: 0.16) : SurauColors.teal.withValues(alpha: 0.12),
      _ => Colors.transparent,
    };
    final (Color badgeBg, Color badgeFg) = switch (state) {
      LinkState.connected => onDark
          ? (const Color(0xFF3FBF8F), SurauColors.glass)
          : (SurauColors.success, Colors.white),
      LinkState.connecting || LinkState.syncing => (SurauColors.gold, SurauColors.ink),
      LinkState.disconnected => (const Color(0xFFE5484D), Colors.white),
      LinkState.error => (const Color(0xFFB45309), Colors.white),
    };
    final ring = onDark ? SurauColors.glass : Colors.white;
    final badge = off ? size * 0.75 : size * 0.62;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: CustomPaint(
              painter: _GlyphPainter(kind: kind, colour: glyphColour, fill: fill, dashed: dashed),
            ),
          ),
          PositionedDirectional(
            end: off ? -size * 0.2 : -size * 0.16,
            top: off ? -size * 0.2 : null,
            bottom: off ? null : -size * 0.14,
            child: Container(
              width: badge,
              height: badge,
              decoration: BoxDecoration(
                color: badgeBg,
                shape: BoxShape.circle,
                border: Border.all(color: ring, width: 1.6),
              ),
              child: CustomPaint(
                painter: _BadgePainter(shape: badgeShape, colour: badgeFg),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The cloud and the box of the mockups' sprite, drawn on a 24 x 24 grid.
class _GlyphPainter extends CustomPainter {
  _GlyphPainter({required this.kind, required this.colour, required this.fill, required this.dashed});

  final LinkKind kind;
  final Color colour;
  final Color fill;
  final bool dashed;

  static Path cloudPath() => Path()
    ..moveTo(7.2, 18.5)
    ..lineTo(17.5, 18.5)
    ..arcToPoint(const Offset(18.0, 9.93), radius: const Radius.circular(4.3), clockwise: false)
    ..arcToPoint(const Offset(6.4, 9.1), radius: const Radius.circular(6.1), clockwise: false)
    ..arcToPoint(const Offset(7.2, 18.5), radius: const Radius.circular(4.7), clockwise: false)
    ..close();

  static Path boxBody() => Path()
    ..addRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(2.5, 8, 19, 9.5), const Radius.circular(2.2)));

  static Path boxDetails() => Path()
    ..moveTo(6, 20.5)
    ..lineTo(9, 20.5)
    ..moveTo(15, 20.5)
    ..lineTo(18, 20.5)
    ..moveTo(6, 12.75)
    ..lineTo(12, 12.75);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 24, size.height / 24);
    final stroke = Paint()
      ..color = colour
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.9
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final body = kind == LinkKind.cloud ? cloudPath() : boxBody();
    if (fill.a > 0) {
      canvas.drawPath(body, Paint()..color = fill);
    }
    canvas.drawPath(dashed ? _dash(body, 3.2, 2.6) : body, stroke);
    if (kind == LinkKind.box) {
      canvas.drawPath(boxDetails(), stroke);
      canvas.drawCircle(const Offset(17.2, 12.75), 1.1, stroke);
    }
    canvas.restore();
  }

  static Path _dash(Path source, double on, double off) {
    final out = Path();
    for (final metric in source.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        final end = math.min(d + on, metric.length);
        out.addPath(metric.extractPath(d, end), Offset.zero);
        d = end + off;
      }
    }
    return out;
  }

  @override
  bool shouldRepaint(_GlyphPainter old) =>
      old.kind != kind || old.colour != colour || old.fill != fill || old.dashed != dashed;
}

/// The mark inside a badge, on the same 24 x 24 grid as the sprite.
class _BadgePainter extends CustomPainter {
  _BadgePainter({required this.shape, required this.colour});

  final LinkBadge shape;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    // The mark takes about two thirds of the badge.
    final scale = size.width * 0.66 / 24;
    canvas.save();
    canvas.translate(size.width * 0.17, size.height * 0.17);
    canvas.scale(scale);
    final p = Paint()
      ..color = colour
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.4
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (shape) {
      case LinkBadge.tick:
        canvas.drawPath(
          Path()
            ..moveTo(5, 12.5)
            ..lineTo(9.2, 16.5)
            ..lineTo(19, 7),
          p,
        );
      case LinkBadge.dots:
        final dot = Paint()..color = colour;
        for (final x in const [5.5, 12.0, 18.5]) {
          canvas.drawCircle(Offset(x, 12), 2.3, dot);
        }
      case LinkBadge.arrows:
        canvas.drawPath(
          Path()
            ..moveTo(19, 9)
            ..arcToPoint(const Offset(5.8, 7.2), radius: const Radius.circular(7.5), clockwise: false)
            ..moveTo(5, 15)
            ..arcToPoint(const Offset(18.2, 16.8), radius: const Radius.circular(7.5), clockwise: false)
            ..moveTo(19, 4)
            ..lineTo(19, 9)
            ..lineTo(14, 9)
            ..moveTo(5, 20)
            ..lineTo(5, 15)
            ..lineTo(10, 15),
          p,
        );
      case LinkBadge.warn:
        canvas.drawPath(
          Path()
            ..moveTo(12, 5)
            ..lineTo(12, 13.5),
          p,
        );
        canvas.drawCircle(const Offset(12, 18.5), 1.9, Paint()..color = colour);
      case LinkBadge.cross:
        canvas.drawPath(
          Path()
            ..moveTo(6, 6)
            ..lineTo(18, 18)
            ..moveTo(18, 6)
            ..lineTo(6, 18),
          p,
        );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_BadgePainter old) => old.shape != shape || old.colour != colour;
}
