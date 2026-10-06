"""Contratos: `CombatDecisionEvent`/`BattleDecisionState` y `MctsTeacherResult`."""

from __future__ import annotations

import copy

import pytest

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent, LegalAction
from nexus_combat_ai.contracts.teacher_label import MctsTeacherLabel, MctsTeacherResult
from nexus_combat_ai.errors import (
    ContractValidationError,
    IncompatibleSchemaError,
    InvalidTeacherLabelError,
)

from .fixtures import builders as b


def _basic_attack_event(**overrides) -> dict:
    base = {
        "schemaVersion": 1,
        "eventType": "COMBAT_DECISION",
        "eventId": "decision:ONLINE:7:abc123",
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "actor": {"teamLabel": "A", "seat": 0},
        "decisionSource": "RULE_BASED",
        "stateBefore": b.state(),
        "legalActions": [b.basic_attack_on("B", 0)],
        "selectedAction": b.basic_attack_on("B", 0),
        "occurredAt": "2026-10-06T00:00:00.000Z",
    }
    base.update(overrides)
    return base


def test_decision_event_round_trips() -> None:
    event = CombatDecisionEvent.from_json(_basic_attack_event())
    assert event.event_id == "decision:ONLINE:7:abc123"
    assert event.is_end_turn() is False


def test_decision_event_end_turn_schema_version_2() -> None:
    event = CombatDecisionEvent.from_json(
        _basic_attack_event(
            schemaVersion=2,
            legalActions=[],
            selectedAction={"kind": "END_TURN"},
            decisionSource="SYSTEM",
        )
    )
    assert event.is_end_turn() is True


def test_decision_event_unsupported_schema_version_fails() -> None:
    with pytest.raises(IncompatibleSchemaError):
        CombatDecisionEvent.from_json(_basic_attack_event(schemaVersion=999))


def test_decision_event_unknown_decision_source_fails() -> None:
    with pytest.raises(ContractValidationError):
        CombatDecisionEvent.from_json(_basic_attack_event(decisionSource="GHOST"))


def test_decision_event_missing_field_fails() -> None:
    raw = _basic_attack_event()
    del raw["battleId"]
    with pytest.raises(ContractValidationError):
        CombatDecisionEvent.from_json(raw)


def test_legal_action_identity_matches_ts_format() -> None:
    action = LegalAction.from_json(b.ability_action_on("ability-x", "B", 0))
    assert action.identity() == "ABILITY|9:ability-x|COMBATANT|1:B|0"


def _teacher_result(**overrides) -> dict:
    action = b.basic_attack_on("B", 0)
    base = {
        "config": {
            "teacherVersion": "mcts-teacher-v1",
            "utilityVersion": "pve-utility-v1",
            "rollouts": 4,
            "maxDepthPlies": 6,
            "explorationConstant": 1.41,
            "rolloutPolicyVersion": "rule-based-v1",
        },
        "simulationSeed": 42,
        "stateSchemaVersion": 1,
        "selectedAction": action,
        "candidates": [
            {
                "action": action,
                "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
                "visits": 4,
                "meanUtility": 0.5,
                "probability": 1.0,
            }
        ],
    }
    base.update(overrides)
    return base


def test_teacher_result_round_trips() -> None:
    result = MctsTeacherResult.from_json(_teacher_result())
    assert result.simulation_seed == 42
    assert result.candidates[0].probability == 1.0


def test_teacher_result_unsupported_teacher_version_fails() -> None:
    raw = _teacher_result()
    raw["config"]["teacherVersion"] = "mcts-teacher-v2"
    with pytest.raises(IncompatibleSchemaError):
        MctsTeacherResult.from_json(raw)


def test_teacher_result_probability_not_summing_to_one_fails() -> None:
    action_a = b.basic_attack_on("B", 0)
    action_b = b.ability_action_on("heal-1", "A", 1)
    raw = _teacher_result(
        selectedAction=action_a,
        candidates=[
            {
                "action": action_a,
                "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
                "visits": 2,
                "meanUtility": 0.5,
                "probability": 0.5,
            },
            {
                "action": action_b,
                "actionIdentity": "ABILITY|6:heal-1|COMBATANT|1:A|1",
                "visits": 1,
                "meanUtility": 0.5,
                "probability": 0.2,
            },
        ],
    )
    with pytest.raises(InvalidTeacherLabelError):
        MctsTeacherResult.from_json(raw)


def test_teacher_result_duplicate_action_identity_fails() -> None:
    action = b.basic_attack_on("B", 0)
    candidate = {
        "action": action,
        "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
        "visits": 2,
        "meanUtility": 0.5,
        "probability": 0.5,
    }
    raw = _teacher_result(candidates=[candidate, copy.deepcopy(candidate)])
    with pytest.raises(InvalidTeacherLabelError):
        MctsTeacherResult.from_json(raw)


def test_teacher_result_selected_action_not_in_candidates_fails() -> None:
    raw = _teacher_result(selectedAction=b.ability_action_on("other", "B", 0))
    with pytest.raises(InvalidTeacherLabelError):
        MctsTeacherResult.from_json(raw)


def test_teacher_result_negative_visits_fails() -> None:
    raw = _teacher_result()
    raw["candidates"][0]["visits"] = -1
    with pytest.raises(ContractValidationError):
        MctsTeacherResult.from_json(raw)


def test_teacher_result_mean_utility_out_of_range_fails() -> None:
    raw = _teacher_result()
    raw["candidates"][0]["meanUtility"] = 1.5
    with pytest.raises(ContractValidationError):
        MctsTeacherResult.from_json(raw)


def _teacher_label(**overrides) -> dict:
    base = {
        "schemaVersion": 1,
        "eventId": "decision:ONLINE:7:abc123",
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "result": _teacher_result(),
        "generatedAt": "2026-10-06T00:00:01.000Z",
    }
    base.update(overrides)
    return base


def test_mcts_teacher_label_round_trips() -> None:
    label = MctsTeacherLabel.from_json(_teacher_label())
    assert label.event_id == "decision:ONLINE:7:abc123"
    assert label.origin == "ONLINE"
    assert label.mode == "PVE"


def test_mcts_teacher_label_unsupported_schema_fails() -> None:
    with pytest.raises(IncompatibleSchemaError):
        MctsTeacherLabel.from_json(_teacher_label(schemaVersion=2))


def test_mcts_teacher_label_unknown_origin_fails() -> None:
    with pytest.raises(ContractValidationError):
        MctsTeacherLabel.from_json(_teacher_label(origin="GHOST"))


def test_mcts_teacher_label_unknown_mode_fails() -> None:
    with pytest.raises(ContractValidationError):
        MctsTeacherLabel.from_json(_teacher_label(mode="RANKED"))
