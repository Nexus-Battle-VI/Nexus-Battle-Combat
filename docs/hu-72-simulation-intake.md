# Simulación interna de misiones (HU-72)

`POST /api/internal/v1/combat/simulations` acepta únicamente solicitudes firmadas
por `missions`. La versión 1 contiene héroe y habilidades congeladas, rotaciones,
encuentros, jefe, Máster opcional, reglas de combate y tabla de botín. Una forma
incorrecta recibe `400 SCHEMA_INVALID`; perfiles o reglas incompletas reciben
`422 MISSION_CONTENT_INVALID`; una firma inválida recibe `401`.

Combat valida el contenido, genera una secuencia privada y reproducible por
`operationId`, resuelve los combates por turnos y persiste el resultado antes de
responder `200`. Los ataques usan las estadísticas de cada combatiente, impacto
1d20, daño fijo o dados y críticos. Las rotaciones ejecutan habilidades de daño
soportadas cuando hay Poder y terminó la recarga; el respaldo es el ataque
básico. La IA `GUARDED` se protege cada tercer turno y la IA `BOSS` gana ataque
por debajo del umbral de vida editable. Hay recuperación entre encuentros,
límite de turnos por encuentro y límite de duración simulada. Un sanador sin
ataque usa las reglas editables `supportAttack`, `supportDamage` y `supportRegen`.

La tabla `bossDrops` se sortea solo cuando cae el jefe. `summary.loot` informa
nombre, cantidad y `productId` si existe. La bitácora, el resultado, las
estadísticas, la evidencia del Máster y el botín se conservan en la colección
creada por la migración `015-mission-simulation-results`. La migración `014`
mantiene la recepción y el SHA-256 del JSON canónico. Reintentar con el mismo
cuerpo y operación devuelve el mismo resultado sin volver a sortear. Cambiar el
cuerpo con el mismo `operationId` responde `409 OPERATION_ID_REUSED`.

La semilla real nunca sale de Combat: la respuesta solo contiene `seedRef`, una
referencia opaca. Las reglas y estadísticas se editan desde Missions; Combat no
consulta su catálogo ni lo modifica.
