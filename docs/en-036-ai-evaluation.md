# EN-036.5 — Evaluación de políticas de IA con combates acelerados

Management [#569](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/569),
hijo de [EN-036 #555](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/555).
Depende de [EN-036.1 #565](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/565),
[EN-036.3 #567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567)
(ver [`en-036-neural-training.md`](en-036-neural-training.md)) y
[EN-036.4 #568](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/568)
(ver [`en-036-neural-runtime.md`](en-036-neural-runtime.md)).

## Objetivo

Comparar `RANDOM`, `RULE_BASED`, `MCTS` y `NEURAL` bajo el **mismo motor de
Combat y las mismas semillas**, midiendo comportamiento real (win rate,
daño, salud/Poder restante, turnos, fallos) — nunca accuracy/loss de
entrenamiento. Validar además que el `model.onnx` que corre en producción
(`onnxruntime-node`, #568) produce los mismos scores que el `model.pt`
que lo entrenó (#567).

**Esta Task mide y compara. No promueve.** Activar un modelo `CANDIDATE`
en producción es `EN-037` (`#570` y siguientes), no esta Task.

## Arquitectura: ningún motor nuevo

```
PolicyComparisonHarness
        │
EvaluationScenario (perfiles reales, 1v1)
        │
BattleRoom.create + join + generateTurnOrder + startBattle  (dominio REAL)
        │
  ┌─────┴─────┐
  │  bucle:   │
  │  LegalActionGenerator.generateAvailable(room)          ← REAL
  │  legalActions.length === 0 → simulation.applyEndTurn   ← REAL
  │  else: policy.decide(context) → resolveLegalAction      ← defensa en profundidad
  │        simulation.applyAction(room, actor, action, …)  ← REAL
  └─────┬─────┘
        │
InMemoryMctsSimulationAdapter
        │
ExecuteBasicAttack / UseSkill / UseEpic / CompleteBattleTurn  (casos de uso REALES)
        │
BattleRoom resultante → siguiente decisión → … → FINISHED
```

El harness **orquesta**; Combat **manda**. `InMemoryMctsSimulationAdapter`
(ya existente, usado por el teacher MCTS de `#565`) es la pieza que
garantiza esto: repositorio aislado por paso, sin publicar eventos, sin
persistir nada fuera del propio harness, pero ejecutando los **mismos**
`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`CompleteBattleTurn` que usa
producción. No existe un segundo motor, una `FakeCombatEngine` ni una
reimplementación simplificada del daño — habría violado CA-01.

Código: `src/evaluation/` (nunca registrado en `AppModule` — no es un
provider de Nest, no corre en el request path) y el CLI en
`src/infrastructure/evaluation/run-ai-evaluation.ts`.

## Policy adapters

`EvaluationPolicy` (`src/evaluation/policies/EvaluationPolicy.ts`) es una
abstracción **exclusiva del harness**, nunca productiva y nunca
implementada por `AiDecisionPort`:

```ts
interface EvaluationDecisionContext {
  room: BattleRoom
  state: BattleDecisionState
  legalActions: readonly LegalAction[]
  matchSeed: number
  decisionIndex: number
  side: 'A' | 'B'
}
interface EvaluationPolicy {
  readonly id: 'RANDOM' | 'RULE_BASED' | 'MCTS' | 'NEURAL'
  decide(context: EvaluationDecisionContext): Promise<LegalAction>
}
```

- **`RandomEvaluationPolicy`**: envuelve la `RandomPolicy` real sobre una
  `RandomSequencePort` propia del harness (nunca `Math.random()`, nunca el
  cursor de Combat ni el de MCTS).
- **`RuleBasedEvaluationPolicy`**: envuelve `RuleBasedPolicy` sin cambiar
  su comportamiento.
- **`MctsEvaluationPolicy`**: llama **directamente** a
  `MctsTeacher.teach(room, simulationSeed)` — MCTS necesita el
  `BattleRoom` completo, no solo el `BattleDecisionState` observable, así
  que nunca se le forzó a implementar `AiDecisionPort` (decisión ya tomada
  en `#565`/`#555`). `teacherResult.candidates` puede ser un **subconjunto**
  legítimo de `legalActions` (el filtro de curaciones no estratégicas de
  MCTS puede descartar candidatos sin que eso sea un error); el harness
  solo exige que `selectedAction` resuelva contra las `legalActions`
  **actuales**, nunca que `candidates` coincida con ellas.
- **`NeuralEvaluationPolicy`**: envuelve la `NeuralPolicy` **real** de
  `#568` directamente — **nunca** pasa por `DecisionPolicySelector`. Esa
  distinción es deliberada: el selector productivo cae a `RuleBasedPolicy`
  ante cualquier fallo de Neural, y si el harness usara el selector, un
  fallo real de Neural se reportaría falsamente como una decisión de
  `RULE_BASED`. Aquí, cualquier fallo (timeout, runtime caído, output
  inválido) se propaga tal cual y el runner lo registra como
  `NEURAL_TIMEOUT`/`NEURAL_RUNTIME_ERROR`/etc. — nunca se esconde.

## Aislamiento de semillas (`evaluation-seed-schedule-v1`)

Cada partida parte de un único `matchSeed` (entero uint32). Todo lo demás
se **deriva** vía SHA-256 (nunca RNG real), con un namespace explícito por
fuente — namespaces disjuntos, nunca comparten secuencia entre sí ni con
el cursor de Combat de una batalla real:

| Fuente                  | Derivación                                       | Alcance                            |
| ----------------------- | ------------------------------------------------ | ---------------------------------- |
| Combat RNG              | `derive("combat", matchSeed)`                    | Toda la partida, continua          |
| Orden de turnos         | `derive("turn-order", matchSeed)`                | Solo el inicio de la partida       |
| `RandomPolicy` por lado | `derive("random-policy", matchSeed, side)`       | Toda la partida, continua por lado |
| MCTS por decisión       | `derive("mcts", matchSeed, side, decisionIndex)` | **Una semilla nueva por decisión** |

MCTS nunca reutiliza la misma `simulationSeed` en dos turnos de la misma
partida, y sus rollouts internos (`deriveMctsRolloutSeed`, ya existente)
tampoco tocan el cursor de Combat ni el de `RandomPolicy`.

## Enfrentamientos espejados (`mirrorEnabled`)

Para cada `(escenario, matchup, matchSeed)`, dos partidas (`LEG_1`/`LEG_2`)
comparten `mirrorPairId` y raíz de semilla:

```
LEG_1: lado A = policy P, lado B = policy Q   (escenario: A usa loadout X, B usa loadout Y)
LEG_2: lado A = policy Q, lado B = policy P   (MISMO escenario: A sigue con X, B sigue con Y)
```

P y Q juegan **ambos lados** y **ambos loadouts** con la misma raíz de
semilla, reduciendo sesgo de lado y de loadout. El par nunca se
descarta a medias: ambas partidas se guardan siempre, aunque una falle.

## Escenarios (`evaluation-scenarios-v1`)

Cuatro escenarios, todos 1v1 (decisión técnica v1: simplifica la
atribución de métricas por lado sin necesitar agregarlas sobre varios
combatientes). Las estadísticas base (Vida 44/Ataque 10/Defensa 11/Daño
1d6) y cada habilidad/épica son las **mismas** ya auditadas en
`test/fixtures/basic-attack.ts`/`skills.ts`/`epic.ts` — nunca inventadas;
solo se duplican como datos planos en `src/evaluation/` porque
`tsconfig.build.json` excluye `test/` del `dist/` que corre el CLI
compilado.

| `scenarioId`           | Qué cubre                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `basic-attack-mirror`  | Solo `BASIC_ATTACK` disponible (sin habilidades ni Poder)                                               |
| `offensive-abilities`  | `BASIC_ATTACK` + 3 `ABILITY` reales (Embate, Tormenta, Loto), distintos costos de Poder                 |
| `support-vs-offensive` | Chamán sin Ataque (Canto del Bosque, `ALLIED_GROUP`) vs. ofensivo — soporte sin inventar `BASIC_ATTACK` |
| `epic-vs-offensive`    | Guerrero Tanque con una épica de daño directo equipada vs. ofensivo                                     |

No hay un escenario "tanque" con estadísticas base distintas: inventar una
línea base nueva (Vida/Ataque/Defensa) solo para variedad habría violado
la regla de no fabricar stats (#569 §35); la variedad real viene de
habilidades/épica/Poder, que sí están auditadas.

## Métricas: definiciones exactas

- **Daño**: `resolution.appliedDamage`/`damage.appliedDamage` de los
  eventos reales (`basicAttackResolved`, `skillUsed`,
  `directDamageSkillUsed`, `epicUsed` con `damage`) — nunca
  `calculatedDamage` ni la magnitud base. Reflejo (`REFLECT_DAMAGE`) no es
  un evento propio: se pliega en la `resolution`/`bonus` del siguiente
  ataque del atacante, así que **no es atribuible como categoría
  separada** desde el log de eventos — se documenta aquí en vez de
  inventar una atribución que el evento no sustenta.
- **Curación**: `heal.amount` de `healSkillUsed`/`epicUsed` — **nunca**
  cuenta como daño, categoría separada por diseño del propio contrato de
  eventos. Para curación de grupo, el monto es **por afectado** (nunca un
  total repartido).
- **Salud restante**: `BattleResult.teams[].remainingHealth/maxHealth`,
  autoritativo, nunca inferido de eventos — y `remainingHealth`/`maxHealth`
  **sí** son correctos leídos de la sala `FINISHED` (a diferencia del
  Poder, ver abajo): `BattleRoom.finish()` no toca la Vida.
- **Poder restante — la trampa documentada en `#565`**:
  `BattleRoom.finish()` ejecuta `restoreAllPower()` **antes** de construir
  el resultado. Leer Poder de una sala `FINISHED` siempre da el máximo,
  nunca el real. El harness sigue el Poder del actor PLY a PLY, leyendo
  `payload.power.after` de cada evento que lo paga
  (`EvaluationMetricsCollector`), exactamente el mismo patrón que ya usa
  `MctsSearch` para la misma limitación.
- **Turnos/plies**: `plies` cuenta cada paso del harness (incluye
  `SYSTEM_END_TURN`); `decisionCount` cuenta solo decisiones reales de
  política (nunca los fines de turno sin acciones legales) — nunca se
  mezclan bajo el mismo nombre.
- **Selecciones inválidas vs. rechazos del motor**: dos conceptos
  separados (#569 §55). `invalidPolicySelections` = una política eligió
  algo que no resuelve contra `legalActions` (`INVARIANT_VIOLATION`).
  `engineRejections` = una acción legal canónica fue rechazada por el
  motor real (`ENGINE_FAILURE`) — nunca debería pasar con `legalActions`
  generadas por el propio motor; si pasa, es una evidencia de bug real,
  no un resultado "normal" de evaluación.

## Fallos: por qué `POLICY_FAILURE` no es "derrota"

`NoStrategicMctsCandidatesError` (MCTS, cuando las únicas acciones legales
son curaciones ya innecesarias, `healthRatio >= 90%`) es un fallo
**legítimo y esperado**: se registra como `MCTS_NO_STRATEGIC_CANDIDATES`,
nunca se esconde cayendo a `RuleBasedPolicy` en silencio y reportándolo
como "MCTS". Un timeout o error real de `NeuralPolicy` se registra como
`NEURAL_TIMEOUT`/`NEURAL_RUNTIME_ERROR`. Ninguno de estos cuenta como
victoria/derrota/empate para ese lado — quedan en un bucket de `failures`
separado, con denominador explícito en cada tabla del reporte.

`MAX_PLIES` (tope de seguridad del harness, nunca una regla de Combat)
aparece sobre todo en `support-vs-offensive`: un sanador que siempre tiene
una acción legal (`Canto del Bosque`, `ALLIED_GROUP`) contra un ofensivo
cuyo daño por turno no siempre alcanza para ganar la carrera dentro del
tope — el harness lo **detecta y reporta** vía `MAX_PLIES`, nunca fabrica
un ganador. Esto es evidencia real sobre el balance de ese matchup/
escenario, no un defecto del harness.

## Paridad PyTorch ↔ ONNX

`ai/` genera `pytorch-parity-reference.json`
(`nexus-combat-parity-reference`, nuevo en esta Task) cargando el
`model.pt` real de un training run (`torch.load(..., weights_only=True)`),
verificando que su `modelStateSha256` recalculado coincide con el que
declara `training-manifest.json` (si no, falla: nunca una referencia de un
checkpoint distinto al declarado), y corriendo los 4 vectores de feature
**fijos** de los fixtures golden (`golden-basic-attack` +
`golden-multi-candidate`, agrupados en 2 casos batch).

El lado Node (`OnnxPytorchParityValidator.ts`) corre el **mismo**
`model.onnx` con `OnnxRuntimeNeuralInferenceAdapter` — el runtime REAL de
producción — y compara: `|onnx - pytorch| <= atol + rtol * |pytorch|`
(misma fórmula que `numpy.allclose`, `atol = rtol = 1e-5`, decisión
técnica v1 documentada, no exigida por el issue) **y** `argmaxAgreement
== 1` (un empate dentro de tolerancia que cambia qué candidato gana es una
divergencia real). **Nunca se instaló `onnxruntime` en Python**: la
paridad se valida contra el runtime real de Node, que es justamente lo
que corre en producción.

La paridad se valida **antes** de correr ninguna partida (`run-ai-
evaluation.ts`): si falla, el CLI aborta sin ejecutar combates — es un
quality gate técnico, no un warning.

## Outputs

- `matches.jsonl`: una línea JSON canónica (claves ordenadas, sin
  espacios) por partida, orden estable (`matchupId` → `scenarioId` →
  `matchSeed` → `mirrorLeg` → `matchId`).
- `summary.json`: machine-readable — versión/purpose/sourceCommit, modelo
  (`modelStateSha256`/`onnxArtifactSha256`/`artifactPurpose`), paridad,
  estadísticas por política y por matchup (+ por escenario), y
  fingerprints (`evaluationConfigSha256`/`seedSetSha256`/`matchesSha256`).
- `summary.md`: la misma información en tablas Markdown, con un
  **aviso obligatorio** en la cabecera si `artifactPurpose == SMOKE_TEST`.
- `evaluation-config.json` / `parity-report.json`: la configuración exacta
  y el reporte de paridad de esa corrida.

Ninguno de estos se versiona (`.gitignore`: `evaluation-out/`,
`ai/evaluation-out/`, `*.evaluation.jsonl`) — son miles de resultados por
corrida FULL.

## SMOKE vs. FULL

- **`SMOKE_TEST`**: pocas semillas (CI usa 2 + 2 de MCTS), MCTS con
  rollouts reducidos (8 en vez de 128) — prueba de ingeniería, nunca
  evidencia de calidad. El job `ai-evaluation-smoke` de CI lo corre en
  cada PR, incluyendo una segunda corrida para verificar
  `matchesSha256` idéntico (reproducibilidad real, no asumida).
- **`FULL_EVALUATION`**: miles de partidas con políticas baratas
  (Random/RuleBased/Neural), MCTS con su propia muestra (más cara, nunca
  reduce rollouts para poder decir "miles") y `MCTS_TEACHER_V1_CONFIG`
  real (128 rollouts, profundidad 6) salvo que se declare explícitamente
  lo contrario.

### Cómo correr

```bash
npm run evaluate:ai -- \
  --artifact-dir /ruta/al/run-de-nexus-combat-train \
  --output ./evaluation-out/run-001 \
  --purpose FULL_EVALUATION \
  --seed-start 3000000 \
  --seed-count 200 \
  --mcts-seed-count 25 \
  --max-plies 500 \
  --source-commit <sha>
```

El `--artifact-dir` debe contener `model.onnx`, `training-manifest.json` y
`pytorch-parity-reference.json` (generado con `uv run nexus-combat-
parity-reference --artifact-dir <mismo dir> --output <dir>/pytorch-
parity-reference.json` dentro de `ai/`). `--skip-expensive-mcts` omite los
3 matchups con MCTS marcándolos `SKIPPED_COST` en el reporte — nunca
0 partidas silenciosas.

## Qué SÍ demuestra esta evaluación (y qué NO)

**Sí demuestra**: que el harness compara las 4 políticas sobre el motor
real sin salirse nunca de `legalActions`, que los resultados son
reproducibles byte a byte con la misma configuración/semillas, y que
`model.onnx` (producción) coincide numéricamente con `model.pt`
(entrenamiento) dentro de tolerancia documentada.

**No demuestra** que el modelo Neural actual esté listo para producción:
el único artefacto disponible hoy tiene `artifactPurpose = SMOKE_TEST`
(entrenado con fixtures sintéticas, `#567`). Un resultado donde Neural
pierde contra RuleBased **no es un fallo del harness** — es una medición
real sobre un modelo de smoke. La promoción de un modelo `CANDIDATE` real
a producción, el model registry (`TRAINING`/`CANDIDATE`/`EVALUATING`/
`ACTIVE`/`REJECTED`) y cualquier umbral de calidad quedan para `EN-037`
(`#570` en adelante) — esta Task nunca los implementa ni los inventa.
