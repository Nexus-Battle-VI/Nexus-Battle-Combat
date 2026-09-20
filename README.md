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

**Implementada la resolución `RandomIndex` (HU-24) → fila → efecto y magnitud**: tabla de 8000 filas por tipo de héroe (Tabla 21 del documento oficial: Guerrero Tanque/Armas, Mago Fuego/Hielo, Pícaro Veneno/Machete), mecánica de modificadores (+6 % de crítico compensado desde «no causar daño», Tabla 23) y caso de uso `ResolveRandomEffect`. **Aún no la invoca ningún flujo** (HU-20 deberá hacerlo cuando Ataque > Defensa), **nadie construye todavía la tabla a partir del héroe equipado real**, no calcula daño numérico y **no hay endpoint público**. Pendientes: Chamán/Médico sin tabla válida en el documento, selección concreta del crítico 120–180 % y contrato de modificadores desde Player-Inventory. Ver [docs/hu-25-effect-control-table.md](docs/hu-25-effect-control-table.md).

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
| HU-11 | [Gestión del recurso Poder](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/20)                                  |
| HU-19 | [Ejecutar habilidad épica](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/63)                                   |
| HU-12 | [Prevención de daño entre aliados](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/21)                           |
| HU-21 | [Determinar condición de finalización de la batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/65)         |
| HU-23 | [Uso de créditos como apuesta en batalla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/70)                    |
| HU-22 | [Entrega de cofre de recompensa por acumulación de créditos](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/69) |

## Integraciones previstas

- **Player/Inventory** (síncrono, `operationId`): perfil de combate del héroe y compromiso `BATTLE`.
- **Wallet** (síncrono, `operationId`): reservar apuestas, transferir al ganador, liberar al cancelar.
- **Entrada interna** (`/api/internal/v1/combat/simulations`, HMAC): Missions ejecuta simulaciones.
- **Tiempo real** (ADR-020): WebSocket en `/api/v1/combat/realtime` a través de Caddy, con ticket de un solo uso.

Detalle en [docs/architecture.md](docs/architecture.md).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
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
