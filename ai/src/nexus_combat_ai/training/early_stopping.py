"""`EarlyStopping` (EN-036.3, Management #567 §31-34, §83-84): monitorea
SOLO `validation loss` -- nunca train loss, nunca ninguna metrica de test
(#567 §31, §85: el test set esta aislado de esta clase por construccion,
porque esta clase ni siquiera recibe datos, solo el escalar `validation_loss`
que el caller ya calculo).

Mejora v1 (#567 §32): `validation_loss < best_loss - min_delta`. La igualdad
NUNCA reinicia la paciencia. `min_delta` es una decision tecnica versionada
(`TrainingConfig.min_delta`, v1 = 0.0), nunca un epsilon escondido."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class EarlyStopping:
    patience: int
    min_delta: float = 0.0

    best_loss: float = math.inf
    best_epoch: int = -1
    _epochs_without_improvement: int = 0

    def step(self, validation_loss: float, epoch: int) -> bool:
        """Registra el resultado de UN epoch ya terminado. Devuelve `True`
        si el training debe detenerse (`#567` §31: `patience` epochs
        consecutivos sin mejora)."""
        if validation_loss < self.best_loss - self.min_delta:
            self.best_loss = validation_loss
            self.best_epoch = epoch
            self._epochs_without_improvement = 0
            return False

        self._epochs_without_improvement += 1
        return self._epochs_without_improvement >= self.patience

    @property
    def epochs_without_improvement(self) -> int:
        return self._epochs_without_improvement
