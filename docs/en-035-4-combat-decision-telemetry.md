# EN-035.4 — Telemetría append-only de decisiones de combate

Esta Task materializa el dataset lógico definido por ADR-023 dentro de Combat. No crea una API ni un microservicio nuevo: el dato se escribe mediante un puerto de aplicación y dos adaptadores, en memoria o MongoDB.

## Contrato

Cada `CombatDecisionEvent` conserva la observación previa (`BattleDecisionState`), las candidatas canónicas (`LegalAction[]`) y la acción finalmente elegida (`ActionIntent`). Incluye origen, modo, actor técnico `(teamLabel, seat)`, fuente de decisión, secuencia global e instante obtenido mediante `ClockPort`.

El contrato excluye deliberadamente `playerId`, nombres, tokens, semillas, cursores de RNG y resultados futuros. El `commandId` online solo participa en el `eventId` técnico idempotente y no se guarda como feature separada.

El resultado terminal se guarda como `CombatDecisionOutcomeEvent` independiente. Nunca se actualizan decisiones anteriores para añadirles el resultado.

## Orden y resiliencia

- Online y Torneo capturan estado/candidatas/selección después de validar el comando y antes de mutar o consumir RNG.
- La sala se guarda primero; solo después se intenta añadir la telemetría.
- Misiones acumula las decisiones durante la simulación, guarda primero el resultado autoritativo y luego añade decisiones y outcome.
- Un fallo preparando o escribiendo telemetría se registra de forma estructurada y no cambia el resultado del combate.
- Un replay del mismo evento y contenido es un no-op. El mismo `eventId` con contenido semántico distinto es un conflicto y nunca sobrescribe.

## Misiones y previews

La secuencia de decisión de una misión usa el contador global `totalTurns`; no usa `roundTurns`, que se reinicia al cambiar de enemigo. Así no colisionan decisiones entre encounters.

`EstimateMissionOutcome` sigue llamando al simulador sin observer ni recorder. Sus 30–100 corridas de preview producen cero eventos persistidos y no contaminan el dataset de partidas reales.

La telemetría registra únicamente las decisiones del héroe que hoy pasan por `AiDecisionPort` (`RuleBasedPolicy` en producción). Las acciones de los enemigos legacy (`AGGRESSIVE`, `GUARDED`, `BOSS`) todavía se ejecutan directamente en `MissionSimulation`; no se fabrican eventos falsos para ellas. Incorporarlas exige primero migrarlas al mismo contrato de decisión en una Task posterior.

## Persistencia MongoDB

La migración `023-combat-decision-events` crea `combat-decision-events` con validador estricto e índices para:

- `_id = eventId` como identidad idempotente;
- una decisión única por `(origin, battleId, decisionSequence)`;
- un outcome único por `(origin, battleId)`;
- consulta temporal por `occurredAt`.

El repositorio expone solo operaciones append/read; no existe actualización ni borrado de eventos.
