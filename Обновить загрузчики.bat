@echo off
chcp 65001 >nul
title SiGame Helper - update downloaders
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" goto :nosetup

echo Updating yt-dlp and gallery-dl...
".venv\Scripts\python.exe" -m pip install --upgrade yt-dlp gallery-dl
echo.
pause
exit /b 0

:nosetup
echo Environment is not ready. Run "SiGame Helper.bat" first.
pause
exit /b 1
