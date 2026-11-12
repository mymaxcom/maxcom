@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\setup.ps1" %*
set "MAXCOM_RC=%ERRORLEVEL%"
pause
exit /b %MAXCOM_RC%
