"""Jerarquia de errores del pipeline (EN-036.2, Management #566).

Regla del paquete: dato corrupto o version no soportada FALLA explicito.
Nunca se corrige en silencio (sin coercion, sin normalizacion de respaldo,
sin "ultimo bucket" para una categoria desconocida).
"""

from __future__ import annotations


class NexusCombatAiError(Exception):
    """Raiz de todos los errores propios de este paquete."""


class ContractValidationError(NexusCombatAiError):
    """Un `CombatDecisionEvent`/`MctsTeacherResult` no cumple el contrato esperado."""


class IncompatibleSchemaError(ContractValidationError):
    """`schemaVersion`/`teacherVersion`/`utilityVersion` no soportada por este paquete."""


class UnsupportedFeatureCategoryError(NexusCombatAiError):
    """Un valor categorico (enum/kind/target/statistic/operation...) no esta en el
    vocabulario congelado de `feature-schema-v1`. Una categoria nueva exige
    `feature-schema-v2`, nunca un mapeo silencioso al ultimo bucket."""


class MissingReferencedEntityError(NexusCombatAiError):
    """Una `LegalAction`/candidate referencia un combatiente, habilidad o epica
    que no existe en el `BattleDecisionState` recibido. Fail closed: nunca un
    vector cero silencioso."""


class DuplicateTeacherLabelError(NexusCombatAiError):
    """Existe mas de un teacher label para la misma decision segun el join key."""


class MissingTeacherLabelError(NexusCombatAiError):
    """Una decision ONLINE/TOURNAMENT sin `MctsTeacherLabel` (categoria B de
    #566 §16): con `LiveMctsTeacherLabeler` wired en produccion, se esperaba
    uno. Fail-closed por defecto (`DatasetBuildConfig.allow_missing_labels`
    controla la excepcion explicita, #566 §31)."""


class InvalidTeacherLabelError(ContractValidationError):
    """El teacher label existe pero viola su propio contrato (visits negativos,
    probabilidades que no suman 1, `selectedAction` ausente de `candidates`, etc.)."""


class DatasetBuildError(NexusCombatAiError):
    """Error irrecuperable al construir el dataset (cutoff, fuente, manifest)."""


class IncompatibleTrainingDatasetError(NexusCombatAiError):
    """El frozen dataset en `--dataset-dir` no es compatible con esta version del
    entrenador (EN-036.3, Management #567 §22, §63-64): `manifestVersion`/
    `featureSchemaVersion`/`featureDimension`/`teacherVersion`/`utilityVersion`/
    `labelSchemaVersion`/`splitStrategyVersion` desconocida o incompatible,
    `outputFingerprint` no coincide con el contenido real (dataset alterado), o
    `missingLabelUnexpected > 0` (hueco de labels no reconocido explicitamente)."""


class DatasetNotTrainableError(NexusCombatAiError):
    """Train, validation o test tiene 0 decisiones (#567 §23). Entrenar sobre un
    split vacio invalidaria early stopping (validation) o la metrica final
    (test); fail closed en vez de fingir que un split vacio es aceptable."""


class NonFiniteTrainingValueError(NexusCombatAiError):
    """Aparecio NaN/+inf/-inf en features, scores del modelo, loss o una metrica
    durante training/evaluacion OFFLINE (#567 §19, §126). A diferencia del
    gameplay online, el entrenamiento NO es fail-open: nunca se produce un
    artefacto a partir de un estado numerico invalido."""


class InvalidTrainingBatchError(NexusCombatAiError):
    """Un batch de `collate_decision_samples` viola una invariante exigida antes
    de calcular la loss (#567 §18): alguna fila sin candidatos reales, suma de
    `teacher_probabilities` enmascaradas fuera de tolerancia de 1.0, o
    `selected_index` fuera de rango."""


class InvalidTrainingConfigError(NexusCombatAiError):
    """`TrainingConfig` recibio un valor fuera de su dominio valido (p. ej.
    `max_epochs <= 0`, `early_stopping_patience <= 0`, `batch_size <= 0`)."""


class OnnxExportError(NexusCombatAiError):
    """La exportacion a ONNX o su validacion posterior (`onnx.checker`) fallo, o
    el grafo exportado no cumple el contrato productivo esperado (#567 §47-50)."""
