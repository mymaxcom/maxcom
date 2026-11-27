// Every path in the app, the two doors (enrol, unlock) outside the shell
// and everything else inside it, with the guard deciding before each
// navigation where the person may be (lib/app/guards.dart). The jemaah
// entry is a [ComingScreen] with its real title (a later plan); the finance
// pages live in lib/features/finance/, every other page in lib/screens/.

import 'dart:async' show unawaited;

import 'package:flutter/foundation.dart' show debugPrint, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderListenable;
import 'package:go_router/go_router.dart';

import '../box/join_address.dart';
import '../features/common/language_switch.dart';
import '../features/common/help_card.dart';
import '../features/common/identity.dart';
import '../features/common/surau_info.dart';
import '../features/common/surau_logo.dart';
import '../features/common/trilingual_strings.dart';
import '../features/common/trilingual_text.dart';
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
import '../features/registry.g.dart' show hiddenFeatures;
import '../features/setup/recovery_screen.dart';
import '../features/setup/setup_providers.dart';
import '../features/setup/setup_screen.dart';
import '../features/link/link_screen.dart';
import '../features/link/move_flow.dart';
import '../features/link/move_screen.dart';
import '../features/live/live_screen.dart';
import '../features/screens/screens_list.dart';
import '../features/screens/tv_editor.dart';
import '../features/unlink/unlink_screen.dart';
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
import '../ops/fleet/fleet_providers.dart';
import '../ops/fleet/fleet_router.dart';
import '../ops/ops_build.dart';
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
import '../screens/user_add_flow.dart';
import '../screens/user_edit_screen.dart';
import '../screens/users_screen.dart';
import '../screens/widgets/pieces.dart' show platformLabel;
import '../box/box_client.dart' show SessionDto;
import '../box/cloud_origin.dart';
import '../sync/sync_providers.dart';
import '../sync/transport.dart';
import 'guards.dart';
import 'providers.dart';
import '../screens/theme/theme_editor_screen.dart';
import '../screens/theme/theme_gallery_screen.dart';
import '../screens/theme/theme_upload_screen.dart';
import 'shell.dart';
import 'theme.dart';

/// Every path in the app. Keep in step with the plan's screen list.
abstract final class AppRoutes {
  static const String enrol = '/enrol';
  static const String setup = '/setup';
  static const String recovery = '/recovery';
  static const String scan = '/scan';
  static const String unlock = '/unlock';
  static const String move = '/move';
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
  static const String screens = '/screens';
  static const String screensLink = '/screens/link';
  static const String screensUnlink = '/screens/unlink';
  static const String screensTv = '/screens/tv/:id';
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
  static const String liveSettings = '/live/settings';
  static const String upload = '/upload';
  static const String jemaah = '/jemaah';
  static const String thisDevice = '/this-device';
  static const String syncConflicts = '/sync/conflicts';
  static const String syncSettings = '/settings/sync';
  static const String settingsOrder = '/settings/order';
  static const String settingsLocation = '/settings/location';
  static const String settingsZone = '/settings/zone';
  static const String settingsPrayerSources = '/settings/prayer-sources';
  static const String settingsThemes = '/settings/templat';
  static const String settingsThemeUpload = '/settings/templat/muat-naik';

  static const String hadisCari = '/content/hadis/cari';

  static String settingsFor(String feature) => '/settings/$feature';

  /// The choices of one TV (`self` for the main box's own TV, else the device id).
  static String screensTvFor(String id) => '/screens/tv/${Uri.encodeComponent(id)}';

  /// A live feature's form: under Siaran langsung, so Back and the bottom bar stay with it.
  static String liveSettingsFor(String feature) => '/live/settings/$feature';
  static String themeEditorFor(String theme) => '/settings/templat/$theme';
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
  'kioskTemplate': AppRoutes.settingsThemes,
};

/// The four features of the Siaran langsung page (registry group `live`): their forms live under `/live/settings/`,
/// never in Konfigurasi.
const List<String> liveSettingsFeatureKeys = ['liveCamera', 'liveOnKiosk', 'liveYoutube', 'recording'];

/// Where an old `/settings/<live feature>` link (a bookmark, a notification) goes now, query kept; null for any other
/// location.
String? liveSettingsMoved(Uri uri) {
  final seg = uri.pathSegments;
  if (seg.length != 2 || seg[0] != 'settings' || !liveSettingsFeatureKeys.contains(seg[1])) return null;
  return Uri(path: AppRoutes.liveSettingsFor(seg[1]), query: uri.hasQuery ? uri.query : null).toString();
}

