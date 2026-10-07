"""L-01..L-06 (EN-036.3, Management #567 §82)."""

from __future__ import annotations

import math

import pytest
import torch

from nexus_combat_ai.errors import InvalidTrainingBatchError, NonFiniteTrainingValueError
from nexus_combat_ai.training.loss import teacher_policy_cross_entropy, validate_batch


def test_l01_one_hot_teacher_favors_the_correct_score() -> None:
    """Distribucion one-hot: minimizar la loss empuja el score del candidato
    correcto hacia arriba respecto a los demas."""
    scores_good = torch.tensor([[5.0, 0.0, 0.0]])
    scores_bad = torch.tensor([[0.0, 0.0, 5.0]])
    probabilities = torch.tensor([[1.0, 0.0, 0.0]])
    mask = torch.tensor([[True, True, True]])

    loss_good = teacher_policy_cross_entropy(scores_good, probabilities, mask)
    loss_bad = teacher_policy_cross_entropy(scores_bad, probabilities, mask)
    assert loss_good.item() < loss_bad.item()


def test_l02_soft_distribution_is_used_directly_not_collapsed_to_one_hot() -> None:
    """[0.7, 0.2, 0.1]: la loss NO debe coincidir con la de un one-hot sobre
    el mismo indice -- se usa la distribucion soft completa (#567 §15)."""
    scores = torch.tensor([[1.0, 0.5, -0.5]])
    mask = torch.tensor([[True, True, True]])

    soft = torch.tensor([[0.7, 0.2, 0.1]])
    one_hot = torch.tensor([[1.0, 0.0, 0.0]])

    loss_soft = teacher_policy_cross_entropy(scores, soft, mask)
    loss_one_hot = teacher_policy_cross_entropy(scores, one_hot, mask)
    assert loss_soft.item() != pytest.approx(loss_one_hot.item())

    log_probs = torch.log_softmax(scores, dim=1)
    expected_soft = -(soft * log_probs).sum().item()
    assert loss_soft.item() == pytest.approx(expected_soft, abs=1e-6)


def test_l03_padding_never_affects_the_loss() -> None:
    """Un candidato de padding con score/prob arbitrarios (siempre 0.0 por
    `collate_decision_samples` en la practica) no debe cambiar la loss frente
    a no tener ese candidato en absoluto."""
    mask_with_padding = torch.tensor([[True, True, False]])
    probabilities_with_padding = torch.tensor([[0.6, 0.4, 0.0]])
    scores_with_padding = torch.tensor([[1.0, -0.3, 999.0]])  # score de padding, arbitrario

    mask_without_padding = torch.tensor([[True, True]])
    probabilities_without_padding = torch.tensor([[0.6, 0.4]])
    scores_without_padding = torch.tensor([[1.0, -0.3]])

    loss_with = teacher_policy_cross_entropy(
        scores_with_padding, probabilities_with_padding, mask_with_padding
    )
    loss_without = teacher_policy_cross_entropy(
        scores_without_padding, probabilities_without_padding, mask_without_padding
    )
    assert loss_with.item() == pytest.approx(loss_without.item(), abs=1e-6)


def test_l04_single_candidate_probability_one_gives_finite_loss() -> None:
    scores = torch.tensor([[3.7]])
    probabilities = torch.tensor([[1.0]])
    mask = torch.tensor([[True]])

    loss = teacher_policy_cross_entropy(scores, probabilities, mask)
    assert math.isfinite(loss.item())
    # softmax de un unico logit es siempre 1.0 -> -log(1.0) == 0.0.
    assert loss.item() == pytest.approx(0.0, abs=1e-6)


def test_l05_mask_without_any_real_candidate_raises() -> None:
    probabilities = torch.tensor([[0.0, 0.0]])
    mask = torch.tensor([[False, False]])
    selected_index = torch.tensor([0])

    with pytest.raises(InvalidTrainingBatchError):
        validate_batch(
            teacher_probabilities=probabilities, candidate_mask=mask, selected_index=selected_index
        )


def test_l06_nan_target_raises() -> None:
    probabilities = torch.tensor([[float("nan"), 0.5]])
    mask = torch.tensor([[True, True]])
    selected_index = torch.tensor([0])

    with pytest.raises(NonFiniteTrainingValueError):
        validate_batch(
            teacher_probabilities=probabilities, candidate_mask=mask, selected_index=selected_index
        )


def test_validate_batch_rejects_probabilities_not_summing_to_one() -> None:
    probabilities = torch.tensor([[0.2, 0.2]])
    mask = torch.tensor([[True, True]])
    selected_index = torch.tensor([0])

    with pytest.raises(InvalidTrainingBatchError):
        validate_batch(
            teacher_probabilities=probabilities, candidate_mask=mask, selected_index=selected_index
        )


def test_validate_batch_rejects_selected_index_on_padding() -> None:
    probabilities = torch.tensor([[1.0, 0.0]])
    mask = torch.tensor([[True, False]])
    selected_index = torch.tensor([1])  # apunta al padding

    with pytest.raises(InvalidTrainingBatchError):
        validate_batch(
            teacher_probabilities=probabilities, candidate_mask=mask, selected_index=selected_index
        )


def test_non_finite_scores_raise_before_computing_loss() -> None:
    scores = torch.tensor([[float("inf"), 0.0]])
    probabilities = torch.tensor([[1.0, 0.0]])
    mask = torch.tensor([[True, True]])

    with pytest.raises(NonFiniteTrainingValueError):
        teacher_policy_cross_entropy(scores, probabilities, mask)
