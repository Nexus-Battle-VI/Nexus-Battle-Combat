"""Exportacion/validacion ONNX (EN-036.3, Management #567 §87)."""

from __future__ import annotations

from pathlib import Path

import onnx
import pytest
import torch
from onnx import TensorProto

from nexus_combat_ai.errors import OnnxExportError
from nexus_combat_ai.export.onnx_exporter import (
    ONNX_INPUT_NAME,
    ONNX_OPSET_VERSION,
    ONNX_OUTPUT_NAME,
    export_candidate_scoring_mlp_to_onnx,
    validate_exported_onnx,
)
from nexus_combat_ai.features.schema import FEATURE_DIMENSION
from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP


def test_export_writes_a_single_nonempty_file(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)

    assert output.is_file()
    assert output.stat().st_size > 0
    # #567 §49: un UNICO archivo, sin `.onnx.data` externo.
    assert list(tmp_path.iterdir()) == [output]


def test_exported_model_passes_onnx_checker(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)

    loaded = validate_exported_onnx(output)
    onnx.checker.check_model(loaded)


def test_input_and_output_contract(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)
    loaded = validate_exported_onnx(output)

    assert len(loaded.graph.input) == 1
    assert len(loaded.graph.output) == 1

    input_tensor = loaded.graph.input[0]
    assert input_tensor.name == ONNX_INPUT_NAME
    dims = input_tensor.type.tensor_type.shape.dim
    assert len(dims) == 2
    assert dims[1].dim_value == FEATURE_DIMENSION
    assert dims[0].dim_param != ""  # candidate axis DINAMICO

    output_tensor = loaded.graph.output[0]
    assert output_tensor.name == ONNX_OUTPUT_NAME
    out_dims = output_tensor.type.tensor_type.shape.dim
    assert len(out_dims) == 1
    assert out_dims[0].dim_param != ""


def test_input_and_output_are_explicitly_float32(tmp_path: Path) -> None:
    """El `modelContract` del training manifest declara `inputDtype`/
    `outputDtype` = `"float32"`; esta prueba exige que el GRAFO ONNX
    realmente lo sea, no solo que el exportador lo produzca por casualidad."""
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)
    loaded = validate_exported_onnx(output)

    assert loaded.graph.input[0].type.tensor_type.elem_type == TensorProto.FLOAT
    assert loaded.graph.output[0].type.tensor_type.elem_type == TensorProto.FLOAT


def test_validate_rejects_a_non_float32_input_dtype(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)

    tampered = onnx.load(str(output))
    tampered.graph.input[0].type.tensor_type.elem_type = TensorProto.DOUBLE
    onnx.save(tampered, str(output))

    with pytest.raises(OnnxExportError, match="dtype"):
        validate_exported_onnx(output)


def test_validate_rejects_a_non_float32_output_dtype(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)

    tampered = onnx.load(str(output))
    tampered.graph.output[0].type.tensor_type.elem_type = TensorProto.DOUBLE
    onnx.save(tampered, str(output))

    with pytest.raises(OnnxExportError, match="dtype"):
        validate_exported_onnx(output)


def test_opset_is_the_explicit_v1_decision(tmp_path: Path) -> None:
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)
    loaded = validate_exported_onnx(output)

    opsets = {imp.domain: imp.version for imp in loaded.opset_import}
    assert opsets[""] == ONNX_OPSET_VERSION == 18


def test_onnx_scores_match_pytorch_scores_within_tolerance(tmp_path: Path) -> None:
    """Paridad minima (no la suite completa de #569): el grafo exportado
    debe producir los MISMOS scores que el modulo PyTorch original."""
    onnxruntime = pytest.importorskip(
        "onnxruntime", reason="onnxruntime no es dependencia de #567 (eso es #568/#569)"
    )
    model = CandidateScoringMLP()
    model.eval()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)

    features = torch.randn(5, FEATURE_DIMENSION, dtype=torch.float32)
    with torch.no_grad():
        expected = model(features).numpy()

    session = onnxruntime.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    (actual,) = session.run(None, {ONNX_INPUT_NAME: features.numpy()})

    import numpy as np

    assert np.allclose(actual, expected, atol=1e-5)


def test_validate_rejects_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(OnnxExportError):
        validate_exported_onnx(tmp_path / "nope.onnx")


def test_validate_rejects_an_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "empty.onnx"
    path.write_bytes(b"")
    with pytest.raises(OnnxExportError):
        validate_exported_onnx(path)


def test_different_candidate_counts_all_work(tmp_path: Path) -> None:
    """[1,72] / [3,72] / [100,72] (#567 §12, §87): el candidate axis nunca
    esta atado a un batch size fijo."""
    model = CandidateScoringMLP()
    output = tmp_path / "model.onnx"
    export_candidate_scoring_mlp_to_onnx(model, output)
    onnxruntime = pytest.importorskip("onnxruntime")
    session = onnxruntime.InferenceSession(str(output), providers=["CPUExecutionProvider"])

    for n in (1, 3, 100):
        features = torch.randn(n, FEATURE_DIMENSION, dtype=torch.float32).numpy()
        (scores,) = session.run(None, {ONNX_INPUT_NAME: features})
        assert scores.shape == (n,)
