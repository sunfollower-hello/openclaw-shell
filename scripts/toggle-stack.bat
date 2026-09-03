@echo off
rem openclaw-shell desktop switch: stop if running, start if not (path-agnostic: script dir = project scripts dir)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 17880 -State Listen -ErrorAction SilentlyContinue; if ($c) { & '%~dp0stop-stack.ps1' } else { & '%~dp0start-stack.ps1' }"
echo.
pause
