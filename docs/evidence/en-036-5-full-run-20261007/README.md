# Evidencia FULL_EVALUATION — EN-036.5 (Management #569) — 2026-10-07

Corrida real de `npm run evaluate:ai` con `--purpose FULL_EVALUATION`
contra el artefacto `SMOKE_TEST` producido por `#567` (sourceCommit
`abedfca1f7dae0bc4d6c98cac8e5200ccec97108`). Generada DESPUÉS de las
correcciones de revisión (Poder con regeneración de `openOwnTurn`,
`winRate` con denominador explícito, `turnsCompleted` real,
`--allow-smoke-model` respetado).

## Comando exacto

```bash
node dist/infrastructure/evaluation/run-ai-evaluation.js \
  --artifact-dir <run-de-nexus-combat-train> \
  --output ./evaluation-out/full-20261007 \
  --purpose FULL_EVALUATION \
  --seed-start 3000000 \
  --seed-count 50 \
  --mcts-seed-count 8 \
  --max-plies 500 \
  --allow-smoke-model \
  --source-commit abedfca1f7dae0bc4d6c98cac8e5200ccec97108
```

## Resultado

- **1392 partidas totales**, 696 pares espejados.
- **0 `invalidPolicySelections`, 0 `engineRejections`** en todo el run.
- Paridad PyTorch↔ONNX: **PASS** (`argmaxAgreement=100%`,
  `maxAbsoluteError≈1.49e-8`, `maxRelativeError≈2.8e-7`, tolerancia
  `atol=rtol=1e-5`).
- **Reproducibilidad confirmada**: una segunda corrida idéntica produjo
  el mismo `matchesSha256 = b23bd12581d9cca3807f1b8909f23245911b009690c3876e17a67549fcb45580`
  byte a byte.

## Archivos

- `summary.json` / `summary.md`: reporte machine-readable y legible.
- `evaluation-config.json`: configuración exacta de la corrida.
- `parity-report.json`: reporte de paridad PyTorch↔ONNX de esa corrida.

`matches.jsonl` (1392 líneas, ~1.4 MB) **no se versiona** — se puede
regenerar byte a byte con el comando de arriba contra el mismo artefacto
SMOKE_TEST (`candidate-mlp-v1-223178020ea4` de `#567`), o descargarse como
artifact de la corrida de CI `ai-evaluation-smoke` (muestra reducida,
smoke) en GitHub Actions.

**Modelo `artifactPurpose=SMOKE_TEST`**: estas métricas demuestran que el
harness funciona de punta a punta, **no** que un modelo esté listo para
producción (ver `docs/en-036-ai-evaluation.md`).
