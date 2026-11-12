<#
.SYNOPSIS
  MAX Kiosk Server: builds MAX-Kiosk-Server-Setup-<version>-windows.exe (Inno Setup 6) from the bundle folder made by build-setup.ps1.
  Windows PowerShell 5.1.
.DESCRIPTION
  The exe carries the whole bundle folder and runs setup\setup.ps1 from it (see maxcom-setup.iss). The bundle folder
  MAX-Kiosk-Server-Setup-<version>-windows must already exist in -SetupDir (run build-setup.ps1 first). It is checked with
  Test-BundleManifest from MaxcomSetup.psm1 before compiling. After the compile, <exe>.sha256 is written
  (one line: lower-case hex, two spaces, file name).
.PARAMETER Version   YYYY.MM.N, optional: defaults to versions.json kiosk-server-windows; if given it must equal it (same as build-setup.ps1).
.PARAMETER SetupDir  Folder holding the bundle folder; the exe and .sha256 are written here (default <repo>\dist\setup).
.PARAMETER Iscc      Path of ISCC.exe (default: Inno Setup 6 under %LOCALAPPDATA%\Programs, then Program Files (x86)).
.PARAMETER IconFile  The .ico for the setup exe (default <repo>\branding\maxcom\maxcom.ico; made by scripts\make-icons.mjs).
.PARAMETER DryRun    Shows what would be compiled; compiles and writes nothing.
#>
param(
  [string]$Version = '',
  [string]$SetupDir = '',
  [string]$Iscc = '',
  [string]$IconFile = '',
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

function Get-Sha256Of([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

$repo = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.')).Path.TrimEnd('\')
$Version = Resolve-ProductVersion 'kiosk-server-windows' $Version $repo
if ($SetupDir -eq '') { $SetupDir = Join-Path $repo 'dist\setup' }
$SetupDir = [System.IO.Path]::GetFullPath($SetupDir)

if ($IconFile -eq '') { $IconFile = Join-Path $repo 'branding\maxcom\maxcom.ico' }
$IconFile = [System.IO.Path]::GetFullPath($IconFile)
if (-not (Test-Path -LiteralPath $IconFile -PathType Leaf)) { Fail "ikon tiada: $IconFile (jalankan node scripts\make-icons.mjs atau beri -IconFile)" }

$topName = "MAX-Kiosk-Server-Setup-$Version-windows"
$bundle = Join-Path $SetupDir $topName
$exePath = Join-Path $SetupDir "$topName.exe"
$issPath = Join-Path $PSScriptRoot 'maxcom-setup.iss'
$psm = Join-Path $PSScriptRoot 'MaxcomSetup.psm1'

if (-not (Test-Path -LiteralPath $issPath -PathType Leaf)) { Fail "maxcom-setup.iss tiada di $issPath" }
if (-not (Test-Path -LiteralPath $psm -PathType Leaf)) { Fail "MaxcomSetup.psm1 tiada di $psm" }

if ($Iscc -eq '') {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
  )
  foreach ($c in $cands) { if (Test-Path -LiteralPath $c -PathType Leaf) { $Iscc = $c; break } }
  if ($Iscc -eq '') { Fail 'ISCC.exe (Inno Setup 6) tidak dijumpai. Pasang Inno Setup 6 atau beri -Iscc <laluan>.' }
}
if (-not (Test-Path -LiteralPath $Iscc -PathType Leaf)) { Fail "ISCC.exe tiada di $Iscc" }

if (-not (Test-Path -LiteralPath $bundle -PathType Container)) { Fail "folder bundle tiada: $bundle (jalankan build-setup.ps1 dahulu)" }
if (-not (Test-Path -LiteralPath (Join-Path $bundle 'manifest.json') -PathType Leaf)) { Fail "manifest.json tiada dalam $bundle (bundle belum siap; jalankan build-setup.ps1 dahulu)" }

if ($DryRun) {
  Write-Host "DRYRUN iscc    : $Iscc"
  Write-Host "DRYRUN skrip   : $issPath"
  Write-Host "DRYRUN bundle  : $bundle"
  Write-Host "DRYRUN ikon    : $IconFile"
  Write-Host "DRYRUN exe     : $exePath"
  Write-Host "DRYRUN sha256  : $exePath.sha256"
  Write-Host 'DRYRUN: tiada apa dikompil, ditulis atau dipadam.'
  exit 0
}

Import-Module -Name $psm -Force
if (-not (Test-BundleManifest $bundle)) {
  $probs = @(Get-BundleManifestProblem $bundle)
  $first = 'tidak diketahui'
  if ($probs.Count -gt 0) { $first = [string]$probs[0] }
  Fail "bundle tidak lulus semakan manifest: $first"
}
Write-Host 'OK manifest bundle disemak (saiz dan sha256)'

if (Test-Path -LiteralPath $exePath) { Remove-Item -LiteralPath $exePath -Force }
$isccArgs = @(
  "/DMyVersion=$Version",
  "/DBundleDir=$bundle",
  "/DOutDir=$SetupDir",
  "/DOutBase=$topName",
  "/DIconFile=$IconFile",
  $issPath
)
& $Iscc @isccArgs | Out-Host
if ($LASTEXITCODE -ne 0) { Fail "ISCC gagal dengan kod $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { Fail "ISCC selesai tetapi exe tiada: $exePath" }

$hash = Get-Sha256Of $exePath
$size = (Get-Item -LiteralPath $exePath).Length
[System.IO.File]::WriteAllText("$exePath.sha256", "$hash  $topName.exe`n", (New-Object System.Text.ASCIIEncoding))

Write-Host "OK exe    : $exePath"
Write-Host "sha256 $hash size $size"
exit 0
