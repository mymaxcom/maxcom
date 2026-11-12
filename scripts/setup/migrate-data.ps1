<#
.SYNOPSIS
  Moves the data folder of a hand-run MAXCOM box into the installed layout, verified file by file.
  Windows PowerShell 5.1, ASCII only, built-ins only.

.DESCRIPTION
  Called by setup.ps1 with -MigrateFrom; can also be run by hand from <root>\bin.

  What it does (plan section "Migration of a hand-run box"):
    1. Checks (changes nothing): the source has surau.db and secret\box.key; the target has no
       database and none of the source's top-level names; source, target and backup folders are not
       inside each other; the source holds no links; enough free space (twice the source plus 1 GB).
    2. Finds the box: the process that listens on the port, accepted only when it is node.exe with
       main.ts on its command line. Shows PID, start time and command line, and asks. With -Yes the
       PID must be given as -StopPid and must match. Nothing listening: carries on.
    3. Stops those PIDs only (that process and its mediamtx.exe / ffmpeg.exe descendants), by
       Stop-Process -Id. Waits until the port is closed and the database files stop changing.
    4. Records relative path, size and sha256 of every source file in
       <BackupRoot>\pre-install-<stamp>\source-manifest.json.
    5. Backs up with robocopy /E /COPY:DAT /XJ to <BackupRoot>\pre-install-<stamp>\data.
    6. Copies the same way into -DataDir (skipping only the old box-run.log) and applies the data ACL.
    7. Verifies: every source file exists in the target with the same sha256; PRAGMA integrity_check
       answers ok on the copied surau.db (bundled Node, node:sqlite, run on a scratch copy of the
       verified files so the target is not touched); the source manifest
       computed again equals the first. Any failure renames the target to data.failed-<stamp>, exits 1,
       and the old box can be started by hand exactly as before.

  The source folder is only ever read: nothing in it is written, renamed or deleted. Exit 0 only when
  step 7 passed. Prints "BOXID <16 hex>" (sha256 of box.key, first 16 hex, as auth/secrets.ts does)
  for doctor -ExpectBoxId. The key itself is never printed.

  -SkipAcl is for tests and -LayoutOnly installs only (no icacls, no elevation). -TestCorrupt <relative
  path> truncates that file in the target between copy and verify, to prove the failure path; it is
  accepted only together with -SkipAcl.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$From,
  [Parameter(Mandatory)][string]$DataDir,
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][string]$NodeExe,
  [Parameter(Mandatory)][string]$ServiceSid,
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [ValidateRange(0, 4194304)][int]$StopPid = 0,
  [switch]$Yes,
  [switch]$SkipAcl,
  [switch]$DryRun,
  [string]$TestCorrupt = ''
)

$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSScriptRoot 'MaxcomSetup.psm1') -Force

$script:SkipCopyRel = @('box-run.log')   # the old hand-run log: in the backup, not in the new data folder
$script:BoxStopped = $false
$script:TargetTouched = $false
$script:Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')

# ---------------------------------------------------------------------------------------------
# Helpers. $src is only ever passed to read-only helpers.
# ---------------------------------------------------------------------------------------------

function Test-AnyPath([string]$Path) {
  # True also for a broken link (Test-Path says false for those).
  try { [void][System.IO.File]::GetAttributes($Path); return $true } catch { return $false }
}

function Get-SafeTree {
  # Module helper is not exported: every entry below Dir, never descending into a reparse point. Read only.
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

function Get-FileSha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try { return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '').ToLowerInvariant() }
  finally { $fs.Dispose(); $sha.Dispose() }
}

function Get-RelPath([string]$Root, [string]$Path) {
  return $Path.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
}

function Get-TreeScan {
  <# Count and total size of the files below Root; refuses a link anywhere (the copy would not carry it). Read only. #>
  param([string]$Root, [string]$What)
  $count = 0
  $size = [int64]0
  foreach ($e in (Get-SafeTree $Root)) {
    if ($e.IsLink) { throw "GAGAL: $What mengandungi pautan atau simpang yang tidak boleh disalin dengan selamat: $($e.Path)" }
    if ($e.IsDir) { continue }
    $count++
    $size += (New-Object System.IO.FileInfo($e.Path)).Length
  }
  return [pscustomobject]@{ Count = $count; Size = $size }
}

