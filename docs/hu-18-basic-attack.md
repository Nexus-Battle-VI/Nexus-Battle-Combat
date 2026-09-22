# HU-18 — Ejecutar ataque básico

> Estado: **implementado en Combat** (Task [#410](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/410)) sobre el contrato
> [`hu-18-basic-attack-v1`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-18-basic-attack-v1.md)
> (Task [#409](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/409)). Web ([#411](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/411))
> y la validación integrada ([#412](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/412)) son Tasks aparte. Este documento
> distingue en cada punto qué es requisito explícito, aclaración formal, decisión técnica o pendiente.

## Trazabilidad

| Elemento            | Referencia                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario | [HU-18 — Ejecutar ataque básico](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/62) (#62) · RF-18 · EPIC-06                                                            |
| Bloqueada por       | HU-17 ([#26](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/26)) y HU-20 ([#64](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/64)), ambas cerradas |
| Arquitectura        | ADR-019 (Combat única autoridad), ADR-020 (comandos por WebSocket con `commandId`, `seq`, persistir antes de difundir), ADR-021 (aleatoriedad HU-24/HU-25). Sin ADR nuevo.                |
| Fuente oficial      | «Proyecto Integrador II»: Tabla 6 (Vida, Ataque, Defensa, Daño), §6.1.4 y Tablas 21–23 (efectos), §7.6 (barra de Vida)                                                                    |

## Clasificación de lo decidido

| #   | Tipo                               | Contenido                                                                                                                                                                                                                                                        |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito explícito (RF-18)        | Solo en el turno del atacante; **un** objetivo, sin área; **no consume Poder**; disponible sin Poder; Ataque contra Defensa; si produce efecto, la Vida del objetivo se actualiza; después de resolver, el turno finaliza.                                       |
| 2   | Aclaración formal                  | Redondeo del daño = **`floor`** ([comentario en #62](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/62#issuecomment-5761290722), 2026-09-21). El documento oficial no lo definía; **no es un requisito original**.                            |
| 3   | Decisión arquitectónica `Accepted` | Combat es la única fuente de la Vida; el cliente envía comandos, no estado; persistir antes de difundir.                                                                                                                                                         |
| 4   | Decisión técnica                   | Comando `attack` (nombre de ADR-020); evento único `basicAttackResolved` con el estado ya avanzado; snapshot de combate congelado; orden de sorteos; serialización por sala y sin re-sorteo tras un conflicto; rechazo de claves desconocidas; códigos de error. |
| 5   | Pendiente                          | Ver [Pendientes](#pendientes).                                                                                                                                                                                                                                   |

## Flujo

```text
Web A ── {"type":"attack","commandId","roomId","target":{teamLabel,seat}} ──▶ Gateway (sub autenticado)
        BasicAttackRealtimeHandler   forma estricta del mensaje · sin datos del cliente
        ExecuteBasicAttack           serializa por sala
          BattleRoom.planBasicAttack        VALIDA (0 sorteos): commandId → repetición → batalla → turno → objetivo → equipo → perfiles y Vida → Ataque/Daño soportados
          prepareAttack + ResolveAttack     HU-20: dado de Ataque · Ataque > Defensa · (si efectivo) efecto HU-25
          dado de Daño                       solo si es efectivo, el porcentaje es > 0 y el Daño es DICE
          BattleRoom.applyBasicAttack       UNA transición: Vida + evento + commandId + turno avanzado
          rooms.save                         UNA escritura, bloqueo optimista
        Gateway.publish              DESPUÉS de persistir ──▶ Web A y Web B (mismos bytes)
```

## Snapshot de combate (`StartBattle`)

HU-17 solo conservaba `turnOrder` y `turnsCompleted`. `StartBattle` ya obtiene el héroe equipado de cada `HUMAN` para revalidar HU-16; con esa **misma respuesta** (sin segunda llamada) congela un **perfil local y mínimo** por participante (`CombatProfile`):

`heroId`, `subtype`, `maxHealth` (`effectiveStats.health`), `attack`, `defense`, `damage` y los `activeEffects` que HU-20 necesita. **No** copia inventario, nombre, referencia del héroe, `selectedAt`, `baseStats`, `blockers` ni Poder.

- **Se congela:** cambiar el equipo en Player-Inventory después de iniciar no modifica la batalla, y **no hay llamadas a Player-Inventory ni a Catalog por golpe** (una prueba lo mide y una guarda estática lo impide).
- **Identidad:** `(teamLabel, seat)`, la `memberKey` de HU-17. Nunca `heroId`.
- **Vida inicial:** `currentHealth = maxHealth = effectiveStats.health`. Invariante `0 ≤ currentHealth ≤ maxHealth`, entero.
- **Datos upstream mal formados** (Vida/Defensa/Ataque decimal o negativo) **no se corrigen en silencio**: el inicio falla como fallo del servicio (`503`) y la sala sigue `PREPARING`.
- **`AI`:** no hay fuente autoritativa de su perfil y no se inventan valores. Su combatiente no tiene perfil ni Vida (`health: null`); un ataque desde o hacia él se rechaza.
- **Batallas anteriores a HU-18** (`IN_BATTLE` sin `combatants`): se restauran sin error y **sin** Vida; no admiten ataque. No hay _backfill_ ni consulta a Player-Inventory al restaurar.

`BattleView` se amplía **de forma aditiva** con `combatants[{teamLabel, seat, health:{current,max}}]` (mismo orden que la cola): es el **único** sitio donde viaja la Vida y nunca lleva Ataque, Defensa, Daño ni efectos.

## Resolución y Vida

```text
dañoBase       = effectiveStats.damage del atacante      DICE {count,sides} → se tira · FIXED {amount} → tal cual
dañoCalculado  = floor( dañoBase × porcentaje / 100 )    (aclaración formal)
dañoAplicado   = min( dañoCalculado, Vida actual )
Vida nueva     = Vida actual − dañoAplicado              (nunca negativa)
```

- **Ataque ≠ Daño.** El Ataque solo se compara con la Defensa (HU-20; la igualdad **no** supera). Nunca `Vida −= Ataque` ni `daño = Ataque − Defensa` (una guarda estática lo comprueba).
- `PERCENTAGE` como Daño base, o un Daño ausente, se rechaza **antes de sortear** (`UNSUPPORTED_COMBAT_PROFILE`): ninguna fuente formal define la base de un porcentaje.
- Un `floor` que deja el daño en 0 (p. ej. `3 × 20 %`) **no es un error**: el golpe fue efectivo, se resolvió y el turno finaliza.
- **Bonos de daño del equipamiento y de habilidades** («+2 al daño»): `effectiveStats.damage` no los incluye (`appliedToStats = false`) y ningún requisito aprobado define cómo componerlos con el dado y el porcentaje. **No se aplican**; siguen como efectos pendientes.
- La **Defensa** solo interviene en la comparación: no reduce además el daño (ninguna fuente lo define).

### Consumo de la secuencia HU-24 (orden exacto)

| Paso              | Sorteos                         | Cuándo                                                        |
| ----------------- | ------------------------------- | ------------------------------------------------------------- |
| 1. Dado de Ataque | `dice.count` (1 con la Tabla 6) | siempre que el atacante lleve dado (HU-20, sin cambios)       |
| 2. Efecto         | 1                               | solo si el golpe es efectivo (HU-20, sin cambios)             |
| 3. Dado de Daño   | `damage.count`                  | solo si es efectivo, el porcentaje es > 0 y el Daño es `DICE` |

Con un efecto del 0 % el daño es 0 sea cual sea el dado: **no se consume aleatoriedad que no puede afectar al resultado** (decisión técnica). Un golpe no efectivo consume solo el paso 1; un rechazo previo, **ninguno**. La cara de un dado de Daño es `dieFaceFromIndex`, la misma que el dado de Ataque. Cada golpe usa la **misma secuencia de proceso** que la cola de turnos (`BATTLE_RANDOM_SEQUENCE`); ni el caso de uso ni el handler conocen la semilla.

## Turno, atomicidad y persistencia

- `BattleRoom.applyBasicAttack` produce **una sola versión nueva** del agregado con la Vida del objetivo, el evento (con su `seq`), el `commandId` procesado y el turno avanzado (reutiliza `BattleState.completeTurn` de HU-17). `ExecuteBasicAttack` hace **una sola** llamada a `save`: no puede quedar la Vida bajada con el turno sin avanzar ni al revés (una guarda estática impide un segundo `save`).
- El turno avanza tras **toda** acción válida y resuelta: golpe no efectivo, efecto 0 % o con daño. **No** avanza si el comando es inválido, fuera de turno o el objetivo no es válido.
- **Persistir antes de difundir:** el caso de uso devuelve el evento ya guardado y el gateway (que es el publicador) lo difunde **después**. Así el publicador no se inyecta en el caso de uso y no hay dependencia circular.
- **Migración `007-battle-rooms-combat-snapshot`** (aditiva): `battle.combatants` opcional y el tipo de evento `basicAttackResolved`. Es la siguiente libre (`006` es del chat de HU-13). Ejecutar antes de arrancar la versión nueva: `npm run migrate` (`node dist/infrastructure/persistence/migrate.js`).

## Evento `basicAttackResolved`

Un único evento por ataque que trae el resultado **y** el `battle` posterior (Vida actualizada y turno ya avanzado): un solo `seq`, Web nunca ve la Vida nueva con el turno viejo y `resume` reproduce exactamente la acción. Campos: `commandId`, `completedPosition`, `attacker`, `target`, `resolution {attackValue, defenseValue, effective, effect, percent, baseDamage, calculatedDamage, appliedDamage}`, `targetHealth {before, after}`, `battle`. **No** viajan el dado de Ataque por separado, los efectos, las estadísticas, el índice, la semilla ni el Poder.

## Idempotencia y concurrencia

- **`commandId` repetido:** se reconoce por `handledCommands` **antes** de validar el turno (tras el ataque el turno ya no es del atacante). Devuelve el mismo evento **solo a quien lo repite**: sin sorteos, sin daño, sin turno y sin difusión.
- **Dos comandos distintos del mismo jugador en el mismo turno:** solo uno muta; el otro recibe `NOT_YOUR_TURN` **sin haber consumido sorteos**.
- **Serialización por sala** (`RoomCommandLockPort`, cumplido por `ChannelLock` de HU-13; una réplica, ADR-020): el segundo comando espera, relee la sala ya actualizada y termina como repetición o `NOT_YOUR_TURN`. El bloqueo optimista por `version` sigue siendo la red de seguridad.
- **Nunca se vuelve a sortear tras un conflicto de versión:** se relee la sala; si el `commandId` ya está procesado se devuelve ese resultado, si no se responde `COMMAND_CONFLICT` y el cliente reintenta con el **mismo** `commandId`. Los sorteos del intento que pierde se descartan con él.

## Errores (`command.rejected {command:"attack", commandId?, code}`)

`MALFORMED_COMMAND` · `INVALID_COMMAND_ID` · `ROOM_NOT_FOUND` · `NOT_A_PARTICIPANT` · `BATTLE_NOT_ACTIVE` · `NOT_YOUR_TURN` · `INVALID_TARGET` · `SAME_TEAM_TARGET` · `TARGET_UNAVAILABLE` · `ACTOR_UNAVAILABLE` · `UNSUPPORTED_COMBAT_PROFILE` · `COMMAND_CONFLICT` · `INTERNAL_ERROR`. Un `commandId` repetido **no** es un error. El comando admite **exactamente** `type`, `commandId`, `roomId` y `target {teamLabel, seat}`: cualquier otra clave (`attackValue`, `damage`, `targets`, `area`…) es `MALFORMED_COMMAND` con 0 sorteos.

## Seguridad

El cliente no aporta Ataque, Defensa, Daño, Vida, efecto, porcentaje, semilla ni turno; el atacante es el `sub` de la conexión y el turno vigente. Nunca viajan semilla, índices, inventario, `activeEffects` ni el perfil. Los logs registran `roomId`, `commandId`, `seq` y resultado; nunca JWT, ticket, semilla ni el mensaje de un error interno.

## Relación con otras historias

- **HU-17:** se reutilizan la cola, `seq`, `resume`/`snapshot` y `BattleState.completeTurn`; `turnAdvanced` no cambia.
- **HU-20:** se **reutilizan** `prepareAttack`, `ResolveAttack` y `ResolveRandomEffect` sin reescribirlos. Solo se relajaron los tipos de entrada de `prepareAttack`/`buildHeroEffectTable` a una interfaz local mínima (`AttackParticipant`, `EffectTableSource`) que `EquippedHero` y el perfil congelado cumplen por estructura; todas las pruebas de HU-20 siguen verdes. HU-20 ya tiene su consumidor de producción.
- **HU-12 (abierta):** el ataque básico **rechaza** objetivos del mismo equipo, incluido él mismo (`SAME_TEAM_TARGET`). Es una validación local coherente con RF-12; **no** cierra HU-12 ni implementa excepciones de habilidades.
- **HU-21 (implementada):** una Vida en 0 **finaliza la batalla** si deja a un equipo sin héroes, en la misma escritura del golpe (`battleFinished` con `seq` contiguo) y con el ataque como actor ganador. Un participante sin Vida no puede ser objetivo (`TARGET_UNAVAILABLE`) ni atacar (`ACTOR_UNAVAILABLE`); en 2 contra 2 su turno se salta. El temporizador de turno de 30 s es de HU-21, no de HU-18.
- **HU-19:** habilidades, costo de Poder y recarga llegaron con HU-19 (ver [hu-19-skills.md](hu-19-skills.md)); la épica sigue fuera (HU-31). Este ataque básico es también el destino de la degradación por Poder insuficiente (`degradedFrom`).
- **Poder:** desde HU-19 Combat modela el Poder de batalla, pero el ataque básico **sigue sin leerlo ni escribirlo**: no hay puerta de Poder que pueda deshabilitarlo (guarda estática). Solo la habilidad lo consume.

## Pruebas

- **Dominio:** política de daño (`floor`, _overkill_, valores inválidos), `Combatant`/`CombatProfile`/`BattleState` (snapshot, invariantes, inmutabilidad, restauración), `BattleRoom.planBasicAttack`/`applyBasicAttack` (orden de validación, transición atómica, repetición).
- **Aplicación:** `ExecuteBasicAttack` con la secuencia HU-24 **guionizada** (orden y conteo de sorteos, Ataque/efecto/Daño, `FIXED`, varios dados, 0 %, no efectivo, _overkill_, rechazos con 0 sorteos, idempotencia, concurrencia, conflicto sin re-sorteo) y `StartBattle` (snapshot, sin segunda llamada, congelado).
- **Gateway:** `attack` por el gateway real (autenticación previa, difusión a los participantes, rechazo solo al remitente, repetición solo al remitente, orden por conexión, `resume`/`snapshot`).
- **Guardas estáticas** (`hu-18-basic-attack-guards.spec.ts`): sin `Math.random`/`crypto`/`Date.now`, sin Poder, sin llamadas cruzadas, una sola escritura, sin `Vida −= Ataque`, `floor`.
- **Extremo a extremo de protocolo** (`test/db/basic-attack.e2e.spec.ts`): **MongoDB real** (Testcontainers), servidor Nest real y **dos clientes `ws` reales** con la secuencia HU-24 guionizada: crítico 137 %, efecto 0 %, golpe no efectivo, idempotencia, fuera de turno, rechazos, reconexión, recarga, **reinicio de Combat**, concurrencia (dos pestañas), 2v2, batalla anterior a HU-18 y el validador de la migración `007`.
- **Mutaciones manuales: 18/18 detectadas** (fuera de turno, dos objetivos, Poder, no reducir la Vida, Ataque como daño, ignorar el porcentaje, no avanzar el turno, segundo `save`, repetición sin reconocer, `Math.random`, datos extra del cliente, aliado, Vida negativa, re-sorteo tras conflicto, publicar sin persistir, `round` en vez de `floor`, dado de Daño con 0 %, objetivo sin Vida).

## Pendientes

| Punto                                             | Estado                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bonos de daño del equipamiento y de habilidades   | **pendiente**: sin regla que los componga con el dado y el porcentaje (HU-19 / aclaración) |
| Participantes `AI` (JcE)                          | **pendiente**: sin fuente autoritativa de su perfil de combate                             |
| Ataque básico de Chamán y Médico                  | **pendiente**: el documento oficial no les da Ataque ni Daño; se rechaza                   |
| Daño en modo `PERCENTAGE` como base               | **pendiente**: sin definición formal; se rechaza                                           |
| Poder de batalla (`currentPower`)                 | HU-11 / HU-19; el ataque básico no lo toca                                                 |
| Eliminación, ganador y fin de batalla             | HU-21                                                                                      |
| Fuego amigo con excepciones                       | HU-12 / HU-19                                                                              |
| Serialización y difusión en memoria (una réplica) | ADR-020                                                                                    |

## Compatibilidad y despliegue

Aditivo: `battle.combatants` y `basicAttackResolved` no cambian ningún campo ni mensaje de HU-13/HU-17; `command.rejected` de `attack` lleva `command`, igual que el chat. **Orden:** Infrastructure → **Combat** (ejecutar `npm run migrate` antes de arrancar) → verificar → **Web**.
