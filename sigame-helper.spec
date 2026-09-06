# PyInstaller-спецификация: собирает всё приложение в один .exe.
#
# Сборка:
#   .venv\Scripts\python.exe -m pip install pyinstaller
#   .venv\Scripts\pyinstaller.exe sigame-helper.spec
#
# Перед сборкой обязательно соберите фронтенд (scripts\build.bat) — иначе
# в .exe попадёт пустая папка static и интерфейс не откроется.
#
# ffmpeg внутрь не упаковывается: он весит больше самой программы и имеет
# лицензию GPL. Приложение ищет его в PATH и в папке bin рядом с .exe.

from pathlib import Path

block_cipher = None
project = Path(SPECPATH)
static = project / "backend" / "app" / "static"

if not (static / "index.html").exists():
    raise SystemExit(
        "Фронтенд не собран: выполните scripts\\build.bat перед сборкой .exe"
    )

a = Analysis(
    [str(project / "backend" / "run.py")],
    pathex=[str(project / "backend")],
    binaries=[],
    datas=[(str(static), "static")],
    hiddenimports=[
        # Uvicorn и yt-dlp подтягивают часть модулей динамически.
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        "webview.platforms.edgechromium",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "PIL"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SiGame Helper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="SiGame Helper",
)
