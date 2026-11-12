<#
.SYNOPSIS
  MAXCOM: renew the box HTTPS leaf certificate before it lapses. Windows PowerShell 5.1.

.DESCRIPTION
  Run daily by the scheduled task MaxcomCertRenew (scripts\install-cert-renew-task.ps1).
  Reads <DataDir>\pki\box-leaf.cer. When it expires within ThresholdDays (default 60), or is missing
  or unreadable, it runs scripts\box-ca.ps1 -Renew for the first non-loopback IPv4 address in the
  current leaf's SAN, with the Store, Surau name and Days that box-ca.ps1 recorded in
  <DataDir>\pki\box-ca.json when the leaf was first made. The box server notices the new leaf within
  an hour and starts using it; no restart and no action on any device is needed (devices trust the
  root, not the leaf).
  One line per run is appended to <LogDir>\cert-renew.log (last 200 lines kept; LogDir defaults to
  <DataDir>\logs for a hand-run box, and is <MaxcomHome>\logs for an installed box, where SYSTEM writes it
  outside the folder the box account can write to):
    <ISO time> <SKIP|RENEWED|FAIL> <message>
  The PFX passphrase and keys are never printed or logged.
  Run it as the SAME account that created the root CA (the CA private key is in that account's
  store: LocalMachine\My needs an administrator, CurrentUser\My needs that very user), or, on an
  installed box whose box-ca.json records a serviceAccount, as SYSTEM (install-cert-renew-task.ps1
  -AsSystem). When box-ca.json records a serviceAccount (a SID) it is passed on to box-ca.ps1, so the
  renewed certificate files stay readable by the account that runs the box.
  Exit code: 0 when nothing was to do or the leaf was renewed; 1 on failure.

.PARAMETER DataDir        Data folder (default: SURAU_DATA_DIR, else <repo>\data).
.PARAMETER LogDir         Folder for cert-renew.log (default <DataDir>\logs). An installed box passes
                          <MaxcomHome>\logs, a folder only Administrators and SYSTEM can write.
.PARAMETER ThresholdDays  Renew when the leaf has fewer days left than this (default 60).
.PARAMETER Force          Renew even if the leaf is still valid for longer.
.PARAMETER CheckOnly      Only report what would happen; change and log nothing.

Refuses (GAGAL, logged, exit 1) when data, secret, pki or the log folder, or any folder above them, is a
reparse point, and when box-ca.json records a serviceAccount other than exactly S-1-5-19.
#>
[CmdletBinding()]
param(
  [string]$DataDir = '',
  [string]$LogDir = '',
  [int]$ThresholdDays = 60,
  [switch]$Force,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

if ($DataDir -eq '') {
  if ($env:SURAU_DATA_DIR) { $DataDir = $env:SURAU_DATA_DIR }
  else { $DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data' }
}
if ([System.IO.Path]::IsPathRooted($DataDir)) { $dataFull = [System.IO.Path]::GetFullPath($DataDir) }
else { $dataFull = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $DataDir)) }

$pkiDir = Join-Path $dataFull 'pki'
$secretDir = Join-Path $dataFull 'secret'
if ($LogDir -eq '') { $logDir = Join-Path $dataFull 'logs' }
elseif ([System.IO.Path]::IsPathRooted($LogDir)) { $logDir = [System.IO.Path]::GetFullPath($LogDir) }
else { $logDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LogDir)) }
$logFile = Join-Path $logDir 'cert-renew.log'

# Links: this runs as SYSTEM. A junction at data, secret, pki or the log folder (or above) would send the
# log, the renewal and box-ca.ps1's icacls somewhere else.
function Get-LinkProblem([string[]]$Paths) {
  $found = @()
  foreach ($p in $Paths) {
    $cur = $p
    while ($cur) {
      $isLink = $false
      try { $isLink = ((([int][System.IO.File]::GetAttributes($cur)) -band 0x400) -ne 0) } catch { $isLink = $false }
      if ($isLink) { $found += $cur }
      $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
  }
  return @($found | Select-Object -Unique)
}
$logLinks = @(Get-LinkProblem @($logDir))
if ($logLinks.Count -gt 0) {
  # No safe place to log: say it on stderr and stop.
  [Console]::Error.WriteLine('GAGAL: folder log ialah pautan (reparse point), tiada apa ditulis: ' + ($logLinks -join ', '))
  exit 1
}
$leafFile = Join-Path $pkiDir 'box-leaf.cer'
$metaFile = Join-Path $pkiDir 'box-ca.json'
$caScript = Join-Path $PSScriptRoot 'box-ca.ps1'

function Write-RenewLog([string]$status, [string]$message) {
  if ($CheckOnly) { Write-Output "$status $message"; return }
  $clean = ($message -replace '[^\x20-\x7E]', ' ') -replace '\s+', ' '
  if ($clean.Length -gt 300) { $clean = $clean.Substring(0, 300) }
  $line = '{0} {1} {2}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'), $status, $clean.Trim()
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $lines = @()
  if (Test-Path $logFile) { $lines = @(Get-Content -Path $logFile -Encoding ASCII) }
  $lines = @($lines + $line)
  if ($lines.Count -gt 200) { $lines = $lines[($lines.Count - 200)..($lines.Count - 1)] }
  [System.IO.File]::WriteAllText($logFile, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
  Write-Output $line
}

function Read-Leaf {
  if (-not (Test-Path $leafFile)) { return $null }
  try {
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, [System.IO.File]::ReadAllBytes($leafFile))
  } catch { return $null }
}

