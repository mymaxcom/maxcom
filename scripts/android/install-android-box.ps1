<#
.SYNOPSIS
  MAXCOM: installs the MAX Kiosk Server APK on one Android box over ADB. Windows PowerShell 5.1.
.DESCRIPTION
  Every step prints one line: OK, SET, LANGKAU (skipped), AMARAN (warning, continues) or GAGAL: (stops, exit 1).
    0 adb found; the device named by -Serial is listed and authorised (never "the only device")
    1 ABI list, Android SDK (28 or later), free space on /data (1 GB or more), WebView version (warning under 91)
    2 APK for the first supported ABI, its .sha256, and the signer pin from android-pins.json
    3 adb install -r --no-incremental (an install signed by another key is reported; nothing is removed)
    4 notification permission (SDK 33 and later)
    5 battery exemption
    6 child process limit (Android 12 and later)
    7 Allwinner "background" service whitelist (only when that service exists; run as the shell user)
    8 with -SetHome: HOME is my.maxcom.box/.KioskActivity
    9 start the activity, forward a free local port to 8787, wait for health, remove the forward
   10 print the box address
   11 with -DisableNetworkAdbAfter: switch network ADB off (unproven on hardware, see the note printed)
  The script never removes or disables a package, and never asks for root. Every adb argument is an array element.
  -DryRun still reads from the device but prints, instead of running, every call that changes state.
.PARAMETER Serial   Device serial or ip:port (required, alias -Device). Must be listed by "adb devices".
.PARAMETER ApkDir   Folder with MAX-Kiosk-Server-<version>-<abi>.apk and .sha256 (default <repo>\dist\android).
.PARAMETER Version  YYYY.MM.N (default: the newest APK for the chosen ABI in ApkDir).
.PARAMETER Adb      Path of adb (default: adb on PATH). Test hook.
.PARAMETER Apksigner Path of apksigner(.bat) (default: newest build-tools under the Android SDK).
.PARAMETER DebugBuild The APK is a debug build: no signer pin is checked (LANGKAU).
.PARAMETER HealthWaitSec  Seconds to wait for health at step 9 (default 180).
#>
param(
  [Parameter(Mandatory = $true)][Alias('Device')][string]$Serial,
  [string]$ApkDir = '',
  [string]$Version = '',
  [switch]$SetHome,
  [switch]$DisableNetworkAdbAfter,
  [switch]$Yes,
  [switch]$DryRun,
  [string]$Adb = '',
  [string]$Apksigner = '',
  [switch]$DebugBuild,
  [int]$HealthWaitSec = 180
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Pkg = 'my.maxcom.box'
$HomeComponent = 'my.maxcom.box/.KioskActivity'
$script:Warnings = 0

function Say([string]$status, [int]$n, [string]$text) { Write-Host ("{0,-8} {1,2}  {2}" -f $status, $n, $text) }
function Fail([int]$n, [string]$m) { Write-Host ("GAGAL: langkah {0}: {1}" -f $n, $m); exit 1 }

# ---- adb plumbing: argument arrays only, always -s <serial> after the device check ----
$script:AdbExe = ''
function Invoke-AdbRaw([string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & $script:AdbExe @a 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  return [pscustomobject]@{ Code = $code; Text = (($out | Out-String).Trim()) }
}
# Read-only call on the chosen device.
function Adb-Read([string[]]$a) { return Invoke-AdbRaw (@('-s', $Serial) + $a) }
# Call that changes state: printed instead of run under -DryRun.
function Adb-Change([string[]]$a) {
  if ($DryRun) {
    Write-Host ('DRYRUN adb -s ' + $Serial + ' ' + ($a -join ' '))
    return [pscustomobject]@{ Code = 0; Text = ''; Dry = $true }
  }
  return Invoke-AdbRaw (@('-s', $Serial) + $a)
}
# The same with a time limit (the APK install); the job gets the argument array as an array.
function Adb-ChangeTimed([string[]]$a, [int]$seconds) {
  if ($DryRun) {
    Write-Host ('DRYRUN adb -s ' + $Serial + ' ' + ($a -join ' '))
    return [pscustomobject]@{ Code = 0; Text = ''; Dry = $true }
  }
  $job = Start-Job -ScriptBlock {
    param($exe, [string[]]$argv)
    $ErrorActionPreference = 'Continue'
    $o = & $exe @argv 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = (($o | Out-String).Trim()) }
  } -ArgumentList $script:AdbExe, (@('-s', $Serial) + $a)
  if (-not (Wait-Job $job -Timeout $seconds)) {
    Stop-Job $job; Remove-Job $job -Force
    return [pscustomobject]@{ Code = 124; Text = 'tamat masa'; TimedOut = $true }
  }
  $r = Receive-Job $job; Remove-Job $job -Force
  return $r
}

function Get-Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

function Find-Apksigner {
  if ($Apksigner -ne '') { return $Apksigner }
  $roots = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, 'C:\dev\android-sdk') | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($r in $roots) {
    $bt = Join-Path $r 'build-tools'
    if (-not (Test-Path -LiteralPath $bt)) { continue }
    $dir = Get-ChildItem -LiteralPath $bt -Directory | Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending | Select-Object -First 1
    if ($dir) {
      $f = Join-Path $dir.FullName 'apksigner.bat'
      if (Test-Path -LiteralPath $f) { return $f }
    }
  }
  return ''
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

function Test-Health([int]$port) {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/health")
    $req.Timeout = 4000; $req.ReadWriteTimeout = 4000
    $resp = $req.GetResponse()
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd()
    } finally { $resp.Close() }
    return ($body -match '"ok"\s*:\s*true')
  } catch { return $false }
}

