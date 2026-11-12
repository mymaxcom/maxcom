<#
.SYNOPSIS
  MAXCOM box installer for Windows: shared functions (paths, ACLs, bundle and archive checks,
  junctions, install state). Windows PowerShell 5.1, ASCII only, built-ins only.

.DESCRIPTION
  Imported by setup.ps1, doctor.ps1, uninstall.ps1, switch-release.ps1 and migrate-data.ps1 (from
  scripts\setup, from the bundle, or from <root>\bin: see Resolve-SetupScript).

  Rules this module keeps:
    - No function uses the current directory: every path must be a full path (drive letter).
    - Junctions are removed as links and never followed. PowerShell 5.1 Remove-Item -Recurse follows
      junctions, so deletes here walk the tree themselves and delete a reparse point as a link.
    - Archives are listed and checked before anything is extracted.
    - Nothing here prints or stores a secret.

  Deviation from the plan text, on purpose: junctions are made with New-Item -ItemType Junction and
  removed with [System.IO.Directory]::Delete(path, $false) instead of "cmd /c mklink /J" and
  "cmd /c rmdir". The effect is the same (no administrator needed, only the link is removed) and no
  command line is parsed by cmd.exe, so a folder name with & ' or spaces cannot change a command.

  Manifest format (manifest.json at the root of the setup bundle, written by build-setup.ps1):
    { "v": 1, "files": [ { "path": "payload/x.zip", "size": 123, "sha256": "<64 hex>" } ] }
  Paths are relative, forward slashes. Every file of the bundle except manifest.json must be listed.
#>

$ErrorActionPreference = 'Stop'

$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'
$script:SidUsers = 'S-1-5-32-545'
$script:SidCreatorOwner = 'S-1-3-0'
$script:SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:VersionPattern = '^[0-9]+\.[0-9]+\.[0-9]+$'

# ---------------------------------------------------------------------------------------------
# Small internal helpers (some exported because the other setup scripts need the same primitives)
# ---------------------------------------------------------------------------------------------

