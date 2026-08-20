# openclaw-shell stack manager: web UI (17880) + OpenClaw gateway (18789) + Cloudflare tunnel
# PID records -> data\stack-pids.json; stop only reclaims recorded PIDs (never touches other processes).
$ErrorActionPreference = 'Stop'
$root = 'D:\ai_workspace\openclaw-shell'
$pidFile = Join-Path $root 'data\stack-pids.json'
$pids = @()
if (Test-Path $pidFile) {
  try { $pids = @(Get-Content $pidFile -Raw | ConvertFrom-Json) } catch { $pids = @() }
}

function Is-PidAlive([int]$pid, [string]$name) {
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  return ($null -ne $proc) -and ($proc.ProcessName -eq $name)
}

function Start-Component([string]$key, [string]$file, [string[]]$procArgs, [string]$procName, [string]$logBase) {
  $existing = $pids | Where-Object { $_.key -eq $key }
  if ($existing -and (Is-PidAlive $existing.pid $procName)) {
    Write-Host "[$key] already running (PID $($existing.pid))"
    return $existing.pid
  }
  $out = Join-Path $root "data\$logBase.log"
  $err = Join-Path $root "data\$logBase.err.log"
  $p = Start-Process -FilePath $file -ArgumentList $procArgs -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  Write-Host "[$key] started (PID $($p.Id)) -> data\$logBase.log"
  return $p.Id
}

$serverPid = Start-Component 'server' 'node.exe' @("$root\dist\server.js") 'node' 'server'
$gwPid     = Start-Component 'gateway' 'node.exe' @("$env:APPDATA\npm\node_modules\openclaw\openclaw.mjs", 'gateway') 'node' 'gateway'
$tunnelPid = Start-Component 'tunnel' 'D:\ai_workspace\cloudflared\cloudflared.exe' `
    @('tunnel', '--config', 'C:\Users\followsun\.cloudflared\config-openclaw.yml', 'run', '74975232-d922-4337-9644-76fac4d04c26') 'cloudflared' 'tunnel'

$result = @(
  @{ key = 'server';  pid = $serverPid },
  @{ key = 'gateway'; pid = $gwPid },
  @{ key = 'tunnel';  pid = $tunnelPid }
) | ConvertTo-Json
[IO.File]::WriteAllText($pidFile, $result)
Write-Host "PIDs saved: $pidFile"
Write-Host "Done. Local http://127.0.0.1:17880 / Public https://openclaw.319274.xyz"
