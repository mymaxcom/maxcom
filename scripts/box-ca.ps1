<#
.SYNOPSIS
  MAXCOM PKI: root CA + box leaf certificate (IP mode). Windows PowerShell 5.1, built-ins only.

.DESCRIPTION
  Creates (or reuses) a root CA "MAXCOM Root CA <Surau>" (ECDSA P-256, 20 years), installs it in
  Cert:\LocalMachine\Root (so Edge on the box trusts it; needs an elevated prompt once), and issues a
  leaf for the box (ECDSA P-256, SAN IP:<Ip>, IP:127.0.0.1, DNS:localhost, DNS:box.surau.local,
  EKU server auth, at most 825 days). The root CA carries a CRITICAL NameConstraints extension that
  permits only the DNS names localhost and box.surau.local, so a stolen CA key cannot impersonate any
  other DNS name on the devices that trust it. The constraint is DNS-only ON PURPOSE: BoringSSL (the
  TLS stack of Flutter / the Android app) cannot verify IP-address name constraints and fails the
  handshake with "unsupported name constraint type"; OS and browser verifiers handle IP subtrees,
  but one root must work everywhere. Accepted trade-off: IP-address HTTPS endpoints are not limited
  by the root. The root does not depend on the box IP, so a box that moves to another IP only needs
  a new leaf (-Renew). A root made by an older version of this script (with IP subtrees) cannot be
  used by the Android app and is refused for -Renew: run without -Renew to make a new root and
  install it on every device. Writes:
    <DataDir>\secret\box.pfx        leaf + key (random 32-char passphrase)
    <DataDir>\secret\pfx.pass       the passphrase (never printed)
    <DataDir>\pki\box-leaf.cer      leaf, DER (the TLS loader reads SAN and expiry from it)
    <DataDir>\pki\root-ca.cer       root CA, DER (install on PCs and iPads)
    <DataDir>\pki\box-ca.json       how the leaf was made (ip, store, surau, days, noTrust; no secrets),
                                    read by scripts\box-cert-renew.ps1 for the automatic renewal
  <DataDir>\secret is restricted to the current user and SYSTEM.
  With -ServiceAccount (an installed box; ONLY S-1-5-19, LOCAL SERVICE, is accepted) the two folders get
  the ONE data ACL contract (module MaxcomSetup.psm1, Get-MaxcomAclContract), inheritance off:
    secret\ SYSTEM F, Administrators F, S-1-5-19 Modify on what is inside the folder (inherit-only) and
             only read/create/write-attributes on the folder itself: no DELETE, so the box account can
             neither rename nor replace the folder with a junction;
    pki\    SYSTEM F, Administrators F, S-1-5-19 Read and Execute; no Users entry.
  The running account keeps Full as well until setup applies the contract again (Set-MaxcomDataAcl).
  The account is recorded as a SID in box-ca.json. Without the parameter nothing changes.
  Nothing is written or locked when data, secret, pki or any folder above them is a reparse point
  (junction or symbolic link): the script stops with GAGAL. Every icacls call acts on the link itself (/L).
  The root lives 20 years; the leaf at most 825 days, and scripts\box-cert-renew.ps1 (daily scheduled
  task, see install-cert-renew-task.ps1) reissues it before it lapses, so devices never need to act.
  The CA private key stays in <Store>\My: run this script and the renewal as the SAME account.
  The box IP must be a DHCP reservation, or the certificate is wrong when the IP changes.

.PARAMETER Ip       Box LAN IP (IPv4 literal).
.PARAMETER DataDir  Data folder (default .\data).
.PARAMETER Days     Leaf validity in days, 1..825 (default 730).
.PARAMETER Renew    Reissue the leaf only (a root CA with the DNS-only constraint must already exist).
.PARAMETER Surau    Name used in the CA subject (default "Surau").
.PARAMETER Store    LocalMachine (default) or CurrentUser (tests).
.PARAMETER NoTrust  Do not install the root CA into the Trusted Root store (tests).
.PARAMETER ServiceAccount  Optional. Exactly S-1-5-19 (as a SID, or a name that resolves to it): the account
                    that runs the box. It gets the secret\ and pki\ contract above. Recorded as a SID.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Ip,
  [string]$DataDir = '.\data',
  [int]$Days = 730,
  [switch]$Renew,
  [string]$Surau = 'Surau',
  [ValidateSet('LocalMachine', 'CurrentUser')][string]$Store = 'LocalMachine',
  [switch]$NoTrust,
  [string]$ServiceAccount = ''
)

