<#
.SYNOPSIS
  Builds the Surau app: -Web (served by the box at /app/) and/or -Apk (Android release).
.DESCRIPTION
  -Web  flutter build web, copied to apps/box-server/public/app/ with sha256sums.txt.
        Refuses to run while a dev server listens on :5173 or :8787 (a build would corrupt it).
  -Apk  flutter build apk --release --split-per-abi. Needs apps/surau-app/android/key.properties
        (see key.properties.example); never signs with the debug key. Prints path, size, sha256.
        Copies the arm64-v8a APK to dist/android/MAX-Admin-Client-<version>-arm64-v8a.apk with a .sha256 beside it.
  -Debug  with -Apk: flutter build apk --debug --target-platform android-arm64 (no key.properties);
        copies app-debug.apk to MAX-Admin-Client-<version>-arm64-v8a-debug.apk the same way.
  Version: versions.json key admin-client-android (bump with node scripts\set-version.mjs admin-client-android <YYYY.MM.N>).
  The build first runs set-version.mjs --check --key admin-client-android and stops when pubspec.yaml disagrees; the version is
  passed to the app as --dart-define=MAXCOM_VERSION=<version> (shown as "MAX Admin Client <versi>" in the Lagi tab).
#>
param(
  [switch]$Web,
  [switch]$Apk,
  [switch]$Debug
)
$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "GAGAL: $m"; exit 1 }

if (-not ($Web -or $Apk)) { Fail 'Pilih -Web dan/atau -Apk.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appDir = Join-Path $root 'apps\surau-app'
$outDir = Join-Path $root 'apps\box-server\public\app'
if (-not (Test-Path (Join-Path $appDir 'pubspec.yaml'))) { Fail "pubspec.yaml tiada di $appDir" }

# Flutter: PATH first, then the pinned install.
$flutter = $null
$cmd = Get-Command flutter -ErrorAction SilentlyContinue
if ($cmd) { $flutter = $cmd.Source }
elseif (Test-Path 'C:\dev\flutter\bin\flutter.bat') { $flutter = 'C:\dev\flutter\bin\flutter.bat' }
else { Fail 'flutter tiada pada PATH dan tiada di C:\dev\flutter.' }

$versionLine = Select-String -Path (Join-Path $appDir 'pubspec.yaml') -Pattern '^version:\s*(\S+)' | Select-Object -First 1
if (-not $versionLine) { Fail 'version tiada dalam pubspec.yaml' }
$version = $versionLine.Matches[0].Groups[1].Value
$appVersion = ($version -split '\+')[0]
Write-Host "Versi aplikasi: $version"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail 'node tiada pada PATH.' }
$svOut = @(& $nodeCmd.Source (Join-Path $PSScriptRoot 'set-version.mjs') --check --key admin-client-android --root $root)
if ($LASTEXITCODE -ne 0) { Fail "versi tidak sepadan dengan versions.json:`n$($svOut -join "`n")" }
$defineVersion = "--dart-define=MAXCOM_VERSION=$appVersion"

function Test-Listening([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(500)) { try { $c.EndConnect($iar) } catch { return $false }; return $c.Connected }
    return $false
  } catch { return $false } finally { $c.Close() }
}

if ($Web) {
  foreach ($port in 5173, 8787) {
    if (Test-Listening $port) { Fail "pelayan pembangunan sedang berjalan pada :$port. Hentikan dahulu; binaan merosakkan folder binaannya." }
  }
  Push-Location $appDir
  try {
    & $flutter build web --release --base-href /app/ --no-web-resources-cdn --pwa-strategy offline-first $defineVersion
    if ($LASTEXITCODE -ne 0) { Fail 'flutter build web gagal.' }
  } finally { Pop-Location }

  $built = Join-Path $appDir 'build\web'
  if (-not (Test-Path (Join-Path $built 'index.html'))) { Fail "build\web\index.html tiada selepas binaan." }
  # outDir is a fixed path inside this repo (public/app); it holds build output only.
  if ((Split-Path $outDir -Leaf) -ne 'app') { Fail 'laluan keluaran tidak dijangka.' }
  if (Test-Path $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  Copy-Item -Path (Join-Path $built '*') -Destination $outDir -Recurse -Force

  $lines = @()
  $outFull = (Resolve-Path $outDir).Path
  Get-ChildItem -Path $outDir -Recurse -File | Where-Object { $_.Name -ne 'sha256sums.txt' } | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($outFull.Length + 1).Replace('\', '/')
    $lines += ('{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower(), $rel)
  }
  Set-Content -LiteralPath (Join-Path $outDir 'sha256sums.txt') -Value $lines -Encoding ASCII
  Write-Host "Web siap: $outDir ($($lines.Count) fail, sha256sums.txt ditulis)"
}

if ($Apk) {
  Push-Location $appDir
  try {
    if ($Debug) {
      & $flutter build apk --debug --target-platform android-arm64 $defineVersion
      if ($LASTEXITCODE -ne 0) { Fail 'flutter build apk --debug gagal.' }
    } else {
      $keyFile = Join-Path $appDir 'android\key.properties'
      if (-not (Test-Path $keyFile)) {
        Fail 'key.properties tiada. Salin android\key.properties.example ke android\key.properties dan isi (keystore di luar repo).'
      }
      & $flutter build apk --release --split-per-abi $defineVersion
      if ($LASTEXITCODE -ne 0) { Fail 'flutter build apk gagal.' }
    }
  } finally { Pop-Location }
  if ($Debug) { $apkPath = Join-Path $appDir 'build\app\outputs\flutter-apk\app-debug.apk'; $suffix = '-debug' }
  else { $apkPath = Join-Path $appDir 'build\app\outputs\flutter-apk\app-arm64-v8a-release.apk'; $suffix = '' }
  if (-not (Test-Path $apkPath)) { Fail "APK tiada: $apkPath" }
  $apkVersion = $appVersion
  $distDir = Join-Path $root 'dist\android'
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null
  $apkName = "MAX-Admin-Client-$apkVersion-arm64-v8a$suffix.apk"
  $dest = Join-Path $distDir $apkName
  Copy-Item -LiteralPath $apkPath -Destination $dest -Force
  $item = Get-Item $dest
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLower()
  [System.IO.File]::WriteAllText("$dest.sha256", "$hash  $apkName`n", (New-Object System.Text.ASCIIEncoding))
  Write-Host "APK: $dest"
  Write-Host ('Saiz: {0:N1} MB' -f ($item.Length / 1MB))
  Write-Host "sha256: $hash"
}
exit 0