# ---- input checks that need no device ----
if ($Serial -notmatch '^[A-Za-z0-9._:\-]{3,64}$') { Fail 0 'nilai -Serial tidak sah (hanya huruf, angka, titik, noktah bertindih, sengkang)' }
if ($Version -ne '' -and $Version -notmatch '^\d{4}\.\d{1,2}\.\d{1,6}$') { Fail 0 '-Version mesti dalam bentuk YYYY.MM.N' }
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($ApkDir -eq '') { $ApkDir = Join-Path $repoRoot 'dist\android' }
if ($ApkDir -match '[&|<>^%"]') { Fail 0 'laluan -ApkDir mengandungi aksara yang tidak dibenarkan' }

# ---- step 0 ----
if ($Adb -ne '') {
  if (-not (Test-Path -LiteralPath $Adb)) { Fail 0 "adb tiada di $Adb" }
  $script:AdbExe = $Adb
} else {
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { Fail 0 'adb tidak dijumpai pada PATH (pasang Android platform-tools)' }
  $script:AdbExe = $cmd.Source
}
$dev = Invoke-AdbRaw @('devices')
$state = ''
foreach ($line in ($dev.Text -split "`n")) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -ge 2 -and $parts[0] -ceq $Serial) { $state = $parts[1] }
}
if ($state -eq '') { Fail 0 "peranti $Serial tiada dalam senarai adb devices" }
if ($state -eq 'unauthorized') { Fail 0 "peranti $Serial belum membenarkan komputer ini: terima kotak Nyahpepijat USB pada skrin TV, kemudian cuba lagi" }
if ($state -ne 'device') { Fail 0 "peranti $Serial dalam keadaan '$state', bukan 'device'" }
Say 'OK' 0 "adb ditemui dan peranti $Serial sah"

