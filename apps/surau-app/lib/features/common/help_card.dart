// Two pieces shared by the enrolment and unlock screens.
//
// [HelpCard]: "Perlukan bantuan?" with the surau's contact person and big
// buttons to call, WhatsApp or email them. It appears wherever a person
// can get stuck (lockout, revoked device, box away, expired invitation,
// camera failure, forgot PIN) and never anywhere else, so it keeps its
// meaning. [TechnicalDetails]: the box address and certificate fingerprint
// behind a collapsed "Butiran teknikal", for the admin's comparison.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'contact_links.dart';
import 'surau_info.dart';

class HelpCard extends StatelessWidget {
  const HelpCard({
    super.key,
    required this.contact,
    this.onGlass = false,
    this.lead,
    this.openUrl = launchOutside,
  });

  /// Null when the box gave no contact: the card still says whom to ask.
  final HelpContact? contact;

  /// Drawn on the unlock screen's glass instead of the app's paper.
  final bool onGlass;

  /// One sentence above the contact, for example why the person is stuck.
  final String? lead;
  final UrlOpener openUrl;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final c = contact;
    final ink = onGlass ? Colors.white : SurauColors.text;
    final soft = onGlass
        ? Colors.white.withValues(alpha: 0.72)
        : SurauColors.muted;
    final accent = onGlass ? SurauColors.gold : SurauColors.teal;

    final phone = c?.phone;
    final email = c?.email;
    final actions = <Widget>[
      if (phone != null)
        _HelpAction(
          icon: Icons.call_outlined,
          label: s.helpCall,
          onGlass: onGlass,
          onTap: () => openUrl(ContactLinks.tel(phone)),
        ),
      if (phone != null)
        _HelpAction(
          icon: Icons.chat_outlined,
          label: s.helpWhatsApp,
          onGlass: onGlass,
          onTap: () => openUrl(ContactLinks.whatsApp(phone)),
        ),
      if (email != null)
        _HelpAction(
          icon: Icons.mail_outline,
          label: s.helpEmail,
          onGlass: onGlass,
          onTap: () => openUrl(ContactLinks.mailto(email)),
        ),
    ];

    return Semantics(
      container: true,
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        decoration: BoxDecoration(
          color: onGlass
              ? Colors.white.withValues(alpha: 0.07)
              : SurauColors.card,
          borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
          border: Border.all(
            color: onGlass ? SurauColors.goldHairline : SurauColors.line,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.help_outline_rounded, color: accent, size: 24),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    s.helpTitle,
                    style: text.titleMedium!.copyWith(color: ink),
                  ),
                ),
              ],
            ),
            if (lead != null) ...[
              const SizedBox(height: 8),
              Text(lead!, style: text.bodyMedium!.copyWith(color: soft)),
            ],
            const SizedBox(height: 10),
            if (c == null)
              Text(s.helpNoContact, style: text.bodyLarge!.copyWith(color: ink))
            else ...[
              Text(
                c.name != null ? s.helpContact(c.name!) : s.helpContactAnyone,
                style: text.bodyLarge!.copyWith(
                  color: ink,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (phone != null) ...[
                const SizedBox(height: 2),
                Text(
                  phone,
                  style: text.bodyLarge!.copyWith(
                    color: soft,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
              if (phone == null && email != null) ...[
                const SizedBox(height: 2),
                Text(email, style: text.bodyMedium!.copyWith(color: soft)),
              ],
            ],
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 14),
              _ActionGrid(actions: actions),
            ],
          ],
        ),
      ),
    );
  }
}

/// Up to three pills in one row when each gets [minPillWidth]; on a narrow
/// phone the third (email) drops to a full-width second row so no label is
/// ever cut short.
class _ActionGrid extends StatelessWidget {
  const _ActionGrid({required this.actions});

  final List<Widget> actions;

