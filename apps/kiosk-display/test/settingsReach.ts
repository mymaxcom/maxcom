// Where every Tetapan parameter is used (brief 2026-11-16, guard 1). Every leaf of every feature's `defaults` in
// packages/core/src/features/registry.ts, plus `enabled`, has one entry here, and the test (settingsReach.test.tsx)
// fails for a parameter with no entry, for an entry whose parameter is gone, and for an entry whose consumer file no
// longer names it. A parameter that changes what the TV shows is also render-tested there (default value vs a changed
// one, through the real App, never a card component on its own).
//
// An entry is either the files that consume the parameter (paths from the repo root; each must exist and name the
// parameter: the leaf as a word, or `needle` when the code builds the name) or `none` with the reason nothing reads it
// (hidden from Tetapan, planned, locked on, or a known gap with its ticket). Adding a parameter without deciding which
// it is fails the test.

export type Reach =
  | { by: readonly string[]; needle?: RegExp }
  | { none: 'hidden' | 'planned' | 'locked' | 'gap'; why: string };

const K = 'apps/kiosk-display/src/';
const B = 'apps/box-server/src/';
const C = 'packages/core/src/';
const A = 'apps/surau-app/lib/';
const by = (...files: string[]): Reach => ({ by: files });
const locked = (why = 'the feature is locked on: there is no switch'): Reach => ({ none: 'locked', why });
const STATE = `${C}kiosk/state.ts`;
const ROT = `${C}content/rotation.ts`;

