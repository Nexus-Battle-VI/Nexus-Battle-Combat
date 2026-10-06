"""Script de UNA SOLA VEZ para generar tests/fixtures/{decision-events,teacher-labels}.jsonl.
No es parte del paquete publicado; se ejecuta manualmente y se borra despues.
Reutiliza los builders de test para garantizar que cada fixture es valida
contra los contratos reales (#566 §53)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from fixtures import builders as b  # noqa: E402

from nexus_combat_ai.contracts.decision_event import LegalAction  # noqa: E402

events: list[dict] = []
labels: list[dict] = []


def identity_of(action_json: dict) -> str:
    """Nunca a mano: la identidad real la calcula el mismo codigo de produccion
    (evita errores de conteo de longitud como los de `ActionIdentity.ts`)."""
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
    # Recalcula SIEMPRE actionIdentity desde el action real: nunca a mano.
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
            "schemaVersion": "teacher-label-fixture-v1",
            "eventId": event_id,
            "battleId": battle_id,
            "decisionSequence": decision_sequence,
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


# --- 1. Actor ofensivo + BASIC_ATTACK (JcE, ONLINE) -------------------------
warrior = b.combatant("A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11)
goblin = b.combatant("B", 0, health=(30, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4))
attack_action = b.basic_attack_on("B", 0)
add_pair(
    "decision:ONLINE:battle-0001:cmd-0",
    "battle-0001",
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
            "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
            "visits": 128,
            "meanUtility": 0.58,
            "probability": 1.0,
        }
    ],
    selected_action=attack_action,
    occurred_at="2026-09-01T10:00:00.000Z",
)

# --- 2. Candidato ABILITY (mismo battle-0001, siguiente decision) -----------
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
    "decision:ONLINE:battle-0001:cmd-1",
    "battle-0001",
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
            "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
            "visits": 40,
            "meanUtility": 0.55,
            "probability": 0.3125,
        },
        {
            "action": ability_action,
            "actionIdentity": "ABILITY|14:ability-storm|COMBATANT|1:B|0",
            "visits": 88,
            "meanUtility": 0.63,
            "probability": 0.6875,
        },
    ],
    selected_action=ability_action,
    occurred_at="2026-09-01T10:01:00.000Z",
    turns_completed=1,
)

# --- 3. Candidato EPIC (battle-0002, JcJ) -----------------------------------
epic = b.epic(
    "epic-overdrive",
    power_cost=0,
    cooldown_turns=3,
    cooldown_remaining=0,
    effects=[b.direct_damage(b.fixed(12))],
)
hero_with_epic = b.combatant(
    "A", 0, health=(50, 50), power=(8, 8), attack=12, defense=10, epic_=epic
)
rival = b.combatant("B", 0, health=(50, 50), power=(8, 8), attack=12, defense=10)
epic_action = b.epic_action_on("epic-overdrive", "B", 0)
add_pair(
    "decision:ONLINE:battle-0002:cmd-0",
    "battle-0002",
    0,
    origin="ONLINE",
    mode="PVP",
    actor_combatant=hero_with_epic,
    allies=[],
    enemies=[rival],
    legal_actions=[b.basic_attack_on("B", 0), epic_action],
    candidates=[
        {
            "action": b.basic_attack_on("B", 0),
            "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
            "visits": 50,
            "meanUtility": 0.5,
            "probability": 0.39,
        },
        {
            "action": epic_action,
            "actionIdentity": "EPIC|15:epic-overdrive|COMBATANT|1:B|0",
            "visits": 78,
            "meanUtility": 0.62,
            "probability": 0.61,
        },
    ],
    selected_action=epic_action,
    occurred_at="2026-09-02T12:00:00.000Z",
)

# --- 4. Soporte/curacion (battle-0003) --------------------------------------
heal_ability = b.ability(
    "ability-life-touch", power_cost=b.power_cost_fixed(3), effects=[b.heal_bonus(b.fixed(2))]
)
healer = b.combatant(
    "A", 0, health=(40, 40), power=(10, 10), attack=None, damage=None, abilities=[heal_ability]
)
wounded_ally = b.combatant("A", 1, health=(10, 44))
enemy_b3 = b.combatant("B", 0, health=(30, 30))
heal_action = b.ability_action_on("ability-life-touch", "A", 1)
add_pair(
    "decision:ONLINE:battle-0003:cmd-0",
    "battle-0003",
    0,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=healer,
    allies=[wounded_ally],
    enemies=[enemy_b3],
    legal_actions=[heal_action],
    candidates=[
        {
            "action": heal_action,
            "actionIdentity": "ABILITY|19:ability-life-touch|COMBATANT|1:A|1",
            "visits": 128,
            "meanUtility": 0.7,
            "probability": 1.0,
        }
    ],
    selected_action=heal_action,
    occurred_at="2026-09-03T09:00:00.000Z",
)

# --- 5. Decision MISSION con candidate set ya restringido por rotacion ------
mission_actor = b.combatant(
    "A", 0, health=(44, 44), power=(10, 10), attack=10, defense=11, abilities=[storm_ability]
)
mission_enemy = b.combatant("B", 0, health=(30, 30))
mission_storm_action = b.ability_action_on("ability-storm", "B", 0)
add_pair(
    "decision:MISSION:battle-mission-0001:0",
    "battle-mission-0001",
    0,
    origin="MISSION",
    mode="PVE",
    actor_combatant=mission_actor,
    allies=[],
    enemies=[mission_enemy],
    # legalActions SI incluye BASIC_ATTACK (Combat lo permite), pero la
    # rotacion de Mision restringe la raiz del teacher a solo la habilidad:
    # el label (candidates) NO debe incluir BASIC_ATTACK.
    legal_actions=[b.basic_attack_on("B", 0), mission_storm_action],
    candidates=[
        {
            "action": mission_storm_action,
            "actionIdentity": "ABILITY|14:ability-storm|COMBATANT|1:B|0",
            "visits": 128,
            "meanUtility": 0.6,
            "probability": 1.0,
        }
    ],
    selected_action=mission_storm_action,
    decision_source="MCTS",
    occurred_at="2026-09-04T08:00:00.000Z",
)

# --- 6/7: mas decisiones de battle-0001 (mismo battleId, distinto candidate count) --
warrior_full = b.combatant(
    "A", 0, health=(44, 44), power=(4, 10), attack=10, defense=11, abilities=[storm_ability]
)
goblin_near_dead = b.combatant(
    "B", 0, health=(2, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4)
)
final_attack = b.basic_attack_on("B", 0)
add_pair(
    "decision:ONLINE:battle-0001:cmd-2",
    "battle-0001",
    2,
    origin="ONLINE",
    mode="PVE",
    actor_combatant=warrior_full,
    allies=[],
    enemies=[goblin_near_dead],
    legal_actions=[final_attack, b.ability_action_on("ability-storm", "B", 0)],
    candidates=[
        {
            "action": final_attack,
            "actionIdentity": "BASIC_ATTACK|COMBATANT|1:B|0",
            "visits": 100,
            "meanUtility": 0.8,
            "probability": 0.78,
        },
        {
            "action": b.ability_action_on("ability-storm", "B", 0),
            "actionIdentity": "ABILITY|14:ability-storm|COMBATANT|1:B|0",
            "visits": 28,
            "meanUtility": 0.75,
            "probability": 0.22,
        },
    ],
    selected_action=final_attack,
    occurred_at="2026-09-01T10:02:00.000Z",
    turns_completed=2,
)

# --- Un END_TURN tecnico (excluido siempre del dataset) ---------------------
events.append(
    {
        "schemaVersion": 2,
        "eventType": "COMBAT_DECISION",
        "eventId": "decision:ONLINE:battle-0001:cmd-3",
        "battleId": "battle-0001",
        "decisionSequence": 3,
        "origin": "ONLINE",
        "mode": "PVE",
        "actor": {"teamLabel": "B", "seat": 0},
        "decisionSource": "SYSTEM",
        "stateBefore": b.state(
            battle_id="battle-0001",
            mode="PVE",
            round_=1,
            turns_completed=3,
            actor=goblin_near_dead,
            allies=[],
            enemies=[warrior_full],
        ),
        "legalActions": [],
        "selectedAction": {"kind": "END_TURN"},
        "occurredAt": "2026-09-01T10:03:00.000Z",
    }
)

out_dir = ROOT / "tests" / "fixtures"
out_dir.mkdir(parents=True, exist_ok=True)
with (out_dir / "decision-events.jsonl").open("w", encoding="utf-8", newline="\n") as f:
    for e in events:
        f.write(json.dumps(e, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
with (out_dir / "teacher-labels.jsonl").open("w", encoding="utf-8", newline="\n") as f:
    for label in labels:
        f.write(json.dumps(label, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")

print(f"wrote {len(events)} events, {len(labels)} labels")
