"""`train_model`/`evaluate_model` (EN-036.3, Management #567 §26-28, §33-34,
§37-38, §70, §77-78, §85).

Separacion deliberada (#567 §27, §85): `train_model` acepta `train_loader`/
`validation_loader` pero NUNCA `test_loader` -- el test set queda aislado de
`train_model` por la FIRMA de la funcion, no por disciplina de quien la
llama. `evaluate_model` es generica (no sabe si el loader que recibe es
validation o test); el CLI (`cli/train_model.py`) decide cuando invocarla
sobre test, UNA sola vez, despues de restaurar el best checkpoint (#567
§77)."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import torch

from nexus_combat_ai.errors import NonFiniteTrainingValueError
from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP
from nexus_combat_ai.training.config import TrainingConfig
from nexus_combat_ai.training.early_stopping import EarlyStopping
from nexus_combat_ai.training.loss import (
    teacher_policy_cross_entropy_per_decision,
    validate_batch,
)
from nexus_combat_ai.training.metrics import EpochMetrics, SplitMetrics, masked_argmax


@dataclass(frozen=True, slots=True)
class TrainingResult:
    best_epoch: int
    epochs_run: int
    stopped_early: bool
    best_state_dict: dict[str, torch.Tensor]
    epoch_history: tuple[EpochMetrics, ...]


def _score_batch(model: CandidateScoringMLP, batch: dict[str, Any]) -> torch.Tensor:
    """`[B, Cmax, F] -> [B, Cmax]`: aplana a `[B*Cmax, F]` para una sola
    llamada al modelo (que solo conoce `[N, F] -> [N]`, #567 §12) y vuelve a
    separar por decision."""
    features: torch.Tensor = batch["candidate_features"]
    if not torch.isfinite(features).all():
        raise NonFiniteTrainingValueError("candidate_features contiene NaN/inf.")
    batch_size, max_candidates, feature_dim = features.shape
    flat_scores = model(features.reshape(batch_size * max_candidates, feature_dim))
    return flat_scores.reshape(batch_size, max_candidates)


def _run_training_epoch(
    model: CandidateScoringMLP,
    loader: Iterable[dict[str, Any]],
    optimizer: torch.optim.Optimizer,
) -> float:
    model.train()
    total_loss = 0.0
    total_decisions = 0

    for batch in loader:
        mask = batch["candidate_mask"]
        probabilities = batch["teacher_probabilities"]
        selected_index = batch["selected_index"]
        validate_batch(
            teacher_probabilities=probabilities, candidate_mask=mask, selected_index=selected_index
        )

        scores = _score_batch(model, batch)
        per_decision_loss = teacher_policy_cross_entropy_per_decision(scores, probabilities, mask)
        loss = per_decision_loss.mean()

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        total_loss += per_decision_loss.detach().sum().item()
        total_decisions += per_decision_loss.shape[0]

    return total_loss / total_decisions


def evaluate_model(model: CandidateScoringMLP, loader: Iterable[dict[str, Any]]) -> SplitMetrics:
    """Solo lectura (`model.eval()` + `torch.no_grad()`, #567 §70). Acumula
    PONDERADO por decision real a lo largo de todos los batches, no como un
    promedio-de-promedios-de-batch (un ultimo batch parcial no debe pesar
    igual que uno completo)."""
    model.eval()
    total_loss = 0.0
    total_top1_correct = 0.0
    total_probability = 0.0
    total_utility = 0.0
    total_decisions = 0

    with torch.no_grad():
        for batch in loader:
            mask = batch["candidate_mask"]
            probabilities = batch["teacher_probabilities"]
            utilities = batch["teacher_mean_utilities"]
            selected_index = batch["selected_index"]
            validate_batch(
                teacher_probabilities=probabilities,
                candidate_mask=mask,
                selected_index=selected_index,
            )

            scores = _score_batch(model, batch)
            per_decision_loss = teacher_policy_cross_entropy_per_decision(
                scores, probabilities, mask
            )
            chosen = masked_argmax(scores, mask)

            decisions_in_batch = per_decision_loss.shape[0]
            total_loss += per_decision_loss.sum().item()
            total_top1_correct += (chosen == selected_index).float().sum().item()
            total_probability += (
                probabilities.gather(1, chosen.unsqueeze(1)).squeeze(1).sum().item()
            )
            total_utility += utilities.gather(1, chosen.unsqueeze(1)).squeeze(1).sum().item()
            total_decisions += decisions_in_batch

    return SplitMetrics(
        loss=total_loss / total_decisions,
        top1_agreement=total_top1_correct / total_decisions,
        mean_teacher_probability_of_selection=total_probability / total_decisions,
        mean_teacher_utility_of_selection=total_utility / total_decisions,
    )


def train_model(
    model: CandidateScoringMLP,
    train_loader: Iterable[dict[str, Any]],
    validation_loader: Iterable[dict[str, Any]],
    config: TrainingConfig,
) -> TrainingResult:
    """Entrena hasta `config.max_epochs` o hasta que `EarlyStopping` (sobre
    `validation loss`, NUNCA train loss ni test, #567 §31) lo detenga. Al
    terminar, `model` queda cargado con el BEST checkpoint (#567 §33) -- el
    ultimo epoch entrenado puede no ser el que se exporta."""
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay
    )
    stopper = EarlyStopping(patience=config.early_stopping_patience, min_delta=config.min_delta)

    best_state_dict = {name: tensor.detach().clone() for name, tensor in model.state_dict().items()}
    history: list[EpochMetrics] = []
    epochs_run = 0
    stopped_early = False

    for epoch in range(config.max_epochs):
        train_loss = _run_training_epoch(model, train_loader, optimizer)
        validation_metrics = evaluate_model(model, validation_loader)
        epochs_run = epoch + 1

        should_stop = stopper.step(validation_metrics.loss, epoch)
        if stopper.best_epoch == epoch:
            best_state_dict = {
                name: tensor.detach().clone() for name, tensor in model.state_dict().items()
            }

        history.append(
            EpochMetrics(
                epoch=epoch,
                train_loss=train_loss,
                validation_loss=validation_metrics.loss,
                validation_top1_agreement=validation_metrics.top1_agreement,
                patience_counter=stopper.epochs_without_improvement,
            )
        )

        if should_stop:
            stopped_early = True
            break

    model.load_state_dict(best_state_dict)

    return TrainingResult(
        best_epoch=stopper.best_epoch,
        epochs_run=epochs_run,
        stopped_early=stopped_early,
        best_state_dict=best_state_dict,
        epoch_history=tuple(history),
    )