function Get-SystemTool([string]$Name) {
  return (Join-Path $env:SystemRoot ('System32\' + $Name))
}

function ConvertTo-FullPath {
  <# Full path without trailing slash. Refuses relative paths: nothing here uses the current directory. #>
  param([Parameter(Mandatory)][string]$Path)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -and $Path -notmatch '^\\\\') {
    throw "GAGAL: laluan mesti laluan penuh dengan huruf pemacu: $Path"
  }
  $p = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($p)
  if ($p.Length -gt $root.Length) { $p = $p.TrimEnd('\') }
  return $p
}

function Test-PathInside {
  <# True when Child is Parent or below it (case-insensitive, whole path segments). #>
  param([string]$Child, [string]$Parent, [switch]$AllowEqual)
  $c = $Child.TrimEnd('\')
  $p = $Parent.TrimEnd('\')
  if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) { return [bool]$AllowEqual }
  return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AnyPath([string]$Path) {
  # True also for a broken link (Test-Path says false for those).
  try { [void][System.IO.File]::GetAttributes($Path); return $true } catch { return $false }
}

function Test-IsReparsePoint {
  param([Parameter(Mandatory)][string]$Path)
  try { $a = [System.IO.File]::GetAttributes($Path) } catch { return $false }
  return ((([int]$a) -band 0x400) -ne 0)
}

function Get-LinkTarget {
  param([Parameter(Mandatory)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  $t = $item.Target
  if ($t -is [array]) { $t = $t | Select-Object -First 1 }
  if ($null -eq $t) { return $null }
  $t = [string]$t
  $t = $t -replace '^\\\?\?\\', ''
  return $t.TrimEnd('\')
}

function Get-SafeTree {
  <# Every entry below Dir (files, folders, links). Never descends into a reparse point. #>
  param([Parameter(Mandatory)][string]$Dir)
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($Dir)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in [System.IO.Directory]::GetFileSystemEntries($d)) {
      $attr = [int][System.IO.File]::GetAttributes($e)
      $isLink = (($attr -band 0x400) -ne 0)
      $isDir = (($attr -band 0x10) -ne 0)
      [void]$out.Add([pscustomobject]@{ Path = $e; IsDir = $isDir; IsLink = $isLink })
      if ($isDir -and -not $isLink) { $stack.Push($e) }
    }
  }
  return $out.ToArray()
}

function New-Junction([string]$Link, [string]$Target) {
  if ($Link -match '[\[\]\*\?]' -or $Target -match '[\[\]\*\?]') {
    throw "GAGAL: aksara [ ] * ? tidak dibenarkan dalam laluan pautan: $Link"
  }
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

function Assert-NoSecretKey($Obj, [string]$Where) {
  if ($null -eq $Obj) { return }
  $names = @()
  if ($Obj -is [System.Collections.IDictionary]) { $names = @($Obj.Keys) }
  elseif ($Obj -is [pscustomobject]) { $names = @($Obj.PSObject.Properties | ForEach-Object { $_.Name }) }
  foreach ($n in $names) {
    if ([string]$n -match '(?i)pass|secret|token|pfx|pwd|private|key') {
      throw "GAGAL: nama medan '$n' kelihatan seperti rahsia dan tidak boleh disimpan dalam state ($Where)"
    }
    if ($Obj -is [System.Collections.IDictionary]) { $child = $Obj[$n] } else { $child = $Obj.$n }
    if ($child -is [System.Collections.IDictionary] -or $child -is [pscustomobject]) { Assert-NoSecretKey $child "$Where.$n" }
  }
}

# ---------------------------------------------------------------------------------------------
# Paths, elevation, step output
# ---------------------------------------------------------------------------------------------

function Get-MaxcomPaths {
  <# Every path of the "Installed layout" as one object. Full paths, no trailing slash. #>
  param([string]$InstallRoot = '', [string]$DataDir = '')
  if ($InstallRoot -eq '') { $InstallRoot = Join-Path $env:ProgramFiles 'MAXCOM' }
  if ($DataDir -eq '') { $DataDir = Join-Path (Join-Path $env:ProgramData 'MAXCOM') 'data' }
  $root = ConvertTo-FullPath $InstallRoot
  $data = ConvertTo-FullPath $DataDir
  $home1 = Split-Path -Parent $data
  if ($null -eq $home1 -or $home1 -eq '') { throw "GAGAL: folder data tidak boleh berada di akar pemacu: $data" }
  $node = Join-Path $root 'runtime\node'
  $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MAXCOM'
  return [pscustomobject]@{
    InstallRoot  = $root
    Launcher     = Join-Path $root 'launcher.mjs'
    StartCmd     = Join-Path $root 'start.cmd'
    BoxConfig    = Join-Path $root 'box-config.json'
    PreviousTxt  = Join-Path $root 'previous.txt'
    RollbackJson = Join-Path $root 'rollback.json'
    Current      = Join-Path $root 'current'
    Releases     = Join-Path $root 'releases'
    Runtime      = Join-Path $root 'runtime'
    NodeDir      = $node
    NodeExe      = Join-Path $node 'node.exe'
    Tools        = Join-Path $root 'tools'
    LiveTools    = Join-Path $root 'tools\live'
    Bin          = Join-Path $root 'bin'
    State        = Join-Path $root 'state'
    InstallJson  = Join-Path $root 'state\install.json'
    PowerBefore  = Join-Path $root 'state\power-before.json'
    MaxcomHome   = $home1
    FirewallCopy = Join-Path $home1 'ensure-live-firewall.ps1'
    Backups      = Join-Path $home1 'backups'
    DataDir      = $data
    Db           = Join-Path $data 'surau.db'
    Secret       = Join-Path $data 'secret'
    Pki          = Join-Path $data 'pki'
    Logs         = Join-Path $data 'logs'
    BoxLog       = Join-Path $data 'logs\box.log'
    HomeLogs     = Join-Path $home1 'logs'
    CertRenewLog = Join-Path $home1 'logs\cert-renew.log'
    StartMenu    = $startMenu
    UninstallKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MAXCOM'
  }
}

function Test-MaxcomElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-SetupScript {
  <# Finds a sibling script: the module's folder first, then its parent (scripts\setup, scripts, bundle, <root>\bin). #>
  param([Parameter(Mandatory, Position = 0)][string]$Name)
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._ -]*$') { throw "GAGAL: nama skrip tidak sah: $Name" }
  $here = $PSScriptRoot
  $parent = Split-Path -Parent $here
  foreach ($dir in @($here, $parent)) {
    if ($null -eq $dir -or $dir -eq '') { continue }
    $p = Join-Path $dir $Name
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  throw "GAGAL: skrip $Name tidak dijumpai di $here atau $parent"
}

function Write-Step {
  param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('OK', 'SET', 'DRYRUN', 'GAGAL', 'LANGKAU')][string]$Status,
    [Parameter(Mandatory, Position = 1)][string]$Name,
    [Parameter(Position = 2)][string]$Text = ''
  )
  switch ($Status) {
    'OK' { if ($Text -eq '') { $line = "OK $Name sudah siap" } else { $line = "OK $Name $Text" } }
    'SET' { $line = "SET $Name`: $Text" }
    'DRYRUN' { $line = "DRYRUN $Name`: $Text" }
    'LANGKAU' { $line = "LANGKAU $Name`: $Text" }
    'GAGAL' { $line = "GAGAL: $Name`: $Text" }
  }
  Write-Host $line
}

function Invoke-Step {
  <#
    Runs one named setup step. The action returns $true when it changed something (prints SET) or
    $false when everything was already in place (prints OK ... sudah siap); only its last output
    value counts. With -DryRun nothing runs and one DRYRUN line is printed. A failure prints
    "GAGAL: <name>: <reason>" and throws, so the setup stops with the step name.
  #>
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Action,
    [switch]$DryRun,
    [string]$Describe = ''
  )
  if ($DryRun) {
    if ($Describe -eq '') { $Describe = 'langkah ini akan dijalankan' }
    Write-Step 'DRYRUN' $Name $Describe
    return $false
  }
  try {
    $result = @(& $Action)
  } catch {
    Write-Step 'GAGAL' $Name $_.Exception.Message
    throw "GAGAL: $Name"
  }
  $changed = $false
  if ($result.Count -gt 0) { $changed = [bool]$result[$result.Count - 1] }
  if ($changed) { Write-Step 'SET' $Name 'selesai' } else { Write-Step 'OK' $Name }
  return $changed
}

# ---------------------------------------------------------------------------------------------
# ACLs
# ---------------------------------------------------------------------------------------------

function Get-UntrustedWriters {
  <#
    Names that can write to Path but are not SYSTEM, Administrators, TrustedInstaller or CREATOR OWNER
    (plus -AlsoTrusted SIDs). Includes an untrusted owner. A missing path gives an empty list: callers
    check existence themselves.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$Path, [string[]]$AlsoTrusted = @())
  $trusted = @($script:SidSystem, $script:SidAdmins, $script:SidCreatorOwner, $script:SidTrustedInstaller) + @($AlsoTrusted)
  $found = @()
  if (-not (Test-Path -LiteralPath $Path)) { return $found }
  $acl = Get-Acl -LiteralPath $Path
  # WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles,
  # ChangePermissions, TakeOwnership, plus GenericWrite and GenericAll bits.
  $writeMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    if ((([int]$ace.FileSystemRights) -band $writeMask) -eq 0) { continue }
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    if ($trusted -contains $sid) { continue }
    $found += [string]$ace.IdentityReference
  }
  try { $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = '' }
  if ($ownerSid -ne '' -and $trusted -notcontains $ownerSid) { $found += "owner $ownerSid" }
  return $found
}

function Get-AclEntryProblem {
  <# Problems when Path has an entry that is not an Allow for one of AllowedSids. #>
  param([string]$Path, [string[]]$AllowedSids, [switch]$ExpectProtected, [switch]$ExpectInherited)
  $probs = @()
  $acl = Get-Acl -LiteralPath $Path
  if ($ExpectProtected -and -not $acl.AreAccessRulesProtected) { $probs += "$Path : pewarisan kebenaran masih hidup" }
  if ($ExpectInherited -and $acl.AreAccessRulesProtected) { $probs += "$Path : pewarisan kebenaran tidak diwarisi daripada folder" }
  foreach ($ace in $acl.Access) {
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    if ($ace.AccessControlType -ne 'Allow') { $probs += "$Path : entri tolak $($ace.IdentityReference)"; continue }
    if ($AllowedSids -notcontains $sid) { $probs += "$Path : entri tidak dibenarkan $($ace.IdentityReference)" }
  }
  return $probs
}

function Invoke-Icacls([string[]]$Arguments) {
  $icacls = Get-SystemTool 'icacls.exe'
  $out = & $icacls @Arguments
  if ($LASTEXITCODE -ne 0) { throw ("GAGAL: icacls " + ($Arguments -join ' ') + " gagal (kod $LASTEXITCODE): " + ($out -join ' ')) }
}

function Set-MaxcomRootAcl {
  <#
    Install root: inheritance off; SYSTEM full, Administrators full, Users read and execute; owner
    Administrators. Needs an elevated shell. Verified with Get-UntrustedWriters.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$Root, [switch]$DryRun)
  $r = ConvertTo-FullPath $Root
  $grants = @("*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F", "*$($script:SidUsers):(OI)(CI)RX")
  if ($DryRun) {
    Write-Host "DRYRUN acl akar: icacls `"$r`" /inheritance:r /grant:r $($grants -join ' ') ; /setowner *$($script:SidAdmins)"
    return $false
  }
  if (-not (Test-MaxcomElevated)) { throw 'GAGAL: perlukan Run as administrator untuk menetapkan kebenaran folder pemasangan' }
  if (-not (Test-Path -LiteralPath $r -PathType Container)) { throw "GAGAL: folder pemasangan tiada: $r" }
  if (Test-IsReparsePoint $r) { throw "GAGAL: folder pemasangan ialah pautan, bukan folder sebenar: $r" }
  Invoke-Icacls (@($r, '/inheritance:r', '/grant:r') + $grants)
  Invoke-Icacls @($r, '/setowner', "*$($script:SidAdmins)")
  $bad = @(Get-UntrustedWriters $r)
  if ($bad.Count -gt 0) { throw "GAGAL: folder pemasangan masih boleh ditulis oleh: $($bad -join ', ')" }
  $probs = @(Get-AclEntryProblem $r @($script:SidSystem, $script:SidAdmins, $script:SidUsers) -ExpectProtected)
  if ($probs.Count -gt 0) { throw ("GAGAL: " + ($probs -join '; ')) }
  return $true
}

function Get-MaxcomAclContract {
  <#
    The ONE ACL contract for data\secret ('secret') and data\pki ('pki'), inheritance off. Used by
    Set-MaxcomDataAcl (apply), Get-MaxcomDataAclProblem (verify; setup and doctor) and mirrored as
    icacls text in box-ca.ps1 and install-cert-renew-task.ps1.
      secret: SYSTEM and Administrators full; the box account (S-1-5-19) Modify on what is INSIDE the folder
              (inherit-only entry) and, on the folder itself, only read, create files and subfolders and
              write attributes: no DELETE and no delete-child, so the box account can neither rename nor
              replace the folder (a junction planted there would be followed by SYSTEM code).
      pki:    SYSTEM and Administrators full; the box account read and execute only. No Users entry.
    Rights are the numeric NTFS masks that icacls F, M and RX produce (2032127, 1245631, 1179817), and
    1180095 for icacls (RX,WD,AD,WEA,WA). Inherit 3 = container+object inherit; Propagation 2 = inherit only.
  #>
  param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('secret', 'pki')][string]$Kind,
    [Parameter(Mandatory)][string]$ServiceSid
  )
  if ($ServiceSid -notmatch '^S-1-\d+(-\d+)+$') { throw "GAGAL: SID akaun perkhidmatan tidak sah: $ServiceSid" }
  $rules = @(
    [pscustomobject]@{ Sid = $script:SidSystem; Rights = 2032127; Inherit = 3; Propagation = 0 },
    [pscustomobject]@{ Sid = $script:SidAdmins; Rights = 2032127; Inherit = 3; Propagation = 0 }
  )
  if ($Kind -eq 'secret') {
    $rules += [pscustomobject]@{ Sid = $ServiceSid; Rights = 1245631; Inherit = 3; Propagation = 2 }
    $rules += [pscustomobject]@{ Sid = $ServiceSid; Rights = 1180095; Inherit = 0; Propagation = 0 }
  } else {
    $rules += [pscustomobject]@{ Sid = $ServiceSid; Rights = 1179817; Inherit = 3; Propagation = 0 }
  }
  return $rules
}

function Set-ExactDirAcl {
  <# Replaces the whole DACL of a folder in one step (inheritance off, nothing else kept). #>
  param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][ValidateSet('secret', 'pki')][string]$Kind, [Parameter(Mandatory)][string]$ServiceSid)
  $sec = New-Object System.Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($r in (Get-MaxcomAclContract $Kind -ServiceSid $ServiceSid)) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($r.Sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights][int]$r.Rights,
      [System.Security.AccessControl.InheritanceFlags][int]$r.Inherit,
      [System.Security.AccessControl.PropagationFlags][int]$r.Propagation,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $sec.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($Dir, $sec)
}

function Get-ExactAclProblem {
  <# Problems when Path does not carry exactly the contract of Kind (protected, no deny, no extra, none missing). #>
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][string]$ServiceSid)
  $probs = @()
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { $probs += "$Path : pewarisan kebenaran masih hidup" }
  $want = @(Get-MaxcomAclContract $Kind -ServiceSid $ServiceSid | ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.Sid, $_.Rights, $_.Inherit, $_.Propagation })
  $have = @()
  foreach ($ace in $acl.Access) {
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    if ($ace.AccessControlType -ne 'Allow') { $probs += "$Path : entri tolak $($ace.IdentityReference)"; continue }
    $key = "{0}|{1}|{2}|{3}" -f $sid, ([int]$ace.FileSystemRights), ([int]$ace.InheritanceFlags), ([int]$ace.PropagationFlags)
    if ($ace.IsInherited) { $probs += "$Path : entri diwarisi $($ace.IdentityReference)" }
    if ($want -notcontains $key) { $probs += "$Path : entri tidak dibenarkan $($ace.IdentityReference) (hak $([int]$ace.FileSystemRights))" }
    $have += $key
  }
  foreach ($k in $want) {
    if ($have -notcontains $k) { $probs += "$Path : entri yang dijangka tiada ($k)" }
  }
  return $probs
}

function Get-MaxcomDataAclProblem {
  <#
    Problems with the data folder ACL, empty when it is right. data\: inheritance off, only SYSTEM,
    Administrators and the service account. data\secret and data\pki: exactly Get-MaxcomAclContract.
    Everything below inherits, with no entry for any other account; nothing below pki\ can be written by
    the service account. Does not descend into links. Looks at the first 600 entries.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$Data, [Parameter(Mandatory)][string]$ServiceSid)
  $d = ConvertTo-FullPath $Data
  if (-not (Test-Path -LiteralPath $d -PathType Container)) { return @("folder data tiada: $d") }
  $allowed = @($script:SidSystem, $script:SidAdmins, $ServiceSid)
  $probs = @(Get-AclEntryProblem $d $allowed -ExpectProtected)
  $special = @{}
  foreach ($kind in @('secret', 'pki')) {
    $p = Join-Path $d $kind
    if (-not (Test-AnyPath $p)) { $probs += "folder $kind tiada: $p"; continue }
    if (Test-IsReparsePoint $p) { $probs += "$p ialah pautan (reparse point)"; continue }
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { $probs += "$p bukan folder"; continue }
    $special[$p.ToLowerInvariant()] = $kind
    $probs += @(Get-ExactAclProblem $p $kind $ServiceSid)
  }
  $pkiLower = (Join-Path $d 'pki').ToLowerInvariant()
  $seen = 0
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($d)
  while ($queue.Count -gt 0 -and $seen -lt 600) {
    $dir = [string]$queue.Dequeue()
    foreach ($e in [System.IO.Directory]::GetFileSystemEntries($dir)) {
      $seen++
      if ($seen -gt 600) { break }
      $attr = [int][System.IO.File]::GetAttributes($e)
      if (($attr -band 0x400) -ne 0) { continue }
      $isDir = (($attr -band 0x10) -ne 0)
      $lower = $e.ToLowerInvariant()
      if (-not $special.ContainsKey($lower)) {
        $probs += @(Get-AclEntryProblem $e $allowed -ExpectInherited)
        if ($lower -eq $pkiLower -or $lower.StartsWith($pkiLower + '\')) {
          $w = @(Get-UntrustedWriters $e | Where-Object { $_ -notlike 'owner *' })
          if ($w.Count -gt 0) { $probs += "$e : boleh ditulis oleh $($w -join ', ')" }
        }
      }
      if ($isDir) { $queue.Enqueue($e) }
    }
  }
  return $probs
}

function Test-MaxcomDataAcl {
  param([Parameter(Mandatory, Position = 0)][string]$Data, [Parameter(Mandatory)][string]$ServiceSid)
  return (@(Get-MaxcomDataAclProblem $Data -ServiceSid $ServiceSid).Count -eq 0)
}

function Set-MaxcomDataAcl {
  <#
    Data folder: inheritance off; SYSTEM full, Administrators full, the service account modify, nobody
    else. Existing children are reset to inherit from the folder (each top-level child, not the folder
    itself, so the folder keeps its own protected ACL), EXCEPT secret\ and pki\: those are created when
    missing, refuse to be links, and get the exact Get-MaxcomAclContract (their own children are reset to
    inherit from them). Verified with Get-MaxcomDataAclProblem. Running it twice changes nothing.
  #>
  param(
    [Parameter(Mandatory, Position = 0)][string]$Data,
    [Parameter(Mandatory)][string]$ServiceSid,
    [switch]$DryRun
  )
  if ($ServiceSid -notmatch '^S-1-\d+(-\d+)+$') { throw "GAGAL: SID akaun perkhidmatan tidak sah: $ServiceSid" }
  $d = ConvertTo-FullPath $Data
  $grants = @("*$($script:SidSystem):(OI)(CI)F", "*$($script:SidAdmins):(OI)(CI)F", "*${ServiceSid}:(OI)(CI)M")
  if ($DryRun) {
    Write-Host "DRYRUN acl data: icacls `"$d`" /inheritance:r /grant:r $($grants -join ' ') ; reset anak ; secret dan pki ikut kontrak (akaun kotak tiada DELETE pada folder itu sendiri)"
    return $false
  }
  if (-not (Test-Path -LiteralPath $d -PathType Container)) { throw "GAGAL: folder data tiada: $d" }
  if (Test-IsReparsePoint $d) { throw "GAGAL: folder data ialah pautan, bukan folder sebenar: $d" }
  Invoke-Icacls (@($d, '/inheritance:r', '/grant:r') + $grants)
  foreach ($kind in @('secret', 'pki')) {
    $p = Join-Path $d $kind
    if (Test-AnyPath $p) {
      if (Test-IsReparsePoint $p) { throw "GAGAL: $p ialah pautan (reparse point), bukan folder sebenar" }
      if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw "GAGAL: $p bukan folder" }
    } else {
      [void][System.IO.Directory]::CreateDirectory($p)
    }
  }
  foreach ($child in [System.IO.Directory]::GetFileSystemEntries($d)) {
    $leaf = [System.IO.Path]::GetFileName($child)
    $kind = ''
    if ($leaf -ieq 'secret') { $kind = 'secret' } elseif ($leaf -ieq 'pki') { $kind = 'pki' }
    if ($kind -eq '') {
      # /L: act on a link itself, never on what it points to. /C: go on after an error and report it by exit code.
      Invoke-Icacls @($child, '/reset', '/T', '/C', '/L', '/Q')
      continue
    }
    Set-ExactDirAcl $child $kind $ServiceSid
    foreach ($inner in [System.IO.Directory]::GetFileSystemEntries($child)) {
      Invoke-Icacls @($inner, '/reset', '/T', '/C', '/L', '/Q')
    }
  }
  $probs = @(Get-MaxcomDataAclProblem $d -ServiceSid $ServiceSid)
  if ($probs.Count -gt 0) { throw ("GAGAL: kebenaran folder data tidak betul: " + (($probs | Select-Object -First 5) -join '; ')) }
  return $true
}

