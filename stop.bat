@echo off
setlocal
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
if errorlevel 1 pause
exit /b %ERRORLEVEL%