# openclaw-shell one-shot environment setup for a fresh machine (no account migration).
# What this does:
#   1. Check git / node / npm
#   2. npm install + tsc build (project local deps)
#   3. Install OpenClaw CLI globally (2026.6.34, npmmirror registry)
#   4. Install official channel plugins (Tencent QQ Bot / WeChat)
#   5. Link the bundled imagegen plugin (plugins/openclaw-shell-imagegen)
#   6. Create a .env template if missing (random UI password)
#   7. Print what still needs manual config (model API key + channels login)
# NOTE: keep this file pure ASCII (PS5.1 reads UTF-8 as GBK and breaks on Chinese comments).
# Usage: open PowerShell here ->  powershell -ExecutionPolicy Bypass -File scripts\setup-new-machine.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Write-Host "== openclaw-shell fresh-machine setup =="
Write-Host "root: $root"

# ---------- 1. environment checks ----------
$missing = @()
foreach ($cmd in @('git','node','npm')) {
  $ok = $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
  if (-not $ok) { $missing += $cmd }
}
if ($missing.Count -gt 0) {
  Write-Host "MISSING base tools: $($missing -join ', ')"
  Write-Host "Install them first: git (git-scm.com), Node.js 20+ LTS (nodejs.org). Then re-run."
  exit 1
}
$nodeMaj = [int](node -v).Substring(1).Split('.')[0]
if ($nodeMaj -lt 20) { Write-Host "WARN: Node $((node -v)) detected; 20+ recommended (24 used in dev)." }

if (-not (Test-Path (Join-Path $root 'package.json'))) {
  Write-Host "ERROR: package.json not found in $root . Run this script from the cloned project directory."
  exit 1
}

# ---------- 2. project deps + build ----------
Write-Host "`n[1/5] npm install (project deps)..."
Set-Location $root
& npm install --registry=https://registry.npmmirror.com
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR npm install failed"; exit 1 }

Write-Host "[2/5] build (tsc -> dist/)..."
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR build failed"; exit 1 }

# ---------- 3. OpenClaw CLI (global) ----------
Write-Host "`n[3/5] OpenClaw CLI (global)..."
$oc = Join-Path $env:APPDATA "npm\node_modules\openclaw\openclaw.mjs"
if (Test-Path $oc) {
  Write-Host "already installed (will use existing). To pin: npm i -g openclaw@2026.6.34"
} else {
  & npm install -g openclaw@2026.6.34 --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { Write-Host "ERROR global openclaw install failed"; exit 1 }
}

# ---------- 4. official channel plugins ----------
Write-Host "`n[4/5] official channel plugins (Tencent QQ Bot + WeChat)..."
function Install-OfficialPlugin([string]$pkg) {
  $r = & node $oc plugins list --json 2>$null | Out-String
  if ($r -match [regex]::Escape(($pkg -replace '^@[^/]+/',''))) {
    Write-Host "  $pkg already installed"
    return
  }
  & node $oc plugins install "npm:$pkg" --force
  if ($LASTEXITCODE -ne 0) { Write-Host "  WARN: install $pkg returned non-zero (see above)" }
}
Install-OfficialPlugin '@tencent-connect/openclaw-qqbot'
Install-OfficialPlugin '@tencent-weixin/openclaw-weixin'

# ---------- 5. bundled imagegen plugin (link) ----------
Write-Host "`n[5/5] imagegen plugin (--link from this repo)..."
$igDir = Join-Path $root 'plugins\openclaw-shell-imagegen'
Set-Location $igDir
& npm install --registry=https://registry.npmmirror.com
& npm run build
Set-Location $root
& node $oc plugins install --link $igDir
if ($LASTEXITCODE -ne 0) { Write-Host "WARN: imagegen --link returned non-zero; run manually after checking output." }

# ---------- 6. .env template ----------
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  $pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ })
  @(
    "OPENCLAW_SHELL_UI_USER=admin",
    "OPENCLAW_SHELL_UI_PASS=$pass"
  ) | Set-Content -Path $envFile -Encoding UTF8
  Write-Host "`n.env created. UI login: admin / $pass  (change it before exposing publicly!)"
} else {
  Write-Host "`n.env already exists (kept)."
}

# ---------- 7. what remains ----------
Write-Host @"

============================================================
Setup done. What still needs manual / AI steps:
  1. Model API key: edit YOUR .openclaw\openclaw.json under
     models.providers.<name> (any OpenAI-compatible service).
     Also set agents.defaults.model.primary, e.g. "name/model".
  2. Start once:  powershell -File scripts\start-stack.ps1
     (starts web UI :17880 + gateway :18789; tunnel auto-skips)
  3. Log in at http://127.0.0.1:17880 and configure a model
     provider in "API & Models" page, then create cards, then
     bind QQ/WeChat via card advanced config (scan QR once).
  Optional Cloudflare public access: install cloudflared, put
  config-openclaw.yml in %USERPROFILE%\.cloudflared, set SKIP_TUNNEL=0.
No account migration needed - everything is rebuilt in place.
============================================================
"@