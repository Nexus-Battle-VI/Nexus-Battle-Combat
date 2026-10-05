# EN-036.1 — Teacher MCTS (`BattleUtilityEvaluator` + `MctsPolicy`)

Esta Task construye un "teacher" de Monte Carlo Tree Search (UCT) que genera, simulando el motor REAL de Combat sobre clones aislados, decisiones/etiquetas fuertes y reproducibles para el actor raíz de una batalla PVE JcE 1v1. **No es productiva**: `DecisionPolicySelector` sigue exactamente igual que en HU-93.2 (`primary: null`, `fallback: RuleBasedPolicy`); `MctsPolicy` no se registra en `app.module.ts` porque nada en producción la inyecta. Tampoco entrena PyTorch ni exporta ONNX: eso es EN-036.2/#566, que puede apoyarse en `MctsTeacherResult` una vez esta Task lo deja reproducible.

## Qué es requisito y qué es decisión técnica v1

**REQUISITO** (de la Task, no reinterpretable):

- La utilidad es `U = 0.60·W + 0.15·H + 0.10·P + 0.15·D`, con cada componente y `U` recortados a `[0,1]`.
- `MctsSearch` debe simular con el motor autoritativo de Combat (`ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`CompleteBattleTurn`), nunca un segundo motor aproximado.
- El RNG de cada simulación debe estar aislado del stream productivo (`BATTLE_RANDOM_SEQUENCE`).
- `MctsPolicy` nunca es la política productiva de JcE.

**DECISIÓN TÉCNICA V1** (elegida en esta Task; revisable sin tocar el contrato anterior):

1. **El árbol solo ramifica en los turnos del actor raíz.** Los turnos del equipo rival —dentro del árbol y durante el rollout— se resuelven siempre con `RuleBasedPolicy`, nunca se buscan. Evita un UCT adversarial de dos bandos; cada ply sigue resuelto por las reglas reales, pero el rival se trata como parte del "entorno", igual que un rollout clásico de un solo agente.
2. **La expansión de aristas no visitadas sigue el orden de `legalActionIdentity`** (determinista). El único azar de toda la búsqueda es el que consume el motor real a través de la secuencia aislada de cada rollout; MCTS no inventa un sorteo propio para decidir qué ramificar.
3. **W** (resultado terminal): victoria del equipo raíz = `1`, derrota = `0`. Un estado aún no terminal (truncado por `maxDepthPlies`) y un empate terminal (`winnerTeamLabel: null`, posible en una sala `FINISHED`) comparten el mismo valor neutral `0.5`: ninguno de los dos favorece ni penaliza al actor raíz.
4. **P** (Poder propio): si el actor NO tiene sistema de Poder (`profile.maxPower === undefined`), se usa el valor neutral `1` — no `0`, que penalizaría injustamente una dimensión que no aplica a ese perfil.
5. **D** (progreso de daño): `1 − Σ Vida_actual_viva / Σ Vida_máxima_viva` del equipo rival, fijado desde la perspectiva del equipo raíz al iniciar la búsqueda (nunca recalculado según de quién sea el turno en un nodo). Sin enemigos vivos, `D = 1` (en vez de dividir por cero).
6. **Semillas de rollout**: `deriveMctsRolloutSeed(rootSeed, index)` es un mezclador entero determinista (estilo splitmix32), sin `node:crypto`. El único precedente del repositorio (`HmacMissionSeedFactory`) resuelve un requisito de _imprevisibilidad_ (antifraude de Misiones) que aquí no existe; solo se necesita independencia estadística entre rollouts, y un mezclador puro además evita que `src/domain/policies/` (donde vive, junto al resto de políticas puras) dependa de infraestructura.
7. **Sin wiring en `app.module.ts`**: ninguna ruta HTTP/WS/cron consume `MctsSearch`/`MctsPolicy`; el tooling de teacher/dataset (futuro #566) los construye directamente, igual que los tests.

## Arquitectura

- `BattleUtilityEvaluator` (`src/domain/policies/`): función pura `evaluateBattleUtility(outcome, actor, enemies)`. No conoce `BattleRoom` ni ningún puerto; el llamador extrae vitales y decide `outcome`.
- `extractUtilityVitals(room, rootActor)` (`src/application/services/MctsSearch.ts`): lee Vida/Poder del actor raíz y Vida de los enemigos directamente de `room.battle.turnOrder`/`combatantFor`, SIN pasar por `BattleDecisionStateAssembler` (que está atado a "de quién es el turno" y por tanto no sirve para evaluar una hoja donde el turno es del rival). Una sala `FINISHED` conserva `battle` (HU-21 solo restaura Poder), así que esta extracción funciona igual en hojas terminales que truncadas.
- `MctsSimulationPort` (`src/application/ports/`) + `InMemoryMctsSimulationAdapter` (`src/adapters/outbound/system/`): cada llamada (`applyAction`/`applyEndTurn`) crea, para ESE paso, un `InMemoryBattleRoomRepository` nuevo sembrado solo con el clon recibido, e instancias nuevas (nunca las DI de producción) de los casos de uso reales, usando sus rutas `*ForActorExclusively`/`executeExclusively` (sin bloqueo de sala: no hace falta, cada simulación es su propio sandbox). Los `commandId` de simulación usan el namespace `mcts:<rollout>:<ply>`, que nunca colisiona con un `commandId` real (fingerprint SHA-256 sin `:`); si alguna vez colisionara dentro del mismo clon, se trata como defecto del arnés (`SimulationTransitionError`), nunca como repetición silenciosa.
- `MctsSearch` (`src/application/services/`): UCT clásico (selección/expansión/rollout/backpropagación), con `score = explotación + C·√(ln(N_padre)/N_hijo)`. Expone `search(room, config, simulationSeed): Promise<MctsTeacherResult>`.
- `MctsPolicy` (`src/application/policies/`): implementa `AiDecisionPort` solo por tipo. `decide()` SIEMPRE rechaza (`MctsRoomContextRequiredError`): `BattleDecisionState` no alcanza para reconstruir una sala simulable (sin snapshot completo ni cooldowns/efectos internos no expuestos por el contrato de decisión). El método real es `teach(room, simulationSeed)`, que recibe el `BattleRoom` autoritativo completo.
- `MCTS_TEACHER_V1_CONFIG` (`src/domain/decision/MctsTeacherResult.ts`): única configuración v1 — `rollouts: 128`, `maxDepthPlies: 6`, `explorationConstant: Math.SQRT2`, `rolloutPolicyVersion: 'rule-based-v1'`.

## Reproducibilidad y aislamiento del RNG

Dado el mismo `BattleRoom` de entrada, la misma `config` y la misma `simulationSeed`, `MctsSearch.search()` es determinista bit a bit: cada rollout deriva su propia `RandomSeed` vía `deriveMctsRolloutSeed`, y `RandomSequenceFactoryPort.create(seed)` (el mismo adaptador MT19937 + Box-Muller de HU-24) construye una secuencia totalmente independiente del singleton productivo — nunca comparte estado con `BATTLE_RANDOM_SEQUENCE` ni con la secuencia de otro rollout. `MctsSearch` nunca muta el `BattleRoom` recibido: cada paso opera sobre un clon (`BattleRoom.restore(toSnapshot())` vía el repositorio en memoria del adaptador) y la sala original se devuelve intacta a quien llamó.

## Fuera de alcance

- Entrenamiento de PyTorch, exportación ONNX y el dataset propiamente dicho: EN-036.2/#566.
- Cualquier cambio a `AiDecisionPort`, `RuleBasedPolicy`, `RandomPolicy` o `DecisionPolicySelector`.
- Torneos (`room.tournament !== null`): el teacher asume JcE 1v1, igual que `ExecuteAiTurn.isAutomatable`.
