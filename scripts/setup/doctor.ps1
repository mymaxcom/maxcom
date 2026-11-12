<#
.SYNOPSIS
  Semak MAXCOM: read-only health check of an installed MAXCOM box on Windows.
  Windows PowerShell 5.1, built-ins only, ASCII only. It never changes anything and never prints a secret.

.DESCRIPTION
  One line per check: "OK <id> <text>", "GAGAL: <id>: <text>" or "LANGKAU <id>: <text>".
  Exit code 0 only when every check that could run passed.
  Checks that need an administrator window (tasks, the box account, the folder rights, the log lines) say
  "LANGKAU: perlukan Run as administrator" when the window is not elevated.

  Check ids: health_http, health_https, release, cert_days, fw_webrtc, fw_srt, fw_https, tools, task_box,
  task_renew, task_firewall, task_kiosk, box_account, acl_data, acl_root, disk, log_warnings, box_id.

.PARAMETER InstallRoot        Install root (default: the folder above this script when it lives in bin, else C:\Program Files\MAXCOM).
.PARAMETER Wait               Seconds to keep retrying the two health checks (the box may still be starting).
.PARAMETER Json               Print one JSON object { ok, checks: [{ id, state, text }] } and nothing else.
.PARAMETER ExpectBoxId        16 hex: the box id must equal sha256(secret\box.key), first 16 hex (checked after a migration).
.PARAMETER SkipSystemChecks   Skip everything that needs the complete install (HTTPS, certificate, firewall, tools,
                              tasks, rights, disk, logs). For tests and a layout-only install.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [ValidateRange(0, 3600)][int]$Wait = 0,
  [switch]$Json,
  [ValidatePattern('^[0-9a-f]{16}$')][string]$ExpectBoxId = '',
  [switch]$SkipSystemChecks
)

$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSScriptRoot 'MaxcomSetup.psm1') -Global -Force -DisableNameChecking

$script:Checks = New-Object System.Collections.ArrayList
$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'
$script:SidService = 'S-1-5-19'

function Add-Check([string]$Id, [string]$State, [string]$Text) {
  [void]$script:Checks.Add([pscustomobject]@{ id = $Id; state = $State; text = $Text })
}

function Test-Run([string]$Id, [scriptblock]$Body) {
  # A check that throws is a failed check, never a crash of the whole run.
  try { & $Body }
  catch { Add-Check $Id 'fail' ("semakan tidak dapat dijalankan: " + $_.Exception.Message) }
}

function ConvertTo-SidText([string]$Name) {
  if ($Name -match '^S-1-') { return $Name }
  try { return ([System.Security.Principal.NTAccount]$Name).Translate([System.Security.Principal.SecurityIdentifier]).Value }
  catch { return '' }
}

function Hide-Secrets([string]$Line) {
  $t = $Line -replace '(?i)(pass|passwd|password|token|secret|key|pin|cookie|authorization)(\w*)\s*[=:]\s*\S+', '$1$2=***'
  if ($t.Length -gt 200) { $t = $t.Substring(0, 200) + '...' }
  return $t
}

function Get-Json([string]$Url, [int]$WaitSeconds) {
  # GET with the default certificate validation (no override: the root must be trusted by Windows).
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $err = ''
  while ($true) {
    try {
      $req = [System.Net.HttpWebRequest]::Create($Url)
      $req.Method = 'GET'
      $req.Timeout = 4000
      $req.ReadWriteTimeout = 4000
      $req.Proxy = $null
      $req.AllowAutoRedirect = $false
      $resp = $req.GetResponse()
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        try { $body = $sr.ReadToEnd() } finally { $sr.Dispose() }
      } finally { $resp.Dispose() }
      return @{ Ok = $true; Data = ($body | ConvertFrom-Json); Error = '' }
    } catch {
      $err = $_.Exception.Message
      if ($null -ne $_.Exception.InnerException) { $err = $_.Exception.InnerException.Message }
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 1
  }
  return @{ Ok = $false; Data = $null; Error = $err }
}

