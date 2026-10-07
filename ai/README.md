# nexus-combat-ai

Pipeline reproducible de dataset Y entrenamiento para la IA de Combat
(Management [EN-036.2 #566](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/566)
y [EN-036.3 #567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567),
hijos de [EN-036 #555](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/555)).

**Offline, nunca productivo.** `ai/` no es un microservicio: no expone HTTP,
no corre dentro del request path de Combat, y nada en el Node runtime lo
importa. Es tooling de dataset/entrenamiento, pensado para ejecutarse a mano
o en CI, nunca desde `ExecuteAiTurn` ni ningun handler HTTP/WS.

Ver también: [`docs/en-036-ai-dataset-pipeline.md`](../docs/en-036-ai-dataset-pipeline.md)
(el documento completo: contratos auditados, gap de teacher labels en vivo,
`feature-schema-v1`, split, reproducibilidad).

## Que hace esta Task (y que NO)

Deja listo:

- Entorno Python 3.13 + `uv` reproducible desde `uv.lock`.
- Lectura de `CombatDecisionEvent` + `MctsTeacherLabel` REALES desde Mongo
  (`combat-decision-events` + `mcts-teacher-labels`) o JSONL/fixtures.
- `FeatureEncoder` (`feature-schema-v1`) versionado y documentado.
- `DecisionSample` + `torch.utils.data.Dataset`/`DataLoader` con candidatos
  de longitud variable.
- Split determinista 80/10/10 por `battleId` (`battle-hash-split-v1`).
- Manifiesto reproducible (`dataset-manifest-v1`) con fingerprints.
- `CandidateScoringMLP` (`candidate-mlp-v1`), entrenamiento reproducible
  (`teacher-policy-cross-entropy-v1`, early stopping, CPU determinista) y
  exportacion a ONNX (EN-036.3 #567; ver
  [`docs/en-036-neural-training.md`](../docs/en-036-neural-training.md)).

**NO** activa `NeuralPolicy` en Combat, **NO** agrega `onnxruntime-node` ni
`onnxruntime` Python, **NO** corre el harness de evaluacion de combates:
eso es #568/#569.

## Teacher labels en vivo: wiring real (EN-036.2, correccion de alcance sobre PR#81)

`MctsTeacher.teach()` SI se invoca en produccion: `LiveMctsTeacherLabeler`
(`src/application/services/LiveMctsTeacherLabeler.ts`) esta wired en
`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`ExecuteAiTurn`, fail-open (un fallo
de MCTS o de persistencia nunca afecta la accion real) y nunca esperado en el
camino de respuesta. El resultado se persiste append-only en la coleccion
Mongo `mcts-teacher-labels` (migracion `025-mcts-teacher-labels.ts`), ligado
por `eventId` al `CombatDecisionEvent` real. Desactivado por defecto
(`MCTS_LIVE_TEACHER_LABELING_ENABLED=false`): un despliegue que quiera
alimentar el dataset de #566 lo activa explicitamente (ver `env.ts` -- cada
decision etiquetada corre una busqueda MCTS completa, `rollouts: 128`, con
costo real de CPU).

`MongoCombatDatasetSource` lee AMBAS colecciones reales, solo lectura.

**Limitacion que sigue vigente: `MISSION` nunca produce labels.**
`RunMissionSimulation` resuelve la mision ENTERA con `MissionSimulation.ts`
(motor aproximado propio, sin `BattleRoom`) antes de preparar su
`CombatDecisionEvent` retroactivamente -- no existe ninguna sala PRE-ACCION
que pasarle a `MctsTeacher.teach()` con fidelidad. El dataset contabiliza esas
decisiones como `missingLabelExpected` (nunca un error); una decision
ONLINE/TOURNAMENT sin label SI hace fallar el build por defecto
(`missingLabelUnexpected`, ver `--allow-missing-labels`).

## Instalación

```bash
cd ai
uv sync --frozen
```

Requiere Python 3.13 (`.python-version` lo fija) y `uv` (versión usada en
CI: `0.9.17`). PyTorch se resuelve CPU-only desde el índice oficial
`https://download.pytorch.org/whl/cpu` (ver `pyproject.toml`,
`[tool.uv.sources]`).

## Pruebas

```bash
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

## Construir el dataset de fixtures

```bash
uv run nexus-combat-dataset build \
  --source jsonl \
  --events tests/fixtures/decision-events.jsonl \
  --labels tests/fixtures/teacher-labels.jsonl \
  --output ./out \
  --cutoff 2027-01-01T00:00:00Z \
  --source-commit "$(git -C .. rev-parse HEAD)" \
  --seed 42
```

Produce `out/{train,validation,test}.jsonl` + `out/manifest.json`. Correr el
mismo comando dos veces (en directorios distintos) produce los MISMOS cuatro
archivos byte a byte (`tests/test_manifest.py::test_reproducibility_byte_for_byte`
lo prueba).

Contra Mongo real (decision events + teacher labels, ambos reales):

```bash
MONGODB_URI="mongodb://localhost:27017/combat" \
uv run nexus-combat-dataset build \
  --source mongo \
  --output ./out \
  --cutoff 2027-01-01T00:00:00Z \
  --seed 42
  # --allow-missing-labels si hay decisiones ONLINE/TOURNAMENT conocidas sin
  # label (p. ej. un periodo con MCTS_LIVE_TEACHER_LABELING_ENABLED apagado)
```

## Entrenar + exportar a ONNX (EN-036.3 #567)

```bash
uv run nexus-combat-train \
  --dataset-dir ./out \
  --output ./artifacts \
  --source-commit "$(git -C .. rev-parse HEAD)" \
  --seed 42
```

`--dataset-dir` debe ser un frozen dataset YA construido con
`nexus-combat-dataset build` (arriba) -- el trainer nunca vuelve a consultar
Mongo ni reconstruye el dataset. Produce
`artifacts/<run-id>/{model.pt,model.onnx,training-manifest.json,metrics.json,feature-schema.json}`
(`ai/artifacts/` está en `.gitignore`: los binarios nunca se commitean). Ver
el detalle completo -- arquitectura, loss, lo que el spike de exportación
ONNX encontró de verdad, y el estado real de los datos -- en
[`docs/en-036-neural-training.md`](../docs/en-036-neural-training.md).

Por defecto marca el artefacto `artifactPurpose: "SMOKE_TEST"`: hoy no hay
suficientes `MctsTeacherLabel` reales en ningún entorno (la colección está
vacía), así que todo run usa el dataset sintético de
`tests/fixtures/training/`. `--artifact-purpose CANDIDATE` existe para
cuando exista dataset real suficiente.

## Regenerar los fixtures/golden vectors

Los fixtures de `tests/fixtures/*.jsonl` y los golden vectors de
`tests/fixtures/golden-*.json` se generan con:

```bash
uv run python scripts/generate_fixtures.py
uv run python scripts/generate_golden_vectors.py
```

Los de `tests/fixtures/training/*.jsonl` (el dataset usado para entrenar,
con un `battleId` deliberadamente elegido para cada split real de
`battle-hash-split-v1` -- el fixture anterior cae ENTERO en `TRAIN`) se
regeneran con:

```bash
uv run python scripts/generate_training_fixtures.py
```

Los tres scripts reutilizan los contratos reales (`contracts/`,
`features/`, `dataset/split.py`) para garantizar que cada fixture es válido
-- nunca se escriben a mano.

## Para #568 (NeuralPolicy en TypeScript/Node)

`feature-schema-v1` (`src/nexus_combat_ai/features/schema.py`) es el
contrato que `#568` deberá reproducir EXACTAMENTE en TypeScript:
`feature_schema_manifest()` expone la definición completa (orden, nombre,
normalización, vocabularios), y `tests/fixtures/golden-*.json` fija vectores
exactos para verificar paridad Python ↔ TypeScript.

El contrato ONNX que `#568` cargará (`candidate_features [N,72] float32` ->
`scores [N] float32`, opset 18, sin `candidate_mask` en el grafo, sin
sigmoid) está en `training-manifest.json.modelContract` de cada run, y
documentado en
[`docs/en-036-neural-training.md`](../docs/en-036-neural-training.md).
