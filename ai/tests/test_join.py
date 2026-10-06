"""Join decision<->label (#566 §14-§17, D-08/D-09/D-10 de §85)."""

from __future__ import annotations

import pytest

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent
from nexus_combat_ai.contracts.teacher_label import TeacherLabelRecord
from nexus_combat_ai.dataset.join import join_decisions_with_labels
from nexus_combat_ai.errors import DuplicateTeacherLabelError

from .fixtures import builders as b


def _event(
    event_id: str, battle_id: str = "battle-1", decision_sequence: int = 0, **overrides
) -> CombatDecisionEvent:
    raw = {
        "schemaVersion": 1,
        "eventType": "COMBAT_DECISION",
        "eventId": event_id,
        "battleId": battle_id,
        "decisionSequence": decision_sequence,
        "origin": "ONLINE",
        "mode": "PVE",
        "actor": {"teamLabel": "A", "seat": 0},
        "decisionSource": "RULE_BASED",
        "stateBefore": b.state(),
        "legalActions": [b.basic_attack_on("B", 0)],
        "selectedAction": b.basic_attack_on("B", 0),
        "occurredAt": "2026-10-06T00:00:00.000Z",
    }
    raw.update(overrides)
    return CombatDecisionEvent.from_json(raw)


def _end_turn_event(
    event_id: str, battle_id: str = "battle-1", decision_sequence: int = 0
) -> CombatDecisionEvent:
    return _event(
        event_id,
        battle_id,
        decision_sequence,
        schemaVersion=2,
        legalActions=[],
        selectedAction={"kind": "END_TURN"},
        decisionSource="SYSTEM",
    )


def _label(
    event_id: str, battle_id: str = "battle-1", decision_sequence: int = 0
) -> TeacherLabelRecord:
    action = b.basic_attack_on("B", 0)
    raw = {
        "schemaVersion": "teacher-label-fixture-v1",
        "eventId": event_id,
        "battleId": battle_id,
        "decisionSequence": decision_sequence,
        "result": {
            "config": {
                "teacherVersion": "mcts-teacher-v1",
                "utilityVersion": "pve-utility-v1",
                "rollouts": 4,
                "maxDepthPlies": 6,
                "explorationConstant": 1.41,
                "rolloutPolicyVersion": "rule-based-v1",
            },
            "simulationSeed": 1,
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
        },
    }
    return TeacherLabelRecord.from_json(raw)


def test_d08_end_turn_always_excluded() -> None:
    events = [_event("e1"), _end_turn_event("e2", decision_sequence=1)]
    labels = [_label("e1")]
    joined, stats = join_decisions_with_labels(events, labels)
    assert stats.total_decisions == 2
    assert stats.excluded_end_turn == 1
    assert len(joined) == 1
    assert joined[0].event.event_id == "e1"


def test_d09_duplicate_label_for_same_event_id_fails() -> None:
    labels = [_label("e1"), _label("e1")]
    with pytest.raises(DuplicateTeacherLabelError):
        join_decisions_with_labels([_event("e1")], labels)


def test_d10_decision_without_label_is_excluded_and_counted() -> None:
    events = [_event("e1"), _event("e2", decision_sequence=1)]
    labels = [_label("e1")]
    joined, stats = join_decisions_with_labels(events, labels)
    assert stats.missing_label == 1
    assert len(joined) == 1


def test_d07_battle_leakage_is_structurally_impossible_in_join() -> None:
    # El join no agrupa ni filtra por battleId: cada JoinedDecision conserva
    # su propio battleId intacto, que es lo que luego usa split.py.
    events = [
        _event("e1", battle_id="battle-A"),
        _event("e2", battle_id="battle-B", decision_sequence=1),
    ]
    labels = [
        _label("e1", battle_id="battle-A"),
        _label("e2", battle_id="battle-B", decision_sequence=1),
    ]
    joined, _ = join_decisions_with_labels(events, labels)
    battle_ids = {jd.event.battle_id for jd in joined}
    assert battle_ids == {"battle-A", "battle-B"}
