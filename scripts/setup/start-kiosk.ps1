<#
.SYNOPSIS
  MAXCOM: show the kiosk screen in Microsoft Edge, full screen, once the box answers. Windows PowerShell 5.1.

.DESCRIPTION
  Runs as the kiosk user, no elevation. Finds msedge.exe (App Paths, then the two Program Files paths),
  waits up to 180 seconds for http://127.0.0.1:<port>/api/health, then starts Edge in kiosk mode with its
  own profile folder (%LOCALAPPDATA%\MAXCOM\kiosk-profile). The address is always loopback HTTP: only the
  port can be chosen.

  Without -Once it waits for that Edge to exit and starts it again after 5 seconds, until the file
  %LOCALAPPDATA%\MAXCOM\kiosk-stop exists (the shortcut "Henti skrin MAXCOM" makes it). A stop file left
  from an earlier session is removed when this script starts for real (never with -Once: a stop request
  is honoured by -Once, which then starts nothing).

  Exit to the box OS: for a real start (not -Once, not -PrintOnly) the script opens a loopback listener
  (System.Net.Sockets.TcpListener on 127.0.0.1, a free port) with a random 32-byte token and opens Edge on
  http://127.0.0.1:<port>/#mxhost=<listener port>.<token>. The kiosk page's corner logo, on a double-click,
  POSTs the token to /exit. Only POST /exit with exactly the token is accepted (answer 204): the script then
  stops the Edge process tree it started (taskkill /PID <pid> /T /F, never by image name) and ends, leaving the
  desktop to the admin. The stop file is not created: the next logon, or the Start menu shortcut, shows the
  kiosk again.

.PARAMETER Port       The box's loopback HTTP port (1..65535, default 8787).
.PARAMETER Once       Start Edge once and return (do not wait, do not restart, no exit helper).
.PARAMETER NoRestart  Start Edge once with the exit helper and stay until Edge closes or the exit request
                      arrives; do not restart Edge (the Start menu shortcut "Skrin MAXCOM" uses this).
.PARAMETER PrintOnly  Print the program and arguments; start nothing, wait for nothing, change nothing.
.PARAMETER EdgePath   Use this msedge.exe instead of looking for one (the file must be named msedge.exe).
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [switch]$Once,
  [switch]$NoRestart,
  [switch]$PrintOnly,
  [string]$EdgePath = ''
)

$ErrorActionPreference = 'Stop'

function Find-Edge {
  param([string]$Given)
  if ($Given -ne '') {
    if ([System.IO.Path]::GetFileName($Given).ToLowerInvariant() -ne 'msedge.exe') {
      throw "GAGAL: -EdgePath mesti fail bernama msedge.exe: $Given (the file must be named msedge.exe)"
    }
    if (-not (Test-Path -LiteralPath $Given -PathType Leaf)) { throw "GAGAL: tidak dijumpai: $Given (not found)" }
    return [System.IO.Path]::GetFullPath($Given)
  }
  $candidates = @()
  try {
    $reg = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop).'(default)'
    if ($reg) { $candidates += [string]$reg }
  } catch { }
  $pf86 = ${env:ProgramFiles(x86)}
  if ($pf86) { $candidates += (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
  }
  throw 'GAGAL: Microsoft Edge tidak dijumpai pada PC ini. (Microsoft Edge was not found.)'
}

# ---- exit helper: loopback listener, token, request parsing, process-tree stop ---------------------------------

