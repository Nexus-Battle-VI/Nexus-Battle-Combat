"""`nexus-combat-dataset build` (#566 §67-§70): comando reproducible, offline,
read-only. Nunca imprime secretos (la URI de Mongo se lee de `MONGODB_URI`,
nunca de un argumento de linea de comandos -- #566 §68)."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from nexus_combat_ai.dataset.builder import DatasetBuildConfig, build_dataset
from nexus_combat_ai.dataset.source import DEFAULT_COMBAT_DATABASE_NAME, JsonlDatasetSource


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


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nexus-combat-dataset")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser(
        "build", help="Construye el dataset logico (train/validation/test + manifest)."
    )
    build.add_argument("--source", choices=["jsonl", "mongo"], required=True)
    build.add_argument("--events", type=Path, help="JSONL de CombatDecisionEvent (fuente jsonl).")
    build.add_argument("--labels", type=Path, help="JSONL de TeacherLabelRecord (fuente jsonl).")
    build.add_argument(
        "--database", default=DEFAULT_COMBAT_DATABASE_NAME, help="Base de Mongo (fuente mongo)."
    )
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--cutoff", required=True, help="ISO-8601 UTC, ej. 2026-10-05T00:00:00Z")
    build.add_argument(
        "--source-commit",
        help="Commit del codigo que define contracts/features/pipeline. "
        "Si se omite, se intenta `git rev-parse HEAD`; si tampoco hay git, falla.",
    )
    build.add_argument("--seed", type=int, required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    if args.command != "build":
        parser.error(f'comando desconocido "{args.command}".')
        return 2

    if args.source == "jsonl":
        if args.events is None or args.labels is None:
            parser.error("--source jsonl requiere --events y --labels.")
            return 2
        source = JsonlDatasetSource(args.events, args.labels)
    else:
        uri = os.environ.get("MONGODB_URI")
        if not uri:
            parser.error("--source mongo requiere la variable de entorno MONGODB_URI.")
            return 2
        from nexus_combat_ai.dataset.source import MongoCombatDatasetSource

        source = MongoCombatDatasetSource(uri, database=args.database)

    source_commit = args.source_commit or _default_source_commit()
    if not source_commit:
        parser.error(
            "No se pudo determinar sourceCommit (sin --source-commit y sin "
            "`git rev-parse HEAD` disponible)."
        )
        return 2

    config = DatasetBuildConfig(
        cutoff=args.cutoff,
        source_commit=source_commit,
        seed=args.seed,
        output_dir=args.output,
    )

    result = build_dataset(source, config)

    print(f"dataset construido en {args.output}", file=sys.stderr)
    print(f"outputFingerprint={result.output_fingerprint}", file=sys.stderr)
    for split, samples in result.samples_by_split.items():
        print(f"{split.lower()}: {len(samples)} decisiones", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