function Get-TreeManifest {
  <# Relative path (forward slashes), size and sha256 of every file below Root, sorted by path. Read only. #>
  param([string]$Root, [string[]]$SkipRel = @())
  $list = New-Object System.Collections.ArrayList
  foreach ($e in (Get-SafeTree $Root)) {
    if ($e.IsLink) { throw "GAGAL: pautan ditemui dalam folder: $($e.Path)" }
    if ($e.IsDir) { continue }
    $rel = Get-RelPath $Root $e.Path
    if ($SkipRel -contains $rel) { continue }
    [void]$list.Add([pscustomobject]@{
        path = $rel
        size = (New-Object System.IO.FileInfo($e.Path)).Length
        sha256 = (Get-FileSha256 $e.Path)
      })
  }
  $sorted = @($list.ToArray() | Sort-Object -Property path)
  return $sorted
}

function Compare-ToManifest {
  <# Problems when the files below Root do not match Expected (source manifest). Extra files are not a problem here. #>
  param([string]$Root, $Expected, [string[]]$SkipRel = @())
  $probs = New-Object System.Collections.ArrayList
  foreach ($m in $Expected) {
    if ($SkipRel -contains $m.path) { continue }
    $p = Join-Path $Root ($m.path.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { [void]$probs.Add("tiada: $($m.path)"); continue }
    if (([int64](New-Object System.IO.FileInfo($p)).Length) -ne [int64]$m.size) { [void]$probs.Add("saiz berbeza: $($m.path)"); continue }
    if ((Get-FileSha256 $p) -ne $m.sha256) { [void]$probs.Add("sha256 berbeza: $($m.path)") }
  }
  return @($probs.ToArray())
}

function Compare-Manifests {
  param($A, $B)
  $probs = New-Object System.Collections.ArrayList
  $index = @{}
  foreach ($b in $B) { $index[[string]$b.path] = $b }
  foreach ($a in $A) {
    if (-not $index.ContainsKey([string]$a.path)) { [void]$probs.Add("hilang: $($a.path)"); continue }
    $b = $index[[string]$a.path]
    if ($a.sha256 -ne $b.sha256 -or [int64]$a.size -ne [int64]$b.size) { [void]$probs.Add("berubah: $($a.path)") }
    $index.Remove([string]$a.path)
  }
  foreach ($k in $index.Keys) { [void]$probs.Add("baharu: $k") }
  return @($probs.ToArray())
}

function Get-BoxIdFromKey([string]$Root) {
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $Root 'secret\box.key'))
  if ($bytes.Length -ne 32) { throw 'GAGAL: secret\box.key bukan 32 bait: sumber ini bukan data kotak yang sah' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  return $hex.Substring(0, 16)
}

function Get-BoxProcesses {
  <# The listener on the port plus its mediamtx.exe / ffmpeg.exe descendants. Returns $null when nothing listens. #>
  param([int]$ListenPort)
  $owners = @(Get-PortOwner $ListenPort)
  if ($owners.Count -eq 0) { return $null }
  if ($owners.Count -gt 1) { throw "GAGAL: lebih daripada satu proses mendengar pada port $ListenPort" }
  $o = $owners[0]
  $ok = ($o.Name -ieq 'node.exe') -and ($o.CommandLine -match '(?i)\bmain\.ts\b')
  $kids = New-Object System.Collections.ArrayList
  if ($ok) {
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([int]$o.Pid)
    $seen = @{ ([int]$o.Pid) = $true }
    while ($queue.Count -gt 0) {
      $parent = [int]$queue.Dequeue()
      $parentStart = ($all | Where-Object { [int]$_.ProcessId -eq $parent } | Select-Object -First 1).CreationDate
      foreach ($c in ($all | Where-Object { [int]$_.ParentProcessId -eq $parent })) {
        $cid = [int]$c.ProcessId
        if ($seen.ContainsKey($cid)) { continue }
        # a child must be younger than its parent, else the parent id was reused
        if ($null -ne $parentStart -and $c.CreationDate -lt $parentStart) { continue }
        $seen[$cid] = $true
        $queue.Enqueue($cid)
        if ($c.Name -ieq 'mediamtx.exe' -or $c.Name -ieq 'ffmpeg.exe') {
          [void]$kids.Add([pscustomobject]@{ Pid = $cid; Name = [string]$c.Name; CommandLine = [string]$c.CommandLine })
        }
      }
    }
  }
  return [pscustomobject]@{ Owner = $o; IsBox = $ok; Children = @($kids.ToArray()) }
}

