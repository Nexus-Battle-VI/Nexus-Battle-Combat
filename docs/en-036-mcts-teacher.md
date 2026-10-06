# EN-036.1 — Teacher MCTS (`BattleUtilityEvaluator` + `MctsSearch` + `MctsTeacher`)

Esta Task construye un "teacher" de Monte Carlo Tree Search (UCT) que genera, simulando el motor REAL de Combat sobre clones aislados, decisiones/etiquetas fuertes y reproducibles para el actor raíz de una batalla. **No es productiva**: `DecisionPolicySelector` sigue exactamente igual que en HU-93.2 (`primary: null`, `fallback: RuleBasedPolicy`); nada en `app.module.ts` inyecta `MctsSearch`/`MctsTeacher`. Tampoco entrena PyTorch ni exporta ONNX: eso es EN-036.2/#566, que puede apoyarse en `MctsTeacherResult` una vez esta Task lo deja reproducible.

Revisión de PR#80 (2026-10-05): se encontraron y corrigieron varios defectos reales antes del merge. Este documento ya refleja el diseño corregido; la sección "Historial de la revisión" al final resume qué cambió y por qué.

## Qué es requisito y qué es decisión técnica v1

**REQUISITO** (de la Task #565 y de su parent EN-036 #555, no reinterpretable):

- La utilidad es `U = 0.60·W + 0.15·H + 0.10·P + 0.15·D`, con cada componente y `U` recortados a `[0,1]`.
- `MctsSearch` debe simular con el motor autoritativo de Combat (`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`CompleteBattleTurn`), nunca un segundo motor aproximado.
- El RNG de cada simulación debe estar aislado del stream productivo (`BATTLE_RANDOM_SEQUENCE`), y el teacher nunca conoce el próximo valor real de una batalla productiva.
- Una acción cuyo efecto principal sea curación solo entra como candidata ESTRATÉGICA cuando algún receptor tiene `healthRatio < 0.90` (regla de salud de #555). No cambia la legalidad real de Combat.
- MCTS nunca es la política productiva de JcE.

**DECISIÓN TÉCNICA V1** (elegida en esta Task; revisable sin tocar el contrato anterior):

1. **Árbol de un solo nivel.** UCT reparte los `rollouts` entre las acciones legales (estratégicas) del actor raíz; TODO lo que ocurre después de esa primera acción — el resto del propio turno, los turnos del rival, cualquier turno posterior del actor raíz dentro del mismo rollout — se juega con `RuleBasedPolicy`, nunca se vuelve a buscar. (Una versión anterior de este PR mantenía un árbol más profundo cuyas aristas, una vez expandidas, **congelaban** el resultado aleatorio de la primera vez que se jugaron: el mismo acierto/crítico/daño se reutilizaba en cada visita posterior a esa arista. En un motor estocástico eso sesga el teacher hacia lo que haya salido en el primer muestreo — ver "Historial de la revisión". Con un solo nivel, CADA rollout vuelve a aplicar la acción elegida con la secuencia de ESE rollout: nunca se reutiliza una transición ya muestreada.)
2. **La expansión (primera visita) de cada candidata sigue el orden de `legalActionIdentity`** (determinista). El único azar de toda la búsqueda es el que consume el motor real a través de la secuencia aislada de cada rollout; MCTS no inventa un sorteo propio para decidir qué explorar primero.
3. **W** (resultado terminal): victoria del equipo raíz = `1`, derrota = `0`. Un estado aún no terminal (truncado por `maxDepthPlies`) y un empate terminal (`winnerTeamLabel: null`, posible en una sala `FINISHED`) comparten el mismo valor neutral `0.5`: ninguno de los dos favorece ni penaliza al actor raíz.
4. **P** (Poder propio): si el actor NO tiene sistema de Poder (`profile.maxPower === undefined`), se usa el valor neutral `1`. Si lo tiene, el valor SIEMPRE viene del seguimiento ply a ply que hace `MctsSearch` durante la trayectoria (ver más abajo), nunca de leer `room.battle` directamente en la hoja final.
5. **D** (progreso de daño): `1 − Σ Vida_actual / Σ Vida_máxima` de TODOS los enemigos del equipo raíz (vivos y muertos), fijado desde la perspectiva del equipo raíz al iniciar la búsqueda. Sin enemigos en absoluto, `D = 1` (en vez de dividir por cero). Un enemigo muerto sigue aportando su `maxHealth` al denominador — excluirlo (como hacía una versión anterior) hacía que matar a un enemigo de un equipo de 2+ no moviera `D` nada.
6. **Semillas de rollout**: `deriveMctsRolloutSeed(rootSeed, index)` es un mezclador entero determinista (estilo splitmix32), sin `node:crypto`. El único precedente del repositorio (`HmacMissionSeedFactory`) resuelve un requisito de _imprevisibilidad_ (antifraude de Misiones) que aquí no existe; solo se necesita independencia estadística entre rollouts, y un mezclador puro además evita que `src/domain/policies/` (donde vive, junto al resto de políticas puras) dependa de infraestructura.
7. **Sin wiring en `app.module.ts`**: ninguna ruta HTTP/WS/cron consume `MctsSearch`/`MctsTeacher`; el tooling de teacher/dataset (futuro #566) los construye directamente, igual que los tests.
8. **"Efecto principal" de una habilidad/épica** = su PRIMER efecto declarado (orden de Catalog). Decide si una acción es "principalmente curación" para la regla de salud del punto 8 de los requisitos.

## Arquitectura

- `BattleUtilityEvaluator` (`src/domain/policies/`): función pura `evaluateBattleUtility(outcome, actor, enemies)`. No conoce `BattleRoom` ni ningún puerto; el llamador extrae vitales y decide `outcome`.
- `extractUtilityVitals(room, rootActor)` (`src/application/services/MctsSearch.ts`): lee Vida/Poder del actor raíz y Vida de TODOS los enemigos directamente de `room.battle.turnOrder`/`combatantFor`, sin pasar por `BattleDecisionStateAssembler` (atado a "de quién es el turno").
- `filterStrategicCandidates(room, actor, legalActions)` (`src/application/services/MctsStrategicCandidateFilter.ts`): implementa la regla de salud (umbral `0.90`) sin tocar la legalidad real; si filtrar dejara la lista vacía, devuelve las acciones originales (nunca deja a MCTS sin nada que explorar).
- `MctsSimulationPort` (`src/application/ports/`) + `InMemoryMctsSimulationAdapter` (`src/adapters/outbound/system/`): cada llamada (`applyAction`/`applyEndTurn`) crea, para ESE paso, un `InMemoryBattleRoomRepository` nuevo sembrado solo con el clon recibido, e instancias nuevas (nunca las DI de producción) de los casos de uso reales. Cada resultado incluye el `BattleEvent` persistido, que `MctsSearch` usa para seguir el Poder del actor raíz (ver más abajo). Los `commandId` de simulación usan el namespace `mcts:<rollout>:<ply>`, que nunca colisiona con un `commandId` real (fingerprint SHA-256 sin `:`).
- `MctsSearch` (`src/application/services/`): UCT de un solo nivel (ver decisión técnica 1), con `score = explotación + C·√(ln(N_total)/N_candidata)`. Expone `search(room, config, simulationSeed): Promise<MctsTeacherResult>`.
- `MctsTeacher` (`src/application/services/MctsTeacher.ts`): entrada pública del teacher. **Deliberadamente NO implementa `AiDecisionPort`** (ver "Gap formal con #566" más abajo). Expone un único método real: `teach(room, simulationSeed)`.
- `MCTS_TEACHER_V1_CONFIG` (`src/domain/decision/MctsTeacherResult.ts`): única configuración v1 — `rollouts: 128`, `maxDepthPlies: 6`, `explorationConstant: Math.SQRT2`, `rolloutPolicyVersion: 'rule-based-v1'`.

## Seguimiento del Poder a través de una hoja terminal

`BattleRoom.finish()` ejecuta `restoreAllPower()` (HU-11): una sala `FINISHED` SIEMPRE tiene Poder al máximo, sin importar cuánto se gastó durante la batalla. Leer Poder directamente de una hoja terminal haría que una victoria agotando todo el Poder y una victoria sin gastar nada dieran el mismo `P = 1`, lo que rompe la fórmula.

En vez de eso, `MctsSearch.simulateTrajectory` sigue el Poder del actor raíz PLY A PLY: empieza en el Poder de la sala raíz (el mismo para todos los rollouts) y, cada vez que el actor raíz protagoniza un evento de habilidad/épica (que siempre incluye `payload.power.{before,after}`), actualiza el seguimiento a `power.after`. Un turno del rival, un ataque básico (no toca Poder) o un `END_TURN` dejan el seguimiento intacto. El valor final de ese seguimiento — nunca el de `room` — es el que entra en `BattleUtilityEvaluator` como `P`.

## Reproducibilidad y aislamiento del RNG

Dado el mismo `BattleRoom` de entrada, la misma `config` y la misma `simulationSeed`, `MctsSearch.search()` es determinista bit a bit: cada rollout deriva su propia `RandomSeed` vía `deriveMctsRolloutSeed`, y `RandomSequenceFactoryPort.create(seed)` (el mismo adaptador MT19937 + Box-Muller de HU-24) construye una secuencia totalmente independiente del singleton productivo. `MctsSearch` nunca muta el `BattleRoom` recibido: cada rollout opera sobre un clon nuevo partiendo SIEMPRE de la sala raíz original (nunca de un resultado cacheado de un rollout anterior — ver decisión técnica 1), y la sala original se devuelve intacta a quien llamó.

## Gap formal con #566 (dataset offline) — RESUELTO

La condición de #565 "MCTS puede generar una etiqueta/distribución para un decision state" asume, en el contexto del dataset de #566, poder re-etiquetar una decisión YA persistida. Con el contrato de `CombatDecisionEvent` eso nunca fue posible: el evento guarda `stateBefore: BattleDecisionState`, nunca el `BattleRoom` completo, y `BattleDecisionState` no alcanza para reconstruir una sala simulable fielmente.

Por eso `MctsTeacher` NO implementa `AiDecisionPort`: fingir esa interfaz y hacer que un `decide(state, legalActions)` rechace siempre habría sido deshonesto con el contrato sin resolver el problema real. `teach(room, simulationSeed, rotationInput?)` es el único método, y solo sirve para etiquetar una decisión EN VIVO (con su `BattleRoom` a mano).

Esto quedó, en la revisión original de este PR, como pregunta abierta para Management/#566 (opción (a): enriquecer `CombatDecisionEvent`; opción (b): limitar el teacher a decisiones en vivo). **Decisión tomada y wiring implementado** (corrección de alcance sobre PR#81, EN-036.2): se eligió (b). `LiveMctsTeacherLabeler` (`src/application/services/LiveMctsTeacherLabeler.ts`) llama a `teach()` en paralelo a la decisión real — recibe la MISMA `room`/`CombatDecisionEvent` pre-acción que `CombatDecisionRecorder` ya captura, nunca espera en el camino de respuesta (fail-open, §15 del encargo de corrección), y persiste el resultado como `MctsTeacherLabel` (`src/domain/decision/MctsTeacherLabel.ts`, contrato oficial) en la colección Mongo append-only `mcts-teacher-labels` (migración `025-mcts-teacher-labels.ts`), ligado por `eventId`. Wired en `ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`ExecuteAiTurn`, detrás del flag `MCTS_LIVE_TEACHER_LABELING_ENABLED` (desactivado por defecto: cada decisión etiquetada corre una búsqueda MCTS completa, con costo real de CPU). Ver `docs/en-036-ai-dataset-pipeline.md` §2 para el detalle completo, incluyendo la limitación que sigue vigente (`MISSION` nunca produce labels, por la misma razón estructural que motivó este gap: `RunMissionSimulation` nunca tiene un `BattleRoom`).

## Gap formal con Misiones

El objetivo técnico de #565 dice "una función de utilidad versionada para JcE/Misiones". `BattleUtilityEvaluator` y la extracción de vitales (`extractUtilityVitals`) son genéricos: no asumen 1v1 ni ningún `teamSizes` concreto, y la regla de salud (`filterStrategicCandidates`) ya contempla objetivos `ALLY`/`ALLIED_GROUP` en equipos de más de un miembro.

Lo que esta Task NO resuelve: `MctsSearch` consulta `LegalActionGenerator.generateAvailable(room)` directamente y no sabe nada de `MissionRotationConstraint` (las restricciones de rotación de héroes que Misiones aplica sobre el espacio de decisión). Si Misiones usa el teacher tal cual, MCTS podría proponer o explorar acciones legales para Combat en general pero no permitidas por la rotación vigente de esa misión. Antes de usar este teacher para Misiones hace falta, en una Task posterior, o bien (a) una capa de filtrado adicional consciente de la rotación (análoga a `filterStrategicCandidates`), o bien (b) confirmar que el `BattleRoom` que llega a `MctsSearch` ya refleja esa restricción en sus acciones legales (si Missions la aplica antes de construir la sala). No se declara aquí resuelto el soporte de Misiones.

## Fuera de alcance

- Entrenamiento de PyTorch, exportación ONNX y el dataset propiamente dicho: EN-036.2/#566.
- Cualquier cambio a `AiDecisionPort`, `RuleBasedPolicy`, `RandomPolicy` o `DecisionPolicySelector`.
- Torneos (`room.tournament !== null`).
- Integración de `MissionRotationConstraint` (ver "Gap formal con Misiones").

## Historial de la revisión (PR#80, 2026-10-05)

La primera versión de este PR tenía un árbol UCT multinivel cuyas aristas expandidas guardaban un `BattleRoom` fijo; los rollouts posteriores que visitaban la misma arista reutilizaban ese resultado en vez de volver a muestrear la acción. Una revisión externa encontró este y otros defectos antes del merge:

- **Resultado aleatorio congelado por arista** (bloqueante): corregido rediseñando `MctsSearch` a un árbol de un solo nivel (decisión técnica 1); cada rollout re-aplica la acción elegida con su propia secuencia.
- **Poder falseado en hojas terminales** (bloqueante, `restoreAllPower()`): corregido con el seguimiento ply a ply descrito arriba.
- **`D` ignoraba enemigos muertos en equipos de 2+** (alto): corregido sumando sobre todos los enemigos, no solo los vivos.
- **Regla de salud (`healthRatio < 0.90`) no implementada** (alto): corregida con `filterStrategicCandidates`.
- **`MctsPolicy implements AiDecisionPort` con `decide()` que siempre rechazaba** (bloqueante): corregido renombrando a `MctsTeacher`, sin esa interfaz; el gap con #566 queda documentado arriba en vez de disimulado.
- **Soporte de Misiones no resuelto**: documentado explícitamente arriba en vez de darse por hecho.
- La comparación MCTS vs. `RuleBasedPolicy`/`RandomPolicy` (`mcts-vs-baseline-policies.spec.ts`) se amplió para reportar utilidad/decisión real de cada política sobre el mismo estado, no solo que vean el mismo espacio de acciones.
