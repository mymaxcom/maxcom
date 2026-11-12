// The app's look: the kiosk's identity (deep teal glass, gold accent,
// Plus Jakarta Sans; see apps/kiosk-display/src/styles.css) adapted for a
// touch admin app that AJK members of every age use in daylight and at
// night. The glass stays in the chrome (app bar, navigation); content sits
// on light teal-tinted paper so forms stay readable. Gold is spent in one
// place: the primary action and the hairline under the header.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Colours shared with the kiosk.
abstract final class SurauColors {
  /// Kiosk glass (`--glass-rgb: 6 48 43`).
  static const Color glass = Color(0xFF06302B);

  /// Seed and primary: the deep teal between glass and paper.
  static const Color teal = Color(0xFF0B5C55);
  static const Color tealSoft = Color(0xFFD3EBE6);

  /// Kiosk accent (`--accent`), always on [ink] or on [glass].
  static const Color gold = Color(0xFFF0C97A);
  static const Color goldSoft = Color(0xFFFBEFD3);

  /// Text on the gold fill (`--ink`).
  static const Color ink = Color(0xFF1A1405);

  /// Page canvas and cards.
  static const Color paper = Color(0xFFF2F6F4);
  static const Color paperDeep = Color(0xFFE6EEEB);
  static const Color card = Color(0xFFFFFFFF);
  static const Color line = Color(0xFFD6E3DF);

  static const Color text = Color(0xFF10211E);
  static const Color muted = Color(0xFF55706B);
  static const Color outline = Color(0xFF8FA6A1);

  static const Color danger = Color(0xFFB3261E);
  static const Color dangerSoft = Color(0xFFFCEEED);
  static const Color dangerInk = Color(0xFF5E1612);

  /// Gold at 35 %, the kiosk's glass border.
  static const Color goldHairline = Color(0x59F0C97A);
}

abstract final class SurauTheme {
  /// Minimum size of anything a finger taps.
  static const double minTapSize = 48;

  /// Standard page gutter.
  static const EdgeInsets pagePadding = EdgeInsets.fromLTRB(20, 16, 20, 32);

  /// Widest a reading or form column gets (iPad landscape); wider pages
  /// centre the column instead of stretching rows across the screen.
  static const double contentMaxWidth = 680;

  static const String fontFamily = 'PlusJakartaSans';

  /// Arabic glyphs in UI text (hadis, zikir, surah names, an Arabic
  /// language later) come from this bundled family; the web build can
  /// never download a fallback (CSP `font-src 'self'`).
  static const List<String> fontFamilyFallback = ['NotoNaskhArabic'];

  /// Quran text: QPC Hafs (Uthmani), Amiri Quran when a glyph is missing,
  /// generous size and line height so harakat never collide between lines.
  /// Pair it with `textDirection: TextDirection.rtl`.
  static const TextStyle quranTextStyle = TextStyle(
    fontFamily: 'QpcHafs',
    fontFamilyFallback: ['AmiriQuran', 'NotoNaskhArabic'],
    fontSize: 30,
    height: 2.0,
    color: SurauColors.text,
  );

  static const double radiusCard = 18;
  static const double radiusControl = 14;
  static const double radiusChip = 10;

  static ThemeData light() {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: SurauColors.teal,
          brightness: Brightness.light,
        ).copyWith(
          primary: SurauColors.teal,
          onPrimary: Colors.white,
          primaryContainer: SurauColors.tealSoft,
          onPrimaryContainer: SurauColors.glass,
          secondary: SurauColors.gold,
          onSecondary: SurauColors.ink,
          secondaryContainer: SurauColors.goldSoft,
          onSecondaryContainer: SurauColors.ink,
          tertiary: SurauColors.glass,
          onTertiary: SurauColors.gold,
          surface: SurauColors.paper,
          onSurface: SurauColors.text,
          surfaceContainerLowest: SurauColors.card,
          surfaceContainerLow: SurauColors.card,
          surfaceContainer: SurauColors.paperDeep,
          surfaceContainerHigh: SurauColors.paperDeep,
          surfaceContainerHighest: SurauColors.line,
          onSurfaceVariant: SurauColors.muted,
          outline: SurauColors.outline,
          outlineVariant: SurauColors.line,
          error: SurauColors.danger,
          onError: Colors.white,
          errorContainer: SurauColors.dangerSoft,
          onErrorContainer: SurauColors.dangerInk,
          inverseSurface: SurauColors.glass,
          onInverseSurface: Colors.white,
          inversePrimary: SurauColors.gold,
        );

