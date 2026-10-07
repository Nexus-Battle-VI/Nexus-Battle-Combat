"""`FrozenDatasetBundle` (EN-036.3, Management #567 §20-23, §61-64): lee el
snapshot que ya produjo `nexus-combat-dataset build` (#566). El trainer NUNCA
vuelve a consultar Mongo, cambiar el `cutoff`, repartir splits de nuevo o
re-etiquetar con MCTS (#567 §21) -- `--dataset-dir` es un directorio YA
congelado y este modulo se limita a leerlo, validarlo y FALLAR CERRADO ante
cualquier incompatibilidad o corrupcion (#567 §61-64), nunca a "arreglarlo"
en silencio.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from nexus_combat_ai.contracts.decision_event import BATTLE_DECISION_STATE_SCHEMA_VERSION
from nexus_combat_ai.contracts.teacher_label import (
    MCTS_TEACHER_LABEL_SCHEMA_VERSION,
    MCTS_TEACHER_V1_VERSION,
    UTILITY_VERSION_PVE_V1,
)
from nexus_combat_ai.dataset.manifest import MANIFEST_VERSION, canonical_json_bytes
from nexus_combat_ai.dataset.sample import DecisionSample, decision_sample_from_jsonl_dict
from nexus_combat_ai.dataset.split import SPLIT_STRATEGY_VERSION
from nexus_combat_ai.errors import DatasetNotTrainableError, IncompatibleTrainingDatasetError
from nexus_combat_ai.features.schema import FEATURE_DIMENSION, FEATURE_SCHEMA_VERSION

_SPLIT_FILES: tuple[str, ...] = ("train", "validation", "test")


@dataclass(frozen=True, slots=True)
class FrozenDatasetBundle:
    manifest: dict[str, object]
    train: tuple[DecisionSample, ...]
    validation: tuple[DecisionSample, ...]
    test: tuple[DecisionSample, ...]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise IncompatibleTrainingDatasetError(message)


def _read_samples(path: Path) -> tuple[DecisionSample, ...]:
    samples: list[DecisionSample] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if stripped == "":
                continue
            try:
                raw = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise IncompatibleTrainingDatasetError(
                    f"{path}:{line_number}: JSON invalido ({error})."
                ) from error
            samples.append(decision_sample_from_jsonl_dict(raw))
    return tuple(samples)


def load_frozen_dataset(dataset_dir: Path) -> FrozenDatasetBundle:
    manifest_path = dataset_dir / "manifest.json"
    if not dataset_dir.is_dir():
        raise IncompatibleTrainingDatasetError(f'"{dataset_dir}" no es un directorio.')
    if not manifest_path.is_file():
        raise IncompatibleTrainingDatasetError(f'Falta "{manifest_path}".')

    manifest_bytes = manifest_path.read_bytes()
    try:
        manifest = json.loads(manifest_bytes)
    except json.JSONDecodeError as error:
        raise IncompatibleTrainingDatasetError(f"manifest.json invalido ({error}).") from error

    _validate_manifest_schema(manifest)

    split_bytes: dict[str, bytes] = {}
    for split in _SPLIT_FILES:
        path = dataset_dir / f"{split}.jsonl"
        if not path.is_file():
            raise IncompatibleTrainingDatasetError(f'Falta "{path}".')
        split_bytes[split] = path.read_bytes()

    _verify_output_fingerprint(manifest, split_bytes)
    _verify_missing_labels(manifest)

    train = _read_samples(dataset_dir / "train.jsonl")
    validation = _read_samples(dataset_dir / "validation.jsonl")
    test = _read_samples(dataset_dir / "test.jsonl")

    if len(train) == 0:
        raise DatasetNotTrainableError('"train.jsonl" no tiene ninguna decision.')
    if len(validation) == 0:
        raise DatasetNotTrainableError('"validation.jsonl" no tiene ninguna decision.')
    if len(test) == 0:
        raise DatasetNotTrainableError('"test.jsonl" no tiene ninguna decision.')

    return FrozenDatasetBundle(manifest=manifest, train=train, validation=validation, test=test)


def _validate_manifest_schema(manifest: dict[str, object]) -> None:
    _require(
        manifest.get("manifestVersion") == MANIFEST_VERSION,
        f"manifestVersion desconocida: {manifest.get('manifestVersion')!r} "
        f"(se esperaba {MANIFEST_VERSION!r}).",
    )
    _require(
        manifest.get("featureSchemaVersion") == FEATURE_SCHEMA_VERSION,
        f"featureSchemaVersion desconocida: {manifest.get('featureSchemaVersion')!r} "
        f"(se esperaba {FEATURE_SCHEMA_VERSION!r}).",
    )
    _require(
        manifest.get("featureDimension") == FEATURE_DIMENSION,
        f"featureDimension incompatible: {manifest.get('featureDimension')!r} "
        f"(se esperaba {FEATURE_DIMENSION}).",
    )
    _require(
        manifest.get("decisionStateSchemaVersion") == BATTLE_DECISION_STATE_SCHEMA_VERSION,
        f"decisionStateSchemaVersion incompatible: "
        f"{manifest.get('decisionStateSchemaVersion')!r} "
        f"(se esperaba {BATTLE_DECISION_STATE_SCHEMA_VERSION}).",
    )
    _require(
        manifest.get("teacherVersion") == MCTS_TEACHER_V1_VERSION,
        f"teacherVersion desconocida: {manifest.get('teacherVersion')!r} "
        f"(se esperaba {MCTS_TEACHER_V1_VERSION!r}).",
    )
    _require(
        manifest.get("utilityVersion") == UTILITY_VERSION_PVE_V1,
        f"utilityVersion desconocida: {manifest.get('utilityVersion')!r} "
        f"(se esperaba {UTILITY_VERSION_PVE_V1!r}).",
    )
    _require(
        manifest.get("labelSchemaVersion") == str(MCTS_TEACHER_LABEL_SCHEMA_VERSION),
        f"labelSchemaVersion incompatible: {manifest.get('labelSchemaVersion')!r} "
        f"(se esperaba {MCTS_TEACHER_LABEL_SCHEMA_VERSION!r}).",
    )
    _require(
        manifest.get("splitStrategyVersion") == SPLIT_STRATEGY_VERSION,
        f"splitStrategyVersion desconocida: {manifest.get('splitStrategyVersion')!r} "
        f"(se esperaba {SPLIT_STRATEGY_VERSION!r}).",
    )
    _require(
        isinstance(manifest.get("outputFingerprint"), str) and manifest["outputFingerprint"] != "",
        "outputFingerprint ausente o vacio en manifest.json.",
    )
    _require(
        isinstance(manifest.get("sourceCommit"), str) and manifest["sourceCommit"] != "",
        "sourceCommit ausente o vacio en manifest.json.",
    )
    _require(
        isinstance(manifest.get("datasetSeed"), int),
        "datasetSeed ausente o invalido en manifest.json.",
    )


def _verify_output_fingerprint(manifest: dict[str, object], split_bytes: dict[str, bytes]) -> None:
    """Recalcula `outputFingerprint` con la MISMA logica que `builder.py`
    (#566) y compara contra lo declarado -- un dataset editado a mano (o
    corrompido en transito) FALLA aqui, nunca entrena en silencio (#567
    §63)."""
    claimed = manifest["outputFingerprint"]
    manifest_core = {k: v for k, v in manifest.items() if k != "outputFingerprint"}
    core_bytes = canonical_json_bytes(manifest_core) + b"".join(
        split_bytes[split] for split in _SPLIT_FILES
    )
    recomputed = hashlib.sha256(core_bytes).hexdigest()
    _require(
        recomputed == claimed,
        f"outputFingerprint no coincide con el contenido real del dataset "
        f"(declarado={claimed!r}, recalculado={recomputed!r}). El dataset fue alterado.",
    )


def _verify_missing_labels(manifest: dict[str, object]) -> None:
    exclusions = manifest.get("exclusions")
    if not isinstance(exclusions, dict):
        raise IncompatibleTrainingDatasetError('Falta "exclusions" en manifest.json.')
    missing_unexpected = exclusions.get("missingLabelUnexpected")
    _require(
        isinstance(missing_unexpected, int),
        "exclusions.missingLabelUnexpected ausente o invalido.",
    )
    if missing_unexpected > 0:
        raise IncompatibleTrainingDatasetError(
            f"exclusions.missingLabelUnexpected = {missing_unexpected} (> 0): el dataset "
            "tiene decisiones ONLINE/TOURNAMENT sin MctsTeacherLabel. #567 no entrena sobre "
            "un hueco de labels sin que quien construyo el dataset lo haya aceptado "
            "explicitamente (--allow-missing-labels en `nexus-combat-dataset build`)."
        )
