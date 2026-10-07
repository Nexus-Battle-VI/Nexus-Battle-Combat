import * as fs from 'node:fs'
import * as path from 'node:path'
import type { BattleDecisionState } from '../../src/domain/decision/BattleDecisionState'
import type { LegalAction } from '../../src/domain/decision/LegalAction'
import {
  FEATURE_DIMENSION,
  FEATURE_NAMES,
  FEATURE_SCHEMA_VERSION,
  FeatureEncoderV1,
} from '../../src/application/services/FeatureEncoderV1'
import {
  MissingReferencedEntityError,
  UnsupportedFeatureCategoryError,
} from '../../src/domain/errors/FeatureEncodingErrors'

const GOLDEN_DIR = path.join(__dirname, '..', '..', 'ai', 'tests', 'fixtures')

interface GoldenCase {
  readonly state: BattleDecisionState
  readonly candidate: LegalAction
  readonly expectedFeatures: Readonly<Record<string, number>>
}

const loadJson = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf-8')) as unknown

const basicAttackGolden = (): GoldenCase => {
  const raw = loadJson('golden-basic-attack.json') as {
    state: unknown
    candidate: unknown
    expectedFeatures: Record<string, number>
  }
  return {
    state: raw.state as BattleDecisionState,
    candidate: raw.candidate as LegalAction,
    expectedFeatures: raw.expectedFeatures,
  }
}

type MultiCandidateKind = 'basicAttack' | 'ability' | 'epic'

const multiCandidateGolden = (kind: MultiCandidateKind): GoldenCase => {
  const raw = loadJson('golden-multi-candidate.json') as {
    state: unknown
    candidates: Record<
      MultiCandidateKind,
      { action: unknown; expectedFeatures: Record<string, number> }
    >
  }
  return {
    state: raw.state as BattleDecisionState,
    candidate: raw.candidates[kind].action as LegalAction,
    expectedFeatures: raw.candidates[kind].expectedFeatures,
  }
}

/** Compara POR NOMBRE/INDICE contra `expectedFeatures` (#568 §17-18): tolerancia
 * <= 1e-7, documentada -- nunca 1e-3/1e-2, que esconderia una divergencia real
 * de encoder. En la practica, con la misma aritmetica IEEE-754 doble seguida
 * del mismo cast a float32, el resultado es byte-identico. */
const TOLERANCE = 1e-7

const assertGoldenParity = (golden: GoldenCase): void => {
  const encoder = new FeatureEncoderV1()
  const vector = encoder.encode(golden.state, golden.candidate)

  expect(vector).toBeInstanceOf(Float32Array)
  expect(vector.length).toBe(FEATURE_DIMENSION)

  for (const [name, expected] of Object.entries(golden.expectedFeatures)) {
    const index = FEATURE_NAMES.indexOf(name)
    expect(index).toBeGreaterThanOrEqual(0)
    const actual = vector[index]
    expect(actual).toBeDefined()
    expect(Math.abs((actual ?? NaN) - expected)).toBeLessThanOrEqual(TOLERANCE)
  }

  // Todas las claves de FEATURE_NAMES deben estar cubiertas por el golden
  // (si el golden omitiera una, esta prueba lo detecta en vez de pasar en
  // silencio con un subconjunto).
  expect(Object.keys(golden.expectedFeatures).sort()).toEqual([...FEATURE_NAMES].sort())
}

describe('FeatureEncoderV1 (EN-036.4 #568): contrato', () => {
  it('FE-01: featureSchemaVersion == feature-schema-v1', () => {
    expect(FEATURE_SCHEMA_VERSION).toBe('feature-schema-v1')
  })

  it('FE-02: featureDimension == 72', () => {
    expect(FEATURE_DIMENSION).toBe(72)
    expect(FEATURE_NAMES).toHaveLength(72)
  })
})

