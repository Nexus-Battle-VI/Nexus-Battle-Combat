"""Join EXACTO `CombatDecisionEvent` <-> `TeacherLabelRecord` (#566 §14-§17).

Join key UNICA: `eventId` (el mismo identificador estable que ya usa
`CombatDecisionEvent`, ver `onlineDecisionEventId`/`missionDecisionEventId`
en `CombatDecisionEvent.ts`). Nunca timestamp aproximado, nunca "el primero/
el ultimo", nunca posicion de array.

Politica de ausencia (§16), dado el estado REAL auditado de Combat
(`develop@123e774`, sin wiring de produccion para teacher labels todavia):

- **END_TURN** (A: "decision que legitimamente no produce teacher label"):
  SIEMPRE excluido del dataset de candidate-scoring (§17), contado en
  `excluded_end_turn`. `END_TURN` no es una `LegalAction`.
- **Decision sin label, no END_TURN**: en el estado actual, NINGUNA decision
  de produccion tiene todavia un teacher label real (el wiring "labels en
  vivo" sigue sin implementar -- ver `TeacherLabelSourceNotAvailableError`).
  Exigir un label aqui seria inventar un requisito que el contrato vigente
  no impone; se cuenta como `missing_label` y la decision se excluye del
  dataset (no entra como ejemplo sin supervision). El dia que exista la
  persistencia real y el contrato garantice un label por decision, esta
  politica debe volverse estricta (fail closed) -- documentado aqui para
  que ese cambio sea deliberado, no un ajuste silencioso.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent
from nexus_combat_ai.contracts.teacher_label import TeacherLabelRecord
from nexus_combat_ai.errors import DuplicateTeacherLabelError


@dataclass(frozen=True, slots=True)
class JoinedDecision:
    event: CombatDecisionEvent
    label: TeacherLabelRecord


@dataclass(frozen=True, slots=True)
class JoinStats:
    total_decisions: int
    excluded_end_turn: int
    joined: int
    missing_label: int


def _index_labels_by_event_id(
    labels: Iterable[TeacherLabelRecord],
) -> dict[str, TeacherLabelRecord]:
    index: dict[str, TeacherLabelRecord] = {}
    for label in labels:
        if label.event_id in index:
            raise DuplicateTeacherLabelError(
                f'Existen al menos dos teacher labels para eventId="{label.event_id}". '
                "El join exige exactamente un label por decision."
            )
        index[label.event_id] = label
    return index


def join_decisions_with_labels(
    events: Iterable[CombatDecisionEvent],
    labels: Iterable[TeacherLabelRecord],
) -> tuple[list[JoinedDecision], JoinStats]:
    label_index = _index_labels_by_event_id(labels)

    total = 0
    excluded_end_turn = 0
    missing_label = 0
    joined: list[JoinedDecision] = []

    for event in events:
        total += 1
        if event.is_end_turn():
            excluded_end_turn += 1
            continue

        label = label_index.get(event.event_id)
        if label is None:
            missing_label += 1
            continue

        joined.append(JoinedDecision(event=event, label=label))

    stats = JoinStats(
        total_decisions=total,
        excluded_end_turn=excluded_end_turn,
        joined=len(joined),
        missing_label=missing_label,
    )
    return joined, stats
