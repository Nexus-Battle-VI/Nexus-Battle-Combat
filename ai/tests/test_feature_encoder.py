"""F-01..F-18 (#566 §84): FeatureEncoder."""

from __future__ import annotations

import copy

import numpy as np
import pytest

from nexus_combat_ai.contracts.decision_event import BattleDecisionState, LegalAction
from nexus_combat_ai.errors import (
    ContractValidationError,
    MissingReferencedEntityError,
    UnsupportedFeatureCategoryError,
)
from nexus_combat_ai.features.encoder import FeatureEncoder
from nexus_combat_ai.features.schema import FEATURE_DIMENSION, FEATURE_INDEX

from .fixtures import builders as b

ENCODER = FeatureEncoder()


def _encode(state_json: dict, candidate_json: dict) -> np.ndarray:
    state = BattleDecisionState.from_json(state_json)
    candidate = LegalAction.from_json(candidate_json)
    return ENCODER.encode(state, candidate)


def test_f01_output_is_float32() -> None:
    vec = _encode(b.state(), b.basic_attack_on("B", 0))
    assert vec.dtype == np.float32


def test_f02_fixed_dimension() -> None:
    vec = _encode(b.state(), b.basic_attack_on("B", 0))
    assert vec.shape == (FEATURE_DIMENSION,)


def test_f03_same_input_same_vector() -> None:
    state_json = b.state()
    candidate_json = b.basic_attack_on("B", 0)
    v1 = _encode(copy.deepcopy(state_json), copy.deepcopy(candidate_json))
    v2 = _encode(copy.deepcopy(state_json), copy.deepcopy(candidate_json))
    assert np.array_equal(v1, v2)


def test_f04_does_not_mutate_input() -> None:
    state_json = b.state()
    candidate_json = b.basic_attack_on("B", 0)
    before_state = copy.deepcopy(state_json)
    before_candidate = copy.deepcopy(candidate_json)
    state = BattleDecisionState.from_json(state_json)
    candidate = LegalAction.from_json(candidate_json)
    ENCODER.encode(state, candidate)
    assert state_json == before_state
    assert candidate_json == before_candidate


def test_f05_health_and_power_ratio() -> None:
    actor = b.combatant("A", 0, health=(22, 44), power=(3, 10))
    vec = _encode(b.state(actor=actor), b.basic_attack_on("B", 0))
    assert vec[FEATURE_INDEX["actor.health_ratio"]] == pytest.approx(0.5)
    assert vec[FEATURE_INDEX["actor.power_present"]] == 1.0
    assert vec[FEATURE_INDEX["actor.power_ratio"]] == pytest.approx(0.3)