function Test-FirewallRule {
  # Locale neutral: the NetSecurity cmdlets and their filters, never parsed command output.
  param([string]$Name, [string]$Protocol, [int]$Port, [string]$Program = '')
  $rules = @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
  if ($rules.Count -eq 0) { return "peraturan $Name tiada" }
  if ($rules.Count -ne 1) { return "peraturan $Name mesti tepat satu (ada $($rules.Count))" }
  $r = $rules[0]
  if ([string]$r.Enabled -ne 'True') { return "peraturan $Name tidak dihidupkan" }
  if ([string]$r.Direction -ne 'Inbound') { return "peraturan $Name bukan peraturan masuk" }
  if ([string]$r.Action -ne 'Allow') { return "peraturan $Name bukan Allow" }
  # Any (0) or Domain+Private+Public (7): every profile.
  $prof = [int]$r.Profile
  if ($prof -ne 0 -and $prof -ne 7) { return "peraturan $Name tidak meliputi semua profil rangkaian" }
  $pf = @($r | Get-NetFirewallPortFilter)
  if ($pf.Count -ne 1) { return "peraturan $Name tidak mempunyai tepat satu penapis port" }
  if ([string]$pf[0].Protocol -ne $Protocol) { return "peraturan $Name bukan protokol $Protocol" }
  $lp = @($pf[0].LocalPort | ForEach-Object { [string]$_ })
  if ($lp.Count -ne 1 -or $lp[0] -ne [string]$Port) { return "peraturan $Name bukan untuk port $Port" }
  $af = @($r | Get-NetFirewallAddressFilter)
  $ra = @()
  foreach ($a in $af) { $ra += @($a.RemoteAddress | ForEach-Object { [string]$_ }) }
  if ($ra.Count -ne 1 -or $ra[0] -ne 'LocalSubnet') { return "peraturan $Name tidak terhad kepada LocalSubnet" }
  if ($Program -ne '') {
    $app = @($r | Get-NetFirewallApplicationFilter)
    $prog = ''
    if ($app.Count -eq 1) { $prog = [string]$app[0].Program }
    if (-not $prog.Equals($Program, [System.StringComparison]::OrdinalIgnoreCase)) { return "peraturan $Name tidak terikat kepada $Program" }
  }
  return ''
}

function Get-TaskProblem {
  param([string]$Name, [string[]]$AllowedSids, [switch]$IgnoreLastResult)
  $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $t) { return "tugas $Name tiada" }
  if ($t.State -eq 'Disabled') { return "tugas $Name dimatikan" }
  $sid = ConvertTo-SidText ([string]$t.Principal.UserId)
  if ($AllowedSids -notcontains $sid) { return "tugas $Name berjalan sebagai $($t.Principal.UserId), bukan akaun yang dijangka" }
  if (-not $IgnoreLastResult -and $t.State -ne 'Running') {
    $info = Get-ScheduledTaskInfo -TaskName $Name
    $r = [int64]$info.LastTaskResult
    if (@(0, 267008, 267009, 267011) -notcontains $r) { return ("tugas {0}: keputusan terakhir 0x{1:X}" -f $Name, $r) }
  }
  return ''
}

# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------

$rootIn = $InstallRoot
if ($rootIn -eq '') {
  $parent = Split-Path -Parent $PSScriptRoot
  if ((Split-Path -Leaf $PSScriptRoot) -ieq 'bin' -and $parent) { $rootIn = $parent } else { $rootIn = Join-Path $env:ProgramFiles 'MAXCOM' }
}
$root = ConvertTo-FullPath $rootIn
$state = $null
try { $state = Read-InstallState $root } catch { $state = $null }
$cfg = $null
$cfgPath = Join-Path $root 'box-config.json'
if (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
  try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
}
$dataIn = ''
if ($null -ne $cfg -and $cfg.dataDir) { $dataIn = [string]$cfg.dataDir }
elseif ($null -ne $state -and $state.dataDir) { $dataIn = [string]$state.dataDir }
$P = Get-MaxcomPaths -InstallRoot $root -DataDir $dataIn

