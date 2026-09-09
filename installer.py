"""SiGame Helper — единственный файл, на который нажимает человек.

Он и устанавливает программу, и запускает её. Что именно делать, решает сам:

* рядом лежит готовое окружение (папка ``runtime``, а у разработчика
  ``.venv``) — молча открывает программу, как обычный ярлык;
* окружения нет — показывает окно установки, спрашивает куда ставить,
  нужен ли ярлык, и только по кнопке «Установить» берётся за дело.

Раньше файлов было два — установщик и запускалка, — и это сбивало с толку:
в архиве с GitHub оказывался не тот, что в релизе. Теперь файл один и ведёт
себя одинаково, откуда бы его ни взяли.
"""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
import urllib.request
import zipfile
from pathlib import Path

APP_NAME = "SiGame Helper"
PYTHON_VERSION = "3.12.10"
PYTHON_ZIP = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
    f"python-{PYTHON_VERSION}-embed-amd64.zip"
)
GET_PIP = "https://bootstrap.pypa.io/get-pip.py"

#: Чтобы дочерние процессы не открывали чёрных окон.
CREATE_NO_WINDOW = 0x08000000


def own_dir() -> Path:
    """Папка, в которой лежит сам файл."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def payload_dir() -> Path:
    """Откуда брать файлы программы при установке.

    Если рядом с нами уже лежит ``backend`` — значит нас распаковали вместе
    с исходниками, и брать надо их: они точно свежее упакованных внутрь.
    Иначе достаём копию из самого файла.
    """
    here = own_dir()
    if (here / "backend").is_dir():
        return here
    bundled = getattr(sys, "_MEIPASS", None)
    return Path(bundled) if bundled else here


def installed_python(folder: Path) -> Path | None:
    """Готовый Python рядом с программой, если он есть.

    Обычно это папка ``runtime``, которую делает установка. Но в папке
    разработчика её нет, зато есть ``.venv`` — и запускать надо оттуда,
    иначе разработчику каждый раз предлагают «установить» уже готовое.
    """
    runtime = folder / "runtime" / "pythonw.exe"
    if (folder / "runtime" / ".ready").exists() and runtime.exists():
        return runtime
    venv = folder / ".venv" / "Scripts" / "pythonw.exe"
    if venv.exists():
        return venv
    return None


def default_target() -> Path:
    """Куда предлагаем поставить.

    Когда рядом уже лежат файлы программы (распакованный архив), ставим
    прямо сюда — незачем плодить копию в подпапке. Когда мы одни, делаем
    свою папку, иначе программа рассыплется по «Загрузкам».
    """
    here = own_dir()
    return here if (here / "backend").is_dir() else here / APP_NAME


def system_target() -> Path:
    """Запасной вариант — личная папка программ, как у Discord или VS Code."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Programs" / APP_NAME


def child_env() -> dict[str, str]:
    """Окружение для дочерних процессов: без UTF-8 русский текст приходит мусором."""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def start_app(folder: Path) -> None:
    """Открывает саму программу."""
    python = installed_python(folder) or folder / "runtime" / "pythonw.exe"
    subprocess.Popen(
        [str(python), str(folder / "backend" / "run.py"), "--window"],
        cwd=str(folder),
        creationflags=CREATE_NO_WINDOW,
    )


class Cancelled(Exception):
    """Человек передумал: нажал «Отмена» или закрыл окно."""


