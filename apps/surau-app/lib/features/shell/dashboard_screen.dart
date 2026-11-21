// Home (operator round 1, mockups 01 to 04). The glass header carries on
// from the unlock screen (surau name in gold, "Assalamualaikum, <name>",
// their roles) with the MAXCOM cloud and box icons beside the name and the
// language switch beside the roles. Under it, only what matters now:
// "Perlu perhatian" when something needs doing (and nothing when all is
// well), what the TV shows with "Lihat skrin TV", then "Butiran sistem",
// folded every time the page opens, with the old status board inside. On a
// wide screen the two halves sit side by side.
// Certificate renewal is automatic and never mentioned, except the one
// calm line an admin sees when it is failing close to expiry (tech_check).

import '../live/live_notice_banner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_version.dart';
import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../sync/sync_engine.dart' show SyncView;
import '../../sync/sync_providers.dart';
import '../common/help_card.dart' show DetailRow, TechnicalDetails;
import '../common/language_switch.dart';
import '../labels.dart' show appLangOfS;
import '../common/roles.dart';
import '../common/surau_logo.dart';
import '../common/time_words.dart';
import '../prayer_year.dart';
import '../sync/sync_actions.dart';
import '../sync/sync_status_chip.dart' show showSyncSheet, stampWords;
import 'box_name_dialog.dart';
import 'connection_icons.dart';
import 'permissions.dart';
import 'read_cache.dart';
import 'tech_check.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  /// Below this many days the prayer data is flagged.
  static const int warnDays = 30;

  /// Same flag when the box tops the data up by itself and has not failed.
  static const int warnDaysAutoFetch = 14;

  /// From this width of the page (beside the rail) the page has two columns.
  static const double twoColumnsFrom = 720;

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
      body: LayoutBuilder(
        builder: (context, c) {
          final two = c.maxWidth >= twoColumnsFrom;
          final maxWidth = two ? 1100.0 : SurauTheme.contentMaxWidth;
          final left = <Widget>[
            const LiveNoticeBanner(),
            const _TechCheckNotice(),
            const _Attention(),
            if (canSee(roles, 'kiosk:read')) const _OnTv(),
          ];
          const right = <Widget>[_SystemDetails()];
          return Column(
            children: [
              Container(
                decoration: const BoxDecoration(
                  color: SurauColors.glass,
                  border: Border(bottom: BorderSide(color: SurauColors.goldHairline)),
                ),
                child: SafeArea(
                  bottom: false,
                  child: Padding(
                    padding: const EdgeInsetsDirectional.fromSTEB(24, 16, 16, 20),
                    child: ContentColumn(
                      maxWidth: maxWidth,
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
                child: ContentColumn(
                  maxWidth: maxWidth,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
                    children: two
                        ? [
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  key: const ValueKey('dash-col-start'),
                                  flex: 11,
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left),
                                ),
                                const SizedBox(width: 20),
                                Expanded(
                                  key: const ValueKey('dash-col-end'),
                                  flex: 10,
                                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right),
                                ),
                              ],
                            ),
                          ]
                        : [...left, ...right],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// The identity block: the surau (logo and name) with the two status icons
/// and, on a phone, the person button; the greeting; the roles with the
/// language switch.
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: SurauNameRow(name: surauName, logo: logo, style: nameStyle, showName: showName),
            ),
            const SizedBox(width: 8),
            const ConnectionIcons(),
            if (withAccount) ...[const SizedBox(width: 8), const AccountButton()],
          ],
        ),
        const SizedBox(height: 6),
        Text(greeting, style: text.headlineSmall!.copyWith(color: Colors.white)),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: Text(
                roles,
                style: text.bodyLarge!.copyWith(color: Colors.white.withValues(alpha: 0.74)),
              ),
            ),
            const SizedBox(width: 12),
            const LanguageSwitch(),
          ],
        ),
      ],
    );
  }
}

/// The health answer, its age in words, and whether the prayer data is
/// running low (shared by "Perlu perhatian" and "Butiran sistem").
class _Facts {
  _Facts(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final deps = ref.watch(appDepsProvider);
    final health = ref.watch(healthProvider);
    final reach = ref.watch(connectivityProvider);
    final Read<HealthDto>? read = health.value;
    h = read?.value;
    busy = health.isLoading && read == null;
    if (reach.down) {
      reachText = s.statusUnreachable;
    } else if (reach.lastContact != null) {
      reachText = s.statusReachedAt(
        whenWords(deps.toLocal(reach.lastContact!), today: deps.toLocal(deps.now()), lang: appLangOfS(s)),
      );
    } else {
      reachText = s.statusChecking;
    }
    final auto = h?.autoFetch;
    final autoOk = auto != null && auto.enabled && auto.lastOk != false;
    limit = autoOk ? DashboardScreen.warnDaysAutoFetch : DashboardScreen.warnDays;
  }

