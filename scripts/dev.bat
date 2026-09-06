@echo off
chcp 65001 >nul
title SiGame Helper - dev mode
cd /d "%~dp0.."

rem Backend on 8756, Vite dev server on 5173 with hot reload.
start "SiGame Helper backend" ".venv\Scripts\python.exe" "backend\run.py" --headless --log-level info
cd frontend
npm run dev
