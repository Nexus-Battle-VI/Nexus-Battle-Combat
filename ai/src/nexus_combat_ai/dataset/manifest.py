"""`dataset-manifest-v1` (#566 §48-§50, §80-§82): manifiesto reproducible.

Deliberadamente NO incluye ningun campo de "hora de ejecucion" (`generatedAt`
de verdad-ahora): eso romperia la reproducibilidad byte-a-byte exigida en
§81. `cutoff` SI aparece, pero es un parametro de entrada declarado por quien
construye el dataset, no un reloj de pared leido en el momento de correr.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MANIFEST_VERSION = "dataset-manifest-v1"


def canonical_json_bytes(obj: Any) -> bytes:
    """Serializacion canonica (#566 §82): claves ordenadas, separadores fijos,
    UTF-8, sin espacios, terminando SIN salto de linea final en el valor
    (el caller decide si agrega `\\n` al escribir una linea JSONL)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


@dataclass(frozen=True, slots=True)
class DatasetCounts:
    battles: int
    decisions: int
    candidates: int
    train_battles: int
    validation_battles: int
    test_battles: int
    train_decisions: int
    validation_decisions: int
    test_decisions: int

    def as_dict(self) -> dict[str, int]:
        return {
            "battles": self.battles,
            "decisions": self.decisions,
            "candidates": self.candidates,
            "trainBattles": self.train_battles,
            "validationBattles": self.validation_battles,
            "testBattles": self.test_battles,
            "trainDecisions": self.train_decisions,
            "validationDecisions": self.validation_decisions,
            "testDecisions": self.test_decisions,
        }


@dataclass(frozen=True, slots=True)
class DatasetExclusions:
    end_turn: int
    missing_label_expected: int
    missing_label_unexpected: int

    def as_dict(self) -> dict[str, int]:
        return {
            "endTurn": self.end_turn,
            "missingLabelExpected": self.missing_label_expected,
            "missingLabelUnexpected": self.missing_label_unexpected,
        }


def build_manifest(
    *,
    feature_schema_version: str,
    feature_dimension: int,
    decision_state_schema_version: int,
    teacher_version: str,
    utility_version: str,
    label_schema_version: str,
    split_strategy_version: str,
    cutoff: str,
    source_commit: str,
    dataset_seed: int,
    counts: DatasetCounts,
    exclusions: DatasetExclusions,
    input_fingerprint: str,
) -> dict[str, Any]:
    return {
        "manifestVersion": MANIFEST_VERSION,
        "featureSchemaVersion": feature_schema_version,
        "featureDimension": feature_dimension,
        "decisionStateSchemaVersion": decision_state_schema_version,
        "teacherVersion": teacher_version,
        "utilityVersion": utility_version,
        "labelSchemaVersion": label_schema_version,
        "splitStrategyVersion": split_strategy_version,
        "cutoff": cutoff,
        "sourceCommit": source_commit,
        "datasetSeed": dataset_seed,
        "counts": counts.as_dict(),
        "exclusions": exclusions.as_dict(),
        "inputFingerprint": input_fingerprint,
    }


def fingerprint_of(obj: Any) -> str:
    import hashlib

    return hashlib.sha256(canonical_json_bytes(obj)).hexdigest()
