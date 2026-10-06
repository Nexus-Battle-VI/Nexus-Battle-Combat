"""Espejo Python de `src/domain/decision/MctsTeacherResult.ts` (EN-036.1, #565),
mas el envoltorio de union con la decision real que #566 necesita para poder
leer un teacher label junto a su `CombatDecisionEvent`.

GAP AUDITADO (ver tambien `docs/en-036-ai-dataset-pipeline.md`): a 2026-10-06,
`develop@123e774` NO tiene ningun wiring de produccion que llame a
`MctsTeacher.teach()` ni ninguna persistencia (puerto, repositorio, migracion
o coleccion Mongo) para su resultado. `MctsTeacherResult` (TypeScript) tampoco
declara ningun campo de union (`eventId`/`battleId`/`decisionSequence`): la
decision "labels en vivo" formalizada en `MctsTeacher.ts` describe COMO deben
generarse esos labels en el futuro, pero no existe todavia el codigo que lo
haga.

Por tanto `TEACHER_LABEL_FIXTURE_SCHEMA_VERSION` ("teacher-label-fixture-v1")
NO es un contrato oficial de Combat: es el envoltorio de union que este
paquete define para sus propios fixtures/tests mientras esa pieza no exista.
Reutiliza exactamente los mismos join keys que `CombatDecisionEvent` ya
expone (`eventId`, o `battleId` + `decisionSequence`) para que, el dia que la
persistencia real exista, el unico cambio esperado en este modulo sea
reemplazar el origen de los datos -- nunca el join ni el feature schema.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from nexus_combat_ai.contracts._json_helpers import field as _field
from nexus_combat_ai.contracts._json_helpers import int_field as _int_field
from nexus_combat_ai.contracts._json_helpers import require as _require
from nexus_combat_ai.contracts._json_helpers import str_field as _str_field
from nexus_combat_ai.contracts.decision_event import LegalAction
from nexus_combat_ai.errors import IncompatibleSchemaError, InvalidTeacherLabelError

MCTS_TEACHER_V1_VERSION = "mcts-teacher-v1"
UTILITY_VERSION_PVE_V1 = "pve-utility-v1"
MCTS_TEACHER_STATE_SCHEMA_VERSION = 1

TEACHER_LABEL_FIXTURE_SCHEMA_VERSION = "teacher-label-fixture-v1"

_PROBABILITY_SUM_TOLERANCE = 1e-6


@dataclass(frozen=True, slots=True)
class MctsTeacherConfig:
    teacher_version: str
    utility_version: str
    rollouts: int
    max_depth_plies: int
    exploration_constant: float
    rollout_policy_version: str

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "config") -> MctsTeacherConfig:
        teacher_version = _str_field(obj, "teacherVersion", path)
        if teacher_version != MCTS_TEACHER_V1_VERSION:
            raise IncompatibleSchemaError(
                f'"{path}.teacherVersion" = "{teacher_version}" no soportada '
                f'(solo se soporta "{MCTS_TEACHER_V1_VERSION}").'
            )
        utility_version = _str_field(obj, "utilityVersion", path)
        if utility_version != UTILITY_VERSION_PVE_V1:
            raise IncompatibleSchemaError(
                f'"{path}.utilityVersion" = "{utility_version}" no soportada '
                f'(solo se soporta "{UTILITY_VERSION_PVE_V1}").'
            )
        return MctsTeacherConfig(
            teacher_version=teacher_version,
            utility_version=utility_version,
            rollouts=_int_field(obj, "rollouts", path),
            max_depth_plies=_int_field(obj, "maxDepthPlies", path),
            exploration_constant=float(_field(obj, "explorationConstant", path)),
            rollout_policy_version=_str_field(obj, "rolloutPolicyVersion", path),
        )


@dataclass(frozen=True, slots=True)
class MctsCandidateResult:
    action: LegalAction
    action_identity: str
    visits: int
    mean_utility: float
    probability: float

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "candidate") -> MctsCandidateResult:
        visits = _int_field(obj, "visits", path)
        _require(visits >= 0, f'"{path}.visits" debe ser >= 0.')
        mean_utility = float(_field(obj, "meanUtility", path))
        _require(
            _is_finite(mean_utility) and 0.0 <= mean_utility <= 1.0,
            f'"{path}.meanUtility" debe ser finito y estar en [0,1].',
        )
        probability = float(_field(obj, "probability", path))
        _require(
            _is_finite(probability) and 0.0 <= probability <= 1.0,
            f'"{path}.probability" debe ser finito y estar en [0,1].',
        )
        action_identity = _str_field(obj, "actionIdentity", path)
        action = LegalAction.from_json(_field(obj, "action", path), f"{path}.action")
        _require(
            action.identity() == action_identity,
            f'"{path}.actionIdentity" no coincide con la identidad real de "{path}.action".',
        )
        return MctsCandidateResult(
            action=action,
            action_identity=action_identity,
            visits=visits,
            mean_utility=mean_utility,
            probability=probability,
        )


def _is_finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


@dataclass(frozen=True, slots=True)
class MctsTeacherResult:
    """`MctsTeacherResult` (`MctsTeacherResult.ts`). Validado estrictamente (`#566` §18)."""

    config: MctsTeacherConfig
    simulation_seed: int
    state_schema_version: int
    selected_action: LegalAction
    candidates: tuple[MctsCandidateResult, ...]

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "teacherResult") -> MctsTeacherResult:
        state_schema_version = _int_field(obj, "stateSchemaVersion", path)
        if state_schema_version != MCTS_TEACHER_STATE_SCHEMA_VERSION:
            raise IncompatibleSchemaError(
                f'"{path}.stateSchemaVersion" = {state_schema_version} no soportado.'
            )
        candidates_raw = _field(obj, "candidates", path)
        _require(
            isinstance(candidates_raw, list) and len(candidates_raw) > 0,
            f'"{path}.candidates" no puede estar vacio.',
        )

        candidates = tuple(
            MctsCandidateResult.from_json(c, f"{path}.candidates[{i}]")
            for i, c in enumerate(candidates_raw)
        )

        identities = [c.action_identity for c in candidates]
        if len(set(identities)) != len(identities):
            raise InvalidTeacherLabelError(f'"{path}.candidates" tiene actionIdentity duplicada.')

        probability_sum = sum(c.probability for c in candidates)
        if abs(probability_sum - 1.0) > _PROBABILITY_SUM_TOLERANCE:
            raise InvalidTeacherLabelError(
                f'"{path}.candidates[].probability" suma {probability_sum}, se esperaba ~1.0.'
            )

        selected_action = LegalAction.from_json(
            _field(obj, "selectedAction", path), f"{path}.selectedAction"
        )
        selected_identity = selected_action.identity()
        matches = [c for c in candidates if c.action_identity == selected_identity]
        if len(matches) != 1:
            raise InvalidTeacherLabelError(
                f'"{path}.selectedAction" debe aparecer EXACTAMENTE una vez en "candidates" '
                f"(aparicio {len(matches)} veces)."
            )

        return MctsTeacherResult(
            config=MctsTeacherConfig.from_json(_field(obj, "config", path), f"{path}.config"),
            simulation_seed=_int_field(obj, "simulationSeed", path),
            state_schema_version=state_schema_version,
            selected_action=selected_action,
            candidates=candidates,
        )


@dataclass(frozen=True, slots=True)
class TeacherLabelRecord:
    """Envoltorio de union FIXTURE-ONLY (ver docstring del modulo): liga un
    `MctsTeacherResult` a la decision real mediante `event_id` (preferido) o
    `battle_id` + `decision_sequence`."""

    schema_version: str
    event_id: str
    battle_id: str
    decision_sequence: int
    result: MctsTeacherResult

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "teacherLabel") -> TeacherLabelRecord:
        schema_version = _str_field(obj, "schemaVersion", path)
        if schema_version != TEACHER_LABEL_FIXTURE_SCHEMA_VERSION:
            raise IncompatibleSchemaError(
                f'"{path}.schemaVersion" = "{schema_version}" no soportada '
                f'(solo se soporta "{TEACHER_LABEL_FIXTURE_SCHEMA_VERSION}").'
            )
        return TeacherLabelRecord(
            schema_version=schema_version,
            event_id=_str_field(obj, "eventId", path),
            battle_id=_str_field(obj, "battleId", path),
            decision_sequence=_int_field(obj, "decisionSequence", path),
            result=MctsTeacherResult.from_json(_field(obj, "result", path), f"{path}.result"),
        )
