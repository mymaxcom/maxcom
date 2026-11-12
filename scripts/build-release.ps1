<#
.SYNOPSIS
  MAXCOM: builds the Windows box release archive maxcom-box-<version>-windows.tar.gz on the dev machine.
  Windows PowerShell 5.1.
.DESCRIPTION
  The archive holds only MAXCOM's own code and the production (pure JavaScript) dependencies, with the
  entries at the archive root: release.json, package.json, apps\box-server, apps\kiosk-display\dist,
  packages\core, node_modules, scripts\ensure-live-firewall.ps1 and the notices. Node, MediaMTX and
  ffmpeg are NOT in it (they are pinned in scripts\release-pins.json and added by build-setup.ps1).

  The version comes from versions.json (key kiosk-server-<platform>); -Version is optional and, when given, must
  equal it. The version is stamped into release.json, which the box server reads as its own version.

  Refuses (nothing is built): a -Version that differs from versions.json, a versions.json that disagrees with
  the files that carry it (node scripts\set-version.mjs --check), uncommitted changes under apps\, packages\ or versions.json, a dev server listening on
  5173 or 8787 (a build would corrupt it; see build-app.ps1), a missing web app build
  (apps\box-server\public\app\index.html and a sha256sums.txt that matches it; -SkipAppBuild never
  skips this), a missing or malformed release-pins.json.

  The build runs in a staging folder in %TEMP%, outside the checkout: npm ci --omit=dev --ignore-scripts
  --workspace @surau/box-server, then the stub workspaces, every node_modules\@surau\* link and
  .package-lock.json are removed (an archive must carry no link; release.json.workspaceLinks tells the
  installer to make the @surau/core junction after extraction). The result must hold no reparse point
  and no *.test.ts. Then a smoke test extracts the archive to a second temp folder, makes the junction,
  starts the box on a random free port with a temp data folder and checks /api/health, / (kiosk) and
  /app/ (web app).

  Nothing is downloaded here: this script never contacts the network except through npm ci.
.PARAMETER Version      YYYY.MM.N, optional: defaults to versions.json kiosk-server-<platform>; if given it must equal it.
.PARAMETER OutDir       Where the archive is written (default <repo>\dist\release).
.PARAMETER SkipAppBuild Do not run the kiosk build (npm run build -w apps/kiosk-display); the kiosk dist must already exist.
.PARAMETER DryRun       Prints the stage list and the planned steps; changes and builds nothing.
.PARAMETER DevPorts     Ports whose listener makes the build refuse (default 5173 and 8787).
.PARAMETER RepoRoot     Test hook: build another checkout (default: the parent of this scripts folder).
.PARAMETER Platform     windows (default) or android. Sets the archive name suffix and release.json.platform; the android
                        stage leaves out scripts\ensure-live-firewall.ps1. Nothing else differs.
.PARAMETER AllowDirty   Manual proof only: build although apps\, packages\ or versions.json have uncommitted changes. release.json then
                        carries dirty = true. build-box-apk.ps1 allows it for -Debug builds only.
#>
param(
  [string]$Version = '',
  [string]$OutDir = '',
  [switch]$SkipAppBuild,
  [switch]$DryRun,
  [int[]]$DevPorts = @(5173, 8787),
  [string]$RepoRoot = '',
  [ValidateSet('windows', 'android')][string]$Platform = 'windows',
  [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "GAGAL: $m"; exit 1 }

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

function Test-Listening([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(500)) { try { $c.EndConnect($iar) } catch { return $false }; return $c.Connected }
    return $false
  } catch { return $false } finally { $c.Close() }
}

function Get-FreePort {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start()
  try { return ([System.Net.IPEndPoint]$l.LocalEndpoint).Port } finally { $l.Stop() }
}

# Walks a folder WITHOUT descending into reparse points (junctions, symlinks); the recursive
# PowerShell 5.1 directory listing would follow them.
function Get-TreeEntries([string]$dir) {
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push((New-Object System.IO.DirectoryInfo($dir)))
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in $d.GetFileSystemInfos()) {
      $isReparse = (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
      $isDir = (($e.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0)
      [void]$out.Add([pscustomobject]@{ Path = $e.FullName; IsReparse = $isReparse; IsDir = $isDir })
      if ($isDir -and -not $isReparse) { $stack.Push($e) }
    }
  }
  return $out
}

