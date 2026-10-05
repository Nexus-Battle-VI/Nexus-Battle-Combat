# HU-93.2 — Turno automático de IA en JcE 1v1

## Alcance

Combat juega automáticamente el turno de un participante `AI` en una sala JcE
1v1 (`PVE`, exactamente un `HUMAN` y un `AI`, sin Torneo). No espera ninguna
petición HTTP ni mensaje de WebSocket humano para esa posición de la cola:
`ExecuteAiTurn` orquesta el turno completo y reutiliza, sin reimplementar
nada, las mismas rutas autoritativas que ya validan y resuelven las acciones
humanas.

Torneo y JcJ quedan explícitamente fuera: `ExecuteAiTurn.isAutomatable`
exige `mode === PVE`, `tournament === null`, exactamente dos participantes en
la cola y que el turno activo sea `AI`. EN-036 (MCTS, PyTorch, ONNX,
`NeuralPolicy`) tampoco se implementa aquí.

## De `BattleDecisionState` a una acción ejecutada

```text
BattleDecisionState  (BattleDecisionStateAssembler)
        ↓
LegalAction[]         (LegalActionGenerator.generateAvailable)
        ↓
DecisionPolicySelector.select(...)
        ↓
ActionIntent
        ↓
resolveLegalAction      (revalida contra las candidatas ya generadas)
        ↓
executeForActorExclusively   (ExecuteBasicAttack / UseSkill / UseEpic)
        ↓
mismo resolve/apply/persist que una acción humana
```

`generateAvailable` es la variante honesta de `LegalActionGenerator.generate`
(contrato EN-035.2/EN-035.4): no lanza cuando no hay candidatas, representa
ese caso válido como `[]`.

## Selección de política (Management#558)

`DecisionPolicySelector` recibe una primaria **opcional** y un fallback fijo:

```text
primary: DecisionPolicyBinding | null
fallback: DecisionPolicyBinding
```

Hoy, sin una política entrenable real (EN-036 no está implementada todavía),
la raíz de composición la construye con `primary: null`. El fallback fijo es
`RuleBasedPolicy` — la primera candidata legal, determinista, sin RNG ni
mutación — exactamente lo que Management#558 exige: _"si la política
neuronal no está disponible, falla o no produce una decisión utilizable →
`RuleBasedPolicy`"_.

`RandomPolicy` **no** participa en este wiring. Sigue existiendo como
baseline experimental de EN-035.3 para evaluación y para Misiones
(`RunMissionSimulation`/`EstimateMissionOutcome`, que no pasan por
`DecisionPolicySelector`), pero nunca es el fallback productivo de JcE.

El día que exista una política entrenable real (`NeuralPolicy`, EN-036), pasa
a ser la primaria inyectada aquí; `RuleBasedPolicy` sigue siendo el mismo
fallback fijo, sin tocar `DecisionPolicySelector` ni `ExecuteAiTurn`.

## Cero acciones legales: `END_TURN`

Un soporte puro (`CHAMAN`/`MEDICO`, `attack`/`damage` nulos) puede llegar a un
turno sin ninguna candidata legal (por ejemplo, su única habilidad de
curación no tiene a quién curar). Combat no inventa un `BASIC_ATTACK` ni un
valor de Ataque/Daño artificial: cierra el turno con un cierre técnico
propio.

```text
legalActions.length > 0
    → la política decide (ActionIntent)

legalActions.length === 0
    → Combat autoriza END_TURN
    → decisionSource: SYSTEM
    → schemaVersion: 2
    → sin ataque, sin curación, sin Poder, sin RNG de combate
    → el turno avanza con las reglas normales (cooldowns y efectos siguen)
```

`END_TURN` **no** es un `ActionIntent`: no se añadió a ese tipo, no aparece
dentro de `LegalAction[]` y ninguna política puede escogerlo voluntariamente
("pasar" con acciones legales disponibles sigue estando prohibido, incluso
para una futura política neuronal). Solo Combat lo emite, y solo cuando
`CombatDecisionRecorder.prepare` confirma que `legalActions` está vacío y la
fuente es `SYSTEM`; cualquier otra combinación lanza `IllegalActionIntentError`.

La migración Mongo `024` amplía el validador estricto de `combat-decision-events`
(`023`) para aceptar esta rama nueva (`schemaVersion: 2`, `decisionSource: SYSTEM`,
`legalActions: []`, `selectedAction: {kind: 'END_TURN'}`) sin debilitar la
validación de los eventos v1 existentes — incluida la rama
`COMBAT_DECISION_OUTCOME`, que sigue exigiendo `schemaVersion: 1`
explícitamente.

## Motor compartido, nunca uno nuevo

`ExecuteBasicAttack`, `UseSkill` y `UseEpic` ganaron una ruta interna por
`CombatantKey` (`executeForActorExclusively`), separada de la autenticación
humana por `playerId`/`requesterId`. Esa ruta reutiliza los mismos planners
(`planBasicAttackForActor`, `planSkillForActor`, `planEpicForActor`), la misma
secuencia HU-24, los mismos efectos y la misma persistencia que la ruta
humana. No existe un segundo motor de combate ni un `playerId` ficticio para
el bot.

`CompleteBattleTurn.executeExclusively` permite cerrar el turno del `AI` con
`actorPlayerId: null` cuando corresponde `END_TURN`, publicando por el mismo
orden persistir → difundir que ya usan las acciones humanas.

## Disparo automático

`AiTurnTrigger` es el adaptador fail-open: un fallo del bot nunca rechaza una
acción humana ya persistida y difundida.

```text
StartBattle (HTTP)              acción humana válida (WS)
        ↓                               ↓
battleStarted ya publicado      evento humano ya publicado
        ↓                               ↓
        AiTurnTrigger.afterTransition(roomId)
                    ↓
            ExecuteAiTurn.execute(roomId)
                    ↓
        RoomCommandLockPort.run(roomId, …)
```

El disparo corre **dentro** del mismo `RoomCommandLockPort` que ya serializa
ataque/habilidad/épica/fin de turno por sala (ADR-020): dos disparos
concurrentes nunca producen dos decisiones ni avanzan el turno dos veces,
porque el segundo, al ejecutarse después del primero, encuentra que el turno
activo ya no es `AI`.

El `commandId` del turno AI es determinista y se deriva de
`battleId`/`turnsCompleted`/`teamLabel`/`seat`, reducido con
`CommandIdFingerprintPort` (el mismo puerto que ya usa `CombatDecisionRecorder`,
implementado por `Sha256CommandIdFingerprint`) — nunca texto crudo sin
acotar, ni `Date.now()`, ni un UUID aleatorio.

## Fuera de alcance de esta entrega

- Torneo (EPIC-09): `ExecuteAiTurn` excluye explícitamente cualquier sala con
  `tournament !== null`; una sala de torneo real siempre tiene 4 humanos por
  construcción de dominio, así que el escenario "torneo con AI actual" ni
  siquiera es alcanzable hoy.
- Recompensas/drops del cierre JcE (HU-93.3, Management#559).
- `NeuralPolicy`/MCTS/PyTorch/ONNX (EN-036).

Trazabilidad: Management #558, HU padre #553, Management#557 (HU-93.1,
preparación del participante IA), ADR-023.
