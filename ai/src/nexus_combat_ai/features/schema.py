"""`feature-schema-v1`: definicion CANONICA y versionada del vector que
`FeatureEncoder.encode(state, candidate)` produce (EN-036.2, #566 §20-§34,
§56, §88-§91).

Este modulo es la UNICA fuente de verdad del orden/nombre/significado de cada
posicion del vector. `#568` (NeuralPolicy en TypeScript/Node) debera
reproducir EXACTAMENTE esta misma definicion; por eso cada constante de
normalizacion/vocabulario vive aqui, nunca dispersa en `encoder.py`.

## Decisiones de diseno (auditadas contra `develop@123e774`)

- **Longitud variable (allies/enemies, abilities, effects): agregaciones, NO
  slots fijos** (#566 §25), salvo donde una invariancia REAL del dominio lo
  permite: `BattleState.ts` fija `MAX_PARTICIPANTS = 6`, asi que un lado
  (aliados o enemigos, EXCLUYENDO al actor) nunca excede `TEAM_CAP = 5`; se
  usa solo para acotar un contador normalizado, nunca para crear slots por
  combatiente.
- **Candidate-specific features, no per-slot** (#566 §26): el objetivo real
  de un candidato se resuelve dentro de `state` (actor/allies/enemies) y se
  describe con un bloque compacto (`candidate.target_*`), no repitiendo el
  vector completo de cada enemigo/aliado.
- **IDs nunca son features** (#566 §22): `battleId`, `eventId`, `abilityId`,
  `epicId`, `playerId`, etc. se usan solo para resolver semantica (buscar la
  habilidad referenciada dentro de `state.actor.abilities`) o como metadata
  de trazabilidad en `DecisionSample`, nunca como numero/hash alimentado al
  vector.
- **`heroSubtype` se omite deliberadamente en v1**: es un identificador de
  Catalog (`hero-subtypes-v1`) con un vocabulario que este paquete no ha
  auditado contra ese contrato; anadirlo sin verificar la taxonomia completa
  violaria la regla "vocabulario congelado" (#566 §31). Queda documentado
  como candidato a `feature-schema-v2`.
- **Categorias**: todo enum observado (`effect.kind`, `effect.target`,
  `effect.statistic`, `effect.operation`) se valida contra un vocabulario
  CONGELADO, auditado contra `SkillEffectPolicy.ts` (patrones INSTANT_STAT,
  TEMPORAL_STAT, INSTANT_HEAL/TEMPORAL_HEAL, DIRECT_DAMAGE, REFLECT_DAMAGE,
  IMMUNITY) + `REVIVE` (HEAL). Un valor fuera de ese vocabulario hace fallar
  `UnsupportedFeatureCategoryError` -- nunca se mapea al ultimo bucket.
"""

from __future__ import annotations

FEATURE_SCHEMA_VERSION = "feature-schema-v1"

DECISION_STATE_SCHEMA_VERSION_SUPPORTED = 1
"""Unica `BattleDecisionState.schemaVersion` que este schema sabe codificar."""

# --- Vocabularios congelados (auditados contra SkillEffectPolicy.ts) --------

BATTLE_MODE_VOCAB: tuple[str, ...] = ("PVP", "PVE")
ACTION_KIND_VOCAB: tuple[str, ...] = ("BASIC_ATTACK", "ABILITY", "EPIC")
TARGET_SCOPE_VOCAB: tuple[str, ...] = ("COMBATANT", "SELF", "ALLIED_GROUP")
TARGET_RELATION_VOCAB: tuple[str, ...] = ("SELF", "ALLY", "ENEMY")
MAGNITUDE_MODE_VOCAB: tuple[str, ...] = ("FIXED", "PERCENTAGE", "DICE")
POWER_COST_MODE_VOCAB: tuple[str, ...] = ("FIXED", "ALL_AVAILABLE")

EFFECT_KIND_VOCAB = frozenset({"STAT_MODIFIER", "DAMAGE", "REFLECT_DAMAGE", "IMMUNITY", "REVIVE"})
EFFECT_TARGET_VOCAB = frozenset({"SELF", "OPPONENT", "ALLY", "ALLIED_GROUP"})
EFFECT_STATISTIC_VOCAB = frozenset({"ATTACK", "DAMAGE", "DEFENSE", "HEALING"})
EFFECT_OPERATION_VOCAB = frozenset({"INCREASE", "DECREASE"})

