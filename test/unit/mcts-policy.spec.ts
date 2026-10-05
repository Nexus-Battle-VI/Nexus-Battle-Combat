import { MctsPolicy } from '../../src/application/policies/MctsPolicy'
import { MctsRoomContextRequiredError } from '../../src/domain/errors/MctsErrors'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import type { MctsSearch } from '../../src/application/services/MctsSearch'
import { battleWithCombat } from '../fixtures/basic-attack'

describe('MctsPolicy (EN-036.1, nunca productiva)', () => {
  it('decide() siempre rechaza: BattleDecisionState no alcanza para simular (hallazgo de auditoria A)', async () => {
    const searchMock = jest.fn()
    const policy = new MctsPolicy({ search: searchMock } as unknown as MctsSearch)

    await expect(policy.decide({} as never, [])).rejects.toThrow(MctsRoomContextRequiredError)
    expect(searchMock).not.toHaveBeenCalled()
  })

  it('teach() delega en MctsSearch.search con la BattleRoom real, la config y la semilla', async () => {
    const room = battleWithCombat()
    const expected = { stateSchemaVersion: 1 } as never
    const searchMock = jest.fn().mockResolvedValue(expected)
    const policy = new MctsPolicy({ search: searchMock } as unknown as MctsSearch)

    const result = await policy.teach(room, 42)

    expect(searchMock).toHaveBeenCalledWith(room, MCTS_TEACHER_V1_CONFIG, 42)
    expect(result).toBe(expected)
  })
})
