# EN-035.4 — Telemetría append-only de decisiones de combate

Esta Task materializa el dataset lógico definido por ADR-023 dentro de Combat. No crea una API ni un microservicio nuevo: el dato se escribe mediante un puerto de aplicación y dos adaptadores, en memoria o MongoDB.

## Contrato

Cada `CombatDecisionEvent` conserva la observación previa (`BattleDecisionState`), las candidatas canónicas (`LegalAction[]`) y la acción finalmente elegida (`ActionIntent`). Incluye origen, modo, actor técnico `(teamLabel, seat)`, fuente de decisión, secuencia global e instante obtenido mediante `ClockPort`.

El contrato excluye deliberadamente `playerId`, nombres, tokens, semillas, cursores de RNG y resultados futuros. El `commandId` online solo participa mediante su huella SHA-256 en el `eventId` técnico idempotente: el texto arbitrario recibido del cliente no se persiste, ni como feature ni dentro de `_id`.

El resultado terminal se guarda como `CombatDecisionOutcomeEvent` independiente. Nunca se actualizan decisiones anteriores para añadirles el resultado.

## Orden y resiliencia

- Online y Torneo capturan estado/candidatas/selección después de validar el comando y antes de mutar o consumir RNG.
- La sala se guarda primero; solo después se intenta añadir la telemetría.
- Misiones acumula las decisiones durante la simulación, guarda primero el resultado autoritativo y luego añade decisiones y outcome.
- Un fallo preparando o escribiendo telemetría se registra de forma estructurada y no cambia el resultado del combate. En los lotes de Misiones cada evento se intenta y registra de forma independiente, de modo que un fallo no impide escribir los eventos posteriores ni el outcome.
- Un replay del mismo evento y contenido es un no-op. El mismo `eventId` con contenido semántico distinto es un conflicto y nunca sobrescribe.

La garantía es deliberadamente _fail-open_: si una escritura aislada falla, el resultado autoritativo de la misión permanece válido y esa pieza de telemetría puede perderse. Esta Task no implementa reconciliación ni backfill sobre resultados ya almacenados; esa recuperación, si se exige, pertenece al trabajo posterior de MLOps de EN-037.

## Misiones y previews

La secuencia de decisión de una misión usa el contador global `totalTurns`; no usa `roundTurns`, que se reinicia al cambiar de enemigo. Así no colisionan decisiones entre encounters.

`EstimateMissionOutcome` sigue llamando al simulador sin observer ni recorder. Sus 30–100 corridas de preview producen cero eventos persistidos y no contaminan el dataset de partidas reales.

La telemetría registra únicamente las decisiones del héroe que hoy pasan por `AiDecisionPort` (`RuleBasedPolicy` en producción). Las acciones de los enemigos legacy (`AGGRESSIVE`, `GUARDED`, `BOSS`) todavía se ejecutan directamente en `MissionSimulation`; no se fabrican eventos falsos para ellas. Incorporarlas exige primero migrarlas al mismo contrato de decisión en una Task posterior.

## Persistencia MongoDB

La migración `023-combat-decision-events` crea `combat-decision-events` con validador estricto e índices para:

- `_id = eventId` como identidad idempotente;
- una decisión única por `(origin, battleId, decisionSequence)`;
- un outcome único por `(origin, battleId)`;
- lectura del dataset por `(schemaVersion, occurredAt)`.

El `$jsonSchema` también cierra los campos y discriminadores de `stateBefore`, acciones, targets y outcomes con `additionalProperties: false` en los niveles estratégicos. El repositorio expone solo operaciones append/read; no existe actualización ni borrado de eventos.
