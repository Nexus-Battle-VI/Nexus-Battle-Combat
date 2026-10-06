"""Espejo Python del contrato OFICIAL de teacher label en vivo (EN-036.1 #565 +
EN-036.2 #566, correccion de alcance sobre PR#81):

- `src/domain/decision/MctsTeacherResult.ts` (`MctsTeacherResult`, ya existia).
- `src/domain/decision/MctsTeacherLabel.ts` (`MctsTeacherLabel`, el envoltorio
  de union oficial: `schemaVersion`, `eventId`, `battleId`, `decisionSequence`,
  `origin`, `mode`, `result`, `generatedAt`).

Auditado en `develop` tras la correccion de alcance: `MctsTeacher.teach()`
ahora SI se invoca en produccion (`LiveMctsTeacherLabeler`, wired en
`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`ExecuteAiTurn`), y el resultado se
persiste append-only en la coleccion Mongo `mcts-teacher-labels`
(migracion `025-mcts-teacher-labels.ts`), ligado por `eventId` al
`CombatDecisionEvent` que lo origino. `MongoCombatDatasetSource.teacher_labels()`
lee esa coleccion real (ver `dataset/source.py`).

**Limitacion que sigue vigente**: el origen `MISSION` nunca produce un
`MctsTeacherLabel`, porque `RunMissionSimulation` resuelve la mision ENTERA
con `MissionSimulation.ts` (motor aproximado propio, sin `BattleRoom`) antes
de preparar su `CombatDecisionEvent` retroactivamente -- no existe ninguna
sala PRE-ACCION que pasarle a `MctsTeacher.teach()` con fidelidad. El dataset
contabiliza esas decisiones como `missingLabel`, nunca como un error (ver
`dataset/join.py`).
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

MCTS_TEACHER_LABEL_SCHEMA_VERSION = 1
"""`MCTS_TEACHER_LABEL_SCHEMA_VERSION` (`MctsTeacherLabel.ts`): entero, NO el
string `"teacher-label-fixture-v1"` que usaba la version anterior (fixture-only)
de este modulo, previa a la correccion de alcance sobre PR#81."""

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


_ORIGINS = frozenset(("ONLINE", "MISSION", "TOURNAMENT"))
_MODES = frozenset(("PVP", "PVE"))


@dataclass(frozen=True, slots=True)
class MctsTeacherLabel:
    """`MctsTeacherLabel` (`MctsTeacherLabel.ts`, contrato OFICIAL): liga un
    `MctsTeacherResult` a la decision real mediante `event_id` (join key
    primaria), con `battle_id`/`decision_sequence` redundantes para validar
    la relacion sin decodificar el `event_id` opaco."""

    schema_version: int
    event_id: str
    battle_id: str
    decision_sequence: int
    origin: str
    mode: str
    result: MctsTeacherResult
    generated_at: str

    @staticmethod
    def from_json(obj: dict[str, Any], path: str = "mctsTeacherLabel") -> MctsTeacherLabel:
        schema_version = _int_field(obj, "schemaVersion", path)
        if schema_version != MCTS_TEACHER_LABEL_SCHEMA_VERSION:
            raise IncompatibleSchemaError(
                f'"{path}.schemaVersion" = {schema_version} no soportada '
                f"(solo se soporta {MCTS_TEACHER_LABEL_SCHEMA_VERSION})."
            )
        origin = _str_field(obj, "origin", path)
        _require(origin in _ORIGINS, f'"{path}.origin" = "{origin}" no es un valor reconocido.')
        mode = _str_field(obj, "mode", path)
        _require(mode in _MODES, f'"{path}.mode" = "{mode}" no es un valor reconocido.')

        return MctsTeacherLabel(
            schema_version=schema_version,
            event_id=_str_field(obj, "eventId", path),
            battle_id=_str_field(obj, "battleId", path),
            decision_sequence=_int_field(obj, "decisionSequence", path),
            origin=origin,
            mode=mode,
            result=MctsTeacherResult.from_json(_field(obj, "result", path), f"{path}.result"),
            generated_at=_str_field(obj, "generatedAt", path),
        )
