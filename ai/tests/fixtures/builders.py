"""Builders JSON minimos para tests, con la MISMA forma (camelCase) que Combat
produce de verdad. Nada aqui reemplaza el contrato real: es solo para no
repetir diccionarios gigantes en cada test."""

from __future__ import annotations

from typing import Any


def fixed(amount: int) -> dict[str, Any]:
    return {"mode": "FIXED", "amount": amount}


def dice(count: int, sides: int) -> dict[str, Any]:
    return {"mode": "DICE", "count": count, "sides": sides}


def percentage(basis_points: int) -> dict[str, Any]:
    return {"mode": "PERCENTAGE", "basisPoints": basis_points}


def power_cost_fixed(amount: int) -> dict[str, Any]:
    return {"mode": "FIXED", "amount": amount}


POWER_COST_ALL_AVAILABLE: dict[str, Any] = {"mode": "ALL_AVAILABLE"}


def effect(
    kind: str,
    target: str,
    *,
    statistic: str | None = None,
    operation: str | None = None,
    magnitude: dict[str, Any] | None = None,
    duration_turns: int | None = None,
    has_activation_condition: bool = False,
    immunity_code: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "kind": kind,
        "target": target,
        "hasActivationCondition": has_activation_condition,
    }
    if statistic is not None:
        out["statistic"] = statistic
    if operation is not None:
        out["operation"] = operation
    if magnitude is not None:
        out["magnitude"] = magnitude
    if duration_turns is not None:
        out["durationTurns"] = duration_turns
    if immunity_code is not None:
        out["immunityCode"] = immunity_code
    return out


def attack_bonus(magnitude: dict[str, Any]) -> dict[str, Any]:
    return effect(
        "STAT_MODIFIER", "SELF", statistic="ATTACK", operation="INCREASE", magnitude=magnitude
    )


def damage_bonus(magnitude: dict[str, Any]) -> dict[str, Any]:
    return effect(
        "STAT_MODIFIER", "SELF", statistic="DAMAGE", operation="INCREASE", magnitude=magnitude
    )


def heal_bonus(magnitude: dict[str, Any], target: str = "ALLY") -> dict[str, Any]:
    return effect(
        "STAT_MODIFIER", target, statistic="HEALING", operation="INCREASE", magnitude=magnitude
    )


def direct_damage(magnitude: dict[str, Any]) -> dict[str, Any]:
    return effect("DAMAGE", "OPPONENT", magnitude=magnitude)


def ability(
    ability_id: str,
    *,
    power_cost: dict[str, Any] | None = None,
    charge_turns: int = 1,
    effects: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "abilityId": ability_id,
        "powerCost": power_cost or power_cost_fixed(3),
        "chargeTurns": charge_turns,
        "effects": effects or [],
    }


def epic(
    epic_id: str,
    *,
    power_cost: int = 0,
    cooldown_turns: int = 2,
    cooldown_remaining: int = 0,
    effects: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "epicId": epic_id,
        "powerCost": power_cost,
        "cooldownTurns": cooldown_turns,
        "cooldownRemaining": cooldown_remaining,
        "effects": effects or [],
    }


_UNSET: Any = object()


def combatant(
    team_label: str,
    seat: int,
    *,
    kind: str = "HUMAN",
    hero_subtype: str | None = "GUERRERO_ARMAS",
    health: tuple[int, int] | None = (44, 44),
    power: tuple[int, int] | None = (10, 10),
    attack: int | None = 10,
    defense: int | None = 11,
    damage: dict[str, Any] | None = _UNSET,
    level: int | None = 1,
    cooldowns: list[dict[str, Any]] | None = None,
    abilities: list[dict[str, Any]] | None = None,
    epic_: dict[str, Any] | None = None,
    active_effects: list[dict[str, Any]] | None = None,
    damage_memory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "identity": {"teamLabel": team_label, "seat": seat},
        "kind": kind,
        "heroSubtype": hero_subtype,
        "health": None if health is None else {"current": health[0], "max": health[1]},
        "power": None if power is None else {"current": power[0], "max": power[1]},
        "attack": attack,
        "defense": defense,
        "damage": dice(1, 6) if damage is _UNSET else damage,
        "level": level,
        "cooldowns": cooldowns or [],
        "abilities": abilities or [],
        "epic": epic_,
        "activeEffects": active_effects or [],
        "damageMemory": damage_memory,
    }


def state(
    *,
    battle_id: str = "battle-1",
    mode: str = "PVE",
    round_: int = 1,
    turns_completed: int = 0,
    actor: dict[str, Any] | None = None,
    allies: list[dict[str, Any]] | None = None,
    enemies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "context": {
            "battleId": battle_id,
            "mode": mode,
            "round": round_,
            "turnsCompleted": turns_completed,
        },
        "actor": actor if actor is not None else combatant("A", 0),
        "allies": allies or [],
        "enemies": enemies if enemies is not None else [combatant("B", 0)],
    }


def basic_attack_on(team_label: str, seat: int) -> dict[str, Any]:
    return {
        "kind": "BASIC_ATTACK",
        "target": {"scope": "COMBATANT", "combatant": {"teamLabel": team_label, "seat": seat}},
    }


def ability_action_on(ability_id: str, team_label: str, seat: int) -> dict[str, Any]:
    return {
        "kind": "ABILITY",
        "abilityId": ability_id,
        "target": {"scope": "COMBATANT", "combatant": {"teamLabel": team_label, "seat": seat}},
    }


def ability_action_self(ability_id: str) -> dict[str, Any]:
    return {"kind": "ABILITY", "abilityId": ability_id, "target": {"scope": "SELF"}}


def ability_action_group(ability_id: str) -> dict[str, Any]:
    return {"kind": "ABILITY", "abilityId": ability_id, "target": {"scope": "ALLIED_GROUP"}}


def epic_action_on(epic_id: str, team_label: str, seat: int) -> dict[str, Any]:
    return {
        "kind": "EPIC",
        "epicId": epic_id,
        "target": {"scope": "COMBATANT", "combatant": {"teamLabel": team_label, "seat": seat}},
    }
