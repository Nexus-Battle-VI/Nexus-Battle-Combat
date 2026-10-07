"""Hashing y `training-manifest-v1` (EN-036.3, Management #567 §41, §52-56).

`model_state_sha256` es la autoridad de reproducibilidad (#567 §41, §80):
`torch.save()`/ONNX pueden variar en detalles de serializacion sin que el
grafo o los pesos cambien (ver `docs/en-036-neural-training.md`, seccion de
reproducibilidad, para la investigacion real hecha sobre esto). Por eso se
hashean los TENSORES crudos -- ordenados por nombre, con su dtype/shape/bytes
contiguos -- nunca el archivo `.pt` serializado completo."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import TYPE_CHECKING

from nexus_combat_ai.dataset.manifest import canonical_json_bytes

if TYPE_CHECKING:
    import torch

TRAINING_MANIFEST_VERSION = "training-manifest-v1"
METRICS_VERSION = "training-metrics-v1"

ARTIFACT_PURPOSE_SMOKE_TEST = "SMOKE_TEST"
ARTIFACT_PURPOSE_CANDIDATE = "CANDIDATE"


def canonical_model_state_sha256(model: torch.nn.Module) -> str:
    """SHA-256 de los parametros del modelo, ordenados por nombre (#567
    §41): mismo dataset + misma config + misma seed -> mismo hash, sin
    depender de como `torch.save()` decida serializar el objeto."""
    hasher = hashlib.sha256()
    state_dict = model.state_dict()
    for name in sorted(state_dict):
        tensor = state_dict[name].detach().to("cpu").contiguous()
        hasher.update(name.encode("utf-8"))
        hasher.update(str(tensor.dtype).encode("utf-8"))
        hasher.update(str(tuple(tensor.shape)).encode("utf-8"))
        hasher.update(tensor.numpy().tobytes())
    return hasher.hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_training_manifest(
    *,
    model_architecture_version: str,
    training_config: dict[str, object],
    training_config_sha256: str,
    dataset_manifest: dict[str, object],
    training_source_commit: str,
    python_version: str,
    torch_version: str,
    numpy_version: str,
    onnx_version: str,
    onnx_opset_version: int,
    model_contract: dict[str, object],
    best_epoch: int,
    epochs_run: int,
    stopped_early: bool,
    trainable_parameter_count: int,
    model_state_sha256: str,
    pytorch_artifact_sha256: str,
    onnx_artifact_sha256: str,
    metrics_file_sha256: str,
    artifact_purpose: str,
) -> dict[str, object]:
    """`training-manifest-v1` (#567 §53): acompaña siempre al artefacto.
    Reutiliza los campos del `dataset-manifest-v1` (#566) ya cargado en vez
    de volver a derivarlos (#567 §121-122: no tres implementaciones
    distintas del mismo dato)."""
    return {
        "trainingManifestVersion": TRAINING_MANIFEST_VERSION,
        "modelArchitectureVersion": model_architecture_version,
        "featureSchemaVersion": dataset_manifest["featureSchemaVersion"],
        "featureDimension": dataset_manifest["featureDimension"],
        "decisionStateSchemaVersion": dataset_manifest["decisionStateSchemaVersion"],
        "teacherVersion": dataset_manifest["teacherVersion"],
        "utilityVersion": dataset_manifest["utilityVersion"],
        "labelSchemaVersion": dataset_manifest["labelSchemaVersion"],
        "datasetManifestVersion": dataset_manifest["manifestVersion"],
        "datasetInputFingerprint": dataset_manifest["inputFingerprint"],
        "datasetOutputFingerprint": dataset_manifest["outputFingerprint"],
        "datasetSourceCommit": dataset_manifest["sourceCommit"],
        "datasetCutoff": dataset_manifest["cutoff"],
        "datasetSeed": dataset_manifest["datasetSeed"],
        "datasetCounts": dataset_manifest["counts"],
        "trainingSourceCommit": training_source_commit,
        "pythonVersion": python_version,
        "torchVersion": torch_version,
        "numpyVersion": numpy_version,
        "onnxVersion": onnx_version,
        "onnxOpsetVersion": onnx_opset_version,
        "trainingConfig": training_config,
        "trainingConfigSha256": training_config_sha256,
        "modelContract": model_contract,
        "bestEpoch": best_epoch,
        "epochsRun": epochs_run,
        "stoppedEarly": stopped_early,
        "trainableParameterCount": trainable_parameter_count,
        "modelStateSha256": model_state_sha256,
        "pytorchArtifactSha256": pytorch_artifact_sha256,
        "onnxArtifactSha256": onnx_artifact_sha256,
        "metricsFileSha256": metrics_file_sha256,
        "artifactPurpose": artifact_purpose,
    }


def write_canonical_json(path: Path, obj: dict[str, object]) -> bytes:
    content = canonical_json_bytes(obj)
    path.write_bytes(content)
    return content
