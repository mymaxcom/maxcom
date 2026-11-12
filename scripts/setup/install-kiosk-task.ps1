<#
.SYNOPSIS
  MAXCOM: register (or remove) the scheduled task "MAXCOM Kiosk" that shows the kiosk screen when the
  kiosk user signs in. Windows PowerShell 5.1.

.DESCRIPTION
  The task runs <root>\bin\start-kiosk.ps1 with Windows PowerShell as the kiosk user, interactive, run level
  Limited (no elevation), at that user's logon. Used for kiosk mode "khas" only.

  Before registering, the script refuses unless <root>\bin and start-kiosk.ps1 exist and only SYSTEM,
  Administrators and TrustedInstaller can write them: the kiosk user must not be able to change the script
  its own task runs. The kiosk user must be a real account (not SYSTEM, LOCAL SERVICE or NETWORK SERVICE).
  Running the script again replaces the task.

.PARAMETER InstallRoot  The MAXCOM install root. Required unless -Uninstall.
.PARAMETER User         The kiosk user account (DOMAIN\name, MACHINE\name or name). Required unless -Uninstall.
.PARAMETER Uninstall    Stop and remove the task.
.PARAMETER DryRun       Print what would be registered (or removed); change nothing, no elevation needed.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$User = '',
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$taskName = 'MAXCOM Kiosk'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $DryRun -and -not $isAdmin) {
  throw 'GAGAL: jalankan skrip ini dari PowerShell sebagai Pentadbir (Administrator). (Run this script from an elevated PowerShell.)'
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($DryRun) {
    if ($null -ne $existing) { Write-Output "DRYRUN would stop and remove task $taskName" } else { Write-Output "DRYRUN task $taskName is not installed" }
    exit 0
  }
  if ($null -ne $existing) {
    # By task, not by process name. Edge itself is stopped by uninstall.ps1 (by PID, by profile folder).
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed task $taskName"
  } else {
    Write-Output "Task $taskName is not installed"
  }
  exit 0
}

if ($InstallRoot -eq '') { throw 'GAGAL: -InstallRoot diperlukan. (-InstallRoot is required.)' }
if ($User -eq '') { throw 'GAGAL: -User diperlukan (akaun pengguna skrin). (-User is required.)' }
if (-not [System.IO.Path]::IsPathRooted($InstallRoot)) { throw "GAGAL: -InstallRoot mesti laluan penuh: $InstallRoot (must be a full path)" }
if ($User -notmatch '^[^"<>|*?/:;,=+\[\]\\]+(\\[^"<>|*?/:;,=+\[\]\\]+)?$') {
  throw "GAGAL: nama pengguna tidak sah: $User (invalid user name)"
}

$root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$binDir = Join-Path $root 'bin'
$script = Join-Path $binDir 'start-kiosk.ps1'

# The kiosk user must be a real interactive account.
$userSid = ''
try {
  $userSid = (New-Object System.Security.Principal.NTAccount($User)).Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {
  if (-not $DryRun) { throw "GAGAL: akaun tidak dijumpai pada PC ini: $User (account not found)" }
}
$refusedSids = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-1-0', 'S-1-5-32-544')
if ($userSid -ne '' -and $refusedSids -contains $userSid) {
  throw "GAGAL: $User bukan akaun pengguna skrin yang sesuai. (not a usable kiosk user)"
}
if ($User -match '^(NT AUTHORITY\\)?(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$') {
  throw "GAGAL: $User bukan akaun pengguna skrin yang sesuai. (not a usable kiosk user)"
}

foreach ($need in @($root, $binDir, $script)) {
  if (-not (Test-Path -LiteralPath $need)) {
    if ($DryRun) { continue }
    throw "GAGAL: tidak dijumpai: $need (not found; run the MAXCOM setup first)"
  }
}
foreach ($p in @($root, $binDir, $script)) {
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "GAGAL: $p ialah pautan (reparse point); ditolak. (is a link; refused)"
  }
}

# Only SYSTEM, Administrators, TrustedInstaller and CREATOR OWNER may write what the task runs.
# The kiosk user is deliberately NOT in this list.
$trustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Get-UntrustedWriters([string]$Path) {
  $found = @()
  if (-not (Test-Path -LiteralPath $Path)) { return $found }
  $acl = Get-Acl -LiteralPath $Path
  $writeMask = [System.Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    if (($ace.FileSystemRights -band $writeMask) -eq 0) { continue }
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    if ($trustedSids -contains $sid) { continue }
    $found += [string]$ace.IdentityReference
  }
  try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = '' }
  if ($ownerSid -ne '' -and $trustedSids -notcontains $ownerSid) { $found += "owner $ownerSid" }
  return $found
}

$offenders = @()
foreach ($p in @($root, $binDir, $script)) {
  $w = @(Get-UntrustedWriters $p)
  if ($w.Count -gt 0) { $offenders += ("$p can be changed by " + ($w -join ', ')) }
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $script

if ($DryRun) {
  Write-Output "DRYRUN task    : $taskName"
  Write-Output "DRYRUN account : $User (logon Interactive, run level Limited)"
  Write-Output "DRYRUN trigger : at logon of $User"
  Write-Output "DRYRUN command : $psExe $arg"
  Write-Output "DRYRUN folder  : $binDir"
  foreach ($o in $offenders) { Write-Output "DRYRUN would refuse: $o" }
  exit 0
}

if ($offenders.Count -gt 0) {
  throw ("GAGAL: tugas tidak didaftarkan kerana skrin yang dijalankannya boleh diubah oleh akaun lain: " + ($offenders -join '; ') +
    ". (Refusing to register: only SYSTEM, Administrators and TrustedInstaller may write these.)")
}

$action = New-ScheduledTaskAction -Execute $psExe -Argument $arg -WorkingDirectory $binDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Shows the MAXCOM kiosk screen (Edge, full screen) when the kiosk user signs in.'

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Output "Registered task $taskName for ${User}: at logon. Command: $psExe $arg"
