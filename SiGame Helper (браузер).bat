@echo off
chcp 65001 >nul
title SiGame Helper - server
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto :launch

echo.
echo   Environment is not ready. Run "SiGame Helper.bat" once - it will set
echo   everything up automatically.
echo.
pause
exit /b 1

:launch
rem Это окно закрывать нельзя: вместе с ним остановится и сервер.
".venv\Scripts\python.exe" "backend\run.py"
pause
