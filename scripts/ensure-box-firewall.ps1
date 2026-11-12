<#
.SYNOPSIS
  MAXCOM: make sure the box HTTPS firewall rule exists and is exactly right. Windows PowerShell 5.1.

.DESCRIPTION
  Keeps one inbound rule for the box LAN HTTPS port, on every network profile (Windows may call the
  Wi-Fi Private or Public), open to the local subnet only:
    "MAXCOM Box HTTPS"  TCP 8443  (the phones, the iPad and the kiosk)
  The rule is bound to the installed node.exe (<install root>\runtime\node\node.exe), so no other
  program can use it. A hand-run box got this rule from the Windows "Allow access" prompt; an
  installed box starts from a scheduled task with no desktop, so no prompt appears and the rule has
  to be made here.

  A rule that is already exactly right is left alone; a missing or different one is deleted by name
  and made again. Nothing else is changed or written. Changing the firewall needs an elevated
  process, so without an administrator window the script exits 1 with a message and touches nothing.

  Run by the setup (elevated) once the runtime is in place, and by the uninstall with -Remove.

.PARAMETER HttpsPort  TCP port of the box LAN HTTPS server (default 8443).
.PARAMETER Program    Full path to the installed node.exe the rule is bound to.
.PARAMETER Remove     Delete the rule and exit (uninstall).
.PARAMETER DryRun     Print what would be done; change nothing and do not need an administrator window.
.PARAMETER Netsh      The netsh program to call (default netsh.exe). Test hook: a fake that prints its command line.
                      When it is given the administrator check is skipped, because the fake changes nothing
                      (the real netsh refuses to change the firewall without elevation anyway).
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$HttpsPort = 8443,
  [Parameter(Mandatory = $true)]
  [string]$Program,
  [switch]$Remove,
  [switch]$DryRun,
  [string]$Netsh = 'netsh.exe'
)

$ErrorActionPreference = 'Stop'
$ruleName = 'MAXCOM Box HTTPS'

# Windows PowerShell 5.1 passes an argument that contains a space as one quoted token ("name=MAXCOM Box HTTPS"),
# but an argument that already holds a double quote is passed exactly as written. So name and program are built
# as name="..." and program="..." here: netsh always sees the documented form, even for C:\Program Files\...
function Invoke-NetshCmd([string[]]$NetshArgs) {
  & $Netsh @NetshArgs
}
function Get-QuotedArg([string]$Key, [string]$Value) {
  return ($Key + '="' + $Value + '"')
}

# Check the program before anything else: a typo must be reported without an administrator window,
# and a rule bound to the wrong file is worse than no rule at all.
if (-not [IO.Path]::IsPathRooted($Program) -or $Program -notmatch '^([A-Za-z]:\\|\\\\)') {
  throw "GAGAL: -Program mesti laluan penuh: $Program (must be a full path)"
}
if ($Program -notmatch '\\node\.exe$') {
  throw "GAGAL: -Program mesti menamakan node.exe: $Program (must end in \node.exe)"
}
if (-not (Test-Path -LiteralPath $Program -PathType Leaf)) {
  throw "GAGAL: node.exe tidak dijumpai: $Program (not found; run the MAXCOM setup first)"
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($DryRun) {
  Write-Host "DRYRUN  ${ruleName}: TCP $HttpsPort, every network profile, local subnet only, program $Program"
  if ($Remove) {
    Write-Host "DRYRUN  would delete the rule $ruleName if it exists."
  } else {
    Write-Host "DRYRUN  would make the rule if it is missing or different, and leave it alone when it is exact."
  }
  Write-Host 'DRY RUN: nothing changed.'
  exit 0
}

if (-not $admin -and -not $PSBoundParameters.ContainsKey('Netsh')) {
  Write-Host 'This needs an elevated PowerShell (Run as administrator) to change the Windows Firewall.'
  Write-Host 'Nothing was changed.'
  exit 1
}

# The rules of this exact name as plain objects, read through the NetSecurity cmdlets (property values are
# the same on every Windows display language; netsh text is translated, so it is never parsed here).
function Get-RuleSnapshot([string]$Name) {
  $out = @()
  foreach ($r in @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $Name })) {
    $port = $r | Get-NetFirewallPortFilter
    $app = $r | Get-NetFirewallApplicationFilter
    $addr = $r | Get-NetFirewallAddressFilter
    $out += [pscustomobject]@{
      Enabled       = [string]$r.Enabled
      Direction     = [string]$r.Direction
      Action        = [string]$r.Action
      Profile       = [string]$r.Profile
      Protocol      = [string]$port.Protocol
      LocalPort     = (@($port.LocalPort) -join ',')
      RemotePort    = (@($port.RemotePort) -join ',')
      Program       = [string]$app.Program
      RemoteAddress = (@($addr.RemoteAddress) -join ',')
      LocalAddress  = (@($addr.LocalAddress) -join ',')
    }
  }
  return $out
}

# True when the snapshot is exactly the wanted rule: one copy, enabled, inbound, allow, every profile,
# TCP, the port, local subnet, and bound to this node.exe.
function Test-RuleSnapshotExact($Snapshot, [int]$Port, [string]$ProgramPath) {
  $s = @($Snapshot)
  if ($s.Count -ne 1) { return $false }
  $r = $s[0]
  if ($r.Enabled -ne 'True') { return $false }
  if ($r.Direction -ne 'Inbound') { return $false }
  if ($r.Action -ne 'Allow') { return $false }
  $allProfiles = ($r.Profile -eq 'Any') -or (($r.Profile -match 'Domain') -and ($r.Profile -match 'Private') -and ($r.Profile -match 'Public'))
  if (-not $allProfiles) { return $false }
  if ($r.Protocol -ne 'TCP') { return $false }
  if ($r.LocalPort -ne [string]$Port) { return $false }
  if ($r.RemoteAddress -ne 'LocalSubnet') { return $false }
  if ($r.Program -ine $ProgramPath) { return $false }
  return $true
}

# An unreadable answer counts as "different": the rule is made again.
function Test-RuleExact([string]$Name, [int]$Port) {
  try { return (Test-RuleSnapshotExact (Get-RuleSnapshot $Name) $Port $Program) } catch { return $false }
}

if ($Remove) {
  # netsh reports a non-zero code when there is nothing to delete; the uninstall must not fail then.
  Invoke-NetshCmd @('advfirewall', 'firewall', 'delete', 'rule', (Get-QuotedArg 'name' $ruleName)) | Out-Null
  Write-Host "REMOVED $ruleName (if it was present)."
  exit 0
}

if (Test-RuleExact $ruleName $HttpsPort) {
  Write-Host "OK      $ruleName (TCP $HttpsPort) already set."
  exit 0
}

Invoke-NetshCmd @('advfirewall', 'firewall', 'delete', 'rule', (Get-QuotedArg 'name' $ruleName)) | Out-Null
Invoke-NetshCmd @('advfirewall', 'firewall', 'add', 'rule', (Get-QuotedArg 'name' $ruleName), 'dir=in', 'action=allow', 'protocol=tcp', "localport=$HttpsPort", 'profile=any', 'remoteip=localsubnet', (Get-QuotedArg 'program' $Program)) | Out-Null
if ($LASTEXITCODE -ne 0) { throw "GAGAL: tidak dapat menambah peraturan firewall $ruleName (could not create it)" }
Write-Host "SET     $ruleName (TCP $HttpsPort), every network profile, local subnet only, program $Program."
exit 0
