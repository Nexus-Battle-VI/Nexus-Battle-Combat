/**
 * Liberacion de los recursos de una sala terminada (HU-21, contrato §8).
 *
 * Lo implementa el gateway de tiempo real: sus conexiones dejan de estar
 * suscritas a la sala como conexiones de BATALLA, pero los sockets NO se
 * cierran (el cliente puede seguir leyendo el resultado y hacer `resume`).
 *
 * Se invoca DESPUES de difundir `battleFinished`; ese orden lo garantiza el
 * `BattleFinalizer`, no este puerto.
 */
export interface BattleRoomReleasePort {
  release(roomId: string): void
}

export const BATTLE_ROOM_RELEASE = Symbol('BattleRoomReleasePort')
