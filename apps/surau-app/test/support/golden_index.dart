// The index of golden screenshots the app must have (Plan 4 Task 12):
// every screen at the three sizes of golden_sizes.dart, plus the few
// single-state extras. `test/screens/all_goldens_test.dart` fails when any
// PNG is missing, and `test/goldens/README.md` must name each one.

import '../golden_sizes.dart';

/// The 22 screens of the plan, each captured at every [GoldenSize].
const List<String> requiredScreens = [
  'enrol_scan',
  'enrol_manual',
  'unlock',
  'dashboard',
  'dashboard_offline',
  'forbidden',
  'settings_list',
  'settings_iqamah',
  'settings_backgrounds',
  'content_list_kuliah',
  'content_edit_kuliah',
  'content_edit_poster',
  'content_edit_tilawah',
  'preview',
  'islamic',
  'prayer_data',
  'users',
  'enrol_qr',
  'devices',
  'pairing',
  'audit',
  'this_device',
];

/// Further states the controller asked for, at every size.
const List<String> requiredExtraScreens = [
  'dashboard_tech_check',
  // Plan 12 A6: the Tetapan list and its neighbours.
  'settings_order',
  'settings_search',
  'settings_search_empty',
  'settings_list_superadmin',
  'settings_applock_superadmin',
  'enrol_ttl',
  // Plan 12 A5: settings pages drawn from the registry metadata.
  'settings_live_youtube',
  'settings_tilawah',
  'settings_first_azan',
  'settings_auto_tone',
  'settings_solat_screen',
  'settings_tarawih',
  'settings_ayat_card',
  'settings_system',
  'enrol_pin_set',
  'enrol_pin_new',
  'settings_data_sources',
  // Plan 4 add-on B: the surau logo and the poster titles.
  'dashboard_logo',
  'unlock_logo',
  'settings_surau_info_logo',
  'content_list_poster',
  // Android preview: the box certificate did not match the pinned one.
  'preview_ssl',
  // Plan 4 add-on C: the adjust screen for every picture, the wide
  // wordmark with the text name off in every header.
  'image_adjust_logo',
  'image_adjust_square',
  'image_adjust_penceramah_circle',
  'image_adjust_poster',
  'dashboard_wide_logo',
  'unlock_wide_logo',
  'enrol_review_wide_logo',
  // Plan 5 Task 0B: the optional app lock, app side.
  'unlock_auto',
  'enrol_review_nolock',
  'this_device_nolock',
  'settings_applock',
  // Plan 5 Task 7: the Live tab.
  'live_idle',
  'live_running',
  'live_warning',
  'live_stopped',
  'live_youtube_signin',
  'live_recordings_pending',
  // Plan 6 Task 9: sync status, conflicts, live-only, cloud sync settings.
  'sync_chip_synced',
  'sync_chip_pending',
  'sync_chip_offline',
  'sync_chip_waking',
  'sync_chip_cloud',
  'sync_sheet',
  'conflicts',
  'conflicts_empty',
  'live_only_dialog',
  'sync_settings_linked',
  'sync_settings_unlinked',
  'unlock_revoked_sync',
  'devices_cloud',
  // Plan 14 Task 7: the hadis screens.
  'hadis_list',
  'hadis_search_categories',
  'hadis_search_results',
  'hadis_search_offline',
  'hadis_detail',
  'hadis_settings',
  // Plan 13: prayer sources, location, zone, import and records.
  'prayer_data_sources',
  'prayer_import',
  'prayer_import_preview',
  'prayer_location',
  'prayer_location_ke',
  'prayer_records',
  'prayer_sources',
  'prayer_zone',
];

/// Goldens captured at the phone size only.
const List<String> requiredPhoneOnly = [
  'arabic_fonts',
  'hadis_remove_own',
  'hadis_remove_provider',
  'hadis_update_dialog',
];

/// Every PNG name (without `.png`) the suite must produce.
List<String> requiredGoldenFiles() => [
  for (final name in [...requiredScreens, ...requiredExtraScreens])
    for (final size in GoldenSize.values) '${name}_${size.name}',
  for (final name in requiredPhoneOnly) '${name}_${GoldenSize.phone.name}',
];
