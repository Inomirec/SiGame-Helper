@echo off
chcp 65001 >nul
title SiGame Helper - сборка запускалки
cd /d "%~dp0.."

rem Пересобирает "SiGame Helper.exe" из launcher.py.
rem Нужно только когда меняется сам запуск программы, а не её код:
rem запускалка лишь готовит окружение и открывает приложение.

if not exist ".venv\Scripts\python.exe" goto :noenv

.venv\Scripts\python.exe -m pip install --quiet pyinstaller
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --noconsole --clean ^
  --name "SiGame Helper" ^
  --icon "%CD%\assets\icon.ico" ^
  --distpath "%CD%\dist-launcher" ^
  --workpath "%CD%\build-launcher" ^
  --specpath "%CD%\build-launcher" ^
  launcher.py
if errorlevel 1 goto :fail

copy /y "dist-launcher\SiGame Helper.exe" "SiGame Helper.exe" >nul
echo.
echo   Готово: SiGame Helper.exe пересобран.
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
