"""`nexus-combat-train` (EN-036.3, Management #567 §60-61, §77, §112-114):
comando reproducible, offline, fail-closed. Consume EXACTAMENTE el frozen
dataset de `--dataset-dir` (producido por `nexus-combat-dataset build`,
#566) -- nunca vuelve a consultar Mongo, nunca re-construye el dataset
(#567 §21). V1 fija una sola configuracion (#567 §110): este CLI no expone
flags de hiperparametros, solo `--seed` (reproducibilidad) y la plomeria de
entrada/salida.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
from torch.utils.data import DataLoader

from nexus_combat_ai.dataset.pytorch_dataset import CombatDecisionDataset, collate_decision_samples
from nexus_combat_ai.errors import NexusCombatAiError, NonFiniteTrainingValueError
from nexus_combat_ai.export.onnx_exporter import (
    ONNX_OPSET_VERSION,
    export_candidate_scoring_mlp_to_onnx,
    validate_exported_onnx,
)
from nexus_combat_ai.features.encoder import FeatureEncoder
from nexus_combat_ai.features.schema import feature_schema_manifest
from nexus_combat_ai.model.candidate_mlp import MODEL_ARCHITECTURE_VERSION, CandidateScoringMLP
from nexus_combat_ai.training.artifacts import (
    ARTIFACT_PURPOSE_CANDIDATE,
    ARTIFACT_PURPOSE_SMOKE_TEST,
    METRICS_VERSION,
    build_training_manifest,
    canonical_model_state_sha256,
    file_sha256,
    write_canonical_json,
)
from nexus_combat_ai.training.config import TrainingConfig
from nexus_combat_ai.training.dataset_loader import load_frozen_dataset
from nexus_combat_ai.training.trainer import evaluate_model, train_model

_ARTIFACT_PURPOSES = (ARTIFACT_PURPOSE_SMOKE_TEST, ARTIFACT_PURPOSE_CANDIDATE)


def _default_source_commit() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    # CPU unicamente (#567 §30, §68): sin CUDA que sembrar.
    torch.use_deterministic_algorithms(True)


def _build_loader(
    samples: tuple[object, ...],
    encoder: FeatureEncoder,
    *,
    batch_size: int,
    shuffle: bool,
    num_workers: int,
    seed: int,
) -> DataLoader:
    dataset = CombatDecisionDataset(list(samples), encoder)
    generator = torch.Generator().manual_seed(seed) if shuffle else None
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        generator=generator,
        collate_fn=collate_decision_samples,
        num_workers=num_workers,
    )


def _run_id(dataset_output_fingerprint: str, training_config_sha256: str, seed: int) -> str:
    """Identidad determinista (#567 §55): el mismo experimento (mismo
    dataset + misma config + misma seed) siempre produce el mismo `run_id`,
    nunca un timestamp."""
    digest = hashlib.sha256(
        f"{dataset_output_fingerprint}:{training_config_sha256}:{seed}".encode()
    ).hexdigest()
    return f"{MODEL_ARCHITECTURE_VERSION}-{digest[:12]}"


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nexus-combat-train")
    parser.add_argument(
        "--dataset-dir",
        type=Path,
        required=True,
        help="Directorio con el frozen dataset de `nexus-combat-dataset build` (#566).",
    )
    parser.add_argument("--output", type=Path, required=True, help="Directorio base de artefactos.")
    parser.add_argument(
        "--source-commit",
        help="Commit del codigo que ejecuta el training (model/training/export). "
        "Si se omite, se intenta `git rev-parse HEAD`; si tampoco hay git, falla.",
    )
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument(
        "--emit-identity-only",
        action="store_true",
        help="Calcula y escribe en stdout {runId, trainingConfigSha256, "
        "datasetOutputFingerprint} como JSON, SIN entrenar (EN-037.2, "
        "Management #571): permite a un coordinador registrar TRAINING en "
        "el Model Registry de EN-037.1 ANTES de ejecutar PyTorch, "
        "reutilizando EXACTAMENTE el mismo calculo de identidad que el "
        "entrenamiento real (_run_id + TrainingConfig.fingerprint) en vez "
        "de duplicarlo en TypeScript.",
    )
    parser.add_argument(
        "--artifact-purpose",
        choices=_ARTIFACT_PURPOSES,
        default=ARTIFACT_PURPOSE_SMOKE_TEST,
        help="SMOKE_TEST (por defecto): demuestra la ingenieria, NO es un modelo de calidad "
        "evaluada. CANDIDATE: declaracion de quien ejecuta el comando de que entreno sobre "
        "datos reales suficientes (#567 §112-114, §149-150) -- el CLI NO verifica la "
        "procedencia del dataset por si mismo (un --dataset-dir sintetico pasa igual), asi "
        "que esto es una afirmacion del operador, no una garantia criptografica; EN-037 "
        "(model registry) tendra que validar procedencia real antes de promocionar. Nunca "
        "ACTIVE, eso tampoco es de este CLI.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    source_commit = args.source_commit or _default_source_commit()
    if not source_commit:
        parser.error(
            "No se pudo determinar trainingSourceCommit (sin --source-commit y sin "
            "`git rev-parse HEAD` disponible)."
        )
        return 2

    try:
        return _run(args, source_commit)
    except NexusCombatAiError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def _run(args: argparse.Namespace, source_commit: str) -> int:
    _seed_everything(args.seed)

    bundle = load_frozen_dataset(args.dataset_dir)
    config = TrainingConfig(seed=args.seed)
    training_config_sha256 = config.fingerprint()

    if args.emit_identity_only:
        dataset_output_fingerprint = bundle.manifest["outputFingerprint"]
        run_id = _run_id(dataset_output_fingerprint, training_config_sha256, args.seed)
        print(
            json.dumps(
                {
                    "runId": run_id,
                    "trainingConfigSha256": training_config_sha256,
                    "datasetOutputFingerprint": dataset_output_fingerprint,
                }
            )
        )
        return 0

    encoder = FeatureEncoder()
    train_loader = _build_loader(
        bundle.train,
        encoder,
        batch_size=config.batch_size,
        shuffle=True,
        num_workers=config.num_workers,
        seed=args.seed,
    )
    validation_loader = _build_loader(
        bundle.validation,
        encoder,
        batch_size=config.batch_size,
        shuffle=False,
        num_workers=config.num_workers,
        seed=args.seed,
    )
    test_loader = _build_loader(
        bundle.test,
        encoder,
        batch_size=config.batch_size,
        shuffle=False,
        num_workers=config.num_workers,
        seed=args.seed,
    )

    model = CandidateScoringMLP()
    result = train_model(model, train_loader, validation_loader, config)

    # TEST se evalua UNA sola vez, despues de entrenar y restaurar el best
    # checkpoint (#567 §77, §85): nunca antes, nunca por epoch.
    final_validation = evaluate_model(model, validation_loader)
    final_test = evaluate_model(model, test_loader)

    _require_finite_metrics(final_validation.as_dict(), "validation")
    _require_finite_metrics(final_test.as_dict(), "test")

    run_id = _run_id(bundle.manifest["outputFingerprint"], training_config_sha256, args.seed)
    run_dir = args.output / run_id
    if run_dir.exists():
        print(f'error: "{run_dir}" ya existe (sin --force; #567 §143).', file=sys.stderr)
        return 1

    # Directorio temporal DENTRO de `--output` (#567 §125): escritura atomica
    # via `Path.rename` al final solo funciona sin saltos entre unidades/
    # discos si el temporal ya vive en el mismo filesystem que el destino.
    args.output.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(dir=args.output))
    try:
        model_state_sha256 = canonical_model_state_sha256(model)

        pytorch_path = tmp_dir / "model.pt"
        torch.save(
            {
                "stateDict": model.state_dict(),
                "modelArchitectureVersion": MODEL_ARCHITECTURE_VERSION,
                "featureSchemaVersion": bundle.manifest["featureSchemaVersion"],
                "featureDimension": bundle.manifest["featureDimension"],
            },
            pytorch_path,
        )

        onnx_path = tmp_dir / "model.onnx"
        export_candidate_scoring_mlp_to_onnx(model, onnx_path)
        validate_exported_onnx(onnx_path)

        feature_schema_path = tmp_dir / "feature-schema.json"
        write_canonical_json(feature_schema_path, feature_schema_manifest())

        metrics = {
            "metricsVersion": METRICS_VERSION,
            "bestEpoch": result.best_epoch,
            "epochsRun": result.epochs_run,
            "stoppedEarly": result.stopped_early,
            "validation": final_validation.as_dict(),
            "test": final_test.as_dict(),
            "epochHistory": [epoch.as_dict() for epoch in result.epoch_history],
        }
        metrics_path = tmp_dir / "metrics.json"
        write_canonical_json(metrics_path, metrics)

        model_contract = {
            "inputName": "candidate_features",
            "inputDtype": "float32",
            "inputRank": 2,
            "featureDimension": bundle.manifest["featureDimension"],
            "candidateAxisDynamic": True,
            "outputName": "scores",
            "outputDtype": "float32",
            "outputRank": 1,
        }
        training_manifest = build_training_manifest(
            model_architecture_version=MODEL_ARCHITECTURE_VERSION,
            training_config=config.as_dict(),
            training_config_sha256=training_config_sha256,
            dataset_manifest=bundle.manifest,
            training_source_commit=source_commit,
            python_version=platform.python_version(),
            torch_version=torch.__version__,
            numpy_version=np.__version__,
            onnx_version=onnx.__version__,
            onnx_opset_version=ONNX_OPSET_VERSION,
            model_contract=model_contract,
            best_epoch=result.best_epoch,
            epochs_run=result.epochs_run,
            stopped_early=result.stopped_early,
            trainable_parameter_count=model.trainable_parameter_count(),
            model_state_sha256=model_state_sha256,
            pytorch_artifact_sha256=file_sha256(pytorch_path),
            onnx_artifact_sha256=file_sha256(onnx_path),
            metrics_file_sha256=file_sha256(metrics_path),
            artifact_purpose=args.artifact_purpose,
        )
        write_canonical_json(tmp_dir / "training-manifest.json", training_manifest)

        if run_dir.exists():
            raise NexusCombatAiError(
                f'"{run_dir}" ya existe (sin --force; #567 §143): otra ejecucion lo creo '
                "mientras este run preparaba sus artefactos."
            )
        tmp_dir.rename(run_dir)
    except BaseException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    for epoch_metrics in result.epoch_history:
        print(
            f"epoch={epoch_metrics.epoch} trainLoss={epoch_metrics.train_loss:.6f} "
            f"validationLoss={epoch_metrics.validation_loss:.6f} "
            f"validationTop1Agreement={epoch_metrics.validation_top1_agreement:.4f} "
            f"patienceCounter={epoch_metrics.patience_counter}",
            file=sys.stderr,
        )

    print(f"runId={run_id}", file=sys.stderr)
    print(f"datasetOutputFingerprint={bundle.manifest['outputFingerprint']}", file=sys.stderr)
    print(f"bestEpoch={result.best_epoch}", file=sys.stderr)
    print(f"epochsRun={result.epochs_run}", file=sys.stderr)
    print(f"stoppedEarly={result.stopped_early}", file=sys.stderr)
    print(f"validationLoss={final_validation.loss:.6f}", file=sys.stderr)
    print(f"validationTop1Agreement={final_validation.top1_agreement:.4f}", file=sys.stderr)
    print(f"testLoss={final_test.loss:.6f}", file=sys.stderr)
    print(f"testTop1Agreement={final_test.top1_agreement:.4f}", file=sys.stderr)
    print(f"modelStateSha256={model_state_sha256}", file=sys.stderr)
    print(f"onnxArtifactSha256={file_sha256(run_dir / 'model.onnx')}", file=sys.stderr)
    print(f"artifactDir={run_dir}", file=sys.stderr)

    return 0


def _require_finite_metrics(values: dict[str, object], split_name: str) -> None:
    for key, value in values.items():
        if isinstance(value, float) and not math.isfinite(value):
            raise NonFiniteTrainingValueError(f'Metrica no finita "{split_name}.{key}" = {value}.')


if __name__ == "__main__":
    raise SystemExit(main())
