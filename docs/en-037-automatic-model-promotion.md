# EN-037.3 — Evaluación y promoción automática de modelos

Management [#572](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/572),
hijo de [EN-037 #556](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/556).
Continúa el registry de #570, el worker de training de #571 y el harness
reproducible de #569. No despliega un servicio nuevo ni modifica Infrastructure;
eso corresponde a #573/#574.

## 1. Decisión de producto y política v1

El PO aprobó la **Opción B: promoción completamente automática**. La aprobación
humana autoriza la política; no existe aprobación manual por modelo ni estados
`WAITING_APPROVAL`, `PENDING_PO` o equivalentes.

`promotion-policy-v1` centraliza y audita los gates:

| Gate                | Regla                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Evidencia           | `FULL_EVALUATION`, modelo y matchups obligatorios presentes, cero partidas fallidas en esos matchups       |
| Seguridad           | 0 selecciones ilegales y 0 rechazos del motor                                                              |
| Paridad             | PyTorch/ONNX `PASS`                                                                                        |
| Neural vs Random    | win rate >= 60 %                                                                                           |
| Neural vs RuleBased | win rate >= 50 %                                                                                           |
| No regresión        | si existe ACTIVE, el candidato no puede rendir peor contra Random ni RuleBased bajo la misma configuración |

El 50 % contra RuleBased y el gate de no regresión son decisiones explícitas del
PO posteriores a la línea base técnica de 45 % de #556/#572. Se documentan como
evolución de la política, no como interpretación silenciosa de la Issue. Empates
cuentan en el denominador y no como victoria. Las partidas fallidas no entran al
denominador, pero hacen fallar el gate de evidencia: una muestra incompleta nunca
promueve.

## 2. Arquitectura y flujo

```text
#571 registra CANDIDATE
        |
        v
AutomaticModelEvaluationCoordinator
        | lease + fencing en Mongo
        v
CANDIDATE -> EVALUATING
        |
        +--> materializa ONNX + manifest + referencia PyTorch
        +--> runAiEvaluation(FULL_EVALUATION) del #569
        +--> si existe ACTIVE, corre el mismo harness otra vez
             con idéntica configuración y semillas
        |
        v
PromotionPolicyV1
   FAIL -> REJECTED, ACTIVE anterior intacto
   PASS -> ACTIVE nuevo, ACTIVE anterior -> SUPERSEDED
```

El coordinador reutiliza `runAiEvaluation()`; no copia el simulador, el encoder,
la paridad ni el cálculo de métricas. Para no alterar el slot neuronal único del
harness, candidato y ACTIVE se evalúan en corridas separadas con el mismo
`evaluationConfigSha256`.

## 3. Artefactos y paridad

#571 invoca el CLI Python existente `nexus-combat-parity-reference` inmediatamente
después del entrenamiento y **antes** de limpiar el directorio temporal. El registry
conserva por contenido:

- `model.onnx`;
- `metrics.json`;
- `pytorch-parity-reference.json`;
- hashes del checkpoint, manifest, configuración, dataset y pesos.

El checkpoint `model.pt` no se conserva. La referencia de paridad es la evidencia
durable que permite comparar PyTorch con ONNX más tarde. Un candidato nuevo sin
`parityReferenceSha256` se rechaza. Versiones históricas ACTIVE creadas antes de
#572 pueden restaurarse con ese campo nulo para seguir sirviendo y ser
supersedidas, pero no se inventa evidencia para reevaluarlas.

`NeuralArtifactMaterializer` reconstruye exclusivamente el subconjunto del
manifest congelado que consume el loader de #568. Evaluación exige ONNX +
referencia; runtime solo necesita ONNX. Todos los bytes se vuelven a verificar
contra su SHA-256.

## 4. Interpretación y persistencia de la evaluación

El reporte autoritativo sigue siendo `EvaluationSummary` de #569. La identidad de
evaluación incluye commit fuente, hash de pesos y hash de configuración. En Mongo,
`ai-model-evaluations` guarda por `modelVersion`:

- lineage del training y hashes ONNX/paridad;
- lease, expiración, propietario y fencing token;
- `evaluationId`, resultado PASS/FAIL y todos los gates;
- razones de fallo;
- versión de política/configuración;
- fingerprints de semillas, configuración y partidas;
- estado de promoción e historial de rollback.

La migración `030` crea validator e índices. Presentar el mismo `modelVersion` con
lineage diferente falla cerrado. Un error técnico (Mongo, disco, ONNX, proceso)
incrementa fallos recuperables y **no** se convierte en FAIL de calidad ni en
REJECTED. Un FAIL definitivo de gates sí termina en REJECTED.

## 5. Promoción, ACTIVE y reemplazo

La migración `029` agrega `SUPERSEDED` y la referencia de paridad al registry. El
grafo relevante es:

```text
CANDIDATE -> EVALUATING -> ACTIVE -> SUPERSEDED
                           ^            |
                           +------------+  rollback
EVALUATING -> REJECTED
```

Mongo es standalone en la topología vigente; no se afirman transacciones
multidocumento inexistentes. El swap utiliza dos escrituras CAS:

1. verificar por adelantado integridad/elegibilidad del candidato;
2. `ACTIVE -> SUPERSEDED` del anterior;
3. `EVALUATING -> ACTIVE` del candidato.

El índice parcial único continúa garantizando como máximo un ACTIVE. Existe una
ventana breve sin ACTIVE si el proceso cae entre 2 y 3; durante ella Combat usa
RuleBased. Ante un error controlado en 3 se intenta compensar reactivando el
anterior. La recuperación del worker completa decisiones PASS que ya quedaron
durables. No se promete atomicidad multidocumento que Mongo standalone no ofrece.

## 6. Rollback

Rollback es un comando técnico interno, no un endpoint HTTP:

```bash
npm run model:rollback -- \
  --operation-id incident-2026-10-08-01 \
  --target-version candidate-mlp-v1-abc123 \
  --reason "regresion operacional confirmada"
```

El destino debe estar `SUPERSEDED`, conservar artefacto íntegro y tener evidencia
PASS con promoción `COMPLETED`. `REJECTED` nunca es elegible. `operation-id` hace
el audit event idempotente; reintentar cuando el destino ya es ACTIVE es no-op.
El rollback usa el mismo protocolo CAS/compensación del reemplazo normal.

## 7. Runtime, recarga y fallback

Con Mongo y `NEURAL_POLICY_ENABLED=true`, `ActiveModelProvider` consulta el ACTIVE
del registry, materializa/verifica el ONNX y reemplaza una referencia inmutable a
`NeuralPolicy`. Sondea cada 30 segundos; promoción y rollback no requieren reiniciar
Combat ni copiar archivos manualmente.

`DecisionPolicySelector` conserva exactamente dos niveles:

```text
ActiveModelProvider (NEURAL) -> RuleBasedPolicy
```

Si no hay ACTIVE, el artefacto es inválido, ONNX no carga o la decisión neuronal
falla, RuleBased mantiene disponibilidad. Una recarga fallida conserva el último
modelo válido ya cargado. Cada decisión toma un delegado estable; no cambia de
modelo a mitad de una inferencia. Una batalla larga sí puede usar una versión nueva
en un turno posterior después del refresh: la consistencia garantizada es por
decisión, no por batalla completa.

El loader histórico por paths permanece solo como compatibilidad de desarrollo
con `PERSISTENCE_DRIVER=memory`. En producción Mongo, el registry es la autoridad.

## 8. Recuperación, concurrencia y fencing

Cada iteración procesa como máximo un candidato. `ensureAndTryClaim` asigna lease y
fencing token; dos workers no ejecutan el mismo candidato. Los heartbeats renuevan
el lease y toda escritura sensible valida propietario + token. Un propietario
obsoleto no puede registrar una decisión.

Al reiniciar:

- `CANDIDATE`: puede reclamarse normalmente;
- `EVALUATING` sin decisión: se reevalúa cuando expira el lease;
- decisión durable PASS sin promoción completa: se aplica la promoción sin repetir
  el harness;
- decisión durable FAIL: se completa REJECTED idempotentemente.

La identidad de evaluación y fingerprints permiten auditar una repetición; no se
usa el tiempo real ni aleatoriedad no determinista para decidir gates.

## 9. Worker y ejecución local

El proceso standalone no expone API:

```bash
npm run build
npm run evaluate:automatic -- --once --source-commit <sha>
```

Opciones principales: `--poll-interval-ms`, `--lease-duration-ms`,
`--heartbeat-interval-ms`, `--seed-start`, `--seed-count`,
`--mcts-seed-count`, `--max-plies`, `--work-root-dir`, backoff y
`--skip-expensive-mcts`. Producción requiere `MONGODB_URI`; reutiliza la
configuración existente de Combat y no añade secretos ni endpoints.

## 10. Pruebas y evidencia

La cobertura incluye matrices de gates, PASS/FAIL, paridad, concurrencia entre
coordinadores, fencing obsoleto, recuperación, idempotencia, promoción compensada,
rollback, hot reload, modelo inválido y fallback. Las migraciones 029/030 y los
repositorios se prueban contra Mongo real.

CI entrena además un CANDIDATE **sintético y efímero de ingeniería**, genera su
referencia PyTorch y ejecuta `npm run test:e2e:en-037` en un proceso Node real. El
E2E registra el artefacto, corre paridad+harness+gates y valida el resultado real:
puede terminar ACTIVE si pasa o REJECTED si falla; jamás fabrica un PASS. Ese
fixture no se publica, dura un día y no constituye evidencia competitiva.

## 11. Limitaciones y siguientes Enablers

- Mongo standalone impide un swap multidocumento estrictamente atómico; se usa CAS,
  índice único, compensación y fallback.
- El polling introduce hasta 30 segundos de latencia de recarga.
- No hay tolerancia numérica inventada para no regresión; se exige `candidate >= ACTIVE`.
- El E2E sintético valida la mecánica, no la calidad competitiva de un modelo real.
- Una versión histórica sin referencia de paridad no puede reevaluarse sin evidencia.
- #573 debe desplegar los workers técnicos y dimensionar CPU/memoria/topología.
- #574 debe validar en el entorno integrado batalla -> datos -> training -> evaluación
  -> promoción/rechazo -> consumo por Combat.
