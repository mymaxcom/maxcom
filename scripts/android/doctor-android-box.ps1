<#
.SYNOPSIS
  MAXCOM: read-only health check of one Android box over ADB. Windows PowerShell 5.1.
.DESCRIPTION
  Prints one line per check: OK, GAGAL (failed) or LANGKAU (could not run). Exit code 0 only when every check
  that could run passed. It changes nothing on the box (the only side effect is a short-lived local adb forward).
.PARAMETER Serial  Device serial or ip:port (required, alias -Device).
.PARAMETER Json    Print the results as JSON instead of lines.
.PARAMETER Wait    Seconds to keep re-running the checks until all pass (default 0 = once).
.PARAMETER Adb     Path of adb (default: adb on PATH). Test hook.
#>
param(
  [Parameter(Mandatory = $true)][Alias('Device')][string]$Serial,
  [switch]$Json,
  [int]$Wait = 0,
  [string]$Adb = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Pkg = 'my.maxcom.box'
$script:AdbExe = ''

function Invoke-AdbRaw([string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & $script:AdbExe @a 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  return [pscustomobject]@{ Code = $code; Text = (($out | Out-String).Trim()) }
}
function Adb-Read([string[]]$a) { return Invoke-AdbRaw (@('-s', $Serial) + $a) }

if ($Serial -notmatch '^[A-Za-z0-9._:\-]{3,64}$') { Write-Host 'GAGAL: nilai -Serial tidak sah'; exit 1 }
if ($Adb -ne '') {
  if (-not (Test-Path -LiteralPath $Adb)) { Write-Host "GAGAL: adb tiada di $Adb"; exit 1 }
  $script:AdbExe = $Adb
} else {
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { Write-Host 'GAGAL: adb tidak dijumpai pada PATH'; exit 1 }
  $script:AdbExe = $cmd.Source
}

function New-Result([string]$name, [string]$status, [string]$detail) {
  return [pscustomobject]@{ name = $name; status = $status; detail = $detail }
}

function Get-DeviceIp {
  $r = Adb-Read @('shell', 'ip', '-o', '-4', 'addr', 'show')
  $best = ''
  foreach ($line in ($r.Text -split "`n")) {
    if ($line -match '^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/') {
      $ifn = $Matches[1]; $ip = $Matches[2]
      if ($ip.StartsWith('127.')) { continue }
      if ($ifn -match '^(wlan|eth)') { return $ip }
      if ($best -eq '') { $best = $ip }
    }
  }
  return $best
}

function Get-FreeLocalPort {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop()
  return $p
}

function Get-Http([string]$url, [int]$timeoutMs) {
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs
  $resp = $req.GetResponse()
  try {
    $ms = New-Object System.IO.MemoryStream
    $resp.GetResponseStream().CopyTo($ms)
    return ,$ms.ToArray()
  } finally { $resp.Close() }
}

function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}

# Local address and port pairs of listening sockets, from ss or netstat output.
function Get-Listeners([string]$text) {
  $rows = New-Object System.Collections.ArrayList
  foreach ($line in ($text -split "`n")) {
    $proto = if ($line -match '^\s*(tcp|udp)') { $Matches[1] } else { continue }
    $m = [regex]::Match($line, '(\[[0-9a-fA-F:.]*\]|[0-9a-fA-F:.*]+):(\d+)\s')
    if ($m.Success) { [void]$rows.Add([pscustomobject]@{ proto = $proto; addr = $m.Groups[1].Value.Trim('[', ']'); port = [int]$m.Groups[2].Value }) }
  }
  return $rows
}

# The served certificate is not trusted by Windows; this callback only records the sha256 of the last chain element.
if (-not ('MaxcomCertCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public static class MaxcomCertCapture {
  public static string Root = "";
  public static RemoteCertificateValidationCallback Callback() {
    return delegate (object s, X509Certificate cert, X509Chain chain, SslPolicyErrors e) {
      try {
        X509Chain c = new X509Chain();
        c.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        c.ChainPolicy.VerificationFlags = X509VerificationFlags.AllFlags;
        c.Build(new X509Certificate2(cert));
        X509Certificate2 last = c.ChainElements[c.ChainElements.Count - 1].Certificate;
        using (SHA256 h = SHA256.Create()) {
          Root = BitConverter.ToString(h.ComputeHash(last.RawData)).Replace("-", "").ToLowerInvariant();
        }
      } catch (Exception) { }
      return true;
    };
  }
}
'@
}

function Run-Checks {
  $res = New-Object System.Collections.ArrayList

  # 1 package and version
  $pk = Adb-Read @('shell', 'dumpsys', 'package', $Pkg)
  if ($pk.Text -match 'versionName=(\S+)') {
    $vc = if ($pk.Text -match 'versionCode=(\d+)') { $Matches[1] } else { '?' }
    $pk.Text -match 'versionName=(\S+)' | Out-Null
    [void]$res.Add((New-Result 'pakej' 'OK' "dipasang, versi $($Matches[1]) (kod $vc)"))
  } else { [void]$res.Add((New-Result 'pakej' 'GAGAL' "pakej $Pkg tidak dipasang")) }

  # 2 HOME resolution
  $hm = Adb-Read @('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.HOME', '-a', 'android.intent.action.MAIN')
  $comp = ($hm.Text -split "`n" | Where-Object { $_ -match '^\S+/\S+$' } | Select-Object -Last 1)
  if ($null -eq $comp) { [void]$res.Add((New-Result 'skrin-utama' 'LANGKAU' 'resolve-activity tidak memberi jawapan')) }
  elseif ($comp -match '^my\.maxcom\.box/(\.|my\.maxcom\.box\.)KioskActivity$') { [void]$res.Add((New-Result 'skrin-utama' 'OK' 'MAX Kiosk Server ialah aplikasi utama')) }
  else { [void]$res.Add((New-Result 'skrin-utama' 'GAGAL' "aplikasi utama ialah $comp, bukan MAX Kiosk Server")) }

  # 3 foreground service
  $sv = Adb-Read @('shell', 'dumpsys', 'activity', 'services', $Pkg)
  if ($sv.Text -match 'BoxService' -and $sv.Text -match 'isForeground=true') { [void]$res.Add((New-Result 'perkhidmatan' 'OK' 'BoxService berjalan di latar depan')) }
  else { [void]$res.Add((New-Result 'perkhidmatan' 'GAGAL' 'BoxService tidak berjalan sebagai perkhidmatan latar depan')) }

  # 4 the three processes
  $ps = Adb-Read @('shell', 'ps', '-A')
  if ($ps.Code -ne 0 -or $ps.Text -eq '') { $ps = Adb-Read @('shell', 'ps') }
  if ($ps.Text -eq '') { [void]$res.Add((New-Result 'proses' 'LANGKAU' 'ps tidak memberi jawapan')) }
  else {
    $missing = @()
    foreach ($n in @($Pkg, 'libnode.so', 'libmediamtx.so')) { if ($ps.Text -notmatch ('(?m)(^|[\s/])' + [regex]::Escape($n) + '\s*$')) { $missing += $n } }
    if ($missing.Count -eq 0) { [void]$res.Add((New-Result 'proses' 'OK' 'aplikasi, node dan mediamtx berjalan')) }
    else { [void]$res.Add((New-Result 'proses' 'GAGAL' ('tiada proses: ' + ($missing -join ', ')))) }
  }

  # 5 battery exemption
  $di = Adb-Read @('shell', 'dumpsys', 'deviceidle', 'whitelist')
  if ($di.Text -match [regex]::Escape($Pkg)) { [void]$res.Add((New-Result 'bateri' 'OK' 'dikecualikan daripada penjimatan bateri')) }
  else { [void]$res.Add((New-Result 'bateri' 'GAGAL' 'tidak dalam senarai pengecualian bateri')) }

  # 6 ports
  $ss = Adb-Read @('shell', 'ss', '-ltnu')
  if ($ss.Code -ne 0 -or $ss.Text -match 'not found|inaccessible') { $ss = Adb-Read @('shell', 'netstat', '-tuln') }
  $ls = Get-Listeners $ss.Text
  if ($ls.Count -eq 0) { [void]$res.Add((New-Result 'port' 'LANGKAU' 'ss dan netstat tidak memberi jawapan')) }
  else {
    $bad = @()
    $p87 = @($ls | Where-Object { $_.proto -eq 'tcp' -and $_.port -eq 8787 })
    if ($p87.Count -eq 0) { $bad += '8787 tidak mendengar' } elseif (@($p87 | Where-Object { $_.addr -ne '127.0.0.1' }).Count -gt 0) { $bad += '8787 terbuka di luar loopback' }
    if (@($ls | Where-Object { $_.proto -eq 'tcp' -and $_.port -eq 8443 -and $_.addr -match '^(\*|0\.0\.0\.0|::|::ffff:0\.0\.0\.0)$' }).Count -eq 0) { $bad += '8443 tidak mendengar di semua alamat' }
    foreach ($up in @(8189, 8890)) {
      if (@($ls | Where-Object { $_.proto -eq 'udp' -and $_.port -eq $up -and -not $_.addr.StartsWith('127.') }).Count -eq 0) { $bad += "UDP $up tidak mendengar pada alamat LAN" }
    }
    foreach ($lp in @(9997, 8554, 8889)) {
      if (@($ls | Where-Object { $_.port -eq $lp -and $_.proto -eq 'tcp' -and $_.addr -ne '127.0.0.1' }).Count -gt 0) { $bad += "$lp terbuka di luar loopback" }
    }
    if ($bad.Count -eq 0) { [void]$res.Add((New-Result 'port' 'OK' '8787 loopback sahaja, 8443 semua alamat, UDP 8189 dan 8890 pada LAN')) }
    else { [void]$res.Add((New-Result 'port' 'GAGAL' ($bad -join '; '))) }
  }

  # 7 health through a forward, and the root certificate over the same forward
  $port = Get-FreeLocalPort
  $rootDer = $null
  $fw = Invoke-AdbRaw @('-s', $Serial, 'forward', "tcp:$port", 'tcp:8787')
  if ($fw.Code -ne 0) { [void]$res.Add((New-Result 'kesihatan' 'LANGKAU' ('adb forward gagal: ' + $fw.Text))) }
  else {
    try {
      try {
        $body = [System.Text.Encoding]::UTF8.GetString((Get-Http "http://127.0.0.1:$port/api/health" 5000))
        if ($body -match '"ok"\s*:\s*true') {
          $ver = if ($body -match '"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { '?' }
          [void]$res.Add((New-Result 'kesihatan' 'OK' "/api/health menjawab, versi $ver"))
        } else { [void]$res.Add((New-Result 'kesihatan' 'GAGAL' '/api/health menjawab tetapi bukan ok')) }
      } catch { [void]$res.Add((New-Result 'kesihatan' 'GAGAL' ('/api/health tidak menjawab: ' + $_.Exception.Message))) }
      try { $rootDer = Get-Http "http://127.0.0.1:$port/api/pki/root.cer" 5000 } catch { $rootDer = $null }
    } finally {
      [void](Invoke-AdbRaw @('-s', $Serial, 'forward', '--remove', "tcp:$port"))
    }
  }

  # 8 HTTPS from the laptop; the served chain must end in the box's own root
  $ip = Get-DeviceIp
  if ($ip -eq '') { [void]$res.Add((New-Result 'https' 'LANGKAU' 'alamat IP kotak tidak dapat dibaca')) }
  elseif ($null -eq $rootDer) { [void]$res.Add((New-Result 'https' 'LANGKAU' 'sijil akar kotak tidak dapat diambil')) }
  else {
    [MaxcomCertCapture]::Root = ''
    $prev = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = [MaxcomCertCapture]::Callback()
    try {
      [void](Get-Http "https://${ip}:8443/api/health" 6000)
      $want = Get-Sha256Hex $rootDer
      if ([MaxcomCertCapture]::Root -eq '') { [void]$res.Add((New-Result 'https' 'GAGAL' 'rantaian sijil yang dihantar tidak dapat dibaca')) }
      elseif ([MaxcomCertCapture]::Root -eq $want) { [void]$res.Add((New-Result 'https' 'OK' "https://${ip}:8443/ menjawab, akar rantaian sama dengan sijil akar kotak")) }
      else { [void]$res.Add((New-Result 'https' 'GAGAL' 'akar rantaian yang dihantar tidak sama dengan sijil akar kotak')) }
    } catch { [void]$res.Add((New-Result 'https' 'GAGAL' ("https://${ip}:8443/ tidak menjawab: " + $_.Exception.Message))) }
    finally { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $prev }
  }

  # 9 free space
  $df = Adb-Read @('shell', 'df', '-k', '/data')
  $tokens = @($df.Text -split '\s+' | Where-Object { $_ -ne '' })
  $freeKb = -1
  for ($i = 1; $i -lt $tokens.Count; $i++) { if ($tokens[$i] -match '^\d+%$' -and $tokens[$i - 1] -match '^\d+$') { $freeKb = [int64]$tokens[$i - 1]; break } }
  if ($freeKb -lt 0) { [void]$res.Add((New-Result 'ruang' 'LANGKAU' 'df tidak dapat dibaca')) }
  elseif ($freeKb -lt 524288) { [void]$res.Add((New-Result 'ruang' 'GAGAL' ("hanya {0} MB kosong pada /data" -f [math]::Floor($freeKb / 1024)))) }
  else { [void]$res.Add((New-Result 'ruang' 'OK' ("{0} MB kosong pada /data" -f [math]::Floor($freeKb / 1024)))) }

  # 10 temperature
  $tp = Adb-Read @('shell', 'cat', '/sys/class/thermal/thermal_zone*/temp')
  $temps = @($tp.Text -split "`n" | Where-Object { $_ -match '^\s*-?\d+\s*$' } | ForEach-Object { [int64]$_.Trim() })
  if ($temps.Count -eq 0) { [void]$res.Add((New-Result 'suhu' 'LANGKAU' 'suhu tidak boleh dibaca')) }
  else {
    $max = ($temps | Measure-Object -Maximum).Maximum
    $c = if ([math]::Abs($max) -ge 1000) { $max / 1000.0 } else { [double]$max }
    if ($c -ge 85) { [void]$res.Add((New-Result 'suhu' 'GAGAL' ("{0:N1} C terlalu panas" -f $c))) }
    else { [void]$res.Add((New-Result 'suhu' 'OK' ("{0:N1} C tertinggi" -f $c))) }
  }

  # 11 uptime of node
  $up = Adb-Read @('shell', 'ps', '-A', '-o', 'ETIME,NAME')
  $ln = ($up.Text -split "`n" | Where-Object { $_ -match 'libnode\.so\s*$' } | Select-Object -First 1)
  if ($null -eq $ln) { [void]$res.Add((New-Result 'masa-hidup-node' 'LANGKAU' 'masa hidup node tidak dapat dibaca')) }
  else { [void]$res.Add((New-Result 'masa-hidup-node' 'OK' ('node berjalan ' + ($ln -replace '\s*libnode\.so\s*$', '').Trim()))) }

  return $res
}

# ---- device must be listed and ready ----
$dev = Invoke-AdbRaw @('devices')
$state = ''
foreach ($line in ($dev.Text -split "`n")) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -ge 2 -and $parts[0] -ceq $Serial) { $state = $parts[1] }
}
if ($state -ne 'device') { Write-Host "GAGAL: peranti $Serial tiada atau belum sedia (keadaan: '$state')"; exit 1 }

$deadline = (Get-Date).AddSeconds([math]::Max(0, $Wait))
do {
  $results = Run-Checks
  $failed = @($results | Where-Object { $_.status -eq 'GAGAL' })
  if ($failed.Count -eq 0) { break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Seconds 5
} while ($true)

if ($Json) { ConvertTo-Json -InputObject @($results) -Depth 3 }
else { foreach ($r in $results) { Write-Host ("{0,-8} {1,-16} {2}" -f $r.status, $r.name, $r.detail) } }
if ($failed.Count -eq 0) { exit 0 } else { exit 1 }
