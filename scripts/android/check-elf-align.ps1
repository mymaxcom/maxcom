<#
.SYNOPSIS
  Google Play 16 KB page check: every arm64-v8a (and x86_64) .so must have every PT_LOAD p_align >= 16384.
.DESCRIPTION
  check-elf-align.ps1 -Path <file.aab|file.apk|file.so|directory> [-Abi arm64-v8a]
  A zip (.aab/.apk) is read in memory: only entries under lib/<abi>/ or <module>/lib/<abi>/ are parsed.
  A directory is searched for .so files. The ELF program headers are parsed here (ELF64 little endian), nothing is run.
  Prints one PASS/FAIL line per library with the smallest LOAD p_align, then exits 1 when any library fails or when no
  library of the ABI was found. -LoadFunctionsOnly defines Get-ElfLoadAligns and Test-ElfPageAlign and returns.
#>
param(
  [string]$Path = '',
  [string]$Abi = 'arm64-v8a',
  [switch]$LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
$PageSize = 16384

# Returns the p_align of every PT_LOAD segment of an ELF image, or throws a message for a file that is not ELF64 LE.
function Get-ElfLoadAligns {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  if ($Bytes.Length -lt 64 -or $Bytes[0] -ne 0x7f -or $Bytes[1] -ne 0x45 -or $Bytes[2] -ne 0x4c -or $Bytes[3] -ne 0x46) { throw 'bukan fail ELF' }
  if ($Bytes[4] -ne 2 -or $Bytes[5] -ne 1) { throw 'bukan ELF64 little endian' }
  $phoff = [BitConverter]::ToUInt64($Bytes, 32)
  $phentsize = [BitConverter]::ToUInt16($Bytes, 54)
  $phnum = [BitConverter]::ToUInt16($Bytes, 56)
  if ($phentsize -lt 56 -or $phoff + [uint64]$phentsize * $phnum -gt [uint64]$Bytes.Length) { throw 'jadual program header tidak sah' }
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $phnum; $i++) {
    $o = [int]($phoff + [uint64]$i * $phentsize)
    if ([BitConverter]::ToUInt32($Bytes, $o) -eq 1) { [void]$out.Add([BitConverter]::ToUInt64($Bytes, $o + 48)) }
  }
  return $out.ToArray()
}

# Returns the failing entries as strings; $Rows gets one object per library (Name, Align, Pass).
function Test-ElfPageAlign {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][byte[]]$Bytes)
  try { $al = @(Get-ElfLoadAligns -Bytes $Bytes) } catch { return [pscustomobject]@{ Name = $Name; Align = 0; Pass = $false; Note = $_.Exception.Message } }
  if ($al.Count -eq 0) { return [pscustomobject]@{ Name = $Name; Align = 0; Pass = $false; Note = 'tiada segmen LOAD' } }
  $min = [uint64]::MaxValue
  foreach ($v in $al) { if ([uint64]$v -lt $min) { $min = [uint64]$v } }
  return [pscustomobject]@{ Name = $Name; Align = $min; Pass = ($min -ge 16384); Note = '' }
}

if ($LoadFunctionsOnly) { return }
if ($Path -eq '' -or -not (Test-Path -LiteralPath $Path)) { Write-Host "GAGAL: -Path tiada: $Path"; exit 1 }

$rows = New-Object System.Collections.ArrayList
$item = Get-Item -LiteralPath $Path
if ($item.PSIsContainer) {
  foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File -Filter '*.so') { [void]$rows.Add((Test-ElfPageAlign -Name $f.FullName -Bytes ([System.IO.File]::ReadAllBytes($f.FullName)))) }
} elseif ($item.Extension -in @('.aab', '.apk', '.zip')) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($item.FullName)
  try {
    foreach ($e in $zip.Entries) {
      if ($e.FullName -notmatch ('(^|/)lib/' + [regex]::Escape($Abi) + '/[^/]+\.so$')) { continue }
      $ms = New-Object System.IO.MemoryStream
      $s = $e.Open()
      try { $s.CopyTo($ms) } finally { $s.Dispose() }
      [void]$rows.Add((Test-ElfPageAlign -Name $e.FullName -Bytes $ms.ToArray()))
      $ms.Dispose()
    }
  } finally { $zip.Dispose() }
} else {
  [void]$rows.Add((Test-ElfPageAlign -Name $item.FullName -Bytes ([System.IO.File]::ReadAllBytes($item.FullName))))
}

$bad = 0
foreach ($r in $rows) {
  $st = if ($r.Pass) { 'PASS' } else { 'FAIL'; $bad++ }
  Write-Host ("{0} p_align=0x{1:x} {2} {3}" -f $st, $r.Align, $r.Name, $r.Note)
}
if ($rows.Count -eq 0) { Write-Host "GAGAL: tiada perpustakaan $Abi dijumpai dalam $Path"; exit 1 }
if ($bad -gt 0) { Write-Host "GAGAL: $bad perpustakaan $Abi tidak menyokong halaman 16 KB (p_align < 0x$($PageSize.ToString('x')))"; exit 1 }
Write-Host "OK: $($rows.Count) perpustakaan $Abi, semua LOAD p_align >= 0x$($PageSize.ToString('x'))"
exit 0
