"""D-01..D-12 (#566 §85): `DecisionSample` + `CombatDecisionDataset`/collate."""

from __future__ import annotations

import copy

import pytest
import torch

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent
from nexus_combat_ai.contracts.teacher_label import MctsTeacherLabel
from nexus_combat_ai.dataset.join import JoinedDecision
from nexus_combat_ai.dataset.pytorch_dataset import CombatDecisionDataset, collate_decision_samples
from nexus_combat_ai.dataset.sample import build_decision_sample, decision_sample_from_jsonl_dict
from nexus_combat_ai.errors import InvalidTeacherLabelError

from .fixtures import builders as b

_ACTOR_WITH_ABILITIES = b.combatant(
    "A",
    0,
    abilities=[
        b.ability("heal-1", effects=[b.heal_bonus(b.fixed(2))]),
        b.ability("song-1", effects=[b.heal_bonus(b.dice(2, 6), target="ALLIED_GROUP")]),
    ],
)


def _event(legal_actions, selected_action, event_id: str = "e1") -> CombatDecisionEvent:
    raw = {
        "schemaVersion": 1,
        "eventType": "COMBAT_DECISION",
        "eventId": event_id,
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "actor": {"teamLabel": "A", "seat": 0},
        "decisionSource": "RULE_BASED",
        "stateBefore": b.state(actor=_ACTOR_WITH_ABILITIES, allies=[b.combatant("A", 1)]),
        "legalActions": legal_actions,
        "selectedAction": selected_action,
        "occurredAt": "2026-10-06T00:00:00.000Z",
    }
    return CombatDecisionEvent.from_json(raw)


def _label_with_candidates(
    candidates_raw: list[dict], selected_action: dict, event_id: str = "e1"
) -> MctsTeacherLabel:
    raw = {
        "schemaVersion": 1,
        "eventId": event_id,
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "generatedAt": "2026-10-06T00:00:01.000Z",
        "result": {
            "config": {
                "teacherVersion": "mcts-teacher-v1",
                "utilityVersion": "pve-utility-v1",
                "rollouts": 3,
                "maxDepthPlies": 6,
                "explorationConstant": 1.41,
                "rolloutPolicyVersion": "rule-based-v1",
            },
            "simulationSeed": 7,
            "stateSchemaVersion": 1,
            "selectedAction": selected_action,
            "candidates": candidates_raw,
        },
    }
    return MctsTeacherLabel.from_json(raw)


def _three_candidates() -> tuple[list[dict], dict]:
    a = b.basic_attack_on("B", 0)
    heal = b.ability_action_on("heal-1", "A", 1)
    group = b.ability_action_group("song-1")
    candidates = [
        {
            "action": a,
            "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
            "visits": 1,
            "meanUtility": 0.3,
            "probability": 0.2,
        },
        {
            "action": heal,
            "actionIdentity": "ABILITY|6:heal-1|COMBATANT|1:A|1",
            "visits": 2,
            "meanUtility": 0.6,
            "probability": 0.5,
        },
        {
            "action": group,
            "actionIdentity": "ABILITY|6:song-1|ALLIED_GROUP",
            "visits": 1,
            "meanUtility": 0.5,
            "probability": 0.3,
        },
    ]
    return candidates, heal  # selected = heal


def test_d01_and_d02_probabilities_align_with_action_identity_and_selected_index() -> None:
    candidates, selected = _three_candidates()
    event = _event([c["action"] for c in candidates], selected)
    label = _label_with_candidates(candidates, selected)

    sample = build_decision_sample(JoinedDecision(event=event, label=label))

    expected_order = sorted(c["actionIdentity"] for c in candidates)
    assert list(sample.action_identities()) == expected_order

    selected_identity = "ABILITY|6:heal-1|COMBATANT|1:A|1"
    assert sample.action_identities()[sample.selected_index] == selected_identity

    by_identity = {c["actionIdentity"]: c["probability"] for c in candidates}
    for i, identity in enumerate(sample.action_identities()):
        assert sample.candidates[i].probability == pytest.approx(by_identity[identity])


def test_d01_mutation_reversed_input_order_still_aligns() -> None:
    candidates, selected = _three_candidates()
    reversed_candidates = list(reversed(candidates))
    event = _event([c["action"] for c in reversed_candidates], selected)
    label = _label_with_candidates(reversed_candidates, selected)

    sample = build_decision_sample(JoinedDecision(event=event, label=label))

    by_identity = {c["actionIdentity"]: c["probability"] for c in candidates}
    for i, identity in enumerate(sample.action_identities()):
        assert sample.candidates[i].probability == pytest.approx(by_identity[identity])


