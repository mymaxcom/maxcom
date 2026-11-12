@echo off
cd /d "%TEMP%" & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" -InstallRoot "%~dp0.." %* & pause
