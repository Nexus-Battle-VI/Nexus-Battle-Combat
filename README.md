# Nexus-Battle-Combat

Servicio de Nexus Battles VI para el bounded context **Combat**: salas, batallas por turnos, aleatoriedad y chat.

Implementa Jugar Online: salas y lobby, batallas por turnos con autoridad única del estado, el motor de reglas de combate, el generador centralizado de aleatoriedad y el chat. Es el **único** lugar del producto donde se ejecutan reglas de combate: Missions le pide simulaciones en lugar de duplicarlas.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Decisión que lo crea:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (`Accepted`)
- **Épicas:** [EPIC-06 Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6), [EPIC-08 Misiones (simulaciones)](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/8)
- **Team propietario:** Team Alfa
- **Arquitectura interna:** Clean + Hexagonal ([ADR-002](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-002-backend-stack.md))
- **Base de datos:** MongoDB, propia y exclusiva ([ADR-005](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-005-data-strategy.md))
- **Puerto:** 3006

## Estado

**Andamiaje desplegado.** Desde el 2026-09-16 corre en producción en el nodo `app` y Caddy le envía `https://nexus.simuladorupbbga.app/api/v1/combat*`. Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base, que ya existe con usuario propio.

**No tiene todavía ninguna ruta de negocio ni ninguna tabla o colección**: las añade cada Historia de Usuario. Mientras tanto, cualquier ruta bajo ese prefijo responde `404` desde NestJS.

### Motor pseudoaleatorio (HU-24)

**Generador implementado** (Mersenne Twister MT19937 → Box-Müller → índice 1..8000), registrado en la raíz de composición como `RANDOM_SEQUENCE_FACTORY`. **No es el motor de combate**: todavía no hay turnos, ataque, tabla de efectos (HU-25) ni selección de semilla (HU-26), y **ningún caso de uso ni endpoint lo consume aún**. La semilla y el estado son solo del servidor. Ver [docs/hu-24-randomness-engine.md](docs/hu-24-randomness-engine.md).

### Tabla de control de efectos aleatorios (HU-25)

**Implementada la resolución `RandomIndex` (HU-24) → fila → efecto, magnitud y porcentaje**: tabla de 8000 filas para los ocho tipos de héroe (Tabla 21 del documento oficial; los sanadores, sin distribución en el documento, con «no causar daño» = 100 % por decisión de diseño), mecánica de modificadores (+6 % de crítico compensado desde «no causar daño», Tabla 23) y su inversa (reducciones), el crítico 120–180 % materializado por la posición de la fila y el caso de uso `ResolveRandomEffect`. `BuildHeroEffectTable` construye la **tabla vigente del héroe equipado real** a partir de su `subtype` y sus `activeEffects` (Player-Inventory): `CRITICAL_CHANCE INCREASE PERCENTAGE` sobre uno mismo la modifica (100 pb = +1 punto porcentual absoluto), y los efectos que actúan sobre quien ataca al portador (`-2 % de crítico` y `-1 al ataque del oponente`) se aplican al preparar un golpe. Los efectos condicionados y temporales quedan en `pendingEffects`. **No hay endpoint público.** Ver [docs/hu-25-effect-control-table.md](docs/hu-25-effect-control-table.md).

### Inicio de batalla y orden de turnos (HU-17)

**Implementado** el inicio de batalla desde una sala `PREPARING` (`POST /api/v1/combat/rooms/{roomId}/start`, idempotente, revalida la elegibilidad precombate de HU-16), la **cola de turnos inmutable** generada con el motor de HU-24 (muestreo por rechazo, sin sesgo; alternancia de equipos; solo equipos del mismo tamaño; sin estadísticas), el avance de turno **del lado del servidor** (`CompleteBattleTurn`, sin ruta pública), `battleStarted`/`turnAdvanced` con `seq`, y el WebSocket de ADR-020 completo (**ticket de un solo uso**, `resume`/`snapshot`, latido, 16 KiB). La batalla se guarda en el mismo documento de la sala (migración `005`). El ataque básico (HU-18) ya es el primer consumidor del avance de turno; las habilidades llegaron con HU-19 y el fin de batalla con HU-21. Semilla: la validada por HU-26 (`COMBAT_RANDOM_SEED`, por defecto 3.000.000); el ciclo de vida de la secuencia (por proceso, por batalla, cursor) es una decisión técnica separada y **no** se establece como requisito. Ver [docs/hu-17-turn-order.md](docs/hu-17-turn-order.md).

### Resultado de un ataque (HU-20)

