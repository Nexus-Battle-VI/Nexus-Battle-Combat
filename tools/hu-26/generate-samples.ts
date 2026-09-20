import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { RandomSeed } from '../../src/domain/value-objects/RandomSeed'
import { generateIndexSample } from './index-sample-generation'
import { createProductionRandomSequenceFactory } from './production-factory'
import { generateNormalSample } from './sample-generation'
import {
  encodeFloat64LittleEndian,
  encodeUint16LittleEndian,
  fingerprintIndexSample,
  fingerprintNormalSample,
} from './sample-fingerprint'
import { DEFAULT_STUDY_CONFIG_PATH, loadStudyConfig } from './study-config'

/**
 * CLI OFFLINE de HU-26: genera las muestras de cada semilla candidata con el
 * codigo PRODUCTIVO y escribe (a) los ficheros binarios que lee el analisis
 * estadistico y (b) las huellas SHA-256 que quedan como evidencia.
 *
 *   npm run study:hu-26:build && npm run study:hu-26:samples
 *
 * La fabrica (`createProductionRandomSequenceFactory`) tiene la misma composicion
 * que `infrastructure/bootstrap/app.module.ts`; una prueba verifica que producen
 * exactamente las mismas secuencias. NO forma parte del runtime de
 * Combat: vive en `tools/`, fuera de `src/` y de la imagen.
 */
const argument = (name: string, fallback: string): string => {
  const position = process.argv.indexOf(name)
  const value = position === -1 ? undefined : process.argv[position + 1]

  return value ?? fallback
}

const main = (): void => {
  const configPath = resolve(argument('--config', DEFAULT_STUDY_CONFIG_PATH))
  const samplesDir = resolve(argument('--samples-dir', join('tools', 'hu-26', '.samples')))
  const evidenceDir = resolve(argument('--evidence-dir', join('docs', 'evidence', 'hu-26')))

  const config = loadStudyConfig(configPath)
  const factory = createProductionRandomSequenceFactory()

  mkdirSync(samplesDir, { recursive: true })
  mkdirSync(evidenceDir, { recursive: true })

  const normal = []
  const index = []

  for (const rawSeed of config.candidateSeeds) {
    const seed = RandomSeed.create(rawSeed)

    const normalSample = generateNormalSample(factory, seed, config.sampleSize)
    writeFileSync(
      join(samplesDir, `normal-${String(rawSeed)}.f64`),
      encodeFloat64LittleEndian(normalSample),
    )
    normal.push(fingerprintNormalSample(rawSeed, normalSample))

    const indexSample = generateIndexSample(factory, seed, config.sampleSize)
    writeFileSync(
      join(samplesDir, `index-${String(rawSeed)}.u16`),
      encodeUint16LittleEndian(indexSample),
    )
    index.push(fingerprintIndexSample(rawSeed, indexSample))

    process.stdout.write(
      `semilla ${String(rawSeed)}: ${String(config.sampleSize)} normales e indices\n`,
    )
  }

  const fingerprints = {
    schemaVersion: 1,
    description:
      'Huellas de las muestras generadas con el codigo productivo (createNormalSequence / create). Las muestras no se commitean: se regeneran de forma determinista.',
    sampleSize: config.sampleSize,
    format: {
      normal: 'Float64 little-endian, sin cabecera (normal-<semilla>.f64)',
      index: 'Uint16 little-endian, sin cabecera (index-<semilla>.u16)',
    },
    normal,
    index,
  }

  writeFileSync(
    join(evidenceDir, 'sample-fingerprints.json'),
    `${JSON.stringify(fingerprints, null, 2)}\n`,
  )
  process.stdout.write(`huellas escritas en ${join(evidenceDir, 'sample-fingerprints.json')}\n`)
}

main()