$ErrorActionPreference = 'Stop'

# ---- validate input -------------------------------------------------------
$addr = $null
if (-not [System.Net.IPAddress]::TryParse($Ip, [ref]$addr) -or
    $addr.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    $Ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
  throw "Ip must be an IPv4 address, got '$Ip'"
}
if ($Days -lt 1 -or $Days -gt 825) {
  throw 'Days must be between 1 and 825 (Apple limit for server certificates)'
}
if ($Surau -notmatch '^[A-Za-z0-9 ._-]{1,40}$') {
  throw 'Surau may only contain letters, digits, space, dot, underscore, hyphen (max 40)'
}
if ($Store -eq 'LocalMachine') {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    throw 'Run this script from an elevated (Administrator) PowerShell once; it installs the root CA into LocalMachine\Root.'
  }
}

# The service account is resolved to a SID before anything is written. Only a SID literal or a plain
# account name is accepted, so the value can never carry icacls syntax or shell text.
$svcSid = ''
if ($ServiceAccount -ne '') {
  try {
    if ($ServiceAccount -match '^S-1-\d{1,3}(-\d{1,10}){1,15}$') {
      $svcSid = (New-Object System.Security.Principal.SecurityIdentifier($ServiceAccount)).Value
    } elseif ($ServiceAccount -match '^[A-Za-z0-9 ._$-]{1,64}(\\[A-Za-z0-9 ._$-]{1,64})?$') {
      $svcSid = (New-Object System.Security.Principal.NTAccount($ServiceAccount)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
  } catch { $svcSid = '' }
  if ($svcSid -eq '') { throw "ServiceAccount must be a SID (S-1-...) or the name of an existing account, got '$ServiceAccount'" }
  # The box runs as LOCAL SERVICE and nothing else. Any other account would get Modify on the key folder.
  if ($svcSid -ne 'S-1-5-19') { throw "ServiceAccount must be exactly S-1-5-19 (LOCAL SERVICE), got '$ServiceAccount'" }
}

# ---- DER helpers: NameConstraints is built by hand (no built-in text form) ----
function Get-DerLength([int]$n) {
  if ($n -lt 128) { return [byte[]]@($n) }
  if ($n -lt 256) { return [byte[]]@(0x81, $n) }
  return [byte[]]@(0x82, ($n -shr 8), ($n -band 255))
}
function New-DerNode([byte]$tag, [byte[]]$content) {
  $list = New-Object 'System.Collections.Generic.List[byte]'
  $list.Add($tag)
  $list.AddRange([byte[]](Get-DerLength $content.Length))
  $list.AddRange($content)
  return ,$list.ToArray()
}
function Join-Bytes($parts) {
  $list = New-Object 'System.Collections.Generic.List[byte]'
  foreach ($part in $parts) { $list.AddRange([byte[]]$part) }
  return ,$list.ToArray()
}
function Get-NameConstraintsHex([string[]]$dnsNames) {
  $subtrees = @()
  foreach ($name in $dnsNames) {
    $base = New-DerNode 0x82 ([System.Text.Encoding]::ASCII.GetBytes($name))
    $subtrees += , (New-DerNode 0x30 $base)
  }
  $permitted = New-DerNode 0xA0 (Join-Bytes $subtrees)
  $all = New-DerNode 0x30 $permitted
  return (($all | ForEach-Object { $_.ToString('X2') }) -join '')
}
# The only names the root may vouch for. DNS only: BoringSSL cannot verify IP name constraints.
$caDnsNames = @('localhost', 'box.surau.local')
# True only for a root whose NameConstraints is exactly the DNS-only extension this script makes
# (an older root with IP subtrees, or one without the extension, is not usable by the Android app).
function Test-CaDnsOnly($cert) {
  $ext = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.30' } | Select-Object -First 1
  if ($null -eq $ext) { return $false }
  $hex = ($ext.RawData | ForEach-Object { $_.ToString('X2') }) -join ''
  return ($hex -eq (Get-NameConstraintsHex $caDnsNames))
}

$caSubject = "CN=MAXCOM Root CA $Surau"
$leafSubject = 'CN=MAXCOM Box'
$myStore = "Cert:\$Store\My"
$rootStore = "Cert:\$Store\Root"

if ([System.IO.Path]::IsPathRooted($DataDir)) { $dataFull = [System.IO.Path]::GetFullPath($DataDir) }
else { $dataFull = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $DataDir)) }
$secretDir = Join-Path $dataFull 'secret'
$pkiDir = Join-Path $dataFull 'pki'

