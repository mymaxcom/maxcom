# Third-party notices

MAXCOM is for non-commercial use by a surau. If it is ever offered to other surau, each licence below must be checked again.

## Quran translation: QuranEnc

- Source: QuranEnc (https://quranenc.com), translation key `malay_basumayyah`: Malay translation by Abdullah Muhammad Basmeih.
- Terms followed: the text is shown verbatim (no edits, no cuts; only line ends are normalised when stored), QuranEnc is credited on the ayat card and the translation version is stored with the text and shown.
- The text is fetched once with `node apps/box-server/src/cli/fetchIslamic.ts --quran` (or from the admin page) and cached on the box at `data/islamic/quran/malay_basumayyah.json`. The kiosk never contacts QuranEnc.
- Version: recorded in the cache file (`version`) at fetch time. QuranEnc's translation list did not carry an entry for `malay_basumayyah` on 2026-11-03, so the version then reads `unlisted`; the fetch date (`fetchedAt`) is always stored.

## Arabic Quran font: KFGQPC Uthmanic Hafs (QPC Hafs)

- Source: King Fahd Glorious Quran Printing Complex (KFGQPC), downloaded 2026-11-03 from the Complex's own font site: https://fonts.qurancomplex.gov.sa/hafs-reading -> https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip (the same family is also redistributed by QUL by Tarteel as "QPC Hafs font", v2.2).
- Terms followed: free non-commercial use; the font file is used unmodified and its licence text (the EULA embedded in the font, name ID 13) is copied beside it (`apps/kiosk-display/src/assets/fonts/qpc-hafs/LICENCE.txt`). Written permission from KFGQPC is needed for any commercial use. The kiosk loads it from the box only, never from the internet.
- File: `apps/kiosk-display/src/assets/fonts/qpc-hafs/KFGQPC-Hafs-V30.ttf` ("KFGQPC HAFS Uthmanic Script Regular", version 3.0; original name `KFGQPC Hafs V30.ttf`), 301356 bytes, sha256 `c9dd7e71a454565b13d89e5e6f2663a918acb0a20a23eea31eccb32a3aeec47a`. Fallback font: Amiri Quran (below).

## Recitation audio: EveryAyah

- Source: EveryAyah (https://everyayah.com). The site has no site-wide licence; the recitation rights stay with the reciters.
- Credit shown on the kiosk and in the admin page: the reciter name (for example "Husary") and "EveryAyah" with the link https://everyayah.com.
- Only the surah(s) the surau chooses are cached on the box (`data/islamic/audio/<reciter>/<surah>/`), capped by the `tilawah.cacheMaxMb` setting. The kiosk never contacts EveryAyah.

## Fonts from Plan 1

- Plus Jakarta Sans: SIL Open Font License 1.1.
- Amiri Quran: SIL Open Font License 1.1.
- Amiri (@fontsource/amiri 5.3.0, Latin 400 and 700 only): SIL Open Font License 1.1. Headings of the kiosk's Old School template.

## Box server image libraries (Plan 4)

- jpeg-js 0.4.4 (https://github.com/jpeg-js/jpeg-js): BSD 3-Clause License. Used to decode and re-encode uploaded JPEG images (logo, posters) on the box.
- pngjs 7.0.0 (https://github.com/pngjs/pngjs): MIT License. Used to decode and re-encode uploaded PNG images on the box.

## Kiosk QR drawing (Plan 14)

- qrcode-generator 1.4.4 (https://github.com/kazuhikoarase/qrcode-generator): MIT License, Kazuhiko Arase. Used in the kiosk page only, to draw the setup, recovery and network-check QR codes on the box screen. It has no dependencies and runs offline from the kiosk bundle.

## Prayer time calculation (Plan 13)

- adhan 4.4.6 (https://github.com/batoulapps/adhan-js): MIT License. Calculates prayer times from the surau coordinates on the box (`apps/box-server/src/prayer/calc.ts`); fully offline, never loaded by the kiosk.
- IANA time zone database (https://www.iana.org/time-zones): public domain. The country to time zone table (`packages/core/src/prayer/countries.ts`) is generated from its `zone.tab` and `iso3166.tab`.
- e-Solat JAKIM zone list: the zone codes and district names (`packages/core/src/prayer/jakimZones.ts`) are copied from the public zone page https://www.e-solat.gov.my/index.php?siteId=24&pageId=24 on 2026-11-09.

## Windows setup zip: tools redistributed with the box (Plan 9)

The Windows setup zip `MAX-Kiosk-Server-Setup-<version>-windows.zip` carries three third-party programs, each pinned by version, URL and sha256 in `scripts/release-pins.json` and checked at build time. Their licence texts ship in the zip.

- Node.js (version in `release-pins.json`, today 24.22.1; https://nodejs.org): MIT License, plus the licences of the components bundled in Node, which are in the `LICENSE` file shipped beside `node.exe`. Only `node.exe` and `LICENSE` are taken from the official Windows zip. Installed at `runtime\node\`.
- MediaMTX (today v1.21.3; https://github.com/bluenviron/mediamtx): MIT License. Used for the live broadcast relay. Installed at `tools\live\mediamtx\`.
- ffmpeg (today FFmpeg n9.0.2-39-g7adfbe40dc, the BtbN FFmpeg-Builds "win64-gpl" build of 2026-10-31, release tag autobuild-2026-10-31-12-59; https://github.com/BtbN/FFmpeg-Builds): this build is licensed GPL-3.0-or-later because it includes libx264, which the live re-encode relay uses. Distributing it in the setup zip is distribution of a GPL binary. The zip therefore carries the GPL text, and the exact source of the pinned build is available from the pinned release page https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59 (build recipes) and from the FFmpeg source repository https://git.ffmpeg.org/ffmpeg.git (commit g7adfbe40dc on the n9.0 branch, see https://ffmpeg.org/download.html) (libx264 source: https://code.videolan.org/videolan/x264). MAXCOM code does not link ffmpeg; the box starts it as a separate program. Installed at `tools\live\ffmpeg\`. Open for the operator (plan, section "Open for the operator" item 2): this ships under option A; the exact source location of the pinned build is confirmed when the pin hash is committed.
