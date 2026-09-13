"""Удаление файла в корзину, а не мимо неё.

Проводник кладёт удалённое в корзину, и человек справедливо ждёт того же
от программы: промахнулся мышью — вернул. Python такого не умеет, поэтому
зовём ту же функцию Windows, которой пользуется сам проводник.

Сторонняя библиотека для этого не нужна: одна функция через ctypes избавляет
от лишней зависимости, которую пришлось бы ставить на каждом компьютере.
"""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes
from pathlib import Path

#: Код операции «удалить» для SHFileOperationW.
_FO_DELETE = 3

#: Без окон, без вопросов, без своих сообщений об ошибках — и с возможностью
#: отмены, то есть через корзину.
_FOF_SILENT = 0x0004
_FOF_NOCONFIRMATION = 0x0010
_FOF_ALLOWUNDO = 0x0040
_FOF_NOERRORUI = 0x0400


class _FileOp(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", ctypes.c_uint16),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


def available() -> bool:
    """Есть ли корзина. На не-Windows её здесь нет."""
    return sys.platform == "win32"


def to_trash(path: Path) -> None:
    """Отправляет файл в корзину. Бросает OSError, если не вышло."""
    if not available():
        raise OSError("Корзина доступна только в Windows")

    # Список файлов передаётся одной строкой с двумя нулями на конце.
    # create_unicode_buffer сам дописывает один, поэтому свой нужен только
    # для разделителя.
    names = ctypes.create_unicode_buffer(str(path.resolve()) + "\0")

    operation = _FileOp()
    operation.hwnd = None
    operation.wFunc = _FO_DELETE
    operation.pFrom = ctypes.cast(names, wintypes.LPCWSTR)
    operation.pTo = None
    operation.fFlags = _FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_SILENT | _FOF_NOERRORUI

    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if code != 0:
        raise OSError(code, f"Windows не смогла отправить файл в корзину (код {code})")
    if operation.fAnyOperationsAborted:
        raise OSError("Удаление прервано")
    # Windows иногда возвращает успех, ничего не удалив, — проверяем сами.
    if os.path.exists(path):
        raise OSError("Файл остался на месте")
