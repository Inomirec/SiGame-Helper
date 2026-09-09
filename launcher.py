"""Единственная кнопка, на которую нажимает человек.

Из архива программу запускает этот файл: он проверяет, всё ли на месте,
при необходимости доустанавливает недостающее — показывая обычное окно с
полосой прогресса, а не чёрную консоль, — и открывает приложение.

Когда всё уже установлено, окно не показывается вовсе: программа просто
открывается, как любая другая.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PYTHON_VERSION = "3.12.10"
PYTHON_ZIP = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
    f"python-{PYTHON_VERSION}-embed-amd64.zip"
)
GET_PIP = "https://bootstrap.pypa.io/get-pip.py"

#: Чтобы дочерние процессы не открывали чёрных окон.
CREATE_NO_WINDOW = 0x08000000


def root_dir() -> Path:
    """Папка программы: рядом с .exe, а при отладке — рядом с этим файлом."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = root_dir()
RUNTIME = ROOT / "runtime"
READY = RUNTIME / ".ready"
ICON = ROOT / "assets" / "icon.ico"
FOLDER_LINK = ROOT / "Запустить SiGame Helper.lnk"


class Progress:
    """Окно подготовки. Появляется, только когда есть что делать."""

    def __init__(self) -> None:
        self.window = None
        self.label = None
        self.bar = None

    def open(self) -> None:
        if self.window is not None:
            return
        import tkinter as tk
        from tkinter import ttk

        self.window = tk.Tk()
        self.window.title("SiGame Helper — подготовка")
        self.window.resizable(False, False)
        if ICON.exists():
            try:
                self.window.iconbitmap(str(ICON))
            except Exception:
                pass

        frame = ttk.Frame(self.window, padding=(24, 20))
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Первая подготовка", font=("Segoe UI", 12, "bold")).pack(
            anchor="w"
        )
        ttk.Label(
            frame,
            text=(
                "Программа скачивает всё, что ей нужно для работы.\n"
                "Это занимает несколько минут и делается один раз."
            ),
            justify="left",
        ).pack(anchor="w", pady=(6, 14))

        self.bar = ttk.Progressbar(frame, length=430, mode="determinate", maximum=100)
        self.bar.pack()
        self.label = ttk.Label(frame, text="Подготовка…")
        self.label.pack(anchor="w", pady=(10, 0))

        # Tk по умолчанию бросает окно в угол экрана — ставим по центру.
        self.window.update_idletasks()
        width, height = self.window.winfo_width(), self.window.winfo_height()
        x = (self.window.winfo_screenwidth() - width) // 2
        y = (self.window.winfo_screenheight() - height) // 3
        self.window.geometry(f"+{x}+{y}")
        self.window.update()

    def step(self, text: str, percent: float | None = None) -> None:
        self.open()
        self.label.config(text=text)
        if percent is not None:
            self.bar.config(value=max(0.0, min(100.0, percent)))
        self.window.update()

    def close(self) -> None:
        if self.window is not None:
            self.window.destroy()
            self.window = None

    def fail(self, text: str) -> None:
        from tkinter import messagebox

        self.open()
        messagebox.showerror("SiGame Helper", text)
        self.close()


