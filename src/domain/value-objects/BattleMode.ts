import { DomainError } from '../errors/DomainError'

/**
 * Modalidad de una sala de batalla (RF-14, CA-01: "modalidad JcJ/JcE").
 *
 * Enum cerrado, SIN cardinalidad de participantes asociada: la regla
 * descartada "PVP = exactamente 2 HUMAN" no se modela (HU-14.1,
 * `HU-14.1-Decisiones-Tecnicas.md`, punto 4). Terminologia en ingles en el
 * codigo, "JcJ/JcE" en la documentacion en espanol.
 */
export const BattleMode = {
  Pvp: 'PVP',
  Pve: 'PVE',
} as const

export type BattleMode = (typeof BattleMode)[keyof typeof BattleMode]

const ALL_MODES: readonly BattleMode[] = [BattleMode.Pvp, BattleMode.Pve]

export const parseBattleMode = (raw: unknown): BattleMode => {
  if (typeof raw !== 'string' || !(ALL_MODES as readonly string[]).includes(raw)) {
    throw new DomainError(`La modalidad "${String(raw)}" no es reconocida. Se espera PVP o PVE.`)
  }

  return raw as BattleMode
}
