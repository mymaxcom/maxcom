<#
.SYNOPSIS
  MAXCOM: register (or remove) the scheduled task MaxcomCertRenew. Windows PowerShell 5.1.

.DESCRIPTION
  The task runs scripts\box-cert-renew.ps1 daily at 03:30 and at system start (with a random delay of
  up to 10 minutes), whether anyone is logged on or not, with highest privileges. It keeps the box
  HTTPS leaf certificate fresh so devices never have to do anything.

  WHICH ACCOUNT: the task runs as an account that can use the root CA private key.
    - Store LocalMachine, a hand-run box (the default of box-ca.ps1): the key is in LocalMachine\My
      and only administrators can use it. Run THIS script from the same elevated administrator
      account that ran box-ca.ps1; the task is registered for that account (S4U, no password stored)
      with highest privileges. SYSTEM is the wrong choice here: box-ca.ps1 locks data\secret to the
      account that ran it plus SYSTEM, and the renewal rewrites those files, so SYSTEM would hand the
      file ownership to the wrong account.
    - Store LocalMachine, an installed box (-AsSystem): the box runs as a low-privilege service
      account and box-ca.ps1 was run with -ServiceAccount, so data\secret already grants SYSTEM,
      Administrators and the service account, and box-ca.json records the account. SYSTEM is then the
      stable owner (a person's account can be renamed or removed and the renewal would stop silently).
      The task runs from -ScriptDir, a folder only Administrators and SYSTEM can write, and is
      refused unless box-ca.json says store LocalMachine and has a serviceAccount.
    - Store CurrentUser (tests only): the key is protected by that user's own login (DPAPI), which a
      "run whether logged on or not" task without a password cannot unlock. Pass -Password, or the
      task is registered to run only while the user is logged on.
  Run it once from an elevated PowerShell on the box. Running it again replaces the task (idempotent).

.PARAMETER DataDir    Data folder holding pki\ (default: SURAU_DATA_DIR, else <repo>\data).
.PARAMETER AsSystem   Register the task as SYSTEM (installed box, see above). Not with -Password.
.PARAMETER ScriptDir  Folder holding box-cert-renew.ps1 and box-ca.ps1 (default: this script's folder).
.PARAMETER Password   Only for a CurrentUser CA: the account's password (SecureString).
.PARAMETER Uninstall  Remove the task.
.PARAMETER DryRun     Print what would be registered (or removed); change nothing, no elevation needed.
#>
[CmdletBinding()]
param(
  [string]$DataDir = '',
  [System.Security.SecureString]$Password,
  [switch]$AsSystem,
  [string]$ScriptDir = '',
  [string]$LogDir = '',
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$taskName = 'MaxcomCertRenew'

if ($DataDir -eq '') {
  if ($env:SURAU_DATA_DIR) { $DataDir = $env:SURAU_DATA_DIR }
  else { $DataDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data' }
}
if ([System.IO.Path]::IsPathRooted($DataDir)) { $dataFull = [System.IO.Path]::GetFullPath($DataDir) }
else { $dataFull = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $DataDir)) }

if ($ScriptDir -eq '') { $ScriptDir = $PSScriptRoot }
if ([System.IO.Path]::IsPathRooted($ScriptDir)) { $ScriptDir = [System.IO.Path]::GetFullPath($ScriptDir) }
else { $ScriptDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ScriptDir)) }
if ($AsSystem -and $null -ne $Password) { throw '-AsSystem cannot be combined with -Password' }
# -AsSystem: SYSTEM writes its log OUTSIDE data\ (the box account can write data\logs): <MaxcomHome>\logs.
if ($LogDir -eq '' -and $AsSystem) { $LogDir = Join-Path (Split-Path -Parent $dataFull) 'logs' }
if ($LogDir -ne '') {
  if ([System.IO.Path]::IsPathRooted($LogDir)) { $LogDir = [System.IO.Path]::GetFullPath($LogDir) }
  else { $LogDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $LogDir)) }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $DryRun -and -not $isAdmin) {
  throw 'Run this script from an elevated (Administrator) PowerShell: the task runs with highest privileges.'
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($DryRun) {
    if ($null -ne $existing) { Write-Output "DRYRUN would remove task $taskName" } else { Write-Output "DRYRUN task $taskName is not installed" }
    exit 0
  }
  if ($null -ne $existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed task $taskName"
  } else {
    Write-Output "Task $taskName is not installed"
  }
  exit 0
}

