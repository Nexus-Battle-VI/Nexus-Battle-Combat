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

## 2. Auditoría previa (obligatoria antes de diseñar Python)

Auditado contra `develop@123e774` (2026-10-06), commit en el que se mergeó
EN-036.1 (#565, PR
[Combat#80](https://github.com/Nexus-Battle-VI/Nexus-Battle-Combat/pull/80)):

| Pregunta                                   | Respuesta real                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿Dónde se genera el teacher label en vivo? | **En ningún sitio todavía.** `MctsTeacher.teach()` no se invoca desde `ExecuteAiTurn`, `RunMissionSimulation` ni ningún otro caso de uso de producción. |
| ¿Dónde se persiste?                        | No existe puerto/repositorio/migración/colección Mongo para `MctsTeacherResult`.                                                                        |
| ¿Es append-only?                           | N/A: no hay persistencia que auditar.                                                                                                                   |
| Identificador estable del label            | No existe: `MctsTeacherResult` (TS) no declara `eventId`/`battleId`/`decisionSequence`.                                                                 |
| Relación con `CombatDecisionEvent`         | Solo documentada como intención ("labels en vivo", docstring de `MctsTeacher.ts`), nunca implementada.                                                  |

`CombatDecisionEvent` **sí** es real y se persiste de verdad:

- Entidad: `src/domain/decision/CombatDecisionEvent.ts`.
- Persistencia: `CombatDecisionRecorder` → `CombatDecisionTelemetryRepositoryPort`
  → `MongoCombatDecisionTelemetryRepository`, colección `combat-decision-events`
  (migraciones `023`/`024`), append-only.
- Join keys reales: `eventId` (preferido), o `battleId` + `decisionSequence`.
- `schemaVersion = 2` + `selectedAction.kind = 'END_TURN'` + `legalActions = []`
  es el cierre técnico sin candidatas: se excluye SIEMPRE del dataset de
  candidate-scoring (§17 del encargo).

**Consecuencia de diseño (regla del propio encargo: "si falta una relación
necesaria... detente y reporta el contrato faltante"):** esta Task NO inventa
un wiring de producción ni un contrato de persistencia de teacher labels.
En su lugar:

1. Define una interfaz (`DatasetSource`) que abstrae de dónde vienen decision
   events y teacher labels.
2. Implementa `MongoCombatDatasetSource` para `CombatDecisionEvent` **real**
   (solo lectura, colección real, orden explícito).
3. Implementa `JsonlDatasetSource`, la fuente completa y determinista usada
   en TODOS los tests, con fixtures validados contra los contratos reales.
4. Documenta `teacher-label-fixture-v1` como el envoltorio de unión que
   **este paquete** define (no un contrato oficial de Combat) mientras la
   persistencia real no exista — ver `MongoCombatDatasetSource.teacher_labels()`,
   que levanta `TeacherLabelSourceNotAvailableError` en vez de simular datos.

Cuando exista esa pieza (una futura Management Task: wiring de `teach()` en
paralelo a la decisión real + persistencia), el único cambio esperado en
este paquete es la implementación de `teacher_labels()` en
`MongoCombatDatasetSource` — el join, el split, el encoder y el dataset
PyTorch no deberían cambiar.

## 3. Arquitectura del paquete

```
ai/
  pyproject.toml          # Python 3.13, uv.lock, PyTorch CPU-only
  src/nexus_combat_ai/
    errors.py             # jerarquia fail-closed
    contracts/
      decision_event.py   # espejo de BattleDecisionState/LegalAction/CombatDecisionEvent (TS)
      teacher_label.py    # espejo de MctsTeacherResult (TS) + envoltorio fixture
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

- `--cutoff` (ISO-8601 UTC) se aplica a `CombatDecisionEvent.occurredAt`
  (el único de los dos contratos con timestamp propio — `MctsTeacherResult`
  no tiene uno; ver limitación de §2).
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
- Una futura Task (no creada todavía): wiring real de `MctsTeacher.teach()`
  en paralelo a las decisiones de producción + persistencia de
  `MctsTeacherResult` — ver §2. Sin esto, `MongoCombatDatasetSource` sigue
  limitado a `CombatDecisionEvent`.
