@echo off
rem ---------------------------------------------------------------------------
rem  One-click launcher for setup-kaggle.ps1
rem  Double-click this file, paste the Kaggle API token when asked, press Enter.
rem  Kept ASCII-only on purpose: cmd.exe must parse it under any code page.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PS_EXE=powershell"
where pwsh >nul 2>nul && set "PS_EXE=pwsh"
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-kaggle.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%~1"=="" pause
exit /b %RC%
