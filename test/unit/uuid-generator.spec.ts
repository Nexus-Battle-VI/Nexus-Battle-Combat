import { UuidGenerator } from '../../src/adapters/outbound/system/UuidGenerator'
import { BattleRoomId } from '../../src/domain/value-objects/BattleRoomId'

/**
 * HU-14.1 fija `BattleRoomId` como UUID v4. Esta prueba cierra el hueco
 * senalado por la auditoria independiente: ningun otro test ejercitaba el
 * FORMATO real que produce `UuidGenerator` (node:crypto `randomUUID()`), solo
 * el de dobles de prueba con ids fijos. Se verifica contra el mismo
 * validador que usa el dominio (`BattleRoomId.create()`), no con un regex
 * paralelo que pudiera divergir.
 */
describe('UuidGenerator', () => {
  it('genera identificadores que BattleRoomId.create() acepta como UUID v4', () => {
    const generator = new UuidGenerator()

    for (let i = 0; i < 20; i += 1) {
      const id = generator.generate()

      expect(() => BattleRoomId.create(id)).not.toThrow()
    }
  })

  it('genera identificadores distintos en llamadas sucesivas', () => {
    const generator = new UuidGenerator()

    const ids = new Set(Array.from({ length: 20 }, () => generator.generate()))

    expect(ids.size).toBe(20)
  })
})