# Removes a folder; links are removed as links first (never followed), then the real content.
function Remove-TreeSafe([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  foreach ($e in @(Get-TreeEntries $dir | Where-Object { $_.IsReparse })) {
    if ($e.IsDir) { [System.IO.Directory]::Delete($e.Path, $false) } else { [System.IO.File]::Delete($e.Path) }
  }
  Remove-Item -LiteralPath $dir -Recurse -Force
}

function Copy-Tree([string]$src, [string]$dst) {
  if (-not (Test-Path -LiteralPath $src -PathType Container)) { Fail "mesti ada: $src" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
}

function Copy-One([string]$src, [string]$dst) {
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Fail "mesti ada: $src" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
}

function Get-Url([string]$url) {
  $req = [System.Net.HttpWebRequest]::Create($url)
  $req.Timeout = 5000
  $req.Proxy = $null
  try {
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    if ($null -eq $_.Exception.Response) { return @{ Status = 0; Body = '' } }
    $resp = $_.Exception.Response
  }
  try {
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    try { return @{ Status = [int]$resp.StatusCode; Body = $sr.ReadToEnd() } } finally { $sr.Dispose() }
  } finally { $resp.Close() }
}

# ---------------------------------------------------------------------------------------------
# Checks that refuse before anything is built
# ---------------------------------------------------------------------------------------------


if ($RepoRoot -eq '') { $RepoRoot = Join-Path $PSScriptRoot '..' }
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { Fail "RepoRoot tiada: $RepoRoot" }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')
if ($OutDir -eq '') { $OutDir = Join-Path $repo 'dist\release' }

# The version of this product comes from versions.json (key kiosk-server-<platform>); the Windows and the Android
# server are bumped separately. Every version file must agree first (set-version.mjs --check, for this key).
$versionKey = "kiosk-server-$Platform"
$versionsFile = Join-Path $repo 'versions.json'
if (-not (Test-Path -LiteralPath $versionsFile -PathType Leaf)) { Fail "versions.json tiada: $versionsFile" }
try { $versions = Get-Content -LiteralPath $versionsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'versions.json bukan JSON yang sah.' }
$declared = [string]$versions.$versionKey
if ($declared -notmatch '^20[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]?$') { Fail "versions.json: $versionKey tiada atau bukan YYYY.MM.N (diberi: '$declared')" }
if ($Version -eq '') { $Version = $declared }
elseif ($Version -ne $declared) { Fail "-Version $Version tidak sama dengan versions.json $versionKey ($declared)" }
$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCheck) { Fail 'node tiada pada PATH.' }
$svOut = @(& $nodeCheck.Source (Join-Path $PSScriptRoot 'set-version.mjs') --check --key $versionKey --root $repo)
if ($LASTEXITCODE -ne 0) { Fail "versi tidak sepadan dengan versions.json:`n$($svOut -join "`n")" }

# Pins file: shape only. Nothing is downloaded here, so the sha256 values are not needed by this script,
# but an https-only url and a versioned ffmpeg url are checked on every build.
$pinsFile = Join-Path $PSScriptRoot 'release-pins.json'
if (-not (Test-Path -LiteralPath $pinsFile -PathType Leaf)) { Fail "release-pins.json tiada: $pinsFile" }
try { $pins = Get-Content -LiteralPath $pinsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'release-pins.json bukan JSON yang sah.' }
foreach ($n in 'node', 'mediamtx', 'ffmpeg') {
  $e = $pins.$n
  if ($null -eq $e) { Fail "release-pins.json: $n tiada" }
  if ([string]$e.version -eq '') { Fail "release-pins.json: version $n kosong" }
  if ([string]$e.url -notmatch '^https://') { Fail "release-pins.json: url $n mesti bermula dengan https://" }
  if ([string]$e.sha256 -ne '' -and [string]$e.sha256 -notmatch '^[0-9a-fA-F]{64}$') { Fail "release-pins.json: sha256 $n tidak sah" }
}
if ([string]$pins.ffmpeg.url -match 'release-essentials') { Fail 'release-pins.json: url ffmpeg mesti berversi, bukan ffmpeg-release-essentials.zip yang berubah-ubah.' }

$archiveName = "maxcom-box-$Version-$Platform.tar.gz"
$archivePath = Join-Path $OutDir $archiveName
$tar = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32\tar.exe'

$stageList = @(
  'package.json',
  'package-lock.json',
  'apps/box-server/package.json',
  'apps/box-server/THIRD-PARTY.md',
  'apps/box-server/src/',
  'apps/box-server/public/app/',
  'apps/kiosk-display/dist/',
  'packages/core/package.json',
  'packages/core/src/',
  $(if ($Platform -eq 'windows') { 'scripts/ensure-live-firewall.ps1' }),
  'THIRD-PARTY-NOTICES.md',
  'node_modules/ (npm ci --omit=dev --ignore-scripts --workspace @surau/box-server)',
  'release.json'
)

if ($DryRun) {
  Write-Host "DRYRUN versi $Version sepadan dengan versions.json ($versionKey); release-pins.json sah"
  Write-Host "DRYRUN refuse: pelayan pembangunan pada port $($DevPorts -join ', ') atau perubahan belum commit di apps/ dan packages/"
  Write-Host "DRYRUN binaan kiosk: $(if ($SkipAppBuild) { 'dilangkau (-SkipAppBuild)' } else { 'npm run build -w apps/kiosk-display' })"
  Write-Host 'DRYRUN syarat: apps/box-server/public/app/index.html dan sha256sums.txt yang sepadan'
  Write-Host "DRYRUN platform: $Platform"
  foreach ($s in @($stageList | Where-Object { $_ })) { Write-Host "DRYRUN stage: $s" }
  Write-Host "DRYRUN tar: $tar -czf $archivePath (entri di akar arkib)"
  Write-Host 'DRYRUN ujian asap: ekstrak ke folder sementara, pautan @surau/core, mula kotak pada port rawak, semak /api/health, / dan /app/'
  Write-Host 'DRYRUN tiada apa yang ditulis atau dibina.'
  exit 0
}

foreach ($port in $DevPorts) {
  if (Test-Listening $port) { Fail "pelayan pembangunan sedang berjalan pada :$port. Hentikan dahulu; binaan merosakkan folder binaannya." }
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Fail 'git tiada pada PATH.' }
$dirty = & $git.Source -C $repo status --porcelain -- apps packages versions.json
if ($LASTEXITCODE -ne 0) { Fail 'git status gagal.' }
if ($dirty -and -not $AllowDirty) { Fail "ada perubahan belum commit di apps/, packages/ atau versions.json:`n$($dirty -join "`n")" }
$commit = (& $git.Source -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or [string]$commit -notmatch '^[0-9a-f]{40}$') { Fail 'git rev-parse HEAD gagal.' }

if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { Fail "tar.exe tiada: $tar" }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Fail 'npm tiada pada PATH.' }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node tiada pada PATH.' }
$nodeNow = (& $node.Source -p 'process.versions.node').Trim()
if ($nodeNow -ne [string]$pins.node.version) { Write-Host "AMARAN: node binaan $nodeNow berbeza daripada pin $($pins.node.version); release.json mencatat pin." }

# Kiosk build (checkout; the dev-server check above already passed).
if (-not $SkipAppBuild) {
  Push-Location $repo
  try {
    & $npm.Source run build -w apps/kiosk-display
    if ($LASTEXITCODE -ne 0) { Fail 'npm run build -w apps/kiosk-display gagal.' }
  } finally { Pop-Location }
}
$kioskDist = Join-Path $repo 'apps\kiosk-display\dist'
if (-not (Test-Path -LiteralPath (Join-Path $kioskDist 'index.html') -PathType Leaf)) { Fail "apps/kiosk-display/dist/index.html tiada (jalankan tanpa -SkipAppBuild)." }

# Web app: built by build-app.ps1 -Web; never skipped.
$appDir = Join-Path $repo 'apps\box-server\public\app'
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'index.html') -PathType Leaf)) { Fail 'apps/box-server/public/app/index.html tiada (jalankan scripts\build-app.ps1 -Web).' }
$sums = Join-Path $appDir 'sha256sums.txt'
if (-not (Test-Path -LiteralPath $sums -PathType Leaf)) { Fail 'apps/box-server/public/app/sha256sums.txt tiada (jalankan scripts\build-app.ps1 -Web).' }
$sumLines = @(Get-Content -LiteralPath $sums -Encoding ASCII | Where-Object { $_.Trim() -ne '' })
if ($sumLines.Count -eq 0) { Fail 'sha256sums.txt kosong.' }
$sumPaths = @{}
foreach ($line in $sumLines) {
  if ($line -notmatch '^([0-9a-f]{64})  (\S.*)$') { Fail "sha256sums.txt: baris tidak sah: $line" }
  $rel = $Matches[2]
  if ($rel.Contains('..') -or $rel.StartsWith('/') -or $rel.Contains(':')) { Fail "sha256sums.txt: laluan tidak sah: $rel" }
  $f = Join-Path $appDir ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail "sha256sums.txt menyebut fail yang tiada: $rel" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() -ne $Matches[1]) { Fail "sha256 tidak sepadan untuk app/$rel (binaan web sudah berubah; jalankan build-app.ps1 -Web semula)." }
  $sumPaths[$rel] = $true
}
if (-not $sumPaths.ContainsKey('index.html')) { Fail 'sha256sums.txt tidak menyenaraikan index.html.' }

