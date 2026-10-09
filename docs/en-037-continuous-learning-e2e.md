# EN-037.5 — Validación E2E del aprendizaje continuo, promoción automática y recuperación ante fallos

Management [#574](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/574),
hijo de [EN-037 #556](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/556).
Valida que los componentes YA implementados por #570 (Model Registry), #571
(Continuous Training Worker), #572 (Automatic Evaluation/Promotion) y #568/#569
(NeuralPolicy/Evaluation Harness) funcionan **conectados**, de punta a punta,
sobre MongoDB y Python/PyTorch reales — nunca reimplementa su lógica de negocio.

Rama: `test/en-037-5-continuous-learning-e2e` (base `develop`, Combat
`7c6126a`, Infrastructure `1c8bbdc` en el momento de crear la rama).

## 1. Objetivo y principio del proyecto

> La IA decide. Combat manda. Missions coordina.

Esta Task no modifica el motor de combate, las fórmulas, el RNG, la tabla de
8000 ni la arquitectura de MCTS/MLP. Solo añade **pruebas y utilidades de
validación** sobre el pipeline existente, y corrige dos defectos reales de
prueba (nunca de producto) encontrados al ejecutarlo de punta a punta por
primera vez con MongoDB y Python reales simultáneamente.

## 2. Matriz de auditoría (qué existía, qué faltaba)

| Componente     | Prueba existente (real)                                                                                  | Integración real end-to-end                            | Brecha que cierra #574                                        |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Partida        | `test/db/hu-93-human-vs-ai.e2e.spec.ts` (HTTP+WS+Mongo real, sin IA continua)                              | No alimentaba el pipeline de aprendizaje                 | `continuous-learning-telemetry.e2e.spec.ts` (nuevo)             |
| Telemetría     | Fixtures JSONL sintéticos en `continuous-training-worker-e2e.spec.ts`                                      | Nunca desde una partida HTTP/WS real                     | idem, con `MCTS_LIVE_TEACHER_LABELING_ENABLED=true` real        |
| Dataset        | `nexus-combat-dataset build` probado con Python/pytest y con el fixture JSONL                              | Nunca sobre telemetría generada en vivo                  | idem — entrenabilidad decidida honestamente, nunca fabricada    |
| Trainer        | `continuous-training-worker-e2e.spec.ts` (Mongo+Python reales) → `CANDIDATE`                               | Se detiene en `CANDIDATE`, nunca sigue a evaluación       | `verify-continuous-learning-e2e.ts` (nuevo) continúa la cadena  |
| Registry       | `mongo-ai-model-registry.spec.ts` (Mongo real, sin Python ni ONNX real)                                    | Hashes/CAS probados, nunca con artefactos recién entrenados | idem — artefactos del training real de arriba                |
| Evaluación     | `verify-automatic-model-promotion-e2e.ts` (ONNX real, pero `InMemory*` y parte de un `artifactDir` dado)   | Nunca Mongo real, nunca partiendo del training real       | idem — `Mongo*Repository` real, candidata producida por el pipeline real |
| Promoción      | `automatic-model-evaluation-coordinator.spec.ts` (unit, fixtures de `EvaluationSummary`)                    | Mecánica de transición ya probada, nunca con gates reales corriendo | idem — gates reales, resultado honesto (ver §6)         |
| Runtime        | `active-model-provider.spec.ts` (unit, ONNX mockeado)                                                      | Nunca con un ONNX real cargado via `ActiveModelProvider`  | idem — hot reload real si promueve; fail-safe real con ONNX inválido (§7) |
| Recuperación   | `mongo-continuous-training-coordinator.spec.ts` / `mongo-ai-evaluation-coordinator.spec.ts` (lease/fencing, Mongo real) | Coalescing solo probado con `ChildProcessRunner` falso (unit) | `continuous-learning-coalescing.e2e.spec.ts` (nuevo) — Mongo+Python reales |

## 3. Arquitectura de las pruebas nuevas

Ninguna de las piezas nuevas reimplementa lógica de negocio; todas invocan
directamente las funciones productivas (`runContinuousTrainingIteration`,
`processNextAutomaticEvaluation`, `ActiveModelProvider`, `AiModelRegistry`)
contra MongoDB real (`@testcontainers/mongodb`) y Python real (`uv run
nexus-combat-dataset`/`nexus-combat-train`/`nexus-combat-parity-reference`).

**Restricción técnica real descubierta y respetada** (no documentada antes
para este caso de uso): el sandbox VM de Jest crea un `Float32Array` distinto
al que el addon nativo `onnxruntime-node` valida internamente — por eso
`verify-automatic-model-promotion-e2e.ts` (#572) ya corre fuera de Jest. Toda
prueba nueva que necesite **inferencia ONNX real** (evaluación automática,
`ActiveModelProvider.refresh()`/`decide()`) hereda esa misma restricción:

```text
test/db/continuous-learning-telemetry.e2e.spec.ts     (Jest)  — partida real -> telemetria -> dataset/training
test/db/continuous-learning-coalescing.e2e.spec.ts    (Jest)  — coalescing real durante un training real
src/infrastructure/evaluation/verify-continuous-learning-e2e.ts (standalone, node real)
  — training real -> CANDIDATE -> evaluacion automatica REAL (ONNX real)
    -> PROMOTED/REJECTED -> hot reload o fallback real -> E2E-11 (ONNX invalido)
```

Comando para el standalone (igual patrón que `test:e2e:en-037`):

```bash
npm run build
npm run test:e2e:en-037-5
```

Nunca se ejecuta contra AWS ni contra el MongoDB de producción. Ambos Jest
specs se omiten (`describe.skip`, nunca "paso sin ejecutarse") si `uv` no está
en `PATH`, igual que `continuous-training-worker-e2e.spec.ts`; el standalone
hace lo mismo y retorna temprano con un mensaje explícito.

## 4. Fase A/B — partida real, telemetría real, dataset honesto

`continuous-learning-telemetry.e2e.spec.ts` arranca el `AppModule` completo
(HTTP + WebSocket + Mongo real, mismo patrón que HU-93.4) con
`NEURAL_POLICY_ENABLED=true` **y** `MCTS_LIVE_TEACHER_LABELING_ENABLED=true`
desde el inicio, sobre una base sin ningún `ACTIVE` todavía. Juega varias
partidas PVE reales (la IA abre y gana en un turno) y comprueba:

- Cada partida produce exactamente 1 `CombatDecisionEvent` real.
- La fuente real registrada es `RULE_BASED` — evidencia observable, no solo
  de tipo, de que `DecisionPolicySelector` cayó al fallback fijo porque
  `ActiveModelProvider.decide()` lanza con `current === null` (Escenario
  **E2E-19**, "sin ACTIVE válido", nunca una ruta separada construida para
  esta prueba).
- Cada decisión recibe, en vivo, su `MctsTeacherLabel` correlacionado por
  `eventId`, sin duplicados (Escenario **E2E-01/E2E-02**).
- Se invoca el pipeline REAL de EN-037.2 (`runContinuousTrainingIteration`,
  Mongo + Python reales) sobre esa telemetría real — nunca sobre el fixture
  JSONL de EN-037.2 — y se acepta honestamente el resultado real: con pocas
  partidas, el split `battle-hash-split-v1` deja casi siempre
  `validationDecisions`/`testDecisions` en 0, y el pipeline devuelve
  `NOT_TRAINABLE` **sin registrar ninguna candidata falsa** (Escenario
  **E2E-03/E2E-04**).

**Hallazgo real documentado, no un defecto de esta prueba**: el etiquetado
MCTS en vivo (`LiveMctsTeacherLabeler.persist`) es fire-and-forget y
best-effort por diseño (§15 de ese archivo) — en ejecuciones rápidas y
consecutivas (varias partidas sin espaciado realista entre sí) se observó
ocasionalmente (~1 de cada 5 partidas en esta prueba) un `MongoServerError`
transitorio al persistir un label, logueado como
`mcts_teacher_label_generation_failed` y **nunca propagado al gameplay**. La
prueba nunca fabrica el label que faltó: descarta esa partida del conteo y
juega una de reemplazo, documentando el límite de reintentos. Si ese label
faltante queda en la base (de una ejecución anterior) al llamar al dataset
builder real, el resultado honesto puede ser `FAILED`/`DATASET_BUILD_FAILED`
en vez de `NOT_TRAINABLE` — exactamente el comportamiento fail-closed que
`docs/en-037-continuous-training-worker.md` ya documenta (el worker nunca
pasa `--allow-missing-labels`), y la prueba lo acepta como resultado válido
en vez de ocultarlo.

## 5. Fase C — coalescing real (E2E-05/06/16)

`continuous-learning-coalescing.e2e.spec.ts` reutiliza el fixture JSONL de
EN-037.2 y envuelve `spawnChildProcess` REAL (nunca lo sustituye): justo
antes de que el pipeline invoque el proceso Python de entrenamiento (el
tramo más largo de una iteración real), inserta 2 partidas nuevas en Mongo —
reproduciendo honestamente la condición de carrera de producción (lo único
que varía es el momento relativo de la escritura, nunca la lógica bajo
prueba). Resultado real confirmado:

- El `CANDIDATE` resultante queda con el `datasetCutoff` de la partida
  original — las 2 tardías **nunca** se incorporan a esa versión.
- `processedThrough` tras `recordSuccess` queda en `requestedThrough +
gracePeriodMs` (nunca el `finishedAt` crudo — ver §8).
- Una segunda iteración, con el watermark devuelto por la primera,
  **descubre** las 2 partidas tardías (`requestedThrough` avanza hasta
  alcanzarlas) — ninguna partida nueva se pierde.

## 6. Fase D/E/F/G — training real, evaluación real, promoción/rechazo real

`verify-continuous-learning-e2e.ts` entrena sobre el mismo fixture JSONL
honesto de EN-037.2 (nunca telemetría de jugadores reales — documentado como
tal, igual criterio que #571) con `Mongo*Repository` reales de punta a punta
(a diferencia de `verify-automatic-model-promotion-e2e.ts`, que usa
`InMemory*` y parte de un `artifactDir` ya construido). Ejecución real
representativa:

```text
modelVersion:            candidate-mlp-v1-4f148b11f7b4
trainingRunId:            = modelVersion
trainingSeed / datasetSeed: 7 / 42
trainingSourceCommit:     continuous-learning-e2e-v1
evaluationId:              eval-continuous-l-<hash>-FULL_EVALUATION-seed3000000x10
promotionPolicyVersion:    promotion-policy-v1
totalMatches evaluados:    240 (seedCount=10, mctsSeedCount=3, skipExpensiveMcts=true)
invariantViolations / engineFailures: 0 / 0
```

Gates reales (`ai_promotion_policy_evaluated`):

| Gate                    | Resultado                                          |
| ------------------------ | --------------------------------------------------- |
| EVIDENCE_COMPLETENESS    | **FAIL** — partidas no completadas (`MAX_PLIES`) en ambos matchups |
| SAFETY                   | PASS — 0 selecciones ilegales, 0 rechazos del motor |
| PARITY                   | PASS — PyTorch↔ONNX, `argmaxAgreement=1`             |
| PERFORMANCE_VS_RANDOM    | FAIL — winRate=58.23 % (umbral 60 %)                |
| PERFORMANCE_VS_RULE_BASED| PASS — winRate=85.71 % (umbral 50 %)                |
| NON_REGRESSION_VS_ACTIVE | PASS — vacuously (sin ACTIVE previo)                |

**Resultado: `REJECTED`, honesto y esperado** (Escenario **E2E-08**). El
modelo entrenado sobre el fixture mínimo de EN-037.2 (unas pocas partidas
sintéticas, pensadas para probar infraestructura, no competitividad) no
tiene por qué superar `promotion-policy-v1` — el propio enunciado de #574 lo
anticipa explícitamente y prohíbe forzar un `PASS`. Esta prueba **nunca**
relajó los umbrales, aumentó artificialmente las muestras con datos
inventados, ni cambió la política para conseguir una promoción.

**Camino `CANDIDATE → ACTIVE` (E2E-09/E2E-10)**: la *mecánica* de esa
transición (gates reales evaluados, CAS de `AiModelRegistry`, hot reload de
`ActiveModelProvider` sin reiniciar Combat) ya está probada de forma
controlada y así clasificada por `verify-automatic-model-promotion-e2e.ts`
(#572) y `automatic-model-evaluation-coordinator.spec.ts` (unit, fixtures de
`EvaluationSummary` con PASS). #574 exige reportar el bloqueo con evidencia
real en vez de fabricar una promoción, y eso es lo que este documento hace:
**pendiente de un dataset de entrenamiento genuinamente más grande/competente
(alcance de EN-036, no de #574)** para observar un `PROMOTED` real de punta a
punta. No se intentó "ajustar" la evaluación (más seeds, más plies) para
forzar un PASS más allá de una comprobación razonable de que el bloqueo no
era un artefacto de una muestra demasiado pequeña — con `seedCount=10` y
`maxPlies=500` el resultado (incluido el fallo de completitud por
`MAX_PLIES`) se mantuvo estable.

## 7. Fase I — ONNX inválido nunca se instala (E2E-11)

En una base Mongo aislada (nunca la del training real de arriba),
`verify-continuous-learning-e2e.ts` registra honestamente un artefacto cuyo
contenido ONNX es inválido (bytes arbitrarios, nunca un protobuf real) pero
cuyo SHA-256 es el REAL de esos bytes — nunca se le miente el hash a
`AiModelRegistry`. Pasa por `TRAINING → CANDIDATE → EVALUATING → ACTIVE` via
las primitivas del propio registro (nunca `promoteEvaluatedCandidate`, que
exige evidencia real de gates), simulando honestamente que, por la vía que
sea (corrupción en reposo, intervención manual, un bug en otro componente),
un artefacto con integridad de **hash** consistente pero contenido inválido
llegó a `ACTIVE`.

Resultado real:

```text
ai_model_activation_failed { reason: "El runtime de inferencia ONNX no esta
disponible: Load model from .../model.onnx failed: Protobuf parsing failed." }
```

`ActiveModelProvider.refresh()` **no** instaló ninguna política: `current`
permanece `null`, el error queda logueado de forma estructurada, y una
llamada a `decide()` sigue lanzando el mismo error documentado de "ningún
modelo ACTIVE cargado todavía" — nunca una decisión servida con pesos
inválidos. Esto demuestra exactamente la distinción que #574 §13 pide:
integridad de bytes (hash) **no** es lo mismo que validez de contenido
(ONNX real); esta última la exige `ActiveModelProvider`, nunca el registro.

## 8. Defectos reales encontrados y corregidos (nunca de producto)

Ejecutar por primera vez la cadena completa con Mongo y Python reales
simultáneos — en vez de solo sus piezas por separado — encontró dos defectos
de **prueba**, ninguno de código productivo:

1. **`test/db/continuous-training-worker-e2e.spec.ts`** (EN-037.2,
   preexistente) asumía `processedThrough === finishedAt` crudo. El código
   productivo (`ContinuousTrainingPipeline.ts`) calcula deliberadamente
   `cutoff = min(requestedThrough + gracePeriodMs, startedAt)` — el `Mongo
   MctsTeacherLabel`/`CombatDecisionEvent` se persisten de forma asíncrona
   tras `finishedAt`, así que el cutoff real siempre lleva el margen de
   gracia sumado. La aserción nunca se había ejecutado en CI (el job
   "Calidad y pruebas" omite `uv`/Python a propósito; esta suite se
   autoexcluye allí) — solo se detectó al correrla localmente con ambos
   stacks presentes, exactamente la combinación que #574 exige. Corregido:
   la aserción ahora compara contra el cutoff real (`finishedAt +
   gracePeriodMs`), documentado inline.
2. **Guardas arquitectónicas estáticas de HU-21/HU-17**
   (`test/unit/hu-21-finish-guards.spec.ts`,
   `test/unit/hu-17-no-alternative-randomness.spec.ts`): el nuevo script de
   #574 necesitaba una `BattleRoom` ya cerrada (para que el pipeline tenga un
   `finishedAt` del que avanzar su watermark) y SHA-256 real (para el
   fixture de ONNX inválido de §7). En vez de construirla a mano en `src/`
   (lo que habría violado la invariante "el cierre del agregado solo se
   invoca desde `BattleRoom.ts`"), el script reutiliza el fixture
   `finishedRoom()` ya existente en `test/fixtures/battle.ts` — exactamente
   el mismo patrón que `continuous-training-worker-e2e.spec.ts` ya usa. El
   nuevo archivo se añadió a la lista explícita y documentada de usos
   legítimos de `node:crypto` (hashing de integridad, nunca una fuente de
   azar), con la misma justificación que `verify-automatic-model-promotion-e2e.ts`
   ya tiene.

Ambos son correcciones mínimas, con trazabilidad inline, y la suite completa
de unit (3492 pruebas) y los specs de `test/db` relacionados vuelven a pasar
en verde tras aplicarlas.

## 9. Lo que #574 deja pendiente, honestamente

- **Un `CANDIDATE → ACTIVE` real de punta a punta** requiere un dataset de
  entrenamiento genuinamente mayor/más competitivo que el fixture mínimo de
  EN-037.2 — alcance de EN-036 (calidad del modelo), no de esta Task.
- **La medición de recursos reales en AWS (nodo `app` Graviton)** sigue
  siendo responsabilidad de #573, nunca de #574 — esta validación es
  deliberadamente local y aislada (Mongo efímero, nunca AWS ni Mongo de
  producción).
- **Fencing con dos trainers/evaluadores reales simultáneos (E2E-13/E2E-14)**
  y **caída a mitad de la promoción (E2E-15)** ya tienen cobertura real de
  Mongo (lease/fencing/CAS) en `mongo-continuous-training-coordinator.spec.ts`
  y `mongo-ai-evaluation-coordinator.spec.ts` (preexistentes) — #574 no
  encontró una brecha adicional que justifique duplicar esa cobertura con un
  segundo proceso Node real.
- **Trainer/evaluador caídos (E2E-17/E2E-18)**: ya se demuestran por
  construcción arquitectónica, no por una prueba dedicada —
  `continuous-training-worker.ts`/`automatic-evaluation-worker.ts` son
  procesos standalone, nunca registrados en `app.module.ts`; toda partida de
  `continuous-learning-telemetry.e2e.spec.ts` se completa sin que ninguno de
  los dos esté corriendo, y una `CANDIDATE` pendiente nunca toca el `ACTIVE`
  vigente (comprobado explícitamente antes de evaluar, §6).

## 10. Relación con #573 y el Enabler #556

Esta Task valida el pipeline en aislamiento local — nunca sustituye la
validación de capacidad/despliegue de #573 en el nodo `app` real. No se
ejecutó `terraform plan`/`apply`, no se desplegó en AWS, no se modificó el
`ACTIVE` real ni ninguna infraestructura viva. El Enabler #556 sigue abierto
mientras #573 conserve pendientes operacionales propios.

## 11. Validaciones ejecutadas

```bash
npm run typecheck     # OK
npm run lint          # OK
npm run format:check  # OK (tras `npm run format` sobre los archivos nuevos)
npx jest --selectProjects unit                                      # 3492/3492 OK
npx jest --config jest.db.config.ts test/db/continuous-learning-telemetry.e2e.spec.ts     # OK
npx jest --config jest.db.config.ts test/db/continuous-learning-coalescing.e2e.spec.ts    # OK
npx jest --config jest.db.config.ts test/db/continuous-training-worker-e2e.spec.ts        # OK, regresión ver §8
npx jest --config jest.db.config.ts test/db/mongo-ai-model-registry.spec.ts               # OK
npx jest --config jest.db.config.ts test/db/mongo-ai-evaluation-coordinator.spec.ts       # OK
npm run build && npm run test:e2e:en-037-5                                                # OK, standalone, ver §6/§7
```

Ejecutado en local con Node 24, `uv` 0.9.17, Docker (MongoDB 8.0 via
testcontainers) y PyTorch CPU 2.14.1 reales — nunca simulado ni mockeado
donde este documento dice "real".

**Límite honesto de esta validación**: se intentó además una corrida completa
de `npm run test:db` (los 21 specs de `test/db/`) como regresión amplia. Las
21 suites fallaron de forma IDÉNTICA — incluidas specs que esta Task nunca
tocó — con `MongoDBContainer.start()` agotando el timeout de Testcontainers;
`docker ps` mostró, en paralelo, una pila completa de ~20 contenedores de
microservicios (`combat`, `catalog`, `wallet`, `postgres`, etc., ya en
ejecución por ~15 minutos, ajena a esta sesión) saturando los recursos de
Docker Desktop. Esto es contención de entorno, nunca una regresión de este
cambio: cada spec directamente relevante (arriba) ya se había verificado en
verde individualmente ANTES de que esa pila arrancara. No se repitió la
corrida completa para no competir por recursos con trabajo ajeno en curso;
se documenta como limitación en vez de reportar un falso verde o un falso
rojo.
