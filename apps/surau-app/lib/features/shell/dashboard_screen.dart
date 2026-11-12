// Home. The glass header carries on from the unlock screen (surau name in
// gold, "Assalamualaikum, <name>", their roles) so the door and the house
// feel like one place. Under it: one board of facts about the box, read
// as rows like a notice board, with gold where something needs attention;
// then the one shortcut everybody uses, the kiosk preview, on glass.
// Certificate renewal is automatic and never mentioned, except the one
// calm line an admin sees when it is failing close to expiry (tech_check).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../sync/sync_status_chip.dart';
import '../common/help_card.dart' show DetailRow, TechnicalDetails;
import '../common/identity.dart';
import '../common/roles.dart';
import '../common/surau_logo.dart';
import '../common/time_words.dart';
import 'permissions.dart';
import 'read_cache.dart';
import '../prayer_year.dart';
import 'tech_check.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  /// Below this many days the prayer data is flagged.
  static const int warnDays = 30;

  /// Same flag when the box tops the data up by itself and has not failed.
  static const int warnDaysAutoFetch = 14;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final session = ref.watch(sessionProvider);
    final box = ref.watch(enrolledBoxProvider);
    final name = session?.user.name ?? box?.userName ?? '';
    final roles = ref.watch(rolesProvider);
    final surau = ref.watch(surauInfoProvider)?.name ?? s.productName;
    final logo = ref.watch(surauLogoProvider).value;
    final showName = ref.watch(surauShowNameProvider);
    final narrow = MediaQuery.sizeOf(context).width < AppShell.wideBreakpoint;

    return Scaffold(
      body: Column(
        children: [
          Container(
            decoration: const BoxDecoration(
              color: SurauColors.glass,
              border: Border(bottom: BorderSide(color: SurauColors.goldHairline)),
            ),
            child: SafeArea(
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 22, 20, 26),
                child: ContentColumn(
                  child: _HomeHeader(
                    surauName: surau,
                    logo: logo == null ? null : LogoImage(bytes: logo, height: 48),
                    showName: showName,
                    greeting: s.greeting(name),
                    roles: rolesSentence(s, roles.toList()),
                    withAccount: narrow,
                  ),
                ),
              ),
            ),
          ),
          const OfflineBanner(),
          Expanded(
            child: SurauTheme.page(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
              children: [
                const _TechCheckNotice(),
                const _StatusBoard(),
                const SyncDashboardCard(),
                if (canSee(roles, 'kiosk:read')) ...[
                  const SizedBox(height: 16),
                  const _PreviewTile(),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The unlock screen's identity block, left-aligned, with the logo beside
/// the surau's name when there is one, and the person button at the end of
/// that row so the greeting keeps the full width.
class _HomeHeader extends StatelessWidget {
  const _HomeHeader({
    required this.surauName,
    required this.greeting,
    required this.roles,
    required this.withAccount,
    this.logo,
    this.showName = true,
  });

  final String surauName;
  final Widget? logo;
  final bool showName;
  final String greeting;
  final String roles;
  final bool withAccount;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final nameStyle = text.titleMedium!.copyWith(color: SurauColors.gold, letterSpacing: 0.2);
    if (!withAccount) {
      if (logo == null) {
        return SurauIdentity(
          surauName: surauName,
          greeting: greeting,
          roles: roles,
          centered: false,
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SurauNameRow(name: surauName, logo: logo, style: nameStyle, showName: showName),
          const SizedBox(height: 6),
          Text(greeting, style: text.headlineSmall!.copyWith(color: Colors.white)),
          if (roles.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(roles, style: text.bodyLarge!.copyWith(color: Colors.white.withValues(alpha: 0.74))),
          ],
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: SurauNameRow(name: surauName, logo: logo, style: nameStyle, showName: showName),
            ),
            const SizedBox(width: 12),
            const AccountButton(),
          ],
        ),
        const SizedBox(height: 2),
        Text(greeting, style: text.headlineSmall!.copyWith(color: Colors.white)),
        if (roles.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(
            roles,
            style: text.bodyLarge!.copyWith(
              color: Colors.white.withValues(alpha: 0.74),
            ),
          ),
        ],
      ],
    );
  }
}

/// `GET /api/health` as four rows; the header says when the box last
/// answered.
class _StatusBoard extends ConsumerWidget {
  const _StatusBoard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final health = ref.watch(healthProvider);
    final reach = ref.watch(connectivityProvider);
    // The data version is a technical number: only the admin (Pentadbir)
    // sees the row (operator rule 2026-11-04).
    final admin = ref.watch(rolesProvider).contains('admin');
    final Read<HealthDto>? read = health.value;
    final h = read?.value;
    final busy = health.isLoading && read == null;

    final String reachText;
    final Color dot;
    if (reach.down) {
      reachText = s.statusUnreachable;
      dot = SurauColors.gold;
    } else if (reach.lastContact != null) {
      reachText = s.statusReachedAt(
        whenWords(deps.toLocal(reach.lastContact!), today: deps.toLocal(deps.now())),
      );
      dot = SurauColors.teal;
    } else {
      reachText = s.statusChecking;
      dot = SurauColors.outline;
    }

    String days(int? n) => n == null ? s.statusUnknown : s.daysLeft(n);
    final auto = h?.autoFetch;
    final autoOk = auto != null && auto.enabled && auto.lastOk != false;
    final limit = autoOk ? DashboardScreen.warnDaysAutoFetch : DashboardScreen.warnDays;
    bool warn(int? n) => n != null && n < limit;

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 14),
            // The reach line drops under the title when both do not fit.
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              runSpacing: 6,
              spacing: 16,
              children: [
                Text(s.statusTitle, style: text.titleMedium),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 8),
                    Text(reachText, style: text.bodySmall),
                  ],
                ),
              ],
            ),
          ),
          if (busy) const LinearProgressIndicator(minHeight: 2),
          const Divider(),
          // Whoever may top the data up (prayer:import) goes straight to the
          // import page from here; everyone else reads the figure.
          _StatusRow(
            key: const ValueKey('status-prayer-data'),
            icon: Icons.calendar_month_outlined,
            label: s.statusPrayerData,
            value: days(h?.daysAhead),
            unknown: h?.daysAhead == null,
            warn: warn(h?.daysAhead),
            hint: noDataThisYear(h?.daysAhead) ? s.statusPrayerDataNone : s.statusPrayerDataWarning,
            onTap: canSee(ref.watch(rolesProvider), 'prayer:import')
                ? () => context.go(AppRoutes.prayerData)
                : null,
          ),
          const Divider(),
          _StatusRow(
            icon: Icons.lock_clock_outlined,
            label: s.statusLockedUsers,
            value: h?.lockedUsers?.toString() ?? s.statusUnknown,
            unknown: h?.lockedUsers == null,
          ),
          if (admin) ...[
            const Divider(),
            _StatusRow(
              icon: Icons.sync_outlined,
              label: s.statusDataVersion,
              value: h?.version.toString() ?? s.statusUnknown,
              unknown: h == null,
            ),
            if (h?.appLock != null) ...[
              const Divider(),
              _StatusRow(
                key: const ValueKey('status-app-lock'),
                icon: Icons.lock_outline_rounded,
                label: s.appLockTitle,
                value: h!.appLock! ? s.appLockStatusOn : s.appLockStatusOff,
                onTap: canSee(ref.watch(rolesProvider), 'settings:write')
                    ? () => context.go(AppRoutes.settingsFor('appLock'))
                    : null,
              ),
            ],
          ],
        ],
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.unknown = false,
    this.warn = false,
    this.hint,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final String value;
  final bool unknown;
  final bool warn;
  final String? hint;

  /// When set the row is a button (ripple, chevron) to the page behind it.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final valueStyle = text.titleMedium!.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
      color: unknown ? SurauColors.muted : SurauColors.text,
      fontWeight: unknown ? FontWeight.w400 : FontWeight.w600,
    );
    final row = Padding(
      padding: EdgeInsets.fromLTRB(20, 14, onTap == null ? 20 : 12, 14),
      child: Row(
        children: [
          Icon(icon, size: 24, color: warn ? SurauColors.ink : SurauColors.teal),
          const SizedBox(width: 14),
          Expanded(
            flex: 3,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: text.bodyLarge),
                if (warn && hint != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      hint!,
                      style: text.bodySmall!.copyWith(color: SurauColors.ink),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            flex: 2,
            child: warn
                ? Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: SurauColors.goldSoft,
                      borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                    ),
                    child: Text(
                      value,
                      textAlign: TextAlign.end,
                      style: valueStyle.copyWith(color: SurauColors.ink),
                    ),
                  )
                : Text(value, textAlign: TextAlign.end, style: valueStyle),
          ),
          if (onTap != null) ...[
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          ],
        ],
      ),
    );
    if (onTap == null) return row;
    return InkWell(onTap: onTap, child: row);
  }
}

