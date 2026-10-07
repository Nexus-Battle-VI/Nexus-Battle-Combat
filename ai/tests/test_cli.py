"""`nexus-combat-dataset build` (#566 §67, §72 "dataset fixture build smoke")."""

from __future__ import annotations

import json
from pathlib import Path

from nexus_combat_ai.cli.build_dataset import main

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_cli_build_from_jsonl_fixtures(tmp_path: Path) -> None:
    output = tmp_path / "out"
    exit_code = main(
        [
            "build",
            "--source",
            "jsonl",
            "--events",
            str(FIXTURES_DIR / "decision-events.jsonl"),
            "--labels",
            str(FIXTURES_DIR / "teacher-labels.jsonl"),
            "--output",
            str(output),
            "--cutoff",
            "2027-01-01T00:00:00Z",
            "--source-commit",
            "abc123",
            "--seed",
            "42",
        ]
    )
    assert exit_code == 0
    assert (output / "train.jsonl").exists()
    assert (output / "validation.jsonl").exists()
    assert (output / "test.jsonl").exists()
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["sourceCommit"] == "abc123"
    assert manifest["datasetSeed"] == 42


def test_cli_build_requires_events_and_labels_for_jsonl_source(tmp_path: Path, capsys) -> None:
    import pytest

    with pytest.raises(SystemExit):
        main(
            [
                "build",
                "--source",
                "jsonl",
                "--output",
                str(tmp_path / "out"),
                "--cutoff",
                "2027-01-01T00:00:00Z",
                "--source-commit",
                "abc123",
                "--seed",
                "1",
            ]
        )


def test_cli_build_requires_mongo_uri_env_for_mongo_source(tmp_path: Path, monkeypatch) -> None:
    import pytest

    monkeypatch.delenv("MONGODB_URI", raising=False)
    with pytest.raises(SystemExit):
        main(
            [
                "build",
                "--source",
                "mongo",
                "--output",
                str(tmp_path / "out"),
                "--cutoff",
                "2027-01-01T00:00:00Z",
                "--source-commit",
                "abc123",
                "--seed",
                "1",
            ]
        )
