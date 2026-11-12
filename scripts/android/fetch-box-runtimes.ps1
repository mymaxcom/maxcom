<#
.SYNOPSIS
  Fetches, verifies and unpacks the pinned runtimes of the MAXCOM box APK (Node from Termux with its shared
  libraries, and MediaMTX) and lays them out for apps/box-android.

.DESCRIPTION
  Every file is pinned by sha256 in scripts/android/android-pins.json. A pinned file is taken from the build cache
  (dist\android-cache) when its hash matches, otherwise it is downloaded over HTTPS and compared BEFORE any use.
  A mismatch deletes the file and stops with GAGAL. Nothing is patched: every library keeps the bytes (and the sha256)
  it had inside the Termux package. Files that are not named lib*.so are renamed by decision 6 of the plan
  (libz.so.1 -> libz_so_1.so, node -> libnode.so) and the pairs are written to libmap.json.

  The libraries to ship are not a fixed list: the ELF dynamic section (DT_NEEDED) of node and of every library taken
  is read, so a new Termux dependency is noticed and a missing one fails by name.

  Output (default dist\android-runtime\<abi>):
    jniLibs\<abi>\lib*.so   libmap.json   cert.pem   licences\   runtime-manifest.json   VERSIONS.md

.PARAMETER Abi        armeabi-v7a or arm64-v8a.
.PARAMETER CacheDir   Default <repo>\dist\android-cache. Keep a copy with the release: Termux removes old versions.
.PARAMETER OutDir     Default <repo>\dist\android-runtime\<abi>.
.PARAMETER PinsFile   Default scripts\android\android-pins.json.
.PARAMETER DryRun     List what would be fetched or reused and write nothing.
.PARAMETER RenameNames  Comma separated names: print the APK name decision 6 gives each (an executable is written as exe:node) and exit.
#>
[CmdletBinding()]
param(
  [ValidateSet('armeabi-v7a', 'arm64-v8a')][string]$Abi,
  [string]$CacheDir,
  [string]$OutDir,
  [string]$PinsFile,
  [switch]$DryRun,
  [string]$RenameNames
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TermuxPrefix = 'data/data/com.termux/files/usr'
$SystemLibs = @('libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so')

# Decision 6: the Android installer only extracts lib<name>.so.
function Get-ApkName {
  param([string]$Name, [bool]$Executable)
  if ($Executable) {
    if ($Name -notmatch '^[A-Za-z0-9_+-]+$') { throw "executable name not allowed: $Name" }
    return "lib$Name.so"
  }
  if ($Name -match '^lib[A-Za-z0-9_+-]+\.so$') { return $Name }
  if ($Name -match '^(lib[A-Za-z0-9_+-]+)\.so\.([0-9]+(\.[0-9]+)*)$') {
    return ($Matches[1] + '_so_' + ($Matches[2] -replace '\.', '_') + '.so')
  }
  throw "library name cannot be renamed to lib*.so: $Name"
}

if ($RenameNames) {
  foreach ($n in $RenameNames.Split(',')) {
    if ($n.StartsWith('exe:')) { Write-Host ("{0}=>{1}" -f $n, (Get-ApkName -Name $n.Substring(4) -Executable $true)) }
    else { Write-Host ("{0}=>{1}" -f $n, (Get-ApkName -Name $n -Executable $false)) }
  }
  exit 0
}

if (-not $Abi) { Write-Host 'GAGAL: -Abi diperlukan (armeabi-v7a atau arm64-v8a)'; exit 1 }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $PinsFile) { $PinsFile = Join-Path $PSScriptRoot 'android-pins.json' }
if (-not $CacheDir) { $CacheDir = Join-Path $RepoRoot 'dist\android-cache' }
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot ('dist\android-runtime\' + $Abi) }
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

$ElfMachine = @{ 'armeabi-v7a' = 40; 'arm64-v8a' = 183 }[$Abi]
$ElfClass = @{ 'armeabi-v7a' = 1; 'arm64-v8a' = 2 }[$Abi]
$Arch = @{ 'armeabi-v7a' = 'arm'; 'arm64-v8a' = 'aarch64' }[$Abi]

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# The one place that talks to the network. The caller compares the hash before the file is used.
function Get-PinnedDownload {
  param([string]$Url, [string]$Dest)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Dest
}

function Test-PinShape {
  param([string]$Name, $Pin)
  if ($null -eq $Pin) { throw "pin tiada untuk $Name" }
  $sha = [string]$Pin.sha256
  if ([string]::IsNullOrWhiteSpace($sha)) { throw "sha256 belum diisi untuk $Name" }
  if ($sha -notmatch '^[0-9a-f]{64}$') { throw "sha256 tidak sah untuk $Name" }
  if (([string]$Pin.url) -notmatch '^https://[^\s]+$') { throw "url mesti https:// untuk $Name" }
  if (([string]$Pin.file) -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$') { throw "nama fail tidak sah untuk $Name" }
  if ([string]::IsNullOrWhiteSpace([string]$Pin.version)) { throw "version tiada untuk $Name" }
}

# Returns the cache path of a verified file. -DryRun reports and never writes or deletes.
function Get-VerifiedFile {
  param([string]$Name, $Pin)
  Test-PinShape -Name $Name -Pin $Pin
  $want = [string]$Pin.sha256
  $path = Join-Path $CacheDir ([string]$Pin.file)
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    if ((Get-Sha256 $path) -eq $want) {
      Write-Host ("cache   {0} {1}" -f $Name, $Pin.version)
      return $path
    }
    if ($DryRun) { Write-Host ("cache fail hash, will be deleted and fetched again: {0}" -f $path) }
    else {
      Write-Host ("cache fail hash, deleted: {0}" -f $path)
      Remove-Item -LiteralPath $path -Force
    }
  }
  if ($DryRun) {
    Write-Host ("fetch   {0} {1} from {2}" -f $Name, $Pin.version, $Pin.url)
    return $null
  }
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $part = $path + '.part'
  if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
  Write-Host ("fetch   {0} {1} from {2}" -f $Name, $Pin.version, $Pin.url)
  try { Get-PinnedDownload -Url ([string]$Pin.url) -Dest $part }
  catch {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    throw "muat turun gagal untuk $Name : $($_.Exception.Message)"
  }
  if ((Get-Sha256 $part) -ne $want) {
    Remove-Item -LiteralPath $part -Force
    throw "sha256 tidak sepadan untuk $Name (fail dipadam)"
  }
  Move-Item -LiteralPath $part -Destination $path -Force
  return $path
}

function Invoke-Tar {
  param([string[]]$TarArgs)
  & $Tar @TarArgs
  if ($LASTEXITCODE -ne 0) { throw "tar.exe gagal ($LASTEXITCODE): $($TarArgs -join ' ')" }
}

# Entries of an archive as @{ Type; Path; Target; Size }; Path has the leading ./ removed.
function Get-TarEntries {
  param([string]$Archive)
  $lines = & $Tar -tvf $Archive
  if ($LASTEXITCODE -ne 0) { throw "tar.exe tidak dapat membaca $Archive" }
  $out = New-Object System.Collections.ArrayList
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^(.)[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$') { throw "baris senarai tar tidak dikenali: $line" }
    $type = $Matches[1]; $size = [int64]$Matches[2]; $rest = $Matches[3]
    $target = $null
    if ($type -eq 'l') {
      $i = $rest.IndexOf(' -> ')
      if ($i -lt 0) { throw "symlink tanpa sasaran: $line" }
      $target = $rest.Substring($i + 4); $rest = $rest.Substring(0, $i)
    } elseif ($type -eq 'h') {
      $i = $rest.IndexOf(' link to ')
      if ($i -ge 0) { $rest = $rest.Substring(0, $i) }
    }
    $p = $rest
    while ($p.StartsWith('./')) { $p = $p.Substring(2) }
    $p = $p.TrimEnd('/')
    [void]$out.Add(@{ Type = $type; Path = $p; Target = $target; Size = $size })
  }
  return $out
}

# Refuses `..`, absolute paths and anything outside Termux's own prefix (ancestors of the prefix are fine).
function Test-EntryPath {
  param([string]$Path, [string]$Archive)
  if ($Path -eq '' -or $Path -eq '.') { return }
  if ($Path.StartsWith('/') -or $Path.StartsWith('\') -or $Path -match '^[A-Za-z]:' -or $Path.Contains('\')) { throw "entri mutlak atau tidak sah dalam ${Archive}: $Path" }
  $segs = $Path.Split('/')
  if ($segs -contains '..' -or $segs -contains '.' -or $segs -contains '') { throw "entri dengan .. dalam ${Archive}: $Path" }
  $inside = ($Path -eq $TermuxPrefix) -or $Path.StartsWith($TermuxPrefix + '/') -or ($TermuxPrefix.StartsWith($Path + '/'))
  if (-not $inside) { throw "entri di luar awalan Termux dalam ${Archive}: $Path" }
}

# Resolves a symlink target to a path relative to the Termux prefix, or $null when it leaves the prefix.
function Resolve-LinkTarget {
  param([string]$RelDir, [string]$Target)
  $parts = New-Object System.Collections.ArrayList
  if ($Target.StartsWith('/')) {
    $abs = '/' + $TermuxPrefix + '/'
    if (-not $Target.StartsWith($abs)) { return $null }
    $Target = $Target.Substring($abs.Length)
  } elseif ($RelDir -ne '') {
    foreach ($s in $RelDir.Split('/')) { [void]$parts.Add($s) }
  }
  foreach ($s in $Target.Split('/')) {
    if ($s -eq '' -or $s -eq '.') { continue }
    if ($s -eq '..') {
      if ($parts.Count -eq 0) { return $null }
      $parts.RemoveAt($parts.Count - 1)
    } else { [void]$parts.Add($s) }
  }
  return ($parts -join '/')
}

# ELF header and dynamic section: Class, Machine, Needed[]. Bounds are checked on every read.
function Read-Elf {
  param([string]$Path)
  $b = [IO.File]::ReadAllBytes($Path)
  if ($b.Length -lt 64 -or $b[0] -ne 0x7F -or $b[1] -ne 0x45 -or $b[2] -ne 0x4C -or $b[3] -ne 0x46) { throw "bukan fail ELF: $Path" }
  $class = [int]$b[4]
  if ($b[5] -ne 1) { throw "ELF bukan little-endian: $Path" }
  if ($class -ne 1 -and $class -ne 2) { throw "kelas ELF tidak sah: $Path" }
  $is64 = ($class -eq 2)
  $machine = [int][BitConverter]::ToUInt16($b, 18)
  $u = {
    param($off, $len)
    if ($off -lt 0 -or ($off + $len) -gt $b.Length) { throw "ELF di luar sempadan: $Path" }
    if ($len -eq 2) { return [uint64][BitConverter]::ToUInt16($b, $off) }
    if ($len -eq 4) { return [uint64][BitConverter]::ToUInt32($b, $off) }
    return [uint64][BitConverter]::ToUInt64($b, $off)
  }
  if ($is64) { $phoff = & $u 32 8; $phentsize = & $u 54 2; $phnum = & $u 56 2 }
  else { $phoff = & $u 28 4; $phentsize = & $u 42 2; $phnum = & $u 44 2 }
  $loads = @(); $dynOff = $null; $dynSize = 0
  for ($i = 0; $i -lt [int]$phnum; $i++) {
    $o = [int]$phoff + $i * [int]$phentsize
    $type = & $u $o 4
    if ($is64) { $pOffset = & $u ($o + 8) 8; $pVaddr = & $u ($o + 16) 8; $pFilesz = & $u ($o + 32) 8 }
    else { $pOffset = & $u ($o + 4) 4; $pVaddr = & $u ($o + 8) 4; $pFilesz = & $u ($o + 16) 4 }
    if ($type -eq 1) { $loads += , @([int64]$pVaddr, [int64]$pOffset, [int64]$pFilesz) }
    if ($type -eq 2) { $dynOff = [int64]$pOffset; $dynSize = [int64]$pFilesz }
  }
  $needed = New-Object System.Collections.ArrayList
  if ($null -ne $dynOff) {
    $esz = 8; if ($is64) { $esz = 16 }
    $neededOffs = @(); $strtab = $null
    for ($p = $dynOff; $p + $esz -le $dynOff + $dynSize; $p += $esz) {
      if ($is64) { $tag = & $u $p 8; $val = & $u ($p + 8) 8 } else { $tag = & $u $p 4; $val = & $u ($p + 4) 4 }
      if ($tag -eq 0) { break }
      if ($tag -eq 1) { $neededOffs += [int64]$val }
      if ($tag -eq 5) { $strtab = [int64]$val }
    }
    if ($neededOffs.Count -gt 0) {
      if ($null -eq $strtab) { throw "ELF tanpa DT_STRTAB: $Path" }
      $strFile = $null
      foreach ($l in $loads) { if ($strtab -ge $l[0] -and $strtab -lt $l[0] + $l[2]) { $strFile = $strtab - $l[0] + $l[1]; break } }
      if ($null -eq $strFile) { throw "DT_STRTAB di luar segmen: $Path" }
      foreach ($no in $neededOffs) {
        $s = [int]($strFile + $no)
        if ($s -lt 0 -or $s -ge $b.Length) { throw "DT_NEEDED di luar sempadan: $Path" }
        $e = $s
        while ($e -lt $b.Length -and $b[$e] -ne 0) { $e++ }
        if ($e -ge $b.Length -or $e - $s -gt 255) { throw "nama DT_NEEDED rosak: $Path" }
        $name = [Text.Encoding]::ASCII.GetString($b, $s, $e - $s)
        if ($name -notmatch '^[A-Za-z0-9_+.-]+$') { throw "nama DT_NEEDED tidak sah: $Path" }
        [void]$needed.Add($name)
      }
    }
  }
  return @{ Class = $class; Machine = $machine; Needed = @($needed) }
}

function Assert-ElfAbi {
  param($Elf, [string]$What)
  if ($Elf.Class -ne $ElfClass -or $Elf.Machine -ne $ElfMachine) { throw "$What bukan untuk $Abi (kelas $($Elf.Class), mesin $($Elf.Machine))" }
}

# ---------------------------------------------------------------- main
$scratch = $null
try {
  if (-not (Test-Path -LiteralPath $PinsFile -PathType Leaf)) { throw "fail pin tiada: $PinsFile" }
  $pins = Get-Content -LiteralPath $PinsFile -Raw | ConvertFrom-Json
  $termuxPins = $pins.termux.$Arch
  if ($null -eq $termuxPins) { throw "pins.termux.$Arch tiada" }
  $mtxPin = $pins.mediamtx.$Abi
  if ($null -eq $mtxPin) { throw "pins.mediamtx.$Abi tiada" }
  $pkgNames = @($termuxPins.PSObject.Properties | ForEach-Object { $_.Name })
  if ($pkgNames.Count -eq 0) { throw "tiada pakej Termux untuk $Arch" }
  foreach ($n in $pkgNames) { if ($n -notmatch '^[A-Za-z0-9][A-Za-z0-9.+-]*$') { throw "nama pakej tidak sah: $n" } }

  # all pins are checked before anything is fetched
  foreach ($n in $pkgNames) { Test-PinShape -Name $n -Pin $termuxPins.$n }
  Test-PinShape -Name 'mediamtx' -Pin $mtxPin

  if (-not (Test-Path -LiteralPath $Tar -PathType Leaf)) { throw "tar.exe tiada: $Tar" }
  $tv = (& $Tar --version) -join ' '
  if ($tv -notmatch 'liblzma') { throw 'tar.exe tidak menyokong xz (liblzma tiada dalam tar --version)' }

  $files = @{}
  foreach ($n in $pkgNames) { $files[$n] = Get-VerifiedFile -Name $n -Pin $termuxPins.$n }
  $mtxFile = Get-VerifiedFile -Name 'mediamtx' -Pin $mtxPin
  if ($DryRun) { Write-Host 'DryRun: tiada apa ditulis.'; exit 0 }

  $scratch = Join-Path ([IO.Path]::GetTempPath()) ('maxcom-android-fetch-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $scratch | Out-Null

  # unpack each .deb (an ar archive) down to its data.tar.xz and list it
  $pkg = @{}
  foreach ($n in $pkgNames) {
    $dir = Join-Path $scratch ('deb-' + $n)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Invoke-Tar @('-xf', $files[$n], '-C', $dir, 'data.tar.xz')
    $data = Join-Path $dir 'data.tar.xz'
    if (-not (Test-Path -LiteralPath $data -PathType Leaf)) { throw "data.tar.xz tiada dalam $n" }
    $entries = @{}
    foreach ($e in (Get-TarEntries -Archive $data)) {
      Test-EntryPath -Path $e.Path -Archive $n
      if ($e.Path -eq $TermuxPrefix -or $e.Path.StartsWith($TermuxPrefix + '/')) {
        $rel = ''
        if ($e.Path.Length -gt $TermuxPrefix.Length) { $rel = $e.Path.Substring($TermuxPrefix.Length + 1) }
        if ($rel -ne '') { $entries[$rel] = $e }
      }
    }
    $pkg[$n] = @{ Data = $data; Entries = $entries; Dir = $dir }
  }

  function Get-RealRel {
    param([string]$PkgName, [string]$Rel)
    $entries = $pkg[$PkgName].Entries
    for ($hop = 0; $hop -lt 8; $hop++) {
      $e = $entries[$Rel]
      if ($null -eq $e) { throw "pautan putus dalam ${PkgName}: $Rel" }
      if ($e.Type -eq '-') { return $Rel }
      if ($e.Type -ne 'l') { throw "bukan fail biasa dalam ${PkgName}: $Rel" }
      $dirPart = ''
      $ix = $Rel.LastIndexOf('/')
      if ($ix -ge 0) { $dirPart = $Rel.Substring(0, $ix) }
      $next = Resolve-LinkTarget -RelDir $dirPart -Target $e.Target
      if ($null -eq $next) { throw "symlink keluar dari awalan Termux dalam ${PkgName}: $Rel" }
      $Rel = $next
    }
    throw "terlalu banyak symlink dalam ${PkgName}: $Rel"
  }

  function Expand-Entries {
    param([string]$PkgName, [string[]]$Rels)
    $list = Join-Path $pkg[$PkgName].Dir ('want-' + [Guid]::NewGuid().ToString('N') + '.txt')
    $lines = @($Rels | ForEach-Object { './' + $TermuxPrefix + '/' + $_ })
    [IO.File]::WriteAllLines($list, $lines, [Text.Encoding]::ASCII)
    $dest = Join-Path $pkg[$PkgName].Dir 'x'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Invoke-Tar @('-xf', $pkg[$PkgName].Data, '-C', $dest, '-T', $list)
    $res = @{}
    foreach ($r in $Rels) {
      $local = Join-Path $dest (($TermuxPrefix + '/' + $r) -replace '/', '\')
      if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw "tidak dapat dikeluarkan dari ${PkgName}: $r" }
      if ((Get-Item -LiteralPath $local).Length -ne $pkg[$PkgName].Entries[$r].Size) { throw "saiz tidak sepadan selepas keluarkan ${PkgName}: $r" }
      $res[$r] = $local
    }
    return $res
  }

  # library index: lib/<name> (file or symlink) of every package
  $libIndex = @{}
  foreach ($n in $pkgNames) {
    foreach ($rel in $pkg[$n].Entries.Keys) {
      if ($rel -match '^lib/([^/]+)$') {
        $base = $Matches[1]
        $t = $pkg[$n].Entries[$rel].Type
        if ($t -ne '-' -and $t -ne 'l') { continue }
        if ($libIndex.ContainsKey($base) -and $libIndex[$base].Pkg -ne $n) { throw "perpustakaan $base disediakan oleh dua pakej: $($libIndex[$base].Pkg) dan $n" }
        $libIndex[$base] = @{ Pkg = $n; Rel = $rel }
      }
    }
  }

  # node
  $nodePkg = @($pkgNames | Where-Object { $pkg[$_].Entries.ContainsKey('bin/node') -and $pkg[$_].Entries['bin/node'].Type -eq '-' })
  if ($nodePkg.Count -ne 1) { throw "bin/node mesti ada dalam tepat satu pakej (jumpa $($nodePkg.Count))" }
  $selected = New-Object System.Collections.ArrayList   # @{ Apk; Name; Pkg; Rel; Local; Exe }
  $byApk = @{}
  $nodeLocal = (Expand-Entries -PkgName $nodePkg[0] -Rels @('bin/node'))['bin/node']
  $nodeElf = Read-Elf -Path $nodeLocal
  Assert-ElfAbi -Elf $nodeElf -What 'node'
  $nodeApk = Get-ApkName -Name 'node' -Executable $true
  $item = @{ Apk = $nodeApk; Name = 'node'; Pkg = $nodePkg[0]; Rel = 'bin/node'; Local = $nodeLocal; Exe = $true }
  [void]$selected.Add($item); $byApk[$nodeApk] = $item

  $queue = New-Object System.Collections.Queue
  foreach ($nn in $nodeElf.Needed) { $queue.Enqueue(@($nn, 'node')) }
  $seen = @{}
  while ($queue.Count -gt 0) {
    $pair = $queue.Dequeue(); $need = $pair[0]; $by = $pair[1]
    if ($SystemLibs -contains $need -or $seen.ContainsKey($need)) { continue }
    $seen[$need] = $true
    if (-not $libIndex.ContainsKey($need)) { throw "perpustakaan diperlukan tetapi tiada dalam mana-mana pakej: $need (diperlukan oleh $by)" }
    $src = $libIndex[$need]
    $real = Get-RealRel -PkgName $src.Pkg -Rel $src.Rel
    $local = (Expand-Entries -PkgName $src.Pkg -Rels @($real))[$real]
    $elf = Read-Elf -Path $local
    Assert-ElfAbi -Elf $elf -What $need
    $apk = Get-ApkName -Name $need -Executable $false
    if ($byApk.ContainsKey($apk)) { throw "dua nama memberi nama APK yang sama $apk" }
    $item = @{ Apk = $apk; Name = $need; Pkg = $src.Pkg; Rel = $real; Local = $local; Exe = $false }
    [void]$selected.Add($item); $byApk[$apk] = $item
    foreach ($nn in $elf.Needed) { $queue.Enqueue(@($nn, $need)) }
  }

  # cert.pem
  $certPkg = @($pkgNames | Where-Object { $pkg[$_].Entries.ContainsKey('etc/tls/cert.pem') -and $pkg[$_].Entries['etc/tls/cert.pem'].Type -eq '-' })
  if ($certPkg.Count -ne 1) { throw "etc/tls/cert.pem mesti ada dalam tepat satu pakej (jumpa $($certPkg.Count))" }
  $certLocal = (Expand-Entries -PkgName $certPkg[0] -Rels @('etc/tls/cert.pem'))['etc/tls/cert.pem']

  # licence files (copyright, LICENSE*) of each package; a symlink into Termux's LICENSES folder is recorded as a note
  $licFiles = @()   # @{ Pkg; Name; Local } or @{ Pkg; Name; Note }
  foreach ($n in $pkgNames) {
    $want = @()
    foreach ($rel in $pkg[$n].Entries.Keys) {
      if ($rel -match '^share/doc/[^/]+/(copyright|LICENSE[A-Za-z0-9._-]*|COPYING[A-Za-z0-9._-]*|NOTICE[A-Za-z0-9._-]*)$') {
        $e = $pkg[$n].Entries[$rel]
        if ($e.Type -eq '-') { $want += $rel }
        elseif ($e.Type -eq 'l') { $licFiles += @{ Pkg = $n; Name = ($rel.Split('/')[-1]); Note = $e.Target } }
      }
    }
    if ($want.Count -gt 0) {
      $ex = Expand-Entries -PkgName $n -Rels $want
      foreach ($r in $want) { $licFiles += @{ Pkg = $n; Name = ($r.Split('/')[-1]); Local = $ex[$r] } }
    }
  }

  # MediaMTX
  $mtxDir = Join-Path $scratch 'mediamtx'
  New-Item -ItemType Directory -Force -Path $mtxDir | Out-Null
  $mtxNames = @{}
  foreach ($e in (Get-TarEntries -Archive $mtxFile)) {
    $pp = $e.Path
    if ($pp -eq '' -or $pp.StartsWith('/') -or $pp.Contains('\') -or (($pp.Split('/')) -contains '..')) { throw "entri tidak sah dalam arkib mediamtx: $pp" }
    $mtxNames[$pp] = $e
  }
  if (-not $mtxNames.ContainsKey('mediamtx') -or $mtxNames['mediamtx'].Type -ne '-') { throw 'arkib mediamtx tiada fail mediamtx' }
  $mtxWant = @('mediamtx'); if ($mtxNames.ContainsKey('LICENSE') -and $mtxNames['LICENSE'].Type -eq '-') { $mtxWant += 'LICENSE' }
  Invoke-Tar (@('-xf', $mtxFile, '-C', $mtxDir) + $mtxWant)
  $mtxLocal = Join-Path $mtxDir 'mediamtx'
  if (-not (Test-Path -LiteralPath $mtxLocal -PathType Leaf)) { throw 'mediamtx tidak dikeluarkan' }
  Assert-ElfAbi -Elf (Read-Elf -Path $mtxLocal) -What 'mediamtx'

  # ---- write the output
  $libDir = Join-Path $OutDir ('jniLibs\' + $Abi)
  foreach ($old in @('jniLibs', 'licences')) {
    $op = Join-Path $OutDir $old
    if (Test-Path -LiteralPath $op) {
      if ((Get-Item -LiteralPath $op -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$op ialah pautan; dipaksa berhenti" }
      Remove-Item -LiteralPath $op -Recurse -Force
    }
  }
  foreach ($old in @('libmap.json', 'cert.pem', 'runtime-manifest.json', 'VERSIONS.md')) {
    $op = Join-Path $OutDir $old
    if (Test-Path -LiteralPath $op) { Remove-Item -LiteralPath $op -Force }
  }
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null

  $manifest = New-Object System.Collections.ArrayList
  foreach ($s in ($selected | Sort-Object { $_.Apk })) {
    $dest = Join-Path $libDir $s.Apk
    Copy-Item -LiteralPath $s.Local -Destination $dest -Force
    $h = Get-Sha256 $dest
    if ($h -ne (Get-Sha256 $s.Local)) { throw "salinan rosak: $($s.Apk)" }
    $ver = [string]$termuxPins.($s.Pkg).version
    [void]$manifest.Add([ordered]@{ apk = $s.Apk; name = $s.Name; sha256 = $h; size = (Get-Item -LiteralPath $dest).Length; from = ('termux:{0}:{1}:{2}' -f $s.Pkg, $ver, $s.Rel) })
  }
  $mtxDest = Join-Path $libDir 'libmediamtx.so'
  Copy-Item -LiteralPath $mtxLocal -Destination $mtxDest -Force
  [void]$manifest.Add([ordered]@{ apk = 'libmediamtx.so'; name = 'mediamtx'; sha256 = (Get-Sha256 $mtxDest); size = (Get-Item -LiteralPath $mtxDest).Length; from = ('mediamtx:{0}:mediamtx' -f $mtxPin.version) })

  $sortedManifest = @($manifest | Sort-Object { $_.apk })
  $map = @($selected | Where-Object { -not $_.Exe } | Sort-Object { $_.Name } | ForEach-Object { '{"apk":"' + $_.Apk + '","name":"' + $_.Name + '"}' })
  [IO.File]::WriteAllText((Join-Path $OutDir 'libmap.json'), ('[' + ($map -join ',') + ']'), [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $OutDir 'runtime-manifest.json'), (ConvertTo-Json -InputObject $sortedManifest -Depth 4), [Text.Encoding]::ASCII)
  Copy-Item -LiteralPath $certLocal -Destination (Join-Path $OutDir 'cert.pem') -Force

  foreach ($l in $licFiles) {
    $ld = Join-Path $OutDir ('licences\' + $l.Pkg)
    New-Item -ItemType Directory -Force -Path $ld | Out-Null
    if ($l.Note) { [IO.File]::WriteAllText((Join-Path $ld ($l.Name + '.link.txt')), ($l.Name + ' -> ' + $l.Note + "`n"), [Text.Encoding]::ASCII) }
    else { Copy-Item -LiteralPath $l.Local -Destination (Join-Path $ld $l.Name) -Force }
  }
  if ($mtxWant -contains 'LICENSE') {
    $ld = Join-Path $OutDir 'licences\mediamtx'
    New-Item -ItemType Directory -Force -Path $ld | Out-Null
    Copy-Item -LiteralPath (Join-Path $mtxDir 'LICENSE') -Destination (Join-Path $ld 'LICENSE') -Force
  }

  # VERSIONS.md in the table live/tools.ts parses (name, version, URL, sha256, licence, date)
  $today = (Get-Date).ToString('yyyy-MM-dd')
  $vl = @(
    '# MAXCOM live tools (Android)',
    '',
    'Written by scripts/android/fetch-box-runtimes.ps1. The sha256 is the hash of the pinned download (ffmpeg: its source tarball).',
    '',
    '| Name | Version | URL | sha256 | Licence | Date |',
    '|---|---|---|---|---|---|',
    ('| mediamtx | {0} | {1} | {2} | {3} | {4} |' -f $mtxPin.version, $mtxPin.url, $mtxPin.sha256, $mtxPin.licence, $today)
  )
  if ($null -ne $pins.ffmpegSrc) {
    $vl += ('| ffmpeg | {0} | {1} | {2} | {3} | {4} |' -f $pins.ffmpegSrc.version, $pins.ffmpegSrc.url, $pins.ffmpegSrc.sha256, $pins.ffmpegSrc.licence, $today)
  }
  [IO.File]::WriteAllLines((Join-Path $OutDir 'VERSIONS.md'), $vl, [Text.Encoding]::ASCII)

  Write-Host ("Siap: {0} fail dalam {1}" -f $sortedManifest.Count, $libDir)
  Write-Host ("Output: {0}" -f $OutDir)
  exit 0
}
catch {
  Write-Host ("GAGAL: " + $_.Exception.Message)
  exit 1
}
finally {
  if ($scratch -and (Test-Path -LiteralPath $scratch)) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}