# Refuse links first: this script may run as SYSTEM, and a junction planted at data, secret or pki (or above)
# would send the writes and the icacls below somewhere else. Checked again after the folders exist.
function Get-LinkProblem([string[]]$Paths) {
  $found = @()
  foreach ($p in $Paths) {
    $cur = $p
    while ($cur) {
      $isLink = $false
      try { $isLink = ((([int][System.IO.File]::GetAttributes($cur)) -band 0x400) -ne 0) } catch { $isLink = $false }
      if ($isLink) { $found += $cur }
      $cur = [System.IO.Path]::GetDirectoryName($cur)
    }
  }
  return @($found | Select-Object -Unique)
}
function Assert-NoLink {
  $bad = @(Get-LinkProblem @($dataFull, $secretDir, $pkiDir))
  if ($bad.Count -gt 0) { throw ("GAGAL: data, secret atau pki (atau folder di atasnya) ialah pautan (reparse point); tiada apa diubah: " + ($bad -join ', ')) }
}
Assert-NoLink
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
New-Item -ItemType Directory -Force -Path $pkiDir | Out-Null
Assert-NoLink

# ---- lock down data\secret BEFORE any secret is written -------------------
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($svcSid -eq '') {
  & icacls.exe $secretDir /inheritance:r /grant:r "${me}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed on the secret folder' }
} else {
  # Installed box: the one contract (see the help). Each folder in ONE icacls call, so there is no moment
  # in which it is open to more than the contract. The two S-1-5-19 entries on secret\ are an inherit-only
  # Modify (the files inside) and a folder-only RX,WD,AD,WEA,WA (no DELETE on the folder itself).
  & icacls.exe $secretDir /inheritance:r /grant:r "${me}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${svcSid}:(OI)(CI)(IO)M" "*${svcSid}:(RX,WD,AD,WEA,WA)" /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed on the secret folder' }
  & icacls.exe $pkiDir /inheritance:r /grant:r "${me}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${svcSid}:(OI)(CI)RX" /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed on the pki folder' }
}

# ---- root CA --------------------------------------------------------------
$ca = Get-ChildItem $myStore | Where-Object { $_.Subject -eq $caSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(60) -and (Test-CaDnsOnly $_) } |
  Sort-Object NotAfter -Descending | Select-Object -First 1

if ($null -eq $ca) {
  if ($Renew) { throw 'Renew requested but no usable root CA exists. A root CA made before the DNS-only NameConstraints (no constraint, or IP subtrees) cannot be renewed and cannot be used by the Android app: run without -Renew to create a new root CA, then install it on every device.' }
  $nameConstraints = '2.5.29.30={critical}{hex}' + (Get-NameConstraintsHex $caDnsNames)
  $ca = New-SelfSignedCertificate -Subject $caSubject `
    -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy NonExportable -KeyUsage CertSign, CRLSign `
    -TextExtension @('2.5.29.19={critical}{text}ca=true', $nameConstraints) `
    -NotAfter (Get-Date).AddYears(20) `
    -CertStoreLocation $myStore
}