$port = 8787
$httpsPort = 8443
if ($null -ne $state -and $state.port) { $port = [int]$state.port }
if ($null -ne $state -and $state.httpsPort) { $httpsPort = [int]$state.httpsPort }
if ($null -ne $cfg -and $null -ne $cfg.env) {
  if ($cfg.env.SURAU_PORT) { $port = [int]$cfg.env.SURAU_PORT }
  if ($cfg.env.SURAU_HTTPS_PORT) { $httpsPort = [int]$cfg.env.SURAU_HTTPS_PORT }
}
$ip = ''
if ($null -ne $state -and $state.ip) { $ip = [string]$state.ip }
$kiosk = ''
if ($null -ne $state -and $state.kiosk) { $kiosk = [string]$state.kiosk }
$elevated = Test-MaxcomElevated
$skipSys = $SkipSystemChecks.IsPresent
$sysSkipText = 'dilangkau (-SkipSystemChecks)'
$adminSkipText = 'perlukan Run as administrator'

if (-not $Json -and $Wait -gt 0) { Write-Host "Menunggu kotak menjawab (paling lama $Wait saat)..." }

# ---------------------------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------------------------

Test-Run 'health_http' {
  $r = Get-Json "http://127.0.0.1:$port/api/health" $Wait
  if ($r.Ok -and $r.Data.ok -eq $true) { Add-Check 'health_http' 'ok' ("kotak menjawab di http://127.0.0.1:$port/ (versi $($r.Data.version))") }
  elseif ($r.Ok) { Add-Check 'health_http' 'fail' "kotak menjawab di port $port tetapi tidak melaporkan ok" }
  else { Add-Check 'health_http' 'fail' ("kotak tidak menjawab di http://127.0.0.1:$port/ : " + $r.Error) }
}

if ($skipSys) { Add-Check 'health_https' 'skip' $sysSkipText }
else {
  Test-Run 'health_https' {
    if ($ip -eq '') { Add-Check 'health_https' 'fail' 'alamat kotak tiada dalam state\install.json'; return }
    $r = Get-Json "https://${ip}:$httpsPort/api/health" $Wait
    if ($r.Ok -and $r.Data.ok -eq $true) { Add-Check 'health_https' 'ok' ("kotak menjawab di https://${ip}:$httpsPort/ dengan sijil yang dipercayai Windows") }
    elseif ($r.Ok) { Add-Check 'health_https' 'fail' "kotak menjawab di port $httpsPort tetapi tidak melaporkan ok" }
    else { Add-Check 'health_https' 'fail' ("https://${ip}:$httpsPort/ gagal (sijil akar belum dipercayai atau kotak tidak menjawab): " + $r.Error) }
  }
}

Test-Run 'release' {
  if (-not (Test-IsReparsePoint $P.Current)) { Add-Check 'release' 'fail' "folder current bukan pautan atau tiada: $($P.Current)"; return }
  $rj = Join-Path $P.Current 'release.json'
  if (-not (Test-Path -LiteralPath $rj -PathType Leaf)) { Add-Check 'release' 'fail' 'current\release.json tiada'; return }
  $rel = Get-Content -LiteralPath $rj -Raw -Encoding UTF8 | ConvertFrom-Json
  $ver = [string]$rel.version
  if ($ver -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Add-Check 'release' 'fail' 'versi dalam release.json tidak sah'; return }
  if (-not (Test-Path -LiteralPath (Join-Path $P.Current '.ok') -PathType Leaf)) { Add-Check 'release' 'fail' "keluaran $ver tidak lengkap (fail .ok tiada)"; return }
  Add-Check 'release' 'ok' "keluaran $ver terpasang dan lengkap"
}

if ($skipSys) { Add-Check 'cert_days' 'skip' $sysSkipText }
else {
  Test-Run 'cert_days' {
    $cer = Join-Path $P.Pki 'box-leaf.cer'
    if (-not (Test-Path -LiteralPath $cer -PathType Leaf)) { Add-Check 'cert_days' 'fail' 'pki\box-leaf.cer tiada'; return }
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cer)
    $days = [int][math]::Floor(($c.NotAfter.ToUniversalTime() - (Get-Date).ToUniversalTime()).TotalDays)
    if ($days -le 0) { Add-Check 'cert_days' 'fail' 'sijil kotak sudah tamat tempoh'; return }
    if ($days -lt 60) { Add-Check 'cert_days' 'ok' "AMARAN: sijil kotak tinggal $days hari; tugas MaxcomCertRenew akan memperbaharuinya" }
    else { Add-Check 'cert_days' 'ok' "sijil kotak tinggal $days hari" }
  }
}