def test_f06_basic_attack_candidate() -> None:
    vec = _encode(b.state(), b.basic_attack_on("B", 0))
    assert vec[FEATURE_INDEX["candidate.kind_basic_attack"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.kind_ability"]] == 0.0
    assert vec[FEATURE_INDEX["candidate.has_power_cost"]] == 0.0


def test_f07_ability_candidate_resolves_power_cost_and_effects() -> None:
    storm = b.ability(
        "storm-1",
        power_cost=b.power_cost_fixed(6),
        charge_turns=1,
        effects=[b.attack_bonus(b.dice(3, 6)), b.damage_bonus(b.fixed(2))],
    )
    actor = b.combatant("A", 0, abilities=[storm])
    vec = _encode(b.state(actor=actor), b.ability_action_on("storm-1", "B", 0))
    assert vec[FEATURE_INDEX["candidate.kind_ability"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.has_power_cost"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.power_cost_mode_fixed"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.power_cost_norm"]] == pytest.approx(6.0 / 20.0)
    # STORM (ver auditoria de PR#80/EN-036.1): su efecto damage_bonus tiene
    # statistic=DAMAGE, asi que SI cuenta como "la habilidad inflige dano"
    # aunque el efecto en si sea un auto-buff -- Combat la resuelve como un
    # ataque mejorado, nunca como un buff inerte.
    assert vec[FEATURE_INDEX["candidate.effect_has_damage"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.effect_has_buff_self"]] == 1.0


def test_f07b_ability_all_available_cost_uses_actor_power_ratio() -> None:
    revive = b.ability("revive-1", power_cost=b.POWER_COST_ALL_AVAILABLE, effects=[])
    actor = b.combatant("A", 0, power=(7, 10), abilities=[revive])
    vec = _encode(b.state(actor=actor), b.ability_action_self("revive-1"))
    assert vec[FEATURE_INDEX["candidate.power_cost_mode_all_available"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.power_cost_norm"]] == pytest.approx(0.7)


def test_f08_epic_candidate_requires_matching_epic_id() -> None:
    e = b.epic(
        "epic-1",
        power_cost=0,
        cooldown_turns=2,
        cooldown_remaining=1,
        effects=[b.direct_damage(b.fixed(10))],
    )
    actor = b.combatant("A", 0, epic_=e)
    vec = _encode(b.state(actor=actor), b.epic_action_on("epic-1", "B", 0))
    assert vec[FEATURE_INDEX["candidate.kind_epic"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.cooldown_ratio"]] == pytest.approx(0.5)
    assert vec[FEATURE_INDEX["candidate.effect_has_damage"]] == 1.0


def test_f08b_epic_id_mismatch_fails_closed() -> None:
    e = b.epic("epic-1")
    actor = b.combatant("A", 0, epic_=e)
    with pytest.raises(MissingReferencedEntityError):
        _encode(b.state(actor=actor), b.epic_action_on("epic-OTHER", "B", 0))


def test_f09_self_target() -> None:
    buff = b.ability("buff-1", effects=[b.attack_bonus(b.fixed(2))])
    actor = b.combatant("A", 0, health=(44, 44), abilities=[buff])
    vec = _encode(b.state(actor=actor), b.ability_action_self("buff-1"))
    assert vec[FEATURE_INDEX["candidate.target_relation_self"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.target_health_ratio"]] == pytest.approx(1.0)


def test_f10_combatant_enemy_target() -> None:
    vec = _encode(b.state(), b.basic_attack_on("B", 0))
    assert vec[FEATURE_INDEX["candidate.target_relation_enemy"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.target_scope_combatant"]] == 1.0


def test_f11_combatant_ally_target() -> None:
    heal = b.ability("heal-1", effects=[b.heal_bonus(b.fixed(2), target="ALLY")])
    actor = b.combatant("A", 0, abilities=[heal])
    ally = b.combatant("A", 1, health=(10, 44))
    vec = _encode(b.state(actor=actor, allies=[ally]), b.ability_action_on("heal-1", "A", 1))
    assert vec[FEATURE_INDEX["candidate.target_relation_ally"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.target_health_ratio"]] == pytest.approx(10 / 44)
    assert vec[FEATURE_INDEX["candidate.effect_has_healing"]] == 1.0


def test_f12_allied_group_target_uses_group_mean() -> None:
    group_heal = b.ability(
        "group-heal", effects=[b.heal_bonus(b.dice(2, 6), target="ALLIED_GROUP")]
    )
    actor = b.combatant("A", 0, abilities=[group_heal])
    allies = [b.combatant("A", 1, health=(10, 44)), b.combatant("A", 2, health=(44, 44))]
    vec = _encode(b.state(actor=actor, allies=allies), b.ability_action_group("group-heal"))
    assert vec[FEATURE_INDEX["candidate.target_is_group"]] == 1.0
    assert vec[FEATURE_INDEX["candidate.target_health_ratio"]] == pytest.approx((10 / 44 + 1.0) / 2)


def test_f13_support_healer_without_numeric_attack_or_damage() -> None:
    heal = b.ability("heal-1", effects=[b.heal_bonus(b.fixed(2))])
    healer = b.combatant("A", 0, attack=None, damage=None, abilities=[heal])
    ally = b.combatant("A", 1, health=(5, 44))
    vec = _encode(b.state(actor=healer, allies=[ally]), b.ability_action_on("heal-1", "A", 1))
    assert vec[FEATURE_INDEX["actor.attack_present"]] == 0.0
    assert vec[FEATURE_INDEX["actor.damage_present"]] == 0.0


def test_f14_multiple_enemies_and_allies_aggregate() -> None:
    allies = [b.combatant("A", 1, health=(44, 44)), b.combatant("A", 2, health=(22, 44))]
    enemies = [b.combatant("B", 0, health=(44, 44)), b.combatant("B", 1, health=(0, 44))]
    vec = _encode(b.state(allies=allies, enemies=enemies), b.basic_attack_on("B", 0))
    assert vec[FEATURE_INDEX["allies.count_norm"]] == pytest.approx(2 / 5)
    assert vec[FEATURE_INDEX["allies.health_ratio_mean"]] == pytest.approx((1.0 + 0.5) / 2)
    assert vec[FEATURE_INDEX["enemies.count_norm"]] == pytest.approx(2 / 5)
    assert vec[FEATURE_INDEX["enemies.alive_count_norm"]] == pytest.approx(1 / 5)
    assert vec[FEATURE_INDEX["enemies.health_ratio_min"]] == pytest.approx(0.0)


def test_f15_active_effects_counted() -> None:
    active = [
        {
            "kind": "STAT",
            "sourceAbilityId": "x",
            "sourceCombatant": {"teamLabel": "A", "seat": 0},
            "statistic": "ATTACK",
            "operation": "INCREASE",
            "amount": 2,
            "remainingOwnTurns": 1,
        }
    ]
    actor = b.combatant("A", 0, active_effects=active)
    vec = _encode(b.state(actor=actor), b.basic_attack_on("B", 0))
    assert vec[FEATURE_INDEX["actor.active_effects_count_norm"]] == pytest.approx(1 / 10)


def test_f16_unknown_effect_kind_fails_closed() -> None:
    bogus = b.ability("bogus-1", effects=[b.effect("MYSTERY_KIND", "SELF")])
    actor = b.combatant("A", 0, abilities=[bogus])
    with pytest.raises(UnsupportedFeatureCategoryError):
        _encode(b.state(actor=actor), b.ability_action_self("bogus-1"))


def test_f16b_unknown_battle_mode_fails_closed() -> None:
    state_json = b.state(mode="PVE")
    state_json["context"]["mode"] = "RANKED"
    with pytest.raises(ContractValidationError):
        BattleDecisionState.from_json(state_json)


def test_f17_nan_health_fails_closed() -> None:
    actor = b.combatant("A", 0, health=(44, 0))
    with pytest.raises(MissingReferencedEntityError):
        _encode(b.state(actor=actor), b.basic_attack_on("B", 0))


def test_f18_missing_ability_reference_fails_closed() -> None:
    actor = b.combatant("A", 0, abilities=[])
    with pytest.raises(MissingReferencedEntityError):
        _encode(b.state(actor=actor), b.ability_action_on("does-not-exist", "B", 0))


def test_f18b_missing_target_combatant_fails_closed() -> None:
    with pytest.raises(MissingReferencedEntityError):
        _encode(b.state(), b.basic_attack_on("B", 99))


def test_values_are_always_finite() -> None:
    vec = _encode(b.state(), b.basic_attack_on("B", 0))
    assert np.isfinite(vec).all()
