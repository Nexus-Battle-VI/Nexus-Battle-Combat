"""`training/metrics.py` (EN-036.3, Management #567 §74-76)."""

from __future__ import annotations

import pytest
import torch

from nexus_combat_ai.training.metrics import (
    masked_argmax,
    mean_teacher_probability_of_selection,
    mean_teacher_utility_of_selection,
    top1_teacher_agreement,
)


def test_masked_argmax_ignores_padding() -> None:
    scores = torch.tensor([[1.0, 5.0, 3.0]])
    mask = torch.tensor([[True, False, True]])  # el 5.0 es padding, debe ignorarse
    chosen = masked_argmax(scores, mask)
    assert chosen.tolist() == [2]


def test_top1_teacher_agreement_fraction() -> None:
    chosen = torch.tensor([0, 1, 1, 0])
    selected_index = torch.tensor([0, 1, 0, 0])
    assert top1_teacher_agreement(chosen, selected_index) == 0.75


def test_mean_teacher_probability_of_selection() -> None:
    chosen = torch.tensor([0, 1])
    probabilities = torch.tensor([[0.9, 0.1], [0.3, 0.7]])
    value = mean_teacher_probability_of_selection(chosen, probabilities)
    assert value == pytest.approx((0.9 + 0.7) / 2)


def test_mean_teacher_utility_of_selection() -> None:
    chosen = torch.tensor([0, 1])
    utilities = torch.tensor([[0.6, 0.2], [0.1, 0.8]])
    value = mean_teacher_utility_of_selection(chosen, utilities)
    assert value == pytest.approx((0.6 + 0.8) / 2)
