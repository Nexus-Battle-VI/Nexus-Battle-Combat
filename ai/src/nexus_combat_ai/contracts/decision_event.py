"""Espejo Python, de solo lectura, de los contratos TypeScript reales de Combat:

- `src/domain/decision/BattleDecisionState.ts`
- `src/domain/decision/LegalAction.ts`
- `src/domain/decision/ActionIntent.ts`
- `src/domain/decision/CombatDecisionEvent.ts`

Auditados en `develop@123e774` (2026-10-06). Cada clase documenta el archivo y
los nombres de campo TS de los que proviene. Nunca se "mejora" el contrato
aqui: si Combat cambia, este modulo deja de parsear ese dato y falla
explicito (`IncompatibleSchemaError`), nunca intenta adivinar.

Los parsers (`from_json`) son estrictos: faltan campos, tipos incorrectos o
enums desconocidos levantan `ContractValidationError` -- nunca devuelven un
valor por defecto silencioso (regla `#566` secciones 54-56).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from nexus_combat_ai.contracts._json_helpers import (
    bool_field as _bool_field,
)
from nexus_combat_ai.contracts._json_helpers import (
    enum_field as _enum_field,
)
from nexus_combat_ai.contracts._json_helpers import (
    field as _field,
)
from nexus_combat_ai.contracts._json_helpers import (
    int_field as _int_field,
)
from nexus_combat_ai.contracts._json_helpers import (
    require as _require,
)
from nexus_combat_ai.contracts._json_helpers import (
    str_field as _str_field,
)
from nexus_combat_ai.errors import IncompatibleSchemaError

# --- CombatDecisionEvent.ts -------------------------------------------------

COMBAT_DECISION_EVENT_SCHEMA_VERSION = 1
COMBAT_END_TURN_DECISION_EVENT_SCHEMA_VERSION = 2
SUPPORTED_DECISION_EVENT_SCHEMA_VERSIONS = (
    COMBAT_DECISION_EVENT_SCHEMA_VERSION,
    COMBAT_END_TURN_DECISION_EVENT_SCHEMA_VERSION,
)

BATTLE_DECISION_STATE_SCHEMA_VERSION = 1

DecisionOrigin = Literal["ONLINE", "MISSION", "TOURNAMENT"]
_ORIGINS = frozenset(("ONLINE", "MISSION", "TOURNAMENT"))

DecisionSource = Literal["HUMAN", "RULE_BASED", "RANDOM", "MCTS", "NEURAL", "SYSTEM"]
_SOURCES = frozenset(("HUMAN", "RULE_BASED", "RANDOM", "MCTS", "NEURAL", "SYSTEM"))

BattleMode = Literal["PVP", "PVE"]
_MODES = frozenset(("PVP", "PVE"))

ParticipantKind = Literal["HUMAN", "AI"]
_PARTICIPANT_KINDS = frozenset(("HUMAN", "AI"))

MagnitudeMode = Literal["FIXED", "PERCENTAGE", "DICE"]
_MAGNITUDE_MODES = frozenset(("FIXED", "PERCENTAGE", "DICE"))

PowerCostMode = Literal["FIXED", "ALL_AVAILABLE"]
_POWER_COST_MODES = frozenset(("FIXED", "ALL_AVAILABLE"))

TargetScope = Literal["COMBATANT", "SELF", "ALLIED_GROUP"]
_TARGET_SCOPES = frozenset(("COMBATANT", "SELF", "ALLIED_GROUP"))

ActionKind = Literal["BASIC_ATTACK", "ABILITY", "EPIC"]
_ACTION_KINDS = frozenset(("BASIC_ATTACK", "ABILITY", "EPIC"))


@dataclass(frozen=True, slots=True)
class CombatantKey:
    """`CombatantKey` (`src/domain/entities/Combatant.ts`): `{ teamLabel, seat }`."""

    team_label: str
    seat: int

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "combatant") -> CombatantKey:
        return CombatantKey(
            team_label=_str_field(obj, "teamLabel", path),
            seat=_int_field(obj, "seat", path),
        )

    def identity(self) -> str:
        return f"{self.team_label}#{self.seat}"


@dataclass(frozen=True, slots=True)
class CombatMagnitude:
    """`CombatMagnitude` (`CombatProfile.ts`): discriminada por `mode`."""

    mode: MagnitudeMode
    amount: int | None = None
    basis_points: int | None = None
    count: int | None = None
    sides: int | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "magnitude") -> CombatMagnitude:
        mode = _enum_field(obj, "mode", path, _MAGNITUDE_MODES)
        if mode == "FIXED":
            return CombatMagnitude(mode=mode, amount=_int_field(obj, "amount", path))
        if mode == "PERCENTAGE":
            return CombatMagnitude(mode=mode, basis_points=_int_field(obj, "basisPoints", path))
        return CombatMagnitude(
            mode=mode,
            count=_int_field(obj, "count", path),
            sides=_int_field(obj, "sides", path),
        )

    def expected_value(self) -> float:
        """Valor esperado homogeneo usado solo para features (nunca para reglas de Combat)."""
        if self.mode == "FIXED":
            assert self.amount is not None
            return float(self.amount)
        if self.mode == "PERCENTAGE":
            assert self.basis_points is not None
            return self.basis_points / 100.0
        assert self.count is not None and self.sides is not None
        return self.count * (self.sides + 1) / 2.0


@dataclass(frozen=True, slots=True)
class CombatPowerCost:
    """`CombatPowerCost` (`CombatProfile.ts`)."""

    mode: PowerCostMode
    amount: int | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "powerCost") -> CombatPowerCost:
        mode = _enum_field(obj, "mode", path, _POWER_COST_MODES)
        if mode == "FIXED":
            return CombatPowerCost(mode=mode, amount=_int_field(obj, "amount", path))
        return CombatPowerCost(mode=mode)


@dataclass(frozen=True, slots=True)
class DecisionEffect:
    """`DecisionEffect` (`BattleDecisionState.ts`): semantica observable congelada."""

    kind: str
    target: str
    has_activation_condition: bool
    statistic: str | None = None
    operation: str | None = None
    magnitude: CombatMagnitude | None = None
    duration_turns: int | None = None
    immunity_code: str | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "effect") -> DecisionEffect:
        magnitude_raw = obj.get("magnitude")
        return DecisionEffect(
            kind=_str_field(obj, "kind", path),
            target=_str_field(obj, "target", path),
            has_activation_condition=_bool_field(obj, "hasActivationCondition", path),
            statistic=obj.get("statistic"),
            operation=obj.get("operation"),
            magnitude=None
            if magnitude_raw is None
            else CombatMagnitude.from_json(magnitude_raw, f"{path}.magnitude"),
            duration_turns=obj.get("durationTurns"),
            immunity_code=obj.get("immunityCode"),
        )


@dataclass(frozen=True, slots=True)
class DecisionCooldown:
    ability_id: str
    remaining_own_turns: int

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "cooldown") -> DecisionCooldown:
        return DecisionCooldown(
            ability_id=_str_field(obj, "abilityId", path),
            remaining_own_turns=_int_field(obj, "remainingOwnTurns", path),
        )


@dataclass(frozen=True, slots=True)
class DecisionAbility:
    ability_id: str
    power_cost: CombatPowerCost
    charge_turns: int
    effects: tuple[DecisionEffect, ...]

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "ability") -> DecisionAbility:
        effects_raw = _field(obj, "effects", path)
        _require(isinstance(effects_raw, list), f'"{path}.effects" debe ser una lista.')
        return DecisionAbility(
            ability_id=_str_field(obj, "abilityId", path),
            power_cost=CombatPowerCost.from_json(
                _field(obj, "powerCost", path), f"{path}.powerCost"
            ),
            charge_turns=_int_field(obj, "chargeTurns", path),
            effects=tuple(
                DecisionEffect.from_json(e, f"{path}.effects[{i}]")
                for i, e in enumerate(effects_raw)
            ),
        )


@dataclass(frozen=True, slots=True)
class DecisionEpic:
    epic_id: str
    power_cost: int
    cooldown_turns: int
    cooldown_remaining: int
    effects: tuple[DecisionEffect, ...]

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "epic") -> DecisionEpic:
        effects_raw = _field(obj, "effects", path)
        _require(isinstance(effects_raw, list), f'"{path}.effects" debe ser una lista.')
        return DecisionEpic(
            epic_id=_str_field(obj, "epicId", path),
            power_cost=_int_field(obj, "powerCost", path),
            cooldown_turns=_int_field(obj, "cooldownTurns", path),
            cooldown_remaining=_int_field(obj, "cooldownRemaining", path),
            effects=tuple(
                DecisionEffect.from_json(e, f"{path}.effects[{i}]")
                for i, e in enumerate(effects_raw)
            ),
        )


@dataclass(frozen=True, slots=True)
class DecisionActiveEffect:
    """`DecisionActiveEffect` (`BattleDecisionState.ts`): union `STAT` | `IMMUNITY`."""

    kind: Literal["STAT", "IMMUNITY"]
    source_ability_id: str
    source_combatant: CombatantKey
    remaining_own_turns: int
    statistic: str | None = None
    operation: str | None = None
    amount: float | None = None
    immunity_code: str | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "activeEffect") -> DecisionActiveEffect:
        kind = _enum_field(obj, "kind", path, frozenset(("STAT", "IMMUNITY")))
        source_combatant = CombatantKey.from_json(
            _field(obj, "sourceCombatant", path), f"{path}.sourceCombatant"
        )
        if kind == "STAT":
            return DecisionActiveEffect(
                kind="STAT",
                source_ability_id=_str_field(obj, "sourceAbilityId", path),
                source_combatant=source_combatant,
                remaining_own_turns=_int_field(obj, "remainingOwnTurns", path),
                statistic=_str_field(obj, "statistic", path),
                operation=_str_field(obj, "operation", path),
                amount=float(_field(obj, "amount", path)),
            )
        return DecisionActiveEffect(
            kind="IMMUNITY",
            source_ability_id=_str_field(obj, "sourceAbilityId", path),
            source_combatant=source_combatant,
            remaining_own_turns=_int_field(obj, "remainingOwnTurns", path),
            immunity_code=_str_field(obj, "immunityCode", path),
        )


@dataclass(frozen=True, slots=True)
class DamageMemory:
    amount: float
    remaining_own_turns: int

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "damageMemory") -> DamageMemory:
        return DamageMemory(
            amount=float(_field(obj, "amount", path)),
            remaining_own_turns=_int_field(obj, "remainingOwnTurns", path),
        )


@dataclass(frozen=True, slots=True)
class DecisionCombatant:
    """`DecisionCombatant` (`BattleDecisionState.ts`)."""

    identity: CombatantKey
    kind: ParticipantKind
    hero_subtype: str | None
    health: tuple[int, int] | None  # (current, max)
    power: tuple[int, int] | None  # (current, max)
    attack: int | None
    defense: int | None
    damage: CombatMagnitude | None
    level: int | None
    cooldowns: tuple[DecisionCooldown, ...]
    abilities: tuple[DecisionAbility, ...]
    epic: DecisionEpic | None
    active_effects: tuple[DecisionActiveEffect, ...]
    damage_memory: DamageMemory | None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "combatant") -> DecisionCombatant:
        kind = _enum_field(obj, "kind", path, _PARTICIPANT_KINDS)
        health_raw = obj.get("health")
        power_raw = obj.get("power")
        damage_raw = obj.get("damage")
        epic_raw = obj.get("epic")
        damage_memory_raw = obj.get("damageMemory")
        cooldowns_raw = _field(obj, "cooldowns", path)
        abilities_raw = _field(obj, "abilities", path)
        active_effects_raw = _field(obj, "activeEffects", path)
        _require(isinstance(cooldowns_raw, list), f'"{path}.cooldowns" debe ser una lista.')
        _require(isinstance(abilities_raw, list), f'"{path}.abilities" debe ser una lista.')
        _require(
            isinstance(active_effects_raw, list), f'"{path}.activeEffects" debe ser una lista.'
        )

        return DecisionCombatant(
            identity=CombatantKey.from_json(_field(obj, "identity", path), f"{path}.identity"),
            kind=kind,
            hero_subtype=obj.get("heroSubtype"),
            health=None
            if health_raw is None
            else (
                _int_field(health_raw, "current", f"{path}.health"),
                _int_field(health_raw, "max", f"{path}.health"),
            ),
            power=None
            if power_raw is None
            else (
                _int_field(power_raw, "current", f"{path}.power"),
                _int_field(power_raw, "max", f"{path}.power"),
            ),
            attack=obj.get("attack"),
            defense=obj.get("defense"),
            damage=None
            if damage_raw is None
            else CombatMagnitude.from_json(damage_raw, f"{path}.damage"),
            level=obj.get("level"),
            cooldowns=tuple(
                DecisionCooldown.from_json(c, f"{path}.cooldowns[{i}]")
                for i, c in enumerate(cooldowns_raw)
            ),
            abilities=tuple(
                DecisionAbility.from_json(a, f"{path}.abilities[{i}]")
                for i, a in enumerate(abilities_raw)
            ),
            epic=None if epic_raw is None else DecisionEpic.from_json(epic_raw, f"{path}.epic"),
            active_effects=tuple(
                DecisionActiveEffect.from_json(e, f"{path}.activeEffects[{i}]")
                for i, e in enumerate(active_effects_raw)
            ),
            damage_memory=None
            if damage_memory_raw is None
            else DamageMemory.from_json(damage_memory_raw, f"{path}.damageMemory"),
        )


@dataclass(frozen=True, slots=True)
class BattleDecisionStateContext:
    battle_id: str
    mode: BattleMode
    round: int
    turns_completed: int


@dataclass(frozen=True, slots=True)
class BattleDecisionState:
    """`BattleDecisionState` (`BattleDecisionState.ts`). Solo soporta `schemaVersion = 1`."""

    schema_version: int
    context: BattleDecisionStateContext
    actor: DecisionCombatant
    allies: tuple[DecisionCombatant, ...]
    enemies: tuple[DecisionCombatant, ...]

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "stateBefore") -> BattleDecisionState:
        schema_version = _int_field(obj, "schemaVersion", path)
        if schema_version != BATTLE_DECISION_STATE_SCHEMA_VERSION:
            raise IncompatibleSchemaError(
                f'"{path}.schemaVersion" = {schema_version} no soportado '
                f"(feature-schema-v1 solo soporta {BATTLE_DECISION_STATE_SCHEMA_VERSION})."
            )
        context_raw = _field(obj, "context", path)
        allies_raw = _field(obj, "allies", path)
        enemies_raw = _field(obj, "enemies", path)
        _require(isinstance(allies_raw, list), f'"{path}.allies" debe ser una lista.')
        _require(isinstance(enemies_raw, list), f'"{path}.enemies" debe ser una lista.')

        context = BattleDecisionStateContext(
            battle_id=_str_field(context_raw, "battleId", f"{path}.context"),
            mode=_enum_field(context_raw, "mode", f"{path}.context", _MODES),
            round=_int_field(context_raw, "round", f"{path}.context"),
            turns_completed=_int_field(context_raw, "turnsCompleted", f"{path}.context"),
        )
        return BattleDecisionState(
            schema_version=schema_version,
            context=context,
            actor=DecisionCombatant.from_json(_field(obj, "actor", path), f"{path}.actor"),
            allies=tuple(
                DecisionCombatant.from_json(a, f"{path}.allies[{i}]")
                for i, a in enumerate(allies_raw)
            ),
            enemies=tuple(
                DecisionCombatant.from_json(e, f"{path}.enemies[{i}]")
                for i, e in enumerate(enemies_raw)
            ),
        )


@dataclass(frozen=True, slots=True)
class DecisionActionTarget:
    """`DecisionActionTarget` (`LegalAction.ts`): union `COMBATANT` | `SELF` | `ALLIED_GROUP`."""

    scope: TargetScope
    combatant: CombatantKey | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "target") -> DecisionActionTarget:
        scope = _enum_field(obj, "scope", path, _TARGET_SCOPES)
        if scope == "COMBATANT":
            return DecisionActionTarget(
                scope=scope,
                combatant=CombatantKey.from_json(
                    _field(obj, "combatant", path), f"{path}.combatant"
                ),
            )
        return DecisionActionTarget(scope=scope)


@dataclass(frozen=True, slots=True)
class LegalAction:
    """`LegalAction` (`LegalAction.ts`) / `ActionIntent` (`ActionIntent.ts`): misma forma."""

    kind: ActionKind
    target: DecisionActionTarget
    ability_id: str | None = None
    epic_id: str | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "action") -> LegalAction:
        kind = _enum_field(obj, "kind", path, _ACTION_KINDS)
        target = DecisionActionTarget.from_json(_field(obj, "target", path), f"{path}.target")
        if kind == "ABILITY":
            return LegalAction(
                kind=kind, target=target, ability_id=_str_field(obj, "abilityId", path)
            )
        if kind == "EPIC":
            return LegalAction(kind=kind, target=target, epic_id=_str_field(obj, "epicId", path))
        return LegalAction(kind=kind, target=target)

    def identity(self) -> str:
        """Reimplementacion fiel de `legalActionIdentity` (`ActionIdentity.ts`)."""

        def part(value: str) -> str:
            return f"{len(value)}:{value}"

        def target_parts(target: DecisionActionTarget) -> list[str]:
            if target.scope == "COMBATANT":
                assert target.combatant is not None
                return ["COMBATANT", part(target.combatant.team_label), str(target.combatant.seat)]
            return [target.scope]

        if self.kind == "BASIC_ATTACK":
            return "|".join(["BASIC_ATTACK", *target_parts(self.target)])
        if self.kind == "ABILITY":
            assert self.ability_id is not None
            return "|".join(["ABILITY", part(self.ability_id), *target_parts(self.target)])
        assert self.epic_id is not None
        return "|".join(["EPIC", part(self.epic_id), *target_parts(self.target)])


@dataclass(frozen=True, slots=True)
class CombatDecisionSelection:
    """`CombatDecisionSelection` (`CombatDecisionEvent.ts`):
    `ActionIntent | { kind: 'END_TURN' }`."""

    is_end_turn: bool
    action: LegalAction | None = None

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "selectedAction") -> CombatDecisionSelection:
        kind = obj.get("kind")
        if kind == "END_TURN":
            return CombatDecisionSelection(is_end_turn=True)
        return CombatDecisionSelection(is_end_turn=False, action=LegalAction.from_json(obj, path))


@dataclass(frozen=True, slots=True)
class CombatDecisionEvent:
    """`CombatDecisionEvent` (`CombatDecisionEvent.ts`). Hecho append-only real."""

    schema_version: int
    event_id: str
    battle_id: str
    decision_sequence: int
    origin: DecisionOrigin
    mode: BattleMode
    actor: CombatantKey
    decision_source: DecisionSource
    state_before: BattleDecisionState
    legal_actions: tuple[LegalAction, ...]
    selected_action: CombatDecisionSelection
    occurred_at: str

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "decisionEvent") -> CombatDecisionEvent:
        schema_version = _int_field(obj, "schemaVersion", path)
        if schema_version not in SUPPORTED_DECISION_EVENT_SCHEMA_VERSIONS:
            raise IncompatibleSchemaError(
                f'"{path}.schemaVersion" = {schema_version} no soportado '
                f"(se soportan {SUPPORTED_DECISION_EVENT_SCHEMA_VERSIONS})."
            )
        event_type = _str_field(obj, "eventType", path)
        _require(event_type == "COMBAT_DECISION", f'"{path}.eventType" debe ser "COMBAT_DECISION".')

        legal_actions_raw = _field(obj, "legalActions", path)
        _require(isinstance(legal_actions_raw, list), f'"{path}.legalActions" debe ser una lista.')

        return CombatDecisionEvent(
            schema_version=schema_version,
            event_id=_str_field(obj, "eventId", path),
            battle_id=_str_field(obj, "battleId", path),
            decision_sequence=_int_field(obj, "decisionSequence", path),
            origin=_enum_field(obj, "origin", path, _ORIGINS),
            mode=_enum_field(obj, "mode", path, _MODES),
            actor=CombatantKey.from_json(_field(obj, "actor", path), f"{path}.actor"),
            decision_source=_enum_field(obj, "decisionSource", path, _SOURCES),
            state_before=BattleDecisionState.from_json(
                _field(obj, "stateBefore", path), f"{path}.stateBefore"
            ),
            legal_actions=tuple(
                LegalAction.from_json(a, f"{path}.legalActions[{i}]")
                for i, a in enumerate(legal_actions_raw)
            ),
            selected_action=CombatDecisionSelection.from_json(
                _field(obj, "selectedAction", path), f"{path}.selectedAction"
            ),
            occurred_at=_str_field(obj, "occurredAt", path),
        )

    def is_end_turn(self) -> bool:
        return self.selected_action.is_end_turn
