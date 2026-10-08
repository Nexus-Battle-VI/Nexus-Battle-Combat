"""`nexus-combat-parity-reference` (EN-036.5, Management #569 §86-98).

Construye un `model.pt`/`training-manifest.json` REALES (mismo patron que
`tests/test_artifacts.py`: round-trip real por `torch.save`/`torch.load`,
nunca un mock de PyTorch) y corre la herramienta de punta a punta."""

from __future__ import annotations

import json
from pathlib import Path

import torch

from nexus_combat_ai.cli.parity_reference import (
    PARITY_REFERENCE_SCHEMA_VERSION,
    ParityReferenceModelMismatchError,
    main,
)
from nexus_combat_ai.features.schema import FEATURE_DIMENSION, FEATURE_SCHEMA_VERSION
from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP
from nexus_combat_ai.training.artifacts import canonical_model_state_sha256

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _write_real_artifact(tmp_path: Path, *, seed: int = 7) -> tuple[Path, str]:
    torch.manual_seed(seed)
    model = CandidateScoringMLP(input_dim=FEATURE_DIMENSION)
    model_state_sha256 = canonical_model_state_sha256(model)

    torch.save(
        {
            "stateDict": model.state_dict(),
            "modelArchitectureVersion": "candidate-mlp-v1",
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "featureDimension": FEATURE_DIMENSION,
        },
        tmp_path / "model.pt",
    )

    manifest = {
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureDimension": FEATURE_DIMENSION,
        "modelStateSha256": model_state_sha256,
        "onnxArtifactSha256": "fake-onnx-hash-for-test",
    }
    (tmp_path / "training-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    return tmp_path, model_state_sha256


def test_genera_una_referencia_real_con_los_4_vectores_golden(tmp_path: Path) -> None:
    artifact_dir, model_state_sha256 = _write_real_artifact(tmp_path)
    output = tmp_path / "pytorch-parity-reference.json"

    exit_code = main(["--artifact-dir", str(artifact_dir), "--output", str(output)])

    assert exit_code == 0
    reference = json.loads(output.read_text(encoding="utf-8"))

    assert reference["schemaVersion"] == PARITY_REFERENCE_SCHEMA_VERSION
    assert reference["modelStateSha256"] == model_state_sha256
    assert reference["onnxArtifactSha256"] == "fake-onnx-hash-for-test"
    assert reference["featureDimension"] == FEATURE_DIMENSION

    case_ids = {c["caseId"] for c in reference["cases"]}
    assert case_ids == {"golden-basic-attack", "golden-multi-candidate"}

    basic = next(c for c in reference["cases"] if c["caseId"] == "golden-basic-attack")
    assert len(basic["candidateFeatures"]) == 1
    assert len(basic["candidateFeatures"][0]) == FEATURE_DIMENSION
    assert len(basic["pytorchScores"]) == 1

    multi = next(c for c in reference["cases"] if c["caseId"] == "golden-multi-candidate")
    assert len(multi["candidateFeatures"]) == 3
    assert len(multi["pytorchScores"]) == 3


def test_es_determinista_para_el_mismo_checkpoint(tmp_path: Path) -> None:
    artifact_dir, _ = _write_real_artifact(tmp_path, seed=3)
    output_a = tmp_path / "a.json"
    output_b = tmp_path / "b.json"

    main(["--artifact-dir", str(artifact_dir), "--output", str(output_a)])
    main(["--artifact-dir", str(artifact_dir), "--output", str(output_b)])

    reference_a = json.loads(output_a.read_text(encoding="utf-8"))
    reference_b = json.loads(output_b.read_text(encoding="utf-8"))

    assert reference_a["cases"] == reference_b["cases"]


def test_pytorch_scores_coinciden_con_un_forward_directo_sobre_el_mismo_modelo(
    tmp_path: Path,
) -> None:
    """PA-01: la referencia debe reportar EXACTAMENTE lo que el modelo real
    calcula -- se recalcula aqui con un forward independiente y se compara."""
    artifact_dir, _ = _write_real_artifact(tmp_path, seed=11)
    output = tmp_path / "pytorch-parity-reference.json"
    main(["--artifact-dir", str(artifact_dir), "--output", str(output)])
    reference = json.loads(output.read_text(encoding="utf-8"))

    checkpoint = torch.load(artifact_dir / "model.pt", weights_only=True)
    model = CandidateScoringMLP(input_dim=checkpoint["featureDimension"])
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    for case in reference["cases"]:
        features = torch.tensor(case["candidateFeatures"], dtype=torch.float32)
        with torch.no_grad():
            expected = model(features).tolist()
        assert case["pytorchScores"] == expected


def test_rechaza_featureSchemaVersion_incompatible(tmp_path: Path) -> None:
    artifact_dir, _ = _write_real_artifact(tmp_path)
    manifest_path = artifact_dir / "training-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["featureSchemaVersion"] = "feature-schema-v2"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    exit_code = main(["--artifact-dir", str(artifact_dir), "--output", str(tmp_path / "out.json")])

    assert exit_code == 1


def test_rechaza_modelStateSha256_que_no_coincide_con_el_checkpoint_real(tmp_path: Path) -> None:
    """PA-07: un manifest manipulado (hash que no corresponde al checkpoint real) debe fallar."""
    artifact_dir, _ = _write_real_artifact(tmp_path)
    manifest_path = artifact_dir / "training-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["modelStateSha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    exit_code = main(["--artifact-dir", str(artifact_dir), "--output", str(tmp_path / "out.json")])

    assert exit_code == 1


def test_parity_reference_model_mismatch_error_es_un_nexus_combat_ai_error() -> None:
    from nexus_combat_ai.errors import NexusCombatAiError

    assert issubclass(ParityReferenceModelMismatchError, NexusCombatAiError)
