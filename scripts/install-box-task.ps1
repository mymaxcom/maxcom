<#
.SYNOPSIS
  MAXCOM: register (or remove) the scheduled task "MAXCOM Box" that runs the box at boot as
  NT AUTHORITY\LOCAL SERVICE. Windows PowerShell 5.1.

.DESCRIPTION
  The task runs <root>\runtime\node\node.exe "<root>\launcher.mjs" with no one signed in. The account is
  LOCAL SERVICE (S-1-5-19): no password, no administrator rights, can use the network. It is never SYSTEM
  and never "highest privileges".

  Triggers: at startup (15 second delay) and once now, repeating every 5 minutes with no end date, so a
  dead launcher is started again within 5 minutes (MultipleInstances IgnoreNew keeps one copy running).
  Settings: no time limit, runs on batteries, starts when available, restarts 3 times 1 minute apart.

  Before registering, the script refuses unless <root>, runtime\node\node.exe, launcher.mjs and
  box-config.json exist and none of them (nor the node folder) can be written by anyone but SYSTEM,
  Administrators and TrustedInstaller. LOCAL SERVICE itself is NOT trusted here: the account that runs the
  box must not be able to change the code it runs. Running the script again replaces the task.

.PARAMETER InstallRoot  The MAXCOM install root (for example C:\Program Files\MAXCOM). Required unless -Uninstall.
.PARAMETER Uninstall    Stop and remove the task.
.PARAMETER DryRun       Print what would be registered (or removed); change nothing, no elevation needed.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$taskName = 'MAXCOM Box'

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
    # Stops the task's own running instance (by task, not by process name), then removes it.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed task $taskName"
  } else {
    Write-Output "Task $taskName is not installed"
  }
  exit 0
}

if ($InstallRoot -eq '') { throw 'GAGAL: -InstallRoot diperlukan. (-InstallRoot is required.)' }
if (-not [System.IO.Path]::IsPathRooted($InstallRoot)) { throw "GAGAL: -InstallRoot mesti laluan penuh: $InstallRoot (must be a full path)" }
$root = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$nodeExe = Join-Path $root 'runtime\node\node.exe'
$launcher = Join-Path $root 'launcher.mjs'
$config = Join-Path $root 'box-config.json'

foreach ($need in @($root, $nodeExe, $launcher, $config)) {
  if (-not (Test-Path -LiteralPath $need)) { throw "GAGAL: tidak dijumpai: $need (not found; run the MAXCOM setup first)" }
}
# A reparse point (junction or symlink) as the root or the runtime could point the task anywhere.
foreach ($p in @($root, (Join-Path $root 'runtime'), (Join-Path $root 'runtime\node'), $nodeExe, $launcher, $config)) {
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "GAGAL: $p ialah pautan (reparse point); ditolak. (is a link; refused)"
  }
}

# Only SYSTEM, Administrators, TrustedInstaller and CREATOR OWNER may write what a task executes.
# The current user and LOCAL SERVICE (S-1-5-19) are deliberately NOT in this list.
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

$checked = @($root, (Join-Path $root 'runtime\node'), $nodeExe, $launcher, $config)
$offenders = @()
foreach ($p in $checked) {
  $w = @(Get-UntrustedWriters $p)
  if ($w.Count -gt 0) { $offenders += ("$p can be changed by " + ($w -join ', ')) }
}

$arg = '"{0}"' -f $launcher
$account = 'NT AUTHORITY\LOCAL SERVICE (S-1-5-19)'

if ($DryRun) {
  Write-Output "DRYRUN task    : $taskName"
  Write-Output "DRYRUN account : $account (logon ServiceAccount, run level Limited)"
  Write-Output 'DRYRUN triggers: at startup (delay 15 seconds); once now, repeating every 5 minutes with no end'
  Write-Output "DRYRUN command : $nodeExe $arg"
  Write-Output "DRYRUN folder  : $root"
  if ($offenders.Count -gt 0) {
    foreach ($o in $offenders) { Write-Output "DRYRUN would refuse: $o" }
  }
  exit 0
}

if ($offenders.Count -gt 0) {
  throw ("GAGAL: tugas tidak didaftarkan kerana fail yang dijalankannya boleh diubah oleh akaun lain: " + ($offenders -join '; ') +
    ". (Refusing to register: only SYSTEM, Administrators and TrustedInstaller may write these.)")
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arg -WorkingDirectory $root
$startup = New-ScheduledTaskTrigger -AtStartup
$startup.Delay = 'PT15S'
# Repeat every 5 minutes with no end. The cmdlet wants a duration, so give one and remove it from the XML
# after registering (a Duration of MaxValue is rejected on current Windows 10 and 11).
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger @($startup, $repeat) -Principal $principal -Settings $settings `
  -Description 'Runs the MAXCOM box (launcher.mjs) at boot as LOCAL SERVICE and starts it again if it stops.'

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

function Get-TaskXml { return [xml](Export-ScheduledTask -TaskName $taskName) }
function Test-RepetitionOk([xml]$x) {
  $ns = New-Object System.Xml.XmlNamespaceManager($x.NameTable)
  $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  $rep = $x.SelectSingleNode('//t:TimeTrigger/t:Repetition', $ns)
  if ($null -eq $rep) { return $false }
  $iv = $rep.SelectSingleNode('t:Interval', $ns)
  $du = $rep.SelectSingleNode('t:Duration', $ns)
  return ($null -ne $iv -and $iv.InnerText -eq 'PT5M' -and $null -eq $du)
}

$xml = Get-TaskXml
if (-not (Test-RepetitionOk $xml)) {
  $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
  $du = $xml.SelectSingleNode('//t:TimeTrigger/t:Repetition/t:Duration', $ns)
  if ($null -ne $du) { [void]$du.ParentNode.RemoveChild($du) }
  Register-ScheduledTask -TaskName $taskName -Xml $xml.OuterXml -Force | Out-Null
  $xml = Get-TaskXml
  if (-not (Test-RepetitionOk $xml)) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw 'GAGAL: pengulangan setiap 5 minit tidak dapat disahkan dalam tugas; tugas dibuang. (the 5 minute repetition could not be verified; task removed)'
  }
}

Write-Output "Registered task $taskName for ${account}: at startup and every 5 minutes. Command: $nodeExe $arg"
