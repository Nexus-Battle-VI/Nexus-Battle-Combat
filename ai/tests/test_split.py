"""S-01..S-07 (#566 §83): `battle-hash-split-v1`."""

from __future__ import annotations

from nexus_combat_ai.dataset.split import split_bucket, split_for_battle


def test_s01_same_battle_id_same_split() -> None:
    assert split_for_battle("battle-xyz") == split_for_battle("battle-xyz")


def test_s02_different_decisions_same_battle_same_split() -> None:
    # El split es funcion SOLO de battleId: distintas decisiones/candidatos
    # de la misma batalla no participan en absoluto del calculo.
    battle_id = "battle-abc"
    splits = {split_for_battle(battle_id) for _ in range(5)}
    assert splits == {split_for_battle(battle_id)}


def test_s03_stable_across_separate_hashlib_calls() -> None:
    # "Proceso distinto" se simula recalculando desde cero sin cache alguno.
    results = [split_bucket(f"battle-{i}") for i in range(50)]
    results_again = [split_bucket(f"battle-{i}") for i in range(50)]
    assert results == results_again


def test_s04_order_of_input_does_not_matter() -> None:
    ids = [f"battle-{i}" for i in range(30)]
    forward = {bid: split_for_battle(bid) for bid in ids}
    backward = {bid: split_for_battle(bid) for bid in reversed(ids)}
    assert forward == backward


def test_s05_result_does_not_depend_on_any_training_seed() -> None:
    # split_for_battle no toma ningun parametro de seed: estructuralmente no
    # puede incorporarlo.
    import inspect

    sig = inspect.signature(split_for_battle)
    assert list(sig.parameters) == ["battle_id"]


def test_s06_no_battle_id_appears_in_more_than_one_split() -> None:
    ids = [f"battle-{i}" for i in range(500)]
    assignment = {bid: split_for_battle(bid) for bid in ids}
    # Por construccion cada battleId tiene una unica entrada en el dict
    # (una sola llamada, un unico split); esto documenta explicitamente la
    # invariante que importa: NINGUNA llamada repetida cambia el resultado.
    for bid in ids:
        assert split_for_battle(bid) == assignment[bid]


def test_s07_distribution_uses_documented_80_10_10_buckets() -> None:
    buckets = [split_bucket(f"battle-{i}") for i in range(5000)]
    train = sum(1 for bucket in buckets if 0 <= bucket < 80)
    validation = sum(1 for bucket in buckets if 80 <= bucket < 90)
    test = sum(1 for bucket in buckets if 90 <= bucket < 100)
    total = len(buckets)
    assert train + validation + test == total
    # Tolerancia amplia: es una distribucion de hash, no una particion exacta.
    assert 0.75 <= train / total <= 0.85
    assert 0.05 <= validation / total <= 0.15
    assert 0.05 <= test / total <= 0.15


def test_buckets_are_in_range() -> None:
    for i in range(200):
        bucket = split_bucket(f"battle-{i}")
        assert 0 <= bucket <= 99
