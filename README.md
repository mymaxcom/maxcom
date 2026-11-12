# MAXCOM

**MAXCOM** is free software for surau, masjid and musalla. A small box at the surau serves a prayer-times
display (the kiosk) and a phone/tablet admin app. It works offline first, needs no licence keys, and every
feature can be switched on or off.

*MAXCOM ialah perisian percuma untuk surau, masjid dan musalla: paparan waktu solat, kuliah, pengumuman dan
kandungan Islam, dengan aplikasi pentadbir untuk telefon dan iPad. Berfungsi tanpa internet.*

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