# ---------------------------------------------------------------------------------------------
# The folder that holds data\ and backups\ (%ProgramData%\MAXCOM) must be a folder of its own
# ---------------------------------------------------------------------------------------------

function Get-MaxcomHomeProblem {
  <#
    Setup locks the PARENT of the data folder and resets the ACL of everything in it except data\ and
    backups\. So that parent must be a dedicated folder: refused when it is a drive root, %ProgramData%,
    %SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, the Users folder or a user profile, unless its
    name is MAXCOM or it is empty or holds only data, backups and logs. MAXCOM_EXTRA_PROTECTED_DIRS
    (semicolon list) can only ADD folders to the refused list; tests use it as a stand-in for a drive root.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$Data)
  $d = ConvertTo-FullPath $Data
  $parent = Split-Path -Parent $d
  if ($null -eq $parent -or $parent -eq '') { return @("folder data tidak boleh berada di akar pemacu: $d") }
  $h = ConvertTo-FullPath $parent
  $root = [System.IO.Path]::GetPathRoot($h)
  $isRoot = ($h.Length -le $root.Length)
  $hit = $isRoot
  $guard = @($env:ProgramData, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:USERPROFILE)
  if ($env:SystemDrive) { $guard += (Join-Path $env:SystemDrive 'Users') }
  if ($env:MAXCOM_EXTRA_PROTECTED_DIRS) { $guard += @($env:MAXCOM_EXTRA_PROTECTED_DIRS -split ';') }
  foreach ($g in $guard) {
    if (-not $g) { continue }
    if ($g -notmatch '^[A-Za-z]:[\\/]') { continue }
    if ((ConvertTo-FullPath $g).Equals($h, [System.StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
  }
  if (-not $hit) { return @() }
  if (-not $isRoot -and (Split-Path -Leaf $h) -ieq 'MAXCOM') { return @() }
  if (Test-Path -LiteralPath $h -PathType Container) {
    $names = @([System.IO.Directory]::GetFileSystemEntries($h) | ForEach-Object { [System.IO.Path]::GetFileName($_) })
    $other = @($names | Where-Object { @('data', 'backups', 'logs') -notcontains $_.ToLowerInvariant() })
    if ($other.Count -eq 0) { return @() }
  } else {
    return @()
  }
  return @("folder induk bagi folder data ($h) bukan folder khas MAXCOM: pemasangan akan mengunci dan menukar pemilik semua isinya. Pilih folder data seperti $((Join-Path $h 'MAXCOM\data')) .")
}

# ---------------------------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------------------------

function Remove-OldBackups {
  <#
    Keeps the newest -Keep database backups made by setup (folders named pre-<version>-<yyyyMMdd-HHmmss>)
    and removes the older ones with Remove-TreeSafe. Never touches -Except (the one just made), a link, or
    any other name (pre-install-* holds the migrated hand-run box and is never removed here).
    Returns the number removed.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$BackupsDir, [int]$Keep = 3, [string]$Except = '')
  $b = ConvertTo-FullPath $BackupsDir
  if (-not (Test-Path -LiteralPath $b -PathType Container)) { return 0 }
  if (Test-IsReparsePoint $b) { throw "GAGAL: folder sandaran ialah pautan: $b" }
  $ex = ''
  if ($Except -ne '') { $ex = (ConvertTo-FullPath $Except).ToLowerInvariant() }
  $all = @()
  foreach ($e in [System.IO.Directory]::GetFileSystemEntries($b)) {
    $n = [System.IO.Path]::GetFileName($e)
    if ($n -notmatch '^pre-[0-9]+\.[0-9]+\.[0-9]+-([0-9]{8}-[0-9]{6})$') { continue }
    if (Test-IsReparsePoint $e) { continue }
    if (-not (Test-Path -LiteralPath $e -PathType Container)) { continue }
    $all += [pscustomobject]@{ Path = $e; Stamp = $Matches[1] }
  }
  $sorted = @($all | Sort-Object -Property @{ Expression = { $_.Stamp }; Descending = $true }, @{ Expression = { $_.Path }; Descending = $true })
  $removed = 0
  for ($i = 0; $i -lt $sorted.Count; $i++) {
    if ($i -lt $Keep) { continue }
    if ($ex -ne '' -and $sorted[$i].Path.ToLowerInvariant() -eq $ex) { continue }
    [void](Remove-TreeSafe $sorted[$i].Path -Under $b)
    $removed++
  }
  return $removed
}

# ---------------------------------------------------------------------------------------------
# Install root safety
# ---------------------------------------------------------------------------------------------

function Get-InstallRootProblem {
  <# Reasons the install root is refused; empty when it is acceptable. #>
  param([Parameter(Mandatory, Position = 0)][string]$Path, [switch]$AllowUserProfile)
  if ($Path -notmatch '^[A-Za-z]:\\') { return @("laluan pemasangan mesti laluan penuh dengan huruf pemacu: $Path") }
  if ($Path -match '[\x00-\x1f"%^<>|*?\[\]`]') { return @("laluan pemasangan mengandungi aksara yang tidak dibenarkan: $Path") }
  $full = ConvertTo-FullPath $Path
  $driveRoot = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -le $driveRoot.Length) { return @("laluan pemasangan tidak boleh akar pemacu: $full") }
  $probs = @()
  if (-not $AllowUserProfile) {
    $guard = @()
    if ($env:USERPROFILE) { $guard += $env:USERPROFILE }
    if ($env:SystemDrive) { $guard += (Join-Path $env:SystemDrive 'Users') }
    foreach ($g in $guard) {
      if (Test-PathInside $full (ConvertTo-FullPath $g) -AllowEqual) { $probs += "laluan pemasangan berada dalam profil pengguna ($g): $full" ; break }
    }
  }
  if (Test-AnyPath $full) {
    if (Test-IsReparsePoint $full) { $probs += "laluan pemasangan ialah pautan (reparse point): $full" }
    elseif (-not (Test-Path -LiteralPath $full -PathType Container)) { $probs += "laluan pemasangan ialah fail: $full" }
  }
  $p = Split-Path -Parent $full
  while ($null -ne $p -and $p.Length -gt $driveRoot.Length) {
    if (Test-IsReparsePoint $p) { $probs += "folder induk ialah pautan (reparse point): $p" }
    $p = Split-Path -Parent $p
  }
  return $probs
}

