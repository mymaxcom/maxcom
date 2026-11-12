<#
.SYNOPSIS
  MAXCOM box: remove the installed software from this PC ("Buang MAXCOM"). Keeps the surau's data.
  Windows PowerShell 5.1, ASCII only, built-ins only.

.DESCRIPTION
  Removes the scheduled tasks, firewall rules, Start menu folder, Apps list entry, the admin-only
  firewall copy, restores the power settings, stops the processes that run from the install root (by PID,
  after showing the command line) and removes the install root.

  Kept unless asked: the data folder named in box-config.json, backups\ beside it, the root CA in
  LocalMachine\Root and its key in LocalMachine\My (a reinstall on this PC reuses them).
    -RemoveData  also removes the data folder and backups\ (needs the typed word BUANG DATA).
    -RemoveCa    also removes the root CA and its key (needs the typed word BUANG SIJIL). The thumbprint
                 is the one recorded in state\install.json at install time (an admin-only folder); a
                 certificate is removed only when its subject starts with "CN=MAXCOM Root CA". It fails,
                 and does not print success, when the private key could not be deleted.
  -ConfirmText gives the typed word(s) on the command line; without it they are asked for, and with -Yes
  but no word the request is refused and nothing is removed.

  The install root is accepted only when it holds state\install.json (written by setup) and launcher.mjs.
  Every delete goes through Remove-TreeSafe / Remove-JunctionSafe of MaxcomSetup.psm1: links are removed
  as links and never followed. The script is read whole by PowerShell before it runs, so removing its own
  folder (<root>\bin) is safe.

  Started as a normal user it asks Windows for administrator rights itself (a new window opens: allow
  it), like Pasang MAXCOM. -DryRun and -LayoutOnly never ask.

  -DryRun    prints what would go and what stays; changes nothing, needs no elevation.
  -LayoutOnly  files and junctions only, in any folder, no elevation: skips tasks, firewall, power, Start
               menu, registry, processes and certificates (it exists for tests).
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [switch]$RemoveData,
  [switch]$RemoveCa,
  [switch]$Yes,
  [string[]]$ConfirmText = @(),
  [switch]$LayoutOnly,
  [switch]$DryRun,
  [switch]$PauseAtEnd,
  [ValidateSet('LocalMachine', 'CurrentUser')][string]$StoreLocation = 'LocalMachine'
)

$ErrorActionPreference = 'Stop'
$script:Bound = $PSBoundParameters
Import-Module -Name (Join-Path $PSScriptRoot 'MaxcomSetup.psm1') -Force

$WordData = 'BUANG DATA'
$WordCa = 'BUANG SIJIL'
$TaskNames = @('MAXCOM Kiosk', 'MAXCOM Box', 'MaxcomCertRenew', 'MAXCOM Live Firewall')
$RuleNames = @('MAXCOM Live WebRTC', 'MAXCOM Live SRT', 'MAXCOM Box HTTPS')

function Exit-Script([int]$Code) {
  # In the window opened by self-elevation the text must stay readable until a key is pressed.
  if ($PauseAtEnd) { try { Read-Host 'Tekan Enter untuk tutup' | Out-Null } catch { } }
  exit $Code
}

function Stop-Here([string]$Text) {
  Write-Host "GAGAL: $Text"
  Exit-Script 1
}

function ConvertTo-QuotedArg([string]$Value) {
  if ($Value.Contains('"')) { throw "nilai tidak boleh mengandungi tanda petik: $Value" }
  if ($Value.EndsWith('\')) { $Value = $Value + '\' }
  return ('"' + $Value + '"')
}

function Start-Elevated {
  # Same method as setup.ps1: an argument ARRAY for Start-Process, every value quoted on its own.
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-QuotedArg $PSCommandPath))
  foreach ($k in $script:Bound.Keys) {
    if ($k -eq 'PauseAtEnd') { continue }
    $v = $script:Bound[$k]
    if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $a += "-$k" } }
    elseif ($v -is [System.Array]) {
      if ($v.Count -gt 0) { $a += "-$k"; foreach ($e in $v) { $a += (ConvertTo-QuotedArg ([string]$e)) } }
    }
    else { $a += "-$k"; $a += (ConvertTo-QuotedArg ([string]$v)) }
  }
  $a += '-PauseAtEnd'
  Write-Host 'Membuang MAX Kiosk Server memerlukan hak pentadbir. Tetingkap baharu akan dibuka; sila benarkan (Yes).'
  try {
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $a -Verb RunAs -Wait -PassThru
  } catch {
    Write-Host 'GAGAL: hak pentadbir tidak diberi. Klik kanan Buang MAXCOM dan pilih Run as administrator. Tiada apa yang dibuang.'
    return 1
  }
  return [int]$p.ExitCode
}

