# Golden screenshots

Every screen of the surau app, rendered in Bahasa Malaysia over the
realistic box of `test/support/fake_box.dart` (Surau D'Waqaf: Ustaz
Ali the admin, Aminah binti Yusof the treasurer, kuliah, pengumuman,
posters, petugas) through the production providers. Each name below exists
at the three sizes of `test/golden_sizes.dart` unless marked phone only:

| Size | Logical px | PNG px (2x) |
|---|---|---|
| `phone` | 412 x 915 (Pixel 7 class Android phone) | 824 x 1830 |
| `ipadMiniPortrait` | 744 x 1133 (iPad mini 6 in Safari) | 1488 x 2266 |
| `ipadMiniLandscape` | 1133 x 744 | 2266 x 1488 |

Regenerate with `flutter test --update-goldens` from `apps/surau-app`, then
open the PNGs and look at them (BM wording, nothing clipped at phone
width, the iPad landscape width used, 48 dp tap targets). PNGs are
platform-rendered and are only generated and checked on the operator's
laptop. `test/screens/all_goldens_test.dart` fails when any PNG of the
required list (`test/support/golden_index.dart`) is missing or absent
from this file.

## The 22 screens of the plan (Task 12)

| Golden | Screen and state | Rendered by |
|---|---|---|
| `enrol_scan` | Enrol, step 1 with the camera | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_manual` | Enrol, paste the code | `test/features/enrol/enrol_screen_test.dart` |
| `unlock` | Unlock with the PIN pad | `test/features/unlock/unlock_screen_test.dart` |
| `dashboard` | Home for an AJK member: board and preview tile | `test/features/shell/dashboard_test.dart` |
| `dashboard_offline` | Home with the box away: banner, last data | `test/features/shell/dashboard_test.dart` |
| `forbidden` | Sent home with `Tiada kebenaran untuk tindakan ini` | `test/features/shell/dashboard_test.dart` |
| `settings_list` | Feature list by group with switches | `test/screens/settings_test.dart` |
| `settings_iqamah` | One feature's form (week table) | `test/screens/settings_test.dart` |
| `settings_backgrounds` | Background images picker | `test/screens/settings_test.dart` |
| `content_list_kuliah` | Kuliah list | `test/screens/content_test.dart` |
| `content_edit_kuliah` | Kuliah editor | `test/screens/content_test.dart` |
| `content_edit_poster` | Poster editor (new poster: title prefilled `Poster 3`, image picker, days, dates, order, `Pratonton di TV`) | `test/screens/content_test.dart` |
| `content_edit_tilawah` | Tilawah slot editor | `test/screens/content_test.dart` |
| `preview` | Kiosk preview page | `test/screens/preview_test.dart` |
| `islamic` | Islamic content caches | `test/screens/islamic_test.dart` |
| `prayer_data` | Prayer data import | `test/screens/prayer_data_test.dart` |
| `users` | People, Pengguna tab | `test/screens/users_test.dart` |
| `enrol_qr` | A new user's enrolment QR (fingerprint behind Butiran teknikal) | `test/screens/users_test.dart` |
| `devices` | People, Peranti tab | `test/screens/devices_test.dart` |
| `pairing` | People, Skrin TV tab (pending TV) | `test/screens/devices_test.dart` |
| `audit` | Log perubahan with one entry open | `test/screens/audit_test.dart` |
| `this_device` | Peranti ini | `test/screens/this_device_test.dart` |

## Further states

| Golden | Screen and state | Rendered by |
|---|---|---|
| `dashboard_tech_check` | Admin home with the failure-only technical check line | `test/features/shell/dashboard_test.dart` |
| `dashboard_three_roles` | Home for Pentadbir, Bendahari dan Media | `test/features/shell/dashboard_test.dart` |
| `menu` | The `Lagi` sheet (phone) or account sheet (iPad) | `test/features/shell/dashboard_test.dart` |
| `settings_live_youtube` | Siaran langsung YouTube for a Pentadbir MAXCOM: choice cards, templates, Lanjutan card | `test/features/settings_widgets_test.dart` |
| `settings_tilawah` | Tilawah: reciter picker, volume slider, Lanjutan storage chips | `test/features/settings_widgets_test.dart` |
| `settings_first_azan` | Azan pertama Subuh: minute chips and the audio list | `test/features/settings_widgets_test.dart` |
| `settings_auto_tone` | Warna teks: swatches and the TV preview | `test/features/settings_widgets_test.dart` |
| `settings_solat_screen` | Skrin sedang solat: preset messages with a counter | `test/features/settings_widgets_test.dart` |
| `settings_tarawih` | Solat tarawih: Hijri month, gap chips, length slider | `test/features/settings_widgets_test.dart` |
| `settings_ayat_card` | Kad ayat: surah picker and the verse range | `test/features/settings_widgets_test.dart` |
| `settings_system` | Sistem (Lanjutan): the three system values | `test/features/settings_widgets_test.dart` |
| `settings_order` | Susunan kad di skrin TV: nine cards, drag handle, up and down | `test/screens/settings_order_test.dart` |
| `settings_search` | Tetapan search for azan: matching groups open, reasons shown | `test/screens/settings_order_test.dart` |
| `settings_search_empty` | Tetapan search with no result | `test/screens/settings_order_test.dart` |
| `settings_list_superadmin` | Tetapan bottom for a Pentadbir MAXCOM: the Lanjutan group open | `test/screens/settings_order_test.dart` |
| `settings_applock_superadmin` | Kunci aplikasi with the always-on row for this device | `test/screens/settings_order_test.dart` |
| `enrol_ttl` | Daftar peranti form with Kod sah selama | `test/screens/settings_order_test.dart` |
| `settings_data_sources` | Sumber data internet: one card per source (name, https address) | `test/screens/settings_test.dart` |
| `settings_surau_info_logo` | Maklumat surau with the logo picture field holding a logo, `Laraskan gambar`, the `Paparkan nama surau juga` switch and the header as the TV draws it | `test/screens/settings_test.dart` |
| `preview_ssl` | Preview frame when the box certificate did not match the pinned one: one calm line, Cuba lagi, figures behind Butiran teknikal | `test/screens/preview_test.dart` |
| `dashboard_logo` | Home with the surau logo beside the name (header on a phone, rail on the iPad) | `test/features/shell/dashboard_test.dart` |
| `unlock_logo` | Unlock with the surau logo above the name | `test/features/unlock/unlock_screen_test.dart` |
| `content_list_poster` | Poster list: thumbnail, title, days and dates per row | `test/screens/content_test.dart` |
| `image_adjust_logo` | Adjust screen for the surau logo, step 1 (the wordmark on white: free frame on the trim box, `Buang latar putih` preselected from the box's analysis, before/after on the kiosk's dark colour) | `test/content/image_adjust_test.dart` |
| `image_adjust_square` | Adjust screen for the logo, step 2 (square icon crop with the app icon and browser icon as they will be) | `test/content/image_adjust_test.dart` |
| `image_adjust_penceramah_circle` | Adjust screen for a speaker photo: circle frame | `test/content/image_adjust_test.dart` |
| `image_adjust_poster` | Adjust screen for a poster: 16:9 frame, the whole picture inside it | `test/content/image_adjust_test.dart` |
| `dashboard_wide_logo` | Home with the wide wordmark and `Paparkan nama surau juga` off: the logo by height in its own shape, no text name (header on a phone, rail on the iPad) | `test/features/shell/dashboard_test.dart` |
| `unlock_wide_logo` | Unlock with the wide wordmark and the text name off | `test/features/unlock/unlock_screen_test.dart` |
| `enrol_review_wide_logo` | Enrol review with the invitation box's wide wordmark and the text name off | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_pin_set` | Enrol review when the box says the PIN exists | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_pin_new` | Enrol review when a PIN must be created | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_review` | Enrol review (older box, both PIN choices) | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_expired` | Expired invitation with the help card | `test/features/enrol/enrol_screen_test.dart` |
| `enrol_done` | Enrolled | `test/features/enrol/enrol_screen_test.dart` |
| `unlock_auto` | Unlock when the box has its app lock off: surau, greeting, spinner and `Membuka kunci`, no pad | `test/features/unlock/unlock_screen_test.dart` |
| `enrol_review_nolock` | Enrol review when the box has its app lock off: no PIN choice, one line saying so | `test/features/enrol/enrol_screen_test.dart` |
| `this_device_nolock` | This device with the app lock off: no Tukar PIN or fingerprint row, `Kunci aplikasi dimatikan` | `test/screens/this_device_test.dart` |
| `settings_applock` | Settings page Kunci aplikasi: the switch and its help text | `test/screens/settings_test.dart` |
| `unlock_new_pin`, `unlock_locked`, `unlock_revoked`, `unlock_unreachable`, `unlock_forgot_pin`, `unlock_three_roles` | Unlock states | `test/features/unlock/unlock_screen_test.dart` |
| `user_edit` | User editor with the role multi-select | `test/screens/users_test.dart` |
| `help_card`, `help_card_glass` | Help card on paper and on glass (phone only) | `test/features/common/help_card_test.dart` |
| `live_idle` | Live tab ready: today's kuliah pre-selected, the camera in its frame, Skrin surau, YouTube and Rakaman rows, `Mula siaran` | `test/screens/live_test.dart` |
| `live_running` | Live tab on air: red tally frame and timer, duration, bitrate and fps, both legs `Bersiaran`, recording parts and size, `Berhenti` | `test/screens/live_test.dart` |
| `live_warning` | On air with the YouTube leg `Cuba lagi dalam 5 s` and the battery, heat and keep-the-screen-on warnings | `test/screens/live_test.dart` |
| `live_stopped` | The `Siaran tamat` summary: duration, the short YouTube line, where the recording is, `Lihat di YouTube` | `test/screens/live_test.dart` |
| `live_youtube_signin` | An admin connecting the surau's YouTube account: the device code, `Buka google.com/device`, waiting | `test/screens/live_test.dart` |
| `live_recordings_pending` | `Rakaman belum disimpan` notice for web recording parts left from the last broadcast | `test/screens/live_test.dart` |
| `theme_sample` | Theme sample page | `test/app/theme_test.dart` |
| `arabic_fonts` | Bismillah in the Quran style and a surah name in the UI fallback (phone only) | `test/app/arabic_fonts_test.dart` |

## Plan 6 Task 9: sync (rendered by `test/screens/sync_test.dart`)

| Golden | Screen and state |
|---|---|
| `sync_chip_synced` | Settings list with the chip `Diselaraskan` (synced through MAXCOM) |
| `sync_chip_pending` | The chip with 3 edits waiting (`3 menunggu` on a phone, `3 perubahan menunggu` on an iPad) |
| `sync_chip_offline` | The chip offline, red outline (`Luar talian`, the whole sentence on an iPad) |
| `sync_chip_waking` | The chip while the cloud starts (`Menyambung ke awan...`) |
| `sync_chip_cloud` | Synced through the cloud, with a red count of 2 conflicts |
| `sync_sheet` | The chip's sheet: connection, last sync, waiting, `Selaraskan sekarang`, `Lihat konflik` |
| `conflicts` | Konflik: a superseded announcement with the winner, two refusals in BM |
| `conflicts_empty` | Konflik with none: `Tiada konflik` |
| `live_only_dialog` | `Perlukan sambungan` naming `Daftar peranti baharu`, offline |
| `sync_settings_linked` | Penyelarasan awan, linked, with the last send and receive |
| `sync_settings_unlinked` | Penyelarasan awan, not linked, with the last error |
| `unlock_revoked_sync` | Unlock after the server revoked this device: `Peranti ini telah dibatalkan`, `Daftar semula` |
| `devices_cloud` | Devices through the cloud: `Daftar peranti baharu` and the enrol-from-home note |

## Plan 14 Task 7: hadis (rendered by `test/screens/hadis_test.dart`)

| Golden | Screen and state |
|---|---|
| `hadis_list` | Senarai hadis: 9 saved, source badges, grades, switches and bins, 66518 flagged `Teks dikemas kini` |
| `hadis_search_categories` | Cari hadis at the category roots |
| `hadis_search_results` | Cari hadis results for `amalan`; on iPad landscape the detail opens beside the list |
| `hadis_search_offline` | `Carian perlukan internet` with `Urus hadis tersimpan` and `Cuba lagi` |
| `hadis_detail` | Butiran hadis of the long 66513: the TV preview in parts and the `Panjang untuk TV` note |
| `hadis_settings` | Tetapan > Hadis: source, order, turnover, fields, grades, sticky `Simpan` |
| `hadis_remove_own` | `Buang hadis ini?` for an own hadis: red, `Buang kekal` (phone only) |
| `hadis_remove_provider` | `Buang hadis ini?` for a HadeethEnc hadis: teal, can be added again (phone only) |
| `hadis_update_dialog` | `Teks dikemas kini di HadeethEnc` with the new text (phone only) |
## Plan 13: prayer sources and data

| Golden | Screen and state | Rendered by |
|---|---|---|
| `prayer_data_sources` | Data waktu solat with the source of each day coloured and the source line | `test/screens/prayer_data_test.dart` |
| `prayer_import` | Import a prayer file: the file, the preview and the choice | `test/screens/prayer_import_test.dart` |
| `prayer_import_preview` | The import preview after a clean dry run | `test/screens/prayer_import_test.dart` |
| `prayer_location` | Lokasi surau in Malaysia: country, zone and coordinates | `test/screens/prayer_location_test.dart` |
| `prayer_location_ke` | Lokasi surau outside Malaysia (Kenya), not yet located | `test/screens/prayer_location_test.dart` |
| `prayer_records` | Rekod import: file, range, choice, person and state | `test/screens/prayer_records_test.dart` |
| `prayer_sources` | Sumber waktu solat: order of official, local calculation and file | `test/screens/prayer_sources_test.dart` |
| `prayer_zone` | Zon JAKIM: the list by district and what is stored | `test/screens/prayer_zone_test.dart` |
