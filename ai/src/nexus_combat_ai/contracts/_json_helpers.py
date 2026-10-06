"""Helpers de parseo estricto compartidos por `decision_event.py` y
`teacher_label.py`. Privados al paquete `contracts`: fallan explicito ante
cualquier campo faltante, de tipo incorrecto o enum desconocido (#566 §54-56)."""

from __future__ import annotations

from typing import Any

from nexus_combat_ai.errors import ContractValidationError


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractValidationError(message)


def field(obj: dict[str, Any], name: str, path: str) -> Any:
    if name not in obj:
        raise ContractValidationError(f'Falta el campo "{name}" en {path}.')
    return obj[name]


def str_field(obj: dict[str, Any], name: str, path: str) -> str:
    value = field(obj, name, path)
    require(isinstance(value, str) and value != "", f'"{path}.{name}" debe ser texto no vacio.')
    return value


def int_field(obj: dict[str, Any], name: str, path: str) -> int:
    value = field(obj, name, path)
    require(
        isinstance(value, int) and not isinstance(value, bool), f'"{path}.{name}" debe ser entero.'
    )
    return value


def bool_field(obj: dict[str, Any], name: str, path: str) -> bool:
    value = field(obj, name, path)
    require(isinstance(value, bool), f'"{path}.{name}" debe ser booleano.')
    return value


def enum_field(obj: dict[str, Any], name: str, path: str, allowed: frozenset[str]) -> str:
    value = str_field(obj, name, path)
    require(value in allowed, f'"{path}.{name}" = "{value}" no es un valor reconocido.')
    return value
