@echo off
cd /d "%TEMP%" & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" -InstallRoot "%~dp0.." %* & pause
