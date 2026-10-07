"""`candidate-mlp-train-v1` (EN-036.3, Management #567 §13-14, §56): toda la
configuracion de un training run en UN solo lugar versionado -- ningun
hiperparametro disperso en `trainer.py`/el CLI.

Separa, igual que los docs de #567 (§97), REQUISITO (#567/#555) de DECISION
TECNICA v1:

- `optimizer="AdamW"`, `learning_rate=0.001`, `batch_size=256`,
  `max_epochs=30`, `early_stopping_patience=5`: fijados por el issue padre
  #555 y por #567, no se eligen aqui.
- `weight_decay=0.01`: el issue NO fija weight decay (#567 §14). Decision
  tecnica v1 explicita (no un default accidental de AdamW): valor estandar
  para AdamW, documentado aqui y persistido en el training manifest.
- `min_delta=0.0`: el issue no define un margen de "mejora" para early
  stopping (#567 §32). Decision tecnica v1: igualdad NO es mejora, sin
  epsilon escondido.
- `num_workers=0`: reproducibilidad CPU v1 (#567 §28, §30); evita
  multiprocessing innecesario para un dataset diminuto.
"""

from __future__ import annotations

from dataclasses import dataclass

from nexus_combat_ai.dataset.manifest import fingerprint_of
from nexus_combat_ai.errors import InvalidTrainingConfigError
from nexus_combat_ai.model.candidate_mlp import MODEL_ARCHITECTURE_VERSION
from nexus_combat_ai.training.loss import LOSS_VERSION

TRAINING_CONFIG_VERSION = "candidate-mlp-train-v1"


@dataclass(frozen=True, slots=True)
class TrainingConfig:
    seed: int
    version: str = TRAINING_CONFIG_VERSION
    model_architecture_version: str = MODEL_ARCHITECTURE_VERSION
    loss_version: str = LOSS_VERSION
    optimizer: str = "AdamW"
    learning_rate: float = 0.001
    weight_decay: float = 0.01
    batch_size: int = 256
    max_epochs: int = 30
    early_stopping_patience: int = 5
    min_delta: float = 0.0
    num_workers: int = 0

    def __post_init__(self) -> None:
        if self.batch_size <= 0:
            raise InvalidTrainingConfigError("batch_size debe ser > 0.")
        if self.max_epochs <= 0:
            raise InvalidTrainingConfigError("max_epochs debe ser > 0.")
        if self.early_stopping_patience <= 0:
            raise InvalidTrainingConfigError("early_stopping_patience debe ser > 0.")
        if self.min_delta < 0.0:
            raise InvalidTrainingConfigError("min_delta debe ser >= 0.")
        if self.num_workers < 0:
            raise InvalidTrainingConfigError("num_workers debe ser >= 0.")

    def as_dict(self) -> dict[str, object]:
        return {
            "trainingConfigVersion": self.version,
            "modelArchitectureVersion": self.model_architecture_version,
            "lossVersion": self.loss_version,
            "optimizer": self.optimizer,
            "learningRate": self.learning_rate,
            "weightDecay": self.weight_decay,
            "batchSize": self.batch_size,
            "maxEpochs": self.max_epochs,
            "earlyStoppingPatience": self.early_stopping_patience,
            "minDelta": self.min_delta,
            "numWorkers": self.num_workers,
            "trainingSeed": self.seed,
        }

    def fingerprint(self) -> str:
        """`trainingConfigSha256` (#567 §56): arquitectura + config + loss +
        seed, nunca el estado del modelo (eso es `modelStateSha256`)."""
        return fingerprint_of(self.as_dict())
