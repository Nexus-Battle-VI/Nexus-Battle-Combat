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
