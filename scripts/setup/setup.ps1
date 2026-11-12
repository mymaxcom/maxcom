<#
.SYNOPSIS
  MAXCOM box setup for Windows: one idempotent run that lays the box down, sets the rights, makes the
  certificate, opens the firewall, registers the tasks and ends with the health check.
  Windows PowerShell 5.1, built-ins only, ASCII only.

.DESCRIPTION
  Run it from the extracted setup bundle (Pasang MAXCOM.cmd calls it). Order of the eleven steps:
    1 copy the setup into <root>\bin      2 stop the box (only when files must change)
    3 Node and live tools                 4 release and the current junction
    5 launcher and box-config.json        6 data folder (+ migration with -MigrateFrom)
    7 certificates                        8 firewall rule for HTTPS
    9 tasks, Start menu, Apps entry      10 power settings
   11 start the box and run Semak MAXCOM
  Running it twice with the same answers changes nothing the second time (each step says OK ... sudah siap).
  A step that fails stops the setup with its name; run it again to continue.

  -DryRun prints one DRYRUN line per step and changes nothing (no elevation needed; the checks of the
  preflight still run, a busy port is then only a warning).
  -LayoutOnly lays out files and junctions only (steps 1, 3 Node only, 4, 5, 6 folder only), in any folder,
  without elevation, tasks, firewall or certificates. It exists for tests.

.PARAMETER InstallRoot  Install root (default C:\Program Files\MAXCOM).
.PARAMETER DataDir      Data folder (default C:\ProgramData\MAXCOM\data). Its parent (default C:\ProgramData\MAXCOM) is created
                       and locked first (SYSTEM and Administrators full, Users read only, owner Administrators);
                       links are refused and a folder others can write is reset. Tests pass a temp -DataDir.
.PARAMETER Ip           The PC's address on the surau network (asked when not given).
.PARAMETER Surau        Short surau name for the certificate (letters, digits, space, dot, hyphen).
.PARAMETER HttpsPort    LAN HTTPS port (default 8443).
.PARAMETER Port         Loopback HTTP port (default 8787).
.PARAMETER Kiosk        khas (starts at logon), kongsi (Start menu shortcut only) or tiada.
.PARAMETER KioskUser    Windows account that shows the kiosk screen (mode khas).
.PARAMETER Power        kotak (never sleep on mains power) or kekal (change nothing).
.PARAMETER MigrateFrom  Data folder of a hand-run box to move into the installed layout.
.PARAMETER StopPid      PID of the hand-run box to stop (needed with -Yes and -MigrateFrom when it runs).
.PARAMETER CloudUrl     https address of the MAXCOM cloud (SURAU_CLOUD_URL and SURAU_WORKER_URL).
.PARAMETER BundleDir    The setup bundle folder (default: the parent of this script's folder).
.PARAMETER PinsFile     release-pins.json (default: next to the setup scripts).
.PARAMETER NewRoot      Allow a new root certificate when the data came from another PC.
.PARAMETER Yes          Do not ask; use the given answers, the saved ones or the defaults.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$DataDir = '',
  [string]$Ip = '',
  [string]$Surau = '',
  [ValidateRange(1, 65535)][int]$HttpsPort = 8443,
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [ValidateSet('khas', 'kongsi', 'tiada')][string]$Kiosk = '',
  [string]$KioskUser = '',
  [ValidateSet('kotak', 'kekal')][string]$Power = '',
  [string]$MigrateFrom = '',
  [int]$StopPid = 0,
  [string]$CloudUrl = '',
  [string]$BundleDir = '',
  [string]$PinsFile = '',
  [switch]$NewRoot,
  [switch]$DryRun,
  [switch]$LayoutOnly,
  [switch]$Yes,
  [switch]$PauseAtEnd
)

$ErrorActionPreference = 'Stop'
$script:Bound = $PSBoundParameters
Import-Module -Name (Join-Path $PSScriptRoot 'MaxcomSetup.psm1') -Global -Force -DisableNameChecking

$script:S = @{}
$script:Dirty = $false
$script:TaskDisabled = $false
$script:LastScriptOutput = @()
$script:OldBoxStopped = $false
$script:Failed = $false
$script:OldBoxCmd = ''
$script:NodeInfo = $null
$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'
$script:SidService = 'S-1-5-19'
$script:StepNames = @(
  '1 salin-persediaan', '2 henti-kotak', '3 runtime-alat', '4 keluaran', '5 konfigurasi', '6 folder-data',
  '7 sijil', '8 tembok-api', '9 tugas', '10 kuasa', '11 mula-semak'
)

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

function ConvertTo-QuotedArg([string]$Value) {
  if ($Value.Contains('"')) { throw "GAGAL: nilai tidak boleh mengandungi tanda petik: $Value" }
  if ($Value.EndsWith('\')) { $Value = $Value + '\' }
  return ('"' + $Value + '"')
}

function Get-Sha256Of([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) } finally { $sha.Dispose() }
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-SourceDirs {
  # The setup folder, its parent, and (only when run from a source checkout) apps\box-server\src\update.
  $dirs = @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot))
  $grand = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  if ($grand) {
    $upd = Join-Path $grand 'apps\box-server\src\update'
    $same = ((Join-Path $grand 'scripts\setup') -ieq $PSScriptRoot)
    if ($same -and (Test-Path -LiteralPath (Join-Path $upd 'launcher.mjs'))) { $dirs += $upd }
  }
  return $dirs
}

function Find-SetupFile([string]$Name) {
  foreach ($d in (Get-SourceDirs)) {
    $p = Join-Path $d $Name
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  return $null
}

function Copy-IfDifferent([string]$Src, [string]$Dst) {
  if (Test-Path -LiteralPath $Dst -PathType Leaf) {
    if ((Get-Sha256Of $Src) -eq (Get-Sha256Of $Dst)) { return $false }
  }
  [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $Dst))
  [System.IO.File]::Copy($Src, $Dst, $true)
  try { Unblock-File -LiteralPath $Dst } catch { }
  return $true
}

function Write-TextIfDifferent([string]$Path, [string]$Text) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $old = [System.IO.File]::ReadAllText($Path)
    if ($old -ceq $Text) { return $false }
  }
  [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

function Read-Line([string]$Prompt, [string]$Default = '') {
  if ($Default -ne '') { $t = Read-Host "$Prompt [$Default]" } else { $t = Read-Host $Prompt }
  if ([string]::IsNullOrWhiteSpace($t)) { return $Default }
  return $t.Trim()
}

function Get-EdgePath {
  $c = @()
  try {
    $v = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop).'(default)'
    if ($v) { $c += [string]$v }
  } catch { }
  if (${env:ProgramFiles(x86)}) { $c += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  foreach ($p in $c) { if (Test-Path -LiteralPath $p -PathType Leaf) { return $p } }
  return $null
}

function Update-State([hashtable]$Patch) {
  # Writes install.json only when a value really changes (no modified-time churn on a re-run).
  $old = Read-InstallState $script:S.P.InstallRoot
  $need = $false
  foreach ($k in $Patch.Keys) {
    $cur = $null
    if ($null -ne $old -and $null -ne $old.PSObject.Properties[$k]) { $cur = $old.$k }
    if ([string]$cur -ne [string]$Patch[$k]) { $need = $true }
  }
  if ($need) { [void](Write-InstallState $script:S.P.InstallRoot -State $Patch) }
  return $need
}

function Get-StateValue([string]$Name) {
  $st = $script:S.State
  if ($null -ne $st -and $null -ne $st.PSObject.Properties[$Name]) { return $st.$Name }
  return $null
}

function Invoke-SetupScript {
  param([Parameter(Mandatory)][string]$Name, [string[]]$Arguments = @(), [switch]$Show)
  $script1 = Resolve-SetupScript $Name
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $all = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script1) + $Arguments
  $out = @(& $ps @all)
  $code = $LASTEXITCODE
  $script:LastScriptOutput = $out
  if ($Show) { foreach ($l in $out) { Write-Host "  $l" } }
  if ($code -ne 0) {
    if (-not $Show) { foreach ($l in ($out | Select-Object -Last 15)) { Write-Host "  $l" } }
    throw "GAGAL: $Name gagal (kod $code)"
  }
  return $out
}

function Test-AclOnlyTrusted([string]$Path, [string[]]$Allowed, [switch]$Protected) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $acl = Get-Acl -LiteralPath $Path
  if ($Protected -and -not $acl.AreAccessRulesProtected) { return $false }
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { return $false }
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { return $false }
    if ($Allowed -notcontains $sid) { return $false }
  }
  return $true
}

