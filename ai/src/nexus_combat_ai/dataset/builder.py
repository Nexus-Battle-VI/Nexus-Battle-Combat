"""Orquestacion reproducible del dataset logico (#566 objetivo tecnico): fuente
-> cutoff -> join -> `DecisionSample` -> split por `battleId` -> JSONL +
manifest. Comando OFFLINE puro (ver `cli/build_dataset.py`): nunca corre
dentro de un request HTTP/WS ni de `ExecuteAiTurn` (#566 §71).
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from nexus_combat_ai.contracts.decision_event import BATTLE_DECISION_STATE_SCHEMA_VERSION
from nexus_combat_ai.contracts.teacher_label import MCTS_TEACHER_V1_VERSION, UTILITY_VERSION_PVE_V1
from nexus_combat_ai.dataset.join import join_decisions_with_labels
from nexus_combat_ai.dataset.manifest import (
    DatasetCounts,
    DatasetExclusions,
    build_manifest,
    canonical_json_bytes,
    fingerprint_of,
)
from nexus_combat_ai.dataset.sample import DecisionSample, build_decision_sample
from nexus_combat_ai.dataset.source import DatasetSource
from nexus_combat_ai.dataset.split import SPLIT_STRATEGY_VERSION, Split, split_for_battle
from nexus_combat_ai.errors import DatasetBuildError
from nexus_combat_ai.features.schema import FEATURE_DIMENSION, FEATURE_SCHEMA_VERSION

_TEACHER_LABEL_FIXTURE_SCHEMA_VERSION = "teacher-label-fixture-v1"
_SPLIT_ORDER: tuple[Split, ...] = ("TRAIN", "VALIDATION", "TEST")


def parse_iso8601_utc(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise DatasetBuildError(f'Fecha ISO-8601 invalida: "{value}" ({error}).') from error
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class DatasetBuildConfig:
    cutoff: str  # ISO-8601 UTC, ej. "2026-10-05T00:00:00Z"
    source_commit: str
    seed: int
    output_dir: Path


@dataclass(frozen=True, slots=True)
class DatasetBuildResult:
    manifest: dict[str, object]
    output_fingerprint: str
    samples_by_split: dict[Split, tuple[DecisionSample, ...]]


def _derive_split_seed(seed: int, split: Split) -> int:
    digest = hashlib.sha256(f"{seed}:{split}".encode()).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False)


def _write_jsonl(path: Path, rows: Iterator[dict[str, object]]) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = b"".join(canonical_json_bytes(row) + b"\n" for row in rows)
    path.write_bytes(content)
    return content


def build_dataset(source: DatasetSource, config: DatasetBuildConfig) -> DatasetBuildResult:
    cutoff_dt = parse_iso8601_utc(config.cutoff)

    def before_cutoff(occurred_at: str) -> bool:
        return parse_iso8601_utc(occurred_at) <= cutoff_dt

    events = [e for e in source.decision_events() if before_cutoff(e.occurred_at)]
    labels = list(source.teacher_labels())

    joined, join_stats = join_decisions_with_labels(events, labels)
    samples = [build_decision_sample(jd) for jd in joined]

    # Orden canonico ESTABLE, independiente del orden de la fuente (#566 §70):
    # el fingerprint de entrada y el reparto en splits parten SIEMPRE de este
    # orden, nunca del orden en que Mongo/JSONL entrego los datos.
    samples.sort(key=lambda s: (s.battle_id, s.decision_sequence, s.event_id))

    input_fingerprint = fingerprint_of([s.to_jsonl_dict() for s in samples])

    by_split: dict[Split, list[DecisionSample]] = {"TRAIN": [], "VALIDATION": [], "TEST": []}
    for sample in samples:
        by_split[split_for_battle(sample.battle_id)].append(sample)

    for split in _SPLIT_ORDER:
        random.Random(_derive_split_seed(config.seed, split)).shuffle(by_split[split])

    written: dict[Split, bytes] = {}
    for split in _SPLIT_ORDER:
        path = config.output_dir / f"{split.lower()}.jsonl"
        written[split] = _write_jsonl(path, (s.to_jsonl_dict() for s in by_split[split]))

    def battles_of(split: Split) -> set[str]:
        return {s.battle_id for s in by_split[split]}

    counts = DatasetCounts(
        battles=len({s.battle_id for s in samples}),
        decisions=len(samples),
        candidates=sum(len(s.candidates) for s in samples),
        train_battles=len(battles_of("TRAIN")),
        validation_battles=len(battles_of("VALIDATION")),
        test_battles=len(battles_of("TEST")),
        train_decisions=len(by_split["TRAIN"]),
        validation_decisions=len(by_split["VALIDATION"]),
        test_decisions=len(by_split["TEST"]),
    )
    exclusions = DatasetExclusions(
        end_turn=join_stats.excluded_end_turn,
        missing_label=join_stats.missing_label,
    )

    manifest = build_manifest(
        feature_schema_version=FEATURE_SCHEMA_VERSION,
        feature_dimension=FEATURE_DIMENSION,
        decision_state_schema_version=BATTLE_DECISION_STATE_SCHEMA_VERSION,
        teacher_version=MCTS_TEACHER_V1_VERSION,
        utility_version=UTILITY_VERSION_PVE_V1,
        label_schema_version=_TEACHER_LABEL_FIXTURE_SCHEMA_VERSION,
        split_strategy_version=SPLIT_STRATEGY_VERSION,
        cutoff=config.cutoff,
        source_commit=config.source_commit,
        dataset_seed=config.seed,
        counts=counts,
        exclusions=exclusions,
        input_fingerprint=input_fingerprint,
    )

    output_core = canonical_json_bytes(manifest) + b"".join(
        written[split] for split in _SPLIT_ORDER
    )
    output_fingerprint = hashlib.sha256(output_core).hexdigest()
    manifest_with_output = {**manifest, "outputFingerprint": output_fingerprint}

    manifest_path = config.output_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_bytes(canonical_json_bytes(manifest_with_output))

    return DatasetBuildResult(
        manifest=manifest_with_output,
        output_fingerprint=output_fingerprint,
        samples_by_split={split: tuple(by_split[split]) for split in _SPLIT_ORDER},
    )
