"""`EarlyStopping` (EN-036.3, Management #567 §83)."""

from __future__ import annotations

from nexus_combat_ai.training.early_stopping import EarlyStopping


def test_stops_after_patience_epochs_without_improvement() -> None:
    losses = [1.0, 0.8, 0.7, 0.71, 0.72, 0.73, 0.74, 0.75]
    stopper = EarlyStopping(patience=5)

    stop_at: int | None = None
    for epoch, loss in enumerate(losses):
        if stopper.step(loss, epoch):
            stop_at = epoch
            break

    assert stop_at == 7  # cinco epochs sin mejora tras el 0.7 del epoch 2 (3,4,5,6,7)
    assert stopper.best_loss == 0.7
    assert stopper.best_epoch == 2


def test_equality_never_resets_patience() -> None:
    stopper = EarlyStopping(patience=2, min_delta=0.0)
    assert stopper.step(1.0, 0) is False  # primer valor: siempre "mejora"
    assert stopper.step(1.0, 1) is False  # igual, NO es mejora, pero no agota todavia
    assert stopper.epochs_without_improvement == 1
    assert stopper.step(1.0, 2) is True  # segunda vez igual -> agota patience=2


def test_min_delta_requires_improvement_larger_than_margin() -> None:
    stopper = EarlyStopping(patience=1, min_delta=0.1)
    assert stopper.step(1.0, 0) is False
    # 0.95 es "mejor" pero no por mas de 0.1 -> NO cuenta como mejora.
    assert stopper.step(0.95, 1) is True
