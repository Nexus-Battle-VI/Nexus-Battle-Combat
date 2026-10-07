"""`torch.utils.data.Dataset` + `collate_fn` para candidatos de longitud
variable (#566 §37-§39). Smoke-only en esta Task (§65-§66): NO entrena nada,
solo prueba que `DataLoader` produce shapes/dtypes correctos.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import torch
from torch.utils.data import Dataset

from nexus_combat_ai.dataset.sample import DecisionSample
from nexus_combat_ai.features.encoder import FeatureEncoder


class CombatDecisionDataset(Dataset):
    """Un item = UNA decision con `C` candidatos (`C` variable entre items)."""

    def __init__(
        self, samples: Sequence[DecisionSample], encoder: FeatureEncoder | None = None
    ) -> None:
        self._samples = list(samples)
        self._encoder = encoder or FeatureEncoder()

    def __len__(self) -> int:
        return len(self._samples)

    def __getitem__(self, index: int) -> dict[str, object]:
        sample = self._samples[index]
        features = np.stack(
            [self._encoder.encode(sample.state, c.action) for c in sample.candidates]
        ).astype(np.float32, copy=False)

        return {
            "candidate_features": torch.from_numpy(features).to(torch.float32),
            "teacher_probabilities": torch.tensor(
                [c.probability for c in sample.candidates], dtype=torch.float32
            ),
            "teacher_mean_utilities": torch.tensor(
                [c.mean_utility for c in sample.candidates], dtype=torch.float32
            ),
            "teacher_visits": torch.tensor(
                [c.visits for c in sample.candidates], dtype=torch.int64
            ),
            "selected_index": torch.tensor(sample.selected_index, dtype=torch.int64),
            "action_identities": sample.action_identities(),
            "battle_id": sample.battle_id,
            "event_id": sample.event_id,
        }


def collate_decision_samples(items: list[dict[str, object]]) -> dict[str, object]:
    """Padding a `Cmax` (el mayor numero de candidatos del batch). `candidate_mask`
    es la UNICA fuente de verdad sobre que posiciones son candidatos reales
    (#566 §38): el relleno nunca contamina probabilidades/utilidades."""
    batch_size = len(items)
    feature_dim = items[0]["candidate_features"].shape[1]  # type: ignore[union-attr]
    max_candidates = max(item["candidate_features"].shape[0] for item in items)  # type: ignore[union-attr]

    features = torch.zeros((batch_size, max_candidates, feature_dim), dtype=torch.float32)
    probabilities = torch.zeros((batch_size, max_candidates), dtype=torch.float32)
    mean_utilities = torch.zeros((batch_size, max_candidates), dtype=torch.float32)
    visits = torch.zeros((batch_size, max_candidates), dtype=torch.int64)
    mask = torch.zeros((batch_size, max_candidates), dtype=torch.bool)
    selected_index = torch.zeros((batch_size,), dtype=torch.int64)

    action_identities: list[tuple[str, ...]] = []
    battle_ids: list[str] = []
    event_ids: list[str] = []

    for row, item in enumerate(items):
        count = item["candidate_features"].shape[0]  # type: ignore[union-attr]
        features[row, :count] = item["candidate_features"]  # type: ignore[index]
        probabilities[row, :count] = item["teacher_probabilities"]  # type: ignore[index]
        mean_utilities[row, :count] = item["teacher_mean_utilities"]  # type: ignore[index]
        visits[row, :count] = item["teacher_visits"]  # type: ignore[index]
        mask[row, :count] = True
        selected_index[row] = item["selected_index"]  # type: ignore[assignment]
        action_identities.append(item["action_identities"])  # type: ignore[arg-type]
        battle_ids.append(item["battle_id"])  # type: ignore[arg-type]
        event_ids.append(item["event_id"])  # type: ignore[arg-type]

    return {
        "candidate_features": features,
        "teacher_probabilities": probabilities,
        "teacher_mean_utilities": mean_utilities,
        "teacher_visits": visits,
        "candidate_mask": mask,
        "selected_index": selected_index,
        "action_identities": action_identities,
        "battle_id": battle_ids,
        "event_id": event_ids,
    }
