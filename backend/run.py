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
import logging
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


def launch_window(url: str, port: int) -> bool:
    """Пытается открыть нативное окно. Возвращает False, если PyWebView недоступен."""
    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        return False

    from app import __version__

    window = webview.create_window(
        f"SiGame Helper {__version__}",
        url,
        width=1500,
        height=940,
        min_size=(1080, 680),
        background_color="#0b0d12",
        text_select=True,
    )
    # Дополнительное окно не нужно: всё живёт на одной странице.
    del window

    # Своя папка профиля вместо временной. По умолчанию pywebview открывает
    # окно «начисто»: каждый запуск заново спрашивает разрешение на доступ
    # к буферу обмена и забывает мелочи вроде громкости плеера. Настройки
    # программы тут ни при чём — они и так лежат отдельным файлом.
    from app.paths import data_dir, ensure_dirs

    ensure_dirs()
    storage = data_dir() / "window"
    storage.mkdir(parents=True, exist_ok=True)

    try:
        webview.start(debug=False, private_mode=False, storage_path=str(storage))
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
    args = parser.parse_args()

    if args.setup:
        return bootstrap_tools()

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
