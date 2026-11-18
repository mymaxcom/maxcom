# Runs the app tests twice: the public build (plain) and the MAXCOM Ops build (--dart-define=MAXCOM_OPS=true).
# A plain `flutter test` skips every ops test (they are `skip: !kOpsBuild`), so a green plain run proves nothing about
# the ops side. This fails when either run fails, or when the ops run skipped a test under test/ops (the public-build
# checks in *_public_* files are meant to be skipped there). Extra arguments (a path, --name) go to both runs.
# Usage: powershell -File apps/surau-app/tool/test-both.ps1 [test paths...]
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Run-Tests([string[]]$extra, [string]$label) {
  Write-Host "== flutter test ($label)"
  $cmd = @("test", "--reporter", "json") + $extra + $script:passArgs
  $names = @{}
  $skipped = New-Object System.Collections.Generic.List[string]
  $failed = 0
  & flutter @cmd | ForEach-Object {
    if ($_ -notmatch '^\s*\{') { return }
    try { $e = $_ | ConvertFrom-Json } catch { return }
    if ($e.type -eq "testStart") { $names[[string]$e.test.id] = $e.test }
    elseif ($e.type -eq "testDone" -and $e.hidden -ne $true) {
      $t = $names[[string]$e.testID]
      if ($e.skipped -eq $true -and $t) { $skipped.Add([string]$t.url + " :: " + [string]$t.name) }
      if ($e.result -ne "success" -and -not ($e.skipped -eq $true)) { $failed++ }
    }
  }
  if ($LASTEXITCODE -ne 0 -or $failed -gt 0) { Write-Host "FAIL: $label run failed ($failed failing)"; exit 1 }
  Write-Host "   $($skipped.Count) skipped"
  return , $skipped
}

$script:passArgs = $args
$plain = Run-Tests @() "public"
$ops = Run-Tests @("--dart-define=MAXCOM_OPS=true") "ops"
# public-build checks are meant to be skipped in the ops run: files named *_public_* and groups named "the public build"
$bad = @($ops | Where-Object { $_ -match "/test/ops/" -and $_ -notmatch "_public_" -and $_ -notmatch " :: the public build" })
if ($bad.Count -gt 0) {
  Write-Host "FAIL: the ops run skipped $($bad.Count) ops test(s):"
  $bad | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host "OK: public run and ops run passed; the ops run skipped no ops test"
exit 0