if ($skipSys) {
  foreach ($id in @('fw_webrtc', 'fw_srt', 'fw_https', 'tools')) { Add-Check $id 'skip' $sysSkipText }
} else {
  Test-Run 'fw_webrtc' {
    $m = Test-FirewallRule 'MAXCOM Live WebRTC' 'UDP' 8189
    if ($m -eq '') { Add-Check 'fw_webrtc' 'ok' 'tembok api: UDP 8189 dibuka untuk subnet setempat' } else { Add-Check 'fw_webrtc' 'fail' $m }
  }
  Test-Run 'fw_srt' {
    $m = Test-FirewallRule 'MAXCOM Live SRT' 'UDP' 8890
    if ($m -eq '') { Add-Check 'fw_srt' 'ok' 'tembok api: UDP 8890 dibuka untuk subnet setempat' } else { Add-Check 'fw_srt' 'fail' $m }
  }
  Test-Run 'fw_https' {
    $m = Test-FirewallRule 'MAXCOM Box HTTPS' 'TCP' $httpsPort $P.NodeExe
    if ($m -eq '') { Add-Check 'fw_https' 'ok' "tembok api: TCP $httpsPort dibuka untuk subnet setempat" } else { Add-Check 'fw_https' 'fail' $m }
  }
  Test-Run 'tools' {
    $probs = @()
    $vf = Join-Path $P.LiveTools 'VERSIONS.md'
    foreach ($f in @('mediamtx\mediamtx.exe', 'ffmpeg\ffmpeg.exe')) {
      if (-not (Test-Path -LiteralPath (Join-Path $P.LiveTools $f) -PathType Leaf)) { $probs += "$f tiada" }
    }
    if (-not (Test-Path -LiteralPath $P.NodeExe -PathType Leaf)) { $probs += 'runtime\node\node.exe tiada' }
    $pinNote = 'versi pin tidak disemak (release-pins.json tiada)'
    if (-not (Test-Path -LiteralPath $vf -PathType Leaf)) { $probs += 'tools\live\VERSIONS.md tiada' }
    else {
      $pinsFile = $null
      foreach ($d in @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot))) {
        $c = Join-Path $d 'release-pins.json'
        if (Test-Path -LiteralPath $c -PathType Leaf) { $pinsFile = $c; break }
      }
      if ($null -ne $pinsFile) {
        $pins = Get-Content -LiteralPath $pinsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $txt = [System.IO.File]::ReadAllText($vf)
        foreach ($n in @('mediamtx', 'ffmpeg')) {
          $h = ([string]$pins.$n.sha256).ToLowerInvariant()
          if ($h -notmatch '^[0-9a-f]{64}$' -or -not $txt.Contains($h)) { $probs += "$n tidak sama dengan versi pin" }
        }
        $pinNote = 'versi sama dengan pin'
      }
    }
    if ($probs.Count -gt 0) { Add-Check 'tools' 'fail' ($probs -join '; ') }
    else { Add-Check 'tools' 'ok' "node, mediamtx dan ffmpeg ada; $pinNote" }
  }
}

