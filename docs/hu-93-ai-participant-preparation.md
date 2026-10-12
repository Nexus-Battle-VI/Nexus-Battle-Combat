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
5. roll de épica `nextInt(8000)`: `0..399` sí, `400..7999` no (5 % exacto;
   `BoundedRandom.nextInt` solo acepta `bound <= RandomIndex.MAX = 8000`, HU-24);
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

El cálculo replica la semántica autoritativa de Player-Inventory en el nivel
emparejado:

- solo `STAT_MODIFIER`, `SELF`, permanente y no condicionado se materializa en
  `POWER`, `HEALTH`, `DEFENSE` o `ATTACK`;
- `SET`, aumentos/disminuciones fijas o porcentuales y multiplicadores conservan
  el mismo orden;
- el resultado se redondea y limita a cero;
- todos los efectos se conservan en `activeEffects`, indicando si ya fueron
  aplicados a las estadísticas.

Catalog no entrega nivel para el bot: `StartBattle` lo toma del héroe humano
autoritativo. `CombatProfile.heroId` usa el `productId` del héroe como identidad
de definición: es una referencia opaca dentro del snapshot, nunca una instancia
de Player-Inventory.

## Soporte puro fuera de JcE

`CHAMAN` y `MEDICO` se excluyen de JcE, pero conservan `attack = null` y
`damage = null` en las modalidades donde siguen permitidos. Sus habilidades
pueden curar, mejorar estadísticas, dar inmunidad u ofrecer otro soporte, pero
no pueden contener `DAMAGE`, `REFLECT_DAMAGE` ni un modificador directo de
`DAMAGE`. Una contradicción en el dataset se rechaza como respuesta inválida de
Catalog; Combat no parchea ni inventa capacidades.

El equipamiento con efectos que causen daño directo se excluye de su loadout y
una épica compatible ofensiva invalida el dataset. No se restringen los soportes
a una whitelist de habilidades de curación.

## Orden transaccional y fallos

El humano se valida antes de consultar Catalog. La definición completa del bot
se resuelve antes de comprometer el equipamiento del humano. Si Catalog falla,
la sala sigue `PREPARING`, no se persiste una
batalla con perfil nulo, no se compromete inventario y no se consume RNG de
selección. Después se mantienen el bloqueo optimista, la persistencia y la
publicación existentes de `StartBattle`.

Trazabilidad: Management #557, HU padre #553, contrato Catalog #575 y ADR-023.

## Correccion JcE: nivel, ofensivos y habilidades (2026-10-11)

`StartBattle` resuelve y valida por completo al unico humano antes de consultar
Catalog o consumir RNG. Solo entonces prepara la IA con el nivel autoritativo
de `EquippedHero.level`. Si un productor anterior a CA-06 omite ese campo se
conserva la semantica documentada del motor: nivel 1. No se usa el nivel de
Account, un maximo, una constante distinta ni un sorteo.

El factory filtra por capacidades antes de elegir: Ataque y Dano presentes,
Curacion ausente. `CHAMAN` y `MEDICO` nunca son candidatos ni fallback; si no
queda ningun ofensivo, Catalog se rechaza de forma controlada y la sala sigue
`PREPARING`. El jugador con uno de esos subtipos se rechaza en entrada e inicio
de JcE, con indicacion de cambiarlo desde Mi Inventario. JcJ conserva la regla
anterior (no en 1v1, permitido en equipos); Misiones y Torneos no usan este
flujo.

El escalado replica CA-06 de Player-Inventory:

1. `POWER`, `HEALTH`, `DEFENSE` y `ATTACK` base se multiplican por el nivel.
2. El equipamiento compatible se aplica una sola vez sobre esa base escalada.
3. `damage` conserva la magnitud de Catalog; `CombatProfile.level` multiplica
   el resultado final en la politica de Dano ya existente.

El perfil congelado incluye el nivel y las habilidades llevan los desbloqueos
1/3/5 definidos por la posicion autoritativa de
`HeroAttributes.abilities`. `BattleRoom.planSkill` y `LegalActionGenerator`
rechazan/excluyen `LOCKED` antes de entregar acciones a RuleBased, Neural o al
selector de politicas.

No existe una regla formal de equivalencia de equipamiento Humano/IA. Se
conservan 2 armas, 6 armaduras, 2 items y el 5 % de epica sin inventar topes de
balance. Las pruebas deterministas verifican niveles 1/3/5/8 y modificadores
aplicados una vez; medir una distribucion con el Catalog productivo es evidencia
de balance, no autorizacion para cambiar formulas.

La regla de nivel ratificada cubre JcE 1v1. JcE por equipos se rechaza con
`PVE_TEAM_LEVEL_MATCHING_UNDEFINED` hasta que Producto defina promedio, maximo
u otra fuente; Combat no inventa esa decision.
