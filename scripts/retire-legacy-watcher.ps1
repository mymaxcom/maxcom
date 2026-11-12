<#
.SYNOPSIS
  MAXCOM: retire a previous installation's YouTube watcher (scheduled task and folder).
  Windows PowerShell 5.1.

.DESCRIPTION
  The previous kiosk installation on the box ran a YouTube watcher as a scheduled task with its own
  folder. This script retires exactly the one task and the one folder that YOU name; nothing is
  guessed, nothing is searched for, no wildcard is accepted.

  Dry run is the default: it prints what it would do and changes nothing. With -Apply it:
    1. exports the task XML to <Folder>\..\retired-<date>\task.xml
    2. disables the task, then deletes it
    3. moves the folder to <Folder>\..\retired-<date>\<folder name>
    4. writes <Folder>\..\retired-<date>\sha256sums.txt with the hash of every file moved
  Nothing is deleted except the scheduled task. The folder is moved, never removed.

  It refuses to touch the MAXCOM repository, the data folder, or any folder that contains either.

.PARAMETER TaskName  Exact name of the scheduled task to retire (as shown in Task Scheduler).
.PARAMETER Folder    Full path of the watcher's folder to move aside.
.PARAMETER DataDir   MAXCOM data folder to protect (default: SURAU_DATA_DIR, else <repo>\data).
.PARAMETER Apply     Do it. Without this switch nothing changes.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$Folder,
  [string]$DataDir = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Host ('refused: ' + $msg)
  exit 1
}

function NormDir([string]$p) {
  $full = [System.IO.Path]::GetFullPath($p)
  return $full.TrimEnd([char]92, [char]47) + [string][char]92
}

if ($TaskName -match '[\*\?\[\]]' -or $TaskName.Trim() -eq '') { Fail 'TaskName must be one exact task name (no wildcards).' }
if ($TaskName.Contains([string][char]92)) { Fail 'TaskName must be the task name only, without a folder path.' }
if ($Folder -match '[\*\?]') { Fail 'Folder must be one exact path (no wildcards).' }

$repo = NormDir (Split-Path -Parent $PSScriptRoot)
if ($DataDir -eq '') {
  if ($env:SURAU_DATA_DIR) { $DataDir = $env:SURAU_DATA_DIR }
  else { $DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data' }
}
$data = NormDir $DataDir
$target = NormDir $Folder

if ($target.Length -le 4) { Fail 'Folder is a drive root.' }
foreach ($protected in @($repo, $data)) {
  $t = $target.ToLowerInvariant()
  $p = $protected.ToLowerInvariant()
  if ($t.StartsWith($p) -or $p.StartsWith($t)) {
    Fail ('Folder overlaps a MAXCOM folder (' + $protected + ').')
  }
}

$folderPath = $target.TrimEnd([char]92)
if (-not (Test-Path -LiteralPath $folderPath -PathType Container)) { Fail ('Folder does not exist: ' + $folderPath) }

$parent = Split-Path -Parent $folderPath
$leaf = Split-Path -Leaf $folderPath
$stamp = (Get-Date).ToString('yyyy-MM-dd')
$retired = Join-Path $parent ('retired-' + $stamp)
$dest = Join-Path $retired $leaf
if (Test-Path -LiteralPath $dest) { Fail ('Already exists: ' + $dest) }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and @($task).Count -ne 1) { Fail 'More than one task has that name.' }

if (-not $Apply) {
  Write-Host 'DRY RUN (nothing changed). Add -Apply to do it.'
  if ($task) {
    Write-Host ('would export task XML to ' + (Join-Path $retired 'task.xml'))
    Write-Host ('would disable then delete scheduled task ' + $TaskName)
  } else {
    Write-Host ('task not found, would skip: ' + $TaskName)
  }
  Write-Host ('would move ' + $folderPath + ' to ' + $dest)
  Write-Host ('would write ' + (Join-Path $retired 'sha256sums.txt'))
  exit 0
}

New-Item -ItemType Directory -Force -Path $retired | Out-Null

if ($task) {
  $xml = Export-ScheduledTask -TaskName $TaskName
  Set-Content -LiteralPath (Join-Path $retired 'task.xml') -Value $xml -Encoding UTF8
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host ('task retired: ' + $TaskName)
} else {
  Write-Host ('task not found, skipped: ' + $TaskName)
}

Move-Item -LiteralPath $folderPath -Destination $dest
Write-Host ('folder moved to ' + $dest)

$lines = @()
Get-ChildItem -LiteralPath $dest -Recurse -File -Force | ForEach-Object {
  $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $rel = $_.FullName.Substring($retired.Length + 1)
  $lines += ($h + '  ' + $rel)
}
Set-Content -LiteralPath (Join-Path $retired 'sha256sums.txt') -Value $lines -Encoding ASCII
Write-Host ('sha256sums.txt written (' + $lines.Count + ' files)')
