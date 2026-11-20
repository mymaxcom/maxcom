<#
.SYNOPSIS
  Builds the Surau app: -Web (served by the box at /app/) and/or -Apk (Android release).
.DESCRIPTION
  -Web  flutter build web, copied to apps/box-server/public/app/ with sha256sums.txt.
        Refuses to run while a dev server listens on :5173 or :8787 (a build would corrupt it).
  -Apk  flutter build apk --release --split-per-abi. Needs apps/surau-app/android/key.properties
        (see key.properties.example); never signs with the debug key. Prints path, size, sha256.
        Copies the arm64-v8a APK to dist/android/MAX-Admin-Client-<version>[-b<N>]-arm64-v8a.apk with a .sha256 beside it
        (-b<N> only when builds.json at the repo root gives admin-client-android a number above 0, e.g. 2026.11.13-b1).
  -Debug  with -Apk: flutter build apk --debug --target-platform android-arm64 (no key.properties);
        copies app-debug.apk to MAX-Admin-Client-<version>[-b<N>]-arm64-v8a-debug.apk the same way.
  -Ops  with -Apk: the private MAXCOM Ops build (Plan 14 section 3.4): --dart-define=MAXCOM_OPS=true, package my.maxcom.app.ops,
        signed ONLY with android\key-ops.properties (never key.properties). The APK is MOVED to
        ~\maxcom-work\secret\ops-builds\<version>\MAXCOM-Ops-<version>-arm64-v8a.apk (+ .sha256) and build\app\outputs is deleted,
        so no ops file stays where the public step reads. Refuses -Web, -Debug, and an output folder inside the repo, under dist\, on a
        Drive path, or outside ~\maxcom-work\secret (-OpsOutDir may pick another folder under it). Nothing is published.
  -PlayBundle  with -Apk (public only: not with -Ops or -Debug): ALSO runs flutter build appbundle --release with the same
        dart-defines, checks the bundle with check-public-apk.mjs (markers, package id, my.maxcom.app.ops, MAXCOM_OPS) and
        copies it to dist/android/MAX-Admin-Client-<version>[-b<N>]-play.aab with a .sha256. Without the switch the commands are
        exactly the ones of a normal -Apk build.
  Public -Apk: the APK and its package id are checked by scripts\check-public-apk.mjs BEFORE the copy to dist\android; a marker hit
        or a .ops package id stops the build. -Web scans build\web the same way before it is copied.
  Version: versions.json key admin-client-android (bump with node scripts\set-version.mjs admin-client-android <YYYY.MM.N>).
  The build first runs set-version.mjs --check --key admin-client-android and stops when pubspec.yaml disagrees; the version is
  passed to the app as --dart-define=MAXCOM_VERSION=<version> (shown as "MAX Admin Client <versi>" in the Lagi tab).
#>
param(
  [switch]$Web,
  [switch]$Apk,
  [switch]$Debug,
  [switch]$Ops,
  [switch]$PlayBundle,
  [string]$OpsOutDir = ''
)
$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "GAGAL: $m"; exit 1 }

if (-not ($Web -or $Apk)) { Fail 'Pilih -Web dan/atau -Apk.' }
if ($Ops -and $Web) { Fail '-Ops tidak boleh bersama -Web: binaan web sentiasa awam.' }
if ($Ops -and -not $Apk) { Fail '-Ops memerlukan -Apk.' }
if ($Ops -and $Debug) { Fail '-Ops tidak boleh bersama -Debug.' }
if ($OpsOutDir -ne '' -and -not $Ops) { Fail '-OpsOutDir hanya dengan -Ops.' }
if ($PlayBundle -and -not $Apk) { Fail '-PlayBundle memerlukan -Apk.' }
if ($PlayBundle -and $Ops) { Fail '-PlayBundle tidak boleh bersama -Ops: bundle Play sentiasa awam.' }
if ($PlayBundle -and $Debug) { Fail '-PlayBundle tidak boleh bersama -Debug.' }

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