if (-not $NoTrust) {
  $trusted = Get-ChildItem $rootStore | Where-Object { $_.Thumbprint -eq $ca.Thumbprint }
  if ($null -eq $trusted) {
    $tmpCa = Join-Path $pkiDir 'root-ca.tmp.cer'
    Export-Certificate -Cert $ca -FilePath $tmpCa -Type CERT | Out-Null
    Import-Certificate -FilePath $tmpCa -CertStoreLocation $rootStore | Out-Null
    Remove-Item $tmpCa -Force
  }
}

# ---- leaf -----------------------------------------------------------------
$sanIps = @($Ip)
if ($Ip -ne '127.0.0.1') { $sanIps += '127.0.0.1' }
$san = '2.5.29.17={text}' + ((@($sanIps | ForEach-Object { "IPAddress=$_" }) + @('DNS=localhost', 'DNS=box.surau.local')) -join '&')
$leaf = New-SelfSignedCertificate -Subject $leafSubject `
  -Signer $ca `
  -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
  -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
  -TextExtension @($san, '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={critical}{text}ca=false') `
  -NotAfter (Get-Date).AddDays($Days) `
  -CertStoreLocation $myStore

# ---- passphrase: random 32 chars, written to file, never printed ----------
$alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$bytes = New-Object byte[] 64
$chars = New-Object System.Text.StringBuilder
while ($chars.Length -lt 32) {
  $rng.GetBytes($bytes)
  foreach ($b in $bytes) {
    # rejection sampling avoids modulo bias
    if ($b -lt (256 - (256 % $alphabet.Length)) -and $chars.Length -lt 32) {
      [void]$chars.Append($alphabet[$b % $alphabet.Length])
    }
  }
}
$rng.Dispose()
$phrase = $chars.ToString()
$phraseSecure = ConvertTo-SecureString -String $phrase -AsPlainText -Force

$pfxPath = Join-Path $secretDir 'box.pfx'
$phraseFile = Join-Path $secretDir 'pfx.pass'
Export-PfxCertificate -Cert $leaf -FilePath $pfxPath -Password $phraseSecure | Out-Null
[System.IO.File]::WriteAllText($phraseFile, $phrase, (New-Object System.Text.ASCIIEncoding))
$phrase = $null
$chars.Clear() | Out-Null

# ---- public exports -------------------------------------------------------
Export-Certificate -Cert $leaf -FilePath (Join-Path $pkiDir 'box-leaf.cer') -Type CERT | Out-Null
$rootCer = Join-Path $pkiDir 'root-ca.cer'
Export-Certificate -Cert $ca -FilePath $rootCer -Type CERT | Out-Null

# The leaf key now lives in the PFX; remove the leaf (and its key) from the Windows store.
Remove-Item -Path ("{0}\{1}" -f $myStore, $leaf.Thumbprint) -DeleteKey -Force

$sha = [System.Security.Cryptography.SHA256]::Create()
$fp = ($sha.ComputeHash([System.IO.File]::ReadAllBytes($rootCer)) | ForEach-Object { $_.ToString('X2') }) -join ':'
$sha.Dispose()

Write-Output "Root CA   : $($ca.Subject)"
Write-Output "Root file : $rootCer"
Write-Output "Root sha256 fingerprint: $fp"
Write-Output "Box leaf  : valid until $($leaf.NotAfter.ToString('yyyy-MM-dd')) for IP $Ip"
# Record how this leaf was made (no secrets) so the scheduled renewal can repeat it unattended.
$meta = [ordered]@{ ip = $Ip; store = $Store; surau = $Surau; days = $Days; noTrust = [bool]$NoTrust }
if ($svcSid -ne '') { $meta['serviceAccount'] = $svcSid }
[System.IO.File]::WriteAllText((Join-Path $pkiDir 'box-ca.json'), ($meta | ConvertTo-Json), (New-Object System.Text.ASCIIEncoding))

Write-Output "PFX       : $pfxPath (passphrase stored in $phraseFile)"
if (-not $Renew) { Write-Output 'Install root-ca.cer on every PC/iPad; on iPadOS also enable full trust in Certificate Trust Settings.' }
