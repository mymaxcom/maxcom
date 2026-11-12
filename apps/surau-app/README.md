# surau-app

Install record for the laptop toolchain (Plan 4 Task 0, 2026-11-03).

| Item | Value |
|---|---|
| Flutter | 3.47.9 stable, revision c197ca5199e9ee5661e865596c9c07294dfab51c |
| Flutter archive | stable/windows/flutter_windows_3.47.9-stable.zip |
| Flutter sha256 | d8e2b5977e09082c6440f89dc1aa887b94c8fbcc3b39222797046295a3f68a9e (matches releases_windows.json) |
| Dart | 3.13.7 |
| DevTools | 2.60.0 |
| Android cmdline-tools | commandlinetools-win-15859902_latest.zip |
| cmdline-tools sha256 | 90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a (matches developer.android.com/studio) |
| Android packages | platform-tools 37.0.1, platforms;android-35, build-tools;35.0.0, plus platforms;android-36 and build-tools;28.0.3 (flutter doctor requires them) |

Install paths: `C:\dev\flutter`, `C:\dev\android-sdk`. User environment: `ANDROID_HOME=C:\dev\android-sdk`; PATH gained `C:\dev\flutter\bin` and `C:\dev\android-sdk\platform-tools`.
Flutter config: web enabled, Windows desktop disabled, analytics off. Do not run `flutter upgrade`; the version is pinned in `.flutter-version`.

Check: `powershell -File scripts/check-flutter.ps1` from the repo root (exit 0 when the installed Flutter matches the pin).