function Remove-CertPrivateKey($Cert) {
  # Deletes the key container behind a certificate (CNG ECDSA or RSA, or a legacy CSP RSA). True when a key was deleted.
  $deleted = $false
  $ec = $null
  try { $ec = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Cert) } catch { $ec = $null }
  if ($ec -is [System.Security.Cryptography.ECDsaCng]) { $ec.Key.Delete(); $deleted = $true }
  if (-not $deleted) {
    $rsa = $null
    try { $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Cert) } catch { $rsa = $null }
    if ($rsa -is [System.Security.Cryptography.RSACng]) { $rsa.Key.Delete(); $deleted = $true }
    elseif ($rsa -is [System.Security.Cryptography.RSACryptoServiceProvider]) { $rsa.PersistKeyInCsp = $false; $rsa.Clear(); $deleted = $true }
  }
  return $deleted
}

function Remove-MaxcomRootCa {
  # Removes the MAXCOM root CA (Root store) and its key (My store) by the recorded thumbprint. Everything is
  # checked before anything is removed: the certificate subject must start with "CN=MAXCOM Root CA". Throws
  # when a private key could not be deleted (the certificate is then left in place so it can be retried).
  param([Parameter(Mandatory)][string]$Thumbprint, [string]$Location = 'LocalMachine')
  if ($Thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'cap jari sijil tidak sah' }
  $want = $Thumbprint.ToUpperInvariant()
  $found = @()
  foreach ($loc in @('Root', 'My')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $loc, $Location
    $store.Open('ReadWrite')
    try {
      foreach ($c in @($store.Certificates | Where-Object { $_.Thumbprint -eq $want })) {
        if ($c.Subject -notlike 'CN=MAXCOM Root CA*') {
          throw "cap jari $Thumbprint ialah sijil '$($c.Subject)', bukan MAXCOM Root CA: tidak dibuang"
        }
        $found += [pscustomobject]@{ Store = $loc; Cert = $c }
      }
    } finally { $store.Close() }
  }
  $removed = 0
  $keys = 0
  foreach ($f in $found) {
    if ($f.Store -eq 'My' -and $f.Cert.HasPrivateKey) {
      if (-not (Remove-CertPrivateKey $f.Cert)) { throw 'kunci peribadi sijil root CA tidak dapat dibuang; sijil dibiarkan' }
      $keys++
    }
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $f.Store, $Location
    $store.Open('ReadWrite')
    try { $store.Remove($f.Cert); $removed++ } finally { $store.Close() }
  }
  foreach ($loc in @('Root', 'My')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $loc, $Location
    $store.Open('ReadOnly')
    try {
      if (@($store.Certificates | Where-Object { $_.Thumbprint -eq $want }).Count -gt 0) {
        throw "sijil $Thumbprint masih ada dalam $Location\$loc selepas dibuang"
      }
    } finally { $store.Close() }
  }
  return [pscustomobject]@{ Removed = $removed; KeysDeleted = $keys }
}