**Implementada la comparación Ataque contra Defensa** (`prepareAttack` y `ResolveAttack`): el Ataque es el efectivo del héroe (Player-Inventory) más el dado de la Tabla 6 (`10 + 1d6`, `10 + 1d8`, `10 + 1d10`), el golpe es efectivo si el Ataque **supera** la Defensa (la igualdad no supera), y **solo entonces** consume un índice más para el efecto de HU-25. **Sin endpoint HTTP**; su consumidor de producción es el ataque básico de HU-18. Ver [docs/hu-20-attack-resolution.md](docs/hu-20-attack-resolution.md).

### Ataque básico (HU-18)

**Implementado** el comando `attack` sobre el WebSocket de ADR-020 (`{"type":"attack","commandId","roomId","target":{"teamLabel","seat"}}`): Combat valida el turno y **un** objetivo enemigo con Vida, resuelve Ataque contra Defensa con HU-20 (`prepareAttack` + `ResolveAttack`, sin reescribirlos), materializa el daño (`floor(dañoBase × porcentaje / 100)`, redondeo aclarado en [Management #62](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/62#issuecomment-5761290722)), actualiza la Vida del objetivo y **avanza el turno en una sola escritura** junto con el evento `basicAttackResolved`, que difunde a los participantes **después** de persistir. `StartBattle` congela al empezar un perfil de combate por participante con la misma respuesta de Player-Inventory que ya usaba (sin llamadas por golpe); la Vida vive solo en Combat y `BattleView` añade `combatants[]` de forma aditiva. Idempotente por `commandId` (una repetición no sortea, no daña ni avanza), serializado por sala y **sin re-sorteo tras un conflicto de versión**. Migración `007` (ejecutar `npm run migrate` antes de arrancar). **No consume Poder** (Combat aún no modela el Poder de batalla), no incluye habilidades, fin de batalla ni participantes `AI`, y no aplica los bonos de daño del equipamiento (sin regla que los componga). Ver [docs/hu-18-basic-attack.md](docs/hu-18-basic-attack.md).

### Habilidades, Poder y recarga (HU-19)

**Implementado** el comando `useSkill` sobre el WebSocket de ADR-020 (`{"type":"useSkill","commandId","roomId","abilityId","target":{"teamLabel","seat"}}`): la habilidad es **la acción del turno** (un ataque mejorado por los modificadores propios de la habilidad) y se resuelve con HU-20 (`prepareAttack` + `ResolveAttack`). Combat valida el turno, **un** objetivo enemigo con Vida, que la habilidad sea del héroe del actor, que su efecto esté soportado y que no esté en **recarga**; cobra el **Poder** con `spendPower` de HU-11 y **avanza el turno en una sola escritura** junto con el evento `skillUsed`, que difunde **después** de persistir. **Poder insuficiente no es un error: la acción se degrada a un ataque básico** (`basicAttackResolved` con `degradedFrom`), con el Poder y la recarga intactos (HU-11). El Poder inicia en el máximo y regenera +2 al comenzar el turno propio; la recarga cuenta turnos propios. `StartBattle` congela `maxPower` y las habilidades del héroe con la misma respuesta de Player-Inventory (que ahora publica `abilities`); `BattleView.combatants[]` añade `power` y `skills[]` de forma aditiva. Idempotente por `commandId`, serializado por sala y **sin re-sorteo tras un conflicto de versión**. Migración `008` (ejecutar `npm run migrate` antes de arrancar). Solo se ejecutan los **modificadores propios de Ataque o Daño**: 10 de las 24 habilidades del Catalog desplegado; el resto (curación, reanimación, inmunidad, reflejo, duraciones, condiciones…) responde `UNSUPPORTED_SKILL_EFFECT`. **La habilidad épica NO está implementada**: depende de HU-31, que no define de dónde sale la épica activa. Ver [docs/hu-19-skills.md](docs/hu-19-skills.md).

### Finalización de batalla (HU-21)

**Implementada** la finalización por las tres causas del contrato (`hu-21-battle-finish-v1`): **eliminación** (en la misma escritura de la acción letal, con el evento de la acción y `battleFinished` de `seq` contiguo), **desconexión** con gracia de **30 s** para reconectar desde la última conexión de batalla, y **vencimiento global de 6 minutos** (gana el mayor porcentaje de vida por producto cruzado entero; empate de porcentaje → mayor vida absoluta; empate total → `NO_WINNER`, pendiente del PO). El **turno de 30 s** que vence pierde el turno y no cierra la batalla. El estado terminal `FINISHED` guarda un **resultado único** (`result` en `snapshot`, en `GET /rooms/{id}` y en el evento `battleFinished`), restaura el **Poder** (HU-11) en la vista final, cierra el chat de la sala y **libera** las conexiones (sin cerrar sockets) y los vencimientos. El tiempo sale siempre de `ClockPort`: barrido de 1 s más **liquidación perezosa** en cada comando; los vencimientos globales y de turno sobreviven al reinicio. La señal a consumidores (HU-22/23/30/29/09) se publica **una vez** por el puerto de resultados: aquí **solo escribe un registro** con `roomId`, `reason`, `outcome` y `winnerTeamLabel`; los **créditos del §7.6 viajan como derecho, no se acreditan** (pendiente de ratificar por el PO). Migración `009` (ejecutar `npm run migrate` antes de arrancar). **Aviso:** una sala `IN_BATTLE` anterior a HU-21 que ya superó los 6 minutos se cierra sola en el primer barrido. Ver [docs/hu-21-battle-finish.md](docs/hu-21-battle-finish.md).

### Salas activas del jugador (volver a mi sala)

`GET /api/v1/combat/me/rooms` devuelve las salas **no terminales** (`WAITING_FOR_PLAYERS`, `PREPARING`, `IN_BATTLE`) en las que participa el jugador autenticado, más las que **creó** y siguen esperando jugadores (crear una sala no une al creador salvo que apueste), de la más reciente a la más antigua, con la misma vista que `GET /rooms/{id}` (la apuesta ajena no se expone). El jugador sale **solo** del testimonio. Existe porque el listado público solo muestra salas en espera con cupo: una sala propia llena, preparándose o en batalla solo se recuperaba conociendo su id. Un jugador puede estar en varias salas a la vez. Migración `012` (índices `teams.participants.playerId` + `status` y `createdBy` + `status`, solo aditiva).

### Chat del lobby y de las salas (HU-13)

**Implementado** sobre el WebSocket de ADR-020 (`/api/v1/combat/realtime`), dentro del gateway existente: dos contextos —el **lobby** (la vista general de Jugar Online, un canal global) y **cada sala** (solo sus participantes humanos, mientras la sala esté activa)—, con comandos `chat.subscribe` / `chat.send` / `chat.unsubscribe`, procesado una sola vez por `commandId`, `seq` por canal, persistencia **antes** de difundir y recuperación con `lastSeq`. Longitud 500, frecuencia 5 cada 10 s y retención configurables (las cifras las ratificó el PO por chat; **la retención de 7 días no tiene ninguna fuente y el PO debe fijarla**). **Censura server-side del lenguaje ofensivo** con `#` antes de persistir y difundir (`ChatProfanityPolicy`; el mensaje no se rechaza), **sin desplegar** (`main` va por detrás de `develop`; exige la migración `006`, que va después de la `005` de HU-17) y **una sola réplica** (ADR-020). El chat de la sala queda **abierto también durante la batalla** (`IN_BATTLE`) y **se cierra al finalizar** (`FINISHED`, HU-21): decisiones técnicas derivadas de «sala activa», pendientes de confirmar por el PO. Al empezar se encontraron dos defectos de HU-15.2 que dejaban sin funcionar el WebSocket entero; HU-17 corrigió por su cuenta el registro del gateway y la carrera de `auth` desapareció con el ticket de un solo uso. Ver [docs/hu-13-chat.md](docs/hu-13-chat.md).

## Qué posee este contexto

- Salas y lobby: modalidad, cupo, composición humana/IA, recompensa, estado.
- Batallas: participantes, orden de turnos, vida, Poder, efectos activos y bitácora.
- Semillas y simulaciones (para reproducir un resultado sin exponerlo mientras está abierto).
- Mensajes de chat de sala y lobby.

Ningún otro servicio accede a este almacén, ni directamente ni con claves foráneas.

## Historias de Usuario que viven aquí

| HU    | Historia                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| HU-14 | [Crear sala de batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/23)                                      |
| HU-15 | [Unirse a una sala de batalla existente](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/24)                     |
| HU-16 | [Validar equipamiento del héroe antes del combate](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/25)           |
| HU-13 | [Chat en sala de batalla y en el lobby](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/22)                      |
| HU-24 | [Generar variable pseudoaleatoria de alta precisión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71)         |
| HU-25 | [Aplicar tabla de control de efectos aleatorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72)             |
| HU-26 | [Selección y validación estadística de la semilla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/73)           |
| HU-17 | [Determinar orden de turnos](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/26)                                 |
| HU-20 | [Calcular resultado de un ataque (Ataque vs. Defensa)](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/64)       |
| HU-18 | [Ejecutar ataque básico](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/62)                                     |
| HU-19 | [Ejecutar habilidad épica](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/63)                                   |
| HU-12 | [Prevención de daño entre aliados](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/21)                           |
| HU-21 | [Determinar condición de finalización de la batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/65)         |
| HU-23 | [Uso de créditos como apuesta en batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/70)                    |
| HU-22 | [Entrega de cofre de recompensa por acumulación de créditos](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69) |

**HU-11 ([Gestión del recurso Poder](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/20)) ya está cerrada, pero se entregó en Player/Inventory**, no aquí. La regla vive allí como política de dominio (`HeroPowerPolicy`) y su especificación está en [`docs/hu-11-power.md`](https://github.com/Nexus-Battle-VI/Nexus-Battle-Player-Inventory/blob/develop/docs/hu-11-power.md).

Combat la **reimplementa a propósito** en `HeroPowerPolicy` (no puede importar código de otro repositorio, ADR-001) y la mantiene alineada con los mismos vectores de prueba de Player/Inventory. Lee el Poder máximo del héroe (`EquippedHero.maxPower`) y, **desde HU-19**, el agregado de batalla guarda el Poder de cada participante (`Combatant.currentPower`), lo cobra con `spendPower` al usar una habilidad y lo regenera con `regenPower` al comenzar el turno propio; el valor viaja en `battle.combatants[].power` (ADR-020). Ver [docs/hu-11-hero-power.md](docs/hu-11-hero-power.md).

## Integraciones previstas

- **Player/Inventory** (síncrono, `operationId`): perfil de combate del héroe y compromiso `BATTLE`. El Poder máximo del héroe es `effectiveStats.power` del contrato `equipped-hero`, que Combat modela como `maxPower`.
- **Wallet** (síncrono, `operationId`): reservar apuestas, transferir al ganador, liberar al cancelar.
- **Entrada interna** (`/api/internal/v1/combat/simulations`, HMAC): Missions ejecuta simulaciones.
- **Tiempo real** (ADR-020): WebSocket en `/api/v1/combat/realtime` a través de Caddy. Autentica con un **ticket de un solo uso** (HU-17): se pide por HTTP y se envía como primer mensaje; el JWT no viaja por el socket. Lo usan el aviso de cambios de sala (HU-15.2), la batalla (HU-17) y el chat (HU-13).

Detalle en [docs/architecture.md](docs/architecture.md).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
    inbound/ws/      Gateway WebSocket (ADR-020) y el manejador del chat
    outbound/        Persistencia, identidad, clientes de otros servicios
  infrastructure/    config, observabilidad, salud, persistencia y composición
```

El dominio no importa NestJS, drivers ni adaptadores, y la aplicación depende solo de sus puertos: lo impide ESLint en CI. Los casos de uso son clases sin decoradores registradas con fábricas en `src/infrastructure/bootstrap/app.module.ts`.

## Verificación local

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:db        # requiere Docker: levanta MongoDB con Testcontainers
npm run test:perf      # requiere Docker; NO forma parte del CI: latencia del chat con WebSocket real
npm run build
```

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                             | Resultado                |
| ----------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`        | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory` | **No arranca** (ADR-019) |
| `PERSISTENCE_DRIVER=mongo` sin `MONGODB_URI`          | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                    | **No arranca**           |

## Identidad y autorización

- **Toda ruta nace protegida.** El guard es global; abrir una ruta exige `@Public()`.
- La identidad sale del token de acceso verificado contra el JWKS del pool (`aws-jwt-verify`), nunca del cuerpo ni de la URL.
- `@Roles(...)` restringe por rol; `SUPER_ADMINISTRATOR` satisface lo que se exige a `ADMINISTRATOR`, y no al revés.
- Las rutas `@InternalOnly()` exigen firma HMAC-SHA256 (`x-internal-service`, `x-internal-timestamp`, `x-internal-signature`) de un servicio de la lista `INTERNAL_CALLERS`. Sin secreto configurado responden `503`. Caddy bloquea `/api/internal*` desde fuera.

## Sondas

| Ruta                    | Semántica                                     |
| ----------------------- | --------------------------------------------- |
| `GET /api/health/live`  | El proceso responde. No consulta dependencias |
| `GET /api/health/ready` | Hace ping a MongoDB. `503` si no responde     |
| `GET /api/version`      | Servicio, versión y entorno                   |

## Ramas

`main` y `develop` están protegidas. Todo Pull Request va a **`develop`**; `main` solo recibe la promoción completa de `develop`, y el workflow `Flujo de ramas` lo hace cumplir. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Licensing pending project governance.