function Invoke-Robocopy {
  param([string]$Source, [string]$Dest, [string[]]$ExcludeFiles = @())
  $rc = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  $args1 = @($Source, $Dest, '/E', '/COPY:DAT', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeFiles.Count -gt 0) { $args1 += '/XF'; $args1 += $ExcludeFiles }
  & $rc @args1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "GAGAL: robocopy gagal (kod $LASTEXITCODE) semasa menyalin ke $Dest" }
}

function Set-BackupFolderAcl {
  <# The pre-install backup holds the secrets: SYSTEM and Administrators only, children inherit. #>
  param([string]$Dir)
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  $out = & $icacls $Dir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
  if ($LASTEXITCODE -ne 0) { throw "GAGAL: icacls pada folder sandaran gagal (kod $LASTEXITCODE): $($out -join ' ')" }
  $acl = Get-Acl -LiteralPath $Dir
  foreach ($ace in $acl.Access) {
    try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    if ($sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') { throw "GAGAL: folder sandaran masih ada entri $($ace.IdentityReference)" }
  }
}

function Test-DatabaseIntegrity {
  <# PRAGMA integrity_check with the bundled Node (node:sqlite, read only). True only when the answer is exactly ok. #>
  param([string]$Node, [string]$Db)
  $code = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.MAXCOM_CHECK_DB,{readOnly:true});const r=d.prepare('PRAGMA integrity_check').all();console.log(r.map(function(x){return Object.values(x)[0]}).join('|'));d.close();"
  $env:MAXCOM_CHECK_DB = $Db
  try {
    $out = @(& $Node '--no-warnings' '-e' $code)
    $exit = $LASTEXITCODE
  } finally {
    $env:MAXCOM_CHECK_DB = $null
  }
  if ($exit -ne 0) { throw "GAGAL: semakan integriti pangkalan data tidak dapat dijalankan (Node kod $exit)" }
  return (($out -join '|').Trim() -ceq 'ok')
}

