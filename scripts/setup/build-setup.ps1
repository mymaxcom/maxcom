<#
.SYNOPSIS
  MAX Kiosk Server: builds the Windows box setup zip MAX-Kiosk-Server-Setup-<version>-windows.zip on the dev machine.
  Windows PowerShell 5.1.
.DESCRIPTION
  Wraps the release archive made by scripts\build-release.ps1 (maxcom-box-<version>-windows.tar.gz) with the
  pinned portable tools and the setup scripts into one folder and one zip:

    MAX-Kiosk-Server-Setup-<version>-windows\
      Pasang MAXCOM.cmd, PANDUAN PASANG.txt
      setup\     every script setup.ps1 copies to <root>\bin, launcher.mjs, start.cmd, cli.mjs, maxcom.cmd,
                 maxcom.ico (the MAX Kiosk Server icon),
                 release-pins.json (the pins file this build verified against)
      payload\   the release archive, node-v<ver>-win-x64.zip, mediamtx_<ver>_windows_amd64.zip, the ffmpeg zip
      licences\  Node LICENSE, MediaMTX LICENSE, the ffmpeg build licence text, ffmpeg-SOURCE.txt
      manifest.json   { v: 1, version, builtAt, files: [{ path, size, sha256 }] } (every file but itself)

  and writes <zip>.sha256 (one line: lower-case hex, two spaces, file name).

  Integrity: Node, MediaMTX and ffmpeg are fetched ONLY here, over HTTPS (TLS 1.2 or later), into the cache
  folder, and used ONLY when their sha256 equals the pin in release-pins.json. An empty pin stops the build
  (GAGAL: sha256 belum diisi untuk <name>). A cached file whose hash differs is deleted and the build stops
  (nothing is silently fetched again); a download whose hash differs is deleted and the build stops.
  On the target PC nothing is downloaded: setup.ps1 verifies every bundle file against manifest.json.

  The finished bundle folder is checked with Test-BundleManifest from MaxcomSetup.psm1 before the zip is made.
.PARAMETER Version     YYYY.MM.N, optional: defaults to versions.json kiosk-server-windows; if given it must equal it. The release archive in -ReleaseDir must be that version.
.PARAMETER ReleaseDir  Folder holding maxcom-box-<version>-windows.tar.gz (default <repo>\dist\release).
.PARAMETER CacheDir    Download cache (default <repo>\dist\release-cache).
.PARAMETER OutDir      Where the bundle folder, the zip and the .sha256 are written (default <repo>\dist\setup).
.PARAMETER PinsFile    release-pins.json to verify against (default <repo>\scripts\release-pins.json). The file is
                       copied into the bundle as setup\release-pins.json.
