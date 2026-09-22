# HU-19 — Ejecutar habilidad épica (habilidades especiales, Poder y recarga)

> Estado: **implementado en Combat** (Task [#414](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/414)) sobre el contrato
> [`hu-19-skills-v1`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-19-skills-v1.md)
> (Task [#413](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/413)). Web ([#415](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/415))
> y la validación 1 contra 1 ([#416](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/416)) son Tasks aparte. Este documento
> distingue en cada punto qué es requisito explícito, aclaración formal, decisión confirmada por el PO, decisión técnica o pendiente.
>
> **La habilidad ÉPICA NO está implementada.** Depende de HU-31 (#78): no existe una fuente de «épica activa/equipada» y el Catalog v1 admite un solo
> efecto específico por épica. Combat no crea `activeEpic` ni `epicSlot` (una guarda estática lo comprueba). Ver [Épica](#épica-bloqueada-hu-31).

## Trazabilidad

| Elemento            | Referencia                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario | [HU-19 — Ejecutar habilidad épica](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/63) (#63) · RF-19 · EPIC-06                                                                                             |
| Bloqueada por       | HU-11 (Poder, cerrada), HU-17 (turnos, cerrada) y **HU-31 (#78, abierta)**                                                                                                                                                   |
| Arquitectura        | ADR-019 (Combat única autoridad), ADR-020 (comandos por WebSocket con `commandId`, `seq`, persistir antes de difundir), ADR-021 (aleatoriedad HU-24/HU-25). Sin ADR nuevo.                                                   |
| Fuente oficial      | «Proyecto Integrador II»: Tabla 7 (habilidades especiales), Tabla 20 (épicas), Poder (HU-11). Cuando el Catalog y el documento difieren, manda el documento (instrucción del PO); las divergencias están en el contrato §16. |

## Clasificación de lo decidido

| #   | Tipo                                                                                | Contenido                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito explícito (HU-19)                                                         | Solo en el turno propio; el costo de Poder se valida y se descuenta; la recarga se respeta; un objetivo válido; el resultado se difunde a ambos clientes; **las habilidades de otra clase se rechazan (CA-02)**.                                                                                                                                                      |
| 2   | Aclaración formal (HU-11)                                                           | **Poder insuficiente ⇒ NO es un error: la acción se degrada a un ataque básico en ese turno.** El Poder y la recarga quedan intactos.                                                                                                                                                                                                                                 |
| 3   | Decisión confirmada por el PO (chat externo, 2026-09-21; **no consta en el issue**) | La habilidad es **la acción del turno** (un ataque mejorado); sus modificadores propios valen solo para esa resolución; la recarga es «bloqueada N turnos propios siguientes»; el Poder inicia en el máximo (`effectiveStats.power`) y regenera +2 (tope máximo) al comenzar el turno propio; el Poder pertenece al participante `(teamLabel, seat)`, no al `heroId`. |
| 4   | Decisión técnica (pendiente de confirmar)                                           | El porcentaje del efecto se aplica sobre `daño base + bono de daño de la habilidad` (`floor((base + bono) × % / 100)`). Es la lectura más simple de «+N al daño»; el documento no la fija.                                                                                                                                                                            |
| 5   | Decisión técnica                                                                    | Comando `useSkill`; evento `skillUsed` con el estado ya avanzado; congelar habilidades y Poder al iniciar; migración `008`; orden de sorteos; efectos soportados (solo modificadores propios de Ataque o Daño); códigos de error.                                                                                                                                     |
| 6   | Pendiente                                                                           | Ver [Pendientes](#pendientes).                                                                                                                                                                                                                                                                                                                                        |

## Flujo

```text
Web A ── {"type":"useSkill","commandId","roomId","abilityId","target":{teamLabel,seat}} ──▶ Gateway (sub autenticado)
        SkillRealtimeHandler       forma exacta del mensaje · sin datos del cliente
        UseSkill                   serializa por sala
          BattleRoom.planSkill            VALIDA (0 sorteos): commandId/repetición → batalla → turno → objetivo → equipo → perfiles y Vida
                                          → SKILLS_NOT_AVAILABLE → UNKNOWN_SKILL → UNSUPPORTED_SKILL_EFFECT → SKILL_ON_COOLDOWN → Poder
                                          └─ Poder insuficiente ⇒ se DEGRADA: ExecuteBasicAttack.executeExclusively (con degradedFrom)
          dados de bono de Ataque · prepareAttack + ResolveAttack (HU-20) · (si efectivo) efecto HU-25 · dado de Daño · dados de bono de Daño
          BattleRoom.applySkill           UNA transición: Vida + Poder + recarga + evento + commandId + turno avanzado
          rooms.save                      UNA escritura, bloqueo optimista
        Gateway.publish              DESPUÉS de persistir ──▶ Web A y Web B (mismos bytes)
```

## De dónde salen las habilidades

Player-Inventory extiende `GET /api/v1/players/{playerId}/equipped-hero` con `abilities` (lista blanca: `abilityId`, `reference`, `name`, `powerCost`, `chargeTurns`, `effects`, **sin** `raw`, condición ni `immunityCode`), a partir del Catalog `HABILIDAD` del héroe. `StartBattle` congela, con **esa misma respuesta**, `maxPower` (`effectiveStats.power`) y las habilidades de cada participante; después no hay llamadas a Player-Inventory ni a Catalog. Si `abilities` falta, el inicio falla como fallo del servicio (`503`): **orden de despliegue Player-Inventory → Combat → Web**.

## Estado de batalla

- **Poder** (`Combatant.currentPower`, `0 ≤ currentPower ≤ maxPower`, entero): inicia en el máximo; el pago lo descuenta (`spendPower` de HU-11; `ALL_AVAILABLE` gasta todo lo disponible); regenera +2, con tope en el máximo, **al comenzar el turno propio** (`regenPower` de HU-11, desde `BattleState.completeTurn`). El ataque básico **no** lo toca.
- **Recarga** (`Combatant.cooldowns`, por `abilityId`): al usar una habilidad se marca `chargeTurns + 1` y **cerrar el turno propio** descuenta 1, así que tras la acción quedan `chargeTurns` turnos propios de bloqueo. Con `chargeTurns = 1` (Catalog v1): usada en T, bloqueada en T + 1 (`SKILL_ON_COOLDOWN`, sin sorteos, sin tocar la sala) y libre en T + 2.
- **Vista pública** (`BattleView.combatants[]`, aditiva): `power {current,max}` y `skills[{abilityId,name,powerCost,chargeTurns,cooldownRemaining,status}]` con `status` = `READY | RECHARGING | UNSUPPORTED`. Nunca viajan efectos, `raw`, semilla ni índices. Un participante sin perfil (`AI`) publica `power: null` y `skills: []`.
- **Batallas anteriores a HU-19** (sin `abilities`): se restauran sin error, `useSkill` responde `SKILLS_NOT_AVAILABLE` y el ataque básico sigue funcionando. No hay _backfill_.

## Resolución

La habilidad es **la acción del turno**: se resuelve como un ataque (HU-20 `prepareAttack` + `ResolveAttack`) mejorado por los modificadores propios de la habilidad, y **el turno avanza** como con cualquier acción.

```text
Ataque       = Ataque del héroe + 1d(Tabla 6) + bono de Ataque de la habilidad   (fijo + dados)
dañoBase     = daño del héroe (DICE se tira · FIXED tal cual) + bono de Daño de la habilidad
dañoCalculado= floor( (dañoBase) × porcentaje / 100 )                            (decisión técnica #4)
dañoAplicado = min( dañoCalculado, Vida actual )
```

### Orden exacto de sorteos (HU-24)

| Paso                        | Sorteos                       | Cuándo                                                        |
| --------------------------- | ----------------------------- | ------------------------------------------------------------- |
| 1. Dados del bono de Ataque | `count` de cada dado del bono | siempre que la habilidad los declare                          |
| 2. Dado de Ataque           | 1                             | siempre (HU-20, sin cambios)                                  |
| 3. Efecto                   | 1                             | solo si el golpe es efectivo (HU-20, sin cambios)             |
| 4. Dado de Daño del héroe   | `damage.count`                | solo si es efectivo, el porcentaje es > 0 y el Daño es `DICE` |
| 5. Dados del bono de Daño   | `count` de cada dado del bono | solo si es efectivo y el porcentaje es > 0                    |

Con un efecto del 0 % **no se tira nada innecesario**. Un rechazo previo consume **cero** sorteos.

### Poder insuficiente: se degrada (HU-11)

Si el costo no se puede pagar, `UseSkill` **no falla**: delega en `ExecuteBasicAttack.executeExclusively` (ya bajo el bloqueo de la sala) con `degradedFrom`. Llega un `basicAttackResolved` con el **mismo `commandId`** y `degradedFrom {command:"useSkill", abilityId, reason:"INSUFFICIENT_POWER"}`; el Poder y la recarga quedan intactos y el turno avanza. Es la única rama en la que `useSkill` produce un evento distinto de `skillUsed`.

## Efectos soportados

`evaluateSkill` (política pura, sin E/S) acepta una habilidad **solo si todos** sus efectos son un modificador propio de Ataque o de Daño: `STAT_MODIFIER`, `SELF`, `INCREASE`, estadística `ATTACK`/`DAMAGE`, magnitud `FIXED` (entero ≥ 1) o `DICE` (`count ≥ 1`, `sides ≥ 2`), **sin duración y sin condición**. Cualquier otra cosa (curación, reanimación, inmunidad, reflejo, efectos sobre el oponente, duraciones, condiciones, `DEFENSE`…) invalida **toda** la habilidad: `UNSUPPORTED_SKILL_EFFECT` y `status: UNSUPPORTED`; nunca se aplica a medias ni se descarta en silencio, y el motivo interno **no viaja**.

Del Catalog desplegado hoy, **10 de las 24 habilidades** cumplen: Golpe con escudo, Embate sangriento, Lanza de los dioses, Golpe de tormenta, Misiles de magma, Vulcano, Lluvia de hielo, Flor de loto, Machetazo y Planazo. Las tres habilidades sanadoras no. Una prueba recorre las 24 con sus datos reales.

## Errores (`command.rejected {command:"useSkill", commandId?, code}`)

`MALFORMED_COMMAND` · `INVALID_COMMAND_ID` · `ROOM_NOT_FOUND` · `NOT_A_PARTICIPANT` · `BATTLE_NOT_ACTIVE` · `NOT_YOUR_TURN` · `INVALID_TARGET` · `SAME_TEAM_TARGET` · `TARGET_UNAVAILABLE` · `ACTOR_UNAVAILABLE` · `UNSUPPORTED_COMBAT_PROFILE` · **`SKILLS_NOT_AVAILABLE`** · **`UNKNOWN_SKILL`** · **`UNSUPPORTED_SKILL_EFFECT`** · **`SKILL_ON_COOLDOWN`** · `COMMAND_CONFLICT` · `INTERNAL_ERROR`. Los cuatro en negrita son nuevos. Solo se le responde al remitente; el resto de la sala no se entera.

## Idempotencia y concurrencia

Igual que HU-18 y con las mismas garantías: un `commandId` repetido devuelve el mismo evento **solo a quien lo repite**, sin sorteos, sin cobrar el Poder otra vez y sin marcar la recarga otra vez; la sala se serializa (`RoomCommandLockPort`), dos comandos distintos del mismo jugador en el mismo turno dejan pasar uno y el otro recibe `NOT_YOUR_TURN` sin haber consumido sorteos; tras un conflicto de versión **nunca se vuelve a sortear** (`resolveConflict` relee la sala y devuelve el resultado guardado o `COMMAND_CONFLICT`).

## Atomicidad, persistencia y migración `008`

`BattleRoom.applySkill` produce **una sola versión** del agregado con la Vida del objetivo, el Poder y la recarga del actor, el evento `skillUsed`, el `commandId` y el turno avanzado; `UseSkill` hace **una** escritura y el gateway difunde **después** de persistir. La migración `008-battle-rooms-skills` es aditiva y autocontenida (validador `$jsonSchema` con `maxPower`, `abilities`, `currentPower`, `cooldowns` y el evento `skillUsed`; su `down` restaura el validador de `007`). Ejecutar **antes** de arrancar la versión nueva: `npm run migrate`.

## Seguridad

El cliente no aporta costo, Poder, recarga, efectos, Ataque, Defensa, Daño, Vida, semilla ni turno; el actor es el `sub` de la conexión y el turno vigente. Cualquier clave de más hace el comando mal formado. Nunca viajan semilla, índices, `raw`, efectos ni el motivo de un efecto no soportado. Los logs registran `roomId`, `commandId` y códigos, no perfiles ni JWT.

## Épica (bloqueada, HU-31)

- No existe una fuente de «épica activa/equipada» (auditoría de `josemora090525` en #78, 2026-09-21).
- El Catalog v1 (`EPICA`) admite **un solo** `specificEffect`; al menos 5 de las 8 épicas de la Tabla 20 combinan varios efectos.
- Por eso Combat **no** implementa la épica, no crea `activeEpic` ni `epicSlot`, y `abilities` solo lleva `HABILIDAD`. Una guarda estática lo comprueba. Cuando HU-31 defina la fuente, la épica se añade sin cambiar el contrato de `useSkill` salvo un identificador nuevo.

## Relación con otras historias

- **HU-11:** se reutilizan `HeroPowerPolicy` (`spendPower`, `regenPower`); el ataque básico sigue sin consumir Poder.
- **HU-17 / HU-18:** se reutiliza la cola, `seq`, `resume`/`snapshot`, `BattleState.completeTurn` y el ataque básico (para la degradación). `basicAttackResolved` gana el campo opcional `degradedFrom` (aditivo).
- **HU-20 / HU-24 / HU-25:** se reutilizan sin reescribirlos.
- **HU-12 (abierta):** la habilidad **rechaza** objetivos del mismo equipo (`SAME_TEAM_TARGET`); no implementa curación ni habilidades sobre aliados.
- **HU-21 (implementada):** una Vida en 0 finaliza la batalla si deja a un equipo sin héroes (la habilidad letal arrastra `battleFinished` en su misma escritura); un participante sin Vida no puede ser objetivo ni actuar (igual que HU-18).
- **HU-31 (abierta):** la épica queda fuera.

## Pruebas

- **Dominio:** `evaluateSkill` (incluida una tabla con las **24** habilidades reales del Catalog), `Combatant` (Poder, recarga, invariantes, `restore`), `BattleState.completeTurn` (recarga y regeneración por participante), `BattleRoom.planSkill`/`applySkill`.
- **Aplicación:** `UseSkill` con la secuencia HU-24 **guionizada** (orden y conteo de sorteos, bonos con dados, degradación, efecto 0 %, golpe no efectivo, rechazos con 0 sorteos, idempotencia, concurrencia, conflicto sin re-sorteo).
- **Adaptador y gateway:** forma exacta del comando (`SkillRealtimeHandler`), difusión a los participantes, rechazo solo al remitente.
- **Guardas estáticas** (`hu-19-skills-guards.spec.ts`): toda la aleatoriedad sale de `RandomSequencePort.nextIndex()` (sin `Math.random`/`crypto`/`Date.now`) y con el orden de dados del contrato; el Poder solo se maneja con `spendPower`/`regenPower` de HU-11; la política de efectos es pura; sin llamadas cruzadas por acción; una sola escritura y una sola transición (`applySkill`); la ruta no resta el Ataque de la Vida; el cliente no aporta resultados; el Poder insuficiente no tiene código de error propio; el motivo de un efecto no soportado no viaja; ningún archivo declara `activeEpic` ni `epicSlot`.
- **Extremo a extremo de protocolo** (`test/db/skills.e2e.spec.ts`): **MongoDB real** (Testcontainers), servidor Nest real y **dos clientes `ws` reales** con la secuencia guionizada: habilidad, recarga y regeneración a lo largo de los turnos, Poder insuficiente, rechazos, idempotencia y concurrencia, reconexión, recarga de página, reinicio de Combat, batallas anteriores a HU-19 y la migración `008`.
- **No verificado:** contra Player-Inventory y Catalog **reales desplegados** ni en navegadores reales (Task #416 pendiente).

## Pendientes

| Punto                                                              | Estado                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Habilidad épica                                                    | **bloqueada por HU-31**                                                                                                         |
| Porcentaje sobre `daño base + bono`                                | **decisión técnica pendiente de confirmar por el PO**                                                                           |
| «Efectos temporales o condicionados» del equipamiento              | **no evaluados** (HU-18 dejó una nota; el texto de HU-19 no los pide)                                                           |
| Curación, reanimación, inmunidad, reflejo, duraciones, condiciones | `UNSUPPORTED_SKILL_EFFECT`; requieren definición formal; **divergencias Catalog ↔ documento** por corregir antes de soportarlos |
| Fuego amigo / habilidades sobre aliados                            | HU-12                                                                                                                           |
| Eliminación, ganador y fin de batalla                              | HU-21                                                                                                                           |
| Serialización y difusión en memoria (una réplica)                  | ADR-020                                                                                                                         |

## Compatibilidad y despliegue

Aditivo: `combatants[].power`/`skills`, `skillUsed` y `degradedFrom` no cambian ningún campo ni mensaje de HU-13/HU-17/HU-18; un Web anterior los ignora. **Orden:** Infrastructure (contrato) → **Player-Inventory** (publica `abilities`) → **Combat** (`npm run migrate` para la `008`, antes de arrancar) → Web. Combat exige `abilities` en la respuesta de Player-Inventory: desplegar Combat primero hace que el inicio de batalla falle con `503`.
