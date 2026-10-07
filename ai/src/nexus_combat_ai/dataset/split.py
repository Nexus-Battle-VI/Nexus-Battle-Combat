"""`battle-hash-split-v1` (#566 §40-§44): split determinista 80/10/10 POR
`battleId`, nunca por decision ni por candidato.

`hash(str)` de Python esta deliberadamente prohibido aqui (`PYTHONHASHSEED`
lo aleatoriza entre procesos, #566 §41): se usa SHA-256 (stdlib, sin
dependencias) sobre `battleId` en UTF-8, truncado a sus primeros 4 bytes como
entero sin signo, modulo 100 para elegir un bucket `[0,99]`.

El split depende SOLO de `battleId`: nunca incorpora el seed de training
(#566 §44) ni el orden de lectura, asi que es estable entre ejecuciones,
procesos y maquinas.
"""

from __future__ import annotations

import hashlib
from typing import Literal

SPLIT_STRATEGY_VERSION = "battle-hash-split-v1"

Split = Literal["TRAIN", "VALIDATION", "TEST"]

_TRAIN_UPPER_BUCKET = 80  # buckets [0,79] -> TRAIN (80%)
_VALIDATION_UPPER_BUCKET = 90  # buckets [80,89] -> VALIDATION (10%); [90,99] -> TEST (10%)


def split_bucket(battle_id: str) -> int:
    """Entero estable en `[0,99]`, derivado solo de `battle_id`."""
    digest = hashlib.sha256(battle_id.encode("utf-8")).digest()
    value = int.from_bytes(digest[:4], byteorder="big", signed=False)
    return value % 100


def split_for_battle(battle_id: str) -> Split:
    bucket = split_bucket(battle_id)
    if bucket < _TRAIN_UPPER_BUCKET:
        return "TRAIN"
    if bucket < _VALIDATION_UPPER_BUCKET:
        return "VALIDATION"
    return "TEST"
