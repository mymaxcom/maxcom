<#
.SYNOPSIS
  MAXCOM: make sure the two live media firewall rules exist and are exactly right. Windows PowerShell 5.1.

.DESCRIPTION
  Keeps two inbound UDP rules, on every network profile (Windows may call the Wi-Fi Private or Public),
  open to the local subnet only:
    "MAXCOM Live WebRTC"  UDP 8189  (WebRTC / ICE)
    "MAXCOM Live SRT"     UDP 8890  (SRT, the phone's stream)
  A rule that is already exactly right is left alone; a missing or different one is deleted by name and
  added again. Nothing else is changed or written. Changing the firewall needs an elevated process, so
  without an administrator window the script exits 1 with a message and touches nothing.

  Run by scripts\install-live-tools.ps1 (once, elevated), by the scheduled task "MAXCOM Live Firewall"
  at every boot, and by the box itself at start when it runs elevated.

.PARAMETER WebrtcPort  UDP port of MAXCOM Live WebRTC (default 8189).
.PARAMETER SrtPort     UDP port of MAXCOM Live SRT (default 8890).
#>
[CmdletBinding()]
param(
  [int]$WebrtcPort = 8189,
  [int]$SrtPort = 8890
)

$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'This needs an elevated PowerShell (Run as administrator) to change the Windows Firewall.'
  Write-Host 'Nothing was changed.'
  exit 1
}

# True when the existing rule(s) of this name are exactly the wanted one (one copy, enabled, inbound, UDP,
# the port, allow, every profile, local subnet). An unreadable answer counts as "different": the rule is re-made.
function Test-RuleExact([string]$Name, [int]$Port) {
  $text = (& netsh advfirewall firewall show rule name="$Name" verbose) | Out-String
  if ($LASTEXITCODE -ne 0) { return $false }
  $blocks = @($text -split '(?m)^\s*Rule Name:' | Where-Object { $_ -match 'Enabled:' })
  if ($blocks.Count -ne 1) { return $false }
  $b = $blocks[0]
  foreach ($want in @('Enabled:\s+Yes', 'Direction:\s+In\b', 'Protocol:\s+UDP', "LocalPort:\s+$Port\b", 'Action:\s+Allow', 'RemoteIP:\s+LocalSubnet\b', 'Profiles:\s+Domain,Private,Public')) {
    if ($b -notmatch "(?m)^\s*$want") { return $false }
  }
  return $true
}

function Set-LiveRule([string]$Name, [int]$Port) {
  if (Test-RuleExact $Name $Port) {
    Write-Host "OK      $Name (UDP $Port) already set."
    return
  }
  & netsh advfirewall firewall delete rule name="$Name" | Out-Null
  & netsh advfirewall firewall add rule name="$Name" dir=in action=allow protocol=udp localport=$Port profile=any remoteip=localsubnet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not add the firewall rule $Name" }
  Write-Host "SET     $Name (UDP $Port), every network profile, local subnet only."
}

Set-LiveRule 'MAXCOM Live WebRTC' $WebrtcPort
Set-LiveRule 'MAXCOM Live SRT' $SrtPort
exit 0
