# HU-93.1 — Preparación del participante IA

## Alcance

Combat prepara el participante `AI` de una sala JcE 1v1 antes de iniciar la
batalla. El resultado es un `CombatProfile` congelado con héroe, habilidades,
estadísticas efectivas, efectos de equipamiento y, cuando corresponde, una
épica. No crea usuario, jugador, inventario ni ownership para el bot.

El turno automático pertenece a HU-93.2 y no forma parte de esta entrega. Los
participantes IA de Tournament tampoco se preparan aquí: el contrato queda
reutilizable, pero su integración requiere una Task de Torneos.

## Frontera con Catalog

`CatalogBotCandidatesHttpClient` consume exclusivamente:

```http
GET /api/internal/v1/catalog/combat/bot-candidates
```

La petición usa el caller `combat`, HMAC-SHA256 y el secreto interno existente.
El parser acepta únicamente `schemaVersion: "1"` y valida la estructura de
héroes, habilidades, equipamiento, compatibilidades, efectos y épicas. Combat
no consulta la vitrina pública ni la base de datos de Catalog.

`CATALOG_SERVICE_BASE_URL` configura la URL. En desarrollo se usa
`http://catalog:3003` como valor local compatible con la red de Docker Compose;
en producción la variable es obligatoria.

## Selección y RNG

Las colecciones se ordenan por `productId` antes de cualquier selección. Todo
azar usa la misma instancia `BATTLE_RANDOM`; no existe semilla ni generador
paralelo para bots.

El orden de consumo para cada bot JcE es:

1. héroe uniforme;
2. hasta dos armas, sin repetir definición;
3. una armadura compatible por ranura, en orden `HEAD`, `CHEST`, `GLOVES`,
   `BRACERS`, `PANTS`, `SHOES`;
4. hasta dos ítems, sin repetir definición;
5. roll de épica `nextInt(10_000)`: `0..499` sí, `500..9999` no;
6. selección uniforme de una épica compatible si el roll fue positivo;
7. generación del orden de turnos existente.

Una sala JcJ no ejecuta ninguno de los pasos 1–6, por lo que conserva su consumo
histórico de RNG. Reintentar el inicio de una sala ya `IN_BATTLE` tampoco vuelve
a consultar Catalog ni vuelve a sortear.

## Loadout y estadísticas

La capacidad 2 armas / 6 armaduras / 2 ítems y las ranuras de armadura son las
reglas vigentes de Player-Inventory. Son techos, no mínimos: no existe una
configuración obligatoria formal por subtipo. `setCode` se conserva como dato de
Catalog y no convierte un set en obligatorio.

Solo se eligen productos `ALL_HEROES` o `SELECTED_SUBTYPES` que incluyan el
subtipo elegido. El loadout es efímero y no reserva ni concede unidades.

El cálculo replica la semántica autoritativa de Player-Inventory en nivel base:

- solo `STAT_MODIFIER`, `SELF`, permanente y no condicionado se materializa en
  `POWER`, `HEALTH`, `DEFENSE` o `ATTACK`;
- `SET`, aumentos/disminuciones fijas o porcentuales y multiplicadores conservan
  el mismo orden;
- el resultado se redondea y limita a cero;
- todos los efectos se conservan en `activeEffects`, indicando si ya fueron
  aplicados a las estadísticas.

Catalog no entrega nivel para el bot. `CombatProfile.level` se omite, que en el
motor vigente equivale al nivel base. `CombatProfile.heroId` usa el `productId`
del héroe como identidad de definición: es una referencia opaca dentro del
snapshot, nunca una instancia de Player-Inventory.

## Soporte puro

`CHAMAN` y `MEDICO` conservan `attack = null` y `damage = null`. Sus habilidades
pueden curar, mejorar estadísticas, dar inmunidad u ofrecer otro soporte, pero
no pueden contener `DAMAGE`, `REFLECT_DAMAGE` ni un modificador directo de
`DAMAGE`. Una contradicción en el dataset se rechaza como respuesta inválida de
Catalog; Combat no parchea ni inventa capacidades.

El equipamiento con efectos que causen daño directo se excluye de su loadout y
una épica compatible ofensiva invalida el dataset. No se restringen los soportes
a una whitelist de habilidades de curación.

## Orden transaccional y fallos

La definición completa del bot se resuelve antes de comprometer el equipamiento
del humano. Si Catalog falla, la sala sigue `PREPARING`, no se persiste una
batalla con perfil nulo, no se compromete inventario y no se consume RNG de
selección. Después se mantienen el bloqueo optimista, la persistencia y la
publicación existentes de `StartBattle`.

Trazabilidad: Management #557, HU padre #553, contrato Catalog #575 y ADR-023.
