// Every path in the app, the two doors (enrol, unlock) outside the shell
// and everything else inside it, with the guard deciding before each
// navigation where the person may be (lib/app/guards.dart). The jemaah
// entry is a [ComingScreen] with its real title (a later plan); the finance
// pages live in lib/features/finance/, every other page in lib/screens/.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/common/help_card.dart';
import '../features/common/identity.dart';
import '../features/common/surau_info.dart';
import '../features/common/surau_logo.dart';
import '../features/enrol/enrol_flow.dart';
import '../features/finance/audit_screen.dart' show FinanceAuditScreen;
import '../features/finance/bayaran_screen.dart';
import '../features/finance/correction_screen.dart';
import '../features/finance/entry_history_sheet.dart';
import '../features/finance/funds_screen.dart';
import '../features/finance/home_screen.dart';
import '../features/finance/kutipan_screen.dart';
import '../features/finance/report_screen.dart';
import '../features/finance/setup_screen.dart' show FinanceSetupScreen;
import '../box/setup_client.dart';
import '../features/enrol/enrol_screen.dart';
import '../features/enrol/scan_router.dart';
import '../features/enrol/scan_screen.dart';
import '../features/setup/recovery_screen.dart';
import '../features/setup/setup_providers.dart';
import '../features/setup/setup_screen.dart';
import '../features/live/live_screen.dart';
import '../features/prayer/import_records_screen.dart';
import '../features/prayer/import_screen.dart';
import '../features/prayer/location_screen.dart';
import '../features/prayer/sources_screen.dart';
import '../features/prayer/zone_screen.dart';
import '../features/shell/coming_screen.dart';
import '../features/shell/dashboard_screen.dart';
import '../features/sync/conflicts_screen.dart';
import '../features/upload/upload_screen.dart';
import '../features/sync/sync_settings_screen.dart';
import '../features/unlock/offline_vault.dart';
import '../features/unlock/session_keeper.dart';
import '../features/unlock/unlock_flow.dart';
import '../features/unlock/unlock_screen.dart';
import '../l10n/generated/s.dart';
import '../screens/audit_screen.dart';
import '../screens/content_edit_screen.dart';
import '../screens/content_list_screen.dart';
import '../screens/devices_screen.dart';
import '../screens/enrol_qr_screen.dart';
import '../screens/hadis/hadis_detail_screen.dart';
import '../screens/hadis/hadis_list_screen.dart';
import '../screens/hadis/hadis_search_screen.dart';
import '../screens/islamic_screen.dart';
import '../screens/pairing_screen.dart';
import '../screens/prayer_data_screen.dart';
import '../screens/preview_screen.dart';
import '../screens/settings_feature_screen.dart';
import '../screens/settings_list_screen.dart';
import '../screens/settings_order_screen.dart';
import '../screens/this_device_screen.dart';
import '../screens/user_edit_screen.dart';
import '../screens/users_screen.dart';
import '../screens/widgets/pieces.dart' show platformLabel;
import '../box/box_client.dart' show SessionDto;
import '../box/cloud_origin.dart';
import '../sync/sync_providers.dart';
import '../sync/transport.dart';
import 'guards.dart';
import 'providers.dart';
import 'shell.dart';
import 'theme.dart';

/// Every path in the app. Keep in step with the plan's screen list.
abstract final class AppRoutes {
  static const String enrol = '/enrol';
  static const String setup = '/setup';
  static const String recovery = '/recovery';
  static const String scan = '/scan';
  static const String unlock = '/unlock';
  static const String dashboard = '/';
  static const String settings = '/settings';
  static const String settingsFeature = '/settings/:feature';
  static const String content = '/content';
  static const String contentKind = '/content/:kind';
  static const String preview = '/preview';
  static const String islamic = '/islamic';
  static const String prayerData = '/prayer-data';
  static const String prayerImport = '/prayer-data/import';
  static const String prayerImports = '/prayer-data/imports';
  static const String users = '/users';
  static const String userNew = '/users/new';
  static const String devices = '/devices';
  static const String pairing = '/pairing';
  static const String audit = '/audit';
  static const String finance = '/finance';
  static const String financeKutipan = '/finance/kutipan';
  static const String financeBayaran = '/finance/bayaran';
  static const String financeCorrection = '/finance/pembetulan';
  static const String financeFunds = '/finance/tabung';
  static const String financeReport = '/finance/laporan';
  static const String financeAudit = '/finance/audit';
  static const String financeSetup = '/finance/setup';
  static const String live = '/live';
  static const String upload = '/upload';
  static const String jemaah = '/jemaah';
  static const String thisDevice = '/this-device';
  static const String syncConflicts = '/sync/conflicts';
  static const String syncSettings = '/settings/sync';
  static const String settingsOrder = '/settings/order';
  static const String settingsLocation = '/settings/location';
  static const String settingsZone = '/settings/zone';
  static const String settingsPrayerSources = '/settings/prayer-sources';