# ---------------------------------------------------------------------------------------------
# Stage, install production dependencies, clean, describe, pack, smoke test
# ---------------------------------------------------------------------------------------------

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('maxcom-release-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'stage'
$extract = Join-Path $work 'extract'
$smokeData = Join-Path $work 'smoke-data'
$smokeTools = Join-Path $work 'smoke-tools'
$proc = $null
$ok = $false
$outLine = ''
try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  Copy-One (Join-Path $repo 'package.json') (Join-Path $stage 'package.json')
  Copy-One (Join-Path $repo 'package-lock.json') (Join-Path $stage 'package-lock.json')
  Copy-One (Join-Path $repo 'apps\box-server\package.json') (Join-Path $stage 'apps\box-server\package.json')
  Copy-One (Join-Path $repo 'apps\box-server\THIRD-PARTY.md') (Join-Path $stage 'apps\box-server\THIRD-PARTY.md')
  Copy-Tree (Join-Path $repo 'apps\box-server\src') (Join-Path $stage 'apps\box-server\src')
  Copy-Tree $appDir (Join-Path $stage 'apps\box-server\public\app')
  Copy-Tree $kioskDist (Join-Path $stage 'apps\kiosk-display\dist')
  Copy-One (Join-Path $repo 'packages\core\package.json') (Join-Path $stage 'packages\core\package.json')
  Copy-Tree (Join-Path $repo 'packages\core\src') (Join-Path $stage 'packages\core\src')
  if ($Platform -eq 'windows') { Copy-One (Join-Path $repo 'scripts\ensure-live-firewall.ps1') (Join-Path $stage 'scripts\ensure-live-firewall.ps1') }
  Copy-One (Join-Path $repo 'THIRD-PARTY-NOTICES.md') (Join-Path $stage 'THIRD-PARTY-NOTICES.md')

  # Stub workspaces: npm ci refuses a lockfile whose workspaces are missing. Only the bare package.json
  # of each workspace the lockfile names is added; they are deleted again after the install.
  # (Windows PowerShell 5.1 ConvertFrom-Json cannot read the lockfile: it has an empty property name.)
  $lockKeys = @(@(& $node.Source -p "Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).packages).join(',')" (Join-Path $repo 'package-lock.json')) -split ',')
  if ($LASTEXITCODE -ne 0 -or $lockKeys.Count -eq 0) { Fail 'package-lock.json tidak dapat dibaca.' }
  $stubs = @()
  foreach ($k in $lockKeys) {
    $k = ([string]$k).Trim()
    if ($k -eq '' -or $k.StartsWith('node_modules/') -or $k.Contains('/node_modules/')) { continue }
    if ($k -match '[\\:]' -or $k.StartsWith('/') -or $k.Contains('..')) { Fail "package-lock.json: laluan ruang kerja tidak sah: $k" }
    $dstPkg = Join-Path $stage (($k -replace '/', '\') + '\package.json')
    if (Test-Path -LiteralPath $dstPkg) { continue }
    $srcPkg = Join-Path $repo (($k -replace '/', '\') + '\package.json')
    if (-not (Test-Path -LiteralPath $srcPkg -PathType Leaf)) { Fail "ruang kerja dalam package-lock.json tiada package.json: $k" }
    Copy-One $srcPkg $dstPkg
    $stubs += $dstPkg
  }

  Push-Location $stage
  try {
    & $npm.Source ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace '@surau/box-server'
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci gagal dalam folder stage.' }
  } finally { Pop-Location }

  # Delete the stub workspaces (and the folder they leave empty), every node_modules\@surau link, .package-lock.json.
  foreach ($s in $stubs) {
    Remove-Item -LiteralPath $s -Force
    $dir = Split-Path -Parent $s
    if ((Get-ChildItem -LiteralPath $dir -Force | Measure-Object).Count -eq 0) { Remove-Item -LiteralPath $dir -Force }
  }
  $scope = Join-Path $stage 'node_modules\@surau'
  if (Test-Path -LiteralPath $scope) {
    foreach ($e in @(Get-TreeEntries $scope | Where-Object { $_.IsReparse })) {
      if ($e.IsDir) { [System.IO.Directory]::Delete($e.Path, $false) } else { [System.IO.File]::Delete($e.Path) }
    }
    if ((Get-ChildItem -LiteralPath $scope -Force | Measure-Object).Count -eq 0) { Remove-Item -LiteralPath $scope -Force }
  }
  $nmLock = Join-Path $stage 'node_modules\.package-lock.json'
  if (Test-Path -LiteralPath $nmLock) { Remove-Item -LiteralPath $nmLock -Force }

  # Dependencies ship their own test folders (with fixtures such as a file named "snow <snowman>" that crash the
  # Windows bsdtar). A package's top-level test/tests folder is never loaded at run time: remove them.
  foreach ($t in @(Get-TreeEntries (Join-Path $stage 'node_modules') | Where-Object { $_.IsDir -and -not $_.IsReparse -and $_.Path -match '\\node_modules\\(@[^\\]+\\)?[^\\]+\\(test|tests)$' })) {
    if (Test-Path -LiteralPath $t.Path) { Remove-Item -LiteralPath $t.Path -Recurse -Force }
  }

  $entries = @(Get-TreeEntries $stage)
  $links = @($entries | Where-Object { $_.IsReparse })
  if ($links.Count -gt 0) { Fail "stage masih ada pautan (reparse point): $($links[0].Path)" }
  $tests = @($entries | Where-Object { -not $_.IsDir -and $_.Path -match '\.test\.ts$' -and $_.Path -notmatch '\\node_modules\\' })
  if ($tests.Count -gt 0) { Fail "stage masih ada fail ujian: $($tests[0].Path)" }

  $rel = [ordered]@{
    v = 1
    version = $Version
    platform = $Platform
    commit = $commit
    builtAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    node = [string]$pins.node.version
    workspaceLinks = @([ordered]@{ name = '@surau/core'; target = 'packages/core' })
  }
  if ($dirty) { $rel['dirty'] = $true }
  [System.IO.File]::WriteAllText((Join-Path $stage 'release.json'), (($rel | ConvertTo-Json -Depth 5) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

  # Pack from inside the stage with the top-level names listed, so entries sit at the archive root (no ./ prefix).
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  $top = @('release.json') + @((New-Object System.IO.DirectoryInfo($stage)).GetFileSystemInfos() | Where-Object { $_.Name -ne 'release.json' } | Sort-Object Name | ForEach-Object { $_.Name })
  # Windows PowerShell 5.1 turns any stderr line of a native command redirected with 2>&1 into a terminating
  # error under EAP Stop (tar prints harmless warnings there), so run it under Continue and judge by exit code.
  $eapBefore = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $tarOut = @(& $tar -czf $archivePath -C $stage @top 2>&1 | ForEach-Object { "$_" }) }
  finally { $ErrorActionPreference = $eapBefore }
  $tarExit = $LASTEXITCODE
  foreach ($l in @($tarOut | Select-Object -First 20)) { if ("$l".Trim() -ne '') { Write-Host "  tar: $l" } }
  if ($tarExit -ne 0) { Fail "tar.exe gagal membuat arkib (kod $tarExit): $(($tarOut | Select-Object -First 5) -join ' | ')" }

  # List the archive we just made with the rule the installer applies: no absolute path, no .., no drive letter, no link.
  $names = @(& $tar -tzf $archivePath)
  if ($LASTEXITCODE -ne 0 -or $names.Count -eq 0) { Fail 'tar.exe tidak dapat menyenaraikan arkib.' }
  foreach ($nm in $names) {
    if ($nm.StartsWith('/') -or $nm.StartsWith('\') -or $nm -match '^[A-Za-z]:' -or ($nm -split '[\\/]') -contains '..') { Fail "arkib mengandungi laluan yang ditolak: $nm" }
  }
  $verbose = @(& $tar -tvzf $archivePath)
  if (@($verbose | Where-Object { $_ -match '^[lh]' }).Count -gt 0) { Fail 'arkib mengandungi entri pautan.' }
  if ($names -notcontains 'release.json') { Fail 'release.json bukan entri di akar arkib.' }

  # Smoke test: extract, make the junction from workspaceLinks, start the box, probe, stop.
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  & $tar -xzf $archivePath -C $extract
  if ($LASTEXITCODE -ne 0) { Fail 'tar.exe gagal mengekstrak arkib untuk ujian asap.' }
  $meta = Get-Content -LiteralPath (Join-Path $extract 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($w in @($meta.workspaceLinks)) {
    $leaf = ([string]$w.name).Substring('@surau/'.Length)
    $scopeDir = Join-Path $extract 'node_modules\@surau'
    New-Item -ItemType Directory -Path $scopeDir -Force | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $scopeDir $leaf) -Value (Join-Path $extract (([string]$w.target) -replace '/', '\')) | Out-Null
  }
  New-Item -ItemType Directory -Path $smokeData -Force | Out-Null
  New-Item -ItemType Directory -Path $smokeTools -Force | Out-Null
  $port = Get-FreePort
  $httpsPort = Get-FreePort
  $saved = @{}
  $envSet = [ordered]@{ SURAU_PORT = [string]$port; SURAU_HTTPS_PORT = [string]$httpsPort; SURAU_DB = (Join-Path $smokeData 'surau.db'); SURAU_DATA_DIR = $smokeData; SURAU_LIVE_TOOLS = $smokeTools; SURAU_ROLE = $null; NODE_OPTIONS = $null }
  foreach ($k in $envSet.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $envSet[$k], 'Process') }
  try {
    $main = Join-Path $extract 'apps\box-server\src\main.ts'
    $proc = Start-Process -FilePath $node.Source -ArgumentList ('"' + $main + '"') -WorkingDirectory $extract -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'smoke.out.log') -RedirectStandardError (Join-Path $work 'smoke.err.log')
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  $health = $null
  for ($i = 0; $i -lt 60; $i++) {
    if ($proc.HasExited) { break }
    $r = Get-Url "http://127.0.0.1:$port/api/health"
    if ($r.Status -eq 200) { $health = $r; break }
    Start-Sleep -Milliseconds 500
  }
  if ($null -eq $health) {
    $errTail = ''
    $errLog = Join-Path $work 'smoke.err.log'
    if (Test-Path -LiteralPath $errLog) { $errTail = ((Get-Content -LiteralPath $errLog -Tail 10 -ErrorAction SilentlyContinue) -join "`n") }
    Fail "ujian asap: kotak tidak menjawab /api/health.`n$errTail"
  }
  $h = $health.Body | ConvertFrom-Json
  if ($h.ok -ne $true) { Fail 'ujian asap: /api/health tidak ok.' }
  $kiosk = Get-Url "http://127.0.0.1:$port/"
  if ($kiosk.Status -ne 200 -or $kiosk.Body -notmatch '<html') { Fail "ujian asap: / tidak menghidangkan skrin kiosk (status $($kiosk.Status))." }
  $web = Get-Url "http://127.0.0.1:$port/app/"
  if ($web.Status -ne 200 -or $web.Body -notmatch '<html') { Fail "ujian asap: /app/ tidak menghidangkan aplikasi web (status $($web.Status))." }
  Write-Host "Ujian asap lulus: /api/health ok, / dan /app/ dihidangkan (port $port)."

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  $size = (Get-Item -LiteralPath $archivePath).Length
  $outLine = "sha256 $hash size $size"
  $ok = $true
} finally {
  # Stop only the process this script started (by PID).
  if ($null -ne $proc) {
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; [void]$proc.WaitForExit(10000) } } catch { }
  }
  try { Remove-TreeSafe $work } catch { Write-Host "AMARAN: folder sementara tidak dapat dibuang: $work ($($_.Exception.Message))" }
  if (-not $ok -and (Test-Path -LiteralPath $archivePath)) { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
}

Write-Host "Arkib: $archivePath"
Write-Host $outLine
