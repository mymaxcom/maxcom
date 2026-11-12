# Arabic fonts bundled in the surau app

Why they are here: the web build is served by the box under a CSP of
`font-src 'self'`, so Flutter can never download a fallback font. Every
Arabic glyph the app shows (Quran ayat, hadis and zikir text, surah names,
a future Arabic UI language) must come from these files. The families are
registered in `pubspec.yaml`; `lib/app/theme.dart` puts `NotoNaskhArabic`
in the text theme's `fontFamilyFallback` and exposes `quranTextStyle`
(`QpcHafs`, then `AmiriQuran`).

All three were obtained on 2026-11-04. Each file is bundled byte for byte
unmodified; the licence text travels with it in the same folder.

## QPC Hafs (Quran text, Uthmani script)

| | |
|---|---|
| Folder | `qpc-hafs/` |
| File | `KFGQPC-Hafs-V30.ttf` (301356 bytes) |
| SHA256 | `c9dd7e71a454565b13d89e5e6f2663a918acb0a20a23eea31eccb32a3aeec47a` |
| Family (pubspec) | `QpcHafs` (name table: "KFGQPC Hafs V3", "KFGQPC HAFS Uthmanic Script Regular", Version 3.0) |
| Source | Copied unchanged from `apps/kiosk-display/src/assets/fonts/qpc-hafs/` (same hash), which came from the official KFGQPC distribution: https://fonts.qurancomplex.gov.sa/hafs-reading (download https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip, zip SHA256 `ddf52d0f6919b0a9cfb1e9cc048d41d88e695f973455fea3c9973837295a324c`) |
| Version | 3.0 |
| Licence | King Fahd Glorious Quran Printing Complex EULA, copied verbatim in `qpc-hafs/LICENCE.txt`: free non-commercial use, no modification or conversion, written approval of KFGQPC needed for commercial use. Credit: King Fahd Glorious Quran Printing Complex (KFGQPC), AlMadinah AlMunawarrah. |

## Amiri Quran (OFL, fallback for Quran text)

| | |
|---|---|
| Folder | `amiri-quran/` |
| File | `AmiriQuran.ttf` (136920 bytes) |
| SHA256 | `e2a47644762d16bdfb6d33e0d8db8c6ff30beae84150ef5a705316bbd829455c` |
| Family (pubspec) | `AmiriQuran` (name table: "Amiri Quran", Version 1.003) |
| Source | Official release of the Amiri project by Khaled Hosny: https://github.com/aliftype/amiri/releases/tag/1.003, asset `Amiri-1.003.zip` (1033533 bytes, SHA256 `81af0aff7d2086d8af24cea7202f7546130997982534691373485cd96744d05e`); only `AmiriQuran.ttf` and `OFL.txt` were taken from the zip |
| Version | 1.003 |
| Licence | SIL Open Font License 1.1, `amiri-quran/OFL.txt` (SHA256 `72de68e5954f4fdd24702292ef5a32f003ca960ec9330dc86e5eefb5dffb9b22`). Copyright 2010-2024 The Amiri Project Authors |

## Noto Naskh Arabic (OFL, Arabic UI text)

| | |
|---|---|
| Folder | `noto-naskh-arabic/` |
| Files | `NotoNaskhArabic-Regular.ttf` (158580 bytes), `NotoNaskhArabic-Bold.ttf` (158172 bytes); static, unhinted TTF (the smallest static build; Flutter does not use TrueType hinting) |
| SHA256 | Regular `c34fdbd98af4dbc45ca192a23d2eeb77032add83086f5fe32957d23b3f36b221`, Bold `380ac34b249d336e1a43c21053df440594e1e3db8f75fabd4d85b649ca1ea4c6` |
| Family (pubspec) | `NotoNaskhArabic` (name table: "Noto Naskh Arabic", Version 2.021), weights 400 and 700 |
| Source | Official Noto release: https://github.com/notofonts/arabic/releases/tag/NotoNaskhArabic-v2.021, asset `NotoNaskhArabic-v2.021.zip` (2922060 bytes, SHA256 `6c050ab9bd087d69b733c505a7576e60c528c2f33cd7b91005a5bd7da4514032`); files taken from `NotoNaskhArabic/unhinted/ttf/` plus the zip's `OFL.txt` |
| Version | 2.021 (2026-01-16) |
| Licence | SIL Open Font License 1.1, `noto-naskh-arabic/OFL.txt` (SHA256 `a7a5a25eb188bf1cd96982030d53e23c33485c69b1044a562254226857ee13af`). Copyright 2022 The Noto Project Authors |

## Size

Fonts are copied as they are into the web bundle (`assets/fonts/...`) and
listed in `FontManifest.json`, so the app downloads them once per cache
fill: 754 KB more (QPC Hafs 301 KB, Amiri Quran 137 KB, Noto Naskh Arabic
317 KB) on top of the 645 KB of Plus Jakarta Sans. The box serves the
`/app/` files from its own disk on the surau Wi-Fi, so this is a one-off
on first open and after an app update.

## Coverage checked (fontTools, 2026-11-04)

- Plus Jakarta Sans: Latin, digits, `●` (PIN mask), `·`, `•`, `…`; no Arabic.
- QPC Hafs and Amiri Quran: the full bismillah with harakat and `ٱ` (U+0671), Arabic-Indic digits.
- Noto Naskh Arabic: the same Arabic set; no Latin letters, which is why it is a fallback and never the first family.
- Zero-width format characters (`U+2060` in one BM string, `U+200F`) need no glyph.
