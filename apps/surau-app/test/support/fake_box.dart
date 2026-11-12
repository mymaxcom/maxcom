// The realistic surau box every golden is rendered against (Plan 4 Task
// 12): one entry point over the shared fakes.
//
// `ShellHarness` (test/features/shell/harness.dart) is the `FakeBox` with
// Surau D'Waqaf seeded the way `scripts/seed-content.mjs` and the
// mdb-export fixture read: real-sounding people (Ustaz Ali, Aminah binti
// Yusof, Encik Hafiz), kuliah with penceramah and kitab, pengumuman,
// posters, petugas and tilawah slots; `installT9Routes` adds the kiosk
// bundle, Islamic status and prayer data answers. Screens are pumped
// through the production providers (`appDepsProvider`, the router, the
// gateway and caches), never through a widget-only stub.
//
// Every golden test imports from here or from the two files below; a new
// screen test should do the same so its data stays the surau's.

export '../features/fakes.dart'
    show
        FakeBox,
        FakeDeviceKey,
        FakeOpener,
        FakeTrust,
        fixedNow,
        fixedToLocal,
        fixtureBox,
        fixtureInfoJson,
        fixturePayload,
        happyBox,
        jsonResponse;
export '../features/shell/harness.dart';
export '../screens/t9_fakes.dart' show installT9Routes, pumpT9, t9Bundle, t9IslamicStatus;
