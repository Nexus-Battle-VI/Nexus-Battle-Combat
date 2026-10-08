import { spawn } from 'node:child_process'

/**
 * Invocador generico de subprocesos (EN-037.2, Management #571 §10):
 * `spawn` (nunca `exec`/shell) con argumentos como ARREGLO -- jamas
 * interpolacion de string, para que no exista inyeccion de shell posible.
 * Asincrono a proposito: el worker necesita que el event loop de Node
 * siga vivo DURANTE el entrenamiento real para poder seguir enviando el
 * heartbeat del lease (#571 §6.2) -- `execFileSync` bloquearia el proceso
 * entero y el lease expiraria a mitad de un training largo.
 */

export interface ChildProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ChildProcessOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /** Limite de bytes capturados por stream (#571 §10): evita crecer sin limite en una corrida larga. */
  readonly maxOutputBytes?: number
}

export interface RunningChildProcess {
  readonly result: Promise<ChildProcessResult>
  /** Termina el subproceso (#571 §6.2, CT-12): best-effort -- `SIGTERM` primero, nunca garantiza terminacion instantanea de un proceso Python ya en medio de un calculo de CPU. */
  readonly cancel: (signal?: NodeJS.Signals) => void
}

export class ChildProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`"${command}" excedio el timeout de ${String(timeoutMs)}ms y fue cancelado.`)
    this.name = 'ChildProcessTimeoutError'
  }
}

export class ChildProcessExitError extends Error {
  constructor(
    command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`"${command}" termino con exit code ${String(exitCode)}: ${stderr.slice(0, 2000)}`)
    this.name = 'ChildProcessExitError'
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** Tipo de la dependencia inyectable (#571): la logica de pipeline nunca llama a `spawn` directamente, siempre a traves de esta funcion. */
export type ChildProcessRunner = (
  command: string,
  args: readonly string[],
  options: ChildProcessOptions,
) => RunningChildProcess

export const spawnChildProcess: ChildProcessRunner = (command, args, options) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env })
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  let stdout = ''
  let stderr = ''
  let timedOut = false

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, options.timeoutMs)

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < maxOutputBytes) stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < maxOutputBytes) stderr += chunk.toString('utf8')
  })

  const result = new Promise<ChildProcessResult>((resolve, reject) => {
    child.on('error', (error: Error) => {
      clearTimeout(timeoutHandle)
      reject(error)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutHandle)
      if (timedOut) {
        reject(new ChildProcessTimeoutError(command, options.timeoutMs))
        return
      }
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })

  return { result, cancel: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal) }
}

/** Azucar para el caso comun "corre y exige exit code 0" (#571): sigue devolviendo el resultado completo para que el caller pueda leer stdout. */
export const runToCompletionOrThrow = async (
  runner: ChildProcessRunner,
  command: string,
  args: readonly string[],
  options: ChildProcessOptions,
): Promise<ChildProcessResult> => {
  const { result } = runner(command, args, options)
  const outcome = await result
  if (outcome.exitCode !== 0) {
    throw new ChildProcessExitError(command, outcome.exitCode, outcome.stderr)
  }
  return outcome
}