# ---- step 1 ----
$abiList = (Adb-Read @('shell', 'getprop', 'ro.product.cpu.abilist')).Text.Trim()
$sdkText = (Adb-Read @('shell', 'getprop', 'ro.build.version.sdk')).Text.Trim()
$sdk = 0
if (-not [int]::TryParse($sdkText, [ref]$sdk)) { Fail 1 "tidak dapat membaca ro.build.version.sdk ('$sdkText')" }
if ($sdk -lt 28) { Fail 1 "Android SDK $sdk terlalu lama; MAX Kiosk Server mahu SDK 28 atau lebih baru" }
$df = Adb-Read @('shell', 'df', '-k', '/data')
$freeKb = -1
$tokens = @($df.Text -split '\s+' | Where-Object { $_ -ne '' })
for ($i = 1; $i -lt $tokens.Count; $i++) {
  if ($tokens[$i] -match '^\d+%$' -and $tokens[$i - 1] -match '^\d+$') { $freeKb = [int64]$tokens[$i - 1]; break }
}
if ($freeKb -lt 0) { Fail 1 'tidak dapat membaca ruang kosong /data' }
if ($freeKb -lt 1048576) { Fail 1 ("ruang kosong /data hanya {0} MB; perlu 1 GB atau lebih" -f [math]::Floor($freeKb / 1024)) }
$wv = (Adb-Read @('shell', 'dumpsys', 'webviewupdate')).Text
$wvText = 'versi WebView tidak dapat dibaca'
if ($wv -match 'Current WebView package \(name, version\):\s*\(([^,]+),\s*([0-9][0-9.]*)\)') {
  $wvMajor = [int](($Matches[2] -split '\.')[0])
  $wvText = "WebView $($Matches[1]) $($Matches[2])"
  if ($wvMajor -lt 91) { Say 'AMARAN' 1 "${wvText}: di bawah 91, paparan kiosk mungkin tidak betul" ; $script:Warnings++ }
} else { Say 'LANGKAU' 1 $wvText }
Say 'OK' 1 ("ABI $abiList, SDK $sdk, ruang kosong {0} MB" -f [math]::Floor($freeKb / 1024))

# ---- step 2 ----
$abi = ''
foreach ($cand in @('arm64-v8a', 'armeabi-v7a')) {
  if (($abiList -split ',') -contains $cand) { $abi = $cand; break }
}
if ($abi -eq '') { Fail 2 "tiada ABI yang disokong dalam '$abiList' (perlu arm64-v8a atau armeabi-v7a)" }
$apk = $null
# build-box-apk.ps1 -Debug names its output MAX-Kiosk-Server-<v>-<abi>-debug.apk
$sfx = ''
if ($DebugBuild) { $sfx = '-debug' }
if ($Version -ne '') {
  $apk = Join-Path $ApkDir "MAX-Kiosk-Server-$Version-$abi$sfx.apk"
  if (-not (Test-Path -LiteralPath $apk)) { Fail 2 "fail APK tiada: $apk" }
} else {
  $found = @(Get-ChildItem -LiteralPath $ApkDir -Filter "MAX-Kiosk-Server-*-$abi$sfx.apk" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^MAX-Kiosk-Server-(\d{4})\.(\d{1,2})\.(\d{1,6})-' } |
    Sort-Object { $m = [regex]::Match($_.Name, '^MAX-Kiosk-Server-(\d{4})\.(\d{1,2})\.(\d{1,6})-'); [int64]$m.Groups[1].Value * 1e10 + [int64]$m.Groups[2].Value * 1e6 + [int64]$m.Groups[3].Value } -Descending)
  if ($found.Count -eq 0) { Fail 2 "tiada MAX-Kiosk-Server-*-$abi$sfx.apk dalam $ApkDir (bina dengan build-box-apk.ps1)" }
  $apk = $found[0].FullName
}
if ($apk -match '[&|<>^%"]') { Fail 2 'laluan APK mengandungi aksara yang tidak dibenarkan' }
$shaFile = "$apk.sha256"
if (-not (Test-Path -LiteralPath $shaFile)) { Fail 2 "fail .sha256 tiada: $shaFile" }
$want = ((Get-Content -LiteralPath $shaFile -Raw -Encoding ASCII).Trim() -split '\s+')[0].ToLowerInvariant()
if ($want -notmatch '^[0-9a-f]{64}$') { Fail 2 "$shaFile tidak mengandungi sha256 yang sah" }
$got = Get-Sha256 $apk
if ($got -ne $want) { Fail 2 "sha256 APK tidak sepadan dengan .sha256 (dapat $got, mahu $want); tiada apa dipasang" }
if ($DebugBuild) {
  Say 'LANGKAU' 2 'binaan nyahpepijat: sijil penandatangan tidak disemak'
} else {
  $pinsPath = Join-Path $PSScriptRoot 'android-pins.json'
  $pin = ''
  if (Test-Path -LiteralPath $pinsPath) {
    $pins = Get-Content -LiteralPath $pinsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pins.PSObject.Properties.Name -contains 'signingCertSha256') { $pin = [string]$pins.signingCertSha256 }
  }
  if ($pin -eq '') { Fail 2 'signingCertSha256 belum diisi dalam android-pins.json; APK tidak dipasang' }
  if ($pin -notmatch '^[0-9a-fA-F]{64}$') { Fail 2 'signingCertSha256 dalam android-pins.json tidak sah' }
  $signer = Find-Apksigner
  if ($signer -eq '') { Fail 2 'apksigner tidak dijumpai (tetapkan -Apksigner atau ANDROID_HOME)' }
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $sig = & $signer @('verify', '--print-certs', $apk) 2>&1 | ForEach-Object { "$_" } | Out-String; $sigCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $old }
  if ($sigCode -ne 0) { Fail 2 'apksigner verify gagal; APK tidak dipasang' }
  if ($sig -notmatch 'certificate SHA-256 digest:\s*([0-9a-fA-F]{64})') { Fail 2 'sijil penandatangan APK tidak dapat dibaca' }
  if ($Matches[1].ToLowerInvariant() -ne $pin.ToLowerInvariant()) { Fail 2 "sijil penandatangan APK ($($Matches[1])) tidak sama dengan pin signingCertSha256; APK tidak dipasang" }
}
Say 'OK' 2 ("APK {0} ({1}), sha256 sepadan" -f (Split-Path -Leaf $apk), $abi)

