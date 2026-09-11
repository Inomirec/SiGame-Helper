"""Запуск SiGame Helper.

Два режима:
  python run.py            — сервер + вкладка в браузере (максимальная совместимость)
  python run.py --window   — отдельное окно приложения (PyWebView / WebView2)
  python run.py --headless — только сервер, ничего не открывать

Кодирование всегда идёт в отдельных процессах ffmpeg, поэтому интерфейс
остаётся отзывчивым независимо от режима запуска.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import json
import logging
import os
import socket
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from pathlib import Path

# Позволяет запускать файл напрямую: python backend/run.py
sys.path.insert(0, str(Path(__file__).resolve().parent))

DEFAULT_PORT = 8756
HOST = "127.0.0.1"

#: True, когда приложение запущено без консоли (pythonw.exe или собранный .exe).
_headless_console = False


def log_file() -> Path:
    """Файл журнала. Если пакет приложения ещё не импортирован — временная папка."""
    try:
        from app.paths import ensure_dirs, logs_dir

        ensure_dirs()
        return logs_dir() / "app.log"
    except Exception:
        return Path(tempfile.gettempdir()) / "sigame-helper.log"


def attach_streams() -> None:
    """Даёт приложению рабочие stdout/stderr.

    Под ``pythonw.exe`` и в собранном .exe без консоли оба потока равны None.
    Логгер uvicorn пишет в stderr и падает на этом при первом же сообщении,
    из-за чего окно приложения так и не открывается. Перенаправляем вывод
    в файл — заодно получаем журнал на случай разбора проблем.
    """
    global _headless_console
    if sys.stdout is not None and sys.stderr is not None:
        return

    _headless_console = True
    handle = open(log_file(), "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = handle


def report_fatal(text: str) -> None:
    """Сообщает о неустранимой ошибке так, чтобы её точно увидели.

    В консольном режиме достаточно печати, а вот запуск двойным кликом консоли
    не имеет: там показываем системное окно с ошибкой, иначе пользователь видит
    ровно ничего.
    """
    with contextlib.suppress(Exception):
        print(text, file=sys.stderr)

    if _headless_console and sys.platform == "win32":
        with contextlib.suppress(Exception):
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                None, text, "SiGame Helper — не удалось запустить", 0x10
            )


def find_free_port(preferred: int, host: str = HOST, attempts: int = 20) -> int:
    """Ищет свободный порт, начиная с предпочтительного."""
    for offset in range(attempts):
        candidate = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(f"Не нашлось свободного порта в диапазоне {preferred}-{preferred + attempts}")


def wait_until_up(host: str, port: int, timeout: float = 20.0) -> bool:
    """Ждёт, пока сервер начнёт принимать соединения."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.4)
            if probe.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.15)
    return False


def run_server(host: str, port: int, *, log_level: str = "info"):
    """Поднимает uvicorn в фоновом потоке и возвращает объект сервера."""
    import uvicorn

    from app.main import app

    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level=log_level,
        access_log=False,
        # SSE-поток живёт долго: не даём воркеру рвать соединение по таймауту.
        timeout_keep_alive=75,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="uvicorn", daemon=True)
    thread.start()
    return server


def _set_window_icon(window, icon: Path) -> None:
    """Ставит окну собственную иконку.

    PyWebView на Windows свой параметр ``icon`` не использует: он жёстко
    берёт значок у ``sys.executable``, то есть у pythonw.exe. Поэтому
    программа и показывалась среди открытых приложений как файл Python.

    Меняем значок у самой формы окна. Послать окну ``WM_SETICON`` тоже
    можно, но WinForms при следующей перерисовке возвращает свой обратно,
    а свойство формы держится.
    """
    log = logging.getLogger("sigame-helper")
    form = getattr(window, "native", None)
    if form is None:
        log.warning("окно ещё не создано — иконку поставить не на что")
        return
    try:
        import clr  # noqa: F401 - подключает мост к .NET

        clr.AddReference("System.Drawing")
        from System import Action  # type: ignore[import-not-found]
        from System.Drawing import Icon  # type: ignore[import-not-found]

        # Свойства формы меняются только из её собственного потока.
        form.Invoke(Action(lambda: setattr(form, "Icon", Icon(str(icon)))))
        log.info("иконка окна установлена")
    except Exception:
        log.warning("не удалось поставить иконку окна", exc_info=True)


#: Подписка на перетаскивание живёт ровно один раз: страница у нас одна,
#: а событие «страница загрузилась» приходит и при обновлении окна.
_drop_ready = False


