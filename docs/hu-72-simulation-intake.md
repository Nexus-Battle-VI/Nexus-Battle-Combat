# Ingreso interno de simulaciones de Missions (HU-72)

`POST /api/internal/v1/combat/simulations` reutiliza el guard HMAC de Combat y
admite únicamente `x-internal-service: missions`. El cuerpo es el contrato de
Missions: versión 1, identidad de la operación y de la matrícula, dificultad,
presupuesto de tiempo, perfil del héroe, rotaciones, encuentros y Máster
opcional. La validación cubre la forma de transporte. Los perfiles de enemigos
pueden seguir en `null`: no se inventan estadísticas ni decisiones de IA.

La migración `014-mission-simulation-intake` crea un documento por `operationId`
con el SHA-256 del JSON canónico y la fecha de recepción. Reintentar con el
mismo cuerpo conserva la operación; cambiar el cuerpo con la misma clave
responde `409 OPERATION_ID_REUSED`. La clave sobrevive al reinicio en MongoDB.

Por ahora la ruta **no ejecuta combates ni devuelve `200`**. Tras registrar una
solicitud válida responde `503 SIMULATION_UNAVAILABLE`, que Missions reintenta
con la misma clave. Cuerpos mal formados reciben `400 SCHEMA_INVALID`; una firma
ausente o incorrecta recibe `401` del guard. No se consume aleatoriedad ni se
emite bitácora, recompensa o resultado ficticio.

La siguiente etapa deberá conectar este ingreso al motor de combate y persistir
el resultado completo antes de responder. Aún faltan la política de IA enemiga,
los perfiles de enemigos y jefe, el tiempo simulado por turno y el escalado por
encuentro. Esas reglas no se eligen en la frontera HTTP.
