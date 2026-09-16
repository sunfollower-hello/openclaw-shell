@echo off
chcp 65001 >nul
rem Emoji pack builder: drag an image folder onto this .bat, or double-click and paste the path.
setlocal
set "PS=%~dp0make-emoji-pack.ps1"
if not exist "%PS%" (
  echo [ERROR] make-emoji-pack.ps1 not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" -Folder "%~1"
echo.
pause
