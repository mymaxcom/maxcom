<#
.SYNOPSIS
  Builds the slim LGPL ffmpeg for the MAXCOM Android box inside the pinned Docker image.
.DESCRIPTION
  build-ffmpeg-android.ps1 -Abi armeabi-v7a|arm64-v8a [-CacheDir <dir>] [-OutDir <dir>] [-PinsFile <file>] [-DryRun]
  Output: <OutDir>\jniLibs\<abi>\libffmpeg.so, <OutDir>\ffmpeg-build-info.txt and a libffmpeg.so row in
  <OutDir>\runtime-manifest.json. The three source tarballs and the NDK zip are fetched here, on the host,
  and checked against android-pins.json; the build container then runs with --network none.
  -DryRun prints the Docker commands as argument lists and starts nothing (no download, no Docker call).
  The shell script and the feature list are mounted from this folder, so the build always uses the checked-in copies.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('armeabi-v7a', 'arm64-v8a')][string]$Abi,
  [string]$CacheDir,
  [string]$OutDir,
  [string]$PinsFile,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$msg) { Write-Host "GAGAL: $msg"; exit 1 }

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
if (-not $CacheDir) { $CacheDir = Join-Path $repo 'dist\android-cache' }
if (-not $OutDir) { $OutDir = Join-Path $repo ('dist\android-runtime\' + $Abi) }
if (-not $PinsFile) { $PinsFile = Join-Path $here 'android-pins.json' }
$featuresFile = Join-Path $here 'ffmpeg-features.json'
$scriptFile = Join-Path $here 'build-ffmpeg-android.sh'
foreach ($f in @($PinsFile, $featuresFile, $scriptFile)) { if (-not (Test-Path -LiteralPath $f)) { Fail "fail tiada: $f" } }

$pins = Get-Content -LiteralPath $PinsFile -Raw | ConvertFrom-Json
foreach ($k in @('ffmpegSrc', 'opusSrc', 'mbedtlsSrc')) {
  if (-not $pins.$k) { Fail "$k tiada dalam android-pins.json" }
  if (-not $pins.$k.sha256) { Fail "sha256 belum diisi untuk $k" }
}
$img = $pins.ndkImage
if (-not $img -or -not $img.base -or -not $img.ndkSha256) { Fail 'ndkImage belum lengkap dalam android-pins.json' }
if ($img.base -notmatch '@sha256:[0-9a-f]{64}$') { Fail 'ndkImage.base mesti dikunci dengan digest sha256' }

$apiLevel = [int]$img.apiLevel
$ndkVolume = 'maxcom-ndk-' + $img.ndkVersion
$ndkZipName = [IO.Path]::GetFileName(([Uri]$img.ndkUrl).AbsolutePath)
$ndkRootName = 'android-ndk-' + $img.ndkVersion
$sources = @(
  @{ key = 'ffmpegSrc'; env = 'FFMPEG' },
  @{ key = 'opusSrc'; env = 'OPUS' },
  @{ key = 'mbedtlsSrc'; env = 'MBEDTLS' }
)

$dockerfile = @"
FROM $($img.base)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential cmake ninja-build pkg-config python3 unzip xz-utils bzip2 file binutils perl ca-certificates && rm -rf /var/lib/apt/lists/*
"@

# ---- the docker commands, built as argument lists ----
$mounts = @('-v', ($CacheDir + ':/cache:ro'), '-v', ($here + ':/scripts:ro'))
$buildArgs = @('run', '--rm', '--network', 'none') + $mounts + @(
  '-v', ($ndkVolume + ':/ndk:ro'), '-v', ($OutDir + ':/out'),
  '-e', "ABI=$Abi", '-e', "API_LEVEL=$apiLevel", '-e', "NDK_ROOT=/ndk/$ndkRootName",
  '-e', 'SRC_DIR=/cache', '-e', 'FEATURES=/scripts/ffmpeg-features.json', '-e', 'OUT=/out')
foreach ($s in $sources) {
  $p = $pins.($s.key)
  $buildArgs += @('-e', ($s.env + '_FILE=' + [IO.Path]::GetFileName(([Uri]$p.url).AbsolutePath)),
    '-e', ($s.env + '_SHA256=' + $p.sha256), '-e', ($s.env + '_VERSION=' + $p.version))
}
$buildArgs += @($img.imageTag, 'bash', '/scripts/build-ffmpeg-android.sh')
$ndkExtractArgs = @('run', '--rm', '--network', 'none', '-v', ($CacheDir + ':/cache:ro'), '-v', ($ndkVolume + ':/ndk'), $img.imageTag, 'bash', '-c',
  "test -f /ndk/.ok || (unzip -q /cache/$ndkZipName -d /ndk && touch /ndk/.ok)")
$imageBuildArgs = @('build', '-t', $img.imageTag, '-')

function Show-Cmd([string]$title, [string[]]$a) {
  Write-Host "$title"
  Write-Host '  docker'
  $i = 0
  foreach ($x in $a) { Write-Host ("  [{0}] {1}" -f $i, $x); $i++ }
}

if ($DryRun) {
  Write-Host "DRY RUN: nothing is downloaded or started. Abi=$Abi CacheDir=$CacheDir OutDir=$OutDir"
  Write-Host 'Dockerfile for the build image (piped to docker build):'
  $dockerfile -split "`n" | ForEach-Object { Write-Host ('  | ' + $_.TrimEnd()) }
  Show-Cmd 'image build:' $imageBuildArgs
  Show-Cmd 'NDK extract (once, into a Docker volume):' $ndkExtractArgs
  Show-Cmd 'ffmpeg build:' $buildArgs
  exit 0
}

# ---- real run ----
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-Pinned([string]$url, [string]$sha256, [string]$name) {
  $dest = Join-Path $CacheDir $name
  if (Test-Path -LiteralPath $dest) {
    if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -eq $sha256.ToLower()) { return }
    Remove-Item -LiteralPath $dest -Force
  }
  $ok = $false
  for ($i = 1; $i -le 6 -and -not $ok; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest -TimeoutSec 900 -ErrorAction Stop; $ok = $true }
    catch { Write-Host "cuba $i gagal untuk ${name}: $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
  }
  if (-not $ok) { Fail "tidak dapat memuat turun $url" }
  $got = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha256.ToLower()) { Remove-Item -LiteralPath $dest -Force; Fail "sha256 tidak sepadan untuk $name (dapat $got, mahu $sha256)" }
}

# native stderr under Stop would throw in Windows PowerShell 5.1; exit codes are checked instead
$ErrorActionPreference = 'Continue'
& docker version --format '{{.Server.Version}}' *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker tidak menjawab. Mulakan Docker Desktop dahulu.' }

foreach ($s in $sources) {
  $p = $pins.($s.key)
  Get-Pinned $p.url $p.sha256 ([IO.Path]::GetFileName(([Uri]$p.url).AbsolutePath))
}
Get-Pinned $img.ndkUrl $img.ndkSha256 $ndkZipName

& docker image inspect $img.imageTag *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Membina imej Docker (sekali sahaja, perlu rangkaian untuk apt)...'
  $dockerfile | & docker @imageBuildArgs
  if ($LASTEXITCODE -ne 0) { Fail 'docker build gagal' }
}
& docker @ndkExtractArgs
if ($LASTEXITCODE -ne 0) { Fail 'mengekstrak NDK gagal' }

& docker @buildArgs
if ($LASTEXITCODE -ne 0) { Fail 'pembinaan ffmpeg gagal' }

$bin = Join-Path $OutDir ('jniLibs\' + $Abi + '\libffmpeg.so')
if (-not (Test-Path -LiteralPath $bin)) { Fail "libffmpeg.so tidak dihasilkan: $bin" }
$sha = (Get-FileHash -LiteralPath $bin -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $bin).Length

# runtime-manifest.json: [{ apk, name, sha256, size, from }]; replace the libffmpeg.so row, keep the others
$manifestPath = Join-Path $OutDir 'runtime-manifest.json'
$rows = @()
if (Test-Path -LiteralPath $manifestPath) {
  $old = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($r in @($old)) { if ($r.apk -ne 'libffmpeg.so') { $rows += $r } }
}
$rows += [pscustomobject]@{ apk = 'libffmpeg.so'; name = 'ffmpeg'; sha256 = $sha; size = $size; from = 'build-ffmpeg-android' }
$json = ConvertTo-Json -InputObject @($rows) -Depth 5
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host "SIAP: $bin"
Write-Host "sha256 $sha  saiz $size"