function Test-RootAclOk {
  $r = $script:S.P.InstallRoot
  if (@(Get-UntrustedWriters $r).Count -gt 0) { return $false }
  return (Test-AclOnlyTrusted $r @($script:SidSystem, $script:SidAdmins, 'S-1-5-32-545') -Protected)
}

function Test-DataAclOk {
  # The one data ACL contract (module): data\ protected, secret\ and pki\ exact, everything below inherited.
  return (Test-MaxcomDataAcl $script:S.P.DataDir -ServiceSid $script:SidService)
}

$script:HomeDone = $false

function Get-MaxcomHomeLinks {
  # Reparse points among %ProgramData%\MAXCOM (the parent of the data folder), data\ and backups\.
  $P = $script:S.P
  $r = @()
  foreach ($x in @($P.MaxcomHome, $P.DataDir, $P.Backups, $P.HomeLogs)) {
    if (Test-IsReparsePoint $x) { $r += $x }
  }
  return $r
}

function Test-HomeAclOk {
  # SYSTEM and Administrators full, Users at most read; inheritance off; nobody else can write or own it.
  $h = $script:S.P.MaxcomHome
  if (@(Get-UntrustedWriters $h).Count -gt 0) { return $false }
  return (Test-AclOnlyTrusted $h @($script:SidSystem, $script:SidAdmins, 'S-1-5-32-545') -Protected)
}

function Get-HomeAclPlan {
  $h = $script:S.P.MaxcomHome
  return "icacls `"$h`" /setowner Administrators /inheritance:r /grant:r SYSTEM:(OI)(CI)F Administrators:(OI)(CI)F Users:(OI)(CI)RX ; pemilik dan kebenaran anak (kecuali data dan backups) ditetapkan semula"
}

function Initialize-MaxcomHome {
  # Creates and locks %ProgramData%\MAXCOM BEFORE data\ or backups\ are created inside it, so a standard user
  # cannot pre-create it and swap data\ for a junction. Refuses links; resets a folder with other writers.
  $S = $script:S
  $P = $S.P
  if ($script:HomeDone) { return $false }
  $h = $P.MaxcomHome
  $hp = @(Get-MaxcomHomeProblem $P.DataDir)
  if ($hp.Count -gt 0) { throw ('GAGAL: ' + ($hp -join '; ')) }
  $links = @(Get-MaxcomHomeLinks)
  if ($links.Count -gt 0) { throw ("GAGAL: pautan (reparse point), bukan folder sebenar: " + ($links -join ', ') + '. Buang pautan itu sebagai pentadbir, kemudian jalankan Pasang MAXCOM sekali lagi.') }
  $ch = $false
  if (-not (Test-Path -LiteralPath $h -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($h); $ch = $true }
  if (-not $S.LayoutOnly) {
    if (-not (Test-HomeAclOk)) {
      $w = @(Get-UntrustedWriters $h)
      if ($w.Count -gt 0) { Write-Host ("AMARAN: folder $h boleh ditulis oleh: " + ($w -join ', ') + '; kebenarannya ditetapkan semula sekarang.') }
      $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
      $adm = '*' + $script:SidAdmins
      & $icacls $h '/setowner' $adm | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GAGAL: icacls /setowner gagal pada folder MAXCOM' }
      & $icacls $h '/inheritance:r' '/grant:r' "*$($script:SidSystem):(OI)(CI)F" "$adm`:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'GAGAL: icacls gagal pada folder MAXCOM' }
      foreach ($child in [System.IO.Directory]::GetFileSystemEntries($h)) {
        $leaf = [System.IO.Path]::GetFileName($child)
        $isDataOrBackups = ($leaf -ieq 'data' -or $leaf -ieq 'backups')
        # Owner first (an owner can always change the ACL), then the ACL back to what the folder gives.
        & $icacls $child '/setowner' $adm '/T' '/C' '/L' '/Q' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "GAGAL: icacls /setowner gagal pada $child" }
        if (-not $isDataOrBackups) {
          & $icacls $child '/reset' '/T' '/C' '/L' '/Q' | Out-Null
          if ($LASTEXITCODE -ne 0) { throw "GAGAL: icacls /reset gagal pada $child" }
        }
      }
      if (-not (Test-HomeAclOk)) { throw "GAGAL: folder $h masih boleh ditulis oleh akaun lain" }
      $ch = $true
    }
  }
  # logs\ (outside data\): the SYSTEM certificate renewal writes its log here, where the box account cannot
  # swap it for a link. Created after the folder is locked, so it only inherits SYSTEM/Administrators/Users read.
  if (-not (Test-Path -LiteralPath $P.HomeLogs -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($P.HomeLogs); $ch = $true }
  $script:HomeDone = $true
  return $ch
}

function Initialize-BackupsDir {
  [void](Initialize-MaxcomHome)
  $b = $script:S.P.Backups
  [void][System.IO.Directory]::CreateDirectory($b)
  if ($script:S.LayoutOnly) { return }
  $allowed = @($script:SidSystem, $script:SidAdmins)
  if (Test-AclOnlyTrusted $b $allowed -Protected) { return }
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $icacls $b '/inheritance:r' '/grant:r' "*$($script:SidSystem):(OI)(CI)F" "*$($script:SidAdmins):(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GAGAL: icacls gagal pada folder backups' }
  if (-not (Test-AclOnlyTrusted $b $allowed -Protected)) { throw 'GAGAL: folder backups masih boleh dicapai oleh akaun lain' }
}

function Get-CurrentVersion {
  $cur = $script:S.P.Current
  if (-not (Test-IsReparsePoint $cur)) { return $null }
  $t = Get-LinkTarget $cur
  if (-not $t) { return $null }
  $leaf = Split-Path -Leaf $t
  if ($leaf -match '^[0-9]+\.[0-9]+\.[0-9]+$') { return $leaf }
  return $null
}

function Test-ReleaseCurrent {
  $v = $script:S.Version
  if ((Get-CurrentVersion) -ne $v) { return $false }
  return (Test-Path -LiteralPath (Join-Path (Join-Path $script:S.P.Releases $v) '.ok') -PathType Leaf)
}

# ---------------------------------------------------------------------------------------------
# Pins, Node, tools
# ---------------------------------------------------------------------------------------------

function Get-Pins {
  if (-not $script:S.PinsFile) { throw 'GAGAL: release-pins.json tiada (tidak dijumpai di folder persediaan)' }
  $pins = Get-Content -LiteralPath $script:S.PinsFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $names = @('node')
  if (-not $script:S.LayoutOnly) { $names += @('mediamtx', 'ffmpeg') }
  foreach ($n in $names) {
    $e = $pins.$n
    if ($null -eq $e) { throw "GAGAL: $n tiada dalam release-pins.json" }
    if ([string]$e.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "GAGAL: sha256 belum diisi untuk $n" }
    if ([string]$e.url -notmatch '^https://') { throw "GAGAL: url $n mesti bermula dengan https://" }
  }
  return $pins
}

function Get-ZipNameFromUrl([string]$Url) {
  $n = ([Uri]$Url).Segments[-1]
  if ($n -notmatch '^[A-Za-z0-9._-]+\.zip$') { throw "GAGAL: nama fail zip tidak sah dalam pin: $n" }
  return $n
}

