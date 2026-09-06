@echo off
chcp 65001 >nul
title SiGame Helper - build frontend
cd /d "%~dp0..\frontend"

call npm install --no-audit --no-fund
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail

echo.
echo Frontend built into backend\app\static
echo.
pause
exit /b 0

:fail
echo Build failed.
pause
exit /b 1
