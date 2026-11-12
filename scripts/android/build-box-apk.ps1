<#
.SYNOPSIS
  MAXCOM: builds the box APKs (one per ABI) and verifies them. Windows PowerShell 5.1.
.DESCRIPTION
  Steps (printed by -DryRun, which writes nothing):
    1. scripts\build-release.ps1 -Version <v> -Platform android  (the release archive; refuses while 5173/8787 listen)
    2. per ABI: scripts\android\fetch-box-runtimes.ps1, then libffmpeg.so (taken from -FfmpegDir, or built by
       build-ffmpeg-android.ps1 when it is not there yet); every runtime file is compared with
       runtime-manifest.json before it is used
    3. clears and fills apps\box-android\app\src\main\jniLibs\<abi>\ and app\src\main\assets\
       {box\, runtime\, licences\} (git-ignored build inputs)
    4. gradlew.bat :app:assembleRelease -PboxVersion=<v>  (assembleDebug with -Debug)
    5. verification of every APK: each lib/<abi>/*.so entry has the sha256 of runtime-manifest.json, none is missing
       or extra, no second ABI is inside, the bundled archive equals assets/box/release.sha256 and the archive just
       built, apksigner verify; a release APK's signer sha256 must equal android-pins.json signingCertSha256
       (an empty pin fails: GAGAL: signingCertSha256 belum diisi)
    6. writes <apk>.sha256 and prints version, size and sha256 per APK

  A release build is refused without apps\box-android\key.properties and never uses the debug key. -Debug builds
  are for the developer's own device: they may be built from a checkout with uncommitted changes (release.json then
  carries dirty = true); a release build never may.
.PARAMETER Version      YYYY.MM.N, optional: defaults to versions.json kiosk-server-android; if given it must equal it (build-release checks it too).
.PARAMETER Abi          armeabi-v7a, arm64-v8a or both (default).
.PARAMETER Debug        assembleDebug (debug key, no signer pin).
.PARAMETER SkipFetch    Use the existing dist\android-runtime\<abi> folders (they are still verified).
.PARAMETER OutDir       Where the APKs and their .sha256 go (default <repo>\dist\android).
.PARAMETER DryRun       Print the six steps and write nothing.
.PARAMETER DevPorts     Passed to build-release.ps1: ports whose listener makes it refuse (default 5173 and 8787).
.PARAMETER SkipAppBuild Passed to build-release.ps1 (the kiosk dist must already exist).
.PARAMETER FfmpegDir    A folder holding jniLibs\<abi>\libffmpeg.so and runtime-manifest.json for each ABI
                        (<FfmpegDir>\<abi>\...); used instead of building ffmpeg.
.PARAMETER LoadFunctionsOnly  Test hook: define the functions and return.
#>
param(
  [string]$Version = '',
  [ValidateSet('armeabi-v7a', 'arm64-v8a', 'both')][string]$Abi = 'both',
  [switch]$Debug,
  [switch]$SkipFetch,
  [string]$OutDir = '',
  [switch]$DryRun,
  [int[]]$DevPorts = @(5173, 8787),
  [switch]$SkipAppBuild,
  [string]$FfmpegDir = '',
  [switch]$LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Fail($m) { Write-Host "GAGAL: $m"; exit 1 }

# The version of this product is versions.json[<key>]; -Version is optional and, when given, must equal it. Every file that
# carries the version must agree first (node scripts\set-version.mjs --check --key <key>).
function Resolve-ProductVersion([string]$Key, [string]$Given, [string]$Repo) {
  $vf = Join-Path $Repo 'versions.json'
  if (-not (Test-Path -LiteralPath $vf -PathType Leaf)) { Fail "versions.json tiada: $vf" }
  try { $vj = Get-Content -LiteralPath $vf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'versions.json bukan JSON yang sah.' }
  $declared = [string]$vj.$Key
  if ($declared -notmatch '^20[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]?$') { Fail "versions.json: $Key tiada atau bukan YYYY.MM.N (diberi: '$declared')" }
  if ($Given -ne '' -and $Given -ne $declared) { Fail "-Version $Given tidak sama dengan versions.json $Key ($declared)" }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { Fail 'node tiada pada PATH.' }
  $svOut = @(& $nodeCmd.Source (Join-Path $PSScriptRoot '..\set-version.mjs') --check --key $Key --root $Repo)
  if ($LASTEXITCODE -ne 0) { Fail "versi tidak sepadan dengan versions.json:`n$($svOut -join "`n")" }
  return $declared
}

# Windows PowerShell 5.1 keeps a JSON array as ONE object when piped; foreach unrolls it.
function Read-Rows([string]$path) {
  $j = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($x in $j) { $x }
}

function Get-FileSha256([string]$path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}

# sha256 (lower case hex) of one zip entry's decompressed bytes.
function Get-EntrySha256($entry) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $s = $entry.Open()
  try { return ([BitConverter]::ToString($sha.ComputeHash($s)) -replace '-', '').ToLowerInvariant() }
  finally { $s.Dispose(); $sha.Dispose() }
}

# Compares an APK (a zip) with what was meant to go into it. Returns an array of error strings (empty = pass).
#   -Manifest   rows with .apk (file name inside lib/<abi>/) and .sha256
#   -ArchiveName / -ArchiveSha256  the bundled box release archive (assets/box/<name>) and its expected sha256;
#                                  assets/box/release.sha256 must hold the same hash
function Test-ApkIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$Apk,
    [Parameter(Mandatory = $true)][string]$Abi,
    [Parameter(Mandatory = $true)]$Manifest,
    [string]$ArchiveName = '',
    [string]$ArchiveSha256 = ''
  )
  $errs = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $Apk -PathType Leaf)) { return @("APK tiada: $Apk") }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $want = @{}
  foreach ($r in @($Manifest)) { $want[[string]$r.apk] = ([string]$r.sha256).ToLowerInvariant() }
  $seen = @{}
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Apk)
  try {
    foreach ($e in $zip.Entries) {
      $n = $e.FullName
      if ($n -match '^lib/([^/]+)/(.*)$') {
        $a = $Matches[1]; $f = $Matches[2]
        if ($a -ne $Abi) { [void]$errs.Add("ABI kedua dalam APK: $n"); continue }
        if ($f -eq '') { continue }
        if (-not $want.ContainsKey($f)) { [void]$errs.Add("fail .so tidak ada dalam runtime-manifest.json: $n"); continue }
        $seen[$f] = $true
        $got = Get-EntrySha256 $e
        if ($got -ne $want[$f]) { [void]$errs.Add("sha256 berubah untuk ${n}: dapat $got, mahu $($want[$f])") }
      } elseif ($n -match '^lib/') {
        [void]$errs.Add("entri lib yang tidak dijangka: $n")
      }
    }
    foreach ($k in $want.Keys) { if (-not $seen.ContainsKey($k)) { [void]$errs.Add("fail dalam runtime-manifest.json tiada dalam APK: lib/$Abi/$k") } }

    if ($ArchiveName -ne '') {
      if ($ArchiveSha256 -notmatch '^[0-9a-f]{64}$') { [void]$errs.Add('sha256 arkib yang dijangka tidak sah') }
      else {
        $ae = $zip.GetEntry("assets/box/$ArchiveName")
        if ($null -eq $ae) { [void]$errs.Add("arkib tiada dalam APK: assets/box/$ArchiveName") }
        elseif ((Get-EntrySha256 $ae) -ne $ArchiveSha256) { [void]$errs.Add("arkib dalam APK tidak sama dengan arkib yang dibina: assets/box/$ArchiveName") }
        $re = $zip.GetEntry('assets/box/release.sha256')
        if ($null -eq $re) { [void]$errs.Add('assets/box/release.sha256 tiada dalam APK') }
        else {
          $sr = New-Object System.IO.StreamReader($re.Open(), [System.Text.Encoding]::ASCII)
          try { $txt = $sr.ReadToEnd().Trim().ToLowerInvariant() } finally { $sr.Dispose() }
          if ($txt -ne $ArchiveSha256) { [void]$errs.Add('assets/box/release.sha256 tidak sama dengan sha256 arkib') }
        }
      }
    }
  } finally { $zip.Dispose() }
  return $errs.ToArray()
}

# Signer check. Release: apksigner verify must pass and the signer certificate sha256 must equal the pin
# (an empty pin fails before apksigner runs). Debug: only apksigner verify.
function Test-ApkSigner {
  param([string]$Apk, [string]$Pin, [bool]$Release, [string]$ApkSignerJar, [string]$Java)
  $errs = New-Object System.Collections.ArrayList
  if ($Release) {
    if ([string]$Pin -eq '') { return @('signingCertSha256 belum diisi') }
    if ($Pin -notmatch '^[0-9a-fA-F]{64}$') { return @('signingCertSha256 dalam android-pins.json tidak sah') }
  }
  $out = @(& $Java -jar $ApkSignerJar verify --print-certs $Apk)
  if ($LASTEXITCODE -ne 0) { return @("apksigner verify gagal untuk $Apk") }
  if ($Release) {
    $line = @($out | Where-Object { $_ -match 'Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})' })
    if ($line.Count -ne 1) { return @('apksigner tidak melaporkan satu sijil penandatangan') }
    [void]($line[0] -match 'digest:\s*([0-9a-fA-F]{64})')
    if ($Matches[1].ToLowerInvariant() -ne $Pin.ToLowerInvariant()) { [void]$errs.Add("sijil penandatangan APK ($($Matches[1])) tidak sama dengan pin signingCertSha256") }
  }
  return $errs.ToArray()
}

if ($LoadFunctionsOnly) { return }

# ---------------------------------------------------------------------------------------------
# Checks before anything is touched
# ---------------------------------------------------------------------------------------------
if ($Version -ne '' -and $Version -notmatch '^20[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]?$') { Fail "-Version mesti berbentuk YYYY.MM.N dengan N antara 1 dan 99, diberi: $Version" }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\')
$Version = Resolve-ProductVersion 'kiosk-server-android' $Version $repo
if ($OutDir -eq '') { $OutDir = Join-Path $repo 'dist\android' }
$abis = if ($Abi -eq 'both') { @('armeabi-v7a', 'arm64-v8a') } else { @($Abi) }
$project = Join-Path $repo 'apps\box-android'
$main = Join-Path $project 'app\src\main'
$archiveName = "maxcom-box-$Version-android.tar.gz"
# The Android Gradle plugin gunzips and renames every *.gz asset (the APK check found a .tar inside), so the archive
# travels inside the APK as .tgz: same bytes, same sha256, only the asset name differs.
$assetName = "maxcom-box-$Version-android.tgz"
$task = if ($Debug) { 'assembleDebug' } else { 'assembleRelease' }

if ($DryRun) {
  Write-Host "DRYRUN 1 build-release.ps1 -Version $Version -Platform android$(if ($Debug) { ' -AllowDirty' })  (refuses while port $($DevPorts -join ', ') listens)"
  Write-Host "DRYRUN 2 untuk $($abis -join ', '): fetch-box-runtimes.ps1$(if ($SkipFetch) { ' (dilangkau: -SkipFetch)' }); libffmpeg.so daripada $(if ($FfmpegDir) { $FfmpegDir } else { 'build-ffmpeg-android.ps1 bila belum ada' })"
  Write-Host "DRYRUN 3 kosongkan dan isi $main\jniLibs\<abi>\ dan assets\{box\$assetName (same bytes as $archiveName), box\release.json, box\release.sha256, runtime\<abi>\libmap.json, runtime\cert.pem, runtime\VERSIONS.md, licences\}"
  Write-Host "DRYRUN 4 gradlew.bat :app:$task -PboxVersion=$Version$(if (-not $Debug) { '  (ditolak tanpa apps\box-android\key.properties)' })"
  Write-Host 'DRYRUN 5 semak setiap APK: sha256 setiap lib/<abi>/*.so melawan runtime-manifest.json, tiada ABI kedua, arkib melawan release.sha256, apksigner verify'
  Write-Host "DRYRUN   $(if ($Debug) { 'binaan nyahpepijat: tiada pin penandatangan' } else { 'sijil penandatangan melawan signingCertSha256 dalam android-pins.json' })"
  Write-Host "DRYRUN 6 tulis <apk>.sha256 dalam $OutDir dan cetak versi, saiz, sha256"
  Write-Host 'DRYRUN tiada apa yang ditulis atau dibina.'
  exit 0
}

$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'android-pins.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$signerPin = if ($pins.PSObject.Properties.Name -contains 'signingCertSha256') { [string]$pins.signingCertSha256 } else { '' }
if (-not $Debug) {
  if (-not (Test-Path -LiteralPath (Join-Path $project 'key.properties') -PathType Leaf)) { Fail 'apps\box-android\key.properties tiada: APK keluaran tidak dibina tanpa kunci pengendali (lihat key.properties.example).' }
  if ($signerPin -eq '') { Fail 'signingCertSha256 belum diisi dalam scripts\android\android-pins.json (pin sijil kunci pengendali).' }
}

$java = (Get-Command java -ErrorAction SilentlyContinue)
if (-not $java) { Fail 'java tiada pada PATH.' }
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $lp = Join-Path $project 'local.properties'; if (Test-Path -LiteralPath $lp) { $m = Select-String -LiteralPath $lp -Pattern '^sdk\.dir=(.+)$' | Select-Object -First 1; if ($m) { $sdk = ($m.Matches[0].Groups[1].Value -replace '\\\\', '\' -replace '\\:', ':') } } }
if (-not $sdk -or -not (Test-Path -LiteralPath (Join-Path $sdk 'build-tools'))) { Fail 'Android SDK tidak dijumpai (ANDROID_HOME atau local.properties).' }
$bt = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'lib\apksigner.jar') } | Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } | Select-Object -Last 1
if (-not $bt) { Fail 'apksigner.jar tiada dalam build-tools.' }
$apksignerJar = Join-Path $bt.FullName 'lib\apksigner.jar'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# ---------------------------------------------------------------------------------------------
# 1. release archive
# ---------------------------------------------------------------------------------------------
Write-Host "1/6 arkib keluaran android $Version"
$brArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'scripts\build-release.ps1'), '-Version', $Version, '-Platform', 'android', '-DevPorts', ($DevPorts -join ','))
if ($SkipAppBuild) { $brArgs += '-SkipAppBuild' }
if ($Debug) { $brArgs += '-AllowDirty' }
& $psExe @brArgs
if ($LASTEXITCODE -ne 0) { Fail 'build-release.ps1 gagal; tiada APK dibina.' }
$archive = Join-Path $repo "dist\release\$archiveName"
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { Fail "arkib tiada: $archive" }
$archiveSha = Get-FileSha256 $archive

# ---------------------------------------------------------------------------------------------
# 2. runtimes (and 3a: verify each file against its manifest before use)
# ---------------------------------------------------------------------------------------------
Write-Host "2/6 runtime: $($abis -join ', ')"
$manifests = @{}
foreach ($a in $abis) {
  $rt = Join-Path $repo "dist\android-runtime\$a"
  if (-not $SkipFetch) {
    & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fetch-box-runtimes.ps1') -Abi $a
    if ($LASTEXITCODE -ne 0) { Fail "fetch-box-runtimes.ps1 gagal untuk $a" }
  }
  $mf = Join-Path $rt 'runtime-manifest.json'
  if (-not (Test-Path -LiteralPath $mf -PathType Leaf)) { Fail "runtime-manifest.json tiada: $mf (jalankan tanpa -SkipFetch)" }
  $libDir = Join-Path $rt "jniLibs\$a"
  $rows = @(Read-Rows $mf)
  if (-not ($rows | Where-Object { $_.apk -eq 'libffmpeg.so' })) {
    $ffLib = $null; $ffRow = $null
    if ($FfmpegDir -ne '') {
      $ffLib = Join-Path $FfmpegDir "$a\jniLibs\$a\libffmpeg.so"
      $ffMf = Join-Path $FfmpegDir "$a\runtime-manifest.json"
      if (-not (Test-Path -LiteralPath $ffLib -PathType Leaf) -or -not (Test-Path -LiteralPath $ffMf -PathType Leaf)) { Fail "libffmpeg.so atau runtime-manifest.json tiada dalam $FfmpegDir\$a" }
      $ffRow = @(Read-Rows $ffMf) | Where-Object { $_.apk -eq 'libffmpeg.so' } | Select-Object -First 1
      if (-not $ffRow) { Fail "libffmpeg.so tiada dalam $ffMf" }
      if ((Get-FileSha256 $ffLib) -ne ([string]$ffRow.sha256).ToLowerInvariant()) { Fail "sha256 libffmpeg.so tidak sepadan dengan manifestnya ($ffLib)" }
      Copy-Item -LiteralPath $ffLib -Destination (Join-Path $libDir 'libffmpeg.so') -Force
      $rows = @($rows) + @($ffRow)
      [System.IO.File]::WriteAllText($mf, (ConvertTo-Json -InputObject @($rows) -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    } else {
      & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-ffmpeg-android.ps1') -Abi $a
      if ($LASTEXITCODE -ne 0) { Fail "build-ffmpeg-android.ps1 gagal untuk $a" }
      $rows = @(Read-Rows $mf)
    }
  }
  foreach ($r in $rows) {
    if ([string]$r.apk -notmatch '^lib[A-Za-z0-9_+-]+\.so$') { Fail "nama dalam runtime-manifest.json tidak sah: $($r.apk)" }
    $f = Join-Path $libDir ([string]$r.apk)
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail "fail runtime tiada: $f" }
    if ((Get-FileSha256 $f) -ne ([string]$r.sha256).ToLowerInvariant()) { Fail "sha256 fail runtime tidak sepadan dengan manifest: $f" }
  }
  $present = @(Get-ChildItem -LiteralPath $libDir -File | ForEach-Object { $_.Name })
  foreach ($p in $present) { if (-not ($rows | Where-Object { $_.apk -eq $p })) { Fail "fail runtime tidak dalam manifest: $libDir\$p" } }
  $manifests[$a] = $rows
}

# ---------------------------------------------------------------------------------------------
# 3. fill the Gradle project's build inputs
# ---------------------------------------------------------------------------------------------
Write-Host '3/6 isi jniLibs dan assets'
foreach ($d in @('jniLibs', 'assets\box', 'assets\runtime', 'assets\licences')) {
  $p = Join-Path $main $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path (Join-Path $main 'assets\box'), (Join-Path $main 'assets\runtime'), (Join-Path $main 'assets\licences') | Out-Null
Copy-Item -LiteralPath $archive -Destination (Join-Path $main "assets\box\$assetName") -Force
[System.IO.File]::WriteAllText((Join-Path $main 'assets\box\release.sha256'), "$archiveSha`n", (New-Object System.Text.UTF8Encoding($false)))
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$tmpRel = Join-Path ([System.IO.Path]::GetTempPath()) ('maxcom-rel-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpRel | Out-Null
try {
  & $tar -xzf $archive -C $tmpRel 'release.json'
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $tmpRel 'release.json'))) { Fail 'release.json tidak dapat diambil daripada arkib.' }
  Copy-Item -LiteralPath (Join-Path $tmpRel 'release.json') -Destination (Join-Path $main 'assets\box\release.json') -Force
} finally { Remove-Item -LiteralPath $tmpRel -Recurse -Force -ErrorAction SilentlyContinue }
$first = $true
foreach ($a in $abis) {
  $rt = Join-Path $repo "dist\android-runtime\$a"
  $dstLib = Join-Path $main "jniLibs\$a"
  New-Item -ItemType Directory -Force -Path $dstLib | Out-Null
  Copy-Item -Path (Join-Path $rt "jniLibs\$a\*") -Destination $dstLib -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $main "assets\runtime\$a") | Out-Null
  Copy-Item -LiteralPath (Join-Path $rt 'libmap.json') -Destination (Join-Path $main "assets\runtime\$a\libmap.json") -Force
  if ($first) {
    Copy-Item -LiteralPath (Join-Path $rt 'cert.pem') -Destination (Join-Path $main 'assets\runtime\cert.pem') -Force
    Copy-Item -LiteralPath (Join-Path $rt 'VERSIONS.md') -Destination (Join-Path $main 'assets\runtime\VERSIONS.md') -Force
    $first = $false
  } elseif ((Get-FileSha256 (Join-Path $rt 'cert.pem')) -ne (Get-FileSha256 (Join-Path $main 'assets\runtime\cert.pem'))) {
    Fail 'cert.pem berbeza antara ABI.'
  }
  if (Test-Path -LiteralPath (Join-Path $rt 'licences')) { Copy-Item -Path (Join-Path $rt 'licences\*') -Destination (Join-Path $main 'assets\licences') -Recurse -Force }
}

# ---------------------------------------------------------------------------------------------
# 4. gradle
# ---------------------------------------------------------------------------------------------
Write-Host "4/6 gradlew :app:$task"
Push-Location $project
try {
  & (Join-Path $project 'gradlew.bat') ":app:$task" "-PboxVersion=$Version" '--console=plain'
  if ($LASTEXITCODE -ne 0) { Fail "gradlew :app:$task gagal." }
} finally { Pop-Location }

# ---------------------------------------------------------------------------------------------
# 5. verification, 6. outputs
# ---------------------------------------------------------------------------------------------
Write-Host '5/6 semakan'
$buildType = if ($Debug) { 'debug' } else { 'release' }
$suffix = if ($Debug) { '-debug' } else { '' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$results = @()
$allErrs = @()
foreach ($a in $abis) {
  $apk = Join-Path $project "app\build\outputs\apk\$buildType\MAX-Kiosk-Server-$Version-$a$suffix.apk"
  if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { Fail "APK tiada selepas gradle: $apk" }
  $errs = @(Test-ApkIntegrity -Apk $apk -Abi $a -Manifest $manifests[$a] -ArchiveName $assetName -ArchiveSha256 $archiveSha)
  $errs += @(Test-ApkSigner -Apk $apk -Pin $signerPin -Release (-not $Debug) -ApkSignerJar $apksignerJar -Java $java.Source)
  if ($errs.Count -gt 0) { foreach ($e in $errs) { Write-Host "GAGAL: [$a] $e" }; $allErrs += $errs; continue }
  $dst = Join-Path $OutDir (Split-Path -Leaf $apk)
  Copy-Item -LiteralPath $apk -Destination $dst -Force
  $h = Get-FileSha256 $dst
  [System.IO.File]::WriteAllText("$dst.sha256", "$h  $(Split-Path -Leaf $dst)`n", (New-Object System.Text.UTF8Encoding($false)))
  $results += [pscustomobject]@{ Path = $dst; Size = (Get-Item -LiteralPath $dst).Length; Sha = $h }
}
if ($allErrs.Count -gt 0) { Fail "semakan APK gagal ($($allErrs.Count) masalah); tiada APK diterbitkan untuk ABI yang gagal." }
Write-Host '6/6 siap'
foreach ($r in $results) { Write-Host "APK $Version $($r.Path) saiz $($r.Size) sha256 $($r.Sha)" }