/// Where `/settings/<feature>` goes instead of its generic page: a feature the Tetapan lists hide (planned, or edited
/// elsewhere) is not reachable by typing its address either, so it returns to the list; a feature with a page of its own
/// goes there; null opens the generic page.
String? settingsFeatureRedirect(String? feature) {
  if (feature != null && liveSettingsFeatureKeys.contains(feature)) return AppRoutes.liveSettingsFor(feature);
  if (feature != null && hiddenFeatures.contains(feature)) return AppRoutes.settings;
  return customFeatureRoutes[feature];
}

/// The router, rebuilt never: the guard reads the session, the enrolled
/// box and the feature switches at each navigation, and is re-run when
/// any of them changes.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _Refresh();
  ref.onDispose(refresh.dispose);
  ref.listen(sessionProvider, (_, _) => refresh.ping());
  ref.listen(enrolledBoxProvider, (_, _) => refresh.ping());
  ref.listen(featureFlagsProvider, (_, _) => refresh.ping());
  ref.listen(joiningInsteadProvider, (_, _) => refresh.ping());
  if (kOpsBuild) {
    // A Pentadbir MAXCOM with no surau chosen lands on the list; choosing one lets the surau screens open.
    ref.listen(needsSurauProvider, (_, _) => refresh.ping());
    ref.listen(opsRevokedProvider, (_, _) => refresh.ping());
    ref.listen(opsLocalDataClosedProvider, (_, _) => refresh.ping());
    // Alive from the start, so it clears the cached answers whenever the session ends.
    ref.read(actingSurauProvider);
  }
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
      // Old `/settings/<live feature>` links go to the Siaran langsung page's own route, before any permission check.
      final moved = liveSettingsMoved(state.uri);
      if (moved != null) return moved;
      final result = guard(
        GuardInput(
          location: state.uri.toString(),
          enrolled: ref.read(enrolledBoxProvider) != null,
          unlocked: ref.read(sessionProvider) != null,
          roles: ref.read(rolesProvider),
          features: ref.read(featureFlagsProvider),
          joining: ref.read(joiningInsteadProvider),
          needsSurau: kOpsBuild && ref.read(needsSurauProvider),
          opsRevoked: kOpsBuild && ref.read(opsRevokedProvider),
          localDataClosed: kOpsBuild && ref.read(opsLocalDataClosedProvider),
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
          // A code handed over by the app itself, else a join ticket that came in the address of the web app (the
          // follower's enrol page opened from an unlink); the address is cleaned once the page has taken it.
          initialCode: state.extra is String
              ? state.extra as String
              : (state.uri.queryParameters[joinQueryKey] ?? heldJoinText),
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
      GoRoute(
        path: AppRoutes.move,
        builder: (context, state) => const _MoveRoute(),
      ),
      // The notice of a phone whose ops mark was withdrawn: outside the shell, ops build only.
      if (kOpsBuild) ...opsUnmarkedRoutes((context) => context.go(AppRoutes.thisDevice)),
      ShellRoute(
        builder: (context, state, child) =>
            AppShell(location: state.uri.path, child: child),
        routes: [
          // The MAXCOM Ops screens exist only in the ops build.
          if (kOpsBuild) ...opsFleetRoutes(),
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
                path: 'templat',
                builder: (context, state) => const ThemeGalleryScreen(),
                routes: [
                  GoRoute(
                    path: 'muat-naik',
                    builder: (context, state) => const ThemeUploadScreen(),
                  ),
                  GoRoute(
                    path: ':theme',
                    builder: (context, state) => ThemeEditorScreen(theme: state.pathParameters['theme']!),
                  ),
                ],
              ),
              GoRoute(
                path: ':feature',
                redirect: (context, state) => settingsFeatureRedirect(state.pathParameters['feature']),
                builder: (context, state) => SettingsFeatureScreen(
                  featureKey: state.pathParameters['feature']!,
                  scrollToLanjutan: kOpsBuild && state.uri.queryParameters['lj'] == '1',
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
                builder: (context, state) => const UserAddFlow(),
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
            path: AppRoutes.screens,
            builder: (context, state) => const ScreensListScreen(),
            routes: [
              GoRoute(
                path: 'link',
                builder: (context, state) => const LinkFlowScreen(),
              ),
              GoRoute(
                path: 'unlink',
                builder: (context, state) => UnlinkFlowScreen(
                  deviceId: state.uri.queryParameters['device'],
                  name: state.uri.queryParameters['name'],
                ),
              ),
              GoRoute(
                path: 'tv/:id',
                builder: (context, state) =>
                    TvEditorScreen(tvId: state.pathParameters['id']!),
              ),
            ],
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
            builder: (context, state) => LiveScreen(openSettings: state.uri.queryParameters['tetapan'] == '1'),
          ),
          // The live features' forms: the same screen as Konfigurasi's, with Back to Siaran langsung. A route of its
          // own (not a child of `/live`), so the live page is not built beneath the form.
          GoRoute(
            path: '${AppRoutes.liveSettings}/:feature',
            redirect: (context, state) =>
                liveSettingsFeatureKeys.contains(state.pathParameters['feature']) ? null : AppRoutes.live,
            builder: (context, state) => SettingsFeatureScreen(
              featureKey: state.pathParameters['feature']!,
              backTo: AppRoutes.live,
            ),
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

/// The new enrolment of a phone that left a follower is saved: the old one goes. Fails safe: the joining flag is always
/// cleared, a failing biometric clear does not stop the rest, and when the old copy cannot be wiped the new box is
/// still taken (the store already holds it), so the app never runs on the new record with the old box in memory.
Future<void> finishJoining(T Function<T>(ProviderListenable<T> provider) read, EnrolOutcome outcome) async {
  final deps = read(appDepsProvider);
  try {
    read(moveDeferredProvider.notifier).set(false);
    read(revokedProvider.notifier).clear();
    read(sessionProvider.notifier).clear();
    try {
      await deps.biometric.clear();
    } on Object catch (e) {
      debugPrint('finishJoining: biometric clear failed (${e.runtimeType})');
    }
    try {
      await read(enrolledBoxProvider.notifier).replaceWith(outcome.box);
    } on Object catch (e) {
      debugPrint('finishJoining: wipe of the old copy failed (${e.runtimeType})');
      read(enrolledBoxProvider.notifier).adopt(outcome.box);
    }
  } finally {
    read(joiningInsteadProvider.notifier).set(false);
  }
}

class _EnrolRoute extends ConsumerStatefulWidget {
  const _EnrolRoute({this.initialCode});

  /// A scanned `surau1:` text handed over by the scan router.
  final String? initialCode;

  @override
  ConsumerState<_EnrolRoute> createState() => _EnrolRouteState();
}

class _EnrolRouteState extends ConsumerState<_EnrolRoute> {
  @override
  void initState() {
    super.initState();
    // The join ticket was read once into the page; it does not stay in the address bar or the history.
    if (widget.initialCode != null) WidgetsBinding.instance.addPostFrameCallback((_) => scrubJoinAddress());
    _joining = ref.read(joiningInsteadProvider.notifier);
  }

  late final JoiningInsteadNotifier _joining;

  @override
  void dispose() {
    // Leaving the enrol page by any route (back, another link) ends "join instead": the flag must not outlive it.
    final joining = _joining;
    Future.microtask(() {
      try {
        joining.set(false);
      } on Object {
        // the provider is gone with the app
      }
    });
    super.dispose();
  }

  /// The new enrolment of a phone that left a follower succeeded: only now does the old one go.
  Future<void> _finishJoining(EnrolOutcome outcome) async {
    await finishJoining(ref.read, outcome);
    if (mounted) context.go(AppRoutes.unlock);
  }

  @override
  Widget build(BuildContext context) {
    final deps = ref.watch(appDepsProvider);
    final joining = ref.watch(joiningInsteadProvider);
    final initialCode = widget.initialCode;
    return EnrolScreen(
      flow: EnrolFlow(
        clientFor: deps.clientFor,
        key: deps.key,
        trust: deps.trust,
        store: deps.boxStore,
        surauInfoStore: deps.surauInfoStore,
        platform: deps.platform,
        pageOrigin: kIsWeb ? Uri.base : null,
        replacing: joining,
        now: deps.now,
      ),
      cameraAvailable: deps.cameraAvailable,
      scannerBuilder: deps.scannerBuilder ?? defaultScanner,
      initialCode: initialCode,
      pairingUi: true,
      actions: joining
          ? [
              IconButton(
                key: const ValueKey('enrol-joining-back'),
                tooltip: S.of(context).actionBack,
                icon: const Icon(Icons.arrow_back_rounded),
                onPressed: () {
                  ref.read(joiningInsteadProvider.notifier).set(false);
                  context.go(AppRoutes.move);
                },
              ),
              ..._languageActions,
            ]
          : _languageActions,
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
        clearHeldJoin();
        if (joining) {
          unawaited(_finishJoining(outcome));
          return;
        }
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

/// The language switch at the end of a first-time screen's top bar.
const List<Widget> _languageActions = [
  Padding(padding: EdgeInsetsDirectional.only(end: 12), child: Center(child: LanguageSwitch())),
];

class _SetupRoute extends ConsumerWidget {
  const _SetupRoute({required this.text});

  final String? text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = text;
    if (t == null) return const _BackToEnrol();
    final deps = ref.watch(appDepsProvider);
    return SetupScreen(
      actions: _languageActions,
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
      actions: _languageActions,
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
    // The page the person was on when the session ended (A9).
    final backTo =
        returnPathOf(GoRouterState.of(context).uri.toString()) ??
        AppRoutes.dashboard;

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
            message: e is TrustError ? e.text(S.of(context)) : e.toString(),
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
                    close: () async => (await vault())?.closeOffline(),
                    enter: (p, {pin, inFlight}) {
                      if (pin != null) ref.read(pinMemoryProvider).value = pin;
                      ref
                          .read(sessionProvider.notifier)
                          .set(SessionDto.offline(p.user));
                      if (inFlight != null) keeper.adopt(inFlight);
                      if (context.mounted) context.go(backTo);
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
                context.go(backTo);
              },
              onEnrolAgain: enrolAgain,
              // A restore revokes every phone; the box then has no Pentadbir and says so on its public identity
              // route. The way back in is the recovery QR of the TV and the recovery code, at the enrol page.
              recoveryProbe: () async {
                final info = await SetupClient(client).boxInfo();
                return info.state == 'recovery' && info.reason == 'no_admin';
              },
              onRecover: enrolAgain,
              moveDeferred: ref.watch(moveDeferredProvider),
              onMove: () {
                ref.read(moveDeferredProvider.notifier).set(false);
                context.go(AppRoutes.move);
              },
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

  @override
  Future<void> clear() => inner.clear();
}

class _GlassWait extends StatelessWidget {
  const _GlassWait();

  @override
  Widget build(BuildContext context) {
    // Nobody can act on this screen and the person's language may not be
    // known yet: BM, with small English and Arabic lines under it.
    return const Scaffold(
      backgroundColor: SurauColors.glass,
      body: Center(
        child: TrilingualWait(
          ms: TrilingualStrings.connectingMs,
          en: TrilingualStrings.connectingEn,
          ar: TrilingualStrings.connectingAr,
        ),
      ),
    );  }
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

/// The box this phone is enrolled at became a follower: the phone moves to the main box (door, like the unlock).
class _MoveRoute extends ConsumerWidget {
  const _MoveRoute();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final deps = ref.watch(appDepsProvider);
    final box = ref.watch(enrolledBoxProvider);
    if (box == null) return const SizedBox.shrink();
    // Nothing is forgotten here: a wrong or expired code must not leave the phone enrolled nowhere. The enrol page
    // opens beside the old enrolment (the guard lets it through) and the old one is dropped once the new succeeded.
    Future<void> leaveAndEnrol(String? code) async {
      ref.read(joiningInsteadProvider.notifier).set(true);
      if (context.mounted) context.go(AppRoutes.enrol, extra: code);
    }

    return ref
        .watch(enrolledClientProvider)
        .when(
          skipLoadingOnReload: true,
          loading: () => const _GlassWait(),
          error: (e, _) => const _BackToEnrol(),
          data: (client) {
            if (client == null) return const SizedBox.shrink();
            return MoveScreen(
              flow: MoveFlow(
                box: box,
                oldClient: client,
                key: deps.key,
                trust: deps.trust,
                clientFor: deps.clientFor,
                store: deps.boxStore,
                platform: deps.platform,
              ),
              deviceName: platformLabel(S.of(context), deps.platform),
              onAdopt: (b) {
                ref.read(moveDeferredProvider.notifier).set(false);
                ref.read(enrolledBoxProvider.notifier).adopt(b);
                context.go(AppRoutes.unlock);
              },
              // Not a dead end: the unlock opens with "Sambung ke Box utama", which comes back here.
              onLater: () {
                ref.read(moveDeferredProvider.notifier).set(true);
                context.go(AppRoutes.unlock);
              },
              // Joining the main box is an ordinary enrolment to that box: the old follower enrolment is forgotten (as
              // "Daftar semula" does) and the enrol page takes the scan or the pasted code.
              onJoinScan: () => leaveAndEnrol(null),
              onJoinCode: leaveAndEnrol,
            );
          },
        );
  }
}
