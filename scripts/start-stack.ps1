# openclaw-shell stack manager: web UI (17880) + OpenClaw gateway (18789) + Cloudflare tunnel
# Liveness is checked by port / process (avoids PS5.1 ConvertFrom-Json array bugs).
# PID records -> data\stack-pids.json for stop-stack only; stop never touches other processes.
# This script is path-agnostic: project root is derived from $PSScriptRoot (scripts\..),
# so it works from any clone location. The Cloudflare tunnel is OPTIONAL: it auto-starts
# only when cloudflared.exe + a config-openclaw.yml are found; set SKIP_TUNNEL=1 to force-skip.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data\stack-pids.json'
# Allow the local tts-server to fall back to local SAPI/Edge for OpenClaw on this machine.
# Selling deployments that run tts-server standalone must NOT set this (never sell local quality).
$env:TTS_ALLOW_LOCAL = '1'
# Force SILK output: QQ voice upload (file_type=3) only accepts silk; mp3/wav are rejected
# ("request data error") and neither OpenClaw core nor qqbot plugin v2.0.1 can transcode outbound.
$env:TTS_FORCE_SILK = '1'
# Force long-form TMP/TEMP: os.tmpdir() may return 8.3 short paths (FOLLOW~1) while OpenClaw
# core writes TTS audio to long paths (followsun...); fs.realpathSync keeps the input path form,
# so the QQ channel TTS_ALLOWED_ROOTS check fails and blocks the audio. Long TMP unifies both.
$env:TMP = Join-Path $env:SystemDrive "\Users\$env:USERNAME\AppData\Local\Temp"
$env:TEMP = $env:TMP
# Bind the web UI to localhost (public access goes through the optional Cloudflare tunnel,
# which also sets Basic-auth via .env). Set HOST=0.0.0.0 to expose on the LAN explicitly.
$env:HOST = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }

# Default TTS engine to offline Windows SAPI if no ttsConfig.json yet (CN networks often
# get 403 from the online Edge endpoint; localfallback still works with zero config).
# The web UI can switch back to Edge / cloud providers on the TTS page at any time.
$ttsCfg = Join-Path $root 'data\ttsConfig.json'
if (-not (Test-Path $ttsCfg)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $ttsCfg) | Out-Null
  $defaultTts = @{
    defaultProvider = 'local'
    local           = @{ engine = 'sapi'; voice = ''; rate = '+0%'; pitch = '+0Hz' }
    providers       = @()
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($ttsCfg, $defaultTts)
  Write-Host "[tts] created data\ttsConfig.json with offline SAPI default"
}

# No LAN exposure by default (HOST=127.0.0.1); no inbound firewall rule needed.
function Test-Port([int]$port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# Trim oversized logs before start. Start-Process redirection truncates its own targets,
# but cloudflared's error log grows unbounded within a single long run (~130KB/day).
function Trim-BigLogs([int]$maxBytes = 5242880) {
  Get-ChildItem (Join-Path $root 'data') -Filter '*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt $maxBytes } |
    ForEach-Object {
      $keep = Get-Content $_.FullName -Tail 2000 -ErrorAction SilentlyContinue
      if ($keep) { Set-Content -Path $_.FullName -Value $keep -Encoding UTF8 }
      Write-Host "[log] trimmed $($_.Name) (was $([math]::Round($_.Length/1MB,1))MB)"
    }
}
Trim-BigLogs

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
# ---- Optional Cloudflare tunnel (public access). Auto-start only if present; SKIP_TUNNEL=1 to force skip. ----
$env:SKIP_TUNNEL = if ($env:SKIP_TUNNEL) { $env:SKIP_TUNNEL } else { '0' }
$cloudflaredCandidates = @(
  "$env:USERPROFILE\cloudflared\cloudflared.exe",
  (Join-Path (Split-Path $root -Parent) 'cloudflared\cloudflared.exe'),
  "$root\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
)
$cloudflared = $null
foreach ($c in $cloudflaredCandidates) { if (Test-Path $c) { $cloudflared = $c; break } }
$tunnelCfg = Join-Path $env:USERPROFILE ".cloudflared\config-openclaw.yml"
$tunnelPid = 0
$tunnelSkipped = $env:SKIP_TUNNEL -eq '1' -or -not $cloudflared -or -not (Test-Path $tunnelCfg)
if ($tunnelSkipped) {
  Write-Host "[tunnel] skipped (no cloudflared/config or SKIP_TUNNEL=1; local http://127.0.0.1:17880 still works)"
} else {
  try {
    $tunnelId = (Select-String -Path $tunnelCfg -Pattern 'tunnel:\s*([0-9a-f-]+)' | Select-Object -First 1).Matches.Groups[1].Value
    if (-not $tunnelId) { $tunnelId = $null }
    if ($tunnelId) {
      $tunnelPid = Start-Component 'tunnel' $cloudflared @('tunnel', '--config', $tunnelCfg, 'run', $tunnelId) 'tunnel' { Test-TunnelRunning }
    } else {
      Write-Host "[tunnel] skipped (could not read tunnel id from $tunnelCfg)"
    }
  } catch {
    Write-Host "[tunnel] skipped (config parse error: $($_.Exception.Message))"
  }
}
$ttsPid    = Start-Component 'tts-server' 'node.exe' @("$root\dist\tts-server.js") 'tts-server' { Test-Port 17900 }

# Record real PIDs (for stop-stack). If a component is already running, look up its PID by port/process.
# NOTE: keep this file pure ASCII (Chinese comments get misread as GBK and can break parsing on PS5.1).
function Get-PortPid([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return 0
}
function Get-TunnelPid() {
  $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*config-openclaw*' } |
          Select-Object -First 1
  if ($proc) { return $proc.ProcessId }
  return 0
}

$entries = New-Object System.Collections.ArrayList
foreach ($pair in @(
    @{ key = 'server';     pid = $serverPid; port = 17880 },
    @{ key = 'gateway';    pid = $gwPid;    port = 18789 },
    @{ key = 'tunnel';     pid = $tunnelPid; port = 0 },
    @{ key = 'tts-server'; pid = $ttsPid;   port = 17900 }
  )) {
  $pidActual = $pair.pid
  if ($pidActual -le 0) {
    if ($pair.port -gt 0) { $pidActual = Get-PortPid $pair.port } else { $pidActual = Get-TunnelPid }
  }
  if ($pidActual -gt 0) { [void]$entries.Add([pscustomobject]@{ key = $pair.key; pid = $pidActual }) }
}
if ($entries.Count -gt 0) {
  [IO.File]::WriteAllText($pidFile, ($entries | ConvertTo-Json))
  Write-Host "PIDs saved: $pidFile"
}
Write-Host "Done. Local http://127.0.0.1:17880"
