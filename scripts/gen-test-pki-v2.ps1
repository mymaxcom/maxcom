<#
.SYNOPSIS
  MAXCOM: make the V2 box-root TLS test fixtures (as BoxCa.kt PERMITTED_DNS_V2). Windows PowerShell 5.1.

.DESCRIPTION
  Writes apps\surau-app\test\fixtures\tls-nc-v2\ : root-ca.cer (ECDSA P-256 root with a CRITICAL DNS-only
  NameConstraints: localhost, box1-surau.local ... box99-surau.local), box2.pfx (leaf SAN IP:127.0.0.1,
  DNS:localhost, DNS:box2-surau.local) and evil.pfx (same root, SAN DNS:evil-surau.local), pass in pfx.pass.
  Every certificate is removed from Cert:\CurrentUser\My again at the end.
  Run from the repo root:  powershell -NoProfile -File scripts\gen-test-pki-v2.ps1
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
function New-Leaf($signer, [string]$san) {
  $c = New-SelfSignedCertificate -Subject 'CN=MAXCOM Box' -Signer $signer -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
    -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={critical}{text}ca=false') `
    -NotAfter (Get-Date).AddDays(730) -CertStoreLocation $store
  [void]$made.Add($c.Thumbprint)
  return $c
}

try {
  $out = Join-Path $root 'apps\surau-app\test\fixtures\tls-nc-v2'
  New-Item -ItemType Directory -Force $out | Out-Null
  $passFile = Join-Path $out 'pfx.pass'
  if (-not (Test-Path $passFile)) { [System.IO.File]::WriteAllText($passFile, 'test') }
  $pass = ([System.IO.File]::ReadAllText($passFile)).Trim()
  $sec = ConvertTo-SecureString -String $pass -AsPlainText -Force

  $dns = @('localhost') + @(1..99 | ForEach-Object { "box$_-surau.local" })
  $nc = '2.5.29.30={critical}{hex}' + (Get-NameConstraintsHex $dns)
  $ext = @('2.5.29.19={critical}{text}ca=true', $nc)
  $ca = New-SelfSignedCertificate -Subject 'CN=MAXCOM Root CA SurauV2' -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName `
    -KeyExportPolicy Exportable -KeyUsage CertSign, CRLSign -TextExtension $ext `
    -NotAfter (Get-Date).AddYears(10) -CertStoreLocation $store
  [void]$made.Add($ca.Thumbprint)
  Export-Certificate -Cert $ca -FilePath (Join-Path $out 'root-ca.cer') -Type CERT | Out-Null

  $box2 = New-Leaf $ca 'IPAddress=127.0.0.1&DNS=localhost&DNS=box2-surau.local'
  Export-PfxCertificate -Cert $box2 -FilePath (Join-Path $out 'box2.pfx') -Password $sec -ChainOption BuildChain | Out-Null
  $evil = New-Leaf $ca 'IPAddress=127.0.0.1&DNS=evil-surau.local'
  Export-PfxCertificate -Cert $evil -FilePath (Join-Path $out 'evil.pfx') -Password $sec -ChainOption BuildChain | Out-Null
  Write-Output 'v2 fixtures regenerated'
}
finally {
  foreach ($t in $made) {
    $p = Join-Path $store $t
    if (Test-Path $p) { Remove-Item -Path $p -DeleteKey -Force }
  }
}
