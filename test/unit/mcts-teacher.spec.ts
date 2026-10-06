import { MctsTeacher } from '../../src/application/services/MctsTeacher'
import { MCTS_TEACHER_V1_CONFIG } from '../../src/domain/decision/MctsTeacherResult'
import type { MctsSearch } from '../../src/application/services/MctsSearch'
import type { MissionRotationInput } from '../../src/application/services/MissionRotationConstraint'
import { battleWithCombat } from '../fixtures/basic-attack'

describe('MctsTeacher (EN-036.1, nunca productiva)', () => {
  it('teach() delega en MctsSearch.search con la BattleRoom real, la config y la semilla', async () => {
    const room = battleWithCombat()
    const expected = { stateSchemaVersion: 1 } as never
    const searchMock = jest.fn().mockResolvedValue(expected)
    const teacher = new MctsTeacher({ search: searchMock } as unknown as MctsSearch)

    const result = await teacher.teach(room, 42)

    expect(searchMock).toHaveBeenCalledWith(room, MCTS_TEACHER_V1_CONFIG, 42, undefined)
    expect(result).toBe(expected)
  })

  it('acepta una config distinta de la v1 por defecto y la reenvia tal cual', async () => {
    const room = battleWithCombat()
    const customConfig = { ...MCTS_TEACHER_V1_CONFIG, rollouts: 8 }
    const searchMock = jest.fn().mockResolvedValue({})
    const teacher = new MctsTeacher({ search: searchMock } as unknown as MctsSearch, customConfig)

    await teacher.teach(room, 7)

    expect(searchMock).toHaveBeenCalledWith(room, customConfig, 7, undefined)
  })

  it('reenvia rotationInput (contexto de Mision) a MctsSearch.search sin tocarlo', async () => {
    const room = battleWithCombat()
    const rotationInput = { rotations: [] } as unknown as MissionRotationInput
    const searchMock = jest.fn().mockResolvedValue({})
    const teacher = new MctsTeacher({ search: searchMock } as unknown as MctsSearch)

    await teacher.teach(room, 7, rotationInput)

    expect(searchMock).toHaveBeenCalledWith(room, MCTS_TEACHER_V1_CONFIG, 7, rotationInput)
  })
})
