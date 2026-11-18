<#
.SYNOPSIS
  The only documented way to copy an installer to MAXCOM-Installers (Google Drive). Plan 14 Task 24.
.DESCRIPTION
  publish-installers.ps1 -File <installer> -DestDir <folder under the installers root>
  Refuses (exit 1, nothing copied):
    - a file under a folder named "secret" (the private MAXCOM Ops output lives in maxcom-work\secret\ops-builds),
    - a file named MAXCOM-Ops-*,
    - an .apk whose package id is not the public one (scripts\check-public-apk.mjs --kind),
    - an .apk that has any marker from apps\surau-app\ops-markers.txt (check-public-apk.mjs),
    - a destination outside the installers root (-InstallersRoot, default G:\My Drive\MAXCOM-Installers).
  A .sha256 file beside the installer is copied with it. The check runs BEFORE any copy.
  The release checklist (docs\HANDOFF.md) names this script; do not copy installers by hand.
#>
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$DestDir,
  [string]$InstallersRoot = 'G:\My Drive\MAXCOM-Installers'
)
$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "GAGAL: $m"; exit 1 }

if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Fail "fail tiada: $File" }
$src = (Resolve-Path -LiteralPath $File).Path
$name = Split-Path $src -Leaf

if ($src -match '(?i)[\\/]secret[\\/]') { Fail "fail berada di bawah folder 'secret' (peribadi): $src" }
if ($name -match '(?i)^MAXCOM-Ops-') { Fail "nama fail ialah binaan ops: $name" }

$dest = [System.IO.Path]::GetFullPath($DestDir)
$rootFull = [System.IO.Path]::GetFullPath($InstallersRoot).TrimEnd('\') + '\'
if (-not (($dest.TrimEnd('\') + '\').StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase))) {
  Fail "folder sasaran mesti di bawah $InstallersRoot"
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail 'node tiada pada PATH.' }
$checkScript = Join-Path $PSScriptRoot 'check-public-apk.mjs'

if ($name -match '(?i)\.apk$') {
  $kind = ((@(& $nodeCmd.Source $checkScript --kind $src)) -join '').Trim()
  if ($kind -ne 'public') { Fail "id pakej APK ialah '$kind', bukan awam (my.maxcom.app)." }
  $o = @(& $nodeCmd.Source $checkScript $src)
  $code = $LASTEXITCODE
  foreach ($l in $o) { Write-Host $l }
  if ($code -ne 0) { Fail 'APK mengandungi bahan ops. Tidak diterbitkan.' }
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item -LiteralPath $src -Destination (Join-Path $dest $name) -Force
$sha = "$src.sha256"
if (Test-Path -LiteralPath $sha -PathType Leaf) { Copy-Item -LiteralPath $sha -Destination (Join-Path $dest "$name.sha256") -Force }
Write-Host "Disalin: $(Join-Path $dest $name)"
exit 0
