# HU-85: salas internas SOLO, DUO y TRIO

Combat prepara dos lados completos de 1, 2 o 3 humanos. Tournament determina
modalidad, roster, calendario y aceptación; Combat conserva el motor PVP y su
límite global de seis minutos. El tamaño del bracket permanece en Tournament.

## Solicitud y respuesta

Se conserva `POST /api/internal/v1/combat/tournament-rooms`, HMAC y caller
`tournament`. La ampliación sigue la propuesta compartida
`Nexus-Battle-Infrastructure/docs/contracts/hu-85-83-tournament-combat-v3.md`;
la integración/publicación de ese contrato corresponde al chat A.

```json
{
  "contractVersion": 3,
  "operationId": "T1:E1",
  "tournamentId": "T1",
  "encounterId": "E1",
  "mode": "TRIO",
  "teamSize": 3,
  "teams": [
    { "teamId": "team-a", "memberIds": ["a1", "a2", "a3"] },
    { "teamId": "team-b", "memberIds": ["b1", "b2", "b3"] }
  ]
}
```

Las tres propiedades `contractVersion`, `mode` y `teamSize` se envían juntas.
Los IDs son referencias opacas de texto, como en el contrato anterior. Combat
resuelve nombres desde Account y héroes desde Player-Inventory. No acepta campos
para escoger héroe, ganador, sala, stake, capacidad o participantes de IA. En v3
rechaza propiedades desconocidas. Los errores de formato son 400; cardinalidad,
tamaño/modalidad contradictorios, equipos iguales y humanos repetidos son 422,
antes de consultar Account/Inventory. Una dependencia fallida conserva su error.

La sala y el registro HU-83 añaden
`tournament: { contractVersion: 3, mode: "TRIO", teamSize: 3 }`.
`BattleRoomDto.mode` sigue siendo `PVP`: representa otra dimensión. La capacidad
de cada Team coincide con su roster, recompensa de lobby = 0, sin stake.

## Compatibilidad e idempotencia

Una petición sin las tres propiedades nuevas mantiene exactamente dos miembros
por lado y la forma histórica de la respuesta. Seis miembros sin modalidad no
se interpretan como DUO. No se infiere TRIO de la longitud.

- Hash histórico: `canonicalBodyHash(cuerpo HTTP completo)`, incluida cualquier
  extensión antigua. `requestHashVersion` ausente equivale a 1. No se reescribe.
- Hash v3: SHA-256 de la solicitud validada, con IDs sin espacios exteriores,
  modalidad, tamaño y versión contractual. Se guarda `requestHashVersion: 2`.
  El orden de equipos y miembros se conserva: determina lados y asientos.
- Mismo operationId y huella/versión devuelve la sala vigente, incluso finalizada;
  una intención distinta responde 409. Los reintentos históricos conservan su
  cuerpo original; cambiar de versión en la misma operación produce conflicto.
- HMAC firma siempre el cuerpo completo recibido; la normalización de intención
  no modifica la firma ni la autorización.

Tournament debe conservar el operationId de cada justa. El índice único parcial
`tournament.operationId_1` de 018 mantiene la exclusión mutua de inserción. El
inicio usa `StartTournamentRoom` → `StartBattle.startRoom`, sin JWT ficticio ni
otro motor. Replay no vuelve a consultar servicios ni crea otra cola/evento.

## Persistencia y reloj

Ejecutar migraciones antes de arrancar. La nueva
`026-battle-rooms-tournament-cardinality` amplía los metadatos opcionales y valida
modo/tamaño, roster completo, humanos únicos, lados distintos, PVP y ausencia de
stake/recompensa de lobby. No modifica 018/025, sus registros ni documentos
existentes. Conserva el índice único. La migración es repetible.

Turno = 30 s, gracia = 30 s y límite global = 360 000 ms permanecen sin cambios.
El motor liquida una transición por llamada y procesa primero el vencimiento
más antiguo; las pruebas avanzan los turnos con reloj controlado antes de
comprobar 359 999/360 000 ms. El desempate existente usa porcentaje de vida,
vida absoluta y `NO_WINNER`. Este último se conserva como resultado de Combat;
no genera un sorteo ni una resolución de ausencia.

## Evidencia reproducible y sus límites

- `test/unit/tournament-cardinality-lifecycle.spec.ts`: perfiles/héroes de cada
  dueño, cola y combatants completos, compromisos, acciones de los seis actores,
  objetivos del asiento 2, habilidades, replays, reloj y justas independientes.
- `test/unit/tournament-room-intent.spec.ts`: huella histórica, normalización,
  conflictos, formato y campos no autoritativos.
- `test/integration/tournament-room-http.spec.ts`: Nest/HTTP/guard HMAC reales,
  caller exclusivo, firma alterada, formato/negocio y aislamiento público.
- `test/db/mongo-tournament-cardinality.spec.ts`: MongoDB real, upgrade desde
  025 con DUO antiguo, índice único, inserciones/inicios concurrentes E1/E2,
  respuesta perdida y nuevas conexiones/repositorios en PREPARING, IN_BATTLE y
  FINISHED; replays de E1/E2 desde procesos Node nuevos sin acceso a upstream ni
  posibilidad de crear otra sala/batalla. Reconstruye roster/resultado/registro
  sin truncar a cuatro.

Account, Inventory, compromisos y JWT son dobles declarados. Combat y MongoDB
son reales en la prueba de persistencia. No acredita cuentas reales, Tournament
end-to-end, premios, despliegue ni aceptación por usuarios. La transmisión no
interviene en el inicio.

La prueba de DB usa Testcontainers por defecto. También admite un MongoDB de
pruebas local mediante `COMBAT_TEST_MONGO_URI`; crea una base con nombre UUID y
elimina exclusivamente esa base al terminar. Ejemplo sin Docker:

```powershell
$env:COMBAT_TEST_MONGO_URI = 'mongodb://127.0.0.1:27038/?directConnection=true'
npm run test:db -- --runInBand test/db/mongo-tournament-cardinality.spec.ts --coverage=false
```

Esta ejecución focalizada no sustituye la suite DB completa con cobertura de CI.
El repositorio base de salas también admite `MONGO_TEST_URI`, con una base UUID
aislada, para comprobar las salas públicas y DUO históricas contra el mismo motor
real sin Docker.

Refs Nexus-Battle-VI/Nexus-Battle-Management#470
Refs Nexus-Battle-VI/Nexus-Battle-Management#465
Refs Nexus-Battle-VI/Nexus-Battle-Management#517