describe('FeatureEncoderV1 (EN-036.4 #568): paridad golden Python <-> TypeScript', () => {
  it('FE-03: golden BASIC_ATTACK', () => {
    assertGoldenParity(basicAttackGolden())
  })

  it('FE-04: golden ABILITY (multi-candidate)', () => {
    assertGoldenParity(multiCandidateGolden('ability'))
  })

  it('FE-05: golden EPIC (multi-candidate)', () => {
    assertGoldenParity(multiCandidateGolden('epic'))
  })

  it('golden BASIC_ATTACK (multi-candidate, mismo state que ability/epic)', () => {
    assertGoldenParity(multiCandidateGolden('basicAttack'))
  })
})

describe('FeatureEncoderV1 (EN-036.4 #568): propiedades y fail-closed', () => {
  it('FE-06: mismo input -> mismo Float32Array', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const first = encoder.encode(golden.state, golden.candidate)
    const second = encoder.encode(golden.state, golden.candidate)
    expect(Array.from(second)).toEqual(Array.from(first))
  })

  it('FE-07: no muta state', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const before = JSON.stringify(golden.state)
    encoder.encode(golden.state, golden.candidate)
    expect(JSON.stringify(golden.state)).toBe(before)
  })

  it('FE-08: no muta candidate', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const before = JSON.stringify(golden.candidate)
    encoder.encode(golden.state, golden.candidate)
    expect(JSON.stringify(golden.candidate)).toBe(before)
  })

  it('FE-09: categoria fuera del vocabulario congelado -> error', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const corrupted = {
      ...golden.state,
      context: { ...golden.state.context, mode: 'UNKNOWN_MODE' },
    } as unknown as BattleDecisionState
    expect(() => encoder.encode(corrupted, golden.candidate)).toThrow(
      UnsupportedFeatureCategoryError,
    )
  })

  it('FE-10: abilityId inexistente -> error', () => {
    const encoder = new FeatureEncoderV1()
    const golden = multiCandidateGolden('ability')
    const bogus: LegalAction = {
      kind: 'ABILITY',
      abilityId: 'ability-does-not-exist',
      target: golden.candidate.target,
    }
    expect(() => encoder.encode(golden.state, bogus)).toThrow(MissingReferencedEntityError)
  })

  it('FE-11: epicId que no coincide con el equipado -> error', () => {
    const encoder = new FeatureEncoderV1()
    const golden = multiCandidateGolden('epic')
    const bogus: LegalAction = {
      kind: 'EPIC',
      epicId: 'epic-does-not-exist',
      target: golden.candidate.target,
    }
    expect(() => encoder.encode(golden.state, bogus)).toThrow(MissingReferencedEntityError)
  })

  it('FE-12: target.combatant inexistente -> error', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const bogus: LegalAction = {
      kind: 'BASIC_ATTACK',
      target: { scope: 'COMBATANT', combatant: { teamLabel: 'Z', seat: 9 } },
    }
    expect(() => encoder.encode(golden.state, bogus)).toThrow(MissingReferencedEntityError)
  })

  it('FE-13: maxHealth invalido (<=0) -> error', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const corrupted = {
      ...golden.state,
      actor: { ...golden.state.actor, health: { current: 10, max: 0 } },
    } as unknown as BattleDecisionState
    expect(() => encoder.encode(corrupted, golden.candidate)).toThrow(MissingReferencedEntityError)
  })

  it('FE-14: todos los valores del vector son finitos', () => {
    const encoder = new FeatureEncoderV1()
    const golden = multiCandidateGolden('epic')
    const vector = encoder.encode(golden.state, golden.candidate)
    expect(Array.from(vector).every((value) => Number.isFinite(value))).toBe(true)
  })

  it('soporta un actor sin Ataque (sanador puro) sin inventar un BASIC_ATTACK', () => {
    const encoder = new FeatureEncoderV1()
    const golden = basicAttackGolden()
    const healer: BattleDecisionState = {
      ...golden.state,
      actor: { ...golden.state.actor, attack: null, damage: null },
    }
    const healAction: LegalAction = {
      kind: 'ABILITY',
      abilityId: 'ability-does-not-exist',
      target: { scope: 'SELF' },
    }
    // El encoder no "inventa" nada: si la habilidad no existe en el actor,
    // sigue fallando igual que con Ataque presente.
    expect(() => encoder.encode(healer, healAction)).toThrow(MissingReferencedEntityError)
  })
})
