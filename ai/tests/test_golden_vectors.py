"""Golden feature vectors (#566 §90-§91): fixture congelado que `#568`
(NeuralPolicy TypeScript) debera reproducir byte-a-byte para el MISMO
state+candidate. Si este test cambia de valor esperado, es
feature-schema-v2, nunca un ajuste silencioso."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nexus_combat_ai.contracts.decision_event import BattleDecisionState, LegalAction
from nexus_combat_ai.features.encoder import FeatureEncoder
from nexus_combat_ai.features.schema import FEATURE_NAMES

FIXTURES_DIR = Path(__file__).parent / "fixtures"
ENCODER = FeatureEncoder()


def _load(name: str) -> dict:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def test_golden_basic_attack_vector_matches_frozen_fixture() -> None:
    golden = _load("golden-basic-attack.json")
    state = BattleDecisionState.from_json(golden["state"])
    candidate = LegalAction.from_json(golden["candidate"])
    vector = ENCODER.encode(state, candidate)

    for i, name in enumerate(FEATURE_NAMES):
        assert vector[i] == pytest.approx(golden["expectedFeatures"][name], abs=1e-6), name


def test_golden_multi_candidate_alignment_matches_frozen_fixture() -> None:
    golden = _load("golden-multi-candidate.json")
    state = BattleDecisionState.from_json(golden["state"])

    for candidate_name, entry in golden["candidates"].items():
        candidate = LegalAction.from_json(entry["action"])
        vector = ENCODER.encode(state, candidate)
        for i, name in enumerate(FEATURE_NAMES):
            assert vector[i] == pytest.approx(entry["expectedFeatures"][name], abs=1e-6), (
                candidate_name,
                name,
            )


def test_golden_multi_candidate_kinds_are_distinguishable() -> None:
    golden = _load("golden-multi-candidate.json")
    kinds = {
        name: entry["expectedFeatures"]["candidate.kind_basic_attack"]
        for name, entry in golden["candidates"].items()
    }
    assert kinds["basicAttack"] == 1.0
    assert kinds["ability"] == 0.0
    assert kinds["epic"] == 0.0