def _enable_file_drop(window) -> None:
    """Учит окно принимать файлы, перетащенные из проводника.

    Сама страница видит у брошенного файла только имя: путей браузеры не
    отдают из соображений безопасности. Зато WebView2 умеет передать окну
    вместе с броском и сами файлы — на этом построен штатный обработчик
    ``drop`` в pywebview, где у каждого файла есть настоящий путь
    (``pywebviewFullPath``).

    Трогать ``AllowExternalDrop`` у браузера нельзя: стоит забрать
    перетаскивание у страницы, и Windows рисует перечёркнутый курсор — бросок
    не доходит уже ни до кого. Ровно так мы и сломали это в прошлый раз.
    """
    global _drop_ready

    log = logging.getLogger("sigame-helper")
    if _drop_ready:
        return

    def on_drop(event) -> None:
        """Достаёт пути и отдаёт их странице обычным событием."""
        try:
            files = (event or {}).get("dataTransfer", {}).get("files") or []
            paths = [
                file["pywebviewFullPath"]
                for file in files
                if isinstance(file, dict) and file.get("pywebviewFullPath")
            ]
            log.info("перетащено файлов: %s из %s", len(paths), len(files))
            if not paths:
                return
            payload = json.dumps(paths, ensure_ascii=False)
            window.evaluate_js(
                "window.dispatchEvent(new CustomEvent('sgh:drop',"
                f" {{ detail: {payload} }}))"
            )
        except Exception:
            log.warning("не удалось принять перетащенные файлы", exc_info=True)

    try:
        from webview.dom import DOMEventHandler

        window.dom.document.events.drop += DOMEventHandler(on_drop, prevent_default=True)
        _drop_ready = True
        log.info("перетаскивание файлов включено")
    except Exception:
        log.warning("перетаскивание файлов включить не удалось", exc_info=True)


def launch_window(url: str, port: int) -> bool:
    """Пытается открыть нативное окно. Возвращает False, если PyWebView недоступен."""
    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        return False

    from app import __version__

    # Панель задач опознаёт приложение не по окну и не по .exe, а по
    # AppUserModelID. Своего у нас не было, поэтому Windows брала личность
    # у pythonw.exe — и его значок, сколько бы мы ни меняли иконку окна.
    # Назначить надо до создания окна.
    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                "Inomirec.SiGameHelper"
            )
            current = ctypes.c_wchar_p()
            ctypes.windll.shell32.GetCurrentProcessExplicitAppUserModelID(
                ctypes.byref(current)
            )
            logging.getLogger("sigame-helper").info(
                "личность приложения: %s", current.value
            )

    title = f"SiGame Helper {__version__}"
    window = webview.create_window(
        title,
        url,
        width=1500,
        height=940,
        min_size=(1080, 680),
        background_color="#0b0d12",
        text_select=True,
    )

    # Своя папка профиля вместо временной. По умолчанию pywebview открывает
    # окно «начисто»: каждый запуск заново спрашивает разрешение на доступ
    # к буферу обмена и забывает мелочи вроде громкости плеера. Настройки
    # программы тут ни при чём — они и так лежат отдельным файлом.
    from app.paths import data_dir, ensure_dirs

    ensure_dirs()
    storage = data_dir() / "window"
    storage.mkdir(parents=True, exist_ok=True)

    # Без своей иконки окно показывается в панели задач как файл Python.
    icon = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
    if icon.exists() and sys.platform == "win32":
        # Ждём штатного события: раньше показа окна ставить значок не на что.
        window.events.shown += lambda: _set_window_icon(window, icon)

    # Перетаскивание файлов из проводника. Ждём именно загрузки страницы:
    # обработчик вешается на её document, а до этого вешать не на что.
    window.events.loaded += lambda: _enable_file_drop(window)

    try:
        webview.start(
            debug=False,
            private_mode=False,
            storage_path=str(storage),
            icon=str(icon) if icon.exists() else None,
        )
    except Exception:  # WebView2 может отсутствовать на голой системе
        logging.getLogger("sigame-helper").exception("Не удалось открыть окно приложения")
        return False
    return True


