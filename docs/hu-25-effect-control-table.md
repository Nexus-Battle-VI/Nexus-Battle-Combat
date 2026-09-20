# HU-25 — Tabla de control de efectos aleatorios

> Estado: **implementados el modelo de tabla, las configuraciones base definidas en el documento, la
> resolución por índice, la mecánica de modificadores y la construcción de la tabla base a partir del
> héroe equipado real (`subtype`, vía Player-Inventory)**. Los efectos del equipamiento (`activeEffects`)
> ya **se reciben y se clasifican**, pero **ninguno se traduce todavía a un modificador de la tabla**: falta
> definir formalmente la unidad de `CRITICAL_CHANCE` con `PERCENTAGE`. No es el motor de combate: no
> compara Ataque contra Defensa (HU-20), no calcula daño numérico ni vida, y **ningún flujo de batalla la
> invoca todavía**. **HU-25 no está terminada de extremo a extremo.** Este documento distingue en cada punto
> qué es requisito explícito, aclaración formal, decisión arquitectónica, decisión técnica, evidencia o
> pendiente funcional.

## Trazabilidad

| Elemento                                                              | Referencia                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario                                                   | [HU-25 — Aplicar tabla de control de efectos aleatorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72) (#72)                                                                                                                                                                                                                                                                                 |
| Requisito funcional                                                   | RF-25                                                                                                                                                                                                                                                                                                                                                                                                                |
| Épica                                                                 | [EPIC-06 — Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) (#6)                                                                                                                                                                                                                                                                                                                   |
| Trabajo previo de análisis/diseño (Tasks cerradas, **no se reabren**) | [#358](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/358) estructura y consulta de la tabla · [#359](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/359) modificadores y rebalanceo · [#360](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/360) efecto y magnitud · [#361](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/361) pruebas |
| Dependencia ya integrada                                              | HU-24 [#71](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71) — [Combat #14](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/14) y [#15](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/15) (`docs/hu-24-randomness-engine.md`)                                                                                                                                         |
| Consumidor posterior (fuera de alcance)                               | HU-20 [#64](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/64): si Ataque > Defensa → invoca este motor                                                                                                                                                                                                                                                                                           |
| Decisión arquitectónica                                               | [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md)                                                                                                                                                                                                                                                                                 |

## Clasificación de lo que se decidió

| #   | Tipo                              | Contenido                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Requisito explícito               | Tabla de 8000 filas por tipo de héroe, modificada por equipamiento; cada fila es un efecto; el índice del generador centralizado selecciona la fila; todo incremento se resta de «no causar daño»; ninguna otra fuente de aleatoriedad; el resultado identifica efecto y magnitud (issue #72, CA-01…CA-08)                                 |
| 2   | Fuente oficial                    | Documento «Proyecto Integrador II», sección 6.1.4: **Tabla 21** (porcentajes base), **Tabla 22** (Guerrero Armas) y **Tabla 23** (Guerrero Armas con +6 % de crítico)                                                                                                                                                                      |
| 3   | Aclaración formal del profesor    | La tabla conserva **siempre el mismo orden** de efectos (ver abajo)                                                                                                                                                                                                                                                                        |
| 4   | Decisión arquitectónica existente | Combat es el único dueño de la aleatoriedad (ADR-019); HU-24 entrega un `RandomIndex` y HU-25 solo lo consume mediante `RandomSequencePort.nextIndex()`                                                                                                                                                                                    |
| 5   | Decisión técnica necesaria        | Tabla almacenada como **rangos contiguos** (equivalente a las 8000 filas); filas enteras como representación autoritativa; incrementos en filas o puntos básicos **sin redondeo**; magnitud como valor o rango; dominio puro sin providers de Nest                                                                                         |
| 6   | Evidencia                         | Las Tasks #358–#361 (prototipo Colab) modelaron la misma estructura índice → rango → efecto; la validación estadística determinista de esta rama                                                                                                                                                                                           |
| 7   | Pendientes funcionales            | Chamán y Médico sin distribución válida; selección concreta del crítico 120–180 %; **unidad de `CRITICAL_CHANCE` con `PERCENTAGE`** (el contrato de efectos ya llega, ver [Integración con Player-Inventory](#integración-con-player-inventory)); distribución «normal» del índice (ver [Tensión documental](#tensión-documental-abierta)) |

## Alcance funcional: qué está conectado y qué no

Hoy existe, implementado y probado:

```text
RandomIndex  →  tabla  →  efecto y magnitud

playerId  →  héroe equipado real  →  subtype  →  tabla BASE del subtipo
                                      activeEffects  →  clasificados (ninguno modifica la tabla todavía)
```

Estado de cada eslabón de la cadena completa:

```text
playerId
  ↓  héroe equipado real            IMPLEMENTADO   Player-Inventory: contrato equipped-hero → PlayerInventoryHttpClient (parser estricto)
  ↓  subtype                        IMPLEMENTADO   parseHeroSubtype → baseEffectTableFor
  ↓  activeEffects                  IMPLEMENTADO   se reciben, se validan y se clasifican (BuildHeroEffectTable)
  ↓  modificadores de la tabla      PENDIENTE      ningún efecto tiene una semántica formal que lo traduzca (CRITICAL_CHANCE: unidad sin definir)
  ↓  tabla vigente                  PARCIAL        hoy es la tabla base; `pendingEffects` declara lo que no está en ella
  ↓  índice                         IMPLEMENTADO   HU-24
  ↓
efecto y magnitud                   IMPLEMENTADO   HU-25   →   daño numérico final   PENDIENTE (HU-20/HU-18)
```

`BuildHeroEffectTable` produce hoy la `table` que recibe `ResolveRandomEffect.execute({ sequence, table })`,
pero **en producción sigue sin haber caller**: ningún flujo de batalla la invoca (HU-20). Por tanto **HU-25
no está terminada de extremo a extremo**, y no lo estará mientras la tabla vigente ignore los efectos del
equipamiento. Ver [Integración con Player-Inventory](#integración-con-player-inventory) y
[Pendientes](#pendientes).

## Arquitectura

Clean + Hexagonal. **Domain puro**: no importa NestJS, adaptadores, infraestructura ni nada de HU-24 más
allá de `RandomIndex`.

```text
domain/
  random-effects/
    RandomEffectType.ts      efectos + ORDEN FIJO
    EffectMagnitude.ts       magnitudes oficiales (valor fijo o rango)
    ResolvedRandomEffect.ts  { effect, magnitude }: lo que HU-25 conoce
    EffectControlTable.ts    tabla de 8000 filas (rangos contiguos), resolve(), withModifiers()
    ProbabilityModifier.ts   incremento de probabilidad, compensado desde NO_DAMAGE
    BaseEffectProfiles.ts    Tabla 21 + baseEffectTableFor(subtype)
  value-objects/HeroSubtype.ts   los 8 códigos del registro hero-subtypes-v1
  errors/RandomEffectErrors.ts   errores de dominio específicos
application/
  use-cases/ResolveRandomEffect.ts   nextIndex() → table.resolve()
  use-cases/BuildHeroEffectTable.ts  héroe equipado → subtype → tabla base + clasificación de efectos
  ports/PlayerInventoryEquippedHeroPort.ts   contrato local del héroe equipado (sin importar tipos de otro servicio)
adapters/outbound/http/
  PlayerInventoryHttpClient.ts       parser ESTRICTO del contrato equipped-hero (HMAC servicio-a-servicio)
```

Flujo (HU-24 → HU-25):

```text
RandomSequencePort.nextIndex()      ← HU-24 (semilla, MT19937, Box-Müller, mapper: NO los conoce HU-25)
        ↓  RandomIndex 1..8000
EffectControlTable.resolve(index)   ← HU-25 (puro, sin NestJS ni generador)
        ↓
ResolvedRandomEffect { effect, magnitude }
```

- El dominio se prueba sin generador: `table.resolve(RandomIndex.create(1500))`.
- `ResolveRandomEffect` **consume exactamente un índice por golpe efectivo** y depende únicamente de
  `RandomSequencePort.nextIndex()`. No toca `NormalSequencePort`, la semilla, MT19937, Box-Müller ni la CDF.
  Recibe la secuencia por llamada (es un objeto con estado de cada batalla, no un servicio compartido) y
  **no se registra en `app.module.ts`**: no hay consumidor hasta que HU-20 defina el flujo de batalla.
- **No hay endpoint público** ni persistencia: la «tabla de control» es una estructura funcional
  inmutable, no una colección de MongoDB. No se creó ninguna migración ni esquema.
- El resultado no incluye índice, fila ni semilla.

## Semántica de las 8000 filas

- La tabla tiene **8000 posiciones = 100 %**, luego **1 punto porcentual = 80 filas**.
- La constante `EFFECT_TABLE_ROWS` es **la misma** que el máximo de `RandomIndex` (8000): el dominio de
  los índices y el de las filas es uno solo, así que todo índice válido cae en una fila y ninguna fila
  queda sin índice.
- La representación autoritativa son **filas enteras** por efecto. No hay decimales ni redondeo
  silencioso: una distribución que no suma exactamente 8000 (7999, 8001, 0…) se rechaza con
  `IncompleteEffectDistributionError`; filas negativas, no enteras, `NaN`, efectos ausentes o
  desconocidos, con `InvalidEffectTableError`.
- Se guarda como **rangos contiguos** (como mucho seis) y no como 8000 entradas. Las pruebas demuestran
  la equivalencia recorriendo **las 8000 filas** de cada tabla.

## Orden de efectos

Aclaración del profesor: la tabla conserva siempre el mismo orden.

1. Causar daño (`DAMAGE`) · 2. Causar daño crítico (`CRITICAL_DAMAGE`) · 3. Evaden el golpe (`EVADE`) ·
2. Resisten el golpe (`RESIST`) · 5. Escapan al golpe (`ESCAPE`) · 6. No causar daño (`NO_DAMAGE`)

Cada efecto empieza en la fila siguiente a la última del anterior. **Un efecto con 0 filas no crea
ningún rango.** Por construcción no hay huecos, solapamientos, filas duplicadas ni filas sin resolver.

## Fuente oficial y configuraciones base (Tabla 21)

Valores transcritos **sin cambios** del documento (configuración base sin equipamiento, ítems ni épicas):

|                 | Causar daño | Crítico | Evaden | Resisten | Escapan | No causar daño |
| --------------- | ----------: | ------: | -----: | -------: | ------: | -------------: |
| Guerrero Tanque |        40 % |     0 % |    5 % |      0 % |     5 % |           50 % |
| Guerrero Armas  |        60 % |     5 % |    3 % |      0 % |     2 % |           30 % |
| Mago Fuego      |        70 % |     5 % |    0 % |      5 % |     0 % |           20 % |
| Mago Hielo      |        70 % |     6 % |    0 % |      4 % |     0 % |           20 % |
| Pícaro Veneno   |        55 % |    10 % |    0 % |      0 % |     0 % |           35 % |
| Pícaro Machete  |        60 % |     8 % |    0 % |      0 % |     2 % |           30 % |
| Chamán          |         0 % |     0 % |    0 % |      0 % |     0 % |            0 % |
| Médico          |         0 % |     0 % |    0 % |      0 % |     0 % |            0 % |

Rangos derivados (1 punto porcentual = 80 filas, orden fijo):

| Héroe           | Rangos                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------- |
| Guerrero Tanque | 1–3200 Daño · 3201–3600 Evade · 3601–4000 Escape · 4001–8000 Sin daño                     |
| Guerrero Armas  | 1–4800 Daño · 4801–5200 Crítico · 5201–5440 Evade · 5441–5600 Escape · 5601–8000 Sin daño |
| Mago Fuego      | 1–5600 Daño · 5601–6000 Crítico · 6001–6400 Resiste · 6401–8000 Sin daño                  |
| Mago Hielo      | 1–5600 Daño · 5601–6080 Crítico · 6081–6400 Resiste · 6401–8000 Sin daño                  |
| Pícaro Veneno   | 1–4400 Daño · 4401–5200 Crítico · 5201–8000 Sin daño                                      |
| Pícaro Machete  | 1–4800 Daño · 4801–5440 Crítico · 5441–5600 Escape · 5601–8000 Sin daño                   |

Los códigos de héroe **no son un vocabulario nuevo**: son los ocho de `hero-subtypes-v1`
(`GUERRERO_TANQUE`, `GUERRERO_ARMAS`, `MAGO_FUEGO`, `MAGO_HIELO`, `PICARO_VENENO`, `PICARO_MACHETE`,
`CHAMAN`, `MEDICO`) que publica Catalog y que Player-Inventory ya devuelve como `subtype`.

## Tabla Guerrero Armas (Tabla 22)

| Probabilidad        |   % | Filas | Rango     | Efecto esperado                |
| ------------------- | --: | ----: | --------- | ------------------------------ |
| Causar daño         |  60 |  4800 | 1–4800    | 100 % del daño                 |
| Causar daño crítico |   5 |   400 | 4801–5200 | 120 % a 180 % del daño         |
| Evaden el golpe     |   3 |   240 | 5201–5440 | 80 % del daño                  |
| Resisten el golpe   |   0 |     0 | —         | 60 % del daño (cuando aplique) |
| Escapan al golpe    |   2 |   160 | 5441–5600 | 20 % del daño                  |
| No causar daño      |  30 |  2400 | 5601–8000 | 0 % del daño                   |

Reproducida **exactamente** en `test/unit/official-effect-tables.spec.ts`, con pruebas de frontera en
las filas 1, 4800, 4801, 5200, 5201, 5440, 5441, 5600, 5601 y 8000; los índices `0` y `8001` los rechaza
`RandomIndex` (HU-24) antes de llegar a la tabla.

## Equipamiento y regla +6 crítico / −6 sin daño (Tabla 23)

Regla explícita (RF-25, CA-06): _«todo incremento de probabilidad en un efecto debe restarse de la
probabilidad de "no causar daño"»_. Ejemplo oficial: Guerrero Armas con +6 % de crítico.

| Probabilidad        |               % |    Filas | Rango     |
| ------------------- | --------------: | -------: | --------- |
| Causar daño         |              60 |     4800 | 1–4800    |
| Causar daño crítico |  **11** (5 + 6) |  **880** | 4801–5680 |
| Evaden el golpe     |               3 |      240 | 5681–5920 |
| Resisten el golpe   |               0 |        0 | —         |
| Escapan al golpe    |               2 |      160 | 5921–6080 |
| No causar daño      | **24** (30 − 6) | **1920** | 6081–8000 |

`ProbabilityModifier.ofBasisPoints(CRITICAL_DAMAGE, 600)` (o `ofRows(…, 480)`) aplicado con
`table.withModifiers([...])` reproduce esta tabla exactamente. La tabla original **no cambia**.

**Lo que se implementó, y solo eso:** un incremento de un efecto distinto de `NO_DAMAGE`, compensado con
las mismas filas de `NO_DAMAGE`. Los incrementos son aditivos (el resultado no depende del orden). Se
puede consumir todo `NO_DAMAGE` (queda en 0 filas y sin rango).

**Lo que falla de forma explícita, porque el documento no define su semántica** (no se adivina):

| Entrada                                                                                                      | Error                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Incremento mayor que las filas disponibles de «no causar daño» (p. ej. sin daño = 3 % y modificador +6 %)    | `InsufficientNoDamageProbabilityError`                 |
| Cantidad negativa (decrementos) o no entera, `NaN`                                                           | `InvalidProbabilityModifierError`                      |
| Aumentar `NO_DAMAGE` (no hay regla de compensación)                                                          | `InvalidProbabilityModifierError`                      |
| Efecto desconocido                                                                                           | `InvalidProbabilityModifierError`                      |
| Puntos básicos que no equivalen a un número exacto de filas (1 fila = 1,25 pb; solo valen múltiplos de 5 pb) | `InvalidProbabilityModifierError` — **no se redondea** |

No se define redistribución entre varios efectos ni un orden de apilamiento distinto de la suma.

**Sobre varios incrementos simultáneos.** `withModifiers` acepta una lista y suma los incrementos antes de
descontarlos de «no causar daño»: es coherente con la regla («todo incremento se resta de no causar
daño») y su resultado no depende del orden. Pero **la semántica de apilamiento del equipamiento real
NO está formalizada**: cómo se traducen varios efectos de Catalog/Player-Inventory (varias piezas, cada
una con su `CRITICAL_CHANCE`, con duración o condición de activación) a `ProbabilityModifier` — y si
esos efectos se acumulan o no — **sigue sin formalizarse** (ver
[Integración con Player-Inventory](#integración-con-player-inventory): hoy ningún efecto de equipamiento se
traduce a un `ProbabilityModifier`). La abstracción se conserva porque es útil, sin afirmar que ya modela el
apilamiento real.

## Efectos y magnitudes

Magnitud **relativa** (lo único que HU-25 conoce), conservada exactamente como en el documento:

| Efecto            | Magnitud          |
| ----------------- | ----------------- |
| `DAMAGE`          | 100 %             |
| `CRITICAL_DAMAGE` | rango 120 %–180 % |
| `EVADE`           | 80 %              |
| `RESIST`          | 60 %              |
| `ESCAPE`          | 20 %              |
| `NO_DAMAGE`       | 0 %               |

Aunque «Evaden» o «Escapan» parezcan extraños junto a 80 % o 20 % de daño, **no se corrigen**: son los
valores del documento. El daño numérico final (que depende del ataque, la defensa, la vida…) **no se
calcula aquí**; lo hará HU-20/HU-18 a partir de `ResolvedRandomEffect`.

## Crítico 120–180: pendiente de materialización

El documento dice «causa entre un [120 % a 180 %] de daño» pero **no define cómo obtener un valor
concreto** del intervalo: ni distribución (uniforme u otra), ni entero o decimal, ni fuente aleatoria. Ni
HU-25 ni las Tasks #358–#361 lo formalizan (la Task #360 lo deja explícitamente «como rango»); HU-20 #64 y
HU-18 #62 tampoco lo definen (revisadas). Por tanto:

- `ResolvedRandomEffect` devuelve `{ kind: 'PERCENT_RANGE', minPercent: 120, maxPercent: 180 }`;
- **no** se usa `Math.random()`, **no** se consume un segundo `nextIndex()` ni se crea otra normal;
- una HU formal debe definir quién materializa el porcentaje y con qué regla.

## Integración con HU-24

- HU-25 consume **solo** `RandomSequencePort.nextIndex()`. **No** usa `NormalSequencePort`
  (reservado a validación de HU-26), ni conoce MT19937, Box-Müller, la CDF ni la semilla.
- Una **guarda estática en CI** (`test/unit/hu-25-no-alternative-randomness.spec.ts`) falla si el código
  de HU-25 referencia `Math.random`, `node:crypto`, MT19937, Box-Müller, la variable normal cruda, la
  semilla, adaptadores o NestJS. Se verificó por mutación que detecta usos válidos de `Math.random` y de
  `node:crypto`.
- **No se define política de semilla** (queda para HU-26/batalla). Las pruebas de integración usan la
  semilla `3_000_000` **solo como fixture** a través de la fábrica.

## Integración con Player-Inventory

Contrato: `GET /api/internal/v1/players/:playerId/equipped-hero` (`@InternalOnly()`, HMAC-SHA256
servicio-a-servicio), documentado en Player-Inventory (`docs/equipped-hero-contract.md`). **No se creó
ningún endpoint nuevo**: se amplió el existente con `activeEffects`. Combat nunca consulta Catalog para
reconstruir el equipamiento ni accede a la base de Player-Inventory, y nunca acepta `subtype`,
`effectiveStats` ni `activeEffects` desde Web.

```text
Player-Inventory                                           Combat
HeroEquipmentDto.activeEffects (HU-28)
  → EquippedHeroDto.activeEffects  ── JSON + HMAC ──►  PlayerInventoryHttpClient   (parser estricto)
                                                        → PlayerInventoryEquippedHeroPort
                                                        → BuildHeroEffectTable
                                                            subtype  → parseHeroSubtype → baseEffectTableFor
                                                            effects  → assessEquipmentEffect
                                                        → HeroEffectTable { table, assessments, pendingEffects }
```

### Puerto y parser

Antes, el puerto modelaba `{ playerId, heroId }` (más `maxPower`, HU-11). Ahora modela, con tipos
**locales** (no se importa nada de otro servicio): `playerId`, `heroId`, `reference`, `subtype`,
`baseStats`, `effectiveStats`, `activeEffects`, `ready` y `selectedAt`, además de `maxPower`.

- `name` **no** se modela: ningún caso de uso de Combat lo usa.
- **`level` no existe** en Player-Inventory (DP-3) y Combat no lo inventa.
- `maxPower` **sigue siendo `effectiveStats.power`**: el parser lo deriva, así que no pueden discrepar.
- El parser es **estricto**: valida cada campo y reconstruye el objeto por lista blanca (nunca `body as
EquippedHero`). Una estructura inválida → `UpstreamServiceError(player-inventory, respuesta_invalida)`
  (503). Los campos extra se ignoran (`raw`, `level`...). El `404` sigue devolviendo `null`.
- Valida **la forma, no el vocabulario**: `subtype`, `kind`, `target`, `statistic` y `operation` son texto no
  vacío, sin lista cerrada. Un valor nuevo de Catalog no bloquea el ingreso a sala de quien lo lleve; se
  valida al construir la tabla (`parseHeroSubtype`) y los efectos desconocidos se clasifican como pendientes.
- **`activeEffects` es obligatorio.** No se hace `activeEffects ?? []`: si el productor es anterior al
  contrato, Combat ejecutaría la tabla base ignorando el equipamiento real. Ver
  [Orden de despliegue](#orden-de-despliegue).

### De `subtype` a la tabla

`buildHeroEffectTable(hero)` → `baseEffectTableFor(parseHeroSubtype(hero.subtype))`. Falla de forma
explícita, sin inventar tabla: subtipo fuera de `hero-subtypes-v1` → `DomainError`; `CHAMAN` / `MEDICO` →
`UnsupportedHeroEffectProfileError`. `BuildHeroEffectTable.execute(playerId)` añade la lectura por el puerto
y lanza `PlayerWithoutEquippedHeroError` si no hay héroe equipado. **No está registrado en `app.module.ts`**
(no hay consumidor hasta HU-20) y **no invoca `ResolveRandomEffect`**.

### Qué se hace con cada efecto

Cada efecto recibido tiene exactamente un resultado; ninguno se descarta ni se aplica en silencio:

| Resultado              | Cuándo                                                                                                                                                                                                                                                           | Modifica la tabla |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `REFLECTED_IN_STATS`   | `appliedToStats = true`: ya está en `effectiveStats`. Se ignora **a propósito** para no aplicarlo dos veces.                                                                                                                                                     | No                |
| `NOT_A_TABLE_MODIFIER` | Vocabulario conocido que no es una probabilidad de la tabla: `POWER`, `HEALTH`, `DEFENSE`, `ATTACK`, `DAMAGE`, `HEALING` y los `kind` `DAMAGE`, `HEALING`, `IMMUNITY`, `REFLECT_DAMAGE`, `REVIVE`, `TEMPORARY_STATUS`. Su semántica pertenece a otras historias. | No                |
| `PENDING_DEFINITION`   | Podría modificar la tabla y el requisito no define cómo (`CRITICAL_CHANCE`), o Combat no reconoce el efecto. **No se aplica y se declara** en `pendingEffects`, con motivos.                                                                                     | No                |

Motivos de `PENDING_DEFINITION` (se listan todos los que aplican): `CRITICAL_CHANCE_UNIT_UNDEFINED`,
`ACTIVATION_CONDITION_UNEVALUATED`, `TEMPORARY_EFFECT_UNDEFINED`, `NON_SELF_TARGET_UNDEFINED`,
`OPERATION_UNDEFINED` y `UNRECOGNIZED_EFFECT`. La lista cerrada de `NOT_A_TABLE_MODIFIER` es deliberada: una
estadística o un `kind` que no esté ahí **no se presume irrelevante**, porque podría ser justo una
probabilidad futura.

**No existe un resultado «aplicado».** Hoy ningún efecto tiene semántica formal, así que no hay traducción
a `ProbabilityModifier`. Cuando exista una regla aprobada, el cambio es un único punto
(`buildHeroEffectTable` → `table.withModifiers(...)`).

### `CRITICAL_CHANCE`: la ambigüedad sigue abierta

Catalog publica efectos como `CRITICAL_CHANCE INCREASE PERCENTAGE 300` (p. ej. la _Espada de dos manos_
para `GUERRERO_ARMAS`). **No existe ninguna fuente formal** —ni el issue de HU-25 (#72), ni HU-28 (#75) y
su Task (#152), ni el contrato de Catalog— que diga si eso es:

- **(a)** **+3 puntos porcentuales absolutos** (como el «+6 %» de la Tabla 23): el crítico de Guerrero
  Armas pasaría de 5 % a 8 % (400 → 640 filas), o
- **(b)** **+3 % relativo** sobre el crítico base: 5 % × 1,03 = 5,15 % (400 → 412 filas).

`ProbabilityModifier.ofBasisPoints` interpreta los puntos básicos como (a), pero eso describe **su**
entrada, ya expresada en puntos absolutos, no cómo traducir un efecto de Catalog. Player-Inventory trata los
`PERCENTAGE` de las estadísticas numéricas como relativos a la base, lo que tampoco resuelve el crítico.
**Combat no elige.** Lo decide el PO.

Pruebas que lo fijan (`test/unit/build-hero-effect-table.spec.ts`): con la espada crítica la tabla vigente
**es** la base (crítico = 400 filas), ni 640 (a) ni 412 (b); lo mismo con 100, 600 y 10 000 pb y con
magnitud `FIXED` o `DICE`; y la fila 5201 resuelve `EVADE` (con (a) sería crítico).

### Condiciones, efectos temporales y apilamiento

- **`hasActivationCondition = true`**: no se trata como modificador permanente. La condición en sí no
  cruza la frontera (Player-Inventory solo envía el indicador): nadie define cuándo se evalúa.
- **`durationTurns`**: un efecto temporal no es un modificador de una tabla vigente.
- **`target` distinto de `SELF`**: cómo afecta a la tabla del _otro_ participante no está definido.
- **Varios efectos de la misma estadística** (varias piezas con crítico): no se suman ni se escoge uno; todos
  quedan pendientes. El apilamiento sigue sin formalizarse (ver más arriba).

### Contrato cruzado entre repositorios

Los dos repositorios fijan **la misma forma JSON** sin compartir archivos (ver `test/fixtures/equipped-hero.ts`
aquí y `test/integration/equipped-hero-http.spec.ts` en Player-Inventory). Si el contrato cambia, el cambio
se hace a mano en ambos y las pruebas fallan hasta que coincidan.

### Orden de despliegue

**Player-Inventory primero.** Combat exige `activeEffects`; contra un Player-Inventory anterior al contrato
rechaza la respuesta (`respuesta_invalida`, 503) y **el ingreso a sala falla**, aunque el ingreso no use la
tabla. Es el precio consciente de no ejecutar en silencio una tabla base que ignore el equipamiento real.

```text
1. Player-Inventory con activeEffects  →  verificar el endpoint interno devuelve activeEffects
2. Combat que exige activeEffects
```

## Integración futura con HU-20

HU-20 dicta: Ataque ≤ Defensa → **no hay efecto aleatorio**; Ataque > Defensa → golpe efectivo → invocar
este motor. `ResolveRandomEffect` está preparado para llamarse **después** de esa condición (un golpe no
efectivo no debe consumir índice). **HU-20 no está implementada:** no hay comparación Ataque/Defensa,
vida, turnos ni ataque básico en esta rama.

## Sanadores: configuración incompleta

La Tabla 21 da **0 % en todos los efectos** para Chamán y Médico. Eso suma **0 %, no 100 %**: el
documento **no proporciona una distribución válida de 8000 filas** para ellos.

- `baseEffectTableFor(CHAMAN | MEDICO)` lanza `UnsupportedHeroEffectProfileError`.
- **No** se construye una tabla de «8000 × no causar daño», **no** se reparten porcentajes, **no** se
  copia otra clase y **no** se asume que los sanadores no atacan.
- HU-16 solo establece que Chamán y Médico participan en modalidades de equipo y no en 1v1; eso no
  define su tabla. (El registro de Catalog los marca con rama de combate `Healing`.)
- Sus valores se transcriben tal cual (ceros) y una prueba impide que se «completen» en silencio.
- **Nota del proyecto (mismo documento, tras la Tabla 23):** _«es necesario diseñar las tablas de efectos
  aleatorios para todos los personajes, manteniendo la lógica del ejercicio y configurando valores
  apropiados que eviten un desequilibrio entre los jugadores»_. Es decir, el propio proyecto encarga
  **diseñar** las distribuciones que la Tabla 21 no trae (Chamán y Médico). Esa es una decisión de
  balance que corresponde al PO/profesor: **esta rama no propone valores**, deja el mecanismo listo
  (basta definir un perfil con 100 % en `BASE_EFFECT_PERCENTAGES`) y el rechazo explícito mientras tanto.

Este pendiente **no bloquea** las seis configuraciones definidas.

## Tensión documental abierta

El mismo documento oficial, justo tras la Tabla 23, afirma: _«el índice aleatorio es una variable
pseudo-aleatoria que debe seguir una distribución normal»_. Pero las tablas definen los efectos **por
filas** (4800 de 8000 filas = 60 %). Ambas cosas solo son compatibles si el índice se distribuye de forma
que cada fila pese 1/8000, es decir, **uniforme**: con una normal directa las filas 1–4800 recibirían
≈ 72,4–72,6 % de las tiradas y no el 60 % de la Tabla 22 (ver `docs/hu-24-randomness-engine.md`).

- **Decisión vigente del equipo** (Tasks #358–#360): índice final uniforme, con la normal como variable
  intermedia. Es la que implementa HU-24 y asumen las pruebas estadísticas de esta rama.
- **No está ratificada por el PO/profesor.** Si se decidiera otra lectura, cambiaría solo
  `NormalToIndexMapper` de HU-24; HU-25 (`index → fila`) **no cambia**, pero las probabilidades
  efectivas dejarían de coincidir con los porcentajes de las tablas.

## Invariantes

Garantizadas por construcción y probadas recorriendo las 8000 filas de cada tabla:

1. Exactamente 8000 posiciones; primera fila = 1; última = 8000.
2. Rangos contiguos en el orden fijo; sin huecos ni solapamientos.
3. Un efecto con 0 filas no crea rango.
4. Todo `RandomIndex` válido resuelve exactamente un efecto.
5. Las filas de cada efecto son enteras y suman 8000 (sin redondeo).
6. Las tablas son inmutables; `withModifiers` devuelve una nueva.
7. Las reglas autoritativas están **congeladas en runtime** (`Object.freeze`), no solo `readonly` de
   TypeScript: `RANDOM_EFFECT_ORDER`, `HERO_SUBTYPES`, `RandomEffectType`, `HeroSubtype`,
   `EFFECT_MAGNITUDES` y `BASE_EFFECT_PERCENTAGES`. Un `reverse()`, `push()` o reasignación desde
   JavaScript lanza `TypeError` y no puede alterar cómo se construyen las tablas.

## Pruebas

**222 pruebas nuevas** en 9 suites (8 unitarias y 1 de integración):

- `effect-control-table` — invariantes, orden, fronteras, rechazo de distribuciones inválidas.
- `base-effect-profiles` — Tabla 21 de los 8 héroes: 6 configuraciones válidas con suma 8000, cobertura
  1..8000, sin huecos ni solapamientos y fronteras; Chamán/Médico rechazados.
- `official-effect-tables` — **Tabla 22** y **Tabla 23** reproducidas columna por columna.
- `probability-modifier` — +6 crítico → Tabla 23 exacta, modificador 0, errores (superar «sin daño»,
  negativos, `NO_DAMAGE`, efecto desconocido, redondeo).
- `hu-25-authoritative-constants` — intenta `reverse`/`sort`/`push`/`pop`/`splice`/asignación sobre las constantes autoritativas y verifica que fallan sin alterar la construcción de tablas.
- `hero-subtype`, `resolve-random-effect` (un solo índice por golpe; solo `nextIndex`),
  `hu-25-no-alternative-randomness` (guarda estática).
- `random-effect-resolution` (integración HU-24 → HU-25): golden con semilla fija y **convergencia
  estadística determinista** sobre 200.000 golpes: Guerrero Armas base ≈ 60 / 5 / 3 / 2 / 30 % y con +6 %
  de crítico ≈ 60 / 11 / 3 / 2 / 24 %, tolerancia 0,5 puntos (medido: error ≤ 0,13). No reemplaza HU-26.
- **Prueba de mutación manual:** 17 defectos deliberados (13 de las reglas de negocio + 4 de inmutabilidad: quitar el `Object.freeze` de cada constante) (orden, equivalencia filas/%, frontera,
  compensación, Tabla 21, sanadores, magnitud, `NO_DAMAGE`, doble índice, `Math.random`, cobertura de la
  fila 8000, redondeo) — **17 de 17 detectados**.

**Integración con Player-Inventory** (rama `feat/hu-25-player-inventory-effects-integration`): **175 pruebas
nuevas** en 2 suites unitarias (y 691 → 866 pruebas en total; se actualizaron los dobles de
`battle-room-*` y `internal-http-clients` para que usen el contrato real):

- `player-inventory-equipped-hero-contract` (103) — parser estricto: contrato completo, los 8 subtipos, `activeEffects`
  vacío/uno/varios, magnitudes `FIXED`/`PERCENTAGE`/`DICE`, `hasActivationCondition`, `appliedToStats`, campos extra
  ignorados, y rechazo de `playerId` distinto, `heroId` vacío, `subtype` faltante, estadísticas o efectos malformados
  y `activeEffects` ausente (**no** se sustituye por `[]`); `404` → `null` y errores de transporte sin cambios.
- `build-hero-effect-table` (72) — `subtype` → tabla (Tabla 22, Mago Fuego, Pícaro Machete, Chamán/Médico, subtipo
  inválido), clasificación de cada efecto, y **las pruebas de que `CRITICAL_CHANCE` no se interpreta** (ni +240 filas
  ni 412); cadena completa JSON → tabla → efecto.
- `test/fixtures/equipped-hero.ts` — fixture contractual único.
- **Controles de mutación:** 8 defectos deliberados (`activeEffects ?? []`, lectura absoluta del crítico, spread que
  filtra `raw`, `appliedToStats` antes que el crítico, cast ciego del subtipo, subtipo ignorado, héroe por defecto
  ante `null`, `maxPower` desde `baseStats`) — **8 de 8 detectados**.

## Limitaciones

- No es el motor de combate: sin Ataque/Defensa, HP, turnos, ataque ni daño numérico.
- Sin consumidor: ningún flujo invoca `ResolveRandomEffect` ni `BuildHeroEffectTable` (HU-20).
- **La tabla vigente ignora el equipamiento.** El héroe real y su `subtype` ya determinan la tabla base y los
  efectos ya llegan, pero ninguno se traduce a un modificador (unidad de `CRITICAL_CHANCE` sin definir).
  `pendingEffects` lo declara; no se finge que se aplicó.
- La integración exige que Player-Inventory ya entregue `activeEffects`: contra una versión anterior el
  ingreso a sala falla con 503 (ver [Orden de despliegue](#orden-de-despliegue)).
- Sin persistencia ni endpoint (no hay requisito que los pida).

## Pendientes

0. **Integración de extremo a extremo** (lo que separa «núcleo de dominio» de «HU-25 Done»): la parte
   `subtype` → tabla base **está hecha**; falta traducir los efectos del equipamiento a modificadores
   (punto 3) y conectar la tabla al flujo de combate de HU-20.

1. **Chamán y Médico**: definir su distribución de 100 % (la nota del proyecto pide diseñarla; los
   valores los aprueba el PO/profesor).
2. **Crítico 120–180 %**: definir cómo se materializa un valor concreto (y con qué fuente).
3. **Modificadores**: el contrato que entrega los efectos **ya existe** (`activeEffects`). Falta que el
   PO/profesor defina **la unidad** de `CRITICAL_CHANCE` con `PERCENTAGE` (+3 puntos absolutos vs. +3 %
   relativo), y además cómo se apilan varios efectos, cuándo se evalúa una condición de activación y qué
   hacer con los efectos temporales o dirigidos a otro participante. **No se elige por Combat.**
4. **Distribución «normal» del índice**: ratificar la decisión del índice uniforme.
5. ~~**`subtype` en el puerto de Combat**~~ — **hecho**: el puerto modela `subtype`, estadísticas y
   `activeEffects`, y `BuildHeroEffectTable` construye la tabla base del héroe real.
6. **Tablas de efectos «para todos los personajes»** (nota del proyecto): solo existen las de la Tabla 21;
   no se inventaron otras (p. ej. variantes por épicas o por ítems).
