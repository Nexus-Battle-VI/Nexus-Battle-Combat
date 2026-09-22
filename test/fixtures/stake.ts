import type {
  WalletStakeOperationResult,
  WalletStakePort,
  WalletStakeReleaseCommand,
  WalletStakeReserveCommand,
  WalletStakeSettleCommand,
} from '../../src/application/ports/WalletStakePort'
import type { Logger } from '../../src/infrastructure/observability/logger'

/**
 * Doble del puerto hacia Wallet para las pruebas de HU-23: registra CADA
 * llamada (tambien cuando el caso de prueba sustituye la respuesta) y responde
 * con exito por defecto. `overrides` cambia el RESULTADO, nunca el registro.
 */
export interface WalletStakeCalls {
  readonly reserve: WalletStakeReserveCommand[]
  readonly release: WalletStakeReleaseCommand[]
  readonly settle: WalletStakeSettleCommand[]
}

export const walletStakeStub = (
  overrides: Partial<WalletStakePort> = {},
): { readonly port: WalletStakePort; readonly calls: WalletStakeCalls } => {
  const calls: WalletStakeCalls = { reserve: [], release: [], settle: [] }

  const reserveResult = (command: WalletStakeReserveCommand): WalletStakeOperationResult => ({
    operationId: command.operationId,
    applied: true,
    holdId: command.operationId,
    balance: 100,
    reserved: command.amount,
    available: 100 - command.amount,
  })

  const releaseResult = (command: WalletStakeReleaseCommand): WalletStakeOperationResult => ({
    operationId: command.operationId,
    applied: true,
    holdId: command.holdId,
    balance: 100,
    reserved: 0,
    available: 100,
  })

  const port: WalletStakePort = {
    reserve: (command) => {
      calls.reserve.push(command)

      return overrides.reserve === undefined
        ? Promise.resolve(reserveResult(command))
        : overrides.reserve(command)
    },
    release: (command) => {
      calls.release.push(command)

      return overrides.release === undefined
        ? Promise.resolve(releaseResult(command))
        : overrides.release(command)
    },
    settle: (command) => {
      calls.settle.push(command)

      return overrides.settle === undefined
        ? Promise.resolve({ operationId: command.operationId, applied: true, results: [] })
        : overrides.settle(command)
    },
  }

  return { port, calls }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
