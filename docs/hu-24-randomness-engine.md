# HU-24 — Motor pseudoaleatorio centralizado

> Estado: **implementado el generador**. No es el motor de combate: no hay tabla de efectos (HU-25),
> ni selección de semilla (HU-26), ni consumidores todavía. Este documento distingue en cada punto
> qué es requisito confirmado, decisión aprobada, decisión técnica, evidencia, recomendación o
> pendiente.

## Trazabilidad

| Elemento                                                              | Referencia                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario                                                   | [HU-24 — Generar variable pseudoaleatoria de alta precisión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71) (#71)                                                                                                                                                                 |
| Requisito funcional                                                   | RF-24                                                                                                                                                                                                                                                                                                    |
| Épica                                                                 | [EPIC-06 — Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) (#6)                                                                                                                                                                                                       |
| Trabajo previo de análisis/diseño (Tasks cerradas, **no se reabren**) | [#355](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/355) núcleo MT19937 + Box-Müller y mapeo · [#356](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/356) centralización · [#357](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/357) pruebas |
| Historia consumidora (fuera de alcance)                               | [HU-25 — Aplicar tabla de control de efectos aleatorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72) (#72), depende de HU-24                                                                                                                                                   |
| Historia dependiente (fuera de alcance)                               | [HU-26 — Selección y validación estadística de la semilla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/73) (#73), depende de HU-24                                                                                                                                                 |
| Decisión arquitectónica                                               | [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (Accepted)                                                                                                                                                          |

## Problema

El juego necesita que los resultados aleatorios de combates y misiones sean imparciales y que ningún
cliente pueda generarlos, inferirlos ni predecirlos. RF-24 exige un **único generador centralizado**,
**Mersenne Twister**, transformado con **Box-Müller**, que produzca valores utilizables en el rango
**[1, 8000]** (las filas de la tabla de control de HU-25).

## Clasificación de lo que se decidió

| #   | Tipo                              | Contenido                                                                                                                                                                           |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Requisito funcional confirmado    | Generador único y centralizado; Mersenne Twister; Box-Müller; servidor como única autoridad; valor en [1, 8000] (issue #71, CA-01…CA-08)                                            |
| 2   | Decisión arquitectónica aprobada  | Combat es el único dueño de la aleatoriedad; Missions no la implementa, la consume vía Combat; no existe un microservicio Random; ningún cliente recibe semilla ni estado (ADR-019) |
| 3   | Decisión técnica necesaria        | MT19937 de 32 bits con `init_genrand`; uniforme de 53 bits (`genrand_res53`); semilla uint32; CDF de Hart/West; secuencia con estado creada por fábrica (sin singleton)             |
| 4   | Evidencia experimental            | Hallazgo 60 % vs ≈72,6 % (ver más abajo); estudio de semillas en Colab (contexto de HU-26)                                                                                          |
| 5   | Recomendación                     | Mantener el mapper como pieza separada; no exponer nunca índices crudos a clientes; decidir el uso de un CSPRNG para futuros usos de seguridad                                      |
| 6   | Pendiente que necesita aclaración | Interpretación final de "distribución normal" del índice (PO/profesor); rango de semilla; política de semilla por batalla; contrato para Missions                                   |

## Arquitectura

Clean + Hexagonal. El dominio y la aplicación no conocen ninguna implementación concreta.

```text
domain/
  value-objects/RandomIndex.ts        1..8000 por construcción
  value-objects/RandomSeed.ts         uint32
  errors/RandomnessErrors.ts          InvalidRandomIndexError, InvalidRandomSeedError
application/
  ports/RandomSequencePort.ts         RandomSequencePort, RandomSequenceFactoryPort, RANDOM_SEQUENCE_FACTORY
adapters/outbound/system/
  Mt19937.ts                          etapa 1: uniformes
  BoxMullerNormalGenerator.ts         etapa 2: normal N(0,1)
  StandardNormalCdf.ts                Φ(z), utilidad numérica pura
  CdfUniformIndexMapper.ts            etapa 3: normal → índice (estrategia PROVISIONAL)
  Mt19937BoxMullerRandomSequenceFactory.ts   composición
  RandomnessContracts.ts              UniformSource, NormalSource, NormalToIndexMapper (internos)
infrastructure/bootstrap/app.module.ts        registra RANDOM_SEQUENCE_FACTORY
```

Flujo (cada flecha es una etapa sustituible):

```text
seed (uint32)
   │  init_genrand
   ▼
MT19937 ──► U1, U2 ∈ [0,1)  (53 bits, 2 salidas de 32 bits cada uno)
   │
   ▼  Box-Müller
Z0, Z1 ~ N(0,1)   (se aprovechan ambas)
   │
   ▼  NormalToIndexMapper  ← única pieza que cambiaría si cambia la interpretación
RandomIndex ∈ [1, 8000]
```

Puerto que consume la aplicación:

```ts
interface RandomSequenceFactoryPort {
  create(seed: RandomSeed): RandomSequencePort
}
interface RandomSequencePort {
  nextNormal(): number
  nextIndex(): RandomIndex
}
```

Ejemplo de uso futuro (HU-25 / simulación): el caso de uso recibe el puerto por inyección, crea **una**
secuencia por batalla y la consume turno a turno.

```ts
const sequence = factory.create(RandomSeed.create(seed)) // una vez por batalla o simulación
const row = sequence.nextIndex().value // 1..8000; cada llamada avanza el estado
```

## Mersenne Twister

- **MT19937** de 32 bits según el código de referencia `mt19937ar.c` (Matsumoto y Nishimura).
- **Implementación interna, sin dependencias nuevas.** Son ~40 líneas, quedan verificadas con vectores
  publicados y añadir una librería no daría garantías adicionales; no se introduce ningún paquete.
- Aritmética uint32 explícita: `>>> 0` tras cada operación de bits y `Math.imul` para la
  multiplicación de inicialización (una multiplicación normal pierde bits por encima de 2^53).
- **Uniforme de 53 bits** (`genrand_res53`): usa dos salidas de 32 bits (27 + 26 bits). Es la
  resolución que necesita Box-Müller para que `ln(U1)` no se degrade en las colas.
- **MT19937 no es criptográficamente seguro.** Su estado interno (624 palabras) puede reconstruirse a
  partir de 624 salidas consecutivas. No se afirma seguridad criptográfica. Ver [Seguridad](#seguridad).
- No se usa `Math.random()` (ni como respaldo) ni `crypto`: RF-24 exige Mersenne Twister.

## Box-Müller

```text
R  = sqrt(-2 ln U1)        t = 2π U2
Z0 = R cos t               Z1 = R sin t
```

- Z0 y Z1 son N(0,1) independientes. **Se aprovechan ambos**: la primera llamada devuelve Z0 y guarda
  Z1 (`#pending`); la siguiente devuelve Z1 sin consumir uniformes.
- `ln(0)` se evita: `U1 = 0` se sustituye por `Number.MIN_VALUE` (R ≈ 38,6, finito). U1 nunca llega a 1
  porque la fuente es [0, 1).
- Una fuente que devolviera `NaN` o algo fuera de [0, 1) lanza `RangeError` en origen en lugar de
  propagar `NaN`/`Infinity`.
- Depende solo de la interfaz `UniformSource`: se prueba con una fuente determinista sin MT19937.

## Semilla vs índice

```text
seed  ≠  index
```

`seed = 3_000_000` **no** significa "fila 3.000.000". Significa: _inicializa MT19937 con este valor_.
El **índice** (1..8000) es una salida de la secuencia, no una entrada. Confundirlos rompería la
reproducibilidad y la seguridad.

Rango de la semilla (**decisión técnica, RF-24 no la define**): entero sin signo de 32 bits
(0…4.294.967.295), el dominio de `init_genrand`. Ver [Decisiones pendientes](#decisiones-pendientes).

## Estado del generador

La secuencia **tiene estado** y este avanza en cada llamada.

```text
INCORRECTO   create(seed).nextIndex(); create(seed).nextIndex(); …   → siempre el mismo valor
CORRECTO     s = create(seed);  s.nextIndex(); s.nextIndex(); …      → el estado avanza
```

- La semilla se entrega **al crear** la secuencia, nunca por llamada: no se puede reiniciar sin querer.
- No hay singleton ni semilla global. `create()` devuelve una secuencia independiente con su propio
  MT19937. **"Centralizado" significa una única autoridad y una única implementación en Combat, no un
  cursor compartido por todas las batallas**: cada batalla podrá reproducirse por separado.
- El estado (624 palabras de MT y la normal pendiente) vive en campos privados de ECMAScript (`#`), sin
  getters ni `toJSON`: `JSON.stringify` y `Object.keys` no lo revelan (probado).
- `nextNormal()` y `nextIndex()` consumen **la misma** secuencia.

## Variable normal intermedia

Box-Müller entrega `Z ~ N(0,1)`. Es la "variable pseudoaleatoria con distribución normal" que exige
RF-24 y que `nextNormal()` expone tal cual. Sobre ella se aplica el mapper para obtener el índice.

## Conversión provisional a índice uniforme

```text
Z ~ N(0,1)   ──Φ──►   U = Φ(Z) ~ Uniforme(0,1)   ──►   index = min(⌊U · 8000⌋, 7999) + 1
```

> **Es una decisión técnica PROVISIONAL, no un requisito funcional.**

- `Φ` es la CDF normal estándar. `Math.erf` no existe en JavaScript y una librería científica sería
  desproporcionada: se implementa la aproximación racional de Hart (1968) en la formulación de West
  (2005), en ~40 líneas, sin dependencias.
- Precisión **medida** contra `scipy.special.ndtr` en la rejilla z ∈ [−9, 9] con paso 0,01 (1801
  puntos): error absoluto máximo **2,2·10⁻¹⁶**; error relativo en la cola inferior (z ≤ −1) de hasta
  ≈ 9·10⁻⁹. Al mapeo solo le importa el error absoluto (debe ser ≪ 1/8000 = 1,25·10⁻⁴).
- Se cumple por construcción `1 ≤ index ≤ 8000` y `Number.isInteger(index)`: el `min(…, 7999)` cubre
  el caso `Φ(Z) = 1` (Φ satura a 1 para Z > ≈ 8,3, y Box-Müller con MT puede llegar a Z ≈ 8,57);
  sin él saldría 8001. Además `RandomIndex.create()` rechaza `0`, `8001`, decimales, `NaN` e
  `Infinity`.
- El mapper es un componente **separado** (`NormalToIndexMapper`): si el PO o el profesor formalizan
  otra interpretación, se reemplaza solo esa clase, sin tocar ni volver a probar MT19937 ni
  Box-Müller.

## Hallazgo 60 % vs ≈ 72,6 %

**Requisito original (HU-24, CA-01).** Valor en [1, 8000] con distribución "estadísticamente validada
como normal".

**Semántica de HU-25.** La tabla se define por **filas**: 4800 de 8000 filas = **60 %**.

**Hallazgo.** Si la normal N(4000,5; 1333,17) se usara **directamente** como índice, las filas 1..4800
recibirían ≈ 72,4 – 72,6 % de las tiradas, no 60 %. Cálculo analítico (SciPy), según cómo se trate el
borde:

| Convención                                  | P(índice en 1..4800) |
| ------------------------------------------- | -------------------- |
| Rango continuo [1, 4800]                    | 72,43 %              |
| Con corrección de continuidad [0,5; 4800,5] | 72,44 %              |
| P(X ≤ 4800) (recorte inferior)              | 72,56 %              |
| P(X ≤ 4800,5)                               | 72,58 %              |

El estudio previo reportó **72,64 %**. Ese valor **no se reprodujo de forma exacta** aquí: es
consistente con las cifras analíticas dentro del ruido muestral de una muestra de 100.000 valores
(desviación típica de la proporción ≈ 0,14 puntos porcentuales). Lo relevante no cambia: la normal
directa desplaza ≈ 12–13 puntos sobre el 60 % que exige la semántica de filas.

**Con la decisión adoptada** (CDF → uniforme), sobre 200.000 tiradas con semilla 3.000.000 el rango
1..4800 recibe **60,21 %** (medido en la prueba automatizada, tolerancia ±1 punto).

## Motivo para no usar clamping

`clamp(normal, 1, 8000)` acumula toda la masa de las colas en 1 y en 8000: ≈ 0,13 % en cada extremo
apilado en una sola fila, y la campana sigue concentrando ≈ 72,6 % en las primeras 4800 filas.
Resuelve el rango, no la distribución.

## Motivo para no usar abs/módulo

- `abs(normal)` pliega la campana sobre sí misma: duplica la densidad de un lado y elimina el otro.
- `normal % 8000` envuelve las colas sobre el extremo opuesto: mezcla valores extremos con filas
  situadas en el otro extremo de la tabla y rompe la monotonía.

Ambas deforman la distribución; por eso se descartan. (Verificado por mutación: sustituir la CDF por la
normal recortada hace fallar la prueba de uniformidad.)

## Seguridad

Verificado en el diff:

- La semilla y el estado del PRNG son **solo del servidor**: ningún DTO, controlador ni cliente
  proporciona semilla, índice, U1/U2 ni reinicia la secuencia.
- **No existe ningún endpoint** de aleatoriedad. Una prueba de integración verifica que
  `GET/POST /api/random`, `/api/seed`, `/api/v1/combat/random|seed|randomness` responden 404.
- Sin `Math.random()` en ningún punto (probado con un espía) y sin `crypto` como sustituto.
- El estado no se serializa ni se enumera; no se registra en logs (el motor no usa el logger).
- No se añadieron secretos, no se tocaron los guards, ni el HMAC, ni ninguna base de datos.
- **Riesgo residual (MT19937 no es CSPRNG):** quien observe 624 salidas crudas consecutivas podría
  reconstruir el estado. Aquí cada índice consume cuatro palabras de 32 bits tras una transformación
  no lineal con pérdida, y a un cliente solo llegaría el _efecto_ resuelto, no el índice; aun así,
  **recomendación:** no exponer nunca índices crudos ni valores normales a clientes, y decidir si algún
  uso futuro con incentivo económico real (Wallet, Auction) requiere un CSPRNG.

## Integración futura con HU-25

HU-25 inyectará `RANDOM_SEQUENCE_FACTORY`, creará una secuencia por batalla y usará
`nextIndex().value` como fila de la tabla de 8000 filas. **HU-25 no está implementada.** HU-24 no
define efectos, críticos, daño ni tablas.

## Integración futura con HU-26

HU-26 selecciona y valida estadísticamente la semilla (media, desviación, asimetría, curtosis,
Kolmogorov-Smirnov, Ljung-Box, Q-Q). **HU-26 no está implementada.** Esta rama solo aporta pruebas
automatizadas deterministas de humo estadístico (ver [Reproducibilidad](#reproducibilidad)), no el
estudio científico. La política de qué semilla recibe cada batalla o simulación **no se decide aquí**.

## Integración futura con Missions

ADR-019 fija que Missions **no** implementa su propio generador: pide la simulación a Combat
(`POST /api/internal/v1/combat/simulations`). Ese contrato **no está formalizado todavía**, por lo que
**no se creó** ninguna ruta ni contrato: HU-24 solo deja el puerto listo para que el futuro caso de
uso de simulación lo consuma.

## Reproducibilidad

**Misma semilla → misma secuencia** dentro de esta implementación TypeScript (probado con 2000 salidas,
que cruzan varios bloques de 624 palabras).

Valores de referencia usados como pruebas _golden_ (semilla `3_000_000`, **solo como fixture**):

| Etapa            | Primeros valores                                                     |
| ---------------- | -------------------------------------------------------------------- |
| MT19937 (uint32) | `3860895593, 2004487413, 2370801471, 2009496479, 980264933, …`       |
| Box-Müller (Z)   | `-0.43720037…, -0.14813966…, -0.14412579…, 1.71288657…, 1.16140957…` |
| Índice 1..8000   | `2648, 3529, 3542, 7654, 7019, 4260, 2553, 5830, 2324, 6027`         |

**Verificación independiente (Python 3.13, NumPy 2.4.2, SciPy 1.17.0):**

- Semilla 5489: las 5 primeras salidas y la salida nº 10.000 (`4123659995`) coinciden con los vectores
  publicados de `mt19937ar.c` / `std::mt19937`.
- MT19937 (uint32) y uniformes de 53 bits son **idénticos bit a bit** a `np.random.RandomState(seed)`
  para las semillas 5489 y 3.000.000.
- Box-Müller coincide con una reimplementación independiente en Python (diferencia ≤ 1,1·10⁻¹⁶) y
  los índices con `floor(scipy.special.ndtr(Z)·8000)+1`.

**Advertencia — NO se afirma equivalencia con el estudio del Colab.** La coincidencia demostrada es con
`RandomState(seed)` (inicialización `init_genrand`). `np.random.MT19937(seed)` y `default_rng(seed)`
inicializan con `SeedSequence` y producen **otra** secuencia; se comprobó para la semilla 3.000.000:

```text
RandomState(3000000) / esta implementación:   3860895593, 2004487413, 2370801471
np.random.MT19937(3000000) (SeedSequence):    3826221150, 4148577348, 2016444158
```

Si el estudio usó `MT19937(seed)`/`default_rng`, sus secuencias **no** coinciden con las de
producción, y HU-26 debe validar el generador productivo real. No se asume lo contrario.

### Validación estadística automatizada (humo, no estudio científico)

Semilla fija, sin reloj ni `Math.random`, por tanto **deterministas** y no _flaky_:

- 200.000 índices, 80 bins de 100 filas: χ² = **105,0** (crítico α = 0,001 con 79 g. l.: 123,594).
  Otras semillas probadas (0, 1, 42, 777, 123456789) dieron entre 59 y 108.
- Rango 1..4800: **60,21 %** (esperado 60 %; la normal directa daría ≈ 72,6 %).
- Sin concentración central: el bin central no supera en más de un 15 % a los extremos.
- Etapa normal (100.000 valores): media ≈ 0 y desviación típica ≈ 1 (tolerancia 0,02).

### Prueba de mutación manual

Para comprobar que las pruebas detectan defectos reales se rompió deliberadamente cada etapa (constante
de MT, templado, `res53`, normal pendiente de Box-Müller, guardia de `log(0)`, signo de la CDF, defensa
del límite superior, mapeo por normal recortada, estado compartido entre secuencias): **9 de 9
mutantes fueron detectados.**

## Limitaciones

- No es el motor de combate: no hay turnos, ataque, daño ni tablas.
- MT19937 no es criptográficamente seguro (ver [Seguridad](#seguridad)).
- La validación de "distribución normal" del **índice** (CA-01, CA-08 del issue) no queda cerrada por
  esta rama: la variable normal intermedia sí es N(0,1) (probada con media y desviación), pero el
  **índice final es uniforme por decisión técnica provisional**, y la validación formal (KS,
  Ljung-Box, Q-Q) es alcance de HU-26.
- La CDF es una aproximación (ver precisión medida arriba), no exacta.
- Sin persistencia de semilla ni de secuencia: **no existe** agregado de batalla/simulación en
  `develop`, y no se inventó uno (ni esquema Mongo, ni ciclo de vida). Punto de integración: el futuro
  agregado guardará la semilla que pasó a `create(seed)`.
- No hay reanudación de una secuencia a mitad (guardar/restaurar el estado MT): si una batalla debe
  sobrevivir a un reinicio, habrá que decidir cómo (p. ej. semilla + contador de llamadas). No se
  diseñó porque depende del agregado inexistente.

## Decisiones pendientes

1. **Interpretación de "distribución normal" del índice final** (PO / profesor). Impacto: solo cambia
   `NormalToIndexMapper`. Mientras tanto, el índice es uniforme (provisional).
2. **Rango de la semilla.** RF-24 no lo define. Esta rama acepta uint32. Observación: el estudio lista
   la semilla `7_294_967_295`, que **excede** 2³²−1 = 4.294.967.295 (posible errata de
   `4_294_967_295`; sin confirmar) y no es representable con `init_genrand`; NumPy con `SeedSequence`
   sí la acepta. Si HU-26 la necesita, habría que ampliar el rango (p. ej. `init_by_array`).
3. **Política de semilla por batalla/simulación** (HU-26 / integración): cómo se elige, dónde se
   guarda y quién puede reproducirla. No se hardcodea `3_000_000` como semilla global.
4. **Contrato interno de simulaciones para Missions** (OpenAPI en `Nexus-Battle-Infrastructure`).
5. **Necesidad de un CSPRNG** para usos futuros con valor económico directo.

## Evidencia Colab

Estudio previo de semillas (contexto de HU-26, **no** reproducido en esta rama):

<https://colab.research.google.com/drive/1l4pQbEZ6LuZB3Kl2YH2C-o0XxvbIPuPT#scrollTo=33-9co5vTNEd>

Semillas evaluadas: 0, 1, 42, 53, 234, 365, 777, 1000, 1500, 3_000_000, 7_294_967_295 · muestra de
100.000 valores por candidata · métricas: media, desviación típica, asimetría, exceso de curtosis,
Kolmogorov-Smirnov, Ljung-Box (lags 10, 20, 30, 40, 50) y Q-Q · α = 0,05 · candidata: `3_000_000`.
Los datos de esta sección provienen del enunciado del encargo; el cuaderno no se ejecutó ni se
verificó desde esta rama. `3_000_000` se usa aquí **solo** como fixture determinista y referencia
histórica.
