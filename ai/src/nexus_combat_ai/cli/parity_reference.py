"""`nexus-combat-parity-reference` (EN-036.5, Management #569 §86-98, §163):
genera `pytorch-parity-reference.json` a partir de un `model.pt` +
`training-manifest.json` YA producidos por `nexus-combat-train` (#567) --
esta herramienta SOLO LEE el checkpoint, nunca reentrena ni lo modifica
(#569 §96, §138-139).

Calcula los scores PyTorch reales sobre un conjunto FIJO de feature
vectors: los fixtures golden ya congelados por #566/#568
(`golden-basic-attack.json`, `golden-multi-candidate.json`), nunca vectores
aleatorios (#569 §89). El lado Node (#569) compara estos scores bit a bit
contra el MISMO `model.onnx` corrido por `onnxruntime-node` -- el runtime
REAL de produccion, sin agregar `onnxruntime` Python como dependencia
nueva (#569 §87, §162): esta herramienta nunca importa `onnxruntime`.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import torch

from nexus_combat_ai.contracts.decision_event import BattleDecisionState, LegalAction
from nexus_combat_ai.errors import NexusCombatAiError
from nexus_combat_ai.features.encoder import FeatureEncoder
from nexus_combat_ai.features.schema import FEATURE_DIMENSION, FEATURE_SCHEMA_VERSION
from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP
from nexus_combat_ai.training.artifacts import canonical_model_state_sha256, write_canonical_json

PARITY_REFERENCE_SCHEMA_VERSION = "pytorch-onnx-parity-v1"

_FIXTURES_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures"


class ParityReferenceModelMismatchError(NexusCombatAiError):
    """El `model.pt`/manifest cargados no son consistentes entre si (schema o hash)."""


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES_DIR / name).read_text(encoding="utf-8"))


def _golden_cases() -> list[tuple[str, BattleDecisionState, list[LegalAction]]]:
    """Casos FIJOS y versionados (#569 §89): los mismos fixtures golden que
    #566/#568 ya congelaron para la paridad del encoder, nunca vectores
    aleatorios sin semilla. `golden-multi-candidate` agrupa sus 3
    candidatos en UN solo caso (batch `[3,72]`), igual que
    `NeuralPolicy` los agrupa en una sola llamada real al runtime."""
    basic = _load_fixture("golden-basic-attack.json")
    multi = _load_fixture("golden-multi-candidate.json")

    multi_candidates = [
        LegalAction.from_json(entry["action"])
        for _name, entry in sorted(multi["candidates"].items())
    ]

    return [
        (
            "golden-basic-attack",
            BattleDecisionState.from_json(basic["state"]),
            [LegalAction.from_json(basic["candidate"])],
        ),
        (
            "golden-multi-candidate",
            BattleDecisionState.from_json(multi["state"]),
            multi_candidates,
        ),
    ]


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nexus-combat-parity-reference")
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        required=True,
        help="Directorio con model.pt y training-manifest.json de un run de nexus-combat-train "
        "(#567).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Ruta de salida para pytorch-parity-reference.json.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    try:
        return _run(args)
    except NexusCombatAiError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def _run(args: argparse.Namespace) -> int:
    manifest_path = args.artifact_dir / "training-manifest.json"
    pytorch_path = args.artifact_dir / "model.pt"

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if manifest["featureSchemaVersion"] != FEATURE_SCHEMA_VERSION:
        raise ParityReferenceModelMismatchError(
            f'featureSchemaVersion="{manifest["featureSchemaVersion"]}" en el manifest, '
            f'se esperaba "{FEATURE_SCHEMA_VERSION}" (el encoder instalado no coincide).'
        )
    if manifest["featureDimension"] != FEATURE_DIMENSION:
        raise ParityReferenceModelMismatchError(
            f"featureDimension={manifest['featureDimension']} en el manifest, "
            f"se esperaba {FEATURE_DIMENSION}."
        )

    checkpoint = torch.load(pytorch_path, weights_only=True)
    model = CandidateScoringMLP(input_dim=checkpoint["featureDimension"])
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    # #569 §95, PA-07: si el checkpoint cargado no es el que el manifest
    # describe, fallar ANTES de generar nada -- nunca una referencia que
    # "parece" corresponder al modelo por casualidad.
    actual_hash = canonical_model_state_sha256(model)
    if actual_hash != manifest["modelStateSha256"]:
        raise ParityReferenceModelMismatchError(
            f"modelStateSha256 real ({actual_hash}) no coincide con el manifest "
            f"({manifest['modelStateSha256']}): el checkpoint cargado no es el declarado "
            "por ese training run."
        )

    encoder = FeatureEncoder()
    cases: list[dict[str, Any]] = []

    for case_id, state, candidates in _golden_cases():
        features = np.stack([encoder.encode(state, candidate) for candidate in candidates])
        with torch.no_grad():
            scores = model(torch.from_numpy(features)).numpy()
        cases.append(
            {
                "caseId": case_id,
                "candidateFeatures": features.tolist(),
                "pytorchScores": scores.tolist(),
            }
        )

    reference = {
        "schemaVersion": PARITY_REFERENCE_SCHEMA_VERSION,
        "modelStateSha256": actual_hash,
        "onnxArtifactSha256": manifest["onnxArtifactSha256"],
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureDimension": FEATURE_DIMENSION,
        "cases": cases,
        # Diagnostico (#569 §135): NUNCA forma parte del fingerprint canonico
        # del resultado de evaluacion -- el lado Node no lo lee para comparar.
        "diagnostics": {
            "pythonVersion": platform.python_version(),
            "torchVersion": torch.__version__,
            "numpyVersion": np.__version__,
            "onnxVersion": onnx.__version__,
        },
    }

    write_canonical_json(args.output, reference)

    print(f"cases={len(cases)}", file=sys.stderr)
    print(f"modelStateSha256={actual_hash}", file=sys.stderr)
    print(f"onnxArtifactSha256={manifest['onnxArtifactSha256']}", file=sys.stderr)
    print(f"output={args.output}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
