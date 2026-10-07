"""Metricas de seleccion (EN-036.3, Management #567 §37-38, §74-76).

Todas comparten el mismo patron: enmascarar el padding ANTES de `argmax`
(#567 §74, nunca incluir candidatos de relleno), elegir la accion del MODELO
y leer la senal del TEACHER sobre esa posicion -- nunca al reves."""

from __future__ import annotations

from dataclasses import dataclass

import torch

from nexus_combat_ai.errors import NonFiniteTrainingValueError


def masked_argmax(scores: torch.Tensor, candidate_mask: torch.Tensor) -> torch.Tensor:
    """`[B, Cmax] -> [B]`: la posicion de mayor score POR FILA, ignorando
    candidatos de padding (#567 §74)."""
    if not torch.isfinite(scores).all():
        raise NonFiniteTrainingValueError("scores no finitos antes de calcular argmax.")
    masked_scores = scores.masked_fill(~candidate_mask, float("-inf"))
    return masked_scores.argmax(dim=1)


def top1_teacher_agreement(chosen: torch.Tensor, selected_index: torch.Tensor) -> float:
    """Fraccion de decisiones donde el candidato de mayor score del modelo
    coincide con `selectedAction` del teacher (#567 §37, §74). Es acuerdo con
    el teacher, nunca "accuracy de victoria" (#567 §37)."""
    return (chosen == selected_index).float().mean().item()


def mean_teacher_probability_of_selection(
    chosen: torch.Tensor, teacher_probabilities: torch.Tensor
) -> float:
    """`teacher_probabilities[fila, chosen]` promediado (#567 §75): que tan
    probable consideraba el teacher la accion que el MODELO elige."""
    values = teacher_probabilities.gather(1, chosen.unsqueeze(1)).squeeze(1)
    return values.mean().item()


def mean_teacher_utility_of_selection(
    chosen: torch.Tensor, teacher_mean_utilities: torch.Tensor
) -> float:
    """`teacher_mean_utilities[fila, chosen]` promediado (#567 §76). NUNCA se
    confunde con win rate: es la utilidad media que el teacher simulo para
    esa accion, no un resultado de combate real."""
    values = teacher_mean_utilities.gather(1, chosen.unsqueeze(1)).squeeze(1)
    return values.mean().item()


@dataclass(frozen=True, slots=True)
class EpochMetrics:
    """Una fila de `epochHistory` (#567 §37, §40)."""

    epoch: int
    train_loss: float
    validation_loss: float
    validation_top1_agreement: float
    patience_counter: int

    def as_dict(self) -> dict[str, object]:
        return {
            "epoch": self.epoch,
            "trainLoss": self.train_loss,
            "validationLoss": self.validation_loss,
            "validationTop1Agreement": self.validation_top1_agreement,
            "patienceCounter": self.patience_counter,
        }


@dataclass(frozen=True, slots=True)
class SplitMetrics:
    """Metricas finales de un split completo (validation final o test, #567
    §38): loss + las tres metricas de seleccion."""

    loss: float
    top1_agreement: float
    mean_teacher_probability_of_selection: float
    mean_teacher_utility_of_selection: float

    def as_dict(self) -> dict[str, object]:
        return {
            "loss": self.loss,
            "top1Agreement": self.top1_agreement,
            "meanTeacherProbabilityOfSelection": self.mean_teacher_probability_of_selection,
            "meanTeacherUtilityOfSelection": self.mean_teacher_utility_of_selection,
        }