const String _contactMark = '';

/// The tech-check sentence with the phone number as one no-wrap piece.
/// [line] is the localised sentence with [_contactMark] where the contact
/// goes; [lead] is the name part, [phone] may be null.
InlineSpan techCheckLineSpan(String line, String lead, String? phone, TextStyle style) {
  final at = line.indexOf(_contactMark);
  final before = at < 0 ? line : line.substring(0, at);
  final after = at < 0 ? '' : line.substring(at + _contactMark.length);
  return TextSpan(
    style: style,
    children: [
      TextSpan(text: before + lead),
      if (phone != null)
        WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: Text(phone, softWrap: false, style: style),
        ),
      TextSpan(text: after),
    ],
  );
}

/// Nothing, almost always. For an admin whose box reports a certificate
/// under two weeks with the automatic renewal failing: one calm line
/// naming whom to call, with the figures behind "Butiran teknikal".
class _TechCheckNotice extends ConsumerWidget {
  const _TechCheckNotice();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(techCheckProvider).value;
    if (status == null || !status.needsCheck) return const SizedBox.shrink();
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final help = ref.watch(surauInfoProvider)?.help;
    // The phone number is one unbreakable piece (the bundled font has no
    // non-breaking hyphen, so it is a no-wrap widget instead).
    final name = help?.name;
    final phone = help?.phone;
    final contactText = switch ((name, phone)) {
      (final String n, _) => phone == null ? n : '$n, ',
      (null, final String _) => '',
      _ => s.techCheckContactAnyone,
    };
    final attempt = DateTime.tryParse(status.lastRenewAttempt ?? '');
    final lastRenew = attempt == null
        ? s.techCheckRenewNever
        : s.techCheckRenewFailed(
            whenWords(deps.toLocal(attempt), today: deps.toLocal(deps.now())),
          );
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
            decoration: BoxDecoration(
              color: SurauColors.goldSoft,
              borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
              border: Border.all(color: SurauColors.goldHairline),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 1),
                  child: Icon(Icons.build_circle_outlined, color: SurauColors.ink, size: 24),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text.rich(
                    techCheckLineSpan(
                      s.techCheckLine(_contactMark),
                      contactText,
                      phone,
                      text.bodyLarge!.copyWith(color: SurauColors.ink),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          TechnicalDetails(
            rows: <DetailRow>[
              (label: s.techCheckDaysLeft, value: s.daysLeft(status.leafDaysLeft ?? 0)),
              (label: s.techCheckLastRenew, value: lastRenew),
            ],
            note: s.techCheckExplain,
          ),
        ],
      ),
    );
  }
}

/// The one glass element on the page: straight to what the TV shows.
class _PreviewTile extends StatelessWidget {
  const _PreviewTile();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Material(
      color: SurauColors.glass,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        side: const BorderSide(color: SurauColors.goldHairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => context.go(AppRoutes.preview),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 14, 16),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: SurauColors.gold.withValues(alpha: 0.14),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.tv_outlined, color: SurauColors.gold, size: 26),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.previewShortcut,
                      style: text.titleMedium!.copyWith(color: Colors.white),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      s.previewShortcutHint,
                      style: text.bodyMedium!.copyWith(
                        color: Colors.white.withValues(alpha: 0.72),
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: SurauColors.gold),
            ],
          ),
        ),
      ),
    );
  }
}
