// The version of this MAX Admin Client build (YYYY.MM.N): scripts/build-app.ps1 passes it with
// --dart-define=MAXCOM_VERSION=<version> (from versions.json, key admin-client-android). A build made without the
// define (flutter run, flutter test) shows the pubspec.yaml value below; test/app/app_version_test.dart keeps the two equal.

const String appVersion = String.fromEnvironment(
  'MAXCOM_VERSION',
  defaultValue: '2026.11.4',
);

/// `MAX Admin Client 2026.11.2`: the line shown at the foot of the Lagi sheet.
const String appVersionLine = 'MAX Admin Client $appVersion';
