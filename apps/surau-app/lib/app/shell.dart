// The house around every unlocked screen: the kiosk's glass as chrome
// (a rail beside the content on an iPad, a bar under it on a phone) that
// shows only what the person's roles and the box's switches allow, the
// person's own sheet (this device, help, lock), the calm offline banner
// every page shows under its title, and the health poll that keeps data
// fresh while the app is in front.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/shell/superadmin_badge.dart';
import '../features/common/help_card.dart';
import '../features/common/roles.dart';
import '../features/common/surau_logo.dart';
import '../features/common/time_words.dart';
import '../features/live/live_fold.dart';
import '../features/shell/menu.dart';
import '../features/unlock/session_keeper.dart';
import '../features/sync/sync_status_chip.dart';
import '../features/upload/cleanup_providers.dart' show recordingCleanupProvider;
import '../features/upload/upload_widgets.dart' show catchUpActiveCountProvider;
import '../l10n/generated/s.dart';
import '../sync/sync_providers.dart';
import 'app_version.dart';
import 'providers.dart';
import 'router.dart';
import 'theme.dart';

class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key, required this.location, required this.child});

  /// Width from which the rail replaces the bottom bar.
  static const double wideBreakpoint = 700;

  /// The bottom bar shows every entry up to this many; beyond it the first
  /// three and `Lagi`.
  static const int barCapacity = 4;

  final String location;
  final Widget child;

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell>
    with WidgetsBindingObserver {
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startPolling();
    // A notice raised before the shell existed (a refused deep link).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final pending = ref.read(noticeProvider);
      if (pending != null) _showNotice(pending);
      ref.read(syncCoordinatorProvider).onForeground();
      ref.read(sessionKeeperProvider).resume();
    });
  }

  void _showNotice(Notice notice) {
    final s = S.of(context);
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 6),
          content: Text(switch (notice) {
            Notice.forbidden => s.errorForbidden,
          }),
        ),
      );
    ref.read(noticeProvider.notifier).clear();
  }

  @override
  void dispose() {
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _startPolling();
      ref.read(healthProvider.notifier).refresh();
      ref.read(syncCoordinatorProvider).onForeground();
      // Offline or on the cloud: try the box (and the cloud) again now.
      ref.read(sessionKeeperProvider).resume();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _poll?.cancel();
      _poll = null;
      // The reconnector runs only while the app is in front.
      ref.read(sessionKeeperProvider).pause();
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  void _startPolling() {
    final every = ref.read(appDepsProvider).healthPollInterval;
    if (every == null || _poll != null) return;
    _poll = Timer.periodic(every, (_) {
      ref.read(healthProvider.notifier).refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(noticeProvider, (_, notice) {
      if (notice != null) _showNotice(notice);
    });
    // The recording clean-up runs for as long as the app is open (it checks
    // YouTube at most once an hour per recording and deletes only what the
    // app recorded and YouTube has).
    ref.listen(recordingCleanupProvider, (_, _) {});

    final items = menuFor(
      ref.watch(rolesProvider),
      ref.watch(featureFlagsProvider),
    );
    // Catch-up uploads still running: the badge on the upload entry.
    final uploadsActive = ref.watch(catchUpActiveCountProvider);

    // The Live tab folded to its preview alone: no navigation, so the video
    // is as large as the screen allows.
    final hideNav =
        ref.watch(liveFoldedProvider) && widget.location.startsWith('/live');
    if (hideNav) return widget.child;

    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= AppShell.wideBreakpoint;
        if (wide) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _GlassRail(
                items: items,
                location: widget.location,
                extended: constraints.maxWidth >= 1000,
                uploadsActive: uploadsActive,
              ),
              Expanded(child: widget.child),
            ],
          );
        }
        return Column(
          children: [
            Expanded(child: widget.child),
            _GlassBar(
              items: items,
              location: widget.location,
              uploadsActive: uploadsActive,
            ),
          ],
        );
      },
    );
  }
}

// ---- rail (iPad) ----

class _GlassRail extends ConsumerWidget {
  const _GlassRail({
    required this.items,
    required this.location,
    required this.extended,
    this.uploadsActive = 0,
  });

  final List<MenuItem> items;
  final String location;
  final bool extended;
  final int uploadsActive;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final surau = ref.watch(surauInfoProvider)?.name ?? s.productName;
    final logo = ref.watch(surauLogoProvider).value;
    final showName = ref.watch(surauShowNameProvider);
    final session = ref.watch(sessionProvider);
    final box = ref.watch(enrolledBoxProvider);
    final name = session?.user.name ?? box?.userName ?? '';
    final roles = rolesSentence(s, ref.watch(rolesProvider).toList());
    final nameStyle = (extended ? text.titleMedium : text.labelMedium)!
        .copyWith(color: SurauColors.gold, letterSpacing: 0.2);
    final nameText = Text(
      surau,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      textAlign: extended ? TextAlign.start : TextAlign.center,
      style: nameStyle,
    );

