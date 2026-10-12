# Simulación interna de misiones (HU-72)

`POST /api/internal/v1/combat/simulations` acepta únicamente solicitudes firmadas
por `missions`. La versión 1 contiene héroe y habilidades congeladas, rotaciones,
encuentros, jefe, Máster opcional, reglas de combate y tabla de botín. Una forma
incorrecta recibe `400 SCHEMA_INVALID`; perfiles o reglas incompletas reciben
`422 MISSION_CONTENT_INVALID`; una firma inválida recibe `401`.

Combat valida el contenido, genera una secuencia privada y reproducible por
`operationId`, resuelve los combates por turnos y persiste el resultado antes de
responder `200`. Los ataques usan las estadísticas de cada combatiente, impacto
1d20, daño fijo o dados y críticos.

Las rotaciones siguen la decisión por turno del diseño de HU-71 (P-R5 a P-R7):
cada rotación mira solo la acción de su cursor y Combat impone estrictamente
`HIGH -> MEDIUM -> LOW`. En cuanto encuentra la primera viable, es la única
acción ofrecida a la política. Si no es viable (habilidad desconocida, efecto no
soportado, en recarga, sin Poder, curación con salud >= 90 % o acción ofensiva
para un soporte puro), se prueba la siguiente sin avanzar su cursor. Si ninguna
es viable, un héroe con ataque y daño usa el ataque básico de respaldo (CA-03).
Un CHAMÁN/MÉDICO sin estadísticas ofensivas no recibe valores inventados ni
fallback ofensivo: Combat registra `SYSTEM/END_TURN` con `legalActions=[]` y el
enemigo continúa. Cada `heroAction` de la bitácora lleva el bloque `strategy` (rotación y paso
usados, si fue respaldo y por qué se saltaron las anteriores), y cada baja se
registra como `combatantDefeated` con su `encounter` y la instancia numerada
(`<enemyRef>#<n>`), que es lo que Missions usa para la experiencia de HU-09.

La IA `GUARDED` se protege cada tercer turno y la IA `BOSS` gana ataque
por debajo del umbral de vida editable. Hay recuperación entre encuentros,
límite de turnos por encuentro y límite de duración simulada. Un sanador sin
ataque conserva únicamente la recuperación `supportRegen`; `supportAttack` y
`supportDamage` se aceptan por compatibilidad del contrato v1, pero no se usan
para fabricar capacidad ofensiva.

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
