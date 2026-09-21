# HU-25 — Tabla de control de efectos aleatorios

> Estado: **implementados el modelo de tabla, las configuraciones base de los ocho tipos de héroe, la
> resolución por índice (con el porcentaje concreto del crítico), la mecánica de modificadores e
> incrementos y reducciones, la construcción de la tabla del héroe equipado real (`subtype`, vía
> Player-Inventory) y la aplicación de `CRITICAL_CHANCE` del equipamiento**. HU-25 fue **aceptada por el PO
> el 2026-09-20** como capacidad independiente; HU-20 ([`docs/hu-20-attack-resolution.md`](hu-20-attack-resolution.md))
> la consume. Los pendientes heredados se resolvieron con el documento oficial (ver
> [Pendientes](#pendientes)): sanadores, materialización del crítico y `-2 % de crítico al ataque del
oponente`. Siguen abiertos solo los efectos **condicionados o temporales**, que necesitan el estado de la
> batalla. **Ningún flujo de batalla invoca todavía la resolución de un golpe** (HU-17/HU-18), así que
> no hay un caller de producción. Este documento distingue en cada punto qué es requisito explícito,
> aclaración formal, decisión arquitectónica, decisión técnica, decisión de diseño, evidencia o pendiente
> funcional.

## Trazabilidad

| Elemento                                                              | Referencia                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario                                                   | [HU-25 — Aplicar tabla de control de efectos aleatorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72) (#72)                                                                                                                                                                                                                                                                                 |
| Requisito funcional                                                   | RF-25                                                                                                                                                                                                                                                                                                                                                                                                                |
| Épica                                                                 | [EPIC-06 — Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) (#6)                                                                                                                                                                                                                                                                                                                   |
| Trabajo previo de análisis/diseño (Tasks cerradas, **no se reabren**) | [#358](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/358) estructura y consulta de la tabla · [#359](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/359) modificadores y rebalanceo · [#360](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/360) efecto y magnitud · [#361](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/361) pruebas |
| Dependencia ya integrada                                              | HU-24 [#71](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71) — [Combat #14](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/14) y [#15](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/15) (`docs/hu-24-randomness-engine.md`)                                                                                                                                         |
| Consumidor                                                            | HU-20 [#64](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/64): si Ataque > Defensa → invoca este motor (`ResolveAttack`, ver `docs/hu-20-attack-resolution.md`)                                                                                                                                                                                                                                  |
| Decisión arquitectónica                                               | [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md)                                                                                                                                                                                                                                                                                 |

## Clasificación de lo que se decidió

| #   | Tipo                              | Contenido                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito explícito               | Tabla de 8000 filas por tipo de héroe, modificada por equipamiento; cada fila es un efecto; el índice del generador centralizado selecciona la fila; todo incremento se resta de «no causar daño»; ninguna otra fuente de aleatoriedad; el resultado identifica efecto y magnitud (issue #72, CA-01…CA-08)     |
| 2   | Fuente oficial                    | Documento «Proyecto Integrador II», sección 6.1.4: **Tabla 21** (porcentajes base), **Tabla 22** (Guerrero Armas) y **Tabla 23** (Guerrero Armas con +6 % de crítico)                                                                                                                                          |
| 3   | Aclaración formal del profesor    | La tabla conserva **siempre el mismo orden** de efectos (ver abajo)                                                                                                                                                                                                                                            |
| 4   | Decisión arquitectónica existente | Combat es el único dueño de la aleatoriedad (ADR-019); HU-24 entrega un `RandomIndex` y HU-25 solo lo consume mediante `RandomSequencePort.nextIndex()`                                                                                                                                                        |
| 5   | Decisión técnica necesaria        | Tabla almacenada como **rangos contiguos** (equivalente a las 8000 filas); filas enteras como representación autoritativa; incrementos en filas o puntos básicos **sin redondeo**; magnitud como valor o rango; dominio puro sin providers de Nest                                                             |
| 6   | Evidencia                         | Las Tasks #358–#361 (prototipo Colab) modelaron la misma estructura índice → rango → efecto; la validación estadística determinista de esta rama                                                                                                                                                               |
| 7   | Decisión de diseño (PO/profesor)  | Adoptadas por la instrucción de resolver los pendientes con el documento oficial: **sanadores** = 100 % «no causar daño»; **crítico 120–180** materializado por la posición de la fila; **`-2 % de crítico al ataque del oponente`** como reducción de la tabla de quien ataca (ver [Pendientes](#pendientes)) |
| 8   | Decisión del PO                   | El índice final es **uniforme** y la normal es la variable intermedia (comentario de cierre de HU-24, 2026-09-20); semilla del proyecto **3.000.000** (cierre de HU-26). Ver [Tensión documental](#tensión-documental-resuelta)                                                                                |
| 9   | Pendientes funcionales            | Efectos de equipamiento **condicionados o temporales** (necesitan el estado de la batalla: turnos y estadísticas del oponente; ver [Casos aún pendientes](#casos-aún-pendientes))                                                                                                                              |

## Alcance funcional: qué está conectado y qué no

Hoy existe, implementado y probado:

```text
RandomIndex  →  tabla  →  efecto y magnitud

playerId  →  héroe equipado real  →  subtype  →  tabla BASE del subtipo
                                      activeEffects  →  CRITICAL_CHANCE soportado  →  ProbabilityModifier  →  tabla VIGENTE
```

Estado de cada eslabón de la cadena completa:

```text
playerId
  ↓  héroe equipado real            IMPLEMENTADO   Player-Inventory: contrato equipped-hero → PlayerInventoryHttpClient (parser estricto)
  ↓  subtype                        IMPLEMENTADO   parseHeroSubtype → baseEffectTableFor
  ↓  activeEffects                  IMPLEMENTADO   se reciben, se validan y se clasifican (BuildHeroEffectTable)
  ↓  modificadores de la tabla      IMPLEMENTADO   solo CRITICAL_CHANCE INCREASE PERCENTAGE (incondicional, permanente, SELF) → ProbabilityModifier
  ↓  tabla vigente                  IMPLEMENTADO   base + withModifiers; `pendingEffects` declara lo que no se pudo aplicar
  ↓  índice                         IMPLEMENTADO   HU-24
  ↓
efecto, magnitud y porcentaje       IMPLEMENTADO   HU-25   →   Ataque > Defensa → este motor   IMPLEMENTADO (HU-20)
                                                       →   daño numérico final y vida        PENDIENTE (HU-18)
```

`BuildHeroEffectTable` produce la `table` que recibe `ResolveRandomEffect.execute({ sequence, table })`, y
`ResolveAttack` (HU-20) lo invoca solo si el Ataque supera la Defensa. **En producción sigue sin haber caller**:
ningún flujo de batalla resuelve golpes todavía (HU-17, HU-18). El componente de tabla está integrado con su
consumidor y probado, pero el flujo real de un combate no existe. Ver
[Integración con Player-Inventory](#integración-con-player-inventory) y [Pendientes](#pendientes).

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
  **no se registra en `app.module.ts`**: su único consumidor es `ResolveAttack` (HU-20), y ese no tiene caller de producción hasta que HU-17/HU-18 definan el flujo de batalla.
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
| Chamán          |         0 % |     0 % |    0 % |      0 % |     0 % |    0 % (100 %) |
| Médico          |         0 % |     0 % |    0 % |      0 % |     0 % |    0 % (100 %) |

Los sanadores se imprimen con 0 % en todas las filas (suma 0 %); su perfil se completa con «no causar daño»
= 100 % por decisión de diseño (ver [Sanadores](#sanadores-no-causar-daño--100--decisión-de-diseño)).

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
daño») y su resultado no depende del orden. `BuildHeroEffectTable` **reutiliza ese modelo aditivo** para
los efectos de `CRITICAL_CHANCE` soportados (varias piezas con +3 y +2 puntos dan +5 puntos, restados de
«no causar daño»); no existe otra fórmula de apilamiento. Lo que **no** está formalizado es el apilamiento
de efectos condicionados, temporales o dirigidos a otro participante: esos no se aplican (ver
[Casos aún pendientes](#casos-aún-pendientes)).

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
valores del documento. El daño numérico final (que depende del daño del héroe, la vida…) **no se calcula
aquí**; lo hará HU-18 a partir de `ResolvedRandomEffect`.

## Crítico 120–180: materialización por posición (decisión de diseño)

El documento dice «causa entre un [120 % a 180 %] de daño» y describe cada fila como uno de los «posibles
valores para el índice aleatorio» (880 en la Tabla 23), pero **no define cómo se escoge el porcentaje
concreto** dentro del intervalo. Por instrucción del PO/profesor de resolver los pendientes con el
documento, se adopta esta regla (función pura `materializePercent`, `EffectMagnitude.ts`):

```text
porcentaje = mín + floor( posición × valores / filas )        valores = máx − mín + 1 = 61  (120..180)
```

donde `posición` cuenta desde 0 dentro del rango contiguo del efecto y `filas` es su tamaño. La primera fila
del crítico da 120 %, la última 180 %, y el intervalo se reparte en tramos iguales sobre las filas.

- **Una sola tirada:** es función del **mismo índice** que ya seleccionó el efecto. **No** se consume un
  segundo `nextIndex()`, **no** se usa `Math.random()` y **no** se crea otra normal (RF-25, CA-07).
- **Uniforme:** como el índice es uniforme, cada uno de los 61 porcentajes enteros recibe las mismas filas
  salvo la diferencia de una que impone dividir en enteros (con 400 filas: 6 o 7 por porcentaje).
- **Entero:** el documento escribe el intervalo con enteros; un daño en puntos es entero.
- **Se adapta al equipo:** con +6 % de crítico (880 filas) el mismo intervalo se reparte sobre 880 filas.
- **Contrato:** `ResolvedRandomEffect` conserva `magnitude` (el intervalo del documento) y añade `percent`,
  el porcentaje que se aplica (0..180).
- **Reversible:** cambiar la regla es cambiar solo `materializePercent`. Es la decisión con **menor base
  documental** de las tres (el documento solo aporta el intervalo y el «posibles valores»): conviene que el
  PO/profesor la ratifique.

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
                                                            effects  → assessEquipmentEffect → ProbabilityModifier[]
                                                            table    → baseTable.withModifiers(modifiers)
                                                        → HeroEffectTable { table, assessments, appliedEffects,
                                                            reflectedInStatsEffects, nonTableEffects, pendingEffects }
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

### De `subtype` a la tabla vigente

`buildHeroEffectTable(hero)` → `baseEffectTableFor(parseHeroSubtype(hero.subtype))` →
`.withModifiers(modificadores de los efectos aplicados)`. Falla de forma explícita, sin inventar tabla:
subtipo fuera de `hero-subtypes-v1` → `DomainError`; incrementos mayores que el «no causar daño»
disponible → `InsufficientNoDamageProbabilityError` (no se recorta ni se redistribuye). `BuildHeroEffectTable.execute(playerId)`
añade la lectura por el puerto y lanza `PlayerWithoutEquippedHeroError` si no hay héroe equipado. **No está
registrado en `app.module.ts`** (no hay caller de producción hasta HU-17/HU-18) y **no invoca `ResolveRandomEffect`**: eso lo hace `ResolveAttack` (HU-20) tras un golpe efectivo.

La tabla base es inmutable y compartida: `withModifiers` devuelve una tabla **nueva**. No se mutan
`BASE_EFFECT_PERCENTAGES`, la tabla base ni `activeEffects`, y cada ejecución es determinista.

### Qué se hace con cada efecto

Cada efecto recibido tiene exactamente un resultado; ninguno se descarta ni se aplica en silencio. El
resultado (`HeroEffectTable`) los separa en `appliedEffects`, `opponentEffects`, `reflectedInStatsEffects`,
`nonTableEffects` y `pendingEffects` (y `assessments` los conserva todos, en el orden del contrato):

| Resultado              | Cuándo                                                                                                                                                                                                                                                                                                                                      | Modifica la tabla |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `APPLIED_TO_TABLE`     | `STAT_MODIFIER` sobre `CRITICAL_CHANCE`, `INCREASE`, magnitud `PERCENTAGE`, objetivo `SELF`, sin condición de activación, sin duración y sin `appliedToStats`. Lleva el `ProbabilityModifier` aplicado.                                                                                                                                     | **Sí**            |
| `AFFECTS_ATTACKERS`    | Actúa sobre quien ataca al portador (`target = OPPONENT`): `CRITICAL_CHANCE DECREASE PERCENTAGE` («−2 % de crítico al ataque del oponente») y `ATTACK DECREASE FIXED` («−1 al ataque del oponente»), permanentes e incondicionales. No cambia la tabla ni el Ataque del portador: lo aplica `prepareAttack` (HU-20). Lleva su `adjustment`. | Del atacante      |
| `REFLECTED_IN_STATS`   | `appliedToStats = true`: ya está en `effectiveStats`. Se ignora **a propósito** para no aplicarlo dos veces.                                                                                                                                                                                                                                | No                |
| `NOT_A_TABLE_MODIFIER` | Vocabulario conocido que no es una probabilidad de la tabla: `POWER`, `HEALTH`, `DEFENSE`, `ATTACK`, `DAMAGE`, `HEALING` y los `kind` `DAMAGE`, `HEALING`, `IMMUNITY`, `REFLECT_DAMAGE`, `REVIVE`, `TEMPORARY_STATUS`. Su semántica pertenece a otras historias.                                                                            | No                |
| `PENDING_DEFINITION`   | Podría modificar la tabla y el requisito no define cómo (variantes no soportadas de `CRITICAL_CHANCE`), o Combat no reconoce el efecto. **No se aplica y se declara** en `pendingEffects`, con motivos.                                                                                                                                     | No                |

Motivos de `PENDING_DEFINITION` (se listan todos los que aplican): `CRITICAL_CHANCE_UNIT_UNDEFINED`
(magnitud `FIXED`, `DICE` o ausente), `CRITICAL_CHANCE_NOT_ROW_ALIGNED` (puntos básicos que no son un número
exacto de filas), `CRITICAL_CHANCE_ALREADY_IN_STATS_INCONSISTENT` (`appliedToStats = true`),
`ACTIVATION_CONDITION_UNEVALUATED`, `TEMPORARY_EFFECT_UNDEFINED`, `NON_SELF_TARGET_UNDEFINED`,
`OPERATION_UNDEFINED`, `OPPONENT_STAT_EFFECT_UNDEFINED` (un efecto sobre el oponente que no es uno de los dos
definidos) y `UNRECOGNIZED_EFFECT`. La lista cerrada de `NOT_A_TABLE_MODIFIER` es deliberada: una
estadística o un `kind` que no esté ahí **no se presume irrelevante**, porque podría ser justo una
probabilidad futura.

`CRITICAL_CHANCE` con `appliedToStats = true` es una contradicción del contrato (`effectiveStats` no tiene
ningún campo de crítico): no se da por consolidado ni se aplica una segunda vez; queda pendiente. No se
altera `effectiveStats`.

### Traducción de `CRITICAL_CHANCE`

Para la tabla de HU-25, un efecto `CRITICAL_CHANCE INCREASE PERCENTAGE` de Player-Inventory se traduce así:

```text
PERCENTAGE basisPoints  →  puntos porcentuales ABSOLUTOS de probabilidad
100 pb = +1 pp = +80 filas          300 pb = +3 pp = +240 filas          600 pb = +6 pp = +480 filas
```

La conversión la hace `ProbabilityModifier.ofBasisPoints(RandomEffectType.CriticalDamage, basisPoints)`
(1 fila = 1,25 pb; solo valen múltiplos de 5 pb, sin redondeo) y el incremento se aplica con
`EffectControlTable.withModifiers`: sale entero de «no causar daño».

**Justificación (Tabla 23).** Guerrero Armas base tiene crítico 5 % y «no causar daño» 30 %. Con «+6 % de
probabilidad de crítico» del equipamiento, la tabla oficial queda en crítico **11 %** y «no causar daño»
**24 %**: 5 + 6 = 11 y 30 − 6 = 24. Es decir, el bono es un incremento en puntos porcentuales absolutos, no un
porcentaje relativo sobre el 5 % (que daría 5,3 %).

**Ejemplo +300 pb (Espada de dos manos, Guerrero Armas)**

| Efecto    | Base             | +300 pb          | Filas (base → +300) |
| --------- | ---------------- | ---------------- | ------------------- |
| DAMAGE    | 60 % · 1–4800    | 60 % · 1–4800    | 4800 → 4800         |
| CRITICAL  | 5 % · 4801–5200  | 8 % · 4801–5440  | 400 → 640           |
| EVADE     | 3 % · 5201–5440  | 3 % · 5441–5680  | 240 → 240           |
| ESCAPE    | 2 % · 5441–5600  | 2 % · 5681–5840  | 160 → 160           |
| NO_DAMAGE | 30 % · 5601–8000 | 27 % · 5841–8000 | 2400 → 2160         |

**Ejemplo +600 pb: reproduce la Tabla 23 exacta**: DAMAGE 1–4800, CRITICAL 11 % (880 filas, 4801–5680),
EVADE 5681–5920, ESCAPE 5921–6080, NO_DAMAGE 24 % (1920 filas, 6081–8000).

**Varios bonos.** +300 y +200 dan +5 puntos (800 filas de crítico, 2000 de «no causar daño»), en cualquier
orden. Si la suma supera el «no causar daño» disponible: `InsufficientNoDamageProbabilityError` (consumirlo
justo hasta 0 es válido).

**Alcance de la regla.** Es **local** a `CRITICAL_CHANCE` + `EffectControlTable`. **No redefine `PERCENTAGE`**
para otras estadísticas: `ATTACK`, `DEFENSE`, `POWER`, `HEALTH`, `DAMAGE` y `HEALING` con `PERCENTAGE` no se
interpretan aquí (siguen `NOT_A_TABLE_MODIFIER`), y no cambia nada en Catalog ni en Player-Inventory.

### Efectos dirigidos al oponente

El documento define **dos** efectos permanentes e incondicionales que actúan sobre el héroe que ataca al
portador (`target = OPPONENT`): «−2 % de crítico al ataque del oponente» (Báculo de Permafrost, Tabla 9) y
«−1 al ataque del oponente» (Visión borrosa, Tabla 10). Se clasifican como `AFFECTS_ATTACKERS`: **no**
cambian la tabla ni el Ataque del portador, sino los de quien lo ataca, y los aplica `prepareAttack` (HU-20)
cuando el portador es el objetivo del golpe.

- `CRITICAL_CHANCE DECREASE PERCENTAGE` sobre `OPPONENT` (100 pb = 1 pp = 80 filas): la tabla de quien ataca
  pierde esas filas de crítico, que **vuelven a «no causar daño»** (el sentido inverso de la Tabla 23; el
  documento solo define «todo efecto que aumente restará a no causar daño»). Un efecto no puede quedar por
  debajo de 0 filas: se acota (`EffectControlTable.withReductions`). Los incrementos propios se aplican
  primero y las reducciones después, lo que equivale a sumar el neto y acotarlo en 0.
- `ATTACK DECREASE FIXED` sobre `OPPONENT`: se resta del Ataque de quien ataca, acotado en 0 (igual que
  Player-Inventory acota las estadísticas efectivas).
- **«Oponente» se lee como el héroe que ataca al portador.** En un 1 contra 1 es unívoco; en equipos el
  documento no distingue, y esta lectura es la única que no requiere estado de batalla.

### Casos aún pendientes

No se aplican, **no se inventa su comportamiento** y quedan en `pendingEffects` con su motivo:

- **`hasActivationCondition = true`**: no se trata como modificador permanente. La condición en sí no
  cruza la frontera (Player-Inventory solo envía el indicador). Evaluarla exige el estado de la batalla
  (turnos, estadísticas del oponente: p. ej. «si el ataque del oponente es menor que la defensa del
  guerrero», Tabla 16), que Combat aún no tiene.
- **`durationTurns`** (efecto temporal): no es un modificador de una tabla vigente; necesita el contador de
  turnos. En el documento, los efectos temporales son de daño, ataque o defensa («+1 al daño por dos
  turnos») o **épicas** (Tabla 20: dos turnos de recarga), que pertenecen a HU-19 y HU-31.
- **Combinaciones de objetivo y operación que el documento no define**: un aumento sobre el oponente, una
  disminución sobre uno mismo, `SET`, `MULTIPLY`, `BLOCK`, otros objetivos.
- **Magnitud `FIXED` o `DICE`** en `CRITICAL_CHANCE`: el documento solo expresa el crítico en «%».
- **`PERCENTAGE` sin equivalencia exacta en filas** (no múltiplo de 5 pb, negativo o no entero): no se redondea.
- **`CRITICAL_CHANCE` con `appliedToStats = true`**: contradicción del contrato.
- **Efectos sobre el oponente distintos de los dos definidos** (`ATTACK` como porcentaje, dado o aumento;
  cualquier efecto sobre su `DEFENSE`): `OPPONENT_STAT_EFFECT_UNDEFINED`.
- **Otras estadísticas de probabilidad** (p. ej. evasión) o efectos que Combat no reconoce:
  `UNRECOGNIZED_EFFECT`. El documento no define ninguna otra probabilidad de la tabla que un objeto modifique.

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

## Integración con HU-20

HU-20 dicta: Ataque ≤ Defensa → **no hay efecto aleatorio**; Ataque > Defensa → golpe efectivo → invocar
este motor. `ResolveAttack` lo hace tras comparar (`docs/hu-20-attack-resolution.md`): un golpe no efectivo
**no consume el índice del efecto** ni consulta la tabla. La tabla que recibe es la del atacante para ese
golpe (`prepareAttack`): base + sus incrementos − lo que le quita el equipo del objetivo. Sigue sin haber
vida, turnos ni ataque básico (HU-17, HU-18) ni un caller de producción.

## Sanadores: «no causar daño» = 100 % (decisión de diseño)

La Tabla 21 imprime **0 % en todas las filas** de Chamán y Médico, lo que suma 0 % y no 100 %. La nota del
proyecto (mismo documento, tras la Tabla 23) dice: _«es necesario diseñar las tablas de efectos aleatorios
para todos los personajes, manteniendo la lógica del ejercicio y configurando valores apropiados que eviten
un desequilibrio entre los jugadores»_. Por instrucción del PO/profesor de resolver los pendientes con el
documento, se completa su perfil con **«no causar daño» = 100 %** (0 % en los otros cinco efectos).

Es la **única** distribución que respeta todo lo que el documento dice de ellos:

- 0 % en los cinco efectos que dañan (Tabla 21);
- **sin Ataque ni Daño** (Tabla 6: «−»): un sanador no gana una capacidad ofensiva que el documento le niega;
- «no causar daño» es el efecto residual que absorbe lo que los demás no ocupan (Tabla 23).

No introduce ningún valor de balance. `baseEffectTableFor(CHAMAN | MEDICO)` ya no lanza y
`UnsupportedHeroEffectProfileError` se retiró. Una prueba fija los ocho perfiles en 100 %. HU-16 solo
establece que participan en modalidades de equipo y no en 1 contra 1; su acción propia es sanar (HU-19).

**Limitación conocida:** un sanador **no puede iniciar un golpe** en HU-20: `attack` llega `null` y se rechaza
(`AttackNotDefinedError`). Que su «ataque básico siempre disponible» (HU-18) sea una acción sin daño o esté
oculta es decisión de HU-18. Sí puede ser objetivo de un golpe (solo se usa su Defensa).

## Tensión documental resuelta

El mismo documento oficial, justo tras la Tabla 23, afirma: _«el índice aleatorio es una variable
pseudo-aleatoria que debe seguir una distribución normal»_. Pero las tablas definen los efectos **por
filas** (4800 de 8000 filas = 60 %). Ambas cosas solo son compatibles si el índice se distribuye de forma
que cada fila pese 1/8000, es decir, **uniforme**: con una normal directa las filas 1–4800 recibirían
≈ 72,4–72,6 % de las tiradas y no el 60 % de la Tabla 22 (ver `docs/hu-24-randomness-engine.md`).

- **Decisión del PO (2026-09-20, comentario de cierre de HU-24 #71):** la normalidad corresponde a la
  variable intermedia (MT19937 → Box-Müller); el **índice 1..8000 que consulta HU-25 es uniforme** para
  preservar la semántica probabilística de las filas. Es la que implementa HU-24 y asumen las pruebas
  estadísticas.
- **Semilla del proyecto: 3.000.000** (cierre de HU-26 #73). El PR #19 fue una re-ejecución exploratoria,
  quedó cerrado sin merge y no forma parte de la decisión. La política de qué semilla recibe cada batalla
  puede evolucionar con el agregado de batalla.

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
  1..8000, sin huecos ni solapamientos y fronteras; Chamán/Médico con «no causar daño» = 100 %.
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
  inválido), clasificación de cada efecto, y la aplicación de `CRITICAL_CHANCE` (ver la sección siguiente); cadena completa JSON → tabla → efecto.
- `test/fixtures/equipped-hero.ts` — fixture contractual único.
- **Controles de mutación (integración original):** 8 defectos deliberados (`activeEffects ?? []`, lectura absoluta del crítico, spread que
  filtra `raw`, `appliedToStats` antes que el crítico, cast ciego del subtipo, subtipo ignorado, héroe por defecto
  ante `null`, `maxPower` desde `baseStats`) — **8 de 8 detectados**.

**Aplicación de `CRITICAL_CHANCE` a la tabla** (rama `feat/hu-25-critical-chance-modifier`):

- `build-hero-effect-table` — sin efectos → base; +300 pb → crítico 400 → 640 y «sin daño» 2400 → 2160, rangos
  y fronteras exactos (filas 4800/4801/5440/5441/5680/5681/5840/5841/8000); +600 pb → **Tabla 23 exacta**
  (880 / 1920); +300 +200 = +5 puntos e independiente del orden; 0 pb; consumo exacto de «no causar daño» (válido) y
  exceso (`InsufficientNoDamageProbabilityError`); condición de activación, objetivo distinto de `SELF`,
  temporal, `DECREASE`/`SET`/`MULTIPLY`/`BLOCK`, `FIXED`, `DICE` y `appliedToStats` → pendientes sin cambiar la
  tabla; no muta la base ni `activeEffects`; `ATTACK PERCENTAGE` sigue sin ser un modificador de la tabla;
  cadena JSON de Player-Inventory → `PlayerInventoryHttpClient` → tabla (crítico 640, sin daño 2160).
- `random-effect-resolution` (integración) — con un `RandomSequencePort` controlado, el índice 5300 da `EVADE`
  con la tabla base y `CRITICAL_DAMAGE` con la espada; con el generador real (HU-24) el equipamiento cambia el
  resultado sin ninguna otra fuente aleatoria.

**Pendientes heredados resueltos con el documento** (rama `feat/hu-20-resolver-ataque-vs-defensa`):

- `base-effect-profiles` — los ocho perfiles suman 100 %; Chamán/Médico con «no causar daño» = 100 %: sus 8000 filas
  son `NO_DAMAGE` y **ningún índice causa daño**.
- `critical-percent-materialization` (29) y `effect-table-reductions` (14) — materialización por posición del
  crítico (120 % y 180 % en los extremos, 61 porcentajes alcanzables, monótona, sin `Math.random`) y reducciones de
  la tabla (vuelven a «no causar daño», acotadas en 0).
- `opponent-effects` (35) — `-2 % de crítico` y `-1 al ataque` del oponente → `AFFECTS_ATTACKERS`; cada variante no
  definida sigue pendiente con sus motivos.
- Detalle y controles de mutación (18 de 18) en [`hu-20-attack-resolution.md`](hu-20-attack-resolution.md#pruebas).

## Limitaciones

- No es el motor de combate: sin vida, turnos, ataque básico ni daño numérico (HU-17, HU-18).
- **Sin caller de producción:** `ResolveAttack` y `prepareAttack` (HU-20) solo se ejercitan en pruebas; no se
  registran en `app.module.ts` ni hay endpoint (un cliente no puede aportar Ataque ni Defensa).
- Solo dos formas de `CRITICAL_CHANCE` modifican una tabla (incremento sobre uno mismo, disminución sobre el
  oponente) y una forma de `ATTACK` altera el golpe. Los demás efectos se clasifican y los que podrían
  afectar quedan en `pendingEffects`; no se finge que se aplicaron.
- **Efectos condicionados y temporales sin aplicar:** necesitan el estado de la batalla (turnos, estadísticas
  del oponente). No hay ninguno en el documento que modifique la tabla salvo las épicas (HU-19, HU-31).
- Un sanador no puede iniciar un golpe (sin Ataque, Tabla 6).
- La integración exige que Player-Inventory ya entregue `activeEffects`: contra una versión anterior el
  ingreso a sala falla con 503 (ver [Orden de despliegue](#orden-de-despliegue)).
- Sin persistencia ni endpoint (no hay requisito que los pida).

## Pendientes

Todos los pendientes heredados de esta historia se **resolvieron con el documento oficial** salvo los
efectos condicionados o temporales. Cada uno con su base:

| #   | Pendiente heredado                               | Resolución                                                                                                                    | Base                                                                                       |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Unidad de `CRITICAL_CHANCE` con `PERCENTAGE`     | 100 pb = +1 punto porcentual absoluto = +80 filas (Combat #23)                                                                | **Documento:** Tabla 23 (5 % + 6 % = 11 %, no 5,3 %)                                       |
| 2   | Distribución «normal» del índice                 | Índice uniforme; la normal es la variable intermedia                                                                          | **Decisión del PO**, cierre de HU-24 (2026-09-20)                                          |
| 3   | Semilla                                          | 3.000.000                                                                                                                     | **Decisión del PO**, cierre de HU-26 (2026-09-20)                                          |
| 4   | Chamán y Médico sin distribución válida          | «no causar daño» = 100 %                                                                                                      | **Documento:** nota del proyecto (diseñar todas las tablas) + Tabla 6 (sin Ataque ni Daño) |
| 5   | Crítico 120–180 %: valor concreto                | Por la posición de la fila dentro del rango del crítico (`materializePercent`); una sola tirada                               | **Diseño** (el documento solo da el intervalo): pide ratificación                          |
| 6   | Efectos hacia otro participante y `DECREASE`     | Solo los dos que el documento define (`-2 % de crítico`, `-1 al ataque` del oponente); el resto sigue pendiente               | **Documento:** Tablas 9 y 10                                                               |
| 7   | Efectos condicionados y temporales               | **Siguen pendientes:** necesitan el estado de la batalla (turnos, estadísticas del oponente); los de la tabla son épicas      | **Documento:** no hay ninguno sobre la tabla salvo épicas (HU-19, HU-31)                   |
| 8   | Magnitudes `FIXED`/`DICE` y otras probabilidades | **Siguen pendientes** sin uso: el documento solo expresa el crítico en «%» y no define otra probabilidad que un objeto cambie | **Documento**                                                                              |
| 9   | Tablas «para todos los personajes»               | Los ocho subtipos tienen tabla; las variantes por épicas o ítems son modificadores, no tablas                                 | **Documento:** nota del proyecto                                                           |
| 10  | `subtype` en el puerto de Combat                 | Hecho (Combat #22)                                                                                                            | —                                                                                          |
