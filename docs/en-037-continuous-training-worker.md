# EN-037.2 — Worker de reentrenamiento continuo con coalescing

Management [#571](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/571),
hijo de [EN-037 #556](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/556).
Depende del Model Registry de
[EN-037.1 #570](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/570)
(ver [`en-037-model-registry.md`](en-037-model-registry.md)) y del pipeline
de dataset/training ya construido en `ai/` por
[EN-036.2 #566](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/566)/
[EN-036.3 #567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567).

## 1. Objetivo y alcance

Integrar el pipeline Python existente (dataset builder + trainer + exportador
ONNX, ya construidos) con un worker **autonomo, durable, serializado y
recuperable**, capaz de incorporar nuevas partidas mediante coalescing y
producir versiones `CANDIDATE` (o fallos trazables) en el Model Registry de
`#570`.

**Lo que este PR NO hace** (alcance negativo explicito, Management #571 §15):
gates de evaluacion Neural-vs-Random/RuleBased, umbrales 60%/45% o
cualquier otro, `promotionPolicyVersion`, auto-promocion a `ACTIVE`,
rollback de modelos activos, hot reload del modelo productivo en runtime,
cambios a la seleccion de politica de inferencia, A/B testing,
entrenamiento distribuido, GPU/SageMaker/S3 nuevo, endpoints publicos,
interfaz Web, un nuevo bounded context de IA, o despliegue AWS definitivo
(eso es `#572`/`#573`/`#574`).

## 2. Arquitectura real implementada

```
BattleRoom.status = FINISHED (Mongo, ya existente)
        |
        v
findFinishedSince(cursor) -- escaneo periodico, worker standalone
        |
        v
ai-training-coordinator (Mongo, NUEVO): requestedThrough / lease+fencing
        |
        v
nexus-combat-dataset build --source mongo --cutoff <congelado>
        |
        v
nexus-combat-train --emit-identity-only  -> {runId, trainingConfigSha256, datasetOutputFingerprint}
        |
        v
AiModelRegistry.startTraining(lineage)        <- TRAINING (antes de PyTorch)
        |
        v
nexus-combat-train --artifact-purpose CANDIDATE   (entrenamiento REAL)
        |
        v
AiModelRegistry.registerCandidate(...)        <- CANDIDATE
        |
        v
ai-training-coordinator.recordSuccess(...)    <- processedThrough avanza, lease liberado
```

**No existia ningun mecanismo de eventos/outbox durable en Combat**
(auditado antes de escribir codigo, Management #571 §3.3): `BattleCompleted`
no existe en ningun archivo del repo. `BattleEventPublisherPort` es un
notificador WebSocket fire-and-forget, nunca durable. `CombatDecisionEvent`/
`COMBAT_DECISION_OUTCOME` se escriben best-effort (nunca lanzan, "la
unicidad la da el bloqueo optimista") -- no son una senal confiable de "la
partida termino". La senal REAL y fuertemente consistente es
`BattleRoom.status === 'FINISHED'` (escrito con bloqueo optimista en el
mismo `rooms.save()`), ya expuesto por
`BattleRoomRepositoryPort.findFinishedSince(since)` (reutilizado, HU-22).

**Tampoco existia ningun lock distribuido reutilizable**: `ChannelLock`/
`RoomCommandLockPort` es en memoria, de una sola replica (ADR-020), y esta
scoped a la serializacion de comandos de una sala -- nunca cruza procesos.
Este PR introduce el PRIMER primitivo de coordinacion entre procesos de
Combat que persiste en Mongo (`ai-training-coordinator`, migracion `028`).

El pipeline Python (`--source mongo` en `nexus-combat-dataset build`,
`MongoCombatDatasetSource`, `--artifact-purpose CANDIDATE` en
`nexus-combat-train`) **ya existia** de `#566`/`#567` -- el trabajo real de
esta Task es orquestacion, no construir otro dataset builder ni otro
algoritmo de entrenamiento. La UNICA adicion a `ai/` es
`--emit-identity-only` (ver §8).

## 3. Responsabilidades Node/Python

- **Node (`src/infrastructure/training/`)**: coordinacion durable (cursor +
  lease/fencing), orquestacion de subprocesos, lectura/validacion de
  artefactos, integracion con el Model Registry de `#570`. Nunca
  reimplementa el dataset builder ni el trainer.
- **Python (`ai/`)**: dataset builder y trainer, sin cambios de
  comportamiento salvo `--emit-identity-only` (una funcion PURA ya
  existente, solo expuesta sin ejecutar el resto del pipeline).

El worker es un **proceso standalone** (`npm run train:continuous`), igual
convencion que `migrate.ts`/`run-ai-evaluation.ts`: `node dist/....js`, DI
manual, nunca registrado en `app.module.ts`. Entrenar no es una
responsabilidad del proceso HTTP de Combat, y levantarlo desde ahi haria
que cada replica intentara coordinar un lease a la vez sin necesidad.

## 4. Senales durables y cursores

Una sola coleccion singleton, `ai-training-coordinator` (`_id='default'`,
migracion `028-ai-training-coordinator.ts`), concentra cursor Y lease: cada
transicion es UNA escritura Mongo atomica, nunca dos escrituras que
pudieran quedar inconsistentes entre si.

- `requestedThrough`: avanza con `$max` (nunca retrocede) al maximo
  `finishedAt` observado entre las `BattleRoom` `FINISHED` que ya superaron
  un **periodo de gracia** (`--grace-period-ms`, default 5 min) --
  tiempo suficiente para que la telemetria best-effort de la partida
  (`CombatDecisionEvent`/`COMBAT_DECISION_OUTCOME`) probablemente ya este
  escrita. Esto NO es una garantia dura: es honesto documentar que una
  escritura excepcionalmente tardia (p. ej. una caida prolongada de Mongo)
  podria no estar disponible todavia cuando se la busca. Nunca queda
  permanentemente excluida: el dataset builder relee TODO el historico
  elegible hasta el cutoff en cada corrida, nunca solo "lo nuevo" -- un
  evento que llega tarde para el corte N aparece automaticamente en el
  corte N+1 (o cualquier corte posterior), simplemente porque la coleccion
  cruda es append-only y el builder nunca descarta el pasado.
- `processedThrough`: el cutoff REALMENTE usado por el ultimo run
  terminado (exitoso o `NOT_TRAINABLE`). Cuando `requestedThrough <=
processedThrough`, no hay trabajo pendiente (IDLE).

No se uso un booleano `new_data_pending=True` en memoria (#571 §5.1 lo
descarta explicitamente): no sobrevive a reinicios ni coordina varias
instancias. `requestedThrough`/`processedThrough` en Mongo si.

## 5. Coalescing

El algoritmo es, deliberadamente, el bucle principal del worker en si
(`continuous-training-worker.ts`): cada iteracion re-escanea
`BattleRoom.findFinishedSince`, avanza `requestedThrough`, y SOLO entonces
intenta reclamar el lease. Mientras un run esta en curso, cualquier
cantidad de partidas que terminen simplemente avanzan `requestedThrough` --
no reclaman lease, no disparan un segundo run. Cuando el run en curso
termina y libera el lease, la SIGUIENTE iteracion ve
`requestedThrough > processedThrough` (reflejando TODO lo que se acumulo
mientras tanto) y arranca un UNICO run coalescido que cubre todo el
historico elegible acumulado + las partidas nuevas. Nunca se ejecutan N+1
runs para N partidas nuevas durante un run.

## 6. Exclusion mutua y leases

```
ai-training-coordinator { leaseState, leaseOwnerId, fencingToken, leaseExpiresAt, heartbeatAt, ... }
```

- **Reclamo atomico**: `findOneAndUpdate({_id, $or:[{leaseState:'IDLE'},{leaseExpiresAt:{$lt:now}}]}, {$set:..., $inc:{fencingToken:1}})`.
  Mongo garantiza que, bajo dos intentos concurrentes, solo UNO ve su
  filtro coincidir (el primero en aplicarse invalida el filtro del
  segundo). Probado contra Mongo REAL con dos intentos concurrentes
  genuinos (`Promise.all`), no en memoria.
- **Heartbeat**: cada `--heartbeat-interval-ms` (default 60s, forzado a
  ser < 1/3 de `--lease-duration-ms`), `updateOne` filtrado por
  `{ownerId, fencingToken}` propios. `matchedCount===0` => el lease ya no
  es mio: me considero despojado, cancelo el subproceso en curso
  (`SIGTERM`) y jamas confirmo un resultado.
- **Fencing en cada escritura de resultado**: `recordSuccess`/
  `recordNotTrainable`/`recordFailure` filtran TAMBIEN por
  `{ownerId, fencingToken}`. Un propietario obsoleto que de alguna forma
  llega a esa linea nunca modifica el documento (la escritura no afecta
  ninguna fila) -- devuelven `false`, el worker lo trata como
  `LEASE_LOST`, nunca como exito confirmado.
- **Doble chequeo antes de tocar el Model Registry**: ademas del
  heartbeat, el pipeline vuelve a pedir `renewLease` explicitamente justo
  antes de `registry.startTraining()` y justo antes de
  `registry.registerCandidate()` -- el Model Registry es un sistema
  SEPARADO del coordinador, y su propia proteccion de integridad
  (`#570`) no sabe nada de leases; esta doble verificacion acota la
  ventana en la que un propietario que acaba de perder el lease podria
  escribir alli.

### Limite declarado (split brain, #571 §6.2)

Un lease distribuido, por si solo, **no mata un proceso PyTorch que ya esta
corriendo** en otro host. Si el host del propietario anterior se cuelga o
se particiona de la red (pero el proceso Python sigue vivo localmente), el
worker NUNCA podra matarlo de forma remota -- el `SIGTERM` del heartbeat
solo funciona si el MISMO proceso Node sigue vivo y puede ejecutar su
callback de perdida de lease sobre SU PROPIO subproceso hijo.

Lo que SI se garantiza, y esta probado contra Mongo real
(`mongo-continuous-training-coordinator.spec.ts`, CT-07..11): **ningun
propietario obsoleto puede publicar o confirmar un resultado** -- ni
"exitoso" ni "fallido" -- una vez que otro propietario reclamo el lease.
En el peor caso (host colgado, proceso Python huerfano), el resultado de
ESE entrenaming concreto simplemente nunca se confirma: el `trainingRunId`
determinista puede reintentarse limpio en una iteracion posterior,
sin ningun riesgo de dos candidatos incompatibles llegando al registry.

## 7. Dataset acumulado

`nexus-combat-dataset build --source mongo --cutoff <congelado>` relee
TODO el historico elegible de `combat-decision-events`/`mcts-teacher-labels`
hasta el cutoff en cada corrida (el builder ya funciona asi desde `#566`;
el worker no inventa un modo incremental). `battle-hash-split-v1`,
`feature-schema-v1`, `candidate-mlp-v1`, `teacher-policy-cross-entropy-v1`
se reutilizan sin tocar.

**Trainability**: antes de invocar `nexus-combat-train`, el worker lee
`manifest.json` (el dataset manifest real) y comprueba
`counts.{train,validation,test}Decisions > 0` -- el mismo criterio exacto
de `DatasetNotTrainableError` en Python (`training/dataset_loader.py`), sin
duplicar su logica de exclusion, solo reutilizando el campo que el
manifest YA expone. Si algun split esta vacio: `NOT_TRAINABLE`, el cutoff
se marca como `processedThrough` igualmente (para no reintentar
inutilmente el MISMO corte sin datos nuevos) y el worker nunca inventa
labels ni fabrica una `CANDIDATE` falsa.

**`MctsTeacherLabel` no es automatico**: auditado explicitamente
(`LiveMctsTeacherLabeler`, `MCTS_LIVE_TEACHER_LABELING_ENABLED`,
default `false` por costo real de CPU). El dataset builder ya falla
cerrado (`--allow-missing-labels` requerido explicitamente) si faltan
labels para decisiones ONLINE/TOURNAMENT -- el worker nunca pasa esa flag,
asi que un periodo sin MCTS en vivo simplemente se clasifica
`DATASET_BUILD_FAILED` (nunca una CANDIDATE con datos faltantes
disfrazados).

## 8. Identidad: `--emit-identity-only` (unica adicion a `ai/`)

`trainingRunId` es `${modelArchitectureVersion}-${sha256(datasetOutputFingerprint:trainingConfigSha256:seed)[:12]}`
(`train_model.py::_run_id`, ya existente). El issue pide registrar
`TRAINING` en el Model Registry ANTES de ejecutar PyTorch, pero
`datasetOutputFingerprint` solo se conoce DESPUES de construir el dataset,
y `trainingConfigSha256` depende de la serializacion canonica exacta de
`TrainingConfig` -- reimplementar ese calculo en TypeScript arriesgaria
exactamente la clase de bug que la revision de `#570` encontro (identidad
divergente entre dos implementaciones).

En vez de eso, `nexus-combat-train` ahora acepta `--emit-identity-only`:
reutiliza LITERALMENTE las mismas funciones (`_run_id`,
`TrainingConfig.fingerprint()`) que el entrenamiento real, se detiene
despues de cargar el dataset congelado (sin tocar PyTorch), e imprime
`{runId, trainingConfigSha256, datasetOutputFingerprint}` como JSON. El
worker llama esto, construye el `AiModelTrainingLineage`, llama
`registry.startTraining(lineage)`, y SOLO ENTONCES invoca el entrenamiento
real con el MISMO seed -- produciendo, por construccion, el mismo
`runId`. Probado explicitamente
(`test_emit_identity_only_matches_the_real_training_run_identity`,
`ai/tests/test_cli_train.py`): la identidad emitida coincide EXACTAMENTE
con la del entrenamiento real para el mismo dataset/seed.

`modelVersion = trainingRunId` siempre (nunca un UUID inventado, consistente con `#570`).

## 9. Integracion con el Model Registry (`#570`)

El worker nunca reimplementa las validaciones de `#570`: construye el
`AiModelTrainingLineage`/manifest y deja que `AiModelRegistry.registerCandidate`
haga su propio trabajo (recalculo de hashes, binding manifest<->lineage de
12 campos, rechazo de `SMOKE_TEST`, etc.). El worker SIEMPRE pasa
`--artifact-purpose CANDIDATE` -- nunca activa nada (`activate()` no se
llama jamas desde este worker; eso es `#572`).

**Decision deliberada**: este worker NUNCA llama `registry.reject(...)`
automaticamente ante un fallo de entrenamiento. `trainingRunId` es
determinista: si se rechazara automaticamente tras un fallo que
resultara ser transitorio, un reintento exitoso mas tarde con los MISMOS
insumos chocaria contra la transicion prohibida `REJECTED -> CANDIDATE`,
bloqueando esa identidad para siempre. Se prefiere dejar la version
abandonada en `TRAINING` (observable via `findByVersion`, nunca
bloqueante -- un reintento con el mismo dataset/seed es simplemente
idempotente en `startTraining`) a arriesgar un bloqueo permanente. Esto
es una limitacion conocida y deliberada: un barrido de limpieza de
`TRAINING` abandonados (basado en antiguedad) queda fuera de alcance de
esta Task.

## 10. Idempotencia y recuperacion

| Punto de interrupcion                                             | Comportamiento al reintentar                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antes de reclamar el lease                                        | Sin efecto; la siguiente iteracion vuelve a intentar.                                                                                                                                                                                                                                                                                                                              |
| Dataset construido, training no iniciado                          | Un reintento (nuevo proceso, mismo cutoff) reconstruye el MISMO dataset (determinista) y produce la MISMA identidad.                                                                                                                                                                                                                                                               |
| `registry.startTraining()` llamado, proceso cae antes de entrenar | La version queda en `TRAINING` (abandonada, ver §9). Un reintento con el mismo dataset/seed llama `startTraining` de nuevo: idempotente (mismo lineage), no-op.                                                                                                                                                                                                                    |
| ONNX escrito en disco, registry aun no actualizado                | El directorio de trabajo es temporal (`workRootDir`, borrado en el `finally`); un reintento regenera los artefactos deterministicamente.                                                                                                                                                                                                                                           |
| `registerCandidate` confirmado, cursor aun no actualizado         | `recordSuccess` solo se llama DESPUES de `registerCandidate` exitoso; si el proceso cae ANTES de esa llamada, el cursor queda sin avanzar, pero la version YA esta en `CANDIDATE` -- un reintento intentaria `startTraining`/`registerCandidate` de nuevo para el MISMO `modelVersion`: ambos son idempotentes para lineage/artifact identicos (`#570`), asi que no corrompe nada. |
| Cursor actualizado, worker cae inmediatamente despues             | Sin efecto: el siguiente arranque simplemente ve `processedThrough` ya al dia.                                                                                                                                                                                                                                                                                                     |
| Lease perdido a mitad de un run                                   | El heartbeat detecta la perdida (`renewLease` devuelve `false`), cancela el subproceso en curso, y el run se clasifica `FAILED`/`LEASE_LOST` sin tocar el registry ni el cursor con un resultado stale (ver §6).                                                                                                                                                                   |

## 11. Configuracion y variables de entorno

El worker reutiliza `MONGODB_URI`/`LOG_LEVEL`/`SERVICE_NAME`/`SERVICE_VERSION`
(mismo `loadConfig`/`createLogger` que el resto de Combat). Todo lo
especifico del worker es por flags de CLI, nunca variables de entorno
nuevas (ver §12).

## 12. Comandos para ejecutar el worker localmente

```bash
npm run build
MONGODB_URI="mongodb://localhost:27017" npm run train:continuous -- \
  --once \
  --ai-dir ../ai \
  --dataset-seed 42 \
  --training-seed 42
```

Flags disponibles: `--once`, `--max-iterations <n>`, `--ai-dir <path>`,
`--database-name <name>` (default `combat`), `--python-command <cmd>`
(default `uv`), `--dataset-seed`/`--training-seed <n>`, `--source-commit
<sha>` (si se omite, usa `git rev-parse HEAD`), `--grace-period-ms`,
`--lease-duration-ms`, `--heartbeat-interval-ms`, `--poll-interval-ms`,
`--dataset-build-timeout-ms`, `--training-timeout-ms`,
`--identity-timeout-ms`, `--work-root-dir`, `--backoff-base-ms`,
`--backoff-max-ms`. Sin `--once`, corre en bucle indefinido (poll +
backoff exponencial ante fallos), respondiendo a `SIGINT`/`SIGTERM` para
un apagado ordenado (termina la iteracion en curso, no acepta una nueva).

## 13. Recursos y limites

Sin medicion de topologia/recursos de produccion todavia (eso es
`#573`/`#574`): los timeouts de subprocesos (`--dataset-build-timeout-ms`,
`--training-timeout-ms`, `--identity-timeout-ms`) son configurables, no
hardcodeados "porque si", y existen para que un `uv run` colgado no
bloquee el worker indefinidamente -- `ChildProcessRunner` cancela
(`SIGTERM`) y rechaza con un error claro al expirar. El output
stdout/stderr capturado por subproceso esta acotado (2 MiB por stream por
defecto) para no crecer sin limite en una corrida larga.

## 14. Observabilidad

Eventos estructurados (`createLogger`, nunca `console.log` directo):
`continuous_training_worker_started/stopped`,
`continuous_training_requested_through_advanced`,
`continuous_training_lease_claimed/lost`,
`continuous_training_not_trainable`,
`continuous_training_identity_emitted`,
`continuous_training_registered_training`,
`continuous_training_candidate_registered`,
`continuous_training_run_failed`,
`continuous_training_iteration_success/failed/not_trainable`. Nunca se
registra `MONGODB_URI`, credenciales, ni payloads de telemetria sensibles
-- solo identificadores tecnicos (`modelVersion`, `ownerId`,
`fencingToken`, `reasonCode`, timestamps ISO). El estado real
(cursor/lease/ultimo resultado) vive en Mongo, no solo en logs.

## 15. Pruebas realizadas y evidencia real

- **Python** (`ai/tests/test_cli_train.py`): `--emit-identity-only`
  coincide exactamente con la identidad de un entrenamiento real para el
  mismo dataset/seed. 7/7 tests de ese archivo, 149/149 del paquete
  completo (`uv run pytest -q`), `ruff check`/`ruff format --check`
  limpios.
- **Unitarias** (`test/unit/dataset-manifest-v1.spec.ts`,
  `test/unit/continuous-training-pipeline.spec.ts`): parseo del dataset
  manifest, y la logica completa de UNA iteracion
  (`runContinuousTrainingIteration`) con un `ChildProcessRunner` FALSO --
  IDLE, LEASE_BUSY, NOT_TRAINABLE, exito feliz, clasificacion de fallos
  (`DATASET_BUILD_FAILED`, `TRAINING_PROCESS_FAILED`), y perdida de lease
  a mitad de un run (nunca confirma un resultado obsoleto).
- **Mongo real** (`test/db/mongo-continuous-training-coordinator.spec.ts`):
  11 pruebas, incluyendo las criticas de concurrencia (CT-07..11): dos
  reclamos concurrentes reales (`Promise.all`) con exactamente un
  ganador, lease expirado recuperable, fencing bloqueando renovacion y
  escritura de resultado de un propietario obsoleto, validador de Mongo
  rechazando un documento invalido.
- **Integrada de punta a punta** (`test/db/continuous-training-worker-e2e.spec.ts`):
  Mongo REAL (testcontainers) + `CombatDecisionEvent`/`MctsTeacherLabel`
  reales en forma (fixture CONTROLADO de
  `ai/tests/fixtures/training/*.jsonl`, el mismo que ya usan las pruebas
  de `#567`/`#568` -- identificado honestamente como sintetico, nunca
  presentado como telemetria de jugadores reales) + una `BattleRoom`
  `FINISHED` real + el worker completo (`runContinuousTrainingIteration`
  con `spawnChildProcess` REAL, nunca una fake) + `uv run
nexus-combat-dataset build --source mongo` REAL + `uv run
nexus-combat-train --emit-identity-only` REAL + `uv run
nexus-combat-train --artifact-purpose CANDIDATE` REAL (PyTorch real,
  ONNX real) + `AiModelRegistry` REAL sobre el MISMO Mongo. Resultado
  verificado: una version `CANDIDATE` real, con artefacto ONNX real
  almacenado y recuperable, `trainingSeed`/`datasetSeed` correctos, y el
  coordinador avanzado a `IDLE`/`processedThrough` correcto.

Comandos ejecutados (resultados reales, no afirmados sin evidencia):
`npm run lint`, `npm run format:check`, `npm run typecheck`,
`npm run test:unit`, `npm run test:integration`, `npm run test:db`,
`npm run test:coverage`, `npm run build`, `git diff --check`; en `ai/`:
`uv run ruff check .`, `uv run ruff format --check .`, `uv run pytest -q`.

## 16. Limitaciones conocidas

- Split brain entre hosts no se resuelve a nivel de proceso (§6, limite
  declarado explicitamente, no un descuido).
- `TRAINING` abandonado tras un fallo nunca se limpia automaticamente
  (§9, decision deliberada para proteger la idempotencia de identidad).
- `requestedThrough` depende de un periodo de gracia configurable, no de
  una garantia transaccional dura entre "la partida termino" y "su
  telemetria esta completamente escrita" (§4) -- documentado, nunca
  presentado como una garantia que no existe.
- Sin medicion de recursos de produccion (CPU/memoria del entrenamiento
  real bajo carga) -- `#573`/`#574`.

## 17. Que deja preparado para `#572`

Una version `CANDIDATE` real, con lineage completo y trazable, lista para
que `#572` (EvaluationHarness de `#569` + gates versionados) decida
automaticamente `PASS -> activate()` / `FAIL -> reject()`. Este worker
nunca evalua calidad ni decide promocion.

## 18. Que corresponde a `#573`/`#574`

Topologia de despliegue real del worker (contenedor/proceso dedicado,
recursos, escalado), medicion de uso de CPU/memoria bajo carga real, y
cualquier integracion funcional completa con Missions/Tournament.
