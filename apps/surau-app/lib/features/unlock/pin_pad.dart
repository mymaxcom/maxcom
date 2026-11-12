// The PIN pad: six dots and a 3 x 4 grid of big keys, drawn on the kiosk's
// glass. Sized for thumbs and older eyes: 76 px keys, 32 px digits, no
// chrome around the grid. Used by the unlock screen only; the enrol screen
// types PINs into fields because it also needs a keyboard for the name.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';

/// Six dots, filled from the left as digits are typed. [shake] nudges the
/// row sideways once (set a new value to replay).
class PinDots extends StatelessWidget {
  const PinDots({
    super.key,
    required this.filled,
    this.length = 6,
    this.shake = 0,
  });

  final int filled;
  final int length;
  final int shake;

  @override
  Widget build(BuildContext context) {
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < length; i++)
          AnimatedContainer(
            key: ValueKey('pin-dot-$i'),
            duration: const Duration(milliseconds: 120),
            width: 18,
            height: 18,
            margin: const EdgeInsets.symmetric(horizontal: 8),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: i < filled ? SurauColors.gold : Colors.transparent,
              border: Border.all(
                color: i < filled
                    ? SurauColors.gold
                    : Colors.white.withValues(alpha: 0.45),
                width: 1.5,
              ),
            ),
          ),
      ],
    );
    return TweenAnimationBuilder<double>(
      key: ValueKey('pin-shake-$shake'),
      tween: Tween(begin: shake == 0 ? 1 : 0, end: 1),
      duration: const Duration(milliseconds: 360),
      curve: Curves.easeOut,
      builder: (context, t, child) {
        // A damped wiggle: 0 -> 1 runs three half-cycles that fade out.
        final offset = t >= 1 ? 0.0 : (1 - t) * 10 * _wiggle(t);
        return Transform.translate(offset: Offset(offset, 0), child: child);
      },
      child: row,
    );
  }

  static double _wiggle(double t) {
    final phase = (t * 3).floor();
    return phase.isEven ? 1 : -1;
  }
}

/// One key of the pad. Digits show [label]; the two corner keys show
/// [child] instead (fingerprint, backspace).
class PinKey extends StatelessWidget {
  const PinKey({
    super.key,
    required this.onTap,
    this.label,
    this.child,
    this.semanticsLabel,
    this.enabled = true,
    this.accent = false,
  }) : assert(label != null || child != null);

  final VoidCallback? onTap;
  final String? label;
  final Widget? child;
  final String? semanticsLabel;
  final bool enabled;

  /// Gold face, for the biometric key.
  final bool accent;

  static const double size = 76;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final face = accent
        ? SurauColors.gold.withValues(alpha: 0.14)
        : Colors.white.withValues(alpha: 0.07);
    final body =
        child ??
        Text(
          label!,
          style: text.headlineLarge!.copyWith(
            color: Colors.white,
            fontWeight: FontWeight.w600,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        );
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticsLabel ?? label,
      excludeSemantics: true,
      child: Opacity(
        opacity: enabled ? 1 : 0.38,
        child: Material(
          color: face,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl + 4),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap == null
                ? null
                : () {
                    HapticFeedback.selectionClick();
                    onTap!();
                  },
            splashColor: Colors.white.withValues(alpha: 0.18),
            highlightColor: Colors.white.withValues(alpha: 0.10),
            child: SizedBox(
              width: size,
              height: size,
              child: Center(child: body),
            ),
          ),
        ),
      ),
    );
  }
}

/// The 3 x 4 grid. [leading] fills the bottom-left slot (biometric key or
/// nothing); backspace is bottom-right. Taps always reach [onDigit] and
/// [onBackspace]; the caller decides whether to act (so a lockout can end
/// on the next tap without a timer).
class PinPad extends StatelessWidget {
  const PinPad({
    super.key,
    required this.onDigit,
    required this.onBackspace,
    required this.backspaceLabel,
    this.leading,
    this.enabled = true,
  });

  final void Function(String digit) onDigit;
  final VoidCallback onBackspace;
  final String backspaceLabel;
  final Widget? leading;
  final bool enabled;

  static const double gap = 14;

  @override
  Widget build(BuildContext context) {
    Widget digit(String d) =>
        PinKey(label: d, enabled: enabled, onTap: () => onDigit(d));

    Widget row(List<Widget> keys) => Padding(
      padding: const EdgeInsets.only(bottom: gap),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < keys.length; i++) ...[
            if (i > 0) const SizedBox(width: gap),
            keys[i],
          ],
        ],
      ),
    );

    // A physical keyboard (laptop, iPad) types the same digits and
    // Backspace as the keys. Autofocus makes it work without a first tap.
    return Focus(
      autofocus: true,
      onKeyEvent: (node, event) {
        if (event is KeyUpEvent) return KeyEventResult.ignored;
        final keys = HardwareKeyboard.instance;
        if (keys.isControlPressed || keys.isMetaPressed || keys.isAltPressed) {
          return KeyEventResult.ignored;
        }
        final d = _digitKeys[event.logicalKey];
        if (d != null) {
          if (event is KeyDownEvent) onDigit(d);
          return KeyEventResult.handled;
        }
        if (event.logicalKey == LogicalKeyboardKey.backspace) {
          if (event is KeyDownEvent) onBackspace();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          row([digit('1'), digit('2'), digit('3')]),
          row([digit('4'), digit('5'), digit('6')]),
          row([digit('7'), digit('8'), digit('9')]),
          row([
            leading ?? const SizedBox(width: PinKey.size, height: PinKey.size),
            digit('0'),
            PinKey(
              semanticsLabel: backspaceLabel,
              enabled: enabled,
              onTap: onBackspace,
              child: Icon(
                Icons.backspace_outlined,
                size: 30,
                color: Colors.white.withValues(alpha: 0.88),
              ),
            ),
          ]),
        ],
      ),
    );
  }

  static final Map<LogicalKeyboardKey, String> _digitKeys = {
    LogicalKeyboardKey.digit0: '0',
    LogicalKeyboardKey.digit1: '1',
    LogicalKeyboardKey.digit2: '2',
    LogicalKeyboardKey.digit3: '3',
    LogicalKeyboardKey.digit4: '4',
    LogicalKeyboardKey.digit5: '5',
    LogicalKeyboardKey.digit6: '6',
    LogicalKeyboardKey.digit7: '7',
    LogicalKeyboardKey.digit8: '8',
    LogicalKeyboardKey.digit9: '9',
    LogicalKeyboardKey.numpad0: '0',
    LogicalKeyboardKey.numpad1: '1',
    LogicalKeyboardKey.numpad2: '2',
    LogicalKeyboardKey.numpad3: '3',
    LogicalKeyboardKey.numpad4: '4',
    LogicalKeyboardKey.numpad5: '5',
    LogicalKeyboardKey.numpad6: '6',
    LogicalKeyboardKey.numpad7: '7',
    LogicalKeyboardKey.numpad8: '8',
    LogicalKeyboardKey.numpad9: '9',
  };
}