    return Container(
      width: extended ? 256 : 112,
      decoration: const BoxDecoration(
        color: SurauColors.glass,
        border: Border(right: BorderSide(color: SurauColors.goldHairline)),
      ),
      child: SafeArea(
        right: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(
                extended ? 22 : 12,
                24,
                extended ? 22 : 12,
                18,
              ),
              // The logo sits beside the name on the wide rail and above it on
              // the narrow one (alone when the logo carries the name); without
              // a logo the rail head is as before.
              child: logo == null
                  ? nameText
                  : extended
                  ? SurauNameRow(
                      name: surau,
                      logo: LogoImage(
                        bytes: logo,
                        height: 44,
                        maxWidth: showName ? 120 : 212,
                      ),
                      style: nameStyle,
                      showName: showName,
                    )
                  : Column(
                      children: [
                        LogoImage(bytes: logo, height: 48, maxWidth: 88),
                        if (showName) ...[const SizedBox(height: 8), nameText],
                      ],
                    ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Column(
                  children: [
                    for (final item in items)
                      _NavButton(
                        icon: item.icon,
                        selectedIcon: item.selectedIcon,
                        label: item.label(s),
                        selected: item.matches(location),
                        horizontal: extended,
                        badge: item.entry == MenuEntry.upload
                            ? uploadsActive
                            : 0,
                        onTap: () => context.go(item.route),
                      ),
                  ],
                ),
              ),
            ),
            SuperadminBadge(wide: true, compact: !extended),
            const Divider(color: SurauColors.goldHairline, height: 1),
            Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: () => showAccountSheet(context),
                child: Padding(
                  padding: EdgeInsets.symmetric(
                    horizontal: extended ? 20 : 12,
                    vertical: 16,
                  ),
                  child: extended
                      ? Row(
                          children: [
                            _Initials(name: name),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.titleSmall!.copyWith(
                                      color: Colors.white,
                                    ),
                                  ),
                                  Text(
                                    roles,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.bodySmall!.copyWith(
                                      color: Colors.white.withValues(
                                        alpha: 0.72,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        )
                      : Center(child: _Initials(name: name)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---- bar (phone) ----

class _GlassBar extends StatelessWidget {
  const _GlassBar({
    required this.items,
    required this.location,
    this.uploadsActive = 0,
  });

  final List<MenuItem> items;
  final String location;
  final int uploadsActive;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final overflow = items.length > AppShell.barCapacity;
    final shown = overflow ? items.sublist(0, AppShell.barCapacity - 1) : items;
    final rest = overflow
        ? items.sublist(AppShell.barCapacity - 1)
        : const <MenuItem>[];
    final restSelected = rest.any((i) => i.matches(location));

    return Container(
      decoration: const BoxDecoration(
        color: SurauColors.glass,
        border: Border(top: BorderSide(color: SurauColors.goldHairline)),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 76,
          child: Row(
            children: [
              for (final item in shown)
                Expanded(
                  child: _NavButton(
                    icon: item.icon,
                    selectedIcon: item.selectedIcon,
                    label: item.label(s),
                    selected: item.matches(location),
                    badge: item.entry == MenuEntry.upload ? uploadsActive : 0,
                    onTap: () => context.go(item.route),
                  ),
                ),
              if (overflow)
                Expanded(
                  child: _NavButton(
                    icon: Icons.menu_rounded,
                    selectedIcon: Icons.menu_rounded,
                    label: s.navMore,
                    selected: restSelected,
                    // the upload entry may sit behind "Lagi": show it there
                    badge: rest.any((i) => i.entry == MenuEntry.upload)
                        ? uploadsActive
                        : 0,
                    onTap: () => showAccountSheet(context, extraItems: rest),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One destination on glass: icon over label (or beside it when
/// [horizontal]), gold when selected with a soft gold pill behind the icon.
class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.selectedIcon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.horizontal = false,
    this.badge = 0,
  });

  /// Running jobs to show on the icon (0 draws nothing).
  final int badge;

  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool horizontal;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final colour = selected
        ? SurauColors.gold
        : Colors.white.withValues(alpha: 0.78);
    final pill = Container(
      width: horizontal ? 44 : 56,
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected
            ? SurauColors.gold.withValues(alpha: 0.18)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Icon(selected ? selectedIcon : icon, size: 26, color: colour),
    );
    final badged = badge > 0
        ? Badge(
            key: const ValueKey('nav-badge'),
            label: Text('$badge'),
            backgroundColor: SurauColors.gold,
            textColor: SurauColors.ink,
            offset: const Offset(4, -2),
            child: pill,
          )
        : pill;
    final labelText = Text(
      label,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      textAlign: horizontal ? TextAlign.start : TextAlign.center,
      style: text.labelSmall!.copyWith(
        fontSize: horizontal ? 15 : 12.5,
        height: 1.15,
        fontWeight: FontWeight.w600,
        color: colour,
      ),
    );
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: horizontal ? 10 : 4,
              vertical: horizontal ? 6 : 5,
            ),
            child: horizontal
                ? Row(
                    children: [
                      badged,
                      const SizedBox(width: 12),
                      Expanded(child: labelText),
                    ],
                  )
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [badged, const SizedBox(height: 3), labelText],
                  ),
          ),
        ),
      ),
    );
  }
}

/// The person's initials in a gold-rimmed disc, on glass or on paper.
class _Initials extends StatelessWidget {
  const _Initials({required this.name, this.onPaper = false, this.size = 44});

  final String name;
  final bool onPaper;
  final double size;

  static String of(String name) {
    final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    final letters = words.take(2).map((w) => w[0].toUpperCase()).join();
    return letters.isEmpty ? '?' : letters;
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: onPaper
            ? SurauColors.tealSoft
            : SurauColors.gold.withValues(alpha: 0.14),
        border: Border.all(
          color: onPaper ? SurauColors.tealSoft : SurauColors.goldHairline,
        ),
      ),
      child: Text(
        of(name),
        style: text.labelMedium!.copyWith(
          fontSize: size * 0.36,
          color: onPaper ? SurauColors.teal : SurauColors.gold,
        ),
      ),
    );
  }
}

/// The round person button on the home header (phones, where there is no
/// rail).
class AccountButton extends StatelessWidget {
  const AccountButton({super.key});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: S.of(context).navMore,
      child: Material(
        color: SurauColors.gold.withValues(alpha: 0.12),
        shape: const CircleBorder(
          side: BorderSide(color: SurauColors.goldHairline),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => showAccountSheet(context),
          child: const SizedBox(
            width: 48,
            height: 48,
            child: Icon(
              Icons.person_outline_rounded,
              color: SurauColors.gold,
              size: 26,
            ),
          ),
        ),
      ),
    );
  }
}

// ---- the person's sheet ----

/// Who is signed in and what else they can open: the menu entries that
/// did not fit the bar, this device, help and lock.
Future<void> showAccountSheet(
  BuildContext context, {
  List<MenuItem> extraItems = const [],
}) async {
  // The sheet only answers; the action runs after it has closed, from the
  // caller's context, which outlives the sheet.
  final choice = await showModalBottomSheet<_SheetChoice>(
    context: context,
    useSafeArea: true,
    // Sized to its content (eight rows at most) instead of the default
    // nine sixteenths of the screen, which clipped the last rows.
    isScrollControlled: true,
    constraints: BoxConstraints(
      maxWidth: 520,
      maxHeight: MediaQuery.sizeOf(context).height * 0.9,
    ),
    builder: (context) => _AccountSheet(extraItems: extraItems),
  );
  if (choice == null || !context.mounted) return;
  switch (choice) {
    case _GoTo(:final route):
      context.go(route);
    case _Help():
      await showHelpSheet(context);
    case _Lock():
      ProviderScope.containerOf(context).read(sessionProvider.notifier).clear();
  }
}

sealed class _SheetChoice {
  const _SheetChoice();
}

class _GoTo extends _SheetChoice {
  const _GoTo(this.route);
  final String route;
}

class _Help extends _SheetChoice {
  const _Help();
}

class _Lock extends _SheetChoice {
  const _Lock();
}

class _AccountSheet extends ConsumerWidget {
  const _AccountSheet({required this.extraItems});

