// A 16:9 approximation of the kiosk with its hadis card: the drawn background,
// the prayer bar's silhouette and the card with the fields the form selects,
// laid out by the same rules as the TV (`hadis_tv_rules.dart`: a part is tier
// 'm' with four Malay lines, no Arabic, no opening sentence). It is a preview,
// not the kiosk renderer; every size is a hundredth of its own width, as the
// kiosk's rem is a hundredth of the TV's.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../app/theme.dart';
import '../../../hadis/hadis_api.dart';
import '../../../hadis/hadis_rules.dart';
import '../../../hadis/hadis_tv_rules.dart';
import '../../../l10n/generated/s.dart';

/// The hadis the preview draws, from a saved item or a catalog entry.
class HadisPreviewData {
  const HadisPreviewData({
    required this.textMs,
    this.textAr,
    this.intro,
    this.gradeText,
    this.attribution,
    this.attributionLong,
    this.credit = false,
  });

  factory HadisPreviewData.fromItem(HadisItem item) {
    if (!item.isProvider) {
      return HadisPreviewData(
        textMs: item.textMs,
        textAr: item.textAr,
        attribution: item.source == unstatedSource || item.source.isEmpty ? null : item.source,
      );
    }
    final ar = (item.ext?['attributionAr'] as String?) ?? '';
    final a = attributionOf(ar);
    final g = item.grade;
    return HadisPreviewData(
      textMs: item.textMs,
      textAr: item.textAr,
      intro: item.intro,
      gradeText: g == null ? null : gradeLabel(g),
      attribution: a?.short ?? (ar.isEmpty ? item.source : ar),
      attributionLong: a?.long,
      credit: true,
    );
  }

  factory HadisPreviewData.fromDetail(HeDetail d) => HadisPreviewData(
    textMs: d.textMs,
    textAr: d.textAr.isEmpty ? null : d.textAr,
    intro: d.introMs,
    gradeText: d.grade == null ? null : gradeLabel(d.grade!),
    attribution: d.attributionShort ?? d.attributionAr,
    attributionLong: d.attributionLong,
    credit: true,
  );

  final String textMs;
  final String? textAr;
  final String? intro;
  final String? gradeText;

  /// Short form; null prints no attribution line.
  final String? attribution;
  final String? attributionLong;

  /// `Sumber: HadeethEnc.com`, printed on every HadeethEnc card.
  final bool credit;
}

class HadisTvPreview extends ConsumerWidget {
  const HadisTvPreview({super.key, required this.data, required this.settings});

  final HadisPreviewData data;

  /// The `hadis` feature values: fields, font size.
  final Map<String, dynamic> settings;

