import { createHash } from 'node:crypto'

/**
 * Espacio de nombres FIJO del `operationId` que Combat envia a Player-Inventory
 * (`POST /api/internal/v1/inventory/grants`).
 *
 * NO CAMBIARLO NUNCA: es parte de la clave de idempotencia. Otro espacio de
 * nombres produce otro UUID para el mismo (`battleId`, `playerId`, secuencia) y
 * un reintento de una entrega ya aplicada se veria como una operacion nueva:
 * el cofre se entregaria dos veces.
 */
export const INVENTORY_GRANT_NAMESPACE = 'f00292ac-1032-4092-847d-1bb0664a27cc'

const UUID_BYTES = 16

/** UUID v5 (RFC 4122 §4.3): SHA-1 de `namespace || name`, con version y variante fijadas. */
export const uuidV5 = (name: string, namespace: string): string => {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')

  if (namespaceBytes.length !== UUID_BYTES) {
    throw new Error(`El espacio de nombres "${namespace}" no es un UUID.`)
  }

  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest()
  const bytes = digest.subarray(0, UUID_BYTES)

  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)

  const hex = bytes.toString('hex')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * `operationId` que viaja a Player-Inventory.
 *
 * El `operationId` LOGICO del workflow (`battle:{battleId}:player:{playerId}:chest:1:grant`,
 * `hu-22-reward-contract-v1` §7) es legible y es el que se persiste y se
 * registra, pero Player-Inventory lo rechaza con `400` (`operationId must be a
 * UUID`): su contrato, heredado de HU-59, exige UUID v1-5 tanto en el DTO
 * (`@IsUUID()`) como en el caso de uso (`UUID_PATTERN`). Este mapeo lo lleva a
 * un UUID v5 DETERMINISTA del mismo id logico:
 *
 *  - el mismo (`battleId`, `playerId`, secuencia) produce siempre el mismo UUID,
 *    asi que un reintento sigue siendo idempotente en Player-Inventory;
 *  - ids logicos distintos producen UUID distintos (colision de SHA-1 aparte);
 *  - un workflow ya persistido con el id logico antiguo se recupera sin tocar
 *    sus datos: la traduccion ocurre al enviar, no al guardar.
 */
export const toInventoryGrantOperationId = (operationId: string): string =>
  uuidV5(operationId, INVENTORY_GRANT_NAMESPACE)