  final List<MenuItem> extraItems;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final session = ref.watch(sessionProvider);
    final box = ref.watch(enrolledBoxProvider);
    final name = session?.user.name ?? box?.userName ?? '';
    final roles = rolesSentence(s, ref.watch(rolesProvider).toList());
    final surau = ref.watch(surauInfoProvider)?.name ?? s.productName;
    final uploadsActive = ref.watch(catchUpActiveCountProvider);

    void answer(_SheetChoice choice) => Navigator.of(context).pop(choice);

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
            child: Row(
              children: [
                _Initials(name: name, onPaper: true, size: 52),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(name, style: text.titleMedium),
                      if (roles.isNotEmpty)
                        Text(
                          roles,
                          style: text.bodyMedium!.copyWith(
                            color: SurauColors.muted,
                          ),
                        ),
                      Text(
                        surau,
                        style: text.bodySmall!.copyWith(
                          color: SurauColors.teal,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const Divider(),
          for (final item in extraItems)
            ListTile(
              leading: Icon(item.icon),
              title: Text(item.label(s)),
              trailing: item.entry == MenuEntry.upload && uploadsActive > 0
                  ? Badge(
                      key: const ValueKey('sheet-badge'),
                      label: Text('$uploadsActive'),
                      backgroundColor: SurauColors.gold,
                      textColor: SurauColors.ink,
                    )
                  : null,
              onTap: () => answer(_GoTo(item.route)),
            ),
          if (extraItems.isNotEmpty) const Divider(),
          ListTile(
            leading: const Icon(Icons.phone_android_outlined),
            title: Text(s.navThisDevice),
            onTap: () => answer(const _GoTo(AppRoutes.thisDevice)),
          ),
          ListTile(
            leading: const Icon(Icons.help_outline_rounded),
            title: Text(s.helpTitle),
            onTap: () => answer(const _Help()),
          ),
          ListTile(
            leading: const Icon(Icons.lock_outline_rounded),
            title: Text(s.actionLogout),
            onTap: () => answer(const _Lock()),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
            child: Text(
              appVersionLine,
              key: const ValueKey('app-version'),
              textAlign: TextAlign.center,
              style: text.bodySmall!.copyWith(color: SurauColors.muted),
            ),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

/// The surau's helper with call buttons, and the box address and
/// certificate fingerprint behind `Butiran teknikal`.
Future<void> showHelpSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    constraints: const BoxConstraints(maxWidth: 520),
    builder: (context) => Consumer(
      builder: (context, ref, _) {
        final deps = ref.watch(appDepsProvider);
        final info = ref.watch(surauInfoProvider);
        final box = ref.watch(enrolledBoxProvider);
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              HelpCard(contact: info?.help, openUrl: deps.openUrl),
              if (box != null) ...[
                const SizedBox(height: 12),
                TechnicalDetails(
                  boxAddress: box.box.toString(),
                  fingerprint: box.caFingerprint,
                ),
              ],
            ],
          ),
        );
      },
    ),
  );
}

// ---- offline banner and page frame ----

/// Shown under every page title while the box cannot be reached: what is
/// on screen is the last data, with the time it was fresh, and a retry. In
/// the offline session (the app opened with neither the box nor the cloud)
/// it says so calmly, and its retry tries to reconnect now.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offline = ref.watch(
      sessionProvider.select((s) => s?.offline == true),
    );
    final reach = ref.watch(connectivityProvider);
    if (!reach.down && !offline) return const SizedBox.shrink();
    final s = S.of(context);
    final deps = ref.watch(appDepsProvider);
    final text = Theme.of(context).textTheme;
    final last = reach.lastContact;
    final String message;
    if (offline) {
      message = s.offlineSessionBanner;
    } else if (last != null) {
      message = s.offlineBannerAt(
        whenWords(deps.toLocal(last), today: deps.toLocal(deps.now())),
      );
    } else if (ref.watch(readCacheProvider).isEmpty) {
      message = s.offlineNoData;
    } else {
      message = s.offlineBanner;
    }
    return Material(
      color: SurauColors.paperDeep,
      child: Container(
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: SurauColors.line)),
        ),
        padding: const EdgeInsets.fromLTRB(18, 8, 8, 8),
        child: Row(
          children: [
            const Icon(
              Icons.cloud_off_rounded,
              size: 22,
              color: SurauColors.muted,
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(message, style: text.bodyMedium)),
            TextButton(
              key: const ValueKey('offline-banner-retry'),
              onPressed: () {
                if (offline) ref.read(sessionKeeperProvider).kick();
                ref.read(healthProvider.notifier).refresh();
              },
              child: Text(s.actionRetry),
            ),
          ],
        ),
      ),
    );
  }
}

/// A page inside the shell: title bar, the offline banner, then [body].
/// Later tasks build their screens on this so every page behaves alike.
class ShellPage extends StatelessWidget {
  const ShellPage({
    super.key,
    required this.title,
    required this.body,
    this.actions = const [],
    this.floatingActionButton,
  });

  final String title;
  final Widget body;
  final List<Widget> actions;
  final Widget? floatingActionButton;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // The sync chip sits last, top right, on every page (hidden while no
      // sync engine runs).
      appBar: AppBar(
        title: Text(title),
        actions: [
          ...actions,
          const SuperadminBadge(),
          // A long title on a phone keeps its room: the chip shows its
          // icon only there.
          SyncStatusChip(
            iconOnly:
                title.length > 14 &&
                MediaQuery.sizeOf(context).width < SyncStatusChip.compactBelow,
          ),
        ],
      ),
      floatingActionButton: floatingActionButton,
      body: Column(
        children: [
          const OfflineBanner(),
          Expanded(child: body),
        ],
      ),
    );
  }
}