function Test-SafeInstallRoot {
  param([Parameter(Mandatory, Position = 0)][string]$Path, [switch]$AllowUserProfile)
  $probs = @(Get-InstallRootProblem $Path -AllowUserProfile:$AllowUserProfile)
  return ($probs.Count -eq 0)
}

# ---------------------------------------------------------------------------------------------
# Bundle manifest and archive checks
# ---------------------------------------------------------------------------------------------

function Get-BundleManifestProblem {
  <# Problems found when checking every bundle file against manifest.json; empty when all is well. #>
  param([Parameter(Mandatory, Position = 0)][string]$BundleDir)
  $dir = ConvertTo-FullPath $BundleDir
  $mf = Join-Path $dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $mf -PathType Leaf)) { return @("manifest.json tiada dalam $dir") }
  try { $m = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return @("manifest.json tidak boleh dibaca: $($_.Exception.Message)") }
  if ($null -eq $m -or $m.v -ne 1 -or $null -eq $m.files) { return @('manifest.json bukan format v1 dengan senarai files') }
  $probs = New-Object System.Collections.ArrayList
  $listed = @{}
  foreach ($f in @($m.files)) {
    $rel = [string]$f.path
    if ($rel -eq '' -or $rel -match '^[/\\]' -or $rel -match '[\\:*?"<>|]' -or (@($rel -split '/') -contains '..') -or (@($rel -split '/') -contains '')) {
      [void]$probs.Add("laluan tidak sah dalam manifest: $rel"); continue
    }
    $key = $rel.ToLowerInvariant()
    if ($listed.ContainsKey($key)) { [void]$probs.Add("manifest menyenaraikan fail dua kali: $rel"); continue }
    $listed[$key] = $true
    if ([string]$f.sha256 -notmatch '^[0-9a-fA-F]{64}$') { [void]$probs.Add("sha256 dalam manifest tidak sah: $rel"); continue }
    $full = [System.IO.Path]::GetFullPath((Join-Path $dir ($rel -replace '/', '\')))
    if (-not (Test-PathInside $full $dir)) { [void]$probs.Add("laluan di luar bundle: $rel"); continue }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { [void]$probs.Add("fail hilang: $rel"); continue }
    if (Test-IsReparsePoint $full) { [void]$probs.Add("fail ialah pautan: $rel"); continue }
    $len = (Get-Item -LiteralPath $full -Force).Length
    if ([int64]$f.size -ne $len) { [void]$probs.Add("saiz tidak sama: $rel"); continue }
    $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    if ($h -ne ([string]$f.sha256).ToUpperInvariant()) { [void]$probs.Add("sha256 tidak sama: $rel") }
  }
  foreach ($e in (Get-SafeTree $dir)) {
    $rel = $e.Path.Substring($dir.Length + 1).Replace('\', '/')
    if ($e.IsLink) { [void]$probs.Add("pautan dalam bundle: $rel"); continue }
    if ($e.IsDir) { continue }
    if ($rel -eq 'manifest.json') { continue }
    if (-not $listed.ContainsKey($rel.ToLowerInvariant())) { [void]$probs.Add("fail tambahan tiada dalam manifest: $rel") }
  }
  return $probs.ToArray()
}

function Test-BundleManifest {
  param([Parameter(Mandatory, Position = 0)][string]$BundleDir)
  $probs = @(Get-BundleManifestProblem $BundleDir)
  return ($probs.Count -eq 0)
}

function Get-EntryNameProblem([string]$Name) {
  if ($Name -eq '') { return 'nama entri kosong' }
  if ($Name -match '[\x00-\x1f]') { return "aksara kawalan dalam nama entri: $Name" }
  if ($Name.Contains('\')) { return "garis serong terbalik dalam nama entri: $Name" }
  if ($Name.Contains(':')) { return "titik bertindih (huruf pemacu atau aliran data) dalam nama entri: $Name" }
  if ($Name.StartsWith('/')) { return "laluan mutlak dalam arkib: $Name" }
  $n = $Name
  while ($n.StartsWith('./')) { $n = $n.Substring(2) }
  if ($n -eq '' -or $n -eq '.') { return $null }
  foreach ($seg in $n.TrimEnd('/').Split('/')) {
    if ($seg -eq '') { return "segmen kosong dalam nama entri: $Name" }
    if ($seg -eq '..') { return "'..' dalam nama entri: $Name" }
    if ($seg -ne '.' -and ($seg.EndsWith('.') -or $seg.EndsWith(' '))) { return "segmen berakhir dengan titik atau ruang: $Name" }
    if ($seg -match '^(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') { return "nama peranti Windows dalam nama entri: $Name" }
  }
  return $null
}

function Get-ArchiveEntryProblem {
  <# Lists the archive (names and types) and returns what is wrong; extracts nothing. #>
  param([Parameter(Mandatory, Position = 0)][string]$Archive)
  $a = ConvertTo-FullPath $Archive
  if (-not (Test-Path -LiteralPath $a -PathType Leaf)) { return @("arkib tiada: $a") }
  $tar = Get-SystemTool 'tar.exe'
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { return @("tar.exe tiada di $tar") }
  $names = @(& $tar -tzf $a)
  if ($LASTEXITCODE -ne 0) { return @("tar tidak dapat membaca arkib (kod $LASTEXITCODE)") }
  $verbose = @(& $tar -tvzf $a)
  if ($LASTEXITCODE -ne 0) { return @("tar tidak dapat membaca arkib (kod $LASTEXITCODE)") }
  if ($names.Count -ne $verbose.Count) { return @("senarai arkib tidak konsisten ($($names.Count) nama, $($verbose.Count) baris)") }
  if ($names.Count -eq 0) { return @('arkib kosong') }
  $probs = @()
  for ($i = 0; $i -lt $names.Count; $i++) {
    $p = Get-EntryNameProblem ([string]$names[$i])
    if ($null -ne $p) { $probs += $p }
    $line = [string]$verbose[$i]
    $t = ''
    if ($line.Length -gt 0) { $t = $line.Substring(0, 1) }
    if ($t -ne '-' -and $t -ne 'd') { $probs += "jenis entri tidak dibenarkan ('$t', pautan atau fail khas): $($names[$i])" }
  }
  return $probs
}

function Test-ArchiveEntries {
  param([Parameter(Mandatory, Position = 0)][string]$Archive)
  $probs = @(Get-ArchiveEntryProblem $Archive)
  return ($probs.Count -eq 0)
}

# ---------------------------------------------------------------------------------------------
# Junction handling
# ---------------------------------------------------------------------------------------------

function Remove-JunctionSafe {
  <# Removes a junction (or directory link) as a link. Refuses a real folder. Verifies the target survived. #>
  param([Parameter(Mandatory, Position = 0)][string]$Path)
  $full = ConvertTo-FullPath $Path
  if (-not (Test-AnyPath $full)) { return $false }
  if (-not (Test-IsReparsePoint $full)) { throw "GAGAL: bukan pautan, tidak dibuang: $full" }
  $target = $null
  try { $target = Get-LinkTarget $full } catch { $target = $null }
  $targetExisted = ($null -ne $target -and (Test-Path -LiteralPath $target))
  if ((([int][System.IO.File]::GetAttributes($full)) -band 0x10) -ne 0) { [System.IO.Directory]::Delete($full, $false) }
  else { [System.IO.File]::Delete($full) }
  if (Test-AnyPath $full) { throw "GAGAL: pautan masih ada selepas dibuang: $full" }
  if ($targetExisted -and -not (Test-Path -LiteralPath $target)) { throw "GAGAL: sasaran pautan hilang selepas pautan dibuang: $target" }
  return $true
}

function Remove-TreeSafe {
  <#
    Deletes a folder tree without ever following a reparse point: links are removed as links first, then
    files, then folders bottom-up. Refuses a Path outside -Under, an -Under that is a drive root or a
    link, and a Path reached through a link.
  #>
  param([Parameter(Mandatory, Position = 0)][string]$Path, [Parameter(Mandatory)][string]$Under)
  $full = ConvertTo-FullPath $Path
  $base = ConvertTo-FullPath $Under
  $driveRoot = [System.IO.Path]::GetPathRoot($base)
  if ($base.Length -le $driveRoot.Length) { throw "GAGAL: pembuangan tidak dibenarkan dengan akar pemacu sebagai had: $base" }
  if (-not (Test-PathInside $full $base -AllowEqual)) { throw "GAGAL: $full di luar $base, tidak dibuang" }
  if (Test-IsReparsePoint $base) { throw "GAGAL: folder had ialah pautan: $base" }
  $p = Split-Path -Parent $full
  while ($null -ne $p -and $p.Length -gt $base.Length) {
    if (Test-IsReparsePoint $p) { throw "GAGAL: laluan melalui pautan, tidak dibuang: $p" }
    $p = Split-Path -Parent $p
  }
  if (-not (Test-AnyPath $full)) { return $false }
  if (Test-IsReparsePoint $full) { return (Remove-JunctionSafe $full) }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) {
    [System.IO.File]::SetAttributes($full, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($full)
    return $true
  }
  $entries = @(Get-SafeTree $full)
  foreach ($e in ($entries | Where-Object { $_.IsLink })) {
    if ($e.IsDir) { [System.IO.Directory]::Delete($e.Path, $false) } else { [System.IO.File]::Delete($e.Path) }
    if (Test-AnyPath $e.Path) { throw "GAGAL: pautan tidak dapat dibuang: $($e.Path)" }
  }
  foreach ($e in ($entries | Where-Object { -not $_.IsLink -and -not $_.IsDir })) {
    [System.IO.File]::SetAttributes($e.Path, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($e.Path)
  }
  foreach ($e in ($entries | Where-Object { -not $_.IsLink -and $_.IsDir } | Sort-Object { $_.Path.Length } -Descending)) {
    [System.IO.File]::SetAttributes($e.Path, [System.IO.FileAttributes]::Directory)
    [System.IO.Directory]::Delete($e.Path, $false)
  }
  [System.IO.File]::SetAttributes($full, [System.IO.FileAttributes]::Directory)
  [System.IO.Directory]::Delete($full, $false)
  if (Test-AnyPath $full) { throw "GAGAL: folder tidak dapat dibuang sepenuhnya: $full" }
  return $true
}

function New-WorkspaceLinks {
  <# Makes node_modules\@surau\<name> junctions from release.json.workspaceLinks. Run AFTER the release folder has its final name. #>
  param([Parameter(Mandatory, Position = 0)][string]$ReleaseDir)
  $rel = ConvertTo-FullPath $ReleaseDir
  $rj = Join-Path $rel 'release.json'
  if (-not (Test-Path -LiteralPath $rj -PathType Leaf)) { throw "GAGAL: release.json tiada dalam $rel" }
  $meta = Get-Content -LiteralPath $rj -Raw -Encoding UTF8 | ConvertFrom-Json
  $made = @()
  if ($null -eq $meta.workspaceLinks) { return $made }
  foreach ($w in @($meta.workspaceLinks)) {
    $name = [string]$w.name
    $target = [string]$w.target
    if ($name -notmatch '^@surau/[a-z-]+$') { throw "GAGAL: nama pautan ruang kerja tidak sah: $name" }
    if ($target -eq '' -or $target -match '[\\:]' -or $target.StartsWith('/')) { throw "GAGAL: sasaran pautan tidak sah: $target" }
    $targetFull = [System.IO.Path]::GetFullPath((Join-Path $rel ($target -replace '/', '\'))).TrimEnd('\')
    if (-not (Test-PathInside $targetFull $rel)) { throw "GAGAL: sasaran pautan di luar keluaran: $target" }
    if (-not (Test-Path -LiteralPath $targetFull -PathType Container)) { throw "GAGAL: sasaran pautan tiada: $target" }
    # the target and every folder between it and the release must be real folders
    $q = $targetFull
    while ($q.Length -gt $rel.Length) {
      if (Test-IsReparsePoint $q) { throw "GAGAL: sasaran pautan melalui pautan lain: $q" }
      $q = Split-Path -Parent $q
    }
    $leaf = $name.Substring('@surau/'.Length)
    $scopeDir = Join-Path (Join-Path $rel 'node_modules') '@surau'
    foreach ($d in @((Join-Path $rel 'node_modules'), $scopeDir)) {
      if (Test-IsReparsePoint $d) { throw "GAGAL: folder ialah pautan: $d" }
    }
    [void][System.IO.Directory]::CreateDirectory($scopeDir)
    $link = Join-Path $scopeDir $leaf
    if (Test-AnyPath $link) {
      if (-not (Test-IsReparsePoint $link)) { throw "GAGAL: $link ialah folder sebenar, bukan pautan" }
      $cur = Get-LinkTarget $link
      if ($null -ne $cur -and $cur.Equals($targetFull, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      [void](Remove-JunctionSafe $link)
    }
    New-Junction $link $targetFull
    $now = Get-LinkTarget $link
    if ($null -eq $now -or -not $now.Equals($targetFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw "GAGAL: pautan $link tidak menuju ke $targetFull" }
    $made += $link
  }
  return $made
}

function Expand-Release {
  <#
    Check the archive, extract to <version>.part, rename to <version>, make the workspace links, write
    .ok last. A release that already has .ok is left alone. A leftover .part or a folder without .ok
    (interrupted run) is deleted safely and the extraction is redone.
    Deviation from the plan order: the rename comes BEFORE the links because a junction stores an
    absolute target, so a link made inside <version>.part would point into the .part folder after the rename.
  #>
  param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$ReleasesDir,
    [Parameter(Mandatory)][string]$Version
  )
  if ($Version -notmatch $script:VersionPattern) { throw "GAGAL: versi tidak sah: $Version" }
  $releases = ConvertTo-FullPath $ReleasesDir
  if (Test-IsReparsePoint $releases) { throw "GAGAL: folder releases ialah pautan: $releases" }
  [void][System.IO.Directory]::CreateDirectory($releases)
  $final = Join-Path $releases $Version
  $part = Join-Path $releases ($Version + '.part')
  $ok = Join-Path $final '.ok'
  if (Test-Path -LiteralPath $ok -PathType Leaf) {
    return [pscustomobject]@{ Version = $Version; Path = $final; Changed = $false }
  }
  $probs = @(Get-ArchiveEntryProblem $Archive)
  if ($probs.Count -gt 0) { throw ("GAGAL: arkib keluaran ditolak: " + (($probs | Select-Object -First 5) -join '; ')) }
  foreach ($stale in @($part, $final)) {
    if (Test-AnyPath $stale) { [void](Remove-TreeSafe $stale -Under $releases) }
  }
  [void][System.IO.Directory]::CreateDirectory($part)
  try {
    $tar = Get-SystemTool 'tar.exe'
    & $tar -xzf (ConvertTo-FullPath $Archive) -C $part
    if ($LASTEXITCODE -ne 0) { throw "GAGAL: tar tidak dapat mengekstrak arkib (kod $LASTEXITCODE)" }
    # belt and braces: nothing extracted may be a link or lie outside the part folder
    foreach ($e in (Get-SafeTree $part)) {
      if ($e.IsLink) { throw "GAGAL: arkib menghasilkan pautan: $($e.Path)" }
      if (-not (Test-PathInside $e.Path $part)) { throw "GAGAL: entri di luar folder ekstrak: $($e.Path)" }
    }
    $rj = Join-Path $part 'release.json'
    if (-not (Test-Path -LiteralPath $rj -PathType Leaf)) { throw 'GAGAL: release.json tiada dalam arkib' }
    $meta = Get-Content -LiteralPath $rj -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$meta.version -ne $Version) { throw "GAGAL: versi dalam release.json ($($meta.version)) tidak sama dengan $Version" }
  } catch {
    $msg = $_.Exception.Message
    try { [void](Remove-TreeSafe $part -Under $releases) } catch { }
    throw $msg
  }
  [System.IO.Directory]::Move($part, $final)
  [void](New-WorkspaceLinks $final)
  [System.IO.File]::WriteAllText($ok, $Version, (New-Object System.Text.UTF8Encoding($false)))
  return [pscustomobject]@{ Version = $Version; Path = $final; Changed = $true }
}

function Switch-Current {
  <# Points <root>\current at releases\<version> (needs .ok), writing previous.txt with the version it left. #>
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Version)
  if ($Version -notmatch $script:VersionPattern) { throw "GAGAL: versi tidak sah: $Version" }
  $rootFull = ConvertTo-FullPath $Root
  $target = Join-Path (Join-Path $rootFull 'releases') $Version
  $cur = Join-Path $rootFull 'current'
  if (-not (Test-Path -LiteralPath (Join-Path $target '.ok') -PathType Leaf)) { throw "GAGAL: keluaran $Version belum lengkap (.ok tiada)" }
  if (Test-IsReparsePoint $target) { throw "GAGAL: folder keluaran ialah pautan: $target" }
  $old = $null
  if (Test-AnyPath $cur) {
    if (-not (Test-IsReparsePoint $cur)) { throw "GAGAL: $cur ialah folder sebenar, bukan pautan" }
    $t = Get-LinkTarget $cur
    if ($null -ne $t -and $t.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
      return [pscustomobject]@{ Changed = $false; From = $Version; To = $Version }
    }
    if ($null -ne $t) { $old = Split-Path -Leaf $t }
  }
  if ($null -ne $old -and $old -match $script:VersionPattern -and $old -ne $Version) {
    [System.IO.File]::WriteAllText((Join-Path $rootFull 'previous.txt'), $old, (New-Object System.Text.UTF8Encoding($false)))
  }
  if (Test-AnyPath $cur) { [void](Remove-JunctionSafe $cur) }
  New-Junction $cur $target
  $now = Get-LinkTarget $cur
  if ($null -eq $now -or -not $now.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "GAGAL: pautan current tidak menuju ke $target"
  }
  return [pscustomobject]@{ Changed = $true; From = $old; To = $Version }
}

# ---------------------------------------------------------------------------------------------
# Network and processes
# ---------------------------------------------------------------------------------------------

function Get-PrivateIPv4 {
  <# Private IPv4 addresses of adapters that are up; the one with a default gateway comes first. #>
  $withGw = @()
  $without = @()
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up') { continue }
    if ($nic.NetworkInterfaceType -eq 'Loopback' -or $nic.NetworkInterfaceType -eq 'Tunnel') { continue }
    $props = $nic.GetIPProperties()
    $hasGw = $false
    foreach ($g in $props.GatewayAddresses) {
      if ($g.Address.AddressFamily -eq 'InterNetwork' -and $g.Address.ToString() -ne '0.0.0.0') { $hasGw = $true }
    }
    foreach ($u in $props.UnicastAddresses) {
      if ($u.Address.AddressFamily -ne 'InterNetwork') { continue }
      $ip = $u.Address.ToString()
      $b = $u.Address.GetAddressBytes()
      $private = ($b[0] -eq 10) -or ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31)
      if (-not $private) { continue }
      if ($hasGw) { $withGw += $ip } else { $without += $ip }
    }
  }
  return @($withGw) + @($without)
}

function Get-PortOwner {
  <# Who listens on a TCP port: one object per owning process (Pid, Name, CommandLine, Owner, StartTime), or nothing. #>
  param([Parameter(Mandatory, Position = 0)][ValidateRange(1, 65535)][int]$Port)
  $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $seen = @{}
  foreach ($c in $conns) {
    $procId = [int]$c.OwningProcess
    if ($seen.ContainsKey($procId)) { continue }
    $seen[$procId] = $true
    $name = ''; $cmd = ''; $owner = ''; $start = $null
    $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    if ($null -ne $cim) {
      $name = [string]$cim.Name
      $cmd = [string]$cim.CommandLine
      $start = $cim.CreationDate
      try {
        $o = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction Stop
        if ($o.ReturnValue -eq 0) { $owner = "$($o.Domain)\$($o.User)" }
      } catch { $owner = '' }
    }
    [pscustomobject]@{
      Port = $Port; Address = [string]$c.LocalAddress; Pid = $procId; Name = $name
      CommandLine = $cmd; Owner = $owner; StartTime = $start
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Install state (<root>\state\install.json): paths, versions, kiosk mode, ip. Never a secret.
# ---------------------------------------------------------------------------------------------

function Read-InstallState {
  param([Parameter(Mandatory, Position = 0)][string]$InstallRoot)
  $p = Join-Path (ConvertTo-FullPath $InstallRoot) 'state\install.json'
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-InstallState {
  <# Merges State (hashtable) into install.json and writes it atomically. Refuses a key that looks like a secret. #>
  param([Parameter(Mandatory, Position = 0)][string]$InstallRoot, [Parameter(Mandatory)][System.Collections.IDictionary]$State)
  Assert-NoSecretKey $State 'state'
  $root = ConvertTo-FullPath $InstallRoot
  $stateDir = Join-Path $root 'state'
  $file = Join-Path $stateDir 'install.json'
  [void][System.IO.Directory]::CreateDirectory($stateDir)
  $merged = [ordered]@{ v = 1 }
  if (Test-Path -LiteralPath $file -PathType Leaf) {
    $old = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($prop in $old.PSObject.Properties) { $merged[$prop.Name] = $prop.Value }
  }
  foreach ($k in $State.Keys) { $merged[[string]$k] = $State[$k] }
  $json = $merged | ConvertTo-Json -Depth 6
  $tmp = $file + '.tmp'
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $file -PathType Leaf) { [System.IO.File]::Replace($tmp, $file, [NullString]::Value) }
  else { [System.IO.File]::Move($tmp, $file) }
  return $file
}

Export-ModuleMember -Function @(
  'Get-MaxcomPaths', 'Test-MaxcomElevated', 'Resolve-SetupScript', 'Write-Step', 'Invoke-Step',
  'Get-UntrustedWriters', 'Test-SafeInstallRoot', 'Get-InstallRootProblem',
  'Set-MaxcomRootAcl', 'Set-MaxcomDataAcl', 'Get-MaxcomAclContract', 'Get-MaxcomDataAclProblem', 'Test-MaxcomDataAcl',
  'Get-MaxcomHomeProblem', 'Remove-OldBackups', 'Test-PathInside',
  'Test-BundleManifest', 'Get-BundleManifestProblem', 'Test-ArchiveEntries', 'Get-ArchiveEntryProblem',
  'Expand-Release', 'New-WorkspaceLinks', 'Switch-Current', 'Remove-JunctionSafe', 'Remove-TreeSafe',
  'Get-PrivateIPv4', 'Get-PortOwner', 'Read-InstallState', 'Write-InstallState',
  'ConvertTo-FullPath', 'Test-IsReparsePoint', 'Get-LinkTarget'
)
