# HU-26 — Selección y validación estadística de la semilla

> Estado: **estudio ejecutado sobre la implementación PRODUCTIVA de HU-24 y documentado con evidencia
> reproducible.** La regla de selección, fijada _antes_ de ejecutar, produce la semilla **777**. Esto
> **no** define una política de semilla para las batallas (ver
> [Política de seed por batalla](#política-de-seed-por-batalla-pendiente)) ni vuelve criptográficamente
> seguro a MT19937. Este documento distingue en cada punto qué es requisito explícito, decisión
> experimental, evidencia observada, recomendación o pendiente.

## Trazabilidad

| Elemento                                          | Referencia                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historia de usuario                               | [HU-26 — Selección y validación estadística de la semilla](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/73) (#73)                                                                                                                                                                                                                                                    |
| Requisito funcional                               | RF-26                                                                                                                                                                                                                                                                                                                                                                                     |
| Épica                                             | [EPIC-06 — Jugar Online](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/6) (#6)                                                                                                                                                                                                                                                                                        |
| Tasks históricas (cerradas, **no se reabren**)    | [#362](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/362) estudio reproducible · [#363](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/363) métricas y selección · [#364](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/364) documentación. Son evidencia del análisis previo (Colab), **no** de la implementación productiva. |
| Dependencia                                       | HU-24 [#71](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/71) — Combat [#14](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/14) y [#15](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/15) (`docs/hu-24-randomness-engine.md`)                                                                                                              |
| Relacionada                                       | HU-25 [#72](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/72) — Combat [#16](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/16) (`docs/hu-25-effect-control-table.md`). HU-26 **no** usa la tabla de efectos para elegir la semilla.                                                                                                                     |
| Diseño del estudio fijado **antes** de ejecutarlo | commit `f177a557a79522d9b925f6dad7eef4c09fd205c0` (`tools/hu-26/study-config.json`)                                                                                                                                                                                                                                                                                                       |

## Objetivo

RF-26 pide comparar semillas candidatas del generador con un tamaño de muestra definido y, para cada
una, media, desviación estándar, asimetría, curtosis, Kolmogorov-Smirnov, Ljung-Box y Q-Q; seleccionar la
que mejor se ajuste según los criterios documentados y dejar la evidencia. Este documento y
`docs/evidence/hu-26/` cumplen eso **sobre el código que corre en Combat**, no sobre un prototipo.

### Clasificación de lo que se decidió

| Tipo                        | Contenido                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Requisito explícito (RF-26) | Conjunto de candidatas, tamaño de muestra **definido**, mismo procedimiento para todas, media/desviación/asimetría/curtosis, KS, Ljung-Box, Q-Q, selección del mejor ajuste, evidencia documentada     |
| Decisión arquitectónica     | ADR-019: Combat es el único dueño de la aleatoriedad; sin endpoint ni servicio aparte                                                                                                                  |
| **Decisión experimental**   | N = 100.000, α = 0,05, lags 10/20/30/40/50, las 11 candidatas, la regla de selección, las convenciones de cada métrica. Heredadas del estudio previo (Tasks #362/#363); **no** son requisitos de RF-26 |
| Evidencia observada         | Los resultados de este estudio (tablas, Q-Q, huellas)                                                                                                                                                  |
| Recomendación               | No usar la semilla seleccionada como semilla global; no exponer salidas crudas a clientes                                                                                                              |
| Pendiente funcional         | Política de semilla por batalla/simulación; ratificación del PO/profesor de los criterios «acordados» y de la interpretación normal → uniforme                                                         |

## Implementación productiva evaluada

```text
RandomSeed (uint32)
   ↓ init_genrand                                  (Mt19937.ts, mt19937ar.c)
MT19937 ── genrand_res53 ──► U1, U2 ∈ [0,1)         (53 bits, 2 salidas de 32 bits)
   ↓ Box-Müller                                    (BoxMullerNormalGenerator.ts)
Z ~ N(0,1)   ◄── ESTO es lo que valida HU-26
   ↓ Φ (CDF) → floor(U·8000)+1                     (CdfUniformIndexMapper.ts)
índice 1..8000 (uniforme)   ◄── NO se valida como normal
```

- La muestra sale **exclusivamente** de
  `Mt19937BoxMullerRandomSequenceFactory.createNormalSequence(RandomSeed.create(seed)).nextNormal()`.
- El harness (`tools/hu-26/`) **no reimplementa** MT19937, Box-Müller ni la CDF: reutiliza las clases
  productivas. Una prueba de integración verifica que la fábrica del harness y la que Nest resuelve desde
  el contenedor (`RANDOM_SEQUENCE_FACTORY`) producen exactamente las mismas normales e índices para las
  semillas 0, 42, 3.000.000 y 4.294.967.295.
- No se usan los índices 1..8000 para KS, media, desviación, asimetría, curtosis ni Q-Q de la normal.

## Diferencia con el Colab anterior

El estudio previo ([Colab](https://colab.research.google.com/drive/1l4pQbEZ6LuZB3Kl2YH2C-o0XxvbIPuPT#scrollTo=33-9co5vTNEd))
usó NumPy. Combat usa su propio MT19937 en TypeScript:

- Su `uint32` y sus uniformes de 53 bits son **idénticos bit a bit** a `np.random.RandomState(seed)`
  (`init_genrand`) y a los vectores de `mt19937ar.c` (comprobado en HU-24, PR #14).
- **No** coinciden con `np.random.MT19937(seed)` / `default_rng(seed)`, que inicializan con `SeedSequence`
  y producen otra secuencia (con la semilla 3.000.000: `3826221150…` frente a `3860895593…`).

Por eso **no se reutilizaron cifras del Colab**: el estudio se volvió a ejecutar. Además:

- Según los comentarios de las Tasks #363/#364, el estudio previo reportaba media ≈ 4000,9 y desviación
  ≈ 1312 para su candidata: son cifras de una variable **escalada al rango de índices**, no de `Z`
  ~ N(0,1). Este estudio analiza `Z` directamente (que es lo que RF-24 llama «variable normal»), así que
  las tablas **no son comparables número a número** con las del Colab.
- El Colab no se ejecutó ni se verificó desde esta rama; no se afirma qué constructor de NumPy usó.
- No se afirma equivalencia entre ambos estudios ni que sus conclusiones deban coincidir.

## Semillas candidatas

| Conjunto                          | Semillas                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| Histórico (estudio previo, 11)    | 0, 1, 42, 53, 234, 365, 777, 1000, 1500, 3.000.000, **7.294.967.295** |
| **Evaluado en este estudio (11)** | 0, 1, 42, 53, 234, 365, 777, 1000, 1500, 3.000.000, **4.294.967.295** |

- **`7.294.967.295` — candidata histórica inválida para la implementación productiva.** Excede
  `RandomSeed.MAX = 4.294.967.295` (2³² − 1): `RandomSeed` solo admite `uint32` porque es el dominio de
  `init_genrand`. **No se trunca, no se aplica módulo ni se hace un cast `uint32` silencioso** (un cast
  habría producido _otra_ semilla, 2.999.999.999, que nadie eligió). Una prueba verifica que se rechaza y
  que una configuración con ella como candidata no carga.
- **`4.294.967.295` = `RandomSeed.MAX`** se añade como candidata de frontera. Es una **decisión
  experimental** de este estudio: conserva las 11 candidatas y prueba el límite superior real. **No** es
  una corrección formal del valor histórico y **no se afirma** que fuera el número que se quiso escribir.

## Tamaño de muestra

`SAMPLE_SIZE = 100.000` observaciones de `Z` por semilla (**decisión experimental**, heredada del estudio
previo para poder comparar la metodología; no es un requisito de RF-26). 11 × 100.000 = 1.100.000 normales.

## Alpha

`α = 0,05` (**decisión experimental** del estudio previo, no un requisito de RF-26).

## Métricas y convenciones

Para cada semilla y con el mismo procedimiento (`tools/hu-26/analyze.py`, Python offline):

| Métrica                | Convención                                                                                       | Objetivo N(0,1) |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------- |
| Media                  | media aritmética                                                                                 | 0               |
| Desviación estándar    | **muestral, `ddof = 1`**                                                                         | 1               |
| Asimetría              | coeficiente de momentos g₁ (`scipy.stats.skew`, `bias=True`)                                     | 0               |
| **Exceso** de curtosis | de Fisher g₂ (`scipy.stats.kurtosis`, `fisher=True`, `bias=True`); **exceso**, no curtosis bruta | 0               |
| Mínimo / máximo de Z   | auditoría                                                                                        | —               |

## Kolmogorov-Smirnov

`scipy.stats.kstest(z, 'norm')`. H₀: la muestra proviene de N(0,1). Criterio: `p > α`.

> **`p > 0,05` significa «no se rechazó H₀ bajo este criterio»; no significa que se demostrara que la
> muestra es normal.**

## Ljung-Box

`statsmodels.stats.diagnostic.acorr_ljungbox` con ACF por FFT (O(n log n), no O(n²)), lags **10, 20, 30, 40
y 50**, `model_df = 0`. Se registra el p-value de cada lag y su **mínimo**; criterio: `mín p > α`.

Se contrasta **para cada semilla** con una implementación independiente (`Q(k) = n(n+2)Σρⱼ²/(n−j)`, ACF por
FFT y χ²): el análisis aborta si difieren más de 1e-9. La diferencia máxima observada en los controles es
< 1e-15.

## Q-Q

Un gráfico por candidata (`docs/evidence/hu-26/qq/seed-<semilla>.png`): cuantiles observados ordenados de
`Z` frente a los cuantiles teóricos N(0,1) en las posiciones `(i − 0,5)/n`, con la recta de referencia
`y = x`. Además se registran dos resúmenes numéricos **descriptivos (no intervienen en la selección)**: la
correlación Q-Q `r` y la máxima desviación absoluta de cuantiles en las probabilidades [0,005; 0,995].

## Criterio de selección

**Fijado y commiteado ANTES de ejecutar el estudio** (commit `f177a55`, `tools/hu-26/study-config.json`;
el historial de git lo demuestra). No se cambió después de ver resultados:

1. **Filtros**: se acepta la candidata solo si `KS p > α` **y** `mínimo Ljung-Box p > α`.
2. **Orden**: entre las aceptadas por **ambos** filtros, se ordena por **menor estadístico KS D**.
3. Desempate técnico determinista: menor valor de semilla (no ocurrió).
4. Si ninguna candidata superara los filtros, **no** se elegiría «la menos mala»: se informaría, se
   documentarían los resultados y se elevaría la decisión.

No participan en la selección: los índices 1..8000, las proporciones de la tabla de HU-25 ni objetivo
alguno sobre una semilla concreta. **No se favoreció ni se buscó volver a elegir la 3.000.000.**

## Resultados completos

Variable: `Z = createNormalSequence(seed).nextNormal()`, N = 100.000, α = 0,05. Tabla generada
automáticamente (`docs/evidence/hu-26/seed-comparison.csv` / `.md`), con estas convenciones de columnas: Std con
`ddof = 1`; asimetría de momentos; exceso de curtosis.

| Semilla    | Media     | Std (ddof=1) | Asimetria | Exceso curtosis | KS D     | KS p     | LB p(10) | LB p(20) | LB p(30) | LB p(40) | LB p(50) | LB min p | KS OK | LB OK | Aceptada | Orden |
| ---------- | --------- | ------------ | --------- | --------------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | ----- | ----- | -------- | ----- |
| 0          | 0.004347  | 1.001335     | -0.020015 | -0.005720       | 0.004615 | 0.028158 | 0.225204 | 0.039621 | 0.050406 | 0.026272 | 0.054141 | 0.026272 | no    | no    | no       | -     |
| 1          | 0.003504  | 1.002486     | 0.006208  | -0.001961       | 0.003652 | 0.138414 | 0.348947 | 0.309083 | 0.235942 | 0.399525 | 0.384146 | 0.235942 | si    | si    | si       | 6     |
| 42         | -0.002939 | 1.000636     | 0.013109  | -0.014777       | 0.003896 | 0.095858 | 0.425173 | 0.313796 | 0.584296 | 0.694629 | 0.092777 | 0.092777 | si    | si    | si       | 8     |
| 53         | -0.001319 | 0.996937     | -0.006804 | 0.014355        | 0.002528 | 0.544147 | 0.822722 | 0.758873 | 0.908397 | 0.931080 | 0.966360 | 0.758873 | si    | si    | si       | 4     |
| 234        | 0.001676  | 1.001762     | 0.000608  | 0.006940        | 0.001850 | 0.882895 | 0.777477 | 0.252672 | 0.435253 | 0.532028 | 0.708783 | 0.252672 | si    | si    | si       | 2     |
| 365        | -0.001124 | 0.998764     | -0.008195 | -0.008022       | 0.002361 | 0.631756 | 0.060853 | 0.080843 | 0.116463 | 0.027047 | 0.067008 | 0.027047 | si    | no    | no       | -     |
| 777        | -0.001094 | 1.001264     | -0.000554 | 0.002517        | 0.001818 | 0.894926 | 0.662987 | 0.117381 | 0.303805 | 0.499218 | 0.340778 | 0.117381 | si    | si    | si       | 1     |
| 1000       | -0.003937 | 0.997128     | -0.004953 | -0.009939       | 0.003244 | 0.242799 | 0.151713 | 0.323241 | 0.190179 | 0.197252 | 0.262690 | 0.151713 | si    | si    | si       | 5     |
| 1500       | -0.000644 | 1.000739     | -0.005233 | 0.012436        | 0.002160 | 0.738549 | 0.085923 | 0.108064 | 0.163557 | 0.291340 | 0.261668 | 0.085923 | si    | si    | si       | 3     |
| 3000000    | -0.004218 | 0.998729     | 0.006186  | 0.032429        | 0.003679 | 0.133062 | 0.972578 | 0.927687 | 0.897794 | 0.907983 | 0.575745 | 0.575745 | si    | si    | si       | 7     |
| 4294967295 | -0.005459 | 1.001484     | 0.012536  | 0.009718        | 0.004540 | 0.032336 | 0.532564 | 0.537002 | 0.683203 | 0.407349 | 0.290875 | 0.290875 | no    | si    | no       | -     |

- **8 de 11 candidatas aceptadas**; 3 descartadas: **0** (KS y Ljung-Box), **365** (Ljung-Box) y
  **4.294.967.295** (KS).
- Orden entre las aceptadas por menor KS D: 777 → 234 → 1500 → 53 → 1000 → 1 → 3000000 → 42.

### Q-Q y resúmenes descriptivos

Los 11 gráficos siguen la recta `y = x` sin curvatura sistemática; solo las últimas colas (|Z| > 4, pocas
observaciones) se separan como es esperable con N = 100.000. Numéricamente:

| Semilla    | Correlación Q-Q r | Máx. desviación de cuantiles [0,005; 0,995] | Z mínimo | Z máximo |
| ---------- | ----------------- | ------------------------------------------- | -------- | -------- |
| 0          | 0.999980          | 0.034505                                    | -4.3968  | 4.3911   |
| 1          | 0.999989          | 0.034245                                    | -4.2835  | 4.2430   |
| 42         | 0.999982          | 0.024548                                    | -4.2117  | 4.3777   |
| 53         | 0.999987          | 0.023157                                    | -4.4070  | 4.3814   |
| 234        | 0.999996          | 0.019538                                    | -4.4747  | 4.4857   |
| 365        | 0.999989          | 0.028499                                    | -4.7880  | 4.3102   |
| 777        | 0.999994          | 0.025377                                    | -4.6241  | 4.4313   |
| 1000       | 0.999986          | 0.025075                                    | -4.7114  | 4.9057   |
| 1500       | 0.999992          | 0.018920                                    | -4.4545  | 4.0543   |
| 3000000    | 0.999987          | 0.019792                                    | -4.7802  | 4.3679   |
| 4294967295 | 0.999990          | 0.018741                                    | -4.2290  | 5.0808   |

Rango de la correlación Q-Q: 0.999980 – 0.999996; mayor desviación central de cuantiles entre todas: 0.0345.

## Semilla seleccionada

**`777`** — según la regla pre-registrada y sobre esta ejecución. Presentó el **mejor ajuste dentro del
conjunto de candidatas, la muestra y el criterio experimental definidos**: KS D = 0.001818, KS p =
0.894926, mínimo Ljung-Box p = 0.117381.

Otros hechos que conviene tener presentes, sin interpretarlos de más:

- **La 3.000.000 (ganadora del estudio previo) queda aceptada, en 7.º lugar** de 8 por KS D. Con la
  implementación productiva la secuencia es otra; no se ajustó nada para favorecerla.
- La **1500**, que el Colab descartó por Ljung-Box, aquí queda **aceptada** (mín p = 0.085923): el
  resultado depende de la secuencia concreta.
- **La diferencia entre las dos primeras (777 y 234) es de 0.000031 en KS D**: el orden entre las
  candidatas aceptadas es fino y **no es estadísticamente significativo**; con otra semilla de prueba o
  con otra muestra podría invertirse.

Huellas de la semilla 777 (`sample-fingerprints.json`): SHA-256 de su muestra normal
`39081d8da3f7231887dff38e85bda53b2fffa0d12065246cc354a6f3ee94e698` y de su muestra de índices `6cfc51d7b864f18a3d5fef3ff063501e5553b99103ddbcca49741cc7ccab3a54`.

`docs/evidence/hu-26/selected-seed.json` recoge esta decisión.

## Limitaciones estadísticas

1. **Selección con muestra finita.** Un MT19937 bien implementado produce, a largo plazo, propiedades muy
   parecidas para toda semilla. Elegir «la mejor» con N = 100.000 es una exigencia de HU-26, pero **no
   convierte a esa semilla en matemáticamente superior** ni en «más aleatoria» para toda secuencia futura.
   Solo se puede afirmar que **presentó el mejor ajuste dentro del conjunto, la muestra y el criterio
   experimental definidos**.
2. **Comparaciones múltiples.** Con 11 semillas y α = 0,05, se esperan ≈ 0,55 rechazos de KS por azar; se
   observaron 2 (`P(≥ 2 | H₀) ≈ 0,10`). Los rechazos de Ljung-Box son más frecuentes que 5 % por semilla
   porque se toma el mínimo de 5 p-values correlacionados (no se calculó su tasa exacta). Los tres
   descartes son compatibles con el azar y **no indican por sí solos un defecto del generador**.
3. **Ganar por menor KS D es ruido dominado** (ver la diferencia entre 777 y 234).
4. **Esto no es una batería de aleatoriedad.** KS, Ljung-Box y Q-Q sobre `Z` con N = 100.000 no
   sustituyen a baterías como TestU01 o Dieharder ni prueban propiedades más finas de MT19937.
5. **«Criterios acordados».** El CA-07 habla de «los criterios acordados». Los usados son los del estudio
   previo (Tasks #362/#363); **no consta una ratificación formal posterior** por el PO/profesor.
6. La comprobación estadística es **de esta ejecución y de esta implementación**: si se cambia
   MT19937, Box-Müller, la CDF o el mapper, la evidencia deja de corresponder al código (una prueba
   automática lo detecta) y el estudio debe repetirse.

## Seguridad

- **MT19937 no es criptográficamente seguro.** Su estado (624 palabras) puede reconstruirse a partir de 624
  salidas consecutivas.
- **Nada de lo hecho aquí lo cambia.** Ni KS, ni Ljung-Box, ni Q-Q, ni la elección de una «buena» semilla
  impiden reconstruir el estado de MT.
- La seguridad frente al jugador depende de **no exponer la semilla, no exponer el estado, no exponer
  suficientes salidas crudas y mantener la autoridad en el servidor** (ADR-019). El estudio es offline: no
  añade endpoints, no persiste métricas y no toca el hot path.

## Seed != índice

`seed = 777` **no** significa «fila 777». La semilla inicializa el estado de MT19937; el **índice** (1..8000)
es una salida de la secuencia. La semilla no se compara con los rangos de la tabla.

## Normal vs índice uniforme

- **Lo que se valida como normal es `Z`** (la salida directa de Box-Müller), con `createNormalSequence`.
- El **índice final es uniforme** por la decisión técnica vigente de HU-24 (`Z → Φ(Z) → floor(U·8000)+1`) y
  **no se finge que sea normal**.
- **Tensión documental abierta (sin ratificar por el PO/profesor):** el documento oficial dice que «el
  índice aleatorio… debe seguir una distribución normal», mientras las tablas se definen por filas (ver
  `docs/hu-24-randomness-engine.md` y `docs/hu-25-effect-control-table.md`). Este estudio **no la
  resuelve**.

### Validación funcional secundaria del índice (NO participa en la selección)

Con `create(seed).nextIndex()` (N = 100.000 por semilla): permanece en 1..8000, y se contrasta con una
uniforme mediante χ² (80 bins de 100 filas, 79 g. l.). Tabla generada (`index-uniformity.csv`):

| Semilla    | Mín | Máx  | En 1..8000 | χ² (79 g. l.) | p (χ²) | Proporción filas 1–4800 | p > α |
| ---------- | --- | ---- | ---------- | ------------- | ------ | ----------------------- | ----- |
| 0          | 1   | 8000 | sí         | 94.79         | 0.1087 | 0.59648                 | sí    |
| 1          | 1   | 8000 | sí         | 66.51         | 0.8408 | 0.59645                 | sí    |
| 42         | 1   | 8000 | sí         | 83.80         | 0.3347 | 0.60054                 | sí    |
| 53         | 1   | 8000 | sí         | 74.93         | 0.6087 | 0.59990                 | sí    |
| 234        | 1   | 8000 | sí         | 57.07         | 0.9702 | 0.59886                 | sí    |
| 365        | 1   | 8000 | sí         | 107.35        | 0.0186 | 0.59885                 | no    |
| 777        | 1   | 8000 | sí         | 65.95         | 0.8527 | 0.60167                 | sí    |
| 1000       | 1   | 8000 | sí         | 56.19         | 0.9757 | 0.60225                 | sí    |
| 1500       | 1   | 8000 | sí         | 72.50         | 0.6838 | 0.60125                 | sí    |
| 3000000    | 1   | 8000 | sí         | 97.42         | 0.0783 | 0.60307                 | sí    |
| 4294967295 | 1   | 8000 | sí         | 62.53         | 0.9131 | 0.60414                 | sí    |

- Todos los índices están en 1..8000 y la proporción de las filas 1–4800 queda en 59.65 % – 60.41 %
  (≈ 60 % que exige la tabla de HU-25).
- La semilla **365** obtiene χ² p = 0.0186 (< 0,05): con 11 semillas se espera ≈ 0,55 así por azar. No
  influye en la selección; se deja constancia.

Esta comprobación **no sustituye** KS/Ljung-Box/Q-Q de la normal. Tampoco se usó la tabla de HU-25 para
elegir la semilla.

## Política de seed por batalla pendiente

**Auditado en `develop`:** no existe agregado `Battle` ni `Simulation`, ni `SeedPolicy`, ni semilla
persistida, ni endpoint de semilla, ni consumidor de `RandomSequenceFactoryPort` fuera del bootstrap.

Por tanto **no se inventa ninguna política**. En particular **no** se implementa
`const SEED = selectedSeed` ni `create(selectedSeed)` para cada batalla: todas empezarían por la misma
secuencia (mismos primeros índices → comportamiento predecible). La semilla **777** queda:

- **documentada** como resultado del estudio;
- como **referencia validada y fixture disponible** para configuración/pruebas posteriores;
- **sin** uso como semilla global.

Cómo se elige, dónde se guarda y quién puede reproducirla la semilla de cada batalla o simulación **sigue
pendiente** y depende de un requisito/contrato futuro (ADR-019 habla de reproducibilidad de simulaciones,
no de una semilla única).

## Reproducibilidad

- El PRNG y las semillas son deterministas: la misma implementación produce **exactamente** las mismas
  muestras.
- **Verificado:** el pipeline completo se ejecutó **dos veces desde cero** (compilación, generación de
  muestras y análisis). Los **17 artefactos** de `docs/evidence/hu-26/` (CSV, MD, JSON, huellas y los 11
  PNG) resultaron **idénticos byte a byte** (SHA-256). Después se ajustó `analyze.py` para escribir siempre saltos de
  línea LF (en Windows producía CRLF) y se repitió el análisis: los 17 artefactos son idénticos a los
  anteriores salvo los saltos de línea, y la evidencia commiteada es la de esa última ejecución.
- **Entorno Python limpio:** se creó un entorno nuevo con `pip install -r tools/hu-26/requirements.txt` y
  se repitió el análisis sobre las mismas muestras: las mismas versiones que `requirements.lock.txt` y los 17 artefactos **idénticos byte a byte** a los de la evidencia.
- Las muestras (1,1 millones de números) **no se commitean**: se regeneran de forma determinista y su
  integridad se comprueba con SHA-256 antes de analizar.

## Cómo volver a ejecutar el estudio

Requisitos: Node 24 (`npm ci`) y Python 3.13.

```bash
python -m venv tools/hu-26/.venv
tools/hu-26/.venv/Scripts/pip install -r tools/hu-26/requirements.txt   # Windows
# tools/hu-26/.venv/bin/pip install -r tools/hu-26/requirements.txt     # Linux/macOS
npm ci
npm run study:hu-26      # ≈ 6 min: compila el harness, genera muestras, analiza
```

Pasos sueltos: `npm run study:hu-26:build` → `npm run study:hu-26:samples` →
`tools/hu-26/.venv/Scripts/python tools/hu-26/analyze.py`. No se commitea `.venv` (ni `.build/`, ni
`.samples/`).

## Evidencia generada

`docs/evidence/hu-26/` (generada automáticamente, sin cifras copiadas a mano):

| Artefacto                     | Contenido                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `seed-comparison.csv` / `.md` | Todas las métricas por semilla, filtros, orden y selección                                     |
| `selected-seed.json`          | Estado de la selección, semilla, regla, aceptadas, descartadas y motivos, entorno de ejecución |
| `qq/seed-<semilla>.png`       | Un Q-Q por candidata (11)                                                                      |
| `sample-fingerprints.json`    | SHA-256, suma, suma de cuadrados y valores ancla de cada muestra (normal e índice)             |
| `index-uniformity.csv`        | Validación secundaria del índice                                                               |
| `analysis-self-check.json`    | Controles positivos y negativos del propio análisis                                            |

Herramientas (`tools/hu-26/`): `study-config.json` (diseño pre-registrado), harness TypeScript
(`generate-samples.ts`, `sample-generation.ts`, `index-sample-generation.ts`, `production-factory.ts`,
`sample-fingerprint.ts`, `study-config.ts`), `analyze.py`, `run-study.mjs`, `requirements.txt` y
`requirements.lock.txt`. **Nada de esto forma parte del runtime**: vive fuera de `src/`, el `Dockerfile` no
lo copia, `.dockerignore` excluye `tools` y no se añadió ninguna dependencia científica al servicio.

### Autocomprobación del análisis

Antes de analizar, `analyze.py` verifica que detecta lo que debe detectar: Ljung-Box de statsmodels igual a
la implementación independiente; KS rechaza N(0,05; 1) y una uniforme; Ljung-Box rechaza un AR(1) con φ =
0,05; una muestra N(0,1) independiente da métricas ≈ teóricas; y la regla de selección elige la menor KS D
entre las aceptadas y no elige nada si no hay aceptadas. Si falla, aborta.

## Decisión sobre la CI

El estudio completo (~6 min, requiere Python) **no se ejecuta en cada CI**. En la CI normal sí se ejecutan
pruebas rápidas (≈ 10 s) que detectan:

- harness roto o que use otra fuente (`createNormalSequence` vs `create().nextIndex()`, `Math.random`);
- semillas inválidas (7.294.967.295 se rechaza; `RandomSeed.MAX` se acepta);
- divergencia del harness respecto al runtime (paridad con el contenedor de Nest);
- divergencia de los golden de HU-24;
- **deriva del generador**: se regeneran las 11 muestras y se contrastan con las huellas del estudio (los
  índices, por SHA-256; las normales, por suma/suma de cuadrados/anclas con tolerancia, para no depender de
  diferencias de 1 ULP de la libm);
- **coherencia de la decisión**: la regla pre-registrada, recalculada de forma independiente sobre el CSV,
  produce la semilla seleccionada.

## Pendientes

1. **Política de semilla por batalla/simulación** (requisito/contrato futuro). No se usa la 777 como
   semilla global.
2. **Ratificación de los «criterios acordados»** (N, α, lags, regla de selección) por el PO/profesor.
3. **Ratificación de la interpretación normal → uniforme** del índice (tensión documental abierta).
4. Decidir si **`RandomSeed` debe ampliarse** (p. ej. `init_by_array`) si algún requisito exigiera semillas
   > 2³² − 1; hoy la candidata histórica 7.294.967.295 no es representable.
5. Repetir el estudio si **cambia cualquier etapa del generador**.
6. Si se quisiera más garantía estadística: una batería de aleatoriedad dedicada (no exigida por RF-26).
