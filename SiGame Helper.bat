@echo off
chcp 65001 >nul
title SiGame Helper
cd /d "%~dp0"

rem Скобки внутри блоков if(...) ломают разбор bat-файла, поэтому весь
rem поток управления построен на метках goto.

if not exist ".venv\Scripts\pythonw.exe" goto :firstrun
if not exist ".sgh-tools-ok" goto :tools
goto :launch


:firstrun
echo.
echo   First run: preparing the environment, this takes a minute...
echo.
call :venv
if errorlevel 1 goto :fail


:tools
rem Доустанавливаем ffmpeg и всё остальное, чтобы пользователю не пришлось
rem ничего искать в настройках. Метка-файл не даёт повторять проверку
rem при каждом запуске.
echo.
echo   Checking tools...
".venv\Scripts\python.exe" "backend\run.py" --setup
if errorlevel 1 goto :toolsfail
echo ok> ".sgh-tools-ok"


:launch
rem pythonw не создаёт консольного окна - приложение живёт в своём окне.
start "" ".venv\Scripts\pythonw.exe" "backend\run.py" --window
exit /b 0


:venv
where python >nul 2>nul
if errorlevel 1 goto :nopython

python -m venv .venv
if errorlevel 1 exit /b 1

".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if errorlevel 1 exit /b 1
exit /b 0


:nopython
echo.
echo   Python was not found on this computer.
echo   Install Python 3.11 or newer from https://www.python.org/downloads/
echo   During installation tick the box "Add python.exe to PATH".
echo.
pause
exit /b 1


:toolsfail
echo.
echo   Could not install ffmpeg automatically.
echo   The app will still start - open Settings and press the download button,
echo   or put ffmpeg.exe and ffprobe.exe into the "bin" folder yourself.
echo.
pause
goto :launch


:fail
echo.
echo   Setup failed - see the messages above.
echo.
pause
exit /b 1
