@echo off
rem openclaw-shell auto start at logon (path-agnostic: script dir = project scripts dir)
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-stack.ps1" > "%~dp0..\data\autostart.log" 2>&1
