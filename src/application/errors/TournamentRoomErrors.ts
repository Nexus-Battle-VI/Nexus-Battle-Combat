/**
 * Errores de aplicacion de las rutas internas de torneo (Management#517, EN
 * de `tournament-rooms`). Viven aparte de `ApplicationError.ts` porque son
 * exclusivos de este flujo interno -- el lobby publico (HU-14/15) nunca los
 * produce -- mismo criterio de organizacion que `MissionSimulationIntakeErrors.ts`.
 *
 * La traduccion a HTTP ocurre en el adaptador de entrada
 * (`tournament-room.controller.ts::translate`).
 */

/** El cuerpo de la peticion no cumple el esquema esperado. 400. */
export class InvalidTournamentRoomRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTournamentRoomRequestError'
  }
}

/**
 * El `operationId` de creacion ya se uso con un cuerpo DISTINTO (comparacion
 * por el resumen canonico del cuerpo, igual que
 * `MissionSimulationOperationReusedError`, HU-72). 409: un reintento con el
 * MISMO cuerpo nunca llega aqui -- `CreateTournamentRoom` devuelve la sala ya
 * creada.
 */
export class TournamentRoomOperationReusedError extends Error {
  constructor(operationId: string) {
    super(`El operationId "${operationId}" ya se uso con un cuerpo de torneo distinto.`)
    this.name = 'TournamentRoomOperationReusedError'
  }
}

/**
 * La sala existe (`roomId` valido) pero `BattleRoom.tournament === null`:
 * es una sala del lobby publico (HU-14), no una sala de torneo. Las rutas
 * `tournament-rooms/:roomId/...` nunca operan sobre ella. 404: desde la
 * perspectiva de Tournament, ese `roomId` no es un recurso suyo.
 */
export class NotATournamentRoomError extends Error {
  constructor(roomId: string) {
    super(`La sala "${roomId}" no es una sala de torneo.`)
    this.name = 'NotATournamentRoomError'
  }
}

/**
 * El `tournamentId`/`encounterId` del cuerpo de `/start` no coinciden con los
 * que la sala tiene persistidos desde su creacion: el `roomId` de la URL no
 * es el de esta justa. 409: la sala SI es de torneo, pero no la que el
 * cuerpo describe.
 */
export class TournamentRoomMismatchError extends Error {
  constructor(roomId: string) {
    super(`La sala "${roomId}" no corresponde al torneo/justa indicados en el cuerpo.`)
    this.name = 'TournamentRoomMismatchError'
  }
}