$sysIds = @('task_box', 'task_renew', 'task_firewall', 'task_kiosk', 'box_account', 'acl_data', 'acl_root')
if ($skipSys) {
  foreach ($id in $sysIds) { Add-Check $id 'skip' $sysSkipText }
} elseif (-not $elevated) {
  foreach ($id in $sysIds) { Add-Check $id 'skip' $adminSkipText }
} else {
  Test-Run 'task_box' {
    $m = Get-TaskProblem 'MAXCOM Box' @($script:SidService)
    if ($m -eq '') { Add-Check 'task_box' 'ok' 'tugas MAXCOM Box ada, sebagai LOCAL SERVICE' } else { Add-Check 'task_box' 'fail' $m }
  }
  Test-Run 'task_renew' {
    $m = Get-TaskProblem 'MaxcomCertRenew' @($script:SidSystem)
    if ($m -eq '') { Add-Check 'task_renew' 'ok' 'tugas MaxcomCertRenew ada, sebagai SYSTEM' } else { Add-Check 'task_renew' 'fail' $m }
  }
  Test-Run 'task_firewall' {
    $m = Get-TaskProblem 'MAXCOM Live Firewall' @($script:SidSystem)
    if ($m -eq '' -and -not (Test-Path -LiteralPath $P.FirewallCopy -PathType Leaf)) { $m = "salinan $($P.FirewallCopy) tiada" }
    if ($m -eq '') { Add-Check 'task_firewall' 'ok' 'tugas MAXCOM Live Firewall ada, sebagai SYSTEM' } else { Add-Check 'task_firewall' 'fail' $m }
  }
  Test-Run 'task_kiosk' {
    if ($kiosk -ne 'khas') { Add-Check 'task_kiosk' 'skip' 'skrin bukan mod khas'; return }
    $want = ConvertTo-SidText ([string]$state.kioskUser)
    if ($want -eq '') { Add-Check 'task_kiosk' 'fail' 'akaun skrin dalam state tidak dapat dikenal pasti'; return }
    $m = Get-TaskProblem 'MAXCOM Kiosk' @($want) -IgnoreLastResult
    if ($m -eq '') { Add-Check 'task_kiosk' 'ok' "tugas MAXCOM Kiosk ada untuk $($state.kioskUser)" } else { Add-Check 'task_kiosk' 'fail' $m }
  }
  Test-Run 'box_account' {
    $o = @(Get-PortOwner $port | Where-Object { $_.Address -eq '127.0.0.1' -or $_.Address -eq '0.0.0.0' -or $_.Address -eq '::' })
    if ($o.Count -eq 0) { Add-Check 'box_account' 'fail' "tiada proses mendengar di port $port"; return }
    $bad = @()
    foreach ($x in $o) {
      $sid = ConvertTo-SidText ([string]$x.Owner)
      if ($sid -ne $script:SidService) { $bad += "PID $($x.Pid) ($($x.Name)) dimiliki oleh '$($x.Owner)'" }
      elseif ($x.Name -ne 'node.exe' -or ([string]$x.CommandLine).IndexOf($P.NodeExe, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        $bad += "PID $($x.Pid) bukan node.exe pemasangan ini"
      }
    }
    if ($bad.Count -eq 0) { Add-Check 'box_account' 'ok' 'proses kotak berjalan sebagai LOCAL SERVICE' } else { Add-Check 'box_account' 'fail' ($bad -join '; ') }
  }
  Test-Run 'acl_data' {
    if (-not (Test-Path -LiteralPath $P.DataDir -PathType Container)) { Add-Check 'acl_data' 'fail' "folder data tiada: $($P.DataDir)"; return }
    # The parent folder (%ProgramData%\MAXCOM) and backups\ matter too: a link or a user-writable parent lets a standard
    # user swap data\ for a junction.
    $probs = @()
    foreach ($x in @($P.MaxcomHome, $P.DataDir, $P.Backups, $P.HomeLogs)) {
      if ((Test-Path -LiteralPath $x) -and (Test-IsReparsePoint $x)) { $probs += "$x ialah pautan (reparse point)" }
    }
    if (Test-Path -LiteralPath $P.MaxcomHome -PathType Container) {
      $hw = @(Get-UntrustedWriters $P.MaxcomHome)
      if ($hw.Count -gt 0) { $probs += "folder induk $($P.MaxcomHome) boleh ditulis oleh: $($hw -join ', ')" }
    }
    # data is protected; secret and pki carry exactly the contract; everything below inherits (module).
    $probs += @(Get-MaxcomDataAclProblem $P.DataDir -ServiceSid $script:SidService)
    if ($probs.Count -eq 0) { Add-Check 'acl_data' 'ok' 'folder data hanya untuk SYSTEM, Administrators dan akaun kotak' }
    else { Add-Check 'acl_data' 'fail' ((($probs | Select-Object -First 3) -join '; ') + $(if ($probs.Count -gt 3) { "; dan $($probs.Count - 3) lagi" } else { '' })) }
  }
  Test-Run 'acl_root' {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { Add-Check 'acl_root' 'fail' "folder pemasangan tiada: $root"; return }
    $w = @()
    foreach ($p in @($root, $P.Bin, $P.Releases, $P.Runtime, $P.State, $P.Launcher, $P.StartCmd, $P.BoxConfig)) {
      if (Test-Path -LiteralPath $p) { $w += @(Get-UntrustedWriters $p) }
    }
    $w = @($w | Select-Object -Unique)
    if ($w.Count -eq 0) { Add-Check 'acl_root' 'ok' 'folder pemasangan hanya boleh ditulis oleh SYSTEM dan Administrators' }
    else { Add-Check 'acl_root' 'fail' ('boleh menulis ke folder pemasangan: ' + (($w | Select-Object -First 4) -join ', ')) }
  }
}

if ($skipSys) { Add-Check 'disk' 'skip' $sysSkipText }
else {
  Test-Run 'disk' {
    $drives = @()
    foreach ($p in @($root, $P.DataDir)) {
      $r = [System.IO.Path]::GetPathRoot($p)
      if ($r -and $drives -notcontains $r) { $drives += $r }
    }
    $low = @()
    $minFree = 2GB
    foreach ($d in $drives) {
      $di = New-Object System.IO.DriveInfo($d)
      if ($di.AvailableFreeSpace -lt $minFree) { $low += ("{0} tinggal {1:N1} GB" -f $d, ($di.AvailableFreeSpace / 1GB)) }
    }
    if ($low.Count -eq 0) { Add-Check 'disk' 'ok' 'ruang kosong lebih daripada 2 GB' } else { Add-Check 'disk' 'fail' ($low -join '; ') }
  }
}

if ($skipSys) { Add-Check 'log_warnings' 'skip' $sysSkipText }
elseif (-not $elevated) { Add-Check 'log_warnings' 'skip' $adminSkipText }
else {
  Test-Run 'log_warnings' {
    if (-not (Test-Path -LiteralPath $P.BoxLog -PathType Leaf)) { Add-Check 'log_warnings' 'ok' 'logs\box.log belum ada'; return }
    $hits = @(Get-Content -LiteralPath $P.BoxLog -Tail 2000 -Encoding UTF8 | Where-Object { $_ -match 'WARNING|failed' } | Select-Object -Last 5)
    if ($hits.Count -eq 0) { Add-Check 'log_warnings' 'ok' 'tiada baris WARNING atau failed dalam log kotak'; return }
    $lines = @($hits | ForEach-Object { Hide-Secrets ([string]$_) })
    Add-Check 'log_warnings' 'ok' ("AMARAN: $($hits.Count) baris terakhir dalam log kotak: " + ($lines -join ' | '))
  }
}

if ($ExpectBoxId -eq '') { Add-Check 'box_id' 'skip' 'tiada -ExpectBoxId' }
else {
  Test-Run 'box_id' {
    $kf = Join-Path $P.Secret 'box.key'
    if (-not (Test-Path -LiteralPath $kf -PathType Leaf)) { Add-Check 'box_id' 'fail' 'secret\box.key tiada'; return }
    $bytes = $null
    try { $bytes = [System.IO.File]::ReadAllBytes($kf) }
    catch [System.UnauthorizedAccessException] { Add-Check 'box_id' 'skip' $adminSkipText; return }
    if ($bytes.Length -ne 32) { Add-Check 'box_id' 'fail' 'secret\box.key bukan 32 bait'; return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
    $id = $h.Substring(0, 16)
    if ($id -eq $ExpectBoxId) { Add-Check 'box_id' 'ok' "id kotak $id sama dengan yang dijangka" }
    else { Add-Check 'box_id' 'fail' "id kotak $id tidak sama dengan $ExpectBoxId" }
  }
}

# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------

$failed = @($script:Checks | Where-Object { $_.state -eq 'fail' })
$allOk = ($failed.Count -eq 0)

if ($Json) {
  $obj = [ordered]@{ ok = $allOk; checks = @($script:Checks.ToArray()) }
  Write-Output (ConvertTo-Json -InputObject $obj -Depth 4 -Compress)
} else {
  foreach ($c in $script:Checks) {
    switch ($c.state) {
      'ok' { Write-Host "OK $($c.id) $($c.text)" }
      'fail' { Write-Host "GAGAL: $($c.id): $($c.text)" }
      default { Write-Host "LANGKAU $($c.id): $($c.text)" }
    }
  }
  if ($allOk) { Write-Host 'Semak MAXCOM: semua semakan yang dijalankan lulus.' }
  else { Write-Host "Semak MAXCOM: $($failed.Count) semakan gagal. Baca baris GAGAL di atas." }
}
if ($allOk) { exit 0 } else { exit 1 }