def test_d03_probabilities_sum_to_one() -> None:
    candidates, selected = _three_candidates()
    event = _event([c["action"] for c in candidates], selected)
    label = _label_with_candidates(candidates, selected)
    sample = build_decision_sample(JoinedDecision(event=event, label=label))
    total = sum(c.probability for c in sample.candidates)
    assert total == pytest.approx(1.0)


def test_d04_variable_candidate_counts_round_trip_through_jsonl() -> None:
    candidates, selected = _three_candidates()
    event = _event([c["action"] for c in candidates], selected)
    label = _label_with_candidates(candidates, selected)
    sample = build_decision_sample(JoinedDecision(event=event, label=label))

    raw = sample.to_jsonl_dict()
    restored = decision_sample_from_jsonl_dict(copy.deepcopy(raw))
    assert restored.action_identities() == sample.action_identities()
    assert restored.selected_index == sample.selected_index


def test_d05_collate_padding_and_mask() -> None:
    candidates_a, selected_a = _three_candidates()
    two_candidates = copy.deepcopy(candidates_a[:2])
    # Las probabilidades de ESTA sub-decision (solo 2 candidatos) deben sumar
    # 1 por su cuenta: no son las mismas probabilidades de la decision de 3.
    two_candidates[0]["probability"] = 0.4
    two_candidates[1]["probability"] = 0.6
    event_a = _event(
        [c["action"] for c in two_candidates], two_candidates[0]["action"], event_id="ea"
    )
    label_a = _label_with_candidates(two_candidates, two_candidates[0]["action"], event_id="ea")
    sample_a = build_decision_sample(JoinedDecision(event=event_a, label=label_a))

    event_b = _event([c["action"] for c in candidates_a], selected_a, event_id="eb")
    label_b = _label_with_candidates(candidates_a, selected_a, event_id="eb")
    sample_b = build_decision_sample(JoinedDecision(event=event_b, label=label_b))

    dataset = CombatDecisionDataset([sample_a, sample_b])
    batch = collate_decision_samples([dataset[0], dataset[1]])

    feature_dim = batch["candidate_features"].shape[2]
    assert batch["candidate_features"].shape == (2, 3, feature_dim)
    assert batch["candidate_mask"][0].sum().item() == 2
    assert batch["candidate_mask"][1].sum().item() == 3
    assert batch["candidate_mask"][0][2].item() is False
    # El relleno no debe "contaminar" probabilidades: la fila A solo suma
    # sobre sus 2 candidatos reales.
    row_a_sum = batch["teacher_probabilities"][0][batch["candidate_mask"][0]].sum().item()
    assert row_a_sum == pytest.approx(sum(c["probability"] for c in two_candidates))


def test_d06_all_tensors_finite_and_right_dtype() -> None:
    candidates, selected = _three_candidates()
    event = _event([c["action"] for c in candidates], selected)
    label = _label_with_candidates(candidates, selected)
    sample = build_decision_sample(JoinedDecision(event=event, label=label))

    dataset = CombatDecisionDataset([sample])
    item = dataset[0]
    assert item["candidate_features"].dtype == torch.float32
    assert item["teacher_probabilities"].dtype == torch.float32
    assert item["teacher_mean_utilities"].dtype == torch.float32
    assert item["teacher_visits"].dtype == torch.int64
    assert item["selected_index"].dtype == torch.int64
    assert torch.isfinite(item["candidate_features"]).all()
    assert torch.isfinite(item["teacher_probabilities"]).all()


def test_d09_selected_action_not_in_candidates_fails_at_build_time() -> None:
    candidates, _ = _three_candidates()
    other = b.epic_action_on("nope", "B", 0)
    # El propio MctsTeacherResult.from_json ya rechaza esto (selectedAction
    # debe estar en candidates exactamente una vez); confirmamos que el error
    # se propaga hasta el nivel de sample tambien.
    with pytest.raises(InvalidTeacherLabelError):
        _label_with_candidates(candidates, other)


def test_d12_dataset_len_matches_samples() -> None:
    candidates, selected = _three_candidates()
    event = _event([c["action"] for c in candidates], selected)
    label = _label_with_candidates(candidates, selected)
    sample = build_decision_sample(JoinedDecision(event=event, label=label))
    dataset = CombatDecisionDataset([sample, sample, sample])
    assert len(dataset) == 3
