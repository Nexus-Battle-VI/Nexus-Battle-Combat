"""Regenera `tests/fixtures/golden-*.json` (#566 §90-§91): fija el vector
EXACTO que `FeatureEncoder` produce para un `state`+`candidate` de control.
`#568` (NeuralPolicy TypeScript) debe reproducir el mismo vector para el
mismo fixture -- por eso se guarda legible (dict `nombre -> valor`, no un
array posicional opaco)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from fixtures import builders as b  # noqa: E402

from nexus_combat_ai.contracts.decision_event import BattleDecisionState, LegalAction  # noqa: E402
from nexus_combat_ai.features.encoder import FeatureEncoder  # noqa: E402
from nexus_combat_ai.features.schema import FEATURE_NAMES  # noqa: E402

ENCODER = FeatureEncoder()


def encode_named(state_json: dict, candidate_json: dict) -> dict[str, float]:
    state = BattleDecisionState.from_json(state_json)
    candidate = LegalAction.from_json(candidate_json)
    vector = ENCODER.encode(state, candidate)
    return {name: float(value) for name, value in zip(FEATURE_NAMES, vector.tolist(), strict=True)}


out_dir = ROOT / "tests" / "fixtures"
out_dir.mkdir(parents=True, exist_ok=True)

# --- Golden 1: BASIC_ATTACK simple, un solo enemigo -------------------------
warrior = b.combatant(
    "A", 0, health=(33, 44), power=(6, 10), attack=10, defense=11, damage=b.dice(1, 6)
)
goblin = b.combatant("B", 0, health=(15, 30), power=None, attack=6, defense=5, damage=b.dice(1, 4))
state_1 = b.state(
    battle_id="golden-battle-1",
    mode="PVE",
    round_=2,
    turns_completed=3,
    actor=warrior,
    allies=[],
    enemies=[goblin],
)
candidate_1 = b.basic_attack_on("B", 0)

golden_1 = {
    "description": (
        "feature-schema-v1: BASIC_ATTACK de un guerrero (33/44 Vida, 6/10 Poder) "
        "contra un goblin (15/30 Vida, sin Poder). Un solo candidato, sin aliados."
    ),
    "featureSchemaVersion": "feature-schema-v1",
    "state": state_1,
    "candidate": candidate_1,
    "expectedFeatures": encode_named(state_1, candidate_1),
}
(out_dir / "golden-basic-attack.json").write_text(
    json.dumps(golden_1, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
)

# --- Golden 2: una decision con BASIC_ATTACK + ABILITY + EPIC ---------------
storm = b.ability(
    "ability-storm",
    power_cost=b.power_cost_fixed(6),
    charge_turns=1,
    effects=[b.attack_bonus(b.dice(3, 6)), b.damage_bonus(b.fixed(2))],
)
epic = b.epic(
    "epic-overdrive",
    power_cost=0,
    cooldown_turns=3,
    cooldown_remaining=1,
    effects=[b.direct_damage(b.fixed(12))],
)
hero = b.combatant(
    "A", 0, health=(50, 50), power=(8, 8), attack=12, defense=10, abilities=[storm], epic_=epic
)
rival = b.combatant("B", 0, health=(50, 50), power=(8, 8), attack=12, defense=10)
state_2 = b.state(
    battle_id="golden-battle-2",
    mode="PVP",
    round_=1,
    turns_completed=0,
    actor=hero,
    allies=[],
    enemies=[rival],
)

candidates_2 = {
    "basicAttack": b.basic_attack_on("B", 0),
    "ability": b.ability_action_on("ability-storm", "B", 0),
    "epic": b.epic_action_on("epic-overdrive", "B", 0),
}

golden_2 = {
    "description": (
        "feature-schema-v1: UNA decision con tres candidatos de kinds distintos "
        "(BASIC_ATTACK, ABILITY con STAT_MODIFIER de Ataque+Dano, EPIC con "
        "DIRECT_DAMAGE), mismo state, para validar alineacion candidate-a-candidate."
    ),
    "featureSchemaVersion": "feature-schema-v1",
    "state": state_2,
    "candidates": {
        name: {"action": action, "expectedFeatures": encode_named(state_2, action)}
        for name, action in candidates_2.items()
    },
}
(out_dir / "golden-multi-candidate.json").write_text(
    json.dumps(golden_2, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
)

print("wrote golden-basic-attack.json, golden-multi-candidate.json")
