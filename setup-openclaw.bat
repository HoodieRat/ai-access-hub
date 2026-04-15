@echo off
setlocal
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\windows\openclaw\setup-openclaw.ps1" %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%