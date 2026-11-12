<#
.SYNOPSIS
  MAXCOM box: go back to the previous release (or to a named one) and, if asked, put back the database
  that was saved before the upgrade. Windows PowerShell 5.1, ASCII only, built-ins only.

.DESCRIPTION
  switch-release.ps1 -InstallRoot <root> (-Previous | -Version <v>) [-RestoreDb] [-Yes] [-LayoutOnly] [-DryRun]

  Stops the task "MAXCOM Box" (and the processes that run from the install root, by PID), points
  <root>\current at the release (it must have .ok; previous.txt then holds the release left behind),
  starts the task again and runs doctor.ps1.
  -RestoreDb  puts back backups\pre-<current version>-<stamp>\surau.db (the newest one). The database in
              use is first moved beside it as surau.db.replaced-<stamp> (with its -wal and -shm), never
              deleted. Everything entered since the upgrade is lost with this switch, so it asks for y.
  -LayoutOnly files and junctions only, in any folder, no elevation, no task, no doctor (for tests).
  -DryRun     prints the plan and changes nothing.
  Nothing here deletes anything.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [switch]$Previous,
  [string]$Version = '',
  [switch]$RestoreDb,
  [switch]$Yes,
  [switch]$LayoutOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSScriptRoot 'MaxcomSetup.psm1') -Force

function Stop-Here([string]$Text) {
  Write-Host "GAGAL: $Text"
  exit 1
}

