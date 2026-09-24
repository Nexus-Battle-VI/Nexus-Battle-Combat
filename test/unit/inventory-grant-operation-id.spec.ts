import {
  INVENTORY_GRANT_NAMESPACE,
  toInventoryGrantOperationId,
  uuidV5,
} from '../../src/adapters/outbound/http/inventory-grant-operation-id'
import { inventoryOperationIdOf } from '../../src/application/use-cases/CreateRewardWorkflows'

/**
 * Regex de Player-Inventory (`GrantPurchasedItems.UUID_PATTERN`): es lo que su
 * caso de uso exige a `operationId` y a cada `productId`. Copiada a proposito,
 * no importada: es la definicion del CONTRATO del destino, y si cambia alla
 * esta prueba debe cambiarse a mano y con conciencia.
 */
const PLAYER_INVENTORY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/**
 * UUID v5 del id logico de un flujo de ejemplo (identificadores sinteticos). Calculado
 * con `uuidV5` DESPUES de comprobar que reproduce los vectores publicados de
 * RFC 4122 (las dos primeras pruebas). Fijarlo aqui evita que un cambio de
 * algoritmo o de espacio de nombres pase inadvertido.
 */
const EXPECTED_WIRE_ID = '4cbcac78-eb3d-51b9-b37a-4b66515477e9'

describe('uuidV5 (RFC 4122 §4.3)', () => {
  it.each([
    // Vectores publicados de forma independiente: la documentacion de Python
    // (`uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')`) y el ejemplo habitual de RFC 4122.
    ['python.org', '886313e1-3b8a-5372-9b90-0c9aee199e5d'],
    ['www.example.com', '2ed6657d-e927-568b-95e1-2665a8aea6a2'],
  ])('reproduce el vector conocido de %s', (name, expected) => {
    expect(uuidV5(name, NAMESPACE_DNS)).toBe(expected)
  })

  it('rechaza un espacio de nombres que no es un UUID', () => {
    expect(() => uuidV5('x', 'no-es-un-uuid')).toThrow('no es un UUID')
  })
})

describe('toInventoryGrantOperationId (HU-22, contrato de Player-Inventory)', () => {
  const battleId = '5b1d3c0e-7a2f-4e6b-9c1d-2f8a4b6c7d01'
  const playerId = '9f3a1c2e-4b5d-4e7f-8a9b-0c1d2e3f4a5b'
  const logical = inventoryOperationIdOf(battleId, playerId)

  it('el id logico del workflow NO es un UUID: es lo que Player-Inventory rechazaba con 400', () => {
    // Control de la regresion: si esta afirmacion dejara de cumplirse, el
    // mapeo ya no haria falta y las pruebas de abajo perderian su sentido.
    expect(logical).toBe(`battle:${battleId}:player:${playerId}:chest:1:grant`)
    expect(PLAYER_INVENTORY_UUID_PATTERN.test(logical)).toBe(false)
  })

  it('el id que viaja SI cumple el contrato de Player-Inventory (UUID v1-5)', () => {
    const wire = toInventoryGrantOperationId(logical)

    expect(wire).toMatch(PLAYER_INVENTORY_UUID_PATTERN)
    expect(wire[14]).toBe('5')
  })

  it('es determinista: el mismo id logico produce siempre el mismo UUID (idempotencia del reintento)', () => {
    expect(toInventoryGrantOperationId(logical)).toBe(toInventoryGrantOperationId(logical))
  })

  it('ids logicos distintos producen UUID distintos (otra secuencia, otro jugador, otra batalla)', () => {
    const other = [
      `battle:${battleId}:player:${playerId}:chest:2:grant`,
      inventoryOperationIdOf(battleId, 'otro-jugador'),
      inventoryOperationIdOf('otra-batalla', playerId),
    ].map(toInventoryGrantOperationId)

    expect(new Set([toInventoryGrantOperationId(logical), ...other]).size).toBe(4)
  })

  it('valor fijado: cambiar el espacio de nombres o el algoritmo duplicaria entregas ya aplicadas', () => {
    // Par (battleId, playerId) de ejemplo. Si este valor cambia, un workflow ya entregado con el UUID
    // anterior se volveria a entregar con otro.
    expect(INVENTORY_GRANT_NAMESPACE).toBe('f00292ac-1032-4092-847d-1bb0664a27cc')
    expect(toInventoryGrantOperationId(logical)).toBe(uuidV5(logical, INVENTORY_GRANT_NAMESPACE))
    expect(toInventoryGrantOperationId(logical)).toBe(EXPECTED_WIRE_ID)
  })
})
