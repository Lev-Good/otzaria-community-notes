$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

Write-Host '=================================================='
Write-Host '  Otzaria Community Notes - Local Test Launcher'
Write-Host '=================================================='

Write-Host '[1/3] Preparing dist\dev-plugin ...'
& npm run pack:dev
if ($LASTEXITCODE -ne 0) {
  Read-Host 'Build failed. Press Enter to exit'
  exit 1
}

Write-Host '[2/3] Starting local test server on http://127.0.0.1:8787 ...'
$serverProc = Start-Process -FilePath 'node' -ArgumentList @('scripts\dev-worker-local.mjs') -WorkingDirectory $root -PassThru

Start-Sleep -Seconds 2

Write-Host '[3/3] Launching Otzaria with --dev-plugins ...'
$otzExe = @('C:\Program Files\otzaria\otzaria.exe', 'C:\Program Files\Otzaria\otzaria.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($otzExe) {
  Start-Process -FilePath $otzExe -ArgumentList @('--dev-plugins')
} else {
  Write-Warning 'otzaria.exe not found in Program Files. Start Otzaria manually with --dev-plugins.'
}

Write-Host ''
Write-Host "Server PID: $($serverProc.Id) (http://127.0.0.1:8787)"
Write-Host "Plugin folder to load in Otzaria: $(Join-Path $root 'dist\dev-plugin')"
Write-Host 'Test invite codes: OTZ-MOD-2026 (moderator) | OTZ-BETA-2026 (regular user)'
Read-Host 'Press Enter to keep running or close this window when done'
