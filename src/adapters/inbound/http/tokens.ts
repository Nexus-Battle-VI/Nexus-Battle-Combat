/** Simbolos de inyeccion de los casos de uso de HU-14/HU-15 (salas de batalla). */
export const CREATE_BATTLE_ROOM = Symbol('CreateBattleRoom')
export const LIST_AVAILABLE_BATTLE_ROOMS = Symbol('ListAvailableBattleRooms')
export const CANCEL_BATTLE_ROOM = Symbol('CancelBattleRoom')
export const JOIN_BATTLE_ROOM = Symbol('JoinBattleRoom')
export const LEAVE_BATTLE_ROOM = Symbol('LeaveBattleRoom')
/** HU-17 (RF-17): lectura de la sala, inicio de batalla y ticket del WebSocket. */
export const GET_BATTLE_ROOM = Symbol('GetBattleRoom')
export const START_BATTLE = Symbol('StartBattle')
export const ISSUE_REALTIME_TICKET = Symbol('IssueRealtimeTicket')
/** HU-17: piezas internas del tiempo real y de la batalla (sin ruta publica). */
export const CONSUME_REALTIME_TICKET = Symbol('ConsumeRealtimeTicket')
export const RESUME_BATTLE = Symbol('ResumeBattle')
export const COMPLETE_BATTLE_TURN = Symbol('CompleteBattleTurn')
export const BATTLE_RANDOM = Symbol('BoundedRandom')
