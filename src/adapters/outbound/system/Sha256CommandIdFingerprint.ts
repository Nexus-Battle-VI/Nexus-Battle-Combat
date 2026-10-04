import { createHash } from 'node:crypto'

import type { CommandIdFingerprintPort } from '../../../application/ports/CommandIdFingerprintPort'

/** SHA-256 estable: conserva idempotencia sin persistir el texto arbitrario del cliente. */
export class Sha256CommandIdFingerprint implements CommandIdFingerprintPort {
  fingerprint(commandId: string): string {
    return createHash('sha256').update(commandId, 'utf8').digest('hex')
  }
}
