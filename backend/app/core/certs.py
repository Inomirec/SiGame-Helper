"""Корневые сертификаты для HTTPS-запросов из самого приложения.

Python на Windows не читает системное хранилище сертификатов, поэтому обычный
``urllib`` отваливается с «unable to get local issuer certificate» — и на
чистой системе это ломает даже загрузку ffmpeg с GitHub. Набор корней несёт
с собой пакет ``certifi``; ровно поэтому yt-dlp работает там, где наш код нет.

Модуль намеренно крошечный и ни от чего не зависит: им пользуются и загрузчик
инструментов, и прокси предпросмотра.
"""

from __future__ import annotations

import socket
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


def ipv4_opener() -> "urllib.request.OpenerDirector":
    """HTTP-открыватель, который ходит только по IPv4 и с корнями certifi.

    Обходы блокировок вроде Zapret и GoodbyeDPI работают на уровне пакетов
    и понимают только IPv4. Если сервер отвечает и по IPv6, система может
    выбрать именно его — тогда обход не применяется и соединение просто
    виснет. Браузер такое переживает за счёт быстрого отката на IPv4,
    а обычный urllib — нет.
    """
    global _opener
    if _opener is None:
        import http.client
        import urllib.request

        def connect_ipv4(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
            host, port = address
            infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
            last: Exception | None = None
            for family, kind, proto, _canon, sockaddr in infos:
                sock = socket.socket(family, kind, proto)
                try:
                    if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                        sock.settimeout(timeout)
                    if source_address:
                        sock.bind(source_address)
                    sock.connect(sockaddr)
                    return sock
                except OSError as exc:
                    last = exc
                    sock.close()
            raise last or OSError("не удалось подключиться по IPv4")

        class HTTPSConnectionV4(http.client.HTTPSConnection):
            _create_connection = staticmethod(connect_ipv4)

        class HTTPConnectionV4(http.client.HTTPConnection):
            _create_connection = staticmethod(connect_ipv4)

        class HTTPSHandlerV4(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return self.do_open(HTTPSConnectionV4, req, context=ssl_context())

        class HTTPHandlerV4(urllib.request.HTTPHandler):
            def http_open(self, req):
                return self.do_open(HTTPConnectionV4, req)

        _opener = urllib.request.build_opener(HTTPSHandlerV4, HTTPHandlerV4)
    return _opener


_opener = None