    final text = textTheme(SurauColors.text, SurauColors.muted);

    final controlShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radiusControl),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFamilyFallback,
      textTheme: text,
      scaffoldBackgroundColor: SurauColors.paper,
      canvasColor: SurauColors.paper,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      visualDensity: VisualDensity.standard,
      splashColor: SurauColors.teal.withValues(alpha: 0.10),
      highlightColor: SurauColors.teal.withValues(alpha: 0.06),
      dividerColor: SurauColors.line,

      appBarTheme: AppBarTheme(
        backgroundColor: SurauColors.glass,
        foregroundColor: Colors.white,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        toolbarHeight: 64,
        titleSpacing: 20,
        titleTextStyle: text.titleLarge!.copyWith(color: Colors.white),
        iconTheme: const IconThemeData(color: Colors.white, size: 26),
        actionsIconTheme: const IconThemeData(color: SurauColors.gold, size: 26),
        shape: const Border(
          bottom: BorderSide(color: SurauColors.goldHairline),
        ),
        systemOverlayStyle: SystemUiOverlayStyle.light,
      ),

      cardTheme: CardThemeData(
        color: SurauColors.card,
        elevation: 0,
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard),
          side: const BorderSide(color: SurauColors.line),
        ),
      ),

      listTileTheme: ListTileThemeData(
        minTileHeight: 60,
        contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        titleTextStyle: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
        subtitleTextStyle: text.bodyMedium!.copyWith(color: SurauColors.muted),
        iconColor: SurauColors.teal,
        horizontalTitleGap: 16,
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? Colors.white
              : SurauColors.outline,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? SurauColors.teal
              : SurauColors.paperDeep,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? Colors.transparent
              : SurauColors.outline,
        ),
        materialTapTargetSize: MaterialTapTargetSize.padded,
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? SurauColors.teal
              : Colors.transparent,
        ),
        side: const BorderSide(color: SurauColors.outline, width: 1.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),

      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? SurauColors.teal
              : SurauColors.outline,
        ),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: SurauColors.gold,
          foregroundColor: SurauColors.ink,
          disabledBackgroundColor: SurauColors.paperDeep,
          disabledForegroundColor: SurauColors.muted,
          minimumSize: const Size(64, 52),
          padding: const EdgeInsets.symmetric(horizontal: 24),
          textStyle: text.labelLarge,
          shape: controlShape,
          elevation: 0,
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: SurauColors.teal,
          minimumSize: const Size(64, 52),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          textStyle: text.labelLarge,
          side: const BorderSide(color: SurauColors.teal, width: 1.5),
          shape: controlShape,
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: SurauColors.teal,
          minimumSize: const Size(minTapSize, minTapSize),
          padding: const EdgeInsets.symmetric(horizontal: 16),
          textStyle: text.labelLarge,
          shape: controlShape,
        ),
      ),

      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(minTapSize, minTapSize),
          iconSize: 26,
        ),
      ),

      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: SurauColors.gold,
        foregroundColor: SurauColors.ink,
        elevation: 2,
        extendedPadding: EdgeInsets.symmetric(horizontal: 22),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: SurauColors.card,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
        hintStyle: text.bodyLarge!.copyWith(color: SurauColors.muted),
        labelStyle: text.bodyMedium!.copyWith(color: SurauColors.muted),
        helperStyle: text.bodySmall,
        errorStyle: text.bodySmall!.copyWith(color: SurauColors.danger),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: const BorderSide(color: SurauColors.line),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: const BorderSide(color: SurauColors.line),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: const BorderSide(color: SurauColors.teal, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: const BorderSide(color: SurauColors.danger),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          borderSide: const BorderSide(color: SurauColors.danger, width: 2),
        ),
      ),

      chipTheme: ChipThemeData(
        backgroundColor: SurauColors.paperDeep,
        selectedColor: SurauColors.tealSoft,
        side: BorderSide.none,
        labelStyle: text.labelMedium,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusChip),
        ),
      ),

      dividerTheme: const DividerThemeData(
        color: SurauColors.line,
        thickness: 1,
        space: 1,
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: SurauColors.glass,
        contentTextStyle: text.bodyLarge!.copyWith(color: Colors.white),
        actionTextColor: SurauColors.gold,
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusControl),
          side: const BorderSide(color: SurauColors.goldHairline),
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: SurauColors.card,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: text.titleLarge,
        contentTextStyle: text.bodyLarge,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusCard + 4),
        ),
      ),

      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: SurauColors.card,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
      ),

      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: SurauColors.glass,
        indicatorColor: SurauColors.gold.withValues(alpha: 0.20),
        height: 76,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(
            size: 26,
            color: s.contains(WidgetState.selected)
                ? SurauColors.gold
                : Colors.white.withValues(alpha: 0.78),
          ),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (s) => text.labelSmall!.copyWith(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: s.contains(WidgetState.selected)
                ? SurauColors.gold
                : Colors.white.withValues(alpha: 0.78),
          ),
        ),
      ),

      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: SurauColors.glass,
        indicatorColor: SurauColors.gold.withValues(alpha: 0.20),
        selectedIconTheme: const IconThemeData(color: SurauColors.gold, size: 26),
        unselectedIconTheme: IconThemeData(
          color: Colors.white.withValues(alpha: 0.78),
          size: 26,
        ),
        selectedLabelTextStyle: text.labelMedium!.copyWith(
          color: SurauColors.gold,
        ),
        unselectedLabelTextStyle: text.labelMedium!.copyWith(
          color: Colors.white.withValues(alpha: 0.78),
        ),
        labelType: NavigationRailLabelType.all,
        minWidth: 88,
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: SurauColors.teal,
        linearTrackColor: SurauColors.paperDeep,
      ),

      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: SurauColors.glass,
          borderRadius: BorderRadius.circular(radiusChip),
        ),
        textStyle: text.bodyMedium!.copyWith(color: Colors.white),
      ),
    );
  }

  /// Standard body for a scrolling page: [pagePadding] gutters and a
  /// centred column no wider than [contentMaxWidth].
  static Widget page({
    required List<Widget> children,
    EdgeInsets padding = pagePadding,
    ScrollController? controller,
  }) {
    return ContentColumn(
      child: ListView(
        controller: controller,
        padding: padding,
        children: children,
      ),
    );
  }

  /// Type scale: one family, sizes a step above Material's defaults so
  /// older eyes read it at arm's length; times use tabular figures like
  /// the kiosk's `.num`.
  static TextTheme textTheme(Color color, Color muted) {
    TextStyle style(
      double size,
      FontWeight weight, {
      double height = 1.3,
      double spacing = 0,
      Color? colour,
      bool tabular = false,
    }) {
      return TextStyle(
        fontFamily: fontFamily,
        fontFamilyFallback: fontFamilyFallback,
        fontSize: size,
        fontWeight: weight,
        height: height,
        letterSpacing: spacing,
        color: colour ?? color,
        fontFeatures: tabular ? const [FontFeature.tabularFigures()] : null,
      );
    }

    return TextTheme(
      displayLarge: style(56, FontWeight.w800, height: 1.0, spacing: -1.2, tabular: true),
      displayMedium: style(44, FontWeight.w800, height: 1.05, spacing: -0.8, tabular: true),
      displaySmall: style(36, FontWeight.w800, height: 1.1, spacing: -0.5, tabular: true),
      headlineLarge: style(32, FontWeight.w700, height: 1.15, spacing: -0.4),
      headlineMedium: style(28, FontWeight.w700, height: 1.2, spacing: -0.3),
      headlineSmall: style(24, FontWeight.w700, height: 1.25, spacing: -0.2),
      titleLarge: style(22, FontWeight.w600, height: 1.25),
      titleMedium: style(18, FontWeight.w600, height: 1.3),
      titleSmall: style(16, FontWeight.w600, height: 1.35),
      bodyLarge: style(17, FontWeight.w400, height: 1.45),
      bodyMedium: style(15, FontWeight.w400, height: 1.45),
      bodySmall: style(13, FontWeight.w400, height: 1.4, colour: muted),
      labelLarge: style(17, FontWeight.w600, height: 1.2),
      labelMedium: style(14, FontWeight.w600, height: 1.2),
      labelSmall: style(12, FontWeight.w500, height: 1.2, spacing: 0.2),
    );
  }
}

/// Centres [child] and caps its width at [SurauTheme.contentMaxWidth].
/// Phones are narrower than the cap, so nothing changes for them.
class ContentColumn extends StatelessWidget {
  const ContentColumn({
    super.key,
    required this.child,
    this.maxWidth = SurauTheme.contentMaxWidth,
  });

  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}
