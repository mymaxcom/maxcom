# MAXCOM

**MAXCOM** is free software for surau, masjid and musalla. A small box at the surau serves a prayer-times
display (the kiosk) and a phone/tablet admin app. It works offline first, needs no licence keys, and every
feature can be switched on or off.

*MAXCOM ialah perisian percuma untuk surau, masjid dan musalla: paparan waktu solat, kuliah, pengumuman dan
kandungan Islam, dengan aplikasi pentadbir untuk telefon dan iPad. Berfungsi tanpa internet.*

## MAXCOM R2 (2026.11.13)

MAXCOM R2 is the current release, now at version 2026.11.13: a free, open source system for surau and masjid, used
under its licence (CC BY-NC-SA 4.0, see "Licence" below). Downloads: [mymaxcom.my](https://mymaxcom.my) or the
[Releases](https://github.com/mymaxcom/maxcom/releases) of this repository.

### Kemas kini 2026.11.13 / Update 2026.11.13

**Build 3 (20 November 2026).** Fixes found on a surau's own devices: YouTube videos play on Android TV boxes; a
video that cannot play no longer holds a slide; a new Video volume setting; on TV boxes that block background apps the
box still starts by itself after a power cut; the TV preview in the app works after the box changes its network
address; no browser translate prompt on the Windows TV screen. If you installed 2026.11.13 before the evening of 20
November, install it again: it updates in place and keeps all data.

*Binaan 3 (20 November 2026): pembetulan yang ditemui pada peranti surau sendiri: video YouTube dimainkan pada kotak
TV Android; video yang tidak dapat dimainkan tidak lagi menahan slaid; tetapan baharu Kelantangan video; pada kotak TV
yang menyekat aplikasi latar belakang, kotak tetap hidup sendiri selepas bekalan elektrik terputus; pratonton TV dalam
aplikasi berfungsi selepas alamat rangkaian kotak berubah; tiada lagi gesaan terjemahan pelayar pada skrin TV Windows.
Jika anda memasang 2026.11.13 sebelum petang 20 November, pasang semula: ia dikemas kini di tempat yang sama dan semua
data kekal.*

- **Videos on the TV screen.** A new Video content kind (upload from the phone, a YouTube link, or a clip of a surau
  recording), played full screen on the TV, YouTube videos included, on the Android and the Windows box.
- **YouTube: sign in once.** The sign-in is kept on the MAXCOM at the surau. "Cannot be checked right now" is shown
  instead of signing out, the sign-in is checked daily, and a clear card appears only when Google really ends it.
  Sign-in and sign-out on the surau Wi-Fi only.
- **Broadcast destinations always in view.** Surau screen, YouTube and Recording above the Start button, with a clear
  Yes or No. One surau-wide YouTube choice shared by every live admin; the app asks before a start to the surau screen
  only.
- **Share the live link.** A banner for every live admin, whichever device started the live; one main button
  (Share to WhatsApp, Share, or Send from a phone with a QR code); a picture from the live with the message; the text
  edited once and shared by all; Send to myself.
- **New microphones picked up automatically** (USB or Lightning on iPad, USB-C on Android); unplugging falls back to
  the device microphone.
- **Camera (CCTV) changes made away from the surau reach the box.**
- **The TV screen in Arabic.** A third TV screen language, Arabic, right to left, on all six themes; any theme with
  any language (choosing Arabic Art offers to switch the TV to Arabic once).
- **Security and reliability improvements.**

Upgrading from 2026.11.12: update the MAX Kiosk Server first (every box of a surau together), then the MAX Admin
Client. No new YouTube sign-in is needed. On an iPad, reload the web app after the box is updated.

### What MAXCOM R2 brought (2026.11.12)

- **Major security audit.** A thorough security and reliability audit, with many improvements that protect
  surau data, user accounts and live broadcasts.
- **MAX Admin Client in three languages.** Bahasa Melayu, English and Arabic (right to left), chosen per phone.
  The TV screen language follows the surau location (BM in Malaysia, English elsewhere) and can be changed in
  Konfigurasi.
- **Many video and audio sources for live broadcasts.** An external IP camera (picture with its own sound),
  extra sound sources mixed in with their own volume (phone or iPad microphone, Mic-in on the Windows box),
  automatic alignment, a clap test for cameras without sound, and camera search on the network.
- **UI/UX and themes.** A new dashboard with cloud and box status icons, Tetapan renamed Konfigurasi with
  search and folding groups, full-screen posters, full-screen Tugasan, Waktu Dunia, Takwim, Pengumuman and
  Hadis with larger text, six built-in themes including Arabic Art. Users and devices get a unique ID, rename,
  delete and restore, and a three-step add-user flow with WhatsApp sharing. A live notice can be shared on
  WhatsApp with the YouTube link.
- **Kewangan module revamp.** A new Tabung screen on the TV (any number of funds, pages, an "All funds"
  summary, a "New" highlight, an option to feature the first fund) and more reliable records (cash payments
  always save, closed months are protected, late entries are flagged, months and amounts in every language).

## Products

| Product | Folder | What it is |
|---|---|---|
| **MAX Kiosk Server** (Windows and Android) | `apps/box-server`, `apps/kiosk-display`, `apps/box-android` | The box: a Node.js server (TypeScript, runs from source on Node 24) with the kiosk display page (Preact, built with Vite). On Android the same server is packaged as an app. |
| **MAX Admin Client** (Android, web/iPad) | `apps/surau-app` | The admin app (Flutter): prayer data, content, users, devices, live broadcast, finance. |
| Shared code | `packages/core`, `packages/device-client` | Content schema, prayer-time logic, and the client a display uses to pair with the box. |

Versions of each product are in `versions.json`; helper scripts are in `scripts/`.

## Requirements

- Node 24 or newer, and `npm ci` at the repository root (npm workspaces).
- Flutter 3.47.9 for the admin app (pinned in `apps/surau-app/.flutter-version`).
- Windows PowerShell 5.1 for the Windows setup, certificate and build scripts in `scripts/`.
- JDK and the Android SDK only for the Android box (`apps/box-android`).

## Build and run

### MAX Kiosk Server (Windows or any machine with Node)

```
npm ci
npm run build -w apps/kiosk-display      # builds the kiosk page the box serves at /
powershell -File scripts\box-ca.ps1      # makes the surau root certificate and the box certificate
node apps/box-server/src/cli/bootstrap.ts # creates the first admin (prints a one-time enrolment text)
node apps/box-server/src/main.ts         # starts the box (data in ./data)
```

The box answers on `http://127.0.0.1:8787/` (its own kiosk) and, once a certificate exists, on
`https://<box-ip>:8443/` for the local network. Settings come from environment variables such as
`SURAU_DB`, `SURAU_DATA_DIR`, `SURAU_PORT` and `SURAU_HTTPS_PORT`; see the comments at the top of
`apps/box-server/src/main.ts`.

Windows installer and release archive: `scripts/build-release.ps1` and `scripts/setup/build-setup.ps1`.
Android box: `scripts/android/build-box-apk.ps1` (uses `apps/box-android`; you need your own signing key,
see `apps/box-android/key.properties.example`).

### MAX Admin Client

```
cd apps/surau-app
flutter pub get
flutter run -d chrome                    # try it in a browser
```

Release builds are made by `scripts/build-app.ps1`: `-Web` builds the web/iPad version that the box serves
at `/app/`; `-Apk` builds the Android APK (copy `apps/surau-app/android/key.properties.example` to
`key.properties` and use your own upload key).

### Tests

```
npm run test:fixtures                    # Windows: makes the TLS test certificates (not stored in the repo)
npm test                                 # box server, core, device client, kiosk display
cd apps/box-server && npx tsc --noEmit -p .
cd apps/surau-app && flutter analyze && flutter test
```

## Licence

MAXCOM is licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International**
(CC BY-NC-SA 4.0). In short: use it, change it and share it freely for non-commercial purposes; keep the
MAXCOM name and logo and the credit; share changes under the same licence. Read [NOTICE.md](NOTICE.md) first
(it explains what that means for MAXCOM, in English and Bahasa Malaysia), then the full text in
[LICENSE](LICENSE). Third-party components keep their own licences, see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Contributing and security

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md) (please do not open a public issue for it).

Website: https://mymaxcom.my
