"""Корневые сертификаты для HTTPS-запросов из самого приложения.

Python на Windows не читает системное хранилище сертификатов, поэтому обычный
``urllib`` отваливается с «unable to get local issuer certificate» — и на
чистой системе это ломает даже загрузку ffmpeg с GitHub. Набор корней несёт
с собой пакет ``certifi``; ровно поэтому yt-dlp работает там, где наш код нет.

Модуль намеренно крошечный и ни от чего не зависит: им пользуются и загрузчик
инструментов, и прокси предпросмотра.
"""

from __future__ import annotations

import ssl

_cached: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """Контекст с корнями certifi, с откатом на системный набор."""
    global _cached
    if _cached is None:
        try:
            import certifi

            _cached = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            _cached = ssl.create_default_context()
    return _cached
