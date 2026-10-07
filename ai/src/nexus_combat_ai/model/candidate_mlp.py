"""`candidate-mlp-v1` (EN-036.3, Management #567 §3, #555): arquitectura
OFICIAL fijada por el issue padre -- `input -> Linear(64) -> ReLU ->
Linear(32) -> ReLU -> Linear(1)` -- con `input` resuelto a
`FEATURE_DIMENSION` (`feature-schema-v1`, #566), nunca el entero `72`
repetido a mano en este modulo ni en ningun otro (#567 §3).

La red puntua UN candidato a la vez: `CandidateScoringMLP.forward` acepta
`[N, FEATURE_DIMENSION]` para cualquier `N >= 1` y devuelve `[N]` -- el
candidate axis es una propiedad del BATCH/dataset (longitud variable por
decision, #566 §37-39), nunca del modelo. `batch_size=256` de #567 es
configuracion de TRAINING (cuantas DECISIONES por paso), no una dimension
fija de esta arquitectura (#567 §12, §72).

Salida: RAW SCORE (`Linear(32, 1)` sin sigmoid/softmax, #567 §10, §135). El
softmax es herramienta del LOSS de entrenamiento (`training/loss.py`), nunca
parte del grafo ONNX productivo: #568 hara `argmax` directo sobre estos
scores para elegir la accion.

Sin Dropout/BatchNorm/LayerNorm (#567 §134): la arquitectura oficial de v1 es
deliberadamente simple.
"""

from __future__ import annotations

import torch
from torch import nn

from nexus_combat_ai.features.schema import FEATURE_DIMENSION

MODEL_ARCHITECTURE_VERSION = "candidate-mlp-v1"

_HIDDEN_1 = 64
_HIDDEN_2 = 32


class CandidateScoringMLP(nn.Module):
    """`State + CandidateAction -> score`. No conoce `actionIdentity`,
    `battleId`, `eventId` ni ningun otro identificador (#567 §65): el orden
    `candidate_features[i] -> scores[i]` es la UNICA relacion que el llamador
    (training o, en #568, `NeuralPolicy`) usa para recuperar que accion
    corresponde a cada score (#567 §136)."""

    def __init__(self, input_dim: int = FEATURE_DIMENSION) -> None:
        super().__init__()
        self.input_dim = input_dim
        self.network = nn.Sequential(
            nn.Linear(input_dim, _HIDDEN_1),
            nn.ReLU(),
            nn.Linear(_HIDDEN_1, _HIDDEN_2),
            nn.ReLU(),
            nn.Linear(_HIDDEN_2, 1),
        )

    def forward(self, candidate_features: torch.Tensor) -> torch.Tensor:
        """`[N, input_dim] -> [N]` para cualquier `N >= 1` (#567 §12): el
        `squeeze(-1)` final colapsa la salida `[N, 1]` de la ultima capa
        lineal, nunca un `batch_size` fijo asumido."""
        return self.network(candidate_features).squeeze(-1)

    def trainable_parameter_count(self) -> int:
        """Derivado del modelo real, nunca hardcodeado (#567 §132-133)."""
        return sum(p.numel() for p in self.parameters() if p.requires_grad)