function Test-Inside([string]$Child, [string]$Parent) {
  $c = (ConvertTo-FullPath $Child).TrimEnd('\') + '\'
  $p = (ConvertTo-FullPath $Parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
}

function Read-Confirm([string]$Question) {
  Write-Host $Question
  try { $a = Read-Host } catch { return $false }
  return ([string]$a -ceq 'y')
}

function Read-Word([string]$Word) {
  # The word is given with -ConfirmText, or typed. Case-sensitive; no partial match.
  foreach ($w in $ConfirmText) { if ([string]$w -ceq $Word) { return $true } }
  if ($Yes -or $DryRun) { return $false }
  Write-Host "Taip $Word untuk mengesahkan:"
  try { $a = Read-Host } catch { return $false }
  return ([string]$a -ceq $Word)
}

# --- leave the folder we may be started from, so it can be removed ---------------------------------
try {
  Set-Location -LiteralPath $env:TEMP
  [System.Environment]::CurrentDirectory = $env:TEMP
} catch { }

# --- 0. check everything before anything is changed ------------------------------------------------
if ($InstallRoot -eq '') { $InstallRoot = Join-Path $env:ProgramFiles 'MAXCOM' }
$relaxed = ($LayoutOnly -or $DryRun)
try {
  $rootProblems = @(Get-InstallRootProblem $InstallRoot -AllowUserProfile:$relaxed)
} catch { Stop-Here $_.Exception.Message }
if ($rootProblems.Count -gt 0) { Stop-Here ($rootProblems -join '; ') }
$root = ConvertTo-FullPath $InstallRoot

if (-not (Test-Path -LiteralPath $root -PathType Container)) { Stop-Here "folder pemasangan tiada: $root" }
$stateDir = Join-Path $root 'state'
$stateFile = Join-Path $stateDir 'install.json'
$launcher = Join-Path $root 'launcher.mjs'
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  Stop-Here "$root bukan pemasangan MAXCOM (state\install.json atau launcher.mjs tiada). Tiada apa yang dibuang."
}
if ((Test-IsReparsePoint $stateDir) -or (Test-IsReparsePoint $stateFile) -or (Test-IsReparsePoint $launcher)) {
  Stop-Here "state\install.json atau launcher.mjs ialah pautan: $root. Tiada apa yang dibuang."
}
try {
  $state = [string](Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8) | ConvertFrom-Json
} catch { Stop-Here "state\install.json tidak sah. Tiada apa yang dibuang." }
if ($null -eq $state -or $null -eq $state.v) { Stop-Here "state\install.json tidak sah. Tiada apa yang dibuang." }
if ($null -ne $state.installRoot -and [string]$state.installRoot -ne '') {
  try { $recorded = ConvertTo-FullPath ([string]$state.installRoot) } catch { $recorded = '' }
  if ($recorded -ne '' -and -not $recorded.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    Stop-Here "state\install.json menyebut folder lain ($recorded). Tiada apa yang dibuang."
  }
}

# data folder: the one named in box-config.json
$cfgFile = Join-Path $root 'box-config.json'
$dataDir = ''
if (Test-Path -LiteralPath $cfgFile -PathType Leaf) {
  try {
    $cfg = [string](Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($null -ne $cfg.dataDir) { $dataDir = [string]$cfg.dataDir }
  } catch { Stop-Here "box-config.json tidak sah. Tiada apa yang dibuang." }
}
$paths = $null
if ($dataDir -ne '') {
  try { $paths = Get-MaxcomPaths -InstallRoot $root -DataDir $dataDir } catch { Stop-Here $_.Exception.Message }
  if ((Test-Inside $paths.DataDir $root) -or (Test-Inside $root $paths.DataDir)) {
    Stop-Here "folder data dan folder pemasangan tidak boleh berada di dalam satu sama lain. Tiada apa yang dibuang."
  }
  if (Test-IsReparsePoint $paths.DataDir) { Stop-Here "folder data ialah pautan: $($paths.DataDir). Tiada apa yang dibuang." }
} else {
  $paths = Get-MaxcomPaths -InstallRoot $root
  if ($RemoveData -or $RemoveCa) { Stop-Here "box-config.json tidak menyebut folder data, -RemoveData dan -RemoveCa ditolak. Tiada apa yang dibuang." }
}
$data = $paths.DataDir

# what the data options are allowed to touch
$backupsOk = $false
if ($RemoveData) {
  if ($dataDir -eq '') { Stop-Here "folder data tidak diketahui." }
  $markers = @('surau.db', 'pki', 'secret', 'logs', 'assets')
  $hasMarker = $false
  foreach ($m in $markers) { if (Test-Path -LiteralPath (Join-Path $data $m)) { $hasMarker = $true } }
  if ((Test-Path -LiteralPath $data) -and -not $hasMarker) {
    Stop-Here "$data tidak kelihatan seperti folder data MAXCOM, tidak dibuang. Tiada apa yang dibuang."
  }
  $protected = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:SystemDrive + '\Users', $env:USERPROFILE)
  foreach ($pr in $protected) {
    if ($pr -and $data.TrimEnd('\').Equals($pr.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
      Stop-Here "folder data ialah folder sistem ($data), tidak dibuang. Tiada apa yang dibuang."
    }
  }
  $backupsOk = $true
  if (Test-Path -LiteralPath $paths.Backups) {
    if ((Test-IsReparsePoint $paths.Backups) -or (Test-Inside $paths.Backups $root) -or (Test-Inside $root $paths.Backups)) { $backupsOk = $false }
    else {
      foreach ($c in [System.IO.Directory]::GetFileSystemEntries($paths.Backups)) {
        if ((Split-Path -Leaf $c) -notmatch '^pre-') { $backupsOk = $false }
      }
    }
  }
}

# administrator rights: ask for them now (before any question), like setup.ps1
if (-not $DryRun -and -not $LayoutOnly -and -not (Test-MaxcomElevated)) {
  $code = Start-Elevated
  exit $code
}

# typed words and the one question
$haveData = $true
$haveCa = $true
if ($RemoveData) { $haveData = (Read-Word $WordData) }
if ($RemoveCa) { $haveCa = (Read-Word $WordCa) }
if (-not $DryRun) {
  if ($RemoveData -and -not $haveData) { Stop-Here "-RemoveData perlukan perkataan $WordData (-ConfirmText '$WordData'). Tiada apa yang dibuang." }
  if ($RemoveCa -and -not $haveCa) { Stop-Here "-RemoveCa perlukan perkataan $WordCa (-ConfirmText '$WordCa'). Tiada apa yang dibuang." }
  if (-not $LayoutOnly -and -not (Test-MaxcomElevated)) { Stop-Here "perlukan Run as administrator. Tiada apa yang dibuang." }
  if (-not $Yes) {
    if ($RemoveData) { $q = 'Buang perisian MAX Kiosk Server dari PC ini? Data surau AKAN DIBUANG. (y/t)' }
    else { $q = 'Buang perisian MAX Kiosk Server dari PC ini? Data surau DIKEKALKAN. (y/t)' }
    if (-not (Read-Confirm $q)) { Write-Host 'Dibatalkan. Tiada apa yang dibuang.'; Exit-Script 2 }
  }
}

# --- 1. the steps ----------------------------------------------------------------------------------
function Get-RootProcesses {
  # Processes whose program file lives inside the install root. Never by name.
  $found = @()
  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
    if ($null -eq $p.ExecutablePath -or $p.ExecutablePath -eq '') { continue }
    if ($p.ProcessId -eq $PID) { continue }
    if (Test-Inside $p.ExecutablePath $root) { $found += $p }
  }
  return $found
}

if (-not $LayoutOnly) {
  Invoke-Step -Name 'tugas berjadual' -DryRun:$DryRun -Describe ("buang tugas: " + ($TaskNames -join ', ')) -Action {
    $changed = $false
    foreach ($n in $TaskNames) {
      $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -eq '\' }
      if ($null -eq $t) { continue }
      try { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue } catch { }
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      $changed = $true
    }
    $changed
  } | Out-Null

  Invoke-Step -Name 'proses MAXCOM' -DryRun:$DryRun -Describe 'henti proses (ikut PID) yang dijalankan dari folder pemasangan, dan Edge skrin MAXCOM' -Action {
    $changed = $false
    foreach ($p in (Get-RootProcesses)) {
      Write-Host ("  henti PID {0}: {1}" -f $p.ProcessId, $p.CommandLine)
      Stop-Process -Id ([int]$p.ProcessId) -Force
      $changed = $true
    }
    foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue)) {
      $cl = [string]$p.CommandLine
      if ($cl.IndexOf('\MAXCOM\kiosk-profile', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      Write-Host ("  henti Edge PID {0}: {1}" -f $p.ProcessId, $cl)
      Stop-Process -Id ([int]$p.ProcessId) -Force
      $changed = $true
    }
    if ($changed) { Start-Sleep -Seconds 2 }
    $changed
  } | Out-Null

  Invoke-Step -Name 'peraturan firewall' -DryRun:$DryRun -Describe ("buang peraturan: " + ($RuleNames -join ', ')) -Action {
    $changed = $false
    foreach ($n in $RuleNames) {
      $rules = @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $n })
      foreach ($r in $rules) { Remove-NetFirewallRule -Name $r.Name; $changed = $true }
    }
    $changed
  } | Out-Null

  Invoke-Step -Name 'tetapan kuasa' -DryRun:$DryRun -Describe 'pulihkan tetapan kuasa dari state\power-before.json' -Action {
    if (-not (Test-Path -LiteralPath $paths.PowerBefore -PathType Leaf)) { return $false }
    $script = $null
    foreach ($d in @($PSScriptRoot, (Join-Path $root 'bin'))) {
      $c = Join-Path $d 'set-box-power.ps1'
      if (Test-Path -LiteralPath $c -PathType Leaf) { $script = $c; break }
    }
    if ($null -eq $script) { Write-Step 'LANGKAU' 'tetapan kuasa' 'set-box-power.ps1 tiada, tetapan kuasa tidak dipulihkan'; return $false }
    $ps = Join-Path $PSHOME 'powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Restore -StateFile $paths.PowerBefore
    if ($LASTEXITCODE -ne 0) { throw "set-box-power.ps1 -Restore gagal (kod $LASTEXITCODE)" }
    $true
  } | Out-Null

  Invoke-Step -Name 'menu Start dan senarai Apps' -DryRun:$DryRun -Describe 'buang folder menu Start MAXCOM, entri senarai Apps dan salinan ensure-live-firewall.ps1' -Action {
    $changed = $false
    $sm = $paths.StartMenu
    if ((Split-Path -Leaf $sm) -ceq 'MAXCOM' -and (Test-Path -LiteralPath $sm)) {
      if (Remove-TreeSafe $sm -Under (Split-Path -Parent $sm)) { $changed = $true }
    }
    $key = $paths.UninstallKey
    if (Test-Path -LiteralPath $key) {
      $us = [string](Get-ItemProperty -LiteralPath $key -Name UninstallString -ErrorAction SilentlyContinue).UninstallString
      if ($us.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\MAXCOM', $false)
        $changed = $true
      } else {
        Write-Step 'LANGKAU' 'senarai Apps' 'entri MAXCOM menunjuk ke pemasangan lain, tidak dibuang'
      }
    }
    $home1 = Join-Path $env:ProgramData 'MAXCOM'
    $fw = Join-Path $home1 'ensure-live-firewall.ps1'
    if (Test-Path -LiteralPath $fw) { if (Remove-TreeSafe $fw -Under $home1) { $changed = $true } }
    $changed
  } | Out-Null

  if ($RemoveCa) {
    Invoke-Step -Name 'sijil root CA' -DryRun:$DryRun -Describe 'buang root CA dan kuncinya (cap jari dari state\install.json; hanya sijil CN=MAXCOM Root CA*)' -Action {
      # the thumbprint recorded by setup in state\install.json (admin-only folder); never read from the data folder
      $thumb = ''
      if ($null -ne $state.rootThumbprint) { $thumb = ([string]$state.rootThumbprint).Trim() }
      if ($thumb -eq '') {
        # installed before the thumbprint was recorded: the root certificate file; the subject check in the store still decides
        $cer = Join-Path $paths.Pki 'root-ca.cer'
        if (-not (Test-Path -LiteralPath $cer -PathType Leaf)) {
          Write-Step 'LANGKAU' 'sijil root CA' 'cap jari tidak direkodkan dan pki\root-ca.cer tiada, sijil tidak dibuang'
          return $false
        }
        $thumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $cer).Thumbprint
      }
      $r = Remove-MaxcomRootCa -Thumbprint $thumb -Location $StoreLocation
      Write-Host ("  sijil dibuang: {0}, kunci dibuang: {1}" -f $r.Removed, $r.KeysDeleted)
      ($r.Removed -gt 0)
    } | Out-Null
  }
}