class Worker:
    """Сама установка. Живёт в отдельном потоке, чтобы окно не замирало.

    Раньше всё делалось в потоке окна, и на небыстрых компьютерах Windows
    успевала объявить программу «не отвечает» — она и правда не отвечала,
    пока шла установка библиотек.
    """

    def __init__(self, target: Path, shortcut: bool, report: queue.Queue) -> None:
        self.target = target
        self.shortcut = shortcut
        self.report = report
        self.stop = threading.Event()

    def say(self, text: str, percent: float | None = None) -> None:
        if self.stop.is_set():
            raise Cancelled
        self.report.put(("step", text, percent))

    # --- шаги установки --------------------------------------------------

    def copy_program(self) -> None:
        source = payload_dir()
        self.target.mkdir(parents=True, exist_ok=True)

        # Ставим в ту же папку, откуда берём, — копировать нечего.
        if source.resolve() != self.target.resolve():
            self.say("Копирую файлы программы…", 2)
            for name in ("backend", "assets", "scripts"):
                src = source / name
                if not src.exists():
                    continue
                dst = self.target / name
                if dst.exists():
                    shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(
                    src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
                )

        # Кладём рядом с программой самих себя: этот же файл будет её запускать.
        if getattr(sys, "frozen", False):
            myself = Path(sys.executable).resolve()
            destination = self.target / f"{APP_NAME}.exe"
            if myself != destination.resolve():
                shutil.copy2(myself, destination)

    def download(self, url: str, target: Path, label: str, base: float, span: float) -> None:
        with urllib.request.urlopen(url, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            with target.open("wb") as handle:
                while True:
                    if self.stop.is_set():
                        raise Cancelled
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if total:
                        share = done / total
                        self.say(f"{label} {share * 100:.0f}%", base + span * share)

    def run_quiet(self, args: list[str]) -> None:
        result = subprocess.run(
            args,
            cwd=str(self.target),
            capture_output=True,
            env=child_env(),
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode != 0:
            tail = result.stderr.decode("utf-8", "replace").strip().splitlines()
            raise RuntimeError("\n".join(tail[-4:]) or "команда завершилась с ошибкой")

    def install_python(self) -> None:
        runtime = self.target / "runtime"
        if runtime.exists():
            shutil.rmtree(runtime, ignore_errors=True)
        runtime.mkdir(parents=True, exist_ok=True)

        archive = runtime / "python.zip"
        self.say(f"Скачиваю Python {PYTHON_VERSION}…", 5)
        self.download(PYTHON_ZIP, archive, "Скачиваю Python", 5, 15)

        self.say("Распаковываю Python…", 20)
        with zipfile.ZipFile(archive) as archive_file:
            archive_file.extractall(runtime)
        archive.unlink(missing_ok=True)

        # Встроенная сборка не видит установленные пакеты, пока не поправить ._pth.
        for pth in runtime.glob("python*._pth"):
            pth.write_text(
                pth.stem + ".zip\n.\nLib\\site-packages\n\nimport site\n",
                encoding="ascii",
            )

        python = runtime / "python.exe"

        self.say("Ставлю pip…", 24)
        getpip = runtime / "get-pip.py"
        self.download(GET_PIP, getpip, "Скачиваю pip", 24, 3)
        self.run_quiet([str(python), str(getpip), "--no-warn-script-location", "-q"])
        getpip.unlink(missing_ok=True)

        # Часть библиотек выложена без готовых «колёс» и собирается на месте.
        self.say("Готовлю сборочные инструменты…", 30)
        self.run_quiet(
            [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
             "setuptools", "wheel"]
        )

        # --no-build-isolation обязателен: встроенный Python не видит PYTHONPATH,
        # через который pip передаёт setuptools во временное окружение сборки.
        self.say("Ставлю библиотеки и загрузчики — это самый долгий шаг…", 35)
        self.run_quiet(
            [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
             "--no-build-isolation", "-r",
             str(self.target / "backend" / "requirements.txt")]
        )
        (runtime / ".ready").write_text("ok", encoding="ascii")

    def install_tools(self) -> None:
        self.say("Скачиваю ffmpeg и Deno…", 60)
        process = subprocess.Popen(
            [str(self.target / "runtime" / "python.exe"),
             str(self.target / "backend" / "run.py"), "--setup"],
            cwd=str(self.target),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=child_env(),
            creationflags=CREATE_NO_WINDOW,
        )
        for raw in process.stdout:
            if self.stop.is_set():
                process.kill()
                raise Cancelled
            line = raw.decode("utf-8", "replace").strip()
            if line:
                self.say(line[:90])
        if process.wait() != 0:
            raise RuntimeError(
                "Не удалось скачать ffmpeg. Проверьте интернет и попробуйте снова."
            )
        (self.target / ".sgh-tools-ok").write_text("ok", encoding="ascii")

    def make_shortcut(self) -> None:
        if not self.shortcut:
            return
        self.say("Создаю ярлык…", 96)
        exe = self.target / f"{APP_NAME}.exe"
        icon = self.target / "assets" / "icon.ico"
        desktop = Path(os.path.expanduser("~")) / "Desktop"
        command = (
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut("
            f"'{desktop / (APP_NAME + '.lnk')}'); "
            f"$s.TargetPath = '{exe}'; "
            f"$s.WorkingDirectory = '{self.target}'; "
            f"$s.IconLocation = '{icon}'; "
            "$s.Description = 'Скачивание, нарезка и сжатие медиа для паков SIGame'; "
            "$s.Save()"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )

    def run(self) -> None:
        try:
            self.copy_program()
            self.install_python()
            self.install_tools()
            self.make_shortcut()
            self.say("Готово", 100)
            self.report.put(("done", None, None))
        except Cancelled:
            self.report.put(("cancelled", None, None))
        except Exception as error:  # рассказываем человеку, а не в пустоту
            self.report.put(("error", str(error), None))


class Wizard:
    """Окно установки: настройка, ход дела, итог."""

    def __init__(self) -> None:
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self.root = tk.Tk()
        self.root.title(f"Установка {APP_NAME}")
        self.root.resizable(False, False)
        # Крестик обязан останавливать работу, а не оставлять её в фоне.
        self.root.protocol("WM_DELETE_WINDOW", self.close_request)

        icon = payload_dir() / "assets" / "icon.ico"
        if icon.exists():
            try:
                self.root.iconbitmap(str(icon))
            except Exception:
                pass

        self.frame = ttk.Frame(self.root, padding=(26, 22))
        self.frame.pack(fill="both", expand=True)

        self.path = tk.StringVar(value=str(default_target()))
        self.here = tk.BooleanVar(value=True)
        self.want_shortcut = tk.BooleanVar(value=True)
        self.want_open = tk.BooleanVar(value=True)
        self.path_entry = None
        self.browse_button = None

        self.queue: queue.Queue = queue.Queue()
        self.worker: Worker | None = None
        self.status = None
        self.bar = None
        self.working = False

        self.show_setup()
        self.center()

    def center(self) -> None:
        self.root.update_idletasks()
        width, height = self.root.winfo_width(), self.root.winfo_height()
        x = (self.root.winfo_screenwidth() - width) // 2
        y = (self.root.winfo_screenheight() - height) // 3
        self.root.geometry(f"+{x}+{y}")

    def clear(self) -> None:
        for child in self.frame.winfo_children():
            child.destroy()

    def close_request(self) -> None:
        """Крестик: во время установки спрашиваем, иначе просто уходим."""
        if not self.working:
            self.root.destroy()
            return
        from tkinter import messagebox

        if messagebox.askyesno(APP_NAME, "Прервать установку?"):
            self.cancel()

    # --- страница 1: настройка ------------------------------------------

    def show_setup(self) -> None:
        ttk = self.ttk
        self.clear()

        ttk.Label(self.frame, text=APP_NAME, font=("Segoe UI", 14, "bold")).pack(anchor="w")
        ttk.Label(
            self.frame,
            text="Скачивание, нарезка и сжатие медиа для паков SIGame.",
        ).pack(anchor="w", pady=(2, 16))

        ttk.Checkbutton(
            self.frame,
            text="Установить туда же, где лежит файл установщик",
            variable=self.here,
            command=self.toggle_place,
        ).pack(anchor="w")

        row = ttk.Frame(self.frame)
        row.pack(fill="x", pady=(6, 14))
        self.path_entry = ttk.Entry(row, textvariable=self.path, width=52)
        self.path_entry.pack(side="left")
        self.browse_button = ttk.Button(row, text="Обзор…", command=self.choose)
        self.browse_button.pack(side="left", padx=(8, 0))
        self.toggle_place()

        ttk.Checkbutton(
            self.frame, text="Создать ярлык на рабочем столе",
            variable=self.want_shortcut,
        ).pack(anchor="w")
        ttk.Checkbutton(
            self.frame, text="Открыть программу после установки",
            variable=self.want_open,
        ).pack(anchor="w", pady=(2, 14))

        ttk.Label(
            self.frame,
            text=(
                "Во время установки программа скачает то, что ей нужно для работы:\n"
                "Python, ffmpeg и загрузчики — около 250 МБ. Это делается один раз."
            ),
            justify="left",
            foreground="#555555",
        ).pack(anchor="w", pady=(0, 16))

        buttons = ttk.Frame(self.frame)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="Отмена", command=self.root.destroy).pack(side="right")
        ttk.Button(buttons, text="Установить", command=self.start).pack(
            side="right", padx=(0, 8)
        )

    def toggle_place(self) -> None:
        """Поле пути живёт, только когда человек снял галочку."""
        if self.here.get():
            self.path.set(str(default_target()))
            state = "disabled"
        else:
            self.path.set(str(system_target()))
            state = "normal"
        self.path_entry.config(state=state)
        self.browse_button.config(state=state)

    def choose(self) -> None:
        from tkinter import filedialog

        picked = filedialog.askdirectory(title="Куда установить программу")
        if picked:
            self.path.set(str(Path(picked) / APP_NAME))

    # --- страница 2: ход дела -------------------------------------------

    def show_progress(self) -> None:
        ttk = self.ttk
        self.clear()

        ttk.Label(self.frame, text="Устанавливаю", font=("Segoe UI", 14, "bold")).pack(
            anchor="w"
        )
        ttk.Label(
            self.frame,
            text="Можно свернуть окно — программа сообщит, когда закончит.",
        ).pack(anchor="w", pady=(2, 16))

        self.bar = ttk.Progressbar(self.frame, length=470, maximum=100)
        self.bar.pack()
        self.status = ttk.Label(self.frame, text="Начинаю…")
        self.status.pack(anchor="w", pady=(10, 16))

        buttons = ttk.Frame(self.frame)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="Отмена", command=self.cancel).pack(side="right")

    def start(self) -> None:
        from tkinter import messagebox

        target = Path(self.path.get().strip())
        if not target.name:
            messagebox.showerror(APP_NAME, "Укажите папку для установки.")
            return
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            messagebox.showerror(APP_NAME, f"Не получается создать папку:\n{error}")
            return

        self.show_progress()
        self.working = True
        self.worker = Worker(target, self.want_shortcut.get(), self.queue)
        threading.Thread(target=self.worker.run, name="install", daemon=True).start()
        self.root.after(100, self.pump)

    def cancel(self) -> None:
        if self.worker:
            self.worker.stop.set()
        if self.status:
            self.status.config(text="Останавливаю…")

    def pump(self) -> None:
        """Забирает сообщения от рабочего потока. Окно всё это время живое."""
        try:
            while True:
                kind, text, percent = self.queue.get_nowait()
                if kind == "step":
                    if text:
                        self.status.config(text=text)
                    if percent is not None:
                        self.bar.config(value=percent)
                elif kind == "done":
                    self.working = False
                    self.show_done()
                    return
                elif kind == "cancelled":
                    self.working = False
                    self.root.destroy()
                    return
                elif kind == "error":
                    self.working = False
                    self.show_error(text or "")
                    return
        except queue.Empty:
            pass
        self.root.after(100, self.pump)

    # --- страница 3: итог ------------------------------------------------

    def show_done(self) -> None:
        ttk = self.ttk
        self.clear()

        ttk.Label(self.frame, text="Готово", font=("Segoe UI", 14, "bold")).pack(anchor="w")
        ttk.Label(
            self.frame,
            text=f"{APP_NAME} установлен в:\n{self.worker.target}",
            justify="left",
        ).pack(anchor="w", pady=(4, 18))

        buttons = ttk.Frame(self.frame)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="Закрыть", command=self.finish).pack(side="right")
        self.center()

    def show_error(self, text: str) -> None:
        ttk = self.ttk
        self.clear()

        ttk.Label(
            self.frame, text="Установка не завершилась", font=("Segoe UI", 14, "bold")
        ).pack(anchor="w")
        ttk.Label(
            self.frame,
            text=(
                f"{text}\n\n"
                "Чаще всего это интернет или антивирус. Проверьте соединение\n"
                "и запустите установку ещё раз."
            ),
            justify="left",
            wraplength=470,
        ).pack(anchor="w", pady=(6, 18))

        buttons = ttk.Frame(self.frame)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="Закрыть", command=self.root.destroy).pack(side="right")
        self.center()

    def finish(self) -> None:
        if self.want_open.get() and self.worker:
            start_app(self.worker.target)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    # Программа уже стоит рядом — значит нас позвали как обычный ярлык.
    if installed_python(own_dir()):
        start_app(own_dir())
        return 0

    Wizard().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
