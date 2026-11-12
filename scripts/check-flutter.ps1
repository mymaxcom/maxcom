param([string]$VersionFile = "apps/surau-app/.flutter-version")
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Host "FAIL: $m"; exit 1 }
if (-not (Test-Path $VersionFile)) { Fail "missing $VersionFile" }
$want = (Get-Content $VersionFile -Raw).Trim()
if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) { Fail "flutter not on PATH" }
$raw = (cmd /c "flutter --version --machine" 2>$null) -join "`n"
try { $v = $raw | ConvertFrom-Json } catch { Fail "cannot parse flutter --version --machine" }
if ($v.frameworkVersion -ne $want) { Fail "flutter $($v.frameworkVersion) != pinned $want" }
if ($v.channel -ne "stable") { Fail "channel $($v.channel) is not stable" }
$dart = [version](($v.dartSdkVersion -split " ")[0])
if ($dart -lt [version]"3.10") { Fail "dart $($v.dartSdkVersion) < 3.10" }
$doc = (cmd /c "flutter doctor" 2>&1) -join "`n"
$lines = $doc -split "`n"
$and = $lines | Where-Object { $_ -match "Android toolchain" } | Select-Object -First 1
$chr = $lines | Where-Object { $_ -match "Chrome - develop for the web" } | Select-Object -First 1
if (-not $and -or $and -match "^\[(X|\u2717)\]|^\[-\]") { Fail "Android toolchain not OK: $and" }
if ($and -match "^\[!\]") { Fail "Android toolchain has issues: $and" }
if (-not $chr -or $chr -match "^\[(X|\u2717|!|-)\]") { Fail "Chrome not OK: $chr" }
Write-Host "flutter $($v.frameworkVersion) ($($v.channel)), dart $($v.dartSdkVersion), devtools $($v.devToolsVersion)"
Write-Host "OK"
exit 0