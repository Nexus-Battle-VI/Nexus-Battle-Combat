/** Resultado interno persistido junto con el evento letal; no se publica por WebSocket. */
export interface VersusDropCandidate {
  readonly productInstanceId: string
  readonly productId: string
  readonly itemId: string
  readonly dropChanceBasisPoints: number
}

export interface VersusDropEvaluation extends VersusDropCandidate {
  readonly rollBasisPoints: number
  readonly eligible: boolean
}

export type VersusDropResolution =
  | { readonly status: 'NO_DROP'; readonly evaluations: readonly VersusDropEvaluation[] }
  | { readonly status: 'AWAITING_TIE_RULE'; readonly evaluations: readonly VersusDropEvaluation[] }
  | {
      readonly status: 'PENDING'
      readonly evaluations: readonly VersusDropEvaluation[]
      readonly selected: VersusDropCandidate
    }

export interface VersusDropDecision {
  readonly killerPlayerId: string
  readonly defeatedPlayerId: string
  readonly resolution: VersusDropResolution
}