function Get-NodeInfo {
  if ($null -ne $script:NodeInfo) { return $script:NodeInfo }
  $pins = Get-Pins
  $zipName = Get-ZipNameFromUrl ([string]$pins.node.url)
  $zip = Join-Path (Join-Path $script:S.BundleDir 'payload') $zipName
  if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "GAGAL: $zipName tiada dalam payload bundle" }
  if ((Get-Sha256Of $zip) -ne ([string]$pins.node.sha256).ToLowerInvariant()) { throw "GAGAL: sha256 $zipName tidak sama dengan pin" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $arch = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $nodeE = @($arch.Entries | Where-Object { $_.FullName -match '^node-v[0-9][A-Za-z0-9.-]*-win-x64/node\.exe$' })
    $licE = @($arch.Entries | Where-Object { $_.FullName -match '^node-v[0-9][A-Za-z0-9.-]*-win-x64/LICENSE$' })
    if ($nodeE.Count -ne 1) { throw 'GAGAL: zip Node mesti mengandungi tepat satu node.exe' }
    $info = @{ Zip = $zip; NodeName = $nodeE[0].FullName; LicName = ''; NodeHash = ''; LicHash = '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $s = $nodeE[0].Open()
      try { $info.NodeHash = (($sha.ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $s.Dispose() }
      if ($licE.Count -eq 1) {
        $info.LicName = $licE[0].FullName
        $s = $licE[0].Open()
        try { $info.LicHash = (($sha.ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $s.Dispose() }
      }
    } finally { $sha.Dispose() }
  } finally { $arch.Dispose() }
  $script:NodeInfo = $info
  return $info
}

function Test-NodeCurrent {
  $info = Get-NodeInfo
  $exe = $script:S.P.NodeExe
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $false }
  if ((Get-Sha256Of $exe) -ne $info.NodeHash) { return $false }
  if ($info.LicName -ne '') {
    $lic = Join-Path $script:S.P.NodeDir 'LICENSE'
    if (-not (Test-Path -LiteralPath $lic -PathType Leaf)) { return $false }
    if ((Get-Sha256Of $lic) -ne $info.LicHash) { return $false }
  }
  return $true
}

function Expand-ZipEntryTo($Arch, [string]$EntryName, [string]$Dest) {
  $e = $Arch.GetEntry($EntryName)
  if ($null -eq $e) { throw "GAGAL: $EntryName tiada dalam zip" }
  $part = $Dest + '.part'
  if (Test-Path -LiteralPath $part) { [System.IO.File]::Delete($part) }
  $in = $e.Open()
  try {
    $out = [System.IO.File]::Create($part)
    try { $in.CopyTo($out) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
  if (Test-Path -LiteralPath $Dest) { [System.IO.File]::Delete($Dest) }
  [System.IO.File]::Move($part, $Dest)
}

function Install-Node {
  $info = Get-NodeInfo
  [void][System.IO.Directory]::CreateDirectory($script:S.P.NodeDir)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $arch = [System.IO.Compression.ZipFile]::OpenRead($info.Zip)
  try {
    Expand-ZipEntryTo $arch $info.NodeName $script:S.P.NodeExe
    if ($info.LicName -ne '') { Expand-ZipEntryTo $arch $info.LicName (Join-Path $script:S.P.NodeDir 'LICENSE') }
  } finally { $arch.Dispose() }
  if ((Get-Sha256Of $script:S.P.NodeExe) -ne $info.NodeHash) { throw 'GAGAL: node.exe selepas salin tidak sama dengan pin' }
}

function Get-ToolArgs {
  $pins = Get-Pins
  $ver = [string]$pins.mediamtx.version
  if ($ver -notmatch '^v') { $ver = 'v' + $ver }
  if ($ver -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw "GAGAL: versi mediamtx tidak sah dalam pin: $ver" }
  return @{
    Dest = $script:S.P.LiveTools; MtxVersion = $ver; MtxSha = ([string]$pins.mediamtx.sha256).ToLowerInvariant()
    FfUrl = [string]$pins.ffmpeg.url; FfSha = ([string]$pins.ffmpeg.sha256).ToLowerInvariant()
  }
}

function Test-ToolsCurrent {
  $t = Get-ToolArgs
  $d = $t.Dest
  $v = Join-Path $d 'VERSIONS.md'
  if (-not (Test-Path -LiteralPath $v -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $d 'mediamtx\mediamtx.exe') -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $d 'ffmpeg\ffmpeg.exe') -PathType Leaf)) { return $false }
  $txt = [System.IO.File]::ReadAllText($v)
  return ($txt.Contains($t.MtxSha) -and $txt.Contains($t.FfSha))
}

# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------

function Read-ExistingConfigEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $c = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($c.v -ne 1) { return $null }
    $h = @{}
    if ($null -ne $c.env) { foreach ($p in $c.env.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } }
    return $h
  } catch { return $null }
}

function Resolve-Inputs {
  $S = $script:S
  $S.Dry = $DryRun.IsPresent
  $S.LayoutOnly = $LayoutOnly.IsPresent
  $S.Yes = $Yes.IsPresent
  $rootIn = $InstallRoot
  if ($rootIn -eq '') { $rootIn = Join-Path $env:ProgramFiles 'MAXCOM' }
  $root = ConvertTo-FullPath $rootIn
  $st = $null
  try { $st = Read-InstallState $root } catch { $st = $null }
  $S.State = $st
  $dataIn = $DataDir
  if ($dataIn -eq '' -and $null -ne $st -and $st.dataDir) { $dataIn = [string]$st.dataDir }
  $P = Get-MaxcomPaths -InstallRoot $root -DataDir $dataIn
  $S.P = $P
  $S.Ask = (-not $S.Yes)

  if ($BundleDir -ne '') { $S.BundleDir = ConvertTo-FullPath $BundleDir } else { $S.BundleDir = ConvertTo-FullPath (Split-Path -Parent $PSScriptRoot) }
  if ($PinsFile -ne '') { $S.PinsFile = ConvertTo-FullPath $PinsFile } else { $S.PinsFile = Find-SetupFile 'release-pins.json' }

  # ports: parameter, then the existing config, then the default
  $cfgEnv = Read-ExistingConfigEnv $P.BoxConfig
  $S.CfgEnv = $cfgEnv
  if ($script:Bound.ContainsKey('Port')) { $S.Port = $Port } elseif ($null -ne $cfgEnv -and $cfgEnv['SURAU_PORT']) { $S.Port = [int]$cfgEnv['SURAU_PORT'] } else { $S.Port = 8787 }
  if ($script:Bound.ContainsKey('HttpsPort')) { $S.HttpsPort = $HttpsPort } elseif ($null -ne $cfgEnv -and $cfgEnv['SURAU_HTTPS_PORT']) { $S.HttpsPort = [int]$cfgEnv['SURAU_HTTPS_PORT'] } else { $S.HttpsPort = 8443 }

  # surau name
  $v = $Surau
  if ($v -eq '' -and $null -ne $st -and $st.surau) { $v = [string]$st.surau }
  if ($v -eq '') { if ($S.Ask) { $v = Read-Line 'Nama pendek surau (huruf, nombor, ruang, titik, sempang)' 'Surau' } else { $v = 'Surau' } }
  if ($v -notmatch '^[A-Za-z0-9 .-]{1,40}$') { throw "GAGAL: nama surau tidak sah (huruf, nombor, ruang, titik, sempang; paling banyak 40): $v" }
  $S.Surau = $v

  # address
  $v = $Ip
  if ($v -eq '' -and $null -ne $st -and $st.ip) { $v = [string]$st.ip }
  $ips = @()
  try { $ips = @(Get-PrivateIPv4) } catch { $ips = @() }
  if ($v -eq '') {
    if ($ips.Count -eq 0) {
      if ($S.LayoutOnly -or $S.Dry) { $v = '127.0.0.1' } else { throw 'GAGAL: tiada alamat IPv4 persendirian dijumpai pada PC ini; sambungkan ke rangkaian surau atau beri -Ip' }
    } elseif ($S.Ask -and $ips.Count -gt 1) {
      Write-Host 'Alamat PC ini pada rangkaian:'
      for ($i = 0; $i -lt $ips.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $ips[$i]) }
      $pick = Read-Line 'Pilih nombor alamat untuk kotak MAXCOM' '1'
      if ($pick -notmatch '^[0-9]+$' -or [int]$pick -lt 1 -or [int]$pick -gt $ips.Count) { throw "GAGAL: pilihan tidak sah: $pick" }
      $v = $ips[[int]$pick - 1]
    } else { $v = $ips[0] }
  }
  $addr = $null
  if ($v -notmatch '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' -or -not [System.Net.IPAddress]::TryParse($v, [ref]$addr)) { throw "GAGAL: alamat IP tidak sah: $v" }
  $S.Ip = $v
  $S.IpOnThisPc = ($ips -contains $v) -or ($v -eq '127.0.0.1')

  # kiosk
  $v = $Kiosk
  if ($v -eq '' -and $null -ne $st -and $st.kiosk) { $v = [string]$st.kiosk }
  if ($v -eq '') {
    if ($S.Ask) {
      Write-Host 'Jenis skrin: khas = PC khas (skrin bermula sendiri), kongsi = PC dikongsi (hanya pintasan menu Start), tiada = tiada skrin.'
      $v = Read-Line 'Jenis skrin (khas/kongsi/tiada)' 'kongsi'
    } else { $v = 'kongsi' }
  }
  if (@('khas', 'kongsi', 'tiada') -notcontains $v) { throw "GAGAL: jenis skrin mesti khas, kongsi atau tiada: $v" }
  $S.Kiosk = $v
  $S.KioskUser = ''
  if ($v -eq 'khas') {
    $u = $KioskUser
    if ($u -eq '' -and $null -ne $st -and $st.kioskUser) { $u = [string]$st.kioskUser }
    if ($u -eq '') {
      $def = "$env:USERDOMAIN\$env:USERNAME"
      if ($S.Ask) { $u = Read-Line 'Akaun Windows yang menunjukkan skrin (bukan pentadbir)' $def } else { $u = $def }
    }
    if ($u -notmatch '^[A-Za-z0-9 ._$-]{1,64}(\\[A-Za-z0-9 ._$-]{1,64})?$') { throw "GAGAL: akaun skrin tidak sah: $u" }
    $S.KioskUser = $u
  }

  # power
  $v = $Power
  if ($v -eq '' -and $null -ne $st -and $st.power) { $v = [string]$st.power }
  if ($v -eq '') { if ($S.Kiosk -eq 'khas') { $v = 'kotak' } else { $v = 'kekal' } }
  $S.Power = $v

  # cloud url
  if ($CloudUrl -ne '' -and $CloudUrl -notmatch '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$') { throw "GAGAL: -CloudUrl mesti alamat https: $CloudUrl" }
  $S.CloudUrl = $CloudUrl

  # migration
  $S.MigrateFrom = ''
  if ($MigrateFrom -ne '') { $S.MigrateFrom = ConvertTo-FullPath $MigrateFrom }
  $S.StopPid = $StopPid

  # bundle archive and version
  $S.Archive = $null
  $S.Version = $null
  $found = @()
  foreach ($d in @($S.BundleDir, (Join-Path $S.BundleDir 'payload'))) {
    if (Test-Path -LiteralPath $d -PathType Container) {
      $found += @(Get-ChildItem -LiteralPath $d -File -Filter 'maxcom-box-*-windows.tar.gz')
    }
  }
  $ok = @($found | Where-Object { $_.Name -match '^maxcom-box-[0-9]+\.[0-9]+\.[0-9]+-windows\.tar\.gz$' })
  if ($ok.Count -eq 1) {
    $S.Archive = $ok[0].FullName
    $S.Version = ($ok[0].Name -replace '^maxcom-box-([0-9.]+)-windows\.tar\.gz$', '$1')
  }
}

