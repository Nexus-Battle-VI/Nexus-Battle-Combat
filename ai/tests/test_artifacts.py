"""Hashing de artefactos (EN-036.3, Management #567 §88)."""

from __future__ import annotations

from pathlib import Path

import torch

from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP
from nexus_combat_ai.training.artifacts import canonical_model_state_sha256, file_sha256


def test_file_sha256_changes_when_one_byte_changes(tmp_path: Path) -> None:
    path = tmp_path / "artifact.bin"
    path.write_bytes(b"hello world")
    original = file_sha256(path)

    path.write_bytes(b"hello worle")  # un byte distinto al final
    changed = file_sha256(path)

    assert original != changed


def test_file_sha256_is_deterministic(tmp_path: Path) -> None:
    path = tmp_path / "artifact.bin"
    path.write_bytes(b"same content")
    assert file_sha256(path) == file_sha256(path)


def test_canonical_model_state_sha256_is_deterministic_for_identical_weights() -> None:
    torch.manual_seed(42)
    model_a = CandidateScoringMLP(input_dim=8)
    torch.manual_seed(42)
    model_b = CandidateScoringMLP(input_dim=8)

    assert canonical_model_state_sha256(model_a) == canonical_model_state_sha256(model_b)


def test_canonical_model_state_sha256_changes_when_a_weight_changes() -> None:
    torch.manual_seed(0)
    model = CandidateScoringMLP(input_dim=8)
    original = canonical_model_state_sha256(model)

    with torch.no_grad():
        model.network[0].weight[0, 0] += 0.001

    changed = canonical_model_state_sha256(model)
    assert original != changed


def test_canonical_model_state_sha256_independent_of_torch_save_serialization(
    tmp_path: Path,
) -> None:
    """#567 §41: la autoridad de reproducibilidad son los TENSORES, no los
    bytes de `torch.save()` (que pueden variar por detalles de pickle/zip sin
    que el modelo real cambie)."""
    torch.manual_seed(5)
    model = CandidateScoringMLP(input_dim=8)
    hash_before_save = canonical_model_state_sha256(model)

    path = tmp_path / "model.pt"
    torch.save(model.state_dict(), path)
    reloaded = CandidateScoringMLP(input_dim=8)
    reloaded.load_state_dict(torch.load(path, weights_only=True))

    assert canonical_model_state_sha256(reloaded) == hash_before_save