function Test-Inside([string]$Child, [string]$Parent) {
  $c = (ConvertTo-FullPath $Child).TrimEnd('\') + '\'
  $p = (ConvertTo-FullPath $Parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

try {
  Set-Location -LiteralPath $env:TEMP
  [System.Environment]::CurrentDirectory = $env:TEMP
} catch { }

# --- 0. check everything before anything is changed ------------------------------------------------
if ($Previous -and $Version -ne '') { Stop-Here 'pilih -Previous atau -Version, bukan kedua-duanya.' }
if (-not $Previous -and $Version -eq '') { Stop-Here 'perlukan -Previous atau -Version <versi>.' }
if ($Version -ne '' -and $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Stop-Here "versi tidak sah: $Version" }

if ($InstallRoot -eq '') { $InstallRoot = Join-Path $env:ProgramFiles 'MAXCOM' }
$relaxed = ($LayoutOnly -or $DryRun)
try { $rootProblems = @(Get-InstallRootProblem $InstallRoot -AllowUserProfile:$relaxed) } catch { Stop-Here $_.Exception.Message }
if ($rootProblems.Count -gt 0) { Stop-Here ($rootProblems -join '; ') }
$root = ConvertTo-FullPath $InstallRoot
$stateDir = Join-Path $root 'state'
$stateFile = Join-Path $stateDir 'install.json'
$launcher = Join-Path $root 'launcher.mjs'
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  Stop-Here "$root bukan pemasangan MAXCOM (state\install.json atau launcher.mjs tiada). Tiada apa yang diubah."
}
if ((Test-IsReparsePoint $stateDir) -or (Test-IsReparsePoint $stateFile) -or (Test-IsReparsePoint $launcher)) {
  Stop-Here "state\install.json atau launcher.mjs ialah pautan: $root. Tiada apa yang diubah."
}

$cfgFile = Join-Path $root 'box-config.json'
$dataDir = ''
if (Test-Path -LiteralPath $cfgFile -PathType Leaf) {
  try {
    $cfg = [string](Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($null -ne $cfg.dataDir) { $dataDir = [string]$cfg.dataDir }
  } catch { Stop-Here 'box-config.json tidak sah. Tiada apa yang diubah.' }
}
if ($RestoreDb -and $dataDir -eq '') { Stop-Here 'box-config.json tidak menyebut folder data, -RestoreDb ditolak.' }
if ($dataDir -ne '') {
  try { $paths = Get-MaxcomPaths -InstallRoot $root -DataDir $dataDir } catch { Stop-Here $_.Exception.Message }
  if (Test-Inside $paths.DataDir $root) { Stop-Here 'folder data tidak boleh berada di dalam folder pemasangan.' }
  if (Test-IsReparsePoint $paths.DataDir) { Stop-Here "folder data ialah pautan: $($paths.DataDir)" }
} else {
  $paths = Get-MaxcomPaths -InstallRoot $root
}

# which release is current, which is the target
$currentVersion = $null
if (Test-IsReparsePoint $paths.Current) {
  $t = Get-LinkTarget $paths.Current
  if ($null -ne $t) {
    $leaf = Split-Path -Leaf $t
    if ($leaf -match '^[0-9]+\.[0-9]+\.[0-9]+$') { $currentVersion = $leaf }
  }
} elseif (Test-Path -LiteralPath $paths.Current) {
  Stop-Here "$($paths.Current) ialah folder sebenar, bukan pautan. Tiada apa yang diubah."
}
if ($Previous) {
  if (-not (Test-Path -LiteralPath $paths.PreviousTxt -PathType Leaf)) { Stop-Here 'previous.txt tiada: tiada keluaran sebelumnya untuk kembali. Tiada apa yang diubah.' }
  $Version = ([string](Get-Content -LiteralPath $paths.PreviousTxt -Raw -Encoding UTF8)).Trim()
  if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Stop-Here 'previous.txt tidak sah. Tiada apa yang diubah.' }
}
$target = Join-Path $paths.Releases $Version
if ((Test-IsReparsePoint $target) -or -not (Test-Path -LiteralPath $target -PathType Container)) {
  Stop-Here "keluaran $Version tiada di $($paths.Releases). Tiada apa yang diubah."
}
if (-not (Test-Path -LiteralPath (Join-Path $target '.ok') -PathType Leaf)) {
  Stop-Here "keluaran $Version belum lengkap (.ok tiada), tidak digunakan. Tiada apa yang diubah."
}
$already = ($null -ne $currentVersion -and $currentVersion -eq $Version)

# the saved database for the version we leave
$backupDb = $null
if ($RestoreDb) {
  if ($null -eq $currentVersion) { Stop-Here 'keluaran semasa tidak diketahui, -RestoreDb ditolak. Tiada apa yang diubah.' }
  if ($already) { Stop-Here "keluaran $Version sudah digunakan, -RestoreDb ditolak. Tiada apa yang diubah." }
  if ((Test-Path -LiteralPath $paths.Backups) -and -not (Test-IsReparsePoint $paths.Backups)) {
    $cands = @([System.IO.Directory]::GetDirectories($paths.Backups) |
      Where-Object { (Split-Path -Leaf $_).StartsWith("pre-$currentVersion-", [System.StringComparison]::Ordinal) -and -not (Test-IsReparsePoint $_) } |
      Sort-Object { Split-Path -Leaf $_ } -Descending)
    foreach ($c in $cands) {
      $f = Join-Path $c 'surau.db'
      if ((Test-Path -LiteralPath $f -PathType Leaf) -and -not (Test-IsReparsePoint $f)) { $backupDb = $f; break }
    }
  }
  if ($null -eq $backupDb) { Stop-Here "tiada salinan pangkalan data pre-$currentVersion-* dalam $($paths.Backups). Tiada apa yang diubah." }
}

if (-not $DryRun) {
  if (-not $LayoutOnly -and -not (Test-MaxcomElevated)) { Stop-Here 'perlukan Run as administrator. Tiada apa yang diubah.' }
  if (-not $already -and -not $Yes) {
    if ($RestoreDb) { Write-Host 'Semua yang dimasukkan sejak naik taraf akan HILANG kerana pangkalan data lama dipulihkan.' }
    Write-Host "Kembali ke keluaran $Version? (y/t)"
    try { $a = Read-Host } catch { $a = '' }
    if ([string]$a -cne 'y') { Write-Host 'Dibatalkan. Tiada apa yang diubah.'; exit 2 }
  }
}

# --- 1. the steps ----------------------------------------------------------------------------------
$script:taskDisabled = $false
try {
if (-not $LayoutOnly) {
  Invoke-Step -Name 'henti kotak' -DryRun:$DryRun -Describe 'henti tugas MAXCOM Box dan proses (ikut PID) yang dijalankan dari folder pemasangan' -Action {
    $changed = $false
    $t = Get-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -eq '\' }
    if ($null -ne $t) {
      # disabled first, so nothing (a trigger, restart-on-failure) starts the box again mid-swap
      $script:taskDisabled = $true
      Disable-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue
      $changed = $true
    }
    foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
      if ($null -eq $p.ExecutablePath -or $p.ExecutablePath -eq '' -or $p.ProcessId -eq $PID) { continue }
      if (-not (Test-Inside $p.ExecutablePath $root)) { continue }
      Write-Host ("  henti PID {0}: {1}" -f $p.ProcessId, $p.CommandLine)
      Stop-Process -Id ([int]$p.ProcessId) -Force
      $changed = $true
    }
    if ($changed) { Start-Sleep -Seconds 2 }
    $changed
  } | Out-Null
}

if ($RestoreDb) {
  Invoke-Step -Name 'pangkalan data' -DryRun:$DryRun -Describe "asingkan surau.db semasa (surau.db.replaced-<cap masa>) dan pulihkan $backupDb" -Action {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $db = $paths.Db
    $suffixes = @('', '-wal', '-shm')
    foreach ($s in $suffixes) {
      $cur = $db + $s
      if (Test-Path -LiteralPath $cur -PathType Leaf) {
        [System.IO.File]::Move($cur, ($db + '.replaced-' + $stamp + $s))
      }
    }
    foreach ($s in $suffixes) {
      $src = $backupDb + $s
      if (Test-Path -LiteralPath $src -PathType Leaf) { [System.IO.File]::Copy($src, ($db + $s), $false) }
    }
    if (-not (Test-Path -LiteralPath $db -PathType Leaf)) { throw 'surau.db tidak berjaya dipulihkan' }
    Write-Host "  pangkalan data lama disimpan di: $($db).replaced-$stamp"
    $true
  } | Out-Null
}

Invoke-Step -Name 'keluaran' -DryRun:$DryRun -Describe "tukar current ke $Version (dari $currentVersion); previous.txt menyimpan keluaran yang ditinggalkan" -Action {
  $r = Switch-Current -Root $root -Version $Version
  [bool]$r.Changed
} | Out-Null

if (-not $LayoutOnly) {
  Invoke-Step -Name 'mula kotak' -DryRun:$DryRun -Describe 'mula tugas MAXCOM Box dan jalankan doctor.ps1 -Wait 90' -Action {
    Enable-ScheduledTask -TaskName 'MAXCOM Box' | Out-Null
    $script:taskDisabled = $false
    Start-ScheduledTask -TaskName 'MAXCOM Box'
    $doctor = $null
    foreach ($d in @($PSScriptRoot, (Join-Path $root 'bin'))) {
      $c = Join-Path $d 'doctor.ps1'
      if (Test-Path -LiteralPath $c -PathType Leaf) { $doctor = $c; break }
    }
    if ($null -eq $doctor) { Write-Step 'LANGKAU' 'doctor' 'doctor.ps1 tiada, semakan tidak dijalankan'; return $true }
    $ps = Join-Path $PSHOME 'powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File $doctor -InstallRoot $root -Wait 90 | ForEach-Object { Write-Host "$_" }
    $doctorExit = $LASTEXITCODE
    if ($doctorExit -ne 0) { throw "doctor.ps1 melaporkan masalah (kod $doctorExit)" }
    $true
  } | Out-Null
}
} finally {
  # the box must never stay disabled, whatever failed above
  if ($script:taskDisabled) {
    try { Enable-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction Stop | Out-Null }
    catch { Write-Host 'AMARAN: tugas MAXCOM Box masih dilumpuhkan. Jalankan: Enable-ScheduledTask -TaskName "MAXCOM Box"' }
  }
}

if ($DryRun) { Write-Host 'DRYRUN selesai: tiada apa yang diubah.' }
else { Write-Host "Keluaran semasa: $Version" }
exit 0