# links first, checked gone; then the tree
Invoke-Step -Name 'pautan' -DryRun:$DryRun -Describe 'buang pautan current dan node_modules\@surau\* sebagai pautan (sasaran tidak disentuh)' -Action {
  $changed = $false
  $cur = $paths.Current
  if ((Test-Path -LiteralPath $cur) -or (Test-IsReparsePoint $cur)) {
    if (Test-IsReparsePoint $cur) { if (Remove-JunctionSafe $cur) { $changed = $true } }
  }
  if (Test-Path -LiteralPath $paths.Releases -PathType Container) {
    foreach ($rel in [System.IO.Directory]::GetDirectories($paths.Releases)) {
      if (Test-IsReparsePoint $rel) { if (Remove-JunctionSafe $rel) { $changed = $true }; continue }
      $scope = Join-Path $rel 'node_modules\@surau'
      if (Test-Path -LiteralPath $scope -PathType Container) {
        if (Test-IsReparsePoint $scope) { if (Remove-JunctionSafe $scope) { $changed = $true }; continue }
        foreach ($l in [System.IO.Directory]::GetFileSystemEntries($scope)) {
          if (Test-IsReparsePoint $l) { if (Remove-JunctionSafe $l) { $changed = $true } }
        }
      }
    }
  }
  if (Test-IsReparsePoint $paths.Current) { throw 'current masih ada' }
  $changed
} | Out-Null

