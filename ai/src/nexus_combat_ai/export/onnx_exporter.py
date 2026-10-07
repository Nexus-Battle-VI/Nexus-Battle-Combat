"""Exportacion ONNX de `CandidateScoringMLP` (EN-036.3, Management #567
§43-51).

`ONNX_OPSET_VERSION = 18` es una DECISION TECNICA v1 explicita (#567 §46),
no el default implicito del exportador: auditado contra la version de
PyTorch/ONNX lockeada en `uv.lock` (spike real, ver
`docs/en-036-neural-training.md`) -- 18 es estable y ampliamente soportado
por versiones de ONNX Runtime publicadas desde 2023, mas conservador que el
maximo que el `onnx` instalado puede describir (28). Elegir el maximo
bleeding-edge arriesgaria incompatibilidad con la version de ONNX Runtime
Node que #568 todavia no ha fijado.

El exportador de esta version de PyTorch (`torch.export`-based, el nuevo
exportador por defecto) exige pasar `dynamic_shapes` keyed por el nombre
REAL del parametro de `forward` (no por el `input_names` de ONNX) y requiere
la dependencia `onnxscript` -- ambos confirmados por el spike real, no
supuestos de memoria (#567 §45-46).
"""

from __future__ import annotations

from pathlib import Path

import onnx
import torch
from onnx import TensorProto

from nexus_combat_ai.errors import OnnxExportError
from nexus_combat_ai.features.schema import FEATURE_DIMENSION
from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP

ONNX_OPSET_VERSION = 18
ONNX_INPUT_NAME = "candidate_features"
ONNX_OUTPUT_NAME = "scores"


def export_candidate_scoring_mlp_to_onnx(model: CandidateScoringMLP, output_path: Path) -> None:
    """Exporta `model` (en modo `eval()`) a un UNICO archivo `output_path`
    (#567 §49: sin `.onnx.data` externo -- la red es diminuta). El primer eje
    de `candidate_features`/`scores` queda DINAMICO (#567 §47, §136): el
    modelo productivo de #568 puntuara `C` candidatos legales reales, nunca
    un batch fijo de entrenamiento. NO recibe `candidate_mask` (#567 §48):
    el padding es exclusivo del `DataLoader` de training."""
    model.eval()
    dummy_input = torch.zeros((1, model.input_dim), dtype=torch.float32)
    candidate_axis = torch.export.Dim("candidate_count")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        torch.onnx.export(
            model,
            (dummy_input,),
            str(output_path),
            input_names=[ONNX_INPUT_NAME],
            output_names=[ONNX_OUTPUT_NAME],
            dynamic_shapes={ONNX_INPUT_NAME: {0: candidate_axis}},
            opset_version=ONNX_OPSET_VERSION,
            verbose=False,
            # El exportador (`dynamo=True`, el nuevo default de esta version
            # de PyTorch) externaliza los pesos a un `.onnx.data` por
            # defecto (`external_data=True`) incluso para una red diminuta
            # como esta -- confirmado con un spike real, no un supuesto.
            # #567 §49 exige un UNICO archivo: `external_data=False` lo
            # fuerza a embeber los pesos dentro del propio `.onnx`.
            external_data=False,
        )
    except Exception as error:  # pragma: no cover - mensaje de contexto, no silenciar
        raise OnnxExportError(f"torch.onnx.export fallo: {error}") from error


def validate_exported_onnx(path: Path) -> onnx.ModelProto:
    """`onnx.checker.check_model` + verificacion del contrato productivo
    exacto (#567 §50): 1 input, 1 output, nombres correctos, feature axis ==
    `FEATURE_DIMENSION`, candidate axis dinamico, opset esperado."""
    if not path.is_file() or path.stat().st_size == 0:
        raise OnnxExportError(f'"{path}" no existe o esta vacio.')

    model = onnx.load(str(path))
    try:
        onnx.checker.check_model(model)
    except onnx.checker.ValidationError as error:
        raise OnnxExportError(f"onnx.checker.check_model fallo: {error}") from error

    if len(model.graph.input) != 1:
        raise OnnxExportError(f"Se esperaba exactamente 1 input, hay {len(model.graph.input)}.")
    if len(model.graph.output) != 1:
        raise OnnxExportError(f"Se esperaba exactamente 1 output, hay {len(model.graph.output)}.")

    input_tensor = model.graph.input[0]
    if input_tensor.name != ONNX_INPUT_NAME:
        raise OnnxExportError(
            f'El input se llama "{input_tensor.name}", se esperaba "{ONNX_INPUT_NAME}".'
        )
    input_dims = input_tensor.type.tensor_type.shape.dim
    if len(input_dims) != 2:
        raise OnnxExportError(f"El input debe tener rank 2, tiene {len(input_dims)}.")
    if input_dims[0].dim_param == "" and input_dims[0].dim_value != 0:
        raise OnnxExportError("El primer eje (candidate axis) del input debe ser dinamico.")
    if input_dims[1].dim_value != FEATURE_DIMENSION:
        raise OnnxExportError(
            f"El feature axis del input es {input_dims[1].dim_value}, "
            f"se esperaba {FEATURE_DIMENSION}."
        )
    if input_tensor.type.tensor_type.elem_type != TensorProto.FLOAT:
        raise OnnxExportError(
            f"El dtype del input es {input_tensor.type.tensor_type.elem_type}, "
            f"se esperaba FLOAT ({TensorProto.FLOAT}) -- el contrato productivo "
            "(#567 §47, modelContract.inputDtype) exige float32 explicito."
        )

    output_tensor = model.graph.output[0]
    if output_tensor.name != ONNX_OUTPUT_NAME:
        raise OnnxExportError(
            f'El output se llama "{output_tensor.name}", se esperaba "{ONNX_OUTPUT_NAME}".'
        )
    output_dims = output_tensor.type.tensor_type.shape.dim
    if len(output_dims) != 1:
        raise OnnxExportError(f"El output debe tener rank 1, tiene {len(output_dims)}.")
    if output_dims[0].dim_param == "" and output_dims[0].dim_value != 0:
        raise OnnxExportError("El unico eje (candidate axis) del output debe ser dinamico.")
    if output_tensor.type.tensor_type.elem_type != TensorProto.FLOAT:
        raise OnnxExportError(
            f"El dtype del output es {output_tensor.type.tensor_type.elem_type}, "
            f"se esperaba FLOAT ({TensorProto.FLOAT}) -- el contrato productivo "
            "(#567 §47, modelContract.outputDtype) exige float32 explicito."
        )

    opsets = {imp.domain: imp.version for imp in model.opset_import}
    default_opset = opsets.get("", None)
    if default_opset != ONNX_OPSET_VERSION:
        raise OnnxExportError(
            f"El opset exportado es {default_opset}, se esperaba {ONNX_OPSET_VERSION}."
        )

    return model
