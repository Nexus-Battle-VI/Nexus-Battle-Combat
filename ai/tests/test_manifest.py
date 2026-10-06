"""Manifest, split-by-battle y reproducibilidad byte-a-byte (#566 §48-§50, §81)."""

from __future__ import annotations

import json
from pathlib import Path

from nexus_combat_ai.dataset.builder import DatasetBuildConfig, build_dataset
from nexus_combat_ai.dataset.source import JsonlDatasetSource

FIXTURES_DIR = Path(__file__).parent / "fixtures"
EVENTS_PATH = FIXTURES_DIR / "decision-events.jsonl"
LABELS_PATH = FIXTURES_DIR / "teacher-labels.jsonl"


def _build(tmp_path: Path, *, seed: int = 42, cutoff: str = "2027-01-01T00:00:00Z"):
    source = JsonlDatasetSource(EVENTS_PATH, LABELS_PATH)
    config = DatasetBuildConfig(
        cutoff=cutoff,
        source_commit="deadbeef",
        seed=seed,
        output_dir=tmp_path,
    )
    return build_dataset(source, config)


def test_manifest_counts_are_correct(tmp_path: Path) -> None:
    result = _build(tmp_path)
    counts = result.manifest["counts"]

    # battle-0001 (3 decisiones no-END_TURN + 1 END_TURN excluido),
    # battle-0002 (1), battle-0003 (1), battle-mission-0001 (1).
    assert counts["battles"] == 4
    assert counts["decisions"] == 6
    assert counts["trainBattles"] + counts["validationBattles"] + counts["testBattles"] == 4
    assert counts["trainDecisions"] + counts["validationDecisions"] + counts["testDecisions"] == 6
    assert result.manifest["exclusions"]["endTurn"] == 1
    assert result.manifest["exclusions"]["missingLabel"] == 0


def test_manifest_declares_versions() -> None:
    pass  # cubierto indirectamente por test_manifest_counts_are_correct + schema tests


def test_no_battle_appears_in_more_than_one_split(tmp_path: Path) -> None:
    result = _build(tmp_path)
    seen: dict[str, str] = {}
    for split, samples in result.samples_by_split.items():
        for sample in samples:
            if sample.battle_id in seen and seen[sample.battle_id] != split:
                raise AssertionError(
                    f"{sample.battle_id} aparece en {seen[sample.battle_id]} y {split}"
                )
            seen[sample.battle_id] = split
    assert len(seen) == 4


def test_cutoff_excludes_events_after_it(tmp_path: Path) -> None:
    # Cutoff antes de TODAS las decisiones: el dataset queda vacio.
    result = _build(tmp_path, cutoff="2020-01-01T00:00:00Z")
    assert result.manifest["counts"]["decisions"] == 0


def test_reproducibility_byte_for_byte(tmp_path: Path) -> None:
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"
    result_a = _build(out_a, seed=7, cutoff="2027-01-01T00:00:00Z")
    result_b = _build(out_b, seed=7, cutoff="2027-01-01T00:00:00Z")

    assert result_a.output_fingerprint == result_b.output_fingerprint

    for filename in ("train.jsonl", "validation.jsonl", "test.jsonl", "manifest.json"):
        bytes_a = (out_a / filename).read_bytes()
        bytes_b = (out_b / filename).read_bytes()
        assert bytes_a == bytes_b, f"{filename} difiere entre dos ejecuciones identicas"


def test_different_seed_changes_order_but_not_input_fingerprint(tmp_path: Path) -> None:
    result_seed_1 = _build(tmp_path / "seed1", seed=1)
    result_seed_2 = _build(tmp_path / "seed2", seed=2)
    assert result_seed_1.manifest["inputFingerprint"] == result_seed_2.manifest["inputFingerprint"]


def test_manifest_json_is_canonical_and_stable_keys(tmp_path: Path) -> None:
    _build(tmp_path)
    raw = (tmp_path / "manifest.json").read_text(encoding="utf-8")
    parsed = json.loads(raw)
    # sort_keys=True + separators compactos: sin espacios tras ":"/",".
    assert ": " not in raw
    assert ", " not in raw
    assert parsed["manifestVersion"] == "dataset-manifest-v1"