# --- Constantes de normalizacion (documentadas, nunca "magicas" dispersas) --

ROUND_CAP = 50.0
TURNS_COMPLETED_CAP = 100.0
STAT_CAP = 100.0  # attack/defense normalizados por saturacion
MAGNITUDE_CAP = 50.0  # valor esperado de dano/sanacion/buff (profile.damage y effect.magnitude)
LEVEL_MIN = 1
LEVEL_MAX = 8
COOLDOWNS_COUNT_CAP = 10.0
ABILITIES_COUNT_CAP = 10.0
ACTIVE_EFFECTS_COUNT_CAP = 10.0
DAMAGE_MEMORY_CAP = 50.0
POWER_COST_CAP = 20.0  # costo de Poder de habilidad/epica
CHARGE_OR_COOLDOWN_CAP = 20.0  # chargeTurns/cooldownTurns, en turnos propios
EFFECT_COUNT_CAP = 10.0

TEAM_CAP = 5.0
"""`BattleState.ts` `MAX_PARTICIPANTS = 6`: el actor ocupa un puesto, asi que
NUNCA puede haber mas de 5 aliados ni mas de 5 enemigos en una cola real.
Normalizar por este tope NUNCA trunca una batalla valida."""


def clamp01(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def saturating_norm(value: float, cap: float) -> float:
    """`min(value, cap) / cap`, recortado a `[0,1]`. `cap` debe ser > 0."""
    if cap <= 0.0:
        raise ValueError("cap debe ser > 0")
    return clamp01(value / cap)


# --- Definicion ordenada del vector ------------------------------------------
# Cada entrada: (nombre, descripcion). El ORDEN es el indice real del vector;
# `FEATURE_DIMENSION = len(FEATURE_NAMES)` se deriva, nunca se hardcodea.

_STATE_FEATURES: tuple[tuple[str, str], ...] = (
    ("state.mode_pvp", "1.0 si BattleMode == PVP"),
    ("state.mode_pve", "1.0 si BattleMode == PVE"),
    ("state.round_norm", "saturating_norm(round, ROUND_CAP)"),
    ("state.turns_completed_norm", "saturating_norm(turnsCompleted, TURNS_COMPLETED_CAP)"),
)

_ACTOR_FEATURES: tuple[tuple[str, str], ...] = (
    ("actor.health_ratio", "currentHealth / maxHealth, clamp01 (REQUERIDO, fail closed si falta)"),
    ("actor.power_present", "1.0 si el actor tiene sistema de Poder"),
    ("actor.power_ratio", "currentPower / maxPower si presente, si no 0.0"),
    ("actor.attack_present", "1.0 si attack no es null (no es sanador)"),
    ("actor.attack_norm", "saturating_norm(attack, STAT_CAP) si presente, si no 0.0"),
    ("actor.defense_norm", "saturating_norm(defense, STAT_CAP)"),
    ("actor.damage_present", "1.0 si profile.damage no es null"),
    ("actor.damage_mode_fixed", "one-hot de profile.damage.mode"),
    ("actor.damage_mode_percentage", "one-hot de profile.damage.mode"),
    ("actor.damage_mode_dice", "one-hot de profile.damage.mode"),
    ("actor.damage_value_norm", "saturating_norm(expected_value(profile.damage), MAGNITUDE_CAP)"),
    ("actor.level_norm", "(level - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)"),
    ("actor.cooldowns_count_norm", "saturating_norm(len(cooldowns), COOLDOWNS_COUNT_CAP)"),
    ("actor.abilities_count_norm", "saturating_norm(len(abilities), ABILITIES_COUNT_CAP)"),
    ("actor.epic_present", "1.0 si el actor tiene epica equipada"),
    ("actor.epic_power_cost_norm", "saturating_norm(epic.powerCost, POWER_COST_CAP) si presente"),
    ("actor.epic_cooldown_ratio", "epic.cooldownRemaining / epic.cooldownTurns si presente"),
    (
        "actor.active_effects_count_norm",
        "saturating_norm(len(activeEffects), ACTIVE_EFFECTS_COUNT_CAP)",
    ),
    ("actor.damage_memory_present", "1.0 si damageMemory no es null"),
    ("actor.damage_memory_amount_norm", "saturating_norm(damageMemory.amount, DAMAGE_MEMORY_CAP)"),
)


def _group_features(prefix: str) -> tuple[tuple[str, str], ...]:
    return (
        (f"{prefix}.count_norm", "saturating_norm(len(group), TEAM_CAP)"),
        (f"{prefix}.alive_count_norm", "saturating_norm(#{healthRatio>0}, TEAM_CAP)"),
        (f"{prefix}.health_ratio_mean", "media de healthRatio del grupo (1.0 si vacio)"),
        (f"{prefix}.health_ratio_min", "minimo de healthRatio del grupo (1.0 si vacio)"),
        (
            f"{prefix}.power_presence_ratio",
            "fraccion del grupo con sistema de Poder (0.0 si vacio)",
        ),
        (
            f"{prefix}.power_ratio_mean",
            "media de powerRatio SOLO sobre quienes tienen Poder (0.0 si ninguno)",
        ),
        (
            f"{prefix}.attack_norm_mean",
            "media de attack_norm SOLO sobre quienes tienen Ataque (0.0 si ninguno)",
        ),
        (f"{prefix}.defense_norm_mean", "media de defense_norm del grupo (0.0 si vacio)"),
        (
            f"{prefix}.active_effects_count_mean_norm",
            "media de active_effects_count_norm del grupo (0.0 si vacio)",
        ),
    )


_ALLIES_FEATURES = _group_features("allies")
_ENEMIES_FEATURES = _group_features("enemies")

_CANDIDATE_FEATURES: tuple[tuple[str, str], ...] = (
    ("candidate.kind_basic_attack", "one-hot de candidate.kind"),
    ("candidate.kind_ability", "one-hot de candidate.kind"),
    ("candidate.kind_epic", "one-hot de candidate.kind"),
    ("candidate.target_scope_combatant", "one-hot de candidate.target.scope"),
    ("candidate.target_scope_self", "one-hot de candidate.target.scope"),
    ("candidate.target_scope_allied_group", "one-hot de candidate.target.scope"),
    ("candidate.target_relation_self", "one-hot: el objetivo resuelto es el propio actor"),
    (
        "candidate.target_relation_ally",
        "one-hot: el objetivo resuelto es un aliado (o el grupo aliado)",
    ),
    ("candidate.target_relation_enemy", "one-hot: el objetivo resuelto es un enemigo"),
    ("candidate.target_is_group", "1.0 si target.scope == ALLIED_GROUP"),
    (
        "candidate.target_health_ratio",
        "healthRatio del objetivo resuelto (media del grupo si ALLIED_GROUP)",
    ),
    ("candidate.target_power_present", "1.0 si el objetivo resuelto tiene sistema de Poder"),
    ("candidate.target_power_ratio", "powerRatio del objetivo resuelto si presente, si no 0.0"),
    ("candidate.target_is_alive", "1.0 si target_health_ratio > 0"),
    ("candidate.has_power_cost", "1.0 si candidate.kind in {ABILITY, EPIC}"),
    ("candidate.power_cost_mode_fixed", "one-hot del powerCost de la habilidad/epica referenciada"),
    (
        "candidate.power_cost_mode_all_available",
        "one-hot del powerCost de la habilidad/epica referenciada",
    ),
    (
        "candidate.power_cost_norm",
        "ver encoder: FIXED normalizado, ALL_AVAILABLE = actor.power_ratio",
    ),
    (
        "candidate.charge_or_cooldown_total_norm",
        "saturating_norm(chargeTurns|cooldownTurns, CHARGE_OR_COOLDOWN_CAP)",
    ),
    ("candidate.cooldown_ratio", "remainingOwnTurns / total (0.0 si no esta en cooldown)"),
    ("candidate.effect_count_norm", "saturating_norm(len(effects), EFFECT_COUNT_CAP)"),
    ("candidate.effect_has_healing", "1.0 si algun efecto tiene statistic == HEALING"),
    ("candidate.effect_has_damage", "1.0 si algun efecto es DAMAGE o statistic == DAMAGE"),
    (
        "candidate.effect_has_buff_self",
        "1.0 si algun efecto es target SELF + operation INCREASE (no HEALING)",
    ),
    (
        "candidate.effect_has_debuff_opponent",
        "1.0 si algun efecto es target OPPONENT + operation DECREASE",
    ),
    ("candidate.effect_has_immunity", "1.0 si algun efecto es kind IMMUNITY"),
    (
        "candidate.primary_effect_mode_fixed",
        "one-hot de la magnitud del PRIMER efecto (effects[0])",
    ),
    ("candidate.primary_effect_mode_percentage", "one-hot de la magnitud del PRIMER efecto"),
    ("candidate.primary_effect_mode_dice", "one-hot de la magnitud del PRIMER efecto"),
    (
        "candidate.primary_effect_value_norm",
        "saturating_norm(expected_value(effects[0].magnitude), MAGNITUDE_CAP)",
    ),
)

FEATURE_SPEC: tuple[tuple[str, str], ...] = (
    _STATE_FEATURES + _ACTOR_FEATURES + _ALLIES_FEATURES + _ENEMIES_FEATURES + _CANDIDATE_FEATURES
)

FEATURE_NAMES: tuple[str, ...] = tuple(name for name, _ in FEATURE_SPEC)
FEATURE_DIMENSION: int = len(FEATURE_NAMES)
FEATURE_INDEX: dict[str, int] = {name: i for i, name in enumerate(FEATURE_NAMES)}


def feature_schema_manifest() -> dict[str, object]:
    """Representacion humana/documentada de `feature-schema-v1` (#566 §88),
    pensada para servir de contrato a `#568` (NeuralPolicy TypeScript)."""
    return {
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "decisionStateSchemaVersionSupported": DECISION_STATE_SCHEMA_VERSION_SUPPORTED,
        "featureDimension": FEATURE_DIMENSION,
        "features": [
            {"index": i, "name": name, "description": description}
            for i, (name, description) in enumerate(FEATURE_SPEC)
        ],
        "normalization": {
            "roundCap": ROUND_CAP,
            "turnsCompletedCap": TURNS_COMPLETED_CAP,
            "statCap": STAT_CAP,
            "magnitudeCap": MAGNITUDE_CAP,
            "levelMin": LEVEL_MIN,
            "levelMax": LEVEL_MAX,
            "cooldownsCountCap": COOLDOWNS_COUNT_CAP,
            "abilitiesCountCap": ABILITIES_COUNT_CAP,
            "activeEffectsCountCap": ACTIVE_EFFECTS_COUNT_CAP,
            "damageMemoryCap": DAMAGE_MEMORY_CAP,
            "powerCostCap": POWER_COST_CAP,
            "chargeOrCooldownCap": CHARGE_OR_COOLDOWN_CAP,
            "effectCountCap": EFFECT_COUNT_CAP,
            "teamCap": TEAM_CAP,
        },
        "vocabularies": {
            "battleMode": list(BATTLE_MODE_VOCAB),
            "actionKind": list(ACTION_KIND_VOCAB),
            "targetScope": list(TARGET_SCOPE_VOCAB),
            "targetRelation": list(TARGET_RELATION_VOCAB),
            "magnitudeMode": list(MAGNITUDE_MODE_VOCAB),
            "powerCostMode": list(POWER_COST_MODE_VOCAB),
            "effectKind": sorted(EFFECT_KIND_VOCAB),
            "effectTarget": sorted(EFFECT_TARGET_VOCAB),
            "effectStatistic": sorted(EFFECT_STATISTIC_VOCAB),
            "effectOperation": sorted(EFFECT_OPERATION_VOCAB),
        },
        "omittedFromV1": [
            "heroSubtype (Catalog hero-subtypes-v1 no auditado; ver docstring del modulo)",
            "decisionSource / origin (metadata/provenance, nunca senal neuronal, #566 §60-63)",
            "cualquier identificador (battleId, eventId, abilityId, epicId, playerId): #566 §22",
        ],
    }