  static const Color _cardFill = Color(0xB3062824);
  static const Color _hairline = Color(0x59F0C97A);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final surau = ref.watch(surauInfoProvider)?.name ?? '';
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: LayoutBuilder(
          builder: (context, c) {
            final u = c.maxWidth / 100;
            return DefaultTextStyle(
              style: const TextStyle(
                color: Colors.white,
                fontFamily: SurauTheme.fontFamily,
                fontFamilyFallback: SurauTheme.fontFamilyFallback,
              ),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ..._backdrop(c.maxWidth, c.maxHeight),
                  Positioned(left: 3 * u, top: 2.6 * u, child: _clock(s(context), u, surau)),
                  Positioned(right: 3 * u, top: 2.8 * u, child: _countdown(s(context), u)),
                  Positioned(
                    left: 3 * u,
                    right: 3 * u,
                    bottom: 16.4 * u,
                    child: _card(context, u),
                  ),
                  Positioned(
                    left: 3 * u,
                    right: 3 * u,
                    bottom: 2.6 * u,
                    height: 12 * u,
                    child: _prayerBar(s(context), u),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  S s(BuildContext context) => S.of(context);

  /// A line break in the text is a space on the TV, as in the kiosk's HTML.
  static String _flat(String s) => s.replaceAll(RegExp(r'\s*\n+\s*'), ' ');

  List<Widget> _backdrop(double w, double h) => [
    const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          stops: [0, 0.38, 0.62, 0.63, 1],
          colors: [
            Color(0xFF86B3AE),
            Color(0xFFA9C9BD),
            Color(0xFFD8D2B4),
            Color(0xFF6F8A77),
            Color(0xFF3E5A4C),
          ],
        ),
      ),
    ),
    const DecoratedBox(
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: Alignment(0.4, -0.24),
          radius: 0.55,
          colors: [Color(0x8CFFECBE), Color(0x00FFECBE)],
        ),
      ),
    ),
    Positioned(
      left: 0.62 * w,
      top: 0.44 * h,
      width: 0.16 * w,
      height: 0.22 * h,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0xFF244C45),
          borderRadius: BorderRadius.vertical(top: Radius.circular(0.08 * w)),
        ),
      ),
    ),
    for (final left in const [0.58, 0.795])
      Positioned(
        left: left * w,
        top: 0.28 * h,
        width: 0.016 * w,
        height: 0.36 * h,
        child: const ColoredBox(color: Color(0xFF24493F)),
      ),
    const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          stops: [0, 0.32, 0.62, 1],
          colors: [Color(0x8C041E1C), Color(0x26041E1C), Color(0x8C041E1C), Color(0xE0041E1C)],
        ),
      ),
    ),
  ];

  Widget _clock(S s, double u, String surau) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (surau.isNotEmpty)
        Text(
          surau.toUpperCase(),
          style: TextStyle(
            color: SurauColors.gold,
            fontSize: 1.2 * u,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.25 * 1.2 * u,
          ),
        ),
      SizedBox(height: 0.6 * u),
      Text(
        '--:--',
        style: TextStyle(fontSize: 8 * u, height: 1, fontWeight: FontWeight.w800),
      ),
    ],
  );

  Widget _countdown(S s, double u) => Container(
    padding: EdgeInsets.symmetric(horizontal: 1.8 * u, vertical: 1.2 * u),
    decoration: BoxDecoration(
      color: const Color(0x9E062824),
      borderRadius: BorderRadius.circular(1.2 * u),
      border: Border.all(color: _hairline),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(s.hadisTvCountdown, style: TextStyle(fontSize: 1.3 * u)),
        Text(
          '--:--:--',
          style: TextStyle(color: SurauColors.gold, fontSize: 2.8 * u, fontWeight: FontWeight.w700),
        ),
      ],
    ),
  );

  Widget _prayerBar(S s, double u) {
    final names = [
      s.hadisTvPrayerImsak,
      s.hadisTvPrayerSubuh,
      s.hadisTvPrayerSyuruk,
      s.hadisTvPrayerZohor,
      s.hadisTvPrayerAsar,
      s.hadisTvPrayerMaghrib,
      s.hadisTvPrayerIsyak,
    ];
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: const Color(0x9E062824),
        borderRadius: BorderRadius.circular(1.6 * u),
        border: Border.all(color: _hairline),
      ),
      child: Row(
        children: [
          for (var i = 0; i < names.length; i++)
            Expanded(
              child: Container(
                color: i == 4 ? SurauColors.gold : null,
                alignment: Alignment.center,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      names[i].toUpperCase(),
                      style: TextStyle(
                        fontSize: 1.3 * u,
                        letterSpacing: 0.1 * u,
                        color: i == 4 ? SurauColors.ink : Colors.white,
                      ),
                    ),
                    Text(
                      '--:--',
                      style: TextStyle(
                        fontSize: (i == 0 || i == 2 ? 2.2 : 3) * u,
                        fontWeight: FontWeight.w800,
                        color: i == 4 ? SurauColors.ink : Colors.white,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _card(BuildContext context, double u) {
    final s = S.of(context);
    final plan = hadisPlan(
      textMs: data.textMs,
      textAr: data.textAr,
      intro: data.intro,
      settings: settings,
    );
    final sizes = hadisTierSizes(plan.tier);
    final showAr = !plan.isParts && plan.showAr;
    // Malay is hidden only when the Arabic is there to stand in for it.
    final malayOn = settings['showMalay'] != false || !showAr;
    final split = hadisDisplayText(data.textMs, data.intro);
    final grade = settings['showGrade'] != false ? data.gradeText : null;
    final attribution = settings['showAttribution'] != false ? data.attribution : null;
    final long = data.attributionLong;
    final attributionText = attribution == null
        ? null
        : long == null
        ? attribution
        : '$attribution (${long.replaceFirst(RegExp(r'^Riwayat '), '')})';

    return Container(
      key: const ValueKey('hadis-tv-card'),
      padding: EdgeInsets.fromLTRB(2 * u, 1.25 * u, 2 * u, 1.05 * u),
      constraints: BoxConstraints(maxHeight: 25 * u),
      decoration: BoxDecoration(
        color: _cardFill,
        borderRadius: BorderRadius.circular(1.4 * u),
        border: Border.all(color: _hairline),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                s.hadisTvTag,
                style: TextStyle(
                  color: SurauColors.gold,
                  fontSize: 1.05 * u,
                  letterSpacing: 0.22 * 1.05 * u,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (grade != null) ...[
                SizedBox(width: u),
                Container(
                  padding: EdgeInsets.symmetric(horizontal: 0.85 * u, vertical: 0.12 * u),
                  decoration: BoxDecoration(
                    color: SurauColors.gold,
                    borderRadius: BorderRadius.circular(2 * u),
                  ),
                  child: Text(
                    grade,
                    style: TextStyle(
                      color: SurauColors.ink,
                      fontSize: u,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
              if (plan.isParts) ...[
                const Spacer(),
                Text(
                  s.hadisTvPart(1, plan.parts.length),
                  key: const ValueKey('hadis-tv-part'),
                  style: TextStyle(
                    fontSize: u,
                    fontWeight: FontWeight.w700,
                    color: Colors.white.withValues(alpha: 0.8),
                  ),
                ),
                for (var i = 0; i < plan.parts.length; i++)
                  Container(
                    width: i == 0 ? 1.8 * u : 0.7 * u,
                    height: 0.7 * u,
                    margin: EdgeInsets.only(left: 0.5 * u),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(u),
                      color: i == 0 ? SurauColors.gold : Colors.white.withValues(alpha: 0.35),
                    ),
                  ),
              ],
            ],
          ),
          SizedBox(height: 0.7 * u),
          if (showAr) ...[
            Text(
              _flat(data.textAr!),
              key: const ValueKey('hadis-tv-ar'),
              textDirection: TextDirection.rtl,
              textAlign: TextAlign.right,
              maxLines: sizes.arLines,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: 'AmiriQuran',
                fontFamilyFallback: const ['NotoNaskhArabic', SurauTheme.fontFamily],
                fontSize: sizes.arSize * u,
                height: 1.75,
              ),
            ),
            SizedBox(height: 0.6 * u),
          ],
          if (malayOn)
            Text.rich(
              key: const ValueKey('hadis-tv-ms'),
              plan.isParts
                  ? TextSpan(text: _flat(plan.parts.first))
                  : TextSpan(
                      children: [
                        if (split.intro != null)
                          TextSpan(
                            text: '${split.intro} ',
                            style: TextStyle(
                              fontWeight: FontWeight.w400,
                              color: Colors.white.withValues(alpha: 0.8),
                            ),
                          ),
                        TextSpan(text: _flat(split.body)),
                      ],
                    ),
              maxLines: plan.msLines,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: sizes.msSize * u,
                height: 1.3,
                fontWeight: FontWeight.w500,
              ),
            ),
          SizedBox(height: 0.8 * u),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: attributionText == null
                    ? const SizedBox.shrink()
                    : Text(
                        attributionText,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: SurauColors.gold,
                          fontSize: 1.2 * u,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
              ),
              if (data.credit)
                Padding(
                  padding: EdgeInsets.only(left: 1.4 * u),
                  child: Text(
                    s.hadisTvCredit,
                    style: TextStyle(
                      fontSize: 0.95 * u,
                      color: Colors.white.withValues(alpha: 0.7),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