function Wait-DatabaseQuiet {
  <# Port closed and surau.db / -wal / -shm unchanged for 3 seconds (30 s at most). #>
  param([string]$SourceDir, [int]$ListenPort)
  $names = @('surau.db', 'surau.db-wal', 'surau.db-shm')
  $deadline = (Get-Date).AddSeconds(30)
  $last = ''
  $stableSince = $null
  while ((Get-Date) -lt $deadline) {
    $portOpen = (@(Get-PortOwner $ListenPort).Count -gt 0)
    $sig = ($names | ForEach-Object {
        $p = Join-Path $SourceDir $_
        if (Test-Path -LiteralPath $p -PathType Leaf) { $f = New-Object System.IO.FileInfo($p); "$($f.Length):$($f.LastWriteTimeUtc.Ticks)" } else { 'none' }
      }) -join '|'
    if (-not $portOpen -and $sig -eq $last) {
      if ($null -eq $stableSince) { $stableSince = Get-Date }
      if (((Get-Date) - $stableSince).TotalSeconds -ge 3) { return }
    } else {
      $stableSince = $null
    }
    $last = $sig
    Start-Sleep -Milliseconds 500
  }
  throw 'GAGAL: pangkalan data sumber masih berubah atau port masih dibuka selepas 30 saat'
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

try {
  # ---- 1. Check (changes nothing) -----------------------------------------------------------
  if ($TestCorrupt -ne '' -and -not $SkipAcl) { throw 'GAGAL: -TestCorrupt hanya dibenarkan bersama -SkipAcl (untuk ujian)' }
  if ($TestCorrupt -ne '' -and ($TestCorrupt -match '(^|[\\/])\.\.([\\/]|$)' -or $TestCorrupt -match '^[A-Za-z]:' -or $TestCorrupt.StartsWith('\') -or $TestCorrupt.StartsWith('/'))) {
    throw 'GAGAL: -TestCorrupt mesti laluan relatif di dalam folder data'
  }
  if ($ServiceSid -notmatch '^S-1-\d+(-\d+)+$') { throw "GAGAL: SID akaun perkhidmatan tidak sah: $ServiceSid" }
  $src = ConvertTo-FullPath $From
  $dst = ConvertTo-FullPath $DataDir
  $bak = ConvertTo-FullPath $BackupRoot
  $node = ConvertTo-FullPath $NodeExe
  foreach ($pair in @(@('-From', $src), @('-DataDir', $dst), @('-BackupRoot', $bak))) {
    if ($pair[1] -notmatch '^[A-Za-z]:\\.') { throw "GAGAL: $($pair[0]) mesti berada di pemacu bernama (bukan akar pemacu atau UNC): $($pair[1])" }
    if ($pair[1] -match '["]') { throw "GAGAL: $($pair[0]) mengandungi aksara yang tidak dibenarkan" }
  }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "GAGAL: node.exe tiada: $node" }
  if (-not (Test-Path -LiteralPath $src -PathType Container)) { throw "GAGAL: folder sumber tiada: $src" }
  if (Test-IsReparsePoint $src) { throw "GAGAL: folder sumber ialah pautan, bukan folder sebenar: $src" }
  if (-not (Test-Path -LiteralPath (Join-Path $src 'surau.db') -PathType Leaf)) { throw "GAGAL: sumber tiada surau.db: $src" }
  if (-not (Test-Path -LiteralPath (Join-Path $src 'secret\box.key') -PathType Leaf)) { throw "GAGAL: sumber tiada secret\box.key: $src" }
  foreach ($pair in @(@($src, $dst), @($src, $bak), @($dst, $bak))) {
    if ((Test-PathInside $pair[0] $pair[1] -AllowEqual) -or (Test-PathInside $pair[1] $pair[0] -AllowEqual)) {
      throw "GAGAL: folder tidak boleh sama atau berada di dalam satu sama lain: $($pair[0]) dan $($pair[1])"
    }
  }
  if (Test-AnyPath $dst) {
    if (-not (Test-Path -LiteralPath $dst -PathType Container) -or (Test-IsReparsePoint $dst)) { throw "GAGAL: folder data sasaran bukan folder sebenar: $dst" }
    foreach ($n in @('surau.db', 'surau.db-wal', 'surau.db-shm')) {
      if (Test-AnyPath (Join-Path $dst $n)) { throw "GAGAL: folder data sasaran sudah ada $n; penghijrahan kedua tidak dibuat senyap-senyap. Tiada apa yang diubah." }
    }
    foreach ($top in [System.IO.Directory]::GetFileSystemEntries($src)) {
      $leaf = [System.IO.Path]::GetFileName($top)
      if ($script:SkipCopyRel -contains $leaf) { continue }
      if (Test-AnyPath (Join-Path $dst $leaf)) { throw "GAGAL: folder data sasaran sudah ada '$leaf' yang bertindih dengan sumber. Tiada apa yang diubah." }
    }
  }
  $scan = Get-TreeScan $src 'folder sumber'
  $need = 2 * $scan.Size + 1GB
  $dstDrive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($dst))
  $bakDrive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($bak))
  if ($dstDrive.Name -eq $bakDrive.Name) {
    if ($dstDrive.AvailableFreeSpace -lt $need) { throw "GAGAL: ruang kosong pemacu $($dstDrive.Name) tidak cukup (perlukan sekurang-kurangnya $([math]::Ceiling($need / 1MB)) MB)" }
  } else {
    if ($dstDrive.AvailableFreeSpace -lt ($scan.Size + 1GB)) { throw "GAGAL: ruang kosong pemacu $($dstDrive.Name) tidak cukup" }
    if ($bakDrive.AvailableFreeSpace -lt ($scan.Size + 1GB)) { throw "GAGAL: ruang kosong pemacu $($bakDrive.Name) tidak cukup" }
  }
  if (-not $SkipAcl -and -not $DryRun -and -not (Test-MaxcomElevated)) { throw 'GAGAL: perlukan Run as administrator untuk menetapkan kebenaran folder data' }
  $boxId = Get-BoxIdFromKey $src
  Write-Host "OK semakan sumber: $($scan.Count) fail, $([math]::Ceiling($scan.Size / 1MB)) MB, kotak $boxId"

  # ---- 2. Find the running box --------------------------------------------------------------
  $running = Get-BoxProcesses $Port
  if ($null -eq $running) {
    Write-Host "OK port $Port tiada pendengar: kotak lama sudah dihentikan"
  } else {
    $o = $running.Owner
    Write-Host "Proses yang mendengar pada port $Port : PID $($o.Pid), $($o.Name), mula $($o.StartTime)"
    Write-Host "  arahan: $($o.CommandLine)"
    foreach ($k in $running.Children) { Write-Host "  anak: PID $($k.Pid), $($k.Name)" }
    if (-not $running.IsBox) {
      throw "GAGAL: proses pada port $Port bukan kotak MAXCOM tangan (node.exe dengan main.ts); ia TIDAK dihentikan. Hentikan atau tukar port sendiri."
    }
    if ($Yes) {
      if ($StopPid -eq 0) { throw 'GAGAL: dengan -Yes, PID proses yang akan dihentikan mesti diberi sebagai -StopPid' }
      if ($StopPid -ne [int]$o.Pid) { throw "GAGAL: -StopPid $StopPid tidak sama dengan PID pendengar port $Port ($($o.Pid)); tiada proses dihentikan" }
    } elseif (-not $DryRun) {
      $answer = Read-Host 'Henti proses ini? (y/t)'
      if ($answer -notmatch '^[yY]') { throw 'GAGAL: dibatalkan oleh pengguna; tiada apa yang diubah' }
    }
  }

  if ($DryRun) {
    Write-Host "DRYRUN henti: $(if ($null -eq $running) { 'tiada proses' } else { 'PID ' + $running.Owner.Pid })"
    Write-Host "DRYRUN sandaran: $(Join-Path $bak ('pre-install-' + $script:Stamp))"
    Write-Host "DRYRUN salin: $src -> $dst"
    Write-Host 'DRYRUN semak: sha256 setiap fail, PRAGMA integrity_check, sumber tidak berubah'
    Write-Host "BOXID $boxId"
    Write-Host 'Mod DRYRUN: tiada apa yang diubah.'
    exit 0
  }

  # ---- 3. Stop those PIDs only --------------------------------------------------------------
  if ($null -ne $running) {
    $ids = @($running.Owner.Pid) + @($running.Children | ForEach-Object { $_.Pid })
    foreach ($procId in $ids) {
      Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
    }
    $script:BoxStopped = $true
    $gone = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $gone) {
      $alive = @($ids | Where-Object { $null -ne (Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue) })
      if ($alive.Count -eq 0) { break }
      Start-Sleep -Milliseconds 300
    }
    $alive = @($ids | Where-Object { $null -ne (Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue) })
    if ($alive.Count -gt 0) { throw "GAGAL: proses belum berhenti: $($alive -join ', ')" }
    Write-Host "SET henti kotak lama: PID $($ids -join ', ')"
  }
  Wait-DatabaseQuiet $src $Port

  # ---- 4. Record the source -----------------------------------------------------------------
  $backupDir = Join-Path $bak ('pre-install-' + $script:Stamp)
  if (Test-AnyPath $backupDir) { throw "GAGAL: folder sandaran sudah wujud: $backupDir" }
  $manifest1 = @(Get-TreeManifest $src)
  [void][System.IO.Directory]::CreateDirectory($backupDir)
  if (-not $SkipAcl) { Set-BackupFolderAcl $backupDir }
  $json = [ordered]@{ v = 1; source = $src; takenAt = (Get-Date).ToUniversalTime().ToString('o'); boxId = $boxId; files = $manifest1 } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $backupDir 'source-manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "SET rekod sumber: $($manifest1.Count) fail dalam source-manifest.json"

  # ---- 5. Back up ---------------------------------------------------------------------------
  $backupData = Join-Path $backupDir 'data'
  [void][System.IO.Directory]::CreateDirectory($backupData)
  Invoke-Robocopy $src $backupData
  Write-Host "SET sandaran: $backupData"

  # ---- 6. Copy into the new data folder, then the ACL ---------------------------------------
  $script:TargetTouched = $true
  [void][System.IO.Directory]::CreateDirectory($dst)
  if (-not $SkipAcl) { [void](Set-MaxcomDataAcl $dst -ServiceSid $ServiceSid) }
  $skipFull = @($script:SkipCopyRel | ForEach-Object { Join-Path $src ($_.Replace('/', '\')) })
  Invoke-Robocopy $src $dst $skipFull
  Write-Host "SET salin: $dst"
  if ($TestCorrupt -ne '') {
    $victim = Join-Path $dst ($TestCorrupt.Replace('/', '\'))
    $fs = [System.IO.File]::Open($victim, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $fs.SetLength([math]::Max(0, [int64]($fs.Length / 2) - 1)) } finally { $fs.Dispose() }
  }
  if (-not $SkipAcl) { [void](Set-MaxcomDataAcl $dst -ServiceSid $ServiceSid) }

  # ---- 7. Verify ----------------------------------------------------------------------------
  $probs = @(Compare-ToManifest $dst $manifest1 $script:SkipCopyRel)
  if ($probs.Count -gt 0) { throw ("GAGAL: salinan tidak sama dengan sumber: " + (($probs | Select-Object -First 5) -join '; ')) }
  $probs = @(Compare-ToManifest $backupData $manifest1)
  if ($probs.Count -gt 0) { throw ("GAGAL: sandaran tidak sama dengan sumber: " + (($probs | Select-Object -First 5) -join '; ')) }
  # SQLite rewrites surau.db-shm even for a read-only open, which would change the target after its hashes
  # were verified. So the check runs on a scratch copy of the verified database files inside the
  # (administrators only) backup folder; the scratch folder is removed afterwards.
  $scratch = Join-Path $backupDir 'integrity-check'
  [void][System.IO.Directory]::CreateDirectory($scratch)
  try {
    foreach ($n in @('surau.db', 'surau.db-wal')) {
      $from1 = Join-Path $dst $n
      if (Test-Path -LiteralPath $from1 -PathType Leaf) { [System.IO.File]::Copy($from1, (Join-Path $scratch $n), $false) }
    }
    $integrityOk = Test-DatabaseIntegrity $node (Join-Path $scratch 'surau.db')
  } finally {
    if (-not (Test-IsReparsePoint $scratch)) { [System.IO.Directory]::Delete($scratch, $true) }
  }
  if (-not $integrityOk) { throw 'GAGAL: PRAGMA integrity_check pada surau.db yang disalin tidak menjawab ok' }
  $manifest2 = @(Get-TreeManifest $src)
  $probs = @(Compare-Manifests $manifest1 $manifest2)
  if ($probs.Count -gt 0) { throw ("GAGAL: folder sumber berubah semasa penghijrahan: " + (($probs | Select-Object -First 5) -join '; ')) }
  $probs = @(Compare-ToManifest $dst $manifest1 $script:SkipCopyRel)
  if ($probs.Count -gt 0) { throw ("GAGAL: salinan berubah semasa semakan: " + (($probs | Select-Object -First 5) -join '; ')) }
  Write-Host "OK semakan: $($manifest1.Count) fail sama (sha256), integrity_check ok, folder sumber tidak berubah"

  Write-Host "BOXID $boxId"
  Write-Host 'Penghijrahan data selesai.'
  Write-Host "Sandaran sebelum pemasangan: $backupDir"
  Write-Host 'PENTING: jangan hidupkan kotak lama lagi selagi kotak yang dipasang berjalan (kunci penyelarasan yang sama di dua tempat kelihatan seperti kotak yang disalin).'
  Write-Host 'Pemboleh ubah persekitaran yang digunakan kotak lama TIDAK dibawa (ia tiada dalam folder data): beri kepada pemasangan (-CloudUrl) atau edit box-config.json.'
  exit 0
} catch {
  $msg = $_.Exception.Message
  if ($msg -notmatch '^GAGAL') { $msg = "GAGAL: $msg" }
  Write-Host $msg
  if ($script:TargetTouched -and (Test-AnyPath $dst)) {
    try {
      $failed = Join-Path (Split-Path -Parent $dst) ('data.failed-' + $script:Stamp)
      [System.IO.Directory]::Move($dst, $failed)
      Write-Host "Folder data sasaran dinamakan semula: $failed"
    } catch {
      Write-Host "GAGAL: folder data sasaran tidak dapat dinamakan semula: $($_.Exception.Message)"
    }
  }
  Write-Host 'Folder sumber tidak diubah. Kotak lama boleh dihidupkan dengan tangan seperti biasa.'
  if ($script:BoxStopped) { Write-Host 'Kotak lama sudah dihentikan oleh skrip ini.' }
  exit 1
}
