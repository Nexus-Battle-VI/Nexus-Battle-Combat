"""`teacher-policy-cross-entropy-v1` (EN-036.3, Management #567 §15-18): la
loss principal de v1.

DECISION TECNICA V1 (#567 §15, §97): el issue exige imitation/supervised
learning pero no fija la loss exacta. El teacher ya produce una distribucion
completa (`candidate.probability`, derivada de visitas MCTS) en vez de un
unico indice elegido -- reducir eso a `CrossEntropy(selectedIndex)`
desperdiciaria la senal de "que tan buenos son los OTROS candidatos" que el
teacher ya calculo. v1 usa soft target cross-entropy contra esa distribucion
completa:

    L = -sum_i p_i * log_softmax(scores)_i,  promediado por DECISION (#567 §73)

`teacher_mean_utilities`/`teacher_visits` se conservan como metricas/evidencia
(`training/metrics.py`) pero NUNCA se mezclan en esta loss como una segunda
senal (#567 §16): v1 tiene una sola loss principal.
"""

from __future__ import annotations

import torch

from nexus_combat_ai.errors import InvalidTrainingBatchError, NonFiniteTrainingValueError

LOSS_VERSION = "teacher-policy-cross-entropy-v1"

_PROBABILITY_SUM_TOLERANCE = 1e-3


def validate_batch(
    *,
    teacher_probabilities: torch.Tensor,
    candidate_mask: torch.Tensor,
    selected_index: torch.Tensor,
) -> None:
    """Invariantes del batch ANTES de calcular nada (#567 §18): nunca se
    entrena en silencio sobre una distribucion corrupta."""
    if candidate_mask.sum(dim=1).eq(0).any():
        raise InvalidTrainingBatchError(
            "Al menos una fila del batch no tiene ningun candidato real "
            "(candidate_mask.sum() == 0)."
        )

    max_candidates = candidate_mask.shape[1]
    if (selected_index < 0).any() or (selected_index >= max_candidates).any():
        raise InvalidTrainingBatchError("selected_index fuera de rango para alguna fila.")

    row_has_selected = candidate_mask.gather(1, selected_index.unsqueeze(1)).squeeze(1)
    if not bool(row_has_selected.all()):
        raise InvalidTrainingBatchError(
            "selected_index apunta a una posicion de padding (candidate_mask=False) en al "
            "menos una fila."
        )

    masked_probabilities = teacher_probabilities.masked_fill(~candidate_mask, 0.0)
    if not torch.isfinite(masked_probabilities).all():
        raise NonFiniteTrainingValueError("teacher_probabilities contiene NaN/inf.")

    probability_sums = masked_probabilities.sum(dim=1)
    if not torch.allclose(
        probability_sums, torch.ones_like(probability_sums), atol=_PROBABILITY_SUM_TOLERANCE
    ):
        raise InvalidTrainingBatchError(
            "Alguna fila tiene teacher_probabilities (candidatos reales) que no suman ~1.0: "
            f"{probability_sums.tolist()}."
        )


def teacher_policy_cross_entropy_per_decision(
    scores: torch.Tensor,
    teacher_probabilities: torch.Tensor,
    candidate_mask: torch.Tensor,
) -> torch.Tensor:
    """`scores`/`teacher_probabilities`/`candidate_mask`: `[B, Cmax]` ->
    `[B]`, UNA loss por decision, SIN promediar (#567 §73): el caller decide
    como agregar sobre B (`teacher_policy_cross_entropy` promedia el batch;
    `training/trainer.py` acumula ponderado por decision real a lo largo de
    varios batches, para que el ultimo batch parcial de una epoch no pese
    distinto que el resto).

    Los candidatos de padding (`candidate_mask=False`) NUNCA participan en el
    softmax (#567 §17): se enmascaran a `-inf` ANTES de softmax, nunca se
    multiplica una probabilidad de padding (que ya es 0.0 por `collate_
    decision_samples`) contra `-inf`, que produciria NaN (`0 * -inf`)."""
    if not torch.isfinite(scores).all():
        raise NonFiniteTrainingValueError("El modelo produjo scores no finitos (NaN/inf).")

    masked_scores = scores.masked_fill(~candidate_mask, float("-inf"))
    log_probs = torch.log_softmax(masked_scores, dim=1)
    safe_log_probs = torch.where(candidate_mask, log_probs, torch.zeros_like(log_probs))

    loss_per_decision = -(teacher_probabilities * safe_log_probs).sum(dim=1)

    if not torch.isfinite(loss_per_decision).all():
        raise NonFiniteTrainingValueError("La loss por decision resulto no finita (NaN/inf).")

    return loss_per_decision


def teacher_policy_cross_entropy(
    scores: torch.Tensor,
    teacher_probabilities: torch.Tensor,
    candidate_mask: torch.Tensor,
) -> torch.Tensor:
    """Promedio POR DECISION sobre el batch (#567 §73): una decision con 10
    candidatos no pesa 10 veces mas que una de 1 (eso ya lo garantiza
    `teacher_policy_cross_entropy_per_decision`; esta funcion solo agrega un
    unico batch -- para varios batches, ver `training/trainer.py`)."""
    return teacher_policy_cross_entropy_per_decision(
        scores, teacher_probabilities, candidate_mask
    ).mean()
