# EN-036.2 — Pipeline de dataset y entrenamiento en Python/PyTorch

Management [#566](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/566)
(hijo de [#555](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/555),
depende de [#564](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/564)
y de [#565](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/565)/
[`docs/en-036-mcts-teacher.md`](en-036-mcts-teacher.md)).

## 1. Objetivo

Construir `Nexus-Battle-Combat/ai`, un paquete Python 3.13 + `uv` + PyTorch
que transforma `CombatDecisionEvent` + teacher labels MCTS en un dataset
`PyTorch Dataset`/`DataLoader` reproducible, particionado 80/10/10 por
`battleId` sin fuga entre splits, con manifiesto y fingerprints verificables.

**Esta Task NO entrena la MLP final, NO exporta ONNX y NO activa
`NeuralPolicy`**: eso es #567/#568. Termina justo antes: dataset listo +
tensores listos + `DataLoader` listo.

## 2. Auditoría previa y wiring real (correccion de alcance sobre PR#81)

Auditado contra `develop@123e774` (2026-10-06, EN-036.1/#565 ya mergeada):
`MctsTeacher.teach()` NO se invocaba en producción y no existía persistencia
para `MctsTeacherResult`. Esa auditoría se reportó al usuario (sección "si
falta una relación necesaria... detente y reporta el contrato faltante" del
encargo), que decidió explícitamente: implementar el wiring real AHORA,
dentro del mismo PR#81, en vez de abrir una Task separada.

**Estado actual (post-corrección):**

| Pregunta                                   | Respuesta real                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Dónde se genera el teacher label en vivo? | `LiveMctsTeacherLabeler` (`src/application/services/LiveMctsTeacherLabeler.ts`), wired en `ExecuteBasicAttack`/`UseSkill`/`UseEpic`/`ExecuteAiTurn`.                       |
| ¿Dónde se persiste?                        | Colección Mongo `mcts-teacher-labels` (migración `025-mcts-teacher-labels.ts`), vía `MctsTeacherLabelRepositoryPort` → `MongoMctsTeacherLabelRepository`, append-only.     |
| ¿Es append-only?                           | Sí: `_id = eventId`; mismo contenido repetido es idempotente, contenido distinto lanza `MctsTeacherLabelConflictError`.                                                    |
| Identificador estable del label            | `MctsTeacherLabel.eventId` (contrato oficial, `src/domain/decision/MctsTeacherLabel.ts`), con `battleId`/`decisionSequence` redundantes para validar la relación.          |
| Relación con `CombatDecisionEvent`         | 1:1 por `eventId`; `result.candidates` es SIEMPRE subconjunto de `legalActions` (nunca igualdad exigida: el filtrado estratégico/de rotación puede descartar opciones).    |
| Activación en producción                   | Desactivado por defecto (`MCTS_LIVE_TEACHER_LABELING_ENABLED=false`): un despliegue lo activa explícitamente (ver `env.ts`; costo real de CPU por decisión, 128 rollouts). |

`CombatDecisionEvent` sigue igual que antes: entidad en
`src/domain/decision/CombatDecisionEvent.ts`, persistida vía
`CombatDecisionRecorder` → `MongoCombatDecisionTelemetryRepository`,
colección `combat-decision-events` (migraciones `023`/`024`), append-only.
`schemaVersion = 2` + `selectedAction.kind = 'END_TURN'` + `legalActions = []`
es el cierre técnico sin candidatas: se excluye SIEMPRE del dataset de
candidate-scoring (§17 del encargo), y `LiveMctsTeacherLabeler` nunca lo
etiqueta (§21).

**Limitación que SIGUE vigente: `MISSION` nunca produce labels.**
`RunMissionSimulation` resuelve la misión ENTERA con `MissionSimulation.ts`
(motor aproximado propio, sin `BattleRoom`) antes de preparar su
`CombatDecisionEvent` retroactivamente — no existe ninguna sala PRE-ACCIÓN
que pasarle a `MctsTeacher.teach()` con fidelidad. Fabricar una sala
aproximada violaría "el teacher usa el motor real"; en vez de eso, el
dataset distingue explícitamente (`dataset/join.py`):

- `missingLabelExpected`: decisión `MISSION` sin label — estructural, nunca
  un error.
- `missingLabelUnexpected`: decisión `ONLINE`/`TOURNAMENT` sin label — con
  el wiring real activo, se esperaba uno; por defecto hace FALLAR el build
  (`MissingTeacherLabelError`, fail-closed, #566 §31) salvo
  `--allow-missing-labels` explícito.

El único cambio esperado en Python para una futura integración de labels
`MISSION` (si algún día existe un `BattleRoom` simulable fiel para Misión)
sería que `MongoCombatDatasetSource.teacher_labels()` empezara a devolver
también esos labels — el join, el split, el encoder y el dataset PyTorch no
cambiarían.

## 3. Arquitectura del paquete

```
ai/
  pyproject.toml          # Python 3.13, uv.lock, PyTorch CPU-only
  src/nexus_combat_ai/
    errors.py             # jerarquia fail-closed
    contracts/
      decision_event.py   # espejo de BattleDecisionState/LegalAction/CombatDecisionEvent (TS)
      teacher_label.py    # espejo OFICIAL de MctsTeacherResult + MctsTeacherLabel (TS)
    features/
      schema.py           # feature-schema-v1: nombres/orden/normalizacion/vocabularios
      encoder.py           # FeatureEncoder.encode(state, candidate) -> np.float32[F]
    dataset/
      source.py           # DatasetSource (Protocol) + Jsonl/Mongo
      join.py              # join EXACTO event<->label por eventId
      sample.py            # DecisionSample (orden canonico por actionIdentity)
      split.py             # battle-hash-split-v1
      builder.py            # orquestacion: fuente -> join -> split -> JSONL + manifest
      manifest.py           # dataset-manifest-v1 + fingerprints canonicos
      pytorch_dataset.py    # torch.utils.data.Dataset + collate_fn
    cli/
      build_dataset.py      # `nexus-combat-dataset build`
  tests/
    fixtures/                # JSONL + golden vectors, todos generados por script
```

## 4. `FeatureEncoder` / `feature-schema-v1`

Ver `src/nexus_combat_ai/features/schema.py` (docstring completo) y
`feature_schema_manifest()` para la definición exportable. Resumen de
decisiones de diseño:

- **Agregaciones, no slots fijos**, para aliados/enemigos/habilidades/efectos
  (longitud variable): conteos normalizados, medias, mínimos. La única
  excepción es el tope `TEAM_CAP = 5`, respaldado por la invariante REAL
  `BattleState.ts`'s `MAX_PARTICIPANTS = 6` (el actor ocupa un puesto) — nunca
  trunca una batalla válida.
- **Candidate-specific features**: el objetivo real de cada candidato
  (`SELF`/`ally`/`enemy`/`ALLIED_GROUP`) se resuelve dentro del `state` y se
  describe con un bloque compacto, nunca repitiendo el vector de cada
  enemigo/aliado.
- **Sin IDs como features**: `abilityId`/`epicId`/`battleId`/etc. solo se
  usan para resolver semántica (buscar la habilidad referenciada) o como
  metadata de `DecisionSample`, nunca como número/hash.
- **Vocabularios congelados**: `effect.kind`/`target`/`statistic`/`operation`
  se validan contra el vocabulario auditado en `SkillEffectPolicy.ts`
  (patrones `INSTANT_STAT`, `TEMPORAL_STAT`, `INSTANT_HEAL`/`TEMPORAL_HEAL`,
  `DIRECT_DAMAGE`, `REFLECT_DAMAGE`, `IMMUNITY`, `REVIVE`). Un valor fuera de
  ese vocabulario falla con `UnsupportedFeatureCategoryError`.
- **`heroSubtype` omitido deliberadamente en v1**: es un identificador de
  Catalog (`hero-subtypes-v1`) cuyo vocabulario completo este paquete no ha
  auditado; añadirlo exige primero verificar esa taxonomía (candidato a
  `feature-schema-v2`).

### Hallazgo durante el diseño de tests: las habilidades "autobuff" SÍ atacan

Al construir la prueba del encoder para una habilidad tipo `STORM` (bono de
Ataque/Daño, sin efecto de daño directo aparente) se descubrió —mismo patrón
que ya había costado una ronda de revisión en PR#80— que `SkillEffectPolicy.ts`
clasifica CUALQUIER `STAT_MODIFIER` que no sea de curación como familia
`DAMAGE` ("ataque mejorado"): la habilidad SIEMPRE se resuelve como un ataque
real contra el objetivo, nunca como un buff inerte. El encoder ya lo refleja
correctamente (`effect_has_damage` se activa también cuando `statistic ==
DAMAGE`, no solo cuando `kind == DAMAGE`); fue el _test_ el que inicialmente
asumía lo contrario, y se corrigió antes de congelar el golden vector.

## 5. `DecisionSample` y orden canónico

`sample.py` ordena los candidatos de cada teacher label por `actionIdentity`
(nunca el orden de Mongo/JSON de origen) ANTES de calcular `selected_index`,
así `teacher_probabilities[i]` queda alineado 1:1 con `candidate_features[i]`
sin importar el orden de entrada (`tests/test_dataset.py::test_d01_mutation_reversed_input_order_still_aligns`
construye deliberadamente el caso invertido).

Se serializa a JSONL en forma CRUDA (`state` + `candidates` + `selectedIndex`),
no como vectores ya codificados: si `feature-schema-v2` llega después, el
mismo JSONL se puede re-codificar sin volver a tocar Mongo/fixtures.

## 6. Split: `battle-hash-split-v1`

SHA-256 de `battleId` (UTF-8) → primeros 4 bytes como entero sin signo →
módulo 100 → bucket `[0,99]`: `[0,79]` TRAIN, `[80,89]` VALIDATION, `[90,99]`
TEST. Nunca usa `hash()` built-in de Python (aleatorizado por proceso vía
`PYTHONHASHSEED`). El split depende SOLO de `battleId`: no incorpora el seed
de training, así que una nueva ejecución nunca mueve batallas entre splits.
Pruebas S-01..S-07 en `tests/test_split.py`.

## 7. Reproducibilidad

- `--cutoff` (ISO-8601 UTC) se aplica a AMBAS fuentes (#566 §45):
  `CombatDecisionEvent.occurredAt` y `MctsTeacherLabel.generatedAt` (el
  wiring real añadió este ultimo campo; antes de la correccion de alcance,
  el contrato fixture-only no lo tenia). Un label generado DESPUES del
  corte (posible por el fire-and-forget de `LiveMctsTeacherLabeler.persist`)
  nunca se cuela.
- `--source-commit` (o `git rev-parse HEAD` si se omite) y `--seed` quedan en
  el manifiesto.
- `inputFingerprint`: SHA-256 sobre la representación canónica (claves
  ordenadas, JSON compacto) de las decisiones ya unidas, en orden
  determinista `(battleId, decisionSequence, eventId)` — nunca el orden de
  la fuente. No cambia con `--seed` (el seed solo reordena DENTRO de cada
  split, con una semilla derivada por split vía SHA-256, nunca compartida
  entre splits).
- `outputFingerprint`: SHA-256 sobre el manifiesto (sin este campo) + los
  tres JSONL en orden fijo train/validation/test.
- El manifiesto deliberadamente NO incluye ningún reloj de pared
  (`generatedAt`): dos ejecuciones con el mismo input/cutoff/seed/commit
  producen los CUATRO archivos de salida byte a byte idénticos
  (`tests/test_manifest.py::test_reproducibility_byte_for_byte`).

## 8. Golden vectors (para `#568`)

`tests/fixtures/golden-basic-attack.json` y `golden-multi-candidate.json`
fijan el vector EXACTO (`nombre -> valor`, no un array posicional opaco) que
`FeatureEncoder` produce para un `state`+`candidate` de control. `#568`
(NeuralPolicy en TypeScript/Node) deberá reproducir el mismo vector para el
mismo fixture: si algún valor cambia, es `feature-schema-v2`, nunca un ajuste
silencioso.

## 9. Qué queda para #567/#568

- #567: elegir la loss (KL/cross-entropy/MSE/ranking), implementar
  `CandidateScoringMLP`, entrenar de verdad, exportar ONNX.
- #568: reimplementar `FeatureEncoder` en TypeScript contra el mismo
  `feature-schema-v1` (usando los golden vectors como prueba de paridad), y
  conectar `NeuralPolicy` a `DecisionPolicySelector`.
- Labels `MISSION`: solo si en el futuro existe un `BattleRoom` simulable
  fiel para Misión (ver limitación de §2); nadie debe fabricar una sala
  aproximada para "resolver" esto antes de tiempo.
- Activar `MCTS_LIVE_TEACHER_LABELING_ENABLED=true` en un entorno real para
  empezar a acumular labels de verdad es una decisión operativa de
  despliegue, no de este paquete.
