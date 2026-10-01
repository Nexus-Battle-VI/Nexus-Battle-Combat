import { RandomIndex } from '../../domain/value-objects/RandomIndex'
import type {
  VersusDropCandidate,
  VersusDropEvaluation,
  VersusDropResolution,
} from '../../domain/entities/VersusDrop'
import type { RandomSequencePort } from '../ports/RandomSequencePort'

/**
 * HU-24 expone 8000 valores equiprobables. Dos extracciones generan un espacio
 * de 64 000 000 valores, divisible exactamente por 10 000: el modulo no sesga
 * ni siquiera las tasas del SRS de 0,01 %. Cada pieza consume dos índices de
 * la misma secuencia central que usa el resto de Combat; no hay otro RNG.
 */
const rollBasisPoints = (sequence: RandomSequencePort): number => {
  const first = sequence.nextIndex().value - RandomIndex.MIN
  const second = sequence.nextIndex().value - RandomIndex.MIN
  return (first * RandomIndex.MAX + second) % 10_000
}

export const resolveVersusDrop = (
  candidates: readonly VersusDropCandidate[],
  sequence: RandomSequencePort,
): VersusDropResolution => {
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (
      candidate.productInstanceId.trim() === '' ||
      candidate.productId.trim() === '' ||
      candidate.itemId.trim() === '' ||
      ids.has(candidate.productInstanceId) ||
      !Number.isInteger(candidate.dropChanceBasisPoints) ||
      candidate.dropChanceBasisPoints < 0 ||
      candidate.dropChanceBasisPoints > 10_000
    ) {
      throw new Error('Candidato de drop inválido; se requiere snapshot autoritativo completo.')
    }
    ids.add(candidate.productInstanceId)
  }

  const evaluations = candidates.map((candidate): VersusDropEvaluation => {
    const roll = rollBasisPoints(sequence)
    return {
      ...candidate,
      rollBasisPoints: roll,
      eligible: roll < candidate.dropChanceBasisPoints,
    }
  })

  const eligible = evaluations.filter((evaluation) => evaluation.eligible)
  if (eligible.length === 0) return { status: 'NO_DROP', evaluations }

  const highest = eligible.reduce(
    (value, candidate) =>
      candidate.dropChanceBasisPoints > value ? candidate.dropChanceBasisPoints : value,
    0,
  )
  const best = eligible.filter((candidate) => candidate.dropChanceBasisPoints === highest)
  if (best.length !== 1) return { status: 'AWAITING_TIE_RULE', evaluations }

  const selected = best[0]
  if (selected === undefined) throw new Error('La selección de drop quedó incompleta.')
  return {
    status: 'PENDING',
    evaluations,
    selected: {
      productInstanceId: selected.productInstanceId,
      productId: selected.productId,
      itemId: selected.itemId,
      dropChanceBasisPoints: selected.dropChanceBasisPoints,
    },
  }
}
