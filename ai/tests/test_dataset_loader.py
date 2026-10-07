"""`FrozenDatasetBundle`/`load_frozen_dataset` (EN-036.3, Management #567
§61-64, §89)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from nexus_combat_ai.dataset.builder import DatasetBuildConfig, build_dataset
from nexus_combat_ai.dataset.manifest import canonical_json_bytes
from nexus_combat_ai.dataset.source import JsonlDatasetSource
from nexus_combat_ai.errors import DatasetNotTrainableError, IncompatibleTrainingDatasetError
from nexus_combat_ai.training.dataset_loader import load_frozen_dataset

FIXTURES = Path(__file__).parent / "fixtures" / "training"


def _rewrite_manifest_with_recomputed_fingerprint(
    dataset_dir: Path, manifest: dict[str, object]
) -> None:
    """Edita `manifest.json` reflejando el cambio EN el `outputFingerprint`
    tambien -- para aislar, en un test, el caso que se quiere probar (p. ej.
    "missingLabelUnexpected > 0") del caso "el fingerprint no coincide",
    que `load_frozen_dataset` valida primero."""
    manifest_core = {k: v for k, v in manifest.items() if k != "outputFingerprint"}
    core_bytes = canonical_json_bytes(manifest_core) + b"".join(
        (dataset_dir / f"{split}.jsonl").read_bytes() for split in ("train", "validation", "test")
    )
    manifest["outputFingerprint"] = hashlib.sha256(core_bytes).hexdigest()
    (dataset_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _build(tmp_path: Path, **overrides: object) -> Path:
    output = tmp_path / "frozen"
    source = JsonlDatasetSource(
        FIXTURES / "decision-events.jsonl", FIXTURES / "teacher-labels.jsonl"
    )
    config = DatasetBuildConfig(
        cutoff=overrides.get("cutoff", "2027-01-01T00:00:00Z"),
        source_commit=overrides.get("source_commit", "test-commit"),
        seed=overrides.get("seed", 42),
        output_dir=output,
    )
    build_dataset(source, config)
    return output


def test_loads_a_valid_frozen_dataset_with_all_splits_non_empty(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    bundle = load_frozen_dataset(dataset_dir)
    assert len(bundle.train) >= 1
    assert len(bundle.validation) >= 1
    assert len(bundle.test) >= 1


def test_rejects_unknown_manifest_version(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["manifestVersion"] = "dataset-manifest-v999"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(IncompatibleTrainingDatasetError):
        load_frozen_dataset(dataset_dir)


def test_rejects_wrong_feature_dimension(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["featureDimension"] = 999
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(IncompatibleTrainingDatasetError):
        load_frozen_dataset(dataset_dir)


def test_rejects_unknown_teacher_version(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["teacherVersion"] = "mcts-teacher-v999"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(IncompatibleTrainingDatasetError):
        load_frozen_dataset(dataset_dir)


def test_rejects_unknown_utility_version(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["utilityVersion"] = "pve-utility-v999"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(IncompatibleTrainingDatasetError):
        load_frozen_dataset(dataset_dir)


def test_rejects_altered_train_jsonl_via_fingerprint_mismatch(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    train_path = dataset_dir / "train.jsonl"
    # Un byte de diferencia (una decision extra copiada) ya invalida el
    # fingerprint, sin tocar manifest.json en absoluto (#567 §63).
    original = train_path.read_bytes()
    train_path.write_bytes(original + original[:1])

    with pytest.raises(IncompatibleTrainingDatasetError, match="outputFingerprint"):
        load_frozen_dataset(dataset_dir)


def test_rejects_dataset_with_missing_label_unexpected(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["exclusions"]["missingLabelUnexpected"] = 1
    _rewrite_manifest_with_recomputed_fingerprint(dataset_dir, manifest)

    with pytest.raises(IncompatibleTrainingDatasetError, match="missingLabelUnexpected"):
        load_frozen_dataset(dataset_dir)


def test_rejects_dataset_with_an_empty_split(tmp_path: Path) -> None:
    dataset_dir = _build(tmp_path)
    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    # Vaciar validation.jsonl rompe el fingerprint Y deja un split vacio;
    # recalcularlo aisla el caso "split vacio puro" del caso "fingerprint
    # alterado" (ambos deben fallar, pero por razones distintas).
    (dataset_dir / "validation.jsonl").write_bytes(b"")
    _rewrite_manifest_with_recomputed_fingerprint(dataset_dir, manifest)

    with pytest.raises(DatasetNotTrainableError):
        load_frozen_dataset(dataset_dir)


def test_rejects_nonexistent_directory(tmp_path: Path) -> None:
    with pytest.raises(IncompatibleTrainingDatasetError):
        load_frozen_dataset(tmp_path / "does-not-exist")
