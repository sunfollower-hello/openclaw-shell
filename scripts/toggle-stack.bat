@echo off
rem openclaw-shell desktop switch: stop if running, start if not
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 17880 -State Listen -ErrorAction SilentlyContinue; if ($c) { & 'D:\ai_workspace\openclaw-shell\scripts\stop-stack.ps1' } else { & 'D:\ai_workspace\openclaw-shell\scripts\start-stack.ps1' }"
echo.
pause
