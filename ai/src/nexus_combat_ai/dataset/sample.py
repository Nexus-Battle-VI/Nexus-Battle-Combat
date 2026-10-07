"""`DecisionSample` (#566 §35-§39, §57-§59): la unidad logica del dataset.

Guarda el `BattleDecisionState` crudo y los candidatos YA ordenados
canonicamente por `actionIdentity` (nunca el orden de Mongo/JSON de origen,
#566 §57) -- asi `selected_index` se calcula DESPUES de ordenar y queda
alineado 1:1 con `teacher_probabilities[i]`/`candidate_features[i]` (§58).

Se serializa a JSONL en forma CRUDA (state + candidatos + label), no como
vectores ya codificados: el dia que exista `feature-schema-v2`, el mismo
JSONL se puede re-encodear sin volver a tocar Mongo/fixtures."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from nexus_combat_ai.contracts.decision_event import (
    BattleDecisionState,
    LegalAction,
)
from nexus_combat_ai.contracts.teacher_label import MctsCandidateResult
from nexus_combat_ai.dataset.join import JoinedDecision
from nexus_combat_ai.errors import InvalidTeacherLabelError


@dataclass(frozen=True, slots=True)
class DecisionSample:
    battle_id: str
    decision_sequence: int
    event_id: str
    origin: str
    decision_source: str
    state: BattleDecisionState
    candidates: tuple[MctsCandidateResult, ...]  # orden canonico (actionIdentity asc)
    selected_index: int

    def action_identities(self) -> tuple[str, ...]:
        return tuple(c.action_identity for c in self.candidates)

    def to_jsonl_dict(self) -> dict[str, Any]:
        return {
            "battleId": self.battle_id,
            "decisionSequence": self.decision_sequence,
            "eventId": self.event_id,
            "origin": self.origin,
            "decisionSource": self.decision_source,
            "stateBefore": _state_to_json(self.state),
            "candidates": [_candidate_to_json(c) for c in self.candidates],
            "selectedIndex": self.selected_index,
        }


def build_decision_sample(joined: JoinedDecision) -> DecisionSample:
    event = joined.event
    result = joined.label.result

    candidates_sorted = tuple(sorted(result.candidates, key=lambda c: c.action_identity))
    identities = [c.action_identity for c in candidates_sorted]
    selected_identity = result.selected_action.identity()
    matches = [i for i, identity in enumerate(identities) if identity == selected_identity]
    if len(matches) != 1:
        raise InvalidTeacherLabelError(
            f'eventId="{event.event_id}": selectedAction debe aparecer exactamente una vez '
            f"entre los candidatos ordenados (aparecio {len(matches)} veces)."
        )

    return DecisionSample(
        battle_id=event.battle_id,
        decision_sequence=event.decision_sequence,
        event_id=event.event_id,
        origin=event.origin,
        decision_source=event.decision_source,
        state=event.state_before,
        candidates=candidates_sorted,
        selected_index=matches[0],
    )


# --- Serializacion cruda (round-trip con los contratos, sin reinventar forma) -----


def _magnitude_to_json(magnitude: Any) -> dict[str, Any] | None:
    if magnitude is None:
        return None
    if magnitude.mode == "FIXED":
        return {"mode": "FIXED", "amount": magnitude.amount}
    if magnitude.mode == "PERCENTAGE":
        return {"mode": "PERCENTAGE", "basisPoints": magnitude.basis_points}
    return {"mode": "DICE", "count": magnitude.count, "sides": magnitude.sides}


def _effect_to_json(effect: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "kind": effect.kind,
        "target": effect.target,
        "hasActivationCondition": effect.has_activation_condition,
    }
    if effect.statistic is not None:
        out["statistic"] = effect.statistic
    if effect.operation is not None:
        out["operation"] = effect.operation
    if effect.magnitude is not None:
        out["magnitude"] = _magnitude_to_json(effect.magnitude)
    if effect.duration_turns is not None:
        out["durationTurns"] = effect.duration_turns
    if effect.immunity_code is not None:
        out["immunityCode"] = effect.immunity_code
    return out


def _ability_to_json(ability: Any) -> dict[str, Any]:
    power_cost: dict[str, Any] = {"mode": ability.power_cost.mode}
    if ability.power_cost.amount is not None:
        power_cost["amount"] = ability.power_cost.amount
    return {
        "abilityId": ability.ability_id,
        "powerCost": power_cost,
        "chargeTurns": ability.charge_turns,
        "effects": [_effect_to_json(e) for e in ability.effects],
    }


def _epic_to_json(epic: Any) -> dict[str, Any]:
    return {
        "epicId": epic.epic_id,
        "powerCost": epic.power_cost,
        "cooldownTurns": epic.cooldown_turns,
        "cooldownRemaining": epic.cooldown_remaining,
        "effects": [_effect_to_json(e) for e in epic.effects],
    }


def _active_effect_to_json(effect: Any) -> dict[str, Any]:
    base = {
        "kind": effect.kind,
        "sourceAbilityId": effect.source_ability_id,
        "sourceCombatant": {
            "teamLabel": effect.source_combatant.team_label,
            "seat": effect.source_combatant.seat,
        },
        "remainingOwnTurns": effect.remaining_own_turns,
    }
    if effect.kind == "STAT":
        base.update(statistic=effect.statistic, operation=effect.operation, amount=effect.amount)
    else:
        base.update(immunityCode=effect.immunity_code)
    return base


def _combatant_to_json(c: Any) -> dict[str, Any]:
    return {
        "identity": {"teamLabel": c.identity.team_label, "seat": c.identity.seat},
        "kind": c.kind,
        "heroSubtype": c.hero_subtype,
        "health": None if c.health is None else {"current": c.health[0], "max": c.health[1]},
        "power": None if c.power is None else {"current": c.power[0], "max": c.power[1]},
        "attack": c.attack,
        "defense": c.defense,
        "damage": _magnitude_to_json(c.damage),
        "level": c.level,
        "cooldowns": [
            {"abilityId": cd.ability_id, "remainingOwnTurns": cd.remaining_own_turns}
            for cd in c.cooldowns
        ],
        "abilities": [_ability_to_json(a) for a in c.abilities],
        "epic": None if c.epic is None else _epic_to_json(c.epic),
        "activeEffects": [_active_effect_to_json(e) for e in c.active_effects],
        "damageMemory": None
        if c.damage_memory is None
        else {
            "amount": c.damage_memory.amount,
            "remainingOwnTurns": c.damage_memory.remaining_own_turns,
        },
    }


def _state_to_json(state: BattleDecisionState) -> dict[str, Any]:
    return {
        "schemaVersion": state.schema_version,
        "context": {
            "battleId": state.context.battle_id,
            "mode": state.context.mode,
            "round": state.context.round,
            "turnsCompleted": state.context.turns_completed,
        },
        "actor": _combatant_to_json(state.actor),
        "allies": [_combatant_to_json(a) for a in state.allies],
        "enemies": [_combatant_to_json(e) for e in state.enemies],
    }


def _target_to_json(target: Any) -> dict[str, Any]:
    if target.scope == "COMBATANT":
        assert target.combatant is not None
        return {
            "scope": "COMBATANT",
            "combatant": {"teamLabel": target.combatant.team_label, "seat": target.combatant.seat},
        }
    return {"scope": target.scope}


def _action_to_json(action: LegalAction) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": action.kind, "target": _target_to_json(action.target)}
    if action.ability_id is not None:
        out["abilityId"] = action.ability_id
    if action.epic_id is not None:
        out["epicId"] = action.epic_id
    return out


def _candidate_to_json(candidate: MctsCandidateResult) -> dict[str, Any]:
    return {
        "action": _action_to_json(candidate.action),
        "actionIdentity": candidate.action_identity,
        "visits": candidate.visits,
        "meanUtility": candidate.mean_utility,
        "probability": candidate.probability,
    }


def decision_sample_from_jsonl_dict(raw: dict[str, Any]) -> DecisionSample:
    state = BattleDecisionState.from_json(raw["stateBefore"], "stateBefore")
    candidates = tuple(
        MctsCandidateResult.from_json(c, f"candidates[{i}]")
        for i, c in enumerate(raw["candidates"])
    )
    return DecisionSample(
        battle_id=raw["battleId"],
        decision_sequence=raw["decisionSequence"],
        event_id=raw["eventId"],
        origin=raw["origin"],
        decision_source=raw["decisionSource"],
        state=state,
        candidates=candidates,
        selected_index=raw["selectedIndex"],
    )