def download(url: str, target: Path, report) -> None:
    """Скачивает файл, сообщая о ходе дела долями процента."""
    with urllib.request.urlopen(url, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        with target.open("wb") as handle:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                done += len(chunk)
                if total:
                    report(done / total * 100)


def run_quiet(args: list[str]) -> None:
    """Запускает команду без консольного окна и падает с понятной ошибкой."""
    result = subprocess.run(
        args,
        cwd=str(ROOT),
        capture_output=True,
        creationflags=CREATE_NO_WINDOW,
    )
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(
            "\n".join(tail[-4:]) or f"команда завершилась с кодом {result.returncode}"
        )


def install_runtime(progress: Progress) -> None:
    """Разворачивает переносимый Python и ставит библиотеки."""
    # Обрывок прошлой неудачной попытки лучше снести целиком.
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME, ignore_errors=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)

    archive = RUNTIME / "python.zip"
    progress.step(f"Скачиваю Python {PYTHON_VERSION} (11 МБ)…", 0)
    download(
        PYTHON_ZIP,
        archive,
        lambda p: progress.step(f"Скачиваю Python {PYTHON_VERSION}… {p:.0f}%", p * 0.25),
    )

    progress.step("Распаковываю…", 25)
    with zipfile.ZipFile(archive) as archive_file:
        archive_file.extractall(RUNTIME)
    archive.unlink(missing_ok=True)

    # Встроенная сборка не видит установленные пакеты, пока не поправить ._pth.
    for pth in RUNTIME.glob("python*._pth"):
        pth.write_text(
            pth.stem + ".zip\n.\nLib\\site-packages\n\nimport site\n",
            encoding="ascii",
        )

    python = RUNTIME / "python.exe"

    progress.step("Ставлю pip…", 30)
    getpip = RUNTIME / "get-pip.py"
    download(GET_PIP, getpip, lambda p: None)
    run_quiet([str(python), str(getpip), "--no-warn-script-location", "-q"])
    getpip.unlink(missing_ok=True)

    # Часть библиотек выложена без готовых «колёс» и собирается на месте —
    # для сборки нужны setuptools и wheel, которых во встроенном Python нет.
    progress.step("Готовлю сборочные инструменты…", 40)
    run_quiet(
        [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
         "setuptools", "wheel"]
    )

    # --no-build-isolation обязателен: встроенный Python из-за ._pth работает
    # в изолированном режиме и не видит PYTHONPATH, через который pip передаёт
    # setuptools во временное окружение сборки.
    progress.step("Ставлю библиотеки и загрузчики (самый долгий шаг)…", 55)
    run_quiet(
        [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
         "--no-build-isolation", "-r", str(ROOT / "backend" / "requirements.txt")]
    )

    READY.write_text("ok", encoding="ascii")


def install_tools(progress: Progress) -> None:
    """Доустанавливает ffmpeg и Deno, показывая, что происходит."""
    marker = ROOT / ".sgh-tools-ok"
    if marker.exists():
        return

    progress.step("Проверяю ffmpeg и Deno…", 70)
    process = subprocess.Popen(
        [str(RUNTIME / "python.exe"), str(ROOT / "backend" / "run.py"), "--setup"],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=CREATE_NO_WINDOW,
    )
    for raw in process.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if line:
            progress.step(line[:90])
    if process.wait() != 0:
        raise RuntimeError(
            "Не удалось скачать ffmpeg. Проверьте интернет и запустите ещё раз."
        )
    marker.write_text("ok", encoding="ascii")


def make_shortcuts(ask_desktop: bool) -> None:
    """Кладёт ярлык в папку программы и, если разрешат, на рабочий стол."""
    script = ROOT / "scripts" / "shortcut.ps1"
    if not script.exists():
        return
    args = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(script),
    ]
    if not ask_desktop:
        args.append("-Silent")
    subprocess.run(args, cwd=str(ROOT), creationflags=CREATE_NO_WINDOW)


def start_app() -> None:
    """Открывает саму программу и уходит."""
    subprocess.Popen(
        [str(RUNTIME / "pythonw.exe"), str(ROOT / "backend" / "run.py"), "--window"],
        cwd=str(ROOT),
        creationflags=CREATE_NO_WINDOW,
    )


def main() -> int:
    progress = Progress()
    first_time = not READY.exists()
    try:
        if first_time:
            install_runtime(progress)
        install_tools(progress)
        if not FOLDER_LINK.exists():
            make_shortcuts(ask_desktop=first_time)
        if first_time:
            progress.step("Готово", 100)
        progress.close()
        start_app()
        return 0
    except Exception as error:  # рассказываем человеку, а не в пустоту
        progress.fail(
            "Подготовка не завершилась.\n\n"
            f"{error}\n\n"
            "Чаще всего это интернет или антивирус. Проверьте соединение "
            "и запустите программу ещё раз."
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
