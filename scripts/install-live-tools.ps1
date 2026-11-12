<#
.SYNOPSIS
  MAXCOM: install the live video tools (MediaMTX and ffmpeg) for the box. Windows PowerShell 5.1.

.DESCRIPTION
  Downloads the MediaMTX Windows amd64 release (GitHub, MIT) and the gyan.dev ffmpeg release
  essentials build (GPL build, run only as a separate process), checks each zip against the sha256
  that YOU pass on the command line, and unpacks them to:
    <Dest>\mediamtx\mediamtx.exe  (+ the shipped mediamtx.yml, used by the config key test)
    <Dest>\ffmpeg\ffmpeg.exe
  Then writes <Dest>\VERSIONS.md (name, version, URL, sha256, licence, date) and opens two UDP ports
  on the Windows Firewall (through scripts\ensure-live-firewall.ps1), every network profile but local subnet
  only: 8189 (WebRTC) and 8890 (SRT). Nothing else is opened: every MediaMTX HTTP port binds loopback.
  It also registers the scheduled task "MAXCOM Live Firewall" (SYSTEM, at startup) that re-asserts those
  two rules at every boot. The task runs an admin-only copy of ensure-live-firewall.ps1 in
  %ProgramData%\MAXCOM (folder writable by Administrators and SYSTEM only, checked after it is set; if the
  check fails the task is not registered), never the script in the repo folder. A repeat run refreshes the copy.

  With -SourceDir the two zips come from a local folder (the setup bundle) instead of a download: the
  file mediamtx_<version>_windows_amd64.zip and the file name of -FfmpegUrl, both in that folder.
  Nothing is downloaded; the two sha256 parameters are still mandatory and are still checked against
  the files. A missing file stops the script before anything is changed.

  The hashes are mandatory on purpose: read them from the release pages and pass them in, so the
  trust decision is always a conscious operator input. The script refuses to run without them, and
  refuses a download or a bundle file whose hash differs (a downloaded file is deleted).

  Safe to repeat: tools are replaced in place, the firewall rules are re-created by name and the task is replaced.
  Adding firewall rules needs an administrator window, so on a real box run this script in an
  elevated PowerShell. Without one the script stops before downloading anything, unless
  -SkipFirewall is passed (development laptops): then it installs the tools and prints the two
  firewall commands to run later.