function Get-PortProblems {
  $S = $script:S
  $P = $S.P
  $out = @()
  foreach ($pt in @($S.Port, $S.HttpsPort)) {
    foreach ($o in @(Get-PortOwner $pt)) {
      $cl = [string]$o.CommandLine
      if ($o.Name -eq 'node.exe' -and $cl.IndexOf($P.NodeExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
      if ($S.MigrateFrom -ne '' -and $o.Name -eq 'node.exe' -and $cl.Contains('main.ts')) { continue }
      $out += "port TCP $pt digunakan oleh PID $($o.Pid) ($($o.Name))"
    }
  }
  foreach ($up in @(8189, 8890)) {
    $eps = @()
    try { $eps = @(Get-NetUDPEndpoint -LocalPort $up -ErrorAction SilentlyContinue) } catch { $eps = @() }
    $seen = @{}
    foreach ($e in $eps) {
      $procId = [int]$e.OwningProcess
      if ($seen.ContainsKey($procId)) { continue }
      $seen[$procId] = $true
      $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
      $path = ''
      $name = ''
      if ($null -ne $cim) { $path = [string]$cim.ExecutablePath; $name = [string]$cim.Name }
      if ($path -ne '' -and $path.StartsWith($P.LiveTools + '\', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      if ($S.MigrateFrom -ne '' -and $name -eq 'mediamtx.exe') { continue }
      $out += "port UDP $up digunakan oleh PID $procId ($name)"
    }
  }
  return $out
}

function Invoke-Preflight {
  $S = $script:S
  $P = $S.P
  $probs = New-Object System.Collections.ArrayList
  $warns = New-Object System.Collections.ArrayList
  if (-not $S.LayoutOnly) {
    if ([Environment]::OSVersion.Version.Build -lt 17763) { [void]$probs.Add('perlukan Windows 10 versi 1809 atau lebih baharu') }
    if (-not [Environment]::Is64BitOperatingSystem) { [void]$probs.Add('perlukan Windows 64-bit') }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\tar.exe') -PathType Leaf)) { [void]$probs.Add('tar.exe tiada di System32') }
  foreach ($m in @(Get-BundleManifestProblem $S.BundleDir | Select-Object -First 8)) { [void]$probs.Add("bundle: $m") }
  if ($null -eq $S.Archive) { [void]$probs.Add('arkib keluaran maxcom-box-<versi>-windows.tar.gz tidak dijumpai (tepat satu) dalam bundle') }
  foreach ($m in @(Get-InstallRootProblem $P.InstallRoot -AllowUserProfile:$S.LayoutOnly)) { [void]$probs.Add($m) }
  if ((Test-PathInside $P.DataDir $P.InstallRoot -AllowEqual) -or (Test-PathInside $P.InstallRoot $P.DataDir -AllowEqual)) {
    [void]$probs.Add('folder data dan folder pemasangan tidak boleh berada di dalam satu sama lain')
  }
  # The parent of the data folder is locked and re-owned by setup: it must be a folder of MAXCOM's own.
  foreach ($m in @(Get-MaxcomHomeProblem $P.DataDir)) { [void]$probs.Add($m) }
  if (-not $S.LayoutOnly) {
    foreach ($g in @($env:USERPROFILE, (Join-Path $env:SystemDrive 'Users'))) {
      if ($g -and (Test-PathInside $P.DataDir (ConvertTo-FullPath $g) -AllowEqual)) { [void]$probs.Add("folder data tidak boleh berada dalam profil pengguna: $($P.DataDir)"); break }
    }
    try {
      $drive = New-Object System.IO.DriveInfo(([System.IO.Path]::GetPathRoot($P.InstallRoot)))
      if ($drive.AvailableFreeSpace -lt 2GB) { [void]$probs.Add('ruang kosong kurang daripada 2 GB pada pemacu pemasangan') }
    } catch { [void]$probs.Add("ruang kosong tidak dapat disemak: $($_.Exception.Message)") }
    $pp = @(Get-PortProblems)
    foreach ($m in $pp) {
      if ($S.Dry) { [void]$warns.Add("$m (pemasangan sebenar akan GAGAL)") } else { [void]$probs.Add($m) }
    }
    if (-not $S.IpOnThisPc) {
      if ($S.Dry) { [void]$warns.Add("alamat $($S.Ip) bukan alamat PC ini (pemasangan sebenar akan GAGAL)") } else { [void]$probs.Add("alamat $($S.Ip) bukan alamat PC ini") }
    }
    if ($null -eq (Get-EdgePath)) {
      if ($S.Kiosk -eq 'tiada') { [void]$warns.Add('Microsoft Edge tidak dijumpai (skrin tiada)') } else { [void]$probs.Add('Microsoft Edge tidak dijumpai; skrin MAXCOM memerlukannya') }
    }
  }
  foreach ($l in @(Get-MaxcomHomeLinks)) { [void]$probs.Add("pautan (reparse point), bukan folder sebenar: $l") }
  if (Test-Path -LiteralPath $P.MaxcomHome -PathType Container) {
    $hw = @(Get-UntrustedWriters $P.MaxcomHome)
    if ($hw.Count -gt 0) { [void]$warns.Add("folder $($P.MaxcomHome) sudah ada dan boleh ditulis oleh: $($hw -join ', '); pemasangan sebenar menetapkan semula kebenarannya") }
  }
  if ($S.MigrateFrom -ne '') {
    if (-not (Test-Path -LiteralPath (Join-Path $S.MigrateFrom 'surau.db') -PathType Leaf)) { [void]$probs.Add("surau.db tiada dalam folder -MigrateFrom: $($S.MigrateFrom)") }
    if (-not (Test-Path -LiteralPath (Join-Path $S.MigrateFrom 'secret\box.key') -PathType Leaf)) { [void]$probs.Add("secret\box.key tiada dalam folder -MigrateFrom: $($S.MigrateFrom)") }
    if ((Test-PathInside $S.MigrateFrom $P.InstallRoot -AllowEqual) -or (Test-PathInside $P.InstallRoot $S.MigrateFrom -AllowEqual)) { [void]$probs.Add('-MigrateFrom bertindih dengan folder pemasangan') }
    # Before anything is stopped: will the old root certificate be usable on this PC? If not, a NEW root is needed
    # and every phone and iPad must enrol again, so that is only done when -NewRoot says so.
    if (-not $S.LayoutOnly) {
      $oldMeta = Join-Path $S.MigrateFrom 'pki\box-ca.json'
      if (Test-Path -LiteralPath $oldMeta -PathType Leaf) {
        $oldStore = ''
        $keyOk = $false
        try {
          $om = Get-Content -LiteralPath $oldMeta -Raw -Encoding UTF8 | ConvertFrom-Json
          $oldStore = [string]$om.store
          if ($oldStore -eq 'LocalMachine') { $keyOk = (Test-RootKeyPresent (Join-Path $S.MigrateFrom 'pki\root-ca.cer')) }
        } catch { $keyOk = $false }
        if (-not $keyOk) {
          Write-Host 'AMARAN: kunci sijil akar kotak lama tiada di PC ini (sijil disimpan di akaun pengguna atau di PC lain).'
          Write-Host '  Sijil akar BAHARU akan diperlukan: semua telefon dan iPad perlu didaftar semula.'
          if (-not $NewRoot.IsPresent) { [void]$probs.Add('sijil akar kotak lama tidak boleh digunakan di PC ini; tiada apa dihentikan. Jalankan semula dengan -NewRoot jika anda bersetuju semua telefon didaftar semula.') }
        }
      }
    }
  }
  if ($S.Kiosk -eq 'khas' -and $S.KioskUser -ne '' -and -not $S.LayoutOnly) {
    # The kiosk user is checked again by install-kiosk-task.ps1 (it refuses system and administrator accounts).
    $null = $S.KioskUser
  }
  foreach ($w in $warns) { Write-Host "AMARAN pra-semak: $w" }
  if ($probs.Count -gt 0) {
    foreach ($m in $probs) { Write-Host "GAGAL: pra-semak: $m" }
    return $false
  }
  Write-Host "OK pra-semak: bundle disahkan (versi $($S.Version)), tiada apa diubah lagi"
  return $true
}

function Start-Elevated {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-QuotedArg $PSCommandPath))
  foreach ($k in $script:Bound.Keys) {
    if ($k -eq 'PauseAtEnd') { continue }
    $v = $script:Bound[$k]
    if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $a += "-$k" } }
    else { $a += "-$k"; $a += (ConvertTo-QuotedArg ([string]$v)) }
  }
  $a += '-PauseAtEnd'
  Write-Host 'Pemasangan memerlukan hak pentadbir. Tetingkap baharu akan dibuka; sila benarkan (Yes).'
  try {
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $a -Verb RunAs -Wait -PassThru
  } catch {
    throw 'GAGAL: hak pentadbir tidak diberi. Klik kanan Pasang MAXCOM dan pilih Run as administrator.'
  }
  return [int]$p.ExitCode
}

# ---------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------

function Get-BinFiles {
  $required = @(
    'setup.ps1', 'MaxcomSetup.psm1', 'box-ca.ps1', 'box-cert-renew.ps1', 'install-cert-renew-task.ps1',
    'install-box-task.ps1', 'ensure-box-firewall.ps1', 'ensure-live-firewall.ps1', 'install-live-tools.ps1',
    'cli.mjs', 'maxcom.cmd'
  )
  $optional = @(
    'doctor.ps1', 'uninstall.ps1', 'switch-release.ps1', 'migrate-data.ps1', 'install-kiosk-task.ps1',
    'start-kiosk.ps1', 'set-box-power.ps1', 'Semak MAXCOM.cmd', 'Buang MAXCOM.cmd', 'maxcom.ico'
  )
  return @{ Required = $required; Optional = $optional }
}

function Step-CopySetup {
  $S = $script:S
  $P = $S.P
  $ch = $false
  if (-not (Test-Path -LiteralPath $P.InstallRoot -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($P.InstallRoot); $ch = $true }
  if (-not $S.LayoutOnly) {
    if (-not (Test-RootAclOk)) { [void](Set-MaxcomRootAcl $P.InstallRoot); $ch = $true }
  }
  [void][System.IO.Directory]::CreateDirectory($P.Bin)
  $bf = Get-BinFiles
  foreach ($n in $bf.Required) {
    $src = Find-SetupFile $n
    if ($null -eq $src) { throw "GAGAL: $n tiada dalam bundle persediaan" }
    if (Copy-IfDifferent $src (Join-Path $P.Bin $n)) { $ch = $true }
  }
  foreach ($n in $bf.Optional) {
    $src = Find-SetupFile $n
    if ($null -ne $src) { if (Copy-IfDifferent $src (Join-Path $P.Bin $n)) { $ch = $true } }
  }
  # doctor compares tools\live\VERSIONS.md with these pins, so the pins used for this install go into bin.
  if ($S.PinsFile -and (Test-Path -LiteralPath $S.PinsFile -PathType Leaf)) {
    if (Copy-IfDifferent $S.PinsFile (Join-Path $P.Bin 'release-pins.json')) { $ch = $true }
  }
  $patch = @{
    installRoot = $P.InstallRoot; dataDir = $P.DataDir; ip = $S.Ip; surau = $S.Surau; kiosk = $S.Kiosk
    kioskUser = $S.KioskUser; power = $S.Power; port = $S.Port; httpsPort = $S.HttpsPort
  }
  if (Update-State $patch) { $ch = $true }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Stop-Box {
  $S = $script:S
  $t = Get-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue
  if ($null -ne $t) {
    # Disabled while files change, so the 5 minute trigger cannot start it half way. Step 11 enables it.
    Disable-ScheduledTask -TaskName 'MAXCOM Box' | Out-Null
    $script:TaskDisabled = $true
    if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName 'MAXCOM Box' }
  }
  for ($i = 0; $i -lt 30; $i++) {
    $busy = @(Get-PortOwner $S.Port | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($S.P.NodeExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($busy.Count -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  $o = @(Get-PortOwner $S.Port | Select-Object -First 1)
  throw "GAGAL: port $($S.Port) masih digunakan oleh PID $($o[0].Pid) ($($o[0].Name)) selepas tugas dihentikan"
}

function Step-StopBox {
  $S = $script:S
  $pending = (-not (Test-ReleaseCurrent)) -or (-not (Test-NodeCurrent))
  if (-not $pending) { if (-not (Test-ToolsCurrent)) { $pending = $true } }
  if (-not $pending) { return $false }
  $t = Get-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue
  $busy = @(Get-PortOwner $S.Port | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($S.P.NodeExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($null -eq $t -and $busy.Count -eq 0) { return $false }
  Stop-Box
  $script:Dirty = $true
  return $true
}

function Step-RuntimeTools {
  $S = $script:S
  $ch = $false
  if (-not (Test-NodeCurrent)) { Stop-BoxIfRunning; Install-Node; $ch = $true }
  if (-not $S.LayoutOnly) {
    if (-not (Test-ToolsCurrent)) {
      Stop-BoxIfRunning
      $t = Get-ToolArgs
      $args1 = @(
        '-Dest', $t.Dest, '-MediamtxVersion', $t.MtxVersion, '-MediamtxSha256', $t.MtxSha,
        '-FfmpegUrl', $t.FfUrl, '-FfmpegSha256', $t.FfSha, '-SourceDir', (Join-Path $S.BundleDir 'payload')
      )
      [void](Invoke-SetupScript 'install-live-tools.ps1' $args1)
      $ch = $true
    }
  }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Stop-BoxIfRunning {
  if ($script:S.LayoutOnly) { return }
  $t = Get-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue
  if ($null -ne $t -and $t.State -eq 'Running') { Stop-Box }
}

function Backup-Database {
  $P = $script:S.P
  Initialize-BackupsDir
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $dir = Join-Path $P.Backups ("pre-{0}-{1}" -f $script:S.Version, $stamp)
  [void][System.IO.Directory]::CreateDirectory($dir)
  foreach ($suffix in @('', '-wal', '-shm')) {
    $f = $P.Db + $suffix
    if (Test-Path -LiteralPath $f -PathType Leaf) { Copy-Item -LiteralPath $f -Destination (Join-Path $dir (Split-Path -Leaf $f)) -Force }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'surau.db') -PathType Leaf)) { throw "GAGAL: salinan pangkalan data tidak dibuat di $dir" }
  # Only the newest 3 setup backups are kept; the one just made is never removed.
  $gone = Remove-OldBackups $P.Backups -Keep 3 -Except $dir
  if ($gone -gt 0) { Write-Host "  $gone sandaran lama dibuang (3 terkini dikekalkan)" }
}

function Remove-OldReleases {
  $P = $script:S.P
  if (-not (Test-Path -LiteralPath $P.Releases -PathType Container)) { return $false }
  $keep = @($script:S.Version)
  $cv = Get-CurrentVersion
  if ($cv) { $keep += $cv }
  if (Test-Path -LiteralPath $P.PreviousTxt -PathType Leaf) {
    $pv = ([System.IO.File]::ReadAllText($P.PreviousTxt)).Trim()
    if ($pv -match '^[0-9]+\.[0-9]+\.[0-9]+$') { $keep += $pv }
  }
  $ch = $false
  foreach ($d in [System.IO.Directory]::GetFileSystemEntries($P.Releases)) {
    $n = Split-Path -Leaf $d
    if ($n -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(\.part)?$') { continue }
    if ($keep -contains $n) { continue }
    [void](Remove-TreeSafe $d -Under $P.Releases)
    $ch = $true
  }
  return $ch
}

function Step-Release {
  $S = $script:S
  $P = $S.P
  $ch = $false
  $ver = $S.Version
  $curVer = Get-CurrentVersion
  if ($curVer -and ([version]$ver -lt [version]$curVer)) {
    throw "GAGAL: versi $ver lebih lama daripada $curVer yang sedang dipasang; gunakan switch-release.ps1 untuk kembali"
  }
  $rel = Expand-Release -Archive $S.Archive -ReleasesDir $P.Releases -Version $ver
  if ($rel.Changed) { $ch = $true }
  if ($curVer -ne $ver) {
    if (Test-Path -LiteralPath $P.Db -PathType Leaf) { Backup-Database }
    $sw = Switch-Current -Root $P.InstallRoot -Version $ver
    if ($sw.Changed) { $ch = $true }
  }
  if (Remove-OldReleases) { $ch = $true }
  if (Update-State @{ version = $ver }) { $ch = $true }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Step-Config {
  $S = $script:S
  $P = $S.P
  $ch = $false
  $l = Find-SetupFile 'launcher.mjs'
  $c = Find-SetupFile 'start.cmd'
  if ($null -eq $l) { throw 'GAGAL: launcher.mjs tiada dalam bundle persediaan' }
  if ($null -eq $c) { throw 'GAGAL: start.cmd tiada dalam bundle persediaan' }
  if (Copy-IfDifferent $l $P.Launcher) { $ch = $true }
  if (Copy-IfDifferent $c $P.StartCmd) { $ch = $true }
  $env1 = @{}
  if ($null -ne $S.CfgEnv) { foreach ($k in $S.CfgEnv.Keys) { $env1[$k] = $S.CfgEnv[$k] } }
  else { $env1['SURAU_CLOUD_URL'] = 'https://api.mymaxcom.my'; $env1['SURAU_WORKER_URL'] = 'https://api.mymaxcom.my' }
  if ($script:Bound.ContainsKey('Port') -or $env1.ContainsKey('SURAU_PORT')) { $env1['SURAU_PORT'] = [string]$S.Port }
  if ($script:Bound.ContainsKey('HttpsPort') -or $env1.ContainsKey('SURAU_HTTPS_PORT')) { $env1['SURAU_HTTPS_PORT'] = [string]$S.HttpsPort }
  if ($S.CloudUrl -ne '') { $env1['SURAU_CLOUD_URL'] = $S.CloudUrl; $env1['SURAU_WORKER_URL'] = $S.CloudUrl }
  $sorted = [ordered]@{}
  foreach ($k in ($env1.Keys | Sort-Object)) { $sorted[$k] = $env1[$k] }
  $cfg = [ordered]@{ v = 1; dataDir = $P.DataDir; env = $sorted }
  $json = ($cfg | ConvertTo-Json -Depth 4) + "`r`n"
  if (Write-TextIfDifferent $P.BoxConfig $json) { $ch = $true }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Read-OldBoxFacts($Lines) {
  # migrate-data.ps1 prints the old box's command line before it stops the box ("arahan: ...") and
  # "SET henti kotak lama" once it has. Kept so a later failure can say how to start the old box again.
  foreach ($l in @($Lines)) {
    $t = [string]$l
    if ($t -match '^\s*arahan: (.+)$') { $script:OldBoxCmd = $Matches[1].Trim() }
    if ($t -match 'SET henti kotak lama') { $script:OldBoxStopped = $true }
  }
}

function Restore-AfterFailure {
  # Runs in a finally: a failed setup must not leave the box task disabled or the old hand-run box unexplained.
  if ($script:TaskDisabled) {
    try {
      Enable-ScheduledTask -TaskName 'MAXCOM Box' | Out-Null
      $script:TaskDisabled = $false
      Write-Host 'Tugas MAXCOM Box dihidupkan semula (pemasangan tidak selesai).'
    } catch {
      Write-Host 'GAGAL: tugas MAXCOM Box masih dimatikan. Hidupkan dengan: Enable-ScheduledTask -TaskName "MAXCOM Box"'
    }
  }
  if ($script:Failed -and $script:OldBoxStopped) {
    Write-Host 'Kotak lama (jalan dengan tangan) telah dihentikan oleh persediaan ini. Folder datanya TIDAK diubah.'
    if ($script:OldBoxCmd -ne '') {
      Write-Host '  Untuk menghidupkannya semula, dari folder kotak lama jalankan:'
      Write-Host "  $($script:OldBoxCmd)"
    } else {
      Write-Host '  Hidupkan semula dengan cara biasa anda memulakannya.'
    }
  }
}

function Step-DataFolder {
  $S = $script:S
  $P = $S.P
  $ch = $false
  if (Initialize-MaxcomHome) { $ch = $true }
  if (-not (Test-Path -LiteralPath $P.DataDir -PathType Container)) { [void][System.IO.Directory]::CreateDirectory($P.DataDir); $ch = $true }
  if (-not $S.LayoutOnly) {
    if (-not (Test-DataAclOk)) { [void](Set-MaxcomDataAcl $P.DataDir -ServiceSid $script:SidService); $ch = $true }
  }
  Initialize-BackupsDir
  if ($S.MigrateFrom -ne '') {
    $done = Get-StateValue 'migratedFrom'
    if ($done -and ([string]$done -ieq $S.MigrateFrom)) {
      Write-Host '  migrasi data sudah dibuat sebelum ini'
    } else {
      $args1 = @(
        '-From', $S.MigrateFrom, '-DataDir', $P.DataDir, '-BackupRoot', $P.Backups, '-NodeExe', $P.NodeExe,
        '-ServiceSid', $script:SidService, '-Port', [string]$S.Port
      )
      if ($S.StopPid -gt 0) { $args1 += @('-StopPid', [string]$S.StopPid) }
      if ($S.Yes) { $args1 += '-Yes' }
      if ($S.LayoutOnly) { $args1 += '-SkipAcl' }
      try {
        $out = Invoke-SetupScript 'migrate-data.ps1' $args1 -Show
      } finally {
        Read-OldBoxFacts $script:LastScriptOutput
      }
      foreach ($l in $out) { if ([string]$l -match '^BOXID ([0-9a-f]{16})$') { $S.BoxId = $Matches[1] } }
      [void](Update-State @{ migratedFrom = $S.MigrateFrom })
      $ch = $true
    }
  }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Test-RootKeyPresent([string]$RootCer) {
  if (-not (Test-Path -LiteralPath $RootCer -PathType Leaf)) { return $false }
  $cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($RootCer)
  $m = @(Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Thumbprint -eq $cer.Thumbprint -and $_.HasPrivateKey })
  return ($m.Count -gt 0)
}

function New-BoxCertificate {
  $S = $script:S
  $a = @('-Ip', $S.Ip, '-Surau', $S.Surau, '-DataDir', $S.P.DataDir, '-ServiceAccount', $script:SidService)
  [void](Invoke-SetupScript 'box-ca.ps1' $a)
  # box-ca.ps1 leaves the running administrator on secret\; the final data ACL must be applied AFTER it.
  [void](Set-MaxcomDataAcl $S.P.DataDir -ServiceSid $script:SidService)
}

function Step-Certificates {
  $changed = [bool](Step-CertificatesCore)
  # uninstall.ps1 -RemoveCa trusts this value from install.json (not a file the box account could write).
  $cer = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Join-Path $script:S.P.Pki 'root-ca.cer'))
  $tp = $cer.Thumbprint.ToUpperInvariant()
  $inMy = @(Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Thumbprint -eq $tp -and $_.HasPrivateKey })
  if ($inMy.Count -eq 0) { throw 'GAGAL: kunci sijil akar tiada dalam LocalMachine\My selepas langkah sijil' }
  if (Update-State @{ rootThumbprint = $tp }) { $changed = $true }
  return $changed
}

function Step-CertificatesCore {
  $S = $script:S
  $P = $S.P
  $metaFile = Join-Path $P.Pki 'box-ca.json'
  $rootCer = Join-Path $P.Pki 'root-ca.cer'
  if (-not (Test-Path -LiteralPath $metaFile -PathType Leaf)) {
    New-BoxCertificate
    $script:Dirty = $true
    return $true
  }
  $m = Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $keyOk = ([string]$m.store -eq 'LocalMachine') -and (Test-RootKeyPresent $rootCer)
  if (-not $keyOk) {
    Write-Host 'Data ini dibuat di PC lain: kunci sijil akar tiada di PC ini.'
    Write-Host '  Pilihan 1: buat sijil akar baharu. Semua telefon dan iPad perlu didaftar semula.'
    Write-Host '  Pilihan 2: batal. Tiada apa diubah.'
    $go = $NewRoot.IsPresent
    if (-not $go -and -not $S.Yes) { $go = ((Read-Line 'Buat sijil akar baharu? (y/t)' 't') -match '^[yY]') }
    if (-not $go) { throw 'GAGAL: sijil akar tiada di PC ini. Jalankan semula dengan -NewRoot untuk membuat yang baharu, atau batalkan.' }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    [System.IO.Directory]::Move($P.Pki, (Join-Path $P.DataDir ("pki.lama-$stamp")))
    $old = Join-Path $P.Secret ("lama-$stamp")
    [void][System.IO.Directory]::CreateDirectory($old)
    foreach ($n in @('box.pfx', 'pfx.pass')) {
      $f = Join-Path $P.Secret $n
      if (Test-Path -LiteralPath $f -PathType Leaf) { [System.IO.File]::Move($f, (Join-Path $old $n)) }
    }
    New-BoxCertificate
    $script:Dirty = $true
    return $true
  }
  if ([string]$m.ip -ne $S.Ip -or [string]$m.serviceAccount -ne $script:SidService) {
    $days = 730
    if ($m.days) { $days = [int]$m.days }
    $name = $S.Surau
    if ($m.surau) { $name = [string]$m.surau }
    $a = @('-Renew', '-Ip', $S.Ip, '-Surau', $name, '-DataDir', $P.DataDir, '-Days', [string]$days, '-ServiceAccount', $script:SidService)
    [void](Invoke-SetupScript 'box-ca.ps1' $a)
    [void](Set-MaxcomDataAcl $P.DataDir -ServiceSid $script:SidService)
    $script:Dirty = $true
    return $true
  }
  if (-not (Test-DataAclOk)) { [void](Set-MaxcomDataAcl $P.DataDir -ServiceSid $script:SidService); return $true }
  return $false
}

function Step-Firewall {
  $S = $script:S
  $sig = Get-TextSha256 ("{0}|{1}|{2}" -f $S.HttpsPort, $S.P.NodeExe, (Get-Sha256Of (Join-Path $S.P.Bin 'ensure-box-firewall.ps1')))
  $rule = Get-NetFirewallRule -DisplayName 'MAXCOM Box HTTPS' -ErrorAction SilentlyContinue
  if ($null -ne $rule -and (Get-StateValue 'sigTembok') -eq $sig) { return $false }
  [void](Invoke-SetupScript 'ensure-box-firewall.ps1' @('-HttpsPort', [string]$S.HttpsPort, '-Program', $S.P.NodeExe))
  [void](Update-State @{ sigTembok = $sig })
  return $true
}

function Set-Shortcut([string]$Lnk, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Desc, [string]$Icon = '') {
  $sh = New-Object -ComObject WScript.Shell
  $iconWant = ''
  if ($Icon -ne '') { $iconWant = $Icon + ',0' }
  if (Test-Path -LiteralPath $Lnk -PathType Leaf) {
    $e = $sh.CreateShortcut($Lnk)
    $iconSame = ($iconWant -eq '' -or [string]$e.IconLocation -eq $iconWant)
    if ($e.TargetPath -eq $Target -and $e.Arguments -eq $Arguments -and $iconSame) { return $false }
  }
  $s = $sh.CreateShortcut($Lnk)
  $s.TargetPath = $Target
  $s.Arguments = $Arguments
  $s.WorkingDirectory = $WorkDir
  $s.Description = $Desc
  if ($iconWant -ne '') { $s.IconLocation = $iconWant }
  $s.Save()
  return $true
}

function Step-Tasks {
  $S = $script:S
  $P = $S.P
  $ch = $false
  $parts = @($P.InstallRoot, $P.DataDir, $S.Kiosk, $S.KioskUser)
  foreach ($n in @('install-box-task.ps1', 'install-cert-renew-task.ps1', 'install-kiosk-task.ps1')) {
    $f = Join-Path $P.Bin $n
    if (Test-Path -LiteralPath $f -PathType Leaf) { $parts += (Get-Sha256Of $f) }
  }
  $sig = Get-TextSha256 ($parts -join '|')
  $need = @('MAXCOM Box', 'MaxcomCertRenew')
  if ($S.Kiosk -eq 'khas') { $need += 'MAXCOM Kiosk' }
  $missing = $false
  foreach ($t in $need) { if ($null -eq (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) { $missing = $true } }
  $kioskThere = ($null -ne (Get-ScheduledTask -TaskName 'MAXCOM Kiosk' -ErrorAction SilentlyContinue))
  if ($missing -or (Get-StateValue 'sigTugas') -ne $sig) {
    [void](Invoke-SetupScript 'install-box-task.ps1' @('-InstallRoot', $P.InstallRoot))
    [void](Invoke-SetupScript 'install-cert-renew-task.ps1' @('-AsSystem', '-ScriptDir', $P.Bin, '-DataDir', $P.DataDir, '-LogDir', $P.HomeLogs))
    if ($S.Kiosk -eq 'khas') {
      [void](Invoke-SetupScript 'install-kiosk-task.ps1' @('-InstallRoot', $P.InstallRoot, '-User', $S.KioskUser))
    } elseif ($kioskThere) {
      [void](Invoke-SetupScript 'install-kiosk-task.ps1' @('-InstallRoot', $P.InstallRoot, '-User', 'x', '-Uninstall'))
    }
    [void](Update-State @{ sigTugas = $sig })
    $ch = $true
  } elseif ($S.Kiosk -ne 'khas' -and $kioskThere) {
    [void](Invoke-SetupScript 'install-kiosk-task.ps1' @('-InstallRoot', $P.InstallRoot, '-User', 'x', '-Uninstall'))
    $ch = $true
  }

  # Start menu folder for all users
  [void][System.IO.Directory]::CreateDirectory($P.StartMenu)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $semak = Join-Path $P.Bin 'Semak MAXCOM.cmd'
  $buang = Join-Path $P.Bin 'Buang MAXCOM.cmd'
  $icoBin = Join-Path $P.Bin 'maxcom.ico'
  $icoUse = ''
  if (Test-Path -LiteralPath $icoBin -PathType Leaf) { $icoUse = $icoBin }
  if (Test-Path -LiteralPath $semak -PathType Leaf) {
    if (Set-Shortcut (Join-Path $P.StartMenu 'Semak MAXCOM.lnk') $semak '' $P.Bin 'Semak kesihatan MAX Kiosk Server' $icoUse) { $ch = $true }
  } else { Write-Host 'AMARAN: Semak MAXCOM.cmd tiada, pintasan tidak dibuat' }
  if (Test-Path -LiteralPath $buang -PathType Leaf) {
    if (Set-Shortcut (Join-Path $P.StartMenu 'Buang MAXCOM.lnk') $buang '' $P.Bin 'Buang perisian MAX Kiosk Server (data surau dikekalkan)' $icoUse) { $ch = $true }
  } else { Write-Host 'AMARAN: Buang MAXCOM.cmd tiada, pintasan tidak dibuat' }
  $kioskPs1 = Join-Path $P.Bin 'start-kiosk.ps1'
  if (Test-Path -LiteralPath $kioskPs1 -PathType Leaf) {
    $a = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (ConvertTo-QuotedArg $kioskPs1) + ' -NoRestart'
    if (Set-Shortcut (Join-Path $P.StartMenu 'Skrin MAXCOM.lnk') $ps $a $P.Bin 'Buka skrin MAXCOM' $icoUse) { $ch = $true }
  } else { Write-Host 'AMARAN: start-kiosk.ps1 tiada, pintasan Skrin MAXCOM tidak dibuat' }
  $stopLnk = Join-Path $P.StartMenu 'Henti skrin MAXCOM.lnk'
  if ($S.Kiosk -eq 'khas') {
    $cmd = 'New-Item -ItemType Directory -Force (Join-Path $env:LOCALAPPDATA ''MAXCOM'') | Out-Null; New-Item -ItemType File -Force (Join-Path $env:LOCALAPPDATA ''MAXCOM\kiosk-stop'') | Out-Null'
    $a = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "' + $cmd + '"'
    if (Set-Shortcut $stopLnk $ps $a $P.Bin 'Henti skrin MAXCOM sehingga log masuk seterusnya' $icoUse) { $ch = $true }
  } elseif (Test-Path -LiteralPath $stopLnk -PathType Leaf) {
    [System.IO.File]::Delete($stopLnk)
    $ch = $true
  }

  # Apps list entry
  $uk = $P.UninstallKey
  $want = @{
    DisplayName = 'MAX Kiosk Server'; DisplayVersion = [string]$S.Version; Publisher = 'MAXCOM'
    InstallLocation = $P.InstallRoot; UninstallString = ('"' + $buang + '"')
  }
  if ($icoUse -ne '') { $want['DisplayIcon'] = $icoUse }
  $cur = $null
  if (Test-Path -LiteralPath $uk) { $cur = Get-ItemProperty -LiteralPath $uk }
  $same = ($null -ne $cur)
  if ($same) {
    foreach ($k in $want.Keys) { if ([string]$cur.$k -ne $want[$k]) { $same = $false } }
    if ($cur.NoModify -ne 1 -or $cur.NoRepair -ne 1) { $same = $false }
  }
  if (-not $same) {
    if (-not (Test-Path -LiteralPath $uk)) { New-Item -Path $uk -Force | Out-Null }
    foreach ($k in $want.Keys) { Set-ItemProperty -LiteralPath $uk -Name $k -Value $want[$k] }
    Set-ItemProperty -LiteralPath $uk -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -LiteralPath $uk -Name NoRepair -Value 1 -Type DWord
    $ch = $true
  }
  if ($ch) { $script:Dirty = $true }
  return $ch
}

function Step-Power {
  $S = $script:S
  $P = $S.P
  $had = Get-StateValue 'powerApplied'
  if ($S.Power -eq 'kotak') {
    if ($had -eq $true -and (Test-Path -LiteralPath $P.PowerBefore -PathType Leaf)) { return $false }
    [void](Invoke-SetupScript 'set-box-power.ps1' @('-Apply', '-StateFile', $P.PowerBefore))
    [void](Update-State @{ powerApplied = $true })
    return $true
  }
  if ($had -eq $true) {
    [void](Invoke-SetupScript 'set-box-power.ps1' @('-Restore', '-StateFile', $P.PowerBefore))
    [void](Update-State @{ powerApplied = $false })
    return $true
  }
  return $false
}

function Step-StartCheck {
  $S = $script:S
  $P = $S.P
  $ch = $false
  $t = Get-ScheduledTask -TaskName 'MAXCOM Box' -ErrorAction SilentlyContinue
  if ($null -eq $t) { throw 'GAGAL: tugas MAXCOM Box tiada' }
  Enable-ScheduledTask -TaskName 'MAXCOM Box' | Out-Null
  $script:TaskDisabled = $false
  $t = Get-ScheduledTask -TaskName 'MAXCOM Box'
  if ($t.State -eq 'Running' -and $script:Dirty) {
    Stop-Box
    Enable-ScheduledTask -TaskName 'MAXCOM Box' | Out-Null
    $script:TaskDisabled = $false
    $t = Get-ScheduledTask -TaskName 'MAXCOM Box'
  }
  if ($t.State -ne 'Running') { Start-ScheduledTask -TaskName 'MAXCOM Box'; $ch = $true }
  $da = @('-InstallRoot', $P.InstallRoot, '-Wait', '90')
  if ($S.BoxId) { $da += @('-ExpectBoxId', $S.BoxId) }
  $out = @()
  try { $out = Invoke-SetupScript 'doctor.ps1' $da -Show } catch { throw 'GAGAL: Semak MAXCOM tidak lulus; lihat baris di atas' }
  return $ch
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

function Invoke-Main {
  if (-not $DryRun -and -not $LayoutOnly -and -not (Test-MaxcomElevated)) { return (Start-Elevated) }
  Resolve-Inputs
  $S = $script:S
  $P = $S.P
  if (-not (Invoke-Preflight)) { return 1 }
  $n = $script:StepNames
  $d = $S.Dry
  $lay = $S.LayoutOnly
  if ($d) { Write-Host "DRYRUN kunci folder $($P.MaxcomHome) sebelum folder data dibuat: $(Get-HomeAclPlan)" }

  [void](Invoke-Step -Name $n[0] -DryRun:$d -Describe "salin skrip persediaan ke $($P.Bin) dan tetapkan kebenaran folder" -Action { Step-CopySetup })
  if (-not $d -and -not $lay) { Import-Module -Name (Join-Path $P.Bin 'MaxcomSetup.psm1') -Global -Force -DisableNameChecking }
  if ($lay) { Write-Step 'LANGKAU' $n[1] 'mod LayoutOnly' }
  else { [void](Invoke-Step -Name $n[1] -DryRun:$d -Describe 'henti MAX Kiosk Server sahaja jika fail perlu diubah' -Action { Step-StopBox }) }
  [void](Invoke-Step -Name $n[2] -DryRun:$d -Describe 'pasang node.exe dan alat siaran langsung dari bundle (sha256 disemak)' -Action { Step-RuntimeTools })
  [void](Invoke-Step -Name $n[3] -DryRun:$d -Describe "ekstrak keluaran $($S.Version), sambung current, salin pangkalan data sebelum tukar" -Action { Step-Release })
  [void](Invoke-Step -Name $n[4] -DryRun:$d -Describe 'tulis launcher.mjs, start.cmd dan box-config.json' -Action { Step-Config })
  $dd = 'sedia folder data dan kebenarannya'
  if ($S.MigrateFrom -ne '') { $dd = "$dd, pindah data dari $($S.MigrateFrom) dengan semakan" }
  [void](Invoke-Step -Name $n[5] -DryRun:$d -Describe $dd -Action { Step-DataFolder })
  if ($lay) {
    foreach ($i in 6..10) { Write-Step 'LANGKAU' $n[$i] 'mod LayoutOnly' }
  } else {
    [void](Invoke-Step -Name $n[6] -DryRun:$d -Describe "buat atau semak sijil kotak untuk $($S.Ip)" -Action { Step-Certificates })
    [void](Invoke-Step -Name $n[7] -DryRun:$d -Describe "peraturan tembok api TCP $($S.HttpsPort)" -Action { Step-Firewall })
    [void](Invoke-Step -Name $n[8] -DryRun:$d -Describe "daftar tugas, menu Start dan senarai Apps (skrin: $($S.Kiosk))" -Action { Step-Tasks })
    [void](Invoke-Step -Name $n[9] -DryRun:$d -Describe "tetapan kuasa ($($S.Power))" -Action { Step-Power })
    [void](Invoke-Step -Name $n[10] -DryRun:$d -Describe 'mulakan kotak dan jalankan Semak MAXCOM' -Action { Step-StartCheck })
  }

  if ($d) { Write-Host 'DRYRUN selesai. Tiada apa diubah.'; return 0 }
  if ($lay) { Write-Host 'Susunan fail MAX Kiosk Server selesai (LayoutOnly: tiada tugas, tembok api atau sijil).'; return 0 }
  Write-Host 'Pemasangan MAX Kiosk Server selesai.'
  Write-Host ("Alamat kotak: https://{0}:{1}/" -f $S.Ip, $S.HttpsPort)
  Write-Host ("Fail sijil akar (pasang pada telefon dan iPad): {0}" -f (Join-Path $P.Pki 'root-ca.cer'))
  if ($S.MigrateFrom -ne '' -or (Get-StateValue 'migratedFrom')) {
    Write-Host 'Telefon yang sudah didaftar terus boleh digunakan.'
    Write-Host 'Jangan hidupkan kotak lama lagi selagi kotak yang dipasang ini berjalan.'
    Write-Host 'Pembolehubah persekitaran kotak lama tidak dibawa: beri -CloudUrl atau ubah box-config.json jika perlu.'
  } else {
    Write-Host 'Imbas kod QR pada skrin dengan aplikasi MAX Admin Client.'
  }
  return 0
}

$code = 1
try {
  $code = Invoke-Main
} catch {
  $msg = $_.Exception.Message
  if ($msg -notmatch '^GAGAL: [0-9]+ ') { Write-Host $msg }
  if (-not $DryRun) { Write-Host 'Jalankan Pasang MAXCOM sekali lagi untuk menyambung. Data surau tidak dibuang.' }
  $code = 1
  $script:Failed = $true
} finally {
  Restore-AfterFailure
}
if ($PauseAtEnd) { Read-Host 'Tekan Enter untuk tutup' | Out-Null }
exit $code