$renewScript = Join-Path $ScriptDir 'box-cert-renew.ps1'
if (-not (Test-Path $renewScript)) { throw "box-cert-renew.ps1 not found in the script folder ($renewScript)" }
$caScript = Join-Path $ScriptDir 'box-ca.ps1'
if ($AsSystem -and -not (Test-Path $caScript)) { throw "box-ca.ps1 not found in the script folder ($caScript)" }

# -AsSystem reads what box-ca.ps1 recorded and refuses early (before any ACL is touched).
$metaFile = Join-Path (Join-Path $dataFull 'pki') 'box-ca.json'
$refuse = @()
$serviceSid = ''
if ($AsSystem) {
  if (-not (Test-Path -LiteralPath $metaFile)) { $refuse += "no $metaFile (run box-ca.ps1 -ServiceAccount first)" }
  else {
    $metaSys = Get-Content -Path $metaFile -Raw -Encoding ASCII | ConvertFrom-Json
    if ($metaSys.store -ne 'LocalMachine') { $refuse += "box-ca.json says store '$($metaSys.store)', not LocalMachine (the CA key must be in LocalMachine\My)" }
    $serviceSid = [string]$metaSys.serviceAccount
    if ($serviceSid -notmatch '^S-1-\d{1,3}(-\d{1,10}){1,15}$') { $refuse += 'box-ca.json has no serviceAccount (run box-ca.ps1 -ServiceAccount first)'; $serviceSid = '' }
  }
  foreach ($linkPath in @($ScriptDir, $renewScript, $caScript)) {
    if ((Get-Item -LiteralPath $linkPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $refuse += "$linkPath is a link; use the real folder" }
  }
  if ($refuse.Count -gt 0) {
    if ($DryRun) { Write-Output ("DRYRUN would refuse -AsSystem: " + ($refuse -join '; ')); exit 0 }
    throw ("Refusing -AsSystem: " + ($refuse -join '; '))
  }
}

# The task runs this folder's script with highest privileges, and it writes data\pki. Anyone who can
# write to either could get their code run as an administrator, so only Administrators, SYSTEM and
# this account may have write access (S4).
$meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', $meSid)
# SYSTEM runs this task with the CA key: nobody but SYSTEM, Administrators and TrustedInstaller
# (and CREATOR OWNER, an inheritance placeholder) may write what it executes or what it writes.
if ($AsSystem) { $trustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') }
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

$pkiDir = Join-Path $dataFull 'pki'
if ($AsSystem -and -not $DryRun) {
  foreach ($chk in @($dataFull, $pkiDir, $LogDir)) {
    $cur = $chk
    while ($cur) {
      $isLink = $false
      try { $isLink = ((([int][System.IO.File]::GetAttributes($cur)) -band 0x400) -ne 0) } catch { $isLink = $false }
      if ($isLink) { throw "GAGAL: $cur ialah pautan (reparse point); tiada apa diubah" }
      $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
  }
}
$badScripts = @(Get-UntrustedWriters $ScriptDir) + @(Get-UntrustedWriters $renewScript)
if ($AsSystem) { $badScripts += @(Get-UntrustedWriters $caScript) }
$badPki = @(Get-UntrustedWriters $pkiDir)
if ($DryRun) {
  if ($badScripts.Count -gt 0) { Write-Output ("DRYRUN would refuse: the scripts folder can be changed by " + ($badScripts -join ', ')) }
  if ($badPki.Count -gt 0) { Write-Output ("DRYRUN would lock data\pki (now changeable by " + ($badPki -join ', ') + ')') }
} else {
  if ($badPki.Count -gt 0) {
    if ($AsSystem) {
      # The box account may read the certificates but never change them.
      # The data ACL contract for pki\ (same as MaxcomSetup.psm1 Get-MaxcomAclContract): no Users entry.
      & icacls.exe $pkiDir /reset /L | Out-Null
      & icacls.exe $pkiDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${serviceSid}:(OI)(CI)RX" /L | Out-Null
    } else {
      & icacls.exe $pkiDir /inheritance:r /grant:r "${me}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /L | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw 'icacls failed on data\pki' }
    $badPki = @(Get-UntrustedWriters $pkiDir)
    if ($badPki.Count -gt 0) {
      throw ("data\pki can still be changed by " + ($badPki -join ', ') + ". Remove their write access, then run this script again.")
    }
    if ($AsSystem) { Write-Output 'Locked data\pki: only Administrators and SYSTEM may write there.' }
    else { Write-Output 'Locked data\pki: only Administrators, SYSTEM and this account may write there.' }
  }
  if ($badScripts.Count -gt 0) {
    throw ("Refusing to register a highest-privilege task: the scripts folder ($ScriptDir) or box-cert-renew.ps1 can be changed by " + ($badScripts -join ', ') + ". Move the box to a folder only Administrators, SYSTEM and this account can write (for example run: icacls `"$ScriptDir`" /inheritance:r /grant:r Administrators:(OI)(CI)F SYSTEM:(OI)(CI)F), then run this script again.")
  }
}

# The store that holds the CA key decides how the task may log on.
$store = 'LocalMachine'
if (Test-Path $metaFile) {
  $meta = Get-Content -Path $metaFile -Raw -Encoding ASCII | ConvertFrom-Json
  if ($meta.store -eq 'CurrentUser') { $store = 'CurrentUser' }
} elseif (-not $DryRun) {
  throw "No ${metaFile}: run scripts\box-ca.ps1 once (it writes box-ca.json), then install the task."
}

$logon = 'S4U'
$account = $me
if ($AsSystem) { $logon = 'ServiceAccount'; $account = 'NT AUTHORITY\SYSTEM' }
elseif ($store -eq 'CurrentUser') {
  if ($null -ne $Password) { $logon = 'Password' } else { $logon = 'Interactive' }
}

$arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -DataDir "{1}"' -f $renewScript, $dataFull
if ($LogDir -ne '') { $arg += (' -LogDir "{0}"' -f $LogDir) }
$workDir = Split-Path -Parent $ScriptDir
if ($AsSystem) { $workDir = $ScriptDir }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $workDir
$randomDelay = New-TimeSpan -Minutes 10
$daily = New-ScheduledTaskTrigger -Daily -At '03:30' -RandomDelay $randomDelay
$startup = New-ScheduledTaskTrigger -AtStartup -RandomDelay $randomDelay
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType $logon -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$task = New-ScheduledTask -Action $action -Trigger @($daily, $startup) -Principal $principal -Settings $settings `
  -Description 'Renews the MAXCOM HTTPS leaf certificate before it expires (scripts\box-cert-renew.ps1).'

if ($DryRun) {
  Write-Output "DRYRUN task    : $taskName"
  Write-Output "DRYRUN account : $account (logon $logon, run level Highest, CA store $store)"
  Write-Output "DRYRUN triggers: daily 03:30 (random delay up to 10 minutes); at startup (random delay up to 10 minutes)"
  Write-Output "DRYRUN command : powershell.exe $arg"
  exit 0
}

if ($logon -eq 'Password') {
  $cred = New-Object System.Management.Automation.PSCredential($me, $Password)
  Register-ScheduledTask -TaskName $taskName -InputObject $task -User $me -Password $cred.GetNetworkCredential().Password -Force | Out-Null
} else {
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
}
Write-Output "Registered task $taskName for $account (logon $logon): daily 03:30 and at startup. Log: $(if ($LogDir -ne '') { Join-Path $LogDir 'cert-renew.log' } else { Join-Path (Join-Path $dataFull 'logs') 'cert-renew.log' })"
if ($logon -eq 'Interactive') {
  Write-Output 'NOTE: the CA key is in CurrentUser\My, so the task only runs while this user is logged on (pass -Password to change that).'
}