try {
  $dataLinks = @(Get-LinkProblem @($dataFull, $secretDir, $pkiDir))
  if ($dataLinks.Count -gt 0) { throw ('GAGAL: data, secret atau pki (atau folder di atasnya) ialah pautan (reparse point); tiada apa diubah: ' + ($dataLinks -join ', ')) }
  $leaf = Read-Leaf
  $reason = $null
  if ($null -eq $leaf) { $reason = 'leaf missing or unreadable' }
  elseif ($Force) { $reason = 'forced' }
  else {
    $daysLeft = [math]::Floor(($leaf.NotAfter.ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalDays)
    if ($daysLeft -lt $ThresholdDays) { $reason = "leaf expires in $daysLeft days" }
    else {
      Write-RenewLog 'SKIP' ("leaf valid until {0} ({1} days left)" -f $leaf.NotAfter.ToString('yyyy-MM-dd'), $daysLeft)
      exit 0
    }
  }

  # The settings box-ca.ps1 recorded when the leaf was made.
  if (-not (Test-Path $metaFile)) { throw "cannot renew: ${metaFile} is missing (run scripts\box-ca.ps1 once without -Renew)" }
  $meta = Get-Content -Path $metaFile -Raw -Encoding ASCII | ConvertFrom-Json
  $store = [string]$meta.store
  if ($store -ne 'LocalMachine' -and $store -ne 'CurrentUser') { throw 'cannot renew: box-ca.json has no valid store' }
  $days = [int]$meta.days
  if ($days -lt 1 -or $days -gt 825) { $days = 730 }
  $surau = [string]$meta.surau

  # IP: first non-loopback IPv4 in the current leaf's SAN, else the recorded one.
  $ip = $null
  if ($null -ne $leaf) {
    $sanExt = $leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1
    if ($null -ne $sanExt) {
      foreach ($m in [regex]::Matches($sanExt.Format($false), '\b(\d{1,3}(?:\.\d{1,3}){3})\b')) {
        if (-not $m.Groups[1].Value.StartsWith('127.')) { $ip = $m.Groups[1].Value; break }
      }
    }
  }
  if ($null -eq $ip) { $ip = [string]$meta.ip }
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'cannot renew: no usable box IP in the leaf or box-ca.json' }

  if ($CheckOnly) { Write-RenewLog 'WOULD-RENEW' "$reason; ip $ip store $store days $days"; exit 0 }

  $caArgs = @{ Ip = $ip; DataDir = $dataFull; Days = $days; Surau = $surau; Store = $store; Renew = $true }
  if ($meta.noTrust -eq $true) { $caArgs['NoTrust'] = $true }
  # The account box-ca.ps1 -ServiceAccount recorded. The box runs as LOCAL SERVICE and nothing else: any other
  # value (a file the box account could have changed) stops the renewal instead of being granted Modify.
  $svc = [string]$meta.serviceAccount
  if ($svc -ne '') {
    if ($svc -cne 'S-1-5-19') { throw "GAGAL: serviceAccount dalam box-ca.json mesti tepat S-1-5-19, bukan '$svc'; pembaharuan dihentikan" }
    $caArgs['ServiceAccount'] = $svc
  }
  & $caScript @caArgs | Out-Null

  $fresh = Read-Leaf
  if ($null -eq $fresh) { throw 'renewal ran but the new leaf cannot be read' }
  Write-RenewLog 'RENEWED' ("{0}; new leaf valid until {1} for IP {2}" -f $reason, $fresh.NotAfter.ToString('yyyy-MM-dd'), $ip)
  exit 0
} catch {
  $msg = $_.Exception.Message
  try { Write-RenewLog 'FAIL' $msg } catch { }
  [Console]::Error.WriteLine("box-cert-renew failed: $msg")
  exit 1
}
