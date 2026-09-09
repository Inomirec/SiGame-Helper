@echo off
chcp 65001 >nul
title SiGame Helper
cd /d "%~dp0"

rem Скобки внутри блоков if(...) ломают разбор bat-файла, поэтому весь
rem поток управления построен на метках goto.

rem В папке разработчика есть .venv - используем его. У обычного пользователя
rem его нет, и тогда работаем на переносимом Python из папки runtime.
if exist ".venv\Scripts\pythonw.exe" goto :usevenv

set "PY=runtime\python.exe"
set "PYW=runtime\pythonw.exe"
if exist "runtime\.ready" goto :tools
goto :install

:usevenv
set "PY=.venv\Scripts\python.exe"
set "PYW=.venv\Scripts\pythonw.exe"
goto :tools


:install
rem Скачивает переносимый Python и все библиотеки. Ставить ничего не нужно.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install.ps1"
if errorlevel 1 goto :fail
if not exist "%PY%" goto :fail


:tools
rem Доустанавливаем ffmpeg и Deno, чтобы пользователю не пришлось ничего
rem искать. Метка-файл не даёт повторять проверку при каждом запуске.
if exist ".sgh-tools-ok" goto :shortcut
echo.
echo   Проверяю ffmpeg и Deno...
"%PY%" "backend\run.py" --setup
if errorlevel 1 goto :toolsfail
echo ok> ".sgh-tools-ok"


:shortcut
rem Один раз кладём на рабочий стол ярлык с иконкой: дальше человек
rem запускает программу им, а не файлом с пугающим расширением.
if exist ".sgh-shortcut" goto :launch
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\shortcut.ps1"
echo ok> ".sgh-shortcut"


:launch
rem pythonw не создаёт консольного окна - приложение живёт в своём окне.
start "" "%PYW%" "backend\run.py" --window
exit /b 0


:toolsfail
echo.
echo   Не удалось скачать ffmpeg.
echo   Программа всё равно запустится, но сжимать не сможет. Проверьте
echo   интернет и запустите этот файл ещё раз.
echo.
pause
goto :launch


:fail
echo.
echo   Подготовка не завершилась. Смотрите сообщения выше.
echo.
pause
exit /b 1