# ---- step 3 ----
if (-not $DryRun -and -not $Yes) {
  $ans = Read-Host "Pasang $(Split-Path -Leaf $apk) pada $Serial ? (y/t)"
  if ($ans -notmatch '^(y|ya)$') { Fail 3 'dibatalkan oleh pengendali' }
}
$ins = Adb-ChangeTimed @('install', '-r', '--no-incremental', $apk) 600
if ($ins.PSObject.Properties.Name -contains 'TimedOut') { Fail 3 'pemasangan melebihi 10 minit dan dihentikan' }
if ($ins.PSObject.Properties.Name -notcontains 'Dry') {
  if ($ins.Text -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
    Fail 3 ("pakej $Pkg sedia ada ditandatangani dengan kunci lain. Memadamnya akan menghapuskan data surau itu, jadi skrip ini tidak memadam apa-apa. " +
      'Sandarkan data, putuskan sendiri di Tetapan TV, atau gunakan APK dengan kunci yang sama.')
  }
  if ($ins.Code -ne 0 -or $ins.Text -notmatch 'Success') { Fail 3 ("adb install gagal: " + $ins.Text) }
}
if ($DryRun) { Say 'SET' 3 'APK akan dipasang (dicetak sahaja)' } else { Say 'OK' 3 'APK dipasang' }

# ---- step 4 ----
if ($sdk -ge 33) {
  $g = Adb-Change @('shell', 'pm', 'grant', $Pkg, 'android.permission.POST_NOTIFICATIONS')
  if ($g.Code -eq 0 -and $g.Text -notmatch 'Exception|Unknown|error') { Say 'SET' 4 'kebenaran notifikasi diberi' }
  else { Say 'AMARAN' 4 ("kebenaran notifikasi tidak dapat diberi: " + $g.Text); $script:Warnings++ }
} else { Say 'LANGKAU' 4 "SDK $sdk tidak memerlukan kebenaran notifikasi" }

# ---- step 5 ----
$b = Adb-Change @('shell', 'dumpsys', 'deviceidle', 'whitelist', "+$Pkg")
if ($b.PSObject.Properties.Name -contains 'Dry' -or $b.Text -match 'Added|already') { Say 'SET' 5 'pengecualian bateri ditetapkan' }
else { Say 'AMARAN' 5 ("pengecualian bateri tidak pasti: " + $b.Text); $script:Warnings++ }

