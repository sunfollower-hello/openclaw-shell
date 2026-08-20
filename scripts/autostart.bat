@echo off
rem openclaw-shell auto start at logon
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\ai_workspace\openclaw-shell\scripts\start-stack.ps1" > "D:\ai_workspace\openclaw-shell\data\autostart.log" 2>&1