  static const String hadisCari = '/content/hadis/cari';

  static String settingsFor(String feature) => '/settings/$feature';
  static String hadisDetailFor(String heId) => '/content/hadis/cari/$heId';
  static String contentFor(String kind) => '/content/$kind';
  static String contentNewFor(String kind) => '/content/$kind/new';
  static String contentItemFor(String kind, String id) => '/content/$kind/$id';
  static String financeEntryFor(String id) => '/finance/entry/$id';
  static String userFor(String id) => '/users/$id';
  static String userEnrolFor(String id) => '/users/$id/enrol';
}

/// Features with a page of their own instead of the generic form, where the
/// page's path is not the feature's key (`location` and `zone` are).
const Map<String, String> customFeatureRoutes = {
  'prayerSources': AppRoutes.settingsPrayerSources,
};

/// The router, rebuilt never: the guard reads the session, the enrolled
/// box and the feature switches at each navigation, and is re-run when
/// any of them changes.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _Refresh();
  ref.onDispose(refresh.dispose);
  ref.listen(sessionProvider, (_, _) => refresh.ping());
  ref.listen(enrolledBoxProvider, (_, _) => refresh.ping());
  ref.listen(featureFlagsProvider, (_, _) => refresh.ping());
  // Keeps the offline profile current and the reconnector running.
  ref.read(sessionKeeperProvider);
  final router = createRouter(ref, refreshListenable: refresh);
  ref.onDispose(router.dispose);
  return router;
});

class _Refresh extends ChangeNotifier {
  void ping() => notifyListeners();
}

