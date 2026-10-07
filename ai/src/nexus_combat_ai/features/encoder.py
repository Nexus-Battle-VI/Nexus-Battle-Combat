"""`FeatureEncoder` (`feature-schema-v1`, EN-036.2 #566 §20-§34).

`encode(state, candidate) -> np.ndarray[float32]` de dimension fija
`FEATURE_DIMENSION`. Determinista, puro (sin IO, sin RNG), nunca muta
`state`/`candidate`. Cualquier dato categorico fuera del vocabulario
congelado, o cualquier referencia (`abilityId`/`epicId`/combatiente) que no
exista en `state`, hace fallar explicito -- nunca produce un vector con
ceros silenciosos (#566 §26-§31, §55).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from nexus_combat_ai.contracts.decision_event import (
    BattleDecisionState,
    CombatantKey,
    CombatMagnitude,
    DecisionAbility,
    DecisionCombatant,
    DecisionEffect,
    DecisionEpic,
    LegalAction,
)
from nexus_combat_ai.errors import MissingReferencedEntityError, UnsupportedFeatureCategoryError
from nexus_combat_ai.features.schema import (
    ABILITIES_COUNT_CAP,
    ACTIVE_EFFECTS_COUNT_CAP,
    CHARGE_OR_COOLDOWN_CAP,
    COOLDOWNS_COUNT_CAP,
    DAMAGE_MEMORY_CAP,
    DECISION_STATE_SCHEMA_VERSION_SUPPORTED,
    EFFECT_COUNT_CAP,
    EFFECT_KIND_VOCAB,
    EFFECT_OPERATION_VOCAB,
    EFFECT_STATISTIC_VOCAB,
    EFFECT_TARGET_VOCAB,
    FEATURE_DIMENSION,
    LEVEL_MAX,
    LEVEL_MIN,
    MAGNITUDE_CAP,
    POWER_COST_CAP,
    ROUND_CAP,
    STAT_CAP,
    TEAM_CAP,
    TURNS_COMPLETED_CAP,
    saturating_norm,
)


def _check_vocab(value: str | None, vocab: frozenset[str], label: str) -> None:
    if value is not None and value not in vocab:
        raise UnsupportedFeatureCategoryError(
            f'{label} = "{value}" no esta en el vocabulario congelado de feature-schema-v1. '
            "Una categoria nueva exige feature-schema-v2."
        )


def _magnitude_onehot_value(magnitude: CombatMagnitude | None) -> tuple[float, float, float, float]:
    if magnitude is None:
        return 0.0, 0.0, 0.0, 0.0
    fixed = 1.0 if magnitude.mode == "FIXED" else 0.0
    percentage = 1.0 if magnitude.mode == "PERCENTAGE" else 0.0
    dice = 1.0 if magnitude.mode == "DICE" else 0.0
    value_norm = saturating_norm(magnitude.expected_value(), MAGNITUDE_CAP)
    return fixed, percentage, dice, value_norm


def _check_effect_vocab(effect: DecisionEffect, path: str) -> None:
    _check_vocab(effect.kind, EFFECT_KIND_VOCAB, f"{path}.kind")
    _check_vocab(effect.target, EFFECT_TARGET_VOCAB, f"{path}.target")
    _check_vocab(effect.statistic, EFFECT_STATISTIC_VOCAB, f"{path}.statistic")
    _check_vocab(effect.operation, EFFECT_OPERATION_VOCAB, f"{path}.operation")


@dataclass(frozen=True, slots=True)
class _GroupAggregate:
    count_norm: float
    alive_count_norm: float
    health_ratio_mean: float
    health_ratio_min: float
    power_presence_ratio: float
    power_ratio_mean: float
    attack_norm_mean: float
    defense_norm_mean: float
    active_effects_count_mean_norm: float

    def as_list(self) -> list[float]:
        return [
            self.count_norm,
            self.alive_count_norm,
            self.health_ratio_mean,
            self.health_ratio_min,
            self.power_presence_ratio,
            self.power_ratio_mean,
            self.attack_norm_mean,
            self.defense_norm_mean,
            self.active_effects_count_mean_norm,
        ]


def _health_ratio(combatant: DecisionCombatant, path: str) -> float:
    if combatant.health is None:
        raise MissingReferencedEntityError(
            f"{path}: el combatiente no tiene Vida valida (health=null)."
        )
    current, maximum = combatant.health
    if maximum <= 0:
        raise MissingReferencedEntityError(f"{path}: maxHealth invalido ({maximum}).")
    return max(0.0, min(1.0, current / maximum))


def _power_presence_ratio(combatant: DecisionCombatant) -> tuple[bool, float]:
    if combatant.power is None:
        return False, 0.0
    current, maximum = combatant.power
    if maximum <= 0:
        return False, 0.0
    return True, max(0.0, min(1.0, current / maximum))


def _attack_presence_norm(combatant: DecisionCombatant) -> tuple[bool, float]:
    if combatant.attack is None:
        return False, 0.0
    return True, saturating_norm(float(combatant.attack), STAT_CAP)


def _defense_norm(combatant: DecisionCombatant) -> float:
    if combatant.defense is None:
        return 0.0
    return saturating_norm(float(combatant.defense), STAT_CAP)


def _group_aggregate(members: tuple[DecisionCombatant, ...], path: str) -> _GroupAggregate:
    count = len(members)
    if count == 0:
        return _GroupAggregate(
            count_norm=0.0,
            alive_count_norm=0.0,
            health_ratio_mean=1.0,
            health_ratio_min=1.0,
            power_presence_ratio=0.0,
            power_ratio_mean=0.0,
            attack_norm_mean=0.0,
            defense_norm_mean=0.0,
            active_effects_count_mean_norm=0.0,
        )

    health_ratios = [_health_ratio(m, f"{path}[{i}]") for i, m in enumerate(members)]
    alive_count = sum(1 for h in health_ratios if h > 0.0)
    power_flags_ratios = [_power_presence_ratio(m) for m in members]
    power_present_count = sum(1 for present, _ in power_flags_ratios if present)
    power_ratio_mean = (
        sum(r for present, r in power_flags_ratios if present) / power_present_count
        if power_present_count > 0
        else 0.0
    )
    attack_flags_norms = [_attack_presence_norm(m) for m in members]
    attack_present_count = sum(1 for present, _ in attack_flags_norms if present)
    attack_norm_mean = (
        sum(n for present, n in attack_flags_norms if present) / attack_present_count
        if attack_present_count > 0
        else 0.0
    )
    defense_norms = [_defense_norm(m) for m in members]
    active_effects_norms = [
        saturating_norm(float(len(m.active_effects)), ACTIVE_EFFECTS_COUNT_CAP) for m in members
    ]

    return _GroupAggregate(
        count_norm=saturating_norm(float(count), TEAM_CAP),
        alive_count_norm=saturating_norm(float(alive_count), TEAM_CAP),
        health_ratio_mean=sum(health_ratios) / count,
        health_ratio_min=min(health_ratios),
        power_presence_ratio=power_present_count / count,
        power_ratio_mean=power_ratio_mean,
        attack_norm_mean=attack_norm_mean,
        defense_norm_mean=sum(defense_norms) / count,
        active_effects_count_mean_norm=sum(active_effects_norms) / count,
    )


def _same_combatant(left: CombatantKey, right: CombatantKey) -> bool:
    return left.team_label == right.team_label and left.seat == right.seat


def _find_combatant(state: BattleDecisionState, key: CombatantKey) -> DecisionCombatant | None:
    if _same_combatant(state.actor.identity, key):
        return state.actor
    for ally in state.allies:
        if _same_combatant(ally.identity, key):
            return ally
    for enemy in state.enemies:
        if _same_combatant(enemy.identity, key):
            return enemy
    return None


def _effects_summary(
    effects: tuple[DecisionEffect, ...], path: str
) -> tuple[float, float, float, float, float]:
    """`(has_healing, has_damage, has_buff_self, has_debuff_opponent, has_immunity)`."""
    has_healing = has_damage = has_buff_self = has_debuff_opponent = has_immunity = False
    for i, effect in enumerate(effects):
        _check_effect_vocab(effect, f"{path}[{i}]")
        if effect.statistic == "HEALING":
            has_healing = True
        if effect.kind == "DAMAGE" or effect.statistic == "DAMAGE":
            has_damage = True
        if (
            effect.target == "SELF"
            and effect.operation == "INCREASE"
            and effect.statistic != "HEALING"
        ):
            has_buff_self = True
        if effect.target == "OPPONENT" and effect.operation == "DECREASE":
            has_debuff_opponent = True
        if effect.kind == "IMMUNITY":
            has_immunity = True
    return (
        1.0 if has_healing else 0.0,
        1.0 if has_damage else 0.0,
        1.0 if has_buff_self else 0.0,
        1.0 if has_debuff_opponent else 0.0,
        1.0 if has_immunity else 0.0,
    )


def _resolve_ability(actor: DecisionCombatant, ability_id: str) -> DecisionAbility:
    for ability in actor.abilities:
        if ability.ability_id == ability_id:
            return ability
    raise MissingReferencedEntityError(
        f'candidate.abilityId = "{ability_id}" no existe en state.actor.abilities.'
    )


def _resolve_epic(actor: DecisionCombatant, epic_id: str) -> DecisionEpic:
    if actor.epic is None:
        raise MissingReferencedEntityError(
            f'candidate.epicId = "{epic_id}" pero state.actor.epic es null.'
        )
    if actor.epic.epic_id != epic_id:
        raise MissingReferencedEntityError(
            f'candidate.epicId = "{epic_id}" no coincide con state.actor.epic.epicId '
            f'("{actor.epic.epic_id}").'
        )
    return actor.epic


class FeatureEncoder:
    """Ver `nexus_combat_ai.features.schema` para el contrato completo del vector."""

    def encode(self, state: BattleDecisionState, candidate: LegalAction) -> np.ndarray:
        if state.schema_version != DECISION_STATE_SCHEMA_VERSION_SUPPORTED:
            raise UnsupportedFeatureCategoryError(
                f"BattleDecisionState.schemaVersion = {state.schema_version} no soportado por "
                f"feature-schema-v1 (solo {DECISION_STATE_SCHEMA_VERSION_SUPPORTED})."
            )
        _check_vocab(state.context.mode, frozenset(("PVP", "PVE")), "state.context.mode")

        values: list[float] = []
        values.extend(self._state_features(state))
        values.extend(self._actor_features(state.actor))
        allies_aggregate = _group_aggregate(state.allies, "state.allies")
        enemies_aggregate = _group_aggregate(state.enemies, "state.enemies")
        values.extend(allies_aggregate.as_list())
        values.extend(enemies_aggregate.as_list())
        values.extend(
            self._candidate_features(state, candidate, allies_aggregate, enemies_aggregate)
        )

        vector = np.asarray(values, dtype=np.float32)
        if vector.shape != (FEATURE_DIMENSION,):
            raise AssertionError(
                f"feature-schema-v1 produjo {vector.shape[0]} valores, "
                f"se esperaban {FEATURE_DIMENSION}."
            )
        if not np.isfinite(vector).all():
            raise UnsupportedFeatureCategoryError("El vector de features contiene NaN/Inf.")
        return vector

    def _state_features(self, state: BattleDecisionState) -> list[float]:
        mode = state.context.mode
        return [
            1.0 if mode == "PVP" else 0.0,
            1.0 if mode == "PVE" else 0.0,
            saturating_norm(float(state.context.round), ROUND_CAP),
            saturating_norm(float(state.context.turns_completed), TURNS_COMPLETED_CAP),
        ]

    def _actor_features(self, actor: DecisionCombatant) -> list[float]:
        health_ratio = _health_ratio(actor, "state.actor")
        power_present, power_ratio = _power_presence_ratio(actor)
        attack_present, attack_norm = _attack_presence_norm(actor)
        defense_norm = _defense_norm(actor)
        damage_present = actor.damage is not None
        damage_fixed, damage_pct, damage_dice, damage_value = _magnitude_onehot_value(actor.damage)
        level = actor.level if actor.level is not None else LEVEL_MIN
        level_norm = (level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)
        cooldowns_norm = saturating_norm(float(len(actor.cooldowns)), COOLDOWNS_COUNT_CAP)
        abilities_norm = saturating_norm(float(len(actor.abilities)), ABILITIES_COUNT_CAP)
        epic_present = actor.epic is not None
        epic_cost_norm = (
            saturating_norm(float(actor.epic.power_cost), POWER_COST_CAP) if epic_present else 0.0
        )
        epic_cooldown_ratio = (
            actor.epic.cooldown_remaining / actor.epic.cooldown_turns
            if epic_present and actor.epic.cooldown_turns > 0
            else 0.0
        )
        active_effects_norm = saturating_norm(
            float(len(actor.active_effects)), ACTIVE_EFFECTS_COUNT_CAP
        )
        damage_memory_present = actor.damage_memory is not None
        damage_memory_norm = (
            saturating_norm(actor.damage_memory.amount, DAMAGE_MEMORY_CAP)
            if damage_memory_present
            else 0.0
        )

        return [
            health_ratio,
            1.0 if power_present else 0.0,
            power_ratio,
            1.0 if attack_present else 0.0,
            attack_norm,
            defense_norm,
            1.0 if damage_present else 0.0,
            damage_fixed,
            damage_pct,
            damage_dice,
            damage_value,
            level_norm,
            cooldowns_norm,
            abilities_norm,
            1.0 if epic_present else 0.0,
            epic_cost_norm,
            epic_cooldown_ratio,
            active_effects_norm,
            1.0 if damage_memory_present else 0.0,
            damage_memory_norm,
        ]

    def _candidate_features(
        self,
        state: BattleDecisionState,
        candidate: LegalAction,
        allies_aggregate: _GroupAggregate,
        enemies_aggregate: _GroupAggregate,
    ) -> list[float]:
        kind_basic = 1.0 if candidate.kind == "BASIC_ATTACK" else 0.0
        kind_ability = 1.0 if candidate.kind == "ABILITY" else 0.0
        kind_epic = 1.0 if candidate.kind == "EPIC" else 0.0

        scope = candidate.target.scope
        scope_combatant = 1.0 if scope == "COMBATANT" else 0.0
        scope_self = 1.0 if scope == "SELF" else 0.0
        scope_group = 1.0 if scope == "ALLIED_GROUP" else 0.0

        (
            relation_self,
            relation_ally,
            relation_enemy,
            target_health_ratio,
            target_power_present,
            target_power_ratio,
        ) = self._resolve_target(state, candidate, allies_aggregate)

        target_is_group = scope_group
        target_is_alive = 1.0 if target_health_ratio > 0.0 else 0.0

        has_power_cost = candidate.kind in ("ABILITY", "EPIC")
        power_cost_mode_fixed = power_cost_mode_all = 0.0
        power_cost_norm = 0.0
        charge_or_cooldown_norm = 0.0
        cooldown_ratio = 0.0
        effect_count_norm = 0.0
        effect_has_healing = effect_has_damage = effect_has_buff_self = 0.0
        effect_has_debuff_opponent = effect_has_immunity = 0.0
        primary_fixed = primary_pct = primary_dice = primary_value = 0.0

        if candidate.kind == "ABILITY":
            assert candidate.ability_id is not None
            ability = _resolve_ability(state.actor, candidate.ability_id)
            power_cost_mode_fixed = 1.0 if ability.power_cost.mode == "FIXED" else 0.0
            power_cost_mode_all = 1.0 if ability.power_cost.mode == "ALL_AVAILABLE" else 0.0
            if ability.power_cost.mode == "FIXED":
                assert ability.power_cost.amount is not None
                power_cost_norm = saturating_norm(float(ability.power_cost.amount), POWER_COST_CAP)
            else:
                _, actor_power_ratio = _power_presence_ratio(state.actor)
                power_cost_norm = actor_power_ratio
            charge_or_cooldown_norm = saturating_norm(
                float(ability.charge_turns), CHARGE_OR_COOLDOWN_CAP
            )
            remaining = next(
                (
                    c.remaining_own_turns
                    for c in state.actor.cooldowns
                    if c.ability_id == ability.ability_id
                ),
                0,
            )
            cooldown_ratio = remaining / ability.charge_turns if ability.charge_turns > 0 else 0.0
            effect_count_norm = saturating_norm(float(len(ability.effects)), EFFECT_COUNT_CAP)
            (
                effect_has_healing,
                effect_has_damage,
                effect_has_buff_self,
                effect_has_debuff_opponent,
                effect_has_immunity,
            ) = _effects_summary(
                ability.effects, f'actor.abilities["{ability.ability_id}"].effects'
            )
            primary = ability.effects[0].magnitude if ability.effects else None
            primary_fixed, primary_pct, primary_dice, primary_value = _magnitude_onehot_value(
                primary
            )
        elif candidate.kind == "EPIC":
            assert candidate.epic_id is not None
            epic = _resolve_epic(state.actor, candidate.epic_id)
            power_cost_mode_fixed = 1.0
            power_cost_norm = saturating_norm(float(epic.power_cost), POWER_COST_CAP)
            charge_or_cooldown_norm = saturating_norm(
                float(epic.cooldown_turns), CHARGE_OR_COOLDOWN_CAP
            )
            cooldown_ratio = (
                epic.cooldown_remaining / epic.cooldown_turns if epic.cooldown_turns > 0 else 0.0
            )
            effect_count_norm = saturating_norm(float(len(epic.effects)), EFFECT_COUNT_CAP)
            (
                effect_has_healing,
                effect_has_damage,
                effect_has_buff_self,
                effect_has_debuff_opponent,
                effect_has_immunity,
            ) = _effects_summary(epic.effects, "actor.epic.effects")
            primary = epic.effects[0].magnitude if epic.effects else None
            primary_fixed, primary_pct, primary_dice, primary_value = _magnitude_onehot_value(
                primary
            )

        return [
            kind_basic,
            kind_ability,
            kind_epic,
            scope_combatant,
            scope_self,
            scope_group,
            relation_self,
            relation_ally,
            relation_enemy,
            target_is_group,
            target_health_ratio,
            target_power_present,
            target_power_ratio,
            target_is_alive,
            1.0 if has_power_cost else 0.0,
            power_cost_mode_fixed,
            power_cost_mode_all,
            power_cost_norm,
            charge_or_cooldown_norm,
            cooldown_ratio,
            effect_count_norm,
            effect_has_healing,
            effect_has_damage,
            effect_has_buff_self,
            effect_has_debuff_opponent,
            effect_has_immunity,
            primary_fixed,
            primary_pct,
            primary_dice,
            primary_value,
        ]

    def _resolve_target(
        self,
        state: BattleDecisionState,
        candidate: LegalAction,
        allies_aggregate: _GroupAggregate,
    ) -> tuple[float, float, float, float, float, float]:
        """`(relation_self, relation_ally, relation_enemy, health_ratio,
        power_present, power_ratio)`."""
        scope = candidate.target.scope

        if scope == "SELF":
            health_ratio = _health_ratio(state.actor, "state.actor")
            power_present, power_ratio = _power_presence_ratio(state.actor)
            return 1.0, 0.0, 0.0, health_ratio, 1.0 if power_present else 0.0, power_ratio

        if scope == "ALLIED_GROUP":
            return (
                0.0,
                1.0,
                0.0,
                allies_aggregate.health_ratio_mean,
                1.0 if allies_aggregate.power_presence_ratio > 0.0 else 0.0,
                allies_aggregate.power_ratio_mean,
            )

        assert candidate.target.combatant is not None
        target_key = candidate.target.combatant
        if _same_combatant(target_key, state.actor.identity):
            health_ratio = _health_ratio(state.actor, "state.actor")
            power_present, power_ratio = _power_presence_ratio(state.actor)
            return 1.0, 0.0, 0.0, health_ratio, 1.0 if power_present else 0.0, power_ratio

        target = _find_combatant(state, target_key)
        if target is None:
            raise MissingReferencedEntityError(
                f'candidate.target.combatant = "{target_key.identity()}" no existe en el '
                "state (ni actor, ni allies, ni enemies)."
            )
        health_ratio = _health_ratio(target, f'target["{target_key.identity()}"]')
        power_present, power_ratio = _power_presence_ratio(target)
        is_ally = target.identity.team_label == state.actor.identity.team_label
        if is_ally:
            return 0.0, 1.0, 0.0, health_ratio, 1.0 if power_present else 0.0, power_ratio
        return 0.0, 0.0, 1.0, health_ratio, 1.0 if power_present else 0.0, power_ratio
