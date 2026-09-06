@echo off
chcp 65001 >nul
title SiGame Helper - setup
cd /d "%~dp0"

echo.
echo   SiGame Helper - setup
echo   ------------------------------------------------
echo.

where python >nul 2>nul
if errorlevel 1 goto :nopython

if exist ".venv\Scripts\python.exe" goto :haveenv
echo   [1/3] Creating virtual environment...
python -m venv .venv
if errorlevel 1 goto :fail
goto :deps

:haveenv
echo   [1/3] Virtual environment already exists - skipping.

:deps
echo   [2/3] Installing Python packages...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if errorlevel 1 goto :fail

echo   [3/3] Checking ffmpeg, yt-dlp and gallery-dl...
".venv\Scripts\python.exe" "backend\run.py" --setup
if errorlevel 1 goto :toolsfail
echo ok> ".sgh-tools-ok"

echo.
echo   All set. Launch the app with "SiGame Helper.bat".
echo.
pause
exit /b 0


:nopython
echo   [!] Python not found.
echo       Install Python 3.11+ from https://www.python.org/downloads/
echo       IMPORTANT: tick "Add python.exe to PATH" during install.
echo.
pause
exit /b 1


:toolsfail
echo.
echo   [!] ffmpeg could not be downloaded automatically.
echo       Check your internet connection and run this file again, or download
echo       a full ffmpeg build yourself and put ffmpeg.exe and ffprobe.exe
echo       into the "bin" folder next to this file.
echo.
pause
exit /b 1


:fail
echo.
echo   [!] Setup failed - see the messages above.
echo.
pause
exit /b 1
