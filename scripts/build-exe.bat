@echo off
chcp 65001 >nul
title SiGame Helper - сборка
cd /d "%~dp0.."

rem Собирает две вещи:
rem   SiGame Helper.exe          - запускалка, лежит в установленной папке
rem   Установка SiGame Helper.exe - установщик, его и выкладывают в релиз
rem
rem Порядок важен: установщик несёт запускалку внутри себя, поэтому она
rem должна быть собрана раньше. Перед сборкой обязательно соберите фронтенд
rem (scripts\build.bat) - иначе внутрь попадёт старый интерфейс.

if not exist ".venv\Scripts\python.exe" goto :noenv

echo   Ставлю PyInstaller...
.venv\Scripts\python.exe -m pip install --quiet pyinstaller

echo   [1/2] Собираю запускалку...
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --noconsole --clean ^
  --name "SiGame Helper" --icon "%CD%\assets\icon.ico" ^
  --distpath "%CD%\dist-launcher" --workpath "%CD%\build-launcher" ^
  --specpath "%CD%\build-launcher" launcher.py
if errorlevel 1 goto :fail
copy /y "dist-launcher\SiGame Helper.exe" "SiGame Helper.exe" >nul

echo   [2/2] Собираю установщик...
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --noconsole --clean ^
  --name "Установка SiGame Helper" --icon "%CD%\assets\icon.ico" ^
  --add-data "%CD%\backend;backend" ^
  --add-data "%CD%\assets;assets" ^
  --add-data "%CD%\scripts;scripts" ^
  --add-data "%CD%\SiGame Helper.exe;." ^
  --distpath "%CD%\dist-setup" --workpath "%CD%\build-setup" ^
  --specpath "%CD%\build-setup" installer.py
if errorlevel 1 goto :fail

echo.
echo   Готово. Установщик лежит в папке dist-setup - его и прикладывайте к релизу.
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
