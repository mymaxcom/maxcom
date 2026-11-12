<#
.SYNOPSIS
  MAXCOM: make a dedicated box PC stay awake on mains power, and put the old values back later.
  Windows PowerShell 5.1.

.DESCRIPTION
  -Apply  records the current MAINS (AC) values of the active power plan to -StateFile, once (an existing
          state file is kept, so a re-run never records the changed values as the originals), then sets on
          mains power: sleep never, hibernate never, screen never off, lid close does nothing.
  -Restore puts the recorded values back and removes the state file. A missing state file is a clean no-op.
  Battery (DC) values are never touched.

.PARAMETER Apply      Record and change.
.PARAMETER Restore    Put the recorded values back.
.PARAMETER StateFile  Where the original values are kept (for example <root>\state\power-before.json).
.PARAMETER DryRun     Print what would be changed; write and change nothing.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Restore,
  [string]$StateFile = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (($Apply -and $Restore) -or (-not $Apply -and -not $Restore)) {
  throw 'GAGAL: pilih tepat satu: -Apply atau -Restore. (choose exactly one of -Apply or -Restore)'
}
if ($StateFile -eq '') { throw 'GAGAL: -StateFile diperlukan. (-StateFile is required.)' }
$state = [System.IO.Path]::GetFullPath($StateFile)

# name, subgroup alias, setting alias, powercfg /change switch ('' = none)
$settings = @(
  @{ Name = 'standby';   Sub = 'SUB_SLEEP';   Set = 'STANDBYIDLE';   Change = 'standby-timeout-ac';   Label = 'tidur (sleep)' },
  @{ Name = 'hibernate'; Sub = 'SUB_SLEEP';   Set = 'HIBERNATEIDLE'; Change = 'hibernate-timeout-ac'; Label = 'hibernate' },
  @{ Name = 'monitor';   Sub = 'SUB_VIDEO';   Set = 'VIDEOIDLE';     Change = 'monitor-timeout-ac';   Label = 'skrin padam (monitor)' },
  @{ Name = 'lid';       Sub = 'SUB_BUTTONS'; Set = 'LIDACTION';     Change = '';                     Label = 'tutup penutup (lid)' }
)

function Get-ActiveScheme {
  $out = (& powercfg.exe /getactivescheme) -join "`n"
  if ($out -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { return $Matches[1].ToLowerInvariant() }
  throw 'GAGAL: pelan kuasa aktif tidak dapat dibaca. (cannot read the active power plan)'
}

function Get-AcValue([string]$Scheme, [string]$Sub, [string]$Set) {
  # $null when the PC does not have this setting (for example no lid).
  try {
    $out = (& powercfg.exe /query $Scheme $Sub $Set) -join "`n"
    if ($LASTEXITCODE -ne 0) { return $null }
    if ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt64($Matches[1], 16) }
  } catch { }
  return $null
}

function Set-AcValue([string]$Scheme, [string]$Sub, [string]$Set, [long]$Value) {
  & powercfg.exe /setacvalueindex $Scheme $Sub $Set $Value
  if ($LASTEXITCODE -ne 0) { throw "GAGAL: powercfg /setacvalueindex $Sub $Set gagal (kod $LASTEXITCODE)." }
}

function Enable-Scheme([string]$Scheme) {
  & powercfg.exe /setactive $Scheme
  if ($LASTEXITCODE -ne 0) { throw "GAGAL: powercfg /setactive gagal (kod $LASTEXITCODE)." }
}

if ($Apply) {
  $scheme = Get-ActiveScheme
  $keep = Test-Path -LiteralPath $state
  $current = @{}
  foreach ($s in $settings) { $current[$s.Name] = Get-AcValue $scheme $s.Sub $s.Set }

  if ($DryRun) {
    if ($keep) { Write-Output "DRYRUN state file exists, originals kept: $state" } else { Write-Output "DRYRUN would record the current values to $state" }
    foreach ($s in $settings) {
      $was = $current[$s.Name]; if ($null -eq $was) { $was = 'tiada (n/a)' }
      if ($s.Change -ne '') {
        Write-Output ("DRYRUN powercfg /change {0} 0   ({1}, now {2})" -f $s.Change, $s.Label, $was)
      } else {
        Write-Output ("DRYRUN powercfg /setacvalueindex {0} {1} {2} 0   ({3}, now {4})" -f $scheme, $s.Sub, $s.Set, $s.Label, $was)
      }
    }
    exit 0
  }

  if (-not $keep) {
    $dir = Split-Path -Parent $state
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $rec = [ordered]@{ v = 1; scheme = $scheme; saved = (Get-Date).ToString('s'); ac = [ordered]@{} }
    foreach ($s in $settings) { $rec.ac[$s.Name] = $current[$s.Name] }
    [System.IO.File]::WriteAllText($state, ($rec | ConvertTo-Json -Depth 4), (New-Object System.Text.ASCIIEncoding))
    Write-Output "Nilai kuasa asal disimpan: $state"
  } else {
    Write-Output "Nilai kuasa asal sudah disimpan sebelum ini; tidak ditulis semula: $state"
  }

  foreach ($s in $settings) {
    if ($null -eq $current[$s.Name]) { Write-Output "Dilangkau (tiada pada PC ini): $($s.Label)"; continue }
    if ($s.Change -ne '') {
      & powercfg.exe /change $s.Change 0
      if ($LASTEXITCODE -ne 0) { throw "GAGAL: powercfg /change $($s.Change) gagal (kod $LASTEXITCODE)." }
    } else {
      Set-AcValue $scheme $s.Sub $s.Set 0
    }
  }
  Enable-Scheme $scheme
  Write-Output 'Kuasa: tidur, hibernate, skrin padam dan penutup tidak lagi menidurkan PC ini (kuasa elektrik sahaja).'
  exit 0
}

# -Restore
if (-not (Test-Path -LiteralPath $state)) {
  Write-Output "Tiada fail keadaan kuasa ($state); tiada apa dipulihkan."
  exit 0
}
$rec = (Get-Content -LiteralPath $state -Raw) | ConvertFrom-Json
$schemeRec = [string]$rec.scheme
if ($schemeRec -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  throw "GAGAL: fail keadaan kuasa rosak (pelan tidak sah): $state (state file is damaged)"
}
$todo = @()
foreach ($s in $settings) {
  $v = $rec.ac.($s.Name)
  if ($null -eq $v) { continue }
  if ($v -isnot [int] -and $v -isnot [long] -and $v -isnot [double]) { throw "GAGAL: nilai tidak sah untuk $($s.Name) dalam $state (invalid value)" }
  if ($v -lt 0 -or $v -gt 4294967295) { throw "GAGAL: nilai di luar julat untuk $($s.Name) dalam $state (out of range)" }
  $todo += @{ S = $s; V = [long]$v }
}
if ($DryRun) {
  foreach ($t in $todo) {
    Write-Output ("DRYRUN powercfg /setacvalueindex {0} {1} {2} {3}   ({4})" -f $schemeRec, $t.S.Sub, $t.S.Set, $t.V, $t.S.Label)
  }
  Write-Output "DRYRUN would remove $state"
  exit 0
}
foreach ($t in $todo) { Set-AcValue $schemeRec $t.S.Sub $t.S.Set $t.V }
& powercfg.exe /setactive $schemeRec
if ($LASTEXITCODE -ne 0) { Write-Output 'Amaran: pelan kuasa asal tidak dapat diaktifkan semula (mungkin sudah dibuang); nilai tetap dipulihkan.' }
Remove-Item -LiteralPath $state -Force
Write-Output 'Tetapan kuasa dipulihkan kepada nilai asal.'