  static const double gap = 10;
  static const double minPillWidth = 118;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final n = actions.length;
        final fits = (constraints.maxWidth - gap * (n - 1)) / n >= minPillWidth;
        if (fits || n < 3) return _row(actions);
        return Column(
          children: [
            _row(actions.sublist(0, 2)),
            const SizedBox(height: gap),
            _row(actions.sublist(2)),
          ],
        );
      },
    );
  }

  Widget _row(List<Widget> items) => Row(
    children: [
      for (var i = 0; i < items.length; i++) ...[
        if (i > 0) const SizedBox(width: gap),
        Expanded(child: items[i]),
      ],
    ],
  );
}

/// A 52 px pill with an icon and a one-word label; the whole pill taps.
class _HelpAction extends StatelessWidget {
  const _HelpAction({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.onGlass,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool onGlass;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colour = onGlass ? SurauColors.gold : SurauColors.teal;
    return Material(
      color: onGlass
          ? SurauColors.gold.withValues(alpha: 0.12)
          : SurauColors.tealSoft.withValues(alpha: 0.6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        side: BorderSide(
          color: onGlass ? SurauColors.goldHairline : SurauColors.tealSoft,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          height: 52,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 22, color: colour),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.labelMedium!.copyWith(
                    color: colour,
                    fontSize: 15,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One labelled line inside [TechnicalDetails].
typedef DetailRow = ({String label, String value});

/// "Butiran teknikal": collapsed by default, opens to the box address and
/// the certificate fingerprint (two rows of four groups, as printed), with
/// the instruction to compare it with the admin's printout; or, with
/// [rows], to any labelled facts (the dashboard's technical check).
class TechnicalDetails extends StatefulWidget {
  const TechnicalDetails({
    super.key,
    this.boxAddress,
    this.fingerprint,
    this.rows = const [],
    this.note,
    this.initiallyOpen = false,
  });

  /// Shown with [fingerprint] when given.
  final String? boxAddress;

  /// Eight groups of four hex characters, space separated, or null on a
  /// loopback test box.
  final String? fingerprint;

  /// Extra labelled lines after the address and fingerprint.
  final List<DetailRow> rows;

  /// A closing sentence under the rows.
  final String? note;
  final bool initiallyOpen;

  @override
  State<TechnicalDetails> createState() => _TechnicalDetailsState();
}

class _TechnicalDetailsState extends State<TechnicalDetails> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final fp = widget.fingerprint;
    final fpRows = fp?.replaceFirst(' ', '\n', fp.indexOf(' ', 19));
    final label = text.labelMedium!.copyWith(color: SurauColors.muted);
    final value = text.bodyLarge!.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    return Material(
      color: SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        side: const BorderSide(color: SurauColors.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(18, 14, 12, 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      s.techDetailsTitle,
                      style: text.titleSmall!.copyWith(
                        color: SurauColors.muted,
                      ),
                    ),
                  ),
                  Icon(
                    _open
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    color: SurauColors.outline,
                  ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 160),
            alignment: Alignment.topCenter,
            child: !_open
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.fromLTRB(18, 2, 18, 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (widget.boxAddress != null) ...[
                          Text(s.enrolBoxLabel, style: label),
                          const SizedBox(height: 2),
                          Text(widget.boxAddress!, style: value),
                          const SizedBox(height: 14),
                          Text(s.enrolCaLabel, style: label),
                          const SizedBox(height: 2),
                          Text(fpRows ?? s.enrolCaNone, style: value),
                          if (fpRows != null) ...[
                            const SizedBox(height: 8),
                            Text(s.enrolCaCompare, style: text.bodySmall),
                          ],
                        ],
                        for (var i = 0; i < widget.rows.length; i++) ...[
                          if (i > 0 || widget.boxAddress != null)
                            const SizedBox(height: 14),
                          Text(widget.rows[i].label, style: label),
                          const SizedBox(height: 2),
                          Text(widget.rows[i].value, style: value),
                        ],
                        if (widget.note != null) ...[
                          const SizedBox(height: 8),
                          Text(widget.note!, style: text.bodySmall),
                        ],
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