# ---- step 6 ----
if ($sdk -ge 31) {
  $p1 = Adb-Change @('shell', 'device_config', 'put', 'activity_manager', 'max_phantom_processes', '2147483647')
  $p2 = Adb-Change @('shell', 'settings', 'put', 'global', 'settings_enable_monitor_phantom_procs', 'false')
  if (($p1.Code -eq 0 -and $p1.Text -notmatch 'Exception|not found|Unknown') -and ($p2.Code -eq 0 -and $p2.Text -notmatch 'Exception|not found|Unknown')) {
    Say 'SET' 6 'had proses anak dinaikkan'
  } else {
    Say 'LANGKAU' 6 ("arahan had proses tidak dikenali pada Android ini: " + (($p1.Text + ' ' + $p2.Text).Trim())); $script:Warnings++
  }
} else { Say 'LANGKAU' 6 "SDK $sdk tiada had proses hantu" }

# ---- step 7 ----
# The vendor call SETS the whole awbms user whitelist (i32 = list length), so the list is read first and merged.
function Get-AwbmsWhitelist {
  $d = Adb-Read @('shell', 'dumpsys', 'background')
  if ($d.Code -ne 0) { return $null }
  $m = [regex]::Match($d.Text, '(?m)^[ \t]*User Whitelist:[ \t]*\r?\n[ \t.]*\[([^\]\r\n]*)\]')
  if (-not $m.Success) { return $null }
  $items = @($m.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  return [pscustomobject]@{ List = $items }
}
$svc = Adb-Read @('shell', 'service', 'check', 'background')
if ($svc.Text -match 'Service background:\s*found') {
  $pkgRe = '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$'
  $cur = Get-AwbmsWhitelist
  if ($null -eq $cur) {
    Say 'AMARAN' 7 ('senarai putih perkhidmatan background tidak dapat dibaca daripada dumpsys background, jadi tiada apa-apa ditulis (supaya aplikasi lain dalam senarai tidak tercicir). Pemasangan diteruskan.')
    $script:Warnings++
  } elseif ($cur.List -contains $Pkg) {
    Say 'OK' 7 'sudah dalam senarai putih perkhidmatan background'
  } elseif (@($cur.List | Where-Object { $_ -notmatch $pkgRe }).Count -gt 0) {
    Say 'AMARAN' 7 ('senarai putih sedia ada mengandungi nama yang tidak sah (' + ($cur.List -join ', ') + '), jadi tiada apa-apa ditulis. Pemasangan diteruskan.')
    $script:Warnings++
  } else {
    $merged = @($cur.List) + @($Pkg)
    $callArgs = @('shell', 'service', 'call', 'background', '3', 'i32', [string]$merged.Count)
    foreach ($e in $merged) { $callArgs += @('s16', $e) }
    $w = Adb-Change $callArgs
    if ($w.PSObject.Properties.Name -contains 'Dry') { Say 'SET' 7 'senarai putih perkhidmatan background digabungkan (arahan dicetak)' }
    elseif ($w.Code -eq 0 -and $w.Text -match 'Result: Parcel\(\s*0{8}\b' -and $w.Text -notmatch 'Exception|denied|Permission') {
      $chk = Get-AwbmsWhitelist
      $missing = @()
      if ($null -ne $chk) { $missing = @($merged | Where-Object { $chk.List -notcontains $_ }) }
      if ($null -ne $chk -and $missing.Count -eq 0) { Say 'SET' 7 ('senarai putih perkhidmatan background digabungkan: ' + ($merged -join ', ')) }
      else {
        $now = if ($null -eq $chk) { 'tidak dapat dibaca' } else { $chk.List -join ', ' }
        Say 'AMARAN' 7 ('senarai putih berubah di luar jangkaan. Lama: [' + ($cur.List -join ', ') + ']. Baharu: [' + $now + ']. Semak peranti.')
        $script:Warnings++
      }
    } else {
      Say 'AMARAN' 7 ('perkhidmatan background Allwinner menolak arahan tanpa hak root. Skrip ini tidak menggunakan lubang root vendor. ' +
        'Tetapkan senarai putih itu dengan cara lain yang dibenarkan, atau beritahu Pentadbir MAXCOM. Pemasangan diteruskan.')
      $script:Warnings++
    }
  }
} else { Say 'LANGKAU' 7 'perkhidmatan background tiada pada peranti ini' }

# ---- step 8 ----
if ($SetHome) {
  $h = Adb-Change @('shell', 'cmd', 'package', 'set-home-activity', $HomeComponent)
  if ($h.PSObject.Properties.Name -contains 'Dry' -or ($h.Code -eq 0 -and $h.Text -notmatch 'Exception|Error|Unknown')) { Say 'SET' 8 'MAX Kiosk Server ditetapkan sebagai skrin utama' }
  else { Say 'AMARAN' 8 ("tidak dapat menetapkan skrin utama: " + $h.Text + ". Pilih MAX Kiosk Server sebagai aplikasi utama pada TV."); $script:Warnings++ }
} else { Say 'LANGKAU' 8 'tanpa -SetHome: pada TV, tekan Home dan pilih MAX Kiosk Server sebagai aplikasi utama (sentiasa)' }

# ---- step 9 ----
$st = Adb-Change @('shell', 'am', 'start', '-n', $HomeComponent)
if ($st.PSObject.Properties.Name -notcontains 'Dry' -and ($st.Code -ne 0 -or $st.Text -match 'Error|Exception')) { Fail 9 ('aplikasi tidak dapat dimulakan: ' + $st.Text) }
if ($DryRun) {
  Write-Host ('DRYRUN adb -s ' + $Serial + ' forward tcp:<port bebas> tcp:8787')
  Write-Host ('DRYRUN tunggu /api/health sehingga ' + $HealthWaitSec + ' saat, kemudian adb -s ' + $Serial + ' forward --remove tcp:<port bebas>')
  Say 'SET' 9 'aplikasi dimulakan (dicetak sahaja)'
} else {
  $port = Get-FreeLocalPort
  $fw = Invoke-AdbRaw @('-s', $Serial, 'forward', "tcp:$port", 'tcp:8787')
  if ($fw.Code -ne 0) { Fail 9 ('adb forward gagal: ' + $fw.Text) }
  $ok = $false
  try {
    $deadline = (Get-Date).AddSeconds($HealthWaitSec)
    do {
      if (Test-Health $port) { $ok = $true; break }
      Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)
  } finally {
    [void](Invoke-AdbRaw @('-s', $Serial, 'forward', '--remove', "tcp:$port"))
  }
  if (-not $ok) { Fail 9 "kotak tidak menjawab /api/health dalam $HealthWaitSec saat (lihat skrin TV dan jalankan doctor-android-box.ps1)" }
  Say 'OK' 9 'kotak menjawab /api/health'
}

# ---- step 10 ----
$ip = Get-DeviceIp
if ($ip -eq '') { Say 'AMARAN' 10 'alamat IP kotak tidak dapat dibaca; lihat alamat pada skrin TV'; $script:Warnings++ }
else { Say 'OK' 10 "Alamat kotak: https://${ip}:8443/" }
Write-Host 'Imbas kod QR pada skrin TV dengan aplikasi MAX Admin Client'

# ---- step 11 ----
if ($DisableNetworkAdbAfter) {
  if ($Serial -match ':\d+$') {
    $u = Adb-Change @('usb')
    Say 'SET' 11 'ADB rangkaian diminta ditutup (belum dibuktikan pada perkakasan; sahkan sambungan terputus)'
  } else {
    Say 'LANGKAU' 11 'peranti ini disambung melalui USB; jika ADB rangkaian dihidupkan di Pilihan Pembangun, matikannya di sana'
  }
} else { Say 'LANGKAU' 11 'tanpa -DisableNetworkAdbAfter: ADB rangkaian tidak diubah' }

if ($script:Warnings -gt 0) { Write-Host ("Selesai dengan {0} amaran." -f $script:Warnings) } else { Write-Host 'Selesai.' }
exit 0