.PARAMETER RepoRoot    Test hook: take scripts and guide from another checkout (default: two folders above this script).
.PARAMETER DryRun      Lists the bundle files and the state of each pin; downloads, writes and deletes nothing.
#>
param(
  [string]$Version = '',
  [string]$ReleaseDir = '',
  [string]$CacheDir = '',
  [string]$OutDir = '',
  [string]$PinsFile = '',
  [string]$RepoRoot = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
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

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

function Get-Sha256Of([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Walks a folder WITHOUT descending into reparse points.
function Get-TreeEntries([string]$dir) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push((New-Object System.IO.DirectoryInfo($dir)))
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in $d.GetFileSystemInfos()) {
      $isReparse = (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
      $isDir = (($e.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
      [void]$out.Add([pscustomobject]@{ Path = $e.FullName; IsReparse = $isReparse; IsDir = $isDir })
      if ($isDir -and -not $isReparse) { $stack.Push($e) }
    }
  }
  return $out
}

# Removes a folder; links are removed as links first (never followed), then the real content.
function Remove-TreeSafe([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  foreach ($e in @(Get-TreeEntries $dir | Where-Object { $_.IsReparse })) {
    if ($e.IsDir) { [System.IO.Directory]::Delete($e.Path, $false) } else { [System.IO.File]::Delete($e.Path) }
  }
  Remove-Item -LiteralPath $dir -Recurse -Force
}

function Test-AsciiFile([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  foreach ($b in $bytes) { if ($b -gt 127) { return $false } }
  return $true
}

function Get-ZipNameFromUrl([string]$url) {
  $n = ([Uri]$url).Segments[-1]
  if ($n -notmatch '^[A-Za-z0-9._-]+\.zip$') { Fail "nama fail zip tidak sah dalam pin: $n" }
  return $n
}

# The ONE download function. Whatever it fetches is hashed by Get-PinnedFile before any use.
function Receive-HttpsFile([string]$url, [string]$dest) {
  if ($url -notmatch '^https://') { Fail "url mesti bermula dengan https://: $url" }
  $tls = [System.Net.SecurityProtocolType]::Tls12
  try { $tls = $tls -bor [System.Net.SecurityProtocolType]'Tls13' } catch { }
  [System.Net.ServicePointManager]::SecurityProtocol = $tls
  $old = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    $r = Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -MaximumRedirection 5 -PassThru
    if ($r.BaseResponse.ResponseUri.Scheme -ne 'https') { Fail "lencongan keluar dari https: $url" }
  } finally { $ProgressPreference = $old }
}

# Returns the path of a cached file whose sha256 equals the pin. Never returns anything unverified.
function Get-PinnedFile([string]$name, $entry, [string]$cacheDir) {
  $zipName = Get-ZipNameFromUrl ([string]$entry.url)
  $want = ([string]$entry.sha256).ToLowerInvariant()
  $path = Join-Path $cacheDir $zipName
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $got = Get-Sha256Of $path
    if ($got -eq $want) { Write-Host "OK $name : fail dalam cache sah ($zipName)"; return $path }
    Remove-Item -LiteralPath $path -Force
    Fail "sha256 fail cache $zipName tidak sama dengan pin untuk $name (dapat $got); fail cache dipadam, jalankan semula untuk muat turun baharu"
  }
  [void][System.IO.Directory]::CreateDirectory($cacheDir)
  $part = "$path.part"
  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  Write-Host "SET $name : muat turun $($entry.url)"
  try {
    Receive-HttpsFile ([string]$entry.url) $part
  } catch {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    Fail "muat turun $name gagal: $($_.Exception.Message)"
  }
  $got = Get-Sha256Of $part
  if ($got -ne $want) {
    Remove-Item -LiteralPath $part -Force
    Fail "sha256 muat turun $name tidak sama dengan pin (dapat $got, pin $want); fail dipadam"
  }
  Move-Item -LiteralPath $part -Destination $path
  return $path
}

# Copies the one zip entry whose full name matches the (case-sensitive) pattern to a fixed destination.
function Copy-ZipEntry([string]$zip, [string]$pattern, [string]$dest, [string]$what) {
  $arch = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $hit = @($arch.Entries | Where-Object { $_.FullName -cmatch $pattern })
    if ($hit.Count -ne 1) { Fail "teks lesen $what tiada (atau lebih daripada satu) dalam $(Split-Path -Leaf $zip)" }
    if ($hit[0].Length -gt 2MB) { Fail "teks lesen $what terlalu besar" }
    $in = $hit[0].Open()
    try {
      $out = [System.IO.File]::Create($dest)
      try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
  } finally { $arch.Dispose() }
}

# ---------------------------------------------------------------------------------------------
# Parameters and pins (checked before anything is built or downloaded)
# ---------------------------------------------------------------------------------------------

if ($RepoRoot -eq '') { $RepoRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.' }
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { Fail "RepoRoot tiada: $RepoRoot" }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')
$Version = Resolve-ProductVersion 'kiosk-server-windows' $Version $repo
if ($ReleaseDir -eq '') { $ReleaseDir = Join-Path $repo 'dist\release' }
if ($CacheDir -eq '') { $CacheDir = Join-Path $repo 'dist\release-cache' }
if ($OutDir -eq '') { $OutDir = Join-Path $repo 'dist\setup' }
if ($PinsFile -eq '') { $PinsFile = Join-Path $repo 'scripts\release-pins.json' }
$ReleaseDir = [System.IO.Path]::GetFullPath($ReleaseDir)
$CacheDir = [System.IO.Path]::GetFullPath($CacheDir)
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$PinsFile = [System.IO.Path]::GetFullPath($PinsFile)

if (-not (Test-Path -LiteralPath $PinsFile -PathType Leaf)) { Fail "release-pins.json tiada: $PinsFile" }
try { $pins = Get-Content -LiteralPath $PinsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'release-pins.json bukan JSON yang sah.' }

$missingSha = New-Object System.Collections.ArrayList
$zipNames = @{}
foreach ($n in 'node', 'mediamtx', 'ffmpeg') {
  $e = $pins.$n
  if ($null -eq $e) { Fail "$n tiada dalam release-pins.json" }
  if ([string]$e.url -notmatch '^https://') { Fail "url $n dalam release-pins.json mesti bermula dengan https://" }
  if ([string]$e.version -eq '') { Fail "versi $n tiada dalam release-pins.json" }
  $zipNames[$n] = Get-ZipNameFromUrl ([string]$e.url)
  $sha = [string]$e.sha256
  if ($sha -eq '') { [void]$missingSha.Add($n) }
  elseif ($sha -notmatch '^[0-9a-fA-F]{64}$') { Fail "sha256 $n dalam release-pins.json bukan hex 64 aksara" }
}
# The names setup.ps1 and install-live-tools.ps1 look for in payload\
if ($zipNames['node'] -ne "node-v$($pins.node.version)-win-x64.zip") { Fail "nama zip Node dalam pin ($($zipNames['node'])) bukan node-v<versi>-win-x64.zip" }
$mtxVer = [string]$pins.mediamtx.version
if ($mtxVer -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { Fail "versi mediamtx dalam pin mesti seperti v1.21.3, diberi: $mtxVer" }
if ($zipNames['mediamtx'] -ne "mediamtx_${mtxVer}_windows_amd64.zip") { Fail "nama zip MediaMTX dalam pin ($($zipNames['mediamtx'])) bukan mediamtx_<versi>_windows_amd64.zip" }

$topName = "MAX-Kiosk-Server-Setup-$Version-windows"
$archiveName = "maxcom-box-$Version-windows.tar.gz"

# ---------------------------------------------------------------------------------------------
# Bundle plan: [path inside the bundle, source file]
# ---------------------------------------------------------------------------------------------

$setupSrc = Join-Path $repo 'scripts\setup'
$scriptsSrc = Join-Path $repo 'scripts'
$updateSrc = Join-Path $repo 'apps\box-server\src\update'
$plan = New-Object System.Collections.ArrayList
function Add-Plan([string]$rel, [string]$src) { [void]$plan.Add([pscustomobject]@{ Rel = $rel; Src = $src }) }

Add-Plan 'Pasang MAXCOM.cmd' (Join-Path $setupSrc 'Pasang MAXCOM.cmd')
Add-Plan 'PANDUAN PASANG.txt' (Join-Path $repo 'scripts\setup\PANDUAN-PASANG.md')
foreach ($n in 'setup.ps1', 'MaxcomSetup.psm1', 'doctor.ps1', 'uninstall.ps1', 'switch-release.ps1', 'migrate-data.ps1',
  'install-kiosk-task.ps1', 'start-kiosk.ps1', 'set-box-power.ps1', 'Semak MAXCOM.cmd', 'Buang MAXCOM.cmd') {
  Add-Plan "setup/$n" (Join-Path $setupSrc $n)
}
foreach ($n in 'box-ca.ps1', 'box-cert-renew.ps1', 'install-cert-renew-task.ps1', 'install-box-task.ps1',
  'ensure-box-firewall.ps1', 'ensure-live-firewall.ps1', 'install-live-tools.ps1') {
  Add-Plan "setup/$n" (Join-Path $scriptsSrc $n)
}
foreach ($n in 'launcher.mjs', 'start.cmd', 'cli.mjs', 'maxcom.cmd') { Add-Plan "setup/$n" (Join-Path $updateSrc $n) }
Add-Plan 'setup/release-pins.json' $PinsFile
Add-Plan 'setup/maxcom.ico' (Join-Path $repo 'branding\maxcom\maxcom.ico')
Add-Plan "payload/$archiveName" (Join-Path $ReleaseDir $archiveName)
foreach ($n in 'node', 'mediamtx', 'ffmpeg') { Add-Plan "payload/$($zipNames[$n])" (Join-Path $CacheDir $zipNames[$n]) }
foreach ($l in 'node-LICENSE.txt', 'mediamtx-LICENSE.txt', 'ffmpeg-LICENSE.txt', 'ffmpeg-SOURCE.txt') { Add-Plan "licences/$l" '(dibuat semasa binaan)' }
Add-Plan 'manifest.json' '(dibuat semasa binaan)'

if ($DryRun) {
  Write-Host "DRYRUN bundle  : $topName"
  Write-Host "DRYRUN zip     : $(Join-Path $OutDir "$topName.zip")"
  foreach ($p in $plan) { Write-Host "DRYRUN fail    : $($p.Rel)  <-  $($p.Src)" }
  foreach ($n in 'node', 'mediamtx', 'ffmpeg') {
    if ($missingSha -contains $n) { Write-Host "DRYRUN PERHATIAN: sha256 belum diisi untuk $n (binaan sebenar akan gagal)" }
    else { Write-Host "DRYRUN pin $n  : $($zipNames[$n]) sha256 diisi" }
  }
  Write-Host 'DRYRUN: tiada apa dimuat turun, ditulis atau dipadam.'
  exit 0
}

if ($missingSha.Count -gt 0) { Fail "sha256 belum diisi untuk $($missingSha[0])" }

# ---------------------------------------------------------------------------------------------
# Source files: present, scripts ASCII
# ---------------------------------------------------------------------------------------------

foreach ($p in $plan) {
  if ($p.Src -eq '(dibuat semasa binaan)') { continue }
  if ($p.Rel.StartsWith('payload/') -and $p.Rel -ne "payload/$archiveName") { continue } # tools: from the cache below
  if (-not (Test-Path -LiteralPath $p.Src -PathType Leaf)) { Fail "fail diperlukan tiada: $($p.Src)" }
  if ($p.Rel -match '\.(ps1|psm1|mjs|cmd|json)$' -and -not (Test-AsciiFile $p.Src)) { Fail "fail bukan ASCII sahaja: $($p.Src)" }
}
$archiveSrc = Join-Path $ReleaseDir $archiveName
if ((Get-Item -LiteralPath $archiveSrc).Length -eq 0) { Fail "arkib keluaran kosong: $archiveSrc" }

# the archive must be the one for this version: release.json at its root says so
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { Fail "tar.exe tiada di $tar" }
$rj = $null
foreach ($entryName in 'release.json', './release.json') {
  $txt = (& $tar -xzOf $archiveSrc $entryName 2>$null | Out-String)
  if ($LASTEXITCODE -eq 0 -and $txt.Trim() -ne '') { $rj = $txt; break }
}
if ($null -eq $rj) { Fail "release.json tiada di akar $archiveName" }
try { $rel = $rj | ConvertFrom-Json } catch { Fail "release.json dalam $archiveName bukan JSON yang sah" }
if ([string]$rel.version -ne $Version) { Fail "release.json dalam arkib berversi '$($rel.version)', bukan $Version" }

# ---------------------------------------------------------------------------------------------
# Pinned tools: verified before use
# ---------------------------------------------------------------------------------------------

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$toolFile = @{}
foreach ($n in 'node', 'mediamtx', 'ffmpeg') { $toolFile[$n] = Get-PinnedFile $n $pins.$n $CacheDir }

# ---------------------------------------------------------------------------------------------
# Assemble the bundle folder
# ---------------------------------------------------------------------------------------------

[void][System.IO.Directory]::CreateDirectory($OutDir)
$bundle = Join-Path $OutDir $topName
if (Test-Path -LiteralPath $bundle) { Remove-TreeSafe $bundle }
[void][System.IO.Directory]::CreateDirectory($bundle)

function Copy-IntoBundle([string]$rel, [string]$src) {
  $dst = Join-Path $bundle ($rel -replace '/', '\')
  [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dst))
  [System.IO.File]::Copy($src, $dst, $true)
}

foreach ($p in $plan) {
  if ($p.Src -eq '(dibuat semasa binaan)') { continue }
  if ($p.Rel.StartsWith('payload/') -and $p.Rel -ne "payload/$archiveName") { continue }
  Copy-IntoBundle $p.Rel $p.Src
}
foreach ($n in 'node', 'mediamtx', 'ffmpeg') { Copy-IntoBundle "payload/$($zipNames[$n])" $toolFile[$n] }

$licDir = Join-Path $bundle 'licences'
[void][System.IO.Directory]::CreateDirectory($licDir)
Copy-ZipEntry $toolFile['node'] '^node-v[0-9][A-Za-z0-9.-]*-win-x64/LICENSE$' (Join-Path $licDir 'node-LICENSE.txt') 'Node'
Copy-ZipEntry $toolFile['mediamtx'] '^LICENSE$' (Join-Path $licDir 'mediamtx-LICENSE.txt') 'MediaMTX'
Copy-ZipEntry $toolFile['ffmpeg'] '^[^/]+/LICENSE(\.txt)?$' (Join-Path $licDir 'ffmpeg-LICENSE.txt') 'ffmpeg'

$ffUri = [Uri][string]$pins.ffmpeg.url
$ffHome = 'https://' + $ffUri.Host
if ($ffUri.Segments.Count -ge 3) { $ffHome = 'https://' + $ffUri.Host + $ffUri.Segments[0] + $ffUri.Segments[1] + $ffUri.Segments[2].TrimEnd('/') }
$srcLines = @(
  'ffmpeg shipped with MAX Kiosk Server (payload\' + $zipNames['ffmpeg'] + ')',
  '',
  'Version  : ' + [string]$pins.ffmpeg.version,
  'Licence  : ' + [string]$pins.ffmpeg.licence,
  'Download : ' + [string]$pins.ffmpeg.url,
  'Build by : ' + $ffHome + ' (build recipes and the exact FFmpeg source revision are published there)',
  'FFmpeg   : https://ffmpeg.org/ (source code: https://git.ffmpeg.org/ffmpeg.git)',
  '',
  'The full licence text of this build is in ffmpeg-LICENSE.txt. MAXCOM runs ffmpeg as a separate program',
  'and does not link it. The source code of the build is available from the locations above.'
)
[System.IO.File]::WriteAllText((Join-Path $licDir 'ffmpeg-SOURCE.txt'), (($srcLines -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))

# manifest.json: every file but itself, forward slashes, sorted
$files = New-Object System.Collections.ArrayList
$bundleFull = (Resolve-Path -LiteralPath $bundle).Path.TrimEnd('\')
foreach ($e in (Get-TreeEntries $bundleFull)) {
  if ($e.IsReparse) { Fail "pautan dalam bundle: $($e.Path)" }
  if ($e.IsDir) { continue }
  $rel2 = $e.Path.Substring($bundleFull.Length + 1).Replace('\', '/')
  [void]$files.Add([pscustomobject]@{ path = $rel2; size = [int64](Get-Item -LiteralPath $e.Path -Force).Length; sha256 = (Get-Sha256Of $e.Path) })
}
$sorted = @($files | Sort-Object -Property @{ Expression = { $_.path } } -CaseSensitive)
$ordered = New-Object System.Collections.ArrayList
$paths = @($sorted | ForEach-Object { $_.path })
[Array]::Sort($paths, [System.StringComparer]::Ordinal)
foreach ($pth in $paths) { [void]$ordered.Add(($sorted | Where-Object { $_.path -ceq $pth } | Select-Object -First 1)) }
$manifest = [ordered]@{
  v = 1
  version = $Version
  builtAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  files = $ordered.ToArray()
}
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $bundle 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

# self-check with the same function setup.ps1 uses on the target PC
$psm = Join-Path $PSScriptRoot 'MaxcomSetup.psm1'
if (-not (Test-Path -LiteralPath $psm -PathType Leaf)) { Fail "MaxcomSetup.psm1 tiada di $psm" }
Import-Module -Name $psm -Force
$probs = @(Get-BundleManifestProblem $bundleFull)
if ($probs.Count -gt 0) { Fail "bundle tidak lulus semakan manifest: $($probs[0])" }
Write-Host "OK manifest: $($ordered.Count) fail disemak (saiz dan sha256)"

# ---------------------------------------------------------------------------------------------
# Zip (forward-slash entry names, no links, one top folder) and checksum
# ---------------------------------------------------------------------------------------------

$zipPath = Join-Path $OutDir "$topName.zip"
$tmpZip = "$zipPath.part"
if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force }
$fs = [System.IO.File]::Open($tmpZip, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    $all = @($ordered | ForEach-Object { $_.path }) + @('manifest.json')
    foreach ($rel3 in $all) {
      $lvl = [System.IO.Compression.CompressionLevel]::Optimal
      if ($rel3.StartsWith('payload/')) { $lvl = [System.IO.Compression.CompressionLevel]::NoCompression }
      $ent = $za.CreateEntry("$topName/$rel3", $lvl)
      $es = $ent.Open()
      try {
        $in = [System.IO.File]::OpenRead((Join-Path $bundleFull ($rel3 -replace '/', '\')))
        try { $in.CopyTo($es) } finally { $in.Dispose() }
      } finally { $es.Dispose() }
    }
  } finally { $za.Dispose() }
} finally { $fs.Dispose() }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Move-Item -LiteralPath $tmpZip -Destination $zipPath

$zipHash = Get-Sha256Of $zipPath
$zipSize = (Get-Item -LiteralPath $zipPath).Length
$shaFile = "$zipPath.sha256"
[System.IO.File]::WriteAllText($shaFile, "$zipHash  $topName.zip`n", (New-Object System.Text.ASCIIEncoding))

Write-Host "OK bundle : $bundle"
Write-Host "OK zip    : $zipPath"
Write-Host "sha256 $zipHash size $zipSize"
exit 0