Invoke-Step -Name 'folder pemasangan' -DryRun:$DryRun -Describe "buang $root" -Action {
  [bool](Remove-TreeSafe $root -Under $root)
} | Out-Null

if ($RemoveData) {
  Invoke-Step -Name 'data surau' -DryRun:$DryRun -Describe "buang $data dan backups (perkataan $WordData $(if ($haveData) { 'diberi' } else { 'BELUM diberi: akan ditolak' }))" -Action {
    $changed = $false
    if (Test-Path -LiteralPath $data) { if (Remove-TreeSafe $data -Under $paths.MaxcomHome) { $changed = $true } }
    if ($backupsOk) {
      if (Test-Path -LiteralPath $paths.Backups) { if (Remove-TreeSafe $paths.Backups -Under $paths.MaxcomHome) { $changed = $true } }
    } else {
      Write-Step 'LANGKAU' 'backups' "$($paths.Backups) mengandungi bukan salinan MAXCOM (pre-*), tidak dibuang"
    }
    $changed
  } | Out-Null
}

# --- 2. what stays ---------------------------------------------------------------------------------
if ($DryRun) { Write-Host 'DRYRUN selesai: tiada apa yang diubah.' }
else { Write-Host 'Perisian MAX Kiosk Server telah dibuang.' }
if ($dataDir -ne '') {
  if ($RemoveData) {
    Write-Host "DIBUANG: data surau di $data"
  } else {
    Write-Host "KEKAL: data surau di $data"
    Write-Host "KEKAL: salinan simpanan di $($paths.Backups)"
  }
}
if (-not $LayoutOnly) {
  if ($RemoveCa) { Write-Host 'DIBUANG: sijil root CA MAXCOM dan kuncinya.' }
  else { Write-Host 'KEKAL: sijil root CA MAXCOM (LocalMachine\Root) dan kuncinya; pasang semula di PC ini tidak memerlukan apa-apa pada telefon.' }
}
Exit-Script 0
