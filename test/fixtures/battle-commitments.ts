import { UpstreamServiceError } from '../../src/application/errors/UpstreamErrors'
import type {
  BattleHeroCommitmentCommand,
  BattleHeroCommitmentPort,
} from '../../src/application/ports/BattleHeroCommitmentPort'

/**
 * Doble del compromiso de batalla para las pruebas de Combat (HU-29).
 *
 * REGISTRA lo que se le pide en lugar de tragarselo: la mitad de lo que hay que
 * probar es QUE SE LLAMA -- que la sala compromete a todos sus humanos al
 * arrancar y los libera al terminar --, y eso no se ve en un doble que solo dice
 * «vale».
 */
export interface RecordingBattleCommitments extends BattleHeroCommitmentPort {
  readonly commits: BattleHeroCommitmentCommand[]
  readonly releases: { readonly roomId: string; readonly playerId: string }[]
  /** Cuando es `true`, comprometer falla como si Player/Inventory no respondiera. */
  failCommits: boolean
  /** Cuando es `true`, liberar falla: es el caso de la liberacion perdida. */
  failReleases: boolean
}

export const recordingBattleCommitments = (): RecordingBattleCommitments => {
  const commits: BattleHeroCommitmentCommand[] = []
  const releases: { roomId: string; playerId: string }[] = []

  const recorder: RecordingBattleCommitments = {
    commits,
    releases,
    failCommits: false,
    failReleases: false,
    commit: (command) => {
      if (recorder.failCommits) {
        return Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable'))
      }

      commits.push(command)

      return Promise.resolve()
    },
    release: (roomId, playerId) => {
      if (recorder.failReleases) {
        return Promise.reject(new UpstreamServiceError('player-inventory', 'no_alcanzable'))
      }

      releases.push({ roomId, playerId })

      return Promise.resolve()
    },
  }

  return recorder
}
