<#
.SYNOPSIS
  MAXCOM: regenerate the TLS test fixtures (certificates and PFX files). Windows PowerShell 5.1.

.DESCRIPTION
  Makes, with New-SelfSignedCertificate in Cert:\CurrentUser\My (every certificate is removed from
  the store again at the end), the fixtures that tests load:

    apps\box-server\test\fixtures\test-box.pfx, test-box-leaf.cer     leaf signed by "MAXCOM Root CA TestFixture", pass "test"
    apps\box-server\test\fixtures\test-box2.pfx, test-box2-leaf.cer   self-signed CA:TRUE leaf, SAN also 10.168.1.60, pass "test"
    apps\surau-app\test\fixtures\tls\box.pfx, root-ca.cer             plain root + leaf, pass "test"
    apps\surau-app\test\fixtures\tls-nc\box.pfx, root-ca.cer          root with DNS-only NameConstraints (as scripts\box-ca.ps1), pass from pfx.pass
    apps\surau-app\test\fixtures\tls-nc\ip-box.pfx, ip-root-ca.cer    older root that also permits IP:127.0.0.1/32, pass from ip-pfx.pass

  apps\surau-app\test\fixtures\tls\untrusted.pfx    a self-signed certificate no root issued (for the trust test), pass "test"
  Existing pass files are kept. Run from the repo root:  powershell -NoProfile -File scripts\gen-test-pki.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$store = 'Cert:\CurrentUser\My'
$made = New-Object System.Collections.ArrayList

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
# NameConstraints permitted subtrees: DNS names, plus optional IPv4 /32 entries.
function Get-NameConstraintsHex([string[]]$dnsNames, [string[]]$ips) {
  $subtrees = @()
  foreach ($name in $dnsNames) {
    $base = New-DerNode 0x82 ([System.Text.Encoding]::ASCII.GetBytes($name))
    $subtrees += , (New-DerNode 0x30 $base)
  }
  foreach ($ip in $ips) {
    $addr = [System.Net.IPAddress]::Parse($ip).GetAddressBytes()
    $base = New-DerNode 0x87 ([byte[]]($addr + [byte[]]@(255, 255, 255, 255)))
    $subtrees += , (New-DerNode 0x30 $base)
  }
  $permitted = New-DerNode 0xA0 (Join-Bytes $subtrees)
  $all = New-DerNode 0x30 $permitted
  return (($all | ForEach-Object { $_.ToString('X2') }) -join '')
}

function New-Root([string]$subject, [string[]]$extra, [int]$years) {
  $ext = @('2.5.29.19={critical}{text}ca=true') + $extra
  $c = New-SelfSignedCertificate -Subject $subject -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign -TextExtension $ext `
    -NotAfter (Get-Date).AddYears($years) -CertStoreLocation $store
  [void]$made.Add($c.Thumbprint)
  return $c
}
function New-Leaf($signer, [string]$subject, [string[]]$ips, [int]$days) {
  $san = '2.5.29.17={text}' + ((@($ips | ForEach-Object { "IPAddress=$_" }) + @('DNS=localhost', 'DNS=box.surau.local')) -join '&')
  $c = New-SelfSignedCertificate -Subject $subject -Signer $signer -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
    -TextExtension @($san, '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={critical}{text}ca=false') `
    -NotAfter (Get-Date).AddDays($days) -CertStoreLocation $store
  [void]$made.Add($c.Thumbprint)
  return $c
}
function Save-Pfx($cert, [string]$path, [string]$pass, [string]$chain) {
  $sec = ConvertTo-SecureString -String $pass -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $path -Password $sec -ChainOption $chain | Out-Null
}
function Save-Cer($cert, [string]$path) {
  Export-Certificate -Cert $cert -FilePath $path -Type CERT | Out-Null
}
function Read-Pass([string]$path) { return ([System.IO.File]::ReadAllText($path)).Trim() }

try {
  # ---- box-server fixtures --------------------------------------------------
  $bs = Join-Path $root 'apps\box-server\test\fixtures'
  $ca = New-Root 'CN=MAXCOM Root CA TestFixture' @() 10
  # 800 days: the "at most 825 days valid" test measures from the moment it runs.
  $leaf = New-Leaf $ca 'CN=MAXCOM Box' @('127.0.0.1') 800
  Save-Pfx $leaf (Join-Path $bs 'test-box.pfx') 'test' 'EndEntityCertOnly'
  Save-Cer $leaf (Join-Path $bs 'test-box-leaf.cer')

  $san2 = '2.5.29.17={text}IPAddress=10.168.1.60&IPAddress=127.0.0.1&DNS=localhost&DNS=box.surau.local'
  $self = New-SelfSignedCertificate -Subject 'CN=MAXCOM Box' -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -TextExtension @($san2, '2.5.29.19={critical}{text}ca=true') `
    -NotAfter (Get-Date).AddYears(10) -CertStoreLocation $store
  [void]$made.Add($self.Thumbprint)
  Save-Pfx $self (Join-Path $bs 'test-box2.pfx') 'test' 'EndEntityCertOnly'
  Save-Cer $self (Join-Path $bs 'test-box2-leaf.cer')

  # ---- surau-app: tls -------------------------------------------------------
  $tls = Join-Path $root 'apps\surau-app\test\fixtures\tls'
  $ca = New-Root 'CN=MAXCOM Root CA Surau' @() 10
  $leaf = New-Leaf $ca 'CN=MAXCOM Box' @('127.0.0.1') 730
  Save-Pfx $leaf (Join-Path $tls 'box.pfx') (Read-Pass (Join-Path $tls 'pfx.pass')) 'EndEntityCertOnly'
  Save-Cer $ca (Join-Path $tls 'root-ca.cer')

  # ---- surau-app: tls-nc ----------------------------------------------------
  $nc = Join-Path $root 'apps\surau-app\test\fixtures\tls-nc'
  $dns = @('localhost', 'box.surau.local')
  $ca = New-Root 'CN=MAXCOM Root CA Surau' @('2.5.29.30={critical}{hex}' + (Get-NameConstraintsHex $dns @())) 10
  $leaf = New-Leaf $ca 'CN=MAXCOM Box' @('127.0.0.1') 730
  Save-Pfx $leaf (Join-Path $nc 'box.pfx') (Read-Pass (Join-Path $nc 'pfx.pass')) 'BuildChain'
  Save-Cer $ca (Join-Path $nc 'root-ca.cer')

  $ca = New-Root 'CN=MAXCOM Root CA OldIp' @('2.5.29.30={critical}{hex}' + (Get-NameConstraintsHex $dns @('127.0.0.1'))) 10
  $leaf = New-Leaf $ca 'CN=MAXCOM Box' @('127.0.0.1') 730
  Save-Pfx $leaf (Join-Path $nc 'ip-box.pfx') (Read-Pass (Join-Path $nc 'ip-pfx.pass')) 'BuildChain'
  Save-Cer $ca (Join-Path $nc 'ip-root-ca.cer')
  $un = New-SelfSignedCertificate -Subject 'CN=Untrusted Box' -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -TextExtension @('2.5.29.17={text}IPAddress=127.0.0.1&DNS=localhost') `
    -NotAfter (Get-Date).AddYears(10) -CertStoreLocation $store
  [void]$made.Add($un.Thumbprint)
  Save-Pfx $un (Join-Path $tls 'untrusted.pfx') 'test' 'EndEntityCertOnly'
  Write-Output 'fixtures regenerated'
}
finally {
  foreach ($t in $made) {
    $p = Join-Path $store $t
    if (Test-Path $p) { Remove-Item -Path $p -DeleteKey -Force }
  }
}
