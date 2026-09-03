# openclaw-shell one-click launcher (called by the desktop shortcut).
# Starts the stack if not running, waits for the web UI, then opens the browser.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$startScript = Join-Path $root 'scripts\start-stack.ps1'

$running = $null -ne (Get-NetTCPConnection -LocalPort 17880 -State Listen -ErrorAction SilentlyContinue)
if (-not $running) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $startScript
}

# Wait up to 30s for the web UI to come up.
for ($i = 0; $i -lt 30; $i++) {
  if ($null -ne (Get-NetTCPConnection -LocalPort 17880 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}

Start-Process "http://127.0.0.1:17880"