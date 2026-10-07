"""Script de UNA SOLA VEZ para generar
tests/fixtures/training/{decision-events,teacher-labels}.jsonl (EN-036.3,
Management #567 §90-91).

El fixture de `#566` (`tests/fixtures/decision-events.jsonl`) NO sirve para
validar el entrenamiento: sus 3 battleIds `ONLINE` caen los tres en TRAIN
segun `battle-hash-split-v1` (ninguno en VALIDATION/TEST), asi que
`nexus-combat-train` sobre ese dataset produciria `validation.jsonl`/
`test.jsonl` vacios -- exactamente el caso que #567 prohibe entrenar (ver
`DatasetNotTrainableError`). Este script elige battleIds de modo
`battle-train-fixture-NNNN` cuyo `split_for_battle()` real cae uno en cada
split, y reutiliza los mismos builders/contratos que `generate_fixtures.py`
para que cada fixture sea valida contra el contrato real -- nunca se escribe
JSON a mano (#567 §91)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from fixtures import builders as b  # noqa: E402

from nexus_combat_ai.contracts.decision_event import LegalAction  # noqa: E402
from nexus_combat_ai.dataset.split import split_for_battle  # noqa: E402

events: list[dict] = []
labels: list[dict] = []

# battleIds verificados (script auxiliar, no commiteado) contra
# `split_for_battle()` real: uno por split, mas uno adicional de TRAIN para
# que el split mayoritario tenga mas de una batalla.
TRAIN_BATTLE_A = "battle-train-fixture-0001"
TRAIN_BATTLE_B = "battle-train-fixture-0002"
VALIDATION_BATTLE = "battle-train-fixture-0000"
TEST_BATTLE = "battle-train-fixture-0008"


def identity_of(action_json: dict) -> str:
    return LegalAction.from_json(action_json).identity()


def add_pair(
    event_id: str,
    battle_id: str,
    decision_sequence: int,
    *,
    origin: str,
    mode: str,
    actor_combatant: dict,
    allies: list[dict],
    enemies: list[dict],
    legal_actions: list[dict],
    candidates: list[dict],
    selected_action: dict,
    decision_source: str = "RULE_BASED",
    occurred_at: str,
    round_: int = 1,
    turns_completed: int = 0,
) -> None:
    state = b.state(
        battle_id=battle_id,
        mode=mode,
        round_=round_,
        turns_completed=turns_completed,
        actor=actor_combatant,
        allies=allies,
        enemies=enemies,
    )
    for candidate in candidates:
        candidate["actionIdentity"] = identity_of(candidate["action"])
    events.append(
        {
            "schemaVersion": 1,
            "eventType": "COMBAT_DECISION",
            "eventId": event_id,
            "battleId": battle_id,
            "decisionSequence": decision_sequence,
            "origin": origin,
            "mode": mode,
            "actor": {
                "teamLabel": actor_combatant["identity"]["teamLabel"],
                "seat": actor_combatant["identity"]["seat"],
            },
            "decisionSource": decision_source,
            "stateBefore": state,
            "legalActions": legal_actions,
            "selectedAction": selected_action,
            "occurredAt": occurred_at,
        }
    )
    labels.append(
        {
            "schemaVersion": 1,
            "eventId": event_id,
            "battleId": battle_id,
            "decisionSequence": decision_sequence,
            "origin": origin,
            "mode": mode,
            "generatedAt": occurred_at,
            "result": {
                "config": {
                    "teacherVersion": "mcts-teacher-v1",
                    "utilityVersion": "pve-utility-v1",
                    "rollouts": 128,
                    "maxDepthPlies": 6,
                    "explorationConstant": 1.4142135623730951,
                    "rolloutPolicyVersion": "rule-based-v1",
                },
                "simulationSeed": 3_000_000 + decision_sequence,
                "stateSchemaVersion": 1,
                "selectedAction": selected_action,
                "candidates": candidates,
            },
        }
    )


# --- TRAIN: battle A -- 2 decisiones, candidato unico y par con distribucion soft ---
warrior = b.combatant("A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11)
goblin = b.combatant("B", 0, health=(30, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4))
attack_action = b.basic_attack_on("B", 0)
add_pair(
    f"decision:ONLINE:{TRAIN_BATTLE_A}:cmd-0",
    TRAIN_BATTLE_A,
    0,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=warrior,
    allies=[],
    enemies=[goblin],
    legal_actions=[attack_action],
    candidates=[
        {
            "action": attack_action,
            "actionIdentity": "",
            "visits": 128,
            "meanUtility": 0.58,
            "probability": 1.0,
        }
    ],
    selected_action=attack_action,
    occurred_at="2026-09-10T10:00:00.000Z",
)

storm_ability = b.ability(
    "ability-storm",
    power_cost=b.power_cost_fixed(6),
    charge_turns=1,
    effects=[b.attack_bonus(b.dice(3, 6)), b.damage_bonus(b.fixed(2))],
)
warrior_with_ability = b.combatant(
    "A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11, abilities=[storm_ability]
)
goblin_hurt = b.combatant(
    "B", 0, health=(22, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4)
)
ability_action = b.ability_action_on("ability-storm", "B", 0)
add_pair(
    f"decision:ONLINE:{TRAIN_BATTLE_A}:cmd-1",
    TRAIN_BATTLE_A,
    1,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=warrior_with_ability,
    allies=[],
    enemies=[goblin_hurt],
    legal_actions=[b.basic_attack_on("B", 0), ability_action],
    candidates=[
        {
            "action": b.basic_attack_on("B", 0),
            "actionIdentity": "",
            "visits": 40,
            "meanUtility": 0.55,
            "probability": 0.3125,
        },
        {
            "action": ability_action,
            "actionIdentity": "",
            "visits": 88,
            "meanUtility": 0.63,
            "probability": 0.6875,
        },
    ],
    selected_action=ability_action,
    occurred_at="2026-09-10T10:01:00.000Z",
    turns_completed=1,
)

# --- TRAIN: battle B -- 1 decision con 3 candidatos (ejercita Cmax=3 del batch) ---
epic = b.epic(
    "epic-overdrive",
    power_cost=0,
    cooldown_turns=3,
    cooldown_remaining=0,
    effects=[b.direct_damage(b.fixed(12))],
)
hero_with_epic = b.combatant(
    "A",
    0,
    health=(50, 50),
    power=(8, 8),
    attack=12,
    defense=10,
    abilities=[storm_ability],
    epic_=epic,
)
rival = b.combatant("B", 0, health=(50, 50), power=(8, 8), attack=12, defense=10)
epic_action = b.epic_action_on("epic-overdrive", "B", 0)
ability_action_b = b.ability_action_on("ability-storm", "B", 0)
add_pair(
    f"decision:ONLINE:{TRAIN_BATTLE_B}:cmd-0",
    TRAIN_BATTLE_B,
    0,
    origin="ONLINE",
    mode="PVP",
    actor_combatant=hero_with_epic,
    allies=[],
    enemies=[rival],
    legal_actions=[b.basic_attack_on("B", 0), ability_action_b, epic_action],
    candidates=[
        {
            "action": b.basic_attack_on("B", 0),
            "actionIdentity": "",
            "visits": 20,
            "meanUtility": 0.5,
            "probability": 0.16,
        },
        {
            "action": ability_action_b,
            "actionIdentity": "",
            "visits": 30,
            "meanUtility": 0.55,
            "probability": 0.23,
        },
        {
            "action": epic_action,
            "actionIdentity": "",
            "visits": 78,
            "meanUtility": 0.62,
            "probability": 0.61,
        },
    ],
    selected_action=epic_action,
    occurred_at="2026-09-11T12:00:00.000Z",
)

# --- VALIDATION: 2 decisiones, AMBAS multi-candidato ------------------------
# (Con decisiones de un solo candidato la loss queda fija en 0.0 para
# cualquier peso -- softmax de un unico logit siempre da probabilidad 1 --
# y el smoke no demuestra nada sobre el entrenamiento real. Validation
# necesita al menos una decision con distribucion no trivial.)
healer = b.combatant(
    "A",
    0,
    health=(40, 40),
    power=(10, 10),
    attack=None,
    damage=None,
    abilities=[
        b.ability(
            "ability-life-touch",
            power_cost=b.power_cost_fixed(3),
            effects=[b.heal_bonus(b.fixed(2))],
        ),
        b.ability(
            "ability-storm",
            power_cost=b.power_cost_fixed(6),
            charge_turns=1,
            effects=[b.attack_bonus(b.dice(3, 6)), b.damage_bonus(b.fixed(2))],
        ),
    ],
)
wounded_ally = b.combatant("A", 1, health=(10, 44))
enemy_v = b.combatant("B", 0, health=(30, 30))
heal_action = b.ability_action_on("ability-life-touch", "A", 1)
storm_action_v = b.ability_action_on("ability-storm", "B", 0)
add_pair(
    f"decision:ONLINE:{VALIDATION_BATTLE}:cmd-0",
    VALIDATION_BATTLE,
    0,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=healer,
    allies=[wounded_ally],
    enemies=[enemy_v],
    legal_actions=[heal_action, storm_action_v],
    candidates=[
        {
            "action": heal_action,
            "actionIdentity": "",
            "visits": 90,
            "meanUtility": 0.7,
            "probability": 0.7,
        },
        {
            "action": storm_action_v,
            "actionIdentity": "",
            "visits": 38,
            "meanUtility": 0.45,
            "probability": 0.3,
        },
    ],
    selected_action=heal_action,
    occurred_at="2026-09-12T09:00:00.000Z",
)
warrior_v2 = b.combatant(
    "A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11, abilities=[storm_ability]
)
goblin_v2 = b.combatant(
    "B", 0, health=(12, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4)
)
attack_action_v2 = b.basic_attack_on("B", 0)
ability_action_v2 = b.ability_action_on("ability-storm", "B", 0)
add_pair(
    f"decision:ONLINE:{VALIDATION_BATTLE}:cmd-1",
    VALIDATION_BATTLE,
    1,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=warrior_v2,
    allies=[],
    enemies=[goblin_v2],
    legal_actions=[attack_action_v2, ability_action_v2],
    candidates=[
        {
            "action": attack_action_v2,
            "actionIdentity": "",
            "visits": 98,
            "meanUtility": 0.82,
            "probability": 0.77,
        },
        {
            "action": ability_action_v2,
            "actionIdentity": "",
            "visits": 30,
            "meanUtility": 0.6,
            "probability": 0.23,
        },
    ],
    selected_action=attack_action_v2,
    occurred_at="2026-09-12T09:01:00.000Z",
    turns_completed=1,
)

# --- TEST: 2 decisiones -------------------------------------------------------
warrior_t = b.combatant("A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11)
goblin_t = b.combatant(
    "B", 0, health=(30, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4)
)
attack_action_t = b.basic_attack_on("B", 0)
add_pair(
    f"decision:ONLINE:{TEST_BATTLE}:cmd-0",
    TEST_BATTLE,
    0,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=warrior_t,
    allies=[],
    enemies=[goblin_t],
    legal_actions=[attack_action_t],
    candidates=[
        {
            "action": attack_action_t,
            "actionIdentity": "",
            "visits": 128,
            "meanUtility": 0.6,
            "probability": 1.0,
        }
    ],
    selected_action=attack_action_t,
    occurred_at="2026-09-13T11:00:00.000Z",
)
rival_t = b.combatant("A", 0, health=(50, 50), power=(8, 8), attack=12, defense=10, epic_=epic)
enemy_t2 = b.combatant("B", 0, health=(50, 50), power=(8, 8), attack=12, defense=10)
epic_action_t = b.epic_action_on("epic-overdrive", "B", 0)
add_pair(
    f"decision:ONLINE:{TEST_BATTLE}:cmd-1",
    TEST_BATTLE,
    1,
    origin="ONLINE",
    mode="PVP",
    actor_combatant=rival_t,
    allies=[],
    enemies=[enemy_t2],
    legal_actions=[b.basic_attack_on("B", 0), epic_action_t],
    candidates=[
        {
            "action": b.basic_attack_on("B", 0),
            "actionIdentity": "",
            "visits": 50,
            "meanUtility": 0.5,
            "probability": 0.39,
        },
        {
            "action": epic_action_t,
            "actionIdentity": "",
            "visits": 78,
            "meanUtility": 0.62,
            "probability": 0.61,
        },
    ],
    selected_action=epic_action_t,
    occurred_at="2026-09-13T11:01:00.000Z",
    turns_completed=1,
)

# --- Verificacion de splits antes de escribir -------------------------------
observed_splits = {bid: split_for_battle(bid) for bid in {e["battleId"] for e in events}}
assert observed_splits[TRAIN_BATTLE_A] == "TRAIN"
assert observed_splits[TRAIN_BATTLE_B] == "TRAIN"
assert observed_splits[VALIDATION_BATTLE] == "VALIDATION"
assert observed_splits[TEST_BATTLE] == "TEST"

out_dir = ROOT / "tests" / "fixtures" / "training"
out_dir.mkdir(parents=True, exist_ok=True)
with (out_dir / "decision-events.jsonl").open("w", encoding="utf-8", newline="\n") as f:
    for e in events:
        f.write(json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
with (out_dir / "teacher-labels.jsonl").open("w", encoding="utf-8", newline="\n") as f:
    for label in labels:
        f.write(json.dumps(label, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")

print(f"wrote {len(events)} events, {len(labels)} labels -> {out_dir}")
print(f"splits: {observed_splits}")