  late final HealthDto? h;
  late final bool busy;
  late final String reachText;
  late final int limit;

  bool warn(int? n) => n != null && n < limit;
}

/// A small heading over a section.
class _Section extends StatelessWidget {
  const _Section(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(4, 0, 4, 8),
      child: Text(
        title,
        style: text.titleSmall!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// Only when something needs doing: the prayer data running low, people
/// locked out (for whoever can unlock them). Nothing at all otherwise.
class _Attention extends ConsumerWidget {
  const _Attention();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final f = _Facts(context, ref);
    final roles = ref.watch(rolesProvider);
    final days = f.h?.daysAhead;
    final locked = f.h?.lockedUsers ?? 0;
    final rows = <Widget>[
      if (f.warn(days))
        _AttentionRow(
          key: const ValueKey('attention-prayer'),
          icon: Icons.calendar_month_outlined,
          title: noDataThisYear(days) ? s.dashPrayerNone : s.dashPrayerDaysLeft(days!),
          hint: noDataThisYear(days) ? s.statusPrayerDataNone : s.statusPrayerDataWarning,
          onTap: canSee(roles, 'prayer:import') ? () => context.go(AppRoutes.prayerData) : null,
        ),
      if (locked > 0 && canSee(roles, 'users:manage'))
        _AttentionRow(
          key: const ValueKey('attention-locked'),
          icon: Icons.lock_clock_outlined,
          title: s.dashLockedUsers(locked),
          hint: s.dashLockedHint,
          onTap: () => context.go(AppRoutes.users),
        ),
    ];
    if (rows.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Section(s.dashAttention),
          Card(
            child: Column(
              children: [
                for (var i = 0; i < rows.length; i++) ...[if (i > 0) const Divider(), rows[i]],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AttentionRow extends StatelessWidget {
  const _AttentionRow({super.key, required this.icon, required this.title, required this.hint, this.onTap});

  final IconData icon;
  final String title;
  final String hint;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final row = Padding(
      padding: EdgeInsetsDirectional.fromSTEB(16, 14, onTap == null ? 16 : 10, 14),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: SurauColors.goldSoft,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, size: 22, color: SurauColors.ink),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(hint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
              ],
            ),
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

/// What the TV shows: the one glass element on the page, straight to the
/// preview.
class _OnTv extends StatelessWidget {
  const _OnTv();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Section(s.dashOnTv),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: SurauColors.glass,
              borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
              border: Border.all(color: SurauColors.goldHairline),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: SurauColors.gold.withValues(alpha: 0.14),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.tv_outlined, color: SurauColors.gold, size: 24),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Text(
                        s.previewShortcutHint,
                        style: text.bodyLarge!.copyWith(color: Colors.white.withValues(alpha: 0.86)),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                OutlinedButton.icon(
                  key: const ValueKey('dash-see-tv'),
                  onPressed: () => context.go(AppRoutes.preview),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: SurauColors.gold,
                    side: BorderSide(color: SurauColors.gold.withValues(alpha: 0.6), width: 1.6),
                    minimumSize: const Size.fromHeight(48),
                  ),
                  icon: const Icon(Icons.tv_outlined),
                  label: Text(s.dashSeeTv),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// "Butiran sistem": the old status board behind one fold, folded each time
/// the page is built (nothing remembered). The line under the title says
/// when MAXCOM last answered.
class _SystemDetails extends ConsumerStatefulWidget {
  const _SystemDetails();

  @override
  ConsumerState<_SystemDetails> createState() => _SystemDetailsState();
}

class _SystemDetailsState extends ConsumerState<_SystemDetails> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final f = _Facts(context, ref);
    final h = f.h;
    final roles = ref.watch(rolesProvider);
    // The data version is a technical number: only whoever may change the
    // settings (the Pentadbir, the Pentadbir MAXCOM) sees the row (operator
    // rule 2026-11-04); asked by permission, never by the name of a role.
    final admin = canSee(roles, 'settings:write');
    final session = ref.watch(sessionProvider);
    final way = session?.offline == true
        ? s.syncNoConnection
        : ref.watch(isCloudGatewayProvider)
        ? s.syncViaCloud
        : s.syncViaBox;
    String days(int? n) => n == null ? s.statusUnknown : s.daysLeft(n);
    final engine = ref.watch(syncActionsProvider) != null;
    final deps = ref.watch(appDepsProvider);
    final SyncView? view = engine ? ref.watch(syncViewProvider).value : null;
    final last = view?.lastSync;

    final rows = <Widget>[
      _StatusRow(
        key: const ValueKey('status-connection'),
        icon: Icons.router_outlined,
        label: s.statusTitle,
        value: way,
      ),
      if (h?.name != null)
        _StatusRow(
          key: const ValueKey('status-box-name'),
          icon: Icons.dns_outlined,
          label: s.dashBoxName,
          value: h!.name!,
          // Whoever may change the settings renames the box, straight to the box (the cloud has no relay for it).
          onTap: admin && !ref.watch(isCloudGatewayProvider) ? () => showBoxNameDialog(context, ref, h.name!) : null,
        ),
      _StatusRow(
        key: const ValueKey('status-prayer-data'),
        icon: Icons.calendar_month_outlined,
        label: s.statusPrayerData,
        value: days(h?.daysAhead),
        unknown: h?.daysAhead == null,
        warn: f.warn(h?.daysAhead),
        // Whoever may top the data up (prayer:import) goes straight to the
        // import page from here; everyone else reads the figure.
        onTap: canSee(roles, 'prayer:import') ? () => context.go(AppRoutes.prayerData) : null,
      ),
      _StatusRow(
        icon: Icons.lock_clock_outlined,
        label: s.statusLockedUsers,
        value: h?.lockedUsers?.toString() ?? s.statusUnknown,
        unknown: h?.lockedUsers == null,
      ),
      if (admin)
        _StatusRow(
          icon: Icons.numbers_rounded,
          label: s.statusDataVersion,
          value: h?.version.toString() ?? s.statusUnknown,
          unknown: h == null,
        ),
      if (admin && h?.appLock != null)
        _StatusRow(
          key: const ValueKey('status-app-lock'),
          icon: Icons.lock_outline_rounded,
          label: s.appLockTitle,
          value: h!.appLock! ? s.appLockStatusOn : s.appLockStatusOff,
          onTap: canSee(roles, 'settings:write') ? () => context.go(AppRoutes.settingsFor('appLock')) : null,
        ),
      if (engine)
        _StatusRow(
          key: const ValueKey('status-last-sync'),
          icon: Icons.sync_rounded,
          label: s.syncLastSync,
          value: last == null ? s.syncNever : stampWords(deps.toLocal(last), today: deps.toLocal(deps.now()), lang: appLangOfS(s)),
          onTap: () => showSyncSheet(context),
        ),
      _StatusRow(
        key: const ValueKey('status-app-version'),
        icon: Icons.phone_android_outlined,
        label: s.dashAppVersion,
        value: appVersion,
      ),
    ];

    return Card(
      key: const ValueKey('dash-system'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _open,
            child: InkWell(
              key: const ValueKey('dash-system-toggle'),
              borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
              onTap: () => setState(() => _open = !_open),
              child: Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 12, 14),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: SurauColors.tealSoft,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(Icons.info_outline_rounded, size: 22, color: SurauColors.teal),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(s.dashSystem, style: text.titleMedium),
                          const SizedBox(height: 2),
                          Text(f.reachText, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                        ],
                      ),
                    ),
                    AnimatedRotation(
                      turns: _open ? 0.5 : 0,
                      duration: const Duration(milliseconds: 180),
                      child: const Icon(Icons.expand_more_rounded, color: SurauColors.teal),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (f.busy && _open) const LinearProgressIndicator(minHeight: 2),
          AnimatedSize(
            duration: const Duration(milliseconds: 180),
            alignment: Alignment.topCenter,
            child: _open
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final r in rows) ...[const Divider(), r],
                    ],
                  )
                : const SizedBox(width: double.infinity),
          ),
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
    this.onTap,
  });

  final IconData icon;
  final String label;
  final String value;
  final bool unknown;
  final bool warn;

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
      padding: EdgeInsetsDirectional.fromSTEB(20, 12, onTap == null ? 20 : 12, 12),
      child: Row(
        children: [
          Icon(icon, size: 22, color: warn ? SurauColors.ink : SurauColors.teal),
          const SizedBox(width: 14),
          Expanded(child: Text(label, style: text.bodyLarge)),
          const SizedBox(width: 12),
          Expanded(
            child: warn
                ? Align(
                    alignment: AlignmentDirectional.centerEnd,
                    child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: SurauColors.goldSoft,
                      borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                    ),
                    child: Text(value, textAlign: TextAlign.end, style: valueStyle.copyWith(color: SurauColors.ink)),
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
    if (onTap == null) return ConstrainedBox(constraints: const BoxConstraints(minHeight: 48), child: row);
    return InkWell(onTap: onTap, child: ConstrainedBox(constraints: const BoxConstraints(minHeight: 48), child: row));
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
            whenWords(deps.toLocal(attempt), today: deps.toLocal(deps.now()), lang: appLangOfS(s)),
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
