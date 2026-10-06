"""`DatasetSource` (#566 §13): abstrae de donde vienen `CombatDecisionEvent` y
`TeacherLabelRecord`, para que `FeatureEncoder`/`builder.py` nunca conozcan
Mongo. Dos implementaciones:

- `JsonlDatasetSource`: fixtures/export JSONL deterministas (la unica fuente
  usada en tests).
- `MongoCombatDatasetSource`: lee `CombatDecisionEvent` REALES de la propia
  base de Combat (coleccion `combat-decision-events`, solo lectura, orden
  explicito por `battleId`+`decisionSequence`). `teacher_labels()` levanta
  `TeacherLabelSourceNotAvailableError`: no existe todavia esa persistencia
  en Combat (ver auditoria en `docs/en-036-ai-dataset-pipeline.md` y
  `errors.TeacherLabelSourceNotAvailableError`).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from nexus_combat_ai.contracts.decision_event import CombatDecisionEvent
from nexus_combat_ai.contracts.teacher_label import TeacherLabelRecord
from nexus_combat_ai.errors import DatasetBuildError, TeacherLabelSourceNotAvailableError

COMBAT_DECISION_EVENTS_COLLECTION = "combat-decision-events"
DEFAULT_COMBAT_DATABASE_NAME = "combat"


class DatasetSource(Protocol):
    def decision_events(self) -> Iterator[CombatDecisionEvent]: ...

    def teacher_labels(self) -> Iterator[TeacherLabelRecord]: ...


def _read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if stripped == "":
                continue
            try:
                yield json.loads(stripped)
            except json.JSONDecodeError as error:
                raise DatasetBuildError(
                    f"{path}:{line_number}: JSON invalido ({error})."
                ) from error


class JsonlDatasetSource:
    """Fuente determinista para tests/fixtures (#566 §13: "al menos una fuente
    determinista para tests"). `events_path`/`labels_path` son JSONL, una
    entrada por linea, con exactamente el mismo shape camelCase que Combat
    produce/produciria."""

    def __init__(self, events_path: Path | str, labels_path: Path | str) -> None:
        self._events_path = Path(events_path)
        self._labels_path = Path(labels_path)

    def decision_events(self) -> Iterator[CombatDecisionEvent]:
        for i, raw in enumerate(_read_jsonl(self._events_path)):
            yield CombatDecisionEvent.from_json(raw, f"{self._events_path.name}[{i}]")

    def teacher_labels(self) -> Iterator[TeacherLabelRecord]:
        for i, raw in enumerate(_read_jsonl(self._labels_path)):
            yield TeacherLabelRecord.from_json(raw, f"{self._labels_path.name}[{i}]")


def _mongo_document_to_decision_event_json(document: dict[str, Any]) -> dict[str, Any]:
    """Adapta un documento Mongo real (`_id` en vez de `eventId`, `occurredAt`
    como `datetime` BSON) al mismo shape JSON camelCase que
    `CombatDecisionEvent.from_json` ya sabe parsear -- ningun otro modulo
    necesita saber que esto vino de Mongo."""
    payload = dict(document)
    event_id = payload.pop("_id")
    occurred_at = payload.get("occurredAt")
    if isinstance(occurred_at, datetime):
        as_utc = occurred_at if occurred_at.tzinfo is not None else occurred_at.replace(tzinfo=UTC)
        payload["occurredAt"] = as_utc.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return {"eventId": event_id, **payload}


class MongoCombatDatasetSource:
    """Lector READ-ONLY contra la base propia de Combat (`#566` §12, §69-§70):
    nunca inserta/actualiza/borra, nunca crea indices, y ordena explicitamente
    por `battleId` + `decisionSequence` (nunca el orden fisico de Mongo)."""

    def __init__(self, uri: str, database: str = DEFAULT_COMBAT_DATABASE_NAME) -> None:
        import pymongo  # import perezoso: no requerido si solo se usa JsonlDatasetSource

        self._client: pymongo.MongoClient = pymongo.MongoClient(uri)
        self._db = self._client[database]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> MongoCombatDatasetSource:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def decision_events(self) -> Iterator[CombatDecisionEvent]:
        collection = self._db[COMBAT_DECISION_EVENTS_COLLECTION]
        cursor = collection.find({"eventType": "COMBAT_DECISION"}).sort(
            [("battleId", 1), ("decisionSequence", 1)]
        )
        for document in cursor:
            raw = _mongo_document_to_decision_event_json(document)
            yield CombatDecisionEvent.from_json(raw, f"mongo:{COMBAT_DECISION_EVENTS_COLLECTION}")

    def teacher_labels(self) -> Iterator[TeacherLabelRecord]:
        raise TeacherLabelSourceNotAvailableError(
            "No existe persistencia real de teacher labels en Combat todavia "
            "(MctsTeacher.teach() nunca se invoca en produccion, sin puerto/"
            "repositorio/migracion/coleccion Mongo). Usa JsonlDatasetSource "
            "con fixtures mientras tanto -- ver docs/en-036-ai-dataset-pipeline.md."
        )
        yield  # pragma: no cover - nunca alcanzable; documenta la forma de generador.
