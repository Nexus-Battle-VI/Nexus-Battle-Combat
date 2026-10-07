# EN-036.3 — Entrenamiento de la MLP y exportación ONNX

Management [#567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567),
hijo de [EN-036 #555](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/555).
Depende de [EN-036.2 #566](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/566)
(ver [`en-036-ai-dataset-pipeline.md`](en-036-ai-dataset-pipeline.md)) y de
[EN-036.1 #565](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/565)
(ver [`en-036-mcts-teacher.md`](en-036-mcts-teacher.md)).

**Offline, nunca productivo.** Igual que el resto de `ai/`: no expone HTTP,
no corre en el request path de Combat. `#568` tomará el `.onnx` producido
aquí e implementará `NeuralPolicy` en TypeScript/Node — **ese PR no hace
eso**: el modelo todavía no decide nada en Combat.

## Qué hace esta Task (y qué NO)

Deja listo:

- `CandidateScoringMLP` (`model/candidate_mlp.py`): `72 → Linear(64) → ReLU
  → Linear(32) → ReLU → Linear(1)`, raw score, candidate axis dinámico.
- `training/`: loss (`teacher-policy-cross-entropy-v1`), métricas,
  `EarlyStopping`, lector del frozen dataset (`FrozenDatasetBundle`),
  bucle de entrenamiento (`train_model`/`evaluate_model`), hashing y
  manifest (`training-manifest-v1`).
- `export/onnx_exporter.py`: exportación + validación ONNX (opset 18).
- CLI `nexus-combat-train`.
- Job de CI (`ai-pipeline`) extendido: smoke training + export + checker.

**NO** activa `NeuralPolicy` en Node, **NO** agrega `onnxruntime-node` ni
`onnxruntime` Python, **NO** construye el harness de evaluación de combates
(`#569`), **NO** hace hyperparameter search ni RL.

## Requisito (#567/#555) vs decisión técnica v1

| | Requisito (issue) | Decisión técnica v1 (este PR) |
|---|---|---|
| Arquitectura | PyTorch, MLP 64/32/1 | Input real = `FEATURE_DIMENSION` (72), nunca hardcodeado |
| Optimizer | AdamW, lr 0.001, batch 256, max 30 epochs, patience 5 | — |
| Weight decay | No lo fija el issue | `0.01` (estándar para AdamW), versionado en `TrainingConfig` |
| Loss | Supervised/imitation learning | `teacher-policy-cross-entropy-v1`: soft target CE contra la distribución MCTS completa, no solo `selectedIndex` |
| Early stopping | 5 epochs sin mejora | `minDelta = 0.0`: la igualdad nunca reinicia la paciencia |
| Exportación | ONNX | `external_data=False` (ver más abajo), opset `18` explícito |
| Salida del modelo | — | Raw score, sin sigmoid/softmax (eso es del loss, no del grafo) |
| Reproducibilidad | Artefacto + metadata | `modelStateSha256` (hash canónico de tensores) como autoridad; `run_id` determinista por `(datasetOutputFingerprint, trainingConfigSha256, seed)` |

## Arquitectura del modelo

```
candidate_features [N, 72]  (N = candidatos legales de ESA decisión, dinámico)
        │
   Linear(72, 64) → ReLU
        │
   Linear(64, 32) → ReLU
        │
   Linear(32, 1)  → squeeze(-1)
        │
     scores [N]   (raw score, SIN sigmoid/softmax)
```

El modelo no sabe `actionIdentity`, `battleId` ni `eventId`: la única
relación es `candidate_features[i] → scores[i]` (crítico para `#568`, que
unirá el score con el candidato real por posición).

`batch_size=256` es configuración de **entrenamiento** (cuántas
*decisiones* por paso), no una dimensión del modelo: cada decisión aporta
`C` candidatos, `C` variable. Un batch de entrenamiento es
`[B, Cmax, 72]` con padding + `candidate_mask`; el modelo solo ve `[N, 72]`
tras aplanar.

## Loss: `teacher-policy-cross-entropy-v1`

El teacher MCTS (#565) ya produce una distribución completa
(`candidate.probability`, derivada de visitas), no solo un índice elegido.
Reducir eso a `CrossEntropy(selectedIndex)` desperdiciaría esa señal. v1
usa **soft target cross-entropy** contra la distribución completa:

```
L = - Σ_i p_i · log_softmax(scores)_i      (por decisión, con padding
                                              enmascarado a -inf ANTES del
                                              softmax)
loss = mean(L sobre las decisiones del batch)
```

`teacher_mean_utilities`/`teacher_visits` se conservan como evidencia/
métricas, pero **no** se mezclan en una segunda loss (una MSE de utilidad
sumada a la CE introduciría un peso arbitrario sin respaldo del issue).

## Dataset consumido

El trainer **nunca** consulta Mongo ni reconstruye el dataset:

```
Mongo (mcts-teacher-labels + combat-decision-events)
        │  nexus-combat-dataset build   (#566)
        ▼
frozen dataset dir: manifest.json + {train,validation,test}.jsonl
        │  nexus-combat-train           (#567, ESTE PR)
        ▼
model.pt + model.onnx + training-manifest.json + metrics.json
```

`FrozenDatasetBundle` (`training/dataset_loader.py`) valida, antes de leer
una sola decisión: `manifestVersion`, `featureSchemaVersion`,
`featureDimension`, `teacherVersion`, `utilityVersion`,
`labelSchemaVersion`, `splitStrategyVersion`, **recalcula**
`outputFingerprint` desde los bytes reales de los 3 `.jsonl` (un dataset
editado a mano falla aquí, no entrena en silencio), y exige
`exclusions.missingLabelUnexpected == 0` (un hueco de labels ONLINE/
TOURNAMENT no reconocido explícitamente en `#566` nunca se entrena
silenciosamente). Train/validation/test deben tener `>= 1` decisión cada
uno, o falla con `DatasetNotTrainableError`.

## Estado real de los datos (auditado, 2026-10)

La colección `mcts-teacher-labels` de Combat está **vacía** en el entorno
local (`MCTS_LIVE_TEACHER_LABELING_ENABLED=false` por defecto desde la
corrección de alcance sobre Combat#81, y nadie ha jugado partidas con el
flag activo todavía). No existe dataset real suficiente para un run
`CANDIDATE`.

Este PR entrena exclusivamente sobre un **dataset sintético controlado**
(`ai/tests/fixtures/training/`, generado con
`ai/scripts/generate_training_fixtures.py`, reutilizando los mismos
builders/contratos que `#566` — nunca JSON escrito a mano) con tres
`battleId` elegidos para caer uno en cada split real de
`battle-hash-split-v1` (el fixture original de `#566` cae ENTERO en
TRAIN, así que no sirve para validar `#567`: `test` quedaría vacío).

**El artefacto que produce CI/este PR es `artifactPurpose = "SMOKE_TEST"`,
nunca `"CANDIDATE"`.** Demuestra que la ingeniería completa funciona
end-to-end y es reproducible — no demuestra nada sobre la calidad del
modelo. `--artifact-purpose CANDIDATE` existe para cuando exista dataset
real suficiente, y `"ACTIVE"` no existe en absoluto (corresponde a
EN-037).

## Exportación ONNX: lo que el spike encontró de verdad

Auditado contra las versiones REALES lockeadas (`uv.lock`): PyTorch
`2.14.1+cpu`, `onnx` `1.23.2`.

1. **El exportador de esta versión de PyTorch (`dynamo=True`, el nuevo
   default) exige `onnxscript`** incluso pasando `opset_version` explícito
   — sin él, `torch.onnx.export` falla con
   `ModuleNotFoundError: onnxscript`. Confirmado con un spike real, no
   supuesto de memoria. Se agregó como dependencia (`onnx-ir`/`onnxscript`
   llegan transitivamente).
2. **`dynamic_shapes` se indexa por el nombre REAL del parámetro de
   `forward`** (`candidate_features`), no por `input_names` de ONNX — un
   error fácil de cometer copiando ejemplos de versiones anteriores de
   PyTorch que usaban `dynamic_axes`.
3. **`external_data=True` es el default** de este exportador — incluso
   para una red de ~7 KB, produce un `model.onnx` + `model.onnx.data`
   separado. `#567 §49` exige un único archivo: `external_data=False` lo
   fuerza a embeber los pesos dentro del propio `.onnx`.
4. **Investigación real de determinismo (§80 del encargo, no una
   declaración sin probar)**: con `external_data=True`, exportar el MISMO
   modelo dos veces producía bytes `.onnx` DISTINTOS aunque el grafo
   (nodos, conexiones, pesos de los `initializer`) fuera IDÉNTICO byte a
   byte — confirmado comparando el `text_format` completo del protobuf
   (diff vacío) contra el diff de bytes crudos (no vacío): la diferencia
   era puramente de **orden de serialización no canónico** del protobuf
   interno del exportador al repartir el grafo en dos archivos, nunca del
   grafo o los pesos reales. Al desactivar `external_data`, el problema
   **desapareció por completo**: el `.onnx` resultante es
   byte-idéntico entre ejecuciones, confirmado dentro del mismo proceso Y
   entre procesos Python frescos (`tests/test_cli_train.py::
   test_reproducibility_same_inputs_produce_the_same_model_state_and_metrics`).
   `modelStateSha256` sigue siendo la autoridad primaria de
   reproducibilidad (§41) por principio, pero en la práctica
   `onnxArtifactSha256` también es reproducible aquí.
5. **`torch.save()` (`model.pt`) SÍ es no determinista** entre ejecuciones
   del mismo `state_dict` (confirmado, no solo supuesto): el contenedor
   zip/pickle cambia bytes aunque el contenido lógico sea idéntico. Esto
   confirma por qué `modelStateSha256` (hash canónico de los tensores
   crudos, ordenados por nombre) es la autoridad correcta y nunca el hash
   del archivo `.pt`.

## Contrato ONNX (para `#568`)

```
input:  candidate_features  float32  [N, 72]   (N dinámico)
output: scores               float32  [N]       (N dinámico, raw score)
opset: 18   (decisión técnica v1, no el máximo que soporta el onnx instalado;
             18 es ampliamente soportado por versiones de ONNX Runtime desde
             2023 — más conservador frente a la versión de ONNX Runtime Node
             que #568 todavía no ha fijado)
```

Sin `candidate_mask` en el grafo: `#568` solo puntuará candidatos legales
reales, nunca padding. `training-manifest.json.modelContract` deja este
contrato en metadata explícita para que `#568` pueda validar antes de
cargar.

## Artefactos de un run

```
ai/artifacts/<run-id>/
  model.pt                  # state_dict + metadata minima (NO el nn.Module completo)
  model.onnx                 # unico archivo, pesos embebidos
  training-manifest.json     # training-manifest-v1 (ver campos abajo)
  metrics.json                # training-metrics-v1
  feature-schema.json         # feature_schema_manifest() de #566
```

`run_id = candidate-mlp-v1-<sha256(datasetOutputFingerprint:trainingConfigSha256:seed)[:12]>`:
determinista, nunca un timestamp (§55). Si `<output>/<run-id>` ya existe,
el CLI **falla** (sin `--force`): nunca sobrescribe un modelo previo en
silencio (§143).

`ai/artifacts/` está en `.gitignore`; los binarios (`.pt`/`.onnx`) nunca se
commitean.

## Comandos

```bash
cd ai
uv sync --frozen

# 1. Construir el frozen dataset (ya existe desde #566; aquí con el fixture
#    de #567 que SI cae en los tres splits).
uv run nexus-combat-dataset build \
  --source jsonl \
  --events tests/fixtures/training/decision-events.jsonl \
  --labels tests/fixtures/training/teacher-labels.jsonl \
  --output ./out \
  --cutoff 2027-01-01T00:00:00Z \
  --source-commit "$(git -C .. rev-parse HEAD)" \
  --seed 42

# 2. Entrenar + exportar.
uv run nexus-combat-train \
  --dataset-dir ./out \
  --output ./artifacts \
  --source-commit "$(git -C .. rev-parse HEAD)" \
  --seed 42
```

Salida (stderr): log por epoch (`epoch`, `trainLoss`, `validationLoss`,
`validationTop1Agreement`, `patienceCounter`) y el resumen final (`runId`,
`datasetOutputFingerprint`, `bestEpoch`, `epochsRun`, `stoppedEarly`,
`validationLoss`/`validationTop1Agreement`, `testLoss`/
`testTop1Agreement`, `modelStateSha256`, `onnxArtifactSha256`,
`artifactDir`).

## Campos del training manifest (`training-manifest-v1`)

Ver `training/artifacts.py::build_training_manifest`. Incluye, entre otros:
versiones (`modelArchitectureVersion`, `trainingConfigVersion` implícito en
`trainingConfig.trainingConfigVersion`, `lossVersion`,
`featureSchemaVersion`, `teacherVersion`, `utilityVersion`,
`labelSchemaVersion`, `onnxOpsetVersion`), procedencia del dataset
(`datasetInputFingerprint`, `datasetOutputFingerprint`, `datasetSourceCommit`,
`datasetCutoff`, `datasetSeed`, `datasetCounts`), procedencia del código
(`trainingSourceCommit`), entorno (`pythonVersion`, `torchVersion`,
`numpyVersion`, `onnxVersion`), resultado del training (`bestEpoch`,
`epochsRun`, `stoppedEarly`, `trainableParameterCount`), hashes
(`modelStateSha256`, `pytorchArtifactSha256`, `onnxArtifactSha256`,
`metricsFileSha256`), `modelContract` (para `#568`) y `artifactPurpose`
(`SMOKE_TEST` | `CANDIDATE`, nunca `ACTIVE`).

Deliberadamente **sin** ningún campo de reloj de pared (`generatedAt` de
verdad-ahora): rompería la reproducibilidad byte-a-byte.
