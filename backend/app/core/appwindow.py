"""Доступ к окну приложения из обработчиков запросов.

Окно создаёт ``run.py``, а поднять его на передний план нужно из обычного
эндпоинта: когда программу запускают второй раз, вторая копия просит первую
показаться и закрывается. Держим здесь одну ссылку на обработчик, чтобы
роутеру не приходилось ничего знать про pywebview.
"""

from __future__ import annotations

from typing import Callable

_bring_to_front: Callable[[], None] | None = None


def register(callback: Callable[[], None]) -> None:
    """Запоминает, как показать окно. Зовётся при его создании."""
    global _bring_to_front
    _bring_to_front = callback


def has_window() -> bool:
    """Есть ли у этой копии своё окно. В режиме без окна — нет."""
    return _bring_to_front is not None


def show() -> bool:
    """Поднимает окно на передний план. False — показывать нечего."""
    if _bring_to_front is None:
        return False
    _bring_to_front()
    return True