function New-ExitToken {
  $b = New-Object byte[] 32
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Start-ExitListener {
  # A raw TCP listener: no URL reservation (urlacl) is needed. Port 0 = a free port from the OS, loopback only.
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start()
  return $l
}

# Constant-time text compare (same length and same bytes, no early exit on the first difference).
function Test-TokenEqual([string]$A, [string]$B) {
  $x = [System.Text.Encoding]::ASCII.GetBytes($A)
  $y = [System.Text.Encoding]::ASCII.GetBytes($B)
  $diff = $x.Length -bxor $y.Length
  $n = [Math]::Max($x.Length, $y.Length)
  for ($i = 0; $i -lt $n; $i++) {
    $bx = 0; $by = 0
    if ($i -lt $x.Length) { $bx = $x[$i] }
    if ($i -lt $y.Length) { $by = $y[$i] }
    $diff = $diff -bor ($bx -bxor $by)
  }
  return ($diff -eq 0)
}

# Reads one request: at most 4 KB in total, 2 seconds in total. Returns @{ Method; Path; Body } or $null.
function Read-ExitRequest([System.Net.Sockets.TcpClient]$Client) {
  $max = 4096
  $stream = $Client.GetStream()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $buf = New-Object byte[] $max
  $have = 0
  $headEnd = -1
  $len = 0
  while ($have -lt $max) {
    $left = 2000 - [int]$sw.ElapsedMilliseconds
    if ($left -le 0) { return $null }
    $stream.ReadTimeout = $left
    try { $n = $stream.Read($buf, $have, $max - $have) } catch { return $null }
    if ($n -le 0) { break }
    $have += $n
    $text = [System.Text.Encoding]::ASCII.GetString($buf, 0, $have)
    $headEnd = $text.IndexOf("`r`n`r`n")
    if ($headEnd -ge 0) {
      $head = $text.Substring(0, $headEnd)
      $len = 0
      if ($head -match '(?im)^Content-Length:\s*(\d{1,6})\s*$') { $len = [int]$Matches[1] }
      if ($len -gt 512) { return $null }
      if ($have -ge ($headEnd + 4 + $len)) { break }
    }
  }
  if ($headEnd -lt 0) { return $null }
  $text = [System.Text.Encoding]::ASCII.GetString($buf, 0, $have)
  $head = $text.Substring(0, $headEnd)
  $first = ($head -split "`r`n")[0]
  if (-not ($first -match '^([A-Z]{3,8}) (\S{1,200}) HTTP/1\.[01]$')) { return $null }
  $method = $Matches[1]
  $path = $Matches[2]
  $body = $text.Substring($headEnd + 4)
  if ($body.Length -gt $len) { $body = $body.Substring(0, $len) }
  return @{ Method = $method; Path = $path; Body = $body }
}

function Send-ExitReply([System.Net.Sockets.TcpClient]$Client, [string]$Status) {
  try {
    $msg = "HTTP/1.1 $Status`r`nContent-Length: 0`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($msg)
    $Client.GetStream().Write($bytes, 0, $bytes.Length)
  } catch { }
}

# Serves at most one waiting connection. Returns $true after a valid exit request (answered 204, $OnExit run).
function Invoke-ExitListener([System.Net.Sockets.TcpListener]$Listener, [string]$Token, [scriptblock]$OnExit) {
  if (-not $Listener.Pending()) { return $false }
  $client = $Listener.AcceptTcpClient()
  $ok = $false
  try {
    $req = Read-ExitRequest $client
    if ($null -eq $req) { Send-ExitReply $client '400 Bad Request' }
    elseif ($req.Method -ne 'POST' -or $req.Path -ne '/exit') { Send-ExitReply $client '404 Not Found' }
    elseif ($null -eq $req.Body -or -not (Test-TokenEqual ([string]$req.Body) $Token)) { Send-ExitReply $client '400 Bad Request' }
    else { Send-ExitReply $client '204 No Content'; $ok = $true }
  } finally { $client.Close() }
  if ($ok) { & $OnExit }
  return $ok
}

# Stops one process and its children by PID (never by image name).
function Stop-ProcessTree([int]$ProcessId) {
  try { & "$env:SystemRoot\System32\taskkill.exe" /PID $ProcessId /T /F 2>&1 | Out-Null } catch { }
}

# Dot-sourced (by the tests) it only defines the functions above.
if ($MyInvocation.InvocationName -eq '.') { return }

$base = Join-Path $env:LOCALAPPDATA 'MAXCOM'
$profileDir = Join-Path $base 'kiosk-profile'
$stopFile = Join-Path $base 'kiosk-stop'
$url = "http://127.0.0.1:$Port/"
$healthUrl = "http://127.0.0.1:$Port/api/health"

$edge = Find-Edge $EdgePath
$edgeArgs = @(
  '--kiosk',
  $url,
  '--edge-kiosk-type=fullscreen',
  '--no-first-run',
  '--no-default-browser-check',
  '--kiosk-idle-timeout-minutes=0',
  '--autoplay-policy=no-user-gesture-required',
  "--user-data-dir=$profileDir"
)

if ($PrintOnly) {
  Write-Output "PROGRAM $edge"
  foreach ($a in $edgeArgs) { Write-Output "ARG $a" }
  Write-Output "HEALTH $healthUrl"
  Write-Output "STOPFILE $stopFile"
  Write-Output 'EXITHELPER loopback listener; #mxhost=<listener port>.<token> is added to the address'
  exit 0
}

function Test-BoxHealthy {
  try {
    $req = [System.Net.HttpWebRequest]::Create($healthUrl)
    $req.Method = 'GET'
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $req.Proxy = $null
    $resp = $req.GetResponse()
    try {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $sr.ReadToEnd()
      $sr.Close()
    } finally { $resp.Close() }
    $obj = $text | ConvertFrom-Json
    return ($obj.ok -eq $true)
  } catch { return $false }
}

function Wait-BoxHealthy([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $stopFile) { return $false }
    if (Test-BoxHealthy) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function ConvertTo-ArgText([string[]]$Items) {
  $parts = @()
  foreach ($i in $Items) {
    if ($i -match '[\s"]') { $parts += ('"' + ($i -replace '"', '\"') + '"') } else { $parts += $i }
  }
  return ($parts -join ' ')
}

New-Item -ItemType Directory -Force -Path $base | Out-Null
if (-not $Once -and (Test-Path -LiteralPath $stopFile)) { Remove-Item -LiteralPath $stopFile -Force }

$argText = ConvertTo-ArgText $edgeArgs

# One listener and one token for the whole session (Edge restarts reuse them). -Once has no exit helper.
$listener = $null
$token = ''
$launchArgText = $argText
if (-not $Once) {
  try {
    $token = New-ExitToken
    $listener = Start-ExitListener
    $hport = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $edgeArgsExit = @($edgeArgs | ForEach-Object { if ($_ -eq $url) { "$url#mxhost=$hport.$token" } else { $_ } })
    $launchArgText = ConvertTo-ArgText $edgeArgsExit
  } catch {
    # No helper is better than no kiosk: show the screen without the exit way.
    $listener = $null
    $launchArgText = $argText
  }
}

while ($true) {
  if (-not (Wait-BoxHealthy 180)) {
    if (Test-Path -LiteralPath $stopFile) { Write-Output 'Henti skrin MAXCOM diminta; berhenti.'; exit 0 }
    if ($Once) {
      Write-Output "GAGAL: kotak MAXCOM tidak menjawab di $healthUrl dalam 180 saat. (box did not answer in 180 seconds)"
      exit 1
    }
    continue
  }
  $p = Start-Process -FilePath $edge -ArgumentList $launchArgText -PassThru
  Write-Output "Skrin MAXCOM dimulakan: $edge (PID $($p.Id))"
  if ($Once) { exit 0 }
  $edgePid = $p.Id
  $leave = $false
  while (-not $p.HasExited) {
    if ($null -ne $listener) {
      if (Invoke-ExitListener $listener $token { Stop-ProcessTree $edgePid }) { $leave = $true; break }
    }
    Start-Sleep -Milliseconds 200
  }
  if ($leave) {
    try { $listener.Stop() } catch { }
    Write-Output 'Keluar ke Windows diminta dari skrin; skrin MAXCOM ditutup.'
    exit 0
  }
  if ($NoRestart) { exit 0 }
  if (Test-Path -LiteralPath $stopFile) { Write-Output 'Henti skrin MAXCOM diminta; berhenti.'; exit 0 }
  Start-Sleep -Seconds 5
  if (Test-Path -LiteralPath $stopFile) { Write-Output 'Henti skrin MAXCOM diminta; berhenti.'; exit 0 }
}
