"""`DatasetSource` (#566 §13): JSONL + adaptacion de documentos Mongo reales."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from nexus_combat_ai.dataset.source import (
    JsonlDatasetSource,
    _mongo_document_to_decision_event_json,
    _mongo_document_to_teacher_label_json,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_jsonl_source_reads_decision_events() -> None:
    source = JsonlDatasetSource(
        FIXTURES_DIR / "decision-events.jsonl", FIXTURES_DIR / "teacher-labels.jsonl"
    )
    events = list(source.decision_events())
    assert len(events) == 7
    assert all(e.event_id for e in events)


def test_jsonl_source_reads_teacher_labels() -> None:
    source = JsonlDatasetSource(
        FIXTURES_DIR / "decision-events.jsonl", FIXTURES_DIR / "teacher-labels.jsonl"
    )
    labels = list(source.teacher_labels())
    assert len(labels) == 6


def test_mongo_document_adapts_id_and_occurred_at() -> None:
    document = {
        "_id": "decision:ONLINE:1:abc",
        "schemaVersion": 1,
        "eventType": "COMBAT_DECISION",
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "actor": {"teamLabel": "A", "seat": 0},
        "decisionSource": "RULE_BASED",
        "occurredAt": datetime(2026, 10, 6, 1, 2, 3, 456000, tzinfo=UTC),
    }
    adapted = _mongo_document_to_decision_event_json(document)
    assert adapted["eventId"] == "decision:ONLINE:1:abc"
    assert "_id" not in adapted
    assert adapted["occurredAt"] == "2026-10-06T01:02:03.456Z"


def test_mongo_document_adapts_teacher_label_id_and_generated_at() -> None:
    document = {
        "_id": "decision:ONLINE:1:abc",
        "schemaVersion": 1,
        "battleId": "battle-1",
        "decisionSequence": 0,
        "origin": "ONLINE",
        "mode": "PVE",
        "generatedAt": datetime(2026, 10, 6, 1, 2, 3, 456000, tzinfo=UTC),
        "result": {"placeholder": True},
    }
    adapted = _mongo_document_to_teacher_label_json(document)
    assert adapted["eventId"] == "decision:ONLINE:1:abc"
    assert "_id" not in adapted
    assert adapted["generatedAt"] == "2026-10-06T01:02:03.456Z"


def test_mongo_source_requires_pymongo_but_never_connects_until_used() -> None:
    pytest.importorskip("pymongo")
    from nexus_combat_ai.dataset.source import MongoCombatDatasetSource

    # pymongo.MongoClient no conecta hasta la primera operacion real: solo
    # construir la fuente (sin iterar) nunca debe fallar ni bloquear.
    source = MongoCombatDatasetSource("mongodb://localhost:1/does-not-matter")
    source.close()
