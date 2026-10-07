# EN-036.4 — NeuralPolicy con ONNX Runtime en Combat

Management [#568](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/568),
hijo de [EN-036 #555](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/555).
Depende de [EN-036.3 #567](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/567)
(ver [`en-036-neural-training.md`](en-036-neural-training.md)): este PR **no
entrena nada**. Toma el contrato ya congelado por `#567`
(`candidate_features [N, 72] → scores [N]`, opset 18) y lo lleva al runtime
Node de Combat, con `RuleBasedPolicy` como fallback obligatorio.

## Qué hace esta Task (y qué NO)

Deja listo:

- `FeatureEncoderV1`: puerto TypeScript de `feature-schema-v1` (el mismo
  esquema de 72 features que `ai/src/nexus_combat_ai/features/encoder.py`),
  verificado con **paridad exacta bit-a-bit** contra los fixtures golden de
  Python.
- `NeuralInferencePort` / `OnnxRuntimeNeuralInferenceAdapter`: adaptador real
  sobre `onnxruntime-node`, CPU-only.
- `NeuralPolicy`: implementa `AiDecisionPort`, igual que `RuleBasedPolicy`.
- `NeuralModelArtifactLoader`: carga y valida el artefacto al arrancar la
  app (manifest, hash, esquema, smoke real), con **fail-open** en cualquier
  fallo.
- `validate-neural-artifact.ts`: CLI que reutiliza exactamente esa misma
  cadena de carga para verificar un artefacto fuera del arranque del
  servicio (usado en CI y en el spike manual de este PR).
- Migración del `Dockerfile` de `node:24-alpine` a `node:24-bookworm-slim`
  (las 4 etapas), **por evidencia real**, no por precaución.

**NO** activa un modelo `CANDIDATE` en producción (`NEURAL_POLICY_ENABLED`
sigue en `false` por defecto), **NO** construye el harness de evaluación de
combates (`#569`), **NO** implementa el registro de modelos (`EN-037`), **NO**
toca nada de `ai/` (sigue siendo el Python offline de `#565`-`#567`).

## El riesgo real: Alpine (musl) vs glibc

`onnxruntime-node` empaqueta un binario nativo (`libonnxruntime.so.1`)
compilado contra glibc. Antes de tocar el `Dockerfile`, se construyó un
spike aislado (`node:24-alpine` vs `node:24-bookworm-slim`) que carga un
`.onnx` real y corre inferencia real — nunca una suposición sobre
compatibilidad de musl.

**Alpine (musl) — falla real, mensaje exacto:**

```
IMPORT_FAILED Error loading shared library ld-linux-x86-64.so.2: No such file or directory
(needed by /spike/node_modules/onnxruntime-node/bin/napi-v6/linux/x64//libonnxruntime.so.1)
```

`ld-linux-x86-64.so.2` es el *dynamic linker* de glibc. musl/Alpine no lo
tiene — no es una cuestión de instalar una librería, es una incompatibilidad
de ABI entre el binario precompilado de `onnxruntime-node` y el libc del
sistema.

**`node:24-bookworm-slim` (glibc) — evidencia real de éxito:**

- Sesión de inferencia creada en 90 ms (spike en host) / 119 ms (dentro del
  contenedor Docker real).
- Inferencia en caliente sobre 50 corridas: `p50 = 0 ms`, `p95 = 1 ms`.
- Score bit-idéntico al de la corrida en host (`-0.06338062882423401`),
  confirmando ejecución determinista en CPU.

Con esa evidencia, el `Dockerfile` migró **las 4 etapas** a
`node:24-bookworm-slim` (nunca mezclar `node_modules` compilados contra
musl en una etapa con otra compilada contra glibc). `USER node`, el
healthcheck, `EXPOSE` y `CMD` no cambiaron: el usuario `node` existe también
en `bookworm-slim`.

**Costo real, no estimado:** la imagen publicada hoy (`ghcr.io/.../nexus-battle-combat:latest`,
Alpine, sin `onnxruntime-node`) pesa **338 MB**. La imagen reconstruida en
este PR (`bookworm-slim` + binarios nativos de `onnxruntime-node`) pesa
**1.34 GB**. El salto es real y se documenta aquí en vez de ocultarse: la
base glibc es más pesada que Alpine, y los binarios nativos de ONNX Runtime
(CPU, x64) añaden varios cientos de MB por sí solos.

## Paridad Python ↔ TypeScript del `FeatureEncoder`

`FeatureEncoderV1.ts` es un puerto directo de
`ai/src/nexus_combat_ai/features/encoder.py`: mismas constantes de
normalización, mismo vocabulario congelado, mismo orden de las 72 features.
La prueba crítica (`test/unit/feature-encoder-v1.spec.ts`) carga los
fixtures golden reales (`ai/tests/fixtures/golden-*.json`, generados por el
propio encoder Python) y compara **por nombre de feature**, no por índice
ciego — si el encoder Python cambiara de orden, esta prueba lo detectaría en
vez de comparar números que coinciden por casualidad posicional.

La tolerancia documentada es `1e-7`, pero en la práctica el resultado es
**bit-a-bit idéntico**: el encoder TypeScript construye el vector como
`number[]` con la misma aritmética IEEE-754 de doble precisión que Python
usa internamente, y convierte a `Float32Array` **solo al final**
(`new Float32Array(values)`), exactamente como `np.asarray(values,
dtype=np.float32)`. Verificado temporalmente con tolerancia `0` (los 4
fixtures golden — `BASIC_ATTACK`, `ABILITY`, `EPIC`, `basicAttack`
multi-candidato — pasaron igual) antes de dejar `1e-7` como margen
documentado, nunca como señal de que algo diverge.

## Arquitectura del runtime

```
DecisionPolicySelector (sin cambios de lógica)
  primary:  NeuralPolicy (si NEURAL_POLICY_ENABLED=true Y el artefacto carga)
            └── encode candidatos → FeatureEncoderV1 → [N, 72]
            └── score               → NeuralInferencePort → [N]
            └── argmax (> estricta, primer índice gana empates)
            └── CA-07: Combat SIEMPRE revalida la acción contra legalActions
  fallback: RuleBasedPolicy (siempre disponible, nunca depende de ONNX)
```

`DecisionPolicySelector` y `ExecuteAiTurn` **no cambiaron su lógica**: ya
estaban completamente desacoplados de qué política concreta es `primary`
desde `#566`/trabajo previo. El único cambio es qué valor se pasa como
`primary` al arrancar la app — antes siempre `null`, ahora el resultado
(posiblemente `null`) de `loadNeuralPrimaryPolicy`.

### Carga y validación del artefacto (`NeuralModelArtifactLoader`)

Cadena de validación, en orden, cualquier fallo devuelve `null` (fallback a
`RuleBasedPolicy`, el servicio nunca se cae ni bloquea el *readiness*):

1. `NEURAL_POLICY_ENABLED=false` (default) → `null` inmediato, ni se tocan
   los archivos.
2. Las rutas del `.onnx` y del manifest deben ser archivos regulares.
3. El manifest se parsea y se valida **campo por campo contra el contrato
   congelado** (arquitectura, versión de esquema de features, dimensión 72,
   nombre/dtype de input y output, opset 18) — cualquier discrepancia es
   `NeuralModelSchemaMismatchError`.
4. `artifactPurpose`:
   - `SMOKE_TEST` **nunca** se acepta si `NODE_ENV=production`, sin importar
     `NEURAL_ALLOW_SMOKE_MODEL`.
   - Fuera de producción, `SMOKE_TEST` requiere `NEURAL_ALLOW_SMOKE_MODEL=true`
     explícito.
   - `CANDIDATE` es el único `artifactPurpose` aceptable en producción, y
     `#567` **todavía no produce uno** (solo `SMOKE_TEST`, de fixtures
     sintéticas) — ver "Qué queda fuera" más abajo.
5. Se calcula el SHA-256 real de los bytes del `.onnx` y se compara contra
   `manifest.onnxArtifactSha256` — mismatch es
   `NeuralModelHashMismatchError`.
6. `OnnxRuntimeNeuralInferenceAdapter.create()`: crea la `InferenceSession`
   (`executionProviders: ['cpu']`), valida que `inputNames`/`outputNames`
   coincidan con el contrato, y corre un smoke real `[1, 72]` antes de
   devolver el adaptador.
7. Se envuelve en `NeuralPolicy` y se registra `neural_model_loaded` (nunca
   `neural_model_unavailable`, que es el log de cualquier fallo en los pasos
   1-6).

### Inferencia (`NeuralPolicy.decide`)

- 0 `legalActions` → `NoLegalDecisionActionsError` (igual que
  `RuleBasedPolicy`), nunca llama al runtime.
- Codifica cada candidato por separado (`FeatureEncoderV1.encode`) en una
  matriz plana `[N, 72]` — el runtime nunca ve el estado completo, solo los
  features ya derivados.
- `scoreWithTimeout`: envuelve la llamada al adaptador con un
  `setTimeout`/`clearTimeout` manual (`NEURAL_INFERENCE_TIMEOUT_MS`,
  default `100`). Esto **no cancela de verdad** la inferencia nativa
  subyacente si el timeout dispara primero — se documenta explícitamente en
  el código: `NeuralPolicy` deja de esperar y usa el fallback, pero
  `session.run()` puede seguir corriendo en segundo plano hasta que
  termine. El default de `100 ms` no es una suposición: la inferencia real
  medida es `p50 = 0 ms`, `p95 = 1 ms` (ver spike arriba), así que `100 ms`
  deja un margen generoso sin que un pico transitorio dispare el timeout
  innecesariamente.
- Valida el output de forma independiente del adaptador concreto:
  `scores.length === candidateCount` y todos los valores finitos. Cualquier
  score `NaN`/`±Infinity` o longitud equivocada es
  `NeuralInferenceOutputError`.
- Elige el índice con score más alto con comparación **estricta `>`**: en un
  empate exacto, gana el **primer** índice en orden de `legalActions` — sin
  RNG, decisión determinista documentada.
- Nunca muta `state` ni `legalActions`; la acción devuelta es la misma
  referencia que ya estaba en `legalActions` (Combat la revalida igual via
  `resolveLegalAction`, CA-07, defensa en profundidad sin importar qué
  política decidió).

## Variables de entorno (todas con default seguro/deshabilitado)

| Variable                       | Default | Efecto                                                                                 |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `NEURAL_POLICY_ENABLED`         | `false` | Si es `false`, `NeuralPolicy` nunca se intenta cargar: solo `RuleBasedPolicy`.           |
| `NEURAL_MODEL_ONNX_PATH`        | (vacío) | Ruta al `.onnx`. Requerida si `NEURAL_POLICY_ENABLED=true`.                              |
| `NEURAL_MODEL_MANIFEST_PATH`    | (vacío) | Ruta al `training-manifest.json`. Requerida si `NEURAL_POLICY_ENABLED=true`.            |
| `NEURAL_INFERENCE_TIMEOUT_MS`   | `100`   | Timeout de una llamada de inferencia (ver justificación del valor arriba).               |
| `NEURAL_ALLOW_SMOKE_MODEL`      | `false` | Permite artefactos `SMOKE_TEST` fuera de producción. `NODE_ENV=production` ignora esto. |

En producción, con los defaults, **nada cambia**: `DECISION_POLICY_SELECTOR`
sigue resolviendo `primary: null` y la IA decide exactamente como antes de
este PR.

## CI: cómo se verifica sin reentrenar

El job `ai-pipeline` ya produce y publica un artefacto `SMOKE_TEST`
(`candidate-mlp-v1-smoke`, de fixtures sintéticas, `#567 §92-94`). El job
`docker` de este repo lo descarga (`actions/download-artifact`, mismo
commit), lo monta de solo lectura dentro de la imagen real recién
construida, y corre el **mismo** `validate-neural-artifact.js` que correría
en un despliegue real — con `NODE_ENV=development` y
`NEURAL_ALLOW_SMOKE_MODEL=true` porque el artefacto de `ai-pipeline` es
deliberadamente `SMOKE_TEST`. Nunca se reimplementa la lógica de carga en el
workflow: si el validador cambia, el CI lo ejercita de verdad.

## Qué queda fuera (deferred a `#569` / `EN-037`)

- No existe hoy ningún artefacto `artifactPurpose=CANDIDATE` — `#567` solo
  entrena con datos sintéticos de fixtures. Activar `NeuralPolicy` con un
  modelo real en producción depende de que `EN-037` (registro de modelos)
  y/o un entrenamiento con datos reales produzcan uno.
- `#569` (harness de evaluación) decidirá cómo comparar `NeuralPolicy`
  contra `RuleBasedPolicy` en combates reales antes de promover un modelo.
- `EN-037`: registro/versionado de modelos, selección de qué artefacto
  apunta `NEURAL_MODEL_ONNX_PATH`/`NEURAL_MODEL_MANIFEST_PATH` en cada
  entorno.

Hasta que eso exista, `NEURAL_POLICY_ENABLED=false` en todos los entornos
reales es la postura correcta, y este PR la respeta por default.
