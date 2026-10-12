# HU-72 - Integracion autoritativa e IA de Misiones

Fecha de verificacion: 2026-10-11. Base: `develop` en
`1379b60e1de79ef618637b258682563c673cb2a8`.

## Arquitectura final

La ejecucion y la estimacion usan la misma instancia productiva de
`DecisionPolicySelector` que JcE Online. Con una version `ACTIVE` valida y la
politica neuronal habilitada, la seleccion se registra como `NEURAL`; si el
modelo falta, falla o propone una accion fuera de `legalActions`, el selector
ejecuta `RuleBasedPolicy` y registra `RULE_BASED`. La estimacion no persiste
telemetria, recompensas ni labels y reutiliza el modelo ya materializado: no lo
recarga por turno ni por corrida.

`MissionRotationConstraint` se ejecuta antes del selector. Por ello una
rotacion `HIGH` viable es la unica candidata que puede ver una politica. Un
soporte puro sin candidata conserva `SYSTEM/END_TURN` y no invoca al selector.

Los turnos ofensivos de cada enemigo tambien atraviesan el mismo selector con
una unica accion legal `BASIC_ATTACK`, porque el contrato v1 de NPC no define
habilidades ni Poder. Su identidad tecnica es
`ENEMY:<encounter>:<enemyRef>#<instance-1>`: identifica la instancia del
encuentro sin inventar un jugador. `GUARDED` conserva la defensa obligatoria de
cada tercer turno como regla de modalidad y queda en la bitacora con fuente
`SYSTEM`; no se fabrica una accion `GUARD` ni un evento de decision incompatible
con `LegalAction`. `BOSS` conserva el umbral y bono de furia configurados.

## Matriz de equivalencia con Online

| Regla                                  | Online                                                             | Misiones                                                                                       | Estado / accion                                                              |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Comparacion ataque/defensa             | `compareAttackAgainstDefense`, impacto solo con `ataque > defensa` | Misma politica; el umbral v1 `defensa + 10` se conserva como configuracion de modalidad        | Compartida                                                                   |
| Aplicacion y tope de dano              | `calculateDamage` y `applyDamage`                                  | Mismas funciones, incluido nivel antes de bonos y vida nunca negativa                          | Compartida                                                                   |
| RNG                                    | `RandomSequencePort`                                               | La unica secuencia privada derivada del `operationId` alimenta dados, criticos, Master y botin | Compartido                                                                   |
| Ataque aleatorio                       | Dado por subtipo y tabla HU-25 del equipamiento                    | `1d20`, `criticalChance` y `criticalMultiplier` del contrato v1                                | Diferencia explicita de modalidad; el NPC no trae subtipo ni tabla de equipo |
| Poder                                  | Snapshot Online y politicas de habilidades                         | Snapshot congelado; regeneracion `+2` por turno y costo de la habilidad                        | Regla v1 de Misiones, validada antes de decidir                              |
| Cooldown                               | Agregado `BattleRoom`                                              | Cursores/cooldowns de `MissionRotationConstraint`                                              | Regla v1 de Misiones; prioridad estricta HU-71                               |
| Efectos, curacion, inmunidad y reflejo | `BattleRoom`/`UseSkill`                                            | `MissionAbilityPolicy` sobre el vocabulario que el contrato v1 puede representar               | Adaptacion de modalidad; no se atribuyen capacidades ausentes al NPC         |
| Fin de turno                           | `CompleteBattleTurn`                                               | Fin de ronda del simulador; `SYSTEM/END_TURN` cuando no hay candidata                          | Semantica equivalente; persistencia distinta                                 |
| IA                                     | `DecisionPolicySelector`                                           | La misma instancia para heroe y ataques enemigos                                               | Compartida                                                                   |

El contrato vigente de Misiones define el impacto `1d20`, mientras Online usa
el dado por subtipo y la tabla de efectos HU-25. No se sustituyo esa diferencia
aprobada por una equivalencia falsa. Las reglas comunes de comparacion,
redondeo, nivel, calculo y aplicacion de dano se delegan en las politicas puras
del dominio de Combat, y toda aleatoriedad sigue saliendo de la unica secuencia
de Combat.

## Telemetria y aprendizaje

Cada seleccion real guarda estado preaccion, acciones legales, accion
seleccionada, fuente, actor, simulacion y secuencia con `origin=MISSION`. La
bitacora anade de forma compatible `decisionSource` a `heroAction`,
`enemyAction` y `enemyGuarded`.

No se construye un `BattleRoom` artificial. Un encuentro secuencial de Mision
no contiene equipos, asientos de jugadores, subtipo de NPC, equipamiento ni la
tabla de efectos que exigen las invariantes de Online. Por la misma razon,
MISSION produce `CombatDecisionEvent` pero no `MctsTeacherLabel`:
`LiveMctsTeacherLabeler` necesita el `BattleRoom` preaccion genuino. Las
decisiones MISSION siguen fuera del dataset supervisado que exige esos labels;
no se presentan acciones RuleBased como teacher.

## Compatibilidad y pendientes

No cambia el contrato HTTP, `MissionSimulationResult`, `summary`, `combatLog`,
`simulationId`, `operationId`, `seedRef` ni `combatOutcome`. La idempotencia se
resuelve antes de simular, por lo que un reintento no vuelve a consultar la IA
ni a sortear.

`ABANDONED` sigue pendiente: no existe una regla formal de cancelacion o
penalizacion. `VOIDED` continua siendo una anulacion tecnica y no se convierte
en abandono.
