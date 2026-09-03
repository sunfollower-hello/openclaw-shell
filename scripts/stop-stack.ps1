# openclaw-shell stack stop: only reclaims PIDs in data\stack-pids.json; never touches system services.
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\stack-pids.json'
if (-not (Test-Path $pidFile)) {
  Write-Host 'No PID record (stack not started via start-stack?)'
  exit 0
}
$pids = Get-Content $pidFile -Raw | ConvertFrom-Json
foreach ($item in $pids) {
  $proc = Get-Process -Id $item.pid -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $item.pid -Force
    Write-Host "[$($item.key)] stopped (PID $($item.pid))"
  } else {
    Write-Host "[$($item.key)] not running"
  }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Done'
