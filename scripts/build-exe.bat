@echo off
chcp 65001 >nul
title SiGame Helper - сборка
cd /d "%~dp0.."

rem Собирает "SiGame Helper.exe" - единственный файл, который нужен человеку.
rem Он же установщик, он же запускалка: если рядом есть папка runtime,
rem просто открывает программу, иначе показывает окно установки.
rem
rem Перед сборкой соберите фронтенд (scripts\build.bat) - иначе внутрь
rem попадёт старый интерфейс.

if not exist ".venv\Scripts\python.exe" goto :noenv

echo   Ставлю PyInstaller...
.venv\Scripts\python.exe -m pip install --quiet pyinstaller

echo   Собираю...
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --noconsole --clean ^
  --name "SiGame Helper" --icon "%CD%\assets\icon.ico" ^
  --add-data "%CD%\backend;backend" ^
  --add-data "%CD%\assets;assets" ^
  --add-data "%CD%\scripts;scripts" ^
  --distpath "%CD%\dist-setup" --workpath "%CD%\build-setup" ^
  --specpath "%CD%\build-setup" installer.py
if errorlevel 1 goto :fail

copy /y "dist-setup\SiGame Helper.exe" "SiGame Helper.exe" >nul
echo.
echo   Готово. Файл обновлён и в папке проекта, и в dist-setup.
echo.
pause
exit /b 0

:noenv
echo   Нужно окружение разработчика: python -m venv .venv
pause
exit /b 1

:fail
echo   Сборка не удалась - смотрите сообщения выше.
pause
exit /b 1
