"""Join EXACTO `CombatDecisionEvent` <-> `MctsTeacherLabel` (#566 §14-§17, §30-§31,
correccion de alcance sobre PR#81).

Join key PRIMARIA: `eventId` (el mismo identificador estable que ya usa
`CombatDecisionEvent`, ver `onlineDecisionEventId`/`missionDecisionEventId`
en `CombatDecisionEvent.ts`). Nunca timestamp aproximado, nunca "el primero/
el ultimo", nunca posicion de array. Si `eventId` coincide pero
`battleId`/`decisionSequence` NO (join inconsistente), FAIL CLOSED (§30):
nunca se acepta un label con una relacion contradictoria con su propia
decision.

Politica de ausencia (§16, §31), ahora que el wiring real existe
(`LiveMctsTeacherLabeler`, EN-036.2 #566 correccion de alcance):

- **END_TURN** (A: "decision que legitimamente no produce teacher label"):
  SIEMPRE excluido del dataset de candidate-scoring (§17), contado en
  `excluded_end_turn`. `END_TURN` no es una `LegalAction`.
- **origin=MISSION sin label** (A tambien, pero por una razon ESTRUCTURAL
  distinta): `RunMissionSimulation` nunca tiene un `BattleRoom` PRE-ACCION
  que pasarle a `MctsTeacher.teach()` -- `MISSION` NUNCA produce labels con
  el engine actual, documentado y esperado, nunca un error. Contado en
  `missing_label_expected`.
- **origin=ONLINE/TOURNAMENT sin label** (B: "decision que DEBERIA tener
  label segun el contrato actual pero falta"): con el wiring real activo,
  estas decisiones SI deberian tener un `MctsTeacherLabel` (salvo
  `NoStrategicMctsCandidatesError`, indistinguible desde aqui de un fallo
  operativo real -- Python no puede ver POR QUE falta). Contado en
  `missing_label_unexpected`; por defecto (`allow_missing_labels=False`)
  hace fallar la construccion del dataset en vez de entrenar en silencio
  sobre datos incompletos (§31). `allow_missing_labels=True` lo permite
  explicitamente (p. ej. mientras `MCTS_LIVE_TEACHER_LABELING_ENABLED`
  estuvo apagado en produccion durante parte del periodo del dataset).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent
from nexus_combat_ai.contracts.teacher_label import MctsTeacherLabel
from nexus_combat_ai.errors import DuplicateTeacherLabelError, MissingTeacherLabelError


@dataclass(frozen=True, slots=True)
class JoinedDecision:
    event: CombatDecisionEvent
    label: MctsTeacherLabel


@dataclass(frozen=True, slots=True)
class JoinStats:
    total_decisions: int
    excluded_end_turn: int
    joined: int
    missing_label_expected: int
    missing_label_unexpected: int


def _index_labels_by_event_id(labels: Iterable[MctsTeacherLabel]) -> dict[str, MctsTeacherLabel]:
    index: dict[str, MctsTeacherLabel] = {}
    for label in labels:
        if label.event_id in index:
            raise DuplicateTeacherLabelError(
                f'Existen al menos dos teacher labels para eventId="{label.event_id}". '
                "El join exige exactamente un label por decision."
            )
        index[label.event_id] = label
    return index


def _require_consistent_join(event: CombatDecisionEvent, label: MctsTeacherLabel) -> None:
    if label.battle_id != event.battle_id or label.decision_sequence != event.decision_sequence:
        raise DuplicateTeacherLabelError(
            f'eventId="{event.event_id}" coincide, pero battleId/decisionSequence no: '
            f"evento=({event.battle_id!r}, {event.decision_sequence}), "
            f"label=({label.battle_id!r}, {label.decision_sequence}). Join inconsistente (§30)."
        )


def join_decisions_with_labels(
    events: Iterable[CombatDecisionEvent],
    labels: Iterable[MctsTeacherLabel],
    *,
    allow_missing_labels: bool = False,
) -> tuple[list[JoinedDecision], JoinStats]:
    label_index = _index_labels_by_event_id(labels)

    total = 0
    excluded_end_turn = 0
    missing_label_expected = 0
    missing_label_unexpected = 0
    joined: list[JoinedDecision] = []

    for event in events:
        total += 1
        if event.is_end_turn():
            excluded_end_turn += 1
            continue

        label = label_index.get(event.event_id)
        if label is None:
            if event.origin == "MISSION":
                missing_label_expected += 1
            else:
                missing_label_unexpected += 1
            continue

        _require_consistent_join(event, label)
        joined.append(JoinedDecision(event=event, label=label))

    if not allow_missing_labels and missing_label_unexpected > 0:
        raise MissingTeacherLabelError(
            f"{missing_label_unexpected} decision(es) ONLINE/TOURNAMENT sin MctsTeacherLabel "
            "(con el wiring real activo, la politica actual espera uno). Pasa "
            "allow_missing_labels=True (CLI: --allow-missing-labels) si es un hueco conocido "
            "(p. ej. periodo con MCTS_LIVE_TEACHER_LABELING_ENABLED apagado)."
        )

    stats = JoinStats(
        total_decisions=total,
        excluded_end_turn=excluded_end_turn,
        joined=len(joined),
        missing_label_expected=missing_label_expected,
        missing_label_unexpected=missing_label_unexpected,
    )
    return joined, stats