export const REACH: Record<string, Record<string, Reach>> = {
  prayerBar: { enabled: locked(), showImsak: by(`${K}ui/visibleNext.ts`), showSyuruk: by(`${K}ui/visibleNext.ts`), timeFormat: by(`${K}ui/PrayerBar.tsx`, `${K}screens/Main.tsx`, `${K}screens/ContentShell.tsx`) },
  clock: { enabled: locked(), showSeconds: by(`${K}screens/Main.tsx`, `${K}screens/ContentShell.tsx`, `${K}screens/LiveScreen.tsx`) },
  prayerSequenceSafety: { enabled: locked('the azan, iqamah and solat order is always enforced by the state machine') },
  zone: { enabled: locked(), zone: by(`${B}prayerAutoFetch.ts`), autoFetch: by(`${B}prayerAutoFetch.ts`) },
  location: {
    enabled: locked(), country: by(`${B}prayer/calc.ts`), timezone: by(`${C}time.ts`), latitude: by(`${B}prayer/calc.ts`),
    longitude: by(`${B}prayer/calc.ts`), city: by(`${B}prayer/resolve.ts`),
  },
  prayerCalc: {
    enabled: locked('local calculation is always the fallback in prayer/resolve.ts pick(): the feature is locked on, no switch'),
    method: by(`${B}prayer/calc.ts`), madhab: by(`${B}prayer/calc.ts`),
    highLatitude: by(`${B}prayer/calc.ts`), adjustMinutes: by(`${B}prayer/calc.ts`), imsakMinutes: by(`${B}prayer/calc.ts`),
  },
  prayerSources: { enabled: locked(), sourceOrder: by(`${B}prayer/resolve.ts`), crossCheck: by(`${B}prayer/routes.ts`) },
  azanCountdown: {
    enabled: by(STATE), minutesBefore: by(STATE), beep: by(STATE),
    fullScreen: by(`${K}screens/Phase.tsx`),
  },
  masukWaktu: { enabled: by(STATE), screenSeconds: by(STATE), beep: by(STATE) },
  iqamahCountdown: { enabled: by(STATE), minutes: by(STATE), endWarningSeconds: by(STATE, `${K}screens/Phase.tsx`), beep: by(STATE) },
  solatScreen: { enabled: by(STATE), minutes: by(STATE), message: by(`${K}screens/Phase.tsx`) },
  jumaat: { enabled: by(STATE), khutbahMinutes: by(STATE), iqamahMinutes: by(STATE), solatMinutes: by(STATE) },
  tarawih: { enabled: by(STATE), hijriMonth: by(STATE), gapMinutes: by(STATE), minutes: by(STATE) },
  syurukWarning: { enabled: by(STATE), minutesBefore: by(STATE), beep: by(STATE) },
  imsakBeep: { enabled: by(STATE) },
  isyraq: { enabled: by(STATE), minutesAfterSyuruk: by(STATE), durationMinutes: by(STATE) },
  dataSources: {
    enabled: locked(), esolat: by(`${B}net/safeFetch.ts`), esolatZones: by(`${B}net/safeFetch.ts`), nominatim: by(`${B}net/safeFetch.ts`),
    quranText: by(`${B}net/safeFetch.ts`), quranAudio: by(`${B}net/safeFetch.ts`), hadeethenc: by(`${B}net/safeFetch.ts`),
  },
  firstAzanSubuh: { enabled: by(STATE), minutesBefore: by(STATE), audioFile: by(STATE) },
  surauInfo: {
    enabled: locked(), name: by(`${K}i18n.ts`), shortName: by(`${B}surauLogo.ts`), kind: by(`${B}surauIni.ts`),
    shortAddress: by(`${B}settingsStore.ts`), helpName: by(`${B}settingsStore.ts`), helpPhone: by(`${B}settingsStore.ts`), helpEmail: by(`${B}settingsStore.ts`),
    logo: by(`${K}ui/Logo.tsx`), showName: by(`${K}ui/Logo.tsx`),
  },
  hijriDate: { enabled: by(`${K}data/kiosk.ts`), adjustDays: by(`${K}data/kiosk.ts`), switchAt: by(`${K}data/kiosk.ts`) },
  backgrounds: { enabled: by(`${K}ui/Background.tsx`), images: by(`${K}ui/Background.tsx`), rotate: by(`${K}ui/Background.tsx`) },
  autoTone: {
    enabled: by(`${K}ui/Background.tsx`),
    override: { none: 'hidden', why: 'the accent has one control, Ubah suai Warna aksen (FieldMeta hidden); a stored value is ignored' },
  },
  language: { enabled: by(`${C}features/tvLanguage.ts`), lang: by(`${C}features/tvLanguage.ts`) },
  orientation: {
    enabled: { none: 'hidden', why: 'the feature is hidden from Tetapan as planned (HIDDEN_FEATURES); nothing on the TV reads it yet' },
    mode: { none: 'hidden', why: 'the feature is hidden from Tetapan as planned (HIDDEN_FEATURES); nothing on the TV reads it yet' },
  },
  kioskTemplate: { enabled: by(`${K}themes/index.ts`), templateId: by(`${K}themes/index.ts`) },
  themeStyle: {
    enabled: { none: 'hidden', why: 'the feature has no generic page (HIDDEN_FEATURES); Ubah suai edits styles' },
    styles: by(`${K}app.tsx`, `${K}themes/styleVars.ts`), packs: by(`${K}themes/index.ts`),
  },
  tvProfiles: {
    enabled: { none: 'hidden', why: 'always on and hidden from Tetapan (HIDDEN_FEATURES, FieldMeta hidden): the per-TV editor of the admin app is its only control' },
    tvs: { none: 'hidden', why: 'read by the box server, not by the TV page: the box lays the profile of each TV over the surau values before it serves the bundle (kioskSettingsForTv)' },
  },
  kuliahCard: { enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), daysAhead: by(ROT) },
  penceramahPhoto: { enabled: by(`${K}screens/content/KuliahScreen.tsx`), shape: by(`${K}screens/content/KuliahScreen.tsx`) },
  kitabCover: { enabled: by(`${K}screens/content/KuliahScreen.tsx`) },
  pengumuman: {
    enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), maxItems: by(ROT),
    daysAhead: { none: 'hidden', why: 'planned (Dirancang), hidden from Tetapan (FieldMeta hidden): a notice shows by its own from and to dates, nothing reads the window' },
  },
  ticker: { enabled: by(`${K}screens/Main.tsx`), speed: by(`${K}content/Ticker.tsx`) },
  posters: { enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT) },
  videos: { enabled: by(ROT), order: by(ROT), volume: by(`${K}screens/content/VideoScreen.tsx`) },
  programKhas: {
    enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), hideAfterMinutes: by(ROT),
    daysAhead: { none: 'hidden', why: 'planned (Dirancang), hidden from Tetapan (FieldMeta hidden): a programme shows by its own show-from and show-to dates, nothing reads the window' },
  },
  takwim: { enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), count: by(`${K}content/cards/TakwimCard.tsx`) },
  hadis: {
    enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT),
    source: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.source\b/ }, mix: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.mix\b/ },
    changeEvery: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.changeEvery\b/ }, perDay: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.perDay\b/ },
    showArabic: by(`${K}content/cards/HadisCard.tsx`), showMalay: by(`${K}content/cards/HadisCard.tsx`, `${K}screens/content/ArabHadisScreen.tsx`),
    showAttribution: by(`${K}content/cards/HadisCard.tsx`), showGrade: by(`${K}content/cards/HadisCard.tsx`),
    fontSize: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.fontSize\b/ }, allowedGrades: { by: [`${C}content/hadisDisplay.ts`], needle: /settings\.allowedGrades\b/ },
  },
  worldTimes: { enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT) },
  tugasan: { enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), daysAhead: by(ROT) },
  ayatCard: {
    enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), pick: by(`${B}kioskContent.ts`), surah: by(`${B}kioskContent.ts`),
    ayatFrom: by(`${B}kioskContent.ts`), ayatTo: by(`${B}kioskContent.ts`),
    showTranslation: by(`${K}content/cards/AyatCard.tsx`, `${K}screens/content/ArabAyatScreen.tsx`),
    textSize: by(`${K}content/cards/AyatCard.tsx`, `${K}screens/content/ArabAyatScreen.tsx`),
  },
  zikirSelepasSolat: {
    enabled: by(ROT), durationSeconds: by(`${K}content/ZikirOverlay.tsx`), minutesAfterSolat: by(`${K}content/ZikirOverlay.tsx`),
    startAfterMinutes: by(ROT), showClock: by(`${K}content/ZikirOverlay.tsx`), showTimeLeft: by(`${K}content/ZikirOverlay.tsx`),
    look: by(`${K}content/ZikirOverlay.tsx`, `${K}screens/Main.tsx`),
  },
  quranReader: { enabled: { none: 'hidden', why: 'the feature is hidden from Tetapan as planned (HIDDEN_FEATURES); nothing on the TV reads it yet' } },
  tilawah: { enabled: by(ROT), reciter: by(`${K}audio/tilawah.ts`), volume: by(`${K}audio/tilawah.ts`), cacheMaxMb: by(`${B}islamic/fetch.ts`) },
  beeps: { enabled: by(`${K}ui/Beep.ts`), volume: by(`${K}ui/Beep.ts`) },
  liveOnKiosk: {
    enabled: by(`${K}data/live.ts`), audio: by(`${K}live/LiveLayer.tsx`), volume: by(`${K}live/LiveLayer.tsx`),
    showStrip: by(`${K}screens/LiveScreen.tsx`), fit: by(`${K}live/LiveLayer.tsx`),
  },
  liveYoutube: {
    enabled: by(`${B}live/sessions.ts`), privacy: by(`${B}live/sessions.ts`),
    relayFrom: { none: 'hidden', why: 'planned (Dirancang), hidden from Tetapan (FieldMeta hidden): only the box relays today; direct phone to YouTube is on the roadmap (Dirancang)' },
    relayVideo: by(`${B}live/sessions.ts`), titleTemplate: { by: [`${C}live/youtubeMeta.ts`], needle: /settings\.titleTemplate/ },
    descriptionTemplate: { by: [`${C}live/youtubeMeta.ts`], needle: /settings\.descriptionTemplate/ },
    maxBitrateKbps: { none: 'hidden', why: 'hidden from Tetapan (FieldMeta hidden): the relay limit is fixed at 3500 kbps in live/sessions.ts and a stored value is ignored' },
    autoQuality: { none: 'hidden', why: 'hidden from Tetapan (FieldMeta hidden): no user control; live/sessions.ts reads it only to switch the relay quality ladder off when it is explicitly false' },
    nextLiveOn: { none: 'hidden', why: 'hidden from Tetapan (FieldMeta hidden): the surau-wide YouTube choice for the next live, set from the Live screen of the app (box route PUT /api/live/youtube/next-live); the TV never reads it' },
  },
  recording: {
    enabled: by(`${A}features/live/live_screen.dart`), segmentMinutes: by(`${A}features/live/live_controller.dart`),
    keepOnDevice: by(`${A}upload/recording_cleanup.dart`),
  },
  // The external camera: the box reads the transport and the audio offsets when it starts a session, the app reads the
  // switch and the name on the live screen and the camera card (guard 2026-11-18, K16).
  liveCamera: {
    enabled: by(`${A}features/live/live_source.dart`),
    name: by(`${A}features/live/live_source.dart`),
    transport: by(`${B}live/cameraRoutes.ts`, `${A}features/live/live_source.dart`),
    brightness: by(`${A}features/live/live_controller.dart`, `${B}live/sessions.ts`),
    avOffsetMs: { none: 'hidden', why: 'hidden from Tetapan (FieldMeta hidden): the live session reads it (live/sessions.ts) and the app no longer shows it' },
  },

  finance: {
    enabled: by(`${B}finance/routes.ts`), penceramahFundId: by(`${B}finance/store.ts`),
    bigAmountSen: by(`${A}features/finance/finance_widgets.dart`), startedOn: by(`${B}finance/store.ts`),
  },
  tabungCard: {
    enabled: by(ROT), durationSeconds: by(ROT), order: by(ROT), figure: by(`${B}finance/tabung.ts`), highlightSeconds: by(`${B}finance/tabung.ts`),
    showTarget: by(`${B}finance/tabung.ts`), qrAssetId: by(`${B}finance/tabung.ts`), featured: by(`${C}content/tabungPages.ts`),
    manualTitle: by(`${B}finance/tabung.ts`),
    row1Label: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Label/ }, row1Sen: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Sen/ },
    row2Label: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Label/ }, row2Sen: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Sen/ },
    row3Label: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Label/ }, row3Sen: { by: [`${B}finance/tabung.ts`], needle: /row\$\{n\}Sen/ },
  },
  calendarFeed: { enabled: { none: 'hidden', why: 'the feature is hidden from Tetapan as planned (HIDDEN_FEATURES); nothing on the TV reads it yet' } },
  jemaahPage: { enabled: { none: 'hidden', why: 'the feature is hidden from Tetapan as planned (HIDDEN_FEATURES); only a placeholder page behind it today' } },
  cloudSync: { enabled: by(`${B}sync/agent.ts`), dirtyCheckSeconds: by(`${B}sync/agent.ts`), cloudUrl: by(`${B}sync/agent.ts`) },
  youtubeCatchUp: {
    enabled: by(`${A}upload/upload_providers.dart`), wifiOnly: by(`${A}upload/upload_providers.dart`),
    joinSegments: by(`${A}upload/upload_providers.dart`), replaceGappyLive: by(`${A}upload/upload_providers.dart`),
  },
  recordingCleanup: {
    enabled: { by: [`${A}upload/recording_cleanup.dart`], needle: /featureOnIn\(clean, ['"]recordingCleanup['"]\)/ },
    keepDays: { by: [`${A}upload/recording_cleanup.dart`], needle: /featureValue\(['"]recordingCleanup['"], clean, ['"]keepDays['"]\)/ },
  },
  appLock: { enabled: by(`${B}auth/appLock.ts`) },
  system: {
    enabled: locked(), noVideoSeconds: by(`${B}app.ts`), cloudWakeSeconds: { none: 'gap', why: 'the cloud wait it set was read by the YouTube cloud leg, removed in the YouTube phase 4 clean-up; no code reads it now, so it stays in the registry (older boxes and apps still carry it) until it is retired' },
    syncHistoryDays: by(`${B}sync/trim.ts`),
    suspendedAt: { none: 'hidden', why: 'set by the fleet tools, never typed in Tetapan; already skipped by the app settings form and search' },
  },
};
