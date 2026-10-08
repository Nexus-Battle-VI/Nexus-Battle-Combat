# EN-037.1 — Model registry de IA en Combat

Management [#570](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/570),
hijo de [EN-037 #556](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/556).
Depende del contrato de runtime congelado por
[EN-036.3 #567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567)/
[EN-036.4 #568](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/568)
y reutiliza criterios de reproducibilidad de
[EN-036.5 #569](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/569).

## Principio central

**El registry no decide si un modelo es bueno.** Garantiza que una version
de modelo existe, es identificable, integra, compatible con el contrato de
runtime, tiene lineage trazable, tiene un estado valido dentro de un ciclo
de vida cerrado, y puede activarse de forma segura (sin condiciones de
carrera, sin corrupcion silenciosa).

- `#571` (futuro) produce candidatos: dataset + entrenamiento + ONNX.
- `#569` (ya implementado) evalua candidatos: Random/RuleBased/MCTS/Neural
  con combates acelerados.
- `#572` (futuro) decide automaticamente, con gates versionados sobre esa
  evaluacion: `PASS -> activate()` / `FAIL -> reject()`.
- `#570` (este PR) hace esas dos ultimas llamadas SEGURAS y AUDITABLES. No
  implementa gates, no conoce `RandomPolicy`/`RuleBasedPolicy`/MCTS/win
  rate/`EvaluationScenario`, y no tiene ningun umbral de calidad
  hardcodeado.

## Ciclo de vida

```
TRAINING -> CANDIDATE -> EVALUATING -> ACTIVE
                      \-> REJECTED  <-/
TRAINING -> REJECTED
CANDIDATE -> REJECTED
```

Union cerrada en [`AiModelState.ts`](../src/domain/value-objects/AiModelState.ts):
`TRAINING | CANDIDATE | EVALUATING | ACTIVE | REJECTED`, nunca strings
libres. `ACTIVE` y `REJECTED` son terminales: que ocurre con un `ACTIVE`
anterior al promover uno nuevo (swap/demote/rollback) es semantica de
`#572`, que este PR no inventa.

Transiciones explicitamente **prohibidas** (nunca compiladas, nunca
alcanzables): `TRAINING -> ACTIVE`, `CANDIDATE -> ACTIVE` directo (debe
pasar por `EVALUATING`), `ACTIVE -> EVALUATING`, `REJECTED -> ACTIVE`,
`REJECTED -> CANDIDATE`.

`TRAINING -> REJECTED` (un training que falla) y `CANDIDATE -> REJECTED`
(un artefacto invalido detectado antes de evaluar) estan permitidas sin
forzar el paso por `EVALUATING` — `EVALUATING -> REJECTED` es obligatoria.

**No existe ningun estado de aprobacion humana** (`WAITING_APPROVAL`,
`PENDING_PO`, etc.) ni campos `approvedBy`/`requiresApproval`. El ciclo
objetivo es automatico de punta a punta; `activate()` es la primitiva
segura que `#572` llamara automaticamente cuando sus gates (todavia no
implementados) decidan `PASS`.

## Identidad: `modelVersion`

`modelVersion` reutiliza directamente `trainingRunId` (nunca un UUID o
timestamp nuevo inventado aqui). Python ya deriva ese id de forma
deterministica a partir de `datasetOutputFingerprint` + `trainingConfigSha256`
\+ `seed` (`ai/src/nexus_combat_ai/cli/train_model.py::_run_id`), asi que la
identidad del registry queda trazable al training real sin inventar una
segunda nocion de identidad.

`modelStateSha256` sigue siendo el identificador criptografico de los
pesos (fijado por `#567`): nunca se sustituye por el SHA del `model.pt`
(serializacion no deterministica, ya probado). Se persisten
`modelStateSha256` y `pytorchArtifactSha256` por separado, sin confundirlos.

## Lineage dividido en dos partes

Reflejando CUANDO cada dato existe de verdad
([`AiModelVersion.ts`](../src/domain/entities/AiModelVersion.ts)):

- **`AiModelTrainingLineage`**: conocido ANTES de entrenar (dataset
  congelado + config de training). Se fija al crear la version en
  `TRAINING` y es inmutable para siempre.
- **`AiModelArtifactLineage`**: solo existe DESPUES de entrenar (hashes del
  checkpoint/ONNX/metricas). Se fija UNA vez, en `TRAINING -> CANDIDATE`, y
  tambien es inmutable desde ese momento.

Despues de crear una version, estos campos NUNCA cambian: `trainingRunId`,
`trainingSeed`, `trainingSourceCommit`, los fingerprints de dataset,
`modelStateSha256`, `onnxArtifactSha256`, `featureSchemaVersion`,
`teacherVersion`, `utilityVersion`. Solo cambian `state`/`stateHistory`/
`updatedAt`/metadata de rechazo. Un registro repetido con metadata
IDENTICA es un no-op idempotente (mismo criterio que
`CombatDecisionEvent`/`MctsTeacherLabel`); metadata DIFERENTE bajo el mismo
`modelVersion` es un conflicto (`ModelVersionConflictError`), nunca un
`replaceOne` silencioso.

## Compatibilidad de manifest: dónde se valida y por qué no se duplica

El contrato de runtime completo (`trainingManifestVersion=training-manifest-v1`,
`modelArchitectureVersion=candidate-mlp-v1`, `featureSchemaVersion=feature-schema-v1`,
`featureDimension=72`, `onnxOpsetVersion=18`, I/O `candidate_features
[N,72] -> scores [N]`, `candidateAxisDynamic=true`) **ya lo valida**
`parseAndValidateTrainingManifest` (congelado por `#567`/`#568`). El
registry reutiliza esa MISMA funcion a traves de
[`AiModelTrainingManifestV1.ts`](../src/infrastructure/ai/AiModelTrainingManifestV1.ts)
(`parseAndValidateModelTrainingManifest`, que delega en ella antes de
extraer los campos de provenance adicionales que el registry necesita) en
vez de reimplementar esas mismas reglas en un tercer archivo.

Esto significa que la compatibilidad de esquema se garantiza **en la
frontera de parseo**, no dentro de `AiModelRegistry`: cualquier manifest
con `featureSchemaVersion`, `modelArchitectureVersion` u `onnxOpsetVersion`
incompatibles falla en `parseAndValidateModelTrainingManifest` ANTES de que
exista la oportunidad de llamar a `registerCandidate(...)` — por
construccion, nunca llega a `CANDIDATE`. Verificado en
[`ai-model-training-manifest-v1.spec.ts`](../test/unit/ai-model-training-manifest-v1.spec.ts)
y en el test de Mongo real correspondiente.

El propio `AiModelRegistry`/`AiModelVersion` solo valida las invariantes de
integridad que genuinamente le pertenecen: presencia de artifact lineage,
coincidencia de SHA-256 real, y `artifactPurpose`. No vuelve a interpretar
`featureSchemaVersion`/`modelArchitectureVersion`/el contrato ONNX: ese
trabajo vive en un solo sitio.

## `artifactPurpose`: una declaracion, nunca una prueba

`artifactPurpose` (`SMOKE_TEST | CANDIDATE`) es una DECLARACION del caller
(fijada por `#567`): no prueba criptograficamente nada sobre el dataset
real detras de un entrenamiento. El registry nunca infiere
`modelIsTrusted = true` a partir de `artifactPurpose === 'CANDIDATE'`.

**Revision de codigo tras la primera version de este PR**: `registerCandidate()`
exige `artifactPurpose === 'CANDIDATE'` — un `SMOKE_TEST` **nunca** entra al
ciclo de vida productivo, ni siquiera como `CANDIDATE`/`EVALUATING` (la
version anterior de este documento decia que SMOKE_TEST podia llegar hasta
ahi y se bloqueaba solo en `activate()`; eso dejaba un `CANDIDATE`/
`EVALUATING` falso en el historial, con significado de lifecycle
equivocado). El rechazo ocurre en `assertArtifactLineage` (dominio,
`AiModelVersion.registerCandidate`) y se revalida en cada reconstruccion
(`assertRestoredInvariants`, constructor) — nunca solo en `activate()`.

El artefacto `SMOKE_TEST` real que ya produce CI
(`candidate-mlp-v1-smoke`, reutilizado tambien por `#568`/`#569`) sigue
pudiendo ejercitar honestamente almacenamiento/hash/roundtrip —
directamente contra `AiModelArtifactRepositoryPort.put`/`getBySha256`, sin
pasar por el registry ni falsear su proposito. Probado en
[`ai-model-version.spec.ts`](../test/unit/ai-model-version.spec.ts),
[`ai-model-registry.spec.ts`](../test/unit/ai-model-registry.spec.ts) y
contra Mongo real en
[`mongo-ai-model-registry.spec.ts`](../test/db/mongo-ai-model-registry.spec.ts).

## Binding manifest ↔ training lineage (revision de codigo)

Un hallazgo de revision identifico que `registerCandidate()` solo
comprobaba los hashes de `model.onnx`/`metrics.json` contra el manifest,
pero NUNCA comprobaba que el manifest perteneciera REALMENTE al
`AiModelVersion` en `TRAINING` que lo recibe. Eso permitiria,
conceptualmente, registrar el artifact lineage del training B sobre el
training lineage del training A, siempre que los bytes de ONNX/metricas
coincidieran con SUS PROPIOS hashes declarados — rompiendo exactamente la
trazabilidad que es el proposito central de `#570`.

`AiModelRegistry.registerCandidate()` ahora compara, fail-closed, estos
campos del manifest contra `current.trainingLineage` ANTES de persistir
nada (`assertManifestMatchesTrainingLineage`):
`modelArchitectureVersion`, `featureSchemaVersion`, `teacherVersion`,
`utilityVersion`, `trainingSourceCommit`, `datasetSourceCommit`,
`datasetInputFingerprint`, `datasetOutputFingerprint`, `datasetCutoff`,
`datasetSeed`, `trainingConfigSha256` y `trainingSeed`. Cualquier
discrepancia lanza `ModelTrainingLineageMismatchError` y el training
permanece intacto en `TRAINING` (nunca una `CANDIDATE` a medias). Probado
con un fixture real en
[`mongo-ai-model-registry.spec.ts`](../test/db/mongo-ai-model-registry.spec.ts)
(`training A + manifest alterado -> reject`).

## `trainingSeed` y metadata reproducible (revision de codigo)

`datasetSeed` y `trainingSeed` son conceptos distintos que la primera
version de este PR confundia implicitamente: `datasetSeed` gobierna el
split/build del dataset; `trainingSeed` (`TrainingConfig.trainingSeed` en
`ai/src/nexus_combat_ai`) gobierna la inicializacion de
PyTorch/DataLoader/entrenamiento. Que hoy ambos valgan 42 en el fixture
sintetico es una coincidencia, nunca una garantia.

`AiModelTrainingLineage` ahora persiste `trainingSeed` explicitamente
(extraido de `trainingConfig.trainingSeed`, validado como parte del
binding de arriba). Ademas, `metrics.json` ya NO se descarta tras
hashearlo: `AiModelArtifactLineage` persiste su contenido parseado
(`metrics`), junto con `trainingConfig` y `datasetCounts` (opacos, igual
criterio que `CombatEpic.baseEffect`: el registry nunca interpreta su
contenido salvo para extraer `trainingSeed`, solo lo persiste para
auditoria) y `trainingManifestSha256` (el SHA-256 real de
`training-manifest.json` completo, para demostrar que la metadata
registrada corresponde exactamente al manifest real recibido). No se
persiste `model.pt`: el runtime solo necesita `model.onnx` (`#567`/`#568`).

## `restore()` revalida invariantes semanticas (revision de codigo)

La version anterior de `AiModelVersion.restore()` confiaba en que Mongo ya
habia garantizado todas las invariantes de la maquina de estados. Pero el
validador `$jsonSchema` de Mongo solo protege la FORMA estructural
(tipos, enums, campos requeridos) — nunca la coherencia semantica entre
`state`/`stateHistory`/`artifactLineage`/`rejection` (por ejemplo, nada en
el validador impedia estructuralmente un documento `state: 'ACTIVE'` con
`artifactLineage: null`, o un `stateHistory` cuyo ultimo elemento no
coincidiera con `state`).

Toda construccion de `AiModelVersion` (desde `startTraining`, `restore`, o
cualquier transicion interna) ahora pasa por
`assertRestoredInvariants` en el constructor privado, que comprueba:
`modelVersion === trainingRunId`; `revision` entero no negativo;
`stateHistory` no vacio, empieza en `TRAINING`, es una cadena continua
(`entry.from === previous.to`) y cada paso es una transicion permitida por
`isAllowedAiModelStateTransition`; el ultimo `stateHistory.to` coincide
con `state`; `artifactLineage` no nulo siempre tiene
`artifactPurpose=CANDIDATE`; `ACTIVE` exige artifact lineage; `REJECTED`
exige informacion de rechazo y ningun otro estado la admite. El validador
de Mongo sigue siendo defensa en profundidad adicional, nunca la unica
autoridad de la maquina de estados.

## Decision de almacenamiento: BSON Binary, no GridFS

ADR-023 dejaba pendiente BSON Binary vs. GridFS para artefactos binarios.
Medicion real sobre el `model.onnx` producido por el pipeline de `#567`
(fixture de entrenamiento sintetico, mismo comando que corre `ai-pipeline`
en CI):

| Medicion                                                           | Valor                      |
| ------------------------------------------------------------------ | -------------------------- |
| `model.onnx` real (candidate-mlp-v1)                               | **37 148 bytes (~36 KiB)** |
| Limite de documento BSON/MongoDB                                   | 16 MiB (16 777 216 bytes)  |
| Margen tecnico reservado para `_id`/metadata/arquitecturas futuras | 1 MiB                      |
| `MAX_ARTIFACT_BYTES` resultante                                    | 15 MiB (15 728 640 bytes)  |

El modelo real ocupa ~0.2% del limite de documento, incluso dejando un
margen de 1 MiB para metadata del documento y para arquitecturas de red
futuras varias veces mas grandes que `candidate-mlp-v1`. GridFS existe para
fragmentar binarios que NO entran en un documento (en chunks de 255 KiB,
mas una segunda coleccion `fs.chunks`) — introducirlo aqui seria
complejidad sin necesidad demostrada.

**Decision**: `ai-model-artifacts` almacena el artefacto como BSON `Binary`
directamente, content-addressed por su propio SHA-256
(`_id = onnxArtifactSha256`). `ModelArtifactTooLargeError` se lanza ANTES
de insertar nada si algun artefacto futuro excediera `MAX_ARTIFACT_BYTES`
(mensaje exacto: `"artifact too large for selected storage strategy"`) —
nunca un limite arbitrario como "8 MB porque si": el limite sale del limite
real de documento de Mongo menos un margen documentado.

## Dos colecciones, nunca una

- **`ai-model-versions`**: metadata + ciclo de vida, mutable, pequena.
  `_id = modelVersion`.
- **`ai-model-artifacts`**: binario inmutable, content-addressed.
  `_id = sha256`.

Separadas a proposito: el binario inmutable nunca se mezcla con el
documento mutable de estado (evita duplicar binarios, inflar documentos de
lifecycle, o mezclar estado mutable con contenido inmutable).

Content-addressed: mismo `sha256` + mismos bytes -> idempotente (no-op).
Mismo `sha256` + bytes distintos -> `ArtifactConflictError`, **nunca
sobreescribe**. En cada lectura antes de activar, se recalcula el SHA-256
real de los bytes almacenados y se compara contra el lineage — nunca se
asume que Mongo no puede contener datos corruptos o manipulados.

## Indices

`ai-model-versions`:

- `_id` (`modelVersion`, implicito).
- `training_run_id_unique` — unico sobre `trainingLineage.trainingRunId`
  (defensivo: por diseño `modelVersion === trainingRunId`, pero el indice
  lo hace una garantia del motor, no solo una convencion de codigo).
- `model_state_sha256` — no unico, para trazabilidad/debug.
- `active_unique` — **unico parcial** sobre `state`, filtrado a
  `state: 'ACTIVE'`. Esta es la defensa REAL contra dos activaciones
  concurrentes (mismo patron que `023-combat-decision-events.ts`): nunca se
  confia solo en `findActive()` + `if null, activate()` a nivel de
  aplicacion, porque eso es una condicion de carrera entre procesos.

`ai-model-artifacts`: solo `_id` (el propio SHA-256 ya es su indice).

## Concurrencia optimista

`replaceWithExpectedRevision(version, expectedRevision)` filtra el
`replaceOne` por `{_id, revision: expectedRevision}` (mismo patron que
`BattleRoomRepositoryPort.save`): si `matchedCount === 0`, la revision ya
avanzo y se lanza `ModelVersionConflictError`. **Nunca last-write-wins
silencioso.**

**Evidencia real de la race de activacion** (test
`mongo-ai-model-registry.spec.ts`, contra Mongo real, no un sustituto en
memoria): se crean dos versiones en `EVALUATING` y se llama
`Promise.allSettled([activate(A), activate(B)])` concurrentemente. El
indice unico parcial sobre `ACTIVE` garantiza que el motor solo permite que
uno de los dos `replaceOne` prospere; el segundo produce un error Mongo
`E11000` que el repositorio mapea a `ActiveModelConflictError` (nunca deja
escapar el detalle de Mongo a dominio/aplicacion). Resultado verificado:
exactamente 1 `fulfilled`, exactamente 1 `rejected` con
`ActiveModelConflictError`, y `findActive()` devuelve exactamente una
version despues de la carrera.

## `findActive()`

Deterministico: `0 -> null`, `1 -> la version`, `2` es imposible por el
indice unico parcial — nunca se elige arbitrariamente "la mas reciente"
entre varias.

## Rechazo

Codigos cerrados: `TRAINING_FAILED | ARTIFACT_INVALID | SCHEMA_INCOMPATIBLE
| EVALUATION_FAILED`. Deliberadamente **no** existe `WIN_RATE_TOO_LOW` ni
similares — esos criterios de calidad son de `#572`. `REJECTED` guarda
`reasonCode`/`reason`/`rejectedAt`; nunca una traza completa ni secretos.

## Lo que este PR NO hace

- No implementa gates de evaluacion, umbrales de win rate (60%/45% o
  cualquier otro), ni auto-promocion. `activate()`/`reject()` son
  primitivas seguras; decidir CUANDO llamarlas es `#572` (EN-037.3).
- No implementa el entrenamiento/dataset/subproceso Python — eso es `#571`.
- No reemplaza `NEURAL_MODEL_ONNX_PATH` por `registry.findActive()` en el
  runtime de inferencia — esa integracion es un EN-037 posterior.
- No expone HTTP, panel de administracion, ni autenticacion nueva.
- No implementa borrado ni limpieza de versiones/artefactos — el registry
  es un historial de auditoria; retencion/GC queda fuera de alcance.
- No implementa rollback ni la semantica de "que pasa con el ACTIVE
  anterior" al promover uno nuevo — eso tambien es `#572`.
- No modifica ningun otro repositorio de Nexus-Battle-VI.

## Validacion

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:db
npm run test:coverage
npm run build
git diff --check
```

`ai/` no se modifico: el registry solo LEE el contrato de manifest ya
congelado por `#567`/`#568`, sin necesidad objetiva de tocar Python.

Para las pruebas de artefacto/manifest reales se generó localmente, con el
mismo comando que corre el job `ai-pipeline` de CI sobre el dataset
sintetico de `ai/tests/fixtures/training/`, un `model.onnx` +
`training-manifest.json` + `metrics.json` reales (no simulados), commiteados
en [`test/fixtures/ai-model-registry/`](../test/fixtures/ai-model-registry)
para que `test:unit`/`test:db` no dependan de un entorno Python disponible
en cada ejecucion.
