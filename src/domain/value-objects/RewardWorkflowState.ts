/**
 * Estados persistidos del `RewardWorkflow` de HU-22 (`hu-22-reward-contract-v1`
 * §8). Son los estados CONCEPTUALES del contrato reducidos a los que de verdad
 * necesitan su propia escritura: `RETRYABLE_FAILURE` e `INVENTORY_PENDING` del
 * contrato no son estados aparte aqui -- un intento transitorio fallido
 * simplemente deja el workflow en su ultimo estado alcanzado (lo recoge el
 * siguiente barrido, igual que `IntervalBattleDeadlineScheduler`), y no hay
 * escritura intermedia entre "seleccionado" y "entregado": la llamada a
 * Player-Inventory resuelve directo a `COMPLETED` o a fallo.
 */
export const RewardWorkflowState = {
  PendingCredit: 'PENDING_CREDIT',
  CreditConfirmed: 'CREDIT_CONFIRMED',
  ChestEligible: 'CHEST_ELIGIBLE',
  RewardSelected: 'REWARD_SELECTED',
  Completed: 'COMPLETED',
  TerminalFailure: 'TERMINAL_FAILURE',
} as const

export type RewardWorkflowState = (typeof RewardWorkflowState)[keyof typeof RewardWorkflowState]

export const TERMINAL_REWARD_WORKFLOW_STATES: readonly RewardWorkflowState[] = [
  RewardWorkflowState.Completed,
  RewardWorkflowState.TerminalFailure,
]

export const isTerminalRewardWorkflowState = (state: RewardWorkflowState): boolean =>
  (TERMINAL_REWARD_WORKFLOW_STATES as readonly string[]).includes(state)
