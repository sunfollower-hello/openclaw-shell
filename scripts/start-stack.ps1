# openclaw-shell stack manager: web UI (17880) + OpenClaw gateway (18789) + Cloudflare tunnel
# Liveness is checked by port / process (avoids PS5.1 ConvertFrom-Json array bugs).
# PID records -> data\stack-pids.json for stop-stack only; stop never touches other processes.
$ErrorActionPreference = 'Stop'
$root = 'D:\ai_workspace\openclaw-shell'
$pidFile = Join-Path $root 'data\stack-pids.json'

function Test-Port([int]$port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Test-TunnelRunning() {
  $n = (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*config-openclaw*' } |
        Measure-Object).Count
  return $n -gt 0
}

function Start-Component([string]$key, [string]$file, [string[]]$procArgs, [string]$logBase, [scriptblock]$isRunning) {
  if (& $isRunning) {
    Write-Host "[$key] already running (skipped)"
    return 0
  }
  $out = Join-Path $root "data\$logBase.log"
  $err = Join-Path $root "data\$logBase.err.log"
  $p = Start-Process -FilePath $file -ArgumentList $procArgs -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  Write-Host "[$key] started (PID $($p.Id)) -> data\$logBase.log"
  return $p.Id
}

$serverPid = Start-Component 'server' 'node.exe' @("$root\dist\server.js") 'server' { Test-Port 17880 }
$gwPid     = Start-Component 'gateway' 'node.exe' @("$env:APPDATA\npm\node_modules\openclaw\openclaw.mjs", 'gateway') 'gateway' { Test-Port 18789 }
$tunnelPid = Start-Component 'tunnel' 'D:\ai_workspace\cloudflared\cloudflared.exe' `
    @('tunnel', '--config', 'C:\Users\followsun\.cloudflared\config-openclaw.yml', 'run', '74975232-d922-4337-9644-76fac4d04c26') 'tunnel' { Test-TunnelRunning }

# 记录实际在跑的 PID（供 stop-stack 使用）
$entries = @()
foreach ($pair in @(
    @{ key = 'server';  pid = $serverPid },
    @{ key = 'gateway'; pid = $gwPid },
    @{ key = 'tunnel';  pid = $tunnelPid }
  )) {
  if ($pair.pid -gt 0) { $entries += [pscustomobject]@{ key = $pair.key; pid = $pair.pid } }
}
if ($entries.Count -gt 0) {
  [IO.File]::WriteAllText($pidFile, ($entries | ConvertTo-Json))
  Write-Host "PIDs saved: $pidFile"
}
Write-Host "Done. Local http://127.0.0.1:17880 / Public https://openclaw.319274.xyz"
