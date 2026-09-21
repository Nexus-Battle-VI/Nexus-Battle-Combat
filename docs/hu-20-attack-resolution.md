# HU-20 — Calcular resultado de un ataque (Ataque vs. Defensa)

> Estado: **implementados la comparación Ataque contra Defensa, el dado de Ataque de la Tabla 6, la
> preparación de un golpe entre dos héroes equipados y la resolución con el efecto aleatorio de HU-25**, con
> pruebas unitarias y de integración contra el motor real de HU-24. Es un **bloque de dominio y aplicación
> sin caller de producción**: ningún flujo de batalla lo invoca todavía (HU-17 orden de turnos, HU-18 ataque
> básico), y **no está expuesto por HTTP** a propósito. No calcula daño numérico, vida ni fin de turno (HU-18).
> **HU-20 no está terminada de extremo a extremo** hasta que HU-18 la use en un combate real. Este documento
> distingue en cada punto qué es requisito explícito, fuente oficial, decisión técnica, decisión de diseño o
> pendiente.

## Trazabilidad

| Elemento                | Referencia                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario     | [HU-20 — Calcular resultado de un ataque (Ataque vs. Defensa)](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/64) (#64)                                                                                                                                                                                                                                    |
| Requisito funcional     | RF-20                                                                                                                                                                                                                                                                                                                                                                         |
| Épica                   | [EPIC-06 — Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) (#6)                                                                                                                                                                                                                                                                            |
| Bloqueada por           | HU-24 [#71](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71) (motor pseudoaleatorio) y HU-25 [#72](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72) (tabla de efectos), ambas **aceptadas por el PO el 2026-09-20**; HU-28 [#75](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/75) (equipamiento), ya integrada |
| Consumidores            | HU-18 [#62](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/62) (ataque básico, bloqueada por HU-17 y HU-20), HU-19 [#63](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/63) (habilidades) y la simulación de misiones (HU-72)                                                                                                           |
| Fuente oficial          | Documento «Proyecto Integrador II»: sección 6.1.1 (Tabla 6: Ataque, Defensa, Daño), sección 6.1.4 (mecánica para efectos aleatorios), Tablas 8–19 (equipamiento) y nota del proyecto tras la Tabla 23                                                                                                                                                                         |
| Decisión arquitectónica | [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md): Combat es el único dueño de la aleatoriedad                                                                                                                                                                                             |

## Clasificación de lo que se decidió

| #   | Tipo                          | Contenido                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito explícito           | Comparar las estadísticas efectivas de Ataque y Defensa; el Ataque incluye los bonos de armas, ítems y habilidades; la Defensa es la del objetivo con sus modificadores vigentes; si el Ataque **no supera** la Defensa el golpe no produce efecto; si **supera** es efectivo y solo entonces se invoca el motor de efectos aleatorios; el resultado dice de forma consistente si fue efectivo (issue #64, CA-01…CA-08)                                                                                                                           |
| 2   | Fuente oficial                | §6.1.4: _«Si el ataque logra superar la defensa del adversario, se emplea una variable aleatoria de alta precisión para seleccionar una fila de la tabla [...]. Por el contrario, si el ataque no logra superar la defensa del enemigo, no se produce ningún efecto»_. Tabla 6: el Ataque de cada héroe es `10 + 1d6`, `10 + 1d8` o `10 + 1d10`. La notación de dados del documento (§6.1.1, junto a la fórmula de experiencia) dice que _«1d8 indica que se debe lanzar un dado de ocho caras y el resultado obtenido se utiliza en la fórmula»_ |
| 3   | Lectura literal del requisito | **La igualdad no supera:** Ataque = Defensa no es efectivo. La HU distingue «no supera» (CA-04) de «supera» (CA-05)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | Decisión técnica necesaria    | Una cara de dado se obtiene del **mismo índice uniforme 1..8000** (HU-24), repartido en tramos iguales; no hay otra fuente de aleatoriedad, ni siquiera para el dado                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | Decisión de diseño            | Adoptadas por la instrucción del PO/profesor de resolver los pendientes con el documento: el dado de Ataque por subtipo (Tabla 6) vive en Combat; el equipo del objetivo le resta Ataque y crítico al atacante (Tablas 9 y 10); un héroe sin Ataque numérico no puede iniciar un golpe                                                                                                                                                                                                                                                            |
| 6   | Pendientes                    | Ver [Lo que sigue abierto](#lo-que-sigue-abierto)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Flujo

```text
héroe atacante ─┐                                    ┌─ Ataque = base + dado (Tabla 6) ──┐
                ├─►  prepareAttack  ────────────────►│  Defensa del objetivo              ├─►  ResolveAttack
héroe objetivo ─┘   (estadísticas efectivas,         │  tabla del atacante para ese golpe │        │
                     efectos del equipo)             └────────────────────────────────────┘        │
                                                                                                    ▼
                                                        Ataque > Defensa ?
                                                          no ─► golpe sin efecto        (consume solo el dado)
                                                          sí ─► ResolveRandomEffect ─► efecto + magnitud + porcentaje
                                                                                      (consume UN índice más)
```

### Componentes

```text
domain/policies/AttackResolutionPolicy.ts   compareAttackAgainstDefense(ataque, defensa) → { attackValue, defenseValue, effective }
domain/policies/AttackProfile.ts            ATTACK_DICE (Tabla 6), dieFaceFromIndex, AttackProfile { base, dice }
domain/errors/AttackResolutionErrors.ts     AttackNotDefinedError
application/use-cases/PrepareAttack.ts      prepareAttack(atacante, objetivo) → { attack, defenseValue, table, ... }
application/use-cases/ResolveAttack.ts      ResolveAttack.execute({ attack, defenseValue, table, sequence }) → AttackResolution
```

- **Dominio puro** (`AttackResolutionPolicy`, `AttackProfile`): sin NestJS, sin puertos, sin generador.
- **`ResolveAttack` recibe números y una tabla**, no héroes: sirve igual a un héroe, a un enemigo de misión
  o a una simulación (HU-72). Recibe la **secuencia por llamada** (un objeto con estado de cada batalla, como
  `ResolveRandomEffect`); la semilla y su política no son de HU-20 (HU-24, HU-26).
- **`prepareAttack` convierte dos héroes equipados** (el contrato de Player-Inventory) en esos números.
  Es una función pura, igual que `buildHeroEffectTable`, y **no consulta a Player-Inventory**: el flujo de
  batalla debe tomar el héroe de cada participante **una vez, al empezar el combate**, y no volver a pedirlo
  en cada golpe (HU-29, bloqueo de equipamiento en combate, sigue abierta).

### Uso previsto (HU-18)

```ts
const prepared = prepareAttack(attackerSnapshot, targetSnapshot)
const result = resolveAttack.execute({ ...prepared, sequence: battle.sequence })

if (result.effective) {
  // HU-18: daño numérico a partir de result.effect.percent, actualizar la vida, fin de turno
}
```

## Reglas

### Comparación (CA-01, CA-04, CA-05)

`efectivo ⇔ Ataque > Defensa`. Ambos son **enteros no negativos** (la misma forma que Player-Inventory
garantiza para las estadísticas efectivas: las redondea y las acota en 0); cualquier otro valor lanza
`DomainError`. La función es pura y devuelve los dos valores comparados para que quien la consuma no tenga
que recalcularlos.

### El Ataque incluye los bonos del equipo (CA-02)

`attack.base` es `effectiveStats.attack` de Player-Inventory: el Ataque base **más los modificadores
permanentes** de armas, ítems y armaduras. `prepareAttack` **no vuelve a sumar** los efectos con
`appliedToStats = true` (ya están dentro): con la espada de dos manos, 10 base + 3 = **13**, no 16.

Se le **resta** lo que el equipo del objetivo le quita al atacante: «−1 al ataque del oponente» (Visión
borrosa, Tabla 10), acotado en 0. Ver [Efectos del equipo del objetivo](#efectos-del-equipo-del-objetivo).

### El dado de Ataque (Tabla 6)

La Tabla 6 define el Ataque de cada héroe como un valor base **más un dado**:

| Subtipo                 | Ataque (Tabla 6) |
| ----------------------- | ---------------- |
| Guerrero Tanque / Armas | `10 + 1d6`       |
| Mago Fuego / Hielo      | `10 + 1d8`       |
| Pícaro Veneno / Machete | `10 + 1d10`      |
| Chamán / Médico         | «−» (sin Ataque) |

El «10» lo entrega Player-Inventory; el dado es una regla del juego por subtipo, así que vive en Combat
(`ATTACK_DICE`, congelado en runtime), igual que la Tabla 21 de efectos. La notación de dados del documento dice
que el dado **se lanza** (§6.1.1), y la definición del documento («un valor de ataque más elevado que la defensa incrementa la
**probabilidad** de acierto») solo tiene sentido si el Ataque es aleatorio: con un Ataque fijo de 10 un héroe
sin equipo **nunca** superaría una Defensa de 10 u 11 (Tanque, Armas, Fuego, Hielo), y dos Guerreros Armas
quedarían en tablas para siempre.

**Cara del dado:** `cara = floor((índice − 1) × caras / 8000) + 1`, sobre el **mismo índice uniforme** de HU-24.
Con 8 y 10 caras el reparto es exacto (1000 y 800 filas por cara); con 6 caras dos caras reciben una fila más
(1334 contra 1333, 0,075 % de diferencia). **No hay otra fuente de aleatoriedad.**

Probabilidad de acierto resultante (Ataque base 10, verificada contra el motor real con 100.000 golpes):

| Atacante              | Defensa | Acierta con | Probabilidad |
| --------------------- | ------: | ----------- | -----------: |
| Guerrero (`10 + 1d6`) |      11 | cara ≥ 2    |       83,3 % |
| Guerrero (`10 + 1d6`) |      10 | siempre     |        100 % |
| Guerrero (`10 + 1d6`) |      16 | nunca       |          0 % |
| Mago (`10 + 1d8`)     |      14 | cara ≥ 5    |         50 % |
| Pícaro (`10 + 1d10`)  |      15 | cara ≥ 6    |         50 % |

### Consumo de la secuencia (CA-06)

Es lo que hace predecible una batalla, y las pruebas lo cuentan con una secuencia guionizada:

| Golpe                     | Índices consumidos                         |
| ------------------------- | ------------------------------------------ |
| Efectivo, con dado        | `dice.count` (el dado) **+ 1** (el efecto) |
| Efectivo, sin dado        | 1 (el efecto)                              |
| **No efectivo**, con dado | `dice.count` (solo el dado)                |
| **No efectivo**, sin dado | **0**                                      |

Un golpe no efectivo **no consulta la tabla ni invoca `ResolveRandomEffect`** (CA-06: solo un golpe efectivo
invoca el motor de efectos). Todo se valida **antes** de tirar: una entrada inválida lanza y deja la
secuencia donde estaba.

### Resultado consistente (CA-07)

```ts
type AttackResolution =
  | { attackBase; attackRoll; attackValue; defenseValue; effective: false; effect: null }
  | {
      attackBase
      attackRoll
      attackValue
      defenseValue
      effective: true
      effect: ResolvedRandomEffect
    }
```

Siempre dice si el golpe fue efectivo y con qué valores; `effect` solo existe si lo fue (una unión
discriminada impide leer un efecto de un golpe que no lo produjo). No incluye el índice, la fila ni la
semilla. `effect` es el `ResolvedRandomEffect` de HU-25: efecto, magnitud y **porcentaje concreto**
(`docs/hu-25-effect-control-table.md`).

### Efectos del equipo del objetivo

El documento define dos efectos permanentes e incondicionales del equipo que actúan sobre **quien ataca al
portador**, y `prepareAttack` los aplica cuando el portador es el objetivo:

| Efecto del documento                     | Objeto (Tabla)                 | Qué hace `prepareAttack`                                                       |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| «−1 al ataque del oponente»              | Visión borrosa (Tabla 10)      | Resta 1 al Ataque del atacante (mínimo 0)                                      |
| «−2 % de crítico al ataque del oponente» | Báculo de Permafrost (Tabla 9) | Quita 160 filas de crítico a la tabla del atacante; vuelven a «no causar daño» |

«Oponente» se lee como el héroe que ataca al portador (en un 1 contra 1 es unívoco). La reducción del
crítico se acota en 0 filas y se aplica **después** de los incrementos propios (equivale a sumar el neto y
acotarlo en 0). Cualquier otra forma de efecto sobre el oponente (porcentaje, dado, aumento, efecto sobre su
Defensa, condicionado, temporal) queda **pendiente y sin aplicar**, con su motivo.

### Un héroe sin Ataque no inicia un golpe

`attack: null` lanza `AttackNotDefinedError`, **no** se trata como un Ataque de 0 (eso ocultaría un dato mal
cargado). Hay dos orígenes:

- **Chamán y Médico:** la Tabla 6 les pone «−» en Ataque y en Daño. Un sanador **sí puede ser objetivo** de un
  golpe (solo se usa su Defensa). Que su «ataque básico siempre disponible» (HU-18) sea una acción sin daño o
  esté oculta lo decide HU-18.
- **Un héroe ofensivo cuyo Catalog declaró el Ataque base como un dado:** Player-Inventory solo entrega el
  Ataque numérico si es un valor fijo, así que llega `null`. Es un dato mal cargado, no una regla.

## Qué NO hace HU-20, y por qué

- **Daño numérico, vida y fin de turno:** son de HU-18 (CA-06 y CA-07 de HU-18: «el estado de vida del objetivo
  debe actualizarse»; «el turno debe finalizar»). HU-20 entrega el efecto y su porcentaje.
- **La reducción del daño por la Defensa** («una defensa superior disminuye la cantidad de daño recibido»,
  §6.1.1): es cálculo de daño, no comparación. HU-18.
- **Turnos, objetivo único, fuego amigo:** HU-17, HU-18 y HU-12 (prevención de daño entre aliados).
- **Efectos condicionados y temporales:** necesitan el estado de la batalla (turnos, estadísticas del
  oponente). Ver [Lo que sigue abierto](#lo-que-sigue-abierto).
- **Habilidades y épicas** («+2 al ataque» por 4 puntos de Poder, «si el héroe carece de poder suficiente, el
  valor de ataque se reduce a su valor base»): HU-19, HU-31 y HU-11. Un flujo que las aplique pasa a
  `ResolveAttack` un `attack.base` ya ajustado.
- **Endpoint público:** un cliente que aportara el Ataque o la Defensa podría manipular el resultado (HU-24,
  CA-05). **No se registra en `app.module.ts`**, y una prueba de integración comprueba que ninguna ruta de
  ataque existe (404).
- **Nivel del héroe:** el documento hace crecer el Ataque con el nivel («un mago de fuego de nivel 3 posee un
  ataque base de 30»), pero el sistema no tiene la noción de nivel (Player-Inventory confirmó que el dato no
  existe, DP-3) y el documento no da la fórmula. Los valores son de **nivel 1**.

## Pendientes heredados resueltos con el documento

Por instrucción del PO/profesor de revisar el documento y resolver los pendientes heredados de HU-24 y HU-25
(detalle y base de cada uno en [`hu-25-effect-control-table.md`](hu-25-effect-control-table.md#pendientes)):

| Pendiente heredado                         | Resolución                                           | Base                                      |
| ------------------------------------------ | ---------------------------------------------------- | ----------------------------------------- |
| Unidad de `CRITICAL_CHANCE`                | 100 pb = +1 pp absoluto = +80 filas (Combat #23)     | Documento: Tabla 23                       |
| Índice «normal» o uniforme                 | Uniforme; la normal es la variable intermedia        | Decisión del PO (cierre de HU-24)         |
| Semilla                                    | 3.000.000                                            | Decisión del PO (cierre de HU-26)         |
| Chamán y Médico                            | «no causar daño» = 100 %                             | Documento: nota del proyecto + Tabla 6    |
| Crítico 120–180: valor concreto            | Por la posición de la fila; una sola tirada          | Diseño: el documento solo da el intervalo |
| Efectos dirigidos al oponente y `DECREASE` | Solo `-2 % de crítico` y `-1 al ataque` del oponente | Documento: Tablas 9 y 10                  |

## Lo que sigue abierto

1. **Efectos condicionados y temporales.** No se aplican: «si el ataque del oponente es menor que la defensa
   del guerrero» (Tabla 16) y «+1 al daño por dos turnos» necesitan el estado de la batalla. Ninguno modifica
   la tabla en el documento salvo las épicas (HU-19, HU-31). Quedan declarados, con su motivo, en
   `pendingEffects`. **`AttackResolution` devuelve el Ataque y la Defensa comparados** para que esas reglas
   puedan evaluarse cuando exista el estado de batalla.
2. **El Ataque con dado no puede expresarse en Catalog.** Catalog solo admite `baseAttack` como un valor fijo
   **o** un dado, nunca «valor + dado» (ADR-013; el formulario de administración de Web igual). Combat guarda
   la parte del dado por subtipo. **Si un administrador cargara el Ataque base de un héroe como `DICE`,
   Player-Inventory entregaría `attack: null` y el héroe no podría atacar** (`AttackNotDefinedError`), en vez de
   recibir un Ataque erróneo. No se verificó qué héroes están cargados en el Catalog de producción.
3. **«Oponente» en partidas por equipos.** La lectura «quien ataca al portador» es unívoca en un 1 contra 1;
   con equipos el documento no distingue entre «cualquier enemigo» y «el enemigo actual».
4. **Crítico 120–180:** es la decisión con menor base documental; pide ratificación del PO/profesor.
5. **Sanadores sin ataque:** HU-18 dice que el ataque básico «siempre está disponible», y el documento dice
   que Chamán y Médico no tienen Ataque ni Daño. Lo resuelve HU-18.
6. **Sin caller de producción:** no hay flujo de batalla (HU-17, HU-18). Mientras tanto la verificación es
   automatizada; no hay nada que probar contra el sistema desplegado.
7. **Despliegue:** no cambia ningún contrato ni endpoint, y Player-Inventory no necesita cambios. El
   `main` de Combat sigue por detrás de `develop`: nada de esto está desplegado hasta que se promueva.

## Pruebas

**276 pruebas nuevas** en 9 suites (7 unitarias y 2 de integración); la suite completa pasa de 1243 pruebas
(43 suites) con cobertura.

- `attack-resolution-policy` (40) — Ataque > Defensa (CA-05), Ataque ≤ Defensa (CA-04), **frontera** (la igualdad no
  supera; ±1), el orden de los argumentos, valores inválidos (decimal, negativo, `NaN`, infinito).
- `attack-profile` (54) — la Tabla 6 por subtipo (los ocho), constantes congeladas, y `dieFaceFromIndex`
  recorriendo los 8000 índices: 1000 filas por cara con 8 caras, 800 con 10 y 1334/1333 con 6.
- `resolve-attack` (36) — CA-01/04/05/06/07 con una secuencia guionizada que **cuenta los índices consumidos**:
  golpe efectivo (dado + 1), no efectivo (solo el dado, 0 si no hay dado), la tabla no se consulta, frontera,
  **barrido de 441 pares Ataque/Defensa**, validación **antes** de tirar, resultado consistente, sin `Math.random`.
- `prepare-attack` (47) — CA-02 (Ataque efectivo, sin volver a sumar lo consolidado), CA-03 (Defensa efectiva del
  objetivo), dado por subtipo, tabla del atacante, lo que resta el equipo del objetivo (`-1 al ataque`,
  `-2 % de crítico`) con acotación en 0, variantes no definidas → pendientes, sanadores y Ataque `null` →
  `AttackNotDefinedError`, subtipo inválido, pureza.
- `opponent-effects` (35) — clasificación de los efectos dirigidos al oponente (`AFFECTS_ATTACKERS`) y de cada
  variante que sigue pendiente, con todos sus motivos.
- `effect-table-reductions` (14) y `critical-percent-materialization` (29) — las reducciones de la tabla (vuelven a
  «no causar daño», acotadas en 0, sin depender del orden) y la materialización del crítico (120 % y 180 % en los
  extremos, los 61 porcentajes alcanzables, 6 o 7 filas por porcentaje, monótona, sin `Math.random`).
- `attack-resolution` (integración, 14) — HU-24 → HU-25 → HU-20 con el **generador real** y la semilla
  3.000.000: cinco golpes **derivados a mano** de los índices ya validados, reproducibilidad, que solo el golpe
  efectivo consume el índice del efecto, la **probabilidad de acierto** sobre 100.000 golpes (83,3 % / 50 % / 100 % /
  0 %), efectos ≈ Tabla 21 y crítico 120..180, y el JSON real de Player-Inventory de **ambos** héroes.
- `attack-resolution-wiring` (integración, 7) — ninguna ruta de ataque existe (404).
- `hu-25-no-alternative-randomness` — la **guarda estática** ahora vigila también los archivos de HU-20: ni
  `Math.random`, ni `node:crypto`, ni MT19937, Box-Müller, la CDF, la semilla o la fábrica.

**Suites de HU-25 actualizadas a propósito** (el comportamiento cambió por decisión, no por accidente):
los sanadores ya no lanzan (`base-effect-profiles`, `build-hero-effect-table`), y el resultado de una tabla
incluye `percent` (`effect-control-table`, `resolve-random-effect`, `official-effect-tables`,
`random-effect-resolution`).

**Controles de mutación (manuales): 18 defectos deliberados, 18 de 18 detectados** (base: 550 pruebas relevantes
en verde; cada defecto se aplicó solo, se ejecutaron las suites afectadas y se restauró el archivo):
`>` por `>=` (20 fallos) · Ataque y Defensa intercambiados (32) · el efecto se resuelve aunque el golpe no sea
efectivo (14) · el dado con `Math.random` (15) · `baseStats` en vez de `effectiveStats` (4) · Ataque `null` como 0 (4) ·
dado equivocado del Tanque (2) · cara del dado desplazada una fila (21) · lo que pierde el crítico no vuelve a «no
causar daño» (8) · reducción sin acotar en 0 (5) · `round` en vez de `floor` en el crítico (10) · crítico que ignora la
posición (9) · sanadores sumando 0 % (10) · el equipo del objetivo no resta Ataque (4) ni crítico (4) · los efectos del
atacante hacia su oponente se le aplican a él mismo (1) · validación posterior al dado (8) · el descuento de Ataque
sumado en vez de restado (4). _Un primer intento de este control quedó **invalidado**: el patrón de pruebas pasó
por un shell y no se ejecutó ninguna; se corrigió el arnés y se exige un resumen real de la base antes de evaluar._

**Validación local:** `npm ci`, `format:check`, `lint`, `typecheck`, `test:unit` (37 suites, 1146 pruebas),
`test:integration` (6 suites, 97), `test:coverage` (43 suites, 1243 pruebas: sentencias 96,88 %, ramas 92,45 %,
funciones 97,87 %, líneas 96,70 %; umbrales de 80 % sin tocar), `test:db` (2 suites, 19 pruebas, Testcontainers),
`build` y `git diff --check`.

## Limitaciones

- No es el motor de combate: sin vida, turnos, ataque básico ni daño numérico.
- Sin caller de producción ni endpoint.
- Valores de nivel 1.
- Un sanador no puede iniciar un golpe.
- Los efectos condicionados y temporales no se aplican.
