<#
.SYNOPSIS
  A MAXCOM box that follows another box (a follower) leaves the surau by itself, when its main box is gone.
  Windows PowerShell 5.1, built-ins only. Run it as Administrator, on the PC that runs the box.

.DESCRIPTION
  The box offers two routes on its own loopback address only: "revert" (go back to the data it had before it was
  linked, asks the recovery code of that data) and "empty" (a follower that was a new box: back to first setup).
  Both need a per-start secret, so no other program on this PC can empty the box. The Android shell holds that secret
  itself. On Windows the box service makes a fresh one at every start and writes it to
      <DataDir>\secret\leave-secret
  A folder with the installed ACL contract (SYSTEM, Administrators and the box account only), so only an
  Administrator can read it. This script reads it and calls the loopback route; it never prints the secret and never
  prints the recovery code.

  Run it with no switch to go back to the data from before the link (it asks the recovery code of that data), or with
  -Empty for a box that was new when it was linked (it asks you to type YA to confirm). The box then restarts by itself.

.PARAMETER Empty        Empty the box and return to first setup (no recovery code; only for a box that had no data).
.PARAMETER InstallRoot  The MAXCOM install folder (default C:\Program Files\MAXCOM); box-config.json there names the data folder and port.
.PARAMETER DataDir      Data folder, when it is not the one in box-config.json (default C:\ProgramData\MAXCOM\data).
.PARAMETER Port         The HTTP port of the box (default: box-config.json, else 8787).
#>
[CmdletBinding()]
param(
  [switch]$Empty,
  [string]$InstallRoot = '',
  [string]$DataDir = '',
  [ValidateRange(0, 65535)][int]$Port = 0
)

$ErrorActionPreference = 'Stop'

function Stop-Leave([string]$Message, [int]$Code = 1) {
  [Console]::Error.WriteLine("GAGAL: $Message")
  exit $Code
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Stop-Leave 'jalankan skrip ini sebagai Administrator (Run as administrator).' 2 }

if ($InstallRoot -eq '') { $InstallRoot = Join-Path $env:ProgramFiles 'MAXCOM' }
$cfgPath = Join-Path $InstallRoot 'box-config.json'
$cfg = $null
if (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
  try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
}
if ($DataDir -eq '') {
  if ($null -ne $cfg -and $cfg.dataDir) { $DataDir = [string]$cfg.dataDir }
  else { $DataDir = Join-Path (Join-Path $env:ProgramData 'MAXCOM') 'data' }
}
if ($Port -eq 0) {
  $Port = 8787
  if ($null -ne $cfg -and $null -ne $cfg.env -and $cfg.env.SURAU_PORT) { $Port = [int]$cfg.env.SURAU_PORT }
}

# ---- read the secret: the file itself, not a link, small, read once from an open handle ----
function Test-IsLink([string]$Path) {
  try { return ((([int][System.IO.File]::GetAttributes($Path)) -band 0x400) -ne 0) } catch { return $false }
}
$secretDir = Join-Path $DataDir 'secret'
$secretFile = Join-Path $secretDir 'leave-secret'
if ((Test-IsLink $DataDir) -or (Test-IsLink $secretDir) -or (Test-IsLink $secretFile)) { Stop-Leave 'folder data atau secret ialah pautan (reparse point); tiada apa dilakukan.' }
if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
  Stop-Leave 'rahsia keluar tiada. MAXCOM mesti sedang berjalan dan menjadi pengikut; mulakan semula MAXCOM dan cuba lagi.'
}
$secret = ''
$fs = $null
try {
  $fs = New-Object System.IO.FileStream($secretFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  if ($fs.Length -gt 128) { Stop-Leave 'fail rahsia keluar tidak sah (terlalu besar).' }
  $buf = New-Object byte[] ([int]$fs.Length)
  $got = 0
  while ($got -lt $buf.Length) {
    $n = $fs.Read($buf, $got, $buf.Length - $got)
    if ($n -le 0) { break }
    $got += $n
  }
  $secret = ([System.Text.Encoding]::ASCII.GetString($buf, 0, $got)).Trim()
} finally { if ($null -ne $fs) { $fs.Dispose() } }
if ($secret -cnotmatch '^[0-9a-f]{64}$') { Stop-Leave 'fail rahsia keluar tidak sah. Mulakan semula MAXCOM dan cuba lagi.' }

# ---- what to do, and the one confirmation ----
$path = '/api/follow/revert'
$bodyObj = @{}
if ($Empty) {
  $path = '/api/follow/empty'
  Write-Host 'Ini mengosongkan MAXCOM ini dan mengembalikannya ke persediaan pertama. Hanya untuk MAXCOM yang masih baharu semasa dipautkan.'
  $ans = Read-Host 'Taip YA untuk meneruskan'
  if ($ans -cne 'YA') { Write-Host 'Dibatalkan. Tiada apa diubah.'; exit 0 }
} else {
  Write-Host 'MAXCOM ini akan diputuskan dan kembali ke data sebelum dipautkan.'
  $sec = Read-Host 'Kod pemulihan data itu' -AsSecureString
  $code = (New-Object System.Net.NetworkCredential('', $sec)).Password
  if ([string]::IsNullOrWhiteSpace($code)) { Stop-Leave 'kod pemulihan kosong.' }
  $bodyObj = @{ recoveryCode = $code.Trim() }
}

# ---- call the loopback route (the box refuses any caller that is not on this PC or lacks the secret) ----
$uri = "http://127.0.0.1:$Port$path"
$json = ConvertTo-Json -InputObject $bodyObj -Compress
$status = 0
$text = ''
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -ContentType 'application/json' -Headers @{ 'X-Maxcom-Leave' = $secret } -Body $json -TimeoutSec 20
  $status = [int]$r.StatusCode
  $text = [string]$r.Content
} catch {
  $resp = $_.Exception.Response
  if ($null -eq $resp) { Stop-Leave "MAXCOM tidak menjawab di port $Port. Pastikan MAXCOM berjalan." }
  $status = [int]$resp.StatusCode
  try {
    $rd = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $rd.ReadToEnd()
    $rd.Dispose()
  } catch { $text = '' }
} finally {
  $secret = $null
  $json = $null
  $bodyObj = $null
}
$answer = $null
try { $answer = $text | ConvertFrom-Json } catch { $answer = $null }
$reply = ''
if ($null -ne $answer -and $null -ne $answer.PSObject.Properties['code']) { $reply = [string]$answer.code }

if ($status -eq 200) {
  Write-Host 'Selesai. MAXCOM akan dimulakan semula dalam beberapa saat.'
  exit 0
}
switch ($reply) {
  'wrong_code' { Stop-Leave 'kod pemulihan salah.' 3 }
  'locked' { Stop-Leave 'terlalu banyak kod salah; cuba lagi selepas satu jam.' 3 }
  'no_backup' { Stop-Leave 'tiada data sebelum dipautkan untuk dikembalikan. Gunakan -Empty jika MAXCOM ini dahulu baharu.' 3 }
  'has_backup' { Stop-Leave 'MAXCOM ini ada data sebelum dipautkan. Jalankan tanpa -Empty untuk mengembalikannya.' 3 }
  'not_found' { Stop-Leave 'MAXCOM ini bukan pengikut MAXCOM lain.' 3 }
  'not_local' { Stop-Leave 'rahsia tidak sepadan. Mulakan semula MAXCOM, kemudian jalankan skrip ini lagi.' 3 }
  default { Stop-Leave "permintaan ditolak (status $status)." 3 }
}
