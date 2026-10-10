"""`nexus-combat-train` end-to-end (EN-036.3, Management #567 §90-92, §143,
§160): dataset sintetico CONTROLADO -> CLI real -> artefactos reales."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nexus_combat_ai.cli.train_model import main
from nexus_combat_ai.dataset.builder import DatasetBuildConfig, build_dataset
from nexus_combat_ai.dataset.source import JsonlDatasetSource

FIXTURES = Path(__file__).parent / "fixtures" / "training"


def _frozen_dataset(tmp_path: Path, name: str = "frozen") -> Path:
    output = tmp_path / name
    source = JsonlDatasetSource(
        FIXTURES / "decision-events.jsonl", FIXTURES / "teacher-labels.jsonl"
    )
    config = DatasetBuildConfig(
        cutoff="2027-01-01T00:00:00Z",
        source_commit="test-source-commit",
        seed=42,
        output_dir=output,
    )
    build_dataset(source, config)
    return output


def test_full_pipeline_produces_all_artifacts(tmp_path: Path) -> None:
    dataset_dir = _frozen_dataset(tmp_path)
    artifacts_dir = tmp_path / "artifacts"

    exit_code = main(
        [
            "--dataset-dir",
            str(dataset_dir),
            "--output",
            str(artifacts_dir),
            "--source-commit",
            "training-code-commit",
            "--seed",
            "123",
        ]
    )
    assert exit_code == 0

    run_dirs = list(artifacts_dir.iterdir())
    assert len(run_dirs) == 1
    run_dir = run_dirs[0]

    for name in (
        "model.pt",
        "model.onnx",
        "training-manifest.json",
        "metrics.json",
        "feature-schema.json",
    ):
        path = run_dir / name
        assert path.is_file(), name
        assert path.stat().st_size > 0, name

    manifest = json.loads((run_dir / "training-manifest.json").read_bytes())
    assert manifest["trainingManifestVersion"] == "training-manifest-v1"
    assert manifest["modelArchitectureVersion"] == "candidate-mlp-v1"
    assert manifest["featureDimension"] == 72
    assert manifest["trainingConfig"]["optimizer"] == "AdamW"
    assert manifest["trainingConfig"]["learningRate"] == 0.001
    assert manifest["trainingConfig"]["batchSize"] == 256
    assert manifest["trainingConfig"]["maxEpochs"] == 30
    assert manifest["trainingConfig"]["earlyStoppingPatience"] == 5
    assert manifest["artifactPurpose"] == "SMOKE_TEST"
    assert manifest["onnxOpsetVersion"] == 18
    assert isinstance(manifest["modelStateSha256"], str) and manifest["modelStateSha256"] != ""
    assert manifest["bestEpoch"] >= 0
    assert manifest["epochsRun"] >= 1

    metrics = json.loads((run_dir / "metrics.json").read_bytes())
    assert metrics["metricsVersion"] == "training-metrics-v1"
    assert "generatedAt" not in metrics  # #567 §54: nada de reloj de pared
    assert len(metrics["epochHistory"]) == metrics["epochsRun"]
    for key in (
        "loss",
        "top1Agreement",
        "meanTeacherProbabilityOfSelection",
        "meanTeacherUtilityOfSelection",
    ):
        assert key in metrics["validation"]
        assert key in metrics["test"]


def test_emit_identity_only_matches_the_real_training_run_identity(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """EN-037.2 (#571): el coordinador llama `--emit-identity-only` ANTES de
    entrenar para registrar TRAINING en el Model Registry sin duplicar el
    calculo de identidad en TypeScript -- debe coincidir EXACTAMENTE con lo
    que produce el entrenamiento real para el mismo dataset/seed."""
    dataset_dir = _frozen_dataset(tmp_path)

    exit_code = main(
        [
            "--dataset-dir",
            str(dataset_dir),
            "--output",
            str(tmp_path / "unused"),
            "--source-commit",
            "c",
            "--seed",
            "55",
            "--emit-identity-only",
        ]
    )
    assert exit_code == 0
    identity = json.loads(capsys.readouterr().out)
    assert set(identity) == {"runId", "trainingConfigSha256", "datasetOutputFingerprint"}

    # `--emit-identity-only` nunca escribe nada en `--output`.
    assert not (tmp_path / "unused").exists()

    artifacts_dir = tmp_path / "artifacts"
    assert (
        main(
            [
                "--dataset-dir",
                str(dataset_dir),
                "--output",
                str(artifacts_dir),
                "--source-commit",
                "c",
                "--seed",
                "55",
            ]
        )
        == 0
    )
    run_dir = next(artifacts_dir.iterdir())
    manifest = json.loads((run_dir / "training-manifest.json").read_bytes())

    assert run_dir.name == identity["runId"]
    assert manifest["trainingConfigSha256"] == identity["trainingConfigSha256"]
    dataset_manifest = json.loads((dataset_dir / "manifest.json").read_bytes())
    assert dataset_manifest["outputFingerprint"] == identity["datasetOutputFingerprint"]


def test_artifact_purpose_can_be_marked_candidate(tmp_path: Path) -> None:
    dataset_dir = _frozen_dataset(tmp_path)
    artifacts_dir = tmp_path / "artifacts"

    exit_code = main(
        [
            "--dataset-dir",
            str(dataset_dir),
            "--output",
            str(artifacts_dir),
            "--source-commit",
            "c",
            "--seed",
            "1",
            "--artifact-purpose",
            "CANDIDATE",
        ]
    )
    assert exit_code == 0
    run_dir = next(artifacts_dir.iterdir())
    manifest = json.loads((run_dir / "training-manifest.json").read_bytes())
    assert manifest["artifactPurpose"] == "CANDIDATE"


def test_does_not_overwrite_an_existing_run_directory(tmp_path: Path) -> None:
    dataset_dir = _frozen_dataset(tmp_path)
    artifacts_dir = tmp_path / "artifacts"
    argv = [
        "--dataset-dir",
        str(dataset_dir),
        "--output",
        str(artifacts_dir),
        "--source-commit",
        "same-commit",
        "--seed",
        "7",
    ]

    assert main(argv) == 0
    run_dir = next(artifacts_dir.iterdir())
    before = sorted(p.name for p in run_dir.iterdir())

    # Mismo dataset + misma config + misma seed -> mismo run_id -> debe
    # fallar en vez de sobreescribir en silencio (#567 §143).
    assert main(argv) == 1
    assert sorted(p.name for p in run_dir.iterdir()) == before


def test_fails_closed_when_dataset_is_not_trainable(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dataset_dir = _frozen_dataset(tmp_path)
    (dataset_dir / "test.jsonl").write_bytes(b"")
    # Recalcular el fingerprint para aislar el caso "split vacio" del caso
    # "fingerprint alterado" (ambos deben fallar, pero por razones distintas).
    import hashlib

    from nexus_combat_ai.dataset.manifest import canonical_json_bytes

    manifest_path = dataset_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest_core = {k: v for k, v in manifest.items() if k != "outputFingerprint"}
    core_bytes = canonical_json_bytes(manifest_core) + b"".join(
        (dataset_dir / f"{split}.jsonl").read_bytes() for split in ("train", "validation", "test")
    )
    manifest["outputFingerprint"] = hashlib.sha256(core_bytes).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    exit_code = main(
        [
            "--dataset-dir",
            str(dataset_dir),
            "--output",
            str(tmp_path / "artifacts"),
            "--source-commit",
            "c",
            "--seed",
            "1",
        ]
    )
    assert exit_code == 1
    assert "error:" in capsys.readouterr().err


def test_reproducibility_same_inputs_produce_the_same_model_state_and_metrics(
    tmp_path: Path,
) -> None:
    """#567 §79, §86, §120: mismo dataset + misma config + misma seed debe
    producir el MISMO `modelStateSha256`, `bestEpoch`, `epochsRun` y
    metricas."""
    dataset_dir = _frozen_dataset(tmp_path)

    argv_a = [
        "--dataset-dir",
        str(dataset_dir),
        "--output",
        str(tmp_path / "run-a"),
        "--source-commit",
        "reproducible-commit",
        "--seed",
        "99",
    ]
    argv_b = [
        "--dataset-dir",
        str(dataset_dir),
        "--output",
        str(tmp_path / "run-b"),
        "--source-commit",
        "reproducible-commit",
        "--seed",
        "99",
    ]

    assert main(argv_a) == 0
    assert main(argv_b) == 0

    run_dir_a = next((tmp_path / "run-a").iterdir())
    run_dir_b = next((tmp_path / "run-b").iterdir())

    # Mismo dataset+config+seed -> mismo run_id determinista (#567 §55),
    # aunque esten en directorios base distintos.
    assert run_dir_a.name == run_dir_b.name

    manifest_a = json.loads((run_dir_a / "training-manifest.json").read_bytes())
    manifest_b = json.loads((run_dir_b / "training-manifest.json").read_bytes())

    assert manifest_a["modelStateSha256"] == manifest_b["modelStateSha256"]
    assert manifest_a["bestEpoch"] == manifest_b["bestEpoch"]
    assert manifest_a["epochsRun"] == manifest_b["epochsRun"]
    assert manifest_a["stoppedEarly"] == manifest_b["stoppedEarly"]
    assert manifest_a["trainingConfigSha256"] == manifest_b["trainingConfigSha256"]

    metrics_a = json.loads((run_dir_a / "metrics.json").read_bytes())
    metrics_b = json.loads((run_dir_b / "metrics.json").read_bytes())
    assert metrics_a["validation"] == metrics_b["validation"]
    assert metrics_a["test"] == metrics_b["test"]

    # #567 §80: se investigo de verdad (no se declaro sin probar) si el ONNX
    # crudo es byte-determinista. La primera version del exportador (con
    # `external_data=True`, el default de este torch) NO lo era; una vez
    # forzado `external_data=False` (ver `export/onnx_exporter.py`), si lo
    # es -- confirmado en el mismo proceso Y entre procesos frescos. Se
    # mantiene `modelStateSha256` como la autoridad primaria de todas formas
    # (#567 §41), pero esta igualdad ya no es una esperanza, es un hecho
    # verificado.
    assert manifest_a["onnxArtifactSha256"] == manifest_b["onnxArtifactSha256"]