.PARAMETER Dest              Install folder (default: <repo>\tools\live).
.PARAMETER MediamtxVersion   MediaMTX release tag, for example v1.21.3.
.PARAMETER MediamtxSha256    sha256 of mediamtx_<version>_windows_amd64.zip (64 hex characters).
.PARAMETER FfmpegUrl         ffmpeg release essentials zip (https only).
.PARAMETER FfmpegSha256      sha256 of that zip (64 hex characters).
.PARAMETER SourceDir         Folder holding the two zips (the setup bundle); nothing is downloaded.
.PARAMETER SkipFirewall      Do not add the firewall rules and do not require an administrator window (dev laptops).
.PARAMETER DryRun            Print what would be done; download, write and change nothing.
#>
[CmdletBinding()]
param(
  [string]$Dest = '',
  [string]$MediamtxVersion = 'v1.21.3',
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [Parameter(Mandatory = $true)] [string]$MediamtxSha256,
  [string]$FfmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [Parameter(Mandatory = $true)] [string]$FfmpegSha256,
  [string]$SourceDir = '',
  [switch]$SkipFirewall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ($Dest -eq '') { $Dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\live' }
if ($MediamtxVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'MediamtxVersion must look like v1.21.3' }
if ($FfmpegUrl -notmatch '^https://') { throw 'FfmpegUrl must start with https://' }

$mtxUrl = "https://github.com/bluenviron/mediamtx/releases/download/$MediamtxVersion/mediamtx_${MediamtxVersion}_windows_amd64.zip"
$mtxZipName = "mediamtx_${MediamtxVersion}_windows_amd64.zip"
$ffZipName = ([Uri]$FfmpegUrl).Segments[-1]

Write-Host "MediaMTX : $mtxUrl"
Write-Host "  sha256 : $MediamtxSha256"
Write-Host "ffmpeg   : $FfmpegUrl"
Write-Host "  sha256 : $FfmpegSha256"
Write-Host "Install  : $Dest"

# Offline bundle (the setup zip): the two zips sit in -SourceDir and the script downloads nothing.
# Only their presence is checked here, so a folder without them fails before anything is changed;
# their sha256 values are checked below, exactly as a downloaded file is checked.
$mtxSource = ''
$ffSource = ''
if ($SourceDir -ne '') {
  Write-Host "Source   : $SourceDir (bundle, nothing is downloaded)"
  $mtxSource = Join-Path $SourceDir $mtxZipName
  $ffSource = Join-Path $SourceDir $ffZipName
  if (-not (Test-Path -LiteralPath $mtxSource -PathType Leaf)) {
    throw "GAGAL: $mtxZipName tiada dalam folder bundle $SourceDir (missing from the bundle)"
  }
  if (-not (Test-Path -LiteralPath $ffSource -PathType Leaf)) {
    throw "GAGAL: $ffZipName tiada dalam folder bundle $SourceDir (missing from the bundle)"
  }
}

if ($DryRun) {
  Write-Host 'DRY RUN: nothing downloaded, written or changed.'
  if ($SourceDir -ne '') {
    Write-Host 'Would use these two bundle files (no download; the sha256 values above are checked first):'
    Write-Host "  $mtxSource"
    Write-Host "  $ffSource"
  }
  Write-Host 'Would open UDP 8189 (MAXCOM Live WebRTC) and UDP 8890 (MAXCOM Live SRT) on every network profile, local subnet only, and register the boot task MAXCOM Live Firewall.'
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $SkipFirewall) {
  Write-Host 'This needs an elevated PowerShell (Run as administrator) to open the two firewall ports.'
  Write-Host 'Nothing was downloaded or changed. Re-run it as administrator, or add -SkipFirewall on a development laptop.'
  exit 1
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$work = Join-Path ([IO.Path]::GetTempPath()) ('maxcom-live-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
if ($admin) {
  # The work folder is where the bundle files are copied, hashed and unpacked. Lock it to Administrators and
  # SYSTEM (no inheritance), so a normal user cannot swap a file between the hash check and its use.
  $workAcl = New-Object System.Security.AccessControl.DirectorySecurity
  $workAcl.SetAccessRuleProtection($true, $false)
  $workInherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($workSid in 'S-1-5-18', 'S-1-5-32-544') {
    $workWho = New-Object System.Security.Principal.SecurityIdentifier $workSid
    $workAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($workWho, 'FullControl', $workInherit, 'None', 'Allow')))
  }
  $workAcl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
  Set-Acl -LiteralPath $work -AclObject $workAcl
}

function Get-Verified([string]$Url, [string]$Sha256, [string]$Name) {
  $file = Join-Path $work $Name
  Write-Host "Downloading $Name ..."
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $file
  $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash
  if ($got -ne $Sha256.ToUpperInvariant()) {
    Remove-Item -Force $file
    throw "sha256 mismatch for $Name (expected $Sha256, got $got). File deleted."
  }
  Write-Host "  sha256 ok"
  return $file
}

# A bundle file is copied into the work folder first, and the COPY is hashed and used: the bundle folder may be
# writable by a normal user, so hashing the original and then reading it again would leave a swap window.
# The original is never changed or deleted: it belongs to the setup bundle.
function Get-BundleFile([string]$Path, [string]$Sha256, [string]$Name) {
  $copy = Join-Path $work $Name
  Copy-Item -LiteralPath $Path -Destination $copy -Force
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash
  if ($got -ne $Sha256.ToUpperInvariant()) {
    Remove-Item -Force -LiteralPath $copy
    throw "GAGAL: sha256 tidak sepadan untuk $Name (sha256 mismatch, expected $Sha256, got $got); the bundle file was not changed."
  }
  Write-Host "  sha256 ok"
  return $copy
}

try {
  if ($SourceDir -ne '') {
    $mtxZip = Get-BundleFile $mtxSource $MediamtxSha256 $mtxZipName
    $ffZip = Get-BundleFile $ffSource $FfmpegSha256 $ffZipName
  } else {
    $mtxZip = Get-Verified $mtxUrl $MediamtxSha256 'mediamtx.zip'
    $ffZip = Get-Verified $FfmpegUrl $FfmpegSha256 'ffmpeg.zip'
  }

  $mtxOut = Join-Path $work 'mtx'
  $ffOut = Join-Path $work 'ff'
  Expand-Archive -Path $mtxZip -DestinationPath $mtxOut
  Expand-Archive -Path $ffZip -DestinationPath $ffOut

  $mtxExe = Join-Path $mtxOut 'mediamtx.exe'
  if (-not (Test-Path $mtxExe)) { throw 'mediamtx.exe not found in the MediaMTX zip' }
  $ffExe = Get-ChildItem -Path $ffOut -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  if ($null -eq $ffExe) { throw 'ffmpeg.exe not found in the ffmpeg zip' }

  $mtxDest = Join-Path $Dest 'mediamtx'
  $ffDest = Join-Path $Dest 'ffmpeg'
  New-Item -ItemType Directory -Force -Path $mtxDest | Out-Null
  New-Item -ItemType Directory -Force -Path $ffDest | Out-Null
  Copy-Item -Force $mtxExe (Join-Path $mtxDest 'mediamtx.exe')
  foreach ($extra in 'mediamtx.yml', 'LICENSE') {
    $src = Join-Path $mtxOut $extra
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $mtxDest $extra) }
  }
  Copy-Item -Force $ffExe.FullName (Join-Path $ffDest 'ffmpeg.exe')
  $ffLicense = Join-Path (Split-Path -Parent (Split-Path -Parent $ffExe.FullName)) 'LICENSE'
  if (Test-Path $ffLicense) { Copy-Item -Force $ffLicense (Join-Path $ffDest 'LICENSE') }

  # ffmpeg version from the first line of "ffmpeg -version" (ffmpeg version n7.1.1-... Copyright ...),
  # else from the folder name inside the zip (ffmpeg-7.1.1-essentials_build)
  $ffVersion = 'unknown'
  try {
    $first = (& (Join-Path $ffDest 'ffmpeg.exe') -version 2>$null | Select-Object -First 1)
    if ($first -match '^ffmpeg version (\S+)') { $ffVersion = $Matches[1] }
  } catch { }
  if ($ffVersion -eq 'unknown') {
    $folder = ($ffExe.FullName.Substring($ffOut.Length).TrimStart('\') -split '\\')[0]
    if ($folder -match '^ffmpeg-(\d+(\.\d+)+)') { $ffVersion = $Matches[1] }
  }
  # licence from the build named in the zip: BtbN "-lgpl-" is LGPL, "-gpl-" is GPL, gyan essentials is GPL
  $ffLicence = 'unknown'
  if ($ffZipName -match '-lgpl-') { $ffLicence = 'LGPL-2.1-or-later' }
  elseif ($ffZipName -match '-gpl-') { $ffLicence = 'GPL-3.0' }
  elseif ($ffZipName -match 'essentials') { $ffLicence = 'GPL-3.0' }

  $today = (Get-Date).ToString('yyyy-MM-dd')
  $lines = @(
    '# MAXCOM live tools',
    '',
    'Written by scripts/install-live-tools.ps1. The sha256 is the hash of the downloaded zip.',
    '',
    '| Name | Version | URL | sha256 | Licence | Date |',
    '|---|---|---|---|---|---|',
    "| mediamtx | $MediamtxVersion | $mtxUrl | $($MediamtxSha256.ToLowerInvariant()) | MIT | $today |",
    "| ffmpeg | $ffVersion | $FfmpegUrl | $($FfmpegSha256.ToLowerInvariant()) | $ffLicence | $today |"
  )
  Set-Content -Path (Join-Path $Dest 'VERSIONS.md') -Value $lines -Encoding Ascii

  # Firewall: UDP only, every profile (Private or Public Wi-Fi) but only from the local subnet. ensure-live-firewall.ps1
  # re-creates the two rules by name (a repeat run never duplicates) and the boot task re-asserts them at every start.
  if ($SkipFirewall) {
    Write-Host 'Firewall skipped (-SkipFirewall). Run these two commands in an administrator window to open the media ports:'
    Write-Host '  netsh advfirewall firewall add rule name="MAXCOM Live WebRTC" dir=in action=allow protocol=udp localport=8189 profile=any remoteip=localsubnet'
    Write-Host '  netsh advfirewall firewall add rule name="MAXCOM Live SRT" dir=in action=allow protocol=udp localport=8890 profile=any remoteip=localsubnet'
  } elseif ($admin) {
    $ensureScript = Join-Path $PSScriptRoot 'ensure-live-firewall.ps1'
    if (-not (Test-Path $ensureScript)) { throw "ensure-live-firewall.ps1 not found next to this script ($ensureScript)" }
    & $ensureScript
    if ($LASTEXITCODE -ne 0) { throw 'ensure-live-firewall.ps1 failed; the media firewall rules are not set.' }
    Write-Host 'Firewall rules set: UDP 8189 (MAXCOM Live WebRTC) and UDP 8890 (MAXCOM Live SRT), every network profile, local subnet only.'

    # Boot task: SYSTEM re-asserts the two rules at every start, so a reset or a changed network profile never leaves them wrong.
    # SYSTEM must never run a file that a normal user can write (that would be a way to become SYSTEM at the next boot).
    # So the task runs an admin-only COPY in %ProgramData%\MAXCOM, not the script in this repo folder. A repeat run refreshes the copy.
    $taskName = 'MAXCOM Live Firewall'
    $secureDir = Join-Path $env:ProgramData 'MAXCOM'
    $secureScript = Join-Path $secureDir 'ensure-live-firewall.ps1'
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $adminSid = 'S-1-5-32-544'
    $trustedSids = @('S-1-5-18', $adminSid, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    function Get-UntrustedWriters([string]$Path) {
      $found = @()
      if (-not (Test-Path -LiteralPath $Path)) { return @("missing $Path") }
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
      if ($ownerSid -eq '' -or $trustedSids -notcontains $ownerSid) { $found += "owner $ownerSid" }
      return $found
    }
    $bad = @()
    try {
      New-Item -ItemType Directory -Force -Path $secureDir | Out-Null
      # lock the folder first (Administrators and SYSTEM full control only, no inheritance, owner Administrators), then put the copy in
      $dirAcl = New-Object System.Security.AccessControl.DirectorySecurity
      $dirAcl.SetAccessRuleProtection($true, $false)
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
      foreach ($sidText in 'S-1-5-18', $adminSid) {
        $who = New-Object System.Security.Principal.SecurityIdentifier $sidText
        $dirAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, 'None', 'Allow')))
      }
      $dirAcl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier $adminSid))
      Set-Acl -LiteralPath $secureDir -AclObject $dirAcl
      if (Test-Path -LiteralPath $secureScript) { Remove-Item -Force -LiteralPath $secureScript }
      Copy-Item -Force $ensureScript $secureScript
      $bad = @(Get-UntrustedWriters $secureDir) + @(Get-UntrustedWriters $secureScript)
    } catch {
      $bad = @("could not secure $secureDir ($($_.Exception.Message))")
    }
    if ($bad.Count -gt 0) {
      Write-Warning ("Boot task NOT registered: $secureDir is not writable only by Administrators and SYSTEM (" + ($bad -join ', ') + '). Fix that folder, then run this script again. The firewall rules above are set for now.')
    } else {
      $taskArg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $secureScript
      $taskAction = New-ScheduledTaskAction -Execute $psExe -Argument $taskArg -WorkingDirectory $secureDir
      $taskTrigger = New-ScheduledTaskTrigger -AtStartup
      $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
      $task = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Re-asserts the MAXCOM live media firewall rules (UDP, local subnet) at every start (admin-only copy of scripts\ensure-live-firewall.ps1).'
      Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
      Write-Host "Registered task '$taskName': runs $secureScript as SYSTEM at every start (admin-only folder)."
    }
  }

  Write-Host "Done. mediamtx $MediamtxVersion and ffmpeg $ffVersion are in $Dest (see VERSIONS.md)."
}
finally {
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
