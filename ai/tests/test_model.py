"""M-01..M-07 (EN-036.3, Management #567 §81): arquitectura exacta de
`CandidateScoringMLP`."""

from __future__ import annotations

import torch
from torch import nn

from nexus_combat_ai.features.schema import FEATURE_DIMENSION
from nexus_combat_ai.model.candidate_mlp import MODEL_ARCHITECTURE_VERSION, CandidateScoringMLP


def test_m01_input_dim_matches_feature_dimension() -> None:
    model = CandidateScoringMLP()
    assert model.input_dim == FEATURE_DIMENSION


def test_m02_first_linear_shape() -> None:
    model = CandidateScoringMLP()
    first = model.network[0]
    assert isinstance(first, nn.Linear)
    assert first.in_features == FEATURE_DIMENSION
    assert first.out_features == 64


def test_m03_second_linear_shape() -> None:
    model = CandidateScoringMLP()
    second = model.network[2]
    assert isinstance(second, nn.Linear)
    assert second.in_features == 64
    assert second.out_features == 32


def test_m04_final_linear_shape() -> None:
    model = CandidateScoringMLP()
    final = model.network[4]
    assert isinstance(final, nn.Linear)
    assert final.in_features == 32
    assert final.out_features == 1


def test_m05_exactly_two_relu_no_dropout_no_norm() -> None:
    model = CandidateScoringMLP()
    kinds = [type(layer) for layer in model.network]
    assert kinds.count(nn.ReLU) == 2
    assert kinds.count(nn.Linear) == 3
    assert len(kinds) == 5
    for layer in model.network:
        assert not isinstance(layer, nn.Dropout)
        assert not isinstance(layer, (nn.BatchNorm1d, nn.LayerNorm))


def test_m06_forward_shape_for_any_candidate_count() -> None:
    model = CandidateScoringMLP()
    for n in (1, 3, 100):
        features = torch.randn(n, FEATURE_DIMENSION, dtype=torch.float32)
        scores = model(features)
        assert scores.shape == (n,)


def test_m07_scores_are_finite() -> None:
    model = CandidateScoringMLP()
    features = torch.randn(5, FEATURE_DIMENSION, dtype=torch.float32)
    scores = model(features)
    assert torch.isfinite(scores).all()


def test_output_has_no_sigmoid_raw_scores_can_be_negative() -> None:
    """#567 §135: `Linear(32, 1)` sin sigmoid -- un score negativo es valido."""
    model = CandidateScoringMLP()
    # Sesgo grande negativo en la ultima capa para forzar un score negativo
    # y confirmar que nada en el forward lo recorta a [0, 1].
    with torch.no_grad():
        model.network[4].bias.fill_(-100.0)
        model.network[4].weight.zero_()
    scores = model(torch.zeros(1, FEATURE_DIMENSION))
    assert scores.item() == -100.0


def test_expected_parameter_count_for_feature_dimension_72() -> None:
    """#567 §133: cuenta esperada derivada a mano para F=72, para detectar un
    cambio accidental de arquitectura."""
    model = CandidateScoringMLP(input_dim=72)
    expected = (72 * 64 + 64) + (64 * 32 + 32) + (32 * 1 + 1)
    assert model.trainable_parameter_count() == expected


def test_model_architecture_version_constant() -> None:
    assert MODEL_ARCHITECTURE_VERSION == "candidate-mlp-v1"
