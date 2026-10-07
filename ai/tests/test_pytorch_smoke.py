"""SMOKE de PyTorch (#566 §65-§66): DataLoader -> batch -> shapes/dtypes.
NO entrena nada (nada de optimizer.step()/loss.backward()/training loop):
eso es #567."""

from __future__ import annotations

from pathlib import Path

import torch
from torch.utils.data import DataLoader

from nexus_combat_ai.dataset.builder import DatasetBuildConfig, build_dataset
from nexus_combat_ai.dataset.pytorch_dataset import CombatDecisionDataset, collate_decision_samples
from nexus_combat_ai.dataset.sample import decision_sample_from_jsonl_dict
from nexus_combat_ai.dataset.source import JsonlDatasetSource
from nexus_combat_ai.features.schema import FEATURE_DIMENSION

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _train_samples(tmp_path: Path) -> list:
    source = JsonlDatasetSource(
        FIXTURES_DIR / "decision-events.jsonl", FIXTURES_DIR / "teacher-labels.jsonl"
    )
    config = DatasetBuildConfig(
        cutoff="2027-01-01T00:00:00Z", source_commit="abc123", seed=42, output_dir=tmp_path
    )
    build_dataset(source, config)
    import json

    rows = [
        json.loads(line)
        for line in (tmp_path / "train.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    rows += [
        json.loads(line)
        for line in (tmp_path / "validation.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    rows += [
        json.loads(line)
        for line in (tmp_path / "test.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    return [decision_sample_from_jsonl_dict(row) for row in rows]


def test_dataloader_smoke(tmp_path: Path) -> None:
    samples = _train_samples(tmp_path)
    assert len(samples) > 0

    dataset = CombatDecisionDataset(samples)
    loader = DataLoader(dataset, batch_size=4, shuffle=False, collate_fn=collate_decision_samples)

    batch = next(iter(loader))

    batch_size, max_candidates, feature_dim = batch["candidate_features"].shape
    assert batch_size > 0
    assert max_candidates >= 1
    assert feature_dim == FEATURE_DIMENSION

    assert torch.isfinite(batch["candidate_features"]).all()
    assert batch["candidate_features"].dtype == torch.float32
    assert batch["teacher_probabilities"].dtype == torch.float32
    assert batch["candidate_mask"].dtype == torch.bool
    assert batch["selected_index"].dtype == torch.int64

    # Las probabilidades de cada fila suman ~1 SOLO sobre las posiciones reales.
    masked_sums = (batch["teacher_probabilities"] * batch["candidate_mask"]).sum(dim=1)
    for value in masked_sums.tolist():
        assert abs(value - 1.0) < 1e-4