def bootstrap_tools() -> int:
    """Доустанавливает недостающие инструменты и выходит.

    Вызывается установочным bat-файлом, чтобы пользователю не приходилось
    ничего искать в настройках: после установки всё уже на месте.
    """
    import asyncio

    from app.core import binaries, toolchain

    detected = binaries.detect_all(refresh=True)
    for name in ("yt-dlp", "gallery-dl"):
        info = detected.get(name)
        state = info.version if info and info.available else "НЕ НАЙДЕН"
        print(f"  {name:<12} {state}")

    last = [-1]

    async def report(value: float, message: str) -> None:
        percent = int(value * 100)
        # Печатаем не чаще, чем раз на процент, иначе консоль захлёбывается.
        if percent != last[0]:
            last[0] = percent
            print(f"\r  {percent:3d}%  {message:<48}", end="", flush=True)

    failures = 0

    ffmpeg = detected.get("ffmpeg")
    ffprobe = detected.get("ffprobe")
    if ffmpeg and ffmpeg.available and ffprobe and ffprobe.available:
        print(f"  {'ffmpeg':<12} {ffmpeg.version}")
        print(f"  {'ffprobe':<12} {ffprobe.version}")
    elif sys.platform != "win32":
        print("  ffmpeg не найден. Установите его через пакетный менеджер системы.")
        failures += 1
    else:
        print("  ffmpeg не найден — скачиваю готовую сборку (около 160 МБ)...")
        last[0] = -1
        try:
            result = asyncio.run(toolchain.install_ffmpeg(report))
            print(f"\n  ffmpeg {result.get('version')} установлен в {toolchain.target_dir()}")
        except Exception as exc:  # сеть, права на запись, изменившийся архив
            print(f"\n  Не удалось скачать ffmpeg: {exc}")
            print("  Положите ffmpeg.exe и ffprobe.exe в папку bin вручную.")
            failures += 1

    # Deno нужен yt-dlp, чтобы решать защиту YouTube. Без него сайт отвечает
    # «Sign in to confirm you're not a bot» даже с правильными куками.
    deno = detected.get("deno")
    if deno and deno.available:
        print(f"  {'deno':<12} {deno.version}")
    elif sys.platform != "win32":
        print("  Deno не найден — YouTube может не скачиваться. Поставьте deno вручную.")
    else:
        print("  Deno не найден — скачиваю (около 40 МБ), без него не работает YouTube...")
        last[0] = -1
        try:
            result = asyncio.run(toolchain.install_deno(report))
            print(f"\n  Deno {result.get('version')} установлен в {toolchain.target_dir()}")
        except Exception as exc:
            print(f"\n  Не удалось скачать Deno: {exc}")
            print("  Скачивание с YouTube может не работать, остальное — будет.")

    return 1 if failures else 0


def ask_running_instance(host: str, port: int, path: str) -> bool:
    """Просит уже открытую программу показать файл. False — она не запущена."""
    import json
    import urllib.error
    import urllib.request

    payload = json.dumps({"path": path}).encode("utf-8")
    request = urllib.request.Request(
        f"http://{host}:{port}/api/settings/open-file",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="SiGame Helper")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--window", action="store_true", help="открыть в отдельном окне")
    parser.add_argument("--browser", action="store_true", help="открыть во вкладке браузера")
    parser.add_argument("--headless", action="store_true", help="не открывать интерфейс")
    parser.add_argument(
        "--setup", action="store_true", help="доустановить недостающие инструменты и выйти"
    )
    parser.add_argument("--log-level", default="info")
    # Windows передаёт путь так, когда файл бросают на ярлык программы
    # или открывают его через «Открыть с помощью».
    parser.add_argument("path", nargs="?", help="файл, который нужно открыть")
    args = parser.parse_args()

    if args.setup:
        return bootstrap_tools()

    # Программа уже открыта — не поднимаем вторую, а просим показать файл.
    if args.path and ask_running_instance(args.host, args.port, args.path):
        return 0

    from app.paths import is_frozen

    # Собранный .exe запускают двойным кликом без аргументов — там уместнее окно.
    if is_frozen() and not (args.window or args.browser or args.headless):
        args.window = True

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    port = find_free_port(args.port, args.host)
    url = f"http://{args.host}:{port}"

    server = run_server(args.host, port, log_level=args.log_level)
    if not wait_until_up(args.host, port):
        print("Сервер не запустился. Смотрите сообщения выше.", file=sys.stderr)
        return 1

    if args.path:
        ask_running_instance(args.host, port, args.path)

    from app import __version__

    print(f"\n  SiGame Helper {__version__}")
    print(f"  Интерфейс: {url}")
    print("  Остановить: Ctrl+C\n")

    try:
        if args.headless:
            while True:
                time.sleep(0.5)
        elif args.window:
            if not launch_window(url, port):
                print("PyWebView недоступен — открываю в браузере.")
                webbrowser.open(url)
                while True:
                    time.sleep(0.5)
        else:
            webbrowser.open(url)
            while True:
                time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nЗавершение…")
    finally:
        server.should_exit = True
        with contextlib.suppress(Exception):
            time.sleep(0.5)
    return 0


def guarded_main() -> int:
    """Обёртка вокруг main(): ни одна ошибка не должна пропасть беззвучно."""
    attach_streams()
    try:
        return main()
    except SystemExit:
        raise
    except BaseException:
        details = traceback.format_exc()
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with contextlib.suppress(Exception):
            with open(log_file(), "a", encoding="utf-8") as handle:
                handle.write(f"{chr(10)}=== {stamp} ==={chr(10)}{details}")
        last_line = details.strip().splitlines()[-1]
        report_fatal(
            "Приложение не смогло запуститься."
            + chr(10) * 2
            + last_line
            + chr(10) * 2
            + "Подробности записаны в файл:"
            + chr(10)
            + str(log_file())
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(guarded_main())
