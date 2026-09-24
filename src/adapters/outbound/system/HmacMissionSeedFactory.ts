import { createHash, createHmac } from 'node:crypto'

import type { MissionSeed, MissionSeedPort } from '../../../application/ports/MissionSeedPort'

/** Keeps the HMAC key and seed derivation outside the simulation engine. */
export class HmacMissionSeedFactory implements MissionSeedPort {
  constructor(private readonly secret: string | null) {}

  forOperation(operationId: string): MissionSeed {
    if (this.secret === null) throw new Error('El secreto de simulacion no esta configurado.')
    const digest = createHmac('sha256', this.secret).update(operationId).digest()
    return {
      value: digest.readUInt32BE(0),
      seedRef: createHash('sha256').update(digest).digest('hex').slice(0, 16),
      simulationId: `sim_${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`,
    }
  }
}