GoRouter createRouter(
  Ref ref, {
  String initialLocation = AppRoutes.dashboard,
  Listenable? refreshListenable,
}) {
  return GoRouter(
    initialLocation: initialLocation,
    refreshListenable: refreshListenable,
    redirect: (context, state) {
      final result = guard(
        GuardInput(
          location: state.uri.toString(),
          enrolled: ref.read(enrolledBoxProvider) != null,
          unlocked: ref.read(sessionProvider) != null,
          roles: ref.read(rolesProvider),
          features: ref.read(featureFlagsProvider),
        ),
      );
      if (result.forbidden) {
        ref.read(noticeProvider.notifier).show(Notice.forbidden);
      }
      return result.redirect;
    },
    routes: [
      GoRoute(
        path: AppRoutes.enrol,
        builder: (context, state) => _EnrolRoute(
          initialCode: state.extra is String ? state.extra as String : null,
        ),
      ),
      GoRoute(
        path: AppRoutes.setup,
        builder: (context, state) => _SetupRoute(
          text: state.extra is String ? state.extra as String : null,
        ),
      ),
      GoRoute(
        path: AppRoutes.recovery,
        builder: (context, state) => _RecoveryRoute(
          text: state.extra is String ? state.extra as String : null,
        ),
      ),
      GoRoute(
        path: AppRoutes.unlock,
        builder: (context, state) => const _UnlockRoute(),
      ),
      ShellRoute(
        builder: (context, state, child) =>
            AppShell(location: state.uri.path, child: child),
        routes: [
          GoRoute(
            path: AppRoutes.dashboard,
            builder: (context, state) => const DashboardScreen(),
          ),
          GoRoute(
            path: AppRoutes.settings,
            builder: (context, state) => const SettingsListScreen(),
            routes: [
              GoRoute(
                path: 'sync',
                builder: (context, state) => const SyncSettingsScreen(),
              ),
              GoRoute(
                path: 'order',
                builder: (context, state) => const SettingsOrderScreen(),
              ),
              GoRoute(
                path: 'location',
                builder: (context, state) => const LocationScreen(),
              ),
              GoRoute(
                path: 'zone',
                builder: (context, state) => const ZoneScreen(),
              ),
              GoRoute(
                path: 'prayer-sources',
                builder: (context, state) => const SourcesScreen(),
              ),
              GoRoute(
                path: ':feature',
                redirect: (context, state) =>
                    customFeatureRoutes[state.pathParameters['feature']],
                builder: (context, state) => SettingsFeatureScreen(
                  featureKey: state.pathParameters['feature']!,
                  scrollToLanjutan: state.uri.queryParameters['lj'] == '1',
                ),
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.content,
            builder: (context, state) => const ContentKindsScreen(),
            routes: [
              // Hadis has its own list and `Cari hadis`; the own-list editor
              // stays the one every kind uses.
              GoRoute(
                path: 'hadis',
                builder: (context, state) => const HadisListScreen(),
                routes: [
                  GoRoute(
                    path: 'new',
                    builder: (context, state) =>
                        const ContentEditScreen(kind: 'hadis'),
                  ),
                  GoRoute(
                    path: 'cari',
                    builder: (context, state) => const HadisSearchScreen(),
                    routes: [
                      GoRoute(
                        path: ':heId',
                        builder: (context, state) => HadisDetailScreen(
                          heId: state.pathParameters['heId']!,
                        ),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: ':id',
                    builder: (context, state) => ContentEditScreen(
                      kind: 'hadis',
                      itemId: state.pathParameters['id']!,
                    ),
                  ),
                ],
              ),
              GoRoute(
                path: ':kind',
                builder: (context, state) =>
                    ContentListScreen(kind: state.pathParameters['kind']!),
                routes: [
                  // `new` before `:id`, so it is never read as an item's id.
                  GoRoute(
                    path: 'new',
                    builder: (context, state) =>
                        ContentEditScreen(kind: state.pathParameters['kind']!),
                  ),
                  GoRoute(
                    path: ':id',
                    builder: (context, state) => ContentEditScreen(
                      kind: state.pathParameters['kind']!,
                      itemId: state.pathParameters['id']!,
                    ),
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.preview,
            builder: (context, state) => const _PreviewRoute(),
          ),
          GoRoute(
            path: AppRoutes.islamic,
            builder: (context, state) => const IslamicScreen(),
          ),
          GoRoute(
            path: AppRoutes.prayerData,
            builder: (context, state) => const PrayerDataScreen(),
            routes: [
              GoRoute(
                path: 'import',
                builder: (context, state) => const ImportScreen(),
              ),
              GoRoute(
                path: 'imports',
                builder: (context, state) => const ImportRecordsScreen(),
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.users,
            builder: (context, state) => const UsersScreen(),
            routes: [
              // `new` before `:id`, so it is never read as a person's id.
              GoRoute(
                path: 'new',
                builder: (context, state) => const UserEditScreen(),
              ),
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    UserEditScreen(userId: state.pathParameters['id']!),
                routes: [
                  GoRoute(
                    path: 'enrol',
                    builder: (context, state) =>
                        EnrolQrScreen(userId: state.pathParameters['id']!),
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.devices,
            builder: (context, state) => const DevicesScreen(),
          ),
          GoRoute(
            path: AppRoutes.pairing,
            builder: (context, state) => const PairingScreen(),
          ),
          GoRoute(
            path: AppRoutes.audit,
            builder: (context, state) => const AuditScreen(),
          ),
          GoRoute(
            path: AppRoutes.finance,
            builder: (context, state) => const FinanceHomeScreen(),
            routes: [
              GoRoute(
                path: 'kutipan',
                builder: (context, state) => const KutipanScreen(),
              ),
              GoRoute(
                path: 'bayaran',
                builder: (context, state) => const BayaranScreen(),
              ),
              GoRoute(
                path: 'pembetulan',
                builder: (context, state) => CorrectionScreen(
                  initialEntryId: state.uri.queryParameters['entry'],
                ),
              ),
              GoRoute(
                path: 'entry/:id',
                builder: (context, state) =>
                    EntryHistoryScreen(entryId: state.pathParameters['id']!),
              ),
              GoRoute(
                path: 'tabung',
                builder: (context, state) => const FundsScreen(),
              ),
              GoRoute(
                path: 'laporan',
                builder: (context, state) =>
                    ReportScreen(initialYm: state.uri.queryParameters['ym']),
              ),
              GoRoute(
                path: 'audit',
                builder: (context, state) => const FinanceAuditScreen(),
              ),
              GoRoute(
                path: 'setup',
                builder: (context, state) => const FinanceSetupScreen(),
              ),
            ],
          ),
          GoRoute(
            path: AppRoutes.live,
            builder: (context, state) => const LiveScreen(),
          ),
          GoRoute(
            path: AppRoutes.upload,
            builder: (context, state) => const UploadScreen(),
          ),
          GoRoute(
            path: AppRoutes.jemaah,
            builder: (context, state) => _coming(
              context,
              (s) => s.navJemaah,
              Icons.groups_rounded,
              (s) => s.comingJemaah,
              plan: 'Pelan 8',
            ),
          ),
          GoRoute(
            path: AppRoutes.thisDevice,
            builder: (context, state) => const ThisDeviceScreen(),
          ),
          GoRoute(
            path: AppRoutes.scan,
            builder: (context, state) => const ScanScreen(),
          ),
          GoRoute(
            path: AppRoutes.syncConflicts,
            builder: (context, state) => const ConflictsScreen(),
          ),
        ],
      ),
    ],
  );
}

Widget _coming(
  BuildContext context,
  String Function(S) title,
  IconData icon,
  String Function(S) description, {
  String? plan,
  String? detail,
}) {
  final s = S.of(context);
  return ComingScreen(
    title: title(s),
    icon: icon,
    description: description(s),
    plan: plan,
    detail: detail,
  );
}

/// How the kiosk page is embedded (a WebView on Android, an iframe on the
/// web); tests override it with a stand-in, as a platform view cannot run
/// under the test binding.
final previewBuilderProvider = Provider<PreviewBuilder>(
  (ref) => defaultPreviewBuilder,
);

class _PreviewRoute extends ConsumerWidget {
  const _PreviewRoute();

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      PreviewScreen(previewBuilder: ref.watch(previewBuilderProvider));
}

// ---- the doors ----

class _EnrolRoute extends ConsumerWidget {
  const _EnrolRoute({this.initialCode});

  /// A scanned `surau1:` text handed over by the scan router.
  final String? initialCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final deps = ref.watch(appDepsProvider);
    return EnrolScreen(
      flow: EnrolFlow(
        clientFor: deps.clientFor,
        key: deps.key,
        trust: deps.trust,
        store: deps.boxStore,
        surauInfoStore: deps.surauInfoStore,
        platform: deps.platform,
        now: deps.now,
      ),
      cameraAvailable: deps.cameraAvailable,
      scannerBuilder: deps.scannerBuilder ?? defaultScanner,
      initialCode: initialCode,
      pairingUi: true,
      onBoxQr: (text) => ScanRouter(
        enrolled: false,
        go: (path, {extra}) => context.go(path, extra: extra),
        flow: ref.read(setupFlowProvider),
      ).route(text),
      // The invitation box's own identity (id and key fingerprint), read over the CA the invitation names.
      boxInfoLoader: (box, caSha256) async {
        try {
          await deps.trust.establish(box, caSha256);
          return await SetupClient(deps.clientFor(box)).boxInfo();
        } on Object {
          return null;
        }
      },
      knownSurau: ref.watch(surauInfoProvider),
      // The invitation box's public logo, read with the same client the
      // enrolment itself uses (and with the same trust).
      logoLoader: (box) async {
        try {
          final client = deps.clientFor(box);
          final info = SurauInfo.fromJson(
            await client.getJson(SurauInfoLoader.path),
          );
          final bytes = await fetchSurauLogo(client, info?.logo);
          return bytes == null
              ? null
              : LoadedLogo(bytes, showName: info?.showName ?? true);
        } on Object {
          return null;
        }
      },
      openUrl: deps.openUrl,
      now: deps.now,
      toLocal: deps.toLocal,
      onEnrolled: (outcome) {
        ref.read(enrolledBoxProvider.notifier).adopt(outcome.box);
        context.go(AppRoutes.unlock);
      },
    );
  }
}

/// Sends a page that was opened without its QR back to the scan page.
class _BackToEnrol extends StatefulWidget {
  const _BackToEnrol();

  @override
  State<_BackToEnrol> createState() => _BackToEnrolState();
}

class _BackToEnrolState extends State<_BackToEnrol> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.go(AppRoutes.enrol);
    });
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

class _SetupRoute extends ConsumerWidget {
  const _SetupRoute({required this.text});

  final String? text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = text;
    if (t == null) return const _BackToEnrol();
    final deps = ref.watch(appDepsProvider);
    return SetupScreen(
      flow: ref.watch(setupFlowProvider),
      qrText: t,
      defaultPhoneName: platformLabel(S.of(context), deps.platform),
      toLocal: deps.toLocal,
      onAdopt: (box) => ref.read(enrolledBoxProvider.notifier).adopt(box),
      onDone: () => context.go(AppRoutes.unlock),
      onScanAnother: () => context.go(AppRoutes.enrol),
    );
  }
}

class _RecoveryRoute extends ConsumerWidget {
  const _RecoveryRoute({required this.text});

  final String? text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = text;
    if (t == null) return const _BackToEnrol();
    final deps = ref.watch(appDepsProvider);
    return RecoveryScreen(
      flow: ref.watch(setupFlowProvider),
      qrText: t,
      defaultPhoneName: platformLabel(S.of(context), deps.platform),
      toLocal: deps.toLocal,
      onAdopt: (box) => ref.read(enrolledBoxProvider.notifier).adopt(box),
      onDone: () => context.go(AppRoutes.unlock),
      onScanAnother: () => context.go(AppRoutes.enrol),
    );
  }
}

class _UnlockRoute extends ConsumerWidget {
  const _UnlockRoute();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final deps = ref.watch(appDepsProvider);
    final box = ref.watch(enrolledBoxProvider);
    if (box == null) return const SizedBox.shrink();

    Future<void> enrolAgain() async {
      ref.read(revokedProvider.notifier).clear();
      ref.read(sessionProvider.notifier).clear();
      await deps.biometric.clear();
      await ref.read(enrolledBoxProvider.notifier).forget();
      if (context.mounted) context.go(AppRoutes.enrol);
    }

    return ref
        .watch(enrolledClientProvider)
        .when(
          // The box record changing under the screen (its cloud learnt from
          // a health answer) keeps the screen and the unlock under way.
          skipLoadingOnReload: true,
          loading: () => const _GlassWait(),
          error: (e, _) => _ReEnrolNeeded(
            message: e is TrustError ? e.message : e.toString(),
            onEnrolAgain: enrolAgain,
          ),
          data: (client) {
            if (client == null) return const SizedBox.shrink();
            Future<void> onAppLock(bool on) =>
                ref.read(enrolledBoxProvider.notifier).setAppLock(on);
            // The accepted PIN stays in memory for this run (silent
            // reconnects) and feeds the offline verifier.
            void onPinAccepted(String? pin) =>
                ref.read(pinMemoryProvider).value = pin;
            final cloud = cloudOriginOf(box);
            final locator = ref.read(baseLocatorProvider);
            // The unlock locates first (MAXCOM at the surau within 2 s,
            // else the cloud: the enrolled one, the one the box reported,
            // or the default) through `unlockAtLocated`.
            final UnlockFlow flow = locator == null
                ? UnlockFlow(
                    client: client,
                    key: deps.key,
                    box: box,
                    biometric: deps.biometric,
                    onAppLock: onAppLock,
                    onPinAccepted: onPinAccepted,
                  )
                : LocatedUnlockFlow(
                    client: client,
                    key: deps.key,
                    box: box,
                    biometric: deps.biometric,
                    onAppLock: onAppLock,
                    onPinAccepted: onPinAccepted,
                    locator: locator,
                    clientFor: (base) => deps.enrolledClient(boxAt(box, base)),
                    tokens: ref.read(sessionTokensProvider),
                    onWaking: () =>
                        ref.read(cloudWakeProvider)?.wakeSoon(cloud),
                  );
            Future<OfflineVault?> vault() async {
              try {
                return await ref.read(offlineVaultProvider.future);
              } on Object {
                return null;
              }
            }

            Future<OfflineProfile?> profile() async {
              try {
                return await (await vault())?.profile();
              } on Object {
                return null;
              }
            }

            final keeper = ref.read(sessionKeeperProvider);
            final offline = deps.localStoreBuilder == null
                ? null
                : OfflineDoor(
                    profile: profile,
                    checkPin: (pin) async =>
                        await (await vault())?.checkPin(pin) ??
                        const PinUnknown(),
                    enter: (p, {pin, inFlight}) {
                      if (pin != null) ref.read(pinMemoryProvider).value = pin;
                      ref
                          .read(sessionProvider.notifier)
                          .set(SessionDto.offline(p.user));
                      if (inFlight != null) keeper.adopt(inFlight);
                      if (context.mounted) context.go(AppRoutes.dashboard);
                    },
                  );
            return UnlockScreen(
              flow: flow,
              box: box,
              offline: offline,
              surauInfo: SurauInfoLoader(
                client: client,
                store: _ProfileNameStore(deps.surauInfoStore, profile),
                // The box away: the cloud answers the same public route.
                fallback: () => deps.enrolledClient(boxAt(box, cloud)),
              ),
              openUrl: deps.openUrl,
              now: deps.now,
              toLocal: deps.toLocal,
              onUnlocked: (session) {
                ref.read(sessionProvider.notifier).set(session);
                context.go(AppRoutes.dashboard);
              },
              onEnrolAgain: enrolAgain,
            );
          },
        );
  }
}

/// The kept surau details, else the surau name from the offline profile.
class _ProfileNameStore implements SurauInfoStore {
  _ProfileNameStore(this.inner, this.profile);

  final SurauInfoStore inner;
  final Future<OfflineProfile?> Function() profile;

  @override
  Future<SurauInfo?> load() async {
    final kept = await inner.load();
    if (kept != null) return kept;
    final name = (await profile())?.surauName;
    return name == null || name.isEmpty ? null : SurauInfo(name: name);
  }

  @override
  Future<void> save(SurauInfo info) => inner.save(info);
}

class _GlassWait extends StatelessWidget {
  const _GlassWait();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: SurauColors.glass,
      body: Center(
        child: SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(
            color: SurauColors.gold,
            strokeWidth: 3,
          ),
        ),
      ),
    );
  }
}

/// The pinned certificate from enrolment is gone (storage cleared, app
/// moved): the only way on is a new enrolment.
class _ReEnrolNeeded extends ConsumerWidget {
  const _ReEnrolNeeded({required this.message, required this.onEnrolAgain});

  final String message;
  final Future<void> Function() onEnrolAgain;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final info = ref.watch(surauInfoProvider);
    final box = ref.watch(enrolledBoxProvider);
    final deps = ref.watch(appDepsProvider);
    return Scaffold(
      backgroundColor: SurauColors.glass,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SurauIdentity(
                    surauName: info?.name ?? s.productName,
                    logo: const SurauLogo(
                      height: 72,
                      maxWidth: 300,
                      radius: 16,
                    ),
                    showName: info?.showName ?? true,
                    greeting: s.greeting(box?.userName ?? ''),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: text.bodyLarge!.copyWith(color: Colors.white),
                  ),
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: onEnrolAgain,
                    icon: const Icon(Icons.qr_code_scanner_rounded),
                    label: Text(s.actionEnrolAgain),
                  ),
                  const SizedBox(height: 24),
                  HelpCard(
                    contact: info?.help,
                    onGlass: true,
                    openUrl: deps.openUrl,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