# internal build of this product's current version (builds.json, optional; not listed = 0): rides in the public APK
# name when above 0. Read here, before any flutter build, so a bad builds.json fails at once.
$build = 0
$buildsFile = Join-Path $root 'builds.json'
if (Test-Path -LiteralPath $buildsFile -PathType Leaf) {
  try { $builds = Get-Content -LiteralPath $buildsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'builds.json bukan JSON yang sah.' }
  $bp = $builds.PSObject.Properties['admin-client-android']
  if ($null -ne $bp) {
    if ([string]$bp.Value -notmatch '^[0-9]\z') { Fail 'builds.json: admin-client-android mesti nombor 0 hingga 9' }
    $build = [int]$bp.Value
  }
}
$buildTag = if ($build -gt 0) { "-b$build" } else { '' }

function Test-Under([string]$child, [string]$parent) {
  $c = [System.IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
  $p = [System.IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

# Plan 14 Task 24: the binary scan (also the gate before any copy to MAXCOM-Installers).
$checkScript = Join-Path $PSScriptRoot 'check-public-apk.mjs'
function Invoke-Check([string[]]$checkArgs) {
  $o = @(& $nodeCmd.Source $checkScript @checkArgs)
  $code = $LASTEXITCODE
  foreach ($l in $o) { Write-Host $l }
  return $code
}

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
    & $flutter build web --release --base-href /app/ --no-web-resources-cdn --pwa-strategy none $defineVersion
    if ($LASTEXITCODE -ne 0) { Fail 'flutter build web gagal.' }
  } finally { Pop-Location }

  $built = Join-Path $appDir 'build\web'
  if (-not (Test-Path (Join-Path $built 'index.html'))) { Fail "build\web\index.html tiada selepas binaan." }
  if ((Invoke-Check @($built)) -ne 0) { Fail 'binaan web awam mengandungi bahan ops. Tidak disalin.' }
  # outDir is a fixed path inside this repo (public/app); it holds build output only.
  if ((Split-Path $outDir -Leaf) -ne 'app') { Fail 'laluan keluaran tidak dijangka.' }
  if (Test-Path $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  Copy-Item -Path (Join-Path $built '*') -Destination $outDir -Recurse -Force

  $outFull = (Resolve-Path $outDir).Path

  # Generate precache list and build id for the service worker.
  $precacheFiles = Get-ChildItem -Path $outDir -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($outFull.Length + 1).Replace('\', '/')
    $rel -ne 'maxcom_sw.js' -and
    $rel -ne 'flutter_service_worker.js' -and
    $rel -ne 'sha256sums.txt' -and
    -not $rel.EndsWith('.map') -and
    $rel -ne 'assets/NOTICES'
  } | Sort-Object FullName

  $buildInputLines = @()
  $precachePaths = @()
  foreach ($file in $precacheFiles) {
    $rel = $file.FullName.Substring($outFull.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLower()
    $buildInputLines += "$rel $hash"
    $precachePaths += $rel
  }
  $buildInput = $buildInputLines -join "`n"
  $buildBytes = [System.Text.Encoding]::ASCII.GetBytes($buildInput)
  $buildStream = [System.IO.MemoryStream]::new($buildBytes)
  $buildHash = (Get-FileHash -Algorithm SHA256 -InputStream $buildStream).Hash.ToLower()
  $buildId = $buildHash.Substring(0, 16)

  $swPath = Join-Path $outDir 'maxcom_sw.js'
  if (-not (Test-Path $swPath)) { Fail 'maxcom_sw.js tiada di output web.' }
  $swContent = [System.IO.File]::ReadAllText($swPath, [System.Text.Encoding]::UTF8)
  $swContent = $swContent.Replace('__MAXCOM_BUILD__', $buildId)
  $quotedPaths = $precachePaths | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
  $filesJson = '[' + ($quotedPaths -join ', ') + ']'
  $swContent = $swContent.Replace('__MAXCOM_FILES__', $filesJson)
  [System.IO.File]::WriteAllText($swPath, $swContent, [System.Text.Encoding]::UTF8)

  $lines = @()
  Get-ChildItem -Path $outDir -Recurse -File | Where-Object { $_.Name -ne 'sha256sums.txt' } | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($outFull.Length + 1).Replace('\', '/')
    $lines += ('{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower(), $rel)
  }
  Set-Content -LiteralPath (Join-Path $outDir 'sha256sums.txt') -Value $lines -Encoding ASCII
  Write-Host "Web siap: $outDir ($($lines.Count) fail, sha256sums.txt ditulis, BUILD=$buildId)"
}

if ($Apk) {
  $outputsDir = Join-Path $appDir 'build\app\outputs'
  if ($Ops) {
    $secretBase = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'maxcom-work\secret'
    if ($OpsOutDir -eq '') { $opsOut = Join-Path $secretBase "ops-builds\$appVersion" } else { $opsOut = $OpsOutDir }
    $opsOut = [System.IO.Path]::GetFullPath($opsOut)
    if (Test-Under $opsOut $root) { Fail "folder keluaran ops berada dalam repo: $opsOut" }
    if (Test-Under $opsOut (Join-Path $root 'dist')) { Fail "folder keluaran ops berada di bawah dist: $opsOut" }
    if ($opsOut -match '(?i)google ?drive|my drive|onedrive|dropbox' -or $opsOut -match '(?i)^g:') { Fail "folder keluaran ops berada pada laluan Drive: $opsOut" }
    if (-not (Test-Under $opsOut $secretBase)) { Fail "folder keluaran ops mesti di bawah $secretBase" }
    $opsKey = Join-Path $appDir 'android\key-ops.properties'
    if (-not (Test-Path $opsKey)) {
      Fail 'key-ops.properties tiada. Salin android\key-ops.properties.example ke android\key-ops.properties dan isi (keystore ops di luar repo, di maxcom-work\secret\ops-keystore). Binaan ops tidak sekali-kali memakai kunci awam.'
    }
  }
  # An earlier build's APK (public or ops) must never be what this run picks up.
  if (Test-Path $outputsDir) { Remove-Item -LiteralPath $outputsDir -Recurse -Force }
  $extraDefine = @()
  if ($Ops) { $extraDefine = @('--dart-define=MAXCOM_OPS=true') }
  Push-Location $appDir
  try {
    if ($Debug) {
      & $flutter build apk --debug --target-platform android-arm64 $defineVersion
      if ($LASTEXITCODE -ne 0) { Fail 'flutter build apk --debug gagal.' }
    } else {
      $keyFile = Join-Path $appDir 'android\key.properties'
      if (-not $Ops -and -not (Test-Path $keyFile)) {
        Fail 'key.properties tiada. Salin android\key.properties.example ke android\key.properties dan isi (keystore di luar repo).'
      }
      & $flutter build apk --release --split-per-abi $defineVersion @extraDefine
      if ($LASTEXITCODE -ne 0) {
        if ($Ops -and (Test-Path $outputsDir)) { Remove-Item -LiteralPath $outputsDir -Recurse -Force }
        Fail 'flutter build apk gagal.'
      }
    }
  } finally { Pop-Location }
  if ($Debug) { $apkPath = Join-Path $appDir 'build\app\outputs\flutter-apk\app-debug.apk'; $suffix = '-debug' }
  else { $apkPath = Join-Path $appDir 'build\app\outputs\flutter-apk\app-arm64-v8a-release.apk'; $suffix = '' }
  if (-not (Test-Path $apkPath)) { Fail "APK tiada: $apkPath" }
  $apkVersion = $appVersion

  # The package id of what came out must be the variant that was asked for.
  $kind = ((@(& $nodeCmd.Source $checkScript --kind $apkPath)) -join '').Trim()
  if ($Ops) {
    if ($kind -ne 'ops') {
      Remove-Item -LiteralPath $outputsDir -Recurse -Force -ErrorAction SilentlyContinue
      Fail "id pakej APK ialah '$kind', bukan my.maxcom.app.ops."
    }
    New-Item -ItemType Directory -Path $opsOut -Force | Out-Null
    $opsName = "MAXCOM-Ops-$apkVersion-arm64-v8a.apk"
    $opsDest = Join-Path $opsOut $opsName
    Move-Item -LiteralPath $apkPath -Destination $opsDest -Force
    Remove-Item -LiteralPath $outputsDir -Recurse -Force
    $opsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $opsDest).Hash.ToLower()
    [System.IO.File]::WriteAllText("$opsDest.sha256", "$opsHash  $opsName`n", (New-Object System.Text.ASCIIEncoding))
    Write-Host "APK ops (peribadi, jangan terbitkan): $opsDest"
    Write-Host ('Saiz: {0:N1} MB' -f ((Get-Item $opsDest).Length / 1MB))
    Write-Host "sha256: $opsHash"
    exit 0
  }
  if ($kind -ne 'public') { Fail "id pakej APK ialah '$kind', bukan my.maxcom.app. Tidak disalin ke dist." }
  if ((Invoke-Check @($apkPath)) -ne 0) { Fail 'APK awam mengandungi bahan ops. Tidak disalin ke dist.' }
  $distDir = Join-Path $root 'dist\android'
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null
  $apkName = "MAX-Admin-Client-$apkVersion$buildTag-arm64-v8a$suffix.apk"
  $dest = Join-Path $distDir $apkName
  Copy-Item -LiteralPath $apkPath -Destination $dest -Force
  $item = Get-Item $dest
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLower()
  [System.IO.File]::WriteAllText("$dest.sha256", "$hash  $apkName`n", (New-Object System.Text.ASCIIEncoding))
  Write-Host "APK: $dest"
  Write-Host ('Saiz: {0:N1} MB' -f ($item.Length / 1MB))
  Write-Host "sha256: $hash"

  # Opt-in: the Android App Bundle for Play, built from the same public sources and defines, and checked before the copy.
  if ($PlayBundle) {
    $bundlePath = Join-Path $appDir 'build\app\outputs\bundle\release\app-release.aab'
    if (Test-Path $bundlePath) { Remove-Item -LiteralPath $bundlePath -Force }
    Push-Location $appDir
    try {
      # One bundle carries every ABI under ONE version code. It must be higher than the per-ABI codes of the sideload APKs
      # (build number + 1000..4000), or a phone that has an APK could not move to the Play version: build number + 9000.
      # The reverse does not hold: a phone that has taken the Play bundle cannot later take a sideload APK (its code is
      # lower, Android refuses the downgrade), so that phone stays on Play.
      $pubLine = Select-String -LiteralPath (Join-Path $appDir 'pubspec.yaml') -Pattern '^version:\s*\S+\+(\d+)\s*$' | Select-Object -First 1
      if (-not $pubLine) { Fail 'pubspec.yaml tiada nombor binaan (version: x+N).' }
      $playCode = [int]$pubLine.Matches[0].Groups[1].Value + 9000
      & $flutter build appbundle --release "--build-number=$playCode" $defineVersion
      if ($LASTEXITCODE -ne 0) { Fail 'flutter build appbundle gagal.' }
    } finally { Pop-Location }
    if (-not (Test-Path $bundlePath)) { Fail "bundle tiada: $bundlePath" }
    $bkind = ((@(& $nodeCmd.Source $checkScript --kind $bundlePath)) -join '').Trim()
    if ($bkind -ne 'public') { Fail "id pakej bundle ialah '$bkind', bukan my.maxcom.app. Tidak disalin ke dist." }
    if ((Invoke-Check @($bundlePath)) -ne 0) { Fail 'bundle Play mengandungi bahan ops. Tidak disalin ke dist.' }
    $aabName = "MAX-Admin-Client-$apkVersion$buildTag-play.aab"
    $aabDest = Join-Path $distDir $aabName
    Copy-Item -LiteralPath $bundlePath -Destination $aabDest -Force
    $aabHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $aabDest).Hash.ToLower()
    [System.IO.File]::WriteAllText("$aabDest.sha256", "$aabHash  $aabName`n", (New-Object System.Text.ASCIIEncoding))
    Write-Host "AAB: $aabDest"
    Write-Host ('Saiz: {0:N1} MB' -f ((Get-Item $aabDest).Length / 1MB))
    Write-Host "sha256: $aabHash"
  }
}
exit 0
