"""`train_model`/`evaluate_model` (EN-036.3, Management #567 §84-86)."""

from __future__ import annotations

import inspect

import pytest
import torch

from nexus_combat_ai.model.candidate_mlp import CandidateScoringMLP
from nexus_combat_ai.training import trainer as trainer_module
from nexus_combat_ai.training.config import TrainingConfig
from nexus_combat_ai.training.metrics import SplitMetrics
from nexus_combat_ai.training.trainer import evaluate_model, train_model

INPUT_DIM = 4


def _toy_batch(seed: int) -> dict[str, torch.Tensor]:
    generator = torch.Generator().manual_seed(seed)
    return {
        "candidate_features": torch.randn(2, 2, INPUT_DIM, generator=generator),
        "candidate_mask": torch.tensor([[True, True], [True, False]]),
        "teacher_probabilities": torch.tensor([[0.6, 0.4], [1.0, 0.0]]),
        "teacher_mean_utilities": torch.tensor([[0.5, 0.3], [0.7, 0.0]]),
        "selected_index": torch.tensor([0, 0]),
    }


def test_train_model_signature_never_accepts_a_test_loader() -> None:
    """#567 §27, §85: el test set queda aislado por la FIRMA de la funcion."""
    parameters = inspect.signature(train_model).parameters
    for name in parameters:
        assert "test" not in name.lower()


def test_evaluate_model_runs_without_grad_and_in_eval_mode() -> None:
    model = CandidateScoringMLP(input_dim=INPUT_DIM)
    model.train()
    batch = _toy_batch(seed=1)
    metrics = evaluate_model(model, [batch])
    assert not model.training
    assert isinstance(metrics, SplitMetrics)


def test_best_checkpoint_is_restored_not_the_last_epoch(monkeypatch: pytest.MonkeyPatch) -> None:
    """#567 §33, §84: tras `train_model`, los pesos deben ser los del BEST
    epoch (validation loss mas baja), no los del ultimo epoch entrenado."""
    train_batch = _toy_batch(seed=7)
    train_loader = [train_batch]
    validation_loader = [train_batch]  # contenido irrelevante: evaluate_model esta mockeado

    fake_losses = iter([1.0, 2.0])  # epoch0 mejora (best); epoch1 empeora -> patience=1 detiene

    def fake_evaluate_model(_model: object, _loader: object) -> SplitMetrics:
        return SplitMetrics(
            loss=next(fake_losses),
            top1_agreement=0.0,
            mean_teacher_probability_of_selection=0.0,
            mean_teacher_utility_of_selection=0.0,
        )

    monkeypatch.setattr(trainer_module, "evaluate_model", fake_evaluate_model)

    config = TrainingConfig(
        seed=0, max_epochs=5, early_stopping_patience=1, learning_rate=0.5, batch_size=256
    )

    torch.manual_seed(123)
    model_under_test = CandidateScoringMLP(input_dim=INPUT_DIM)
    initial_state = {k: v.clone() for k, v in model_under_test.state_dict().items()}

    result = trainer_module.train_model(model_under_test, train_loader, validation_loader, config)

    assert result.best_epoch == 0
    assert result.epochs_run == 2
    assert result.stopped_early is True

    # Replica DETERMINISTA e independiente de la mecanica real de entrenamiento
    # (el stub de evaluate_model solo decide CUANDO detenerse, nunca como
    # evolucionan los pesos: eso depende solo de train_loader/optimizer).
    replica = CandidateScoringMLP(input_dim=INPUT_DIM)
    replica.load_state_dict(initial_state)
    optimizer = torch.optim.AdamW(
        replica.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay
    )
    after_epoch0 = trainer_module._run_training_epoch(replica, train_loader, optimizer)
    weights_after_epoch0 = {k: v.clone() for k, v in replica.state_dict().items()}
    after_epoch1 = trainer_module._run_training_epoch(replica, train_loader, optimizer)
    weights_after_epoch1 = {k: v.clone() for k, v in replica.state_dict().items()}

    assert after_epoch0 != after_epoch1  # el optimizer SI dio un segundo paso real

    for name, tensor in result.best_state_dict.items():
        assert torch.equal(tensor, weights_after_epoch0[name]), name
        assert not torch.equal(tensor, weights_after_epoch1[name]), name

    # Y el modelo que `train_model` deja cargado coincide con el best, no con
    # el ultimo paso que de hecho se ejecuto (epoch 1).
    for name, tensor in model_under_test.state_dict().items():
        assert torch.equal(tensor, weights_after_epoch0[name]), name


def test_training_stops_without_early_stop_runs_all_max_epochs() -> None:
    batch = _toy_batch(seed=3)
    config = TrainingConfig(seed=0, max_epochs=3, early_stopping_patience=999)
    model = CandidateScoringMLP(input_dim=INPUT_DIM)

    result = train_model(model, [batch], [batch], config)

    assert result.epochs_run == 3
    assert result.stopped_early is False
    assert len(result.epoch_history) == 3
